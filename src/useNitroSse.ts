import { useEffect, useRef, useState, useCallback } from 'react';
import { createNitroSse } from './index';
import type {
  SseClient,
  SseClientOptions,
  SseEvent,
  SseState,
  SseStats,
} from './SseInterface';
import type { AnyMap } from 'react-native-nitro-modules';

type SseEventMap = object;

export interface UseNitroSseOptions<
  TEvents extends SseEventMap = Record<string, AnyMap>,
  TMessage = AnyMap
> extends SseClientOptions {
  /**
   * Whether to automatically start streaming on mount or when URL changes.
   * @default true
   */
  autoStart?: boolean;
  /** Map of handlers for specific custom event types */
  events?: {
    [K in keyof TEvents]?: (event: SseEvent<TEvents[K]>) => void;
  };
  /** Handler for incoming message events (both default and custom events) */
  onMessage?: (event: SseEvent<TMessage>) => void;
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
}

export interface UseNitroSseReturn {
  /** Underlying SseClient instance (null if uninitialized or failed) */
  client: SseClient | null;
  /** Whether the client instance has finished mounting and is ready */
  isReady: boolean;
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
 * Safely serializes an object into a stable JSON string:
 * - Sorts object keys to avoid reconnection on equivalent configs with reordered keys.
 * - Handles circular structures by substituting '[Circular]'.
 * - Handles BigInt by converting to string.
 * - Catches any unexpected serialization error and falls back gracefully.
 */
export function safeSerializeConfig(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return String(obj);
  }
  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
        if (!Array.isArray(value)) {
          const sorted: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(value).sort(([a], [b]) =>
            a.localeCompare(b)
          )) {
            sorted[k] = v;
          }
          return sorted;
        }
      }
      return value;
    });
  } catch (e) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        '[useNitroSse] Failed to serialize config object, falling back to string representation:',
        e
      );
    }
    return String(obj);
  }
}

/**
 * Derives the `isConnected` flag from the connection state without a native JSI call.
 * Matches the semantics of `SseClient.isConnected()`: true for 'connecting', 'open', or 'reconnecting'.
 */
function isConnectedState(s: SseState): boolean {
  return s === 'connecting' || s === 'open' || s === 'reconnecting';
}

/**
 * Automatically handles client instantiation, listener attachment, state tracking, and lifecycle disposal on unmount.
 *
 * @param options SSE configuration options, callbacks, and custom event handlers.
 * @returns State, client instance, and imperative control methods.
 */
export function useNitroSse<
  TEvents extends SseEventMap = Record<string, AnyMap>,
  TMessage = AnyMap
