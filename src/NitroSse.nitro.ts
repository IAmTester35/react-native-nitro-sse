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

export interface NitroSse
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /**
   * Configure SSE and setup event callback.
   */
  setup(config: SseConfig, onEvent: (events: SseEvent[]) => void): void;

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
