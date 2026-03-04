package com.margelo.nitro.nitrosse

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class NitroSseLogicTest {

    private lateinit var eventBuffer: MutableList<SseEvent>
    private var bufferCapacity = 100
    private var batchInterval = 0.0

    @Before
    fun setup() {
        eventBuffer = mutableListOf()
    }

    private fun pushEventToBuffer(event: SseEvent, onFlush: () -> Unit) {
        synchronized(eventBuffer) {
            while (eventBuffer.size >= bufferCapacity) {
                eventBuffer.removeAt(0)
            }
            eventBuffer.add(event)
        }

        if (batchInterval <= 0) {
            onFlush()
        }
    }

    @Test
    fun testBufferCapacityLimit() {
        bufferCapacity = 5
        batchInterval = 100.0 // Enable batching so we don't flush immediately
        
        for (i in 1..10) {
            pushEventToBuffer(SseEvent(SseEventType.MESSAGE, "data $i", "$i", null, null)) {}
        }
        
        assertEquals(5, eventBuffer.size)
        assertEquals("6", eventBuffer[0].id)
        assertEquals("10", eventBuffer[4].id)
    }

    @Test
    fun testImmediateFlushWhenNoBatching() {
        batchInterval = 0.0
        val flushCount = AtomicInteger(0)
        
        pushEventToBuffer(SseEvent(SseEventType.OPEN, null, null, null, null)) {
            flushCount.incrementAndGet()
        }
        
        assertEquals(1, flushCount.get())
    }

    @Test
    fun testRetryAfterExtraction() {
        // Mock non-standard retry after logic (conceptual check of the method)
        fun extractMillis(headerValue: String?): Long? {
            if (headerValue == null) return null
            return try {
                headerValue.toLong() * 1000L
            } catch (e: Exception) {
                null // Simplifying for the logic test
            }
        }

        assertEquals(5000L, extractMillis("5"))
        assertEquals(60000L, extractMillis("60"))
        assertNull(extractMillis(null))
        assertNull(extractMillis("invalid"))
    }

    @Test
    fun testBackoffCalculation() {
        val baseBackoffDelayMs = 2000L
        val maxBackoffDelayMs = 30000L
        
        fun calculateDelay(counter: Int): Long {
            return Math.min(baseBackoffDelayMs * (1 shl counter), maxBackoffDelayMs)
        }

        assertEquals(2000L, calculateDelay(0))
        assertEquals(4000L, calculateDelay(1))
        assertEquals(8000L, calculateDelay(2))
        assertEquals(16000L, calculateDelay(3))
        assertEquals(30000L, calculateDelay(4)) // Capped at max
        assertEquals(30000L, calculateDelay(10)) // Still capped
    }

    @Test
    fun testHeartbeatScannerLogic_Integrated() {
        val heartbeatCount = AtomicInteger(0)
        var isAtStartOfLine = true
        
        fun processByte(b: Byte) {
            if (isAtStartOfLine && b == ':'.toByte()) {
                heartbeatCount.incrementAndGet()
            }
            isAtStartOfLine = (b == '\n'.toByte() || b == '\r'.toByte())
        }

        val stream = "data: hello\n:heartbeat\n\n:ping\n".toByteArray()
        for (b in stream) processByte(b)
        
        assertEquals(2, heartbeatCount.get())
    }
}
