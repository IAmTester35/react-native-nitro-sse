# react-native-nitro-sse

Server-Sent Events (SSE) client for React Native built on Nitro Modules (JSI).

---

## Features

- **JSI Execution**: Direct synchronous JS-to-native calls via Nitro Modules.
- **Reconnection**: Exponential backoff with jitter and HTTP 429 (`Retry-After`) handling.
- **Event Batching**: Configurable batch interval and buffer size limits.
- **Lifecycle & Network**: Automatic pause and resume on app state or network transitions.
- **Heartbeat Detection**: Inactive connection detection via SSE comment pings (`:`).
- **Diagnostics**: Network inspection via DevTools and local stream simulation in development.

---

## Installation

```sh
npm install react-native-nitro-sse react-native-nitro-modules
# or
yarn add react-native-nitro-sse react-native-nitro-modules
```

> **Note**: `react-native-nitro-modules` is a peer dependency.

<details>
<summary><b>Compatibility Matrix</b></summary>

| react-native-nitro-sse | react-native-nitro-modules |
| :--------------------- | :------------------------- |
| **3.0.0+**             | **0.37.1**                 |
| **2.3.0 - 2.4.2**      | **0.35.9**                 |
| **2.2.0 - 2.2.3**      | **0.35.4**                 |
| **2.0.0 - 2.1.1**      | **0.35.2**                 |
| **1.0.0 - 1.6.2**      | **0.34.1 - 0.35.2**        |

</details>

---

## Usage

| Approach             | Primary Use Case                                     | Lifecycle                                      |
| :------------------- | :--------------------------------------------------- | :--------------------------------------------- |
| **`useNitroSse`**    | React components & UI views                          | Automatic (bound to component mount/unmount)   |
| **`createNitroSse`** | Stores (Zustand/Redux), background tasks, singletons | Explicit (`setup`, `start`, `stop`, `dispose`) |

---

### 1. Declarative Hook (`useNitroSse`)

Used inside React functional components. Binds the stream to the component lifecycle.

```tsx
import { Text } from 'react-native';
import { useNitroSse } from 'react-native-nitro-sse';

interface StreamEvents {
  user_joined: { userId: string; username: string };
  price_update: { symbol: string; price: number };
}

export function EventStream() {
  const { state, isConnected } = useNitroSse<StreamEvents>({
    url: 'https://api.example.com/events',
    headers: { Authorization: 'Bearer TOKEN' },
    autoParseJSON: true,
    // Async interceptor called before initial connection & auto-reconnects
    onBeforeRequest: async () => {
      const token = await getFreshAuthToken();
      return { Authorization: `Bearer ${token}` };
    },
    onMessage: (e) => console.log(e.parsedData ?? e.data),
    onError: (e) => console.error(e.message),
    // Strongly-typed named event types ('event: <name>')
    events: {
      user_joined: (e) => console.log('User joined:', e.parsedData?.username),
      price_update: (e) => console.log('Price update:', e.parsedData?.price),
    },
  });

  return (
    <Text>
      Status: {state} ({isConnected ? 'Connected' : 'Disconnected'})
    </Text>
  );
}
```

<details>
<summary><b><code>useNitroSse</code> Options & Return Values</b></summary>

#### `UseNitroSseOptions`

