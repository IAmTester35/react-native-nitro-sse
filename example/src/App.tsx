import { useState, useCallback } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
} from 'react-native';
import { useNitroSse } from 'react-native-nitro-sse';
import { Content, type LogEntry } from './Content';
import { SseBenchmarkView } from './SseBenchmarkView';
import { getDevServerUrl } from './config';

type TabMode = 'stream' | 'benchmark';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabMode>('stream');
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
    url: getDevServerUrl(),
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
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      {/* Segmented Tab Navigation */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'stream' && styles.tabButtonActive]}
          onPress={() => setActiveTab('stream')}
        >
          <Text
            style={[styles.tabText, activeTab === 'stream' && styles.tabTextActive]}
          >
            Live Stream
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'benchmark' && styles.tabButtonActive]}
          onPress={() => setActiveTab('benchmark')}
        >
          <Text
            style={[styles.tabText, activeTab === 'benchmark' && styles.tabTextActive]}
          >
            Benchmark
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.contentArea}>
        {activeTab === 'stream' ? (
          <Content
            logs={logs}
            state={state}
            isConnected={isConnected}
            onToggleConnection={handleToggleConnection}
            onClearLogs={() => setLogs([])}
          />
        ) : (
          <SseBenchmarkView />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  tabContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#F3F4F6',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    gap: 8,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabButtonActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 2,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
  },
  tabTextActive: {
    color: '#111827',
  },
  contentArea: {
    flex: 1,
  },
});
