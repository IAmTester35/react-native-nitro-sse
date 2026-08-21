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
  /** Restart the stream manually */
  restart: () => void;
  /** Flush buffered events */
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
 * React Hook for high-performance Server-Sent Events (SSE) streaming in React Native.
 * Automatically handles client instantiation, listener attachment, state tracking, and lifecycle disposal on unmount.
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

  // Initialize client lazily so it is available on first render
  const clientRef = useRef<SseClient | null>(null);
  if (clientRef.current === null) {
    try {
      clientRef.current = createNitroSse();
    } catch (e) {
      console.error('[useNitroSse] Failed to instantiate NitroSse client:', e);
    }
  }

  const [state, setState] = useState<SseState>(() =>
    clientRef.current ? clientRef.current.getState() : 'idle'
  );
  const [isConnected, setIsConnected] = useState<boolean>(() =>
    clientRef.current ? clientRef.current.isConnected() : false
  );

  // Sync latest callbacks in render body to prevent stale closures and avoid re-connection cycles
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

  const configKey = JSON.stringify(restConfig);

  useEffect(() => {
    let client = clientRef.current;
    if (!client) {
      try {
        client = createNitroSse();
        clientRef.current = client;
      } catch (e) {
        console.error('[useNitroSse] Failed to initialize NitroSse client:', e);
        return;
      }
    }

    const parsedConfig: SseConfig = JSON.parse(configKey);
    const config: SseConfig = {
      ...parsedConfig,
      onBeforeRequest: callbacksRef.current.onBeforeRequest
        ? () => callbacksRef.current.onBeforeRequest?.() ?? Promise.resolve({})
        : undefined,
    };

    client.setup(config);

    // Attach typed listeners
    client.addEventListener('message', (e) => {
      callbacksRef.current.onMessage?.(e);
      if (e.event) {
        callbacksRef.current.events?.[e.event]?.(e);
      }
    });

    client.addEventListener('error', (e) => {
      callbacksRef.current.onError?.(e);
    });

    client.addEventListener('open', (e) => {
      callbacksRef.current.onOpen?.(e);
    });

    client.addEventListener('close', (e) => {
      callbacksRef.current.onClose?.(e);
    });

    client.addEventListener('heartbeat', (e) => {
      callbacksRef.current.onHeartbeat?.(e);
    });

    client.addEventListener('state', (e) => {
      const newState = e.state ?? client.getState();
      setState(newState);
      setIsConnected(client.isConnected());
      callbacksRef.current.onStateChange?.(newState);
    });

    if (autoStart) {
      client.start();
    }
    setState(client.getState());
    setIsConnected(client.isConnected());

    return () => {
      client.dispose();
      clientRef.current = null;
      setState('closed');
      setIsConnected(false);
    };
  }, [configKey, autoStart]);

  const start = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.start();
      setState(clientRef.current.getState());
      setIsConnected(clientRef.current.isConnected());
    }
  }, []);

  const stop = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.stop();
      setState(clientRef.current.getState());
      setIsConnected(clientRef.current.isConnected());
    }
  }, []);

  const restart = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.restart();
      setState(clientRef.current.getState());
      setIsConnected(clientRef.current.isConnected());
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
    client: clientRef.current,
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
