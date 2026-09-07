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
import {
  NitroSseValidationError,
  NitroSseDisposedError,
  NitroSseStateError,
} from './NitroSseError';

declare const __DEV__: boolean | undefined;

/**
 * Sanitizes HTTP headers by stripping carriage returns, newlines, null bytes,
 * converting non-string values to strings, and pruning null/undefined values.
 */
export function sanitizeHeaders(
  headers?: Record<string, string>
): Record<string, string> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return {};
  }
  const clean: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(headers)) {
    if (rawValue === null || rawValue === undefined) continue;
    const cleanKey = String(key)
      .replace(/[\r\n\0]+/g, '')
      .trim();
    if (!cleanKey) continue;
    const cleanVal = String(rawValue).replace(/[\r\n\0]+/g, '');
    clean[cleanKey] = cleanVal;
  }
  return clean;
}

/**
 * Defensively validates and normalizes the SSE configuration object.
 * Throws NitroSseValidationError if essential requirements (e.g. valid URL) are violated.
 * Clamps numeric properties to safe boundaries and warns in __DEV__.
 */
export function validateConfig(config: SseConfig): SseConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new NitroSseValidationError(
      '[NitroSse] Invalid config: Expected a configuration object.',
      'INVALID_CONFIG',
      { received: config }
    );
  }

  if (typeof config.url !== 'string' || !config.url.trim()) {
    throw new NitroSseValidationError(
      "[NitroSse] Invalid config: 'url' must be a non-empty string.",
      'INVALID_CONFIG',
      { received: (config as any).url }
    );
  }

  const trimmedUrl = config.url.trim();
  const lowerUrl = trimmedUrl.toLowerCase();
  if (
    // eslint-disable-next-line no-script-url
    lowerUrl.startsWith('javascript:') ||
    lowerUrl.startsWith('data:') ||
    lowerUrl.startsWith('file:') ||
    lowerUrl.startsWith('ftp:')
  ) {
    throw new NitroSseValidationError(
      `[NitroSse] Invalid config: Unsupported protocol in URL "${trimmedUrl}". SSE requires HTTP or HTTPS.`,
      'INVALID_CONFIG',
      { url: trimmedUrl }
    );
  }

  if (!lowerUrl.startsWith('http://') && !lowerUrl.startsWith('https://')) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        `[NitroSse] URL "${trimmedUrl}" does not start with http:// or https://. Ensure it is an absolute URL; relative paths will fail on native.`
      );
    }
  }

  if (config.headers !== undefined) {
    if (
      !config.headers ||
      typeof config.headers !== 'object' ||
      Array.isArray(config.headers)
    ) {
      throw new NitroSseValidationError(
        "[NitroSse] Invalid config: 'headers' must be an object of key-value pairs.",
        'INVALID_CONFIG',
        { received: config.headers }
      );
    }
  }

  let lowerMethod: 'get' | 'post' | undefined;
  if (config.method !== undefined) {
    if (typeof config.method !== 'string') {
      throw new NitroSseValidationError(
        `[NitroSse] Invalid config: 'method' must be a string ('get' or 'post').`,
        'INVALID_CONFIG',
        { received: config.method }
      );
    }
    const lm = config.method.toLowerCase();
    if (lm !== 'get' && lm !== 'post') {
      throw new NitroSseValidationError(
        `[NitroSse] Invalid config: 'method' must be 'get' or 'post', received '${config.method}'.`,
        'INVALID_CONFIG',
        { received: config.method }
      );
    }
    lowerMethod = lm as 'get' | 'post';
  }

  if (
    config.onBeforeRequest !== undefined &&
    typeof config.onBeforeRequest !== 'function'
  ) {
    throw new NitroSseValidationError(
      "[NitroSse] Invalid config: 'onBeforeRequest' must be a function.",
      'INVALID_CONFIG',
      { received: typeof config.onBeforeRequest }
    );
  }

  let connectionTimeoutMs = config.connectionTimeoutMs;
  if (connectionTimeoutMs !== undefined) {
    if (!Number.isFinite(connectionTimeoutMs) || connectionTimeoutMs < 0) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(
          `[NitroSse] Invalid connectionTimeoutMs (${connectionTimeoutMs}). Resetting to default 15000.`
        );
      }
      connectionTimeoutMs = 15000;
    }
  }

  let readTimeoutMs = config.readTimeoutMs;
  if (readTimeoutMs !== undefined) {
    if (!Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(
          `[NitroSse] Invalid readTimeoutMs (${readTimeoutMs}). Resetting to default 300000.`
        );
      }
      readTimeoutMs = 300000;
    }
  }

  let batchingIntervalMs = config.batchingIntervalMs;
  if (batchingIntervalMs !== undefined) {
    if (!Number.isFinite(batchingIntervalMs) || batchingIntervalMs < 0) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(
          `[NitroSse] Invalid batchingIntervalMs (${batchingIntervalMs}). Clamping to 0.`
        );
      }
      batchingIntervalMs = 0;
    }
  }

  let maxBufferSize = config.maxBufferSize;
  if (maxBufferSize !== undefined) {
    if (!Number.isFinite(maxBufferSize) || maxBufferSize <= 0) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(
          `[NitroSse] Invalid maxBufferSize (${maxBufferSize}). Resetting to default 1000.`
        );
      }
      maxBufferSize = 1000;
    }
  }

  let retryIntervalMs = config.retryIntervalMs;
  let maxRetryIntervalMs = config.maxRetryIntervalMs;
  if (retryIntervalMs !== undefined) {
    if (!Number.isFinite(retryIntervalMs) || retryIntervalMs < 0) {
      retryIntervalMs = 1000;
    }
  }
  if (maxRetryIntervalMs !== undefined) {
    if (!Number.isFinite(maxRetryIntervalMs) || maxRetryIntervalMs < 0) {
      maxRetryIntervalMs = 30000;
    }
  }
  if (
    retryIntervalMs !== undefined &&
    maxRetryIntervalMs !== undefined &&
    retryIntervalMs > maxRetryIntervalMs
  ) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        `[NitroSse] retryIntervalMs (${retryIntervalMs}) cannot exceed maxRetryIntervalMs (${maxRetryIntervalMs}). Clamping retryIntervalMs.`
      );
    }
    retryIntervalMs = maxRetryIntervalMs;
  }

  let jitterFactor = config.jitterFactor;
  if (jitterFactor !== undefined) {
    if (
      !Number.isFinite(jitterFactor) ||
      jitterFactor < 0 ||
      jitterFactor > 1
    ) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(
          `[NitroSse] Invalid jitterFactor (${jitterFactor}). Clamping between 0.0 and 1.0.`
        );
      }
      jitterFactor = Math.max(
        0,
        Math.min(1, Number.isFinite(jitterFactor) ? jitterFactor : 0.5)
      );
    }
  }

  let maxReconnectAttempts = config.maxReconnectAttempts;
  if (maxReconnectAttempts !== undefined) {
    if (!Number.isFinite(maxReconnectAttempts) || maxReconnectAttempts < -1) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(
          `[NitroSse] Invalid maxReconnectAttempts (${maxReconnectAttempts}). Defaulting to -1 (infinite).`
        );
      }
      maxReconnectAttempts = -1;
    }
  }

  let maxAuthRetries = config.maxAuthRetries;
  if (maxAuthRetries !== undefined) {
    if (!Number.isFinite(maxAuthRetries) || maxAuthRetries < 0) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(
          `[NitroSse] Invalid maxAuthRetries (${maxAuthRetries}). Defaulting to 3.`
        );
      }
      maxAuthRetries = 3;
    }
  }

  if (config.mock !== undefined) {
    if (!config.mock || typeof config.mock !== 'object') {
      throw new NitroSseValidationError(
        '[NitroSse] Invalid mock config: Expected an object.',
        'INVALID_CONFIG',
        { received: config.mock }
      );
    }
    if (config.mock.mode !== 'replace' && config.mock.mode !== 'inject') {
      throw new NitroSseValidationError(
        `[NitroSse] Invalid mock config: 'mode' must be 'replace' or 'inject', received '${
          (config.mock as any).mode
        }'.`,
        'INVALID_CONFIG',
        { received: config.mock.mode }
      );
    }
    if (!Array.isArray(config.mock.data)) {
      throw new NitroSseValidationError(
        "[NitroSse] Invalid mock config: 'data' must be an array of mock events.",
        'INVALID_CONFIG',
        { received: typeof config.mock.data }
      );
    }
  }

  return {
    ...config,
    url: trimmedUrl,
    ...(lowerMethod !== undefined ? { method: lowerMethod } : {}),
    ...(connectionTimeoutMs !== undefined ? { connectionTimeoutMs } : {}),
    ...(readTimeoutMs !== undefined ? { readTimeoutMs } : {}),
    ...(batchingIntervalMs !== undefined ? { batchingIntervalMs } : {}),
    ...(maxBufferSize !== undefined ? { maxBufferSize } : {}),
    ...(retryIntervalMs !== undefined ? { retryIntervalMs } : {}),
    ...(maxRetryIntervalMs !== undefined ? { maxRetryIntervalMs } : {}),
    ...(jitterFactor !== undefined ? { jitterFactor } : {}),
    ...(maxReconnectAttempts !== undefined ? { maxReconnectAttempts } : {}),
    ...(maxAuthRetries !== undefined ? { maxAuthRetries } : {}),
  };
}

