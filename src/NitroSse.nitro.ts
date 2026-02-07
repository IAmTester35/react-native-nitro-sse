import type { HybridObject } from 'react-native-nitro-modules';
import type { SseConfig, SseEvent, SseStats } from './SseInterface';

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
}
