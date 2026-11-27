package com.margelo.nitro.nitrosse

import java.util.concurrent.atomic.AtomicLong

/**
 * Thread-safe telemetry store for [NitroSse].
 *
 * Lock-ordering invariant: [SseMetrics] uses its own private [lock] and NEVER calls back into
 * [NitroSse] or [SseEventBuffer] while holding [lock], preventing lock-inversion deadlocks.
 */
@Suppress("TooManyFunctions") // Cohesive telemetry store exposing one recorder per SSE lifecycle/metric event.
internal class SseMetrics {
    private val lock = Any()

    // Transport Metrics
    private var rawBytesReceived: Double = 0.0
    private var decompressedBytesReceived: Double? = null
    private var sessionRawBytesOffset: Double = 0.0
    private val totalBytesReceived = AtomicLong(0)
    private var chunksReceived: Double = 0.0
    private var lastStatusCode: Double? = null

    // Parser Metrics
    private var totalEventsReceived: Double = 0.0
    private var commentsReceived: Double = 0.0
    private var linesParsed: Double = 0.0
    private var parseErrors: Double = 0.0
    private var serverRetryDelayMs: Double? = null

    // Latency & Timing Metrics
    private var connectedAt: Double? = null
    private var connectionAttemptStartTime: Double? = null
    private var timeToFirstByteMs: Double? = null
    private var lastEventTime: Double? = null
    private var lastHeartbeatTime: Double? = null
    private var lastActivityTime: Double = 0.0
    private var maxEventGapMs: Double = 0.0

    // Lifecycle & Reconnect Metrics
    private var connectionAttempts: Double = 0.0
    private var reconnectCount: Double = 0.0
    private var lastReconnectDelayMs: Double? = null
    private var disconnectReason: SseDisconnectReason? = null
    private var lastErrorTime: Double? = null
    private var lastErrorCode: String? = null

    fun resetSessionByteCounters() {
        synchronized(lock) {
            rawBytesReceived = 0.0
            decompressedBytesReceived = null
            sessionRawBytesOffset = 0.0
        }
    }

    fun recordConnectionAttemptStart(now: Double) {
        synchronized(lock) {
            connectionAttempts += 1.0
            connectionAttemptStartTime = now
            timeToFirstByteMs = null
        }
    }

    fun recordOpen(statusCode: Int, isReconnect: Boolean, now: Double) {
        synchronized(lock) {
            if (isReconnect) {
                reconnectCount += 1.0
            }
            lastStatusCode = statusCode.toDouble()
            connectedAt = now
        }
    }

    fun recordDataChunk(decompressedBytes: Long, requestId: String, now: Double) {
        synchronized(lock) {
            chunksReceived += 1.0
            val isGzip = SseNetworkMetricsTracker.isGzip(requestId)
            if (isGzip) {
                decompressedBytesReceived = (decompressedBytesReceived ?: 0.0) + decompressedBytes.toDouble()
                val raw = SseNetworkMetricsTracker.getRawBytes(requestId)
                rawBytesReceived = sessionRawBytesOffset + (raw?.toDouble() ?: decompressedBytes.toDouble())
            } else {
                rawBytesReceived += decompressedBytes.toDouble()
            }
            if (timeToFirstByteMs == null && connectionAttemptStartTime != null) {
                timeToFirstByteMs = now - connectionAttemptStartTime!!
            }
        }
    }

    fun accumulateGzipRawBytesOffset(retiringRequestId: String?) {
        if (retiringRequestId == null || !SseNetworkMetricsTracker.isGzip(retiringRequestId)) return
        val rawBytes = SseNetworkMetricsTracker.getRawBytes(retiringRequestId) ?: return
        synchronized(lock) {
            sessionRawBytesOffset += rawBytes.toDouble()
        }
    }

    fun recordLinesParsed(count: Int) {
        synchronized(lock) {
            linesParsed += count.toDouble()
        }
    }

    fun recordParseError() {
        synchronized(lock) {
            parseErrors += 1.0
            disconnectReason = SseDisconnectReason.PARSER_ERROR
        }
    }

    fun recordMessage(encodedDataSize: Long, eventTypeSize: Long, now: Double) {
        totalBytesReceived.addAndGet(encodedDataSize + eventTypeSize)
        synchronized(lock) {
            totalEventsReceived += 1.0
            lastEventTime = now
            recordActivityLocked(now)
        }
    }

    fun recordComment(commentBytes: Long, now: Double) {
        totalBytesReceived.addAndGet(commentBytes)
        synchronized(lock) {
            commentsReceived += 1.0
            lastHeartbeatTime = now
            recordActivityLocked(now)
        }
    }

    fun recordServerRetryDelay(retryMs: Long) {
        synchronized(lock) {
            serverRetryDelayMs = retryMs.toDouble()
        }
    }

    fun recordLastEventIdBytes(idBytes: Long) {
        totalBytesReceived.addAndGet(idBytes)
    }

    fun recordReconnectDelay(delayMs: Double) {
        synchronized(lock) {
            lastReconnectDelayMs = delayMs
        }
    }

    fun recordUserStop() {
        synchronized(lock) {
            disconnectReason = SseDisconnectReason.USER_STOP
            connectedAt = null
        }
    }

    fun clearConnectedAt() {
        synchronized(lock) {
            connectedAt = null
        }
    }

    fun recordFailure(
        statusCode: Int,
        disconnectReason: SseDisconnectReason,
        errorCode: String,
        now: Double
    ) {
        synchronized(lock) {
            connectedAt = null
            if (statusCode != SseHttpStatus.UNKNOWN) {
                lastStatusCode = statusCode.toDouble()
            }
            lastErrorTime = now
            lastErrorCode = errorCode
            this.disconnectReason = disconnectReason
        }
    }

    fun getTotalBytesReceived(): Long = totalBytesReceived.get()

    internal fun getSessionRawBytesOffset(): Double = synchronized(lock) { sessionRawBytesOffset }

    fun toSseStats(
        eventsBuffered: Double,
        peakBufferedEvents: Double,
        bufferFlushCount: Double,
        bufferOverflowCount: Double
    ): SseStats = synchronized(lock) {
        SseStats(
            rawBytesReceived = rawBytesReceived,
            decompressedBytesReceived = decompressedBytesReceived,
            totalBytesReceived = totalBytesReceived.get().toDouble(),
            chunksReceived = chunksReceived,
            lastStatusCode = lastStatusCode,
            totalEventsReceived = totalEventsReceived,
            commentsReceived = commentsReceived,
            linesParsed = linesParsed,
            parseErrors = parseErrors,
            serverRetryDelayMs = serverRetryDelayMs,
            connectedAt = connectedAt,
            timeToFirstByteMs = timeToFirstByteMs,
            lastEventTime = lastEventTime,
            lastHeartbeatTime = lastHeartbeatTime,
            maxEventGapMs = maxEventGapMs,
            eventsBuffered = eventsBuffered,
            peakBufferedEvents = peakBufferedEvents,
            bufferFlushCount = bufferFlushCount,
            bufferOverflowCount = bufferOverflowCount,
            connectionAttempts = connectionAttempts,
            reconnectCount = reconnectCount,
            lastReconnectDelayMs = lastReconnectDelayMs,
            disconnectReason = disconnectReason,
            lastErrorTime = lastErrorTime,
            lastErrorCode = lastErrorCode
        )
    }

    private fun recordActivityLocked(now: Double) {
        if (lastActivityTime > 0.0) {
            val gap = now - lastActivityTime
            if (gap > maxEventGapMs) {
                maxEventGapMs = gap
            }
        }
        lastActivityTime = now
    }
}
