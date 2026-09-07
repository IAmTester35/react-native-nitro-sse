# react-native-nitro-sse

Server-Sent Events (SSE) client for React Native built on **Nitro Modules (JSI)**, supporting event batching, background lifecycle management, and automatic reconnection.

---

## Features

- **JSI Architecture**: Direct JS-to-native communication without the asynchronous bridge.
- **Event Batching**: Batches high-frequency events to reduce UI thread load.
- **Auto Reconnect**: Configurable exponential backoff with jitter.
- **Lifecycle & Heartbeat**: Pauses and resumes connections on app state changes; detects inactive connections via heartbeat comments.
- **DevTools & Mocking**: Network inspection in React Native 0.83+ DevTools and local stream simulation.

---

## Installation

```sh
yarn add react-native-nitro-sse react-native-nitro-modules
# or
npm install react-native-nitro-sse react-native-nitro-modules
```

> [!NOTE]  
> `react-native-nitro-modules` is a peer dependency and must be installed in the host project.

---

## Compatibility

| react-native-nitro-sse | react-native-nitro-modules |
| :--------------------- | :------------------------- |
| **3.0.0 - latest**     | **0.37.1**                 |
| **2.3.0 - 2.4.2**      | **0.35.9**                 |
| **2.2.0 - 2.2.3**      | **0.35.4**                 |
| **2.0.0 - 2.1.1**      | **0.35.2**                 |

<details>
<summary>Older versions (1.x)</summary>

| react-native-nitro-sse | react-native-nitro-modules |
| :--------------------- | :------------------------- |
| **1.4.0 - 1.6.2**      | **0.35.2**                 |
| **1.0.0 - 1.3.1**      | **0.34.1**                 |

</details>

---

## Usage

### Hook (`useNitroSse`)

Recommended for React Native functional components. Handles native lifecycle, listener subscription, and cleanup automatically on unmount.

```tsx
import React from 'react';
import { Text } from 'react-native';
import { useNitroSse } from 'react-native-nitro-sse';

function StreamComponent() {
  const { state, isConnected } = useNitroSse({
    url: 'https://api.example.com/stream',
    headers: { Authorization: 'Bearer TOKEN' },
    autoParseJSON: true,
    onMessage: (e) => console.log('Message:', e.data, e.parsedData),
    onError: (e) => console.error('Error:', e.message),
    events: {
      custom_event: (e) => console.log('Custom:', e.data),
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

#### Options (`UseNitroSseOptions`)

Extends all [`SseConfig`](#configuration-reference-sseconfig) options with lifecycle callbacks:

| Option          | Type                                        | Default | Description                                           |
| :-------------- | :------------------------------------------ | :------ | :---------------------------------------------------- |
| `autoStart`     | `boolean`                                   | `true`  | Auto-start streaming on mount or URL change.          |
| `onMessage`     | `(event: SseEvent) => void`                 | —       | Handler for incoming message events.                  |
| `onError`       | `(event: SseEvent) => void`                 | —       | Handler for transport or connection errors.           |
| `onOpen`        | `(event: SseEvent) => void`                 | —       | Handler for stream open events.                       |
| `onClose`       | `(event: SseEvent) => void`                 | —       | Handler for stream close events.                      |
| `onHeartbeat`   | `(event: SseEvent) => void`                 | —       | Handler for keep-alive heartbeat ping comments (`:`). |
| `onStateChange` | `(state: SseState) => void`                 | —       | Handler for connection state transitions.             |
| `events`        | `Record<string, (event: SseEvent) => void>` | —       | Handlers for specific custom event types.             |

#### Return Values (`UseNitroSseReturn`)

| Property                 | Type                                        | Description                                                                                                                     |
| :----------------------- | :------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------ |
| `client`                 | `SseClient \| null`                         | Underlying SseClient instance.                                                                                                  |
| `isReady`                | `boolean`                                   | Whether the hook has finished mounting and the client instance is initialized and ready.                                        |
| `state`                  | `SseState`                                  | Current connection state (`'idle' \| 'connecting' \| 'open' \| 'reconnecting' \| 'paused' \| 'stale' \| 'closed' \| 'failed'`). |
| `isConnected`            | `boolean`                                   | Whether connection is currently active.                                                                                         |
| `start()`                | `() => void`                                | Start streaming manually.                                                                                                       |
| `stop()`                 | `() => void`                                | Stop streaming manually.                                                                                                        |
| `restart()`              | `() => void`                                | Restart with a fresh handshake.                                                                                                 |
| `flush()`                | `() => void`                                | Immediately flush buffered events.                                                                                              |
| `updateHeaders(headers)` | `(headers: Record<string, string>) => void` | Update request headers dynamically.                                                                                             |
| `setLastProcessedId(id)` | `(id: string) => void`                      | Update event ID used for `Last-Event-ID` on reconnect.                                                                          |
| `getStats()`             | `() => SseStats \| undefined`               | Retrieve connection metrics.                                                                                                    |
| `injectMockEvent(event)` | `(event: Partial<SseEvent>) => void`        | Inject mock event (dev only).                                                                                                   |

</details>

---

### Imperative API

Ideal for Zustand, Redux, background tasks, or services outside the React tree.

```ts
import { createNitroSse } from 'react-native-nitro-sse';

