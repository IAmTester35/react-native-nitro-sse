package com.margelo.nitro.nitrosse

import android.util.Log
import okhttp3.Request
import okhttp3.Response
import java.util.UUID

/**
 * A utility to report network events to the React Native DevTools Network Tab.
 * It uses reflection to access the internal InspectorNetworkReporter class in RN.
 */
object NetworkInspector {
    private const val TAG = "NitroSseNetworkInspector"
    private var reporterClass: Class<*>? = null
    private var isEnabledCached: Boolean = false

    init {
        try {
            reporterClass = Class.forName("com.facebook.react.modules.network.InspectorNetworkReporter")
            Log.d(TAG, "InspectorNetworkReporter found. Network tracing is available.")
        } catch (e: Exception) {
            Log.d(TAG, "InspectorNetworkReporter not found. Network tracing is disabled.")
        }
    }

    private fun isEnabled(): Boolean {
        if (reporterClass == null) return false
        return try {
            val method = reporterClass?.getDeclaredMethod("isDebuggingEnabled")
            method?.invoke(null) as? Boolean ?: false
        } catch (e: Exception) {
            false
        }
    }

    fun reportRequestStart(requestId: String, request: Request) {
        if (reporterClass == null || !isEnabled()) return
        try {
            val method = reporterClass?.getDeclaredMethod(
                "reportRequestStart",
                String::class.java,
                String::class.java,
                String::class.java,
                Map::class.java,
                String::class.java,
                Long::class.javaPrimitiveType
            )
            val headers = request.headers.toMap()
            // We send an empty body string as SSE setup usually doesn't have a large body
            val body = "" 
            method?.invoke(null, requestId, request.url.toString(), request.method, headers, body, 0L)
        } catch (e: Exception) {
            Log.e(TAG, "Error reporting request start", e)
        }
    }

    fun reportResponseStart(requestId: String, request: Request, response: Response) {
        if (reporterClass == null || !isEnabled()) return
        try {
            val method = reporterClass?.getDeclaredMethod(
                "reportResponseStart",
                String::class.java,
                String::class.java,
                Int::class.javaPrimitiveType,
                Map::class.java,
                Long::class.javaPrimitiveType
            )
            val headers = response.headers.toMap()
            method?.invoke(null, requestId, request.url.toString(), response.code, headers, -1L)
        } catch (e: Exception) {
            Log.e(TAG, "Error reporting response start", e)
        }
    }

    fun reportResponseEnd(requestId: String, totalBytes: Long) {
        if (reporterClass == null || !isEnabled()) return
        try {
            val method = reporterClass?.getDeclaredMethod("reportResponseEnd", String::class.java, Long::class.javaPrimitiveType)
            method?.invoke(null, requestId, totalBytes)
        } catch (e: Exception) {
            Log.e(TAG, "Error reporting response end", e)
        }
    }

    fun reportRequestFailed(requestId: String, cancelled: Boolean) {
        if (reporterClass == null || !isEnabled()) return
        try {
            val method = reporterClass?.getDeclaredMethod("reportRequestFailed", String::class.java, Boolean::class.javaPrimitiveType)
            method?.invoke(null, requestId, cancelled)
        } catch (e: Exception) {
            Log.e(TAG, "Error reporting request failure", e)
        }
    }
}
