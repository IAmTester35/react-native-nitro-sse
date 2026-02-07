package com.margelo.nitro.nitrosse

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.proguard.annotations.DoNotStrip
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSources
import okhttp3.sse.EventSourceListener
import okio.Buffer
import okio.ForwardingSource
import okio.buffer
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

/**
 * NitroSse implements a high-performance SSE client using OkHttp.
 * 
 * ARCHITECTURE DECISIONS:
 * 1. Threading: Uses a dedicated HandlerThread (sseHandlerThread) to offload all network events 
 *    and buffer management from the Main/JS threads. This prevents UI freezes during high-frequency bursts.
 * 2. Backpressure: Implements a producer-consumer pattern with an internal buffer and batching timer.
 *    This solves the "Bridge Flooding" problem by grouping multiple events into a single JSI call.
 * 3. Reliability: Uses exponential backoff with jitter and respects 'Retry-After' headers to 
 *    prevent DoS-ing the server while ensuring resilient reconnections.
 * 4. Heartbeat: Since OkHttp-SSE obscures comments, we use a Network Interceptor to manually 
 *    detect ':' bytes, enabling JS-side watchdog timers.
 */
@DoNotStrip
class NitroSse : HybridNitroSseSpec() {
    private var client: OkHttpClient? = null
    private var eventSource: EventSource? = null
    private var config: SseConfig? = null
    private var onEventsCallback: ((events: Array<SseEvent>) -> Unit)? = null
    
    private val isRunning = AtomicBoolean(false)
    private var wasRunningBeforePaused = false
    private var sseHandlerThread: android.os.HandlerThread? = null
    private var sseHandler: Handler? = null
    
    private val eventBuffer = mutableListOf<SseEvent>()
    private var isFlushPending = AtomicBoolean(false)
    
    private var backoffCounter = 0
    @Volatile private var lastProcessedId: String? = null
    
    private val totalBytesReceived = AtomicLong(0)
    private var reconnectCount = 0
    private var lastErrorTime: Double? = null
    private var lastErrorCode: String? = null

    private val defaultRetryDelayMs = 3000L
    private val baseBackoffDelayMs = 2000L
    private val maxBackoffDelayMs = 30000L

    companion object {
        private const val TAG = "NitroSse"
    }

    override fun setup(config: SseConfig, onEvent: (events: Array<SseEvent>) -> Unit) {
        this.config = config
        this.onEventsCallback = onEvent
        
        this.client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(35, TimeUnit.SECONDS)
            .addNetworkInterceptor { chain ->
                val response = chain.proceed(chain.request())
                val responseBody = response.body
                if (responseBody != null) {
                    val countingBody = object : ResponseBody() {
                        override fun contentType() = responseBody.contentType()
                        override fun contentLength() = responseBody.contentLength()
                        override fun source() = (object : okio.ForwardingSource(responseBody.source()) {
                            override fun read(sink: okio.Buffer, byteCount: Long): Long {
                                val bytesRead = super.read(sink, byteCount)
                                if (bytesRead != -1L) {
                                    totalBytesReceived.addAndGet(bytesRead)
                                    
                                    try {
                                        val snapshot = sink.snapshot()
                                        if (snapshot.size > 0 && snapshot.get(0) == ':'.toByte()) {
                                            pushEventToBuffer(SseEvent(SseEventType.HEARTBEAT, null, null, null, "keep-alive"))
                                        }
                                    } catch (e: Exception) {
                                        // Silent catch for interceptor parsing
                                    }
                                }
                                return bytesRead
                            }
                        }).buffer()
                    }
                    response.newBuilder().body(countingBody).build()
                } else {
                    response
                }
            }
            .build()
            
        if (sseHandlerThread == null) {
            sseHandlerThread = android.os.HandlerThread("NitroSseThread").apply { start() }
            sseHandler = Handler(sseHandlerThread!!.looper)
        }
    }

    private fun pushEventToBuffer(event: SseEvent) {
        val batchInterval = config?.batchingIntervalMs ?: 0.0
        val bufferCapacity = config?.maxBufferSize?.toInt() ?: 1000

        synchronized(eventBuffer) {
            while (eventBuffer.size >= bufferCapacity) {
                eventBuffer.removeAt(0)
            }
            eventBuffer.add(event)
        }

        if (batchInterval <= 0) {
            flushBufferToJs()
        } else if (!isFlushPending.getAndSet(true)) {
            sseHandler?.postDelayed({
                flushBufferToJs()
            }, batchInterval.toLong())
        }
    }

