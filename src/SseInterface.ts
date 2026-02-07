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
   * Note: OS limitations may restrict background execution time.
   * @default false
   */
  backgroundExecution?: boolean;
  /**
   * Interval in milliseconds to batch events before sending them to JS.
   * Set to 0 to disable batching (real-time mode).
   */
  batchingIntervalMs?: number;
  /**
   * Maximum number of events to hold in the buffer before forced flushing.
   */
  maxBufferSize?: number;
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
