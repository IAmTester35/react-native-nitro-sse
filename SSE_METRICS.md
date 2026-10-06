# SSE Connection Metrics Specification (`getStats`)

Tài liệu thiết kế và đặc tả kỹ thuật cho các chỉ số đo lường (metrics) trong API `getStats()` sau khi chuyển đổi sang Custom SSE Parser ([SseEventReader](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/android/src/main/java/com/margelo/nitro/nitrosse/SseConnectionHandler.kt) trên Android và [RealSseEventSource](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/ios/SseConnectionHandler.swift) trên iOS).

---

## 1. Phân loại Metrics theo Tầng Kiến Trúc

### 1.1. Tầng Framing & Parser Spec (WHATWG SSE)

Tận dụng việc tự scan dòng và tách byte thay vì dùng thư viện bên ngoài:

| Metric | Type | Mô tả & Cách đo | Mục đích giám sát |
| :--- | :--- | :--- | :--- |
| `totalEventsReceived` | `number` | Tổng số event hợp lệ (`data:` field hoàn chỉnh kết thúc bằng double newline). | Đếm số lượng message logic nhận được từ server. |
| `commentsReceived` | `number` | Số dòng comment (bắt đầu bằng `:`) mà parser đã xử lý. | Giám sát tần suất heartbeat/ping mà server gửi trong lúc stream idle. |
| `linesParsed` | `number` | Tổng số dòng text đã quét qua scanner (kể cả dòng trống, field name). | Đo thông lượng (throughput) và tải của vòng lặp parse. |
| `parseErrors` | `number` | Số dòng vi phạm format (vượt `MAX_SSE_LINE_LENGTH`, byte lỗi UTF-8). | Cảnh báo khi server gửi payload sai chuẩn hoặc packet bị hỏng. |
| `serverRetryDelayMs` | `number?` | Giá trị chỉ thị `retry: <ms>` mới nhất server yêu cầu client chờ trước khi kết nối lại. | Theo dõi cấu hình backoff do backend chủ động điều khiển. |

### 1.2. Tầng Transport & Network IO

Theo dõi trực tiếp dữ liệu thô từ socket và HTTP layer:

| Metric | Type | Mô tả & Cách đo | Mục đích giám sát |
| :--- | :--- | :--- | :--- |
| `rawBytesReceived` | `number` | Dung lượng byte thực tế nhận qua socket từ OS network delegate trước giải nén. | Đo lường chính xác băng thông mạng (data usage) tiêu thụ trên 4G/5G/WiFi. |
| `decompressedBytesReceived` | `number` | Dung lượng byte sau khi giải nén Gzip (nếu server có gzip). | Tính tỉ lệ nén băng thông: `rawBytesReceived / decompressedBytesReceived`. |
| `totalBytesReceived` | `number` | Tổng số byte UTF-8 của decoded payload (giữ tương thích ngược). | So sánh độ nở dữ liệu sau khi decode sang string. |
| `chunksReceived` | `number` | Số lần delegate nhận chunk từ socket (`didReceive data` hoặc read buffer). | Đo mức độ phân mảnh TCP packet và chất lượng mạng. |
| `lastStatusCode` | `number?` | HTTP status code của response hiện tại hoặc response lỗi gần nhất (200, 401, 502...). | Phân loại lỗi HTTP tầng transport mà không cần parse chuỗi error. |

### 1.3. Tầng Latency & Stream Health

Giám sát độ trễ, nhịp độ stream và phát hiện kết nối treo ngầm:

