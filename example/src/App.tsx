import { useState, useCallback, useRef, useEffect } from 'react';
import { Platform, LayoutAnimation, UIManager } from 'react-native';
import { Content, type LogEntry } from './Content';
import {
  createNitroSse,
  type SseClient,
  type SseStats,
  type SseEvent,
} from 'react-native-nitro-sse';

const DEFAULT_URL = Platform.select({
  android: 'http://10.0.2.2:33333/events',
  ios: 'http://localhost:33333/events',
  default: 'http://localhost:33333/events',
})!;

if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * Root React component that manages an SSE client and provides a UI for controlling and observing its connection.
 *
 * Manages SSE lifecycle, connection and reconnection configuration, logging, periodic statistics polling, and token/header rotation.
 * Registers typed SSE event listeners, exposes control handlers (start, stop, flush, restart, apply headers, set last processed ID, toggle config), and passes all relevant state and handlers to the rendered Content component.
 *
 * @returns The application UI as a JSX element (renders the Content component with current state and control callbacks).
 */
export default function App() {
  // --- States ---
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [useInterceptor, setUseInterceptor] = useState(false);
  const [useMock, setUseMock] = useState(true);
  const [mockMode, setMockMode] = useState<'replace' | 'inject'>('replace');
  const [mockSpeed, setMockSpeed] = useState('1');
  const [stats, setStats] = useState<SseStats>({
    totalBytesReceived: 0,
    reconnectCount: 0,
  });

  // --- Configuration ---
  const [url, setUrl] = useState(DEFAULT_URL);
  const [batching, setBatching] = useState('1000');
  const [headersJson, setHeadersJson] = useState('{"authorization": "Nitro"}');
  const [manualId, setManualId] = useState('');
  const [method, setMethod] = useState<'get' | 'post'>('get');
  const [body, setBody] = useState('');
  const [connectionTimeout, setConnectionTimeout] = useState('15000');
  const [readTimeout, setReadTimeout] = useState('300000');
  const [retryInterval, setRetryInterval] = useState('1000');
  const [maxRetryInterval, setMaxRetryInterval] = useState('30000');
  const [jitter, setJitter] = useState('0.5');
  const [reconnectAttempts, setReconnectAttempts] = useState('-1');
  const [autoParseJSON, setAutoParseJSON] = useState(true);
  const [showConfig, setShowConfig] = useState(false);

  // --- Refs ---
  const sseRef = useRef<SseClient | null>(null);
  const statsInterval = useRef<Record<string, any> | null>(null);
  const scrollViewRef = useRef<any>(null);

  // --- Helpers ---
  const addLog = useCallback(
    (
      type: string,
      data?: string,
      message?: string,
      statusCode?: number,
      parsedData?: any
    ) => {
      const entry: LogEntry = {
        id: Math.random().toString(36).substring(7),
        time: new Date().toLocaleTimeString([], {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        type,
        data,
        message,
        statusCode,
        parsedData,
      };
      setLogs((prev) => [entry, ...prev].slice(0, 100));
    },
    []
  );

  const updateStats = useCallback(() => {
    if (sseRef.current) {
      const currentStats = sseRef.current.getStats();
      const active = sseRef.current.isConnected();
      setStats(currentStats);
      setIsConnected(active);
    }
  }, []);

  // --- Handlers ---

  const startConnection = () => {
    if (sseRef.current) return;

    try {
      setIsConnecting(true);
      addLog('system', undefined, 'Initializing connection...');

      const sse = createNitroSse();

      // --- New: Typed Event Listeners ---
      sse.addEventListener('open', (event) => {
        addLog(
          'open',
          event.data,
          'Connection established (via listener)',
          event.statusCode,
          event.parsedData
        );
        setIsConnected(true);
        setIsConnecting(false);
      });

      sse.addEventListener('message', (event) => {
        addLog(
          event.type,
          event.data,
          event.message,
          event.statusCode,
          event.parsedData
        );
      });

      sse.addEventListener('error', (event) => {
        addLog(
          'error',
          event.data,
          event.message,
          event.statusCode,
          event.parsedData
        );
        setIsConnecting(false);
        setIsConnected(false);
      });

      sse.addEventListener('heartbeat', (event) => {
        addLog('heartbeat', undefined, 'Keep-alive received', event.statusCode);
      });

      // Demonstrate custom SSE event name listening
      sse.addEventListener('update', (event) => {
        addLog(
          'update',
          event.data,
          'Custom "update" event received!',
          event.statusCode,
          event.parsedData
        );
      });

      // Generate mock events
      const mockEvents: Partial<SseEvent>[] = [
        { type: 'message', data: '{"status":"started","source":"Mock JS Engine"}' },
        { type: 'message', data: '{"value":42,"timestamp":1710000000}' },
        { type: 'message', data: '{"temperature":24.5,"humidity":52.1}' },
        { type: 'message', data: '{"event":"user_login","username":"nitro_tester"}', event: 'update' },
        { type: 'heartbeat', message: 'Keep-alive mock comment' },
        { type: 'message', data: '{"status":"processing","progress":50}' },
        { type: 'message', data: '{"temperature":24.8,"humidity":51.8}' },
        { type: 'message', data: '{"status":"finished","progress":100}' }
      ];

      const speed = parseInt(mockSpeed, 10) || 1;
      const dataToMock: Partial<SseEvent>[] = speed > 10
        ? Array.from({ length: Math.min(10000, speed * 5) }, (_, i) => ({
          type: 'message',
          data: `{"event_id":${i},"value":${Math.round(Math.random() * 100)}}`
        }))
        : mockEvents;

      sse.setup({
        url: url + (useInterceptor ? '?auth=true' : ''),
        method: method,
        body: method === 'post' ? body : undefined,
        batchingIntervalMs: parseInt(batching, 10) || 0,
        connectionTimeoutMs: parseInt(connectionTimeout, 10) || 15000,
        readTimeoutMs: parseInt(readTimeout, 10) || 35000,
        // --- New: Reconnection Logic ---
        retryIntervalMs: parseInt(retryInterval, 10) || 1000,
        maxRetryIntervalMs: parseInt(maxRetryInterval, 10) || 30000,
        jitterFactor: parseFloat(jitter) || 0.5,
        maxReconnectAttempts: parseInt(reconnectAttempts, 10) || -1,
        autoParseJSON: autoParseJSON,
        onBeforeRequest: useInterceptor
          ? async () => {
            addLog('system', undefined, 'Middleware: Refreshing token...');
            await new Promise((resolve) => setTimeout(resolve, 500));
            return {
              'Authorization': 'Bearer interceptor-token',
              'X-Interceptor-Actived': 'true',
            };
          }
          : undefined,
        mock: useMock
          ? {
            mode: mockMode,
            data: dataToMock,
            eventsPerSecond: speed,
          }
          : undefined,
      });

      sse.start();
      sseRef.current = sse;

      // Start stats polling
      statsInterval.current = setInterval(updateStats, 1000);

      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setShowConfig(false);
    } catch (e: any) {
      setIsConnecting(false);
      addLog('error', undefined, e.message);
    }
  };

  const stopConnection = () => {
    if (sseRef.current) {
      sseRef.current.stop();
      sseRef.current = null;
      setIsConnected(false);
      setIsConnecting(false);
      if (statsInterval.current) {
        clearInterval(statsInterval.current as any);
      }
      addLog('system', undefined, 'Connection stopped');
    }
  };

  const manualFlush = () => {
    if (sseRef.current) {
      sseRef.current.flush();
      addLog('command', undefined, 'Manual flush requested');
    }
  };

  const manualRestart = () => {
    if (sseRef.current) {
      sseRef.current.restart();
      addLog('command', undefined, 'Restarting connection...');
    }
  };

  const toggleConfig = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setShowConfig(!showConfig);
  };

  const applyCustomHeaders = () => {
    if (sseRef.current) {
      try {
        const headers = JSON.parse(headersJson);
        sseRef.current.updateHeaders(headers);
        addLog('system', undefined, 'Headers updated for next reconnect');
      } catch {
        addLog('error', undefined, 'Invalid JSON for headers');
      }
    }
  };

  const applyManualId = () => {
    if (sseRef.current) {
      sseRef.current.setLastProcessedId(manualId);
      addLog('system', undefined, `Last ID set to: ${manualId}`);
    }
  };

  useEffect(() => {
    return () => {
      if (statsInterval.current) clearInterval(statsInterval.current as any);
      if (sseRef.current) {
        sseRef.current.stop();
        sseRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let tokenInterval: ReturnType<typeof setInterval>;
    if (isConnected) {
      tokenInterval = setInterval(() => {
        const newToken = `Bearer Nitro-${Math.random()
          .toString(36)
          .substring(7)
          .toUpperCase()}`;
        if (sseRef.current) {
          sseRef.current.updateHeaders({ authorization: newToken });
          addLog('system', undefined, `Rotated auth token: ${newToken}`);
        }
      }, 5000);
    }
    return () => {
      if (tokenInterval) clearInterval(tokenInterval);
    };
  }, [isConnected, addLog]);

  return (
    <Content
      logs={logs}
      isConnected={isConnected}
      isConnecting={isConnecting}
      useInterceptor={useInterceptor}
      useMock={useMock}
      mockMode={mockMode}
      mockSpeed={mockSpeed}
      stats={stats}
      url={url}
      batching={batching}
      headersJson={headersJson}
      manualId={manualId}
      method={method}
      body={body}
      connectionTimeout={connectionTimeout}
      readTimeout={readTimeout}
      retryInterval={retryInterval}
      maxRetryInterval={maxRetryInterval}
      jitter={jitter}
      reconnectAttempts={reconnectAttempts}
      autoParseJSON={autoParseJSON}
      showConfig={showConfig}
      scrollViewRef={scrollViewRef}
      setLogs={setLogs}
      setUrl={setUrl}
      setBatching={setBatching}
      setMethod={setMethod}
      setBody={setBody}
      setConnectionTimeout={setConnectionTimeout}
      setReadTimeout={setReadTimeout}
      setRetryInterval={setRetryInterval}
      setMaxRetryInterval={setMaxRetryInterval}
      setJitter={setJitter}
      setReconnectAttempts={setReconnectAttempts}
      setAutoParseJSON={setAutoParseJSON}
      setHeadersJson={setHeadersJson}
      setManualId={setManualId}
      setUseInterceptor={setUseInterceptor}
      setUseMock={setUseMock}
      setMockMode={setMockMode}
      setMockSpeed={setMockSpeed}
      startConnection={startConnection}
      stopConnection={stopConnection}
      manualFlush={manualFlush}
      manualRestart={manualRestart}
      toggleConfig={toggleConfig}
      applyCustomHeaders={applyCustomHeaders}
      applyManualId={applyManualId}
    />
  );
}
