import type { NitroSse } from './NitroSse.nitro';
import type {
  SseClient,
  SseConfig,
  SseEvent,
  SseListener,
  SseStats,
} from './SseInterface';

export class NitroSseClient implements SseClient {
  private _native: NitroSse;
  private _listeners: Map<string, Set<SseListener>> = new Map();
  private _legacyCallback?: (events: SseEvent[]) => void;

  constructor(native: NitroSse) {
    this._native = native;
  }

  setup(config: SseConfig, onEvent?: (events: SseEvent[]) => void): void {
    this._legacyCallback = onEvent;

    // We wrap the native setup to dispatch events to typed listeners
    this._native.setup(config, (events) => {
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

  updateHeaders(headers: Record<string, string>): void {
    this._native.updateHeaders(headers);
  }

  setLastProcessedId(id: string): void {
    this._native.setLastProcessedId(id);
  }
}