| Metric | Type | Mô tả & Cách đo | Mục đích giám sát |
| :--- | :--- | :--- | :--- |
| `connectedAt` | `number?` | Epoch timestamp (ms) khi nhận `200 OK` (`connectionDidOpen`). | Tính thời gian kết nối đang duy trì (`uptime = Date.now() - connectedAt`). |
| `timeToFirstByteMs` | `number?` | Khoảng thời gian (ms) từ khi gửi request đến khi nhận byte đầu tiên từ server. | Đo độ trễ khởi tạo kết nối (DNS lookup + TCP handshake + TLS + Server TTFB). |
| `lastEventTime` | `number?` | Epoch timestamp (ms) nhận được event `message` gần nhất. | Xác định độ tươi của dữ liệu. |
| `lastHeartbeatTime` | `number?` | Epoch timestamp (ms) nhận được comment/heartbeat gần nhất. | Phân biệt giữa server idle bình thường vs kết nối bị treo. |
| `maxEventGapMs` | `number` | Khoảng thời gian lớn nhất (ms) giữa 2 event (hoặc heartbeat) liên tiếp trong session. | **Phát hiện stream bị stall / nghẽn mạng cục bộ** trong các ứng dụng real-time/LLM token. |

### 1.4. Tầng Buffer & JSI Batching

