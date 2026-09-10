package com.margelo.nitro.nitrosse

import android.os.Build
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import okio.GzipSink
import okio.buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicLong

/**
 * Implementation unit tests directly targeting [HeartbeatNetworkInterceptor].
 *
 * Verifies live OkHttp chain interception, transparent byte tracking via [AtomicLong],
 * gzip decompression via GzipSource, SSE comment stripping per WHATWG specification,
 * and seamless downstream body reading.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.O])
class HeartbeatNetworkInterceptorTest {
    private lateinit var server: MockWebServer
    private lateinit var totalBytesReceived: AtomicLong
    private val heartbeats = mutableListOf<Pair<String?, String>>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        totalBytesReceived = AtomicLong(0)
        heartbeats.clear()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun testPlainTextHeartbeatDetectionAndByteCounting() {
        val sseStream = ": ping\ndata: hello\n\n:pong\n"
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(sseStream)
        )

        val interceptor = HeartbeatInterceptor(totalBytesReceived) { rid, comment ->
            heartbeats.add(rid to comment)
        }
        val client = OkHttpClient.Builder()
            .addInterceptor(interceptor)
            .build()

        val request = Request.Builder()
            .url(server.url("/sse"))
            .tag(String::class.java, "test-req-123")
            .build()

        val response = client.newCall(request).execute()
        val bodyContent = response.body?.string()

        // Downstream consumer must read intact stream content
        assertEquals(sseStream, bodyContent)

        // Total bytes received should match byte length of raw stream
        assertEquals(sseStream.toByteArray().size.toLong(), totalBytesReceived.get())

        // Heartbeats:
        // ": ping\n" -> "ping" (single leading space stripped)
        // ":pong\n" -> "pong" (no space, preserved)
        assertEquals(2, heartbeats.size)
        assertEquals("test-req-123" to "ping", heartbeats[0])
        assertEquals("test-req-123" to "pong", heartbeats[1])
    }

    @Test
    fun testGzipStreamDecompressionAndHeartbeatDetection() {
        val sseStream = ": keepalive\ndata: compressed-sse\n\n"

        // Compress data using GzipSink
        val compressedBuffer = Buffer()
        val gzipSink = GzipSink(compressedBuffer).buffer()
        gzipSink.writeUtf8(sseStream)
        gzipSink.close()

        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setHeader("Content-Encoding", "gzip")
                .setBody(compressedBuffer)
        )

        val interceptor = HeartbeatInterceptor(totalBytesReceived) { rid, comment ->
            heartbeats.add(rid to comment)
        }
        val client = OkHttpClient.Builder()
            .addInterceptor(interceptor)
            .build()

        val request = Request.Builder()
            .url(server.url("/gzip-sse"))
            .build()

        val response = client.newCall(request).execute()

        // Content-Encoding header is stripped by OkHttp's BridgeInterceptor during transparent decompression
        assertNull(response.header("Content-Encoding"))

        val bodyContent = response.body?.string()
        assertEquals(sseStream, bodyContent)
        assertEquals(1, heartbeats.size)
        assertEquals(null to "keepalive", heartbeats[0])
        assertTrue(totalBytesReceived.get() > 0)
    }

    @Test
    fun testNonCommentStreamsDoNotTriggerHeartbeat() {
        val dataOnly = "data: line 1\ndata: line 2\n\n"
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(dataOnly)
        )

        val interceptor = HeartbeatInterceptor(totalBytesReceived) { rid, comment ->
            heartbeats.add(rid to comment)
        }
        val client = OkHttpClient.Builder()
            .addInterceptor(interceptor)
            .build()

        val request = Request.Builder().url(server.url("/events")).build()
        val response = client.newCall(request).execute()
        val bodyContent = response.body?.string()

        assertEquals(dataOnly, bodyContent)
        assertTrue(heartbeats.isEmpty())
        assertEquals(dataOnly.toByteArray().size.toLong(), totalBytesReceived.get())
    }
}