/**
 * Public facade and typed event emitter for NitroSse, delegating streaming execution to an SseDriver strategy.
 */
export class NitroSseClient implements SseClient {
  private _native: NitroSse;
  private _driver: SseDriver;
  private _listeners: Map<string, Set<SseListener>> = new Map();
  private _legacyCallback?: (events: SseEvent[]) => void;
  private _config?: SseConfig;
  private _isDisposed = false;
  private _pendingHeaders: Record<string, string> = {};

  constructor(native: NitroSse) {
    this._native = native;
    this._driver = new NativeDriver(native, (events) =>
      this._dispatchEvents(events)
    );
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  private _checkDisposed(): void {
    if (this._isDisposed) {
      throw new NitroSseDisposedError();
    }
  }

  setup(config: SseConfig, onEvent?: (events: SseEvent[]) => void): void {
    this._checkDisposed();

    if (onEvent !== undefined && typeof onEvent !== 'function') {
      throw new NitroSseValidationError(
        "[NitroSse] setup: 'onEvent' must be a function.",
        'INVALID_ARGUMENT',
        { received: typeof onEvent }
      );
    }

    const validatedConfig = validateConfig(config);

    if (this.isConnected()) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(
          '[NitroSse] setup() called while connection is active; stopping previous stream before reconfiguring.'
        );
      }
      this._driver?.stop();
    }

