import type { AnyMap } from 'react-native-nitro-modules';
/**
 * HTTP method to use for the SSE connection.
 */
export type HttpMethod = 'get' | 'post';

/**
 * Type of event received from the SSE stream.
 * - `open`: Connection established.
 * - `message`: Standard data message.
 * - `error`: Connection error or other failure.
 * - `close`: Connection closed (not typical for SSE, but used for cleanup).
 * - `heartbeat`: Ping/Keep-alive signal.
 * - `state`: Connection state change.
 */
export type SseEventType =
  | 'open'
  | 'message'
  | 'error'
  | 'close'
  | 'heartbeat'
  | 'state';

/**
 * State of the SSE connection.
 */
export type SseState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'stale'
  | 'reconnecting'
  | 'paused'
  | 'closed'
  | 'failed';

/**
 * Configuration for the SSE connection.
 */
export interface SseConfig {
  /** The URL of the SSE endpoint. */
  url: string;
  /** HTTP method (default: 'GET'). */
  method?: HttpMethod;
  /** Custom HTTP headers to include in the request. */
  headers?: Record<string, string>;
  /** Body for POST requests. */
  body?: string;
  /**
   * Whether to continue processing events when the app is in the background.
   * Note: On iOS, this uses background tasks which are limited in time by the OS.
   * @default false
   */
  backgroundExecution?: boolean;
  /**
   * How long (in ms) to wait and group multiple events before sending them to the JS side.
   * High-frequency streams should use this to reduce JS bridge overhead and improve UI performance.
   * Set to 0 to deliver events immediately one-by-one.
   * @default 0
   */
  batchingIntervalMs?: number;
  /**
   * Maximum number of events to keep in the native buffer before forcing a flush to JS,
   * regardless of the `batchingIntervalMs`. Prevents memory pressure.
   * @default 1000
   */
  maxBufferSize?: number;
  /**
   * Maximum time (in ms) to wait for the initial server connection and handshake to complete.
   * Effectively the \"Connect Timeout\".
   * @default 15000
   */
  connectionTimeoutMs?: number;
  /**
   * Maximum idle time (in ms) allowed between receiving data packets or heartbeats.
   * If the server remains silent longer than this, the connection is considered stalled and will reconnect.
   * Increase this for streams that transmit data infrequently.
   * @default 300000
   */
  readTimeoutMs?: number;
  /**
   * Initial delay (in ms) for reconnection attempts.
   * Subsequent attempts use exponential backoff.
   * @default 1000
   */
  retryIntervalMs?: number;
  /**
   * Maximum delay (in ms) for reconnection attempts.
   * @default 30000
   */
  maxRetryIntervalMs?: number;
  /**
   * Factor to randomize reconnection attempts (0.0 to 1.0).
   * 0 means no jitter, 1.0 means up to 100% randomization.
   * @default 0.5
   */
  jitterFactor?: number;
  /**
   * Maximum number of reconnection attempts before giving up.
   * Use -1 for infinite (default), 0 to disable auto-reconnection.
   * @default -1
   */
  maxReconnectAttempts?: number;
  /**
   * Whether to automatically parse message data as JSON in a background native thread.
   * If true, and parsing succeeds, the result will be available in the 'parsedData' field.
   * @default false
   */
  autoParseJSON?: boolean;
  /**
   * Whether to automatically monitor network connectivity changes.
   * If true, the client will proactively reconnect when switching networks (WiFi <-> Cellular)
   * and pause/resume based on internet availability.
   * @default true
   */
  monitorNetwork?: boolean;
  /**
   * Async interceptor called before every connection attempt (including auto-reconnects).
   * Use this to refresh tokens or calculate dynamic headers.
   * Note: This is protected by a native timeout to prevent the app from hanging.
   */
  onBeforeRequest?: () => Promise<Record<string, string>>;
  /**
   * Configuration for mock streaming data.
   * Used for local testing and debugging.
   */
  mock?: SseMockConfig;
}

export type SseMockMode = 'replace' | 'inject';

