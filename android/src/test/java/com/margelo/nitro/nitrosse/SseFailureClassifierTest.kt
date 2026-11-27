package com.margelo.nitro.nitrosse

import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException

class SseFailureClassifierTest {
    private val testUrl = "http://localhost:33333/events"

    private fun makeResponse(code: Int, headers: Map<String, String> = emptyMap()): Response {
        val builder = Response.Builder()
            .request(Request.Builder().url(testUrl).build())
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("HTTP $code")
        headers.forEach { (k, v) -> builder.header(k, v) }
        return builder.build()
    }

    @Test
    fun `isEventStreamContentType matches exact mime and rejects spoofed content types`() {
        assertTrue(SseFailureClassifier.isEventStreamContentType("text/event-stream"))
        assertTrue(SseFailureClassifier.isEventStreamContentType("TEXT/EVENT-STREAM; charset=utf-8"))
        assertTrue(SseFailureClassifier.isEventStreamContentType("  text/event-stream ; charset=utf-8 "))

        assertFalse(SseFailureClassifier.isEventStreamContentType(null))
        assertFalse(SseFailureClassifier.isEventStreamContentType(""))
        assertFalse(SseFailureClassifier.isEventStreamContentType("application/json"))
        assertFalse(SseFailureClassifier.isEventStreamContentType("application/text/event-stream"))
        assertFalse(SseFailureClassifier.isEventStreamContentType("text/event-stream-v2"))
    }

    @Test
    fun `disconnectReason maps server, parser, timeout, and network errors`() {
        val parserCtx = SseFailureClassifier.buildContext(SseParserLimitException("Too large"), null, null)
        assertEquals(SseDisconnectReason.PARSER_ERROR, SseFailureClassifier.disconnectReason(parserCtx))

        val timeoutCtx = SseFailureClassifier.buildContext(SocketTimeoutException("Read timed out"), null, null)
        assertEquals(SseDisconnectReason.TIMEOUT, SseFailureClassifier.disconnectReason(timeoutCtx))

        val badMimeResp = makeResponse(200, mapOf("Content-Type" to "application/text/event-stream"))
        val badMimeCtx = SseFailureClassifier.buildContext(null, badMimeResp, null)
        assertEquals(SseDisconnectReason.SERVER_ERROR, SseFailureClassifier.disconnectReason(badMimeCtx))

        val netCtx = SseFailureClassifier.buildContext(IOException("Reset"), null, null)
        assertEquals(SseDisconnectReason.NETWORK_ERROR, SseFailureClassifier.disconnectReason(netCtx))
    }

    @Test
    fun `classify handles terminal failures`() {
        val policy = SseFailurePolicyInput(
            hasInterceptor = false,
            nextAuthAttempt = 1,
            maxAuthRetries = 3,
            maxRetryIntervalMs = 30_000L,
            retryAfterJitterMs = 1_000L
        )

        val ctx204 = SseFailureClassifier.buildContext(null, makeResponse(204), null)
        assertEquals(
            SseFailureDecision.FailAndStop("No Content (204). Stopping.", 204.0),
            SseFailureClassifier.classify(ctx204, policy)
        )

        val ctxMime = SseFailureClassifier.buildContext(
            InvalidContentTypeException("bad"),
            makeResponse(200, mapOf("Content-Type" to "text/plain")),
            null
        )
        assertEquals(
            SseFailureDecision.FailAndStop("Invalid Content-Type: expected text/event-stream. Stopping.", 200.0),
            SseFailureClassifier.classify(ctxMime, policy)
        )

        val ctxLimit = SseFailureClassifier.buildContext(SseParserLimitException("Line too long"), null, null)
        assertEquals(
            SseFailureDecision.FailAndStop("Line too long", null),
            SseFailureClassifier.classify(ctxLimit, policy)
        )

        val ctx201 = SseFailureClassifier.buildContext(
            null,
            makeResponse(201, mapOf("Content-Type" to "text/event-stream")),
            null
        )
        assertEquals(
            SseFailureDecision.FailAndStop("HTTP 201 is not a valid SSE response. Stopping.", 201.0),
            SseFailureClassifier.classify(ctx201, policy)
        )

        val ctx400 = SseFailureClassifier.buildContext(null, makeResponse(400), "  Bad Request  ")
        assertEquals(
            SseFailureDecision.FailAndStop("Fatal Error (400): Bad Request", 400.0),
            SseFailureClassifier.classify(ctx400, policy)
        )
    }

