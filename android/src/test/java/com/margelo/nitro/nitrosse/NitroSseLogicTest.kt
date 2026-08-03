package com.margelo.nitro.nitrosse

import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Unit tests for [SseReconnectStrategy], [SseEventBuffer], and [SseConnectionHandler] core logic.
 *
 * Verifies exponential backoff delay bounds, full jitter calculation, HTTP Retry-After header parsing,
 * event buffer capacity/timer flushing, multi-threaded event submission, and OkHttp listener delivery.
 */
class NitroSseLogicTest {

    @Test
    fun testBackoffWithJitterCalculation() {
        val strategy = SseReconnectStrategy()
        strategy.configure(
            retryIntervalMs = 1000.0,
            maxRetryIntervalMs = 30000.0,
            jitterFactor = 0.5,
            maxReconnectAttempts = -1
        )

        // Attempt 0 (Base 1.0s): Jitter factor 0.5 constrains expected delay within [500ms, 1500ms]
        val delay0 = strategy.nextDelay(isError = true)
        assertTrue("Delay $delay0 should be >= 500", delay0 >= 500)
        assertTrue("Delay $delay0 should be <= 1500", delay0 <= 1500)

        // Attempt 1 (Base 2.0s): Jitter factor 0.5 constrains expected delay within [1000ms, 3000ms]
        val delay1 = strategy.nextDelay(isError = true)
        assertTrue("Delay $delay1 should be >= 1000", delay1 >= 1000)
        assertTrue("Delay $delay1 should be <= 3000", delay1 <= 3000)

        // Non-error retry resets backoff multiplier to base interval [500ms, 1500ms]
        val delayNonError = strategy.nextDelay(isError = false)
        assertTrue("Delay $delayNonError should be >= 500", delayNonError >= 500)
        assertTrue("Delay $delayNonError should be <= 1500", delayNonError <= 1500)
    }

    @Test
    fun testMaxReconnectAttemptsStop() {
        val strategy = SseReconnectStrategy()
        strategy.configure(
            retryIntervalMs = 1000.0,
            maxRetryIntervalMs = 30000.0,
            jitterFactor = 0.0,
            maxReconnectAttempts = 3
        )

        assertFalse(strategy.hasReachedMaxAttempts())

        // Consume 3 attempts
        strategy.nextDelay(isError = true)
        strategy.nextDelay(isError = true)
        strategy.nextDelay(isError = true)

        assertTrue("Should reach max after 3 attempts", strategy.hasReachedMaxAttempts())
    }

    @Test
    fun testReconnectStrategyReset() {
        val strategy = SseReconnectStrategy()
        strategy.configure(
            retryIntervalMs = 1000.0,
            maxRetryIntervalMs = 30000.0,
            jitterFactor = 0.0,
            maxReconnectAttempts = 3
        )

        strategy.nextDelay(isError = true)
        strategy.nextDelay(isError = true)
        strategy.nextDelay(isError = true)
        assertTrue(strategy.hasReachedMaxAttempts())

        strategy.reset()
        assertFalse("Should reset after reset()", strategy.hasReachedMaxAttempts())
    }

    @Test
    fun testRetryAfterDateParsing() {
        fun createResponse(headerValue: String?): Response {
            val request = Request.Builder().url("https://example.com").build()
            val builder = Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(429)
                .message("Too Many Requests")
                .body("".toResponseBody(null))
            
            if (headerValue != null) {
                builder.header("Retry-After", headerValue)
            }
            return builder.build()
        }

        // Verify parser extracts numeric Retry-After seconds (5 seconds -> 5000ms)
        val res1 = createResponse("5")
        assertEquals(5000L, SseReconnectStrategy.extractRetryAfterMillis(res1))

        // Verify parser handles HTTP-date string format targeting future timestamps
        val formatter = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss z", Locale.US)
        formatter.timeZone = TimeZone.getTimeZone("GMT")
        val futureDate = formatter.format(Date(System.currentTimeMillis() + 3600000))
        val res2 = createResponse(futureDate)

        val extracted = SseReconnectStrategy.extractRetryAfterMillis(res2)
        assertNotNull(extracted)
        assertTrue(extracted!! > 3500000L)
        assertTrue(extracted <= 3600000L)

        // Missing header returns null to signal default backoff strategy
        val res3 = createResponse(null)
        assertNull(SseReconnectStrategy.extractRetryAfterMillis(res3))
    }

    @Test
    fun testReconnectStrategyInvalidConfig() {
        val strategy = SseReconnectStrategy()
        // Misconfiguration where retryInterval > maxRetryInterval should cap at maxRetryIntervalMs
        strategy.configure(
            retryIntervalMs = 5000.0,
            maxRetryIntervalMs = 1000.0,
            jitterFactor = 0.0,
            maxReconnectAttempts = -1
        )
        val delay = strategy.nextDelay(isError = true)
        assertTrue("Delay $delay should be <= 1000", delay <= 1000)
    }

    @Test
    fun testRetryAfterInvalidDate() {
        fun createResponse(headerValue: String): Response {
            val request = Request.Builder().url("https://example.com").build()
            return Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(429)
                .message("Too Many Requests")
                .header("Retry-After", headerValue)
                .body("".toResponseBody(null))
                .build()
        }

        // Malformed date strings return null fallback safely
        val res = createResponse("Not A Valid Date")
        assertNull(SseReconnectStrategy.extractRetryAfterMillis(res))
    }

