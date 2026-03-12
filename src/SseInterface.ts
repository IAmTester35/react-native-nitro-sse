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
 */
export type SseEventType = 'open' | 'message' | 'error' | 'close' | 'heartbeat';

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
   * Effectively the "Connect Timeout".
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
   * Async interceptor called before every connection attempt (including auto-reconnects).
   * Use this to refresh tokens or calculate dynamic headers.
   * Note: This is protected by a native timeout to prevent the app from hanging.
   */
  onBeforeRequest?: () => Promise<Record<string, string>>;
}

/**
 * Represents a single SSE event.
 */
export interface SseEvent {
  /** The type of the event. */
  type: SseEventType;
  /** The data payload of the event. */
  data?: string;
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
