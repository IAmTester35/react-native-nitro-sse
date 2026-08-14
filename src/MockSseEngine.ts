import type {
  SseEvent,
  SseMockConfig,
  SseMockEvent,
  SseState,
  SseStats,
} from './SseInterface';

/**
 * Encapsulates mock streaming logic for testing and offline simulation.
 * Handles timer intervals, looping, custom delays, simulated error rates, and mock state tracking.
 */
export class MockSseEngine {
  private _config: SseMockConfig;
  private _emitEvents: (events: SseEvent[]) => void;
  private _mockIntervalId?: any;
  private _mockIndex: number = 0;
  private _mockState?: SseState;

  constructor(config: SseMockConfig, emitEvents: (events: SseEvent[]) => void) {
    this._config = config;
    this._emitEvents = emitEvents;
  }

  get isReplaceMode(): boolean {
    return this._config.mode === 'replace';
  }

  get isInjectMode(): boolean {
    return this._config.mode === 'inject';
  }

  get mode(): string {
    return this._config.mode;
  }

  get eventsPerSecond(): number | undefined {
    return this._config.eventsPerSecond;
  }

  /**
   * Transforms a raw mock event definition or partial SSE event into a full SseEvent DTO.
   */
  static createSseEvent(
    rawMock: Partial<SseMockEvent> | Partial<SseEvent>
  ): SseEvent {
    return {
      type: rawMock.type ?? 'message',
      data: rawMock.data,
      parsedData: rawMock.parsedData,
      id: rawMock.id,
      event: rawMock.event,
      message: rawMock.message,
      statusCode: rawMock.statusCode ?? 200,
      retry: rawMock.retry,
      state: rawMock.state,
    };
  }

  private _setMockState(state: SseState): void {
    if (this._mockState !== state) {
      this._mockState = state;
      const stateEvent: SseEvent = { type: 'state', state, statusCode: 200 };
      this._emitEvents([stateEvent]);
    }
  }

  /**
   * Starts mock stream scheduling.
   * @returns true if native stream should be skipped (replace mode), false otherwise (inject mode).
   */
  start(): boolean {
    if (this._mockIntervalId) {
      clearTimeout(this._mockIntervalId);
      this._mockIntervalId = undefined;
    }

    const {
      mode,
      data,
      eventsPerSecond = 1,
      loop = false,
      errorRate = 0,
    } = this._config;
    this._mockIndex = 0;

    // Validate and normalize eventsPerSecond (must be a finite positive number, default to 1)
    let validatedEventsPerSecond = Number(eventsPerSecond);
    if (
      Number.isNaN(validatedEventsPerSecond) ||
      !Number.isFinite(validatedEventsPerSecond) ||
      validatedEventsPerSecond <= 0
    ) {
      validatedEventsPerSecond = 1;
    }

    // Validate and normalize errorRate (must be a finite number within [0,1], default to 0)
    let validatedErrorRate = Number(errorRate);
    if (
      Number.isNaN(validatedErrorRate) ||
      !Number.isFinite(validatedErrorRate)
    ) {
      validatedErrorRate = 0;
    } else {
      validatedErrorRate = Math.max(0, Math.min(1, validatedErrorRate));
    }

    const delayMs = 1000 / validatedEventsPerSecond;
    // Safeguard: if eventsPerSecond is huge (e.g. 1000), setInterval/setTimeout is too slow.
    // We batch events together in chunks if the calculated interval is under 10ms.
    const batchSize = Math.max(1, Math.round(validatedEventsPerSecond / 100)); // chunk size for 10ms intervals
    const intervalMs = Math.max(10, delayMs * batchSize);

    const scheduleNext = () => {
      if (this._mockIndex >= data.length) {
        if (loop && data.length > 0) {
          this._mockIndex = 0;
        } else {
          if (this._mockIntervalId) {
            clearTimeout(this._mockIntervalId);
            this._mockIntervalId = undefined;
          }
          if (mode === 'replace') {
            this._setMockState('closed');
          }
          const closeEvent: SseEvent = { type: 'close', statusCode: 200 };
          this._emitEvents([closeEvent]);
          return;
        }
      }

      // Simulate connection drops
      if (validatedErrorRate && Math.random() < validatedErrorRate) {
        if (mode === 'replace') {
          this._setMockState('reconnecting');
        }
        const errorEvent: SseEvent = {
          type: 'error',
          message: 'Mock Connection Drop (Simulated Error)',
          statusCode: 500,
        };
        this._emitEvents([errorEvent]);

        // Retry / reconnect delay simulator (e.g. 2000ms)
        this._mockIntervalId = setTimeout(scheduleNext, 2000);
        return;
      }

      const currentItem = data[this._mockIndex];
      const hasCustomDelay =
        currentItem && typeof currentItem.delayMs === 'number';

      const batch: SseEvent[] = [];
      if (hasCustomDelay) {
        const rawMock = data[this._mockIndex++];
        if (rawMock) {
          batch.push(MockSseEngine.createSseEvent(rawMock));
        }
      } else {
        for (let i = 0; i < batchSize && this._mockIndex < data.length; i++) {
          const nextItem = data[this._mockIndex];
          if (nextItem && typeof nextItem.delayMs === 'number') {
            break;
          }
          const rawMock = data[this._mockIndex++];
          if (rawMock) {
            batch.push(MockSseEngine.createSseEvent(rawMock));
          }
        }
      }

      if (batch.length > 0) {
        if (mode === 'replace') {
          this._setMockState('open');
        }
        this._emitEvents(batch);
      }

      const nextDelay = hasCustomDelay ? currentItem.delayMs! : intervalMs;
      this._mockIntervalId = setTimeout(scheduleNext, nextDelay);
    };

    const firstItem = data[0];
    const firstDelay =
      firstItem && typeof firstItem.delayMs === 'number'
        ? firstItem.delayMs
        : intervalMs;

    if (mode === 'replace') {
      this._setMockState('connecting');
      this._setMockState('open');

      // Emit simulated open event
      const openEvent: SseEvent = { type: 'open', statusCode: 200 };
      this._emitEvents([openEvent]);

      this._mockIntervalId = setTimeout(scheduleNext, firstDelay);
      return true; // Indicates replace mode (skip native start)
    } else if (mode === 'inject') {
      this._mockIntervalId = setTimeout(scheduleNext, firstDelay);
      return false; // Indicates inject mode (continue native start)
    }

    return false;
  }

  stop(): void {
    if (this._mockIntervalId) {
      clearTimeout(this._mockIntervalId);
      this._mockIntervalId = undefined;
    }
    if (this._config.mode === 'replace') {
      this._setMockState('closed');
    }
  }

  restart(): void {
    this.stop();
    this.start();
  }

  isConnected(): boolean {
    return (
      this._mockState === 'open' ||
      this._mockState === 'connecting' ||
      this._mockState === 'reconnecting'
    );
  }

  getStats(): SseStats {
    return {
      totalBytesReceived: this._mockIndex * 150,
      reconnectCount: 0,
    };
  }

  getState(): SseState {
    return this._mockState ?? 'idle';
  }

  resetState(): void {
    this._mockState = undefined;
    if (this._mockIntervalId) {
      clearTimeout(this._mockIntervalId);
      this._mockIntervalId = undefined;
    }
  }

  injectEvent(event: Partial<SseEvent>): void {
    const sseEvent = MockSseEngine.createSseEvent(event);
    this._emitEvents([sseEvent]);
  }
}
