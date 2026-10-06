package com.margelo.nitro.nitrosse

import android.os.Handler
import android.util.Log
import com.facebook.proguard.annotations.DoNotStrip
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okio.utf8Size
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicInteger
import java.util.UUID
import kotlin.random.Random
import android.net.NetworkCapabilities

/**
 * Core Android implementation of [HybridNitroSseSpec] managing Server-Sent Events (SSE).
 *
 * Coordinates OkHttp SSE connection state, exponential backoff retries, event buffering,
 * network interface transitions, and Android app lifecycle hibernation. Uses a single-threaded
 * background [SseDispatcher] to ensure thread-safe state mutations and avoid blocking the JS UI thread.
 */
@DoNotStrip
class NitroSse @DoNotStrip constructor() : HybridNitroSseSpec(), SseConnectionDelegate {

    // Secondary constructor for unit testing to inject virtual-time dispatchers without spawning HandlerThreads
    internal constructor(dispatcher: SseDispatcher) : this() {
        this.sseDispatcher = dispatcher
    }
    @Volatile
    private var client: OkHttpClient? = null
    private var eventSource: SseEventSource? = null
    private var config: SseConfig? = null
    // Marked @Volatile to guarantee cross-thread memory visibility between calling thread stop()/dispose()
    // and sseDispatcher/OkHttp callback execution threads without stale reads.
    @Volatile
    private var requestId: String? = null
    
    private val isRunning = AtomicBoolean(false)
    /**
     * Indicates whether the underlying React Native JS Dispatcher/CallInvoker has been destroyed
     * (e.g. during Fast Refresh, bundle reload, or host teardown).
     * Marked @Volatile to guarantee cross-thread memory visibility between sseDispatcher background
     * thread, network callbacks, and JS/Main threads without stale CPU cache reads.
     */
    @Volatile
    private var isDispatcherDestroyed = false
    private var wasRunningBeforePaused = false
    private val consecutiveAuthErrors = AtomicInteger(0)
    
    private var sseDispatcherThread: android.os.HandlerThread? = null
    internal var sseDispatcher: SseDispatcher? = null
    
    // Transport Metrics
    private var rawBytesReceived: Double = 0.0
    private var decompressedBytesReceived: Double? = null
    private var sessionRawBytesOffset: Double = 0.0
    private val totalBytesReceived = AtomicLong(0)
    private var chunksReceived: Double = 0.0
    private var lastStatusCode: Double? = null

    // Parser Metrics
    private var totalEventsReceived: Double = 0.0
    private var commentsReceived: Double = 0.0
    private var linesParsed: Double = 0.0
    private var parseErrors: Double = 0.0
    private var serverRetryDelayMs: Double? = null

    // Latency & Timing Metrics
    private var connectedAt: Double? = null
    private var connectionAttemptStartTime: Double? = null
    private var timeToFirstByteMs: Double? = null
    private var lastEventTime: Double? = null
    private var lastHeartbeatTime: Double? = null
    private var lastActivityTime: Double = 0.0
    private var maxEventGapMs: Double = 0.0

    // Lifecycle & Reconnect Metrics
    private var connectionAttempts: Double = 0.0
    private var reconnectCount: Double = 0.0
    private var lastReconnectDelayMs: Double? = null
    private var disconnectReason: SseDisconnectReason? = null
    private var lastErrorTime: Double? = null
    private var lastErrorCode: String? = null

    private val connectionAttemptVersion = AtomicInteger(0)
    private var lastProcessedId: String? = null
    private var currentState = java.util.concurrent.atomic.AtomicReference(SseState.IDLE)
    private var wasRunningBeforeNetworkLoss = false
    private var interceptorTimeoutRunnable: Runnable? = null
    private val isDisposed = AtomicBoolean(false)
    /// Dynamic request interceptor decoupled from SseConfig (v3.0)
    private var requestInterceptor: (() -> Promise<Promise<Map<String, String>>>)? = null

    private lateinit var eventBuffer: SseEventBuffer
    private val reconnectStrategy = SseReconnectStrategy()
    private var networkMonitor: SseNetworkMonitor? = null
    private var lifecycleManager: SseLifecycleManager? = null
    private val connectionHandler = SseConnectionHandler(this)
    private val mainDispatcher = AndroidSseDispatcher(Handler(android.os.Looper.getMainLooper()))

    companion object {
        private const val TAG = "NitroSse"
        private const val DEFAULT_MAX_AUTH_RETRIES = 3
    }

