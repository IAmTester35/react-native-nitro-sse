# Troubleshooting & FAQ — react-native-nitro-sse

This document compiles common development, native build, and runtime issues encountered when working with `react-native-nitro-sse`, along with step-by-step resolution guides.

---

## 1. Nitrogen Code Generation Out-of-Sync

### Symptom:
Native build fails with missing method errors on newly added `NitroSse.nitro.ts` methods, or app crashes with C++ undefined symbol errors upon JSI invocation.

### Cause:
The TypeScript JSI spec interface was modified, but `nitrogen` was not executed to regenerate C++/Swift/Kotlin glue code.

### Resolution:
```bash
yarn nitrogen
yarn clean
yarn prepare
```
Rebuild the app inside `example/`: `yarn example android` or `yarn example ios`.

---

## 2. `JS Dispatcher destroyed` Warning on App Reload

### Symptom:
Native system logs display:
`[NitroSse] JS Dispatcher destroyed. Stopping SSE stream.` or app crashes during React Native JS reload (Cmd+R / Fast Refresh).

### Cause:
The JS engine is reinitialized while native async callbacks from `onBeforeRequest` or `onEvent` attempt to interact with a JSI dispatcher destroyed by the React Native runtime.

### Resolution:
Native implementation handles C++ `Dispatcher has already been destroyed` exceptions gracefully:
- Sets `isDispatcherDestroyed = true`.
- Teardowns socket connection silently without forwarding events to JS to prevent app crashes.
- When writing new native code, **always check `isDispatcherDestroyed` before invoking `eventBuffer.push(...)`**.

---

## 3. iOS Background Execution Limit Exceeded

### Symptom:
App is terminated in background by iOS after 30 seconds to 3 minutes.

### Cause:
`backgroundExecution: true` is configured, but background work exceeds the time granted by iOS via `UIBackgroundTaskIdentifier`.

### Resolution:
1. Explain to users: iOS does not permit indefinite background WebSocket/SSE connections unless using specific background modes (Audio, Location, VoIP).
2. When `SseLifecycleManager` receives an expiration signal (`expirationHandler`), it gracefully moves the client to `PAUSED` and closes socket connections. Streams automatically resume when returning to Foreground.

---

## 4. HandlerThread Memory Leak on Android

### Symptom:
Android memory leak warnings regarding `HandlerThread("NitroSseThread")` when creating and destroying multiple `createNitroSse()` instances.

### Cause:
The `dispose()` method of `NitroSse.kt` was not called or looper thread was not quit safely.

### Resolution:
Ensure `dispose()` quits the looper safely when disposing `NitroSse`:
```kotlin
sseDispatcherThread?.quitSafely()
sseDispatcherThread = null
sseDispatcher = null
```

---

## 5. DevTools Network Inspector Not Capturing Streams

### Symptom:
SSE network streams do not appear in the Network tab of React Native DevTools 0.83+.

### Cause:
DevTools Inspector only captures native sockets registered via `NitroSseNetworkInspector` (iOS) and `NetworkInspector` (Android).

### Resolution:
- Verify device/emulator is running React Native 0.83+.
- Ensure `reportRequestStart`, `reportResponseStart`, and `reportResponseEnd` are called with matching `requestId` parameters across the connection lifecycle in `NitroSse.swift` and `NitroSse.kt`.

---

## 6. Mock Streaming Warning in Production Build

### Symptom:
App logs display yellow warning banner: `[react-native-nitro-sse] WARNING: MOCK STREAMING IS ENABLED!`.

### Cause:
The `mock` configuration option remains inside `SseConfig` when calling `setup()`.

### Resolution:
`NitroSseClient.ts` strips `mock` settings automatically when `__DEV__ === false`. To strictly prevent leaks, wrap mock configs with environment flags:
```tsx
sse.setup({
  url: 'https://api.example.com/stream',
  mock: __DEV__ ? myMockConfig : undefined
});
```
