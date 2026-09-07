import { useEffect, useRef, useState, useCallback } from 'react';
import { createNitroSse } from './index';
import type {
  SseClient,
  SseConfig,
  SseEvent,
  SseState,
  SseStats,
} from './SseInterface';

export interface UseNitroSseOptions extends SseConfig {
  /**
   * Whether to automatically start streaming on mount or when URL changes.
   * @default true
   */
  autoStart?: boolean;
  /** Handler for incoming message events (both default and custom events) */
  onMessage?: (event: SseEvent) => void;
  /** Handler for transport or connection errors */
  onError?: (event: SseEvent) => void;
  /** Handler for stream open events */
  onOpen?: (event: SseEvent) => void;
  /** Handler for stream close events */
  onClose?: (event: SseEvent) => void;
  /** Handler for keep-alive heartbeat ping events */
  onHeartbeat?: (event: SseEvent) => void;
  /** Handler for connection state transitions */
  onStateChange?: (state: SseState) => void;
  /** Map of handlers for specific custom event types */
  events?: Record<string, (event: SseEvent) => void>;
}

export interface UseNitroSseReturn {
  /** Underlying SseClient instance (null if uninitialized or failed) */
  client: SseClient | null;
  /** Current connection state */
  state: SseState;
  /** Whether the client connection is currently running */
  isConnected: boolean;
  /** Start the stream manually */
  start: () => void;
  /** Stop the stream manually */
  stop: () => void;
  /** Restart the stream manually (stop + start) */
  restart: () => void;
  /** Force flush buffered events to JS */
  flush: () => void;
  /** Update request headers */
  updateHeaders: (headers: Record<string, string>) => void;
  /** Set last processed event ID */
  setLastProcessedId: (id: string) => void;
  /** Get connection statistics */
  getStats: () => SseStats | undefined;
  /** Manually inject a mock event into the stream (for testing/debugging) */
  injectMockEvent: (event: Partial<SseEvent>) => void;
}

/**
 * Derives the `isConnected` flag from the connection state without a native JSI call.
 * Matches the semantics of `SseClient.isConnected()`: true for 'connecting', 'open', or 'reconnecting'.
 */
function isConnectedState(s: SseState): boolean {
  return s === 'connecting' || s === 'open' || s === 'reconnecting';
}

/**
 * React Hook for high-performance Server-Sent Events (SSE) streaming in React Native.
 * Automatically handles client instantiation, listener attachment, state tracking, and lifecycle disposal on unmount.
 *
 * @param options SSE configuration options, callbacks, and custom event handlers.
 * @returns State, client instance, and imperative control methods.
 */
