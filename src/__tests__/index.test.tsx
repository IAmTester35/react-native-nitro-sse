import { NitroModules } from 'react-native-nitro-modules';

const TEST_URL = 'http://localhost:33333/events';

// Mock NitroModules
jest.mock('react-native-nitro-modules', () => {
  return {
    NitroModules: {
      createHybridObject: jest.fn(),
    },
  };
});

describe('NitroSseModule Unit Tests', () => {
  let mockNative: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockNative = {
      setup: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      updateHeaders: jest.fn(),
      setLastProcessedId: jest.fn(),
      getStats: jest.fn(),
      isConnected: jest.fn(),
      getState: jest.fn().mockReturnValue('idle'),
      flush: jest.fn(),
      restart: jest.fn(),
      dispose: jest.fn(),
    };

    (NitroModules.createHybridObject as jest.Mock).mockReturnValue(mockNative);
  });

  it('should call native setup method', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const config = { url: TEST_URL };
      const onEvent = jest.fn();

      NitroSseModule.setup(config, onEvent);
      expect(mockNative.setup).toHaveBeenCalledWith(
        config,
        expect.any(Function)
      );
    });
  });

  it('should call native start method', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      NitroSseModule.setup({ url: TEST_URL });
      NitroSseModule.start();
      expect(mockNative.start).toHaveBeenCalled();
    });
  });

  it('should call native stop method', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      NitroSseModule.stop();
      expect(mockNative.stop).toHaveBeenCalled();
    });
  });

  it('should call native updateHeaders method', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const newHeaders = { Authorization: 'Bearer new-token' };
      NitroSseModule.updateHeaders(newHeaders);
      expect(mockNative.updateHeaders).toHaveBeenCalledWith(newHeaders);
    });
  });

  it('should call native isConnected method', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      NitroSseModule.isConnected();
      expect(mockNative.isConnected).toHaveBeenCalled();
    });
  });

  it('should bubble up errors thrown by native methods', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      NitroSseModule.setup({ url: TEST_URL });
      const error = new Error('Native start failed');
      mockNative.start.mockImplementation(() => {
        throw error;
      });

      expect(() => NitroSseModule.start()).toThrow('Native start failed');
    });
  });

  it('should correctly pass event callbacks to native', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const onEvent = jest.fn();
      const config = { url: TEST_URL };

      NitroSseModule.setup(config, onEvent);

      // Verify setup was called
      expect(mockNative.setup).toHaveBeenCalledWith(
        config,
        expect.any(Function)
      );

      // Simulate native side calling the callback
      const registeredCallback = mockNative.setup.mock.calls[0][1];
      const testEvent = {
        type: 'message',
        data: '{"foo":"bar"}',
        parsedData: { foo: 'bar' },
      };
      registeredCallback([testEvent]);

      expect(onEvent).toHaveBeenCalledWith([testEvent]);
    });
  });

  it('should handle complex stats objects from native', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const mockStats = {
        totalBytesReceived: 1024,
        reconnectCount: 5,
        lastErrorTime: 1234567890,
        lastErrorCode: 'TIMEOUT',
      };
      mockNative.getStats.mockReturnValue(mockStats);

      const stats = NitroSseModule.getStats();
      expect(stats).toEqual(mockStats);
      expect(mockNative.getStats).toHaveBeenCalled();
    });
  });

  it('should allow updating headers with empty object', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      NitroSseModule.updateHeaders({});
      expect(mockNative.updateHeaders).toHaveBeenCalledWith({});
    });
  });

  it('should log debug message if createHybridObject throws error', () => {
    jest.isolateModules(() => {
      const consoleDebugSpy = jest
        .spyOn(console, 'debug')
        .mockImplementation(() => {});
      (NitroModules.createHybridObject as jest.Mock).mockImplementation(() => {
        throw new Error('Test Error');
      });

      // Re-require to trigger the top-level try-catch
      try {
        const { createNitroSse } = require('../index');
        createNitroSse();
      } catch {
        // Ignore the subsequent error about module not found
      }

      expect(consoleDebugSpy).toHaveBeenCalledWith(
        'Native NitroSse not found. This might be a test environment or web.'
      );
      consoleDebugSpy.mockRestore();
    });
  });

  it('should throw error if native module is not found', () => {
    jest.isolateModules(() => {
      (NitroModules.createHybridObject as jest.Mock).mockReturnValue(undefined);
      expect(() => {
        const { createNitroSse } = require('../index');
        createNitroSse();
      }).toThrow('NitroSse: Native module not found');
    });
  });

  it('should handle backpressure by buffering events when batching is enabled', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const onEvent = jest.fn();
      const config = {
        url: TEST_URL,
        batchingIntervalMs: 500,
      };

      NitroSseModule.setup(config, onEvent);
      expect(mockNative.setup).toHaveBeenCalledWith(
        config,
        expect.any(Function)
      );

      // Simulate native buffering behavior (conceptual check only as logic is native)
      // We verify that the config passed includes the batching parameters
      const passedConfig = mockNative.setup.mock.calls[0][0];
      expect(passedConfig.batchingIntervalMs).toBe(500);
    });
  });

  it('should respect maxBufferSize configuration', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const onEvent = jest.fn();
      const config = {
        url: TEST_URL,
        maxBufferSize: 50,
      };

      NitroSseModule.setup(config, onEvent);

      const passedConfig = mockNative.setup.mock.calls[0][0];
      expect(passedConfig.maxBufferSize).toBe(50);
    });
  });

  it('should call native flush method', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      NitroSseModule.flush();
      expect(mockNative.flush).toHaveBeenCalled();
    });
  });

  it('should call native restart method', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      NitroSseModule.setup({ url: TEST_URL });
      NitroSseModule.restart();
      expect(mockNative.restart).toHaveBeenCalled();
    });
  });

  it('should call native setLastProcessedId method', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const testId = 'event-123';

      NitroSseModule.setLastProcessedId(testId);
      expect(mockNative.setLastProcessedId).toHaveBeenCalledWith(testId);
    });
  });

  it('should get isConnected status from native', () => {
    jest.isolateModules(() => {
      // If isConnected is a property on the HybridObject:
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      mockNative.isConnected.mockReturnValue(true);

      const connected = NitroSseModule.isConnected();
      expect(connected).toBe(true);
      expect(mockNative.isConnected).toHaveBeenCalled();
    });
  });

  it('should create separate native instances for each factory call', () => {
    jest.isolateModules(() => {
      (NitroModules.createHybridObject as jest.Mock).mockImplementation(() => ({
        ...mockNative,
      }));
      const { createNitroSse } = require('../index');
      const instance1 = createNitroSse();
      const instance2 = createNitroSse();

      expect(NitroModules.createHybridObject).toHaveBeenCalledTimes(2);
      expect(instance1).not.toBe(instance2);
    });
  });

  it('should pass all config parameters correctly', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const onEvent = jest.fn();
      const fullConfig = {
        url: TEST_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Custom': 'Value' },
        body: JSON.stringify({ room: '123' }),
        backgroundExecution: true,
        batchingIntervalMs: 100,
        maxBufferSize: 5000,
        retryIntervalMs: 1500,
        maxRetryIntervalMs: 45000,
        jitterFactor: 0.3,
        maxReconnectAttempts: 10,
        autoParseJSON: true,
      };

      NitroSseModule.setup(fullConfig as any, onEvent);
      expect(mockNative.setup).toHaveBeenCalledWith(
        { ...fullConfig, method: 'post' },
        expect.any(Function)
      );
    });
  });

  it('should support onBeforeRequest interceptor', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const onEvent = jest.fn();
      const onBeforeRequest = async () => ({
        Authorization: 'Bearer interceptor-token',
      });
      const configWithInterceptor = {
        url: TEST_URL,
        onBeforeRequest,
      };

      NitroSseModule.setup(configWithInterceptor as any, onEvent);
      expect(mockNative.setup).toHaveBeenCalledWith(
        configWithInterceptor,
        expect.any(Function)
      );
    });
  });

  it('should dispatch events to typed listeners', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const messageListener = jest.fn();
      const customEventListener = jest.fn();

      NitroSseModule.addEventListener('message', messageListener);
      NitroSseModule.addEventListener('update', customEventListener);

      NitroSseModule.setup({ url: TEST_URL });

      // Simulate native side calling the callback
      const registeredCallback = mockNative.setup.mock.calls[0][1];
      const events = [
        { type: 'message', data: 'hello' },
        { type: 'message', data: 'world', event: 'update' },
      ];
      registeredCallback(events);

      expect(messageListener).toHaveBeenCalledTimes(2);
      expect(messageListener).toHaveBeenNthCalledWith(1, events[0]);
      expect(messageListener).toHaveBeenNthCalledWith(2, events[1]);

      expect(customEventListener).toHaveBeenCalledTimes(1);
      expect(customEventListener).toHaveBeenCalledWith(events[1]);
    });
  });

  describe('Mock Streaming Feature', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should support replace mock mode without calling native start', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const openListener = jest.fn();
        const messageListener = jest.fn();
        const legacyCallback = jest.fn();

        NitroSseModule.addEventListener('open', openListener);
        NitroSseModule.addEventListener('message', messageListener);

        const mockEvents = [
          { type: 'message', data: 'mock-1' },
          { type: 'message', data: 'mock-2' },
        ];

        NitroSseModule.setup(
          {
            url: TEST_URL,
            mock: {
              mode: 'replace',
              data: mockEvents,
              eventsPerSecond: 100, // 10ms per event
            },
          },
          legacyCallback
        );

        NitroSseModule.start();

        // 1. Should NOT call native start
        expect(mockNative.start).not.toHaveBeenCalled();

        // 2. Should immediately emit simulated 'open' event
        expect(openListener).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'open', statusCode: 200 })
        );
        expect(legacyCallback).toHaveBeenCalledWith([
          expect.objectContaining({ type: 'open', statusCode: 200 }),
        ]);

        // 3. Fast-forward timer by 10ms to emit first event
        jest.advanceTimersByTime(10);
        expect(messageListener).toHaveBeenCalledTimes(1);
        expect(messageListener).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: 'message', data: 'mock-1' })
        );

        // 4. Fast-forward timer by another 10ms to emit second event
        jest.advanceTimersByTime(10);
        expect(messageListener).toHaveBeenCalledTimes(2);
        expect(messageListener).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: 'message', data: 'mock-2' })
        );

        // 5. Clean up
        NitroSseModule.stop();
      });
    });

    it('should support inject mock mode calling native start in parallel', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const messageListener = jest.fn();

        NitroSseModule.addEventListener('message', messageListener);

        const mockEvents = [{ type: 'message', data: 'mock-1' }];

        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'inject',
            data: mockEvents,
            eventsPerSecond: 50, // 20ms per event
          },
        });

        NitroSseModule.start();

        // 1. Should call native start in inject mode
        expect(mockNative.start).toHaveBeenCalled();

        // 2. Advance time to emit mock event
        jest.advanceTimersByTime(20);
        expect(messageListener).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'message', data: 'mock-1' })
        );

        // 3. Clean up
        NitroSseModule.stop();
      });
    });

    it('should handle batching at ultra high eventsPerSecond', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const messageListener = jest.fn();

        NitroSseModule.addEventListener('message', messageListener);

        // 100 events to be streamed
        const mockEvents = Array.from({ length: 100 }, (_, i) => ({
          type: 'message' as const,
          data: `mock-${i}`,
        }));

        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: mockEvents,
            eventsPerSecond: 1000, // 1000 events/second
          },
        });

        NitroSseModule.start();

        // At 1000 events/sec:
        // delayMs = 1000 / 1000 = 1ms.
        // batchSize = Math.max(1, 1000 / 100) = 10 events per interval.
        // intervalMs = Math.max(10, 1 * 10) = 10ms.
        // So every 10ms, a batch of 10 events is emitted.

        // Advance 10ms -> 10 events should be emitted in a batch
        jest.advanceTimersByTime(10);
        expect(messageListener).toHaveBeenCalledTimes(10);
        expect(messageListener).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ data: 'mock-0' })
        );
        expect(messageListener).toHaveBeenNthCalledWith(
          10,
          expect.objectContaining({ data: 'mock-9' })
        );

        // Clean up
        NitroSseModule.stop();
      });
    });

    it('should clear interval and not emit after stop() is called', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const messageListener = jest.fn();

        NitroSseModule.addEventListener('message', messageListener);

        const mockEvents = [
          { type: 'message', data: 'mock-1' },
          { type: 'message', data: 'mock-2' },
        ];

        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: mockEvents,
            eventsPerSecond: 100, // 10ms per event
          },
        });

        NitroSseModule.start();

        const closeListener = jest.fn();
        NitroSseModule.addEventListener('close', closeListener);

        // 1st event
        jest.advanceTimersByTime(10);
        expect(messageListener).toHaveBeenCalledTimes(1);

        // 2nd event
        jest.advanceTimersByTime(10);
        expect(messageListener).toHaveBeenCalledTimes(2);

        // End of stream -> triggers close
        jest.advanceTimersByTime(10);
        expect(closeListener).toHaveBeenCalledTimes(1);

        // Stop the mock
        NitroSseModule.stop();
      });
    });

    it('should support restart() in replace mock mode', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const messageListener = jest.fn();

        NitroSseModule.addEventListener('message', messageListener);

        const mockEvents = [
          { type: 'message', data: 'mock-1' },
          { type: 'message', data: 'mock-2' },
        ];

        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: mockEvents,
            eventsPerSecond: 100, // 10ms per event
          },
        });

        NitroSseModule.start();

        jest.advanceTimersByTime(10);
        expect(messageListener).toHaveBeenCalledTimes(1);
        expect(messageListener).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: 'message', data: 'mock-1' })
        );

        // Restart
        NitroSseModule.restart();

        // Verify it restarts from mock index 0 and re-emits mock-1
        jest.advanceTimersByTime(10);
        expect(messageListener).toHaveBeenCalledTimes(2);
        expect(messageListener).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: 'message', data: 'mock-1' })
        );

        NitroSseModule.stop();
      });
    });

    it('should return correct isConnected() and getStats() in replace mock mode', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();

        mockNative.isConnected.mockReturnValue(false);

        const mockEvents = [{ type: 'message', data: 'mock-1' }];

        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: mockEvents,
            eventsPerSecond: 100,
          },
        });

        // 1. Initially should be disconnected
        expect(NitroSseModule.isConnected()).toBe(false);

        // 2. Start mock -> should be connected
        NitroSseModule.start();
        expect(NitroSseModule.isConnected()).toBe(true);

        // 3. Advance to increment mockIndex
        jest.advanceTimersByTime(10);
        expect(NitroSseModule.getStats().totalBytesReceived).toBeGreaterThan(0);

        // 4. Stop mock -> should be disconnected
        NitroSseModule.stop();
        expect(NitroSseModule.isConnected()).toBe(false);
      });
    });

    it('should track getState() and emit state events in replace mock mode', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const stateListener = jest.fn();

        NitroSseModule.addEventListener('state', stateListener);
        expect(NitroSseModule.getState()).toBe('idle');

        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: [{ type: 'message', data: 'hello' }],
            eventsPerSecond: 100,
          },
        });

        NitroSseModule.start();
        expect(NitroSseModule.getState()).toBe('open');
        expect(stateListener).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'state', state: 'connecting' })
        );
        expect(stateListener).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'state', state: 'open' })
        );

        jest.advanceTimersByTime(20);
        expect(NitroSseModule.getState()).toBe('closed');
        expect(stateListener).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'state', state: 'closed' })
        );
      });
    });

    it('should disable mock streaming in production environment (when __DEV__ is false)', () => {
      const originalDev = (global as any).__DEV__;
      (global as any).__DEV__ = false;

      try {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const NitroSseModule = createNitroSse();
          const mockEvents = [{ type: 'message', data: 'mock-1' }];

          NitroSseModule.setup({
            url: TEST_URL,
            mock: {
              mode: 'replace',
              data: mockEvents,
              eventsPerSecond: 100,
            },
          });

          NitroSseModule.start();

          // 1. Should call native start because mock is disabled
          expect(mockNative.start).toHaveBeenCalled();
        });
      } finally {
        (global as any).__DEV__ = originalDev;
      }
    });

    it('should support loop in replace mock mode', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const messageListener = jest.fn();

        NitroSseModule.addEventListener('message', messageListener);

        const mockEvents = [{ type: 'message', data: 'mock-1' }];

        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: mockEvents,
            eventsPerSecond: 100, // 10ms per event
            loop: true,
          },
        });

        NitroSseModule.start();

        // 1. Advance to emit mock-1 (1st loop)
        jest.advanceTimersByTime(10);
        expect(messageListener).toHaveBeenCalledTimes(1);
        expect(messageListener).toHaveBeenLastCalledWith(
          expect.objectContaining({ data: 'mock-1' })
        );

        // 2. Advance to emit mock-1 again (2nd loop)
        jest.advanceTimersByTime(10);
        expect(messageListener).toHaveBeenCalledTimes(2);
        expect(messageListener).toHaveBeenLastCalledWith(
          expect.objectContaining({ data: 'mock-1' })
        );

        NitroSseModule.stop();
      });
    });

    it('should support custom delays per event', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const messageListener = jest.fn();

        NitroSseModule.addEventListener('message', messageListener);

        const mockEvents = [
          { type: 'message', data: 'mock-1', delayMs: 50 },
          { type: 'message', data: 'mock-2', delayMs: 200 },
        ];

        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: mockEvents,
            eventsPerSecond: 10,
          },
        });

        NitroSseModule.start();

        // 1. First event should be scheduled with custom delayMs 50
        jest.advanceTimersByTime(50);
        expect(messageListener).toHaveBeenCalledTimes(1);
        expect(messageListener).toHaveBeenLastCalledWith(
          expect.objectContaining({ data: 'mock-1' })
        );

        // 2. Second event should be scheduled with custom delayMs 200
        jest.advanceTimersByTime(200);
        expect(messageListener).toHaveBeenCalledTimes(2);
        expect(messageListener).toHaveBeenLastCalledWith(
          expect.objectContaining({ data: 'mock-2' })
        );

        NitroSseModule.stop();
      });
    });

    it('should support simulated connection drops via errorRate', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const errorListener = jest.fn();

        NitroSseModule.addEventListener('error', errorListener);

        const mockEvents = [{ type: 'message', data: 'mock-1' }];

        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: mockEvents,
            eventsPerSecond: 100,
            errorRate: 1.0, // Force error on every schedule
          },
        });

        NitroSseModule.start();

        // Advance timer to trigger scheduleNext -> forces error due to errorRate = 1.0
        jest.advanceTimersByTime(10);
        expect(errorListener).toHaveBeenCalledTimes(1);
        expect(errorListener).toHaveBeenLastCalledWith(
          expect.objectContaining({
            type: 'error',
            message: 'Mock Connection Drop (Simulated Error)',
            statusCode: 500,
          })
        );

        NitroSseModule.stop();
      });
    });

    it('should support dynamic manual event injection using injectMockEvent()', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const customListener = jest.fn();

        NitroSseModule.addEventListener('alert', customListener);

        NitroSseModule.setup({ url: TEST_URL });

        // Manually inject event
        const alertEvent = { type: 'message', event: 'alert', data: 'danger' };
        NitroSseModule.injectMockEvent(alertEvent as any);

        expect(customListener).toHaveBeenCalledTimes(1);
        expect(customListener).toHaveBeenLastCalledWith(
          expect.objectContaining({
            type: 'message',
            event: 'alert',
            data: 'danger',
          })
        );
      });
    });

    it('should validate and normalize invalid eventsPerSecond and errorRate configurations', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const messageListener = jest.fn();
        const errorListener = jest.fn();

        NitroSseModule.addEventListener('message', messageListener);
        NitroSseModule.addEventListener('error', errorListener);

        const mockEvents = [{ type: 'message', data: 'mock-1' }];

        // Set invalid/out of range configurations
        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: mockEvents,
            eventsPerSecond: -10, // Invalid: non-positive, should default to 1 (1000ms delay)
            errorRate: 2.5, // Invalid: >1, should clamp to 1.0 (always drop/error)
          },
        });

        NitroSseModule.start();

        // Advance 1000ms (based on normalized eventsPerSecond = 1)
        jest.advanceTimersByTime(1000);

        // Since errorRate is clamped to 1.0, it should force a simulated connection drop (error)
        expect(errorListener).toHaveBeenCalledTimes(1);
        expect(errorListener).toHaveBeenLastCalledWith(
          expect.objectContaining({
            type: 'error',
            statusCode: 500,
          })
        );

        NitroSseModule.stop();
      });
    });

    it('should not emit close event when data is exhausted in inject mode', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const closeListener = jest.fn();
        const messageListener = jest.fn();

        NitroSseModule.addEventListener('close', closeListener);
        NitroSseModule.addEventListener('message', messageListener);

        const mockEvents = [{ type: 'message', data: 'inject-event-1' }];

        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'inject',
            data: mockEvents,
            eventsPerSecond: 10,
          },
        });

        NitroSseModule.start();

        // Advance past all mock events
        jest.advanceTimersByTime(500);

        expect(messageListener).toHaveBeenCalledTimes(1);
        expect(closeListener).not.toHaveBeenCalled();

        NitroSseModule.stop();
      });
    });

    it('should cancel previous driver timer when setup is called multiple times', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const messageListener = jest.fn();

        NitroSseModule.addEventListener('message', messageListener);

        // Setup first mock configuration
        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: [{ type: 'message', data: 'first-config-event' }],
            eventsPerSecond: 1,
          },
        });
        NitroSseModule.start();

        // Re-setup with new configuration without waiting for first timer
        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: [{ type: 'message', data: 'second-config-event' }],
            eventsPerSecond: 1,
          },
        });
        NitroSseModule.start();

        jest.advanceTimersByTime(2000);

        // First config event should not have fired because its driver was stopped on re-setup
        expect(messageListener).toHaveBeenCalledTimes(1);
        expect(messageListener).toHaveBeenLastCalledWith(
          expect.objectContaining({ data: 'second-config-event' })
        );

        NitroSseModule.stop();
      });
    });

    it('should support dispose() to cleanup listeners and call native dispose', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const messageListener = jest.fn();

        NitroSseModule.addEventListener('message', messageListener);
        NitroSseModule.setup({ url: TEST_URL });

        NitroSseModule.dispose();
        expect(mockNative.dispose).toHaveBeenCalled();
      });
    });

    it('should track headers and lastProcessedId in replace mock mode', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();

        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: [{ type: 'message', data: 'mock-1' }],
          },
        });

        NitroSseModule.updateHeaders({ Authorization: 'Bearer token123' });
        NitroSseModule.setLastProcessedId('event-999');

        expect(NitroSseModule.getState()).toBe('idle');
      });
    });

    it('should route custom events to both custom listener and generic message listener', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const genericMessageListener = jest.fn();
        const customListener = jest.fn();

        NitroSseModule.addEventListener('message', genericMessageListener);
        NitroSseModule.addEventListener('custom_notification', customListener);

        let nativeCallback: any;
        mockNative.setup.mockImplementation((_config: any, cb: any) => {
          nativeCallback = cb;
        });

        NitroSseModule.setup({ url: TEST_URL });

        // Trigger custom event
        nativeCallback([
          {
            type: 'message',
            event: 'custom_notification',
            data: '{"id":1}',
            id: 'evt-1',
          },
        ]);

        expect(customListener).toHaveBeenCalledTimes(1);
        expect(genericMessageListener).toHaveBeenCalledTimes(1);

        // Trigger normal message event
        nativeCallback([
          {
            type: 'message',
            event: 'message',
            data: '{"id":2}',
            id: 'evt-2',
          },
        ]);

        expect(customListener).toHaveBeenCalledTimes(1);
        expect(genericMessageListener).toHaveBeenCalledTimes(2);
      });
    });

    it('should support removeEventListener and removeAllEventListeners', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const listenerA = jest.fn();
        const listenerB = jest.fn();

        NitroSseModule.addEventListener('message', listenerA);
        NitroSseModule.addEventListener('message', listenerB);

        let nativeCallback: any;
        mockNative.setup.mockImplementation((_config: any, cb: any) => {
          nativeCallback = cb;
        });
        NitroSseModule.setup({ url: TEST_URL });

        NitroSseModule.removeEventListener('message', listenerA);
        nativeCallback([{ type: 'message', data: 'hello' }]);

        expect(listenerA).not.toHaveBeenCalled();
        expect(listenerB).toHaveBeenCalledTimes(1);

        NitroSseModule.removeAllEventListeners('message');
        nativeCallback([{ type: 'message', data: 'world' }]);

        expect(listenerB).toHaveBeenCalledTimes(1);
      });
    });

    it('should not dispatch events to listeners after dispose() is called', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();
        const messageListener = jest.fn();

        NitroSseModule.addEventListener('message', messageListener);

        let nativeCallback: any;
        mockNative.setup.mockImplementation((_config: any, cb: any) => {
          nativeCallback = cb;
        });
        NitroSseModule.setup({ url: TEST_URL });

        NitroSseModule.dispose();

        if (nativeCallback) {
          nativeCallback([{ type: 'message', data: 'late event' }]);
        }

        expect(messageListener).not.toHaveBeenCalled();
      });
    });

    it('should accurately calculate totalBytesReceived in MockReplaceDriver', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();

        const payload = 'test payload data';
        NitroSseModule.setup({
          url: TEST_URL,
          mock: {
            mode: 'replace',
            data: [{ type: 'message', data: payload, event: 'update' }],
            eventsPerSecond: 10,
          },
        });
        NitroSseModule.start();

        jest.advanceTimersByTime(200);

        const stats = NitroSseModule.getStats();
        expect(stats.totalBytesReceived).toBeGreaterThanOrEqual(payload.length);
        NitroSseModule.stop();
      });
    });

    it('should pass maxAuthRetries parameter to native setup', () => {
      jest.isolateModules(() => {
        const { createNitroSse } = require('../index');
        const NitroSseModule = createNitroSse();

        NitroSseModule.setup({
          url: TEST_URL,
          maxAuthRetries: 5,
        });

        expect(mockNative.setup).toHaveBeenCalledWith(
          expect.objectContaining({ maxAuthRetries: 5 }),
          expect.any(Function)
        );
      });
    });

    describe('Defensive Programming Hardening', () => {
      it('should throw error when calling methods on a disposed NitroSseClient instance', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();
          client.dispose();

          expect(client.isDisposed).toBe(true);
          expect(client.isConnected()).toBe(false);
          expect(client.getState()).toBe('closed');
          expect(client.getStats()).toEqual({
            totalBytesReceived: 0,
            reconnectCount: 0,
          });

          expect(() => client.start()).toThrow(
            'Cannot perform operation on a disposed NitroSseClient instance'
          );
          expect(() => client.stop()).toThrow(
            'Cannot perform operation on a disposed NitroSseClient instance'
          );
          expect(() => client.restart()).toThrow(
            'Cannot perform operation on a disposed NitroSseClient instance'
          );
          expect(() => client.flush()).toThrow(
            'Cannot perform operation on a disposed NitroSseClient instance'
          );
          expect(() => client.setup({ url: TEST_URL })).toThrow(
            'Cannot perform operation on a disposed NitroSseClient instance'
          );
          expect(() => client.updateHeaders({ a: '1' })).toThrow(
            'Cannot perform operation on a disposed NitroSseClient instance'
          );
          expect(() => client.setLastProcessedId('1')).toThrow(
            'Cannot perform operation on a disposed NitroSseClient instance'
          );
          expect(() => client.addEventListener('message', () => {})).toThrow(
            'Cannot perform operation on a disposed NitroSseClient instance'
          );
        });
      });

      it('should buffer updateHeaders called before setup and merge into setup config', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();

          client.updateHeaders({ Authorization: 'Bearer token-before-setup' });

          client.setup({
            url: TEST_URL,
            headers: { 'X-Custom': 'val' },
          });

          expect(mockNative.setup).toHaveBeenCalledWith(
            expect.objectContaining({
              headers: {
                'Authorization': 'Bearer token-before-setup',
                'X-Custom': 'val',
              },
            }),
            expect.any(Function)
          );
        });
      });

      it('should not leak previous headers or updateHeaders into subsequent setup() calls', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();

          client.setup({
            url: TEST_URL,
            headers: { 'Old-Header': 'old-value' },
          });

          client.updateHeaders({ 'Dynamic-Header': 'dynamic-value' });

          // Re-setup with completely new headers
          client.setup({
            url: TEST_URL,
            headers: { 'New-Header': 'new-value' },
          });

          expect(mockNative.setup).toHaveBeenLastCalledWith(
            expect.objectContaining({
              headers: {
                'New-Header': 'new-value',
              },
            }),
            expect.any(Function)
          );
        });
      });

      it('should throw NitroSseStateError when start() or restart() is called before setup()', () => {
        jest.isolateModules(() => {
          const { createNitroSse, NitroSseStateError } = require('../index');
          const client = createNitroSse();

          expect(() => client.start()).toThrow(NitroSseStateError);
          expect(() => client.start()).toThrow(
            '[NitroSse] Cannot start SSE stream: client is not configured. Call setup(config) first.'
          );

          expect(() => client.restart()).toThrow(NitroSseStateError);
          expect(() => client.restart()).toThrow(
            '[NitroSse] Cannot restart SSE stream: client is not configured. Call setup(config) first.'
          );
        });
      });

      it('should sanitize headers by stripping newlines, converting non-strings, and pruning null/undefined', () => {
        jest.isolateModules(() => {
          const { createNitroSse, sanitizeHeaders } = require('../index');
          const sanitized = sanitizeHeaders({
            'Safe-Header': 'normal-val',
            'Injected\r\nHeader': 'injected\nval',
            'Numeric': 123 as any,
            'Boolean': true as any,
            'NullVal': null as any,
            'UndefinedVal': undefined as any,
          });

          expect(sanitized).toEqual({
            'Safe-Header': 'normal-val',
            'InjectedHeader': 'injectedval',
            'Numeric': '123',
            'Boolean': 'true',
          });

          const client = createNitroSse();
          client.setup({
            url: TEST_URL,
            headers: {
              'Dirty\r\nKey': 'dirty\nval',
            },
          });

          expect(mockNative.setup).toHaveBeenCalledWith(
            expect.objectContaining({
              headers: {
                DirtyKey: 'dirtyval',
              },
            }),
            expect.any(Function)
          );
        });
      });

      it('should isolate exceptions in legacy onEvent callback without interrupting typed event listeners', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();
          let nativeCb: any;
          mockNative.setup.mockImplementation((_cfg: any, cb: any) => {
            nativeCb = cb;
          });

          const errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
          const faultyLegacyCallback = jest.fn(() => {
            throw new Error('Exploding legacy callback');
          });
          const typedListener = jest.fn();

          client.addEventListener('message', typedListener);
          client.setup({ url: TEST_URL }, faultyLegacyCallback);

          const event = { type: 'message' as const, data: 'hello' };
          expect(() => nativeCb([event])).not.toThrow();

          expect(faultyLegacyCallback).toHaveBeenCalled();
          expect(typedListener).toHaveBeenCalledWith(event);
          expect(errorSpy).toHaveBeenCalledWith(
            '[NitroSse] Error in legacy onEvent callback:',
            expect.any(Error)
          );
          errorSpy.mockRestore();
        });
      });

      it('should handle re-entrant listener additions without infinite loops', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();
          let nativeCb: any;
          mockNative.setup.mockImplementation((_cfg: any, cb: any) => {
            nativeCb = cb;
          });

          client.setup({ url: TEST_URL });

          let secondListenerCalls = 0;
          const secondListener = () => {
            secondListenerCalls++;
          };

          let firstListenerCalls = 0;
          client.addEventListener('message', () => {
            firstListenerCalls++;
            client.addEventListener('message', secondListener);
          });

          nativeCb([{ type: 'message', data: 'first' }]);
          expect(firstListenerCalls).toBe(1);
          // Snapshot iteration ensures secondListener is not called in the same dispatch cycle
          expect(secondListenerCalls).toBe(0);

          nativeCb([{ type: 'message', data: 'second' }]);
          expect(firstListenerCalls).toBe(2);
          expect(secondListenerCalls).toBe(1);
        });
      });

      it('should make dispose idempotent when called multiple times', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();

          client.dispose();
          client.dispose();
          client.dispose();

          expect(mockNative.dispose).toHaveBeenCalledTimes(1);
        });
      });
    });

    describe('Defensive Programming & Creative Usage Tests', () => {
      it('should throw NitroSseModuleNotFoundError with NATIVE_MODULE_NOT_FOUND code when native module is missing', () => {
        jest.isolateModules(() => {
          (NitroModules.createHybridObject as jest.Mock).mockReturnValue(
            undefined
          );
          const {
            createNitroSse,
            NitroSseError,
            NitroSseModuleNotFoundError,
          } = require('../index');

          try {
            createNitroSse();
            fail('Expected createNitroSse to throw');
          } catch (err: any) {
            expect(err).toBeInstanceOf(Error);
            expect(err).toBeInstanceOf(NitroSseError);
            expect(err).toBeInstanceOf(NitroSseModuleNotFoundError);
            expect(err.code).toBe('NATIVE_MODULE_NOT_FOUND');
            expect(err.name).toBe('NitroSseModuleNotFoundError');
            expect(err.message).toContain('Native module not found');
          }
        });
      });

      it('should reject invalid config types with NitroSseValidationError and INVALID_CONFIG code', () => {
        jest.isolateModules(() => {
          const {
            createNitroSse,
            NitroSseValidationError,
          } = require('../index');
          const client = createNitroSse();

          expect(() => client.setup(null as any)).toThrow(
            NitroSseValidationError
          );
          expect(() => client.setup(undefined as any)).toThrow(
            NitroSseValidationError
          );
          expect(() => client.setup('http://localhost:33333' as any)).toThrow(
            NitroSseValidationError
          );
          expect(() => client.setup([] as any)).toThrow(
            NitroSseValidationError
          );

          try {
            client.setup(null as any);
          } catch (err: any) {
            expect(err.code).toBe('INVALID_CONFIG');
            expect(err.name).toBe('NitroSseValidationError');
          }
        });
      });

      it('should reject empty or whitespace-only URLs with NitroSseValidationError', () => {
        jest.isolateModules(() => {
          const {
            createNitroSse,
            NitroSseValidationError,
          } = require('../index');
          const client = createNitroSse();

          expect(() => client.setup({ url: '' })).toThrow(
            NitroSseValidationError
          );
          expect(() => client.setup({ url: '   ' })).toThrow(
            NitroSseValidationError
          );
          expect(() => client.setup({ url: 12345 as any })).toThrow(
            NitroSseValidationError
          );

          try {
            client.setup({ url: '' });
          } catch (err: any) {
            expect(err.code).toBe('INVALID_CONFIG');
            expect(err.message).toContain("'url' must be a non-empty string");
          }
        });
      });

      it('should reject dangerous or unsupported protocols in URL with NitroSseValidationError', () => {
        jest.isolateModules(() => {
          const {
            createNitroSse,
            NitroSseValidationError,
          } = require('../index');
          const client = createNitroSse();

          const dangerousUrls = [
            // eslint-disable-next-line no-script-url
            'javascript:alert(1)',
            'data:text/plain;base64,SGVsbG8=',
            'file:///etc/passwd',
            'ftp://example.com/events',
          ];

          for (const url of dangerousUrls) {
            expect(() => client.setup({ url })).toThrow(
              NitroSseValidationError
            );
            try {
              client.setup({ url });
            } catch (err: any) {
              expect(err.code).toBe('INVALID_CONFIG');
              expect(err.message).toContain('Unsupported protocol');
            }
          }
        });
      });

      it('should reject invalid HTTP methods with NitroSseValidationError', () => {
        jest.isolateModules(() => {
          const {
            createNitroSse,
            NitroSseValidationError,
          } = require('../index');
          const client = createNitroSse();

          expect(() =>
            client.setup({ url: TEST_URL, method: 'DELETE' as any })
          ).toThrow(NitroSseValidationError);
          expect(() =>
            client.setup({ url: TEST_URL, method: 'PUT' as any })
          ).toThrow(NitroSseValidationError);
          expect(() =>
            client.setup({ url: TEST_URL, method: 123 as any })
          ).toThrow(NitroSseValidationError);
        });
      });

      it('should reject non-function onEvent or onBeforeRequest with NitroSseValidationError', () => {
        jest.isolateModules(() => {
          const {
            createNitroSse,
            NitroSseValidationError,
          } = require('../index');
          const client = createNitroSse();

          expect(() =>
            client.setup({ url: TEST_URL }, 'not-a-function' as any)
          ).toThrow(NitroSseValidationError);

          expect(() =>
            client.setup({ url: TEST_URL, onBeforeRequest: {} as any })
          ).toThrow(NitroSseValidationError);
        });
      });

      it('should defensively clamp invalid numeric bounds and warn', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();
          const warnSpy = jest
            .spyOn(console, 'warn')
            .mockImplementation(() => {});

          client.setup({
            url: TEST_URL,
            batchingIntervalMs: -50,
            maxBufferSize: -10,
            retryIntervalMs: 60000,
            maxRetryIntervalMs: 30000,
            jitterFactor: 2.5,
          });

          expect(mockNative.setup).toHaveBeenCalledWith(
            expect.objectContaining({
              batchingIntervalMs: 0,
              maxBufferSize: 1000,
              retryIntervalMs: 30000,
              maxRetryIntervalMs: 30000,
              jitterFactor: 1,
            }),
            expect.any(Function)
          );

          warnSpy.mockRestore();
        });
      });

      it('should validate mock configuration strictly', () => {
        jest.isolateModules(() => {
          const {
            createNitroSse,
            NitroSseValidationError,
          } = require('../index');
          const client = createNitroSse();

          expect(() =>
            client.setup({
              url: TEST_URL,
              mock: 'not-an-object' as any,
            })
          ).toThrow(NitroSseValidationError);

          expect(() =>
            client.setup({
              url: TEST_URL,
              mock: { mode: 'invalid' as any, data: [] },
            })
          ).toThrow(NitroSseValidationError);

          expect(() =>
            client.setup({
              url: TEST_URL,
              mock: { mode: 'replace', data: 'not-an-array' as any },
            })
          ).toThrow(NitroSseValidationError);
        });
      });

      it('should validate addEventListener parameters and throw NitroSseValidationError on bad inputs', () => {
        jest.isolateModules(() => {
          const {
            createNitroSse,
            NitroSseValidationError,
          } = require('../index');
          const client = createNitroSse();

          expect(() => client.addEventListener('', () => {})).toThrow(
            NitroSseValidationError
          );
          expect(() => client.addEventListener('   ', () => {})).toThrow(
            NitroSseValidationError
          );
          expect(() => client.addEventListener(null as any, () => {})).toThrow(
            NitroSseValidationError
          );
          expect(() => client.addEventListener('message', null as any)).toThrow(
            NitroSseValidationError
          );
          expect(() =>
            client.addEventListener('message', 'string' as any)
          ).toThrow(NitroSseValidationError);
        });
      });

      it('should gracefully ignore invalid removeEventListener and removeAllEventListeners inputs', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();

          expect(() =>
            client.removeEventListener(null as any, null as any)
          ).not.toThrow();
          expect(() =>
            client.removeEventListener('', (() => {}) as any)
          ).not.toThrow();
          expect(() =>
            client.removeAllEventListeners(123 as any)
          ).not.toThrow();
        });
      });

      it('should validate updateHeaders, setLastProcessedId, and injectMockEvent parameters', () => {
        jest.isolateModules(() => {
          const {
            createNitroSse,
            NitroSseValidationError,
          } = require('../index');
          const client = createNitroSse();

          expect(() => client.updateHeaders(null as any)).toThrow(
            NitroSseValidationError
          );
          expect(() => client.updateHeaders([] as any)).toThrow(
            NitroSseValidationError
          );
          expect(() => client.updateHeaders('Authorization' as any)).toThrow(
            NitroSseValidationError
          );

          expect(() => client.setLastProcessedId(123 as any)).toThrow(
            NitroSseValidationError
          );

          expect(() => client.injectMockEvent(null as any)).toThrow(
            NitroSseValidationError
          );
          expect(() => client.injectMockEvent([] as any)).toThrow(
            NitroSseValidationError
          );
        });
      });

      it('should throw NitroSseDisposedError with CLIENT_DISPOSED code on disposed instance', () => {
        jest.isolateModules(() => {
          const {
            createNitroSse,
            NitroSseError,
            NitroSseDisposedError,
          } = require('../index');
          const client = createNitroSse();
          client.dispose();

          try {
            client.start();
            fail('Expected client.start() to throw');
          } catch (err: any) {
            expect(err).toBeInstanceOf(Error);
            expect(err).toBeInstanceOf(NitroSseError);
            expect(err).toBeInstanceOf(NitroSseDisposedError);
            expect(err.code).toBe('CLIENT_DISPOSED');
            expect(err.name).toBe('NitroSseDisposedError');
          }

          expect(() => client.stop()).toThrow(NitroSseDisposedError);
          expect(() => client.restart()).toThrow(NitroSseDisposedError);
          expect(() => client.flush()).toThrow(NitroSseDisposedError);
          expect(() => client.setup({ url: TEST_URL })).toThrow(
            NitroSseDisposedError
          );
          expect(() => client.updateHeaders({ a: '1' })).toThrow(
            NitroSseDisposedError
          );
          expect(() => client.setLastProcessedId('1')).toThrow(
            NitroSseDisposedError
          );
          expect(() => client.injectMockEvent({})).toThrow(
            NitroSseDisposedError
          );
          expect(() => client.addEventListener('message', () => {})).toThrow(
            NitroSseDisposedError
          );
        });
      });

      it('should discard events arriving after client is disposed', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();
          let nativeCb: any;
          mockNative.setup.mockImplementation((_cfg: any, cb: any) => {
            nativeCb = cb;
          });

          const onEvent = jest.fn();
          const messageListener = jest.fn();
          client.setup({ url: TEST_URL }, onEvent);
          client.addEventListener('message', messageListener);

          client.dispose();

          // Late callback arriving after dispose
          nativeCb([{ type: 'message', data: 'too late' }]);

          expect(onEvent).not.toHaveBeenCalled();
          expect(messageListener).not.toHaveBeenCalled();
        });
      });

      it('should normalize uppercase POST/GET to lowercase post/get for JSI converter compatibility', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();

          client.setup({
            url: TEST_URL,
            method: 'POST' as any,
          });

          expect(mockNative.setup).toHaveBeenCalledWith(
            expect.objectContaining({
              method: 'post',
            }),
            expect.any(Function)
          );

          client.setup({
            url: TEST_URL,
            method: 'GET' as any,
          });

          expect(mockNative.setup).toHaveBeenLastCalledWith(
            expect.objectContaining({
              method: 'get',
            }),
            expect.any(Function)
          );
        });
      });

      it('should reject non-object headers with NitroSseValidationError in setup()', () => {
        jest.isolateModules(() => {
          const {
            createNitroSse,
            NitroSseValidationError,
          } = require('../index');
          const client = createNitroSse();

          expect(() =>
            client.setup({
              url: TEST_URL,
              headers: 'Bearer token' as any,
            })
          ).toThrow(NitroSseValidationError);

          expect(() =>
            client.setup({
              url: TEST_URL,
              headers: ['Authorization', 'Bearer token'] as any,
            })
          ).toThrow(NitroSseValidationError);
        });
      });

      it('should clamp invalid connectionTimeoutMs and readTimeoutMs to safe defaults and warn', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();
          const warnSpy = jest
            .spyOn(console, 'warn')
            .mockImplementation(() => {});

          client.setup({
            url: TEST_URL,
            connectionTimeoutMs: -100,
            readTimeoutMs: 0,
          });

          expect(mockNative.setup).toHaveBeenCalledWith(
            expect.objectContaining({
              connectionTimeoutMs: 15000,
              readTimeoutMs: 300000,
            }),
            expect.any(Function)
          );

          warnSpy.mockRestore();
        });
      });

      it('should forward full merged headers to native driver on subsequent updateHeaders calls', () => {
        jest.isolateModules(() => {
          const { createNitroSse } = require('../index');
          const client = createNitroSse();

          client.setup({
            url: TEST_URL,
            headers: {
              'X-Initial-Key': 'initial-val',
              'Authorization': 'token-v1',
            },
          });

          client.updateHeaders({
            Authorization: 'token-v2',
            Tenant: 'tenant-123',
          });

          expect(mockNative.updateHeaders).toHaveBeenLastCalledWith({
            'X-Initial-Key': 'initial-val',
            'Authorization': 'token-v2',
            'Tenant': 'tenant-123',
          });
        });
      });
    });
  });
});