Inherits all [`SseClientOptions`](#configuration-reference-sseclientoptions) options plus:

| Option          | Type                                                               | Default | Description                                              |
| :-------------- | :----------------------------------------------------------------- | :------ | :------------------------------------------------------- |
| `autoStart`     | `boolean`                                                          | `true`  | Starts streaming on mount or when URL changes.           |
| `events`        | `{ [K in keyof TEvents]?: (event: SseEvent<TEvents[K]>) => void }` | —       | Strongly-typed handlers for specific custom event types. |
| `onMessage`     | `(event: SseEvent) => void`                                        | —       | Handler for message events.                              |
| `onError`       | `(event: SseEvent) => void`                                        | —       | Handler for transport or connection errors.              |
| `onOpen`        | `(event: SseEvent) => void`                                        | —       | Handler for stream open events.                          |
| `onClose`       | `(event: SseEvent) => void`                                        | —       | Handler for stream close events.                         |
| `onHeartbeat`   | `(event: SseEvent) => void`                                        | —       | Handler for heartbeat ping comments (`:`).               |
| `onStateChange` | `(state: SseState) => void`                                        | —       | Handler for connection state transitions.                |

#### `UseNitroSseReturn`

| Property                 | Type                                        | Description                                                                                         |
| :----------------------- | :------------------------------------------ | :-------------------------------------------------------------------------------------------------- |
| `client`                 | `SseClient \| null`                         | Native client instance (`null` before initialization).                                              |
| `isReady`                | `boolean`                                   | True after initial mount and client initialization.                                                 |
| `state`                  | `SseState`                                  | `'idle' \| 'connecting' \| 'open' \| 'reconnecting' \| 'paused' \| 'stale' \| 'closed' \| 'failed'` |
| `isConnected`            | `boolean`                                   | True when connection is active.                                                                     |
| `start()`                | `() => void`                                | Starts the stream.                                                                                  |
| `stop()`                 | `() => void`                                | Stops the stream.                                                                                   |
| `restart()`              | `() => void`                                | Restarts connection handshake.                                                                      |
| `flush()`                | `() => void`                                | Immediately flushes buffered events.                                                                |
| `updateHeaders(headers)` | `(headers: Record<string, string>) => void` | Updates headers without reconnecting.                                                               |
| `setLastProcessedId(id)` | `(id: string) => void`                      | Updates event ID used for `Last-Event-ID` on reconnect.                                             |
| `getStats()`             | `() => SseStats \| undefined`               | Returns connection metrics.                                                                         |
| `injectMockEvent(event)` | `(event: Partial<SseEvent>) => void`        | Injects a mock event (development only).                                                            |

</details>

---

### 2. Imperative Client (`createNitroSse`)

Used outside React component lifecycles:

- State management stores (Zustand, Redux, ...).
- Persistent connections spanning across screen navigation.
- Background and headless tasks (React Native Headless JS, background sync).
- Dedicated service classes or singleton modules.

```ts
import { createNitroSse } from 'react-native-nitro-sse';

const sse = createNitroSse();

sse.setup({
  url: 'https://api.example.com/events',
  headers: { Authorization: 'Bearer TOKEN' },
  autoParseJSON: true,
  // Dynamic header refresh for initial connection and auto-reconnects
  onBeforeRequest: async () => {
    const token = await getFreshAuthToken();
    return { Authorization: `Bearer ${token}` };
  },
});

// Event listeners
sse.addEventListener('message', (e) => console.log(e.parsedData ?? e.data));
sse.addEventListener('user_joined', (e) => console.log('Joined:', e.data));
sse.addEventListener('error', (e) => console.error(e.message));

// Connection controls
sse.start();

// Disposal
// sse.dispose();
```

---

## API & Configuration

<details>
<summary><b>Configuration Reference (<code>SseClientOptions</code>)</b></summary>

<a id="configuration-reference-sseclientoptions"></a>
<a id="configuration-reference-sseconfig"></a>

`SseClientOptions` is the configuration object accepted by `setup()` and `useNitroSse()`. It extends the native data struct `SseConfig` with dynamic client interceptors:

| Parameter              | Type                                    | Default  | Description                                                                                        |
| :--------------------- | :-------------------------------------- | :------- | :------------------------------------------------------------------------------------------------- |
| `url`                  | `string`                                | —        | **Required**. Target SSE endpoint URL.                                                             |
| `method`               | `'get' \| 'post'`                       | `'get'`  | HTTP method.                                                                                       |
| `headers`              | `Record<string, string>`                | `{}`     | Request headers.                                                                                   |
| `body`                 | `string`                                | —        | Body for POST requests.                                                                            |
| `backgroundExecution`  | `boolean`                               | `false`  | (iOS) Continues streaming while app is in background.                                              |
| `batchingIntervalMs`   | `number`                                | `0`      | Batching delay in ms (`0` dispatches immediately).                                                 |
| `maxBufferSize`        | `number`                                | `1000`   | Max buffer size before forcing event dispatch.                                                     |
| `connectionTimeoutMs`  | `number`                                | `15000`  | Socket connection timeout in ms.                                                                   |
| `readTimeoutMs`        | `number`                                | `300000` | Inactivity timeout in ms before reconnecting.                                                      |
| `retryIntervalMs`      | `number`                                | `1000`   | Base reconnect delay in ms.                                                                        |
| `maxRetryIntervalMs`   | `number`                                | `30000`  | Maximum exponential backoff delay in ms.                                                           |
| `jitterFactor`         | `number`                                | `0.5`    | Jitter factor applied to reconnect delay (`0.0` to `1.0`).                                         |
| `maxReconnectAttempts` | `number`                                | `-1`     | Max reconnect retries (`-1` = infinite, `0` = disabled).                                           |
| `maxAuthRetries`       | `number`                                | `3`      | Max retry attempts for 401/403 responses using `onBeforeRequest`.                                  |
| `autoParseJSON`        | `boolean`                               | `false`  | Parses JSON root objects (`'{...}'`) into `parsedData`. If `false`, use `data` and parse manually. |
| `monitorNetwork`       | `boolean`                               | `true`   | Automatically pauses/resumes on network changes.                                                   |
| `onBeforeRequest`      | `() => Promise<Record<string, string>>` | —        | Async hook to refresh headers prior to connection attempts.                                        |
| `mock`                 | `SseMockConfig`                         | —        | Mock stream configuration (development only).                                                      |

</details>

<details>
<summary><b>Client Methods Reference (<code>SseClient</code>)</b></summary>

- **`start()`**: Initiates the connection. If called during reconnection backoff, immediately retries.
- **`stop()`**: Disconnects the stream without disposing the instance.
- **`restart()`**: Reconnects with a fresh connection handshake.
- **`flush()`**: Flushes pending events in the buffer immediately.
- **`isConnected()`**: Returns boolean indicating if connection is active (`connecting`, `open`, `reconnecting`).
- **`getState()`**: Returns current `SseState`.
- **`getStats()`**: Returns connection metrics (`totalBytesReceived`, `reconnectCount`, `lastErrorTime`, `lastErrorCode`).
- **`updateHeaders(headers)`**: Merges new headers into current configuration without closing the connection.
- **`setLastProcessedId(id)`**: Sets the event ID to send in `Last-Event-ID` on subsequent reconnections.
- **`addEventListener(type, listener)`**: Subscribes to an event type (`'message'`, `'open'`, `'close'`, `'error'`, `'heartbeat'`, `'state'`, or custom event name).
- **`removeEventListener(type, listener)`**: Unsubscribes a specific listener.
- **`removeAllEventListeners(type?)`**: Unregisters all listeners (or listeners for a given event type).
- **`dispose()`**: Closes connection and releases native resources. Subsequent calls throw `NitroSseDisposedError`.

</details>

<details>
<summary><b>Error Handling (<code>NitroSseError</code>)</b></summary>

Errors thrown by the library inherit from `NitroSseError`:

```ts
import { NitroSseError } from 'react-native-nitro-sse';

try {
  // ...
} catch (err) {
  if (err instanceof NitroSseError) {
    console.error(`[${err.code}] ${err.message}`, err.details);
  }
}
```

| Error Class                   | Error Code                             | Description                                                           |
| :---------------------------- | :------------------------------------- | :-------------------------------------------------------------------- |
| `NitroSseModuleNotFoundError` | `NATIVE_MODULE_NOT_FOUND`              | Native Nitro module binary is missing.                                |
| `NitroSseValidationError`     | `INVALID_CONFIG` \| `INVALID_ARGUMENT` | Invalid argument or configuration parameter.                          |
| `NitroSseStateError`          | `INVALID_STATE`                        | Method invoked in an invalid state (e.g. `start()` before `setup()`). |
| `NitroSseDisposedError`       | `CLIENT_DISPOSED`                      | Method invoked on an already disposed client instance.                |

</details>

<details>
<summary><b>Mocking & Testing (Development Only)</b></summary>

Development-only mock stream simulation:

```ts
import { createNitroSse } from 'react-native-nitro-sse';

const sse = createNitroSse();

sse.setup({
  url: 'https://api.example.com/events',
  mock: __DEV__
    ? {
        mode: 'replace', // 'replace' = local mock, 'inject' = server + mocks
        loop: true,
        data: [
          { type: 'open', statusCode: 200 },
          { type: 'message', data: 'Hello' },
          { event: 'status', data: '{"ok":true}', delayMs: 500 },
        ],
      }
    : undefined,
});

sse.addEventListener('message', (e) => console.log('Message:', e.data));
sse.start();

// Programmatic event injection (development only)
sse.injectMockEvent({ type: 'message', data: 'Test' });
```

</details>

---

## License

MIT
