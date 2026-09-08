import { Platform } from 'react-native';
import { createNitroSse, type SseClient } from 'react-native-nitro-sse';
import { CURRENT_LIBRARY_VERSION, getBenchmarkServerUrl } from './config';

declare const HermesInternal:
  | {
    getInstrumentedStats?: () => {
      js_numGCs: number;
      js_gcCPUTime: number;
      js_allocatedBytes: number;
      js_heapSize: number;
      js_totalAllocatedBytes?: number;
    };
  }
  | undefined;

export interface BenchmarkScenario {
  name: string;
  targetRate: number; // events/sec
  batchingIntervalMs: number;
  autoParseJSON: boolean;
  durationSec: number;
  payloadSize?: number;
}

export interface HermesMetrics {
  gcCountDelta: number;
  gcCpuTimeDeltaMs: number;
  allocatedBytesDeltaKB: number;
  totalAllocatedBytesDeltaKB: number;
  finalHeapSizeKB: number;
}

export interface LatencyMetrics {
  avgMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface BenchmarkResult {
  name: string;
  targetRate: number;
  batchingIntervalMs: number;
  autoParseJSON: boolean;
  expectedEvents: number;
  totalEvents: number;
  deliveryRatePercent: number;
  totalBatches: number;
  durationMs: number;
  throughput: number;
  dataRateKBps: number;
  totalBytesReceived: number;
  avgBatchSize: string;
  latency: LatencyMetrics;
  hermesMetrics: HermesMetrics;
}

export interface BenchmarkReport {
  libraryVersion: string;
  platform: string;
  device: string;
  timestamp: number;
  results: BenchmarkResult[];
}

export const DEFAULT_BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  // Tier 1: 100 ev/s (Normal streaming load)
  {
    name: '100 ev/s | No-batch | Raw',
    targetRate: 100,
    batchingIntervalMs: 0,
    autoParseJSON: false,
    durationSec: 4,
  },
  {
    name: '100 ev/s | No-batch | JSON',
    targetRate: 100,
    batchingIntervalMs: 0,
    autoParseJSON: true,
    durationSec: 4,
  },
  {
    name: '100 ev/s | 50ms Batch | Raw',
    targetRate: 100,
    batchingIntervalMs: 50,
    autoParseJSON: false,
    durationSec: 4,
  },
  {
    name: '100 ev/s | 50ms Batch | JSON',
    targetRate: 100,
    batchingIntervalMs: 50,
    autoParseJSON: true,
    durationSec: 4,
  },

  // Tier 2: 1,000 ev/s (High-frequency / multi-channel)
  {
    name: '1,000 ev/s | No-batch | Raw',
    targetRate: 1000,
    batchingIntervalMs: 0,
    autoParseJSON: false,
    durationSec: 4,
  },
  {
    name: '1,000 ev/s | No-batch | JSON',
    targetRate: 1000,
    batchingIntervalMs: 0,
    autoParseJSON: true,
    durationSec: 4,
  },
  {
    name: '1,000 ev/s | 50ms Batch | Raw',
    targetRate: 1000,
    batchingIntervalMs: 50,
    autoParseJSON: false,
    durationSec: 4,
  },
  {
    name: '1,000 ev/s | 50ms Batch | JSON',
    targetRate: 1000,
    batchingIntervalMs: 50,
    autoParseJSON: true,
    durationSec: 4,
  },

  // Tier 3: 5,000 ev/s (Heavy stress / Burst)
  {
    name: '5,000 ev/s | No-batch | Raw (Stress Limit)',
    targetRate: 5000,
    batchingIntervalMs: 0,
    autoParseJSON: false,
    durationSec: 4,
  },
  {
    name: '5,000 ev/s | 50ms Batch | Raw',
    targetRate: 5000,
    batchingIntervalMs: 50,
    autoParseJSON: false,
    durationSec: 4,
  },
  {
    name: '5,000 ev/s | 50ms Batch | JSON',
    targetRate: 5000,
    batchingIntervalMs: 50,
    autoParseJSON: true,
    durationSec: 4,
  },

  // Tier 4: 10,000 ev/s (Peak / Extreme throughput)
  {
    name: '10,000 ev/s | 50ms Batch | Raw',
    targetRate: 10000,
    batchingIntervalMs: 50,
    autoParseJSON: false,
    durationSec: 4,
  },
  {
    name: '10,000 ev/s | 50ms Batch | JSON',
    targetRate: 10000,
    batchingIntervalMs: 50,
    autoParseJSON: true,
    durationSec: 4,
  },
];

/**
 * Re-export server host resolver for backward compatibility.
 */
export const getDefaultServerHost = getBenchmarkServerUrl;

let cachedClockOffsetMs: number | null = null;

/**
 * Calibrates clock offset between client and benchmark server using Cristian's algorithm.
 * offset = clientTime - (serverTime + RTT / 2)
 */
