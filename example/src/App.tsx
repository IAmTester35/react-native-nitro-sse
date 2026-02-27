import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  SafeAreaView,
  StatusBar,
  TextInput,
  LayoutAnimation,
  ActivityIndicator,
  UIManager,
} from 'react-native';
import {
  createNitroSse,
  type NitroSse,
  type SseEvent,
  type SseStats,
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

const COLORS = {
  background: '#0F172A',
  card: '#1E293B',
  primary: '#38BDF8',
  success: '#10B981',
  error: '#EF4444',
  warning: '#F59E0B',
  text: '#F8FAFC',
  textDim: '#94A3B8',
  border: '#334155',
  accent: '#7C3AED',
};

interface LogEntry {
  id: string;
  time: string;
  type: string;
  data?: string;
  message?: string;
}

export default function App() {
  // --- States ---
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [stats, setStats] = useState<SseStats>({
    totalBytesReceived: 0,
    reconnectCount: 0,
  });

  // --- Configuration ---
  const [url, setUrl] = useState(DEFAULT_URL);
  const [batching, setBatching] = useState('1000');
  const [showConfig, setShowConfig] = useState(false);

  // --- Refs ---
  const sseRef = useRef<NitroSse | null>(null);
  const statsInterval = useRef<Record<string, any> | null>(null);
  const scrollViewRef = useRef<any>(null);

  // --- Helpers ---
  const addLog = useCallback(
    (type: string, data?: string, message?: string) => {
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
  const handleEvents = useCallback(
    (events: SseEvent[]) => {
      events.forEach((event) => {
        addLog(event.type, event.data, event.message);
        if (event.type === 'open') {
          setIsConnected(true);
          setIsConnecting(false);
        } else if (event.type === 'close') {
          setIsConnected(false);
        }
      });
    },
    [addLog]
  );

  const startConnection = () => {
    if (sseRef.current) return;

    try {
      setIsConnecting(true);
      addLog('system', undefined, 'Initializing connection...');

      const sse = createNitroSse();
      sse.setup(
        {
          url: url,
          batchingIntervalMs: parseInt(batching, 10) || 0,
        },
        handleEvents
      );

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

  useEffect(() => {
    return () => {
      if (statsInterval.current) clearInterval(statsInterval.current as any);
    };
  }, []);

  // --- Render Functions ---
  const renderLogItem = (item: LogEntry) => {
    let typeColor = COLORS.textDim;
    if (item.type === 'open') typeColor = COLORS.success;
    if (item.type === 'error') typeColor = COLORS.error;
    if (item.type === 'message') typeColor = COLORS.primary;
    if (item.type === 'command') typeColor = COLORS.accent;

    return (
      <View key={item.id} style={styles.logItem}>
        <View style={styles.logHeader}>
          <Text style={styles.logTime}>{item.time}</Text>
          <View
            style={[styles.typeBadge, { backgroundColor: typeColor + '20' }]}
          >
            <Text style={[styles.typeText, { color: typeColor }]}>
              {item.type.toUpperCase()}
            </Text>
          </View>
        </View>
        {item.data ? <Text style={styles.logData}>{item.data}</Text> : null}
        {item.message ? (
          <Text style={styles.logMessage}>{item.message}</Text>
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* --- Header & Status --- */}
      <View style={styles.header}>
        <View>
          <Text style={styles.brandTitle}>
            Nitro <Text style={{ color: COLORS.primary }}>SSE</Text>
          </Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor: isConnected
                    ? COLORS.success
                    : isConnecting
                    ? COLORS.warning
                    : COLORS.error,
                },
              ]}
            />
            <Text style={styles.statusText}>
              {isConnected
                ? 'LIVE'
                : isConnecting
                ? 'CONNECTING...'
                : 'DISCONNECTED'}
            </Text>
          </View>
        </View>
        <TouchableOpacity style={styles.settingsButton} onPress={toggleConfig}>
          <Text style={styles.settingsIcon}>⚙️</Text>
        </TouchableOpacity>
      </View>

      {/* --- Stats Dashboard --- */}
      <View style={styles.statsContainer}>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>DATA RECEIVED</Text>
          <Text style={styles.statValue}>
            {(stats.totalBytesReceived / 1024).toFixed(2)}{' '}
            <Text style={styles.statUnit}>KB</Text>
          </Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>RECONNECTS</Text>
          <Text style={styles.statValue}>{stats.reconnectCount}</Text>
        </View>
      </View>

      {/* --- Configuration Sheet (Collapsible) --- */}
      {showConfig && (
        <View style={styles.configSheet}>
          <Text style={styles.configTitle}>Connection Settings</Text>

          <Text style={styles.inputLabel}>ENDPOINT URL</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="http://..."
            placeholderTextColor={COLORS.textDim}
          />

          <View style={styles.inputRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>BATCHING (MS)</Text>
              <TextInput
                style={styles.input}
                value={batching}
                onChangeText={setBatching}
                keyboardType="numeric"
                placeholder="0 = off"
                placeholderTextColor={COLORS.textDim}
              />
            </View>
          </View>
        </View>
      )}

      {/* --- Main Controls --- */}
      <View style={styles.mainControls}>
        {!isConnected && !isConnecting ? (
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: COLORS.primary }]}
            onPress={startConnection}
          >
            <Text style={styles.buttonText}>ESTABLISH CONNECTION</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.actionButton} onPress={manualFlush}>
              <Text style={styles.actionButtonText}>FLUSH</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={manualRestart}
            >
              <Text style={styles.actionButtonText}>RESTART</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.actionButton,
                { backgroundColor: COLORS.error + '20' },
              ]}
              onPress={stopConnection}
            >
              <Text style={[styles.actionButtonText, { color: COLORS.error }]}>
                STOP
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* --- Log Viewer --- */}
      <View style={styles.logViewer}>
        <View style={styles.logViewerHeader}>
          <Text style={styles.logViewerTitle}>STREAM ACTIVITY</Text>
          <TouchableOpacity onPress={() => setLogs([])}>
            <Text style={styles.clearText}>CLEAR</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={scrollViewRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          indicatorStyle="white"
        >
          {logs.length === 0 ? (
            <View style={styles.emptyState}>
              {isConnecting ? (
                <ActivityIndicator color={COLORS.primary} />
              ) : (
                <Text style={styles.emptyText}>No activity recorded yet.</Text>
              )}
            </View>
          ) : (
            logs.map(renderLogItem)
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 50,
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  brandTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: COLORS.text,
    letterSpacing: 1,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    color: COLORS.textDim,
    fontSize: 10,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  settingsButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.card,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  settingsIcon: {
    fontSize: 18,
  },
  statsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 15,
    gap: 10,
    marginBottom: 15,
  },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statLabel: {
    color: COLORS.textDim,
    fontSize: 9,
    fontWeight: 'bold',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  statValue: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
  },
  statUnit: {
    fontSize: 10,
    color: COLORS.textDim,
  },
  configSheet: {
    backgroundColor: COLORS.card,
    marginHorizontal: 15,
    borderRadius: 12,
    padding: 15,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  configTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 15,
  },
  inputLabel: {
    color: COLORS.primary,
    fontSize: 9,
    fontWeight: 'bold',
    marginBottom: 6,
  },
  input: {
    backgroundColor: COLORS.background,
    borderRadius: 8,
    padding: 10,
    color: COLORS.text,
    fontSize: 13,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 10,
  },
  mainControls: {
    paddingHorizontal: 15,
    marginBottom: 20,
  },
  primaryButton: {
    height: 50,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionButton: {
    flex: 1,
    height: 45,
    backgroundColor: COLORS.card,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  actionButtonText: {
    color: COLORS.text,
    fontSize: 11,
    fontWeight: 'bold',
  },
  logViewer: {
    flex: 1,
    backgroundColor: COLORS.card,
    marginHorizontal: 15,
    marginBottom: 20,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  logViewerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#00000020',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  logViewerTitle: {
    color: COLORS.textDim,
    fontSize: 10,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  clearText: {
    color: COLORS.error,
    fontSize: 10,
    fontWeight: 'bold',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 12,
  },
  logItem: {
    marginBottom: 12,
    backgroundColor: '#00000030',
    borderRadius: 8,
    padding: 10,
    borderWidth: 0.5,
    borderColor: '#ffffff10',
  },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  logTime: {
    color: COLORS.textDim,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 10,
  },
  typeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  typeText: {
    fontSize: 8,
    fontWeight: 'bold',
  },
  logData: {
    color: COLORS.text,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 11,
    lineHeight: 16,
  },
  logMessage: {
    color: COLORS.textDim,
    fontSize: 11,
    fontStyle: 'italic',
  },
  emptyState: {
    flex: 1,
    height: 200,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: COLORS.textDim,
    fontSize: 12,
  },
});
