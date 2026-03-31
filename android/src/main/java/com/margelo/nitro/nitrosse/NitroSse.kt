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
import java.util.concurrent.atomic.AtomicInteger
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
    private val consecutiveAuthErrors = AtomicInteger(0)
    private val maxAuthRetries = 3
    private var sseHandlerThread: android.os.HandlerThread? = null
    private var sseHandler: Handler? = null
    
    private val eventBuffer = mutableListOf<SseEvent>()
    private var isFlushPending = AtomicBoolean(false)
    
    private var backoffCounter = 0
    private var currentReconnectAttempts = 0
    @Volatile private var lastProcessedId: String? = null
    
    private val totalBytesReceived = AtomicLong(0)
    private val connectionAttemptVersion = AtomicInteger(0)
    private var reconnectCount = 0
    private var lastErrorTime: Double? = null
    private var lastErrorCode: String? = null
    
    private var hasSubscribedToLifecycle = false

    companion object {
        private const val TAG = "NitroSse"
    }

    /**
     * Set up the NitroSse instance with configuration and an event callback.
     * This prepares the OkHttpClient and internal handler threads.
     *
     * @param config The SSE configuration containing URL, headers, and more.
     * @param onEvent Callback function to receive batched SSE events.
     */
    override fun setup(config: SseConfig, onEvent: (events: Array<SseEvent>) -> Unit) {
        this.config = config
        this.onEventsCallback = onEvent
        
        if (this.client == null) {
            this.client = OkHttpClient.Builder()
                .connectTimeout((config.connectionTimeoutMs ?: 15000.0).toLong(), TimeUnit.MILLISECONDS)
                .readTimeout((config.readTimeoutMs ?: 300000.0).toLong(), TimeUnit.MILLISECONDS)
                                .addNetworkInterceptor(HeartbeatNetworkInterceptor(totalBytesReceived) {
                                    pushEventToBuffer(SseEvent(SseEventType.HEARTBEAT, null, null, null, "keep-alive", null, null))
                                })
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

    /**
     * Called when the app enters the foreground.
     * Automatically resumes the stream if it was hibernated.
     */
    override fun onStart(owner: LifecycleOwner) {
        if (wasRunningBeforePaused) {
            Log.d(TAG, "App foregrounded. Resuming NitroSse stream.")
            wasRunningBeforePaused = false
            start()
        }
    }

    /**
     * Called when the app enters the background.
     * Hibernates the connection to save battery and resources.
     */
    override fun onStop(owner: LifecycleOwner) {
        if (isRunning.get()) {
            if (config?.backgroundExecution == true) {
                Log.d(TAG, "App backgrounded. backgroundExecution is true, keeping NitroSse connection alive.")
                return
            }
            Log.d(TAG, "App backgrounded. Hibernating NitroSse connection.")
            wasRunningBeforePaused = true
            stop()
        }
    }

    private fun pushEventToBuffer(event: SseEvent) {
        val batchInterval = config?.batchingIntervalMs ?: 0.0
        val bufferCapacity = config?.maxBufferSize?.toInt() ?: 1000

        var shouldFlush = false
        synchronized(eventBuffer) {
            eventBuffer.add(event)
            if (eventBuffer.size >= bufferCapacity) {
                shouldFlush = true
            }
        }

        if (batchInterval <= 0 || shouldFlush) {
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

    /**
     * Manually set the last seen event ID. 
     * This will be used as the 'Last-Event-ID' header on the next connection attempt.
     */
    override fun setLastProcessedId(id: String) {
        this.lastProcessedId = id
    }

    /**
     * Dynamically update the headers for subsequent connection attempts.
     */
    override fun updateHeaders(headers: Map<String, String>) {
        synchronized(this) {
            this.config?.let {
                this.config = it.copy(headers = headers)
                Log.d(TAG, "Headers updated manually")
            }
        }
    }

    /**
     * Returns runtime statistics about the SSE connection.
     */
    override fun getStats(): SseStats {
        // getStats is called from JS thread, so we should sync with sseHandler thread
        // or coordinate carefully. Since we need to return immediately, 
        // using the state as-is is okay IF all updates happen on a single thread 
        // and we use synchronized or @Volatile.
        synchronized(this) {
            return SseStats(
                totalBytesReceived.get().toDouble(),
                reconnectCount.toDouble(),
                lastErrorTime,
                lastErrorCode
            )
        }
    }

    /**
     * Start the SSE connection.
     * This triggers the initial request and handles subsequent reconnections.
     */
    override fun start() {
        if (config == null) return
        if (!isRunning.compareAndSet(false, true)) return
        
        consecutiveAuthErrors.set(0)
        val version = connectionAttemptVersion.incrementAndGet()
        sseHandler?.post { 
            backoffCounter = 0
            requestId = null
            performConnection(version) 
        }
    }

    private fun performConnection(version: Int) {
        if (!isRunning.get() || version != connectionAttemptVersion.get()) return
        
        val currentConfig = synchronized(this) { config } ?: return
        val interceptor = currentConfig.onBeforeRequest
        
        if (interceptor != null) {
            val interceptorCompleted = AtomicBoolean(false)
            val timeoutMs = (currentConfig.connectionTimeoutMs ?: 15000.0).toLong()

            sseHandler?.postDelayed({
                if (interceptorCompleted.compareAndSet(false, true)) {
                    handleInterceptorError(Exception("onBeforeRequest interceptor timed out after $timeoutMs ms"), version)
                }
            }, timeoutMs)

            interceptor.invoke().then { promise2 ->
                promise2.then { newHeaders ->
                    sseHandler?.post {
                        if (!isRunning.get() || version != connectionAttemptVersion.get()) return@post
                        if (interceptorCompleted.compareAndSet(false, true)) {
                            synchronized(this) {
                                val mergedHeaders = (config?.headers ?: emptyMap()).toMutableMap()
                                newHeaders.forEach { (k, v) -> mergedHeaders[k] = v }
                                config = config?.copy(headers = mergedHeaders)
                            }
                            executeConnection(version)
                        }
                    }
                }.catch { error ->
                    if (interceptorCompleted.compareAndSet(false, true)) {
                        handleInterceptorError(error, version)
                    }
                }
            }.catch { error ->
                if (interceptorCompleted.compareAndSet(false, true)) {
                    handleInterceptorError(error, version)
                }
            }
        } else {
            executeConnection(version)
        }
    }

    private fun handleInterceptorError(t: Throwable?, version: Int) {
        sseHandler?.post {
            if (!isRunning.get() || version != connectionAttemptVersion.get()) return@post
            Log.e(TAG, "Request Interceptor Error: ${t?.message}")
            pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "Interceptor Error: ${t?.message}", -1.0, null))
            
            // Reconnect with delay
            val currentJitterFactor = config?.jitterFactor ?: 0.5
            val currentRetryInterval = (config?.retryIntervalMs ?: 1000.0).toLong()
            val delay = (currentRetryInterval * (1.0 - currentJitterFactor + Random.nextDouble() * 2 * currentJitterFactor)).toLong()
            sseHandler?.postDelayed({ if (isRunning.get()) performConnection(version) }, delay)
        }
    }

    private fun executeConnection(version: Int) {
        val currentConfig: SseConfig
        val currentLastId: String?
        synchronized(this) {
            if (!isRunning.get() || config == null || version != connectionAttemptVersion.get()) return
            currentConfig = config!!
            currentLastId = lastProcessedId
        }
        
        // Report end for previous request if it was running
        requestId?.let { 
            NetworkInspector.reportResponseEnd(it, totalBytesReceived.get())
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
        override fun onOpen(eventSource: EventSource, response: Response) {
            sseHandler?.post {
                if (eventSource != this@NitroSse.eventSource) return@post
                consecutiveAuthErrors.set(0)
                backoffCounter = 0
                currentReconnectAttempts = 0
                synchronized(this@NitroSse) {
                    pushEventToBuffer(SseEvent(SseEventType.OPEN, null, null, null, null, response.code.toDouble(), null))
                }
            }
        }

        override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
            sseHandler?.post {
                if (eventSource != this@NitroSse.eventSource) return@post
                if (!id.isNullOrEmpty()) {
                    this@NitroSse.lastProcessedId = id
                }
                synchronized(this@NitroSse) {
                    pushEventToBuffer(SseEvent(SseEventType.MESSAGE, data, id, type, null, 200.0, null))
                }
            }
        }

        override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
            sseHandler?.post {
                if (eventSource != this@NitroSse.eventSource) return@post
                Log.e(TAG, "SSE Failure: ${t?.message}, Code: ${response?.code}")
                if (!isRunning.get()) return@post
                
                val statusCode = response?.code ?: -1
                
                synchronized(this@NitroSse) {
                    reconnectCount++
                    lastErrorTime = System.currentTimeMillis().toDouble()
                    lastErrorCode = t?.javaClass?.simpleName ?: statusCode.toString()
                }
                
                requestId?.let { 
                    NetworkInspector.reportRequestFailed(it, false)
                    this@NitroSse.requestId = null
                }

                if (statusCode == 401 || statusCode == 403) {
                    val currentConfig = synchronized(this@NitroSse) { config }
                    if (currentConfig?.onBeforeRequest == null) {
                        pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "Auth Error ($statusCode) - No interceptor provided. Stopping.", statusCode.toDouble(), null))
                        stop()
                        return@post
                    }

                    val retries = consecutiveAuthErrors.incrementAndGet()
                    if (retries >= maxAuthRetries) {
                        pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "Auth Error ($statusCode) - Retry limit reached ($maxAuthRetries). Stopping.", statusCode.toDouble(), null))
                        stop()
                        return@post
                    }
                    
                    pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "Auth Error ($statusCode) - Retry $retries/$maxAuthRetries. Refreshing token...", statusCode.toDouble(), null))
                    scheduleReconnect(true)
                    return@post
                }

                if (statusCode == 400) {
                    pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "Fatal Error ($statusCode). Stopping.", statusCode.toDouble(), null))
                    stop()
                    return@post
                }

                val retryAfterMillis = extractRetryAfterMillis(response)
                if ((statusCode == 429 || statusCode == 503) && retryAfterMillis != null) {
                    val jitter = (500 + Random.nextInt(1500)).toLong()
                    val totalDelay = retryAfterMillis + jitter
                    pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "Retry-After received: ${totalDelay/1000}s", statusCode.toDouble(), totalDelay.toDouble()))
                    sseHandler?.postDelayed({ 
                        if (isRunning.get() && eventSource == this@NitroSse.eventSource) performConnection(connectionAttemptVersion.get()) 
                    }, totalDelay)
                    return@post
                }

                if (statusCode == 429) {
                    pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "Rate Limited (429) without Retry-After. Stopping.", 429.0, null))
                    stop()
                    return@post
                }

                if (statusCode == 204) {
                    pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "No Content (204). Stopping.", 204.0, null))
                    stop()
                    return@post
                }

                pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, t?.message ?: "Link lost ($statusCode)", if (statusCode != -1) statusCode.toDouble() else null, null))
                scheduleReconnect(true)
            }
        }

        override fun onClosed(eventSource: EventSource) {
            sseHandler?.post {
                if (eventSource != this@NitroSse.eventSource) return@post
                if (isRunning.get()) {
                    requestId?.let { 
                        NetworkInspector.reportResponseEnd(it, totalBytesReceived.get())
                        this@NitroSse.requestId = null
                    }
                    scheduleReconnect(false)
                }
            }
        }

        private fun scheduleReconnect(isError: Boolean) {
            val currentConfig = synchronized(this@NitroSse) { config } ?: return
            val currentJitterFactor = currentConfig.jitterFactor ?: 0.5
            val currentRetryInterval = (currentConfig.retryIntervalMs ?: 1000.0).toLong()
            val currentMaxRetryInterval = (currentConfig.maxRetryIntervalMs ?: 30000.0).toLong()

            val maxAttempts = (currentConfig.maxReconnectAttempts ?: -1.0).toInt()
            if (maxAttempts != -1 && currentReconnectAttempts >= maxAttempts) {
                Log.d(TAG, "Max reconnection attempts reached ($maxAttempts). Stopping.")
                pushEventToBuffer(SseEvent(SseEventType.ERROR, null, null, null, "Max reconnection attempts reached ($maxAttempts).", null, null))
                stop()
                return
            }

            val reconnectDelay = if (isError) {
                val base = Math.min(currentRetryInterval * (1 shl backoffCounter), currentMaxRetryInterval)
                backoffCounter++
                (base * (1.0 - currentJitterFactor + Random.nextDouble() * 2 * currentJitterFactor)).toLong()
            } else {
                (currentRetryInterval * (1.0 - currentJitterFactor + Random.nextDouble() * 2 * currentJitterFactor)).toLong()
            }

            currentReconnectAttempts++
            val safeReconnectDelay = Math.max(reconnectDelay, 1000L)
            sseHandler?.postDelayed({ 
                if (isRunning.get()) performConnection(connectionAttemptVersion.get()) 
            }, safeReconnectDelay)
        }
    }

    /**
     * Immediately emit any pending buffered events to the JS bridge.
     */
    override fun flush() {
        flushBufferToJs()
    }

    /**
     * Restart the SSE connection by stopping and starting again.
     */
    override fun restart() {
        stop()
        start()
    }

    /**
     * Indicates if the SSE connection is currently active or trying to connect.
     */
    override fun isConnected(): Boolean {
        return isRunning.get()
    }

    /**
     * Stop the SSE connection and clear any pending reconnect timers.
     */
    override fun stop() {
        isRunning.set(false)
        val version = connectionAttemptVersion.incrementAndGet() 
        sseHandler?.post {
            flushBufferToJs()
            backoffCounter = 0 
            sseHandler?.removeCallbacksAndMessages(null)
            eventSource?.cancel()
            eventSource = null
            requestId?.let { 
                NetworkInspector.reportResponseEnd(it, totalBytesReceived.get())
                requestId = null
            }
            isFlushPending.set(false)
        }
    }

    /**
     * Clean up all resources, including background threads and lifecycle observers.
     * This is called by Nitro when the HybridObject is being garbage collected or JS reloads.
     */
    override fun dispose() {
        Log.d(TAG, "Disposing NitroSse instance and cleaning up resources...")
 
        isRunning.set(false)
        connectionAttemptVersion.incrementAndGet()
        
        try {
            eventSource?.cancel()
            eventSource = null
            requestId?.let { 
                NetworkInspector.reportRequestFailed(it, true) 
                requestId = null
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error during synchronous dispose: ${e.message}")
        }

        if (hasSubscribedToLifecycle) {
            Handler(Looper.getMainLooper()).post {
                ProcessLifecycleOwner.get().lifecycle.removeObserver(this@NitroSse)
            }
            hasSubscribedToLifecycle = false
        }
        
        sseHandler?.removeCallbacksAndMessages(null)
        sseHandlerThread?.quitSafely()
        sseHandlerThread = null
        sseHandler = null
        
        super.dispose()
    }
}

/**
 * Separates the network interception logic (counting bytes, intercepting SSE heartbeats) 
 * from the main NitroSse connection manager.
 */
internal class HeartbeatNetworkInterceptor(
    private val totalBytesReceived: AtomicLong,
    private val onHeartbeat: () -> Unit
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
                                        onHeartbeat()
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
            return response.newBuilder().body(countingBody).build()
        }
        return response
    }
}
