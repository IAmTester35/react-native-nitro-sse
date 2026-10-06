package com.margelo.nitro.nitrosse

import okhttp3.Call
import okhttp3.Callback
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.BufferedSource
import okio.ByteString
import okio.ForwardingSource
import okio.buffer
import java.io.IOException

/**
 * Maximum bytes to read from HTTP error responses to prevent Out-Of-Memory errors.
 */
const val MAX_ERROR_BODY_BYTES = 8192L

/**
 * Maximum bytes allowed for a single SSE line to prevent Out-Of-Memory errors.
 */
const val MAX_SSE_LINE_LENGTH = 16 * 1024 * 1024L

/**
 * Maximum characters allowed for accumulated event data to prevent Out-Of-Memory errors.
 */
const val MAX_SSE_EVENT_DATA_SIZE = 16 * 1024 * 1024

/**
 * CRLF delimiter byte sequence (\r, \n) used for optimized line break scanning.
 */
private val CRLF_DELIMITERS = ByteString.of('\r'.code.toByte(), '\n'.code.toByte())

/**
 * Exception indicating the HTTP response did not have 'text/event-stream' Content-Type per WHATWG SSE specification.
 */
class InvalidContentTypeException(message: String) : IOException(message)

/**
 * Interface representing an active SSE stream connection that can be cancelled.
 */
interface SseEventSource {
    fun cancel()
    fun request(): Request
}

/**
 * Interface for delegating OkHttp SSE event callbacks to the connection manager.
 */
interface SseConnectionDelegate {
    fun connectionDidOpen(response: Response, requestId: String)
    fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String)
    fun connectionDidReceiveComment(comment: String, requestId: String) {}
    fun connectionDidReceiveRetry(retryMs: Long, requestId: String) {}
    fun connectionDidUpdateLastEventId(id: String?, requestId: String) {}
    fun connectionDidReceiveDataChunk(decompressedBytes: Long, requestId: String) {}
    fun connectionDidParseLines(count: Int, requestId: String) {}
    fun connectionDidEncounterParseError(requestId: String) {}
    fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
        connectionDidFail(t, response, requestId)
    }
    fun connectionDidFail(t: Throwable?, response: Response?, requestId: String) {}
    fun connectionDidClose(requestId: String)
}

/**
 * Sequential line-by-line SSE parser complying with WHATWG Server-Sent Events specification.
 * Ensures strict chronological ordering between data messages, comments, and directives.
 */
internal class SseEventReader(private val source: BufferedSource) {
    interface Callback {
        fun onEvent(id: String?, type: String?, data: String)
        fun onComment(comment: String)
        fun onRetryChange(retryMs: Long)
        fun onIdUpdate(id: String?) {}
        fun onLinesParsed(count: Int) {}
    }

    private val dataBuffer = StringBuilder()
    private var hasData = false
    private var eventType: String? = null
    private var lastEventId: String? = null
    private var isAtStreamStart = true
    private var skipLeadingLf = false

    /**
     * Reads a line from [source] handling CRLF (\r\n), bare CR (\r), and LF (\n).
     * Strips leading UTF-8 BOM (0xEF, 0xBB, 0xBF) if present at stream start per WHATWG SSE spec.
     * Operates on [BufferedSource.buffer] using hardware-accelerated [Buffer.indexOfElement] to locate
     * line endings without byte-by-byte Kotlin loop overhead while properly supporting bare carriage returns.
     */
    private fun readSseLine(): String? {
        val buffer = source.buffer
        if (source.exhausted()) return null

        if (isAtStreamStart) {
            if (source.request(3)) {
                if (buffer.size >= 3 &&
                    buffer[0] == 0xEF.toByte() &&
                    buffer[1] == 0xBB.toByte() &&
                    buffer[2] == 0xBF.toByte()
                ) {
                    buffer.skip(3)
                }
            }
            isAtStreamStart = false
        }

        if (skipLeadingLf) {
            skipLeadingLf = false
            if (buffer.size > 0 && buffer[0] == '\n'.code.toByte()) {
                buffer.skip(1)
            }
        }

        var scanned = 0L
        while (true) {
            val newlineIndex = buffer.indexOfElement(CRLF_DELIMITERS, scanned)
            if (newlineIndex != -1L) {
                if (newlineIndex > MAX_SSE_LINE_LENGTH) {
                    throw IOException("SSE line exceeded maximum limit of $MAX_SSE_LINE_LENGTH bytes")
                }
                val b = buffer[newlineIndex]
                val line = buffer.readUtf8(newlineIndex)
                buffer.skip(1)
                if (b == '\r'.code.toByte()) {
                    // If followed immediately by \n in current buffer, consume \n as CRLF.
                    // If buffer is exhausted at this exact boundary, defer check via skipLeadingLf
                    // to avoid blocking on source.request(1) when server sent bare CR.
                    if (buffer.size > 0) {
                        if (buffer[0] == '\n'.code.toByte()) {
                            buffer.skip(1)
                        }
                    } else {
                        skipLeadingLf = true
                    }
                }
                return line
            }

            if (buffer.size > MAX_SSE_LINE_LENGTH) {
                throw IOException("SSE line exceeded maximum limit of $MAX_SSE_LINE_LENGTH bytes")
            }

            scanned = buffer.size
            if (!source.request(buffer.size + 1)) {
                if (buffer.size > MAX_SSE_LINE_LENGTH) {
                    throw IOException("SSE line exceeded maximum limit of $MAX_SSE_LINE_LENGTH bytes")
                }
                return if (buffer.size > 0) buffer.readUtf8() else null
            }
        }
    }