export async function calibrateClockOffset(
  serverHost: string = getBenchmarkServerUrl(),
  samples: number = 3
): Promise<number> {
  const offsets: number[] = [];
  for (let i = 0; i < samples; i++) {
    try {
      const t0 = Date.now();
      const res = await fetch(`${serverHost}/health`);
      const data = (await res.json()) as { serverTime?: number };
      const t1 = Date.now();
      if (typeof data?.serverTime === 'number') {
        const rtt = Math.max(0, t1 - t0);
        const clientMid = t0 + Math.round(rtt / 2);
        offsets.push(clientMid - data.serverTime);
      }
    } catch {
      // Ignore network errors during calibration
    }
  }
  if (offsets.length > 0) {
    offsets.sort((a, b) => a - b);
    cachedClockOffsetMs = offsets[Math.floor(offsets.length / 2)] ?? 0;
  } else {
    cachedClockOffsetMs = 0;
  }
  return cachedClockOffsetMs;
}

/**
 * Formats a benchmark result into a readable multi-line summary string.
 */
export function formatBenchmarkResult(r: BenchmarkResult): string {
  const lines = [
    `[${r.name}]`,
    `Throughput: ${r.throughput.toLocaleString()} ev/s (${r.dataRateKBps.toLocaleString()} KB/s) | Delivery: ${r.deliveryRatePercent}%`,
    `Latency: avg ${r.latency.avgMs}ms | p95 ${r.latency.p95Ms}ms | max ${r.latency.maxMs}ms`,
    `Batches: ${r.totalBatches.toLocaleString()} (avg size: ${r.avgBatchSize})`,
    `Hermes GCs: +${r.hermesMetrics.gcCountDelta} (${r.hermesMetrics.gcCpuTimeDeltaMs}ms CPU)`,
    `Alloc Churn: +${r.hermesMetrics.totalAllocatedBytesDeltaKB.toLocaleString()} KB`,
    `Live Heap Δ: ${r.hermesMetrics.allocatedBytesDeltaKB >= 0 ? '+' : ''}${r.hermesMetrics.allocatedBytesDeltaKB} KB | Final: ${r.hermesMetrics.finalHeapSizeKB} KB`,
  ];
  return lines.join('\n');
}

/**
 * Runs a single benchmark scenario.
 */