Đo hiệu năng và hành vi của [SseEventBuffer](file:///Users/nammaithanh/Desktop/Samset/react-native-nitro-sse/src/SseInterface.ts):

| Metric | Type | Mô tả & Cách đo | Mục đích giám sát |
| :--- | :--- | :--- | :--- |
| `eventsBuffered` | `number` | Số lượng event hiện đang xếp hàng chờ flush về JavaScript. | Đánh giá backpressure hiện thời tại thời điểm đọc stats. |
| `peakBufferedEvents` | `number` | Số lượng event tối đa từng nằm trong hàng đợi buffer cùng lúc (high-water mark). | **Đánh giá buffer có nguy cơ chạm ngưỡng đầy** (`maxBufferSize`) hay không để tinh chỉnh config. |
| `bufferFlushCount` | `number` | Tổng số lần trigger flush buffer qua JSI callback. | Đánh giá tần suất tương tác với JavaScript runtime. |
| `bufferOverflowCount` | `number` | Số lần buffer chạm `maxBufferSize` buộc phải flush sớm trước chu kỳ `batchingIntervalMs`. | Cảnh báo tốc độ bắn event từ server vượt quá khả năng tiêu thụ của buffer. |

### 1.5. Tầng Diagnostics & Reconnect

Chẩn đoán nguyên nhân ngắt kết nối và cơ chế tự phục hồi:

| Metric | Type | Mô tả & Cách đo | Mục đích giám sát |
| :--- | :--- | :--- | :--- |
| `connectionAttempts` | `number` | Tổng số lần phát request kết nối (kể cả lần đầu và các lần retry thất bại). | Phân biệt tỷ lệ kết nối thành công: `reconnectCount / connectionAttempts`. |
| `reconnectCount` | `number` | Số lần kết nối lại thành công sau khi bị đứt. | Đánh giá độ ổn định tổng thể của session. |
| `lastReconnectDelayMs` | `number?` | Thời gian backoff chờ (ms) của lần reconnect gần nhất. | Kiểm tra tính toán exponential backoff & jitter có hoạt động chuẩn xác. |
| `disconnectReason` | `SseDisconnectReason?` | Phân loại nguyên nhân dẫn đến lần ngắt kết nối gần nhất: `'user_stop'`, `'network_error'`, `'server_error'`, `'parser_error'`, `'timeout'`. | **Xác định chính xác nguyên nhân ngắt kết nối** để UI xử lý tương ứng (không retry nếu do user hoặc lỗi 4xx cố định). |
| `lastErrorTime` | `number?` | Epoch timestamp (ms) của lỗi gần nhất. | Ghi log thời điểm phát sinh sự cố. |
| `lastErrorCode` | `string?` | Mã lỗi định danh hoặc domain error từ OS. | Tra cứu nhanh lỗi native (`NSURLErrorTimedOut`, `CLEARTEXT_NOT_PERMITTED`...). |

---

## 2. Đặc Tả TypeScript Interface Đề Xuất

```typescript
export type SseDisconnectReason =
  | 'user_stop'
  | 'network_error'
  | 'server_error'
  | 'parser_error'
  | 'timeout';

export interface SseStats {
  // === Transport & Socket ===
  /** Raw bytes received from the network socket before decompression. */
  rawBytesReceived: number;
  /** Decompressed bytes received (if gzip/compression applied). */
  decompressedBytesReceived?: number;
  /** Decoded payload byte length (for backward compatibility). */
  totalBytesReceived: number;
  /** Number of data chunks/packets read from the network transport. */
  chunksReceived: number;
  /** HTTP response status code of the current or last connection attempt. */
  lastStatusCode?: number;

  // === Parser & Framing ===
  /** Total valid SSE message events parsed and emitted. */
  totalEventsReceived: number;
  /** Total SSE comment lines (':') received as heartbeats. */
  commentsReceived: number;
  /** Total raw lines processed by the SSE parser. */
  linesParsed: number;
  /** Number of parsing errors encountered (line length limit exceeded, invalid UTF-8, etc.). */
  parseErrors: number;
  /** Latest retry delay requested by server via 'retry:' directive (ms). */
  serverRetryDelayMs?: number;

  // === Latency & Timing ===
  /** Epoch timestamp (ms) when the active connection was established. */
  connectedAt?: number;
  /** Latency in ms from connection start to first body byte received. */
  timeToFirstByteMs?: number;
  /** Epoch timestamp (ms) of the most recently received event. */
  lastEventTime?: number;
  /** Epoch timestamp (ms) of the most recently received heartbeat/comment. */
  lastHeartbeatTime?: number;
  /** Maximum elapsed time (ms) between consecutive events/heartbeats (stall detection). */
  maxEventGapMs: number;

  // === Buffer & Backpressure ===
  /** Number of events currently waiting in the dispatch buffer. */
  eventsBuffered: number;
  /** Maximum number of events queued in the buffer at any one time (high-water mark). */
  peakBufferedEvents: number;
  /** Total number of buffer flushes to JavaScript. */
  bufferFlushCount: number;
  /** Total number of early flushes triggered because buffer reached maxBufferSize. */
  bufferOverflowCount: number;

  // === Reconnection & Diagnostics ===
  /** Total connection attempts made (initial and retries). */
  connectionAttempts: number;
  /** Number of successful reconnections. */
  reconnectCount: number;
  /** Delay in ms used for the last reconnect attempt. */
  lastReconnectDelayMs?: number;
  /** Reason for the last disconnection. */
  disconnectReason?: SseDisconnectReason;
  /** Timestamp of the last error event. */
  lastErrorTime?: number;
  /** Error code or domain of the last error. */
  lastErrorCode?: string;
}
```

---

## 3. Hướng Dẫn Triển Khai Native (Zero Overhead)

1. **Bộ đếm O(1)**:
   - Android: Dùng `AtomicLong` hoặc biến nguyên thủy trong `HandlerThread` của `SseDispatcher`.
   - iOS: Dùng biến nguyên thủy trong `SseDispatcher` (`DispatchQueue`).
2. **Cập nhật `maxEventGapMs`**:
   - Khi nhận event hoặc comment mới:
     ```kotlin
     val now = System.currentTimeMillis()
     if (lastActivityTime > 0) {
         val gap = now - lastActivityTime
         if (gap > maxEventGapMs) maxEventGapMs = gap
     }
     lastActivityTime = now
     ```
3. **Cập nhật `peakBufferedEvents`**:
   - Trong hàm `push()` của `SseEventBuffer`:
     ```swift
     if buffer.count > peakBufferedEvents {
         peakBufferedEvents = buffer.count
     }
     ```
4. **Xác định `disconnectReason`**:
   - Gọi `stop()` bởi client -> `'user_stop'`.
   - `didCompleteWithError` với `NSURLErrorTimedOut` hoặc OkHttp `SocketTimeoutException` -> `'timeout'`.
   - `didCompleteWithError` do mất kết nối mạng/DNS (`NSURLErrorNotConnectedToInternet`) -> `'network_error'`.
   - HTTP status >= 400 -> `'server_error'`.
   - Parser ném lỗi (vượt `MAX_SSE_LINE_LENGTH`) -> `'parser_error'`.
