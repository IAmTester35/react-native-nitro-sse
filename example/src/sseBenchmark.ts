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
  stdDevMs?: number;
}

export interface BenchmarkStdDev {
  throughput: number;
  dataRateKBps: number;
  latencyAvgMs: number;
  latencyP95Ms: number;
  latencyMaxMs: number;
  gcCpuTimeDeltaMs: number;
  totalAllocatedBytesDeltaKB: number;
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
  stdDev?: BenchmarkStdDev;
  runs?: BenchmarkResult[];
}

export interface BenchmarkMatrixOptions {
  iterations?: number;
  warmup?: boolean;
}

export interface BenchmarkReport {
  libraryVersion: string;
  platform: string;
  device: string;
  timestamp: number;
  results: BenchmarkResult[];
}

export function calcStdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
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
    name: '5,000 ev/s | No-batch | Raw',
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

export interface ClockCalibration {
  offsetMs: number;
  rttMs: number;
  errorMarginMs: number; // ± RTT / 2
}

let cachedClockCalibration: ClockCalibration | null = null;

/**
 * Calibrates clock offset between client and benchmark server using Cristian's algorithm.
 * offset = clientTime - (serverTime + RTT / 2)
 * Maximum error bound is ± RTT / 2.
 */
export async function calibrateClockOffset(
  serverHost: string = getBenchmarkServerUrl(),
  samples: number = 3
): Promise<ClockCalibration> {
  const measurements: { offset: number; rtt: number }[] = [];
  for (let i = 0; i < samples; i++) {
    try {
      const t0 = Date.now();
      const res = await fetch(`${serverHost}/health`);
      const data = (await res.json()) as { serverTime?: number };
      const t1 = Date.now();
      if (typeof data?.serverTime === 'number') {
        const rtt = Math.max(0, t1 - t0);
        const clientMid = t0 + Math.round(rtt / 2);
        measurements.push({
          offset: clientMid - data.serverTime,
          rtt,
        });
      }
    } catch {
      // Ignore network errors during calibration
    }
  }
  if (measurements.length > 0) {
    measurements.sort((a, b) => a.offset - b.offset);
    const median = measurements[Math.floor(measurements.length / 2)]!;
    cachedClockCalibration = {
      offsetMs: median.offset,
      rttMs: median.rtt,
      errorMarginMs: Math.round((median.rtt / 2) * 10) / 10,
    };
  } else {
    cachedClockCalibration = {
      offsetMs: 0,
      rttMs: 0,
      errorMarginMs: 0,
    };
  }
  return cachedClockCalibration;
}

/**
 * Formats a benchmark result into a readable multi-line summary string.
 */
