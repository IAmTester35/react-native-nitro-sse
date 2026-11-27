package com.margelo.nitro.nitrosse

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Maximum bytes to read from HTTP error responses to prevent Out-Of-Memory errors.
 */
const val MAX_ERROR_BODY_BYTES = 8192L

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
    fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {}
    fun connectionDidClose(requestId: String)
}

fun SseConnectionDelegate.connectionDidFail(t: Throwable?, response: Response?, requestId: String) {
    connectionDidFail(t, response, null, requestId)
}

private fun dispatchInvalidContentType(
    response: Response,
    body: ResponseBody?,
    isCancelled: () -> Boolean,
    delegate: SseConnectionDelegate,
    requestId: String
) {
    response.use { res ->
        val receivedType = body?.contentType()?.toString() ?: "none"
        val error = InvalidContentTypeException(
            "Invalid Content-Type: expected text/event-stream but received '$receivedType'"
        )
        if (!isCancelled()) {
            delegate.connectionDidFail(error, res, null, requestId)
        }
    }
}

private fun dispatchNonOkResponse(
    response: Response,
    errorBody: String?,
    isCancelled: () -> Boolean,
    delegate: SseConnectionDelegate,
    requestId: String
) {
    if (!isCancelled()) {
        delegate.connectionDidFail(null, response, errorBody, requestId)
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

    private fun shouldReadErrorBody(response: Response): Boolean =
        response.code >= SseHttpStatus.BAD_REQUEST

    private fun readBoundedErrorBody(response: Response): String? {
        val source = if (shouldReadErrorBody(response)) response.body?.source() else null
        return source?.let {
            val timeoutMs = client.connectTimeoutMillis.toLong()
            if (timeoutMs > 0L) {
                it.timeout().deadline(timeoutMs, TimeUnit.MILLISECONDS)
            }
            try {
                try {
                    it.request(MAX_ERROR_BODY_BYTES)
                } catch (_: IOException) {
                    // Preserve any partial error body bytes already buffered before disconnect/timeout
                }
                val size = minOf(it.buffer.size, MAX_ERROR_BODY_BYTES)
                if (size > 0L) it.buffer.readUtf8(size) else null
            } finally {
                if (timeoutMs > 0L) {
                    it.timeout().clearDeadline()
                }
            }
        }
    }

    private fun createReaderCallback(): SseEventReader.Callback = object : SseEventReader.Callback {
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

    private fun streamResponseEvents(response: Response, body: ResponseBody) {
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
            val callback = createReaderCallback()

            while (!isCancelled && reader.processNextEvent(callback)) {
                // Read and dispatch events sequentially
            }

            if (!isCancelled) {
                delegate.connectionDidClose(requestId)
            }
        } catch (e: SseParserLimitException) {
            if (!isCancelled) {
                delegate.connectionDidEncounterParseError(requestId)
                delegate.connectionDidFail(e, null, null, requestId)
            }
        } catch (e: IOException) {
            if (!isCancelled) {
                delegate.connectionDidFail(e, null, null, requestId)
            }
        } finally {
            response.close()
        }
    }

    override fun onResponse(call: Call, response: Response) {
        val body = response.body
        when {
            isCancelled -> response.close()
            response.code != SseHttpStatus.OK -> response.use { res ->
                // WHATWG SSE Section 9.1: Only HTTP 200 OK responses with text/event-stream establish an SSE stream.
                dispatchNonOkResponse(res, readBoundedErrorBody(res), { isCancelled }, delegate, requestId)
            }
            body == null || !isEventStream(body) ->
                // WHATWG SSE: permanently fail and stop without reconnecting on non-event-stream Content-Type.
                dispatchInvalidContentType(response, body, { isCancelled }, delegate, requestId)
            else -> {
                val emptyResponse = response.newBuilder().body("".toResponseBody(null)).build()
                delegate.connectionDidOpen(emptyResponse, requestId)
                streamResponseEvents(response, body)
            }
        }
    }

    private fun isEventStream(body: ResponseBody): Boolean {
        val contentType = body.contentType() ?: return false
        return contentType.type == "text" && contentType.subtype == "event-stream"
    }
}

/**
 * Creates OkHttp [EventSource] instances and builds sanitized SSE [Request] objects.
 */
class SseConnectionHandler(private val delegate: SseConnectionDelegate) {

    fun createEventSource(client: OkHttpClient, request: Request, requestId: String): SseEventSource {
        val eventSource = RealSseEventSource(client, request, delegate, requestId)
        eventSource.connect()
        return eventSource
    }

    companion object {
        internal fun buildRequest(
            currentConfig: SseConfig,
            currentLastId: String?,
            newRequestId: String
        ): Request {
            // Set SSE headers explicitly for Network Inspector visibility and encoding control.
            val requestBuilder = Request.Builder()
                .url(currentConfig.url)
                .header("Accept", "text/event-stream")
                .header("Cache-Control", "no-cache")

            // Populate config headers first, filtering out Last-Event-ID and Accept-Encoding
            currentConfig.headers?.forEach { (k, v) ->
                if (!k.equals("Last-Event-ID", ignoreCase = true) &&
                    !k.equals("Accept-Encoding", ignoreCase = true)
                ) {
                    requestBuilder.header(k, v)
                }
            }

            currentLastId?.let {
                if (it.isNotEmpty()) requestBuilder.header("Last-Event-ID", it)
            }

            if (currentConfig.method == HttpMethod.POST) {
                val customContentType = currentConfig.headers?.entries?.firstOrNull {
                    it.key.equals("Content-Type", ignoreCase = true)
                }?.value
                val mediaType = (customContentType ?: "application/json").toMediaType()
                val body = (currentConfig.body ?: "").toRequestBody(mediaType)
                requestBuilder.post(body)
            }

            requestBuilder.tag(String::class.java, newRequestId)
            return requestBuilder.build()
        }
    }
}