const sse = createNitroSse();

sse.setup({
  url: 'https://api.example.com/stream',
  headers: { Authorization: 'Bearer TOKEN' },
  autoParseJSON: true,
});

sse.addEventListener('open', () => console.log('Connected'));
sse.addEventListener('message', (e) =>
  console.log('Received:', e.data, e.parsedData)
);
sse.addEventListener('error', (e) => console.error('Error:', e.message));

sse.start();

// Cleanup: sse.dispose();
```

---

## API & Configuration Reference

<a id="configuration-reference-sseconfig"></a>

<details>
<summary><b>Configuration Reference (<code>SseConfig</code>)</b></summary>

| Parameter              | Type                                    | Default  | Description                                                     |
| :--------------------- | :-------------------------------------- | :------- | :-------------------------------------------------------------- |
| `url`                  | `string`                                | —        | **Required**. SSE endpoint URL.                                 |
| `method`               | `'get' \| 'post'`                       | `'get'`  | HTTP method.                                                    |
| `headers`              | `Record<string, string>`                | `{}`     | Custom request headers.                                         |
| `body`                 | `string`                                | —        | Payload sent with POST requests.                                |
| `backgroundExecution`  | `boolean`                               | `false`  | (iOS) Continue receiving events when app is in the background.  |
| `batchingIntervalMs`   | `number`                                | `0`      | Event batching interval in ms (`0` sends immediately).          |
| `maxBufferSize`        | `number`                                | `1000`   | Maximum events buffered before forcing a dispatch.              |
| `connectionTimeoutMs`  | `number`                                | `15000`  | Connection timeout in ms.                                       |
| `readTimeoutMs`        | `number`                                | `300000` | Inactivity timeout in ms before reconnecting.                   |
| `retryIntervalMs`      | `number`                                | `1000`   | Initial reconnect delay in ms.                                  |
| `maxRetryIntervalMs`   | `number`                                | `30000`  | Maximum reconnect delay in ms.                                  |
| `jitterFactor`         | `number`                                | `0.5`    | Reconnect delay randomization factor (`0.0` to `1.0`).          |
| `maxReconnectAttempts` | `number`                                | `-1`     | Max reconnect attempts (`-1` = infinite, `0` = disabled).       |
| `maxAuthRetries`       | `number`                                | `3`      | Consecutive 401/403 retry attempts with `onBeforeRequest`.      |
| `autoParseJSON`        | `boolean`                               | `false`  | Automatically parses JSON `data` strings into `parsedData`.     |
| `monitorNetwork`       | `boolean`                               | `true`   | Pause and resume connection on network connectivity changes.    |
| `onBeforeRequest`      | `() => Promise<Record<string, string>>` | —        | Async hook to update headers before each request.               |
| `mock`                 | `SseMockConfig`                         | —        | Mock stream configuration (development only).                   |

</details>

<details>
<summary><b>Mocking & Testing System (<code>v2.3.0+</code>)</b></summary>

Simulate SSE streams locally for testing without a live backend. Mocks are disabled in production builds.

#### Configuration (`SseMockConfig`)

```tsx
sse.setup({
  url: 'https://api.mocked-endpoint.com/stream',
  mock: {
    mode: 'replace', // 'replace' = Pure JS local simulation; 'inject' = Server + injected events
    eventsPerSecond: 2,
    loop: true,
    errorRate: 0.1, // 10% chance to simulate connection drops
    data: [
      { type: 'open', statusCode: 200 },
      { type: 'message', data: 'Initial greeting' },
      {
        event: 'user-updated',
        data: '{"id":123,"status":"online"}',
        delayMs: 1500,
      },
      { type: 'message', data: 'Periodic heartbeat' },
    ],
  },
});
```

#### Manual Injector

Inject custom testing events programmatically at runtime:

```tsx
sse.injectMockEvent({
  type: 'message',
  event: 'alert',
  data: 'System maintenance warning!',
});
```

</details>

<details>
<summary><b>Advanced Operations</b></summary>

- **`isConnected()`**: Returns whether connection is currently active (`connecting`, `open`, or `reconnecting`).
- **`getStats()`**: Returns connection metrics (`totalBytesReceived`, `reconnectCount`, `lastErrorTime`, `lastErrorCode`).
- **`updateHeaders(headers)`**: Updates request headers without closing the connection.
- **`setLastProcessedId(id)`**: Updates event ID sent in `Last-Event-ID` header on reconnect.
- **`restart()`**: Reconnects the stream with a clean connection.
- **`flush()`**: Dispatches buffered events immediately without waiting for `batchingIntervalMs`.
- **`getState()`**: Returns current state (`'idle' \| 'connecting' \| 'open' \| 'stale' \| 'reconnecting' \| 'paused' \| 'closed' \| 'failed'`).
- **`removeEventListener(type, listener)`**: Unregisters an event listener.
- **`removeAllEventListeners(type?)`**: Unregisters all event listeners, optionally filtered by event type.
- **`dispose()`**: Closes active connections, clears timers, observers, and listeners.

</details>

---

## License

MIT

---

_Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)_
