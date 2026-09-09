---
name: sse-benchmark
description: Comprehensive workflow, execution guide, and troubleshooting playbook for running high-throughput SSE benchmarks on iOS and Android with react-native-nitro-sse. Use when running benchmarks, comparing Android vs iOS performance, investigating clock drift, diagnosing event coalescing, evaluating latency/throughput, or analyzing Hermes GC impact.
---

# SSE Benchmark & Performance Playbook

This skill provides operational procedures, architectural details, and troubleshooting knowledge for running and analyzing Server-Sent Events (SSE) benchmarks in `react-native-nitro-sse`.

---

## 1. Benchmark Suite Architecture

The benchmark system consists of two coordinated components:

```
┌────────────────────────────────────────────────────────┐
│ Node.js Benchmark Server (example/script/sse-benchmark-server.mjs) │
│ - Port 3100 (configurable via PORT)                   │
│ - Endpoints: /events (SSE stream), /health (Status)   │
│ - Precise event emission: setInterval / chunk batching │
│ - Header injection: X-Server-Time for clock sync       │
└──────────────────────────┬─────────────────────────────┘
                           │ HTTP/1.1 or HTTP/2 SSE
                           ▼
┌────────────────────────────────────────────────────────┐
│ React Native Benchmark Harness (example/src/sseBenchmark.ts) │
│ - Multi-scenario test runner (100 to 10,000 ev/s)      │
│ - Cristian's algorithm clock calibration (serverTime)  │
│ - Raw & JSON payload validation                        │
│ - No-batch vs 50ms batching modes                      │
│ - Hermes GC & Memory Heap telemetry (HermesInternal)   │
│ - Automatic result persistence (example/benchmark-results/) │
└────────────────────────────────────────────────────────┘
```

### Key Files

- Server: [`example/script/sse-benchmark-server.mjs`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/example/script/sse-benchmark-server.mjs)
- Client Runner: [`example/src/sseBenchmark.ts`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/example/src/sseBenchmark.ts)
- Results Directory: [`example/benchmark-results/`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/example/benchmark-results/)

---

## 2. Standard Benchmark Scenarios

The suite evaluates 13 distinct scenarios to test throughput limits, JSI bridge overhead, batching efficiency, and memory stability:

| #   | Scenario                          | Target Rate | Payload    | Batching Mode    | Primary Focus                                     |
| --- | --------------------------------- | ----------- | ---------- | ---------------- | ------------------------------------------------- |
| 0   | 100 ev/s \| No-batch \| Raw       | 100 ev/s    | 128 B text | Disabled (`0ms`) | Baseline latency & 1:1 event dispatch             |
| 1   | 100 ev/s \| No-batch \| JSON      | 100 ev/s    | 128 B JSON | Disabled (`0ms`) | Baseline JSON parse overhead                      |
| 2   | 100 ev/s \| 50ms Batch \| Raw     | 100 ev/s    | 128 B text | 50ms window      | Batching overhead at low frequency                |
| 3   | 100 ev/s \| 50ms Batch \| JSON    | 100 ev/s    | 128 B JSON | 50ms window      | Batch JSON processing                             |
| 4   | 1,000 ev/s \| No-batch \| Raw     | 1,000 ev/s  | 128 B text | Disabled (`0ms`) | Moderate JSI bridge call frequency                |
| 5   | 1,000 ev/s \| No-batch \| JSON    | 1,000 ev/s  | 128 B JSON | Disabled (`0ms`) | Moderate parse throughput                         |
| 6   | 1,000 ev/s \| 50ms Batch \| Raw   | 1,000 ev/s  | 128 B text | 50ms window      | High-efficiency batching (~50 ev/batch)           |
| 7   | 1,000 ev/s \| 50ms Batch \| JSON  | 1,000 ev/s  | 128 B JSON | 50ms window      | Batching + parsing throughput                     |
| 8   | 5,000 ev/s \| No-batch \| Raw     | 5,000 ev/s  | 128 B text | Disabled (`0ms`) | High-frequency raw JSI bridge without batching    |
| 9   | 5,000 ev/s \| 50ms Batch \| Raw   | 5,000 ev/s  | 128 B text | 50ms window      | High-throughput streaming (~250 ev/batch)         |
| 10  | 5,000 ev/s \| 50ms Batch \| JSON  | 5,000 ev/s  | 128 B JSON | 50ms window      | High-throughput JSON streaming                    |
| 11  | 10,000 ev/s \| 50ms Batch \| Raw  | 10,000 ev/s | 128 B text | 50ms window      | **Extreme throughput** (~500 ev/batch, >1.2 MB/s) |
| 12  | 10,000 ev/s \| 50ms Batch \| JSON | 10,000 ev/s | 128 B JSON | 50ms window      | Extreme throughput with JSON serialization        |

---

## 3. Step-by-Step Execution Workflow

### Step 1: Start the Benchmark Server

Run the standalone Node.js server on the host machine:

```bash
node example/script/sse-benchmark-server.mjs
```

The server binds to `0.0.0.0:3100` and displays:

```
SSE Benchmark Server running on http://localhost:3100
Endpoints:
  GET /events?rate=1000&size=128&duration=4
  GET /health
```

### Step 2: Configure Network Forwarding

- **iOS Simulator:** Connects directly via `http://localhost:3100/events` or host IP.
- **Android Emulator:**
  Android emulators route host machine localhost through reverse proxy:
  ```bash
  adb reverse tcp:3100 tcp:3100
  ```
  _(Alternative fallback: use `http://10.0.2.2:3100/events`)._
