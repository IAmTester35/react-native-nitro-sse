import { useState, useCallback } from 'react';
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  Platform,
} from 'react-native';
import { NitroSseModule, type SseEvent } from 'react-native-nitro-sse';

const SSE_URL = Platform.select({
  android: 'http://10.0.2.2:33333/events',
  ios: 'http://localhost:33333/events',
  default: 'http://localhost:33333/events',
});

export default function App() {
  const [logs, setLogs] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const addLog = (msg: string) => {
    setLogs((prev) =>
      [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50)
    );
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
          setIsConnected(false);
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

  const toggleConnection = () => {
    if (isConnected) {
      NitroSseModule.stop();
      setIsConnected(false);
      addLog('⚪ SSE Connection Stopped by User');
    } else {
      setLogs([]);
      NitroSseModule.setup({ url: SSE_URL }, handleEvents);
      NitroSseModule.start();
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Nitro SSE Demo</Text>
        <Text style={styles.status}>
          Status:{' '}
          <Text style={isConnected ? styles.online : styles.offline}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </Text>
        </Text>
      </View>

      <TouchableOpacity
        style={[
          styles.button,
          isConnected ? styles.buttonStop : styles.buttonStart,
        ]}
        onPress={toggleConnection}
      >
        <Text style={styles.buttonText}>
          {isConnected ? 'Stop SSE' : 'Start SSE'}
        </Text>
      </TouchableOpacity>

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
    </SafeAreaView>
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
