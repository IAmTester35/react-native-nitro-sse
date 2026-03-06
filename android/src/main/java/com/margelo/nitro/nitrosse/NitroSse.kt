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
import okio.*
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.UUID
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
 * 5. Lifecycle Management: Implements the Hibernation pattern. When the app enters the background,
 *    we stop the stream to save battery. It automatically resumes when returning to foreground.
 */
@DoNotStrip
class NitroSse : HybridNitroSseSpec(), DefaultLifecycleObserver {
    @Volatile private var client: OkHttpClient? = null
    @Volatile private var eventSource: EventSource? = null
    @Volatile private var config: SseConfig? = null
    @Volatile private var requestId: String? = null
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
    
    private var hasSubscribedToLifecycle = false

    private val defaultRetryDelayMs = 2000L
    private val baseBackoffDelayMs = 1000L
    private val maxBackoffDelayMs = 30000L

    companion object {
        private const val TAG = "NitroSse"
    }

    override fun setup(config: SseConfig, onEvent: (events: Array<SseEvent>) -> Unit) {
        this.config = config
        this.onEventsCallback = onEvent
        
        if (this.client == null) {
            this.client = OkHttpClient.Builder()
                .connectTimeout((config.connectionTimeoutMs ?: 15000.0).toLong(), TimeUnit.MILLISECONDS)
                .readTimeout((config.readTimeoutMs ?: 35000.0).toLong(), TimeUnit.MILLISECONDS)
                .addNetworkInterceptor { chain ->
                    val request = chain.request()
                    val rid = request.tag(String::class.java)
                    
                    val response = chain.proceed(request)
                    
                    rid?.let { 
                        NetworkInspector.reportResponseStart(it, request, response)
                    }
                    
                    val responseBody = response.body
                    if (responseBody != null) {
                        val countingBody = object : ResponseBody() {
                            override fun contentType() = responseBody.contentType()
                            override fun contentLength() = responseBody.contentLength()
                            override fun source() = (object : okio.ForwardingSource(responseBody.source()) {
                                private var isAtStartOfLine = true

                                override fun read(sink: okio.Buffer, byteCount: Long): Long {
                                    val bufferOffset = sink.size
                                    val bytesRead = super.read(sink, byteCount)
                                    if (bytesRead != -1L) {
                                        totalBytesReceived.addAndGet(bytesRead)
                                        

                                        try {
                                            for (i in 0 until bytesRead) {
                                                val b = sink.get(bufferOffset + i)
                                                if (isAtStartOfLine && b == ':'.code.toByte()) {
                                                    // This is a comment/heartbeat.
                                                    // For simplicity, we just notify that a heartbeat occurred.
                                                    // In a more complex impl, we would buffer until \n to get the full comment.
                                                    pushEventToBuffer(SseEvent(SseEventType.HEARTBEAT, null, null, null, "keep-alive", null, null))
                                                }
                                                isAtStartOfLine = (b == '\n'.code.toByte() || b == '\r'.code.toByte())
                                            }
                                        } catch (e: Exception) {
                                            // Silent
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
        }
            
        if (sseHandlerThread == null) {
            sseHandlerThread = android.os.HandlerThread("NitroSseThread").apply { start() }
            sseHandler = Handler(sseHandlerThread!!.looper)
        }

        if (!hasSubscribedToLifecycle) {
            Handler(Looper.getMainLooper()).post {
                ProcessLifecycleOwner.get().lifecycle.addObserver(this)
                hasSubscribedToLifecycle = true
            }
        }
    }

    override fun onStart(owner: LifecycleOwner) {
        if (wasRunningBeforePaused) {
            Log.d(TAG, "App foregrounded. Resuming NitroSse stream.")
            wasRunningBeforePaused = false
            start()
        }
    }

    override fun onStop(owner: LifecycleOwner) {
        if (isRunning.get()) {
            Log.d(TAG, "App backgrounded. Hibernating NitroSse connection.")
            wasRunningBeforePaused = true
            stop()
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
        synchronized(this) {
            this.config?.let {
                this.config = it.copy(headers = headers)
                Log.d(TAG, "Headers updated for subsequent connections")
            }
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
        if (config == null || isRunning.get()) return
        isRunning.set(true)
        backoffCounter = 0
        requestId = null
        sseHandler?.post { performConnection() }
    }

    private fun performConnection() {
        val currentConfig: SseConfig
        val currentLastId: String?
        synchronized(this) {
            if (!isRunning.get() || config == null) return
            currentConfig = config!!
            currentLastId = lastProcessedId
        }
        
        // Report end for previous request if it was running
        requestId?.let { 
            NetworkInspector.reportResponseEnd(it, totalBytesReceived.getAndSet(0))
            this.requestId = null
        }
        
        // Cancel existing event source if any before starting new one
        eventSource?.cancel()
        eventSource = null
        
        val newRequestId = UUID.randomUUID().toString()
        this.requestId = newRequestId
        
        val requestBuilder = Request.Builder()
            .url(currentConfig.url)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
        
        currentLastId?.let { 
            if (it.isNotEmpty()) requestBuilder.header("Last-Event-ID", it) 
        }

        currentConfig.headers?.forEach { (k, v) -> requestBuilder.header(k, v) }

        if (currentConfig.method == HttpMethod.POST) {
            val body = currentConfig.body?.toRequestBody("application/json".toMediaType()) ?: "".toRequestBody()
            requestBuilder.post(body)
        }

        requestBuilder.tag(String::class.java, newRequestId)
        val request = requestBuilder.build()
        NetworkInspector.reportRequestStart(newRequestId, request)
        
        eventSource = EventSources.createFactory(client!!).newEventSource(request, sseListener)
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
            backoffCounter = 0
            pushEventToBuffer(SseEvent(SseEventType.OPEN, null, null, null, null, response.code.toDouble(), null))
        }

        override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
            if (eventSource != this@NitroSse.eventSource) return
            if (!id.isNullOrEmpty()) {
                this@NitroSse.lastProcessedId = id
            }
            pushEventToBuffer(SseEvent(SseEventType.MESSAGE, data, id, type, null, 200.0, null))
        }

        override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
            if (eventSource != this@NitroSse.eventSource) return
            Log.e(TAG, "SSE Failure: ${t?.message}, Code: ${response?.code}")
            if (!isRunning.get()) return
            
            val statusCode = response?.code ?: -1
            reconnectCount++
            lastErrorTime = System.currentTimeMillis().toDouble()
            lastErrorCode = t?.javaClass?.simpleName ?: statusCode.toString()
            
            requestId?.let { NetworkInspector.reportRequestFailed(it, false) }

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
                sseHandler?.postDelayed({ if (isRunning.get() && eventSource == this@NitroSse.eventSource) performConnection() }, totalDelay)
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
            
            if (statusCode == 204) {
                pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "No Content (204). Stopping.", 204.0, null))
                stop()
                return
            }

            pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, t?.message ?: "Link lost ($statusCode)", if (statusCode != -1) statusCode.toDouble() else null, null))
            sseHandler?.postDelayed({ if (isRunning.get() && eventSource == this@NitroSse.eventSource) performConnection() }, safeReconnectDelay)
        }

        override fun onClosed(eventSource: EventSource) {
            if (eventSource != this@NitroSse.eventSource) return
            if (isRunning.get()) {
                requestId?.let { NetworkInspector.reportResponseEnd(it, totalBytesReceived.get()) }
                val delay = (defaultRetryDelayMs * (0.8 + Random.nextDouble() * 0.4)).toLong()
                sseHandler?.postDelayed({ if (isRunning.get() && eventSource == this@NitroSse.eventSource) performConnection() }, delay)
            }
        }
    }

    override fun flush() {
        flushBufferToJs()
    }

    override fun restart() {
        stop()
        start()
    }

    override fun isConnected(): Boolean {
        return isRunning.get()
    }

    override fun stop() {
        isRunning.set(false)
        backoffCounter = 0 
        sseHandler?.removeCallbacksAndMessages(null)
        eventSource?.cancel()
        eventSource = null
        requestId?.let { 
            NetworkInspector.reportResponseEnd(it, totalBytesReceived.get())
            requestId = null
        }
        synchronized(eventBuffer) {
            eventBuffer.clear()
        }
        isFlushPending.set(false)
    }

    override fun dispose() {
        Log.d(TAG, "Disposing NitroSse instance and cleaning up resources...")
        stop()
        if (hasSubscribedToLifecycle) {
            Handler(Looper.getMainLooper()).post {
                ProcessLifecycleOwner.get().lifecycle.removeObserver(this@NitroSse)
            }
            hasSubscribedToLifecycle = false
        }
        sseHandlerThread?.quitSafely()
        sseHandlerThread = null
        sseHandler = null
        super.dispose()
    }
}
