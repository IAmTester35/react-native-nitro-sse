package com.margelo.nitro.nitrosse

import android.os.Handler
import android.util.Log
import com.facebook.proguard.annotations.DoNotStrip
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import com.margelo.nitro.NitroModules
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
    private var client: OkHttpClient? = null
    private var eventSource: EventSource? = null
    private var config: SseConfig? = null
    private var requestId: String? = null
    
    private val isRunning = AtomicBoolean(false)
    private var isDispatcherDestroyed = false
    private var wasRunningBeforePaused = false
    private val consecutiveAuthErrors = AtomicInteger(0)
    private val maxAuthRetries = 3
    
    private var sseDispatcherThread: android.os.HandlerThread? = null
    internal var sseDispatcher: SseDispatcher? = null
    
    private val totalBytesReceived = AtomicLong(0)
    private val connectionAttemptVersion = AtomicInteger(0)
    private var lastProcessedId: String? = null
    private var currentState = java.util.concurrent.atomic.AtomicReference(SseState.IDLE)
    private val totalReconnectCount = AtomicInteger(0)
    private var lastErrorTime: Double? = null
    private var lastErrorCode: String? = null
    private var wasRunningBeforeNetworkLoss = false
    private var lastNetworkCapabilities: NetworkCapabilities? = null

    private lateinit var eventBuffer: SseEventBuffer
    private val reconnectStrategy = SseReconnectStrategy()
    private var networkMonitor: SseNetworkMonitor? = null
    private var lifecycleManager: SseLifecycleManager? = null
    private val connectionHandler = SseConnectionHandler(this)
    private val mainDispatcher = AndroidSseDispatcher(Handler(android.os.Looper.getMainLooper()))

    companion object {
        private const val TAG = "NitroSse"
    }

    override fun setup(config: SseConfig, onEvent: (events: Array<SseEvent>) -> Unit) {
        synchronized(this) {
            this.config = config
            
            if (sseDispatcher == null) {
                sseDispatcherThread = android.os.HandlerThread("NitroSseThread").apply { start() }
                sseDispatcher = AndroidSseDispatcher(Handler(sseDispatcherThread!!.looper))
            }

            if (!::eventBuffer.isInitialized) {
                eventBuffer = SseEventBuffer(onEvent, sseDispatcher, mainDispatcher)
            } else {
                eventBuffer.setCallback(onEvent)
            }
            eventBuffer.configure(config.batchingIntervalMs ?: 0.0, config.maxBufferSize?.toInt() ?: 1000)

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
                    .addNetworkInterceptor(HeartbeatNetworkInterceptor(totalBytesReceived) {
                        eventBuffer.push(SseEvent(SseEventType.HEARTBEAT, null, null, null, null, "keep-alive", null, null, null))
                    })
                this.client = builder.build()
            } else {
                this.client = this.client!!.newBuilder()
                    .connectTimeout((config.connectionTimeoutMs ?: 15000.0).toLong(), TimeUnit.MILLISECONDS)
                    .readTimeout((config.readTimeoutMs ?: 300000.0).toLong(), TimeUnit.MILLISECONDS)
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

    private fun startNetworkMonitoring() {
        val context = NitroModules.applicationContext ?: return
        if (networkMonitor == null) {
            networkMonitor = SseNetworkMonitor(context, sseDispatcher) { isAvailable, capabilities ->
                handleNetworkChange(isAvailable, capabilities)
            }
        }
        networkMonitor?.start()
    }

    private fun handleNetworkChange(isAvailable: Boolean, capabilities: NetworkCapabilities?) {
        Log.d(TAG, "Network change: available=$isAvailable")
        if (isAvailable && capabilities != null) {
            if (wasRunningBeforeNetworkLoss) {
                Log.d(TAG, "Network restored. Resuming stream.")
                wasRunningBeforeNetworkLoss = false
                if (lifecycleManager?.isAppInBackground == true && config?.backgroundExecution != true) {
                    wasRunningBeforePaused = true
                } else {
                    start()
                }
            } else if (isRunning.get() && lastNetworkCapabilities != null) {
                val isWifi = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                val isCellular = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                
                val lastWifi = lastNetworkCapabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ?: false
                val lastCellular = lastNetworkCapabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ?: false
                
                if ((isWifi && !lastWifi) || (isCellular && !lastCellular)) {
                    Log.d(TAG, "Network interface changed. Restarting stream.")
                    restart()
                }
            }
            lastNetworkCapabilities = capabilities
        } else if (!isAvailable) {
            if (isRunning.get()) {
                Log.d(TAG, "Network lost. Hibernating.")
                wasRunningBeforeNetworkLoss = true
                updateState(SseState.PAUSED)
                isRunning.set(false)
                connectionAttemptVersion.incrementAndGet()
                performInternalCleanup()
            }
            lastNetworkCapabilities = null
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
            sseDispatcher?.post {
                performInternalCleanup()
            }
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
                this.config = it.copy(headers = headers)
            }
        }
    }

    override fun getStats(): SseStats {
        synchronized(this) {
            return SseStats(
                totalBytesReceived.get().toDouble(),
                totalReconnectCount.get().toDouble(),
                lastErrorTime,
                lastErrorCode
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
        }
    }

    override fun start() {
        val currentConfig = synchronized(this) { config } ?: return
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
        val interceptor = currentConfig.onBeforeRequest
        
        if (interceptor != null) {
            val interceptorCompleted = AtomicBoolean(false)
            val timeoutMs = (currentConfig.connectionTimeoutMs ?: 15000.0).toLong()

            // Enforce timeout guard on JS onBeforeRequest promise to prevent connection hangs
            sseDispatcher?.postDelayed({
                if (interceptorCompleted.compareAndSet(false, true)) {
                    handleInterceptorError(Exception("onBeforeRequest timed out"), version)
                }
            }, timeoutMs)

            try {
                interceptor.invoke().then { promise2 ->
                    promise2.then { newHeaders ->
                        sseDispatcher?.post {
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
                        if (interceptorCompleted.compareAndSet(false, true)) handleInterceptorError(error, version)
                    }
                }.catch { error ->
                    if (interceptorCompleted.compareAndSet(false, true)) handleInterceptorError(error, version)
                }
            } catch (e: Throwable) {
                if (interceptorCompleted.compareAndSet(false, true)) handleInterceptorError(e, version)
            }
        } else {
            executeConnection(version)
        }
    }

    private fun handleInterceptorError(t: Throwable?, version: Int) {
        sseDispatcher?.post {
            if (!isRunning.get() || version != connectionAttemptVersion.get()) return@post
            
            val isDispatcherDestroyedMsg = t?.message?.contains("Dispatcher has already been destroyed", ignoreCase = true) == true
            if (isDispatcherDestroyedMsg) {
                Log.w(TAG, "JS Dispatcher destroyed. Stopping SSE stream.")
                this@NitroSse.isDispatcherDestroyed = true
                stopInternal()
                return@post
            }

            eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Interceptor Error: ${t?.message}", -1.0, null, null))

            scheduleReconnect(true, version)
        }
    }

    private fun executeConnection(version: Int) {
        val currentConfig: SseConfig
        val currentLastId: String?
        val oldRequestId: String?
        val newRequestId = UUID.randomUUID().toString()
        
        synchronized(this) {
            if (!isRunning.get() || config == null || version != connectionAttemptVersion.get()) return
            currentConfig = config!!
            currentLastId = lastProcessedId
            
            oldRequestId = requestId
            requestId = newRequestId
            
            eventSource?.cancel()
            eventSource = null
        }
        
        oldRequestId?.let { NetworkInspector.reportResponseEnd(it, totalBytesReceived.get()) }
        
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
        
        val newEventSource = connectionHandler.createEventSource(client!!, request, newRequestId)
        synchronized(this) { eventSource = newEventSource }
    }

    override fun connectionDidOpen(response: Response, reqId: String) {
        sseDispatcher?.post {
            if (reqId != requestId) return@post
            consecutiveAuthErrors.set(0)
            reconnectStrategy.reset()
            updateState(SseState.OPEN)
            eventBuffer.push(SseEvent(SseEventType.OPEN, null, null, null, null, null, response.code.toDouble(), null, null))
        }
    }

    override fun connectionDidReceiveMessage(id: String?, type: String?, data: String, reqId: String) {
        sseDispatcher?.post {
            if (reqId != requestId) return@post
            val currentConfig: SseConfig?
            synchronized(this@NitroSse) {
                if (!id.isNullOrEmpty()) {
                    this@NitroSse.lastProcessedId = id
                }
                currentConfig = this@NitroSse.config
            }
            val parsedData = if (currentConfig?.autoParseJSON == true) JsonUtils.parseJsonToAnyMap(data) else null
            eventBuffer.push(SseEvent(SseEventType.MESSAGE, data, parsedData, id, type, null, 200.0, null, null))
        }
    }

    override fun connectionDidFail(t: Throwable?, response: Response?, reqId: String) {
        sseDispatcher?.post {
            if (reqId != requestId || !isRunning.get()) return@post
            val statusCode = response?.code ?: -1
            
            totalReconnectCount.incrementAndGet()
            synchronized(this@NitroSse) {
                lastErrorTime = System.currentTimeMillis().toDouble()
                lastErrorCode = t?.javaClass?.simpleName ?: statusCode.toString()
            }
            
            val currentRequestId = synchronized(this@NitroSse) {
                val id = requestId
                requestId = null
                id
            }
            currentRequestId?.let { NetworkInspector.reportRequestFailed(it, false) }

            if (statusCode == 401 || statusCode == 403) {
                val currentConfig = synchronized(this@NitroSse) { config }
                if (currentConfig?.onBeforeRequest == null) {
                    eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Auth Error ($statusCode) - No interceptor provided. Stopping.", statusCode.toDouble(), null, null))
                    updateState(SseState.FAILED)
                    stopInternal()
                    return@post
                }
                val retries = consecutiveAuthErrors.incrementAndGet()
                if (retries >= maxAuthRetries) {
                    eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Auth Error ($statusCode) - Retry limit reached ($maxAuthRetries). Stopping.", statusCode.toDouble(), null, null))
                    updateState(SseState.FAILED)
                    stopInternal()
                    return@post
                }
                eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Auth Error ($statusCode) - Retry $retries/$maxAuthRetries. Refreshing token...", statusCode.toDouble(), null, null))
                scheduleReconnect(true, connectionAttemptVersion.get())
                return@post
            }
            
            if (statusCode == 400) {
                eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Fatal Error ($statusCode). Stopping.", statusCode.toDouble(), null, null))
                updateState(SseState.FAILED)
                stopInternal()
                return@post
            }

            val retryAfterMillis = SseReconnectStrategy.extractRetryAfterMillis(response)
            if ((statusCode == 429 || statusCode == 503) && retryAfterMillis != null) {
                val jitter = (500 + Random.nextInt(1001)).toLong()
                val totalDelay = retryAfterMillis + jitter
                eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Retry-After received: ${totalDelay/1000}s", statusCode.toDouble(), totalDelay.toDouble(), null))
                val currentAttemptVersion = connectionAttemptVersion.get()
                updateState(SseState.RECONNECTING)
                sseDispatcher?.postDelayed({ if (isRunning.get()) performConnection(currentAttemptVersion) }, totalDelay)
                return@post
            }

            if (statusCode == 429) {
                eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Rate Limited (429) without Retry-After. Stopping.", 429.0, null, null))
                updateState(SseState.FAILED)
                stopInternal()
                return@post
            }

            if (statusCode == 204) {
                eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "No Content (204). Stopping.", 204.0, null, null))
                updateState(SseState.FAILED)
                stopInternal()
                return@post
            }

            val isTimeout = t is java.net.SocketTimeoutException || t is java.io.InterruptedIOException || t?.message?.contains("timeout", ignoreCase = true) == true
            if (isTimeout) {
                updateState(SseState.STALE)
            }

            eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, t?.message ?: "Link lost ($statusCode)", if (statusCode != -1) statusCode.toDouble() else null, null, null))
            scheduleReconnect(true, connectionAttemptVersion.get())
        }
    }

    override fun connectionDidClose(reqId: String) {
        sseDispatcher?.post {
            if (reqId != requestId || !isRunning.get()) return@post
            val currentRequestId = synchronized(this@NitroSse) {
                val id = requestId
                requestId = null
                id
            }
            currentRequestId?.let { NetworkInspector.reportResponseEnd(it, totalBytesReceived.get()) }
            scheduleReconnect(false, connectionAttemptVersion.get())
        }
    }

    private fun scheduleReconnect(isError: Boolean, attemptVersion: Int) {
        if (reconnectStrategy.hasReachedMaxAttempts()) {
            val maxAttempts = reconnectStrategy.currentReconnectAttempts
            Log.d(TAG, "Max reconnection attempts reached ($maxAttempts). Stopping.")
            eventBuffer.push(SseEvent(SseEventType.ERROR, null, null, null, null, "Max reconnection attempts reached ($maxAttempts).", null, null, null))
            updateState(SseState.FAILED)
            stopInternal()
            return
        }
        val safeReconnectDelay = reconnectStrategy.nextDelay(isError)
        updateState(SseState.RECONNECTING)
        sseDispatcher?.postDelayed({ if (isRunning.get()) performConnection(attemptVersion) }, safeReconnectDelay)
    }

    private fun stopInternal() {
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
        stopInternal()
        updateState(SseState.RECONNECTING)
        start()
    }

    override fun isConnected(): Boolean {
        return isRunning.get()
    }

    override fun stop() {
        isRunning.set(false)
        wasRunningBeforeNetworkLoss = false
        wasRunningBeforePaused = false
        if (currentState.get() != SseState.FAILED) {
            updateState(SseState.CLOSED)
        }
        connectionAttemptVersion.incrementAndGet() 
        sseDispatcher?.post {
            performInternalCleanup()
        }
    }

    private fun performInternalCleanup() {
        reconnectStrategy.reset()
        if (!isDispatcherDestroyed) {
            if (::eventBuffer.isInitialized) eventBuffer.flush()
        } else {
            if (::eventBuffer.isInitialized) eventBuffer.clear()
        }
        val currentRequestId = synchronized(this) {
            eventSource?.cancel()
            eventSource = null
            val id = requestId
            requestId = null
            id
        }
        currentRequestId?.let { NetworkInspector.reportResponseEnd(it, totalBytesReceived.get()) }
    }

    override fun dispose() {
        Log.d(TAG, "Disposing NitroSse instance and cleaning up resources...")
        
        if (::eventBuffer.isInitialized) {
            eventBuffer.clearCallback()
        }
        
        isRunning.set(false)
        connectionAttemptVersion.incrementAndGet()
        
        networkMonitor?.stop()
        lifecycleManager?.stopObserving()
        
        try {
            val currentRequestId = synchronized(this) {
                eventSource?.cancel()
                eventSource = null
                val id = requestId
                requestId = null
                id
            }
            currentRequestId?.let { NetworkInspector.reportRequestFailed(it, true) }
        } catch (e: Exception) {
            Log.e(TAG, "Error during synchronous dispose: ${e.message}")
        }
        
        sseDispatcher?.removeCallbacksAndMessages(null)
        sseDispatcherThread?.quitSafely()
        sseDispatcherThread = null
        sseDispatcher = null
        
        super.dispose()
    }
}
