import Foundation

/// Value-type telemetry container tracking transport, parser, timing, and lifecycle metrics for `NitroSse`.
/// Access is serialized externally by `NitroSse` on its `SseDispatcher` queue.
internal struct SseMetrics {
    // Transport metrics
    private var rawBytesReceived: Double = 0
    private var decompressedBytesReceived: Double?
    private var sessionRawBytesBase: Double = 0
    private var currentTaskRawBytes: Double = 0
    private var sessionDecompressedBytesBase: Double = 0
    private var currentTaskDecompressedBytes: Double = 0
    private(set) var totalBytesReceived: Double = 0
    private var chunksReceived: Double = 0
    private var lastStatusCode: Double?

    // Parser metrics
    private var totalEventsReceived: Double = 0
    private var commentsReceived: Double = 0
    private var linesParsed: Double = 0
    private var parseErrors: Double = 0
    private var serverRetryDelayMs: Double?

    // Timing metrics
    private var connectedAt: Double?
    private var connectionAttemptStartTime: Double?
    private var timeToFirstByteMs: Double?
    private var lastEventTime: Double?
    private var lastHeartbeatTime: Double?
    private var lastActivityTime: Double = 0
    private var maxEventGapMs: Double = 0

    // Lifecycle & error metrics
    private var connectionAttempts: Double = 0
    private var reconnectCount: Double = 0
    private var lastReconnectDelayMs: Double?
    private var disconnectReason: SseDisconnectReason?
    private var lastErrorTime: Double?
    private var lastErrorCode: String?

    mutating func resetSessionByteCounters() {
        sessionRawBytesBase = 0
        currentTaskRawBytes = 0
        sessionDecompressedBytesBase = 0
        currentTaskDecompressedBytes = 0
        rawBytesReceived = 0
        decompressedBytesReceived = nil
    }

    mutating func recordConnectionAttemptStart(now: Double) {
        connectionAttempts += 1
        connectionAttemptStartTime = now
        timeToFirstByteMs = nil
    }

    mutating func recordOpen(statusCode: Int, isReconnect: Bool, now: Double) {
        if isReconnect {
            reconnectCount += 1
        }
        lastStatusCode = Double(statusCode)
        connectedAt = now
    }

    mutating func recordDataChunk(rawWireBytes: Int64, decompressedBytes: Int64?, now: Double) {
        chunksReceived += 1
        currentTaskRawBytes = Double(rawWireBytes)
        rawBytesReceived = sessionRawBytesBase + currentTaskRawBytes
        if let decomp = decompressedBytes {
            currentTaskDecompressedBytes = Double(decomp)
            decompressedBytesReceived = sessionDecompressedBytesBase + currentTaskDecompressedBytes
        }
        if timeToFirstByteMs == nil, let start = connectionAttemptStartTime {
            timeToFirstByteMs = now - start
        }
    }

    mutating func recordLinesParsed(_ count: Int) {
        linesParsed += Double(count)
    }

    mutating func recordParseError() {
        parseErrors += 1
        disconnectReason = .parserError
    }

    mutating func recordMessage(eventType: String, data: String, now: Double) {
        let encodedDataSize = Double(data.utf8.count)
        // WHATWG SSE accounting:
        // - `message` is the default event type and is often omitted on the wire, so don't count it.
        // - id byte accounting is handled when id: is encountered to avoid duplicate counting.
        let eventTypeSize = (eventType.isEmpty || eventType == "message") ? 0.0 : Double(eventType.utf8.count)
        totalBytesReceived += encodedDataSize + eventTypeSize
        totalEventsReceived += 1
        lastEventTime = now
        recordActivity(now: now)
    }

    mutating func recordComment(_ comment: String, now: Double) {
        totalBytesReceived += Double(comment.utf8.count)
        commentsReceived += 1
        lastHeartbeatTime = now
        recordActivity(now: now)
    }

    mutating func recordServerRetryDelay(_ retryMs: Int64) {
        serverRetryDelayMs = Double(retryMs)
    }

    mutating func recordLastEventIdBytes(_ id: String) {
        totalBytesReceived += Double(id.utf8.count)
    }

    mutating func recordReconnectDelay(seconds: TimeInterval) {
        lastReconnectDelayMs = seconds * 1000.0
    }

    mutating func recordUserStop() {
        disconnectReason = .userStop
    }

    mutating func recordConnectionEnded() {
        connectedAt = nil
        flushTaskBytes()
    }

    mutating func recordFailure(
        statusCode: Int?,
        disconnectReason: SseDisconnectReason,
        errorCode: String,
        now: Double
    ) {
        connectedAt = nil
        flushTaskBytes()
        if let statusCode = statusCode {
            lastStatusCode = Double(statusCode)
        }
        self.disconnectReason = disconnectReason
        lastErrorTime = now
        lastErrorCode = errorCode
    }

    func toSseStats(eventBuffer: SseEventBuffer) -> SseStats {
        return SseStats(
            rawBytesReceived: rawBytesReceived,
            decompressedBytesReceived: decompressedBytesReceived,
            totalBytesReceived: totalBytesReceived,
            chunksReceived: chunksReceived,
            lastStatusCode: lastStatusCode,
            totalEventsReceived: totalEventsReceived,
            commentsReceived: commentsReceived,
            linesParsed: linesParsed,
            parseErrors: parseErrors,
            serverRetryDelayMs: serverRetryDelayMs,
            connectedAt: connectedAt,
            timeToFirstByteMs: timeToFirstByteMs,
            lastEventTime: lastEventTime,
            lastHeartbeatTime: lastHeartbeatTime,
            maxEventGapMs: maxEventGapMs,
            eventsBuffered: Double(eventBuffer.eventsBuffered),
            peakBufferedEvents: Double(eventBuffer.peakBufferedEvents),
            bufferFlushCount: Double(eventBuffer.bufferFlushCount),
            bufferOverflowCount: Double(eventBuffer.bufferOverflowCount),
            connectionAttempts: connectionAttempts,
            reconnectCount: reconnectCount,
            lastReconnectDelayMs: lastReconnectDelayMs,
            disconnectReason: disconnectReason,
            lastErrorTime: lastErrorTime,
            lastErrorCode: lastErrorCode
        )
    }

    private mutating func recordActivity(now: Double) {
        if lastActivityTime > 0 {
            let gap = now - lastActivityTime
            if gap > maxEventGapMs {
                maxEventGapMs = gap
            }
        }
        lastActivityTime = now
    }

    private mutating func flushTaskBytes() {
        sessionRawBytesBase += currentTaskRawBytes
        currentTaskRawBytes = 0
        sessionDecompressedBytesBase += currentTaskDecompressedBytes
        currentTaskDecompressedBytes = 0
    }
}
