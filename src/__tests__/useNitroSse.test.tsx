import React from 'react';
import { NitroModules } from 'react-native-nitro-modules';
import {
  useNitroSse,
  type UseNitroSseOptions,
  type UseNitroSseReturn,
} from '../useNitroSse';

jest.mock('react-native-nitro-modules', () => {
  return {
    NitroModules: {
      createHybridObject: jest.fn(),
    },
  };
});

describe('useNitroSse Hook Tests', () => {
  let mockNative: any;
  let nativeCallback: any;

  // React hook test mock harness
  let effects: Array<() => (() => void) | void> = [];
  let cleanups: Array<(() => void) | void> = [];
  let prevDepsMap: Map<number, React.DependencyList | undefined> = new Map();
  let stateMap: Map<number, any> = new Map();
  let stateIndex = 0;
  let refMap: Map<number, { current: any }> = new Map();
  let refIndex = 0;
  let effectIndex = 0;

  function useHookHarness(options: UseNitroSseOptions): UseNitroSseReturn {
    stateIndex = 0;
    refIndex = 0;
    effectIndex = 0;
    return useNitroSse(options);
  }

  beforeEach(() => {
    jest.clearAllMocks();

    effects = [];
    cleanups = [];
    prevDepsMap.clear();
    stateMap.clear();
    stateIndex = 0;
    refMap.clear();
    refIndex = 0;
    effectIndex = 0;

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
        effects.push(effect);
      }
    });

    jest.spyOn(React, 'useCallback').mockImplementation((fn) => fn);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function flushEffects() {
    const currentEffects = [...effects];
    effects = [];
    for (const effect of currentEffects) {
      if (cleanups.length > 0) {
        const oldCleanup = cleanups.shift();
        if (typeof oldCleanup === 'function') oldCleanup();
      }
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
  }

  function unmount() {
    for (const cleanup of cleanups) {
      if (typeof cleanup === 'function') cleanup();
    }
    cleanups = [];
  }

  it('should not instantiate native client during render phase and initialize after mount', () => {
    // 1. Initial render before effects run (render phase)
    const initialResult = useHookHarness({
      url: 'https://example.com/sse',
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
      url: 'https://example.com/sse',
    });
    expect(mountedResult.client).not.toBeNull();
    expect(mountedResult.state).toBe('open');
    expect(mountedResult.isConnected).toBe(true);
  });

  it('should initialize, setup, start, and support all manual helper methods', () => {
    const onMessage = jest.fn();
    const onError = jest.fn();

    const hookResult = useHookHarness({
      url: 'https://example.com/sse',
      onMessage,
      onError,
    });

    flushEffects();

    expect(mockNative.setup).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/sse' }),
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
      url: 'https://example.com/sse',
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
      url: 'https://example.com/sse',
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
      url: 'https://example.com/sse',
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
      url: 'https://example.com/sse',
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

  it('should not call setState on unmount cleanup to avoid flicker and unmounted updates', () => {
    useHookHarness({
      url: 'https://example.com/sse',
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
      url: 'https://example.com/sse',
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
      url: 'https://example.com/sse',
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
        url: 'https://example.com/sse',
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
      url: 'https://example.com/sse',
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
      url: 'https://example.com/sse',
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
      url: 'https://example.com/sse-1',
    });
    flushEffects();
    const mountedSuccess = useHookHarness({
      url: 'https://example.com/sse-1',
    });
    expect(mountedSuccess.client).not.toBeNull();
    expect(mountedSuccess.isConnected).toBe(true);

    // 2. Next creation throws on URL update
    (NitroModules.createHybridObject as jest.Mock).mockImplementation(() => {
      throw new Error('Native crash on second init');
    });

    useHookHarness({
      url: 'https://example.com/sse-2',
    });
    flushEffects();

    const mountedFail = useHookHarness({
      url: 'https://example.com/sse-2',
    });
    expect(mountedFail.client).toBeNull();
    expect(mountedFail.isConnected).toBe(false);
    expect(mountedFail.state).toBe('failed');
  });
});
