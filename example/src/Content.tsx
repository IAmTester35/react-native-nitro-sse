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
  ActivityIndicator,
  Alert,
} from 'react-native';
import type { SseStats } from 'react-native-nitro-sse';

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
  accent: '#7C3AED',
};

export interface LogEntry {
  id: string;
  time: string;
  type: string;
  data?: string;
  message?: string;
  statusCode?: number;
}

export interface ContentProps {
  logs: LogEntry[];
  isConnected: boolean;
  isConnecting: boolean;
  useInterceptor: boolean;
  stats: SseStats;
  url: string;
  batching: string;
  headersJson: string;
  manualId: string;
  method: 'get' | 'post';
  body: string;
  connectionTimeout: string;
  readTimeout: string;
  showConfig: boolean;
  scrollViewRef: any;
  setLogs: (logs: LogEntry[]) => void;
  setUrl: (url: string) => void;
  setBatching: (val: string) => void;
  setMethod: (val: 'get' | 'post') => void;
  setBody: (val: string) => void;
  setConnectionTimeout: (val: string) => void;
  setReadTimeout: (val: string) => void;
  setHeadersJson: (val: string) => void;
  setManualId: (val: string) => void;
  setUseInterceptor: (val: boolean) => void;
  startConnection: () => void;
  stopConnection: () => void;
  manualFlush: () => void;
  manualRestart: () => void;
  toggleConfig: () => void;
  applyCustomHeaders: () => void;
  applyManualId: () => void;
}

