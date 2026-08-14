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
}

/**
 * Driver simulating the entire SSE stream in JavaScript without native networking.
 */
export class MockReplaceDriver implements SseDriver {
  constructor(private _mockEngine: MockSseEngine) {}

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

  updateHeaders(_headers: Record<string, string>): void {}

  setLastProcessedId(_id: string): void {}

  injectMockEvent(event: Partial<SseEvent>): void {
    this._mockEngine.injectEvent(event);
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
}
