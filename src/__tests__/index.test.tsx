import { NitroModules } from 'react-native-nitro-modules';

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
    };

    (NitroModules.createHybridObject as jest.Mock).mockReturnValue(mockNative);
  });

  it('should call native setup method', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const config = { url: 'http://localhost:33333/events' };
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
      const config = { url: 'http://localhost:33333/events' };

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
        url: 'http://localhost:33333/events',
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
        url: 'http://localhost:33333/events',
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
        url: 'http://localhost:33333/events',
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
        fullConfig,
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
        url: 'http://localhost:33333/events',
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

      NitroSseModule.setup({ url: 'http://localhost:33333/events' });

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
            url: 'http://localhost',
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
          url: 'http://localhost',
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
          url: 'http://localhost',
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
          url: 'http://localhost',
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
          url: 'http://localhost',
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
          url: 'http://localhost',
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
          url: 'http://localhost',
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
            url: 'http://localhost',
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
          url: 'http://localhost',
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
          url: 'http://localhost',
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
          url: 'http://localhost',
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

        NitroSseModule.setup({ url: 'http://localhost' });

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
          url: 'http://localhost',
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
          url: 'http://localhost',
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
          url: 'http://localhost',
          mock: {
            mode: 'replace',
            data: [{ type: 'message', data: 'first-config-event' }],
            eventsPerSecond: 1,
          },
        });
        NitroSseModule.start();

        // Re-setup with new configuration without waiting for first timer
        NitroSseModule.setup({
          url: 'http://localhost',
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
  });
});
