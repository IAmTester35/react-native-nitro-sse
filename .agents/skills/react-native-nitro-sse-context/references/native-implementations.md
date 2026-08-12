# Native Implementations — react-native-nitro-sse

This document provides a detailed breakdown of the native source code implementations on **iOS (Swift)** and **Android (Kotlin)** within `react-native-nitro-sse`.

---

## 1. iOS Implementation (`ios/`)

The iOS implementation is built on top of `LDSwiftEventSource` (LaunchDarkly's official EventSource parser) wrapped with thread-safe dispatchers.

### iOS Module List

1. **`NitroSse.swift`**:
   - Primary class inheriting from `HybridNitroSseSpec`.
   - Implements JSI spec methods: `setup`, `start`, `stop`, `restart`, `flush`, `setLastProcessedId`, `updateHeaders`, `getStats`, `getState`.
   - Listens to `SseConnectionDelegate` to handle open events, message chunks, heartbeat comments, and socket failures.
2. **`SseConnectionHandler.swift`**:
   - Instantiates and configures `EventSource` from `LDSwiftEventSource`.
   - Configures custom HTTP Headers (`Last-Event-ID`, `Authorization`, etc.), HTTP method (GET/POST), and connect/read timeouts.
3. **`SseDispatchQueueDispatcher.swift` & `SseDispatcher.swift`**:
   - `SseDispatcher` protocol defines the threading queue interface.
   - `SseDispatchQueueDispatcher` wraps `DispatchQueue(label: "com.margelo.nitro.sse", qos: .utility)` ensuring all state mutations execute on a single background queue.
4. **`SseEventBuffer.swift`**:
   - Manages buffering of `SseEvent` objects in native memory.
   - Schedules batch flushing via `DispatchSourceTimer` based on `batchingIntervalMs` or forces immediate flushing upon reaching `maxBufferSize`.
   - Provides static helper `parseJsonToAnyMap(_:)` to decode raw JSON strings into native dictionary structures (`AnyMap`) on background threads.
5. **`SseLifecycleManager.swift`**:
   - Registers NotificationCenter observers for `UIApplication.didEnterBackgroundNotification` and `willEnterForegroundNotification`.
   - Manages `UIBackgroundTaskIdentifier` to extend background execution when `backgroundExecution: true`.
6. **`SseNetworkMonitor.swift`**:
   - Uses `Network.framework` (`NWPathMonitor`) to detect internet loss or network interface switching (WiFi -> Cellular).
   - Employs `monitorGeneration` tracking to safely discard path update callbacks from stale monitor instances.
7. **`SseReconnectStrategy.swift`**:
   - Calculates delay duration (in milliseconds) for subsequent reconnect attempts using Exponential Backoff with Random Jitter.
   - Enforces parameter validation for `retryIntervalMs`, `maxRetryIntervalMs`, `jitterFactor`, and `maxReconnectAttempts`, applying defaults for `NaN`, infinity, or invalid negative values.
8. **`NitroSseNetworkInspector.mm` / `.h`**:
   - Objective-C++ file serving as a bridge to React Native C++ core Network Inspector APIs.

---

## 2. Android Implementation (`android/`)

The Android implementation is built on **OkHttp SSE** (`okhttp3.sse.EventSource`) and **Android ProcessLifecycleOwner**.

### Android Module List (`com.margelo.nitro.nitrosse`)

1. **`NitroSse.kt`**:
   - Core class implementing `HybridNitroSseSpec`, annotated with `@DoNotStrip`.
   - Manages OkHttp SSE connection lifecycle, thread safety via `AndroidSseDispatcher`, and JS bridge interaction.
   - Provides a secondary constructor for virtual-time dispatcher injection during unit testing.
2. **`SseConnectionHandler.kt`**:
   - Wraps OkHttp's `EventSourceListener`. Forwards `onOpen`, `onEvent`, `onClosed`, and `onFailure` callbacks to `SseConnectionDelegate`.
3. **`AndroidSseDispatcher.kt` & `SseDispatcher.kt`**:
   - Wraps an `android.os.HandlerThread("NitroSseThread")` and `Handler` to serialize all execution onto a dedicated background thread.
4. **`SseEventBuffer.kt`**:
   - Accumulates native `SseEvent` items and executes the JS callback (`onEvent`) via `mainDispatcher` (`Handler(Looper.getMainLooper())`).
   - Validates `maxBufferSize` thresholds against invalid numbers (`NaN`, infinity, <= 0).
5. **`SseLifecycleManager.kt`**:
   - Uses Android Jetpack's `DefaultLifecycleObserver` registered with `ProcessLifecycleOwner.get().lifecycle` to observe `ON_STOP` (app background) and `ON_START` (app foreground).
6. **`SseNetworkMonitor.kt`**:
   - Registers a `ConnectivityManager.NetworkCallback` to listen to network availability changes (`onAvailable`, `onLost`, `onCapabilitiesChanged`).
   - Employs `monitorGeneration` tracking to ignore stale callback dispatches during start/stop cycles.
7. **`SseReconnectStrategy.kt`**:
   - Manages retry attempt counts (`currentReconnectAttempts`) and calculates delay durations with random Jitter (`Random.nextInt`).
8. **`JsonUtils.kt`**:
   - Uses `org.json.JSONObject` and `org.json.JSONArray` to parse raw JSON strings into `ArrayMap<String, Any?>` (`AnyMap`) on background threads.
9. **`NetworkInspector.kt`**:
   - Reports network requests and byte counts to React Native Network Inspector for DevTools integration.

---

## 3. iOS - Android Component Mapping

| Feature | iOS (Swift) | Android (Kotlin) |
|---|---|---|
| Socket Parser Engine | `LDSwiftEventSource.EventSource` | `okhttp3.sse.EventSources` |
| Thread Serializer | `SseDispatchQueueDispatcher` (`GCD`) | `AndroidSseDispatcher` (`HandlerThread`) |
| App Lifecycle Observer | `SseLifecycleManager` (`NotificationCenter`) | `SseLifecycleManager` (`ProcessLifecycleOwner`) |
| Network Monitor | `SseNetworkMonitor` (`NWPathMonitor`) | `SseNetworkMonitor` (`ConnectivityManager`) |
| JSON Parser Offloader | `SseEventBuffer.parseJsonToAnyMap` | `JsonUtils.parseJsonToAnyMap` |
| Network Tracing | `NitroSseNetworkInspector.mm` (ObjC++) | `NetworkInspector.kt` (Kotlin) |
