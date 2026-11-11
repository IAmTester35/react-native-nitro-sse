import { useEffect, useRef, useState, useCallback } from 'react';
import { createNitroSse } from './createNitroSse';
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

  const prevHeaderKeysRef = useRef<string[]>(
    headers && typeof headers === 'object' ? Object.keys(headers).sort() : []
  );
  const lastSyncedHeadersKeyRef = useRef<string | null>(null);

  // Synchronize options, guard, and callback references after render commit without render-phase mutation
  useEffect(() => {
    headersRef.current = headers;
    restConfigRef.current = restConfig;
    hasValidUrlRef.current = hasValidUrl;
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
    headers,
    restConfig,
    hasValidUrl,
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
  const isHeadersUndefined = headers === undefined;
  const configKey = safeSerializeConfig(restConfig);
  const headersKey = safeSerializeConfig(headers);

  const initializeClient = useCallback((): SseClient | null => {
    let clientInstance: SseClient | null = null;
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
            const customEvents = callbacksRef.current.events;
            if (
              customEvents &&
              typeof customEvents === 'object' &&
              Object.prototype.hasOwnProperty.call(customEvents, e.event)
            ) {
              const handler = customEvents[e.event as keyof TEvents];
              if (typeof handler === 'function') {
                (handler as (event: SseEvent<unknown>) => void)(e);
              }
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
      return clientInstance;
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
      return null;
    }
  }, [autoStart]);

  // Instantiates the SseClient, attaches typed event listeners, applies configuration, and disposes on unmount
  // react-doctor-disable-next-line effect-needs-cleanup -- clientRef.current.dispose() completely releases all event listeners and native socket streams
  useEffect(() => {
    lastSyncedHeadersKeyRef.current = headersKey;
    prevHeaderKeysRef.current =
      headersRef.current && typeof headersRef.current === 'object'
        ? Object.keys(headersRef.current).sort()
        : [];

    if (!hasValidUrl) {
      if (
        autoStart &&
        typeof __DEV__ !== 'undefined' &&
        __DEV__ &&
        restConfigRef.current.url !== undefined
      ) {
        console.warn(
          '[useNitroSse] Missing or empty url in options. Connection will not start until a valid URL is provided.'
        );
      }
      setState('idle');
      clientRef.current = null;
      setClient(null);
      return () => {};
    }

    initializeClient();

    return () => {
      if (clientRef.current) {
        clientRef.current.dispose();
        clientRef.current = null;
        setClient(null);
      }
    };
    // Recreate client if headers becomes undefined to purge stale native headers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    configKey,
    autoStart,
    hasBeforeRequest,
    hasValidUrl,
    isHeadersUndefined,
    initializeClient,
  ]);

  // Synchronize headers dynamically without reconnecting, or recreate client if header keys were removed
  useEffect(() => {
    if (lastSyncedHeadersKeyRef.current === headersKey) {
      return;
    }
    lastSyncedHeadersKeyRef.current = headersKey;

    const currentHeaders = headersRef.current;
    const currentKeys =
      currentHeaders && typeof currentHeaders === 'object'
        ? Object.keys(currentHeaders).sort()
        : [];
    const currentKeysSet = new Set(currentKeys);
    const isKeyRemoved =
      currentHeaders !== undefined &&
      prevHeaderKeysRef.current.some((k) => !currentKeysSet.has(k));
    prevHeaderKeysRef.current = currentKeys;

    if (isKeyRemoved && hasValidUrlRef.current) {
      clientRef.current?.dispose();
      initializeClient();
      return;
    }

    if (clientRef.current && currentHeaders !== undefined) {
      try {
        clientRef.current.updateHeaders(currentHeaders);
      } catch (err) {
        console.error(
          '[useNitroSse] Failed to dynamically update headers:',
          err
        );
      }
    }
  }, [headersKey, initializeClient]);

  // Imperative control callbacks wrapped in useCallback for stable references
  const runClientAction = useCallback(
    (
      methodName: string,
      errorLabel: string,
      action: (instance: SseClient) => void,
      actionOptions?: { syncState?: boolean; checkUrl?: boolean }
    ) => {
      if (clientRef.current) {
        try {
          action(clientRef.current);
          if (actionOptions?.syncState) {
            setState(clientRef.current.getState());
          }
        } catch (err) {
          console.error(`[useNitroSse] Failed to ${errorLabel}:`, err);
        }
      } else if (typeof __DEV__ !== 'undefined' && __DEV__) {
        if (actionOptions?.checkUrl && !hasValidUrlRef.current) {
          console.warn(
            `[useNitroSse] Cannot ${methodName} SSE stream: url is empty or invalid.`
          );
        } else {
          console.warn(
            `[useNitroSse] ${methodName}() was called before the client was initialized.`
          );
        }
      }
    },
    []
  );

  const start = useCallback(
    () =>
      runClientAction('start', 'start client', (c) => c.start(), {
        syncState: true,
        checkUrl: true,
      }),
    [runClientAction]
  );

  const stop = useCallback(
    () =>
      runClientAction('stop', 'stop client', (c) => c.stop(), {
        syncState: true,
      }),
    [runClientAction]
  );

  const restart = useCallback(
    () =>
      runClientAction('restart', 'restart client', (c) => c.restart(), {
        syncState: true,
        checkUrl: true,
      }),
    [runClientAction]
  );

  const flush = useCallback(
    () => runClientAction('flush', 'flush events', (c) => c.flush()),
    [runClientAction]
  );

  const updateHeaders = useCallback(
    (newHeaders: Record<string, string>) =>
      runClientAction('updateHeaders', 'update headers', (c) =>
        c.updateHeaders(newHeaders)
      ),
    [runClientAction]
  );

  const setLastProcessedId = useCallback(
    (id: string) =>
      runClientAction('setLastProcessedId', 'set last processed ID', (c) =>
        c.setLastProcessedId(id)
      ),
    [runClientAction]
  );

  const getStats = useCallback((): SseStats | undefined => {
    try {
      return clientRef.current?.getStats();
    } catch {
      return undefined;
    }
  }, []);

  const injectMockEvent = useCallback(
    (event: Partial<SseEvent>) =>
      runClientAction('injectMockEvent', 'inject mock event', (c) =>
        c.injectMockEvent(event)
      ),
    [runClientAction]
  );

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