    /**
     * Reads lines from source until one event (message or comment) is completed and dispatched.
     * Returns true if an event was dispatched, or false on EOF.
     * Per WHATWG SSE spec: "Once the end of the file is reached, any pending data must be dispatched as an event."
     */
    fun processNextEvent(callback: Callback): Boolean {
        var linesParsedInEvent = 0
        while (true) {
            val line = readSseLine()
            if (line == null) {
                if (linesParsedInEvent > 0) {
                    callback.onLinesParsed(linesParsedInEvent)
                }
                if (hasData) {
                    val data = dataBuffer.toString()
                    val id = lastEventId
                    val type = eventType
                    dataBuffer.setLength(0)
                    hasData = false
                    eventType = null
                    callback.onEvent(id, type, data)
                    return true
                }
                return false
            }
            linesParsedInEvent++
            if (line.isEmpty()) {
                if (hasData) {
                    callback.onLinesParsed(linesParsedInEvent)
                    val data = dataBuffer.toString()
                    val id = lastEventId
                    val type = eventType
                    dataBuffer.setLength(0)
                    hasData = false
                    eventType = null
                    callback.onEvent(id, type, data)
                    return true
                }
                // Delimiter / keepalive empty line without data
            } else if (line.startsWith(":")) {
                callback.onLinesParsed(linesParsedInEvent)
                val rawComment = line.substring(1)
                val commentText = if (rawComment.startsWith(" ")) rawComment.substring(1) else rawComment
                callback.onComment(commentText)
                return true
            } else {
                val colonIndex = line.indexOf(':')
                val field: String
                val value: String
                if (colonIndex != -1) {
                    field = line.substring(0, colonIndex)
                    val rawValue = line.substring(colonIndex + 1)
                    value = if (rawValue.startsWith(" ")) rawValue.substring(1) else rawValue
                } else {
                    field = line
                    value = ""
                }
                when (field) {
                    "data" -> {
                        if (dataBuffer.length + value.length > MAX_SSE_EVENT_DATA_SIZE) {
                            throw IOException("SSE event data exceeded maximum limit of $MAX_SSE_EVENT_DATA_SIZE characters")
                        }
                        if (hasData) {
                            dataBuffer.append("\n")
                        }
                        dataBuffer.append(value)
                        hasData = true
                    }
                    "id" -> {
                        if (!value.contains('\u0000')) {
                            lastEventId = if (value.isEmpty()) null else value
                            callback.onIdUpdate(lastEventId)
                        }
                    }
                    "event" -> {
                        eventType = if (value.isEmpty()) null else value
                    }
                    "retry" -> {
                        // WHATWG SSE: If field value consists solely of ASCII digits 0-9, set reconnection time. Otherwise ignore.
                        if (value.isNotEmpty() && value.all { it in '0'..'9' }) {
                            val retryMs = value.toLongOrNull()
                            if (retryMs != null && retryMs >= 0) {
                                callback.onRetryChange(retryMs)
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Thread-safe EventSource implementation backed by OkHttp [Call] and sequential [SseEventReader].
 */
internal class RealSseEventSource(
    private val client: OkHttpClient,
    private val request: Request,
    private val delegate: SseConnectionDelegate,
    private val requestId: String
) : SseEventSource, Callback {
    private var call: Call? = null
    @Volatile
    private var isCancelled = false

    fun connect() {
        val newCall = client.newCall(request)
        synchronized(this) {
            if (isCancelled) {
                newCall.cancel()
                return
            }
            call = newCall
        }
        newCall.enqueue(this)
    }

    override fun request(): Request = request

    override fun cancel() {
        synchronized(this) {
            isCancelled = true
            call?.cancel()
        }
    }

    override fun onFailure(call: Call, e: IOException) {
        if (!isCancelled) {
            delegate.connectionDidFail(e, null, null, requestId)
        }
    }

    override fun onResponse(call: Call, response: Response) {
        if (isCancelled) {
            response.close()
            return
        }

        // WHATWG SSE Section 9.1: Only HTTP 200 OK responses with text/event-stream establish an SSE stream.
        // Any other HTTP response code (including 201, 204, 206, 4xx, 5xx) must fail the connection.
        if (response.code != 200) {
            val errorBody = if (response.code != 204) {
                try {
                    response.peekBody(MAX_ERROR_BODY_BYTES).string()
                } catch (e: Exception) {
                    null
                }
            } else null
            delegate.connectionDidFail(null, response, errorBody, requestId)
            response.close()
            return
        }



        // WHATWG SSE: permanently fail and stop without reconnecting on non-event-stream Content-Type.
        val body = response.body
        if (body == null || !isEventStream(body)) {
            val receivedType = body?.contentType()?.toString() ?: "none"
            val error = InvalidContentTypeException("Invalid Content-Type: expected text/event-stream but received '$receivedType'")
            delegate.connectionDidFail(error, response, null, requestId)
            response.close()
            return
        }

        val emptyResponse = response.newBuilder().body("".toResponseBody(null)).build()
        delegate.connectionDidOpen(emptyResponse, requestId)

        try {
            val decompressedSource = object : ForwardingSource(body.source()) {
                override fun read(sink: okio.Buffer, byteCount: Long): Long {
                    val read = super.read(sink, byteCount)
                    if (read > 0 && !isCancelled) {
                        this@RealSseEventSource.delegate.connectionDidReceiveDataChunk(read, requestId)
                    }
                    return read
                }
            }
            val reader = SseEventReader(decompressedSource.buffer())
            val callback = object : SseEventReader.Callback {
                override fun onEvent(id: String?, type: String?, data: String) {
                    if (!isCancelled) {
                        delegate.connectionDidReceiveMessage(id, type, data, requestId)
                    }
                }

                override fun onComment(comment: String) {
                    if (!isCancelled) {
                        delegate.connectionDidReceiveComment(comment, requestId)
                    }
                }

                override fun onRetryChange(retryMs: Long) {
                    if (!isCancelled) {
                        delegate.connectionDidReceiveRetry(retryMs, requestId)
                    }
                }

                override fun onIdUpdate(id: String?) {
                    if (!isCancelled) {
                        delegate.connectionDidUpdateLastEventId(id, requestId)
                    }
                }

                override fun onLinesParsed(count: Int) {
                    if (!isCancelled) {
                        delegate.connectionDidParseLines(count, requestId)
                    }
                }
            }

            while (!isCancelled && reader.processNextEvent(callback)) {
                // Read and dispatch events sequentially
            }

            if (!isCancelled) {
                delegate.connectionDidClose(requestId)
            }
        } catch (e: Exception) {
            if (!isCancelled) {
                if (e is InvalidContentTypeException ||
                    e.message?.contains("SSE line exceeded") == true ||
                    e.message?.contains("SSE event data exceeded") == true
                ) {
                    delegate.connectionDidEncounterParseError(requestId)
                }
                delegate.connectionDidFail(e, response, null, requestId)
            }
        } finally {
            response.close()
        }
    }

    private fun isEventStream(body: ResponseBody): Boolean {
        val contentType = body.contentType() ?: return false
        return contentType.type == "text" && contentType.subtype == "event-stream"
    }
}

/**
 * Creates OkHttp [EventSource] instances and translates callbacks into [SseConnectionDelegate] calls.
 */
class SseConnectionHandler(private val delegate: SseConnectionDelegate) {
    
    fun createEventSource(client: OkHttpClient, request: Request, requestId: String): SseEventSource {
        val eventSource = RealSseEventSource(client, request, delegate, requestId)
        eventSource.connect()
        return eventSource
    }
}

/**
 * Shared tracker recording raw network socket transport metrics from InspectorNetworkInterceptor.
 */
object SseNetworkMetricsTracker {
    private val rawBytesMap = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicLong>()
    private val gzipMap = java.util.concurrent.ConcurrentHashMap<String, Boolean>()
    private val chunksMap = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicLong>()

    fun recordRawBytes(requestId: String, bytes: Long, isGzip: Boolean) {
        rawBytesMap.computeIfAbsent(requestId) { java.util.concurrent.atomic.AtomicLong(0) }.addAndGet(bytes)
        chunksMap.computeIfAbsent(requestId) { java.util.concurrent.atomic.AtomicLong(0) }.incrementAndGet()
        if (isGzip) {
            gzipMap[requestId] = true
        }
    }

    fun getRawBytes(requestId: String): Long? = rawBytesMap[requestId]?.get()
    fun getChunks(requestId: String): Long? = chunksMap[requestId]?.get()
    fun isGzip(requestId: String): Boolean = gzipMap[requestId] == true

    fun clear(requestId: String) {
        rawBytesMap.remove(requestId)
        gzipMap.remove(requestId)
        chunksMap.remove(requestId)
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


