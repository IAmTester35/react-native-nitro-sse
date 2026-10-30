import {
  SseEventParser,
  type SseEventParserDelegate,
  MAX_SSE_LINE_LENGTH,
  MAX_SSE_EVENT_DATA_SIZE,
} from '../SseEventParser';

describe('SseEventParser', () => {
  let delegate: jest.Mocked<SseEventParserDelegate>;
  let parser: SseEventParser;

  beforeEach(() => {
    delegate = {
      onEvent: jest.fn(),
      onComment: jest.fn(),
      onRetry: jest.fn(),
      onIdUpdate: jest.fn(),
      onParseError: jest.fn(),
      onLinesParsed: jest.fn(),
    };
    parser = new SseEventParser(delegate);
  });

  test('parses basic single-line event with LF', () => {
    parser.feed('data: hello world\n\n');
    expect(delegate.onEvent).toHaveBeenCalledTimes(1);
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'hello world'
    );
    expect(delegate.onLinesParsed).toHaveBeenCalledWith(2);
  });

  test('parses custom event type and id', () => {
    parser.feed('event: user_join\nid: usr_42\ndata: Alice\n\n');
    expect(delegate.onIdUpdate).toHaveBeenCalledWith('usr_42');
    expect(delegate.onEvent).toHaveBeenCalledWith(
      'usr_42',
      'user_join',
      'Alice'
    );
  });

  test('strips leading UTF-8 BOM if present at stream start', () => {
    parser.feed('\uFEFFdata: bom_stripped\n\n');
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'bom_stripped'
    );
  });

  test('handles CRLF line endings', () => {
    parser.feed('data: crlf_message\r\n\r\n');
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'crlf_message'
    );
  });

  test('handles bare CR line endings', () => {
    parser.feed('data: bare_cr_message\r\r');
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'bare_cr_message'
    );
  });

  test('handles CRLF split across chunk boundary', () => {
    parser.feed('data: chunked_message\r');
    expect(delegate.onEvent).not.toHaveBeenCalled();

    parser.feed('\n\n');
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'chunked_message'
    );
  });

  test('handles bare CR split across chunk boundary followed by text', () => {
    parser.feed('data: line1\r');
    expect(delegate.onEvent).not.toHaveBeenCalled();

    parser.feed('data: line2\r\r');
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'line1\nline2'
    );
  });

  test('concatenates multi-line data with newline', () => {
    parser.feed('data: line one\ndata: line two\ndata: line three\n\n');
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'line one\nline two\nline three'
    );
  });

  test('parses comments with and without leading space', () => {
    parser.feed(': keepalive ping\n:heartbeat\n');
    expect(delegate.onComment).toHaveBeenCalledWith('keepalive ping');
    expect(delegate.onComment).toHaveBeenCalledWith('heartbeat');
    expect(delegate.onEvent).not.toHaveBeenCalled();
  });

  test('parses retry directives with ASCII digits', () => {
    parser.feed('retry: 5000\n');
    expect(delegate.onRetry).toHaveBeenCalledWith(5000);

    parser.feed('retry: invalid_string\n');
    expect(delegate.onRetry).toHaveBeenCalledTimes(1); // not called again
  });

  test('ignores ID field containing NULL character', () => {
    parser.feed('id: bad\0id\ndata: test\n\n');
    expect(delegate.onIdUpdate).not.toHaveBeenCalled();
    expect(delegate.onEvent).toHaveBeenCalledWith(undefined, undefined, 'test');
  });

  test('clears lastEventId when empty id: line received', () => {
    parser.feed('id: 101\ndata: first\n\n');
    expect(delegate.onIdUpdate).toHaveBeenCalledWith('101');
    expect(parser.lastEventId).toBe('101');

    parser.feed('id:\ndata: second\n\n');
    expect(delegate.onIdUpdate).toHaveBeenCalledWith(undefined);
    expect(parser.lastEventId).toBeUndefined();
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'second'
    );
  });

  test('discards incomplete event at endOfStream (EOF)', () => {
    parser.feed('data: final_unclosed');
    expect(delegate.onEvent).not.toHaveBeenCalled();

    parser.endOfStream();
    expect(delegate.onEvent).not.toHaveBeenCalled();
  });

  test('ignores unknown field names silently', () => {
    parser.feed('foo: bar\nx-custom: value\ndata: valid\n\n');
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'valid'
    );
  });

  test('triggers parse error and discards when single line exceeds MAX_SSE_LINE_LENGTH', () => {
    const hugeLine = 'data: ' + 'x'.repeat(MAX_SSE_LINE_LENGTH + 10) + '\n';
    parser.feed(hugeLine);
    expect(delegate.onParseError).toHaveBeenCalled();
  });

  test('triggers parse error and discards when dataBuffer exceeds MAX_SSE_EVENT_DATA_SIZE', () => {
    const hugeData = 'x'.repeat(MAX_SSE_EVENT_DATA_SIZE + 10);
    parser.feed(`data: ${hugeData}\n\n`);
    expect(delegate.onParseError).toHaveBeenCalled();
    expect(delegate.onEvent).not.toHaveBeenCalled();
  });

  test('resets parser state correctly', () => {
    parser.feed('id: 99\ndata: pending');
    parser.reset('initial_id');
    expect(parser.lastEventId).toBe('initial_id');

    parser.feed('data: new_event\n\n');
    expect(delegate.onEvent).toHaveBeenCalledWith(
      'initial_id',
      undefined,
      'new_event'
    );
  });

  test('ignores retry directive with plus sign per WHATWG SSE', () => {
    parser.feed('retry: +1000\ndata: after_retry\n\n');
    expect(delegate.onRetry).not.toHaveBeenCalled();
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'after_retry'
    );
  });

  test('handles split multibyte UTF-8 characters across chunk boundaries', () => {
    const fullMessage = 'data: Xin chào 🇻🇳 🚀\n\n';
    const splitIndex = 14;
    const chunk1 = fullMessage.slice(0, splitIndex);
    const chunk2 = fullMessage.slice(splitIndex);

    parser.feed(chunk1);
    expect(delegate.onEvent).not.toHaveBeenCalled();

    parser.feed(chunk2);
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'Xin chào 🇻🇳 🚀'
    );
  });

  test('buffers many tiny fragments without line breaks correctly', () => {
    const message = 'data: streaming payload across many tiny chunks\n\n';
    // Feed one character at a time to test fragment accumulation
    for (const char of message) {
      parser.feed(char);
    }
    expect(delegate.onEvent).toHaveBeenCalledTimes(1);
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'streaming payload across many tiny chunks'
    );
  });

  test('handles colonless fields per WHATWG specification', () => {
    // Colonless 'data' line appends empty string; colonless 'event' resets eventType
    parser.feed('data\nevent\n\n');
    expect(delegate.onEvent).toHaveBeenCalledWith(undefined, undefined, '');
  });

  test('Issue 2.6 repro: aborts parser and rejects subsequent chunks when trailing unclosed fragment exceeds MAX_SSE_LINE_LENGTH', () => {
    const hugeTrailing =
      'data: valid\n\n' + 'x'.repeat(MAX_SSE_LINE_LENGTH + 10);
    parser.feed(hugeTrailing);
    expect(delegate.onParseError).toHaveBeenCalledTimes(1);

    // Subsequent feed should be ignored because parser is aborted
    parser.feed('data: ignored\n\n');
    expect(delegate.onEvent).toHaveBeenCalledTimes(1);
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'valid'
    );
  });

  test('Issue 2.6 repro: aborts parser on slow-path trailing unclosed fragment exceeding MAX_SSE_LINE_LENGTH', () => {
    parser.feed('data: valid\r\n\r\n');
    parser.feed(':\r' + 'x'.repeat(MAX_SSE_LINE_LENGTH + 10));
    expect(delegate.onParseError).toHaveBeenCalledTimes(1);

    // Subsequent feed should be ignored because parser is aborted
    parser.feed('data: ignored\n\n');
    expect(delegate.onEvent).toHaveBeenCalledTimes(1);
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'valid'
    );
  });
});
