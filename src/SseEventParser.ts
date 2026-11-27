/**
 * WHATWG Server-Sent Events (SSE) streaming parser.
 *
 * Implements the W3C/WHATWG SSE parsing algorithm with cross-platform parity
 * matching iOS SseEventParser (Swift) and Android SseEventReader (Kotlin).
 */

export const MAX_SSE_LINE_LENGTH = 16 * 1024 * 1024; // 16 MB
export const MAX_SSE_EVENT_DATA_SIZE = 16 * 1024 * 1024; // 16 MB

export interface SseEventParserDelegate {
  onEvent(id: string | undefined, type: string | undefined, data: string): void;
  onComment(comment: string): void;
  onRetry(retryMs: number): void;
  onIdUpdate(id: string | undefined): void;
  onParseError(error: Error): void;
  onLinesParsed(count: number): void;
}

// ASCII char codes
const LF = 0x0a; // 10
const CR = 0x0d; // 13
const SPACE = 0x20; // 32
const COLON = 0x3a; // 58

export class SseEventParser {
  private _delegate: SseEventParserDelegate;
  private _pendingFragments: string[] = [];
  private _pendingLength: number = 0;
  private _dataBuffer: string = '';
  private _hasData: boolean = false;
  private _eventType?: string;
  private _lastEventIdBuffer?: string;
  private _lastEventId?: string;
  private _idUpdatedInCurrentEvent: boolean = false;
  private _isAtStreamStart: boolean = true;
  private _skipLeadingLf: boolean = false;
  private _aborted: boolean = false;

  constructor(delegate: SseEventParserDelegate, initialLastEventId?: string) {
    this._delegate = delegate;
    this._lastEventId = initialLastEventId;
    this._lastEventIdBuffer = initialLastEventId;
  }

  get lastEventId(): string | undefined {
    return this._lastEventId;
  }

  /**
   * Resets parser state for reconnection.
   */
  reset(initialLastEventId?: string): void {
    this._pendingFragments.length = 0;
    this._pendingLength = 0;
    this._dataBuffer = '';
    this._hasData = false;
    this._eventType = undefined;
    this._lastEventId = initialLastEventId;
    this._lastEventIdBuffer = initialLastEventId;
    this._idUpdatedInCurrentEvent = false;
    this._isAtStreamStart = true;
    this._skipLeadingLf = false;
    this._aborted = false;
  }

  /**
   * Signals end of stream (EOF).
   * Per WHATWG SSE specification:
   * "Once the end of the file is reached, any pending data must be discarded.
   * (If the file ends in the middle of an event, before the final empty line,
   * the incomplete event is not dispatched.)"
   */
  endOfStream(): void {
    if (this._aborted) return;
    this._pendingFragments.length = 0;
    this._pendingLength = 0;
    this._dataBuffer = '';
    this._hasData = false;
    this._eventType = undefined;
    this._idUpdatedInCurrentEvent = false;
    this._lastEventIdBuffer = this._lastEventId;
  }

  /**
   * Aborts parsing immediately and discards pending fragments.
   */
  abort(): void {
    this._aborted = true;
    this._pendingFragments.length = 0;
    this._pendingLength = 0;
  }

  private _fail(message: string): void {
    this._aborted = true;
    this._pendingFragments.length = 0;
    this._pendingLength = 0;
    this._delegate.onParseError(new Error(message));
  }

