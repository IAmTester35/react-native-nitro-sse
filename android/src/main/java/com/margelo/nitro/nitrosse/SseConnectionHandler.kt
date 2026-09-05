package com.margelo.nitro.nitrosse

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import okio.Buffer
import okio.ForwardingSource
import okio.GzipSource
import okio.buffer
import java.util.concurrent.atomic.AtomicLong

/**
 * Interface for delegating OkHttp SSE event callbacks to the connection manager.
 */
interface SseConnectionDelegate {
    fun connectionDidOpen(response: Response, requestId: String)
    fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String)
    fun connectionDidFail(t: Throwable?, response: Response?, requestId: String)
    fun connectionDidClose(requestId: String)
}

/**
 * Creates OkHttp [EventSource] instances and translates OkHttp callbacks into [SseConnectionDelegate] calls.
 */
class SseConnectionHandler(private val delegate: SseConnectionDelegate) {
    
    fun createEventSource(client: OkHttpClient, request: Request, requestId: String): EventSource {
        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                delegate.connectionDidOpen(response, requestId)
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                delegate.connectionDidReceiveMessage(id, type, data, requestId)
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                delegate.connectionDidFail(t, response, requestId)
            }

            override fun onClosed(eventSource: EventSource) {
                delegate.connectionDidClose(requestId)
            }
        }
        return EventSources.createFactory(client).newEventSource(request, listener)
    }
}

/**
 * Network interceptor for byte accounting and SSE heartbeat/comment detection.
 * Sniffs raw stream before EventSourceReader discards SSE comments (`:`).
 */
internal class HeartbeatNetworkInterceptor(
    private val totalBytesReceived: AtomicLong,
    private val onHeartbeat: (requestId: String?, comment: String) -> Unit
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val rid = request.tag(String::class.java)

        val response = chain.proceed(request)

        rid?.let {
            NetworkInspector.reportResponseStart(it, request, response)
        }

        val responseBody = response.body
        if (responseBody != null) {
            val isGzip = "gzip".equals(response.header("Content-Encoding"), ignoreCase = true)
            val rawSource = if (isGzip) {
                GzipSource(responseBody.source())
            } else {
                responseBody.source()
            }

            val countingBody = object : ResponseBody() {
                override fun contentType() = responseBody.contentType()
                override fun contentLength() = if (isGzip) -1L else responseBody.contentLength()

                private val bufferedSource by lazy {
                    (object : ForwardingSource(rawSource) {
                        private var isAtStartOfLine = true
                        private var isReadingComment = false
                        private val commentBuffer = java.io.ByteArrayOutputStream()

                        override fun read(sink: Buffer, byteCount: Long): Long {
                            val scratch = Buffer()
                            val bytesRead = super.read(scratch, byteCount)
                            if (bytesRead != -1L) {
                                totalBytesReceived.addAndGet(bytesRead)
                                try {
                                    val bytes = scratch.snapshot().toByteArray()
                                    for (b in bytes) {
                                        val isNewline = (b == '\n'.code.toByte() || b == '\r'.code.toByte())
                                        if (isReadingComment) {
                                            if (isNewline) {
                                                isReadingComment = false
                                                val rawComment = commentBuffer.toString("UTF-8")
                                                // WHATWG SSE Spec: Remove only a single leading space after ':' if present
                                                val commentText = if (rawComment.startsWith(" ")) rawComment.substring(1) else rawComment
                                                commentBuffer.reset()
                                                onHeartbeat(rid, commentText)
                                            } else {
                                                commentBuffer.write(b.toInt())
                                            }
                                        } else if (isAtStartOfLine && b == ':'.code.toByte()) {
                                            isReadingComment = true
                                            commentBuffer.reset()
                                        }
                                        isAtStartOfLine = isNewline
                                    }
                                } catch (e: Exception) {
                                    // Swallow byte scanning errors to prevent stream reader failure if buffer inspection fails
                                }
                                sink.write(scratch, bytesRead)
                            }
                            return bytesRead
                        }
                    }).buffer()
                }

                override fun source() = bufferedSource
            }
            val responseBuilder = response.newBuilder().body(countingBody)
            if (isGzip) {
                responseBuilder.removeHeader("Content-Encoding").removeHeader("Content-Length")
            }
            return responseBuilder.build()
        }
        return response
    }
}
