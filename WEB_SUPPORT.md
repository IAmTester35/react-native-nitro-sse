# Web Support Architecture Specification

Tài liệu phân tích và đặc tả kiến trúc hỗ trợ nền tảng Web cho thư viện `react-native-nitro-sse`, giải thích lý do tại sao không thể dùng `window.EventSource` tiêu chuẩn và giải pháp thay thế thông qua [`SseDriver`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseDriver.ts#L8-L20).

---

## 1. Giới Hạn Của Browser `EventSource` Tiêu Chuẩn

API `EventSource` (W3C / WHATWG) trên trình duyệt có thiết kế đóng kín và hạn chế nhiều tính năng mạng nâng cao mà [`SseConfig`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseInterface.ts#L41-L130) và [`SseClient`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseInterface.ts#L249-L307) yêu cầu.

### Bảng So Sánh Tính Năng

| Tính năng trong `react-native-nitro-sse` | Browser `window.EventSource` | Khả năng đáp ứng | Lý do / Chi tiết kỹ thuật |
| :--- | :--- | :--- | :--- |
| **HTTP Methods & Body** (`method: 'post'`, `body: string`) | Chỉ hỗ trợ `GET` | ❌ Không hỗ trợ | Không thể gửi payload trong request khởi tạo stream (e.g. LLM chat completions). |
| **Custom HTTP Headers** (`headers: Record<string, string>`) | Không cho phép custom headers | ❌ Không hỗ trợ | Trình duyệt chỉ cho phép gửi cookie qua `withCredentials: true`. Không truyền được header `Authorization: Bearer <token>` hay `X-API-Key`. |
| **Dynamic Request Interceptor** ([`onBeforeRequest`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseInterface.ts#L135-L142)) | Không hỗ trợ | ❌ Không hỗ trợ | Không có hook để refresh token async trước mỗi lần reconnect. |
| **Dynamic Headers Update** ([`updateHeaders`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseInterface.ts#L298)) | Không hỗ trợ | ❌ Không hỗ trợ | Không thể cập nhật header trên connection đang chạy hoặc chuẩn bị retry. |
| **Reconnection Control** (`retryIntervalMs`, `maxRetryIntervalMs`, `jitterFactor`) | Trình duyệt tự quản lý | ❌ Không cấu hình được | Trình duyệt chỉ nhận chỉ thị `retry:` từ server; client không thể áp dụng Exponential Backoff và Jitter. |
| **Giới hạn số lần thử lại** (`maxReconnectAttempts`, `maxAuthRetries`) | Vô hạn theo browser | ❌ Không kiểm soát được | Trình duyệt tự retry liên tục; không thể dừng khi gặp lỗi 401/403 hay vượt ngưỡng max retry. |
| **Timeout kiểm soát** (`connectionTimeoutMs`, `readTimeoutMs`) | Opaque | ❌ Không hỗ trợ | Không thể phát hiện stream bị treo (stale connection) khi server ngừng gửi heartbeat. |
| **Last-Event-ID Manipulation** ([`setLastProcessedId`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseInterface.ts#L300)) | Trình duyệt tự lưu ngầm | ❌ Không can thiệp được | Không cho phép override thủ công `Last-Event-ID` trước khi reconnect. |
| **Chỉ số đo lường** ([`getStats`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseInterface.ts#L296)) | Không có metrics | ❌ Không hỗ trợ | Không đo được `totalBytesReceived`, `reconnectCount`, `lastErrorTime`, `lastErrorCode`. |
| **Event Batching** (`batchingIntervalMs`, `maxBufferSize`) | Bắn từng DOM event ngay lập tức | ❌ Không hỗ trợ | Không có cơ chế gom cụm event để giảm tải render UI ở stream tần số cao. |
| **Connection States** ([`SseState`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseInterface.ts#L28-L36)) | Chỉ có `readyState` (0, 1, 2) | ❌ Thiếu trạng thái | Không phân biệt được các trạng thái: `idle`, `stale`, `reconnecting`, `paused`, `failed`. |

---

## 2. Kiến Trúc Giải Pháp: Thay Thế Bằng `FetchSseDriver`

Để hỗ trợ Web đầy đủ mà không thay đổi public API ([`SseClient`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseInterface.ts#L249-L307) và [`NitroSseClient`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/NitroSseClient.ts#L376)), thư viện cần triển khai một Driver mới cho Web kế thừa pattern [`SseDriver`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseDriver.ts#L8-L20).

```text
                           ┌────────────────────────┐
                           │     NitroSseClient     │ (Public Facade & Event Emitter)
                           └───────────┬────────────┘
                                       │ delegates to
                                       ▼
                           ┌────────────────────────┐
                           │      <<SseDriver>>     │
                           └───────────┬────────────┘
               ┌───────────────────────┼────────────────────────┐
               ▼                       ▼                        ▼
     ┌───────────────────┐   ┌───────────────────┐    ┌───────────────────┐
     │   NativeDriver    │   │  MockReplace/     │    │   FetchSseDriver  │
     │  (iOS / Android)  │   │  MockInjectDriver │    │       (Web)       │
     │   Nitro JSI Core  │   │   (Simulated)     │    │ fetch() + Streams │
     └───────────────────┘   └───────────────────┘    └───────────────────┘
```

### 2.1. Công Nghệ Nền Tảng Cho Web Driver

Thay vì `window.EventSource`, Web Driver sử dụng:
1. **`fetch()` API với Streaming**: Gọi request với `headers`, `method: 'POST' | 'GET'`, và `body`.
2. **`ReadableStream` (`response.body.getReader()`)**: Đọc từng chunk nhị phân (`Uint8Array`) nhận được từ server theo thời gian thực.
3. **`TextDecoder({ stream: true })`**: Giải mã byte stream sang chuỗi UTF-8 đa byte mà không bị cắt gãy ký tự.
4. **Custom WHATWG SSE Parser**: Quét dòng ký tự (`data:`, `event:`, `id:`, `retry:`, `: comment`) đồng nhất với parser native trên Android ([SseConnectionHandler.kt](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/android/src/main/java/com/margelo/nitro/nitrosse/SseConnectionHandler.kt)) và iOS ([SseConnectionHandler.swift](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/ios/SseConnectionHandler.swift)).
5. **`AbortController`**: Đóng kết nối lập tức khi gọi `stop()` hoặc khi timeout.
6. **Client-side Backoff Loop**: Quản lý reconnect với Exponential Backoff, Jitter, và gọi [`onBeforeRequest`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseInterface.ts#L135-L142) trước mỗi lượt kết nối lại.

---

## 3. Kế Hoạch Triển Khai Chi Tiết

### Bước 1: Tạo Web Driver (`src/FetchSseDriver.ts`)
- Triển khai interface [`SseDriver`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseDriver.ts#L8-L20).
- Chứa vòng lặp đọc stream:
  ```ts
  const response = await fetch(url, { method, headers, body, signal });
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Decode và chuyển qua WHATWG parser
  }
  ```
- Quản lý bộ đệm batching ([`batchingIntervalMs`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseInterface.ts#L62)) trên JS timer (`setTimeout` / `flush()`).

### Bước 2: Tách Entrypoint Cho Nền Tảng Web (`src/createNitroSse.web.ts`)
- React Native bundler (Metro) ưu tiên file có đuôi `.web.ts` khi đóng gói cho nền tảng web.
- Tránh gọi `NitroModules.createHybridObject('NitroSse')` trên web (vốn sẽ throw [`NitroSseModuleNotFoundError`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/createNitroSse.ts#L24-L26)).
- Trả về [`NitroSseClient`](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/NitroSseClient.ts#L376) được cấu hình với `FetchSseDriver`.

### Bước 3: Đồng Bộ Trạng Thái & Metrics
- Đếm `totalBytesReceived` dựa trên `value.byteLength` của từng chunk đọc từ `getReader()`.
- Tăng `reconnectCount` mỗi lần vòng lặp retry được kích hoạt.
- Tự động kích hoạt timer `readTimeoutMs` sau mỗi lần nhận chunk; nếu quá hạn mà không có dữ liệu/heartbeat thì abort và reconnect.
