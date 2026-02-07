import { useState, useCallback, useRef } from 'react';
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import {
  createNitroSse,
  type NitroSse,
  type SseEvent,
} from 'react-native-nitro-sse';

const SSE_URL = Platform.select({
  android: 'http://10.0.2.2:33333/events',
  ios: 'http://localhost:33333/events',
  default: 'http://localhost:33333/events',
});

export default function App() {
  const [logs, setLogs] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  // Store the SSE instance in a Ref to persist across re-renders
  const sseRef = useRef<NitroSse | null>(null);

  const addLog = (msg: string) => {
    setLogs((prev) =>
      [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50)
    );
  };

  const handleError = (error: any) => {
    console.error(error);
    addLog(`⚠️ Exception: ${error.message}`);
  };

  const handleEvents = useCallback((events: SseEvent[]) => {
    events.forEach((event) => {
      switch (event.type) {
        case 'open':
          addLog('🟢 SSE Connection Opened');
          setIsConnected(true);
          break;
        case 'message':
          addLog(`📩 Message: ${event.data}`);
          break;
        case 'error':
          addLog(`🔴 Error: ${event.message}`);
          // Note: We don't automatically set isConnected=false here because
          // the library might be retrying (autoreconnect).
          // We can check sseRef.current?.isConnected if needed.
          if (sseRef.current) {
            // Optional: Sync UI state with actual connection state
            // setIsConnected(sseRef.current.isConnected);
          }
          break;
        case 'close':
          addLog('⚪ SSE Connection Closed');
          setIsConnected(false);
          break;
        case 'heartbeat':
          addLog('💓 Heartbeat received');
          break;
      }
    });
  }, []);

  const startConnection = () => {
    if (sseRef.current) {
      addLog('⚠️ Connection already exists');
      return;
    }

    try {
      addLog('⏳ Initializing connection...');
      const sse = createNitroSse();
      sse.setup(
        {
          url: SSE_URL || '',
          batchingIntervalMs: 2000, // Demonstrate flushing by adding delay
        },
        handleEvents
      );

      sse.start();
      sseRef.current = sse;
      setIsConnected(true); // Optimistic update
    } catch (e) {
      handleError(e);
    }
  };

  const stopConnection = () => {
    if (sseRef.current) {
      sseRef.current.stop();
      sseRef.current = null;
      setIsConnected(false);
      addLog('🛑 SSE Connection Stopped by User');
    }
  };

  const manualFlush = () => {
    if (sseRef.current) {
      sseRef.current.flush();
      addLog('🚿 Manually Flushed Buffer');
    }
  };

  const manualRestart = () => {
    if (sseRef.current) {
      sseRef.current.restart();
      addLog('🔄 Manually Restarted Connection');
    }
  };

  const checkStatus = () => {
    if (sseRef.current) {
      const active = sseRef.current.isConnected;
      const stats = sseRef.current.getStats();
      addLog(
        `📊 Status: ${active ? 'Active' : 'Inactive'}, Reconnects: ${
          stats.reconnectCount
        }, Bytes: ${stats.totalBytesReceived}`
      );
    } else {
      addLog('📊 Status: No Instance');
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Nitro SSE Demo</Text>
        <Text style={styles.status}>
          Status:{' '}
          <Text style={isConnected ? styles.online : styles.offline}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </Text>
        </Text>
      </View>

      <View style={styles.controls}>
        {!isConnected ? (
          <TouchableOpacity
            style={[styles.button, styles.buttonStart]}
            onPress={startConnection}
          >
            <Text style={styles.buttonText}>Start SSE</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.button, styles.buttonStop]}
            onPress={stopConnection}
          >
            <Text style={styles.buttonText}>Stop SSE</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.controlsRow}>
        <TouchableOpacity style={styles.miniButton} onPress={manualFlush}>
          <Text style={styles.miniButtonText}>Flush</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.miniButton} onPress={manualRestart}>
          <Text style={styles.miniButtonText}>Restart</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.miniButton} onPress={checkStatus}>
          <Text style={styles.miniButtonText}>Stats</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.logContainer}>
        <Text style={styles.logTitle}>Logs:</Text>
        <ScrollView style={styles.scrollView}>
          {logs.map((log, index) => (
            <Text key={index} style={styles.logText}>
              {log}
            </Text>
          ))}
          {logs.length === 0 && (
            <Text style={styles.emptyText}>
              Press Start to receive simulated data...
            </Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    padding: 20,
  },
  header: {
    marginBottom: 20,
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
  },
  status: {
    fontSize: 16,
    marginTop: 8,
  },
  online: {
    color: '#4CAF50',
    fontWeight: 'bold',
  },
  offline: {
    color: '#F44336',
    fontWeight: 'bold',
  },
  button: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 20,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  controls: {
    width: '100%',
    alignItems: 'center',
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
    width: '100%',
    gap: 10,
  },
  miniButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    elevation: 2,
  },
  miniButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  buttonStart: {
    backgroundColor: '#2196F3',
  },
  buttonStop: {
    backgroundColor: '#F44336',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  logContainer: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  logTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#555',
  },
  scrollView: {
    flex: 1,
  },
  logText: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#444',
    marginBottom: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: '#eee',
    paddingBottom: 2,
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 20,
    color: '#999',
    fontStyle: 'italic',
  },
});
