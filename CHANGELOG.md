# Changelog

## 2.4.2 (2026-08-14)

### Fixes

- **iOS**: Removed `timeoutIntervalForResource` constraint causing `URLSession` to abort SSE streams.
- **iOS**: Guarded auto-reconnect with incremented attempt versions to eliminate duplicate reconnect storms from `.shutdown`.
- **iOS**: Fixed initial `NWPathMonitor` status check falsely triggering an immediate stream restart.
- **iOS**: Added exponential backoff fallback on HTTP 429 rate limit instead of terminating the stream.
- **Android**: Added `Accept-Encoding: identity` to prevent raw Gzip byte scanning in heartbeat interceptor.
- **Android**: Guarded heartbeat events by active request ID to prevent keep-alive leaks from closed sockets.
- **Core**: Hardened reconnect versioning across Android and iOS to discard delayed callbacks from previous cycles.

### Improvements

- Cleaned up dead code, unused imports, and deduplicated logic across TypeScript, iOS, and Android.
- Fixed source entrypoint and cleaned up published files in `package.json`.

## 2.4.1 (2026-08-13)

### Fixes

- **iOS**: Prevented duplicate reconnect loops by making Nitro SSE the sole retry owner while forwarding LDSwiftEventSource failures through the existing reconnect strategy.

## 2.4.0 (2026-08-12)

### Features

- **Connection State Machine & API**: Introduced `SseState` (`idle`, `connecting`, `open`, `stale`, `reconnecting`, `paused`, `closed`, `failed`), `getState()`, and `'state'` event emitter.
- **Mock State Transitions**: Added dynamic `SseState` lifecycle events and status tracking to JS mock engine (`replace` mode).

### Improvements

- **Native Config Hardening**: Added fallback defaults for invalid (`NaN`, infinity, negative) config parameters across iOS and Android.
- **Network Monitor Safety**: Added generation tracking to `SseNetworkMonitor` on iOS/Android to discard stale callbacks on restart/teardown.
- **Architecture Refactoring**: Modularized native core (`NitroSse.swift` / `NitroSse.kt`) into dedicated components (Buffer, Reconnect, Network, Lifecycle).
- **Testing & Example**: Expanded JS, iOS (XCTest), and Android (JUnit) test coverage and updated example app dashboard.

## 2.4.0-beta.1 (2026-08-03)

### Features

- **Connection State Machine & API**: Introduced `SseState` (`idle`, `connecting`, `open`, `stale`, `reconnecting`, `pause`, `close`, `fail`) and added `getState()` method to inspect active connection state.
- **State Change Event**: Added `'state'` to `SseEventType` and `state` property to `SseEvent`, enabling event listeners to subscribe directly to connection state transitions.

### Improvements

- **iOS**: Refactored `NitroSse.swift` into smaller, maintainable modules (Buffer, Reconnect, Network, Lifecycle).
- **Android**: Refactored `NitroSse.kt` into smaller, maintainable modules (Buffer, Reconnect, Network, Lifecycle).
- **Testing**: Expanded Native Unit Tests for both iOS and Android covering connection state transitions and edge cases.
- **Example**: Updated example app UI to display real-time connection states.

## 2.3.2 (2026-07-24)

### Fixes

- **Android**: Fixed a `FATAL EXCEPTION: NitroSseThread` crash that occurred when background reconnects attempted to invoke JS callbacks after the JS runtime/Dispatcher was invalidated (e.g., during Fast Refresh or component unmount). The client now safely catches the `Dispatcher has already been destroyed!` error and gracefully stops the stream.
- **Core (Android & iOS)**: Optimized connection teardown logic to prevent flushing buffered events to a dead JS runtime, reducing unnecessary bridge overhead.
- **Android**: Hardened error boundaries by catching `Throwable` instead of `Exception` in the interceptor block to safely handle generic JNI errors.

## 2.3.1 (2026-06-16)

### Improvements