export function formatBenchmarkResult(r: BenchmarkResult): string {
  const tpStr = r.stdDev?.throughput
    ? `${r.throughput.toLocaleString()} ± ${r.stdDev.throughput}`
    : r.throughput.toLocaleString();
  const latAvgStr = r.latency.stdDevMs || r.stdDev?.latencyAvgMs
    ? `${r.latency.avgMs} ± ${r.latency.stdDevMs || r.stdDev?.latencyAvgMs}ms`
    : `${r.latency.avgMs}ms`;
  const lines = [
    `[${r.name}]`,
    `Throughput: ${tpStr} ev/s (${r.dataRateKBps.toLocaleString()} KB/s) | Delivery: ${r.deliveryRatePercent}%`,
    `Latency: avg ${latAvgStr} | p95 ${r.latency.p95Ms}ms | max ${r.latency.maxMs}ms`,
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
  if (cachedClockCalibration === null) {
    await calibrateClockOffset(serverHost);
  }

  return new Promise((resolve) => {
    const sse: SseClient = createNitroSse();
    let eventCount = 0;
    let batchCount = 0;
    let startTime = 0;
    let isSettled = false;
    const latencies: number[] = [];

    // Intra-run 1-second sampling buckets for instantaneous throughput stdDev
    const secondBuckets: number[] = [];
    let currentSecondBucketCount = 0;
    let lastSecond = -1;

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

      // Close out last second bucket
      if (currentSecondBucketCount > 0) {
        secondBuckets.push(currentSecondBucketCount);
      }
      const intraThroughputStdDev = Math.round(calcStdDev(secondBuckets));

      const safeDurationMs = Math.max(1, Math.round(durationMs));
      const durationSec = safeDurationMs / 1000;
      const throughput = Math.round(eventCount / durationSec);
      const dataRateKBps = Math.round((sseStats.totalBytesReceived / 1024) / durationSec);
      const avgBatchSize = (eventCount / Math.max(1, batchCount)).toFixed(1);
      const expectedEvents = scenario.targetRate * scenario.durationSec;
      const deliveryRatePercent = Number(
        ((eventCount / Math.max(1, expectedEvents)) * 100).toFixed(1)
      );

      // Latency percentile & variance calculations
      latencies.sort((a, b) => a - b);
      const avgLatencyMs =
        latencies.length > 0
          ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)
          : 0;
      const p95Index = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
      const p95LatencyMs = latencies[p95Index] ?? 0;
      const maxLatencyMs = latencies[latencies.length - 1] ?? 0;
      const latencyVariance =
        latencies.length > 1
          ? latencies.reduce((sum, v) => sum + (v - avgLatencyMs) ** 2, 0) /
            (latencies.length - 1)
          : 0;
      const latencyStdDevMs = Math.round(Math.sqrt(latencyVariance) * 10) / 10;

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

      // Hermes js_gcCPUTime is in seconds -> convert to milliseconds, round to 2 decimals
      const rawCpuSecDelta =
        (finalStats?.js_gcCPUTime ?? 0) - (initialStats?.js_gcCPUTime ?? 0);
      const gcCpuTimeDeltaMs = Math.round(rawCpuSecDelta * 1000 * 100) / 100;

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
          stdDevMs: latencyStdDevMs,
        },
        hermesMetrics: {
          gcCountDelta: (finalStats?.js_numGCs ?? 0) - (initialStats?.js_numGCs ?? 0),
          gcCpuTimeDeltaMs,
          allocatedBytesDeltaKB: liveAllocatedDeltaKB,
          totalAllocatedBytesDeltaKB: totalAllocatedDeltaKB,
          finalHeapSizeKB: Math.round((finalStats?.js_heapSize ?? 0) / 1024),
        },
        stdDev: {
          throughput: intraThroughputStdDev,
          dataRateKBps: Math.round((intraThroughputStdDev * (scenario.payloadSize ?? 128)) / 1024),
          latencyAvgMs: latencyStdDevMs,
          latencyP95Ms: 0,
          latencyMaxMs: 0,
          gcCpuTimeDeltaMs: 0,
          totalAllocatedBytesDeltaKB: 0,
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
        const clockOffset = cachedClockCalibration?.offsetMs ?? 0;
        const now = Date.now() - clockOffset;
        let hasDataInBatch = false;

        // Filter and sample latency from benchmark data events only
        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];
          if (!item) continue;

          // Exclude protocol lifecycle events (STATE, OPEN, CLOSE)
          const isCloseEvent =
            item.event === 'close' ||
            (typeof item.data === 'string' && item.data.includes('"status":"finished"'));
          const isStateOrOpen = item.type === 'state' || item.type === 'open';
          if (isCloseEvent || isStateOrOpen) {
            continue;
          }

          if (eventCount === 0) {
            startTime = performance.now();
          }
          eventCount++;
          hasDataInBatch = true;

          // Intra-run 1-second sampling bucket
          const elapsedSec = Math.floor((performance.now() - startTime) / 1000);
          if (elapsedSec > lastSecond) {
            if (lastSecond >= 0) {
              secondBuckets.push(currentSecondBucketCount);
            }
            currentSecondBucketCount = 0;
            lastSecond = elapsedSec;
          }
          currentSecondBucketCount++;

          // Extract timestamp:
          // In JSON mode: native AnyMap produces typed object (0 JS parsing overhead).
          // In Raw mode: use low-allocation indexOf + slice baseline instead of regex.
          let eventTs = 0;
          if (item.parsedData && typeof item.parsedData.ts === 'number') {
            eventTs = item.parsedData.ts;
          } else if (typeof item.data === 'string') {
            const tsIdx = item.data.indexOf('"ts":');
            if (tsIdx !== -1) {
              const start = tsIdx + 5;
              const commaIdx = item.data.indexOf(',', start);
              const braceIdx = item.data.indexOf('}', start);
              const end = commaIdx !== -1 ? commaIdx : braceIdx !== -1 ? braceIdx : item.data.length;
              eventTs = parseInt(item.data.slice(start, end), 10);
            }
          }
          if (eventTs > 0) {
            latencies.push(Math.max(0, now - eventTs));
          }
        }

        if (hasDataInBatch) {
          batchCount++;
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
 * Supports warmup and multiple iterations with standard deviation aggregation.
 */
export async function runSseBenchmarkMatrix(
  serverHost: string = getBenchmarkServerUrl(),
  onProgress?: (progress: {
    current: number;
    total: number;
    scenario: string;
    result?: BenchmarkResult;
  }) => void,
  options?: BenchmarkMatrixOptions
): Promise<BenchmarkReport> {
  const results: BenchmarkResult[] = [];
  const total = DEFAULT_BENCHMARK_SCENARIOS.length;
  const iterations = Math.max(1, options?.iterations ?? 1);
  const shouldWarmup = options?.warmup ?? true;

  const cal = await calibrateClockOffset(serverHost);
  console.log(
    `[Benchmark] Calibrated client-server clock offset: ${cal.offsetMs}ms (RTT: ${cal.rttMs}ms, uncertainty: ±${cal.errorMarginMs}ms)`
  );

  // Optional Warmup phase to prime JIT compiler, network socket, and dispatcher threads
  if (shouldWarmup) {
    console.log('[Benchmark] Warming up runtime and network pipeline (2s)...');
    try {
      await runSingleScenario(
        {
          name: 'Warmup',
          targetRate: 200,
          batchingIntervalMs: 0,
          autoParseJSON: false,
          durationSec: 2,
        },
        serverHost
      );
    } catch {
      // Ignore warmup errors
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  for (let i = 0; i < total; i++) {
    const scenario = DEFAULT_BENCHMARK_SCENARIOS[i];
    if (!scenario) continue;
    onProgress?.({ current: i + 1, total, scenario: scenario.name });
    console.log(`[Benchmark] Running [${i + 1}/${total}]: ${scenario.name}...`);

    const scenarioRuns: BenchmarkResult[] = [];
    for (let it = 0; it < iterations; it++) {
      if (iterations > 1) {
        console.log(`  └─ Iteration ${it + 1}/${iterations}...`);
      }
      const runResult = await runSingleScenario(scenario, serverHost);
      scenarioRuns.push(runResult);
      if (it < iterations - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Aggregate metrics across iterations
    let finalResult: BenchmarkResult;
    if (scenarioRuns.length === 1) {
      finalResult = scenarioRuns[0]!;
    } else {
      const throughputs = scenarioRuns.map((r) => r.throughput);
      const dataRates = scenarioRuns.map((r) => r.dataRateKBps);
      const avgLatencies = scenarioRuns.map((r) => r.latency.avgMs);
      const p95Latencies = scenarioRuns.map((r) => r.latency.p95Ms);
      const maxLatencies = scenarioRuns.map((r) => r.latency.maxMs);
      const gcCpuTimes = scenarioRuns.map((r) => r.hermesMetrics.gcCpuTimeDeltaMs);
      const allocChurns = scenarioRuns.map(
        (r) => r.hermesMetrics.totalAllocatedBytesDeltaKB
      );

      const meanThroughput = Math.round(
        throughputs.reduce((a, b) => a + b, 0) / iterations
      );
      const meanDataRate = Math.round(
        dataRates.reduce((a, b) => a + b, 0) / iterations
      );
      const meanAvgLatency = Math.round(
        avgLatencies.reduce((a, b) => a + b, 0) / iterations
      );
      const meanP95Latency = Math.round(
        p95Latencies.reduce((a, b) => a + b, 0) / iterations
      );
      const peakMaxLatency = Math.max(...maxLatencies);
      const meanGcCpuTime =
        Math.round(
          (gcCpuTimes.reduce((a, b) => a + b, 0) / iterations) * 100
        ) / 100;
      const meanAllocChurn = Math.round(
        allocChurns.reduce((a, b) => a + b, 0) / iterations
      );
      const meanBatches = Math.round(
        scenarioRuns.reduce((a, r) => a + r.totalBatches, 0) / iterations
      );
      const meanDelivery = Number(
        (
          scenarioRuns.reduce((a, r) => a + r.deliveryRatePercent, 0) / iterations
        ).toFixed(1)
      );

      finalResult = {
        ...scenarioRuns[0]!,
        throughput: meanThroughput,
        dataRateKBps: meanDataRate,
        totalBatches: meanBatches,
        deliveryRatePercent: meanDelivery,
        latency: {
          avgMs: meanAvgLatency,
          p95Ms: meanP95Latency,
          maxMs: peakMaxLatency,
          stdDevMs: Math.round(calcStdDev(avgLatencies) * 10) / 10,
        },
        hermesMetrics: {
          ...scenarioRuns[scenarioRuns.length - 1]!.hermesMetrics,
          gcCpuTimeDeltaMs: meanGcCpuTime,
          totalAllocatedBytesDeltaKB: meanAllocChurn,
        },
        stdDev: {
          throughput: Math.round(calcStdDev(throughputs)),
          dataRateKBps: Math.round(calcStdDev(dataRates)),
          latencyAvgMs: Math.round(calcStdDev(avgLatencies) * 10) / 10,
          latencyP95Ms: Math.round(calcStdDev(p95Latencies) * 10) / 10,
          latencyMaxMs: Math.round(calcStdDev(maxLatencies) * 10) / 10,
          gcCpuTimeDeltaMs: Math.round(calcStdDev(gcCpuTimes) * 100) / 100,
          totalAllocatedBytesDeltaKB: Math.round(calcStdDev(allocChurns)),
        },
        runs: scenarioRuns,
      };
    }

    results.push(finalResult);
    onProgress?.({ current: i + 1, total, scenario: scenario.name, result: finalResult });

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
