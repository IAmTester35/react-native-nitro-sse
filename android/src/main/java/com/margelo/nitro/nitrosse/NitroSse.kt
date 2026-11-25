package com.margelo.nitro.nitrosse

import android.net.NetworkCapabilities
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import androidx.lifecycle.ProcessLifecycleOwner
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.io.InterruptedIOException
import java.lang.ref.WeakReference
import java.net.SocketTimeoutException
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.random.Random
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.utf8Size

/**
 * Core Android implementation of [HybridNitroSseSpec] managing Server-Sent Events (SSE).
 *
 * Coordinates OkHttp SSE connection state, exponential backoff retries, event buffering,
 * network interface transitions, and Android app lifecycle hibernation.
 *
 * Threading & Synchronization Model:
 * - [SseDispatcher] (dedicated [HandlerThread]): Serializes asynchronous connection workflows,
 *   reconnection scheduling, backoff timers, and event buffering/flushing.
 * - Intrinsic Monitor ([synchronized]): Guards shared mutable state (metrics, active config,
 *   timestamps) to enable thread-safe synchronous reads from the JS/JSI thread (e.g. [getStats])
 *   and high-throughput in-line metric updates from OkHttp network callbacks without creating
 *   excessive Runnable allocations on the dispatcher.
 * - Lock-free & Atomic Primitives ([AtomicBoolean], [AtomicInteger], [@Volatile]): Guarantee immediate
 *   cross-thread visibility and atomic state transitions for lifecycle flags ([isRunning], [requestId]).
 */