- **Dependencies Upgrade**: Updated `react-native-nitro-modules` and `nitrogen` to `0.35.9`, React Native to `0.85.3`, and React to `19.2.3`.
- **Example**: Refactored example app implementation and updated native project config for compatibility.

### Fixes

- **iOS**: Fixed background task lifetime management by running UIApplication actions on main thread to avoid leaks.
- **iOS**: Fixed DevTools Network Inspector reporting by sending correct connection start and failure status codes.

## 2.3.0 (2026-05-19)

### Features

- **JS**: Added JS-only mock streaming data engine supporting completely offline simulated streams (`replace` mode) and parallel mock event injection alongside real server streams (`inject` mode).
- **Example**: Added interactive **Mock Data Generator** configuration section inside example dashboard.
- **Dependencies Upgrade**: Updated `react-native-nitro-modules` and `nitrogen` to `0.35.6`.

## 2.2.3 (2026-04-20)

### Fixes

- **iOS**: Fixed compatibility with React Native < 0.82 by ensuring `requestId` is correctly cast to `id` when reporting network events, supporting both `NSString` and `NSNumber` identifiers.

## 2.2.2 (2026-04-18)

### Fixes

- **Android**: Fixed an infinite restart loop when `monitorNetwork` is enabled by guarding against initial network detection being treated as an "interface change."
- **Android**: Fixed a race condition in the asynchronous state machine where `restart()` could fail because a pending cleanup task would cancel the newly initiated connection attempt.

## 2.2.1 (2026-04-18)

### Fixes

- **Android**: Fixed a `SecurityException` crash when starting the connection. Added `ACCESS_NETWORK_STATE` and `INTERNET` permissions to `AndroidManifest.xml` and implemented crash-safe network monitoring registration.

## 2.2.0 (2026-04-14)

### Features

- **Network Monitoring API**: Exposed `monitorNetwork` boolean in `SseConfig`. When enabled (default), the client intelligently hibernates during system-wide network loss and resumes upon reconnections to conserve battery and CPU.
- **Dependencies Upgrade**: Updated `react-native-nitro-modules` and `nitrogen` to `0.35.4`.

### Reliability & Stability

- **iOS Memory Management**: Completely overhauled background app lifecycle handling (added exact app state tracking with `isAppInBackground` and proper `cleanupBackgroundTask()` execution) to prevent persistent background task leaks and Watchdog terminations.
- **iOS Network Resilience**: Enhanced `NWPathMonitor` integration to jump-start stream recovery without waiting for timeouts when network interfaces re-activate.
- **Android CPU/Memory Optimization**: Fixed a critical bug in JSI event dispatching where delayed flushes (`postDelayed`) were accumulating indiscriminately. Overhauled the buffering logic with `flushRunnable` to clear and resolve timer overheads.

## 2.1.1 (2026-04-02)

### Infrastructure & Maintenance

- **React Native**: Updated to `0.83.4` for improved stability and New Architecture compatibility.
- **Nitro Modules**: Synchronized `react-native-nitro-modules` and `nitrogen` versions across the library and example app to ensure consistent Codegen and build reliability on CI.
- **Package Size**: Excluded native unit tests (`ios/Tests` and `android/src/test`) from the published npm package to reduce noise and installation size for consumers.

## 2.1.0 (2026-03-31)

### Features

- **Native JSON Parsing**: Added `autoParseJSON` to `SseConfig`. When enabled, message data is parsed as JSON in the background native thread and exposed via `parsedData` in the `SseEvent`. This significantly improves performance for high-frequency or heavy-payload streams by offloading CPU-intensive JSON parsing from the JavaScript thread to the platform's native JSON engine.

### Improvements

- **Native Unit Testing**: Added a comprehensive suite of native tests for both Android (Kotlin) and iOS (Swift) to verify JSON parsing accuracy, including support for nested objects and arrays.
- **Thread Safety**: Hardened the internal state machine to ensure consistent configuration access during background processing.

## 2.0.0 (2026-03-31)

### ⚠️ Breaking Changes