    override fun setup(
        config: SseConfig,
        onEvent: (events: Array<SseEvent>) -> Unit,
        onBeforeRequest: (() -> Promise<Promise<Map<String, String>>>)?
    ) {
        synchronized(this) {
            this.config = config
            this.requestInterceptor = onBeforeRequest
            this.rawBytesReceived = 0.0
            this.decompressedBytesReceived = null
            this.sessionRawBytesOffset = 0.0
            if (this.lastProcessedId == null) {
                this.lastProcessedId = config.headers?.entries?.firstOrNull { 
                    it.key.equals("Last-Event-ID", ignoreCase = true) 
                }?.value
            }
            
            if (sseDispatcher == null) {
                sseDispatcherThread = android.os.HandlerThread("NitroSseThread").apply { start() }
                sseDispatcher = AndroidSseDispatcher(Handler(sseDispatcherThread!!.looper))
            }

            if (!::eventBuffer.isInitialized) {
                eventBuffer = SseEventBuffer(onEvent, sseDispatcher)
                eventBuffer.onFlushError = { e -> handleRuntimeOrFlushError(e) }
            } else {
                eventBuffer.setCallback(onEvent)
            }
            eventBuffer.configure(config.batchingIntervalMs ?: 0.0, config.maxBufferSize?.toInt() ?: 1000)

            // Custom backoff guarantees cross-platform parity and lifecycle coordination.
            reconnectStrategy.configure(
                config.retryIntervalMs ?: 1000.0,
                config.maxRetryIntervalMs ?: 30000.0,
                config.jitterFactor ?: 0.5,
                (config.maxReconnectAttempts ?: -1.0).toInt()
            )

            if (this.client == null) {
                val builder = OkHttpClient.Builder()
                    .connectTimeout((config.connectionTimeoutMs ?: 15000.0).toLong(), TimeUnit.MILLISECONDS)
                    .readTimeout((config.readTimeoutMs ?: 300000.0).toLong(), TimeUnit.MILLISECONDS)
                    // Enables transparent socket-level retry on route failures (multiple IP fallback, transient resets)
                    // before bubbling up to full SSE stream reconnect.
                    .retryOnConnectionFailure(true)
                    .addNetworkInterceptor(InspectorNetworkInterceptor())
                this.client = builder.build()
            } else {
                this.client = this.client!!.newBuilder()
                    .connectTimeout((config.connectionTimeoutMs ?: 15000.0).toLong(), TimeUnit.MILLISECONDS)
                    .readTimeout((config.readTimeoutMs ?: 300000.0).toLong(), TimeUnit.MILLISECONDS)
                    .retryOnConnectionFailure(true)
                    .build()
            }
            
            if (lifecycleManager == null) {
                lifecycleManager = SseLifecycleManager(
                    lifecycleProvider = { androidx.lifecycle.ProcessLifecycleOwner.get().lifecycle },
                    mainDispatcher = mainDispatcher,
                    sseDispatcher = sseDispatcher!!,
                    onBackground = { handleAppBackground() },
                    onForeground = { handleAppForeground() }
                )
                lifecycleManager?.startObserving()
            }
            if (config.monitorNetwork != false) {
                sseDispatcher?.post {
                    startNetworkMonitoring()
                }
            } else {
                sseDispatcher?.post {
                    networkMonitor?.stop()
                    networkMonitor = null
                }
            }
        }
    }

    /**
     * Convenience overload for setup without onBeforeRequest.
     */
    fun setup(config: SseConfig, onEvent: (events: Array<SseEvent>) -> Unit) {
        setup(config, onEvent, null)
    }

    private fun startNetworkMonitoring() {
        val context = NitroModules.applicationContext ?: return
        if (networkMonitor == null) {
            networkMonitor = SseNetworkMonitor(context, sseDispatcher) { isAvailable, interfaceChanged, capabilities ->
                handleNetworkChange(isAvailable, interfaceChanged, capabilities)
            }
        }
        networkMonitor?.start()
    }

    private fun handleNetworkChange(isAvailable: Boolean, interfaceChanged: Boolean, capabilities: NetworkCapabilities?) {
        Log.d(TAG, "Network change: available=$isAvailable, interfaceChanged=$interfaceChanged")
        if (isAvailable && capabilities != null) {
            if (wasRunningBeforeNetworkLoss) {
                Log.d(TAG, "Network restored. Resuming stream.")
                wasRunningBeforeNetworkLoss = false
                if (lifecycleManager?.isAppInBackground == true && config?.backgroundExecution != true) {
                    wasRunningBeforePaused = true
                } else {
                    start()
                }
            } else if (isRunning.get() && interfaceChanged) {
                Log.d(TAG, "Network interface changed. Restarting stream.")
                restart()
            }
        } else if (!isAvailable) {
            if (isRunning.get()) {
                Log.d(TAG, "Network lost. Hibernating.")
                wasRunningBeforeNetworkLoss = true
                updateState(SseState.PAUSED)
                isRunning.set(false)
                connectionAttemptVersion.incrementAndGet()
                performInternalCleanup()
            }
        }
    }

    private fun handleAppForeground() {
        if (wasRunningBeforePaused) {
            Log.d(TAG, "App foregrounded. Resuming NitroSse stream.")
            wasRunningBeforePaused = false
            start()
        }
    }

    private fun handleAppBackground() {
        if (isRunning.get()) {
            if (config?.backgroundExecution == true) {
                Log.d(TAG, "App backgrounded. keeping connection alive.")
                return
            }
            Log.d(TAG, "App backgrounded. Hibernating.")
            wasRunningBeforePaused = true
            updateState(SseState.PAUSED)
            isRunning.set(false)
            connectionAttemptVersion.incrementAndGet()
            performInternalCleanup()
        }
    }

