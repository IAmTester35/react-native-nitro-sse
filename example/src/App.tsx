import { useState, useCallback } from 'react';
import { Platform } from 'react-native';
import { useNitroSse } from 'react-native-nitro-sse';
import { Content, type LogEntry } from './Content';

const DEFAULT_URL = Platform.select({
  android: 'http://10.0.2.2:33333/events',
  default: 'http://localhost:33333/events',
})!;

export default function App() {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const addLog = useCallback((type: string, data?: string, message?: string) => {
    setLogs((prev) => [
      {
        id: Math.random().toString(36).slice(2, 9),
        time: new Date().toTimeString().slice(0, 8),
        type,
        data,
        message,
      },
      ...prev.slice(0, 99),
    ]);
  }, []);

  const { state, isConnected, start, stop } = useNitroSse({
    url: DEFAULT_URL,
    autoStart: false,
    onOpen: () => addLog('open', undefined, 'Connected'),
    onMessage: (e) => addLog('message', e.data),
    onError: (e) => addLog('error', e.data, e.message),
    onHeartbeat: (e) => addLog('heartbeat', undefined, e.message ?? 'Keep-alive'),
    events: {
      notification: (e) => addLog('custom', e.data, 'Custom Event: notification'),
    },
  });

  const handleToggleConnection = useCallback(() => {
    if (isConnected) {
      stop();
      addLog('system', undefined, 'Disconnected');
    } else {
      addLog('system', undefined, 'Connecting...');
      start();
    }
  }, [isConnected, start, stop, addLog]);

  return (
    <Content
      logs={logs}
      state={state}
      isConnected={isConnected}
      onToggleConnection={handleToggleConnection}
      onClearLogs={() => setLogs([])}
    />
  );
}
