package com.margelo.nitro.nitrosse

import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Implementation unit tests verifying [NetworkInspector] fallback behavior and reflection safety.
 *
 * Confirms that all tracing callbacks degrade gracefully without throwing exceptions when
 * React Native's internal `InspectorNetworkReporter` is absent from the classpath.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.O])
class NetworkInspectorTest {
    private val TEST_URL = "http://localhost:33333/events"

    @Test
    fun testReportRequestStartGracefulFallback() {
        val requestWithBody = Request.Builder()
            .url(TEST_URL)
            .method("POST", "test body".toRequestBody("text/plain".toMediaType()))
            .header("X-Custom", "value")
            .build()

        // Should not throw even if InspectorNetworkReporter is not available
        NetworkInspector.reportRequestStart("req-1", requestWithBody)

        val requestWithoutBody = Request.Builder()
            .url(TEST_URL)
            .get()
            .build()

        NetworkInspector.reportRequestStart("req-2", requestWithoutBody)
    }

    @Test
    fun testReportResponseStartGracefulFallback() {
        val request = Request.Builder().url(TEST_URL).build()
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .header("Content-Type", "text/event-stream")
            .body("".toResponseBody(null))
            .build()

        NetworkInspector.reportResponseStart("req-1", request, response)
    }

    @Test
    fun testReportResponseEndGracefulFallback() {
        NetworkInspector.reportResponseEnd("req-1", 1024L)
        NetworkInspector.reportResponseEnd("req-2", 0L)
    }

    @Test
    fun testReportRequestFailedGracefulFallback() {
        NetworkInspector.reportRequestFailed("req-1", cancelled = true)
        NetworkInspector.reportRequestFailed("req-2", cancelled = false)
    }
}