    override fun setLastProcessedId(id: String) {
        synchronized(this) {
            this.lastProcessedId = id
        }
    }

    override fun updateHeaders(headers: Map<String, String>) {
        synchronized(this) {
            this.config?.let {
                val merged = (it.headers ?: emptyMap()) + headers
                this.config = it.copy(headers = merged)
            }
        }
    }

    override fun getStats(): SseStats {
        synchronized(this) {
            val buffered = if (::eventBuffer.isInitialized) eventBuffer.getEventsBuffered().toDouble() else 0.0
            val peak = if (::eventBuffer.isInitialized) eventBuffer.getPeakBufferedEvents().toDouble() else 0.0
            val flushes = if (::eventBuffer.isInitialized) eventBuffer.getBufferFlushCount().toDouble() else 0.0
            val overflows = if (::eventBuffer.isInitialized) eventBuffer.getBufferOverflowCount().toDouble() else 0.0

            return SseStats(
                rawBytesReceived = rawBytesReceived,
                decompressedBytesReceived = decompressedBytesReceived,
                totalBytesReceived = totalBytesReceived.get().toDouble(),
                chunksReceived = chunksReceived,
                lastStatusCode = lastStatusCode,
                totalEventsReceived = totalEventsReceived,
                commentsReceived = commentsReceived,
                linesParsed = linesParsed,
                parseErrors = parseErrors,
                serverRetryDelayMs = serverRetryDelayMs,
                connectedAt = connectedAt,
                timeToFirstByteMs = timeToFirstByteMs,
                lastEventTime = lastEventTime,
                lastHeartbeatTime = lastHeartbeatTime,
                maxEventGapMs = maxEventGapMs,
                eventsBuffered = buffered,
                peakBufferedEvents = peak,
                bufferFlushCount = flushes,
                bufferOverflowCount = overflows,
                connectionAttempts = connectionAttempts,
                reconnectCount = reconnectCount,
                lastReconnectDelayMs = lastReconnectDelayMs,
                disconnectReason = disconnectReason,
                lastErrorTime = lastErrorTime,
                lastErrorCode = lastErrorCode
            )
        }
    }

    override fun getState(): SseState {
        return currentState.get()
    }

    private fun updateState(newState: SseState) {
        val oldState = currentState.getAndSet(newState)
        if (oldState != newState && ::eventBuffer.isInitialized) {
            eventBuffer.push(SseEvent(SseEventType.STATE, null, null, null, null, null, null, null, newState))
            // State events represent immediate connection lifecycle transitions and must be flushed
            // to JS immediately to prevent UI and React hook state desynchronization.
            eventBuffer.flush()
        }
    }

    override fun start() {
        val currentConfig = synchronized(this) { config }
            ?: throw IllegalStateException("NitroSse not configured. Call setup() first.")
        
        if (isRunning.get()) {
            // If client is waiting in backoff reconnect loop, start() acts as an immediate "Retry Now",
            // cancelling pending backoff delay, resetting backoff counter, and attempting connection immediately.
            if (currentState.get() == SseState.RECONNECTING) {
                Log.d(TAG, "start() invoked while reconnecting. Resetting backoff and retrying immediately.")
                consecutiveAuthErrors.set(0)
                val version = connectionAttemptVersion.incrementAndGet()
                updateState(SseState.CONNECTING)
                sseDispatcher?.post {
                    reconnectStrategy.reset()
                    requestId = null
                    performConnection(version)
                }
            }
            return
        }

        if (!isRunning.compareAndSet(false, true)) return
        
        consecutiveAuthErrors.set(0)
        isDispatcherDestroyed = false
        val version = connectionAttemptVersion.incrementAndGet()
        updateState(SseState.CONNECTING)
        sseDispatcher?.post { 
            reconnectStrategy.reset()
            requestId = null
            performConnection(version) 
        }
    }