    @Test
    fun testEventBufferBatchingByCapacity() {
        val flushedBatches = mutableListOf<Array<SseEvent>>()
        val dispatcher = TestSseDispatcher()
        val buffer = SseEventBuffer(onFlush = { events ->
            flushedBatches.add(events)
        }, dispatcher = dispatcher, mainDispatcher = dispatcher)

        buffer.configure(batchingIntervalMs = 10000.0, maxBufferSize = 3)

        val mockEvent = SseEvent(SseEventType.MESSAGE, "test", null, "1", "message", null, 200.0, null, null)

        // Pushing events under max capacity should hold events without flushing
        buffer.push(mockEvent)
        buffer.push(mockEvent)
        assertEquals(0, flushedBatches.size)

        // Reaching capacity threshold must trigger buffer flush immediately
        buffer.push(mockEvent)
        dispatcher.executePending()
        assertEquals(1, flushedBatches.size)
        assertEquals(3, flushedBatches.first().size)
    }

    @Test
    fun testEventBufferBatchingByTime() {
        var receivedEvents = 0
        val dispatcher = TestSseDispatcher()
        
        val buffer = SseEventBuffer(onFlush = { events ->
            receivedEvents += events.size
        }, dispatcher = dispatcher, mainDispatcher = dispatcher)
        
        buffer.configure(batchingIntervalMs = 50.0, maxBufferSize = 10)
        
        val mockEvent = SseEvent(SseEventType.MESSAGE, "test", null, "1", "message", null, 200.0, null, null)
        buffer.push(mockEvent)
        buffer.push(mockEvent)
        
        assertEquals(0, receivedEvents)
        
        // Advancing virtual time by configured interval should execute scheduled flush
        dispatcher.executePending()
        dispatcher.advanceTimeBy(50)
        
        assertEquals(2, receivedEvents)
    }

    @Test
    fun testEventBufferClear() {
        var didFlush = false
        val dispatcher = TestSseDispatcher()
        val buffer = SseEventBuffer(onFlush = {
            didFlush = true
        }, dispatcher = dispatcher, mainDispatcher = dispatcher)

        buffer.configure(batchingIntervalMs = 10000.0, maxBufferSize = 5)

        val mockEvent = SseEvent(SseEventType.MESSAGE, "test", null, "1", "message", null, 200.0, null, null)

        buffer.push(mockEvent)
        buffer.push(mockEvent)
        buffer.clear()

        buffer.push(mockEvent)
        dispatcher.executePending()
        assertFalse("Should not have flushed because buffer was cleared", didFlush)
    }

    @Test
    fun testEventBufferNoBatching() {
        var flushedCount = 0
        val dispatcher = TestSseDispatcher()
        val buffer = SseEventBuffer(onFlush = {
            flushedCount++
        }, dispatcher = dispatcher, mainDispatcher = dispatcher)

        buffer.configure(batchingIntervalMs = 0.0, maxBufferSize = 1000)

        val mockEvent = SseEvent(SseEventType.MESSAGE, "test", null, "1", "message", null, 200.0, null, null)

        buffer.push(mockEvent)
        dispatcher.executePending()
        assertEquals("Should flush immediately when batching is disabled", 1, flushedCount)
    }

    @Test
    fun testEventBufferNullDispatcher() {
        var flushedCount = 0
        val buffer = SseEventBuffer(onFlush = {
            flushedCount++
        }, dispatcher = null, mainDispatcher = null)

        buffer.configure(batchingIntervalMs = 1000.0, maxBufferSize = 2)

        val mockEvent = SseEvent(SseEventType.MESSAGE, "test", null, "1", "message", null, 200.0, null, null)
        buffer.push(mockEvent)
        buffer.push(mockEvent) // should flush immediately because maxBufferSize is reached, no dispatcher
        
        assertEquals(1, flushedCount)
    }

    @Test
    fun testEventBufferConcurrency() {
        var totalFlushedEvents = 0
        val dispatcher = TestSseDispatcher()
        val buffer = SseEventBuffer(onFlush = { events ->
            totalFlushedEvents += events.size
        }, dispatcher = dispatcher, mainDispatcher = dispatcher)

        buffer.configure(batchingIntervalMs = 0.0, maxBufferSize = 100)

        val threads = mutableListOf<Thread>()
        for (i in 0 until 10) {
            val t = Thread {
                for (j in 0 until 100) {
                    val mockEvent = SseEvent(SseEventType.MESSAGE, "test-$i-$j", null, "1", "message", null, 200.0, null, null)
                    buffer.push(mockEvent)
                }
            }
            threads.add(t)
            t.start()
        }

        threads.forEach { it.join() }
        dispatcher.executePending()

        assertEquals("Should have processed exactly 1000 events without dropping", 1000, totalFlushedEvents)
    }

    // MARK: - SseConnectionHandler Tests

    @Test
    fun testConnectionHandlerWithMockWebServer() {
        val server = MockWebServer()
        server.enqueue(MockResponse()
            .setHeader("Content-Type", "text/event-stream")
            .setBody("data: hello\n\n"))
        server.start()

        val latch = CountDownLatch(2)
        var receivedData = ""
        var didOpen = false

        val delegate = object : SseConnectionDelegate {
            override fun connectionDidOpen(response: Response, requestId: String) {
                didOpen = true
                latch.countDown()
            }
            override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {
                receivedData = data
                latch.countDown()
            }
            override fun connectionDidFail(t: Throwable?, response: Response?, requestId: String) {}
            override fun connectionDidClose(requestId: String) {}
        }

        val client = OkHttpClient.Builder().build()
        val request = Request.Builder().url(server.url("/")).build()

        val handler = SseConnectionHandler(delegate)
        val eventSource = handler.createEventSource(client, request, "test-req-id")

        assertTrue("Timeout waiting for events", latch.await(5, TimeUnit.SECONDS))
        assertTrue(didOpen)
        assertEquals("hello", receivedData)

        eventSource.cancel()
        server.shutdown()
    }
}
