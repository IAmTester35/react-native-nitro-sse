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
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < str.length &&
      str.charCodeAt(i + 1) >= 0xdc00 &&
      str.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isValidNonNegative(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

const DEFAULT_MAX_BUFFER_SIZE = 1000;
/** Hard upper bound on buffered events, matching SseEventBuffer on Android (Kotlin) and iOS (Swift). */
const HARD_MAX_BUFFER_SIZE = 10_000;
/** Maximum UTF-8 bytes to read from HTTP error responses, matching native 8KB cap. */
const MAX_ERROR_BODY_BYTES = 8192;
/** Maximum characters of error body preview included in `event.message` (`event.data` retains the full 8KB body). */
const MAX_ERROR_MESSAGE_BODY_CHARS = 256;

function formatErrorBodyPreview(errorBody?: string): string | undefined {
  const trimmed = errorBody?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_ERROR_MESSAGE_BODY_CHARS
    ? `${trimmed.slice(0, MAX_ERROR_MESSAGE_BODY_CHARS)}…`
    : trimmed;
}

function resolveMaxBufferSize(val: unknown): number {
  return typeof val === 'number' && Number.isFinite(val) && val > 0
    ? Math.min(Math.floor(val), HARD_MAX_BUFFER_SIZE)
    : DEFAULT_MAX_BUFFER_SIZE;
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
    if (isValidNonNegative(retryIntervalMs)) {
      this._retryInterval = retryIntervalMs / 1000.0;
    } else {
      this._retryInterval = 1.0;
    }

    if (isValidNonNegative(maxRetryIntervalMs)) {
      this._maxRetryInterval = maxRetryIntervalMs / 1000.0;
    } else {
      this._maxRetryInterval = 30.0;
    }

    if (typeof jitterFactor === 'number' && Number.isFinite(jitterFactor)) {
      this._jitterFactor = Math.min(Math.max(0.0, jitterFactor), 1.0);
    } else {
      this._jitterFactor = 0.5;
    }

    if (isValidNonNegative(maxReconnectAttempts)) {
      this._maxReconnectAttempts = maxReconnectAttempts;
    } else {
      this._maxReconnectAttempts = -1;
    }
  }

  get maxReconnectAttempts(): number {
    return this._maxReconnectAttempts;
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
    const base = isError
      ? Math.min(
          this._retryInterval * Math.pow(2.0, this._backoffCounter++),
          this._maxRetryInterval
        )
      : Math.min(this._retryInterval, this._maxRetryInterval);

    const randomFactor =
      1.0 - this._jitterFactor + Math.random() * (2 * this._jitterFactor);
    const delay = base * randomFactor;

    // Minimum floor of 1000ms enforced across all platforms, capped at max 32-bit signed int for timer safety
    const MAX_TIMER_MS = 2_147_483_647;
    const ms = Number.isFinite(delay) ? delay * 1000.0 : MAX_TIMER_MS;
    return Math.min(Math.max(ms, 1000.0), MAX_TIMER_MS);
  }

  reset(): void {
    this._backoffCounter = 0;
    this._currentReconnectAttempts = 0;
  }

  updateRetryInterval(retryMs: number): void {
    if (isValidNonNegative(retryMs)) {
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
  private _activeParser?: SseEventParser;
  private _connectionTimer?: ReturnType<typeof setTimeout>;
  private _errorBodyTimer?: ReturnType<typeof setTimeout>;
  private _readTimeoutTimer?: ReturnType<typeof setTimeout>;
  private _reconnectTimer?: ReturnType<typeof setTimeout>;
  private _batchTimer?: ReturnType<typeof setTimeout>;
  private _batchBuffer: SseEvent[] = [];

  private _wasRunningBeforeNetworkLoss = false;
  private _reconnectStrategy = new SseReconnectStrategy();

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

  private _removeNetworkListeners?: () => void;

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
        this._establishConnection(this._connectionAttemptVersion, this._config);
      }
      return;
    }

    this._isRunning = true;
    this._isReconnecting = false;
    this._wasRunningBeforeNetworkLoss = false;
    this._consecutiveAuthErrors = 0;
    this._reconnectStrategy.reset();
    this._connectionAttemptVersion++;

    this._establishConnection(this._connectionAttemptVersion, this._config);
  }

  stop(): void {
    if (this._isRunning || this._wasRunningBeforeNetworkLoss) {
      this._disconnectReason = 'user_stop';
    }
    this._wasRunningBeforeNetworkLoss = false;
    this._stopInternal(true);
  }

  restart(): void {
    if (!this._config) {
      return;
    }
    this._connectedAt = undefined;
    this._teardownConnection();

    this._isRunning = true;
    this._isReconnecting = true;
    this._consecutiveAuthErrors = 0;
    this._reconnectStrategy.reset();
    this._connectionAttemptVersion++;
    this._updateState('reconnecting');
    this._establishConnection(this._connectionAttemptVersion, this._config);
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
  }

  // =========================================================================
  // Internal Connection Engine
  // =========================================================================

  /**
   * A connection attempt is stale when the driver has been stopped, or when a
   * newer attempt (reconnect / restart / stop) has superseded it.
   */
  private _isStale(attemptVersion: number): boolean {
    return (
      !this._isRunning || attemptVersion !== this._connectionAttemptVersion
    );
  }

  private async _establishConnection(
    attemptVersion: number,
    config: SseConfig
  ): Promise<void> {
    if (this._isStale(attemptVersion)) {
      return;
    }

    this._updateState('connecting');
    this._connectionAttempts++;
    const attemptStartTime = Date.now();
    this._timeToFirstByteMs = undefined;

    // 1. Prepare dynamic headers via interceptor if configured
    let dynamicInterceptorHeaders: Record<string, string> = {};
    if (this._onBeforeRequest) {
      try {
        const timeoutMs = config.connectionTimeoutMs ?? 15000;
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
        if (this._isStale(attemptVersion)) return;
        this._recordError('Interceptor Error', undefined);

        const errorMsg = `Interceptor Error: ${
          err instanceof Error ? err.message : String(err)
        }`;
        this._pushEvent({
          type: 'error',
          statusCode: -1,
          message: errorMsg,
        });

        this._consecutiveAuthErrors++;
        const maxAuthRetries = config.maxAuthRetries ?? 3;
        if (this._consecutiveAuthErrors > maxAuthRetries) {
          this._disconnectReason = 'server_error';
          this._failAndStop(
            `Auth retry limit reached (${maxAuthRetries}). Stopping.`,
            -1
          );
          return;
        }

        this._scheduleReconnect(true, undefined, attemptVersion, config);
        return;
      }
    }

    if (this._isStale(attemptVersion)) return;

    // URL syntax and protocol validation matching Native (http/https only)
    try {
      const parsedUrl = new URL(
        config.url,
        typeof window !== 'undefined' && window.location
          ? window.location.href
          : 'http://localhost'
      );
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        this._failAndStop(`Invalid URL: ${config.url}`, -1);
        return;
      }
    } catch {
      this._failAndStop(`Invalid URL: ${config.url}`, -1);
      return;
    }

    // 2. Build headers
    const filteredHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries({
      ...(config.headers ?? {}),
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

    if (this._lastProcessedId) {
      mergedHeaders['Last-Event-ID'] = this._lastProcessedId;
    }

    const abortController = new AbortController();
    this._abortController = abortController;

    const connectionTimeoutMs = config.connectionTimeoutMs ?? 15000;
    const requestStartTime = Date.now();
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    if (connectionTimeoutMs > 0) {
      connectionTimer = setTimeout(() => {
        if (this._connectionTimer === connectionTimer) {
          this._connectionTimer = undefined;
        }
        if (attemptVersion === this._connectionAttemptVersion) {
          this._disconnectReason = 'timeout';
          abortController.abort();
        }
      }, connectionTimeoutMs);
      this._connectionTimer = connectionTimer;
    }

    const method = (config.method ?? 'get').toUpperCase();
    const fetchOptions: RequestInit = {
      method,
      headers: mergedHeaders,
      signal: abortController.signal,
      mode: 'cors',
      credentials: 'same-origin',
    };

    if (method === 'POST' && config.body) {
      fetchOptions.body = config.body;
      const hasContentType = Object.keys(mergedHeaders).some(
        (k) => k.toLowerCase() === 'content-type'
      );
      if (!hasContentType) {
        mergedHeaders['Content-Type'] = 'application/json';
      }
    }

    let response: Response;
    try {
      response = await fetch(config.url, fetchOptions);
    } catch (err) {
      if (connectionTimer !== undefined) {
        clearTimeout(connectionTimer);
        if (this._connectionTimer === connectionTimer) {
          this._connectionTimer = undefined;
        }
      }
      if (this._isStale(attemptVersion)) return;

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
      this._scheduleReconnect(true, undefined, attemptVersion, config);
      return;
    }

    if (connectionTimer !== undefined) {
      clearTimeout(connectionTimer);
      if (this._connectionTimer === connectionTimer) {
        this._connectionTimer = undefined;
      }
    }
    if (this._isStale(attemptVersion)) return;

    const statusCode = response.status;
    this._lastStatusCode = statusCode;

    let errorBody: string | undefined;
    if (statusCode >= 400) {
      errorBody = await this._readBoundedErrorBody(
        response,
        connectionTimeoutMs,
        requestStartTime,
        abortController,
        attemptVersion
      );
      if (this._isStale(attemptVersion)) return;
    }

    // 3. HTTP Validation Rules matching Native (WHATWG SSE Section 9.1)
    // 3a. HTTP 200 OK: Content-Type MIME type MUST be text/event-stream
    if (statusCode === 200) {
      const contentType = response.headers.get('Content-Type') ?? '';
      const semiIdx = contentType.indexOf(';');
      const mimeType = (
        semiIdx === -1 ? contentType : contentType.slice(0, semiIdx)
      )
        .trim()
        .toLowerCase();
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
      const maxAuthRetries = config.maxAuthRetries ?? 3;
      if (!this._onBeforeRequest) {
        this._disconnectReason = 'server_error';
        this._failAndStop(
          `Auth Error (${statusCode}) - No interceptor provided. Stopping.`,
          statusCode,
          errorBody
        );
        return;
      }

      this._consecutiveAuthErrors++;
      if (this._consecutiveAuthErrors > maxAuthRetries) {
        this._disconnectReason = 'server_error';
        this._failAndStop(
          `Auth Error (${statusCode}) - Retry limit reached (${maxAuthRetries}). Stopping.`,
          statusCode,
          errorBody
        );
        return;
      }

      this._recordError(`Auth Error (${statusCode})`, String(statusCode));
      this._pushEvent({
        type: 'error',
        statusCode,
        message: `Auth Error (${statusCode}) - Retry ${this._consecutiveAuthErrors}/${maxAuthRetries}. Refreshing token...`,
        ...(errorBody !== undefined ? { data: errorBody } : {}),
      });
      this._scheduleReconnect(true, undefined, attemptVersion, config);
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
        ...(errorBody !== undefined ? { data: errorBody } : {}),
      });
      this._scheduleReconnect(true, undefined, attemptVersion, config);
      return;
    } else if (statusCode === 429 || statusCode === 503) {
      // 3e. Rate limit / Service unavailable: Honor Retry-After
      const retryAfterHeader = response.headers.get('Retry-After');
      const rawRetryAfterMs = this._parseRetryAfterHeader(retryAfterHeader);
      this._disconnectReason = 'server_error';
      this._recordError(`HTTP ${statusCode}`, String(statusCode));

      if (rawRetryAfterMs !== undefined) {
        const maxIntervalMs = config.maxRetryIntervalMs ?? 30000;
        const boundedRetryMs = Math.max(
          0,
          Math.min(rawRetryAfterMs, maxIntervalMs)
        );
        const jitter = 500 + Math.floor(Math.random() * 1001); // 0.5s - 1.5s matching Native
        const totalDelayMs = Math.max(1000, boundedRetryMs + jitter);

        this._pushEvent({
          type: 'error',
          statusCode,
          retry: totalDelayMs,
          message: `Retry-After received: ${Math.round(totalDelayMs / 1000)}s`,
          ...(errorBody !== undefined ? { data: errorBody } : {}),
        });
        this._scheduleReconnect(true, totalDelayMs, attemptVersion, config);
        return;
      }

      if (statusCode === 429) {
        this._pushEvent({
          type: 'error',
          statusCode: 429,
          message: 'Rate Limited (429). Retrying with backoff...',
          ...(errorBody !== undefined ? { data: errorBody } : {}),
        });
        this._scheduleReconnect(true, undefined, attemptVersion, config);
        return;
      }

      this._pushEvent({
        type: 'error',
        statusCode,
        message: `HTTP ${statusCode}`,
        ...(errorBody !== undefined ? { data: errorBody } : {}),
      });
      this._scheduleReconnect(true, undefined, attemptVersion, config);
      return;
    } else if (statusCode >= 400 && statusCode <= 499) {
      // 3f. Fatal client error (e.g. 400 Bad Request, 404 Not Found, 405 Method Not Allowed)
      this._disconnectReason = 'server_error';
      const bodyPreview = formatErrorBodyPreview(errorBody);
      const fatalMessage = bodyPreview
        ? `Fatal Error (${statusCode}): ${bodyPreview}`
        : `Fatal Error (${statusCode}). Stopping.`;
      this._failAndStop(fatalMessage, statusCode, errorBody);
      return;
    } else if (statusCode >= 500) {
      // 3g. Server error: Recoverable
      this._disconnectReason = 'server_error';
      this._recordError(`Server Error (${statusCode})`, String(statusCode));
      const bodyPreview = formatErrorBodyPreview(errorBody);
      const errorMsg = bodyPreview
        ? `Server Error (${statusCode}): ${bodyPreview}`
        : `Server Error (${statusCode})`;
      this._pushEvent({
        type: 'error',
        statusCode,
        message: errorMsg,
        ...(errorBody !== undefined ? { data: errorBody } : {}),
      });
      this._scheduleReconnect(true, undefined, attemptVersion, config);
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
    if (this._isReconnecting) {
      this._reconnectCount++;
      this._isReconnecting = false;
    }
    this._connectedAt = Date.now();
    this._updateState('open');
    if (this._isStale(attemptVersion)) return;
    this._pushEvent({ type: 'open', statusCode });
    if (this._isStale(attemptVersion)) return;

    // 5. Initialize streaming reader and parser
    const parser = new SseEventParser(this, this._lastProcessedId);
    this._activeParser = parser;
    const reader = response.body.getReader();
    this._activeReader = reader;
    const decoder = new TextDecoder('utf-8');

    // 6. Setup idle read timeout
    this._resetReadTimeout(attemptVersion, config);

    try {
      while (!this._isStale(attemptVersion)) {
        const { value, done } = await reader.read();

        if (this._isStale(attemptVersion)) {
          break;
        }

        if (done) {
          const tail = decoder.decode();
          if (tail) {
            parser.feed(tail);
          }
          parser.endOfStream();
          break;
        }

        if (value) {
          if (this._timeToFirstByteMs === undefined) {
            this._timeToFirstByteMs = Date.now() - attemptStartTime;
          }
          this._rawBytesReceived += value.byteLength;
          this._chunksReceived++;
          this._resetReadTimeout(attemptVersion, config);

          const text = decoder.decode(value, { stream: true });
          parser.feed(text);
        }
      }
    } catch (readErr) {
      if (this._isStale(attemptVersion)) return;
      const isAborted = abortController.signal.aborted;
      if (!isAborted) {
        const errorMsg =
          readErr instanceof Error ? readErr.message : 'Read error';
        this._disconnectReason = 'network_error';
        this._recordError(errorMsg, undefined);
        this._pushEvent({ type: 'error', message: errorMsg });
        this._scheduleReconnect(true, undefined, attemptVersion, config);
        return;
      }
    } finally {
      this._clearReadTimeout();
    }

    if (this._isStale(attemptVersion)) return;

    // Clean disconnect from server
    this._scheduleReconnect(false, undefined, attemptVersion, config);
  }

  // =========================================================================
  // Reconnect & Teardown Helpers
  // =========================================================================

  private _scheduleReconnect(
    isError: boolean,
    fixedDelayMs: number | undefined,
    attemptVersion: number,
    config: SseConfig
  ): void {
    if (this._isStale(attemptVersion)) return;

    if (this._reconnectStrategy.hasReachedMaxAttempts()) {
      this._failAndStop(
        `Max reconnection attempts reached (${this._reconnectStrategy.maxReconnectAttempts}).`
      );
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
      this._reconnectTimer = undefined;
      if (!this._isStale(newVersion)) {
        this._establishConnection(newVersion, config);
      }
    }, delay);
  }

  private _stopInternal(emitClosed: boolean): void {
    this._connectedAt = undefined;
    this._isRunning = false;
    this._isReconnecting = false;
    this._wasRunningBeforeNetworkLoss = false;
    this._reconnectStrategy.reset();
    this._connectionAttemptVersion++;

    this._teardownConnection();

    if (emitClosed && this._state !== 'failed') {
      this._updateState('closed');
    }
  }

  private _failAndStop(
    message: string,
    statusCode?: number,
    data?: string
  ): void {
    this._recordError(
      message,
      statusCode !== undefined ? String(statusCode) : undefined
    );
    this._pushEvent({
      type: 'error',
      message,
      statusCode,
      ...(data !== undefined ? { data } : {}),
    });
    this._updateState('failed');
    this._stopInternal(false);
  }

  private _teardownConnection(): void {
    this._cleanupTimers();
    this._cleanupTransport();
    this._flushBatch();
  }

  private _cleanupTransport(): void {
    if (this._activeParser) {
      this._activeParser.abort();
      this._activeParser = undefined;
    }
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

  private async _readBoundedErrorBody(
    response: Response,
    connectionTimeoutMs: number,
    requestStartTime: number,
    abortController: AbortController,
    attemptVersion: number
  ): Promise<string | undefined> {
    const effectiveTimeoutMs =
      connectionTimeoutMs > 0 ? connectionTimeoutMs : 15000;
    const remainingTimeoutMs = Math.max(
      0,
      effectiveTimeoutMs - (Date.now() - requestStartTime)
    );
    if (remainingTimeoutMs <= 0) {
      try {
        response.body?.cancel?.().catch(() => {});
      } catch {
        // Ignore cancellation errors
      }
      return undefined;
    }

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      this._activeReader = reader;
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let timedOut = false;

      let streamTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<{ value: undefined; done: true }>(
        (resolve) => {
          streamTimer = setTimeout(() => {
            if (this._errorBodyTimer === streamTimer) {
              this._errorBodyTimer = undefined;
            }
            timedOut = true;
            resolve({ value: undefined, done: true });
            try {
              reader.cancel().catch(() => {});
            } catch {
              // Ignore reader cancellation errors
            }
            try {
              abortController.abort();
            } catch {
              // Ignore abort errors
            }
          }, remainingTimeoutMs);
          this._errorBodyTimer = streamTimer;
        }
      );

      try {
        while (
          totalBytes < MAX_ERROR_BODY_BYTES &&
          !timedOut &&
          !this._isStale(attemptVersion)
        ) {
          const { value, done } = await Promise.race([
            reader.read(),
            timeoutPromise,
          ]);
          if (timedOut || this._isStale(attemptVersion) || done) {
            break;
          }
          if (value && value.byteLength > 0) {
            const remaining = MAX_ERROR_BODY_BYTES - totalBytes;
            const slice =
              value.byteLength > remaining
                ? value.subarray(0, remaining)
                : value;
            chunks.push(slice);
            totalBytes += slice.byteLength;
          }
        }
      } catch {
        // Preserve already-buffered partial error body bytes before disconnect/abort
      } finally {
        if (streamTimer !== undefined) {
          clearTimeout(streamTimer);
          if (this._errorBodyTimer === streamTimer) {
            this._errorBodyTimer = undefined;
          }
        }
        if (this._activeReader === reader) {
          this._activeReader = undefined;
        }
        try {
          reader.cancel().catch(() => {});
        } catch {
          // Ignore reader cancellation errors
        }
        try {
          reader.releaseLock();
        } catch {
          // Ignore releaseLock errors
        }
      }

      if (this._isStale(attemptVersion) || totalBytes === 0) {
        return undefined;
      }

      let combined: Uint8Array;
      if (chunks.length === 1 && chunks[0]) {
        combined = chunks[0];
      } else {
        combined = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }
      const decoded = new TextDecoder('utf-8').decode(combined);
      return decoded.length > 0 ? decoded : undefined;
    }

    // Fallback for environments without ReadableStream body support
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const fallbackTimeoutPromise = new Promise<undefined>((resolve) => {
      fallbackTimer = setTimeout(() => {
        if (this._errorBodyTimer === fallbackTimer) {
          this._errorBodyTimer = undefined;
        }
        resolve(undefined);
        try {
          abortController.abort();
        } catch {
          // Ignore abort errors
        }
      }, remainingTimeoutMs);
      this._errorBodyTimer = fallbackTimer;
    });

    let raw: string | undefined;
    try {
      raw = await Promise.race([response.text(), fallbackTimeoutPromise]);
    } catch {
      // Ignore body reading error
    } finally {
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
        if (this._errorBodyTimer === fallbackTimer) {
          this._errorBodyTimer = undefined;
        }
      }
    }

    if (this._isStale(attemptVersion) || !raw) {
      return undefined;
    }
    const encoded = new TextEncoder().encode(raw);
    const bounded =
      encoded.byteLength > MAX_ERROR_BODY_BYTES
        ? encoded.subarray(0, MAX_ERROR_BODY_BYTES)
        : encoded;
    const decoded = new TextDecoder('utf-8').decode(bounded);
    return decoded.length > 0 ? decoded : undefined;
  }

  private _cleanupTimers(): void {
    if (this._connectionTimer) {
      clearTimeout(this._connectionTimer);
      this._connectionTimer = undefined;
    }
    if (this._errorBodyTimer) {
      clearTimeout(this._errorBodyTimer);
      this._errorBodyTimer = undefined;
    }
    if (this._readTimeoutTimer) {
      clearTimeout(this._readTimeoutTimer);
      this._readTimeoutTimer = undefined;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
  }

  private _resetReadTimeout(
    attemptVersion: number,
    config: SseConfig = this._config!
  ): void {
    this._clearReadTimeout();
    const readTimeoutMs = config.readTimeoutMs ?? 300000;
    if (readTimeoutMs <= 0) return;

    this._readTimeoutTimer = setTimeout(() => {
      this._readTimeoutTimer = undefined;
      if (!this._isStale(attemptVersion)) {
        this._disconnectReason = 'timeout';
        this._updateState('stale');
        const errorMsg = 'Read timeout';
        this._recordError(errorMsg, undefined);
        this._pushEvent({ type: 'error', message: errorMsg });
        this._scheduleReconnect(true, undefined, attemptVersion, config);
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
    const maxBufferSize = resolveMaxBufferSize(this._config?.maxBufferSize);

    this._batchBuffer.push(event);
    if (this._batchBuffer.length > this._peakBufferedEvents) {
      this._peakBufferedEvents = this._batchBuffer.length;
    }

    if (batchingIntervalMs <= 0) {
      this._flushBatch();
    } else if (this._batchBuffer.length >= maxBufferSize) {
      this._bufferOverflowCount++;
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

  private _recordActivity(now: number): void {
    if (this._lastActivityTime > 0) {
      const gap = now - this._lastActivityTime;
      if (gap > this._maxEventGapMs) {
        this._maxEventGapMs = gap;
      }
    }
    this._lastActivityTime = now;
  }

  // =========================================================================
  // SseEventParserDelegate Implementation
  // =========================================================================

  onEvent(
    id: string | undefined,
    type: string | undefined,
    data: string
  ): void {
    if (!this._isRunning) return;
    const now = Date.now();
    this._lastEventTime = now;
    this._recordActivity(now);

    const eventType = type ?? 'message';
    const encodedDataSize = getUtf8ByteCount(data);
    const eventTypeSize =
      eventType === 'message' ? 0 : getUtf8ByteCount(eventType);
    this._totalBytesReceived += encodedDataSize + eventTypeSize;

    this._totalEventsReceived++;

    let parsedData: AnyMap | undefined;
    if (this._config?.autoParseJSON && /^\s*\{/.test(data)) {
      try {
        parsedData = JSON.parse(data) as AnyMap;
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
    if (!this._isRunning) return;
    const now = Date.now();
    this._lastHeartbeatTime = now;
    this._recordActivity(now);
    this._totalBytesReceived += getUtf8ByteCount(comment);
    this._commentsReceived++;

    this._pushEvent({
      type: 'heartbeat',
      message: comment,
    });
  }

  onRetry(retryMs: number): void {
    if (!this._isRunning) return;
    this._serverRetryDelayMs = retryMs;
    this._reconnectStrategy.updateRetryInterval(retryMs);
  }

  onIdUpdate(id: string | undefined): void {
    if (!this._isRunning) return;
    if (id !== undefined && id !== this._lastProcessedId) {
      this._totalBytesReceived += getUtf8ByteCount(id);
    }
    this._lastProcessedId = id;
  }

  onParseError(error: Error): void {
    if (!this._isRunning) return;
    this._parseErrors++;
    this._disconnectReason = 'parser_error';
    this._failAndStop(`SSE parser error: ${error.message}`);
  }

  onLinesParsed(count: number): void {
    if (!this._isRunning) return;
    this._linesParsed += count;
  }

  // =========================================================================
  // Network Monitoring
  // =========================================================================

  private _setupNetworkListeners(): void {
    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function' ||
      this._removeNetworkListeners !== undefined
    )
      return;

    const offlineListener = () => {
      if (this._isRunning) {
        this._wasRunningBeforeNetworkLoss = true;
        this._disconnectReason = 'network_error';
        this._connectionAttemptVersion++;
        this._teardownConnection();
        this._updateState('paused');
        this._isRunning = false;
      }
    };

    const onlineListener = () => {
      if (this._wasRunningBeforeNetworkLoss) {
        this._wasRunningBeforeNetworkLoss = false;
        this.start();
      }
    };

    const target: EventTarget = window;
    target.addEventListener('offline', offlineListener);
    target.addEventListener('online', onlineListener);
    this._removeNetworkListeners = () => {
      target.removeEventListener('offline', offlineListener);
      target.removeEventListener('online', onlineListener);
    };
  }

  private _teardownNetworkListeners(): void {
    if (
      typeof window === 'undefined' ||
      typeof window.removeEventListener !== 'function' ||
      !this._removeNetworkListeners
    )
      return;
    this._removeNetworkListeners();
    this._removeNetworkListeners = undefined;
  }
}