    private fun performConnection(version: Int) {
        // Discard attempt if state has changed or a newer connection cycle was initiated
        if (!isRunning.get() || version != connectionAttemptVersion.get()) return
        
        val currentConfig = synchronized(this) { config } ?: return
        // Asynchronously await JS onBeforeRequest interceptor before creating EventSource.
        val interceptor = synchronized(this) { requestInterceptor }
        
        if (interceptor != null) {
            val interceptorCompleted = AtomicBoolean(false)
            val timeoutMs = (currentConfig.connectionTimeoutMs ?: 15000.0).toLong()

            val safeHandleError: (Throwable) -> Unit = { error ->
                if (interceptorCompleted.compareAndSet(false, true)) {
                    handleInterceptorError(error, version)
                }
            }

            // Proactively cancel any previous in-flight interceptor timeout runnable
            interceptorTimeoutRunnable?.let { sseDispatcher?.removeCallbacks(it) }
            val timeoutRunnable = Runnable {
                safeHandleError(Exception("onBeforeRequest timed out"))
            }
            interceptorTimeoutRunnable = timeoutRunnable

            // Enforce timeout guard on JS onBeforeRequest promise to prevent connection hangs
            sseDispatcher?.postDelayed(timeoutRunnable, timeoutMs)

            try {
                // Note: Safe-calls (?.) protect against null/unmocked Promise chains in unit tests and JS bridging.
                // Parameter non-null intrinsics and synchronous errors route to catch(e: Throwable) / safeHandleError.
                interceptor.invoke()?.then { promise2 ->
                    promise2?.then { newHeaders ->
                        sseDispatcher?.post {
                            if (!isRunning.get() || version != connectionAttemptVersion.get()) return@post
                            if (interceptorCompleted.compareAndSet(false, true)) {
                                interceptorTimeoutRunnable?.let { sseDispatcher?.removeCallbacks(it) }
                                interceptorTimeoutRunnable = null
                                val connectionConfig = synchronized(this) {
                                    val base = config ?: return@post
                                    val mergedHeaders = (base.headers ?: emptyMap()).toMutableMap()
                                    newHeaders.forEach { (k, v) -> mergedHeaders[k] = v }
                                    base.copy(headers = mergedHeaders)
                                }
                                executeConnection(version, connectionConfig)
                            }
                        }
                    }?.catch { error ->
                        safeHandleError(error)
                    }
                }?.catch { error ->
                    safeHandleError(error)
                }
            } catch (e: Throwable) {
                safeHandleError(e)
            }
        } else {
            executeConnection(version, null)
        }
    }

    private fun handleRuntimeOrFlushError(t: Throwable?) {
        val isDispatcherDestroyedMsg = t?.message?.contains("Dispatcher has already been destroyed", ignoreCase = true) == true
        if (isDispatcherDestroyedMsg) {
            Log.w(TAG, "JS Dispatcher destroyed during event flush. Disposing NitroSse instance.")
            this.isDispatcherDestroyed = true
            dispose()
        }
    }

    private fun handleInterceptorError(t: Throwable?, version: Int) {
        interceptorTimeoutRunnable?.let { sseDispatcher?.removeCallbacks(it) }
        interceptorTimeoutRunnable = null
        sseDispatcher?.post {
            if (!isRunning.get() || version != connectionAttemptVersion.get()) return@post
            
            val isDispatcherDestroyedMsg = t?.message?.contains("Dispatcher has already been destroyed", ignoreCase = true) == true
            if (isDispatcherDestroyedMsg) {
                Log.w(TAG, "JS Dispatcher destroyed during interceptor error. Disposing NitroSse instance.")
                this.isDispatcherDestroyed = true
                dispose()
                return@post
            }
            
            val maxRetries = synchronized(this@NitroSse) { config?.maxAuthRetries?.toInt() ?: DEFAULT_MAX_AUTH_RETRIES }
            val retries = consecutiveAuthErrors.incrementAndGet()
            if (retries > maxRetries) {
                failAndStop("Auth retry limit reached ($maxRetries). Stopping.", -1.0)
                return@post
            }

            eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Interceptor Error: ${t?.message}", -1.0, null, null))
            scheduleReconnect(true, version)
        }
    }

