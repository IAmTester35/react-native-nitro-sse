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

  test('dispatches pending event at endOfStream (EOF)', () => {
    parser.feed('data: final_unclosed');
    expect(delegate.onEvent).not.toHaveBeenCalled();

    parser.endOfStream();
    expect(delegate.onEvent).toHaveBeenCalledWith(
      undefined,
      undefined,
      'final_unclosed'
    );
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
});
