# 🚀 react-native-nitro-sse

Thư viện Server-Sent Events (SSE) hiệu năng cao cho React Native, được xây dựng trên nền tảng **Nitro Modules (JSI)**. Được thiết kế cho các hệ thống yêu cầu độ ổn định cực cao, xử lý dữ liệu lớn (Big Data stream) và tối ưu hóa pin tuyệt đối.

## 🌟 Tại sao chọn NitroSSE?

Khác với các thư viện EventSource thông thường chạy trên tầng JS hoặc Bridge truyền thống, NitroSSE đưa toàn bộ logic điều khiển xuống tầng Native sâu nhất:

-   **🚀 Tốc độ JSI**: Giao tiếp giữa JS và Native với độ trễ gần như bằng 0.
-   **🧠 Smart Reconnect**: Tự động kết nối lại với chiến lược **Exponential Backoff** và **Jitters** (chống thundering herd).
-   **🛡️ Bảo vệ Server (DoS Protection)**: Tuân thủ header `Retry-After` (RFC) và giới hạn cứng tần suất kết nối.
-   **🌊 Chống ngập lụt (Backpressure)**: Cơ chế **Batching** gom tin nhắn và **Tail Drop** để bảo vệ UI khỏi bị đóng băng khi server quá tải.
-   **🔋 Mobile-First (Battery Saving)**: Tự động "ngủ đông" (Hibernate) khi app vào background và tái kết nối mượt mà khi quay lại.
-   **💓 Heartbeat Detection**: Phát hiện các tín hiệu keep-alive (comments) từ server để duy trì watchdog.
-   **🛠️ Full Method Support**: Hỗ trợ đầy đủ GET/POST và tùy chỉnh Headers động (Dynamic Headers).

---

## 📦 Cài đặt

```sh
yarn add react-native-nitro-sse react-native-nitro-modules
# hoặc
npm install react-native-nitro-sse react-native-nitro-modules
```

> **Lưu ý**: Yêu cầu `react-native-nitro-modules` vì đây là hạt nhân giúp thư viện đạt hiệu năng cao.

---

## 🚀 Hướng dẫn sử dụng

### 1. Khởi tạo cơ bản

```tsx
import { NitroSseModule } from 'react-native-nitro-sse';

NitroSseModule.setup(
  {
    url: 'https://api.yourserver.com/stream',
    method: 'get',
    headers: {
      'Authorization': 'Bearer active-token',
    },
    // Gom tin nhắn mỗi 100ms để tối ưu UI render
    batchingIntervalMs: 100,
    // Chỉ giữ tối đa 1000 tin nhắn trong hàng đợi
    maxBufferSize: 1000,
  },
  (events) => {
    events.forEach((event) => {
      if (event.type === 'message') {
        console.log('Nhận dữ liệu:', event.data);
      } else if (event.type === 'heartbeat') {
        console.log('Server vẫn đang sống...');
      }
    });
  }
);

// Bắt đầu kết nối
NitroSseModule.start();

// Ngắt kết nối khi không cần thiết
// NitroSseModule.stop();
```

### 2. Cập nhật Token mà không cần Restart

Khi token hết hạn, bạn có thể cập nhật header ngay lập tức. Native sẽ sử dụng nó cho lần tự động reconnect tiếp theo.

```tsx
NitroSseModule.updateHeaders({
  'Authorization': 'Bearer new-fresh-token',
});
```

---

## ⚙️ Cấu hình (SseConfig)

| Tham số | Kiểu dữ liệu | Mô tả |
| :--- | :--- | :--- |
| `url` | `string` | **Bắt buộc**. URL của endpoint SSE. |
| `method` | `'get' \| 'post'` | Phương thức HTTP (Mặc định: `get`). |
| `headers` | `Record<string, string>` | Các custom headers (Auth, Content-Type...). |
| `body` | `string` | Thân bản tin (dùng cho POST). |
| `batchingIntervalMs` | `number` | Thời gian gom event trước khi đẩy lên JS (Mặc định: 0 - đẩy ngay). |
| `maxBufferSize` | `number` | Giới hạn hàng đợi Native giúp chống tràn bộ nhớ (Mặc định: 1000). |
| `backgroundExecution` | `boolean` | (iOS) Cố gắng duy trì task ngắn hạn khi vào background. |

---

## 🏗️ Kiến trúc hệ thống

Dự án sử dụng mô hình **Producer-Consumer** an toàn:
1.  **Native (Producer)**: Thu thập dữ liệu từ Socket ở Background Thread, xử lý Backpressure.
2.  **Nitro (Bridge)**: Snapshot dữ liệu và vận chuyển an toàn qua JSI CallInvoker.
3.  **JavaScript (Consumer)**: Tiêu thụ dữ liệu theo từng Batch, đảm bảo UI Loop luôn mượt mà.

---

## 📄 Giấy phép

MIT

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)