    const hasHeaders =
      Object.keys(this._pendingHeaders).length > 0 ||
      validatedConfig.headers !== undefined;
    const cleanHeaders = hasHeaders
      ? sanitizeHeaders({
          ...this._pendingHeaders,
          ...validatedConfig.headers,
        })
      : undefined;

    this._config = {
      ...validatedConfig,
      ...(cleanHeaders !== undefined ? { headers: cleanHeaders } : {}),
    };
    this._pendingHeaders = {};
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

    // Wrap the native setup to dispatch events to typed listeners when native streaming is active
    if (mockConfig?.mode !== 'replace') {
      this._native.setup(this._config, (events) => {
        this._dispatchEvents(events);
      });
    }
  }

  addEventListener(type: string, listener: SseListener): void {
    this._checkDisposed();
    if (typeof type !== 'string' || !type.trim()) {
      throw new NitroSseValidationError(
        "[NitroSse] addEventListener: 'type' must be a non-empty string.",
        'INVALID_ARGUMENT',
        { received: type }
      );
    }
    if (typeof listener !== 'function') {
      throw new NitroSseValidationError(
        "[NitroSse] addEventListener: 'listener' must be a function.",
        'INVALID_ARGUMENT',
        { received: typeof listener }
      );
    }
    const cleanType = type.trim();
    if (!this._listeners.has(cleanType)) {
      this._listeners.set(cleanType, new Set());
    }
    this._listeners.get(cleanType)!.add(listener);
  }

  removeEventListener(type: string, listener: SseListener): void {
    this._checkDisposed();
    if (typeof type !== 'string' || typeof listener !== 'function') {
      return;
    }
    this._listeners.get(type.trim())?.delete(listener);
  }

  removeAllEventListeners(type?: string): void {
    this._checkDisposed();
    if (type !== undefined) {
      if (typeof type === 'string' && type.trim()) {
        this._listeners.delete(type.trim());
      }
    } else {
      this._listeners.clear();
    }
  }

  private _emit(type: string, event: SseEvent): void {
    const listeners = this._listeners.get(type);
    if (listeners) {
      Array.from(listeners).forEach((listener) => {
        try {
          listener(event);
        } catch (e) {
          console.error(`[NitroSse] Error in event listener for "${type}":`, e);
        }
      });
    }
  }

  private _dispatchEvents(events: SseEvent[]): void {
    if (this._isDisposed || !Array.isArray(events)) return;
    try {
      this._legacyCallback?.(events);
    } catch (e) {
      console.error('[NitroSse] Error in legacy onEvent callback:', e);
    }
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      if (event.type) {
        this._emit(event.type, event);
      }
      if (event.event && event.event !== event.type) {
        this._emit(event.event, event);
      }
    }
  }

  start(): void {
    this._checkDisposed();
    if (!this._config) {
      throw new NitroSseStateError(
        '[NitroSse] Cannot start SSE stream: client is not configured. Call setup(config) first.'
      );
    }
    this._driver.start();
  }

  stop(): void {
    this._checkDisposed();
    this._driver.stop();
  }

  restart(): void {
    this._checkDisposed();
    if (!this._config) {
      throw new NitroSseStateError(
        '[NitroSse] Cannot restart SSE stream: client is not configured. Call setup(config) first.'
      );
    }
    this._driver.restart();
  }

  flush(): void {
    this._checkDisposed();
    this._driver.flush();
  }

  isConnected(): boolean {
    if (this._isDisposed) return false;
    return this._driver.isConnected();
  }

  getStats(): SseStats {
    if (this._isDisposed) {
      return {
        totalBytesReceived: 0,
        reconnectCount: 0,
      };
    }
    return this._driver.getStats();
  }

  getState(): SseState {
    if (this._isDisposed) return 'closed';
    return this._driver.getState();
  }

  updateHeaders(headers: Record<string, string>): void {
    this._checkDisposed();
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
      throw new NitroSseValidationError(
        "[NitroSse] updateHeaders: 'headers' must be an object of key-value pairs.",
        'INVALID_ARGUMENT',
        { received: headers }
      );
    }
    const clean = sanitizeHeaders(headers);
    if (!this._config) {
      this._pendingHeaders = { ...this._pendingHeaders, ...clean };
      this._driver.updateHeaders(clean);
    } else {
      this._config.headers = { ...this._config.headers, ...clean };
      this._driver.updateHeaders(this._config.headers);
    }
  }

  setLastProcessedId(id: string): void {
    this._checkDisposed();
    if (typeof id !== 'string') {
      throw new NitroSseValidationError(
        "[NitroSse] setLastProcessedId: 'id' must be a string.",
        'INVALID_ARGUMENT',
        { received: id }
      );
    }
    this._driver.setLastProcessedId(id);
  }

  injectMockEvent(event: Partial<SseEvent>): void {
    this._checkDisposed();
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new NitroSseValidationError(
        "[NitroSse] injectMockEvent: 'event' must be an object.",
        'INVALID_ARGUMENT',
        { received: event }
      );
    }
    this._driver.injectMockEvent(event);
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._listeners.clear();
    this._legacyCallback = undefined;
    this._pendingHeaders = {};
    this._driver?.dispose();
  }
}
