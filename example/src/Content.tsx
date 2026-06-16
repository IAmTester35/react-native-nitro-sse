import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  SafeAreaView,
  StatusBar,
  ActivityIndicator,
} from 'react-native';

export const COLORS = {
  background: '#0F172A',
  card: '#1E293B',
  primary: '#38BDF8',
  success: '#10B981',
  error: '#EF4444',
  warning: '#F59E0B',
  text: '#F8FAFC',
  textDim: '#94A3B8',
  border: '#334155',
};

export interface LogEntry {
  id: string;
  time: string;
  type: string;
  data?: string;
  message?: string;
}

export interface ContentProps {
  logs: LogEntry[];
  isConnected: boolean;
  isConnecting: boolean;
  setLogs: (logs: LogEntry[]) => void;
  startConnection: () => void;
  stopConnection: () => void;
}

export function Content(props: ContentProps) {
  const {
    logs,
    isConnected,
    isConnecting,
    setLogs,
    startConnection,
    stopConnection,
  } = props;

  const renderLogItem = (item: LogEntry) => {
    let typeColor = COLORS.textDim;
    if (item.type === 'open') typeColor = COLORS.success;
    if (item.type === 'error') typeColor = COLORS.error;
    if (item.type === 'message') typeColor = COLORS.primary;

    return (
      <View key={item.id} style={styles.logItem}>
        <View style={styles.logHeader}>
          <Text style={styles.logTime}>{item.time}</Text>
          <View style={[styles.typeBadge, { backgroundColor: typeColor + '20' }]}>
            <Text style={[styles.typeText, { color: typeColor }]}>
              {item.type.toUpperCase()}
            </Text>
          </View>
        </View>
        {item.data ? (
          <Text style={styles.logData} numberOfLines={2}>
            {item.data}
          </Text>
        ) : null}
        {item.message ? (
          <Text style={styles.logMessage} numberOfLines={2}>
            {item.message}
          </Text>
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
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

      <View style={styles.mainControls}>
        {!isConnected && !isConnecting ? (
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: COLORS.primary }]}
            onPress={startConnection}
          >
            <Text style={styles.buttonText}>CONNECT</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: COLORS.error + '20' }]}
            onPress={stopConnection}
          >
            <Text style={[styles.actionButtonText, { color: COLORS.error }]}>
              STOP
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.logViewer}>
        <View style={styles.logViewerHeader}>
          <Text style={styles.logViewerTitle}>STREAM ACTIVITY</Text>
          <TouchableOpacity onPress={() => setLogs([])}>
            <Text style={styles.clearText}>CLEAR</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
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
  mainControls: {
    paddingHorizontal: 15,
    marginBottom: 20,
  },
  primaryButton: {
    height: 50,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  actionButton: {
    height: 45,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  actionButtonText: {
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
