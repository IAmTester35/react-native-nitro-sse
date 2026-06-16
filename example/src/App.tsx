import { useState, useRef, useEffect } from 'react';
import { Platform } from 'react-native';
import { Content, type LogEntry } from './Content';
import {
  createNitroSse,
  type SseClient,
} from 'react-native-nitro-sse';

const DEFAULT_URL = Platform.select({
  android: 'http://10.0.2.2:33333/events',
  ios: 'http://localhost:33333/events',
  default: 'http://localhost:33333/events',
})!;

export default function App() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
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
      setIsConnecting(true);
      addLog('system', undefined, 'Initializing connection...');

      const sse = createNitroSse();

      sse.addEventListener('open', () => {
        addLog('open', undefined, 'Connection established');
        setIsConnected(true);
        setIsConnecting(false);
      });

      sse.addEventListener('message', (event) => {
        addLog('message', event.data);
      });

      sse.addEventListener('error', (event) => {
        addLog('error', event.data, event.message);
        setIsConnecting(false);
        setIsConnected(false);
      });

      sse.addEventListener('heartbeat', () => {
        addLog('heartbeat', undefined, 'Keep-alive received');
      });

      sse.setup({
        url: DEFAULT_URL,
      });

      sse.start();
      sseRef.current = sse;

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
      isConnected={isConnected}
      isConnecting={isConnecting}
      setLogs={setLogs}
      startConnection={startConnection}
      stopConnection={stopConnection}
    />
  );
}