- **Physical Devices:** Use host machine LAN IP (e.g. `http://192.168.1.x:3100/events`) and ensure firewall allows port 3100.

### Step 3: Run the Example App

```bash
# For iOS
yarn example ios

# For Android
yarn example android
```

> [!WARNING] > **Native Recompilation Gotcha:** Metro Hot Reload only pushes TypeScript changes. If modifying native code (`android/` Kotlin or `ios/` Swift), Metro reload will NOT update native logic. You must rebuild and reinstall the native binary:
>
> - Android: `cd example/android && ./gradlew installDebug` or `yarn example android`
> - iOS: Rebuild from Xcode or `yarn example ios`.

### Step 4: Execute Suite & Review Output

In the example app UI, trigger the benchmark suite.

- Live progress logs to Metro console / adb logcat.
- Detailed ASCII summary table prints to console upon completion.
- JSON results are automatically written to:
  `example/benchmark-results/<ISO_TIMESTAMP>-v<VERSION>-<PLATFORM>.json`

---

## 4. Key Metrics & Interpretation

| Metric                       | Healthy Target                           | Interpretation                                                                                                                            |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Delivery %**               | `100%`                                   | Ratio of received events to sent events. Any value <100% indicates dropped packets or early timeout.                                      |
| **Throughput (ev/s)**        | ≥ 95% of target                          | Actual delivered event rate. Drift-compensated node emitter maintains ~100% nominal emission.                                            |
| **Data Throughput**          | ~12 KB/s (100) to >1.1 MB/s (10k)        | Logical byte payload delivery rate.                                                                                                       |
| **Avg Latency (No-batch)**   | `0 – 2 ms`                               | Transit + JSI dispatch time. Should be near-zero with direct JSI callbacks.                                                               |
| **Avg Latency (50ms Batch)** | `25 – 30 ms`                             | Theoretical average of uniform arrival in a 50ms window is `50 / 2 = 25ms`. Processing overhead is `Avg Latency - 25ms` (healthy: ≤ 5ms). |
| **P95 Latency (50ms Batch)** | `48 – 52 ms`                             | Should not exceed the batch interval plus network transit time.                                                                           |
| **Batches Count**            | ~80–84 batches (for 4s duration at 50ms) | `4000ms / 50ms = 80`. Values around 80 indicate clean timer intervals. Values ~160 indicate unwanted double-fires.                        |
| **Hermes GCs**               | 0–10 GCs over entire 40k event run       | Frequency of garbage collections. Lower is better.                                                                                        |
| **GC CPU Time**              | < 10 ms                                  | Total thread pause caused by GC. Ephemeral SSE payloads are reclaimed in nursery with ~0.5–1ms per minor GC pause.                        |
| **Heap Memory**              | Stable (8 MB – 16 MB)                    | Heap must remain stable across scenarios without monotonic growth (no memory leak).                                                       |

---

## 5. Diagnostic Playbook for Platform Discrepancies Example

### Anomaly A: Android Latency Shows +100ms to +200ms vs iOS

- **Root Cause:** AVD (Android Virtual Device / QEMU) system clock drift relative to host macOS clock. Latency calculated as `Date.now() - event.timestamp` is skewed by clock difference.
- **Diagnosis:** Check emulator clock offset:
  ```bash
  adb shell date +%s%3N && date +%s%3N
  ```
- **Solution:** Use Cristian's Clock Synchronization Algorithm (already implemented in `sseBenchmark.ts`):
  1. Client sends pre-flight request to `/health`.
  2. Server responds with `serverTime: Date.now()`.
  3. Client calculates `clockOffset = (t0 + t1)/2 - serverTime`.
  4. Client adjusts latency: `latency = clientNow - eventTs - clockOffset`.

### Anomaly B: No-batch Shows `avgBatchSize > 1.0` on Android

- **Root Cause:** Event coalescing in `SseEventBuffer.kt`. If the dispatcher posts a flush runnable to the tail of the `HandlerThread` queue, subsequent incoming events push to the list before the flush executes, turning 1-by-1 dispatches into batches of 4–8.
- **Solution:** Check thread context via `dispatcher.isCurrentDispatcher()`. When `batchingIntervalMs <= 0.0` and already on the dispatcher thread, execute `flushSync()` immediately without posting an async message.

### Anomaly C: 50ms Batch Yields ~160 Batches Instead of ~80

- **Root Cause:** Timer not cancelled on out-of-band or forced flushes. If a flush occurred, the pending `postDelayed` runnable remained active and fired shortly thereafter (~25ms interval).
- **Solution:** Call `dispatcher.removeCallbacks(flushRunnable)` before any manual or scheduled flush to guarantee clean window intervals.

### Anomaly D: Android Reports +15% More Bytes Than iOS

- **Root Cause:** Android counted wire bytes (including HTTP headers, chunk delimiters, and gzip framing via OkHttp interceptor), while iOS counted logical UTF-8 string bytes (`data + type + id + comment`).
- **Solution:** Standardize on **logical UTF-8 byte accounting** across all platforms in `NitroSse.kt` and `NitroSse.swift`:
  ```kotlin
  val bytes = event.data.toByteArray(Charsets.UTF_8).size +
              event.eventType.toByteArray(Charsets.UTF_8).size +
              event.id.toByteArray(Charsets.UTF_8).size
  totalBytesReceived.addAndGet(bytes.toLong())
  ```
