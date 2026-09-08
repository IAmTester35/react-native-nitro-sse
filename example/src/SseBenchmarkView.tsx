import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import {
  runSseBenchmarkMatrix,
  type BenchmarkReport,
  type BenchmarkResult,
} from './sseBenchmark';
import { getBenchmarkServerUrl } from './config';

export const SseBenchmarkView: React.FC = () => {
  const [host, setHost] = useState(getBenchmarkServerUrl());
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [results, setResults] = useState<BenchmarkResult[]>([]);

  const run = useCallback(async () => {
    if (running) return;

    setRunning(true);
    setResults([]);
    setStatus('Running...');

    try {
      const report: BenchmarkReport = await runSseBenchmarkMatrix(
        host,
        ({ current, total, scenario, result }) => {
          setStatus(`[${current}/${total}] ${scenario}`);
          if (result) {
            setResults((prev) => [...prev, result]);
          }
        }
      );
      setStatus(`Completed v${report.libraryVersion}: ${report.results.length} scenarios`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`Error: ${message}`);
    } finally {
      setRunning(false);
    }
  }, [host, running]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>SSE Benchmark</Text>
          <Text style={styles.status}>{status}</Text>
        </View>
        <TouchableOpacity
          onPress={run}
          disabled={running}
          style={[styles.button, running && styles.buttonDisabled]}
        >
          {running ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Text style={styles.buttonText}>Run Matrix</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.inputRow}>
        <Text style={styles.inputLabel}>Host:</Text>
        <TextInput
          value={host}
          onChangeText={setHost}
          editable={!running}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          placeholder="http://localhost:3100"
          placeholderTextColor="#9CA3AF"
        />
      </View>

      <ScrollView style={styles.scrollArea} contentContainerStyle={styles.resultsList}>
        {results.length === 0 && !running && (
          <Text style={styles.emptyText}>Tap &quot;Run Matrix&quot; to begin stress test</Text>
        )}

        {results.map((r, index) => (
          <View key={index} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{r.name}</Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>
                  {r.autoParseJSON ? 'JSON' : 'RAW'}
                </Text>
              </View>
            </View>

            <View style={styles.grid}>
              <View style={styles.metricItem}>
                <Text style={styles.metricLabel}>Throughput</Text>
                <Text style={styles.metricValuePrimary}>
                  {r.throughput.toLocaleString()} ev/s ({r.dataRateKBps.toLocaleString()} KB/s)
                </Text>
              </View>

              <View style={styles.metricItem}>
                <Text style={styles.metricLabel}>Latency (Avg / P95 / Max)</Text>
                <Text style={styles.metricValue}>
                  {r.latency.avgMs}ms / {r.latency.p95Ms}ms / {r.latency.maxMs}ms
                </Text>
              </View>

              <View style={styles.metricItem}>
                <Text style={styles.metricLabel}>Batches / Delivery</Text>
                <Text style={styles.metricValue}>
                  {r.totalBatches.toLocaleString()} (avg {r.avgBatchSize}) | {r.deliveryRatePercent}%
                </Text>
              </View>

              <View style={styles.metricItem}>
                <Text style={styles.metricLabel}>Hermes GCs</Text>
                <Text style={styles.metricValue}>
                  +{r.hermesMetrics.gcCountDelta} ({r.hermesMetrics.gcCpuTimeDeltaMs}ms CPU)
                </Text>
              </View>

              <View style={styles.metricItem}>
                <Text style={styles.metricLabel}>Alloc Churn / Heap</Text>
                <Text style={styles.metricValue}>
                  +{r.hermesMetrics.totalAllocatedBytesDeltaKB.toLocaleString()} KB / {r.hermesMetrics.finalHeapSizeKB} KB
                </Text>
              </View>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
};

// Backward-compatible alias
export const SseBenchmarkDevButton = SseBenchmarkView;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
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
    marginTop: 2,
    fontWeight: '500',
  },
  button: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#93C5FD',
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#F9FAFB',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    gap: 8,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#4B5563',
  },
  input: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: '#111827',
  },
  scrollArea: {
    flex: 1,
  },
  resultsList: {
    padding: 16,
    gap: 12,
  },
  emptyText: {
    textAlign: 'center',
    color: '#9CA3AF',
    marginTop: 40,
    fontSize: 14,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    padding: 14,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F3F4F6',
    paddingBottom: 8,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
    flex: 1,
  },
  badge: {
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4F46E5',
  },
  grid: {
    gap: 6,
  },
  metricItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metricLabel: {
    fontSize: 12,
    color: '#6B7280',
  },
  metricValue: {
    fontSize: 12,
    fontWeight: '500',
    color: '#1F2937',
    fontVariant: ['tabular-nums'],
  },
  metricValuePrimary: {
    fontSize: 13,
    fontWeight: '700',
    color: '#16A34A',
    fontVariant: ['tabular-nums'],
  },
});