@DoNotStrip
@Suppress("TooManyFunctions", "LargeClass")
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
    
    private var sseDispatcherThread: HandlerThread? = null
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
    private var currentState = AtomicReference(SseState.IDLE)
    private var wasRunningBeforeNetworkLoss = false
    private var interceptorTimeoutRunnable: Runnable? = null
    private var networkRestartRunnable: Runnable? = null
    private val isDisposed = AtomicBoolean(false)
    /// Dynamic request interceptor decoupled from SseConfig (v3.0)
    private var requestInterceptor: (() -> Promise<Promise<Map<String, String>>>)? = null

    private lateinit var eventBuffer: SseEventBuffer
    private val reconnectStrategy = SseReconnectStrategy()
    private var networkMonitor: SseNetworkMonitor? = null
    private var lifecycleManager: SseLifecycleManager? = null
    private val connectionHandler = SseConnectionHandler(this)
    private val mainDispatcher = AndroidSseDispatcher(Handler(Looper.getMainLooper()))

    companion object {
        private const val NETWORK_CHANGE_DEBOUNCE_MS = 1000L
        private const val DEFAULT_MAX_AUTH_RETRIES = 3
        private const val DEFAULT_MAX_BUFFER_SIZE = 1000
        private const val DEFAULT_RETRY_INTERVAL_MS = 1000.0
        private const val DEFAULT_MAX_RETRY_INTERVAL_MS = 30000.0
        private const val DEFAULT_JITTER_FACTOR = 0.5
        private const val DEFAULT_CONNECT_TIMEOUT_MS = 15000.0
        private const val DEFAULT_READ_TIMEOUT_MS = 300000.0
        private const val RETRY_AFTER_JITTER_BASE_MS = 500
        private const val RETRY_AFTER_JITTER_BOUND_MS = 1001
        private const val MILLIS_PER_SECOND = 1000L
        private const val HTTP_OK = 200
        private const val HTTP_OK_DOUBLE = 200.0
        private const val HTTP_NO_CONTENT = 204
        private const val HTTP_NO_CONTENT_DOUBLE = 204.0
        private const val HTTP_SUCCESS_MAX = 299
        private const val HTTP_BAD_REQUEST = 400
        private const val HTTP_UNAUTHORIZED = 401
        private const val HTTP_FORBIDDEN = 403
        private const val HTTP_REQUEST_TIMEOUT = 408
        private const val HTTP_TOO_MANY_REQUESTS = 429
        private const val HTTP_TOO_MANY_REQUESTS_DOUBLE = 429.0
        private const val HTTP_CLIENT_ERROR_MAX = 499
        private const val HTTP_INTERNAL_ERROR = 500
        private const val HTTP_SERVICE_UNAVAILABLE = 503
        private const val STATUS_UNKNOWN = -1
        private const val STATUS_UNKNOWN_DOUBLE = -1.0
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

            ensureDispatcherAndEventBuffer(config, onEvent)

            // Custom backoff guarantees cross-platform parity and lifecycle coordination.
            reconnectStrategy.configure(
                config.retryIntervalMs ?: DEFAULT_RETRY_INTERVAL_MS,
                config.maxRetryIntervalMs ?: DEFAULT_MAX_RETRY_INTERVAL_MS,
                config.jitterFactor ?: DEFAULT_JITTER_FACTOR,
                (config.maxReconnectAttempts ?: STATUS_UNKNOWN_DOUBLE).toInt()
            )

            configureHttpClient(config)
            configureLifecycleAndNetwork(config)
        }
    }

    private fun ensureDispatcherAndEventBuffer(
        config: SseConfig,
        onEvent: (events: Array<SseEvent>) -> Unit
    ) {
        if (sseDispatcher == null) {
            sseDispatcherThread = HandlerThread("NitroSseThread").apply { start() }
            sseDispatcher = AndroidSseDispatcher(Handler(sseDispatcherThread!!.looper))
        }

        if (!::eventBuffer.isInitialized) {
            eventBuffer = SseEventBuffer(onEvent, sseDispatcher)
            eventBuffer.onFlushError = { e -> handleRuntimeOrFlushError(e) }
        } else {
            eventBuffer.setCallback(onEvent)
        }
        eventBuffer.configure(
            config.batchingIntervalMs ?: 0.0,
            config.maxBufferSize?.toInt() ?: DEFAULT_MAX_BUFFER_SIZE
        )
    }

    private fun configureHttpClient(config: SseConfig) {
        val baseBuilder = this.client?.newBuilder()
            ?: OkHttpClient.Builder().addNetworkInterceptor(InspectorNetworkInterceptor())
        this.client = baseBuilder
            .connectTimeout(
                (config.connectionTimeoutMs ?: DEFAULT_CONNECT_TIMEOUT_MS).toLong(),
                TimeUnit.MILLISECONDS
            )
            .readTimeout(
                (config.readTimeoutMs ?: DEFAULT_READ_TIMEOUT_MS).toLong(),
                TimeUnit.MILLISECONDS
            )
            .retryOnConnectionFailure(true)
            .build()
    }

    private fun configureLifecycleAndNetwork(config: SseConfig) {
        if (lifecycleManager == null) {
            val weakThis = WeakReference(this)
            val manager = SseLifecycleManager(
                lifecycleProvider = { ProcessLifecycleOwner.get().lifecycle },
                mainDispatcher = mainDispatcher,
                sseDispatcher = sseDispatcher!!,
                onBackground = { weakThis.get()?.handleAppBackground() },
                onForeground = { weakThis.get()?.handleAppForeground() }
            )
            lifecycleManager = manager
            manager.startObserving()
        }
        if (config.monitorNetwork != false) {
            sseDispatcher?.post { startNetworkMonitoring() }
        } else {
            sseDispatcher?.post {
                networkMonitor?.stop()
                networkMonitor = null
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
        val monitor = networkMonitor ?: run {
            val weakThis = WeakReference(this)
            SseNetworkMonitor(context, sseDispatcher) { isAvailable, interfaceChanged, capabilities ->
                weakThis.get()?.handleNetworkChange(isAvailable, interfaceChanged, capabilities)
            }.also { networkMonitor = it }
        }
        monitor.start()
    }

    internal fun handleNetworkChange(
        isAvailable: Boolean,
        interfaceChanged: Boolean,
        capabilities: NetworkCapabilities? = null
    ) {
        if (isAvailable && capabilities != null) {
            if (wasRunningBeforeNetworkLoss) {
                cancelNetworkRestartDebounce()
                wasRunningBeforeNetworkLoss = false
                if (lifecycleManager?.isAppInBackground == true && !isBackgroundExecutionEnabled()) {
                    wasRunningBeforePaused = true
                } else {
                    start()
                }
            } else if (isRunning.get() && interfaceChanged) {
                cancelNetworkRestartDebounce()
                val runnable = Runnable {
                    networkRestartRunnable = null
                    if (isRunning.get()) {
                        restart()
                    }
                }
                networkRestartRunnable = runnable
                sseDispatcher?.postDelayed(runnable, NETWORK_CHANGE_DEBOUNCE_MS)
            }
        } else if (!isAvailable) {
            cancelNetworkRestartDebounce()
            if (isRunning.get()) {
                wasRunningBeforeNetworkLoss = true
                hibernate()
            }
        }
    }

    private fun handleAppForeground() {
        if (wasRunningBeforePaused) {
            wasRunningBeforePaused = false
            start()
        }
    }

    private fun handleAppBackground() {
        if (isRunning.get()) {
            if (isBackgroundExecutionEnabled()) {
                return
            }
            wasRunningBeforePaused = true
            hibernate()
        }
    }

    /**
     * Reads [SseConfig.backgroundExecution] under the instance monitor, since [config] is written
     * from the JS thread ([setup], [updateHeaders], [dispose]) while this is read on [sseDispatcher].
     */
    private fun isBackgroundExecutionEnabled(): Boolean =
        synchronized(this) { config?.backgroundExecution == true }

    /**
     * Pauses the active stream (network loss or app background) and invalidates in-flight attempts.
     * Callers set their own resume-intent flag ([wasRunningBeforeNetworkLoss] / [wasRunningBeforePaused]).
     * Always invoked on [sseDispatcher].
     */
    private fun hibernate() {
        updateState(SseState.PAUSED)
        isRunning.set(false)
        connectionAttemptVersion.incrementAndGet()
        performInternalCleanup()
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
        checkNotNull(synchronized(this) { config }) {
            "NitroSse not configured. Call setup() first."
        }

        if (!isRunning.compareAndSet(false, true)) {
            // If client is waiting in backoff reconnect loop, start() acts as an immediate "Retry Now",
            // cancelling pending backoff delay, resetting backoff counter, and attempting connection immediately.
            if (currentState.get() == SseState.RECONNECTING) {
                beginConnectionCycle()
            }
            return
        }

        isDispatcherDestroyed = false
        beginConnectionCycle()
    }

    /**
     * Begins a fresh connection cycle from the caller thread: claims a new attempt version
     * (invalidating pending backoff timers), transitions to CONNECTING, and connects on [sseDispatcher].
     */
    private fun beginConnectionCycle() {
        consecutiveAuthErrors.set(0)
        val version = connectionAttemptVersion.incrementAndGet()
        updateState(SseState.CONNECTING)
        sseDispatcher?.post { connectWithFreshBackoff(version) }
    }

    /**
     * Resets backoff counters and performs a connection attempt for [version]. Must run on [sseDispatcher].
     */
    private fun connectWithFreshBackoff(version: Int) {
        reconnectStrategy.reset()
        requestId = null
        performConnection(version)
    }

    private fun performConnection(version: Int) {
        // Discard attempt if state has changed or a newer connection cycle was initiated
        if (!isRunning.get() || version != connectionAttemptVersion.get()) return
        
        val (currentConfig, interceptor) = synchronized(this) {
            val cfg = config ?: return
            Pair(cfg, requestInterceptor)
        }
        
        if (interceptor != null) {
            executeWithInterceptor(interceptor, currentConfig, version)
        } else {
            executeConnection(version, null)
        }
    }

    @Suppress("TooGenericExceptionCaught")
    private fun executeWithInterceptor(
        interceptor: () -> Promise<Promise<Map<String, String>>>,
        currentConfig: SseConfig,
        version: Int
    ) {
        val interceptorCompleted = AtomicBoolean(false)
        val timeoutMs = (currentConfig.connectionTimeoutMs ?: DEFAULT_CONNECT_TIMEOUT_MS).toLong()

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
            // Safe-calls (?.) protect against null/unmocked Promise chains in unit tests and JS bridging.
            interceptor.invoke()?.then { promise2 ->
                promise2?.then { newHeaders ->
                    sseDispatcher?.post {
                        if (!isRunning.get() || version != connectionAttemptVersion.get()) return@post
                        if (interceptorCompleted.compareAndSet(false, true)) {
                            interceptorTimeoutRunnable?.let { sseDispatcher?.removeCallbacks(it) }
                            interceptorTimeoutRunnable = null
                            val connectionConfig = synchronized(this) {
                                val base = config ?: return@post
                                base.copy(headers = (base.headers ?: emptyMap()) + newHeaders)
                            }
                            executeConnection(version, connectionConfig)
                        }
                    }
                }?.catch(safeHandleError)
            }?.catch(safeHandleError)
        } catch (e: Throwable) {
            safeHandleError(e)
        }
    }

    /**
     * Detects the React Native / Nitro "JS Dispatcher destroyed" runtime error (Fast Refresh, bundle reload,
     * host teardown). Originates from third-party C++ (no typed exception available), so message matching
     * is centralized here as the single source of truth.
     */
    private fun isJsDispatcherDestroyedError(t: Throwable?): Boolean =
        t?.message?.contains("Dispatcher has already been destroyed", ignoreCase = true) == true

    private fun handleRuntimeOrFlushError(t: Throwable?) {
        if (isJsDispatcherDestroyedError(t)) {
            this.isDispatcherDestroyed = true
            dispose()
        }
    }

    private fun handleInterceptorError(t: Throwable?, version: Int) {
        // May be invoked from the Promise callback thread; hop to sseDispatcher before touching
        // dispatcher-confined state (interceptorTimeoutRunnable). Stale attempts must not cancel a newer
        // attempt's timeout, which is why removal happens after the version guard.
        sseDispatcher?.post {
            if (!isRunning.get() || version != connectionAttemptVersion.get()) return@post
            interceptorTimeoutRunnable?.let { sseDispatcher?.removeCallbacks(it) }
            interceptorTimeoutRunnable = null
            
            if (isJsDispatcherDestroyedError(t)) {
                this.isDispatcherDestroyed = true
                dispose()
                return@post
            }
            
            val maxRetries = synchronized(this@NitroSse) {
                config?.maxAuthRetries?.toInt() ?: DEFAULT_MAX_AUTH_RETRIES
            }
            val retries = consecutiveAuthErrors.incrementAndGet()
            if (retries > maxRetries) {
                failAndStop("Auth retry limit reached ($maxRetries). Stopping.", STATUS_UNKNOWN_DOUBLE)
                return@post
            }

            eventBuffer.push(
                SseEvent(
                    SseEventType.ERROR,
                    null,
                    null,
                    null,
                    null,
                    "Interceptor Error: ${t?.message}",
                    STATUS_UNKNOWN_DOUBLE,
                    null,
                    null
                )
            )
            scheduleReconnect(true, version)
        }
    }

    private fun buildSseHttpRequest(
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

    @Suppress("TooGenericExceptionCaught")
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
            accumulateGzipRawBytesOffset(oldRequestId)
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
            val request = buildSseHttpRequest(currentConfig, currentLastId, newRequestId)
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
            // Handles IllegalArgumentException (URL/headers), NullPointerException, and IllegalStateException
            // without catching/suppressing fatal JVM errors (e.g. OutOfMemoryError, VirtualMachineError).
            failAndStop("Invalid connection request: ${e.message}", STATUS_UNKNOWN_DOUBLE)
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
            eventBuffer.push(
                SseEvent(
                    SseEventType.OPEN,
                    null,
                    null,
                    null,
                    null,
                    null,
                    response.code.toDouble(),
                    null,
                    null
                )
            )
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
        synchronized(this) {
            if (requestId != this.requestId) return
            parseErrors += 1.0
            disconnectReason = SseDisconnectReason.PARSER_ERROR
        }
    }

    override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, requestId: String) {
        if (requestId != this@NitroSse.requestId) return
        // Spec-compliant logical byte accounting (UTF-8 payload: data + event + id + comment).
        // Matches iOS (NitroSse.swift) and JS Mock (MockSseEngine.ts). Raw wire headers/framing
        // are intentionally excluded to maintain cross-platform parity.
        val encodedDataSize = data.utf8Size()
        val eventTypeSize = if (type != null && type != "message") type.utf8Size() else 0L

        val currentConfig: SseConfig?
        synchronized(this@NitroSse) {
            if (requestId != this@NitroSse.requestId) return
            totalBytesReceived.addAndGet(encodedDataSize + eventTypeSize)
            currentConfig = this@NitroSse.config
            totalEventsReceived += 1.0
            val now = System.currentTimeMillis().toDouble()
            lastEventTime = now
            recordActivity(now)
        }
        val parsedData = if (currentConfig?.autoParseJSON == true) JsonUtils.parseJsonToAnyMap(data) else null
        sseDispatcher?.post {
            if (requestId != this@NitroSse.requestId) return@post
            eventBuffer.push(
                SseEvent(SseEventType.MESSAGE, data, parsedData, id, type, null, HTTP_OK_DOUBLE, null, null)
            )
        }
    }

    override fun connectionDidReceiveComment(comment: String, requestId: String) {
        if (requestId != this@NitroSse.requestId) return
        val commentBytes = comment.utf8Size()
        synchronized(this@NitroSse) {
            if (requestId != this@NitroSse.requestId) return
            totalBytesReceived.addAndGet(commentBytes)
            commentsReceived += 1.0
            val now = System.currentTimeMillis().toDouble()
            lastHeartbeatTime = now
            recordActivity(now)
        }
        // Note (v4.0 roadmap): Avoid pushing HEARTBEAT event across JSI; use internal watchdog or onHeartbeat.
        sseDispatcher?.post {
            if (requestId != this@NitroSse.requestId) return@post
            eventBuffer.push(SseEvent(SseEventType.HEARTBEAT, null, null, null, null, comment, null, null, null))
        }
    }

    override fun connectionDidReceiveRetry(retryMs: Long, requestId: String) {
        synchronized(this@NitroSse) {
            if (requestId != this@NitroSse.requestId) return
            serverRetryDelayMs = retryMs.toDouble()
        }
        // reconnectStrategy is confined to sseDispatcher (nextDelay/reset run there); FIFO ordering
        // guarantees this update lands before any subsequent close/fail callback from the same stream.
        sseDispatcher?.post {
            if (requestId != this@NitroSse.requestId) return@post
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

    private fun isTimeoutException(t: Throwable?): Boolean =
        t is SocketTimeoutException ||
            t is InterruptedIOException ||
            t?.message?.contains("timeout", ignoreCase = true) == true

    private fun isInvalidEventStreamResponse(t: Throwable?, response: Response?): Boolean {
        val hasInvalidBodyType = response != null &&
            response.code in HTTP_OK..HTTP_SUCCESS_MAX &&
            response.header("Content-Type")?.contains("text/event-stream", ignoreCase = true) != true
        return t is InvalidContentTypeException || hasInvalidBodyType
    }

    private fun recordFailureMetrics(
        t: Throwable?,
        statusCode: Int,
        isInvalidContentType: Boolean,
        isParserLimit: Boolean,
        isTimeout: Boolean
    ) {
        synchronized(this) {
            connectedAt = null
            if (statusCode != STATUS_UNKNOWN) {
                lastStatusCode = statusCode.toDouble()
            }
            lastErrorTime = System.currentTimeMillis().toDouble()
            lastErrorCode = t?.javaClass?.simpleName ?: statusCode.toString()

            // Classification mirrors iOS (NitroSse.swift): invalid Content-Type is a server/protocol error.
            disconnectReason = when {
                statusCode >= HTTP_BAD_REQUEST || statusCode == HTTP_NO_CONTENT || isInvalidContentType ->
                    SseDisconnectReason.SERVER_ERROR
                isParserLimit -> SseDisconnectReason.PARSER_ERROR
                isTimeout -> SseDisconnectReason.TIMEOUT
                else -> SseDisconnectReason.NETWORK_ERROR
            }
        }
    }

    private fun clearFailedRequestAndReportInspector() {
        val currentRequestId = synchronized(this) {
            val id = this.requestId
            accumulateGzipRawBytesOffset(id)
            this.requestId = null
            id
        }
        currentRequestId?.let {
            NetworkInspector.reportRequestFailed(it, false)
            SseNetworkMetricsTracker.clear(it)
        }
    }

    private fun handleTerminalFailure(
        t: Throwable?,
        statusCode: Int,
        errorBody: String?,
        isInvalidContentType: Boolean
    ): Boolean {
        val statusDouble = if (statusCode != STATUS_UNKNOWN) statusCode.toDouble() else null
        val isFatalClientError = statusCode in HTTP_BAD_REQUEST..HTTP_CLIENT_ERROR_MAX &&
            statusCode != HTTP_UNAUTHORIZED &&
            statusCode != HTTP_FORBIDDEN &&
            statusCode != HTTP_REQUEST_TIMEOUT &&
            statusCode != HTTP_TOO_MANY_REQUESTS
        var handled = true
        when {
            statusCode == HTTP_NO_CONTENT ->
                failAndStop("No Content (204). Stopping.", HTTP_NO_CONTENT_DOUBLE)
            isInvalidContentType ->
                failAndStop("Invalid Content-Type: expected text/event-stream. Stopping.", statusDouble)
            t is SseParserLimitException ->
                // Parser resource violations (line length, event data size) are fatal and must not reconnect
                failAndStop(t.message, statusDouble)
            isFatalClientError -> {
                val sanitizedBody = errorBody?.trim()?.ifEmpty { null }
                val finalMessage = if (sanitizedBody != null) {
                    "Fatal Error ($statusCode): $sanitizedBody"
                } else {
                    "Fatal Error ($statusCode). Stopping."
                }
                failAndStop(finalMessage, statusCode.toDouble())
            }
            else -> handled = false
        }
        return handled
    }

    private fun handleAuthFailure(statusCode: Int): Boolean {
        if (statusCode != HTTP_UNAUTHORIZED && statusCode != HTTP_FORBIDDEN) return false
        val hasInterceptor = synchronized(this) { requestInterceptor != null }
        if (!hasInterceptor) {
            failAndStop(
                "Auth Error ($statusCode) - No interceptor provided. Stopping.",
                statusCode.toDouble()
            )
        } else {
            val maxRetries = synchronized(this) { config?.maxAuthRetries?.toInt() ?: DEFAULT_MAX_AUTH_RETRIES }
            val retries = consecutiveAuthErrors.incrementAndGet()
            if (retries > maxRetries) {
                failAndStop(
                    "Auth Error ($statusCode) - Retry limit reached ($maxRetries). Stopping.",
                    statusCode.toDouble()
                )
            } else {
                val message = "Auth Error ($statusCode) - Retry $retries/$maxRetries. Refreshing token..."
                eventBuffer.push(
                    SseEvent(SseEventType.ERROR, null, null, null, null, message, statusCode.toDouble(), null, null)
                )
                scheduleReconnect(true, connectionAttemptVersion.get())
            }
        }
        return true
    }

    private fun handleRetryAfterOrRateLimit(statusCode: Int, response: Response?): Boolean {
        // Schedule non-blocking Retry-After delay on dispatcher.
        val retryAfterMillis = SseReconnectStrategy.extractRetryAfterMillis(response)
        val isRetryAfterStatus = statusCode == HTTP_TOO_MANY_REQUESTS || statusCode == HTTP_SERVICE_UNAVAILABLE
        var handled = true
        if (isRetryAfterStatus && retryAfterMillis != null) {
            val maxInterval = synchronized(this) {
                (config?.maxRetryIntervalMs ?: DEFAULT_MAX_RETRY_INTERVAL_MS).toLong()
            }
            val boundedRetryAfter = retryAfterMillis.coerceIn(0L, maxInterval)
            val jitter = (RETRY_AFTER_JITTER_BASE_MS + Random.nextInt(RETRY_AFTER_JITTER_BOUND_MS)).toLong()
            val totalDelay = boundedRetryAfter + jitter
            val message = "Retry-After received: ${totalDelay / MILLIS_PER_SECOND}s"
            eventBuffer.push(
                SseEvent(
                    SseEventType.ERROR,
                    null,
                    null,
                    null,
                    null,
                    message,
                    statusCode.toDouble(),
                    totalDelay.toDouble(),
                    null
                )
            )
            scheduleReconnect(true, connectionAttemptVersion.get(), totalDelay)
        } else if (statusCode == HTTP_TOO_MANY_REQUESTS) {
            eventBuffer.push(
                SseEvent(
                    SseEventType.ERROR,
                    null,
                    null,
                    null,
                    null,
                    "Rate Limited (429). Retrying with backoff...",
                    HTTP_TOO_MANY_REQUESTS_DOUBLE,
                    null,
                    null
                )
            )
            scheduleReconnect(true, connectionAttemptVersion.get())
        } else {
            handled = false
        }
        return handled
    }

    private fun formatTransientFailureMessage(
        t: Throwable?,
        statusCode: Int,
        reportedStatusCode: Double?,
        errorBody: String?
    ): String = when {
        statusCode >= HTTP_INTERNAL_ERROR && !errorBody.isNullOrBlank() ->
            "Server Error ($statusCode): ${errorBody.trim()}"
        else ->
            t?.message ?: if (reportedStatusCode != null) {
                "Link lost (${reportedStatusCode.toInt()})"
            } else {
                "Link lost"
            }
    }

    override fun connectionDidFail(t: Throwable?, response: Response?, errorBody: String?, requestId: String) {
        sseDispatcher?.post {
            // Android uses a unique UUID `requestId` per attempt alongside `connectionAttemptVersion`.
            // Delayed callbacks from a previous socket are rejected by `requestId != this@NitroSse.requestId`.
            if (requestId != this@NitroSse.requestId || !isRunning.get()) return@post

            val statusCode = response?.code ?: STATUS_UNKNOWN
            val isTimeout = isTimeoutException(t)
            val isParserLimit = t is SseParserLimitException
            val isInvalidContentType = isInvalidEventStreamResponse(t, response)

            recordFailureMetrics(t, statusCode, isInvalidContentType, isParserLimit, isTimeout)
            clearFailedRequestAndReportInspector()

            val handled = handleTerminalFailure(t, statusCode, errorBody, isInvalidContentType) ||
                handleAuthFailure(statusCode) ||
                handleRetryAfterOrRateLimit(statusCode, response)
            if (handled) return@post

            // Map request timeout to STALE state before scheduling reconnection.
            // OkHttp readTimeout acts as watchdog; emitting STALE notifies JS listeners before RECONNECTING.
            if (isTimeout) {
                updateState(SseState.STALE)
            }

            val isReportedCode = statusCode >= HTTP_BAD_REQUEST
            val reportedStatusCode = if (isReportedCode) statusCode.toDouble() else null
            val defaultErrorMsg = formatTransientFailureMessage(t, statusCode, reportedStatusCode, errorBody)

            eventBuffer.push(
                SseEvent(
                    SseEventType.ERROR,
                    null,
                    null,
                    null,
                    null,
                    defaultErrorMsg,
                    reportedStatusCode,
                    null,
                    null
                )
            )
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
        synchronized(this) {
            config ?: return
            connectedAt = null
        }
        // Claim running state and a new attempt version synchronously on the caller thread (mirrors start()/stop()).
        // A subsequent stop()/dispose() bumps the version and thereby invalidates this queued restart, instead of
        // the restart task resurrecting a stream the caller has already stopped.
        isRunning.set(true)
        val version = connectionAttemptVersion.incrementAndGet()
        // Detach the current socket immediately so its late callbacks are rejected as stale (requestId cleared).
        clearActiveRequestAndReportEnd()
        // Deliver events buffered from the retired connection before announcing RECONNECTING so JS observes
        // them in chronological order (not batched together with / after the new state transition).
        eventBuffer.flush()
        updateState(SseState.RECONNECTING)
        val task = {
            // An explicit restart supersedes any pending hibernation resume intent (mirrors stop()).
            wasRunningBeforeNetworkLoss = false
            wasRunningBeforePaused = false
            // Cleanup is unconditional: a start()/restart() issued before this task drained bumps the version,
            // but the timers and buffers of the retired cycle must still be released. FIFO ordering on
            // [sseDispatcher] guarantees it runs before that newer cycle's queued connect task.
            performInternalCleanup()
            if (isRunning.get() && version == connectionAttemptVersion.get()) {
                connectWithFreshBackoff(version)
            }
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
                // Preserve FAILED as terminal state. When the JS dispatcher is destroyed, dispose() has already
                // cleared this queue, so no state event needs to be (or can be) delivered.
                if (!isDispatcherDestroyed && currentState.get() != SseState.FAILED) {
                    updateState(SseState.CLOSED)
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
            accumulateGzipRawBytesOffset(id)
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
     * Folds the raw (compressed) wire bytes of a retiring gzip request into [sessionRawBytesOffset]
     * so [rawBytesReceived] stays cumulative across reconnects. Caller must hold the instance monitor.
     */
    private fun accumulateGzipRawBytesOffset(retiringRequestId: String?) {
        if (retiringRequestId == null || !SseNetworkMetricsTracker.isGzip(retiringRequestId)) return
        SseNetworkMetricsTracker.getRawBytes(retiringRequestId)?.let { sessionRawBytesOffset += it.toDouble() }
    }

    /**
     * Updates [maxEventGapMs] / [lastActivityTime] for any inbound stream activity (message or comment).
     * Caller must hold the instance monitor.
     */
    private fun recordActivity(now: Double) {
        if (lastActivityTime > 0.0) {
            val gap = now - lastActivityTime
            if (gap > maxEventGapMs) maxEventGapMs = gap
        }
        lastActivityTime = now
    }

    private fun cancelNetworkRestartDebounce() {
        networkRestartRunnable?.let { sseDispatcher?.removeCallbacks(it) }
        networkRestartRunnable = null
    }

    /**
     * Cleans up timeouts, active socket, and flushes any pending buffered events.
     * Always invoked within `sseDispatcherThread` execution context (from lifecycle, network, or stop).
     */
    private fun performInternalCleanup() {
        cancelNetworkRestartDebounce()
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
        isRunning.set(false)
        connectionAttemptVersion.incrementAndGet()
        // The dispatcher queue is discarded below, so no queued stop() task can publish the terminal state.
        // Keep getState() accurate (silently: the JS event callback is already unusable) while preserving FAILED.
        if (isDispatcherDestroyed) {
            currentState.updateAndGet { if (it == SseState.FAILED) it else SseState.CLOSED }
        }
        
        synchronized(this) {
            requestInterceptor = null
            config = null
        }
        
        cancelNetworkRestartDebounce()
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
