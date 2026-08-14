import type { NitroSse } from './NitroSse.nitro';
import type {
  SseClient,
  SseConfig,
  SseEvent,
  SseListener,
  SseStats,
  SseState,
} from './SseInterface';
import { MockSseEngine } from './MockSseEngine';
import {
  type SseDriver,
  NativeDriver,
  MockReplaceDriver,
  MockInjectDriver,
} from './SseDriver';

declare const __DEV__: boolean | undefined;

/**
 * Public facade and typed event emitter for NitroSse, delegating streaming execution to an SseDriver strategy.
 */
export class NitroSseClient implements SseClient {
  private _native: NitroSse;
  private _driver: SseDriver;
  private _listeners: Map<string, Set<SseListener>> = new Map();
  private _legacyCallback?: (events: SseEvent[]) => void;
  private _config?: SseConfig;

  constructor(native: NitroSse) {
    this._native = native;
    this._driver = new NativeDriver(native, (events) =>
      this._dispatchEvents(events)
    );
  }

  setup(config: SseConfig, onEvent?: (events: SseEvent[]) => void): void {
    this._config = { ...config };
    this._legacyCallback = onEvent;

    const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ === true : false;
    const mockConfig = isDev ? this._config.mock : undefined;
    if (!isDev) {
      delete this._config.mock;
    }

    if (mockConfig) {
      console.warn(
        '\n' +
          '=================================================================\n' +
          '⚠️  [react-native-nitro-sse] WARNING: MOCK STREAMING IS ENABLED! ⚠️\n' +
          `   Mode: ${mockConfig.mode.toUpperCase()} | Speed: ${
            mockConfig.eventsPerSecond ?? 1
          } events/sec\n` +
          '   Please ensure mocking is disabled before building for production!\n' +
          '=================================================================\n'
      );
      const mockEngine = new MockSseEngine(mockConfig, (events) => {
        this._dispatchEvents(events);
      });

      this._driver =
        mockConfig.mode === 'replace'
          ? new MockReplaceDriver(mockEngine)
          : new MockInjectDriver(this._native, mockEngine);
    } else {
      this._driver = new NativeDriver(this._native, (events) =>
        this._dispatchEvents(events)
      );
    }

    // Wrap the native setup to dispatch events to typed listeners
    this._native.setup(this._config, (events) => {
      this._dispatchEvents(events);
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

  private _dispatchEvents(events: SseEvent[]): void {
    this._legacyCallback?.(events);
    for (const event of events) {
      this._emit(event.type, event);
      if (event.event && event.event !== event.type) {
        this._emit(event.event, event);
      }
    }
  }

  start(): void {
    this._driver.start();
  }

  stop(): void {
    this._driver.stop();
  }

  restart(): void {
    this._driver.restart();
  }

  flush(): void {
    this._driver.flush();
  }

  isConnected(): boolean {
    return this._driver.isConnected();
  }

  getStats(): SseStats {
    return this._driver.getStats();
  }

  getState(): SseState {
    return this._driver.getState();
  }

  updateHeaders(headers: Record<string, string>): void {
    this._driver.updateHeaders(headers);
  }

  setLastProcessedId(id: string): void {
    this._driver.setLastProcessedId(id);
  }

  injectMockEvent(event: Partial<SseEvent>): void {
    this._driver.injectMockEvent(event);
  }
}