- **Client Factory**: The `createNitroSse()` function now returns an `SseClient` object instead of the native `NitroSse` object. This allows for typed event listeners and internal state management. Ensure you update your type references (e.g., `useRef<SseClient>(null)`).

### Features

- **Typed Event Emitters**: Supported industry-standard `.addEventListener(type, listener)` and `.removeEventListener(type, listener)` for a more intuitive developer experience.
  - Granular logic separation based on the SSE `event:` field (e.g., `sse.addEventListener('update', ...)`).
  - Automatic dispatching to pre-defined system types: `'open'`, `'message'`, `'error'`, `'close'`, and `'heartbeat'`.
  - Fully type-safe TypeScript implementation powered by a high-performance JS wrapper.
- **Custom Reconnection Logic**: Added support for fine-tuned backoff and jitter in `SseConfig`.
  - `retryIntervalMs`: Initial delay for reconnection attempts (default: 1000ms).
  - `maxRetryIntervalMs`: Maximum delay between reconnection attempts (default: 30000ms).
  - `jitterFactor`: Randomization factor (0.0 to 1.0) to prevent the "thundering herd" problem (default: 0.5).
- **Reconnection Limits**: Added `maxReconnectAttempts` to `SseConfig`.
  - Allows limiting continuous reconnection attempts before stopping (default: `-1` for infinite, `0` to disable).

### Improvements

- **Native Logic Consistency**: Standardized the reconnection algorithm across Android (Kotlin) and iOS (Swift) to ensure predictable behavior on both platforms.
- **Testing**: Updated Android (Kotlin), iOS (Swift), and Jest unit tests to cover new algorithms and the new `SseClient` wrapper.

### Fixes

- **iOS**: Fixed a regression where `SseConfig` parameters (intervals, jitter, limits) were lost when using an `onBeforeRequest` interceptor.

## 1.6.2 (2026-03-17)

### Infrastructure

- **Nitro**: Updated `react-native-nitro-modules` and `nitrogen` to `0.35.2`.
- **Nitro**: Migrated `nitro.json` to the new platform-specific autolinking syntax introduced in 0.35.1.

## 1.6.1 (2026-03-12)

### Fixes

- **iOS**: Fixed a compilation error where `config.backgroundExecution` (Optional Bool) was used directly in an `if` statement.
- **iOS**: Resolved a Swift warning by changing an unused `var` mutation to a `let` constant in `updateHeaders`.

## 1.6.0 (2026-03-12)

### Reliability & Stability

- **Thread-Safe State Machine**: Refactored iOS threading to eliminate data races during concurrent start/stop/reload actions. Fixed potential deadlocks in `deinit` and `start()` using queue-aware `DispatchSpecificKey`. Resolved race conditions in `onBeforeRequest` interceptor to prevent overwriting updated headers.
- **Background Support**: Implemented `backgroundExecution` flag for both iOS and Android to keep streams alive in the background.
- **Zero-Loss Buffering**: Replaced tail-drop with forced flushing when `maxBufferSize` is reached.
- **Improved Timeouts**: Default `readTimeoutMs` increased to 5 minutes for better stability on idle streams.
- **Accuracy Fixes**: Fixed Android's byte counter to be cumulative across reconnections.
- **JS Reload Safety**: Synchronous native cleanup to prevent "ghost connections" during hot reloads.

### Developer Experience (DX)

- **Native Unit Tests**: Added comprehensive test suites for versioning, auth resets, and stats on both platforms.
- **JSDoc Updates**: Improved documentation and added `@default` tags for all config options.
- **Interceptor Safety**: Added native timeouts for `onBeforeRequest` to prevent app hangs.

### Infrastructure & Example

- **Example App**: Refactored architecture and added a detailed event inspector.

## 1.5.0 (2026-03-06)

### Features

