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

  function createRawStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    });
  }

  async function flushMicrotasks(rounds = 25): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
    }
  }

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
      body: createMockStream([]),
    });

    driver.start();
    await flushMicrotasks();

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
      body: createMockStream([]),
    });

    driver.start();
    await flushMicrotasks();

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

    globalThis.fetch = jest.fn().mockImplementation(async () => ({
      status: 401,
      headers: new Headers(),
      body: createMockStream([]),
    }));

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
    expect(
      dispatchedEvents.some(
        (e) => e.type === 'error' && e.message === 'Read timeout'
      )
    ).toBe(true);

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
      body: createMockStream([]),
    });

    driver.start();
    await flushMicrotasks();

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

    globalThis.fetch = jest.fn().mockImplementation(async () => ({
      status: 429,
      headers: new Headers({ 'Retry-After': '2' }),
      body: createMockStream([]),
    }));

    driver.start();
    await flushMicrotasks();

    expect(driver.getState()).toBe('reconnecting');
    const errorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errorEvent?.retry).toBeGreaterThanOrEqual(2500);
    expect(errorEvent?.retry).toBeLessThanOrEqual(3500);
    expect(errorEvent?.message).toMatch(/Retry-After received: [23]s/);

    // Advance for the scheduled reconnect (2s + up to 1.5s jitter)
    jest.advanceTimersByTime(4000);
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
    const config: SseConfig = { url: TEST_URL, maxAuthRetries: 0 };
    driver.setup(config, interceptor);

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('failed');
    const err = dispatchedEvents.find((e) => e.type === 'error');
    expect(err?.message).toContain('Interceptor Error: Token refresh failed');
    expect(err?.statusCode).toBe(-1);
  });

  test('retries when onBeforeRequest throws up to maxAuthRetries', async () => {
    const interceptor = jest
      .fn()
      .mockRejectedValue(new Error('Token refresh failed'));
    const config: SseConfig = {
      url: TEST_URL,
      maxAuthRetries: 1,
      retryIntervalMs: 1000,
      jitterFactor: 0,
    };
    driver.setup(config, interceptor);

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('reconnecting');
    expect(interceptor).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2000);
    await Promise.resolve();
    await Promise.resolve();

    expect(interceptor).toHaveBeenCalledTimes(2);
    expect(driver.getState()).toBe('failed');
    const fatal = dispatchedEvents.find((e) =>
      e.message?.includes('Auth retry limit reached')
    );
    expect(fatal).toBeDefined();
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
    await flushMicrotasks();

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
    await flushMicrotasks();

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

  test('server retry directive updates serverRetryDelayMs and reconnect strategy interval', async () => {
    const config: SseConfig = { url: TEST_URL, retryIntervalMs: 1000 };
    driver.setup(config);

    const stream = createMockStream(['retry: 8888\ndata: msg_with_retry\n\n']);

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
    expect(stats.serverRetryDelayMs).toBe(8888);
  });

  test('enforces 1000ms minimum reconnect floor even with smaller retryIntervalMs and server retry directive', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      retryIntervalMs: 100,
      jitterFactor: 0,
    };
    driver.setup(config);

    const stream = createMockStream(['retry: 50\ndata: hi\n\n']);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: stream,
    });

    driver.start();
    for (let i = 0; i < 15; i++) {
      await Promise.resolve();
    }

    const stats = driver.getStats();
    expect(stats.serverRetryDelayMs).toBe(50);
    expect(stats.lastReconnectDelayMs).toBeGreaterThanOrEqual(1000);
  });

  test('parses RFC 1123 HTTP-Date in Retry-After header on HTTP 429', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      maxReconnectAttempts: 1,
      maxRetryIntervalMs: 60000,
    };
    driver.setup(config);

    // Create RFC 1123 HTTP-Date 5 seconds in the future
    const futureDate = new Date(Date.now() + 5000).toUTCString();

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 429,
      headers: new Headers({ 'Retry-After': futureDate }),
      body: createMockStream([]),
    });

    driver.start();
    await flushMicrotasks();

    expect(driver.getState()).toBe('reconnecting');
    const errorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errorEvent?.statusCode).toBe(429);
    expect(errorEvent?.retry).toBeGreaterThanOrEqual(1000);
    expect(errorEvent?.retry).toBeLessThanOrEqual(7500);
  });

  test('bounds negative and extreme Retry-After header to maxRetryIntervalMs', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      maxRetryIntervalMs: 5000,
      maxReconnectAttempts: 1,
    };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 429,
      headers: new Headers({ 'Retry-After': '999999' }), // extreme delay
      body: createMockStream([]),
    });

    driver.start();
    await flushMicrotasks();

    const errorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errorEvent?.retry).toBeGreaterThanOrEqual(5500); // clamped to 5000 + 500..1500 jitter
    expect(errorEvent?.retry).toBeLessThanOrEqual(6500);
  });

  test('parser resource limit violation during live stream transitions to failed without reconnecting', async () => {
    const config: SseConfig = { url: TEST_URL, retryIntervalMs: 1000 };
    driver.setup(config);

    // Single line exceeding 16MB
    const hugeLine = 'data: ' + 'x'.repeat(16 * 1024 * 1024 + 10) + '\n\n';
    const stream = createMockStream([hugeLine]);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: stream,
    });

    driver.start();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    expect(driver.getState()).toBe('failed');
    expect(driver.getStats().disconnectReason).toBe('parser_error');
    expect(driver.getStats().parseErrors).toBeGreaterThanOrEqual(1);
    const err = dispatchedEvents.find((e) => e.type === 'error');
    expect(err?.message).toContain('SSE line exceeded maximum limit');
  });

  test('onBeforeRequest headers do not mutate base config headers', async () => {
    const originalHeaders = { 'X-Initial': 'base-header' };
    const config: SseConfig = {
      url: TEST_URL,
      headers: { ...originalHeaders },
    };
    const interceptor = jest
      .fn()
      .mockResolvedValue({ 'X-Token': 'dynamic-token-123' });
    driver.setup(config, interceptor);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: createMockStream([]),
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(config.headers).toEqual(originalHeaders);
    expect(config.headers?.['X-Token']).toBeUndefined();
  });

  test('id without data updates lastProcessedId and attaches to subsequent reconnect request', async () => {
    const config: SseConfig = { url: TEST_URL, retryIntervalMs: 1000 };
    driver.setup(config);

    const stream = createMockStream([
      'id: resume-cursor-42\n\n', // ID line without data
    ]);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: stream,
    });

    driver.start();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // After EOF, client enters reconnecting state and sends updated Last-Event-ID on reconnect
    expect(driver.getState()).toBe('reconnecting');

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: createMockStream([]),
    });

    jest.advanceTimersByTime(2000);
    await Promise.resolve();
    await Promise.resolve();

    const secondCallHeaders = (globalThis.fetch as jest.Mock).mock.calls[0][1]
      .headers;
    expect(secondCallHeaders['Last-Event-ID']).toBe('resume-cursor-42');
  });

  test('autoParseJSON handles non-object roots and malformed JSON safely', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      autoParseJSON: true,
    };
    driver.setup(config);

    const stream = createMockStream([
      'data: "just a string"\n\ndata: 12345\n\ndata: true\n\ndata: null\n\ndata: { unclosed json: \n\ndata: {"valid": true}\n\n',
    ]);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: stream,
    });

    driver.start();
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    const messages = dispatchedEvents.filter((e) => e.type === 'message');
    expect(messages.length).toBe(6);
    expect(messages[0]?.parsedData).toBeUndefined();
    expect(messages[1]?.parsedData).toBeUndefined();
    expect(messages[2]?.parsedData).toBeUndefined();
    expect(messages[3]?.parsedData).toBeUndefined();
    expect(messages[4]?.parsedData).toBeUndefined();
    expect(messages[5]?.parsedData).toEqual({ valid: true });
  });

  test('preserves custom Content-Type in POST requests', async () => {
    const config: SseConfig = {
      url: TEST_URL,
      method: 'post',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'query=search&limit=10',
    };
    driver.setup(config);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: createMockStream([]),
    });

    driver.start();
    await Promise.resolve();

    const fetchOptions = (globalThis.fetch as jest.Mock).mock.calls[0][1];
    expect(fetchOptions.method).toBe('POST');
    expect(fetchOptions.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    );
    expect(fetchOptions.body).toBe('query=search&limit=10');
  });

  test('handles HTTP 405, 410, and 422 fatal client errors identically to native', async () => {
    for (const code of [405, 410, 422]) {
      const testDriver = new FetchSseDriver();
      testDriver.setup({ url: TEST_URL });

      globalThis.fetch = jest.fn().mockResolvedValue({
        status: code,
        headers: new Headers(),
        body: createMockStream([]),
      });

      testDriver.start();
      await flushMicrotasks();

      expect(testDriver.getState()).toBe('failed');
      expect(testDriver.getStats().disconnectReason).toBe('server_error');
      testDriver.dispose();
    }
  });

  test('read error mid-stream emits error event without 200 statusCode and transitions to reconnecting', async () => {
    const config: SseConfig = { url: TEST_URL, retryIntervalMs: 1000 };
    driver.setup(config);

    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const faultyStream = new ReadableStream<Uint8Array>({
      start(c) {
        streamController = c;
      },
    });

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: faultyStream,
    });

    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('open');

    // Simulate socket reset / network failure mid-stream
    streamController!.error(new Error('Connection reset by peer'));
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('reconnecting');
    expect(driver.getStats().disconnectReason).toBe('network_error');
    const err = dispatchedEvents.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(err?.message).toBe('Connection reset by peer');
    expect(err?.statusCode).toBeUndefined();
  });

  test('Issue 2.2 repro: SseReconnectStrategy rejects non-finite Infinity and falls back to default', () => {
    driver.setup({
      url: TEST_URL,
      retryIntervalMs: Infinity,
      maxRetryIntervalMs: Infinity,
      jitterFactor: 0.5,
      maxReconnectAttempts: Infinity,
    });
    expect((driver as any)._reconnectStrategy.nextDelayMs(false)).toBeLessThan(
      5000
    );
  });

  test('Issue 2.1 repro: HTTP 204 does not call response.text()', async () => {
    const textMock = jest.fn().mockResolvedValue('');
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 204,
      headers: new Headers(),
      text: textMock,
      body: null,
    });

    driver.setup({ url: TEST_URL });
    driver.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.getState()).toBe('failed');
    expect(textMock).not.toHaveBeenCalled();
  });

  test('Issue 2.8 repro: connection timer handle reset to undefined on expiration', () => {
    driver.setup({ url: TEST_URL, connectionTimeoutMs: 100 });
    globalThis.fetch = jest
      .fn()
      .mockImplementation(() => new Promise(() => {})); // Never resolves

    driver.start();
    expect((driver as any)._connectionTimer).toBeDefined();

    jest.advanceTimersByTime(150);
    expect((driver as any)._connectionTimer).toBeUndefined();
  });

  test('Issue 1.8 repro: _failAndStop increments _connectionAttemptVersion exactly once', () => {
    driver.setup({ url: TEST_URL });
    const versionBefore = (driver as any)._connectionAttemptVersion;
    (driver as any)._failAndStop('Test error');
    const versionAfter = (driver as any)._connectionAttemptVersion;
    expect(versionAfter - versionBefore).toBe(1);
  });

  test('Issue 1.2 repro: _stopInternal does not invoke _flushBatch twice consecutively when closing', () => {
    driver.setup({ url: TEST_URL, batchingIntervalMs: 50 });
    (driver as any)._isRunning = true;
    (driver as any)._state = 'open';
    const flushSpy = jest.spyOn(driver as any, '_flushBatch');
    (driver as any)._stopInternal(true);
    // Line 814 flushed pre-close, line 817 (_updateState('closed')) flushed post-close.
    // Line 818 would cause a 3rd redundant call!
    expect(flushSpy).toHaveBeenCalledTimes(2);
  });

  test('Issue 1.3 repro: _pushEvent does not call _cancelBatchTimer twice consecutively per flush', () => {
    driver.setup({ url: TEST_URL, batchingIntervalMs: 100, maxBufferSize: 2 });
    const cancelSpy = jest.spyOn(driver as any, '_cancelBatchTimer');
    // Push event to fill buffer to maxBufferSize
    (driver as any)._pushEvent({ type: 'message', data: '1' });
    (driver as any)._pushEvent({ type: 'message', data: '2' });
    // Without fix: cancelSpy called 3 times (1 inside _flushBatch on overflow, 1 right before in _pushEvent, etc.)
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  test('Issue 2.7 repro: POST request without body does not check headers with Object.keys', async () => {
    const keysSpy = jest.spyOn(Object, 'keys');
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: new ReadableStream(),
    });

    driver.setup({ url: TEST_URL, method: 'post' });
    keysSpy.mockClear();
    driver.start();
    await Promise.resolve();

    const mergedHeadersChecked = keysSpy.mock.calls.some(
      ([obj]) =>
        obj &&
        typeof obj === 'object' &&
        (obj as any).Accept === 'text/event-stream'
    );
    expect(mergedHeadersChecked).toBe(false);
    keysSpy.mockRestore();
  });

  test('Issue 1.1 repro: onIdUpdate and onEvent do not double-count last-event-id bytes', async () => {
    driver.setup({ url: TEST_URL });
    const stream = createMockStream([
      'id: event-123\ndata: hello\n\n', // 9 bytes ('event-123') + 5 bytes ('hello') = 14
      'id: event-123\ndata: world\n\n', // retained id (0 bytes) + 5 bytes ('world') = 19
    ]);
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: stream,
    });

    driver.start();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    expect(driver.getStats().totalBytesReceived).toBe(19);
  });

  test('Issue 1.5 verification: reconnect count increments accurately on reconnection attempt', async () => {
    driver.setup({ url: TEST_URL });
    globalThis.fetch = jest.fn().mockImplementation(async () => ({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: new ReadableStream(),
    }));

    driver.start();
    await Promise.resolve();
    expect(driver.getStats().reconnectCount).toBe(0);

    // Restart simulates reconnecting
    driver.restart();
    expect(driver.getState()).toBe('connecting');
    await Promise.resolve();
    expect(driver.getStats().reconnectCount).toBe(1);
  });

  test('Issue 2.8 repro: readTimeoutTimer handle reset to undefined on expiration', () => {
    driver.setup({ url: TEST_URL, readTimeoutMs: 100 });
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: new ReadableStream(),
    });

    driver.start();
    (driver as any)._resetReadTimeout(
      (driver as any)._connectionAttemptVersion
    );
    expect((driver as any)._readTimeoutTimer).toBeDefined();

    jest.advanceTimersByTime(150);
    expect((driver as any)._readTimeoutTimer).toBeUndefined();
  });

  test('synchronous stop() in listener aborts parser and drops remaining events in chunk without dangling timers', async () => {
    const receivedMessages: string[] = [];
    driver = new FetchSseDriver((events) => {
      for (const ev of events) {
        if (ev.type === 'message' && ev.data) {
          receivedMessages.push(ev.data);
          if (ev.data === 'first') {
            driver.stop();
          }
        }
      }
    });
    driver.setup({ url: TEST_URL, batchingIntervalMs: 0 });

    const stream = createMockStream(['data: first\n\ndata: second\n\n']);

    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: stream,
    });

    driver.start();
    await jest.runAllTicks();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    expect(receivedMessages).toEqual(['first']);
    expect(driver.getState()).toBe('closed');
    expect((driver as any)._batchTimer).toBeUndefined();
  });

  test('restart() resets reconnectStrategy and consecutiveAuthErrors', () => {
    driver.setup({ url: TEST_URL, maxReconnectAttempts: 2, maxAuthRetries: 2 });
    (driver as any)._reconnectStrategy.recordAttempt();
    (driver as any)._reconnectStrategy.recordAttempt();
    expect((driver as any)._reconnectStrategy.hasReachedMaxAttempts()).toBe(
      true
    );

    (driver as any)._consecutiveAuthErrors = 5;

    globalThis.fetch = jest.fn().mockReturnValue(new Promise(() => {}));
    driver.restart();

    expect((driver as any)._consecutiveAuthErrors).toBe(0);
    expect((driver as any)._reconnectStrategy.hasReachedMaxAttempts()).toBe(
      false
    );
  });

  test('caps maxBufferSize at 10,000 events like native platforms', () => {
    driver.setup({
      url: TEST_URL,
      batchingIntervalMs: 1000,
      maxBufferSize: 15000,
    });

    for (let i = 0; i < 10_000; i++) {
      (driver as any)._pushEvent({ type: 'message', data: String(i) });
    }

    // Flushed at the hard cap (10,000) instead of buffering up to the configured 15,000.
    const stats = driver.getStats();
    expect(stats.bufferOverflowCount).toBe(1);
    expect(stats.eventsBuffered).toBe(0);
    expect(dispatchedEvents.length).toBe(10_000);
  });

  test.each([0, -5, NaN, Infinity])(
    'falls back to default maxBufferSize (1000) for invalid value %p',
    (invalid) => {
      driver.setup({
        url: TEST_URL,
        batchingIntervalMs: 1000,
        maxBufferSize: invalid,
      });

      for (let i = 0; i < 1000; i++) {
        (driver as any)._pushEvent({ type: 'message', data: String(i) });
      }

      expect(driver.getStats().bufferOverflowCount).toBe(1);
      expect(dispatchedEvents.length).toBe(1000);
    }
  );

  test('preserves UTF-8 JSON error body in data on HTTP 403 without interceptor', async () => {
    const jsonBody = JSON.stringify({
      code: 'input_rejected',
      message: '输入包含违规内容',
      risk: 100,
    });
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 403,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: createMockStream([jsonBody]),
    });

    driver.setup({ url: TEST_URL });
    driver.start();
    await flushMicrotasks();

    expect(driver.getState()).toBe('failed');
    expect(dispatchedEvents.map((e) => e.type)).toEqual([
      'state',
      'error',
      'state',
    ]);
    const errorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.statusCode).toBe(403);
    expect(errorEvent?.message).toBe(
      'Auth Error (403) - No interceptor provided. Stopping.'
    );
    expect(errorEvent?.data).toBe(jsonBody);
    expect(errorEvent?.parsedData).toBeUndefined();
    expect(errorEvent?.retry).toBeUndefined();
  });

  test('preserves error body in data on HTTP 403 auth retries and retry limit reached', async () => {
    const jsonBody = '{"code":"forbidden","message":"访问受限"}';
    const interceptor = jest
      .fn()
      .mockResolvedValue({ Authorization: 'Bearer refreshed' });

    globalThis.fetch = jest.fn().mockImplementation(async () => ({
      status: 403,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: createMockStream([jsonBody]),
    }));

    driver.setup(
      {
        url: TEST_URL,
        maxAuthRetries: 1,
        retryIntervalMs: 1000,
        jitterFactor: 0,
      },
      interceptor
    );

    driver.start();
    await flushMicrotasks();

    expect(driver.getState()).toBe('reconnecting');

    jest.advanceTimersByTime(2000);
    await flushMicrotasks();

    expect(driver.getState()).toBe('failed');
    const errorEvents = dispatchedEvents.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(2);
    expect(errorEvents[0]?.statusCode).toBe(403);
    expect(errorEvents[0]?.message).toBe(
      'Auth Error (403) - Retry 1/1. Refreshing token...'
    );
    expect(errorEvents[0]?.data).toBe(jsonBody);
    expect(errorEvents[0]?.parsedData).toBeUndefined();
    expect(errorEvents[1]?.statusCode).toBe(403);
    expect(errorEvents[1]?.message).toBe(
      'Auth Error (403) - Retry limit reached (1). Stopping.'
    );
    expect(errorEvents[1]?.data).toBe(jsonBody);
    expect(errorEvents[1]?.parsedData).toBeUndefined();
  });

  test('403 with onBeforeRequest recovers to 200 stream and resets consecutiveAuthErrors', async () => {
    const jsonBody = '{"code":"token_expired"}';
    let callCount = 0;
    const interceptor = jest.fn().mockImplementation(async () => ({
      Authorization: `Bearer token-${interceptor.mock.calls.length}`,
    }));

    globalThis.fetch = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 403,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          body: createMockStream([jsonBody]),
        };
      }
      if (callCount === 2) {
        return {
          status: 200,
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
          body: createMockStream(['data: recovered\n\n']),
        };
      }
      return {
        status: 403,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: createMockStream([jsonBody]),
      };
    });

    driver.setup(
      {
        url: TEST_URL,
        maxAuthRetries: 1,
        retryIntervalMs: 1000,
        jitterFactor: 0,
      },
      interceptor
    );

    driver.start();
    await flushMicrotasks();

    expect(driver.getState()).toBe('reconnecting');
    const firstErr = dispatchedEvents.find((e) => e.type === 'error');
    expect(firstErr?.data).toBe(jsonBody);
    expect(firstErr?.message).toBe(
      'Auth Error (403) - Retry 1/1. Refreshing token...'
    );

    // Backoff fires -> interceptor refreshes token -> 200 stream opens, then EOF schedules reconnect
    jest.advanceTimersByTime(1000);
    await flushMicrotasks(20);

    const fetchCalls = (globalThis.fetch as jest.Mock).mock.calls;
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    expect(fetchCalls[1]?.[1]?.headers?.Authorization).toBe('Bearer token-2');
    expect(dispatchedEvents.some((e) => e.type === 'open')).toBe(true);
    expect(dispatchedEvents.find((e) => e.type === 'message')?.data).toBe(
      'recovered'
    );

    // Clean EOF reconnect hits 403 again: consecutiveAuthErrors was reset so it starts at Retry 1/1 again
    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    const errorEvents = dispatchedEvents.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(2);
    expect(errorEvents[1]?.message).toBe(
      'Auth Error (403) - Retry 1/1. Refreshing token...'
    );
    expect(errorEvents[1]?.data).toBe(jsonBody);
  });

  test('preserves error body, message, retry, parsedData, and event order across 401, 403, 408, 429, 500, and 503', async () => {
    const cases: Array<{
      status: number;
      headers?: Record<string, string>;
      body: string;
      withInterceptor?: boolean;
      expectedMessage: string | RegExp;
      expectedEvents: string[];
      expectRetry?: boolean;
    }> = [
      {
        status: 401,
        body: '{"error":"unauthorized"}',
        withInterceptor: true,
        expectedMessage: 'Auth Error (401) - Retry 1/2. Refreshing token...',
        expectedEvents: ['state', 'error', 'state'],
      },
      {
        status: 403,
        body: '{"error":"forbidden"}',
        expectedMessage:
          'Auth Error (403) - No interceptor provided. Stopping.',
        expectedEvents: ['state', 'error', 'state'],
      },
      {
        status: 408,
        body: 'Request Timeout Body',
        expectedMessage: 'HTTP 408',
        expectedEvents: ['state', 'state', 'error', 'state'],
      },
      {
        status: 429,
        headers: { 'Retry-After': '2' },
        body: '{"error":"rate_limited_retry_after"}',
        expectedMessage: /^Retry-After received: [23]s$/,
        expectedEvents: ['state', 'error', 'state'],
        expectRetry: true,
      },
      {
        status: 429,
        body: '{"error":"rate_limited"}',
        expectedMessage: 'Rate Limited (429). Retrying with backoff...',
        expectedEvents: ['state', 'error', 'state'],
      },
      {
        status: 500,
        body: 'Internal Server Error',
        expectedMessage: 'Server Error (500): Internal Server Error',
        expectedEvents: ['state', 'error', 'state'],
      },
      {
        status: 503,
        headers: { 'Retry-After': '2' },
        body: 'Service Unavailable Retry',
        expectedMessage: /^Retry-After received: [23]s$/,
        expectedEvents: ['state', 'error', 'state'],
        expectRetry: true,
      },
      {
        status: 503,
        body: 'Service Unavailable',
        expectedMessage: 'HTTP 503',
        expectedEvents: ['state', 'error', 'state'],
      },
    ];

    for (const c of cases) {
      const localEvents: SseEvent[] = [];
      const localDriver = new FetchSseDriver((events) =>
        localEvents.push(...events)
      );
      localDriver.setup(
        {
          url: TEST_URL,
          maxReconnectAttempts: 1,
          maxAuthRetries: 2,
          retryIntervalMs: 1000,
          jitterFactor: 0,
        },
        c.withInterceptor
          ? jest.fn().mockResolvedValue({ Authorization: 'Bearer ok' })
          : undefined
      );
      globalThis.fetch = jest.fn().mockResolvedValue({
        status: c.status,
        headers: new Headers(c.headers),
        body: createMockStream([c.body]),
      });

      localDriver.start();
      await flushMicrotasks();

      expect(localEvents.map((e) => e.type)).toEqual(c.expectedEvents);
      const errorEvents = localEvents.filter((e) => e.type === 'error');
      expect(errorEvents.length).toBe(1);
      const errorEvent = errorEvents[0];
      expect(errorEvent?.statusCode).toBe(c.status);
      expect(errorEvent?.data).toBe(c.body);
      expect(errorEvent?.parsedData).toBeUndefined();
      if (typeof c.expectedMessage === 'string') {
        expect(errorEvent?.message).toBe(c.expectedMessage);
      } else {
        expect(errorEvent?.message).toMatch(c.expectedMessage);
      }
      if (c.expectRetry) {
        expect(errorEvent?.retry).toBeGreaterThanOrEqual(2500);
        expect(errorEvent?.retry).toBeLessThanOrEqual(3500);
        expect(localDriver.getStats().lastReconnectDelayMs).toBe(
          errorEvent?.retry
        );
      } else {
        expect(errorEvent?.retry).toBeUndefined();
      }
      localDriver.dispose();
    }
  });

  test('normalizes empty streaming body to undefined and enforces 8192/8193 UTF-8 byte cap in streaming and fallback', async () => {
    // 1. Empty streaming body -> undefined
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 403,
      headers: new Headers(),
      body: createMockStream([]),
    });

    driver.setup({ url: TEST_URL });
    driver.start();
    await flushMicrotasks();

    const emptyErrorEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(emptyErrorEvent?.statusCode).toBe(403);
    expect(emptyErrorEvent?.data).toBeUndefined();

    // 2. Exact 8192 bytes intact & 8193 bytes truncated to 8192 + reader cancelled
    for (const byteLen of [8192, 8193]) {
      const localEvents: SseEvent[] = [];
      const localDriver = new FetchSseDriver((events) =>
        localEvents.push(...events)
      );
      const cancelSpy = jest.fn().mockResolvedValue(undefined);
      const payload = new Uint8Array(byteLen).fill(0x58); // 'X'
      let pulled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!pulled) {
            pulled = true;
            controller.enqueue(payload);
          } else {
            return new Promise(() => {});
          }
          return undefined;
        },
        cancel: cancelSpy,
      });

      globalThis.fetch = jest.fn().mockResolvedValue({
        status: 403,
        headers: new Headers(),
        body: stream,
      });

      localDriver.setup({ url: TEST_URL });
      localDriver.start();
      await flushMicrotasks();

      const errEvent = localEvents.find((e) => e.type === 'error');
      const expectedBytes = Math.min(byteLen, 8192);
      expect(errEvent?.data).toBe('X'.repeat(expectedBytes));
      expect(new TextEncoder().encode(errEvent?.data).length).toBe(
        expectedBytes
      );
      expect(cancelSpy).toHaveBeenCalled();
      localDriver.dispose();
    }

    // 3. Fallback response.text() truncates by UTF-8 bytes (Chinese 3-byte chars)
    const fallbackEvents: SseEvent[] = [];
    const fallbackDriver = new FetchSseDriver((events) =>
      fallbackEvents.push(...events)
    );
    const largeChinese = '中'.repeat(4000); // 12,000 UTF-8 bytes
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 403,
      headers: new Headers(),
      body: null,
      text: jest.fn().mockResolvedValue(largeChinese),
    });

    fallbackDriver.setup({ url: TEST_URL });
    fallbackDriver.start();
    await flushMicrotasks();

    const fallbackErr = fallbackEvents.find((e) => e.type === 'error');
    expect(fallbackErr?.data).toBeDefined();
    // 8192 / 3 = 2730 full chars (8190 bytes) + 2 truncated bytes -> U+FFFD
    expect(fallbackErr?.data).toBe(`${'中'.repeat(2730)}\uFFFD`);
    fallbackDriver.dispose();
  });

  test('handles 3-byte Chinese and 4-byte emoji UTF-8 boundaries at 8192 bytes without lone surrogates', async () => {
    // 8189 ASCII + '中' (3 bytes) = exactly 8192 bytes (intact)
    // 8190 ASCII + '中' (3 bytes) = 8193 bytes -> truncated at 8192 -> 'A'.repeat(8190) + '\uFFFD'
    // 8190 ASCII + '😀' (4 bytes) = 8194 bytes -> truncated at 8192 -> 'A'.repeat(8190) + '\uFFFD' (no lone surrogate)
    const cases = [
      {
        label: 'exact-8192-chinese',
        input: `${'A'.repeat(8189)}中`,
        expected: `${'A'.repeat(8189)}中`,
      },
      {
        label: 'straddle-8192-chinese',
        input: `${'A'.repeat(8190)}中`,
        expected: `${'A'.repeat(8190)}\uFFFD`,
      },
      {
        label: 'straddle-8192-emoji',
        input: `${'A'.repeat(8190)}😀`,
        expected: `${'A'.repeat(8190)}\uFFFD`,
      },
    ];

    const hasLoneSurrogate = (s: string): boolean => {
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
          i++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          return true;
        }
      }
      return false;
    };

    for (const c of cases) {
      const localEvents: SseEvent[] = [];
      const localDriver = new FetchSseDriver((events) =>
        localEvents.push(...events)
      );
      globalThis.fetch = jest.fn().mockResolvedValue({
        status: 403,
        headers: new Headers(),
        body: createRawStream([new TextEncoder().encode(c.input)]),
      });

      localDriver.setup({ url: TEST_URL });
      localDriver.start();
      await flushMicrotasks();

      const errEvent = localEvents.find((e) => e.type === 'error');
      expect(errEvent?.data).toBe(c.expected);
      expect(hasLoneSurrogate(errEvent?.data ?? '')).toBe(false);
      localDriver.dispose();
    }
  });

  test('autoParseJSON: true preserves raw HTML, malformed JSON, and valid JSON error bodies without setting parsedData', async () => {
    const bodies = [
      '<html><body>403 Forbidden</body></html>',
      '{"broken": ',
      '{"code":"input_rejected","risk":100}',
    ];

    for (const body of bodies) {
      const localEvents: SseEvent[] = [];
      const localDriver = new FetchSseDriver((events) =>
        localEvents.push(...events)
      );
      localDriver.setup({ url: TEST_URL, autoParseJSON: true });
      globalThis.fetch = jest.fn().mockResolvedValue({
        status: 403,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: createMockStream([body]),
      });

      localDriver.start();
      await flushMicrotasks();

      const errEvent = localEvents.find((e) => e.type === 'error');
      expect(errEvent?.statusCode).toBe(403);
      expect(errEvent?.data).toBe(body);
      expect(errEvent?.parsedData).toBeUndefined();
      localDriver.dispose();
    }
  });

  test('stop() and dispose() mid-read of stalled 403 body emit no error event and clean up timers', async () => {
    for (const method of ['stop', 'dispose'] as const) {
      const localEvents: SseEvent[] = [];
      const localDriver = new FetchSseDriver((events) =>
        localEvents.push(...events)
      );
      const cancelSpy = jest.fn().mockResolvedValue(undefined);
      let readController!: ReadableStreamDefaultController<Uint8Array>;
      const stalledStream = new ReadableStream<Uint8Array>({
        start(controller) {
          readController = controller;
          controller.enqueue(new TextEncoder().encode('{"partial":'));
        },
        pull() {
          // Hang waiting for more bytes
          return new Promise(() => {});
        },
        cancel: cancelSpy,
      });

      globalThis.fetch = jest.fn().mockResolvedValue({
        status: 403,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: stalledStream,
      });

      localDriver.setup({ url: TEST_URL, connectionTimeoutMs: 5000 });
      localDriver.start();
      await flushMicrotasks();

      if (method === 'stop') {
        localDriver.stop();
      } else {
        localDriver.dispose();
      }
      try {
        readController.close();
      } catch {
        // Already cancelled
      }
      await flushMicrotasks();

      expect(localEvents.some((e) => e.type === 'error')).toBe(false);
      expect(cancelSpy).toHaveBeenCalled();
      expect((localDriver as any)._errorBodyTimer).toBeUndefined();
      expect((localDriver as any)._connectionTimer).toBeUndefined();
      localDriver.dispose();
    }
  });

  test('stalled 403 error body preserves partial data within single shared connectionTimeoutMs budget and supports 0 timeout', async () => {
    // 1. Shared budget: connectionTimeoutMs=1000, fetch takes 400ms -> body times out after remaining 600ms
    const cancelSpy = jest.fn().mockResolvedValue(undefined);
    const stalledStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":"chunk"'));
      },
      pull() {
        return new Promise(() => {});
      },
      cancel: cancelSpy,
    });

    globalThis.fetch = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              status: 403,
              headers: new Headers({ 'Content-Type': 'application/json' }),
              body: stalledStream,
            });
          }, 400);
        })
    );

    driver.setup({ url: TEST_URL, connectionTimeoutMs: 1000 });
    driver.start();

    // Advance 400ms so fetch resolves, leaving 600ms for error body read
    jest.advanceTimersByTime(400);
    await flushMicrotasks();
    expect(dispatchedEvents.some((e) => e.type === 'error')).toBe(false);

    // Advance remaining 600ms (total 1000ms, NOT 1400ms) -> body timer fires and preserves partial body
    jest.advanceTimersByTime(600);
    await flushMicrotasks();

    expect(driver.getState()).toBe('failed');
    const errEvent = dispatchedEvents.find((e) => e.type === 'error');
    expect(errEvent?.statusCode).toBe(403);
    expect(errEvent?.data).toBe('{"partial":"chunk"');
    expect(cancelSpy).toHaveBeenCalled();

    // 2. connectionTimeoutMs: 0 does not abort error body read immediately
    const zeroEvents: SseEvent[] = [];
    const zeroDriver = new FetchSseDriver((events) =>
      zeroEvents.push(...events)
    );
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 403,
      headers: new Headers(),
      body: createMockStream(['{"ok":"slow-error"}']),
    });
    zeroDriver.setup({ url: TEST_URL, connectionTimeoutMs: 0 });
    zeroDriver.start();
    await flushMicrotasks();

    const zeroErr = zeroEvents.find((e) => e.type === 'error');
    expect(zeroErr?.statusCode).toBe(403);
    expect(zeroErr?.data).toBe('{"ok":"slow-error"}');
    zeroDriver.dispose();
  });
});