export function useNitroSse(options: UseNitroSseOptions): UseNitroSseReturn {
  const {
    autoStart = true,
    onMessage,
    onError,
    onOpen,
    onClose,
    onHeartbeat,
    onStateChange,
    events,
    onBeforeRequest,
    ...restConfig
  } = options;

  // Underlying client reference for imperative callbacks
  const clientRef = useRef<SseClient | null>(null);
  const [client, setClient] = useState<SseClient | null>(null);

  const [state, setState] = useState<SseState>('idle');
  const [isConnected, setIsConnected] = useState<boolean>(false);

  // Callback ref holding the latest handler references across renders
  const callbacksRef = useRef({
    onMessage,
    onError,
    onOpen,
    onClose,
    onHeartbeat,
    onStateChange,
    events,
    onBeforeRequest,
  });

  // Synchronize callback references on each render pass to prevent stale closures without render-phase mutation
  useEffect(() => {
    callbacksRef.current = {
      onMessage,
      onError,
      onOpen,
      onClose,
      onHeartbeat,
      onStateChange,
      events,
      onBeforeRequest,
    };
  }, [
    onMessage,
    onError,
    onOpen,
    onClose,
    onHeartbeat,
    onStateChange,
    events,
    onBeforeRequest,
  ]);

  const hasBeforeRequest = Boolean(onBeforeRequest);
  const configKey = JSON.stringify(restConfig);

  // Instantiates the SseClient, attaches typed event listeners, applies configuration, and disposes on unmount
  useEffect(() => {
    let disposed = false;
    let clientInstance: SseClient | null = null;
    try {
      clientInstance = createNitroSse();
      clientRef.current = clientInstance;
      setClient(clientInstance);

      const parsedConfig: SseConfig = JSON.parse(configKey);
      const config: SseConfig = {
        ...parsedConfig,
        onBeforeRequest: callbacksRef.current.onBeforeRequest
          ? async () => {
              const headers = await callbacksRef.current.onBeforeRequest?.();
              return headers ?? {};
            }
          : undefined,
      };

      clientInstance.setup(config);

      // Attach typed event listeners — each guarded against late native callbacks arriving after dispose
      clientInstance.addEventListener('message', (e) => {
        if (disposed) return;
        callbacksRef.current.onMessage?.(e);
        if (e.event && e.event !== e.type) {
          callbacksRef.current.events?.[e.event]?.(e);
        }
      });

      clientInstance.addEventListener('error', (e) => {
        if (disposed) return;
        callbacksRef.current.onError?.(e);
      });

      clientInstance.addEventListener('open', (e) => {
        if (disposed) return;
        callbacksRef.current.onOpen?.(e);
      });

      clientInstance.addEventListener('close', (e) => {
        if (disposed) return;
        callbacksRef.current.onClose?.(e);
      });

      clientInstance.addEventListener('heartbeat', (e) => {
        if (disposed) return;
        callbacksRef.current.onHeartbeat?.(e);
      });

      clientInstance.addEventListener('state', (e) => {
        if (disposed) return;
        const newState = e.state ?? 'idle';
        setState(newState);
        setIsConnected(isConnectedState(newState));
        callbacksRef.current.onStateChange?.(newState);
      });

      if (autoStart) {
        clientInstance.start();
      }
      const initialState = clientInstance.getState();
      setState(initialState);
      setIsConnected(isConnectedState(initialState));
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error('[useNitroSse] Failed to initialize NitroSse client:', e);
      clientInstance?.dispose();
      clientRef.current = null;
      setClient(null);
      setIsConnected(false);
      setState('failed');
      callbacksRef.current.onError?.({
        type: 'error',
        message: errorMsg,
        statusCode: -1,
      });
      callbacksRef.current.onStateChange?.('failed');
      return;
    }

    return () => {
      disposed = true;
      clientInstance?.dispose();
      clientRef.current = null;
      setClient(null);
    };
  }, [configKey, autoStart, hasBeforeRequest]);

  // Imperative control callbacks wrapped in useCallback for stable references
  const start = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.start();
      const s = clientRef.current.getState();
      setState(s);
      setIsConnected(isConnectedState(s));
    }
  }, []);

  const stop = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.stop();
      const s = clientRef.current.getState();
      setState(s);
      setIsConnected(isConnectedState(s));
    }
  }, []);

  const restart = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.restart();
      const s = clientRef.current.getState();
      setState(s);
      setIsConnected(isConnectedState(s));
    }
  }, []);

  const flush = useCallback(() => {
    clientRef.current?.flush();
  }, []);

  const updateHeaders = useCallback((headers: Record<string, string>) => {
    clientRef.current?.updateHeaders(headers);
  }, []);

  const setLastProcessedId = useCallback((id: string) => {
    clientRef.current?.setLastProcessedId(id);
  }, []);

  const getStats = useCallback((): SseStats | undefined => {
    return clientRef.current?.getStats();
  }, []);

  const injectMockEvent = useCallback((event: Partial<SseEvent>) => {
    clientRef.current?.injectMockEvent(event);
  }, []);

  return {
    client: client ?? clientRef.current,
    state,
    isConnected,
    start,
    stop,
    restart,
    flush,
    updateHeaders,
    setLastProcessedId,
    getStats,
    injectMockEvent,
  };
}