    @Test
    fun `classify handles auth decisions`() {
        val ctx403 = SseFailureClassifier.buildContext(null, makeResponse(403), null)

        assertEquals(
            SseFailureDecision.FailAndStop("Auth Error (403) - No interceptor provided. Stopping.", 403.0),
            SseFailureClassifier.classify(
                ctx403,
                SseFailurePolicyInput(false, 1, 3, 30_000L, 1_000L)
            )
        )

        assertEquals(
            SseFailureDecision.AuthRetry("Auth Error (403) - Retry 2/3. Refreshing token...", 403.0),
            SseFailureClassifier.classify(
                ctx403,
                SseFailurePolicyInput(true, 2, 3, 30_000L, 1_000L)
            )
        )

        assertEquals(
            SseFailureDecision.AuthLimitReached("Auth Error (403) - Retry limit reached (3). Stopping.", 403.0),
            SseFailureClassifier.classify(
                ctx403,
                SseFailurePolicyInput(true, 4, 3, 30_000L, 1_000L)
            )
        )
    }

    @Test
    fun `classify handles retry-after, rate limit, and transient errors`() {
        val policy = SseFailurePolicyInput(
            hasInterceptor = false,
            nextAuthAttempt = 1,
            maxAuthRetries = 3,
            maxRetryIntervalMs = 10_000L,
            retryAfterJitterMs = 1_000L
        )

        val ctx503 = SseFailureClassifier.buildContext(
            null,
            makeResponse(503, mapOf("Retry-After" to "60")),
            null
        )
        assertEquals(
            SseFailureDecision.RetryAfter("Retry-After received: 11s", 503.0, 11_000L),
            SseFailureClassifier.classify(ctx503, policy)
        )

        val ctx429 = SseFailureClassifier.buildContext(null, makeResponse(429), null)
        assertEquals(
            SseFailureDecision.RateLimitBackoff("Rate Limited (429). Retrying with backoff...", 429.0),
            SseFailureClassifier.classify(ctx429, policy)
        )

        val ctx500 = SseFailureClassifier.buildContext(null, makeResponse(500), " Gateway down ")
        assertEquals(
            SseFailureDecision.TransientRetry("Server Error (500): Gateway down", 500.0, false),
            SseFailureClassifier.classify(ctx500, policy)
        )

        val ctxTimeout = SseFailureClassifier.buildContext(SocketTimeoutException("Timed out"), null, null)
        assertEquals(
            SseFailureDecision.TransientRetry("Timed out", null, true),
            SseFailureClassifier.classify(ctxTimeout, policy)
        )

        // Retry-After: 0 with 500ms jitter must still enforce 1000ms minimum floor
        val minFloorPolicy = SseFailurePolicyInput(
            hasInterceptor = false,
            nextAuthAttempt = 1,
            maxAuthRetries = 3,
            maxRetryIntervalMs = 10_000L,
            retryAfterJitterMs = 500L
        )
        val ctx429Zero = SseFailureClassifier.buildContext(
            null,
            makeResponse(429, mapOf("Retry-After" to "0")),
            null
        )
        assertEquals(
            SseFailureDecision.RetryAfter("Retry-After received: 1s", 429.0, 1_000L),
            SseFailureClassifier.classify(ctx429Zero, minFloorPolicy)
        )

        // Large 400/500 body is truncated to 256 chars in message preview
        val longBody = "A".repeat(400)
        val ctxLong400 = SseFailureClassifier.buildContext(null, makeResponse(400), longBody)
        assertEquals(
            SseFailureDecision.FailAndStop("Fatal Error (400): ${"A".repeat(256)}…", 400.0),
            SseFailureClassifier.classify(ctxLong400, policy)
        )
    }
}
