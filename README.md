# react-native-nitro-sse

High-performance Server-Sent Events (SSE) client for React Native, built on top of **Nitro Modules (JSI)**. Designed for mission-critical apps requiring high-throughput streaming, battery optimization, and extreme stability.

---

## Why NitroSSE?

Traditional EventSource libraries run on the JS thread or use the legacy React Native Bridge. NitroSSE moves the entire control logic down to the native layer:

- **Zero-Latency JSI**: Instantaneous JS-Native communication bypassing the async bridge.
- **Advanced Backpressure**: Batches high-frequency events and automatically flushes when the buffer is full to prevent memory pressure, keeping the UI thread fluid under extreme load.
- **Intelligent Reconnect**: Automatic recovery using **Exponential Backoff** and **Jitter** to prevent server stampedes.
- **Lifecycles**: Auto-hibernates connections in background and resumes on foreground to preserve battery.
- **Heartbeat Watchdog**: Native detection of keep-alive/ping comments to auto-reconnect dead sockets.
- **RN DevTools Integration**: Plug-and-play network tracing in **React Native 0.83+ DevTools** (monitor streams directly).
- **Local Mocking Engine**: Simulates streams, connection drops, and delays entirely in JS without backend setup.

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
| **2.5.0 - latest**     | **0.37.0**                 |
| **2.4.0 - 2.4.2**      | **0.35.9**                 |
| **2.3.1**              | **0.35.9**                 |
| **2.3.0**              | **0.35.6**                 |
| **2.2.0 - 2.2.3**      | **0.35.4**                 |
| **2.0.0 - 2.1.1**      | **0.35.2**                 |
| **1.6.2**              | **0.35.2**                 |
| **1.4.0 - 1.6.1**      | **0.35.0**                 |
| **1.2.2 - 1.3.1**      | **0.34.1**                 |
| **1.2.0 - 1.2.1**      | **0.34.0**                 |
| **1.1.0**              | **0.33.9**                 |
| **1.0.0**              | **0.33.8**                 |

---

## Usage

### Using the `useNitroSse` Hook (Recommended)

```tsx
import React from 'react';
import { Text, View } from 'react-native';
import { useNitroSse } from 'react-native-nitro-sse';

function StreamComponent() {
  const { state, isConnected } = useNitroSse({
    url: 'https://api.example.com/stream',
    headers: { Authorization: 'Bearer TOKEN' },
    autoParseJSON: true,
    onMessage: (e) => console.log('Received:', e.data, e.parsedData),
    onError: (e) => console.error('Error:', e.message),
    events: {
      custom_event: (e) => console.log('Custom event:', e.data),
    },
  });

  return (
    <View>
      <Text>
        Status: {state} ({isConnected ? 'Connected' : 'Disconnected'})
      </Text>
    </View>
  );
}
```

### Imperative API

```tsx
import { useEffect } from 'react';
import { createNitroSse } from 'react-native-nitro-sse';

function StreamComponent() {
  useEffect(() => {
    const sse = createNitroSse();

    sse.setup({
      url: 'https://api.example.com/stream',
      headers: { Authorization: 'Bearer TOKEN' },
      autoParseJSON: true,
    });

    sse.addEventListener('message', (e) => console.log('Received:', e.data));
    sse.addEventListener('error', (e) => console.error('Error:', e.message));

    sse.start();

    return () => {
      sse.dispose();
    };
  }, []);

  return null;
}
```

---

## Configuration Reference (`SseConfig`)

