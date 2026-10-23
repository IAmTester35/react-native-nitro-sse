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

export class SseEventParser {
  private _delegate: SseEventParserDelegate;
  private _buffer: string = '';
  private _dataBuffer: string = '';
  private _hasData: boolean = false;
  private _eventType?: string;
  private _lastEventId?: string;
  private _isAtStreamStart: boolean = true;
  private _skipLeadingLf: boolean = false;

  constructor(delegate: SseEventParserDelegate, initialLastEventId?: string) {
    this._delegate = delegate;
    this._lastEventId = initialLastEventId;
  }

  get lastEventId(): string | undefined {
    return this._lastEventId;
  }

  /**
   * Resets parser state for reconnection.
   */
  reset(initialLastEventId?: string): void {
    this._buffer = '';
    this._dataBuffer = '';
    this._hasData = false;
    this._eventType = undefined;
    this._lastEventId = initialLastEventId;
    this._isAtStreamStart = true;
    this._skipLeadingLf = false;
  }

  /**
   * Signals end of stream (EOF) — flushes pending line and pending event if any.
   */
  endOfStream(): void {
    if (this._buffer.length > 0) {
      const line = this._buffer;
      this._buffer = '';
      this._processLine(line);
      this._delegate.onLinesParsed(1);
    }

    if (this._hasData) {
      const data = this._dataBuffer;
      const id = this._lastEventId;
      const type = this._eventType;

      this._dataBuffer = '';
      this._hasData = false;
      this._eventType = undefined;

      this._delegate.onEvent(id, type, data);
    }
  }

  /**
   * Feeds a decoded UTF-8 text chunk into the streaming parser.
   */
  feed(chunk: string): void {
    if (!chunk) return;

    let text = chunk;

    // Handle CR at previous chunk boundary: if followed immediately by LF, consume LF
    if (this._skipLeadingLf) {
      this._skipLeadingLf = false;
      if (text.charCodeAt(0) === 0x0a) {
        text = text.slice(1);
        if (!text && !this._buffer) return;
      }
    }

    if (this._isAtStreamStart) {
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
      this._isAtStreamStart = false;
      if (!text && !this._buffer) return;
    }

    const fullText = this._buffer ? this._buffer + text : text;
    this._buffer = '';

    const len = fullText.length;
    let start = 0;
    let i = 0;
    let parsedLinesInChunk = 0;

    while (i < len) {
      // Check maximum line length constraint before scanning further
      if (i - start > MAX_SSE_LINE_LENGTH) {
        this._delegate.onParseError(
          new Error(
            `SSE line exceeded maximum limit of ${MAX_SSE_LINE_LENGTH} characters`
          )
        );
        // Discard current overflowing line and advance
        while (
          i < len &&
          fullText.charCodeAt(i) !== 0x0a &&
          fullText.charCodeAt(i) !== 0x0d
        ) {
          i++;
        }
        if (
          i < len &&
          fullText.charCodeAt(i) === 0x0d &&
          i + 1 < len &&
          fullText.charCodeAt(i + 1) === 0x0a
        ) {
          i += 2;
        } else if (i < len) {
          i += 1;
        }
        start = i;
        continue;
      }

      const code = fullText.charCodeAt(i);
      if (code === 0x0a) {
        // \n (LF)
        const line = fullText.slice(start, i);
        start = i + 1;
        i++;
        this._processLine(line);
        parsedLinesInChunk++;
      } else if (code === 0x0d) {
        // \r (CR or CRLF)
        if (i + 1 < len) {
          if (fullText.charCodeAt(i + 1) === 0x0a) {
            // CRLF in current buffer
            const line = fullText.slice(start, i);
            start = i + 2;
            i += 2;
            this._processLine(line);
            parsedLinesInChunk++;
          } else {
            // Bare CR in current buffer
            const line = fullText.slice(start, i);
            start = i + 1;
            i++;
            this._processLine(line);
            parsedLinesInChunk++;
          }
        } else {
          // \r at the very end of current buffer
          const line = fullText.slice(start, i);
          start = i + 1;
          i++;
          this._skipLeadingLf = true;
          this._processLine(line);
          parsedLinesInChunk++;
        }
      } else {
        i++;
      }
    }

    if (start < len) {
      const remaining = fullText.slice(start);
      if (remaining.length > MAX_SSE_LINE_LENGTH) {
        this._delegate.onParseError(
          new Error(
            `SSE line exceeded maximum limit of ${MAX_SSE_LINE_LENGTH} characters`
          )
        );
        this._buffer = '';
      } else {
        this._buffer = remaining;
      }
    }

    if (parsedLinesInChunk > 0) {
      this._delegate.onLinesParsed(parsedLinesInChunk);
    }
  }

  private _processLine(line: string): void {
    if (line === '') {
      // Empty line dispatches the current event
      if (this._hasData) {
        const data = this._dataBuffer;
        const id = this._lastEventId;
        const type = this._eventType;

        this._dataBuffer = '';
        this._hasData = false;
        this._eventType = undefined;

        this._delegate.onEvent(id, type, data);
      }
      return;
    }

    if (line.startsWith(':')) {
      // Lines starting with ':' are comments / heartbeats
      const rawComment = line.slice(1);
      const comment = rawComment.startsWith(' ')
        ? rawComment.slice(1)
        : rawComment;
      this._delegate.onComment(comment);
      return;
    }

    const colonIndex = line.indexOf(':');
    let field: string;
    let value: string;

    if (colonIndex !== -1) {
      field = line.slice(0, colonIndex);
      const rawValue = line.slice(colonIndex + 1);
      value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    } else {
      field = line;
      value = '';
    }

    switch (field) {
      case 'data': {
        const separatorSize = this._hasData ? 1 : 0;
        if (
          this._dataBuffer.length + separatorSize + value.length >
          MAX_SSE_EVENT_DATA_SIZE
        ) {
          this._delegate.onParseError(
            new Error(
              `SSE event data exceeded maximum limit of ${MAX_SSE_EVENT_DATA_SIZE} characters`
            )
          );
          this._dataBuffer = '';
          this._hasData = false;
          return;
        }

        if (this._hasData) {
          this._dataBuffer += '\n' + value;
        } else {
          this._dataBuffer = value;
          this._hasData = true;
        }
        break;
      }

      case 'id': {
        // WHATWG SSE: If field value contains a U+0000 NULL character, ignore the field
        if (!value.includes('\0')) {
          this._lastEventId = value === '' ? undefined : value;
          this._delegate.onIdUpdate(this._lastEventId);
        }
        break;
      }

      case 'event': {
        this._eventType = value === '' ? undefined : value;
        break;
      }

      case 'retry': {
        // WHATWG SSE: If field value consists solely of ASCII digits, set reconnection time
        if (value.length > 0 && /^[0-9]+$/.test(value)) {
          const retryVal = parseInt(value, 10);
          if (!Number.isNaN(retryVal) && retryVal >= 0) {
            this._delegate.onRetry(retryVal);
          }
        }
        break;
      }

      default:
        // Unknown fields ignored per WHATWG spec
        break;
    }
  }
}