    private fun executeConnection(version: Int, connectionConfig: SseConfig? = null) {
        val currentConfig: SseConfig
        val currentLastId: String?
        val oldRequestId: String?
        val newRequestId = UUID.randomUUID().toString()
        val safeClient: OkHttpClient
        
        synchronized(this) {
            if (!isRunning.get() || config == null || version != connectionAttemptVersion.get()) return
            currentConfig = connectionConfig ?: config!!
            currentLastId = lastProcessedId
            safeClient = client ?: return
            
            oldRequestId = requestId
            if (oldRequestId != null && SseNetworkMetricsTracker.isGzip(oldRequestId)) {
                val raw = SseNetworkMetricsTracker.getRawBytes(oldRequestId)
                if (raw != null) {
                    sessionRawBytesOffset += raw.toDouble()
                }
            }
            requestId = newRequestId
            
            eventSource?.cancel()
            eventSource = null

            connectionAttempts += 1.0
            connectionAttemptStartTime = System.currentTimeMillis().toDouble()
            timeToFirstByteMs = null
        }
        
        oldRequestId?.let {
            NetworkInspector.reportResponseEnd(it, totalBytesReceived.get())
            SseNetworkMetricsTracker.clear(it)
        }
        
        try {
            // Set SSE headers explicitly for Network Inspector visibility and encoding control.
            val requestBuilder = Request.Builder()
                .url(currentConfig.url)
                .header("Accept", "text/event-stream")
                .header("Cache-Control", "no-cache")
            
            // Populate config headers first, filtering out Last-Event-ID and Accept-Encoding
            currentConfig.headers?.forEach { (k, v) -> 
                if (!k.equals("Last-Event-ID", ignoreCase = true) && !k.equals("Accept-Encoding", ignoreCase = true)) {
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
            val request = requestBuilder.build()
            NetworkInspector.reportRequestStart(newRequestId, request)
            
            val newEventSource = connectionHandler.createEventSource(safeClient, request, newRequestId)
            synchronized(this) {
                // Ensure socket is cancelled if stop() or dispose() raced with socket initialization
                if (!isRunning.get() || version != connectionAttemptVersion.get()) {
                    newEventSource.cancel()
                } else {
                    eventSource = newEventSource
                }
            }
        } catch (e: Exception) {
            // Standard Java Exception catch: handles IllegalArgumentException (URL/headers), NullPointerException,
            // and IllegalStateException without catching/suppressing fatal JVM errors (e.g. OutOfMemoryError, VirtualMachineError).
            Log.e(TAG, "Failed to create SSE connection request: ${e.message}", e)
            failAndStop("Invalid connection request: ${e.message}", -1.0)
        }
    }

    override fun connectionDidOpen(response: Response, requestId: String) {
        sseDispatcher?.post {
            if (requestId != this@NitroSse.requestId) return@post
            consecutiveAuthErrors.set(0)
            reconnectStrategy.reset()
            synchronized(this@NitroSse) {
                if (currentState.get() == SseState.RECONNECTING) {
                    reconnectCount += 1.0
                }
                lastStatusCode = response.code.toDouble()
                connectedAt = System.currentTimeMillis().toDouble()
            }
            updateState(SseState.OPEN)
            eventBuffer.push(SseEvent(SseEventType.OPEN, null, null, null, null, null, response.code.toDouble(), null, null))
        }
    }

    override fun connectionDidReceiveDataChunk(decompressedBytes: Long, requestId: String) {
        synchronized(this) {
            if (requestId != this.requestId) return
            chunksReceived += 1.0
            val isGzip = SseNetworkMetricsTracker.isGzip(requestId)
            if (isGzip) {
                decompressedBytesReceived = (decompressedBytesReceived ?: 0.0) + decompressedBytes.toDouble()
                val raw = SseNetworkMetricsTracker.getRawBytes(requestId)
                rawBytesReceived = sessionRawBytesOffset + (raw?.toDouble() ?: decompressedBytes.toDouble())
            } else {
                rawBytesReceived += decompressedBytes.toDouble()
            }
            if (timeToFirstByteMs == null && connectionAttemptStartTime != null) {
                timeToFirstByteMs = System.currentTimeMillis().toDouble() - connectionAttemptStartTime!!
            }
        }
    }

    override fun connectionDidParseLines(count: Int, requestId: String) {
        synchronized(this) {
            if (requestId != this.requestId) return
            linesParsed += count.toDouble()
        }
    }

    override fun connectionDidEncounterParseError(requestId: String) {
        sseDispatcher?.post {
            if (requestId != this@NitroSse.requestId) return@post
            synchronized(this@NitroSse) {
                parseErrors += 1.0
                disconnectReason = SseDisconnectReason.PARSER_ERROR
            }
        }
    }

    override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {
        val currentRid = synchronized(this@NitroSse) { this@NitroSse.requestId }
        if (requestId != currentRid) return
        // Spec-compliant logical byte accounting (UTF-8 payload: data + event + id + comment).
        // Matches iOS (NitroSse.swift) and JS Mock (MockSseEngine.ts). Raw wire headers/framing
        // are intentionally excluded to maintain cross-platform parity.
        val encodedDataSize = data.utf8Size()
        val eventTypeSize = if (type != null && type != "message") type.utf8Size() else 0L

        val currentConfig: SseConfig?
        synchronized(this@NitroSse) {
            if (requestId != this@NitroSse.requestId) return
            val currentLastId = this@NitroSse.lastProcessedId
            val isNewId = !id.isNullOrEmpty() && id != currentLastId
            val idSize = if (isNewId) id!!.utf8Size() else 0L
            totalBytesReceived.addAndGet(encodedDataSize + eventTypeSize + idSize)

            // WHATWG SSE Spec: If the server sends an empty id (e.g. 'id:\n'), reset lastProcessedId to null.
            // Note: lastProcessedId is dynamically updated here for every incoming message with an id,
            // feeding into Last-Event-ID for reconnection resumption per WHATWG SSE specification.
            if (id != null) {
                this@NitroSse.lastProcessedId = if (id.isEmpty()) null else id
            }
            currentConfig = this@NitroSse.config
            totalEventsReceived += 1.0
            val now = System.currentTimeMillis().toDouble()
            lastEventTime = now
            if (lastActivityTime > 0.0) {
                val gap = now - lastActivityTime
                if (gap > maxEventGapMs) {
                    maxEventGapMs = gap
                }
            }
            lastActivityTime = now
        }
        val parsedData = if (currentConfig?.autoParseJSON == true) JsonUtils.parseJsonToAnyMap(data) else null
        sseDispatcher?.post {
            if (requestId != this@NitroSse.requestId) return@post
            eventBuffer.push(SseEvent(SseEventType.MESSAGE, data, parsedData, id, type, null, 200.0, null, null))
        }
    }

    override fun connectionDidReceiveComment(comment: String, requestId: String) {
        val currentRid = synchronized(this@NitroSse) { this@NitroSse.requestId }
        if (requestId != currentRid) return
        val commentBytes = comment.utf8Size()
        synchronized(this@NitroSse) {
            if (requestId != this@NitroSse.requestId) return
            totalBytesReceived.addAndGet(commentBytes)
            commentsReceived += 1.0
            val now = System.currentTimeMillis().toDouble()
            lastHeartbeatTime = now
            if (lastActivityTime > 0.0) {
                val gap = now - lastActivityTime
                if (gap > maxEventGapMs) {
                    maxEventGapMs = gap
                }
            }
            lastActivityTime = now
        }
        // TODO(breaking-change): In next major version, avoid pushing HEARTBEAT event across JSI; use internal watchdog or dedicated onHeartbeat callback to eliminate bridge overhead.
        sseDispatcher?.post {
            if (requestId != this@NitroSse.requestId) return@post
            eventBuffer.push(SseEvent(SseEventType.HEARTBEAT, null, null, null, null, comment, null, null, null))
        }
    }

    override fun connectionDidReceiveRetry(retryMs: Long, requestId: String) {
        synchronized(this@NitroSse) {
            if (requestId != this@NitroSse.requestId) return
            serverRetryDelayMs = retryMs.toDouble()
            reconnectStrategy.updateRetryInterval(retryMs.toDouble())
        }
    }

    override fun connectionDidUpdateLastEventId(id: String?, requestId: String) {
        val newId = if (id.isNullOrEmpty()) null else id
        synchronized(this@NitroSse) {
            if (requestId != this@NitroSse.requestId) return
            if (newId != null && newId != this@NitroSse.lastProcessedId) {
                totalBytesReceived.addAndGet(newId.utf8Size())
            }
            this@NitroSse.lastProcessedId = newId
        }
    }

    override fun connectionDidFail(t: Throwable?, response: Response?, requestId: String) {
        connectionDidFail(t, response, null, requestId)
    }

    override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
        sseDispatcher?.post {
            // Note on Stale Callback Protection:
            // Android uses a unique UUID `requestId` per connection attempt rather than an integer `attemptVersion`.
            // When a connection fails, stops, or restarts, `this@NitroSse.requestId` is immediately cleared (set to null)
            // or replaced with a new UUID. Thus, any delayed or asynchronous error/close callbacks from a canceled/previous
            // socket are safely and strictly rejected by `if (requestId != this@NitroSse.requestId) return@post`.
            if (requestId != this@NitroSse.requestId || !isRunning.get()) return@post
            val statusCode = response?.code ?: -1
            val isTimeout = t is java.net.SocketTimeoutException || t is java.io.InterruptedIOException || t?.message?.contains("timeout", ignoreCase = true) == true
            val isParserLimit = t?.message?.contains("SSE line exceeded maximum limit", ignoreCase = true) == true ||
                t?.message?.contains("SSE event data exceeded maximum limit", ignoreCase = true) == true ||
                t is InvalidContentTypeException

            synchronized(this@NitroSse) {
                connectedAt = null
                if (statusCode != -1) {
                    lastStatusCode = statusCode.toDouble()
                }
                lastErrorTime = System.currentTimeMillis().toDouble()
                lastErrorCode = t?.javaClass?.simpleName ?: statusCode.toString()
                
                if (statusCode >= 400 || statusCode == 204) {
                    disconnectReason = SseDisconnectReason.SERVER_ERROR
                } else if (isParserLimit) {
                    disconnectReason = SseDisconnectReason.PARSER_ERROR
                } else if (isTimeout) {
                    disconnectReason = SseDisconnectReason.TIMEOUT
                } else {
                    disconnectReason = SseDisconnectReason.NETWORK_ERROR
                }
            }
            
            val currentRequestId = synchronized(this@NitroSse) {
                val id = this@NitroSse.requestId
                if (id != null) {
                    val raw = SseNetworkMetricsTracker.getRawBytes(id)
                    if (raw != null) {
                        sessionRawBytesOffset += raw.toDouble()
                    }
                }
                this@NitroSse.requestId = null
                id
            }
            currentRequestId?.let {
                NetworkInspector.reportRequestFailed(it, false)
                SseNetworkMetricsTracker.clear(it)
            }

            if (statusCode == 204) {
                failAndStop("No Content (204). Stopping.", 204.0)
                return@post
            }

            // Strict WHATWG SSE: permanently close without reconnecting on non-event-stream Content-Type (e.g. captive portal 200 HTML).
            val isInvalidContentType = t is InvalidContentTypeException ||
                (response != null && response.code in 200..299 && !(response.header("Content-Type")?.contains("text/event-stream", ignoreCase = true) ?: false))
            if (isInvalidContentType) {
                failAndStop("Invalid Content-Type: expected text/event-stream. Stopping.", if (statusCode != -1) statusCode.toDouble() else null)
                return@post
            }

            // Parser resource violations (line length, event data size) are fatal and must not reconnect
            if (isParserLimit) {
                failAndStop(t?.message ?: "Resource limit exceeded. Stopping.", if (statusCode != -1) statusCode.toDouble() else null)
                return@post
            }

            val maxRetries = synchronized(this@NitroSse) { config?.maxAuthRetries?.toInt() ?: DEFAULT_MAX_AUTH_RETRIES }
            // Handle 401/403 with async token refresh up to maxAuthRetries.
            if (statusCode == 401 || statusCode == 403) {
                val hasInterceptor = synchronized(this@NitroSse) { requestInterceptor != null }
                if (!hasInterceptor) {
                    failAndStop("Auth Error ($statusCode) - No interceptor provided. Stopping.", statusCode.toDouble())
                    return@post
                }
                val retries = consecutiveAuthErrors.incrementAndGet()
                if (retries > maxRetries) {
                    failAndStop("Auth Error ($statusCode) - Retry limit reached ($maxRetries). Stopping.", statusCode.toDouble())
                    return@post
                }
                eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Auth Error ($statusCode) - Retry $retries/$maxRetries. Refreshing token...", statusCode.toDouble(), null, null))
                scheduleReconnect(true, connectionAttemptVersion.get())
                return@post
            }
            
            val isFatal = (statusCode in 400..499 && statusCode != 401 && statusCode != 403 && statusCode != 408 && statusCode != 429)
            if (isFatal) {
                val sanitizedBody = errorBody?.trim()?.ifEmpty { null }
                val finalMessage = if (sanitizedBody != null) {
                    "Fatal Error ($statusCode): $sanitizedBody"
                } else {
                    "Fatal Error ($statusCode). Stopping."
                }
                failAndStop(finalMessage, statusCode.toDouble())
                return@post
            }

            // Schedule non-blocking Retry-After delay on dispatcher.
            val retryAfterMillis = SseReconnectStrategy.extractRetryAfterMillis(response)
            if ((statusCode == 429 || statusCode == 503) && retryAfterMillis != null) {
                val maxInterval = synchronized(this@NitroSse) { (config?.maxRetryIntervalMs ?: 30000.0).toLong() }
                val boundedRetryAfter = retryAfterMillis.coerceIn(0L, maxInterval)
                val jitter = (500 + Random.nextInt(1001)).toLong()
                val totalDelay = boundedRetryAfter + jitter
                eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Retry-After received: ${totalDelay / 1000}s", statusCode.toDouble(), totalDelay.toDouble(), null))
                scheduleReconnect(true, connectionAttemptVersion.get(), totalDelay)
                return@post
            }

            if (statusCode == 429) {
                eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Rate Limited (429). Retrying with backoff...", 429.0, null, null))
                scheduleReconnect(true, connectionAttemptVersion.get())
                return@post
            }

            // Map request timeout to STALE state before scheduling reconnection.
            // Intentionally mirrors iOS (NitroSse.swift). OkHttp readTimeout acts as watchdog;
            // emitting STALE notifies JS listeners of timeout-induced degradation before RECONNECTING.
            if (isTimeout) {
                updateState(SseState.STALE)
            }

            val defaultErrorMsg = when {
                statusCode >= 500 && !errorBody.isNullOrBlank() -> "Server Error ($statusCode): ${errorBody.trim()}"
                else -> t?.message ?: "Link lost ($statusCode)"
            }

            // Teardown and reconnect on stream or socket failure.
            eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, defaultErrorMsg, if (statusCode != -1) statusCode.toDouble() else null, null, null))
            scheduleReconnect(true, connectionAttemptVersion.get())
        }
    }

    override fun connectionDidClose(requestId: String) {
        sseDispatcher?.post {
            if (requestId != this@NitroSse.requestId || !isRunning.get()) return@post
            synchronized(this@NitroSse) {
                connectedAt = null
            }
            clearActiveRequestAndReportEnd()
            scheduleReconnect(false, connectionAttemptVersion.get())
        }
    }

    private fun failAndStop(message: String, statusCode: Double? = null) {
        eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, message, statusCode, null, null))
        updateState(SseState.FAILED)
        stopInternal()
    }

    private fun scheduleReconnect(isError: Boolean, attemptVersion: Int, fixedDelay: Long? = null) {
        if (!isRunning.get() || attemptVersion != connectionAttemptVersion.get()) return
        if (reconnectStrategy.hasReachedMaxAttempts()) {
            val maxAttempts = reconnectStrategy.currentReconnectAttempts
            Log.d(TAG, "Max reconnection attempts reached ($maxAttempts). Stopping.")
            failAndStop("Max reconnection attempts reached ($maxAttempts).")
            return
        }
        val safeReconnectDelay = if (fixedDelay != null) {
            reconnectStrategy.recordAttempt()
            fixedDelay
        } else {
            reconnectStrategy.nextDelay(isError)
        }
        synchronized(this) {
            lastReconnectDelayMs = safeReconnectDelay.toDouble()
        }
        // Increment attempt version before scheduling to invalidate pending tasks from previous cycles
        val newAttemptVersion = connectionAttemptVersion.incrementAndGet()
        updateState(SseState.RECONNECTING)
        sseDispatcher?.postDelayed({
            // Double check version and running state at trigger time to discard stale delayed callbacks
            if (isRunning.get() && newAttemptVersion == connectionAttemptVersion.get()) {
                performConnection(newAttemptVersion)
            }
        }, safeReconnectDelay)
    }

    private fun stopInternal() {
        synchronized(this) {
            connectedAt = null
        }
        isRunning.set(false)
        connectionAttemptVersion.incrementAndGet()
        performInternalCleanup()
    }

    override fun flush() {
        if (::eventBuffer.isInitialized) {
            eventBuffer.flush()
        }
    }

    override fun restart() {
        synchronized(this) { config } ?: return
        val task = {
            stopInternal()
            isRunning.set(true)
            val version = connectionAttemptVersion.incrementAndGet()
            updateState(SseState.RECONNECTING)
            reconnectStrategy.reset()
            requestId = null
            performConnection(version)
        }
        if (sseDispatcher?.isCurrentDispatcher() == true) {
            task()
        } else {
            sseDispatcher?.post(task)
        }
    }

    override fun isConnected(): Boolean {
        return isRunning.get()
    }

    override fun stop() {
        synchronized(this) {
            if (isRunning.get()) {
                disconnectReason = SseDisconnectReason.USER_STOP
            }
            connectedAt = null
        }
        isRunning.set(false)
        val stopVersion = connectionAttemptVersion.incrementAndGet()
        clearActiveRequestAndReportEnd()

        val task = {
            if (connectionAttemptVersion.get() == stopVersion) {
                wasRunningBeforeNetworkLoss = false
                wasRunningBeforePaused = false
                if (!isDispatcherDestroyed && currentState.get() != SseState.FAILED) {
                    updateState(SseState.CLOSED)
                } else if (isDispatcherDestroyed) {
                    currentState.set(SseState.CLOSED)
                }
                performInternalCleanup()
            }
        }
        if (sseDispatcher?.isCurrentDispatcher() == true) {
            task()
        } else {
            sseDispatcher?.post(task)
        }
    }

    private fun clearActiveRequestAndReportEnd() {
        val currentRequestId = synchronized(this) {
            val id = requestId
            if (id != null && SseNetworkMetricsTracker.isGzip(id)) {
                val raw = SseNetworkMetricsTracker.getRawBytes(id)
                if (raw != null) {
                    sessionRawBytesOffset += raw.toDouble()
                }
            }
            eventSource?.cancel()
            eventSource = null
            requestId = null
            id
        }
        currentRequestId?.let {
            NetworkInspector.reportResponseEnd(it, totalBytesReceived.get())
            SseNetworkMetricsTracker.clear(it)
        }
    }

    /**
     * Cleans up timeouts, active socket, and flushes any pending buffered events.
     * Always invoked within `sseDispatcherThread` execution context (from lifecycle, network, or stop).
     */
    private fun performInternalCleanup() {
        interceptorTimeoutRunnable?.let { sseDispatcher?.removeCallbacks(it) }
        interceptorTimeoutRunnable = null
        reconnectStrategy.reset()
        if (!isDispatcherDestroyed) {
            if (::eventBuffer.isInitialized) eventBuffer.flush()
        } else {
            if (::eventBuffer.isInitialized) eventBuffer.clear()
        }
        clearActiveRequestAndReportEnd()
    }

    /**
     * Synchronously cleans up active network sockets, timers, and lifecycle observers.
     * Note: OkHttp Dispatcher uses ThreadPoolExecutor(corePoolSize=0, keepAliveTime=60s).
     * Idle worker threads automatically terminate after 60s, allowing full GC collection.
     */
    override fun dispose() {
        if (!isDisposed.compareAndSet(false, true)) {
            return
        }
        Log.d(TAG, "Disposing NitroSse instance and cleaning up resources...")
        
        isRunning.set(false)
        connectionAttemptVersion.incrementAndGet()
        
        synchronized(this) {
            requestInterceptor = null
            config = null
        }
        
        interceptorTimeoutRunnable?.let { sseDispatcher?.removeCallbacks(it) }
        interceptorTimeoutRunnable = null
        
        if (::eventBuffer.isInitialized) {
            eventBuffer.clearCallback()
            eventBuffer.clear()
        }
        
        networkMonitor?.stop()
        networkMonitor = null
        
        lifecycleManager?.stopObserving()
        lifecycleManager = null
        
        clearActiveRequestAndReportEnd()
        
        synchronized(this) {
            client?.dispatcher?.executorService?.shutdown()
            client?.connectionPool?.evictAll()
            client = null
        }
        
        sseDispatcher?.removeCallbacksAndMessages(null)
        sseDispatcherThread?.quitSafely()
        sseDispatcherThread = null
        sseDispatcher = null
        
        super.dispose()
    }
}
