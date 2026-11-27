import type { HybridObject, AnyMap } from 'react-native-nitro-modules';
import type {
  SseConfig,
  SseStats,
  SseState,
  SseEventType,
} from './SseInterface';

/**
 * Concrete SSE event representation passed across the JSI barrier.
 */
export interface SseEvent {
  /** The type of the event. */
  type: SseEventType;
  /**
   * The raw payload of the event.
   * - For `message` events: holds the SSE `data` field.
   * - For HTTP `error` events (`statusCode >= 400`): holds the bounded raw HTTP error response body
   *   (up to 8192 UTF-8 bytes; `undefined` when empty). Attached to both retryable and terminal error
   *   events (`data` does not indicate a terminal failure—check connection `state` to distinguish
   *   `'reconnecting'` vs `'failed'`). Responses exceeding 8192 UTF-8 bytes are truncated, so wrap
   *   `JSON.parse(event.data)` in `try/catch`.
   */
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

export interface NitroSse
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /**
   * Configure SSE, event callback, and optional dynamic request interceptor.
   */
  setup(
    config: SseConfig,
    onEvent: (events: SseEvent[]) => void,
    onBeforeRequest?: () => Promise<Record<string, string>>
  ): void;

  /**
   * Start the SSE connection.
   */
  start(): void;

  /**
   * Stop the SSE connection.
   */
  stop(): void;

  /**
   * Set the last processed event ID.
   * Native will use this ID to resume connection if interrupted.
   */
  setLastProcessedId(id: string): void;

  /**
   * Update HTTP headers dynamically (e.g., when token expires).
   * These headers will be used for subsequent connection/reconnection attempts.
   */
  updateHeaders(headers: Record<string, string>): void;

  /**
   * Get connection statistics.
   */
  getStats(): SseStats;
  /**
   * Manually flush the event buffer.
   * Useful when batching is enabled but you need to process pending events immediately.
   */
  flush(): void;

  /**
   * Force a reconnection.
   * This resets the connection state and attempts to reconnect immediately.
   */
  restart(): void;

  /**
   * Check if the connection is currently active.
   */
  isConnected(): boolean;

  /**
   * Get the current state of the connection.
   */
  getState(): SseState;
}
