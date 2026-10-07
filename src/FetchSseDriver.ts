import type { SseDriver } from './SseDriver';
import type {
  SseConfig,
  SseDisconnectReason,
  SseEvent,
  SseState,
  SseStats,
} from './SseInterface';
import { SseEventParser, type SseEventParserDelegate } from './SseEventParser';
import { MockSseEngine } from './MockSseEngine';
import type { AnyMap } from 'react-native-nitro-modules';

declare const window: any;

function getUtf8ByteCount(str: string): number {
  if (!str) return 0;
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Calculates exponential backoff with full symmetric jitter matching iOS/Android.
 */
class SseReconnectStrategy {
  private _backoffCounter = 0;
  private _currentReconnectAttempts = 0;
  private _retryInterval = 1.0; // in seconds
  private _maxRetryInterval = 30.0;
  private _jitterFactor = 0.5;
  private _maxReconnectAttempts = -1;

  configure(
    retryIntervalMs?: number,
    maxRetryIntervalMs?: number,
    jitterFactor?: number,
    maxReconnectAttempts?: number
  ): void {
    if (
      retryIntervalMs !== undefined &&
      !Number.isNaN(retryIntervalMs) &&
      retryIntervalMs >= 0
    ) {
      this._retryInterval = retryIntervalMs / 1000.0;
    } else {
      this._retryInterval = 1.0;
    }

    if (
      maxRetryIntervalMs !== undefined &&
      !Number.isNaN(maxRetryIntervalMs) &&
      maxRetryIntervalMs >= 0
    ) {
      this._maxRetryInterval = maxRetryIntervalMs / 1000.0;
    } else {
      this._maxRetryInterval = 30.0;
    }

    if (jitterFactor !== undefined && !Number.isNaN(jitterFactor)) {
      this._jitterFactor = Math.min(Math.max(0.0, jitterFactor), 1.0);
    } else {
      this._jitterFactor = 0.5;
    }

    if (
      maxReconnectAttempts !== undefined &&
      !Number.isNaN(maxReconnectAttempts) &&
      maxReconnectAttempts >= 0
    ) {
      this._maxReconnectAttempts = maxReconnectAttempts;
    } else {
      this._maxReconnectAttempts = -1;
    }
  }

  hasReachedMaxAttempts(): boolean {
    if (this._maxReconnectAttempts === -1) return false;
    return this._currentReconnectAttempts >= this._maxReconnectAttempts;
  }

  recordAttempt(): void {
    this._currentReconnectAttempts++;
  }

  nextDelayMs(isError: boolean): number {
    this._currentReconnectAttempts++;
    let delay: number;

    if (isError) {
      const exponent = this._backoffCounter;
      const base = Math.min(
        this._retryInterval * Math.pow(2.0, exponent),
        this._maxRetryInterval
      );
      this._backoffCounter++;
      const randomFactor =
        1.0 - this._jitterFactor + Math.random() * (2 * this._jitterFactor);
      delay = base * randomFactor;
    } else {
      const randomFactor =
        1.0 - this._jitterFactor + Math.random() * (2 * this._jitterFactor);
      delay = this._retryInterval * randomFactor;
    }

    // Minimum floor of 1000ms enforced across all platforms
    return Math.max(delay * 1000.0, 1000.0);
  }

  reset(): void {
    this._backoffCounter = 0;
    this._currentReconnectAttempts = 0;
  }

  updateRetryInterval(retryMs: number): void {
    if (!Number.isNaN(retryMs) && retryMs >= 0) {
      this._retryInterval = retryMs / 1000.0;
    }
  }
}

/**
 * Web SSE Driver executing server-sent events using WHATWG fetch(), ReadableStream, and TextDecoder.
 */
export class FetchSseDriver implements SseDriver, SseEventParserDelegate {
  private _config?: SseConfig;
  private _onBeforeRequest?: () => Promise<Record<string, string>>;
  private _dispatchEvents: (events: SseEvent[]) => void;

  private _state: SseState = 'idle';
  private _isRunning = false;
  private _isReconnecting = false;
  private _lastProcessedId?: string;
  private _dynamicHeaders: Record<string, string> = {};
  private _consecutiveAuthErrors = 0;
  private _connectionAttemptVersion = 0;

  private _abortController?: AbortController;
  private _activeReader?: ReadableStreamDefaultReader<Uint8Array>;
  private _connectionTimer?: ReturnType<typeof setTimeout>;
  private _readTimeoutTimer?: ReturnType<typeof setTimeout>;
  private _reconnectTimer?: ReturnType<typeof setTimeout>;
  private _batchTimer?: ReturnType<typeof setTimeout>;
  private _batchBuffer: SseEvent[] = [];

  private _wasRunningBeforeNetworkLoss = false;
  private _reconnectStrategy = new SseReconnectStrategy();
  private _parser?: SseEventParser;

  // === Stats tracking ===
  private _rawBytesReceived = 0;
  private _totalBytesReceived = 0;
  private _chunksReceived = 0;
  private _lastStatusCode?: number;
  private _totalEventsReceived = 0;
  private _commentsReceived = 0;
  private _linesParsed = 0;
  private _parseErrors = 0;
  private _serverRetryDelayMs?: number;
  private _connectedAt?: number;
  private _timeToFirstByteMs?: number;
  private _connectionAttemptStartTime?: number;
  private _lastEventTime?: number;
  private _lastHeartbeatTime?: number;
  private _lastActivityTime = 0;
  private _maxEventGapMs = 0;
  private _peakBufferedEvents = 0;
  private _bufferFlushCount = 0;
  private _bufferOverflowCount = 0;
  private _connectionAttempts = 0;
  private _reconnectCount = 0;
  private _lastReconnectDelayMs?: number;
  private _disconnectReason?: SseDisconnectReason;
  private _lastErrorTime?: number;
  private _lastErrorCode?: string;

  private _onlineListener?: () => void;
  private _offlineListener?: () => void;

  constructor(dispatchEvents: (events: SseEvent[]) => void = () => {}) {
    this._dispatchEvents = dispatchEvents;
  }

  setDispatchEvents(dispatchEvents: (events: SseEvent[]) => void): void {
    this._dispatchEvents = dispatchEvents;
  }

  setup(
    config: SseConfig,
    onBeforeRequest?: () => Promise<Record<string, string>>
  ): void {
    this._config = config;
    this._onBeforeRequest = onBeforeRequest;
    this._dynamicHeaders = {};
    this._wasRunningBeforeNetworkLoss = false;

    if (this._lastProcessedId === undefined && config.headers) {
      const headerEntry = Object.entries(config.headers).find(
        ([k]) => k.toLowerCase() === 'last-event-id'
      );
      if (headerEntry) {
        this._lastProcessedId = headerEntry[1];
      }
    }

    this._reconnectStrategy.configure(
      config.retryIntervalMs,
      config.maxRetryIntervalMs,
      config.jitterFactor,
      config.maxReconnectAttempts
    );

    if (config.monitorNetwork !== false) {
      this._setupNetworkListeners();
    } else {
      this._teardownNetworkListeners();
    }
  }

  start(): void {
    if (!this._config) {
      throw new Error(
        '[FetchSseDriver] Cannot start: driver is not configured. Call setup() first.'
      );
    }
    if (this._isRunning) {
      // Immediate "Retry Now" if currently in reconnection backoff loop
      if (this._state === 'reconnecting') {
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = undefined;
        }
        this._reconnectStrategy.reset();
        this._consecutiveAuthErrors = 0;
        this._connectionAttemptVersion++;
        this._updateState('connecting');
        this._establishConnection(this._connectionAttemptVersion);
      }
      return;
    }

    this._isRunning = true;
    this._isReconnecting = false;
    this._wasRunningBeforeNetworkLoss = false;
    this._consecutiveAuthErrors = 0;
    this._reconnectStrategy.reset();
    this._connectionAttemptVersion++;

    this._establishConnection(this._connectionAttemptVersion);
  }

  stop(): void {
    if (this._isRunning) {
      this._disconnectReason = 'user_stop';
    }
    this._stopInternal(true);
  }

  restart(): void {
    if (!this._config) {
      return;
    }
    this._connectedAt = undefined;
    this._cleanupTimers();
    this._cleanupTransport();
    this._flushBatch();

    this._isRunning = true;
    this._connectionAttemptVersion++;
    this._updateState('reconnecting');
    this._establishConnection(this._connectionAttemptVersion);
  }

  flush(): void {
    this._flushBatch();
  }

  isConnected(): boolean {
    return this._isRunning;
  }

  getStats(): SseStats {
    return {
      rawBytesReceived: this._rawBytesReceived,
      decompressedBytesReceived: undefined,
      totalBytesReceived: this._totalBytesReceived,
      chunksReceived: this._chunksReceived,
      lastStatusCode: this._lastStatusCode,
      totalEventsReceived: this._totalEventsReceived,
      commentsReceived: this._commentsReceived,
      linesParsed: this._linesParsed,
      parseErrors: this._parseErrors,
      serverRetryDelayMs: this._serverRetryDelayMs,
      connectedAt: this._connectedAt,
      timeToFirstByteMs: this._timeToFirstByteMs,
      lastEventTime: this._lastEventTime,
      lastHeartbeatTime: this._lastHeartbeatTime,
      maxEventGapMs: this._maxEventGapMs,
      eventsBuffered: this._batchBuffer.length,
      peakBufferedEvents: this._peakBufferedEvents,
      bufferFlushCount: this._bufferFlushCount,
      bufferOverflowCount: this._bufferOverflowCount,
      connectionAttempts: this._connectionAttempts,
      reconnectCount: this._reconnectCount,
      lastReconnectDelayMs: this._lastReconnectDelayMs,
      disconnectReason: this._disconnectReason,
      lastErrorTime: this._lastErrorTime,
      lastErrorCode: this._lastErrorCode,
    };
  }

  getState(): SseState {
    return this._state;
  }

  updateHeaders(headers: Record<string, string>): void {
    this._dynamicHeaders = { ...this._dynamicHeaders, ...headers };
  }

  setLastProcessedId(id: string): void {
    this._lastProcessedId = id;
  }

  injectMockEvent(event: Partial<SseEvent>): void {
    const sseEvent = MockSseEngine.createSseEvent(event);
    this._pushEvent(sseEvent);
  }

  dispose(): void {
    this.stop();
    this._teardownNetworkListeners();
    this._batchBuffer = [];
  }

  // =========================================================================
  // Internal Connection Engine
  // =========================================================================

  private async _establishConnection(attemptVersion: number): Promise<void> {
    if (
      !this._isRunning ||
      attemptVersion !== this._connectionAttemptVersion ||
      !this._config
    ) {
      return;
    }

    this._updateState('connecting');
    this._connectionAttempts++;
    this._connectionAttemptStartTime = Date.now();
    this._timeToFirstByteMs = undefined;

    // 1. Prepare dynamic headers via interceptor if configured
    let dynamicInterceptorHeaders: Record<string, string> = {};
    if (this._onBeforeRequest) {
      try {
        const timeoutMs = this._config.connectionTimeoutMs ?? 15000;
        let interceptorTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          dynamicInterceptorHeaders = await Promise.race([
            this._onBeforeRequest(),
            new Promise<Record<string, string>>((_, reject) => {
              interceptorTimer = setTimeout(
                () => reject(new Error('onBeforeRequest interceptor timeout')),
                timeoutMs
              );
            }),
          ]);
        } finally {
          if (interceptorTimer !== undefined) {
            clearTimeout(interceptorTimer);
          }
        }
      } catch (err) {
        if (
          !this._isRunning ||
          attemptVersion !== this._connectionAttemptVersion
        )
          return;
        this._recordError('Interceptor Error', undefined);
        this._failAndStop(
          `Interceptor Error: ${
            err instanceof Error ? err.message : String(err)
          }`,
          -1
        );
        return;
      }
    }

    if (!this._isRunning || attemptVersion !== this._connectionAttemptVersion)
      return;

    // URL syntax and protocol validation matching Native (http/https only)
    try {
      const parsedUrl = new URL(
        this._config.url,
        typeof window !== 'undefined' && window.location
          ? window.location.href
          : 'http://localhost'
      );
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        this._failAndStop(`Invalid URL: ${this._config.url}`, -1);
        return;
      }
    } catch {
      this._failAndStop(`Invalid URL: ${this._config.url}`, -1);
      return;
    }

    // 2. Build headers
    const filteredHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries({
      ...(this._config.headers ?? {}),
      ...this._dynamicHeaders,
      ...dynamicInterceptorHeaders,
    })) {
      const lower = k.toLowerCase();
      if (lower !== 'last-event-id' && lower !== 'accept-encoding') {
        filteredHeaders[k] = v;
      }
    }

    const mergedHeaders: Record<string, string> = {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...filteredHeaders,
    };

    if (this._lastProcessedId && this._lastProcessedId.length > 0) {
      mergedHeaders['Last-Event-ID'] = this._lastProcessedId;
    }

    const abortController = new AbortController();
    this._abortController = abortController;

    const connectionTimeoutMs = this._config.connectionTimeoutMs ?? 15000;
    this._connectionTimer = setTimeout(() => {
      if (attemptVersion === this._connectionAttemptVersion) {
        this._disconnectReason = 'timeout';
        abortController.abort();
      }
    }, connectionTimeoutMs);

    const method = (this._config.method ?? 'get').toUpperCase();
    const fetchOptions: RequestInit = {
      method,
      headers: mergedHeaders,
      signal: abortController.signal,
      mode: 'cors',
      credentials: 'same-origin',
    };

    if (method === 'POST') {
      const hasContentType = Object.keys(mergedHeaders).some(
        (k) => k.toLowerCase() === 'content-type'
      );
      if (!hasContentType && this._config.body) {
        mergedHeaders['Content-Type'] = 'application/json';
      }
      if (this._config.body) {
        fetchOptions.body = this._config.body;
      }
    }

    let response: Response;
    try {
      response = await fetch(this._config.url, fetchOptions);
    } catch (err) {
      clearTimeout(this._connectionTimer);
      if (!this._isRunning || attemptVersion !== this._connectionAttemptVersion)
        return;

      const isAborted = abortController.signal.aborted;
      const errorMsg = isAborted
        ? 'Connection timeout'
        : err instanceof Error
        ? err.message
        : 'Failed to fetch';
      this._disconnectReason = isAborted ? 'timeout' : 'network_error';
      if (isAborted) {
        this._updateState('stale');
      }
      this._recordError(errorMsg, undefined);
      this._pushEvent({ type: 'error', message: errorMsg });
      this._scheduleReconnect(true, undefined, attemptVersion);
      return;
    }

    clearTimeout(this._connectionTimer);
    if (!this._isRunning || attemptVersion !== this._connectionAttemptVersion)
      return;

    const statusCode = response.status;
    this._lastStatusCode = statusCode;

    let errorBody: string | undefined;
    if (statusCode >= 400 || statusCode === 204) {
      try {
        errorBody = await response.text();
      } catch {
        // Ignore body reading error
      }
    }

    // 3. HTTP Validation Rules matching Native (WHATWG SSE Section 9.1)
    // 3a. HTTP 200 OK: Content-Type MIME type MUST be text/event-stream
    if (statusCode === 200) {
      const contentType = response.headers.get('Content-Type') ?? '';
      const mimeType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
      if (mimeType !== 'text/event-stream') {
        this._disconnectReason = 'server_error';
        this._failAndStop(
          `Invalid Content-Type: expected text/event-stream but received '${contentType}'. Stopping.`,
          statusCode
        );
        return;
      }
    } else if (statusCode === 204) {
      // 3b. HTTP 204 No Content is fatal per WHATWG SSE spec
      this._disconnectReason = 'server_error';
      this._failAndStop(
        'Server sent HTTP 204 No Content. Stopping.',
        statusCode
      );
      return;
    } else if (statusCode === 401 || statusCode === 403) {
      // 3c. HTTP 401/403 Auth errors
      const maxAuthRetries = this._config.maxAuthRetries ?? 3;
      if (!this._onBeforeRequest) {
        this._disconnectReason = 'server_error';
        this._failAndStop(
          `Auth Error (${statusCode}) - No interceptor provided. Stopping.`,
          statusCode
        );
        return;
      }

      this._consecutiveAuthErrors++;
      if (this._consecutiveAuthErrors > maxAuthRetries) {
        this._disconnectReason = 'server_error';
        this._failAndStop(
          `Auth Error (${statusCode}) - Retry limit reached (${maxAuthRetries}). Stopping.`,
          statusCode
        );
        return;
      }

      this._recordError(`Auth Error (${statusCode})`, String(statusCode));
      this._pushEvent({
        type: 'error',
        statusCode,
        message: `Auth Error (${statusCode}) - Retry ${this._consecutiveAuthErrors}/${maxAuthRetries}. Refreshing token...`,
      });
      this._scheduleReconnect(true, undefined, attemptVersion);
      return;
    } else if (statusCode === 408) {
      // 3d. Request Timeout: Recoverable per WHATWG SSE and Native specs
      this._disconnectReason = 'timeout';
      this._updateState('stale');
      this._recordError('HTTP 408', '408');
      this._pushEvent({
        type: 'error',
        statusCode: 408,
        message: 'HTTP 408',
      });
      this._scheduleReconnect(true, undefined, attemptVersion);
      return;
    } else if (statusCode === 429 || statusCode === 503) {
      // 3e. Rate limit / Service unavailable: Honor Retry-After
      const retryAfterHeader = response.headers.get('Retry-After');
      const rawRetryAfterMs = this._parseRetryAfterHeader(retryAfterHeader);
      this._disconnectReason = 'server_error';
      this._recordError(`HTTP ${statusCode}`, String(statusCode));

      if (rawRetryAfterMs !== undefined) {
        const maxIntervalMs = this._config.maxRetryIntervalMs ?? 30000;
        const boundedRetryMs = Math.max(
          0,
          Math.min(rawRetryAfterMs, maxIntervalMs)
        );

        this._pushEvent({
          type: 'error',
          statusCode,
          retry: boundedRetryMs,
          message: `Retry-After received: ${Math.round(
            boundedRetryMs / 1000
          )}s`,
        });
        this._scheduleReconnect(true, boundedRetryMs, attemptVersion);
        return;
      }

      if (statusCode === 429) {
        this._pushEvent({
          type: 'error',
          statusCode: 429,
          message: 'Rate Limited (429). Retrying with backoff...',
        });
        this._scheduleReconnect(true, undefined, attemptVersion);
        return;
      }

      this._pushEvent({
        type: 'error',
        statusCode,
        message: `HTTP ${statusCode}`,
      });
      this._scheduleReconnect(true, undefined, attemptVersion);
      return;
    } else if (statusCode >= 400 && statusCode <= 499) {
      // 3f. Fatal client error (e.g. 400 Bad Request, 404 Not Found, 405 Method Not Allowed)
      this._disconnectReason = 'server_error';
      const bodyText = errorBody?.trim();
      const fatalMessage = bodyText
        ? `Fatal Error (${statusCode}): ${bodyText}`
        : `Fatal Error (${statusCode}). Stopping.`;
      this._failAndStop(fatalMessage, statusCode);
      return;
    } else if (statusCode >= 500) {
      // 3g. Server error: Recoverable
      this._disconnectReason = 'server_error';
      this._recordError(`Server Error (${statusCode})`, String(statusCode));
      const bodyText = errorBody?.trim();
      const errorMsg = bodyText
        ? `Server Error (${statusCode}): ${bodyText}`
        : `Server Error (${statusCode})`;
      this._pushEvent({
        type: 'error',
        statusCode,
        message: errorMsg,
      });
      this._scheduleReconnect(true, undefined, attemptVersion);
      return;
    } else {
      // Any other non-200 status code (e.g. 201 Created, 202, 3xx) is fatal per WHATWG SSE Section 9.1
      this._disconnectReason = 'server_error';
      this._failAndStop(
        `HTTP ${statusCode} is not a valid SSE response. Stopping.`,
        statusCode
      );
      return;
    }

    if (!response.body) {
      this._failAndStop(
        'Response body is null. ReadableStream is not supported.',
        statusCode
      );
      return;
    }

    // 4. Connection established successfully
    this._reconnectStrategy.reset();
    this._consecutiveAuthErrors = 0;
    if (this._isReconnecting || this._state === 'reconnecting') {
      this._reconnectCount++;
      this._isReconnecting = false;
    }
    this._connectedAt = Date.now();
    this._updateState('open');
    this._pushEvent({ type: 'open', statusCode });

    // 5. Initialize streaming reader and parser
    this._parser = new SseEventParser(this, this._lastProcessedId);
    const reader = response.body.getReader();
    this._activeReader = reader;
    const decoder = new TextDecoder('utf-8');

    // 6. Setup idle read timeout
    this._resetReadTimeout(attemptVersion);

    try {
      while (
        this._isRunning &&
        attemptVersion === this._connectionAttemptVersion
      ) {
        const { value, done } = await reader.read();

        if (done) {
          decoder.decode(); // flush trailing bytes
          this._parser?.endOfStream();
          break;
        }

        if (value) {
          if (
            this._timeToFirstByteMs === undefined &&
            this._connectionAttemptStartTime
          ) {
            this._timeToFirstByteMs =
              Date.now() - this._connectionAttemptStartTime;
          }
          this._rawBytesReceived += value.byteLength;
          this._chunksReceived++;
          this._resetReadTimeout(attemptVersion);

          const text = decoder.decode(value, { stream: true });
          this._parser?.feed(text);
        }
      }
    } catch (readErr) {
      if (!this._isRunning || attemptVersion !== this._connectionAttemptVersion)
        return;
      const isAborted = abortController.signal.aborted;
      if (!isAborted) {
        this._recordError(
          readErr instanceof Error ? readErr.message : 'Read error',
          undefined
        );
        this._scheduleReconnect(true, undefined, attemptVersion);
        return;
      }
    } finally {
      this._clearReadTimeout();
    }

    if (!this._isRunning || attemptVersion !== this._connectionAttemptVersion)
      return;

    // Clean disconnect from server
    this._scheduleReconnect(false, undefined, attemptVersion);
  }

  // =========================================================================
  // Reconnect & Teardown Helpers
  // =========================================================================

  private _scheduleReconnect(
    isError: boolean,
    fixedDelayMs: number | undefined,
    attemptVersion: number
  ): void {
    if (!this._isRunning || attemptVersion !== this._connectionAttemptVersion)
      return;

    if (this._reconnectStrategy.hasReachedMaxAttempts()) {
      const maxAttempts = this._config?.maxReconnectAttempts ?? -1;
      this._failAndStop(`Max reconnection attempts reached (${maxAttempts}).`);
      return;
    }

    let delay: number;
    if (fixedDelayMs !== undefined) {
      this._reconnectStrategy.recordAttempt();
      delay = fixedDelayMs;
    } else {
      delay = this._reconnectStrategy.nextDelayMs(isError);
    }

    this._lastReconnectDelayMs = delay;
    this._connectionAttemptVersion++;
    const newVersion = this._connectionAttemptVersion;

    this._isReconnecting = true;
    this._updateState('reconnecting');
    this._cleanupTransport();

    this._reconnectTimer = setTimeout(() => {
      if (this._isRunning && newVersion === this._connectionAttemptVersion) {
        this._establishConnection(newVersion);
      }
    }, delay);
  }

  private _stopInternal(emitClosed: boolean): void {
    this._connectedAt = undefined;
    this._isRunning = false;
    this._isReconnecting = false;
    this._connectionAttemptVersion++;

    this._cleanupTimers();
    this._cleanupTransport();
    this._flushBatch();

    if (emitClosed && this._state !== 'failed') {
      this._updateState('closed');
      this._flushBatch();
    }
  }

  private _failAndStop(message: string, statusCode?: number): void {
    this._connectionAttemptVersion++;
    this._recordError(
      message,
      statusCode !== undefined ? String(statusCode) : undefined
    );
    this._pushEvent({ type: 'error', message, statusCode });
    this._updateState('failed');
    this._stopInternal(false);
  }

  private _cleanupTransport(): void {
    if (this._activeReader) {
      try {
        this._activeReader.cancel().catch(() => {});
      } catch {
        // Ignore reader cancellation errors
      }
      this._activeReader = undefined;
    }
    if (this._abortController) {
      try {
        this._abortController.abort();
      } catch {
        // Ignore abort errors
      }
      this._abortController = undefined;
    }
  }

  private _cleanupTimers(): void {
    if (this._connectionTimer) {
      clearTimeout(this._connectionTimer);
      this._connectionTimer = undefined;
    }
    if (this._readTimeoutTimer) {
      clearTimeout(this._readTimeoutTimer);
      this._readTimeoutTimer = undefined;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = undefined;
    }
  }

  private _resetReadTimeout(attemptVersion: number): void {
    this._clearReadTimeout();
    const readTimeoutMs = this._config?.readTimeoutMs ?? 300000;
    if (readTimeoutMs <= 0) return;

    this._readTimeoutTimer = setTimeout(() => {
      if (
        this._isRunning &&
        attemptVersion === this._connectionAttemptVersion
      ) {
        this._disconnectReason = 'timeout';
        this._updateState('stale');
        this._cleanupTransport();
        this._scheduleReconnect(true, undefined, attemptVersion);
      }
    }, readTimeoutMs);
  }

  private _clearReadTimeout(): void {
    if (this._readTimeoutTimer) {
      clearTimeout(this._readTimeoutTimer);
      this._readTimeoutTimer = undefined;
    }
  }

  private _updateState(newState: SseState): void {
    if (this._state === newState) return;
    this._state = newState;
    this._pushEvent({ type: 'state', state: newState });
    this._flushBatch();
  }

  private _recordError(message: string, code?: string): void {
    this._lastErrorTime = Date.now();
    this._lastErrorCode = code ?? message;
  }

  private _parseRetryAfterHeader(value: string | null): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      const seconds = parseInt(trimmed, 10);
      return seconds * 1000;
    }
    const timestamp = Date.parse(trimmed);
    if (!Number.isNaN(timestamp)) {
      const diff = timestamp - Date.now();
      return Math.max(diff, 1000);
    }
    return undefined;
  }

  // =========================================================================
  // Batching & Dispatching
  // =========================================================================

  private _pushEvent(event: SseEvent): void {
    const batchingIntervalMs = this._config?.batchingIntervalMs ?? 0;
    const maxBufferSize = this._config?.maxBufferSize ?? 1000;

    this._batchBuffer.push(event);
    if (this._batchBuffer.length > this._peakBufferedEvents) {
      this._peakBufferedEvents = this._batchBuffer.length;
    }

    if (this._batchBuffer.length >= maxBufferSize && batchingIntervalMs > 0) {
      this._bufferOverflowCount++;
      this._cancelBatchTimer();
      this._flushBatch();
    } else if (
      this._batchBuffer.length >= maxBufferSize ||
      batchingIntervalMs <= 0
    ) {
      this._cancelBatchTimer();
      this._flushBatch();
    } else if (!this._batchTimer) {
      this._batchTimer = setTimeout(() => {
        this._batchTimer = undefined;
        this._flushBatch();
      }, batchingIntervalMs);
    }
  }

  private _flushBatch(): void {
    this._cancelBatchTimer();
    if (this._batchBuffer.length === 0) return;

    this._bufferFlushCount++;
    const batch = this._batchBuffer;
    this._batchBuffer = [];

    this._dispatchEvents(batch);
  }

  private _cancelBatchTimer(): void {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = undefined;
    }
  }

  // =========================================================================
  // SseEventParserDelegate Implementation
  // =========================================================================

  onEvent(
    id: string | undefined,
    type: string | undefined,
    data: string
  ): void {
    const now = Date.now();
    this._lastEventTime = now;
    if (this._lastActivityTime > 0) {
      const gap = now - this._lastActivityTime;
      if (gap > this._maxEventGapMs) {
        this._maxEventGapMs = gap;
      }
    }
    this._lastActivityTime = now;

    const eventType = type ?? 'message';
    const encodedDataSize = getUtf8ByteCount(data);
    const eventTypeSize =
      eventType === 'message' ? 0 : getUtf8ByteCount(eventType);
    this._totalBytesReceived += encodedDataSize + eventTypeSize;

    if (id !== undefined && id !== this._lastProcessedId) {
      this._totalBytesReceived += getUtf8ByteCount(id);
      this._lastProcessedId = id;
    }

    this._totalEventsReceived++;

    let parsedData: AnyMap | undefined;
    if (this._config?.autoParseJSON && data.trimStart().startsWith('{')) {
      try {
        const obj = JSON.parse(data);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          parsedData = obj as AnyMap;
        }
      } catch {
        // Ignore JSON parsing failures
      }
    }

    this._pushEvent({
      type: 'message',
      data,
      parsedData,
      id: id ?? this._lastProcessedId,
      event: type,
      statusCode: 200,
    });
  }

  onComment(comment: string): void {
    const now = Date.now();
    this._lastHeartbeatTime = now;
    if (this._lastActivityTime > 0) {
      const gap = now - this._lastActivityTime;
      if (gap > this._maxEventGapMs) {
        this._maxEventGapMs = gap;
      }
    }
    this._lastActivityTime = now;
    this._totalBytesReceived += getUtf8ByteCount(comment);
    this._commentsReceived++;

    this._pushEvent({
      type: 'heartbeat',
      message: comment,
    });
  }

  onRetry(retryMs: number): void {
    this._serverRetryDelayMs = retryMs;
    this._reconnectStrategy.updateRetryInterval(retryMs);
  }

  onIdUpdate(id: string | undefined): void {
    if (id !== undefined && id !== this._lastProcessedId) {
      this._totalBytesReceived += getUtf8ByteCount(id);
    }
    this._lastProcessedId = id;
  }

  onParseError(error: Error): void {
    this._parseErrors++;
    this._disconnectReason = 'parser_error';
    this._failAndStop(`SSE parser error: ${error.message}`);
  }

  onLinesParsed(count: number): void {
    this._linesParsed += count;
  }

  // =========================================================================
  // Network Monitoring
  // =========================================================================

  private _setupNetworkListeners(): void {
    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function' ||
      this._offlineListener !== undefined
    )
      return;

    this._offlineListener = () => {
      if (this._isRunning) {
        this._wasRunningBeforeNetworkLoss = true;
        this._disconnectReason = 'network_error';
        this._connectionAttemptVersion++;
        this._cleanupTimers();
        this._cleanupTransport();
        this._updateState('paused');
        this._isRunning = false;
      }
    };

    this._onlineListener = () => {
      if (this._wasRunningBeforeNetworkLoss) {
        this._wasRunningBeforeNetworkLoss = false;
        this.start();
      }
    };

    window.addEventListener('offline', this._offlineListener);
    window.addEventListener('online', this._onlineListener);
  }

  private _teardownNetworkListeners(): void {
    if (
      typeof window === 'undefined' ||
      typeof window.removeEventListener !== 'function'
    )
      return;
    if (this._offlineListener) {
      window.removeEventListener('offline', this._offlineListener);
      this._offlineListener = undefined;
    }
    if (this._onlineListener) {
      window.removeEventListener('online', this._onlineListener);
      this._onlineListener = undefined;
    }
  }
}