export function Content(props: ContentProps) {
  const {
    logs,
    isConnected,
    isConnecting,
    useInterceptor,
    stats,
    url,
    batching,
    headersJson,
    manualId,
    method,
    body,
    connectionTimeout,
    readTimeout,
    showConfig,
    scrollViewRef,
    setLogs,
    setUrl,
    setBatching,
    setMethod,
    setBody,
    setConnectionTimeout,
    setReadTimeout,
    setHeadersJson,
    setManualId,
    setUseInterceptor,
    startConnection,
    stopConnection,
    manualFlush,
    manualRestart,
    toggleConfig,
    applyCustomHeaders,
    applyManualId,
  } = props;

  // --- Render Functions ---
  const renderLogItem = (item: LogEntry) => {
    let typeColor = COLORS.textDim;
    if (item.type === 'open') typeColor = COLORS.success;
    if (item.type === 'error') typeColor = COLORS.error;
    if (item.type === 'message') typeColor = COLORS.primary;
    if (item.type === 'command') typeColor = COLORS.accent;

    const showDetails = () => {
      const details = [
        `Type: ${item.type.toUpperCase()}`,
        item.statusCode ? `Status: ${item.statusCode}` : null,
        item.data ? `Data: ${item.data}` : null,
        item.message ? `Message: ${item.message}` : null,
        item.id ? `Event ID: ${item.id}` : null,
      ]
        .filter(Boolean)
        .join('\n\n');

      Alert.alert(
        'Event Details',
        details,
        [{ text: 'Close', style: 'cancel' }],
        { cancelable: true }
      );
    };

    return (
      <TouchableOpacity
        key={item.id}
        style={styles.logItem}
        onPress={showDetails}
        activeOpacity={0.7}
      >
        <View style={styles.logHeader}>
          <Text style={styles.logTime}>{item.time}</Text>
          <View
            style={[styles.typeBadge, { backgroundColor: typeColor + '20' }]}
          >
            <Text style={[styles.typeText, { color: typeColor }]}>
              {item.type.toUpperCase()}
            </Text>
          </View>
          {item.statusCode ? (
            <Text style={styles.logStatus}>HTTP {item.statusCode}</Text>
          ) : null}
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
      </TouchableOpacity>
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
            <View style={styles.flex1}>
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
            <View style={styles.flex1}>
              <Text style={styles.inputLabel}>METHOD</Text>
              <View style={styles.methodRow}>
                {['get', 'post'].map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[
                      styles.methodButton,
                      method === m && styles.methodButtonActive,
                    ]}
                    onPress={() => setMethod(m as any)}
                  >
                    <Text
                      style={[
                        styles.methodButtonText,
                        method === m && styles.methodButtonTextActive,
                      ]}
                    >
                      {m.toUpperCase()}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>

          {method === 'post' && (
            <>
              <Text style={styles.inputLabel}>POST BODY</Text>
              <TextInput
                style={[styles.input, styles.multilineInput]}
                value={body}
                onChangeText={setBody}
                multiline
                placeholder='{"key": "value"}'
                placeholderTextColor={COLORS.textDim}
              />
            </>
          )}

          <View style={styles.inputRow}>
            <View style={styles.flex1}>
              <Text style={styles.inputLabel}>CONN TIMEOUT (MS)</Text>
              <TextInput
                style={styles.input}
                value={connectionTimeout}
                onChangeText={setConnectionTimeout}
                keyboardType="numeric"
                placeholder="15000"
                placeholderTextColor={COLORS.textDim}
              />
            </View>
            <View style={styles.flex1}>
              <Text style={styles.inputLabel}>READ TIMEOUT (MS)</Text>
              <TextInput
                style={styles.input}
                value={readTimeout}
                onChangeText={setReadTimeout}
                keyboardType="numeric"
                placeholder="35000"
                placeholderTextColor={COLORS.textDim}
              />
            </View>
          </View>

          <View style={styles.divider} />

          <Text style={styles.inputLabel}>CUSTOM HEADERS (JSON)</Text>
          <View style={styles.inputWithAction}>
            <TextInput
              style={styles.inputFlex}
              value={headersJson}
              onChangeText={setHeadersJson}
              placeholder='{"Key": "Value"}'
              placeholderTextColor={COLORS.textDim}
            />
            <TouchableOpacity
              style={styles.inlineActionButton}
              onPress={applyCustomHeaders}
              disabled={!isConnected}
            >
              <Text style={styles.inlineActionText}>SET</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.inputLabelMargin}>MANUAL LAST-EVENT-ID</Text>
          <View style={styles.inputWithAction}>
            <TextInput
              style={styles.inputFlex}
              value={manualId}
              onChangeText={setManualId}
              placeholder="id..."
              placeholderTextColor={COLORS.textDim}
            />
            <TouchableOpacity
              style={styles.inlineActionButton}
              onPress={applyManualId}
              disabled={!isConnected}
            >
              <Text style={styles.inlineActionText}>SET</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.divider} />
          <View style={styles.toggleRow}>
            <Text style={styles.configTitle}>Interceptor / Middleware</Text>
            <TouchableOpacity
              style={[
                styles.miniToggle,
                useInterceptor && { backgroundColor: COLORS.primary },
              ]}
              onPress={() => setUseInterceptor(!useInterceptor)}
            >
              <Text style={styles.miniToggleText}>
                {useInterceptor ? 'ON' : 'OFF'}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.logMessage}>
            Checks 'Authorization' header in server. Requires interceptor to
            provide it.
          </Text>
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
  divider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 15,
  },
  inputWithAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inlineActionButton: {
    backgroundColor: COLORS.primary + '20',
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.primary + '40',
  },
  inlineActionText: {
    color: COLORS.primary,
    fontSize: 10,
    fontWeight: 'bold',
  },
  inputFlex: {
    backgroundColor: COLORS.background,
    borderRadius: 8,
    padding: 10,
    color: COLORS.text,
    fontSize: 13,
    borderWidth: 1,
    borderColor: COLORS.border,
    flex: 1,
    marginBottom: 0,
  },
  inputLabelMargin: {
    color: COLORS.primary,
    fontSize: 9,
    fontWeight: 'bold',
    marginBottom: 6,
    marginTop: 12,
  },
  flex1: {
    flex: 1,
  },
  logStatus: {
    color: COLORS.textDim,
    fontSize: 9,
    fontWeight: '600',
    marginLeft: 8,
  },
  methodRow: {
    flexDirection: 'row',
    backgroundColor: COLORS.background,
    borderRadius: 8,
    padding: 2,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  methodButton: {
    flex: 1,
    height: 34,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 6,
  },
  methodButtonActive: {
    backgroundColor: COLORS.primary,
  },
  methodButtonText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: COLORS.textDim,
  },
  methodButtonTextActive: {
    color: '#fff',
  },
  multilineInput: {
    height: 60,
    textAlignVertical: 'top',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 5,
  },
  miniToggle: {
    backgroundColor: COLORS.background,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  miniToggleText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
});
