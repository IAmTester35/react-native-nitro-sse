import { FetchSseDriver } from '../FetchSseDriver';
import type { SseConfig, SseEvent } from '../SseInterface';

describe('FetchSseDriver', () => {
  const TEST_URL = 'http://localhost:33333/events';
  let dispatchedEvents: SseEvent[];
  let driver: FetchSseDriver;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    dispatchedEvents = [];
    driver = new FetchSseDriver((events) => {
      dispatchedEvents.push(...events);
    });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    driver.dispose();
    globalThis.fetch = originalFetch;
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index++]));
        } else {
          controller.close();
        }
      },
    });
  }

  test('successfully connects, streams chunks, and closes on EOF', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      retryIntervalMs: 1000,
    };
    driver.setup(config);

    const stream = createMockStream([
      'data: first chunk\n\n',
      'event: custom\ndata: second chunk\n\n',
    ]);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: stream,
    });

    driver.start();
    expect(driver.getState()).toBe('connecting');

    // Allow fetch promise and stream reader to resolve
    await jest.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.isConnected()).toBe(true);
    expect(driver.getState()).toBe('open');

    // Run until reader completes EOF
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    const types = dispatchedEvents.map((e) => e.type);
    expect(types).toContain('open');
    expect(types).toContain('message');

    const messages = dispatchedEvents.filter((e) => e.type === 'message');
    expect(messages.length).toBe(2);
    expect(messages[0]?.data).toBe('first chunk');
    expect(messages[1]?.event).toBe('custom');
    expect(messages[1]?.data).toBe('second chunk');

    const stats = driver.getStats();
    expect(stats.totalEventsReceived).toBe(2);
    expect(stats.chunksReceived).toBe(2);
    expect(stats.lastStatusCode).toBe(200);
  });

  test('fails immediately without reconnecting when Content-Type is invalid', async () => {
    const config: SseConfig = { url: TEST_URL };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/html' }),
      body: createMockStream(['<html>Error</html>']),
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('failed');
    const errorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toContain('Invalid Content-Type');
  });

  test('fails immediately without reconnecting on HTTP 204 No Content', async () => {
    const config: SseConfig = { url: TEST_URL };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 204,
      headers: new Headers(),
      body: null,
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('failed');
    const errorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toContain('204 No Content');
  });

  test('fails immediately on HTTP 400 Bad Request', async () => {
    const config: SseConfig = { url: TEST_URL };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 400,
      headers: new Headers(),
      body: null,
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('failed');
    const errorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errorEvent?.statusCode).toBe(400);
  });

  test('fails immediately on HTTP 401 when no onBeforeRequest interceptor provided', async () => {
    const config: SseConfig = { url: TEST_URL };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 401,
      headers: new Headers(),
      body: null,
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('failed');
    const errorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errorEvent?.message).toContain('No interceptor provided');
  });

  test('retries on HTTP 401 with onBeforeRequest up to maxAuthRetries', async () => {
    const interceptor = jest
      .fn()
      .mockResolvedValue({ Authorization: 'Bearer refreshed' });
    const config: SseConfig = {
      url: TEST_URL,
      maxAuthRetries: 2,
      retryIntervalMs: 1000,
      jitterFactor: 0,
    };
    driver.setup(config, interceptor);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 401,
      headers: new Headers(),
      body: null,
    });

    const flushMicrotasks = async () => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    };

    driver.start();
    await flushMicrotasks();

    // 1st error -> reconnecting
    expect(driver.getState()).toBe('reconnecting');
    expect(interceptor).toHaveBeenCalledTimes(1);

    // Advance backoff timer for retry 1
    jest.advanceTimersByTime(2000);
    await flushMicrotasks();
    expect(interceptor).toHaveBeenCalledTimes(2);

    // Advance backoff timer for retry 2
    jest.advanceTimersByTime(4000);
    await flushMicrotasks();
    expect(interceptor).toHaveBeenCalledTimes(3);

    // Advance backoff timer for retry 3 (exceeds maxAuthRetries=2)
    jest.advanceTimersByTime(8000);
    await flushMicrotasks();

    // Retry limit exceeded -> should fail
    expect(driver.getState()).toBe('failed');
  });

  test('triggers stale state and reconnects when readTimeoutMs expires', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      readTimeoutMs: 5000,
      retryIntervalMs: 1000,
    };
    driver.setup(config);

    // Stream that sends one chunk and then stays silent forever
    let resolveSilent: () => void;
    const silentPromise = new Promise<void>((res) => {
      resolveSilent = res;
    });

    const encoder = new TextEncoder();
    let sent = false;
    const silentStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode('data: initial\n\n'));
        } else {
          await silentPromise;
          controller.close();
        }
      },
      cancel() {
        resolveSilent?.();
      },
    });

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: silentStream,
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('open');

    // Advance time past readTimeoutMs (5000ms)
    jest.advanceTimersByTime(5100);

    // Idle timer fired: state moved to stale then reconnecting
    expect(['stale', 'reconnecting']).toContain(driver.getState());
    expect(driver.getStats().disconnectReason).toBe('timeout');

    resolveSilent!();
  });

  test('buffers and flushes events according to batchingIntervalMs', () => {
    const config: SseConfig = {
      url: TEST_URL,
      batchingIntervalMs: 50,
      maxBufferSize: 5,
    };
    driver.setup(config);

    // Manually inject mock events
    driver.injectMockEvent({ type: 'message', data: 'm1' });
    driver.injectMockEvent({ type: 'message', data: 'm2' });

    // Not flushed yet
    expect(dispatchedEvents.length).toBe(0);
    expect(driver.getStats().eventsBuffered).toBe(2);

    // Advance time by batchingIntervalMs
    jest.advanceTimersByTime(50);
    expect(dispatchedEvents.length).toBe(2);
    expect(driver.getStats().bufferFlushCount).toBe(1);
  });

  test('flushes immediately on buffer overflow when reaching maxBufferSize', () => {
    const config: SseConfig = {
      url: TEST_URL,
      batchingIntervalMs: 500,
      maxBufferSize: 3,
    };
    driver.setup(config);

    driver.injectMockEvent({ type: 'message', data: 'm1' });
    driver.injectMockEvent({ type: 'message', data: 'm2' });
    expect(dispatchedEvents.length).toBe(0);

    // 3rd event reaches maxBufferSize -> immediate flush
    driver.injectMockEvent({ type: 'message', data: 'm3' });
    expect(dispatchedEvents.length).toBe(3);
    expect(driver.getStats().bufferOverflowCount).toBe(1);
  });

  test('autoParseJSON parses root JSON objects into parsedData', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      autoParseJSON: true,
    };
    driver.setup(config);

    const stream = createMockStream([
      'data: {"id":1,"name":"Alice"}\n\n',
      'data: [1,2,3]\n\n',
    ]);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: stream,
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    const messages = dispatchedEvents.filter((e) => e.type === 'message');
    expect(messages.length).toBe(2);
    expect(messages[0]?.parsedData).toEqual({ id: 1, name: 'Alice' });
    expect(messages[1]?.parsedData).toBeUndefined(); // array not parsed
  });

  test('recovers and reconnects with stale state on HTTP 408 Request Timeout', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      retryIntervalMs: 1000,
    };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 408,
      headers: new Headers(),
      body: null,
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('reconnecting');
    expect(driver.getStats().disconnectReason).toBe('timeout');

    const errorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.statusCode).toBe(408);
  });

  test('honors Retry-After on HTTP 429 and records attempt towards maxReconnectAttempts', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      maxReconnectAttempts: 1,
    };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 429,
      headers: new Headers({ 'Retry-After': '2' }),
      body: null,
    });

    const flushMicrotasks = async () => {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
    };

    driver.start();
    await flushMicrotasks();

    expect(driver.getState()).toBe('reconnecting');
    const errorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errorEvent?.retry).toBe(2000);
    expect(errorEvent?.message).toContain('Retry-After received: 2s');

    // Advance 2s for the scheduled reconnect
    jest.advanceTimersByTime(2000);
    await flushMicrotasks();

    // 2nd failure exceeds maxReconnectAttempts = 1 -> should fail and stop
    expect(driver.getState()).toBe('failed');
    const fatalEvent = dispatchedEvents.find(
      (e) =>
        e.type === 'error' &&
        e.message?.includes('Max reconnection attempts reached')
    );
    expect(fatalEvent).toBeDefined();
  });

  test('calling start() while reconnecting acts as immediate Retry Now and resets backoff', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      retryIntervalMs: 10000,
    };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('reconnecting');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Call start() immediately without waiting for 10s timer
    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test('stop() transitions to closed and records disconnectReason as user_stop', async () => {
    const config: SseConfig = { url: TEST_URL };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: createMockStream(['data: live\n\n']),
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.isConnected()).toBe(true);
    driver.stop();

    expect(driver.getState()).toBe('closed');
    expect(driver.isConnected()).toBe(false);
    expect(driver.getStats().disconnectReason).toBe('user_stop');
  });

  test('rejects permissive Content-Type as invalid (exact MIME parity with native)', async () => {
    const config: SseConfig = { url: TEST_URL };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'Content-Type': 'application/x-text/event-stream-custom',
      }),
      body: createMockStream(['data: invalid\n\n']),
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('failed');
    expect(driver.getStats().disconnectReason).toBe('server_error');
    const err = dispatchedEvents.find((e) => e.type === 'error');
    expect(err?.message).toContain('Invalid Content-Type');
  });

  test('fails immediately on non-200 HTTP response (such as HTTP 201 Created)', async () => {
    const config: SseConfig = { url: TEST_URL };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 201,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: createMockStream(['data: created\n\n']),
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('failed');
    expect(driver.getStats().disconnectReason).toBe('server_error');
  });

  test('reports -1 statusCode and Interceptor Error message when onBeforeRequest throws', async () => {
    const interceptor = jest
      .fn()
      .mockRejectedValue(new Error('Token refresh failed'));
    const config: SseConfig = { url: TEST_URL };
    driver.setup(config, interceptor);

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('failed');
    const err = dispatchedEvents.find((e) => e.type === 'error');
    expect(err?.message).toContain('Interceptor Error: Token refresh failed');
    expect(err?.statusCode).toBe(-1);
  });

  test('initializes lastProcessedId from config.headers case-insensitively', () => {
    const config: SseConfig = {
      url: TEST_URL,
      headers: {
        'last-event-id': 'initial-cursor-99',
      },
    };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: createMockStream([]),
    });

    driver.start();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Last-Event-ID': 'initial-cursor-99',
        }),
      })
    );
  });

  test('pauses on offline event, clears timers, and reconnects on online event', async () => {
    const listeners: Record<string, () => void> = {};
    const origAdd = (globalThis as any).window?.addEventListener;
    const origRemove = (globalThis as any).window?.removeEventListener;

    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.addEventListener = (
      event: string,
      cb: () => void
    ) => {
      listeners[event] = cb;
    };
    (globalThis as any).window.removeEventListener = (event: string) => {
      delete listeners[event];
    };

    const config: SseConfig = {
      url: TEST_URL,
      monitorNetwork: true,
    };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockImplementation(() =>
      Promise.resolve({
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createMockStream(['data: stream\n\n']),
      })
    );

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('open');

    // Simulate browser offline event
    listeners.offline?.();
    expect(driver.getState()).toBe('paused');
    expect(driver.isConnected()).toBe(false);
    expect(driver.getStats().disconnectReason).toBe('network_error');

    // Simulate browser online event
    listeners.online?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(['connecting', 'open']).toContain(driver.getState());

    (globalThis as any).window.addEventListener = origAdd;
    (globalThis as any).window.removeEventListener = origRemove;
  });

  test('fails immediately with -1 statusCode on invalid URL scheme (parity with native)', async () => {
    const config: SseConfig = { url: 'ftp://localhost:33333/events' };
    driver.setup(config);

    driver.start();
    await Promise.resolve();

    expect(driver.getState()).toBe('failed');
    const errorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errorEvent?.statusCode).toBe(-1);
    expect(errorEvent?.message).toContain(
      'Invalid URL: ftp://localhost:33333/events'
    );
  });

  test('clean disconnect on EOF schedules reconnect without emitting a close event', async () => {
    const config: SseConfig = { url: TEST_URL, retryIntervalMs: 1000 };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: createMockStream(['data: payload\n\n']),
    });

    driver.start();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // After EOF, client enters reconnecting state and does NOT emit a 'close' event
    expect(driver.getState()).toBe('reconnecting');
    const closeEvents = dispatchedEvents.filter((e) => e.type === 'close');
    expect(closeEvents.length).toBe(0);
  });

  test('stop() only emits state closed and does not emit duplicate close event', async () => {
    const config: SseConfig = { url: TEST_URL };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: createMockStream(['data: active\n\n']),
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    driver.stop();

    expect(driver.getState()).toBe('closed');
    const closeEvents = dispatchedEvents.filter((e) => e.type === 'close');
    expect(closeEvents.length).toBe(0);

    const stateClosedEvents = dispatchedEvents.filter(
      (e) => e.type === 'state' && e.state === 'closed'
    );
    expect(stateClosedEvents.length).toBe(1);
  });

  test('restart() is a safe no-op when driver is not yet configured (parity with native)', () => {
    expect(() => driver.restart()).not.toThrow();
    expect(driver.getState()).toBe('idle');
  });

  test('Last-Event-ID header is isolated: removes stale config header and attaches dynamic lastProcessedId', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      headers: {
        'last-event-id': 'stale-id-1',
        'accept-encoding': 'gzip',
        'Authorization': 'Bearer test-token',
      },
    };
    driver.setup(config);
    driver.setLastProcessedId('fresh-id-999');

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: createMockStream([]),
    });

    driver.start();
    await Promise.resolve();

    const fetchHeaders = (globalThis.fetch as jest.Mock).mock.calls[0][1]
      .headers;
    expect(fetchHeaders['Last-Event-ID']).toBe('fresh-id-999');
    expect(fetchHeaders['last-event-id']).toBeUndefined();
    expect(fetchHeaders['accept-encoding']).toBeUndefined();
    expect(fetchHeaders.Authorization).toBe('Bearer test-token');
  });

  test('extracts HTTP error response body text on 4xx fatal errors', async () => {
    const config: SseConfig = { url: TEST_URL };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 404,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      text: jest
        .fn()
        .mockResolvedValue('{"error":"Requested resource was not found"}'),
      body: null,
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('failed');
    const err = dispatchedEvents.find((e) => e.type === 'error');
    expect(err?.message).toBe(
      'Fatal Error (404): {"error":"Requested resource was not found"}'
    );
  });

  test('extracts HTTP error response body text on 5xx server errors', async () => {
    const config: SseConfig = { url: TEST_URL, retryIntervalMs: 1000 };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 502,
      headers: new Headers({ 'Content-Type': 'text/plain' }),
      text: jest.fn().mockResolvedValue('Bad Gateway: backend upstream down'),
      body: null,
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('reconnecting');
    const err = dispatchedEvents.find((e) => e.type === 'error');
    expect(err?.message).toBe(
      'Server Error (502): Bad Gateway: backend upstream down'
    );
  });

  test('measures exact UTF-8 byte count for multi-byte Unicode strings in getStats().totalBytesReceived', async () => {
    const config: SseConfig = { url: TEST_URL };
    driver.setup(config);

    // Multi-byte string: "Xin chào 🇻🇳"
    // "Xin chào ": 'Xin ' (4) + 'ch' (2) + 'à' (2) + 'o ' (2) = 10 bytes
    // Flag 🇻🇳: each regional indicator is 4 bytes -> 8 bytes.
    // Total = 18 UTF-8 bytes. In JS string.length, it would be 14 (UTF-16 code units).
    const unicodeData = 'Xin chào 🇻🇳';
    const utf8ExpectedBytes = new TextEncoder().encode(unicodeData).length;
    expect(utf8ExpectedBytes).toBeGreaterThan(unicodeData.length);

    const stream = createMockStream([`data: ${unicodeData}\n\n`]);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: stream,
    });

    driver.start();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    const stats = driver.getStats();
    expect(stats.totalBytesReceived).toBe(utf8ExpectedBytes);
  });
});