/**
 * Represents a single mock SSE event configuration.
 */
export interface SseMockEvent {
  /** The type of the event. */
  type?: SseEventType;
  /** The data payload of the event as a raw string. */
  data?: string;
  /** The parsed JSON data, if autoParseJSON is enabled and parsing succeeds. */
  parsedData?: AnyMap;
  /** The event ID, if provided. */
  id?: string;
  /** The event name, if provided (internal 'event' field in SSE). */
  event?: string;
  /** System message or error description. */
  message?: string;
  /** HTTP status code if applicable. */
  statusCode?: number;
  /** Server-requested retry delay in milliseconds. */
  retry?: number;
  /** Custom delay in milliseconds before this event is dispatched. */
  delayMs?: number;
}

/**
 * Configuration for mock streaming data.
 */
export interface SseMockConfig {
  /**
   * - 'replace': Simulates the stream completely in JavaScript without any native network connection.
   * - 'inject': Establishes the real server connection and injects mock events alongside it.
   */
  mode: SseMockMode;
  /**
   * The list of mock events to be streamed.
   */
  data: SseMockEvent[];
  /**
   * The frequency at which mock events are dispatched.
   * Represented in events per second.
   * @default 1
   */
  eventsPerSecond?: number;
  /**
   * Whether to loop the mock stream indefinitely.
   * @default false
   */
  loop?: boolean;
  /**
   * Probability of simulated connection drop/error events (0.0 to 1.0).
   * @default 0
   */
  errorRate?: number;
}

/**
 * Represents a single SSE event.
 */
export interface SseEvent {
  /** The type of the event. */
  type: SseEventType;
  /** The data payload of the event as a raw string. */
  data?: string;
  /** The parsed JSON data, if autoParseJSON is enabled and parsing succeeds. */
  parsedData?: AnyMap;
  /** The event ID, if provided. */
  id?: string;
  /** The event name, if provided (internal 'event' field in SSE). */
  event?: string;
  /** System message or error description. */
  message?: string;
  /** HTTP status code if applicable. */
  statusCode?: number;
  /** Server-requested retry delay in milliseconds. */
  retry?: number;
  /** The current connection state (only available if type is 'state'). */
  state?: SseState;
}

/**
 * Statistics about the SSE connection.
 */
export interface SseStats {
  /** Total bytes received so far. */
  totalBytesReceived: number;
  /** Number of times the connection has been re-established. */
  reconnectCount: number;
  /** Timestamp of the last error event. */
  lastErrorTime?: number;
  /** Error code of the last error. */
  lastErrorCode?: string;
}

/**
 * Listener for a specific SSE event.
 */
export type SseListener = (event: SseEvent) => void;

/**
 * Public interface for the NitroSse client, supporting typed event listeners.
 */
export interface SseClient {
  /**
   * Configure SSE and setup event callback.
   * @param config The SSE configuration.
   * @param onEvent Optional legacy batch callback for all events.
   */
  setup(config: SseConfig, onEvent?: (events: SseEvent[]) => void): void;

  /**
   * Register a listener for a specific event type ('message', 'open', etc.)
   * or a custom SSE event name (from the 'event:' field).
   */
  addEventListener(type: string, listener: SseListener): void;

  /**
   * Unregister a listener.
   */
  removeEventListener(type: string, listener: SseListener): void;

  /** Start the connection. */
  start(): void;
  /** Stop the connection. */
  stop(): void;
  /** Restart the connection (stop + start). */
  restart(): void;
  /** Force flush buffered events to JS. */
  flush(): void;
  /** Check if active. */
  isConnected(): boolean;
  /** Get stats. */
  getStats(): SseStats;
  /** Manually update headers. */
  updateHeaders(headers: Record<string, string>): void;
  /** Set last event ID. */
  setLastProcessedId(id: string): void;
  /** Manually inject a mock event into the stream (for testing/debugging). */
  injectMockEvent(event: Partial<SseEvent>): void;
  /** Get current connection state. */
  getState(): SseState;
}
