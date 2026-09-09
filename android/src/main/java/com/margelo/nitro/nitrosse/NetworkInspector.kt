package com.margelo.nitro.nitrosse

import android.util.Log
import okhttp3.Request
import okhttp3.Response
import okio.Buffer
import java.lang.reflect.Method

/**
 * Reports SSE connection events to the React Native DevTools Network inspector.
 *
 * Uses Java reflection to dynamically access React Native's internal `InspectorNetworkReporter`.
 * This prevents compilation failure or runtime link errors when running in production builds
 * or environments where network inspection modules are stripped.
 */
object NetworkInspector {
    private const val TAG = "NitroSseNetworkInspector"

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
            Log.d(TAG, "InspectorNetworkReporter found. Network tracing is available.")
        } catch (_: Throwable) {
            Log.d(TAG, "InspectorNetworkReporter not found. Network tracing is disabled.")
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
            val body = request.body?.let {
                val buffer = Buffer()
                it.writeTo(buffer)
                buffer.readUtf8()
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
