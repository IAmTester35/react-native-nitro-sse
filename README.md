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
| **1.4.0**              | **0.35.0**                 |
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
    // Maximum of 1000 messages in the native queue before tail-drop
    maxBufferSize: 1000,
  },
  (events) => {
    events.forEach((event) => {
      if (event.type === 'message') {
        console.log('Data received:', event.data);
      } else if (event.type === 'heartbeat') {
        console.log('Server heartbeat detected...');
      }
    });
  }
);

// Start the connection
nitroSse.start();

// Stop the connection when unmounting or no longer needed
// nitroSse.stop();
```


### 2. Check Connection Status

You can synchronously check the connection status at any time:

```tsx
const connected = nitroSse.isConnected();
console.log('Is Connected:', connected);
```


### 3. Dynamic Token Updates

When your authentication token expires, update the headers instantly. The native layer will apply these headers to the next automatic reconnection attempt without interrupting the current flow if not necessary.

```tsx
nitroSse.updateHeaders({
  'Authorization': 'Bearer new-fresh-token',
});
```


---

## ⚙️ Configuration (SseConfig)

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `url` | `string` | **Required**. The URL of the SSE endpoint. |
| `method` | `'get' \| 'post'` | HTTP method (Default: `get`). |
| `headers` | `Record<string, string>` | Custom headers (e.g., Auth, Content-Type). |
| `body` | `string` | Request body (payload) for POST requests. |
| `batchingIntervalMs` | `number` | Time window to buffer events before flushing to JS (Default: 0 - immediate). |
| `maxBufferSize` | `number` | Native queue limit to prevent memory overflow (Default: 1000). |
| `backgroundExecution` | `boolean` | (iOS) Attempt to maintain a background task for a short period. |

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
