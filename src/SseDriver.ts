import type { NitroSse } from './NitroSse.nitro';
import type { SseConfig, SseEvent, SseState, SseStats } from './SseInterface';
import { MockSseEngine } from './MockSseEngine';

/**
 * Internal execution strategy driving the SSE lifecycle.
 */
export interface SseDriver {
  setup(
    config: SseConfig,
    onBeforeRequest?: () => Promise<Record<string, string>>
  ): void;
  start(): void;
  stop(): void;
  restart(): void;
  flush(): void;
  isConnected(): boolean;
  getStats(): SseStats;
  getState(): SseState;
  updateHeaders(headers: Record<string, string>): void;
  setLastProcessedId(id: string): void;
  injectMockEvent(event: Partial<SseEvent>): void;
  dispose(): void;
}

/**
 * Driver delegating all operations to the native JSI NitroSse module.
 */
export class NativeDriver implements SseDriver {
  constructor(
    private _native: NitroSse,
    private _dispatchEvents: (events: SseEvent[]) => void
  ) {}

  setup(
    config: SseConfig,
    onBeforeRequest?: () => Promise<Record<string, string>>
  ): void {
    if (onBeforeRequest !== undefined) {
      this._native.setup(config, this._dispatchEvents, onBeforeRequest);
    } else {
      this._native.setup(config, this._dispatchEvents);
    }
  }

  start(): void {
    this._native.start();
  }

  stop(): void {
    this._native.stop();
  }

  restart(): void {
    this._native.restart();
  }

  flush(): void {
    this._native.flush();
  }

  isConnected(): boolean {
    return this._native.isConnected();
  }

  getStats(): SseStats {
    return this._native.getStats();
  }

  getState(): SseState {
    return this._native.getState();
  }

  updateHeaders(headers: Record<string, string>): void {
    this._native.updateHeaders(headers);
  }

  setLastProcessedId(id: string): void {
    this._native.setLastProcessedId(id);
  }

  injectMockEvent(event: Partial<SseEvent>): void {
    const sseEvent = MockSseEngine.createSseEvent(event);
    this._dispatchEvents([sseEvent]);
  }

  dispose(): void {
    // Note: dispose() is a built-in method provided by the HybridObject base class in react-native-nitro-modules
    // (registered on the JSI prototype via HybridObject::loadHybridMethods in C++). It forwards to native
    // dispose() implementations (NitroSse.swift and NitroSse.kt) without needing to be re-declared in NitroSse.nitro.ts.
    if (typeof this._native.dispose === 'function') {
      this._native.dispose();
    }
  }
}

/**
 * Driver simulating the entire SSE stream in JavaScript without native networking.
 */
export class MockReplaceDriver implements SseDriver {
  private _headers: Record<string, string> = {};
  private _lastProcessedId?: string;

  constructor(private _mockEngine: MockSseEngine) {}

  get headers(): Record<string, string> {
    return this._headers;
  }

  get lastProcessedId(): string | undefined {
    return this._lastProcessedId;
  }

  setup(
    config: SseConfig,
    _onBeforeRequest?: () => Promise<Record<string, string>>
  ): void {
    if (config.headers) {
      this._headers = { ...this._headers, ...config.headers };
    }
  }

  start(): void {
    this._mockEngine.start();
  }

  stop(): void {
    this._mockEngine.stop();
  }

  restart(): void {
    this._mockEngine.restart();
  }

  flush(): void {}

  isConnected(): boolean {
    return this._mockEngine.isConnected();
  }

  getStats(): SseStats {
    return this._mockEngine.getStats();
  }

  getState(): SseState {
    return this._mockEngine.getState();
  }

  updateHeaders(headers: Record<string, string>): void {
    this._headers = { ...this._headers, ...headers };
  }

  setLastProcessedId(id: string): void {
    this._lastProcessedId = id;
  }

  injectMockEvent(event: Partial<SseEvent>): void {
    this._mockEngine.injectEvent(event);
  }

  dispose(): void {
    this._mockEngine.stop();
  }
}

/**
 * Driver running underlying network streaming in parallel with mock event injection.
 */
export class MockInjectDriver implements SseDriver {
  constructor(
    private _realDriver: SseDriver,
    private _mockEngine: MockSseEngine
  ) {}

  setup(
    config: SseConfig,
    onBeforeRequest?: () => Promise<Record<string, string>>
  ): void {
    this._realDriver.setup(config, onBeforeRequest);
  }

  start(): void {
    this._mockEngine.start();
    this._realDriver.start();
  }

  stop(): void {
    this._mockEngine.stop();
    this._realDriver.stop();
  }

  restart(): void {
    this._mockEngine.restart();
    this._realDriver.restart();
  }

  flush(): void {
    this._realDriver.flush();
  }

  isConnected(): boolean {
    return this._realDriver.isConnected();
  }

  getStats(): SseStats {
    return this._realDriver.getStats();
  }

  getState(): SseState {
    return this._realDriver.getState();
  }

  updateHeaders(headers: Record<string, string>): void {
    this._realDriver.updateHeaders(headers);
  }

  setLastProcessedId(id: string): void {
    this._realDriver.setLastProcessedId(id);
  }

  injectMockEvent(event: Partial<SseEvent>): void {
    this._mockEngine.injectEvent(event);
  }

  dispose(): void {
    this._mockEngine.stop();
    this._realDriver.dispose();
  }
}