- **Request Interceptors (Middleware)**: Added `onBeforeRequest` to `SseConfig`. This allows for asynchronous dynamic header updates (e.g., refreshing authentication tokens) before any connection or reconnection attempt.
- **Smart Auth Recovery**: Implemented automatic recovery for `HTTP 401` (Unauthorized) and `403` (Forbidden). The client now triggers the interceptor to refresh credentials and reconnects in the background without manually stopping the session.
- **Security & Stability**: Added a "Max Auth Retries" guard (limit to 3 consecutive failures) to prevent infinite loops and battery drain in case of hosed credentials.
- **Race Condition Prevention**: Hardened the native state machine (Android/iOS) to handle concurrent start/stop actions safely during asynchronous middleware execution.
- **SSE Spec Compliance**: Added support for the `HTTP 204 No Content` status code. The client now correctly stops the connection without retrying when the server signals no further data.
- **HTTP Status Codes**: Both iOS and Android now report the actual `statusCode` (e.g., 200, 401, 429) in `open`, `message`, and `error` events, allowing for better JS-side error handling.
- **Configurable Timeouts**: Added `connectionTimeoutMs` and `readTimeoutMs` to `SseConfig` to allow fine-tuning for different network environments and heartbeat intervals.
- **Improved Android Heartbeat**: Enhanced the heartbeat detection logic to better capture SSE comments.
- **Reliable Error Delivery**: Improved buffer management to ensure all events (including fatal errors) are flushed to JavaScript before the connection is disposed.
- **Request Interceptor**: Now correctly executes before _every_ connection and reconnection attempt, ensuring headers are always fresh.
- **Header Merging**: Interceptors now merge new headers with existing ones instead of replacing them.
- **Auth Retry Fixes**: Corrected the auth retry limits and ensured recovery only triggers when an interceptor is present.
- **iOS Timeout Fix**: Properly applied `connectionTimeoutMs` to `URLSessionConfiguration` on iOS.

### Improvements

- **Example App**: Updated the example application to visualize HTTP status codes and provide clearer debugging information.

## 1.4.1 (2026-03-05)

### Fixes

- **iOS**: Fixed a critical build error where `NitroSseNetworkInspector.h` was not found in the Umbrella Header when using modular headers (CocoaPods). Added the header to `s.source_files` in the podspec to ensure correct visibility.

## 1.4.0 (2026-03-05)

### Features

- **DevTools Integration**: Added initial support for the **React Native 0.83+ DevTools Network Tab**. SSE connections are now visible in the Network tab on both Android and iOS, displaying request/response headers, status codes, and connection timing.
  - _Note: Real-time event stream data visibility is currently limited by the React Native DevTools implementation itself._
- **Dependency Update**: Updated `react-native-nitro-modules` and `nitrogen` to `0.35.0`.
- **Performance & Stability**: Refined reconnection logic and native resource management to comply with the latest Nitro standards.

### Fixes

- **Android**: Updated native JNI initialization to fix the breaking change in **Nitro 0.35.0** for Kotlin HybridObjects, resolving potential memory leaks.
- **iOS**: Improved native inspector reporting to prevent duplicate entries and crashes in the React Native C++ layer.

## 1.3.1 (2026-03-04)

### Fixes

- **CI/CD**: Improved release reliability by verifying versions directly against the npm registry instead of relying solely on Git tags.

## 1.3.0 (2026-03-04)

### Features

- **CI/CD**: Improved release security by making the `Continuous Release` workflow dependent on `CI` workflow success.
- **Testing**: Added comprehensive Native Unit Tests for both Android (Kotlin) and iOS (Swift) covering core algorithms: buffer management, exponential backoff, and heartbeat scanning.

### Fixes

- **Android**: Fixed a fragile heartbeat detection logic in the network interceptor by implementing a stateful scanner for SSE comments.
- **Android**: Resolved race conditions in `updateHeaders` and `performConnection` using synchronization and volatile fields.
- **iOS**: Major refactoring of `NitroSse.swift` to remove dead code and improve thread-safety in event handlers using weak references.
- **Performance**: Ensured `Last-Event-ID` is correctly persisted on both Android and iOS to prevent data loss during automatic reconnections.

