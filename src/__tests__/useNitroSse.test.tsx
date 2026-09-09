import React from 'react';
import { NitroModules } from 'react-native-nitro-modules';
import {
  useNitroSse,
  safeSerializeConfig,
  type UseNitroSseOptions,
  type UseNitroSseReturn,
} from '../useNitroSse';
import type { SseEvent } from '../SseInterface';

jest.mock('react-native-nitro-modules', () => {
  return {
    NitroModules: {
      createHybridObject: jest.fn(),
    },
  };
});

const TEST_URL = 'http://localhost:33333/events';

describe('useNitroSse Hook Tests', () => {
  let mockNative: any;
  let nativeCallback: any;

  // React hook test mock harness
  let effects: Array<{ idx: number; effect: () => (() => void) | void }> = [];
  let cleanupsMap: Map<number, (() => void) | void> = new Map();
  let prevDepsMap: Map<number, React.DependencyList | undefined> = new Map();
  let stateMap: Map<number, any> = new Map();
  let stateIndex = 0;
  let refMap: Map<number, { current: any }> = new Map();
  let refIndex = 0;
  let effectIndex = 0;
  let callbackMap: Map<
    number,
    { fn: any; deps: React.DependencyList | undefined }
  > = new Map();
  let callbackIndex = 0;

  function useHookHarness(options: UseNitroSseOptions): UseNitroSseReturn {
    stateIndex = 0;
    refIndex = 0;
    effectIndex = 0;
    callbackIndex = 0;
    return useNitroSse(options);
  }

  beforeEach(() => {
    jest.clearAllMocks();

    effects = [];
    cleanupsMap.clear();
    prevDepsMap.clear();
    stateMap.clear();
    stateIndex = 0;
    refMap.clear();
    refIndex = 0;
    effectIndex = 0;
    callbackMap.clear();
    callbackIndex = 0;

    mockNative = {
      setup: jest.fn().mockImplementation((_config, cb) => {
        nativeCallback = cb;
      }),
      start: jest.fn(),
      stop: jest.fn(),
      updateHeaders: jest.fn(),
      setLastProcessedId: jest.fn(),
      getStats: jest.fn().mockReturnValue({
        totalBytesReceived: 1024,
        reconnectCount: 2,
      }),
      isConnected: jest.fn().mockReturnValue(true),
      getState: jest.fn().mockReturnValue('open'),
      flush: jest.fn(),
      restart: jest.fn(),
      dispose: jest.fn(),
    };

    (NitroModules.createHybridObject as jest.Mock).mockReturnValue(mockNative);

    jest.spyOn(React, 'useRef').mockImplementation((initialValue) => {
      const idx = refIndex++;
      if (!refMap.has(idx)) {
        refMap.set(idx, { current: initialValue });
      }
      return refMap.get(idx)!;
    });

    (jest.spyOn(React, 'useState') as any).mockImplementation(
      (initialValue: any) => {
        const idx = stateIndex++;
        if (!stateMap.has(idx)) {
          stateMap.set(
            idx,
            typeof initialValue === 'function' ? initialValue() : initialValue
          );
        }
        const setState = (newValue: any) => {
          stateMap.set(
            idx,
            typeof newValue === 'function'
              ? newValue(stateMap.get(idx))
              : newValue
          );
        };
        return [stateMap.get(idx), setState];
      }
    );

    jest.spyOn(React, 'useEffect').mockImplementation((effect, deps) => {
      const idx = effectIndex++;
      const prevDeps = prevDepsMap.get(idx);
      const hasChanged =
        !prevDeps ||
        !deps ||
        deps.some((dep, i) => !Object.is(dep, prevDeps[i]));

      if (hasChanged) {
        prevDepsMap.set(idx, deps);
        effects.push({ idx, effect });
      }
    });

    jest.spyOn(React, 'useCallback').mockImplementation((fn, deps) => {
      const idx = callbackIndex++;
      const prev = callbackMap.get(idx);
      const hasChanged =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.some((dep, i) => !Object.is(dep, prev.deps![i]));

      if (hasChanged) {
        callbackMap.set(idx, { fn, deps });
        return fn;
      }
      return prev.fn;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function flushEffects() {
    const currentEffects = [...effects];
    effects = [];
    for (const { idx, effect } of currentEffects) {
      const oldCleanup = cleanupsMap.get(idx);
      if (typeof oldCleanup === 'function') {
        oldCleanup();
        cleanupsMap.delete(idx);
      }
      const cleanup = effect();
      if (cleanup) cleanupsMap.set(idx, cleanup);
    }
  }

  function unmount() {
    for (const cleanup of cleanupsMap.values()) {
      if (typeof cleanup === 'function') cleanup();
    }
    cleanupsMap.clear();
  }

  it('should not instantiate native client during render phase and initialize after mount', () => {
    // 1. Initial render before effects run (render phase)
    const initialResult = useHookHarness({
      url: TEST_URL,
    });

    // In render phase, client MUST NOT be instantiated to prevent native thread/memory leaks
    expect(initialResult.client).toBeNull();
    expect(initialResult.state).toBe('idle');
    expect(initialResult.isConnected).toBe(false);
    expect(NitroModules.createHybridObject).not.toHaveBeenCalled();

    // 2. Commit phase (effects flushed)
    flushEffects();

    expect(NitroModules.createHybridObject).toHaveBeenCalledTimes(1);
    expect(mockNative.setup).toHaveBeenCalledTimes(1);

    // 3. Component re-rendered after commit phase
    const mountedResult = useHookHarness({
      url: TEST_URL,
    });
    expect(mountedResult.client).not.toBeNull();
    expect(mountedResult.state).toBe('open');
    expect(mountedResult.isConnected).toBe(true);
  });

  it('should initialize, setup, start, and support all manual helper methods', () => {
    const onMessage = jest.fn();
    const onError = jest.fn();

    const hookResult = useHookHarness({
      url: TEST_URL,
      onMessage,
      onError,
    });

    flushEffects();

    expect(mockNative.setup).toHaveBeenCalledWith(
      expect.objectContaining({ url: TEST_URL }),
      expect.any(Function)
    );
    expect(mockNative.start).toHaveBeenCalled();

    // Trigger message event
    nativeCallback([
      {
        type: 'message',
        data: 'hello world',
      },
    ]);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ data: 'hello world' })
    );

    // Call helpers
    hookResult.stop();
    expect(mockNative.stop).toHaveBeenCalled();

    hookResult.restart();
    expect(mockNative.restart).toHaveBeenCalled();

    hookResult.flush();
    expect(mockNative.flush).toHaveBeenCalled();

    hookResult.updateHeaders({ Authorization: 'Bearer token123' });
    expect(mockNative.updateHeaders).toHaveBeenCalledWith({
      Authorization: 'Bearer token123',
    });

    hookResult.setLastProcessedId('evt-999');
    expect(mockNative.setLastProcessedId).toHaveBeenCalledWith('evt-999');

    const stats = hookResult.getStats();
    expect(stats).toEqual({
      totalBytesReceived: 1024,
      reconnectCount: 2,
    });

    hookResult.injectMockEvent({ type: 'message', data: 'mocked' });

    // Trigger cleanup (simulate unmount)
    unmount();
    expect(mockNative.dispose).toHaveBeenCalled();
  });

  it('should preserve and invoke onBeforeRequest callback properly', async () => {
    const onBeforeRequest = jest
      .fn()
      .mockResolvedValue({ Authorization: 'Bearer token' });

    useHookHarness({
      url: TEST_URL,
      onBeforeRequest,
    });

    flushEffects();

    const setupCall = mockNative.setup.mock.calls[0];
    const passedConfig = setupCall[0];

    expect(typeof passedConfig.onBeforeRequest).toBe('function');
    const headers = await passedConfig.onBeforeRequest();
    expect(onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('should reconfigure native setup when onBeforeRequest transitions from undefined to defined', async () => {
    // Mount without interceptor
    useHookHarness({
      url: TEST_URL,
    });
    flushEffects();

    expect(mockNative.setup).toHaveBeenCalledTimes(1);
    const initialConfig = mockNative.setup.mock.calls[0][0];
    expect(initialConfig.onBeforeRequest).toBeUndefined();

    // Re-render when auth token is available and interceptor is provided
    const onBeforeRequest = jest
      .fn()
      .mockResolvedValue({ Authorization: 'Bearer auth-token' });

    useHookHarness({
      url: TEST_URL,
      onBeforeRequest,
    });
    flushEffects();

    expect(mockNative.setup).toHaveBeenCalledTimes(2);
    const updatedConfig = mockNative.setup.mock.calls[1][0];
    expect(typeof updatedConfig.onBeforeRequest).toBe('function');
    const headers = await updatedConfig.onBeforeRequest();
    expect(headers).toEqual({ Authorization: 'Bearer auth-token' });
  });

  it('should differentiate custom events from default message events and prevent duplicate dispatch', () => {
    const onMessage = jest.fn();
    const onMessageCustom = jest.fn();
    const onCustomEvent = jest.fn();

    useHookHarness({
      url: TEST_URL,
      onMessage,
      events: {
        message: onMessageCustom,
        custom: onCustomEvent,
      },
    });

    flushEffects();

    // Default message event on iOS: event is "message" and type is "message"
    nativeCallback([
      { type: 'message', event: 'message', data: 'standard message' },
      { type: 'message', event: 'custom', data: 'custom message' },
    ]);

    // onMessage receives all message chunks
    expect(onMessage).toHaveBeenCalledTimes(2);
    // events.message MUST NOT be triggered for default event
    expect(onMessageCustom).not.toHaveBeenCalled();
    // events.custom MUST be triggered for custom event
    expect(onCustomEvent).toHaveBeenCalledTimes(1);
    expect(onCustomEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'custom', data: 'custom message' })
    );
  });

  it('should support strongly-typed parsedData for custom events via generic parameter', () => {
    interface WeatherEvents {
      lightning: { voltage: number; strikePoint: string };
      storm: { windSpeed: number };
    }

    let capturedLightning: SseEvent<WeatherEvents['lightning']> | undefined;
    let capturedStorm: SseEvent<WeatherEvents['storm']> | undefined;

    useNitroSse<WeatherEvents>({
      url: TEST_URL,
      events: {
        lightning: (e) => {
          capturedLightning = e;
        },
        storm: (e) => {
          capturedStorm = e;
        },
      },
    });

    flushEffects();

    nativeCallback([
      {
        type: 'message',
        event: 'lightning',
        data: '{"voltage":100000,"strikePoint":"tower"}',
        parsedData: { voltage: 100000, strikePoint: 'tower' },
      },
      {
        type: 'message',
        event: 'storm',
        data: '{"windSpeed":85}',
        parsedData: { windSpeed: 85 },
      },
    ]);

    expect(capturedLightning).toBeDefined();
    expect(capturedLightning?.parsedData?.voltage).toBe(100000);
    expect(capturedLightning?.parsedData?.strikePoint).toBe('tower');

    expect(capturedStorm).toBeDefined();
    expect(capturedStorm?.parsedData?.windSpeed).toBe(85);
  });

  it('should not call setState on unmount cleanup to avoid flicker and unmounted updates', () => {
    useHookHarness({
      url: TEST_URL,
    });
    flushEffects();

    const stateSetter = jest.fn();
    (jest.spyOn(React, 'useState') as any).mockImplementation(() => [
      'open',
      stateSetter,
    ]);

    unmount();
    expect(mockNative.dispose).toHaveBeenCalled();
    expect(stateSetter).not.toHaveBeenCalled();
  });

  it('should respect autoStart = false', () => {
    useHookHarness({
      url: TEST_URL,
      autoStart: false,
    });

    flushEffects();

    expect(mockNative.setup).toHaveBeenCalled();
    expect(mockNative.start).not.toHaveBeenCalled();
  });

  it('should handle all event types (open, close, error, heartbeat, state, custom)', () => {
    const onOpen = jest.fn();
    const onClose = jest.fn();
    const onError = jest.fn();
    const onHeartbeat = jest.fn();
    const onStateChange = jest.fn();
    const onCustom = jest.fn();

    useHookHarness({
      url: TEST_URL,
      onOpen,
      onClose,
      onError,
      onHeartbeat,
      onStateChange,
      events: {
        custom_evt: onCustom,
      },
    });

    flushEffects();

    nativeCallback([
      { type: 'open' },
      { type: 'heartbeat' },
      { type: 'error', message: 'connection dropped' },
      { type: 'message', event: 'custom_evt', data: '{"count":10}' },
      { type: 'state', state: 'reconnecting' },
      { type: 'close' },
    ]);

    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'open' })
    );
    expect(onHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'heartbeat' })
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'connection dropped' })
    );
    expect(onCustom).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'custom_evt' })
    );
    expect(onStateChange).toHaveBeenCalledWith('reconnecting');
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'close' })
    );
  });

  it('should handle native module creation failure gracefully without throwing', () => {
    const onError = jest.fn();
    const onStateChange = jest.fn();

    (NitroModules.createHybridObject as jest.Mock).mockImplementation(() => {
      throw new Error('Native module not found');
    });

    expect(() => {
      useHookHarness({
        url: TEST_URL,
        onError,
        onStateChange,
      });
      flushEffects();
    }).not.toThrow();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Native module not found'),
        statusCode: -1,
      })
    );
    expect(onStateChange).toHaveBeenCalledWith('failed');

    const mounted = useHookHarness({
      url: TEST_URL,
      onError,
      onStateChange,
    });
    expect(mounted.state).toBe('failed');
    expect(mounted.client).toBeNull();
  });

  it('should handle client.setup failure gracefully and transition to failed state', () => {
    const onError = jest.fn();
    const onStateChange = jest.fn();

    mockNative.setup.mockImplementation(() => {
      throw new Error('Invalid URL format');
    });

    expect(() => {
      useHookHarness({
        url: 'invalid-url',
        onError,
        onStateChange,
      });
      flushEffects();
    }).not.toThrow();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Invalid URL format'),
        statusCode: -1,
      })
    );
    expect(onStateChange).toHaveBeenCalledWith('failed');

    const mounted = useHookHarness({
      url: 'invalid-url',
      onError,
      onStateChange,
    });
    expect(mounted.state).toBe('failed');
    expect(mounted.client).toBeNull();
    expect(mounted.isConnected).toBe(false);
  });

  it('should safely return empty headers object when onBeforeRequest resolves to undefined or null', async () => {
    const onBeforeRequest = jest.fn().mockResolvedValue(undefined);

    useHookHarness({
      url: TEST_URL,
      onBeforeRequest,
    });

    flushEffects();

    const setupCall = mockNative.setup.mock.calls[0];
    const passedConfig = setupCall[0];
    expect(typeof passedConfig.onBeforeRequest).toBe('function');

    const headers = await passedConfig.onBeforeRequest();
    expect(headers).toEqual({});
  });

  it('should reset client and isConnected when client creation fails on config update', () => {
    // 1. Mount successfully
    useHookHarness({
      url: TEST_URL,
    });
    flushEffects();
    const mountedSuccess = useHookHarness({
      url: TEST_URL,
    });
    expect(mountedSuccess.client).not.toBeNull();
    expect(mountedSuccess.isConnected).toBe(true);

    // 2. Next creation throws on URL update
    (NitroModules.createHybridObject as jest.Mock).mockImplementation(() => {
      throw new Error('Native crash on second init');
    });

    useHookHarness({
      url: `${TEST_URL}-updated`,
    });
    flushEffects();

    const mountedFail = useHookHarness({
      url: `${TEST_URL}-updated`,
    });
    expect(mountedFail.client).toBeNull();
    expect(mountedFail.isConnected).toBe(false);
    expect(mountedFail.state).toBe('failed');
  });
  it('should not recreate the native client when re-rendered with equivalent options', () => {
    const options = {
      url: TEST_URL,
    };

    const firstResult = useHookHarness(options);
    expect(firstResult.client).toBeNull();

    flushEffects();

    expect(NitroModules.createHybridObject).toHaveBeenCalledTimes(1);
    expect(mockNative.setup).toHaveBeenCalledTimes(1);

    const secondResult = useHookHarness(options);

    expect(secondResult.client).not.toBeNull();
    expect((secondResult.client as any)?._native).toBe(mockNative);
    expect(NitroModules.createHybridObject).toHaveBeenCalledTimes(1);
    expect(mockNative.setup).toHaveBeenCalledTimes(1);
  });

  it('should preserve event ordering when native emits multiple events in one callback', () => {
    const receivedEvents: string[] = [];

    const onOpen = jest.fn(() => {
      receivedEvents.push('open');
    });

    const onHeartbeat = jest.fn(() => {
      receivedEvents.push('heartbeat');
    });

    const onError = jest.fn(() => {
      receivedEvents.push('error');
    });

    const onClose = jest.fn(() => {
      receivedEvents.push('close');
    });

    useHookHarness({
      url: TEST_URL,
      onOpen,
      onHeartbeat,
      onError,
      onClose,
    });

    flushEffects();

    nativeCallback([
      { type: 'open' },
      { type: 'heartbeat' },
      { type: 'error', message: 'temporary failure' },
      { type: 'close' },
    ]);

    expect(receivedEvents).toEqual(['open', 'heartbeat', 'error', 'close']);
  });

  it('should process events emitted across multiple native callbacks', () => {
    const onMessage = jest.fn();
    const onHeartbeat = jest.fn();

    useHookHarness({
      url: TEST_URL,
      onMessage,
      onHeartbeat,
    });

    flushEffects();

    nativeCallback([
      {
        type: 'message',
        data: 'first',
      },
    ]);

    nativeCallback([
      {
        type: 'message',
        data: 'second',
      },
      {
        type: 'heartbeat',
      },
    ]);

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: 'first',
      })
    );
    expect(onMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: 'second',
      })
    );
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('should dispatch each custom event to its matching handler', () => {
    const onFirst = jest.fn();
    const onSecond = jest.fn();

    useHookHarness({
      url: TEST_URL,
      events: {
        first: onFirst,
        second: onSecond,
      },
    });

    flushEffects();

    nativeCallback([
      {
        type: 'message',
        event: 'first',
        data: 'first payload',
      },
      {
        type: 'message',
        event: 'second',
        data: 'second payload',
      },
    ]);

    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'first',
        data: 'first payload',
      })
    );

    expect(onSecond).toHaveBeenCalledTimes(1);
    expect(onSecond).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'second',
        data: 'second payload',
      })
    );
  });

  it('should not dispatch a custom event to another custom event handler', () => {
    const onFirst = jest.fn();
    const onSecond = jest.fn();

    useHookHarness({
      url: TEST_URL,
      events: {
        first: onFirst,
        second: onSecond,
      },
    });

    flushEffects();

    nativeCallback([
      {
        type: 'message',
        event: 'first',
        data: 'only first',
      },
    ]);

    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onSecond).not.toHaveBeenCalled();
  });

  it('should continue processing the remaining events when one event is emitted alongside others', () => {
    const onOpen = jest.fn();
    const onMessage = jest.fn();
    const onClose = jest.fn();

    useHookHarness({
      url: TEST_URL,
      onOpen,
      onMessage,
      onClose,
    });

    flushEffects();

    nativeCallback([
      { type: 'open' },
      {
        type: 'message',
        data: 'payload',
      },
      { type: 'close' },
    ]);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('should not invoke optional callbacks that were not provided', () => {
    useHookHarness({
      url: TEST_URL,
    });

    flushEffects();

    expect(() => {
      nativeCallback([
        { type: 'open' },
        { type: 'heartbeat' },
        {
          type: 'message',
          data: 'hello',
        },
        {
          type: 'error',
          message: 'failure',
        },
        {
          type: 'state',
          state: 'reconnecting',
        },
        { type: 'close' },
      ]);
    }).not.toThrow();
  });

  it('should dispose the native client when unmounted after manual stop', () => {
    useHookHarness({
      url: TEST_URL,
    });

    flushEffects();

    expect(mockNative.start).toHaveBeenCalledTimes(1);

    const result = useHookHarness({
      url: TEST_URL,
    });

    mockNative.stop.mockClear();
    result.stop();

    expect(mockNative.stop).toHaveBeenCalledTimes(1);

    unmount();

    expect(mockNative.dispose).toHaveBeenCalledTimes(1);
  });

  it('should dispose the native client only once for a single mount', () => {
    useHookHarness({
      url: TEST_URL,
    });

    flushEffects();

    unmount();
    unmount();

    expect(mockNative.dispose).toHaveBeenCalledTimes(1);
  });

  it('should expose the same native client instance after initialization', () => {
    const beforeMount = useHookHarness({
      url: TEST_URL,
    });

    expect(beforeMount.client).toBeNull();

    flushEffects();

    const afterMount = useHookHarness({
      url: TEST_URL,
    });

    expect(afterMount.client).not.toBeNull();
    expect((afterMount.client as any)?._native).toBe(mockNative);
  });

  it('should invoke injectMockEvent through the hook without requiring native setup', () => {
    const onMessage = jest.fn();

    const result = useHookHarness({
      url: TEST_URL,
      onMessage,
    });

    flushEffects();

    expect(() => {
      result.injectMockEvent({
        type: 'message',
        data: 'injected event',
      });
    }).not.toThrow();

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        data: 'injected event',
      })
    );
  });

  it('should forward different header values exactly as provided', () => {
    useHookHarness({
      url: TEST_URL,
    });

    flushEffects();

    const headers = {
      'Authorization': 'Bearer abc',
      'X-Custom-Header': 'custom-value',
      'X-Request-ID': 'request-123',
    };

    const result = useHookHarness({
      url: TEST_URL,
    });

    result.updateHeaders(headers);

    expect(mockNative.updateHeaders).toHaveBeenCalledTimes(1);
    expect(mockNative.updateHeaders).toHaveBeenCalledWith(headers);
  });

  it('should forward different last processed ids exactly as provided', () => {
    useHookHarness({
      url: TEST_URL,
    });

    flushEffects();

    const result = useHookHarness({
      url: TEST_URL,
    });

    result.setLastProcessedId('12345');

    result.setLastProcessedId('67890');

    expect(mockNative.setLastProcessedId).toHaveBeenCalledTimes(2);
    expect(mockNative.setLastProcessedId).toHaveBeenNthCalledWith(1, '12345');
    expect(mockNative.setLastProcessedId).toHaveBeenNthCalledWith(2, '67890');
  });

  it('should return the native stats without modifying them', () => {
    const expectedStats = {
      totalBytesReceived: 999999,
      reconnectCount: 42,
    };

    mockNative.getStats.mockReturnValue(expectedStats);

    useHookHarness({
      url: TEST_URL,
    });

    flushEffects();

    const result = useHookHarness({
      url: TEST_URL,
    });

    expect(result.getStats()).toBe(expectedStats);
    expect(mockNative.getStats).toHaveBeenCalledTimes(1);
  });

  it('should reflect the native connection state through the hook return value after initialization', () => {
    mockNative.isConnected.mockReturnValue(false);
    mockNative.getState.mockReturnValue('closed');

    useHookHarness({
      url: TEST_URL,
    });

    flushEffects();

    const result = useHookHarness({
      url: TEST_URL,
    });

    expect(result.isConnected).toBe(false);
    expect(result.state).toBe('closed');
  });

  it('should report failed state when native client creation throws and remain usable after the failure', () => {
    const nativeError = new Error('creation failed');

    (NitroModules.createHybridObject as jest.Mock).mockImplementation(() => {
      throw nativeError;
    });

    const onError = jest.fn();
    const onStateChange = jest.fn();

    const options = {
      url: TEST_URL,
      onError,
      onStateChange,
    };

    useHookHarness(options);

    flushEffects();

    const result = useHookHarness(options);

    expect(result.client).toBeNull();
    expect(result.state).toBe('failed');
    expect(result.isConnected).toBe(false);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('failed');

    expect(() => {
      result.stop();
      result.restart();
      result.flush();
      result.updateHeaders({ Authorization: 'Bearer token' });
      result.setLastProcessedId('123');
      result.getStats();
    }).not.toThrow();
  });

  it('should synchronize callbacksRef without re-running client setup effect and invoke latest callback', () => {
    const onMessageV1 = jest.fn();
    const onMessageV2 = jest.fn();

    // 1. First render with initial callback
    useHookHarness({
      url: TEST_URL,
      onMessage: onMessageV1,
    });
    flushEffects();

    expect(NitroModules.createHybridObject).toHaveBeenCalledTimes(1);
    expect(mockNative.setup).toHaveBeenCalledTimes(1);

    // 2. Re-render with new callback reference (same URL and config)
    useHookHarness({
      url: TEST_URL,
      onMessage: onMessageV2,
    });
    flushEffects();

    // Setup must NOT be called again (client preserved)
    expect(NitroModules.createHybridObject).toHaveBeenCalledTimes(1);
    expect(mockNative.setup).toHaveBeenCalledTimes(1);

    // 3. Dispatch native event -> must invoke the updated handler via callbacksRef
    nativeCallback([
      {
        type: 'message',
        data: 'synced-via-ref',
      },
    ]);

    expect(onMessageV1).not.toHaveBeenCalled();
    expect(onMessageV2).toHaveBeenCalledTimes(1);
    expect(onMessageV2).toHaveBeenCalledWith(
      expect.objectContaining({ data: 'synced-via-ref' })
    );
  });

  it('should not mutate headersRef, restConfigRef, or hasValidUrlRef during render phase', () => {
    useHookHarness({
      url: TEST_URL,
      headers: { Authorization: 'Bearer v1' },
      batchingIntervalMs: 1000,
    });
    flushEffects();

    const headersRef = refMap.get(1);
    const restConfigRef = refMap.get(2);
    const hasValidUrlRef = refMap.get(3);

    expect(headersRef?.current).toEqual({ Authorization: 'Bearer v1' });
    expect(restConfigRef?.current.batchingIntervalMs).toBe(1000);
    expect(hasValidUrlRef?.current).toBe(true);

    // Re-render (render phase, before flushEffects)
    useHookHarness({
      url: '   ',
      headers: { Authorization: 'Bearer v2' },
      batchingIntervalMs: 2000,
    });

    // During render phase, refs must not be mutated yet
    expect(headersRef?.current).toEqual({ Authorization: 'Bearer v1' });
    expect(restConfigRef?.current.batchingIntervalMs).toBe(1000);
    expect(hasValidUrlRef?.current).toBe(true);

    // After commit phase
    flushEffects();
    expect(headersRef?.current).toEqual({ Authorization: 'Bearer v2' });
    expect(restConfigRef?.current.batchingIntervalMs).toBe(2000);
    expect(hasValidUrlRef?.current).toBe(false);
  });

  it('should ignore all native events arriving after unmount via internal disposed guard', () => {
    const onMessage = jest.fn();
    const onError = jest.fn();
    const onOpen = jest.fn();
    const onClose = jest.fn();
    const onHeartbeat = jest.fn();
    const onStateChange = jest.fn();

    useHookHarness({
      url: TEST_URL,
      onMessage,
      onError,
      onOpen,
      onClose,
      onHeartbeat,
      onStateChange,
    });
    flushEffects();

    onOpen.mockClear();
    onStateChange.mockClear();

    // Trigger cleanup (simulate unmount, disposed = true)
    unmount();

    // Simulate late events dispatched by native background threads
    expect(() => {
      nativeCallback([
        { type: 'open' },
        { type: 'message', data: 'stale message' },
        { type: 'heartbeat' },
        { type: 'state', state: 'open' },
        { type: 'error', message: 'stale error' },
        { type: 'close' },
      ]);
    }).not.toThrow();

    expect(onOpen).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onHeartbeat).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('should delegate onBeforeRequest through callbacksRef to invoke updated interceptor implementation', async () => {
    const interceptorV1 = jest
      .fn()
      .mockResolvedValue({ Authorization: 'Bearer token-1' });
    const interceptorV2 = jest
      .fn()
      .mockResolvedValue({ Authorization: 'Bearer token-2' });

    useHookHarness({
      url: TEST_URL,
      onBeforeRequest: interceptorV1,
    });
    flushEffects();

    expect(mockNative.setup).toHaveBeenCalledTimes(1);
    const registeredInterceptor =
      mockNative.setup.mock.calls[0][0].onBeforeRequest;
    expect(typeof registeredInterceptor).toBe('function');

    // Re-render with new interceptor function (hasBeforeRequest is true -> no re-setup)
    useHookHarness({
      url: TEST_URL,
      onBeforeRequest: interceptorV2,
    });
    flushEffects();

    expect(mockNative.setup).toHaveBeenCalledTimes(1);

    // Call registered native wrapper -> should resolve with interceptorV2's return value
    const headers = await registeredInterceptor();
    expect(interceptorV1).not.toHaveBeenCalled();
    expect(interceptorV2).toHaveBeenCalledTimes(1);
    expect(headers).toEqual({ Authorization: 'Bearer token-2' });
  });

  it('should maintain stable function references for all imperative methods across re-renders', () => {
    const firstRender = useHookHarness({
      url: TEST_URL,
      onMessage: () => {},
    });
    flushEffects();

    const secondRender = useHookHarness({
      url: TEST_URL,
      onMessage: () => {},
    });
    flushEffects();

    expect(secondRender.start).toBe(firstRender.start);
    expect(secondRender.stop).toBe(firstRender.stop);
    expect(secondRender.restart).toBe(firstRender.restart);
    expect(secondRender.flush).toBe(firstRender.flush);
    expect(secondRender.updateHeaders).toBe(firstRender.updateHeaders);
    expect(secondRender.setLastProcessedId).toBe(
      firstRender.setLastProcessedId
    );
    expect(secondRender.getStats).toBe(firstRender.getStats);
    expect(secondRender.injectMockEvent).toBe(firstRender.injectMockEvent);
  });

  it('should accurately derive isConnected across all SseState transitions', () => {
    useHookHarness({
      url: TEST_URL,
    });
    flushEffects();

    const mounted = useHookHarness({
      url: TEST_URL,
    });
    expect(mounted.isConnected).toBe(true);
    expect(mounted.state).toBe('open');

    const transitions: Array<{
      state: any;
      expectedConnected: boolean;
    }> = [
      { state: 'stale', expectedConnected: false },
      { state: 'reconnecting', expectedConnected: true },
      { state: 'paused', expectedConnected: false },
      { state: 'connecting', expectedConnected: true },
      { state: 'closed', expectedConnected: false },
      { state: 'idle', expectedConnected: false },
      { state: 'failed', expectedConnected: false },
      { state: 'open', expectedConnected: true },
    ];

    for (const { state, expectedConnected } of transitions) {
      nativeCallback([{ type: 'state', state }]);
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const current = useHookHarness({ url: TEST_URL });
      expect(current.state).toBe(state);
      expect(current.isConnected).toBe(expectedConnected);
    }
  });

  it('should dynamically dispatch custom events to updated handlers via callbacksRef', () => {
    const customV1 = jest.fn();
    const customV2 = jest.fn();

    useHookHarness({
      url: TEST_URL,
      events: {
        priceUpdate: customV1,
      },
    });
    flushEffects();

    useHookHarness({
      url: TEST_URL,
      events: {
        priceUpdate: customV2,
      },
    });
    flushEffects();

    expect(mockNative.setup).toHaveBeenCalledTimes(1);

    nativeCallback([
      { type: 'message', event: 'priceUpdate', data: 'BTC: 60000' },
    ]);

    expect(customV1).not.toHaveBeenCalled();
    expect(customV2).toHaveBeenCalledTimes(1);
    expect(customV2).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'priceUpdate', data: 'BTC: 60000' })
    );
  });

  describe('Declarative Hook Defensive Hardening', () => {
    it('should handle circular references and BigInt in options without crashing React render phase', () => {
      const circularObj: any = { url: TEST_URL };
      circularObj.self = circularObj;
      circularObj.bigIntVal = BigInt(9007199254740991);

      let result: any;
      expect(() => {
        result = useHookHarness(circularObj);
      }).not.toThrow();

      expect(result).toBeDefined();
      expect(result.client).toBeNull();
      expect(result.isReady).toBe(false);

      expect(() => flushEffects()).not.toThrow();
      expect(mockNative.setup).toHaveBeenCalledTimes(1);
    });

    it('should produce identical fingerprint for objects with reordered keys avoiding unnecessary reconnection', () => {
      const optsA = {
        url: TEST_URL,
        mock: {
          mode: 'replace' as const,
          loop: true,
          eventsPerSecond: 2,
          data: [],
        },
      };

      const optsB = {
        mock: {
          data: [],
          eventsPerSecond: 2,
          loop: true,
          mode: 'replace' as const,
        },
        url: TEST_URL,
      };

      useHookHarness(optsA);
      flushEffects();
      expect(NitroModules.createHybridObject).toHaveBeenCalledTimes(1);

      useHookHarness(optsB);
      flushEffects();
      // Equivalent keys in different order must NOT trigger re-setup or recreate client
      expect(NitroModules.createHybridObject).toHaveBeenCalledTimes(1);
    });

    it('should update headers dynamically without re-creating client or disconnecting active stream', () => {
      useHookHarness({
        url: TEST_URL,
        headers: { Authorization: 'Bearer token-v1' },
      });
      flushEffects();

      expect(mockNative.setup).toHaveBeenCalledTimes(1);
      expect(mockNative.dispose).not.toHaveBeenCalled();

      // Update headers only
      useHookHarness({
        url: TEST_URL,
        headers: { 'Authorization': 'Bearer token-v2', 'X-App-Version': '1.0' },
      });
      flushEffects();

      // Client should NOT be recreated or re-setup
      expect(mockNative.setup).toHaveBeenCalledTimes(1);
      expect(mockNative.dispose).not.toHaveBeenCalled();
      // Instead, updateHeaders should be invoked directly on the active client
      expect(mockNative.updateHeaders).toHaveBeenCalledWith({
        'Authorization': 'Bearer token-v2',
        'X-App-Version': '1.0',
      });
    });

    it('should expose isReady flag accurately reflecting client readiness', () => {
      const initial = useHookHarness({ url: TEST_URL });
      expect(initial.isReady).toBe(false);
      expect(initial.client).toBeNull();

      flushEffects();

      const mounted = useHookHarness({ url: TEST_URL });
      expect(mounted.isReady).toBe(true);
      expect(mounted.client).not.toBeNull();
    });

    it('should warn in DEV when calling start/stop/updateHeaders before client is initialized without throwing', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = useHookHarness({ url: TEST_URL, autoStart: false });

      expect(() => {
        result.start();
        result.stop();
        result.restart();
        result.flush();
        result.updateHeaders({ a: '1' });
        result.setLastProcessedId('100');
        result.injectMockEvent({ type: 'message' });
      }).not.toThrow();

      expect(warnSpy).toHaveBeenCalledWith(
        '[useNitroSse] start() was called before the client was initialized.'
      );
      warnSpy.mockRestore();
    });

    describe('Defensive & Creative Usage Edge Cases for useNitroSse', () => {
      it('should handle null, undefined, and non-object options without throwing in render phase', () => {
        const errorSpy = jest
          .spyOn(console, 'error')
          .mockImplementation(() => {});

        expect(() => {
          const res1 = useHookHarness(null as any);
          expect(res1.state).toBe('idle');
          expect(res1.isConnected).toBe(false);
          expect(res1.isReady).toBe(false);

          const res2 = useHookHarness(undefined as any);
          expect(res2.state).toBe('idle');

          const res3 = useHookHarness([] as any);
          expect(res3.state).toBe('idle');
        }).not.toThrow();

        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
      });

      it('should remain idle and not attempt connection when URL is empty or whitespace-only', () => {
        const warnSpy = jest
          .spyOn(console, 'warn')
          .mockImplementation(() => {});

        const emptyUrlResult = useHookHarness({
          url: '',
          autoStart: true,
        });
        flushEffects();

        expect(emptyUrlResult.state).toBe('idle');
        expect(emptyUrlResult.isConnected).toBe(false);
        expect(emptyUrlResult.client).toBeNull();
        expect(mockNative.setup).not.toHaveBeenCalled();

        // Calling start() with invalid URL warns and does not throw
        expect(() => emptyUrlResult.start()).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            'Cannot start SSE stream: url is empty or invalid'
          )
        );

        warnSpy.mockRestore();
      });

      it('should isolate unhandled exceptions in onMessage without preventing custom event handlers from firing', () => {
        const errorSpy = jest
          .spyOn(console, 'error')
          .mockImplementation(() => {});
        const onMessageError = new Error('Bug in user onMessage!');
        const onMessage = jest.fn(() => {
          throw onMessageError;
        });
        const onCustomEvent = jest.fn();

        useHookHarness({
          url: TEST_URL,
          onMessage,
          events: {
            score: onCustomEvent,
          },
        });
        flushEffects();

        // Native emits a custom score event
        nativeCallback([
          {
            type: 'message',
            event: 'score',
            data: JSON.stringify({ score: 10 }),
          },
        ]);

        // onMessage was called and threw, but error was caught and logged
        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith(
          '[useNitroSse] Unhandled error in onMessage callback:',
          onMessageError
        );

        // onCustomEvent MUST still be called despite onMessage throwing!
        expect(onCustomEvent).toHaveBeenCalledTimes(1);
        expect(onCustomEvent).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'score' })
        );

        errorSpy.mockRestore();
      });

      it('should isolate unhandled exceptions in custom event handlers', () => {
        const errorSpy = jest
          .spyOn(console, 'error')
          .mockImplementation(() => {});
        const customError = new Error('Custom handler exploded');
        const onCustom = jest.fn(() => {
          throw customError;
        });

        useHookHarness({
          url: TEST_URL,
          events: {
            crash: onCustom,
          },
        });
        flushEffects();

        expect(() => {
          nativeCallback([{ type: 'message', event: 'crash', data: 'data' }]);
        }).not.toThrow();

        expect(errorSpy).toHaveBeenCalledWith(
          "[useNitroSse] Unhandled error in events['crash'] callback:",
          customError
        );
        errorSpy.mockRestore();
      });

      it('should isolate unhandled exceptions in onOpen, onClose, onHeartbeat, and onStateChange', () => {
        const errorSpy = jest
          .spyOn(console, 'error')
          .mockImplementation(() => {});

        useHookHarness({
          url: TEST_URL,
          onOpen: () => {
            throw new Error('Explosion in onOpen');
          },
          onClose: () => {
            throw new Error('Explosion in onClose');
          },
          onHeartbeat: () => {
            throw new Error('Explosion in onHeartbeat');
          },
          onStateChange: () => {
            throw new Error('Explosion in onStateChange');
          },
        });
        flushEffects();

        expect(() => {
          nativeCallback([{ type: 'open' }]);
          nativeCallback([{ type: 'heartbeat', message: 'ping' }]);
          nativeCallback([{ type: 'state', state: 'stale' }]);
          nativeCallback([{ type: 'close' }]);
        }).not.toThrow();

        expect(errorSpy).toHaveBeenCalledTimes(4);
        errorSpy.mockRestore();
      });

      it('should sanitize dirty headers returned from onBeforeRequest interceptor', async () => {
        let interceptor: any;
        mockNative.setup.mockImplementation((cfg: any) => {
          interceptor = cfg.onBeforeRequest;
        });

        useHookHarness({
          url: TEST_URL,
          onBeforeRequest: async () => ({
            'Dirty\r\nKey': 'dirty\nval',
            'Safe-Key': 'safe-val',
            'Numeric': 123 as any,
          }),
        });
        flushEffects();

        expect(interceptor).toBeDefined();
        const headers = await interceptor();
        expect(headers).toEqual({
          'DirtyKey': 'dirtyval',
          'Safe-Key': 'safe-val',
          'Numeric': '123',
        });
      });

      it('should handle onBeforeRequest rejecting or returning non-object without crashing', async () => {
        const errorSpy = jest
          .spyOn(console, 'error')
          .mockImplementation(() => {});
        const warnSpy = jest
          .spyOn(console, 'warn')
          .mockImplementation(() => {});
        let interceptor: any;
        mockNative.setup.mockImplementation((cfg: any) => {
          interceptor = cfg.onBeforeRequest;
        });

        useHookHarness({
          url: TEST_URL,
          onBeforeRequest: async () => 'not-an-object' as any,
        });
        flushEffects();

        const headers = await interceptor();
        expect(headers).toEqual({});
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            'onBeforeRequest returned an invalid headers value'
          ),
          'not-an-object'
        );

        warnSpy.mockRestore();
        errorSpy.mockRestore();
      });

      it('should return undefined safely from getStats when unmounted or uninitialized', () => {
        const result = useHookHarness({ url: TEST_URL });
        // Before effects run
        expect(result.getStats()).toBeUndefined();

        flushEffects();
        // After mount
        expect(result.getStats()).toEqual({
          totalBytesReceived: 1024,
          reconnectCount: 2,
        });

        unmount();
        // After unmount
        expect(result.getStats()).toBeUndefined();
      });
    });
  });

  describe('safeSerializeConfig', () => {
    it('should sort object keys deterministically', () => {
      const obj1 = { z: 1, a: 2, m: { y: 10, x: 20 } };
      const obj2 = { a: 2, z: 1, m: { x: 20, y: 10 } };
      expect(safeSerializeConfig(obj1)).toBe(safeSerializeConfig(obj2));
      expect(safeSerializeConfig(obj1)).toBe(
        '{"a":2,"m":{"x":20,"y":10},"z":1}'
      );
    });

    it('should handle circular references gracefully by substituting [Circular]', () => {
      const circularObj: any = { url: TEST_URL, retryIntervalMs: 1000 };
      circularObj.self = circularObj;
      const serialized = safeSerializeConfig(circularObj);
      expect(serialized).toContain('"self":"[Circular]"');
      expect(serialized).toContain(`"url":"${TEST_URL}"`);
    });

    it('should serialize BigInt values as strings', () => {
      const configWithBigInt = { id: 9007199254740991n, name: 'stream' };
      const serialized = safeSerializeConfig(configWithBigInt);
      expect(serialized).toBe('{"id":"9007199254740991","name":"stream"}');
    });

    it('should handle primitive and array values correctly', () => {
      expect(safeSerializeConfig(null)).toBe('null');
      expect(safeSerializeConfig(undefined)).toBe('undefined');
      expect(safeSerializeConfig('simple-string')).toBe('simple-string');
      expect(safeSerializeConfig(123)).toBe('123');
      expect(safeSerializeConfig([3, 2, 1])).toBe('[3,2,1]');
    });
  });
});
