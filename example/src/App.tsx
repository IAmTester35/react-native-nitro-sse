import { useState, useRef, useEffect } from 'react';
import { Platform } from 'react-native';
import { Content, type LogEntry } from './Content';
import {
  createNitroSse,
  type SseClient,
  type SseState,
} from 'react-native-nitro-sse';

const DEFAULT_URL = Platform.select({
  android: 'http://10.0.2.2:33333/events',
  ios: 'http://localhost:33333/events',
  default: 'http://localhost:33333/events',
})!;

export default function App() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connectionState, setConnectionState] = useState<SseState>('idle');
  const sseRef = useRef<SseClient | null>(null);

  const addLog = useRef((type: string, data?: string, message?: string) => {
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
    };
    setLogs((prev) => [entry, ...prev].slice(0, 100));
  }).current;

  const startConnection = () => {
    if (sseRef.current) return;

    try {
      addLog('system', undefined, 'Initializing connection...');

      const sse = createNitroSse();

      sse.addEventListener('open', () => {
        addLog('open', undefined, 'Connection established');
      });

      sse.addEventListener('message', (event) => {
        addLog('message', event.data);
      });

      sse.addEventListener('error', (event) => {
        addLog('error', event.data, event.message);
      });

      sse.addEventListener('heartbeat', () => {
        addLog('heartbeat', undefined, 'Keep-alive received');
      });

      sse.addEventListener('state', (event) => {
        if (event.state) {
          setConnectionState(event.state);
        }
      });

      sse.setup({
        url: DEFAULT_URL,
      });

      sse.start();
      sseRef.current = sse;

    } catch (e: any) {
      addLog('error', undefined, e.message);
    }
  };

  const stopConnection = () => {
    if (sseRef.current) {
      sseRef.current.stop();
      sseRef.current = null;
      addLog('system', undefined, 'Connection stopped');
    }
  };

  useEffect(() => {
    return () => {
      if (sseRef.current) {
        sseRef.current.stop();
        sseRef.current = null;
      }
    };
  }, []);

  return (
    <Content
      logs={logs}
      connectionState={connectionState}
      setLogs={setLogs}
      startConnection={startConnection}
      stopConnection={stopConnection}
    />
  );
}
