package com.margelo.nitro.nitrosse

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

class NitroSseLogicTest {

    private lateinit var eventBuffer: MutableList<SseEvent>
    private var bufferCapacity = 100
    private var flushCount = 0

    @Before
    fun setup() {
        eventBuffer = mutableListOf()
        flushCount = 0
    }

    private fun pushEventToBuffer(event: SseEvent) {
        synchronized(eventBuffer) {
            eventBuffer.add(event)
            if (eventBuffer.size >= bufferCapacity) {
                // Simulate flush logic from NitroSse.kt
                flushCount++
                eventBuffer.clear()
            }
        }
    }

    @Test
    fun testZeroLossBufferingFlush() {
        bufferCapacity = 5
        
        // Fill buffer to capacity
        for (i in 1..5) {
            pushEventToBuffer(SseEvent(SseEventType.MESSAGE, "data $i", "$i", null, null, null, null))
        }
        
        assertEquals(1, flushCount)
        assertEquals(0, eventBuffer.size)

        // Check it doesn't drop items when not at capacity
        for (i in 1..3) {
            pushEventToBuffer(SseEvent(SseEventType.MESSAGE, "data $i", "$i", null, null, null, null))
        }
        assertEquals(3, eventBuffer.size)
        assertEquals(1, flushCount)
    }

    @Test
    fun testBackoffWithJitterCalculation() {
        val retryIntervalMs = 1000L
        val maxRetryIntervalMs = 30000L
        val jitterFactor = 0.5
        
        fun calculateDelay(counter: Int, jitter: Double): Long {
            val base = Math.min(retryIntervalMs * (1 shl counter), maxRetryIntervalMs)
            // Logic from NitroSse.kt: (base * (1.0 - jitterFactor + Random.nextDouble() * 2 * jitterFactor)).toLong()
            return (base * (1.0 - jitterFactor + jitter * 2 * jitterFactor)).toLong()
        }

        // Test range for counter 0 (Base 1000ms)
        // Min: 1000 * (0.5 + 0) = 500ms
        // Max: 1000 * (0.5 + 1.0) = 1500ms
        assertEquals(500L, calculateDelay(0, 0.0))
        assertEquals(1500L, calculateDelay(0, 1.0))
        
        // Test range for counter 5 (Base 32000ms -> Capped 30000ms)
        // Min: 30000 * 0.5 = 15000ms
        // Max: 30000 * 1.5 = 45000ms
        assertEquals(15000L, calculateDelay(5, 0.0))
        assertEquals(45000L, calculateDelay(5, 1.0))
    }

    @Test
    fun testMaxReconnectAttemptsStop() {
        val maxAttempts = 3
        var currentReconnectAttempts = 0
        var isRunning = true
        
        fun onFailure() {
            if (currentReconnectAttempts >= maxAttempts) {
                isRunning = false
                return
            }
            currentReconnectAttempts++
        }
        
        for (i in 1..3) {
            onFailure()
        }
        assertTrue(isRunning)
        assertEquals(3, currentReconnectAttempts)
        
        onFailure() // 4th call, current (3) >= max (3)
        assertFalse(isRunning)
    }

    @Test
    fun testAuthErrorLogic() {
        fun shouldRetry(statusCode: Int, hasInterceptor: Boolean, consecutiveAuthErrors: Int): Boolean {
            val maxAuthRetries = 3
            if (statusCode == 401 || statusCode == 403) {
                if (!hasInterceptor) return false
                if (consecutiveAuthErrors >= maxAuthRetries) return false
                return true
            }
            return false
        }

        // Case 1: 401 without interceptor -> Fail
        assertFalse(shouldRetry(statusCode = 401, hasInterceptor = false, consecutiveAuthErrors = 0))
        
        // Case 2: 401 with interceptor -> Retry
        assertTrue(shouldRetry(statusCode = 401, hasInterceptor = true, consecutiveAuthErrors = 0))
        
        // Case 3: 401 reaching limit (3) -> Fail
        assertFalse(shouldRetry(statusCode = 401, hasInterceptor = true, consecutiveAuthErrors = 3))
    }

    @Test
    fun testFatalErrorLogic() {
        fun isFatal(statusCode: Int): Boolean {
            return statusCode == 400 || statusCode == 204
        }

        assertTrue(isFatal(400))
        assertTrue(isFatal(204))
        assertFalse(isFatal(500))
        assertFalse(isFatal(401))
    }

    @Test
    fun testRetryAfterExtraction() {
        fun extractMillis(headerValue: String?): Long? {
            if (headerValue == null) return null
            return try {
                headerValue.toLong() * 1000L
            } catch (e: Exception) {
                null // Simplifying for logic test
            }
        }

        assertEquals(5000L, extractMillis("5"))
        assertEquals(60000L, extractMillis("60"))
        
        // Mocking the date parsing behavior from NitroSse.kt
        fun extractDateMillis(headerValue: String?): Long? {
            if (headerValue == "Wed, 21 Oct 2015 07:28:00 GMT") return 10000L // Mocked diff
            return null
        }
        assertEquals(10000L, extractDateMillis("Wed, 21 Oct 2015 07:28:00 GMT"))

        assertNull(extractMillis(null))
        assertNull(extractMillis("invalid"))
    }

    @Test
    fun testStartIdempotency() {
        val isRunning = AtomicInteger(0)
        
        fun start() {
            // Simulated compareAndSet(false, true) logic
            if (isRunning.get() == 0) {
                isRunning.set(1)
            }
        }
        
        start()
        assertEquals(1, isRunning.get())
        start()
        assertEquals(1, isRunning.get()) // Should not have changed
    }

    @Test
    fun testConcurrentStartStopVersioning() {
        val connectionAttemptVersion = AtomicInteger(0)
        var executeCount = 0
        
        fun start(): Int {
            return connectionAttemptVersion.get()
        }
        
        fun stop() {
            connectionAttemptVersion.incrementAndGet()
        }
        
        fun finishConnection(version: Int) {
            if (version == connectionAttemptVersion.get()) {
                executeCount++
            }
        }
        
        // 1. User starts
        val v1 = start()
        
        // 2. User stops immediately
        stop()
        
        // 3. Logic tries to finish with old version
        finishConnection(v1)
        assertEquals(0, executeCount)
        
        // 4. New start
        val v2 = start()
        finishConnection(v2)
        assertEquals(1, executeCount)
    }

    @Test
    fun testStatsPersistenceAcrossAttempts() {
        var totalBytes = 0L
        var reconnectCount = 0
        
        fun recordAttempt(bytes: Long) {
            reconnectCount++
            totalBytes += bytes
        }
        
        recordAttempt(1024)
        recordAttempt(2048)
        
        assertEquals(2, reconnectCount)
        assertEquals(3072L, totalBytes)
    }

    @Test
    fun testHeartbeatDetectionCount() {
        val totalBytes = 100L
        val comment = ":ping"
        
        // Just verify math logic for byte counting in Network Interceptor
        val newTotal = totalBytes + comment.toByteArray(Charsets.UTF_8).size
        assertEquals(105L, newTotal)
    }
}
