import type { NitroSse } from './NitroSse.nitro';
import type {
  SseClient,
  SseConfig,
  SseEvent,
  SseListener,
  SseStats,
} from './SseInterface';

declare const __DEV__: boolean | undefined;

export class NitroSseClient implements SseClient {
  private _native: NitroSse;
  private _listeners: Map<string, Set<SseListener>> = new Map();
  private _legacyCallback?: (events: SseEvent[]) => void;
  private _config?: SseConfig;
  private _mockIntervalId?: any;
  private _mockIndex: number = 0;

  constructor(native: NitroSse) {
    this._native = native;
  }

  setup(config: SseConfig, onEvent?: (events: SseEvent[]) => void): void {
    this._config = { ...config };
    this._legacyCallback = onEvent;

    const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ === true : false;
    if (!isDev) {
      delete this._config.mock;
    }

    if (this._config.mock) {
      console.warn(
        '\n' +
          '=================================================================\n' +
          '⚠️  [react-native-nitro-sse] WARNING: MOCK STREAMING IS ENABLED! ⚠️\n' +
          `   Mode: ${this._config.mock.mode.toUpperCase()} | Speed: ${
            this._config.mock.eventsPerSecond ?? 1
          } events/sec\n` +
          '   Please ensure mocking is disabled before building for production!\n' +
          '=================================================================\n'
      );
    }

    if (this._mockIntervalId) {
      clearTimeout(this._mockIntervalId);
      this._mockIntervalId = undefined;
    }

    // We wrap the native setup to dispatch events to typed listeners
    this._native.setup(this._config, (events) => {
      // 1. Call legacy batch callback if provided
      this._legacyCallback?.(events);

      // 2. Dispatch individual events to registered listeners
      for (const event of events) {
        // Dispatch basic types: 'open', 'message', 'error', 'close', 'heartbeat'
        this._emit(event.type, event);

        // Dispatch by SSE event name if it's different from the type
        // e.g., if type is 'message' but event name is 'update'
        if (event.event && event.event !== event.type) {
          this._emit(event.event, event);
        }
      }
    });
  }

  addEventListener(type: string, listener: SseListener): void {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: SseListener): void {
    this._listeners.get(type)?.delete(listener);
  }

  private _emit(type: string, event: SseEvent): void {
    const listeners = this._listeners.get(type);
    if (listeners) {
      listeners.forEach((listener) => {
        try {
          listener(event);
        } catch (e) {
          console.error(`[NitroSse] Error in event listener for "${type}":`, e);
        }
      });
    }
  }

  private _createSseEvent(rawMock: any): SseEvent {
    return {
      type: rawMock.type ?? 'message',
      data: rawMock.data,
      parsedData: rawMock.parsedData,
      id: rawMock.id,
      event: rawMock.event,
      message: rawMock.message,
      statusCode: rawMock.statusCode ?? 200,
      retry: rawMock.retry,
    };
  }

  start(): void {
    if (this._mockIntervalId) {
      clearTimeout(this._mockIntervalId);
      this._mockIntervalId = undefined;
    }

    if (this._config?.mock) {
      const {
        mode,
        data,
        eventsPerSecond = 1,
        loop = false,
        errorRate = 0,
      } = this._config.mock;
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
            const closeEvent: SseEvent = { type: 'close', statusCode: 200 };
            this._legacyCallback?.([closeEvent]);
            this._emit('close', closeEvent);
            return;
          }
        }

        // Simulate connection drops
        if (validatedErrorRate && Math.random() < validatedErrorRate) {
          const errorEvent: SseEvent = {
            type: 'error',
            message: 'Mock Connection Drop (Simulated Error)',
            statusCode: 500,
          };
          this._legacyCallback?.([errorEvent]);
          this._emit('error', errorEvent);

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
            batch.push(this._createSseEvent(rawMock));
          }
        } else {
          for (let i = 0; i < batchSize && this._mockIndex < data.length; i++) {
            const nextItem = data[this._mockIndex];
            if (nextItem && typeof nextItem.delayMs === 'number') {
              break;
            }
            const rawMock = data[this._mockIndex++];
            if (rawMock) {
              batch.push(this._createSseEvent(rawMock));
            }
          }
        }

        if (batch.length > 0) {
          // 1. Call legacy batch callback if provided
          this._legacyCallback?.(batch);

          // 2. Dispatch individual events to registered listeners
          for (const event of batch) {
            this._emit(event.type, event);
            if (event.event && event.event !== event.type) {
              this._emit(event.event, event);
            }
          }
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
        // Emit simulated open event
        const openEvent: SseEvent = { type: 'open', statusCode: 200 };
        this._legacyCallback?.([openEvent]);
        this._emit('open', openEvent);

        this._mockIntervalId = setTimeout(scheduleNext, firstDelay);
        return; // Skip native start
      } else if (mode === 'inject') {
        this._mockIntervalId = setTimeout(scheduleNext, firstDelay);
      }
    }

    this._native.start();
  }

  stop(): void {
    if (this._mockIntervalId) {
      clearTimeout(this._mockIntervalId);
      this._mockIntervalId = undefined;
    }
    this._native.stop();
  }

  restart(): void {
    if (this._config?.mock) {
      this.stop();
      this.start();
    } else {
      this._native.restart();
    }
  }

  flush(): void {
    this._native.flush();
  }

  isConnected(): boolean {
    if (this._config?.mock?.mode === 'replace' && this._mockIntervalId) {
      return true;
    }
    return this._native.isConnected();
  }

  getStats(): SseStats {
    if (this._config?.mock?.mode === 'replace') {
      return {
        totalBytesReceived: this._mockIndex * 150,
        reconnectCount: 0,
      };
    }
    return this._native.getStats();
  }

  updateHeaders(headers: Record<string, string>): void {
    this._native.updateHeaders(headers);
  }

  setLastProcessedId(id: string): void {
    this._native.setLastProcessedId(id);
  }

  injectMockEvent(event: Partial<SseEvent>): void {
    const sseEvent = this._createSseEvent(event);
    this._legacyCallback?.([sseEvent]);
    this._emit(sseEvent.type, sseEvent);
    if (sseEvent.event && sseEvent.event !== sseEvent.type) {
      this._emit(sseEvent.event, sseEvent);
    }
  }
}