## 1.2.3 (2026-03-04)

### Fixes

- **Android**: Fixed a critical memory leak by properly removing the lifecycle observer and shutting down the background handler thread when the module is disposed.

## 1.2.2 (2026-03-02)

### Features

- **Dependency Update**: Updated `react-native-nitro-modules` and `nitrogen` to `0.34.1`.

## 1.2.1 (2026-02-27)

### Fixes

- **iOS**: Fixed a compilation error in `establishConnection` caused by missing optional unwrapping.
- **iOS**: Improved session isolation in `SseHandler` to prevent cross-session event leakage.

## 1.2.0 (2026-02-27)

### Features

- **Dependency Update**: Updated `react-native-nitro-modules` and `nitrogen` to `0.34.0`.
- **Testing**: Added more comprehensive Unit Tests for `restart()` and `setLastProcessedId()`.
- **Integration Test**: Added a local SSE Test Server (`example/sse-server.js`) and `yarn server` script for manual testing.
- **Example App**: Completely refactored the example app with a modern Dark Mode UI, real-time stats dashboard, and configurable connection settings.

### Fixes

- **Core**: Fixed a critical race condition in `restart()` that caused connections to immediately close and reconnect after the first message.
- **Android**: Added instance validation in `EventSource` callbacks to ignore events from stale or closed connections.

## 1.1.0 (2026-02-23)

### Features

- **Dependency Update**: Updated `react-native-nitro-modules` and `nitrogen` to `0.33.9`.

## 1.0.2 (2026-02-11)

### Features

- **Android**: Added App Foreground/Background transition handling (Hibernation pattern). The connection now automatically pauses when the app is in the background and resumes when returning to the foreground, parity with iOS.

### Fixes

- **Android**: Added missing `androidx.lifecycle` dependency for lifecycle detection.

## 1.0.1 (2026-02-11)

### Fixes

- **iOS**: Prevented duplicate `NotificationCenter` observers in `setup()`.
- **Android**: Added check to prevent multiple concurrent connections in `start()`.
- **Android**: Improved resource management by reusing `OkHttpClient` and canceling old `EventSource` before reconnection.

## 1.0.0 (2026-02-11)

### Features

- **Stable Release**: Initial stable release of `react-native-nitro-sse`.
- **Dependency Update**: Updated `react-native-nitro-modules` to `0.33.8` for improved stability and performance.

## 0.1.0-beta.4 (2026-02-07)

### CI/CD

- **Continuous Release**: Enabled fully automated releases. Pushing a new version to `main` now automatically creates a GitHub Release and publishes to npm.

## 0.1.0-beta.3 (2026-02-07)

### Fixes

- **Podspec**: Updated repository URL in `NitroSse.podspec` to match the new organization.

## 0.1.0-beta.2 (2026-02-07)

### ⚠️ Breaking Changes

- **Factory Pattern**: The library now exports a factory function `createNitroSse()` instead of a singleton instance. This allows multiple concurrent SSE connections.
  - **Old usage**:
    ```typescript
    import { NitroSseModule } from 'react-native-nitro-sse';
    NitroSseModule.setup({ url: '...' }, callback);
    ```
  - **New usage**:
    ```typescript
    import { createNitroSse } from 'react-native-nitro-sse';
    const sse = createNitroSse();
    sse.setup({ url: '...' }, callback);
    sse.start();
    ```

### Features

- **Multiple Concurrent Connections**: You can now create as many independent SSE connections as needed.
- **Manual Flush**: Added `.flush()` method to forcefully send buffered events to JS immediately.
- **Restart**: Added `.restart()` method to force a reconnection from the client side.
- **Connection Status**: Added `.isConnected()` method to check the active state of the connection synchronously.

### Improvements

- **Stability**: Enhanced native implementation (kotlin/swift) for robust connection handling.
- **Tests**: Comprehensive unit tests covering the new factory pattern and methods.
- **Cleanup**: Removed unused coverage artifacts and optimized build configuration.
