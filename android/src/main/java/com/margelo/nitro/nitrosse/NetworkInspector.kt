package com.margelo.nitro.nitrosse

import android.util.Log
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer
import java.lang.reflect.Method

/**
 * Reports SSE connection events to the React Native DevTools Network inspector.
 *
 * Uses Java reflection to dynamically access React Native's internal `InspectorNetworkReporter`.
 * This prevents compilation failure or runtime link errors when running in production builds
 * or environments where network inspection modules are stripped.
 */
@Suppress("TooGenericExceptionCaught")
object NetworkInspector {
    private const val TAG = "NitroSseNetworkInspector"
    private const val MAX_INSPECTOR_BODY_BYTES = 64 * 1024L

    private val isDebuggingEnabledMethod: Method?
    private val reportRequestStartMethod: Method?
    private val reportResponseStartMethod: Method?
    private val reportResponseEndMethod: Method?
    private val reportRequestFailedMethod: Method?

    init {
        var isDebugging: Method? = null
        var reqStart: Method? = null
        var resStart: Method? = null
        var resEnd: Method? = null
        var reqFailed: Method? = null

        try {
            val clazz = Class.forName("com.facebook.react.modules.network.InspectorNetworkReporter")
            isDebugging = clazz.getDeclaredMethod("isDebuggingEnabled")
            reqStart = clazz.getDeclaredMethod(
                "reportRequestStart",
                String::class.java,
                String::class.java,
                String::class.java,
                Map::class.java,
                String::class.java,
                Long::class.javaPrimitiveType
            )
            resStart = clazz.getDeclaredMethod(
                "reportResponseStart",
                String::class.java,
                String::class.java,
                Int::class.javaPrimitiveType,
                Map::class.java,
                Long::class.javaPrimitiveType
            )
            resEnd = clazz.getDeclaredMethod(
                "reportResponseEnd",
                String::class.java,
                Long::class.javaPrimitiveType
            )
            reqFailed = clazz.getDeclaredMethod(
                "reportRequestFailed",
                String::class.java,
                Boolean::class.javaPrimitiveType
            )
        } catch (_: Throwable) {
            // InspectorNetworkReporter is unavailable in production or stripped builds.
        }

        isDebuggingEnabledMethod = isDebugging
        reportRequestStartMethod = reqStart
        reportResponseStartMethod = resStart
        reportResponseEndMethod = resEnd
        reportRequestFailedMethod = reqFailed
    }

    private fun isEnabled(): Boolean {
        return try {
            isDebuggingEnabledMethod?.invoke(null) as? Boolean == true
        } catch (_: Throwable) {
            false
        }
    }

    fun reportRequestStart(requestId: String, request: Request) {
        if (!isEnabled()) return
        try {
            val body = request.body?.let { reqBody ->
                val contentLen = reqBody.contentLength()
                if (reqBody.isOneShot() || reqBody.isDuplex() || contentLen > MAX_INSPECTOR_BODY_BYTES) {
                    "[Body omitted or exceeds ${MAX_INSPECTOR_BODY_BYTES}B]"
                } else {
                    val buffer = Buffer()
                    reqBody.writeTo(buffer)
                    val bytesToRead = minOf(buffer.size, MAX_INSPECTOR_BODY_BYTES)
                    buffer.readUtf8(bytesToRead)
                }
            } ?: ""

            reportRequestStartMethod?.invoke(
                null,
                requestId,
                request.url.toString(),
                request.method,
                request.headers.toMap(),
                body,
                0L
            )
        } catch (e: Exception) {
            Log.e(TAG, "Error reporting request start", e)
        }
    }

    fun reportResponseStart(requestId: String, request: Request, response: Response) {
        if (!isEnabled()) return
        try {
            reportResponseStartMethod?.invoke(
                null,
                requestId,
                request.url.toString(),
                response.code,
                response.headers.toMap(),
                -1L
            )
        } catch (e: Exception) {
            Log.e(TAG, "Error reporting response start", e)
        }
    }

    fun reportResponseEnd(requestId: String, totalBytes: Long) {
        if (!isEnabled()) return
        try {
            reportResponseEndMethod?.invoke(null, requestId, totalBytes)
        } catch (e: Exception) {
            Log.e(TAG, "Error reporting response end", e)
        }
    }

    fun reportRequestFailed(requestId: String, cancelled: Boolean) {
        if (!isEnabled()) return
        try {
            reportRequestFailedMethod?.invoke(null, requestId, cancelled)
        } catch (e: Exception) {
            Log.e(TAG, "Error reporting request failure", e)
        }
    }
}

private const val INITIAL_CACHE_CAPACITY = 64
private const val CACHE_LOAD_FACTOR = 0.75f

/**
 * Shared tracker recording raw network socket transport metrics from [InspectorNetworkInterceptor].
 * Implements bounded caching and cleared-request guards to eliminate memory leaks from trailing socket reads.
 */
object SseNetworkMetricsTracker {
    private const val MAX_ENTRIES = 200

    private class MetricsEntry(
        var bytes: Long = 0L,
        var isGzip: Boolean = false,
        var cleared: Boolean = false
    )

    private val entries = object : LinkedHashMap<String, MetricsEntry>(
        INITIAL_CACHE_CAPACITY,
        CACHE_LOAD_FACTOR,
        false
    ) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, MetricsEntry>?): Boolean =
            size > MAX_ENTRIES
    }

    @Synchronized
    fun recordRawBytes(requestId: String, bytes: Long, isGzip: Boolean) {
        val entry = entries.getOrPut(requestId) { MetricsEntry() }
        // Drop trailing socket reads after request has been cleared/cancelled to prevent resurrected memory leaks
        if (entry.cleared) return

        entry.bytes += bytes
        if (isGzip) {
            entry.isGzip = true
        }
    }

    @Synchronized
    fun getRawBytes(requestId: String): Long? =
        entries[requestId]?.takeUnless { it.cleared }?.bytes

    @Synchronized
    fun isGzip(requestId: String): Boolean =
        entries[requestId]?.let { !it.cleared && it.isGzip } == true

    @Synchronized
    fun clear(requestId: String) {
        val entry = entries.getOrPut(requestId) { MetricsEntry() }
        entry.bytes = 0L
        entry.isGzip = false
        entry.cleared = true
    }

    @Synchronized
    internal fun reset() {
        entries.clear()
    }
}

/**
 * Network interceptor for recording raw wire response metadata for React Native DevTools.
 * Runs at the network layer to capture true HTTP status, raw wire headers (e.g. Content-Encoding: gzip), and timing.
 */
internal class InspectorNetworkInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val rid = request.tag(String::class.java)
        val response = chain.proceed(request)
        rid?.let {
            NetworkInspector.reportResponseStart(it, request, response)
        }
        val responseBody = response.body
        if (responseBody != null && rid != null) {
            val isGzip = response.header("Content-Encoding")?.equals("gzip", ignoreCase = true) == true
            val trackingSource = object : ForwardingSource(responseBody.source()) {
                override fun read(sink: okio.Buffer, byteCount: Long): Long {
                    val read = super.read(sink, byteCount)
                    if (read > 0) {
                        SseNetworkMetricsTracker.recordRawBytes(rid, read, isGzip)
                    }
                    return read
                }
            }
            val wrappedBody = object : ResponseBody() {
                override fun contentType() = responseBody.contentType()
                override fun contentLength() = responseBody.contentLength()
                override fun source(): BufferedSource = trackingSource.buffer()
            }
            return response.newBuilder().body(wrappedBody).build()
        }
        return response
    }
}
