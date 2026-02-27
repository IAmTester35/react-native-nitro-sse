# Changelog

## 1.2.0 (2026-02-27)

### Features

*   **Dependency Update**: Updated `react-native-nitro-modules` and `nitrogen` to `0.34.0`.
*   **Testing**: Added more comprehensive Unit Tests for `restart()` and `setLastProcessedId()`. 
*   **Integration Test**: Added a local SSE Test Server (`example/sse-server.js`) and `yarn server` script for manual testing.
*   **Example App**: Completely refactored the example app with a modern Dark Mode UI, real-time stats dashboard, and configurable connection settings.

### Fixes

*   **Core**: Fixed a critical race condition in `restart()` that caused connections to immediately close and reconnect after the first message.
*   **Android**: Added instance validation in `EventSource` callbacks to ignore events from stale or closed connections.
*   **iOS**: Refactored event handling using an isolated `SseHandler` to prevent cross-session event leakage during restarts.

## 1.1.0 (2026-02-23)

### Features

*   **Dependency Update**: Updated `react-native-nitro-modules` and `nitrogen` to `0.33.9`.

## 1.0.2 (2026-02-11)

### Features

*   **Android**: Added App Foreground/Background transition handling (Hibernation pattern). The connection now automatically pauses when the app is in the background and resumes when returning to the foreground, parity with iOS.

### Fixes

*   **Android**: Added missing `androidx.lifecycle` dependency for lifecycle detection.

## 1.0.1 (2026-02-11)

### Fixes

*   **iOS**: Prevented duplicate `NotificationCenter` observers in `setup()`.
*   **Android**: Added check to prevent multiple concurrent connections in `start()`.
*   **Android**: Improved resource management by reusing `OkHttpClient` and canceling old `EventSource` before reconnection.

## 1.0.0 (2026-02-11)

### Features

*   **Stable Release**: Initial stable release of `react-native-nitro-sse`.
*   **Dependency Update**: Updated `react-native-nitro-modules` to `0.33.8` for improved stability and performance.

## 0.1.0-beta.4 (2026-02-07)

### CI/CD

*   **Continuous Release**: Enabled fully automated releases. Pushing a new version to `main` now automatically creates a GitHub Release and publishes to npm.

## 0.1.0-beta.3 (2026-02-07)

### Fixes

*   **Podspec**: Updated repository URL in `NitroSse.podspec` to match the new organization.

## 0.1.0-beta.2 (2026-02-07)

### ⚠️ Breaking Changes

*   **Factory Pattern**: The library now exports a factory function `createNitroSse()` instead of a singleton instance. This allows multiple concurrent SSE connections.
    *   **Old usage**:
        ```typescript
        import { NitroSseModule } from 'react-native-nitro-sse';
        NitroSseModule.setup({ url: '...' }, callback);
        ```
    *   **New usage**:
        ```typescript
        import { createNitroSse } from 'react-native-nitro-sse';
        const sse = createNitroSse();
        sse.setup({ url: '...' }, callback);
        sse.start();
        ```

### Features

*   **Multiple Concurrent Connections**: You can now create as many independent SSE connections as needed.
*   **Manual Flush**: Added `.flush()` method to forcefully send buffered events to JS immediately.
*   **Restart**: Added `.restart()` method to force a reconnection from the client side.
*   **Connection Status**: Added `.isConnected()` method to check the active state of the connection synchronously.

### Improvements

*   **Stability**: Enhanced native implementation (kotlin/swift) for robust connection handling.
*   **Tests**: Comprehensive unit tests covering the new factory pattern and methods.
*   **Cleanup**: Removed unused coverage artifacts and optimized build configuration.