  /**
   * Feeds a decoded UTF-8 text chunk into the streaming parser.
   */
  feed(chunk: string): void {
    if (!chunk || this._aborted) return;

    let text = chunk;

    // Handle CR at previous chunk boundary: if followed immediately by LF, consume LF
    if (this._skipLeadingLf) {
      this._skipLeadingLf = false;
      if (text.charCodeAt(0) === LF) {
        text = text.slice(1);
        if (!text && this._pendingLength === 0) return;
      }
    }

    if (this._isAtStreamStart) {
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
      this._isAtStreamStart = false;
      if (!text && this._pendingLength === 0) return;
    }

    const hasLf = text.indexOf('\n') !== -1;
    const hasCr = text.indexOf('\r') !== -1;

    // Optimization: When the incoming chunk has no line terminator, buffer it as an array fragment
    // without concatenating strings on every feed. This eliminates O(N^2) memory reallocation.
    if (!hasLf && !hasCr) {
      if (this._pendingLength + text.length > MAX_SSE_LINE_LENGTH) {
        this._fail(
          `SSE line exceeded maximum limit of ${MAX_SSE_LINE_LENGTH} characters`
        );
        return;
      }
      this._pendingFragments.push(text);
      this._pendingLength += text.length;
      return;
    }

    // A terminator arrived: join any accumulated fragments + current chunk once.
    // Accumulated fragments are guaranteed not to contain CR or LF, so scanning resumes at `carried`.
    const carried = this._pendingLength;
    let fullText: string;
    if (this._pendingFragments.length > 0) {
      this._pendingFragments.push(text);
      fullText = this._pendingFragments.join('');
      this._pendingFragments.length = 0;
      this._pendingLength = 0;
    } else {
      fullText = text;
    }

    const len = fullText.length;
    let parsedLinesInChunk = 0;
    let start = 0;

    // Fast-path: When there are no carriage returns in fullText (the vast majority of SSE streams),
    // scan using native SIMD-accelerated indexOf('\n') starting at `carried` instead of 0.
    if (!hasCr) {
      let nextLf = fullText.indexOf('\n', carried);

      while (nextLf !== -1 && !this._aborted) {
        if (nextLf - start > MAX_SSE_LINE_LENGTH) {
          this._fail(
            `SSE line exceeded maximum limit of ${MAX_SSE_LINE_LENGTH} characters`
          );
          return;
        }

        const line = fullText.slice(start, nextLf);
        start = nextLf + 1;
        this._processLine(line);
        parsedLinesInChunk++;
        nextLf = fullText.indexOf('\n', start);
      }
    } else {
      // Slow-path: Handles streams with CR, CRLF, and bare CR line endings
      let i = carried;

      while (i < len && !this._aborted) {
        if (i - start > MAX_SSE_LINE_LENGTH) {
          this._fail(
            `SSE line exceeded maximum limit of ${MAX_SSE_LINE_LENGTH} characters`
          );
          return;
        }

        const code = fullText.charCodeAt(i);
        if (code === LF) {
          const line = fullText.slice(start, i);
          start = i + 1;
          i++;
          this._processLine(line);
          parsedLinesInChunk++;
        } else if (code === CR) {
          const isCrlf = i + 1 < len && fullText.charCodeAt(i + 1) === LF;
          const step = isCrlf ? 2 : 1;
          if (i + 1 === len) {
            this._skipLeadingLf = true;
          }
          const line = fullText.slice(start, i);
          start = i + step;
          i += step;
          this._processLine(line);
          parsedLinesInChunk++;
        } else {
          i++;
        }
      }
    }

    if (this._aborted) return;

    if (start < len) {
      const remaining = fullText.slice(start);
      if (remaining.length > MAX_SSE_LINE_LENGTH) {
        this._fail(
          `SSE line exceeded maximum limit of ${MAX_SSE_LINE_LENGTH} characters`
        );
        return;
      }
      this._pendingFragments.push(remaining);
      this._pendingLength = remaining.length;
    }

    if (parsedLinesInChunk > 0) {
      this._delegate.onLinesParsed(parsedLinesInChunk);
    }
  }

  private _processLine(line: string): void {
    if (line === '') {
      // Empty line dispatches the current event per WHATWG specification
      // Step 1: Set last event ID string of event source to value of last event ID buffer
      if (this._idUpdatedInCurrentEvent) {
        this._idUpdatedInCurrentEvent = false;
        this._lastEventId = this._lastEventIdBuffer;
        this._delegate.onIdUpdate(this._lastEventId);
      }

      // Step 2: If data buffer is empty, reset data buffer and event type buffer to empty string and return
      if (!this._hasData) {
        this._eventType = undefined;
        return;
      }

      // Steps 3-6: Dispatch event
      const data = this._dataBuffer;
      const id = this._lastEventId;
      const type = this._eventType;

      this._dataBuffer = '';
      this._hasData = false;
      this._eventType = undefined;

      this._delegate.onEvent(id, type, data);
      return;
    }

    const firstCharCode = line.charCodeAt(0);

    // Comment line: starts with ':'
    if (firstCharCode === COLON) {
      const comment =
        line.charCodeAt(1) === SPACE ? line.slice(2) : line.slice(1);
      this._delegate.onComment(comment);
      return;
    }

    const colonIndex = line.indexOf(':');
    let field: string;
    let value: string;

    if (colonIndex !== -1) {
      field = line.slice(0, colonIndex);
      const rawValue = line.slice(colonIndex + 1);
      value = rawValue.charCodeAt(0) === SPACE ? rawValue.slice(1) : rawValue;
    } else {
      field = line;
      value = '';
    }

    switch (field) {
      case 'data': {
        this._appendData(value);
        break;
      }

      case 'id': {
        this._handleId(value);
        break;
      }

      case 'event': {
        this._handleEvent(value);
        break;
      }

      case 'retry': {
        // WHATWG SSE: If field value consists solely of ASCII digits, set reconnection time
        if (value.length > 0 && /^[0-9]+$/.test(value)) {
          this._delegate.onRetry(parseInt(value, 10));
        }
        break;
      }

      default:
        // Unknown fields ignored per WHATWG spec
        break;
    }
  }

  private _handleEvent(value: string): void {
    this._eventType = value === '' ? undefined : value;
  }

  private _handleId(value: string): void {
    if (!value.includes('\0')) {
      this._lastEventIdBuffer = value === '' ? undefined : value;
      this._idUpdatedInCurrentEvent = true;
    }
  }

  private _appendData(value: string): void {
    const separatorSize = this._hasData ? 1 : 0;
    if (
      this._dataBuffer.length + separatorSize + value.length >
      MAX_SSE_EVENT_DATA_SIZE
    ) {
      this._dataBuffer = '';
      this._hasData = false;
      this._fail(
        `SSE event data exceeded maximum limit of ${MAX_SSE_EVENT_DATA_SIZE} characters`
      );
      return;
    }

    if (this._hasData) {
      this._dataBuffer += '\n' + value;
    } else {
      this._dataBuffer = value;
      this._hasData = true;
    }
  }
}
