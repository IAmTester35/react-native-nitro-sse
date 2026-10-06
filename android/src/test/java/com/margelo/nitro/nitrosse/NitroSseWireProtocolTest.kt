package com.margelo.nitro.nitrosse

import android.os.Build
import android.os.Looper
import com.facebook.soloader.SoLoader
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * End-to-end wire protocol tests verifying WHATWG Server-Sent Events HTTP framing,
 * chronological event sequencing, header preservation, and directives against MockWebServer.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.O], shadows = [ShadowHybridNitroSseSpecCxxPart::class])
class NitroSseWireProtocolTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        SoLoader.setInTestMode()
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun createConfig(
        url: String,
        method: HttpMethod = HttpMethod.GET,
        headers: Map<String, String> = emptyMap(),
        body: String? = null
    ): SseConfig {
        return SseConfig(
            url,
            method,
            headers,
            body,
            false,
            0.0,
            1000.0,
            15000.0,
            300000.0,
            100.0,
            30000.0,
            0.0,
            3.0,
            3.0,
            false,
            false,
            null
        )
    }

    /**
     * Verifies that comments (`: comment`) and messages (`data: ...`) arrive in exact
     * chronological wire sequence rather than comments being read ahead of prior messages.
     */
    @Test
    fun testHeartbeatAndMessageChronologicalWireOrder() {
        val sseStream = "data: first_msg\n\n: ping1\ndata: second_msg\n\n"
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(sseStream)
        )

        val sse = NitroSse()
        val config = createConfig(server.url("/events").toString())
        val receivedEvents = mutableListOf<SseEvent>()
        val latch = CountDownLatch(2)

        sse.setup(config) { events ->
            synchronized(receivedEvents) {
                for (e in events) {
                    if (e.type == SseEventType.MESSAGE || e.type == SseEventType.HEARTBEAT) {
                        receivedEvents.add(e)
                        latch.countDown()
                    }
                }
            }
        }

        sse.start()
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < 3000 && latch.count > 0) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(20)
        }

        sse.stop()

        synchronized(receivedEvents) {
            assertTrue("Should receive at least 2 events", receivedEvents.size >= 2)
            val firstEvent = receivedEvents[0]
            val secondEvent = receivedEvents[1]

            assertEquals("MESSAGE arrives first matching chronological wire order", SseEventType.MESSAGE, firstEvent.type)
            assertEquals("first_msg", firstEvent.data)
            assertEquals("HEARTBEAT arrives second matching chronological wire order", SseEventType.HEARTBEAT, secondEvent.type)
            assertEquals("ping1", secondEvent.message)
        }
    }

    /**
     * Verifies that `Last-Event-ID` provided in config.headers is forwarded on the initial HTTP request.
     */
    @Test
    fun testInitialLastEventIdHeaderSentFromConfig() {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: hello\n\n")
        )

        val sse = NitroSse()
        val config = createConfig(
            server.url("/events").toString(),
            headers = mapOf("Last-Event-ID" to "checkpoint-999")
        )

        sse.setup(config) { _ -> }
        sse.start()

        val recordedRequest = server.takeRequest(3, TimeUnit.SECONDS)
        sse.stop()

        val sentLastEventId = recordedRequest?.getHeader("Last-Event-ID")
        assertEquals("Last-Event-ID from config.headers must be sent on initial request", "checkpoint-999", sentLastEventId)
    }

    /**
     * Verifies that a custom Content-Type in POST request is preserved instead of being forced to application/json.
     */
    @Test
    fun testCustomContentTypePreservedOnPostRequest() {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: ok\n\n")
        )

        val sse = NitroSse()
        val config = createConfig(
            server.url("/events").toString(),
            method = HttpMethod.POST,
            headers = mapOf("Content-Type" to "application/x-www-form-urlencoded"),
            body = "query=test&filter=all"
        )

        sse.setup(config) { _ -> }
        sse.start()

        val recordedRequest = server.takeRequest(3, TimeUnit.SECONDS)
        sse.stop()

        val sentContentType = recordedRequest?.getHeader("Content-Type")
        assertTrue("Sent Content-Type must preserve custom application/x-www-form-urlencoded", sentContentType?.startsWith("application/x-www-form-urlencoded") == true)
    }

    /**
     * Verifies that WHATWG SSE 'retry: <ms>' directive dynamically updates the client
     * reconnection strategy backoff interval and populates the event retry field.
     */
    @Test
    fun testServerRetryDirectiveUpdatesReconnectInterval() {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("retry: 8888\ndata: msg_with_retry\n\n")
        )

        val sse = NitroSse()
        val config = createConfig(server.url("/events").toString())
        val receivedEvents = mutableListOf<SseEvent>()
        val latch = CountDownLatch(1)

        sse.setup(config) { events ->
            for (e in events) {
                if (e.type == SseEventType.MESSAGE) {
                    receivedEvents.add(e)
                    latch.countDown()
                }
            }
        }

        sse.start()
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < 3000 && latch.count > 0) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(20)
        }
        sse.stop()

        assertTrue("Should receive MESSAGE event", receivedEvents.isNotEmpty())
        val msgEvent = receivedEvents[0]
        assertEquals("msg_with_retry", msgEvent.data)
        assertNull("SseEvent.retry must be null on MESSAGE events per WHATWG spec", msgEvent.retry)

        val strategyField = NitroSse::class.java.getDeclaredField("reconnectStrategy").apply { isAccessible = true }
        val reconnectStrategy = strategyField.get(sse) as SseReconnectStrategy
        val intervalField = SseReconnectStrategy::class.java.getDeclaredField("retryIntervalMs").apply { isAccessible = true }
        val currentInterval = intervalField.get(reconnectStrategy) as Double
        assertEquals("Reconnect interval must be updated to 8888.0ms", 8888.0, currentInterval, 0.0)
    }

    /**
     * Verifies that bare carriage return (\r) line endings are correctly parsed
     * per WHATWG SSE specification.
     */
    @Test
    fun testBareCarriageReturnLineEndingFraming() {
        val sseStream = "data: bare_cr_1\r\rdata: bare_cr_2\r\r"
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(sseStream)
        )

        val sse = NitroSse()
        val config = createConfig(server.url("/events").toString())
        val receivedEvents = mutableListOf<SseEvent>()
        val latch = CountDownLatch(2)

        sse.setup(config) { events ->
            synchronized(receivedEvents) {
                for (e in events) {
                    if (e.type == SseEventType.MESSAGE) {
                        receivedEvents.add(e)
                        latch.countDown()
                    }
                }
            }
        }

        sse.start()
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < 3000 && latch.count > 0) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(20)
        }
        sse.stop()

        synchronized(receivedEvents) {
            assertEquals("Should parse both messages separated by bare \\r", 2, receivedEvents.size)
            assertEquals("bare_cr_1", receivedEvents[0].data)
            assertEquals("bare_cr_2", receivedEvents[1].data)
        }
    }

    /**
     * Verifies that WHATWG SSE 'retry: <ms>' directives containing non-ASCII digits (like +1000)
     * are strictly ignored.
     */
    @Test
    fun testRetryDirectiveIgnoresNonDigits() {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("retry: +1000\ndata: ok\n\n")
        )

        val sse = NitroSse()
        val config = createConfig(server.url("/events").toString())
        val receivedEvents = mutableListOf<SseEvent>()
        val latch = CountDownLatch(1)

        sse.setup(config) { events ->
            for (e in events) {
                if (e.type == SseEventType.MESSAGE) {
                    receivedEvents.add(e)
                    latch.countDown()
                }
            }
        }

        sse.start()
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < 3000 && latch.count > 0) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(20)
        }
        sse.stop()

        assertTrue("Should receive MESSAGE event", receivedEvents.isNotEmpty())
        val msgEvent = receivedEvents[0]
        assertEquals("ok", msgEvent.data)
        assertNull("SseEvent.retry must be null for invalid 'retry: +1000'", msgEvent.retry)

        val strategyField = NitroSse::class.java.getDeclaredField("reconnectStrategy").apply { isAccessible = true }
        val reconnectStrategy = strategyField.get(sse) as SseReconnectStrategy
        val intervalField = SseReconnectStrategy::class.java.getDeclaredField("retryIntervalMs").apply { isAccessible = true }
        val currentInterval = intervalField.get(reconnectStrategy) as Double
        assertEquals("Reconnect interval must remain at configured 100.0ms", 100.0, currentInterval, 0.0)
    }

    /**
     * Verifies that HTTP 204 No Content dispatches the specific 'No Content (204). Stopping.'
     * terminal error event and does not attempt reconnection.
     */
    @Test
    fun testHttp204DispatchesNoContentStoppingMessage() {
        server.enqueue(
            MockResponse()
                .setResponseCode(204)
        )

        val sse = NitroSse()
        val config = createConfig(server.url("/events").toString())
        val receivedEvents = mutableListOf<SseEvent>()
        val latch = CountDownLatch(1)

        sse.setup(config) { events ->
            for (e in events) {
                if (e.type == SseEventType.ERROR) {
                    receivedEvents.add(e)
                    latch.countDown()
                }
            }
        }

        sse.start()
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < 3000 && latch.count > 0) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(20)
        }
        sse.stop()

        assertTrue("Should receive ERROR event on HTTP 204", receivedEvents.isNotEmpty())
        val errorEvent = receivedEvents.last()
        assertEquals("HTTP 204 must emit 'No Content (204). Stopping.'", "No Content (204). Stopping.", errorEvent.message)
        assertEquals(204.0, errorEvent.statusCode)
        assertEquals("Client must transition to FAILED on 204", SseState.FAILED, sse.getState())
    }

    /**
     * Verifies that HTTP 301 Permanent Redirect automatically redirects the connection
     * to the new location and receives streamed events.
     */
    @Test
    fun testPermanentRedirect301FollowsRedirect() {
        server.enqueue(
            MockResponse()
                .setResponseCode(301)
                .setHeader("Location", server.url("/redirected-events").toString())
        )
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: redirected_msg\n\n")
        )

        val sse = NitroSse()
        val config = createConfig(server.url("/events").toString())
        val receivedEvents = mutableListOf<SseEvent>()
        val latch = CountDownLatch(1)

        sse.setup(config) { events ->
            for (e in events) {
                if (e.type == SseEventType.MESSAGE) {
                    receivedEvents.add(e)
                    latch.countDown()
                }
            }
        }

        val threadField = NitroSse::class.java.getDeclaredField("sseDispatcherThread").apply { isAccessible = true }
        val handlerThread = threadField.get(sse) as? android.os.HandlerThread

        sse.start()
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < 5000 && latch.count > 0) {
            shadowOf(Looper.getMainLooper()).idle()
            handlerThread?.looper?.let { shadowOf(it).runToEndOfTasks() }
            Thread.sleep(20)
        }
        sse.stop()

        val req1 = server.takeRequest(2, TimeUnit.SECONDS)
        val req2 = server.takeRequest(2, TimeUnit.SECONDS)

        assertEquals("/events", req1?.path)
        assertEquals("/redirected-events", req2?.path)
        assertEquals(1, receivedEvents.size)
        assertEquals("redirected_msg", receivedEvents[0].data)
    }

    /**
     * Verifies that non-200 successful HTTP status (e.g. 206 Partial Content) fails the connection
     * without establishing the SSE stream per WHATWG SSE specification.
     */
    @Test
    fun testHttp206PartialContentFailsWithoutOpeningStream() {
        server.enqueue(
            MockResponse()
                .setResponseCode(206)
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: partial\n\n")
        )

        val sse = NitroSse()
        val config = createConfig(server.url("/events").toString())
        val receivedEvents = mutableListOf<SseEvent>()
        val latch = CountDownLatch(1)

        sse.setup(config) { events ->
            for (e in events) {
                receivedEvents.add(e)
                if (e.type == SseEventType.OPEN || e.type == SseEventType.ERROR) {
                    latch.countDown()
                }
            }
        }

        sse.start()
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < 3000 && latch.count > 0) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(20)
        }
        sse.stop()

        val hasOpen = receivedEvents.any { it.type == SseEventType.OPEN }
        val hasError = receivedEvents.any { it.type == SseEventType.ERROR }
        assertFalse("HTTP 206 must NOT open SSE stream per WHATWG SSE spec", hasOpen)
        assertTrue("HTTP 206 must emit an ERROR event", hasError)
    }

    /**
     * Verifies that HTTP 302 Temporary Redirect does NOT update the persistent SSE reconnection URL,
     * so subsequent reconnects target the original URL per WHATWG SSE specification.
     */
    @Test
    fun testTemporaryRedirect302PreservesOriginalReconnectionUrl() {
        server.enqueue(
            MockResponse()
                .setResponseCode(302)
                .setHeader("Location", server.url("/temp-redirected").toString())
        )
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: temp_msg\n\n")
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END)
        )
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: reconnected_msg\n\n")
        )

        val sse = NitroSse()
        val config = createConfig(server.url("/events").toString())
        val receivedEvents = mutableListOf<SseEvent>()
        val latch = CountDownLatch(2)

        sse.setup(config) { events ->
            for (e in events) {
                if (e.type == SseEventType.MESSAGE) {
                    receivedEvents.add(e)
                    latch.countDown()
                }
            }
        }

        val threadField = NitroSse::class.java.getDeclaredField("sseDispatcherThread").apply { isAccessible = true }
        val handlerThread = threadField.get(sse) as? android.os.HandlerThread

        sse.start()
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < 5000 && latch.count > 0) {
            shadowOf(Looper.getMainLooper()).idle()
            handlerThread?.looper?.let { shadowOf(it).runToEndOfTasks() }
            Thread.sleep(20)
        }
        sse.stop()

        val req1 = server.takeRequest(2, TimeUnit.SECONDS)
        val req2 = server.takeRequest(2, TimeUnit.SECONDS)
        val req3 = server.takeRequest(2, TimeUnit.SECONDS)

        assertEquals("/events", req1?.path)
        assertEquals("/temp-redirected", req2?.path)
        assertEquals("Subsequent reconnect must still target original /events per WHATWG SSE spec", "/events", req3?.path)
    }
}


