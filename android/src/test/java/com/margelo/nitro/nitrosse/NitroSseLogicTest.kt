package com.margelo.nitro.nitrosse

import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import okio.BufferedSource
import okio.Source
import okio.Timeout
import okio.buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
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
    companion object {
        private const val TEST_URL = "http://localhost:33333/events"
    }

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
    fun testReconnectStrategyRecordAttempt() {
        val strategy = SseReconnectStrategy()
        strategy.configure(
            retryIntervalMs = 1000.0,
            maxRetryIntervalMs = 30000.0,
            jitterFactor = 0.0,
            maxReconnectAttempts = 2
        )

        assertEquals(0, strategy.currentReconnectAttempts)
        assertEquals(1, strategy.recordAttempt())
        assertEquals(1, strategy.currentReconnectAttempts)
        assertFalse(strategy.hasReachedMaxAttempts())

        assertEquals(2, strategy.recordAttempt())
        assertTrue(strategy.hasReachedMaxAttempts())

        strategy.reset()
        assertEquals(0, strategy.currentReconnectAttempts)
        assertFalse(strategy.hasReachedMaxAttempts())
    }

    @Test
    fun testRetryAfterDateParsing() {
        fun createResponse(headerValue: String?): Response {
            val request = Request.Builder().url(TEST_URL).build()
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
    fun testInputHardeningAndValidation() {
        val strategy = SseReconnectStrategy()
        strategy.configure(
            retryIntervalMs = Double.NaN,
            maxRetryIntervalMs = Double.POSITIVE_INFINITY,
            jitterFactor = 2.5,
            maxReconnectAttempts = -50
        )
        val delay = strategy.nextDelay(isError = true)
        assertTrue("Delay $delay should fall back to finite default >= 500", delay >= 500)
        assertFalse("Max attempts should fallback to -1 for invalid negative count", strategy.hasReachedMaxAttempts())

        strategy.configure(
            retryIntervalMs = 1000.0,
            maxRetryIntervalMs = 30000.0,
            jitterFactor = -0.5,
            maxReconnectAttempts = -1
        )
        assertTrue("Explicit maxReconnectAttempts = -1 should be preserved", !strategy.hasReachedMaxAttempts())

        val dispatcher = TestSseDispatcher()
        val buffer = SseEventBuffer(onFlush = {}, dispatcher = dispatcher)
        buffer.configure(batchingIntervalMs = Double.NaN, maxBufferSize = -10)
        val mockEvent = SseEvent(SseEventType.MESSAGE, "test", null, "1", "message", null, 200.0, null, null)
        buffer.push(mockEvent)
        dispatcher.executePending()
    }

    @Test
    fun testRetryAfterInvalidDate() {
        fun createResponse(headerValue: String): Response {
            val request = Request.Builder().url(TEST_URL).build()
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
        }, dispatcher = dispatcher)

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
    fun testEventBufferCapsMaxBufferSizeAtHardLimit() {
        val flushedBatches = mutableListOf<Array<SseEvent>>()
        val dispatcher = TestSseDispatcher()
        val buffer = SseEventBuffer(onFlush = { events -> flushedBatches.add(events) }, dispatcher = dispatcher)
        buffer.configure(batchingIntervalMs = 1000.0, maxBufferSize = 15000)

        val mockEvent = SseEvent(SseEventType.MESSAGE, "test", null, "1", "message", null, 200.0, null, null)

        repeat(10_000) { buffer.push(mockEvent) }
        dispatcher.executePending()

        assertEquals(1, flushedBatches.size)
        assertEquals(10_000, flushedBatches.first().size)
        assertEquals(1L, buffer.getBufferOverflowCount())
        assertEquals(0, buffer.getEventsBuffered())
    }

    @Test
    fun testEventBufferBatchingByTime() {
        var receivedEvents = 0
        val dispatcher = TestSseDispatcher()
        
        val buffer = SseEventBuffer(onFlush = { events ->
            receivedEvents += events.size
        }, dispatcher = dispatcher)
        
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
        }, dispatcher = dispatcher)

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
        var flushedBatches = 0
        var totalEvents = 0
        val dispatcher = TestSseDispatcher()
        val buffer = SseEventBuffer(onFlush = { events ->
            flushedBatches++
            totalEvents += events.size
            assertEquals("Each batch must contain exactly 1 event when batching is disabled", 1, events.size)
        }, dispatcher = dispatcher)

        buffer.configure(batchingIntervalMs = 0.0, maxBufferSize = 1000)

        val mockEvent1 = SseEvent(SseEventType.MESSAGE, "test1", null, "1", "message", null, 200.0, null, null)
        val mockEvent2 = SseEvent(SseEventType.MESSAGE, "test2", null, "2", "message", null, 200.0, null, null)
        val mockEvent3 = SseEvent(SseEventType.MESSAGE, "test3", null, "3", "message", null, 200.0, null, null)

        buffer.push(mockEvent1)
        buffer.push(mockEvent2)
        buffer.push(mockEvent3)
        dispatcher.executePending()

        assertEquals("Should flush 3 distinct batches for 3 pushed events", 3, flushedBatches)
        assertEquals("Total flushed events must be 3", 3, totalEvents)
    }

    @Test
    fun testEventBufferNullDispatcher() {
        var flushedCount = 0
        val buffer = SseEventBuffer(onFlush = {
            flushedCount++
        }, dispatcher = null)

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
        }, dispatcher = dispatcher)

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
            override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {}
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

    @Test
    fun testConnectionHandlerStreamReadFailurePassesNullResponse() {
        val server = MockWebServer()
        server.enqueue(MockResponse()
            .setHeader("Content-Type", "text/event-stream")
            .setBody("data: initial chunk\n\n")
            .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        server.start()

        val latch = CountDownLatch(1)
        var failedThrowable: Throwable? = null
        var failedResponse: Response? = "placeholder".let { null }
        var failCalled = false

        val delegate = object : SseConnectionDelegate {
            override fun connectionDidOpen(response: Response, requestId: String) {}
            override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {}
            override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
                failCalled = true
                failedThrowable = t
                failedResponse = response
                latch.countDown()
            }
            override fun connectionDidClose(requestId: String) {}
        }

        val client = OkHttpClient.Builder().build()
        val request = Request.Builder().url(server.url("/")).build()

        val handler = SseConnectionHandler(delegate)
        val eventSource = handler.createEventSource(client, request, "test-stream-fail-id")

        assertTrue("Timeout waiting for connectionDidFail", latch.await(5, TimeUnit.SECONDS))
        assertTrue(failCalled)
        assertNotNull(failedThrowable)
        assertNull("Response must be null on stream-read exception", failedResponse)

        eventSource.cancel()
        server.shutdown()
    }

    @Test
    fun testConnectionHandlerInvalidContentTypePassesResponse() {
        val server = MockWebServer()
        server.enqueue(MockResponse()
            .setHeader("Content-Type", "text/html")
            .setBody("<html><body>Captive Portal</body></html>"))
        server.start()

        val latch = CountDownLatch(1)
        var failedThrowable: Throwable? = null
        var failedResponse: Response? = null
        var failCalled = false

        val delegate = object : SseConnectionDelegate {
            override fun connectionDidOpen(response: Response, requestId: String) {}
            override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {}
            override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
                failCalled = true
                failedThrowable = t
                failedResponse = response
                latch.countDown()
            }
            override fun connectionDidClose(requestId: String) {}
        }

        val client = OkHttpClient.Builder().build()
        val request = Request.Builder().url(server.url("/")).build()

        val handler = SseConnectionHandler(delegate)
        val eventSource = handler.createEventSource(client, request, "test-invalid-ct-id")

        assertTrue("Timeout waiting for connectionDidFail", latch.await(5, TimeUnit.SECONDS))
        assertTrue(failCalled)
        assertTrue(failedThrowable is InvalidContentTypeException)
        assertNotNull("Response must be non-null on invalid Content-Type", failedResponse)
        assertEquals("text/html", failedResponse?.header("Content-Type"))

        eventSource.cancel()
        server.shutdown()
    }

    @Test
    fun testConnectionDidFailDelegationNoRecursion() {
        var called4Param = false
        val delegate = object : SseConnectionDelegate {
            override fun connectionDidOpen(response: Response, requestId: String) {}
            override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {}
            override fun connectionDidClose(requestId: String) {}
            override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
                called4Param = true
            }
        }
        // Invoking 3-param must route cleanly to 4-param
        delegate.connectionDidFail(Exception("test"), null, "req-1")
        assertTrue("3-parameter connectionDidFail must delegate to 4-parameter implementation", called4Param)
    }

    @Test
    fun testReconnectStrategyOverflowWithZeroAndNonZeroRetryIntervalNeverReturnsInvalidDelay() {
        val strategy = SseReconnectStrategy()

        strategy.configure(0.0, 30000.0, 0.5, -1)
        for (i in 0 until 1030) {
            assertEquals("Attempt $i with retryIntervalMs=0 must clamp to 1000ms", 1000L, strategy.nextDelay(true))
        }

        strategy.configure(1000.0, 30000.0, 0.0, -1)
        for (i in 0 until 1030) {
            val delay = strategy.nextDelay(true)
            assertTrue("Attempt $i delay ($delay) must stay within [1000, 30000]", delay in 1000L..30000L)
        }
    }

    @Test
    fun testErrorBodyCapturedForHttpErrorStatusesSkippedFor204AndPreservesPartialBodyOnIOException() {
        val utf8Json = """{"code":"input_rejected","message":"输入包含违规内容","risk":100}"""
        val capturedCases = listOf(
            Triple(401, null, """{"error":"unauthorized"}"""),
            Triple(403, null, utf8Json),
            Triple(408, null, "Request Timeout"),
            Triple(429, null, """{"error":"rate_limited"}"""),
            Triple(503, "5", "Service Unavailable")
        )
        for ((code, retryAfter, expectedBody) in capturedCases) {
            val expectedBytes = expectedBody.toByteArray(Charsets.UTF_8)
            val body = object : ResponseBody() {
                override fun contentType() = "application/json".toMediaType()
                override fun contentLength() = expectedBytes.size.toLong()
                override fun source(): BufferedSource {
                    var offset = 0
                    val src = object : Source {
                        override fun read(sink: Buffer, byteCount: Long): Long {
                            if (offset >= expectedBytes.size) return -1L
                            val len = minOf(byteCount.toInt(), expectedBytes.size - offset)
                            sink.write(expectedBytes, offset, len)
                            offset += len
                            return len.toLong()
                        }
                        override fun timeout() = Timeout.NONE
                        override fun close() {}
                    }
                    return src.buffer()
                }
            }
            val client = OkHttpClient.Builder()
                .addInterceptor(Interceptor { chain ->
                    val builder = Response.Builder()
                        .request(chain.request())
                        .protocol(Protocol.HTTP_1_1)
                        .code(code)
                        .message("Err")
                        .body(body)
                    if (retryAfter != null) {
                        builder.header("Retry-After", retryAfter)
                    }
                    builder.build()
                })
                .build()

            val latch = CountDownLatch(1)
            var capturedBody: String? = null
            val handler = SseConnectionHandler(object : SseConnectionDelegate {
                override fun connectionDidOpen(response: Response, requestId: String) {}
                override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {}
                override fun connectionDidClose(requestId: String) {}
                override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
                    capturedBody = errorBody
                    latch.countDown()
                }
            })
            handler.createEventSource(client, Request.Builder().url(TEST_URL).build(), "req-capture-$code")
            assertTrue(latch.await(5, TimeUnit.SECONDS))
            assertEquals("Status $code should capture errorBody", expectedBody, capturedBody)
        }

        // HTTP 204 No Content must not attempt to read a response body
        var bodyReadAttempted204 = false
        val tracking204Body = object : ResponseBody() {
            override fun contentType() = "text/plain".toMediaType()
            override fun contentLength() = 0L
            override fun source(): BufferedSource {
                val src = object : Source {
                    override fun read(sink: Buffer, byteCount: Long): Long {
                        bodyReadAttempted204 = true
                        return -1L
                    }
                    override fun timeout() = Timeout.NONE
                    override fun close() {}
                }
                return src.buffer()
            }
        }
        val client204 = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(204)
                    .message("No Content")
                    .body(tracking204Body)
                    .build()
            })
            .build()
        val latch204 = CountDownLatch(1)
        var captured204Body: String? = "sentinel"
        val handler204 = SseConnectionHandler(object : SseConnectionDelegate {
            override fun connectionDidOpen(response: Response, requestId: String) {}
            override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {}
            override fun connectionDidClose(requestId: String) {}
            override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
                captured204Body = errorBody
                latch204.countDown()
            }
        })
        handler204.createEventSource(client204, Request.Builder().url(TEST_URL).build(), "req-204")
        assertTrue(latch204.await(5, TimeUnit.SECONDS))
        assertFalse("Status 204 should not read error body", bodyReadAttempted204)
        assertNull("Status 204 should pass null errorBody", captured204Body)

        // Error body larger than MAX_ERROR_BODY_BYTES (8192) is truncated cleanly at 8192 bytes
        val largeBytes = ByteArray(16384) { 'A'.code.toByte() }
        val largeBody = object : ResponseBody() {
            override fun contentType() = "text/plain".toMediaType()
            override fun contentLength() = largeBytes.size.toLong()
            override fun source(): BufferedSource {
                var offset = 0
                val src = object : Source {
                    override fun read(sink: Buffer, byteCount: Long): Long {
                        if (offset >= largeBytes.size) return -1L
                        val len = minOf(byteCount.toInt(), largeBytes.size - offset)
                        sink.write(largeBytes, offset, len)
                        offset += len
                        return len.toLong()
                    }
                    override fun timeout() = Timeout.NONE
                    override fun close() {}
                }
                return src.buffer()
            }
        }
        val client403Large = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(403)
                    .message("Forbidden")
                    .body(largeBody)
                    .build()
            })
            .build()
        val latchLarge = CountDownLatch(1)
        var capturedLargeBody: String? = null
        val handlerLarge = SseConnectionHandler(object : SseConnectionDelegate {
            override fun connectionDidOpen(response: Response, requestId: String) {}
            override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {}
            override fun connectionDidClose(requestId: String) {}
            override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
                capturedLargeBody = errorBody
                latchLarge.countDown()
            }
        })
        handlerLarge.createEventSource(client403Large, Request.Builder().url(TEST_URL).build(), "req-403-large")
        assertTrue(latchLarge.await(5, TimeUnit.SECONDS))
        assertEquals(8192, capturedLargeBody?.toByteArray(Charsets.UTF_8)?.size)

        // HTTP 500 with mid-stream IOException should preserve already-buffered partial error body
        val partialErrorBody = object : ResponseBody() {
            override fun contentType() = "text/plain".toMediaType()
            override fun contentLength() = 64L
            override fun source(): BufferedSource {
                var emitted = false
                val src = object : Source {
                    override fun read(sink: Buffer, byteCount: Long): Long {
                        if (!emitted) {
                            emitted = true
                            sink.writeUtf8("partial-500-err")
                            return 15L
                        }
                        throw IOException("stream interrupted")
                    }
                    override fun timeout() = Timeout.NONE
                    override fun close() {}
                }
                return src.buffer()
            }
        }
        val client500 = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(500)
                    .message("Internal Server Error")
                    .body(partialErrorBody)
                    .build()
            })
            .build()

        val latch500 = CountDownLatch(1)
        var captured500Body: String? = null
        val handler500 = SseConnectionHandler(object : SseConnectionDelegate {
            override fun connectionDidOpen(response: Response, requestId: String) {}
            override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {}
            override fun connectionDidClose(requestId: String) {}
            override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
                captured500Body = errorBody
                latch500.countDown()
            }
        })
        handler500.createEventSource(client500, Request.Builder().url(TEST_URL).build(), "req-500")
        assertTrue(latch500.await(5, TimeUnit.SECONDS))
        assertEquals("partial-500-err", captured500Body)
    }

    @Test
    fun testErrorBodyBoundarySizesUtf8EmptyAndCancelMidRead() {
        fun executeHandlerWithBytes(
            statusCode: Int,
            bytes: ByteArray,
            reportedContentLength: Long = bytes.size.toLong()
        ): String? {
            val body = object : ResponseBody() {
                override fun contentType() = "application/json".toMediaType()
                override fun contentLength() = reportedContentLength
                override fun source(): BufferedSource {
                    var offset = 0
                    val src = object : Source {
                        override fun read(sink: Buffer, byteCount: Long): Long {
                            if (offset >= bytes.size) return -1L
                            val len = minOf(byteCount.toInt(), bytes.size - offset)
                            sink.write(bytes, offset, len)
                            offset += len
                            return len.toLong()
                        }
                        override fun timeout() = Timeout.NONE
                        override fun close() {}
                    }
                    return src.buffer()
                }
            }
            val client = OkHttpClient.Builder()
                .addInterceptor(Interceptor { chain ->
                    Response.Builder()
                        .request(chain.request())
                        .protocol(Protocol.HTTP_1_1)
                        .code(statusCode)
                        .message("Err")
                        .body(body)
                        .build()
                })
                .build()
            val latch = CountDownLatch(1)
            var captured: String? = "sentinel"
            val handler = SseConnectionHandler(object : SseConnectionDelegate {
                override fun connectionDidOpen(response: Response, requestId: String) {}
                override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {}
                override fun connectionDidClose(requestId: String) {}
                override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
                    captured = errorBody
                    latch.countDown()
                }
            })
            handler.createEventSource(client, Request.Builder().url(TEST_URL).build(), "req-boundary-$statusCode")
            assertTrue(latch.await(5, TimeUnit.SECONDS))
            return captured
        }

        // Exact 8192 bytes intact; 8193 bytes truncated to 8192
        val exact8192 = ByteArray(8192) { 'A'.code.toByte() }
        assertEquals(String(exact8192, Charsets.UTF_8), executeHandlerWithBytes(403, exact8192))

        val over8193 = ByteArray(8193) { 'A'.code.toByte() }
        val captured8193 = executeHandlerWithBytes(403, over8193)
        assertEquals(8192, captured8193?.toByteArray(Charsets.UTF_8)?.size)

        // Multi-byte UTF-8 boundary: 3-byte Chinese ('中') & 4-byte emoji ('😀') straddling 8192
        val exactChinese = ("A".repeat(8189) + "中").toByteArray(Charsets.UTF_8)
        assertEquals(8192, exactChinese.size)
        assertEquals("A".repeat(8189) + "中", executeHandlerWithBytes(403, exactChinese))

        val straddleChinese = ("A".repeat(8190) + "中").toByteArray(Charsets.UTF_8)
        assertEquals(8193, straddleChinese.size)
        assertEquals("A".repeat(8190) + "\uFFFD", executeHandlerWithBytes(403, straddleChinese))

        val straddleEmoji = ("A".repeat(8190) + "😀").toByteArray(Charsets.UTF_8)
        assertEquals(8194, straddleEmoji.size)
        assertEquals("A".repeat(8190) + "\uFFFD", executeHandlerWithBytes(403, straddleEmoji))

        // Empty bodies through handler: Content-Length 0 and chunked empty (-1)
        assertNull(executeHandlerWithBytes(403, ByteArray(0), 0L))
        assertNull(executeHandlerWithBytes(403, ByteArray(0), -1L))

        // Cancel mid-read of hanging 403 body must suppress connectionDidFail and close response
        val readingStarted = CountDownLatch(1)
        val bodyClosed = CountDownLatch(1)
        val failInvoked = java.util.concurrent.atomic.AtomicBoolean(false)
        val hangingBody = object : ResponseBody() {
            override fun contentType() = "application/json".toMediaType()
            override fun contentLength() = -1L
            override fun source(): BufferedSource {
                val src = object : Source {
                    override fun read(sink: Buffer, byteCount: Long): Long {
                        readingStarted.countDown()
                        try {
                            bodyClosed.await(2, TimeUnit.SECONDS)
                        } catch (_: InterruptedException) {}
                        throw IOException("cancelled")
                    }
                    override fun timeout() = Timeout.NONE
                    override fun close() {
                        bodyClosed.countDown()
                    }
                }
                return src.buffer()
            }
        }
        val cancelClient = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(403)
                    .message("Forbidden")
                    .body(hangingBody)
                    .build()
            })
            .build()
        val cancelHandler = SseConnectionHandler(object : SseConnectionDelegate {
            override fun connectionDidOpen(response: Response, requestId: String) {}
            override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {}
            override fun connectionDidClose(requestId: String) {}
            override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
                failInvoked.set(true)
            }
        })
        val source = cancelHandler.createEventSource(cancelClient, Request.Builder().url(TEST_URL).build(), "req-cancel-403")
        assertTrue(readingStarted.await(5, TimeUnit.SECONDS))
        source.cancel()
        assertTrue("Response body must be closed on cancel", bodyClosed.await(5, TimeUnit.SECONDS))
        Thread.sleep(100)
        assertFalse("connectionDidFail must not be called after cancel", failInvoked.get())
    }

    @Test
    fun testStalled403ErrorBodyPreservesPartialBodyOnConnectTimeout() {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(
                MockResponse()
                    .setResponseCode(403)
                    .addHeader("Content-Type", "application/json")
                    .setBody("{\"partial\":1234567890")
                    .throttleBody(11, 2, TimeUnit.SECONDS)
            )
            val client = OkHttpClient.Builder()
                .connectTimeout(250, TimeUnit.MILLISECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .build()
            val latch = CountDownLatch(1)
            var capturedStatus: Int? = null
            var capturedBody: String? = null
            val handler = SseConnectionHandler(object : SseConnectionDelegate {
                override fun connectionDidOpen(response: Response, requestId: String) {}
                override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {}
                override fun connectionDidClose(requestId: String) {}
                override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
                    capturedStatus = response?.code
                    capturedBody = errorBody
                    latch.countDown()
                }
            })
            handler.createEventSource(client, Request.Builder().url(server.url("/events")).build(), "req-stall-403")
            assertTrue(latch.await(5, TimeUnit.SECONDS))
            assertEquals(403, capturedStatus)
            assertEquals("{\"partial\":", capturedBody)
        } finally {
            server.shutdown()
        }
    }
}

