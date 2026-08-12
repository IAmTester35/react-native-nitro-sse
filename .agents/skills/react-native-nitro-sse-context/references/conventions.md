# Coding Conventions & Standards — react-native-nitro-sse

This document outlines coding standards, module organization, thread-safety invariants, and Separation of Concerns (SoC) rules across **TypeScript**, **Kotlin**, and **Swift**.

---

## 1. Separation of Concerns (SoC) Rules

The repository strictly enforces responsibility boundaries:

1. **`src/NitroSse.nitro.ts` (JSI Spec Layer)**:
   - Contains ONLY TypeScript interface declarations representing C++ Hybrid Objects.
   - MUST NOT contain business logic or external library imports other than `react-native-nitro-modules`.
2. **`src/SseInterface.ts` (Type Definitions Layer)**:
   - Pure type definitions, interfaces, enums, and DTOs (`SseConfig`, `SseEvent`, `SseStats`, `SseState`).
3. **`src/NitroSseClient.ts` (JS Business & Mocking Layer)**:
   - Wraps the native `NitroSse` JSI object.
   - Manages Typed Event Listeners (`addEventListener`, `removeEventListener`).
   - Handles the Mocking Engine (`SseMockConfig`) and strips mock code completely in Production (`!__DEV__`).
4. **Native Layers (`ios/` & `android/`)**:
   - Handles socket connections (LDSwiftEventSource / OkHttp SSE).
   - Enforces thread safety via Dispatchers.
   - Manages app lifecycle, network connectivity monitoring, and event buffering.

---

## 2. TypeScript Guidelines

- **Strict Typing**: `strict: true` must remain enabled in `tsconfig.json`. Avoid `any` except when decoding raw JSON structures (`AnyMap`).
- **Naming Conventions**:
  - `camelCase` for methods, parameters, and variables (`createNitroSse`, `lastProcessedId`).
  - `PascalCase` for Interfaces, Types, and Classes (`SseConfig`, `SseEvent`, `NitroSseClient`).
  - `kebab-case` for TypeScript file names (`NitroSseClient.ts`, `SseInterface.ts`).
- **Exports**: Expose public APIs through `src/index.ts`. External projects must not import internal implementation files directly.

---

## 3. Swift Guidelines (iOS)

- **Safety & Memory Management**:
  - Always use `[weak self]` in asynchronous closures (`dispatcher.async`, timers, completion handlers) to prevent retain cycles.
  - Decorate with `@DoNotStrip` or inherit from Nitrogen-generated `HybridNitroSseSpec`.
- **Thread Safety Invariants**:
  - Any method mutating `NitroSse.swift` state MUST execute via `dispatcher.async` or `dispatcher.sync`.
  - Always call `dispatcher.assertOnQueue()` at the top of private helper methods to detect invalid queue access early during Debug builds.
- **Naming Conventions**:
  - `camelCase` for variables and functions (`establishConnection`, `connectionAttemptVersion`).
  - `PascalCase` for Structs, Classes, and Enums (`SseEventBuffer`, `SseReconnectStrategy`).
  - Separate protocol extensions cleanly (e.g., `extension NitroSse: SseConnectionDelegate`).

---

## 4. Kotlin Guidelines (Android)

- **Null Safety & Thread Safety**:
  - Use Atomic data types for cross-thread counters and flags (`AtomicBoolean`, `AtomicInteger`, `AtomicLong`, `AtomicReference`).
  - Enforce synchronization (`synchronized(this)`) when reading or writing `config` or `client` instances.
  - Apply `@DoNotStrip` on `NitroSse` class and main constructor to prevent ProGuard / R8 stripping in release builds.
- **Threading & Looper**:
  - All connection management operations MUST be posted to `sseDispatcher` (`HandlerThread`).
  - Dispatched `onEvent` callbacks back to JS MUST use `mainDispatcher` (`Looper.getMainLooper()`) to guarantee thread safety on the JS UI thread.
- **Naming Conventions**:
  - Adhere to standard Kotlin coding conventions.
  - Constants in `companion object` use `UPPER_SNAKE_CASE` (e.g., `private const val TAG = "NitroSse"`).

---

## 5. HTTP Error Handling & Reconnection Rules

All native implementations MUST adhere to the following HTTP status code matrix:

| HTTP Code | Mandatory Native Behavior | Target Connection State |
|---|---|---|
| **200 OK** | Emit `open` event, reset retry counters & consecutive auth error counters. | `SseState.OPEN` |
| **204 No Content** | Emit `error` event ("No Content (204). Stopping."), cancel socket, DO NOT retry. | `SseState.FAILED` -> `CLOSED` |
| **400 Bad Request** | Fatal Error. Emit `error` event, tear down socket immediately, halt stream. | `SseState.FAILED` -> `CLOSED` |
| **401 / 403 Auth Error** | If `onBeforeRequest` is configured, increment `consecutiveAuthErrors` and attempt token refresh (max 3 retries). Stop if no interceptor or retries exhausted. | `SseState.RECONNECTING` (or `FAILED`) |
| **429 Rate Limit / 503** | If `Retry-After` header present, pause for specified duration + random Jitter. Stop if 429 has no `Retry-After`. | `SseState.RECONNECTING` (or `FAILED`) |
| **Timeout (-1001 / SocketTimeout)** | Mark connection as stale, emit `error` event, and schedule automatic reconnection. | `SseState.STALE` -> `RECONNECTING` |

---

## 6. Connection Attempt Versioning & Generation Tracking Rules

All asynchronous socket, timer, or network path callbacks **MUST** verify generation counters or attempt versions before mutating client state:

1. **`connectionAttemptVersion`**:
   All asynchronous socket or timer callbacks **MUST** accept an `attemptVersion: Int` parameter.

   ```swift
   // Swift Example
   func connectionDidFail(error: Error, attemptVersion: Int) {
       dispatcher.async { [weak self] in
           guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion else {
               return // Discard stale callback
           }
           // Processing error...
       }
   }
   ```
   If `attemptVersion != currentVersion`, the callback terminates immediately without logging errors or modifying client connection state.

2. **`monitorGeneration`**:
   `SseNetworkMonitor` implementations (iOS & Android) increment a `monitorGeneration` counter on `start()` and `stop()` to discard queued background path updates from previous path monitor instances.
