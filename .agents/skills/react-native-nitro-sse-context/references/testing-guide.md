# Testing Guide & Strategy — react-native-nitro-sse

This document details the multi-layered testing strategy (JavaScript/Jest, Android Native Unit Tests, iOS Native Unit Tests) and CLI commands for `react-native-nitro-sse`.

---

## 1. 3-Tier Testing Architecture

Because the library interfaces directly with OS-level networking and hardware lifecycle events, testing is divided into 3 distinct layers:

```text
                  ┌──────────────────────────────┐
                  │ Layer 1: JS/TS API (Jest)    │
                  │ src/__tests__/index.test.tsx │
                  └──────────────┬───────────────┘
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
┌─────────────────────────────┐         ┌─────────────────────────────┐
│ Layer 2: Android Native     │         │ Layer 3: iOS Native         │
│ android/src/test/java/...   │         │ ios/Tests/...               │
│ (JUnit + Virtual Time)      │         │ (XCTest + Mock Dispatcher)  │
└─────────────────────────────┘         └─────────────────────────────┘
```

---

## 2. Layer 1: JavaScript & TypeScript Unit Tests (Jest)

- **File Location**: `src/__tests__/index.test.tsx`
- **Objective**:
  - Verifies public API functions `createNitroSse()`, `getState()`, and `NitroSseClient.ts`.
  - Validates registration and removal of typed event listeners (`addEventListener` & `removeEventListener`).
  - Ensures event dispatching matches standard `type` (`message`, `open`, `error`, `state`, etc.) or custom event names (`event.event`).
  - Tests the Mock Engine (`mode: 'replace'` and `mode: 'inject'`), mock `SseState` transitions, streaming rate (`eventsPerSecond`), simulated error rate (`errorRate`), and manual event injection (`injectMockEvent`).
- **Execution Command**:
  ```bash
  yarn test
  ```

---

## 3. Layer 2: Android Native Unit Tests (Kotlin + JUnit)

- **File Location**: `android/src/test/java/com/margelo/nitro/nitrosse/`
- **Test Suite List**:
  - `NitroSseLogicTest.kt`: Tests core logic of `NitroSse.kt` (State machine, backoff, versioning, config parameter validation for `NaN`/infinity/negative numbers, interceptor timeouts).
  - `NitroSseCoordinatorTest.kt`: Tests thread coordination, combining event buffering with custom dispatchers and network monitor generation tracking.
  - `NitroSseIntegrationTest.kt`: Integration tests for OkHttp SSE data streaming.
  - `NitroSseJsonTest.kt`: Tests JSON string parsing using `JsonUtils`.
  - `AndroidSseDispatcherTest.kt` & `TestSseDispatcher.kt`: Virtual-time dispatcher allowing immediate execution of async tasks without requiring real Android OS HandlerThreads.
  - `HeartbeatScannerTest.kt`: Tests keep-alive ping comment filtering (`: keep-alive`).
- **Execution Command**:
  ```bash
  yarn test:android
  ```
  *(Navigates to `example/android` and runs Gradle task `:react-native-nitro-sse:testDebugUnitTest`).*

---

## 4. Layer 3: iOS Native Unit Tests (Swift + XCTest)

- **File Location**: `ios/Tests/`
- **Test Suite List**:
  - `NitroSseTests.swift`: Tests state transitions, config parameter validation (`testReconnectStrategyValidation`, `testEventBufferMaxBufferSizeValidation`), header updates, restarts, flushing, and error retries in Swift.
  - `NitroSseCoordinatorTests.swift`: Tests coordination between `SseEventBuffer`, `SseReconnectStrategy`, `SseNetworkMonitor`, and `SseLifecycleManager`.
  - `NitroSseIntegrationTests.swift`: Integration tests simulating socket streams with LDSwiftEventSource.
  - `MockSseDispatcher.swift`: Synchronous mock dispatcher to test async logic on main/test threads without thread leaks.
- **Execution Command**:
  ```bash
  yarn test:ios
  ```
  *(Invokes `xcodebuild test` on Xcode workspace `example/ios/NitroSseExample.xcworkspace` targeting iPhone 16e Simulator).*

---

## 5. CLI Testing Commands Summary

| Task | Command | Description |
|---|---|---|
| **TypeScript Typecheck** | `yarn typecheck` | Validates TypeScript types using `tsc --noEmit`. |
| **ESLint Check** | `yarn lint` | Lints `.ts`, `.tsx`, and `.js` files. |
| **ESLint Fix** | `yarn lint --fix` | Automatically fixes code formatting and lint errors. |
| **JS Unit Tests** | `yarn test` | Runs Jest unit tests for JS API & Mocking engine. |
| **Android Tests** | `yarn test:android` | Runs Kotlin unit tests via Gradle. |
| **iOS Tests** | `yarn test:ios` | Runs Swift unit tests via `xcodebuild`. |
| **Full Native Tests** | `yarn test:native` | Runs both `test:android` and `test:ios`. |
| **Complete CI Workflow** | `yarn ci` | Runs lint + typecheck + JS test + build library + Native tests + Android/iOS build checks. |
