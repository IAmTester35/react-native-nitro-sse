# Technical Architecture — react-native-nitro-sse

This document explains the technical architecture of `react-native-nitro-sse`, including the Nitro Modules JSI layer, Threading Serialization model, Backpressure Buffer system, Lifecycle & Network management, and React Native DevTools Inspector integration.

---

## 1. Nitro JSI Binding Architecture

Unlike legacy EventSource libraries running over the asynchronous React Native Bridge (JSON stringification overhead), `react-native-nitro-sse` uses **Nitro Modules (JSI)**:

```
[ JS Engine (QuickJS/Hermes) ]
              │ (Zero-latency direct C++ JSI call)
              ▼
[ HybridObject C++ Glue (nitrogen/generated) ]
       ┌──────┴────────────────────────┐
       ▼                               ▼
[ Swift (iOS) ]                [ Kotlin (Android) ]
LDSwiftEventSource             OkHttp SSE
DispatchQueue (.utility)       HandlerThread ("NitroSseThread")
```

- **Spec Interface (`src/NitroSse.nitro.ts`)**: Declares the `NitroSse` TypeScript interface extending `HybridObject<{ ios: 'swift'; android: 'kotlin' }>`.
- **Nitrogen CLI**: Scans `NitroSse.nitro.ts` and automatically generates C++ headers, Swift protocols (`HybridNitroSseSpec`), and Kotlin abstract classes in `nitrogen/generated/`.
- **Autolinking (`nitro.json`)**: Configures `cxxNamespace: ["nitrosse"]`, native Swift implementation class `NitroSse`, and Kotlin implementation class `NitroSse`.

---

## 2. Threading Serialization Model

To eliminate race conditions from continuous socket streaming and prevent crashes when invoking callbacks on the JS thread, the library enforces **Single-Threaded Native Serialization**:

### iOS Dispatcher (`SseDispatcher`)
- Uses a dedicated `DispatchQueue` labeled `com.margelo.nitro.sse` with QoS `.utility`.
- `SseDispatchQueueDispatcher` wraps this queue and attaches a `DispatchSpecificKey` to verify `isCurrentDispatcher()` and `assertOnQueue()`.
- All mutable state variables (`isRunning`, `config`, `eventSource`, `lastProcessedId`, `connectionAttemptVersion`) **MUST be read/written exclusively on this dispatcher queue**.

### Android Dispatcher (`SseDispatcher`)
- Initializes a dedicated `android.os.HandlerThread("NitroSseThread")`.
- `AndroidSseDispatcher` wraps an `android.os.Handler` to dispatch all connection, teardown, logging, and event processing tasks onto this background looper thread.
- Dispatched events to JS (`onEvent`) pass through `mainDispatcher` (`Handler(Looper.getMainLooper())`) to ensure thread safety with JSI/React Native UI thread requirements.

---

## 3. Backpressure & Event Buffering (`SseEventBuffer`)

Under high-frequency SSE streams (e.g., AI streaming tokens at 100+ chunks/second), delivering each event individually to the JS thread would overload the JSI bridge and drop UI frame rates.

```
Incoming SSE Chunks (Native Thread)
       │
       ▼
┌──────────────────────────────────────────┐
│ SseEventBuffer                           │
│ - Append event into internal array       │
│ - Check maxBufferSize (default: 1000)    │
│ - Timer: batchingIntervalMs (default: 0) │
└──────────────────────────────────────────┘
       │
       ▼ (Flush Array Batch)
JS Callback `onEvent(events: SseEvent[])`
```

- **`batchingIntervalMs`**: If > 0, events accumulate in native memory and flush to JS at fixed interval windows.
- **`maxBufferSize`**: Memory safety threshold (default 1000). When pending events exceed this limit, `SseEventBuffer` forces an immediate `flush()` to JS regardless of `batchingIntervalMs`.
- **Manual Flush**: JS can explicitly trigger `client.flush()` to force immediate dispatch of buffered events.

---

## 4. Reconnection & Attempt Versioning (`SseReconnectStrategy`)

To prevent race conditions caused by stale async callbacks arrived after a client reset or restart:

1. **`connectionAttemptVersion` Counter**: Increments by 1 on every `start()`, `stop()`, or `restart()`.
2. **Stale Callback Guard**: Every network listener/callback compares its `attemptVersion` with `self.connectionAttemptVersion`. If mismatched, the callback aborts immediately without mutating client state.
3. **Exponential Backoff & Jitter**:
   - `retryIntervalMs` (default: 1000ms), `maxRetryIntervalMs` (default: 30000ms).
   - Random jitter (default factor: 0.5) avoids thundering herd server overload during recovery.