>(options: UseNitroSseOptions<TEvents, TMessage>): UseNitroSseReturn {
  const isValidOptions =
    Boolean(options) && typeof options === 'object' && !Array.isArray(options);
  const safeOptions: Partial<UseNitroSseOptions<TEvents, TMessage>> =
    isValidOptions ? options : {};

  if (!isValidOptions && typeof __DEV__ !== 'undefined' && __DEV__) {
    console.error(
      '[useNitroSse] Invalid options provided. Expected an options object.'
    );
  }

  const {
    autoStart = true,
    headers,
    onMessage,
    onError,
    onOpen,
    onClose,
    onHeartbeat,
    onStateChange,
    events,
    onBeforeRequest,
    ...restConfig
  } = safeOptions;

  // Underlying client reference for imperative callbacks
  const clientRef = useRef<SseClient | null>(null);
  const [client, setClient] = useState<SseClient | null>(null);

  const [state, setState] = useState<SseState>('idle');
  const isConnected = isConnectedState(state);

  // Validate URL presence for connection guard
  const hasValidUrl =
    typeof restConfig.url === 'string' && restConfig.url.trim().length > 0;

  // Keep references to latest options and guard without causing teardown
  const headersRef = useRef(headers);
  const restConfigRef = useRef(restConfig);
  const hasValidUrlRef = useRef(hasValidUrl);

  // Synchronize options and guard references after render commit without render-phase mutation
  useEffect(() => {
    headersRef.current = headers;
    restConfigRef.current = restConfig;
    hasValidUrlRef.current = hasValidUrl;
  }, [headers, restConfig, hasValidUrl]);

  // Callback ref holding the latest handler references across renders
  const callbacksRef = useRef<{
    onMessage?: (event: SseEvent<TMessage>) => void;
    onError?: (event: SseEvent) => void;
    onOpen?: (event: SseEvent) => void;
    onClose?: (event: SseEvent) => void;
    onHeartbeat?: (event: SseEvent) => void;
    onStateChange?: (state: SseState) => void;
    events?: { [K in keyof TEvents]?: (event: SseEvent<TEvents[K]>) => void };
    onBeforeRequest?: () => Promise<Record<string, string>>;
  }>({
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
  // Track undefined transition to recreate client and purge stale headers (e.g. on logout)
  const isHeadersUndefined = headers === undefined;
  const configKey = safeSerializeConfig(restConfig);
  const headersKey = safeSerializeConfig(headers);

  // Instantiates the SseClient, attaches typed event listeners, applies configuration, and disposes on unmount
  useEffect(() => {
    let clientInstance: SseClient | null = null;

    if (!hasValidUrl) {
      if (
        autoStart &&
        typeof __DEV__ !== 'undefined' &&
        __DEV__ &&
        restConfig.url !== undefined
      ) {
        console.warn(
          '[useNitroSse] Missing or empty url in options. Connection will not start until a valid URL is provided.'
        );
      }
      setState('idle');
      clientRef.current = null;
      setClient(null);
      return;
    }

    try {
      clientInstance = createNitroSse();
      clientRef.current = clientInstance;
      setClient(clientInstance);

      const config: SseClientOptions = {
        ...restConfigRef.current,
        url: restConfigRef.current.url ?? '',
        ...(headersRef.current !== undefined
          ? { headers: headersRef.current }
          : {}),
        onBeforeRequest: callbacksRef.current.onBeforeRequest
          ? async () => {
              return callbacksRef.current.onBeforeRequest!();
            }
          : undefined,
      };

      clientInstance.setup(config);

      // Attach typed event listeners
      clientInstance.addEventListener<TMessage>('message', (e) => {
        try {
          callbacksRef.current.onMessage?.(e);
        } catch (err) {
          console.error(
            '[useNitroSse] Unhandled error in onMessage callback:',
            err
          );
        }
        if (e.event && e.event !== e.type) {
          try {
            const handler =
              callbacksRef.current.events?.[e.event as keyof TEvents];
            if (handler) {
              (handler as (event: SseEvent<unknown>) => void)(e);
            }
          } catch (err) {
            console.error(
              `[useNitroSse] Unhandled error in events['${e.event}'] callback:`,
              err
            );
          }
        }
      });

      clientInstance.addEventListener('error', (e) => {
        callbacksRef.current.onError?.(e);
      });

      clientInstance.addEventListener('open', (e) => {
        callbacksRef.current.onOpen?.(e);
      });

      clientInstance.addEventListener('close', (e) => {
        callbacksRef.current.onClose?.(e);
      });

      clientInstance.addEventListener('heartbeat', (e) => {
        callbacksRef.current.onHeartbeat?.(e);
      });

      clientInstance.addEventListener('state', (e) => {
        const newState = e.state ?? 'idle';
        setState(newState);
        callbacksRef.current.onStateChange?.(newState);
      });

      if (autoStart) {
        clientInstance.start();
      }
      const initialState = clientInstance.getState();
      setState(initialState);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error('[useNitroSse] Failed to initialize NitroSse client:', e);
      clientInstance?.dispose();
      clientRef.current = null;
      setClient(null);
      setState('failed');
      try {
        callbacksRef.current.onError?.({
          type: 'error',
          message: errorMsg,
          statusCode: -1,
        });
      } catch (err) {
        console.error(
          '[useNitroSse] Unhandled error in onError during initialization failure:',
          err
        );
      }
      try {
        callbacksRef.current.onStateChange?.('failed');
      } catch (err) {
        console.error(
          '[useNitroSse] Unhandled error in onStateChange during initialization failure:',
          err
        );
      }
      return;
    }

    return () => {
      clientInstance?.dispose();
      clientRef.current = null;
      setClient(null);
    };
    // Recreate client if headers becomes undefined to purge stale native headers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey, autoStart, hasBeforeRequest, hasValidUrl, isHeadersUndefined]);

  // Synchronize headers dynamically without reconnecting or tearing down active socket
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (clientRef.current && headers !== undefined) {
      try {
        clientRef.current.updateHeaders(headers);
      } catch (err) {
        console.error(
          '[useNitroSse] Failed to dynamically update headers:',
          err
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headersKey]);

  // Imperative control callbacks wrapped in useCallback for stable references
  const start = useCallback(() => {
    if (clientRef.current) {
      try {
        clientRef.current.start();
        const s = clientRef.current.getState();
        setState(s);
      } catch (err) {
        console.error('[useNitroSse] Failed to start client:', err);
      }
    } else if (typeof __DEV__ !== 'undefined' && __DEV__) {
      if (!hasValidUrlRef.current) {
        console.warn(
          '[useNitroSse] Cannot start SSE stream: url is empty or invalid.'
        );
      } else {
        console.warn(
          '[useNitroSse] start() was called before the client was initialized.'
        );
      }
    }
  }, []);

  const stop = useCallback(() => {
    if (clientRef.current) {
      try {
        clientRef.current.stop();
        const s = clientRef.current.getState();
        setState(s);
      } catch (err) {
        console.error('[useNitroSse] Failed to stop client:', err);
      }
    } else if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        '[useNitroSse] stop() was called before the client was initialized.'
      );
    }
  }, []);

  const restart = useCallback(() => {
    if (clientRef.current) {
      try {
        clientRef.current.restart();
        const s = clientRef.current.getState();
        setState(s);
      } catch (err) {
        console.error('[useNitroSse] Failed to restart client:', err);
      }
    } else if (typeof __DEV__ !== 'undefined' && __DEV__) {
      if (!hasValidUrlRef.current) {
        console.warn(
          '[useNitroSse] Cannot restart SSE stream: url is empty or invalid.'
        );
      } else {
        console.warn(
          '[useNitroSse] restart() was called before the client was initialized.'
        );
      }
    }
  }, []);

  const flush = useCallback(() => {
    if (clientRef.current) {
      try {
        clientRef.current.flush();
      } catch (err) {
        console.error('[useNitroSse] Failed to flush events:', err);
      }
    } else if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        '[useNitroSse] flush() was called before the client was initialized.'
      );
    }
  }, []);

  const updateHeaders = useCallback((newHeaders: Record<string, string>) => {
    if (clientRef.current) {
      try {
        clientRef.current.updateHeaders(newHeaders);
      } catch (err) {
        console.error('[useNitroSse] Failed to update headers:', err);
      }
    } else if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        '[useNitroSse] updateHeaders() was called before the client was initialized.'
      );
    }
  }, []);

  const setLastProcessedId = useCallback((id: string) => {
    if (clientRef.current) {
      try {
        clientRef.current.setLastProcessedId(id);
      } catch (err) {
        console.error('[useNitroSse] Failed to set last processed ID:', err);
      }
    } else if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        '[useNitroSse] setLastProcessedId() was called before the client was initialized.'
      );
    }
  }, []);

  const getStats = useCallback((): SseStats | undefined => {
    try {
      return clientRef.current?.getStats();
    } catch {
      return undefined;
    }
  }, []);

  const injectMockEvent = useCallback((event: Partial<SseEvent>) => {
    if (clientRef.current) {
      try {
        clientRef.current.injectMockEvent(event);
      } catch (err) {
        console.error('[useNitroSse] Failed to inject mock event:', err);
      }
    } else if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        '[useNitroSse] injectMockEvent() was called before the client was initialized.'
      );
    }
  }, []);

  return {
    client: client ?? clientRef.current,
    isReady: Boolean(client ?? clientRef.current),
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
