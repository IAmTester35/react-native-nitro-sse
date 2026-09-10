package com.margelo.nitro.nitrosse

import android.os.Build
import com.facebook.soloader.SoLoader
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import okio.GzipSink
import okio.buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Verifies live OkHttp stream handling for Gzip-compressed SSE feeds.
 *
 * Ensures:
 * 1. Client requests allow transparent compression (no 'Accept-Encoding: identity' override).
 * 2. Application Interceptor reads decompressed UTF-8 text.
 * 3. SSE comments (':') are extracted into HEARTBEAT events even from compressed streams.
 * 4. Message events are received and parsed without corruption.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.O])
class NitroSseGzipTest {
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

    @Test
    fun testLiveGzipSseStreamDecompressionAndHeartbeats() {
        val ssePayload = ": keep-alive\nevent: message\ndata: {\"status\":\"ok\",\"compressed\":true}\n\n"

        // Compress stream with GzipSink
        val compressedBuffer = Buffer()
        val gzipSink = GzipSink(compressedBuffer).buffer()
        gzipSink.writeUtf8(ssePayload)
        gzipSink.close()

        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setHeader("Content-Encoding", "gzip")
                .setBody(compressedBuffer)
        )

        val capturedComments = mutableListOf<String>()
        val heartbeatInterceptor = HeartbeatInterceptor { _, comment ->
            capturedComments.add(comment)
        }

        val client = OkHttpClient.Builder()
            .addNetworkInterceptor(InspectorNetworkInterceptor())
            .addInterceptor(heartbeatInterceptor)
            .build()

        val request = Request.Builder()
            .url(server.url("/events-gzip"))
            .tag(String::class.java, "req-gzip-test")
            .build()

        val response = client.newCall(request).execute()
        val recordedRequest = server.takeRequest()

        // Verify request was sent without forcing 'identity' encoding (allowing gzip)
        val acceptEncoding = recordedRequest.getHeader("Accept-Encoding")
        assertNotNull("Accept-Encoding should be sent by OkHttp", acceptEncoding)
        assertTrue("OkHttp should include gzip in Accept-Encoding", acceptEncoding?.contains("gzip") == true)
        assertTrue("Request must not enforce identity encoding", acceptEncoding != "identity")

        // Downstream stream reader receives transparently decompressed body
        val bodyContent = response.body?.string()
        assertEquals(ssePayload, bodyContent)

        // Verify comment/heartbeat extracted properly
        assertEquals(1, capturedComments.size)
        assertEquals("keep-alive", capturedComments[0])
    }

    @Test
    fun testNitroSseDoesNotInjectIdentityHeader() {
        val dispatcher = TestSseDispatcher()
        val sse = NitroSse(dispatcher)
        val serverUrl = server.url("/events").toString()
        val config = SseConfig(
            serverUrl,
            null,
            emptyMap(),
            null,
            false,
            0.0,
            1000.0,
            15000.0,
            300000.0,
            1000.0,
            30000.0,
            0.5,
            -1.0,
            3.0,
            false,
            false,
            null
        )

        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: initial\n\n")
        )

        sse.setup(config) {}
        dispatcher.executePending()

        sse.start()
        dispatcher.executePending()

        val recordedRequest = server.takeRequest(2, TimeUnit.SECONDS)
        assertNotNull("Server should receive connection request", recordedRequest)

        val acceptEncoding = recordedRequest?.getHeader("Accept-Encoding")
        // Verify 'Accept-Encoding: identity' is NOT sent
        assertTrue("Accept-Encoding must not be hardcoded to identity", acceptEncoding != "identity")

        sse.dispose()
    }

    @Test
    fun testNitroSseReceivesEventsFromGzipStreamEndToEnd() {
        val dispatcher = TestSseDispatcher()
        val sse = NitroSse(dispatcher)
        val serverUrl = server.url("/events-gzip").toString()
        val config = SseConfig(
            serverUrl,
            null,
            emptyMap(),
            null,
            false,
            0.0,
            1000.0,
            15000.0,
            300000.0,
            1000.0,
            30000.0,
            0.5,
            -1.0,
            3.0,
            true,
            false,
            null
        )

        val ssePayload = ": initial heartbeat\nevent: message\ndata: {\"status\":\"gzip-ok\",\"count\":42}\n\n"
        val compressedBuffer = Buffer()
        val gzipSink = GzipSink(compressedBuffer).buffer()
        gzipSink.writeUtf8(ssePayload)
        gzipSink.close()

        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setHeader("Content-Encoding", "gzip")
                .setBody(compressedBuffer)
        )

        val receivedEvents = mutableListOf<SseEvent>()
        sse.setup(config) { events ->
            receivedEvents.addAll(events)
        }
        dispatcher.executePending()

        sse.start()
        dispatcher.executePending()

        for (i in 0 until 20) {
            Thread.sleep(50)
            dispatcher.executePending()
            if (receivedEvents.any { it.type == SseEventType.MESSAGE }) break
        }

        val messageEvent = receivedEvents.find { it.type == SseEventType.MESSAGE }
        assertNotNull("Message event must be received from gzipped stream", messageEvent)
        assertEquals("message", messageEvent?.event)
        assertTrue("Data must contain status gzip-ok", messageEvent?.data?.contains("gzip-ok") == true)

        val stats = sse.getStats()
        assertTrue("totalBytesReceived should be greater than 0", stats.totalBytesReceived > 0.0)

        sse.dispose()
    }
}