| Parameter              | Type                                    | Default  | Description                                                     |
| :--------------------- | :-------------------------------------- | :------- | :-------------------------------------------------------------- |
| `url`                  | `string`                                | —        | **Required**. SSE endpoint target.                              |
| `method`               | `'get' \| 'post'`                       | `'get'`  | HTTP method.                                                    |
| `headers`              | `Record<string, string>`                | `{}`     | Custom request headers.                                         |
| `body`                 | `string`                                | —        | Payload sent during POST requests.                              |
| `backgroundExecution`  | `boolean`                               | `false`  | (iOS) Keep background execution active when app is minimized.   |
| `batchingIntervalMs`   | `number`                                | `0`      | Batch window (ms). `0` sends events instantly.                  |
| `maxBufferSize`        | `number`                                | `1000`   | Native memory safety threshold.                                 |
| `connectionTimeoutMs`  | `number`                                | `15000`  | Handshake connect timeout threshold.                            |
| `readTimeoutMs`        | `number`                                | `300000` | Socket inactivity limit triggers reconnect.                     |
| `retryIntervalMs`      | `number`                                | `1000`   | Backoff base delay (ms) for reconnect.                          |
| `maxRetryIntervalMs`   | `number`                                | `30000`  | Cap on backoff reconnect delay (ms).                            |
| `jitterFactor`         | `number`                                | `0.5`    | Randomization spread ratio (`0.0` to `1.0`).                    |
| `maxReconnectAttempts` | `number`                                | `-1`     | Limit reconnections. `-1` = infinite. `0` = disabled.           |
| `maxAuthRetries`       | `number`                                | `3`      | Max consecutive 401/403 retry attempts using `onBeforeRequest`. |
| `autoParseJSON`        | `boolean`                               | `false`  | Parses event `data` on native thread; outputs to `parsedData`.  |
| `monitorNetwork`       | `boolean`                               | `true`   | Pauses/resumes connection on WiFi <-> Cell or link changes.     |
| `onBeforeRequest`      | `() => Promise<Record<string, string>>` | —        | Async hook running immediately before every request.            |
| `mock`                 | `SseMockConfig`                         | —        | Injected mock stream settings (Dev environment only).           |

---

## Mocking & Testing System (`v2.3.0+`)

NitroSSE includes a built-in mock streaming engine to test application responses without running live endpoints. Mocks are automatically disabled in production configurations.

### Configuration (`SseMockConfig`)

```tsx
sse.setup({
  url: 'https://api.mocked-endpoint.com/stream',
  mock: {
    mode: 'replace', // 'replace' = Pure JS local simulation; 'inject' = Server + injected events
    eventsPerSecond: 2,
    loop: true,
    errorRate: 0.1, // 10% chance to simulate connection drops and trigger reconnects
    data: [
      { type: 'open', statusCode: 200 },
      { type: 'message', data: 'Initial greeting' },
      {
        event: 'user-updated',
        data: '{"id":123,"status":"online"}',
        delayMs: 1500,
      },
      { type: 'message', data: 'Periodic heartbeat comments' },
    ],
  },
});
```

### Manual Injector

Inject custom testing events programmatically at runtime to mock specific app situations:

```tsx
sse.injectMockEvent({
  type: 'message',
  event: 'alert',
  data: 'System maintenance warning!',
});
```

---

## Advanced Operations

- **`updateHeaders(headers)`**: Change request headers (e.g., updating expired authentication tokens) without closing and opening the connection manually.
- **`setLastProcessedId(id)`**: Update the native parser's last processed event ID. Native uses this ID as the `Last-Event-ID` header on next reconnection.
- **`restart()`**: Immediately tears down the current network socket and initializes fresh handshake sequence.
- **`flush()`**: Explicitly forces dispatch of currently buffered events, ignoring `batchingIntervalMs`.
- **`getState()`**: Returns the current real-time connection state (`'idle' | 'connecting' | 'open' | 'reconnecting' | 'stale' | 'closed' | 'failed'`).
- **`removeEventListener(type, listener)`**: Unregisters a specific event listener.
- **`removeAllEventListeners(type?)`**: Unregisters all listeners, optionally filtered by event type.
- **`dispose()`**: Synchronously tears down active network sockets, timers, and lifecycle observers, and clears all registered listeners.

---

## License

MIT

---

_Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)_
