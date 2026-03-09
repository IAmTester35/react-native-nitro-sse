# 🚀 react-native-nitro-sse

High-performance Server-Sent Events (SSE) client for React Native, built on top of **Nitro Modules (JSI)**. Designed for mission-critical systems requiring extreme stability, high-throughput data streaming, and absolute battery optimization.

## 🌟 Why NitroSSE?

Unlike traditional EventSource libraries that run on the JS thread or use the legacy Bridge, NitroSSE moves the entire control logic down to the deepest Native layer:

-   **🚀 Zero-Latency JSI**: Communication between JS and Native is instantaneous, bypassing the asynchronous bridge.
-   **🧠 Smart Reconnect**: Automatic reconnection strategy using **Exponential Backoff** and **Jitter** to prevent thundering herd problems.
-   **🛡️ DoS Protection**: Respects RFC `Retry-After` headers and enforces strict connection frequency limits.
-   **🌊 Backpressure Handling**: Advanced **Batching** mechanism aggregates messages and employs **Tail Drop** strategies to protect the UI thread from freezing during data surges.
-   **🔋 Mobile-First Architecture**: Automatically hibernates when the app enters the background and seamlessly reconnects upon foregrounding to conserve battery.
-   **💓 Heartbeat Detection**: Native-side detection of keep-alive signals (comments) to maintain a reliable connection watchdog.
-   **🔍 DevTools Integration**: Plug-and-play support for **React Native 0.83+ DevTools Network Tab**. Monitor connection status, request/response headers, and timing directly in the official desktop debugger.
-   **🛠️ Full Protocol Support**: Comprehensive support for GET/POST methods and dynamic header updates.

---

## 📦 Installation

```sh
yarn add react-native-nitro-sse react-native-nitro-modules
# or
npm install react-native-nitro-sse react-native-nitro-modules
```

> **Note**: `react-native-nitro-modules` is required as the core foundation for JSI performance.

---

## 📊 Compatibility

| react-native-nitro-sse | react-native-nitro-modules |
| :--------------------- | :------------------------- |
| **1.5.1**              | **0.35.0**                 |
| **1.4.0 - 1.5.0**      | **0.35.0**                 |
| **1.2.2 - 1.3.1**      | **0.34.1**                 |
| **1.2.0 - 1.2.1**      | **0.34.0**                 |
| **1.1.0**              | **0.33.9**                 |
| **1.0.0**              | **0.33.8**                 |


---

## 🚀 Usage

### 1. Basic Initialization

Initialize the module with your endpoint configuration and an event listener.

```tsx
import { createNitroSse } from 'react-native-nitro-sse';

const nitroSse = createNitroSse();

nitroSse.setup(
  {
    url: 'https://api.yourserver.com/stream',
    method: 'get',
    headers: {
      'Authorization': 'Bearer active-token',
    },
    // Batch messages every 100ms to optimize UI rendering
    batchingIntervalMs: 100,
    // Maximum of 1000 messages in the native queue before forced flush
    maxBufferSize: 1000,
    // Optional: Auto-refresh tokens or dynamic headers
    onBeforeRequest: async () => {
      const token = await fetchNewToken();
      return { 'Authorization': `Bearer ${token}` };
    }
  },
  (events) => {
    // events is an array of SseEvent objects
    events.forEach((event) => {
      console.log('Received:', event);
    });
  }
);

// Start the connection
nitroSse.start();
```

### 2. Monitoring & Statistics

NitroSSE provides synchronous access to connection health and throughput data.

```tsx
const stats = nitroSse.getStats();
console.log(`Downloaded: ${stats.totalBytesReceived / 1024} KB`);
console.log(`Reconnections: ${stats.reconnectCount}`);
```

---

## ⚙️ Configuration (SseConfig)

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `url` | `string` | - | **Required**. The URL of the SSE endpoint. |
| `method` | `'get' \| 'post'` | `get` | HTTP method. |
| `headers` | `Record<string, string>` | `{}` | Custom HTTP headers. |
| `body` | `string` | - | Request body (payload) for POST requests. |
| `batchingIntervalMs` | `number` | `0` | Time window (ms) to group events. `0` = real-time. |
| `maxBufferSize` | `number` | `1000` | Native queue limit to prevent memory overflow. |
| `connectionTimeoutMs`| `number` | `15000` | Max time for initial handshake / connect. |
| `readTimeoutMs`      | `number` | `300000`| Max idle time between data packets before reconnecting. |
| `backgroundExecution` | `boolean` | `false` | (iOS) Attempt to maintain connection via background tasks. |
| `onBeforeRequest`    | `function`| - | Async hook to refresh headers/tokens before every attempt. |

---

## 🛡️ Reliability Features (v1.5.1+)

-   **Atomic State Management**: Calling `.start()` or `.stop()` updates the instance status immediately on the JSI thread, ensuring the UI (e.g., `isConnected()`) never feels laggy or stuck.
-   **Promise Safety**: The `onBeforeRequest` interceptor is wrapped in a native fallback timeout. Even if your JS token refresh hangs indefinitely, the native state machine will recover and retry safely.
-   **Zero-Ghost Reloads**: Seamlessly handles React Native Hot Reloads. The native layer detects when the JS environment is being destroyed and synchronously kills active sockets to prevent duplicate connections.
-   **Cumulative Logic**: Statistics (`totalBytesReceived`) are preserved across reconnections, giving you a true 360-degree view of the session's data usage.

---

## 🏗️ System Architecture

This project employs a robust **Producer-Consumer** model:

1.  **Native (Producer)**: Collects data from the socket on a dedicated Background Thread, handling all backpressure logic.
2.  **Nitro (Bridge)**: Snapshots data and securely transports it via the JSI CallInvoker.
3.  **JavaScript (Consumer)**: Consumes data in batches, ensuring the UI Loop remains buttery smooth even under heavy load.

---

## 📄 License

MIT

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)