4. **Input Parameter Hardening & Validation**:
   - iOS (`SseReconnectStrategy.swift`) and Android (`SseReconnectStrategy.kt`, `SseEventBuffer.swift`, `SseEventBuffer.kt`) strictly validate `retryIntervalMs`, `maxRetryIntervalMs`, `jitterFactor`, `maxReconnectAttempts`, and `maxBufferSize`.
   - If values are `NaN`, `infinity`, or negative (except `maxReconnectAttempts: -1`), fallback default values are applied. `jitterFactor` is clamped to `[0.0, 1.0]`.
5. **Header `Retry-After` Handling**: On HTTP 429 or 503 responses containing a `Retry-After` header, the client honors the specified delay plus 0.5s - 1.5s randomized jitter before retrying.
6. **Token Refresh Interceptor (`onBeforeRequest`)**:
   - Executes before every connection attempt (and auto-reconnect) to refresh expired tokens.
   - Protected by a timeout (`connectionTimeoutMs`) to prevent unhandled JS Promises from hanging native threads indefinitely.
   - On HTTP 401/403, triggers `onBeforeRequest` to refresh auth tokens up to `maxAuthRetries` (3 attempts).

---

## 5. Mobile Lifecycle & Network Monitoring

### Lifecycle Hibernation (`SseLifecycleManager`)
- **iOS**: Listens to `UIApplication.didEnterBackgroundNotification` and `willEnterForegroundNotification`.
  - If `backgroundExecution == false`: Flushes pending events, closes socket, marks `wasRunningBeforeHibernation = true`, conserving battery. Automatically resumes stream when returning to foreground.
  - If `backgroundExecution == true`: Requests `beginBackgroundTask` to extend socket activity as permitted by iOS.
- **Android**: Listens to lifecycle events via `ProcessLifecycleOwner.get().lifecycle`.
  - Automatically hibernates socket when app is minimized to background and resumes on foreground restoration.

### Network Monitoring (`SseNetworkMonitor`)
- **iOS**: Monitors network interface changes via `Network.framework` (`NWPathMonitor`).
- **Android**: Listens to connectivity changes via `ConnectivityManager.NetworkCallback` with `NetworkCapabilities`.
- **Generation Tracking (`monitorGeneration`)**: Increments a generation counter when starting or stopping path monitoring to discard delayed async network callbacks from previous monitor instances.
- On connection loss: Transitions state to `PAUSED` and pauses socket. Automatically resumes when network becomes available.
- On interface transition (WiFi <-> Cellular) while active: Proactively triggers `restart()` to route streaming traffic over the new interface.

---

## 6. RN DevTools Inspector Integration

Enables live SSE stream monitoring in **React Native DevTools Network Inspector** (RN 0.83+):

- **iOS**: `NitroSseNetworkInspector` (Objective-C++ class) calls React Native C++ core APIs (`RCTNetworkTask` / Inspector hooks) to emit `reportRequestStart`, `reportResponseStart`, `reportResponseEnd`, and `reportRequestFailed`.
- **Android**: `NetworkInspector` (Kotlin class) interfaces with React Native Network Interceptor to log requests, responses, and cumulative byte size (`totalBytesReceived`).

---

## 7. JS Client & Mock Streaming Engine

The `NitroSseClient.ts` wrapper encapsulates the native JSI object and provides:

- **Typed Event Listeners (`addEventListener` / `removeEventListener`)**: Emits events by standard `type` (`message`, `open`, `error`, `close`, `heartbeat`, `state`) or custom SSE event names (`event.event`).
- **Connection State API (`getState()`)**: Returns active `SseState` (`idle`, `connecting`, `open`, `stale`, `reconnecting`, `paused`, `closed`, `failed`).
- **Mocking Engine (`SseMockConfig`)**:
  - `mode: 'replace'`: Simulates stream entirely in JS without initiating native sockets, accurately simulating `SseState` transitions (`connecting` -> `open` -> `reconnecting` / `closed`) and emitting `'state'` events.
  - `mode: 'inject'`: Connects to real endpoints while injecting simulated custom mock events into the stream.
  - Supports configurable stream rate (`eventsPerSecond`), `looping`, randomized error rates (`errorRate`), and per-event custom delay (`delayMs`).
  - Automatically stripped out in production environments (`!__DEV__`).