    private fun flushBufferToJs() {
        val eventsToEmit: Array<SseEvent>
        synchronized(eventBuffer) {
            if (eventBuffer.isEmpty()) {
                isFlushPending.set(false)
                return
            }
            eventsToEmit = eventBuffer.toTypedArray()
            eventBuffer.clear()
        }
        isFlushPending.set(false)
        onEventsCallback?.invoke(eventsToEmit)
    }

    override fun setLastProcessedId(id: String) {
        this.lastProcessedId = id
    }

    override fun updateHeaders(headers: Map<String, String>) {
        this.config?.let {
            this.config = it.copy(headers = headers)
            Log.d(TAG, "Headers updated for subsequent connections")
        }
    }

    override fun getStats(): SseStats {
        return SseStats(
            totalBytesReceived.get().toDouble(),
            reconnectCount.toDouble(),
            lastErrorTime,
            lastErrorCode
        )
    }

    override fun start() {
        if (config == null) return
        isRunning.set(true)
        backoffCounter = 0
        sseHandler?.post { performConnection() }
    }

    private fun performConnection() {
        if (!isRunning.get()) return
        
        val requestBuilder = Request.Builder()
            .url(config!!.url)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
        
        lastProcessedId?.let { 
            if (it.isNotEmpty()) requestBuilder.header("Last-Event-ID", it) 
        }

        config!!.headers?.forEach { (k, v) -> requestBuilder.header(k, v) }

        if (config!!.method == HttpMethod.POST) {
            val body = config!!.body?.toRequestBody("application/json".toMediaType()) ?: "".toRequestBody()
            requestBuilder.post(body)
        }

        eventSource = EventSources.createFactory(client!!).newEventSource(requestBuilder.build(), sseListener)
    }

    private fun extractRetryAfterMillis(response: Response?): Long? {
        val header = response?.header("Retry-After") ?: return null
        return try {
            header.toLong() * 1000L
        } catch (e: NumberFormatException) {
            response.headers.getDate("Retry-After")?.let {
                val diff = it.time - System.currentTimeMillis()
                if (diff > 0) diff else null
            }
        }
    }

    private val sseListener = object : EventSourceListener() {
        override fun onOpen(eventSource: EventSource, response: Response) {
            backoffCounter = 0
            pushEventToBuffer(SseEvent(SseEventType.OPEN, null, null, null, null))
        }

        override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
            pushEventToBuffer(SseEvent(SseEventType.MESSAGE, data, id, type, null))
        }

        override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
            Log.e(TAG, "SSE Failure: ${t?.message}, Code: ${response?.code}")
            if (!isRunning.get()) return
            
            val statusCode = response?.code ?: -1
            reconnectCount++
            lastErrorTime = System.currentTimeMillis().toDouble()
            lastErrorCode = t?.javaClass?.simpleName ?: statusCode.toString()

            val isFatal = (statusCode == 401 || statusCode == 403 || statusCode == 400)
            if (isFatal) {
                pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "Fatal Error ($statusCode). Stopping."))
                stop()
                return
            }

            val retryAfterMillis = extractRetryAfterMillis(response)
            if ((statusCode == 429 || statusCode == 503) && retryAfterMillis != null) {
                val jitter = (500 + Random.nextInt(1500)).toLong()
                val totalDelay = retryAfterMillis + jitter
                pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "Retry-After received: ${totalDelay/1000}s"))
                sseHandler?.postDelayed({ if (isRunning.get()) performConnection() }, totalDelay)
                return
            }

            if (statusCode == 429) {
                pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "Rate Limited (429) without Retry-After. Stopping."))
                stop()
                return
            }

            val isHandshakeError = response == null || response.code != 200
            val reconnectDelay = if (isHandshakeError) {
                val base = Math.min(baseBackoffDelayMs * (1 shl backoffCounter), maxBackoffDelayMs)
                backoffCounter++
                (base * (0.5 + Random.nextDouble())).toLong()
            } else {
                (defaultRetryDelayMs * (0.8 + Random.nextDouble() * 0.4)).toLong()
            }

            val safeReconnectDelay = Math.max(reconnectDelay, 2000L)
            pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, t?.message ?: "Link lost ($statusCode)"))
            sseHandler?.postDelayed({ if (isRunning.get()) performConnection() }, safeReconnectDelay)
        }

        override fun onClosed(eventSource: EventSource) {
            if (isRunning.get()) {
                val delay = (defaultRetryDelayMs * (0.8 + Random.nextDouble() * 0.4)).toLong()
                sseHandler?.postDelayed({ if (isRunning.get()) performConnection() }, delay)
            }
        }
    }

    override fun stop() {
        isRunning.set(false)
        backoffCounter = 0 
        sseHandler?.removeCallbacksAndMessages(null)
        eventSource?.cancel()
        eventSource = null
        synchronized(eventBuffer) {
            eventBuffer.clear()
        }
    }
}
