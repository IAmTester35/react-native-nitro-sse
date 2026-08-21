import type { NitroSse } from './NitroSse.nitro';
import type { SseEvent, SseState, SseStats } from './SseInterface';
import { MockSseEngine } from './MockSseEngine';

/**
 * Internal execution strategy driving the SSE lifecycle.
 */
export interface SseDriver {
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
    if (typeof (this._native as any).dispose === 'function') {
      (this._native as any).dispose();
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
 * Driver running native networking in parallel with mock event injection.
 */
export class MockInjectDriver implements SseDriver {
  constructor(private _native: NitroSse, private _mockEngine: MockSseEngine) {}

  start(): void {
    this._mockEngine.start();
    this._native.start();
  }

  stop(): void {
    this._mockEngine.stop();
    this._native.stop();
  }

  restart(): void {
    this._mockEngine.restart();
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
    this._mockEngine.injectEvent(event);
  }

  dispose(): void {
    this._mockEngine.stop();
    this._native.dispose();
  }
}
