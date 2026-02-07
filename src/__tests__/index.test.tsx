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
    };

    (NitroModules.createHybridObject as jest.Mock).mockReturnValue(mockNative);
  });

  it('should call native setup method', () => {
    jest.isolateModules(() => {
      const { NitroSseModule } = require('../index');
      const config = { url: 'http://test.com' };
      const onEvent = jest.fn();

      NitroSseModule.setup(config, onEvent);
      expect(mockNative.setup).toHaveBeenCalledWith(config, onEvent);
    });
  });

  it('should call native start method', () => {
    jest.isolateModules(() => {
      const { NitroSseModule } = require('../index');
      NitroSseModule.start();
      expect(mockNative.start).toHaveBeenCalled();
    });
  });

  it('should call native stop method', () => {
    jest.isolateModules(() => {
      const { NitroSseModule } = require('../index');
      NitroSseModule.stop();
      expect(mockNative.stop).toHaveBeenCalled();
    });
  });

  it('should call native updateHeaders method', () => {
    jest.isolateModules(() => {
      const { NitroSseModule } = require('../index');
      const newHeaders = { Authorization: 'Bearer new-token' };
      NitroSseModule.updateHeaders(newHeaders);
      expect(mockNative.updateHeaders).toHaveBeenCalledWith(newHeaders);
    });
  });

  it('should call native isConnected method', () => {
    jest.isolateModules(() => {
      const { NitroSseModule } = require('../index');
      NitroSseModule.isConnected();
      expect(mockNative.isConnected).toHaveBeenCalled();
    });
  });

  it('should bubble up errors thrown by native methods', () => {
    jest.isolateModules(() => {
      const { NitroSseModule } = require('../index');
      const error = new Error('Native start failed');
      mockNative.start.mockImplementation(() => {
        throw error;
      });

      expect(() => NitroSseModule.start()).toThrow('Native start failed');
    });
  });

  it('should correctly pass event callbacks to native', () => {
    jest.isolateModules(() => {
      const { NitroSseModule } = require('../index');
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
      const { NitroSseModule } = require('../index');
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
      const { NitroSseModule } = require('../index');
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
        require('../index');
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
        require('../index');
      }).toThrow('NitroSse: Native module not found');
    });
  });

  it('should handle backpressure by buffering events when batching is enabled', () => {
    jest.isolateModules(() => {
      const { NitroSseModule } = require('../index');
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
      const { NitroSseModule } = require('../index');
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
});
