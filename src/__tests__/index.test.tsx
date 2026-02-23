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
      flush: jest.fn(),
      restart: jest.fn(),
    };

    (NitroModules.createHybridObject as jest.Mock).mockReturnValue(mockNative);
  });

  it('should call native setup method', () => {
    jest.isolateModules(() => {
      const { createNitroSse } = require('../index');
      const NitroSseModule = createNitroSse();
      const config = { url: 'http://test.com' };
      const onEvent = jest.fn();

      NitroSseModule.setup(config, onEvent);
      expect(mockNative.setup).toHaveBeenCalledWith(config, onEvent);
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
      const config = { url: 'https://example.com/stream' };

      NitroSseModule.setup(config, onEvent);

      // Verify setup was called
      expect(mockNative.setup).toHaveBeenCalledWith(config, onEvent);

      // Simulate native side calling the callback
      const registeredCallback = mockNative.setup.mock.calls[0][1];
      const testEvent = { type: 'open' };
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
        url: 'https://example.com',
        batchingIntervalMs: 500,
      };

      NitroSseModule.setup(config, onEvent);
      expect(mockNative.setup).toHaveBeenCalledWith(config, onEvent);

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
        url: 'https://example.com',
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
        url: 'https://api.example.com/v1/sse',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Custom': 'Value' },
        body: JSON.stringify({ room: '123' }),
        backgroundExecution: true,
        batchingIntervalMs: 100,
        maxBufferSize: 5000,
      };

      NitroSseModule.setup(fullConfig as any, onEvent);
      expect(mockNative.setup).toHaveBeenCalledWith(fullConfig, onEvent);
    });
  });
});
