import React from 'react';
import { NitroModules } from 'react-native-nitro-modules';
import { useNitroSse } from '../useNitroSse';

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
  let stateMap: Map<number, any> = new Map();
  let stateIndex = 0;
  let refMap: Map<number, { current: any }> = new Map();
  let refIndex = 0;

  beforeEach(() => {
    jest.clearAllMocks();

    effects = [];
    cleanups = [];
    stateMap.clear();
    stateIndex = 0;
    refMap.clear();
    refIndex = 0;

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

    jest.spyOn(React, 'useEffect').mockImplementation((effect) => {
      effects.push(effect);
    });

    jest.spyOn(React, 'useCallback').mockImplementation((fn) => fn);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function flushEffects() {
    for (const effect of effects) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
    effects = [];
  }

  function unmount() {
    for (const cleanup of cleanups) {
      if (typeof cleanup === 'function') cleanup();
    }
    cleanups = [];
  }

  it('should provide client instance and initial state on first render', () => {
    const result = useNitroSse({
      url: 'https://example.com/sse',
    });

    expect(result.client).not.toBeNull();
    expect(result.state).toBe('open');
    expect(result.isConnected).toBe(true);
  });

  it('should initialize, setup, start, and support all manual helper methods', () => {
    const onMessage = jest.fn();
    const onError = jest.fn();

    const hookResult = useNitroSse({
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

    useNitroSse({
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

  it('should respect autoStart = false', () => {
    useNitroSse({
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

    useNitroSse({
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
    (NitroModules.createHybridObject as jest.Mock).mockImplementation(() => {
      throw new Error('Native module not found');
    });

    expect(() => {
      useNitroSse({ url: 'https://example.com/sse' });
    }).not.toThrow();
  });
});
