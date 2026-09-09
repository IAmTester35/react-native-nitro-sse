import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  StatusBar,
} from 'react-native';
import type { SseState } from 'react-native-nitro-sse';

export interface LogEntry {
  id: string;
  time: string;
  type: string;
  data?: string;
  message?: string;
}

export interface ContentProps {
  logs: LogEntry[];
  state: SseState;
  isConnected: boolean;
  onToggleConnection: () => void;
  onClearLogs: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  open: '#16A34A',
  error: '#DC2626',
  message: '#2563EB',
  heartbeat: '#D97706',
  custom: '#8B5CF6',
};

export function Content({
  logs,
  state,
  isConnected,
  onToggleConnection,
  onClearLogs,
}: ContentProps) {
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Nitro SSE</Text>
          <Text style={styles.status}>{state}</Text>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.btn, isConnected ? styles.btnStop : styles.btnStart]}
            onPress={onToggleConnection}
          >
            <Text style={styles.btnText}>{isConnected ? 'Stop' : 'Connect'}</Text>
          </TouchableOpacity>
          {logs.length > 0 && (
            <TouchableOpacity style={styles.btnClear} onPress={onClearLogs}>
              <Text style={styles.btnClearText}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={logs}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No events received</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.logRow}>
            <Text style={styles.logTime}>{item.time}</Text>
            <Text
              style={[
                styles.logType,
                { color: TYPE_COLORS[item.type] ?? '#6B7280' },
              ]}
            >
              {item.type}
            </Text>
            <Text style={styles.logText} numberOfLines={2}>
              {item.data ?? item.message}
            </Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 60,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
  },
  status: {
    fontSize: 12,
    color: '#6B7280',
    textTransform: 'uppercase',
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  btn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnStart: {
    backgroundColor: '#2563EB',
  },
  btnStop: {
    backgroundColor: '#DC2626',
  },
  btnText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  btnClear: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginLeft: 8,
  },
  btnClearText: {
    color: '#6B7280',
    fontSize: 14,
  },
  list: {
    padding: 16,
  },
  logRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F3F4F6',
  },
  logTime: {
    fontSize: 11,
    color: '#9CA3AF',
    fontVariant: ['tabular-nums'],
    marginRight: 8,
  },
  logType: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    width: 65,
    marginRight: 8,
  },
  logText: {
    flex: 1,
    fontSize: 12,
    color: '#1F2937',
  },
  emptyText: {
    textAlign: 'center',
    color: '#9CA3AF',
    marginTop: 40,
    fontSize: 14,
  },
});