export async function runSingleScenario(
  scenario: BenchmarkScenario,
  serverHost: string = getBenchmarkServerUrl()
): Promise<BenchmarkResult> {
  if (cachedClockOffsetMs === null) {
    await calibrateClockOffset(serverHost);
  }

  return new Promise((resolve) => {
    const sse: SseClient = createNitroSse();
    let eventCount = 0;
    let batchCount = 0;
    let startTime = 0;
    let isSettled = false;
    const latencies: number[] = [];

    const initialStats = HermesInternal?.getInstrumentedStats?.();
    const url = `${serverHost}/sse?rate=${scenario.targetRate}&duration=${scenario.durationSec}&size=${scenario.payloadSize ?? 128
      }`;

    let safetyTimeout: ReturnType<typeof setTimeout>;

    const finish = () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(safetyTimeout);

      const durationMs =
        startTime > 0 ? performance.now() - startTime : scenario.durationSec * 1000;
      const finalStats = HermesInternal?.getInstrumentedStats?.();
      const sseStats = sse.getStats();

      try {
        sse.stop();
      } catch {
        // ignore teardown errors
      }

      const safeDurationMs = Math.max(1, Math.round(durationMs));
      const durationSec = safeDurationMs / 1000;
      const throughput = Math.round(eventCount / durationSec);
      const dataRateKBps = Math.round((sseStats.totalBytesReceived / 1024) / durationSec);
      const avgBatchSize = (eventCount / Math.max(1, batchCount)).toFixed(1);
      const expectedEvents = scenario.targetRate * scenario.durationSec;
      const deliveryRatePercent = Math.min(
        100,
        Math.round((eventCount / Math.max(1, expectedEvents)) * 100)
      );

      // Latency percentile calculations
      latencies.sort((a, b) => a - b);
      const avgLatencyMs =
        latencies.length > 0
          ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)
          : 0;
      const p95Index = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
      const p95LatencyMs = latencies[p95Index] ?? 0;
      const maxLatencyMs = latencies[latencies.length - 1] ?? 0;

      const initialTotalAlloc =
        initialStats?.js_totalAllocatedBytes ?? initialStats?.js_allocatedBytes ?? 0;
      const finalTotalAlloc =
        finalStats?.js_totalAllocatedBytes ?? finalStats?.js_allocatedBytes ?? 0;
      const totalAllocatedDeltaKB = Math.max(
        0,
        Math.round((finalTotalAlloc - initialTotalAlloc) / 1024)
      );

      const liveAllocatedDeltaKB = Math.round(
        ((finalStats?.js_allocatedBytes ?? 0) - (initialStats?.js_allocatedBytes ?? 0)) / 1024
      );

      const result: BenchmarkResult = {
        name: scenario.name,
        targetRate: scenario.targetRate,
        batchingIntervalMs: scenario.batchingIntervalMs,
        autoParseJSON: scenario.autoParseJSON,
        expectedEvents,
        totalEvents: eventCount,
        deliveryRatePercent,
        totalBatches: batchCount,
        durationMs: safeDurationMs,
        throughput,
        dataRateKBps,
        totalBytesReceived: sseStats.totalBytesReceived,
        avgBatchSize,
        latency: {
          avgMs: avgLatencyMs,
          p95Ms: p95LatencyMs,
          maxMs: maxLatencyMs,
        },
        hermesMetrics: {
          gcCountDelta: (finalStats?.js_numGCs ?? 0) - (initialStats?.js_numGCs ?? 0),
          gcCpuTimeDeltaMs: Math.round(((finalStats?.js_gcCPUTime ?? 0) - (initialStats?.js_gcCPUTime ?? 0)) * 1000) / 1000,
          allocatedBytesDeltaKB: liveAllocatedDeltaKB,
          totalAllocatedBytesDeltaKB: totalAllocatedDeltaKB,
          finalHeapSizeKB: Math.round((finalStats?.js_heapSize ?? 0) / 1024),
        },
      };

      resolve(result);
    };

    // Safety timeout in case close event isn't fired
    safetyTimeout = setTimeout(finish, (scenario.durationSec + 4) * 1000);

    sse.setup(
      {
        url,
        batchingIntervalMs: scenario.batchingIntervalMs,
        autoParseJSON: scenario.autoParseJSON,
      },
      (batch) => {
        const clockOffset = cachedClockOffsetMs ?? 0;
        const now = Date.now() - clockOffset;
        if (eventCount === 0) {
          startTime = performance.now();
        }
        batchCount++;
        eventCount += batch.length;

        // Sample latency from events
        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];
          if (!item) continue;
          let eventTs = 0;
          if (item.parsedData && typeof item.parsedData.ts === 'number') {
            eventTs = item.parsedData.ts;
          } else if (item.data) {
            const match = item.data.match(/"ts":(\d+)/);
            if (match?.[1]) {
              eventTs = parseInt(match[1], 10);
            }
          }
          if (eventTs > 0) {
            latencies.push(Math.max(0, now - eventTs));
          }
        }
      }
    );

    sse.addEventListener('close', () => {
      finish();
    });

    sse.addEventListener('error', (err) => {
      console.warn(`[Benchmark] Error during "${scenario.name}":`, err.message);
      setTimeout(finish, 200);
    });

    sse.start();
  });
}

/**
 * Runs the full benchmark matrix and reports to console + Node.js server.
 */
export async function runSseBenchmarkMatrix(
  serverHost: string = getBenchmarkServerUrl(),
  onProgress?: (progress: {
    current: number;
    total: number;
    scenario: string;
    result?: BenchmarkResult;
  }) => void
): Promise<BenchmarkReport> {
  const results: BenchmarkResult[] = [];
  const total = DEFAULT_BENCHMARK_SCENARIOS.length;

  console.log(`[Benchmark] Starting SSE benchmark suite against ${serverHost}...`);
  const initialOffset = await calibrateClockOffset(serverHost);
  console.log(`[Benchmark] Calibrated client-server clock offset: ${initialOffset}ms`);

  for (let i = 0; i < total; i++) {
    const scenario = DEFAULT_BENCHMARK_SCENARIOS[i];
    if (!scenario) continue;
    onProgress?.({ current: i + 1, total, scenario: scenario.name });
    console.log(`[Benchmark] Running [${i + 1}/${total}]: ${scenario.name}...`);

    const result = await runSingleScenario(scenario, serverHost);
    results.push(result);
    onProgress?.({ current: i + 1, total, scenario: scenario.name, result });

    // Cool down between scenarios and attempt GC stabilization
    const globalAny = global as { gc?: () => void };
    if (typeof globalAny.gc === 'function') {
      try {
        globalAny.gc();
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const report: BenchmarkReport = {
    libraryVersion: CURRENT_LIBRARY_VERSION,
    platform: Platform.OS,
    device:
      Platform.select({
        ios: 'iOS Simulator/Device',
        android: 'Android Emulator/Device',
      }) ?? 'Unknown',
    timestamp: Date.now(),
    results,
  };

  // POST report back to the benchmark server terminal
  try {
    await fetch(`${serverHost}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
    console.log('[Benchmark] Report submitted to benchmark server successfully.');
  } catch (err) {
    console.warn('[Benchmark] Could not send report to server:', (err as Error).message);
  }

  return report;
}
