import Foundation
import NitroModules
import Network

/// NitroSse implements a high-performance SSE client for iOS using native Foundation URLSession.
///
/// Architectural Principles:
/// 1. Threading Serialization: All mutable state and operations are strictly serialized on a dedicated background dispatcher (`SseDispatcher`)
///    to eliminate data races and prevent blocking JS/UI threads.
/// 2. Mobile Lifecycle Hibernation: When entering background without background execution enabled, the connection is gracefully hibernated
///    (flushing pending events and stopping sockets) to comply with iOS background execution limits and conserve battery.
/// 3. Event Batching: Events are buffered and flushed in batches to minimize JSI bridge overhead.
/// 4. Versioned Connection Attempts: Reconnection attempts use `connectionAttemptVersion` counters to discard stale async callbacks.
class NitroSse: HybridNitroSseSpec {
    private let dispatcher: SseDispatcher

    public override init() {
        let queue = DispatchQueue(label: "com.margelo.nitro.sse", qos: .utility)
        let key = DispatchSpecificKey<Void>()
        queue.setSpecific(key: key, value: ())
        self.dispatcher = SseDispatchQueueDispatcher(queue: queue, queueKey: key)
        super.init()
    }

    internal init(dispatcher: SseDispatcher) {
        self.dispatcher = dispatcher
        super.init()
    }

    // MARK: - State
    
    private var eventSource: SseEventSource?
    private var config: SseConfig?
    /// Dynamic request interceptor decoupled from SseConfig (v3.0) to prevent JSI closure re-wrapping and retain leaks.
    private var requestInterceptor: (() -> Promise<Promise<Dictionary<String, String>>>)?
    private var isRunning: Bool = false
    private var isDisposed: Bool = false
    /// Indicates whether the JS Dispatcher/CallInvoker has been destroyed to prevent invoking dead callbacks.
    private var isDispatcherDestroyed: Bool = false
    internal var connectionAttemptVersion: Int = 0
    private var requestId: String? = nil
    internal var lastProcessedId: String? = nil
    private var currentState: SseState = .idle

    private var consecutiveAuthErrors: Int = 0
    private static let defaultMaxAuthRetries: Int = 3

    // MARK: - Metrics
    private var rawBytesReceived: Double = 0
    private var decompressedBytesReceived: Double? = nil
    private var sessionRawBytesBase: Double = 0
    private var currentTaskRawBytes: Double = 0
    private var sessionDecompressedBytesBase: Double = 0
    private var currentTaskDecompressedBytes: Double = 0
    private var totalBytesReceived: Double = 0
    private var chunksReceived: Double = 0
    private var lastStatusCode: Double? = nil

    private var totalEventsReceived: Double = 0
    private var commentsReceived: Double = 0
    private var linesParsed: Double = 0
    private var parseErrors: Double = 0
    private var serverRetryDelayMs: Double? = nil

    private var connectedAt: Double? = nil
    private var connectionAttemptStartTime: Double? = nil
    private var timeToFirstByteMs: Double? = nil
    private var lastEventTime: Double? = nil
    private var lastHeartbeatTime: Double? = nil
    private var lastActivityTime: Double = 0
    private var maxEventGapMs: Double = 0

    private var connectionAttempts: Double = 0
    private var reconnectCount: Double = 0
    private var isReconnecting: Bool = false
    private var lastReconnectDelayMs: Double? = nil
    private var disconnectReason: SseDisconnectReason? = nil
    private var currentAttemptHasParseError: Bool = false
    private var lastErrorTime: Double? = nil
    private var lastErrorCode: String? = nil

    private var wasRunningBeforeHibernation: Bool = false
    private var wasRunningBeforeNetworkLoss: Bool = false

    private class InterceptorCancellationToken {
        var isCancelled: Bool = false
    }
    private var currentInterceptorToken: InterceptorCancellationToken? = nil

    // MARK: - Collaborators
    
    private let eventBuffer = SseEventBuffer()
    private let reconnectStrategy = SseReconnectStrategy()
    private var networkMonitor: SseNetworkMonitor?
    private var lifecycleManager: SseLifecycleManager?

    // MARK: - Lifecycle

    /// Synchronously cleans up all active network sockets, timers, and lifecycle observers.
    func dispose() {
        let cleanup = {
            // Note: Thread safety on isDisposed is guaranteed without atomics because cleanup is serialized
            // on the underlying serial DispatchQueue (`dispatcher.sync`), acting as a mutex.
            guard !self.isDisposed else { return }
            self.isDisposed = true
            self.stopInternal(emitClosed: false)
            self.requestInterceptor = nil
            self.config = nil
            self.currentInterceptorToken?.isCancelled = true
            self.currentInterceptorToken = nil
            self.eventBuffer.clearCallback()
            self.eventBuffer.clear()
            self.networkMonitor?.stop()
            self.networkMonitor = nil
            // Serialized on dispatcher to prevent race conditions with background execution
            self.lifecycleManager?.stopObserving()
            self.lifecycleManager = nil
        }
        if dispatcher.isCurrentDispatcher() {
            cleanup()
        } else {
            dispatcher.sync(cleanup)
        }
    }

    deinit {
        // Synchronous cleanup is required during deallocation to avoid executing callbacks on deallocated instances.
        dispose()
    }

    // MARK: - HybridNitroSseSpec

    /// Configures the SSE client parameters, event buffer, backoff strategy, and lifecycle observers.
    /// In v3.0, `onBeforeRequest` is decoupled from `SseConfig` to keep `SseConfig` as a pure data struct,
    /// preventing closure re-wrapping and retain leaks across `copyWith` calls.
    func setup(
        config: SseConfig,
        onEvent: @escaping ((_ events: [SseEvent]) -> Void),
        onBeforeRequest: (() -> Promise<Promise<Dictionary<String, String>>>)? = nil
    ) throws {
        dispatcher.async {
            self.config = config
            self.requestInterceptor = onBeforeRequest
            self.sessionRawBytesBase = 0
            self.currentTaskRawBytes = 0
            self.sessionDecompressedBytesBase = 0
            self.currentTaskDecompressedBytes = 0
            self.rawBytesReceived = 0
            self.decompressedBytesReceived = nil
            if self.lastProcessedId == nil {
                self.lastProcessedId = config.headers?.first {
                    $0.key.caseInsensitiveCompare("Last-Event-Id") == .orderedSame
                }?.value
            }
            
            self.eventBuffer.configure(
                batchingIntervalMs: config.batchingIntervalMs ?? 0,
                maxBufferSize: config.maxBufferSize ?? 1000,
                dispatcher: self.dispatcher,
                onFlush: onEvent
            )
            
            self.reconnectStrategy.configure(
                retryIntervalMs: config.retryIntervalMs,
                maxRetryIntervalMs: config.maxRetryIntervalMs,
                jitterFactor: config.jitterFactor,
                maxReconnectAttempts: config.maxReconnectAttempts
            )
            
            self.lifecycleManager?.stopObserving()
            self.lifecycleManager = SseLifecycleManager(
                dispatcher: self.dispatcher,
                onBackground: { [weak self] in self?.handleAppDidEnterBackground() },
                onForeground: { [weak self] in self?.handleAppWillEnterForeground() }
            )
            self.lifecycleManager?.startObserving()
            
            if config.monitorNetwork != false {
                self.startNetworkMonitoring()
            } else {
                self.stopNetworkMonitoring()
            }
        }
    }

    /// Sets the Last-Event-ID header to resume streaming from a specific event boundary.
    func setLastProcessedId(id: String) {
        dispatcher.async {
            self.lastProcessedId = id
        }
    }

    /// Updates active HTTP headers for subsequent request attempts (e.g. updating authorization tokens).
    func updateHeaders(headers: [String: String]) throws {
        dispatcher.async {
            guard let config = self.config else { return }
            var merged = config.headers ?? [:]
            for (k, v) in headers {
                merged[k] = v
            }
            self.config = config.copyWith(headers: merged)
            print("[NitroSse] Headers updated for subsequent connections.")
        }
    }

    /// Fetches runtime metrics synchronously on the dispatcher to avoid data races.
    func getStats() throws -> SseStats {
        return dispatcher.sync {
            return SseStats(
                rawBytesReceived: rawBytesReceived,
                decompressedBytesReceived: decompressedBytesReceived,
                totalBytesReceived: totalBytesReceived,
                chunksReceived: chunksReceived,
                lastStatusCode: lastStatusCode,
                totalEventsReceived: totalEventsReceived,
                commentsReceived: commentsReceived,
                linesParsed: linesParsed,
                parseErrors: parseErrors,
                serverRetryDelayMs: serverRetryDelayMs,
                connectedAt: connectedAt,
                timeToFirstByteMs: timeToFirstByteMs,
                lastEventTime: lastEventTime,
                lastHeartbeatTime: lastHeartbeatTime,
                maxEventGapMs: maxEventGapMs,
                eventsBuffered: Double(eventBuffer.eventsBuffered),
                peakBufferedEvents: Double(eventBuffer.peakBufferedEvents),
                bufferFlushCount: Double(eventBuffer.bufferFlushCount),
                bufferOverflowCount: Double(eventBuffer.bufferOverflowCount),
                connectionAttempts: connectionAttempts,
                reconnectCount: reconnectCount,
                lastReconnectDelayMs: lastReconnectDelayMs,
                disconnectReason: disconnectReason,
                lastErrorTime: lastErrorTime,
                lastErrorCode: lastErrorCode
            )
        }
    }

    /// Fetches the current connection state synchronously on the dispatcher to avoid data races.
    func getState() throws -> SseState {
        return dispatcher.sync {
            return currentState
        }
    }

    private func updateState(_ newState: SseState) {
        dispatcher.assertOnQueue()
        if self.currentState != newState {
            self.currentState = newState
            self.eventBuffer.push(SseEvent(type: .state, data: nil, parsedData: nil, id: nil, event: nil, message: nil, statusCode: nil, retry: nil, state: newState))
            // State events represent immediate connection lifecycle transitions and must be flushed
            // to JS immediately to prevent UI and React hook state desynchronization.
            self.eventBuffer.flush()
        }
    }

    /// Begins connection establishment and resets retry counters.
    /// If the client is currently in a backoff reconnection delay, start() acts as an immediate "Retry Now",
    /// resetting the retry strategy and establishing connection immediately.
    func start() throws {
        let startBody = {
            if self.isRunning {
                if self.currentState == .reconnecting {
                    print("[NitroSse] start() invoked while reconnecting. Resetting backoff and retrying immediately.")
                    self.reconnectStrategy.reset()
                    self.consecutiveAuthErrors = 0
                    // Note: Incrementing connectionAttemptVersion invalidates in-flight callbacks from the prior attempt.
                    // `establishConnection` will cancel `currentInterceptorToken`. If an older JS interceptor Promise is still
                    // running in JS runtime, its eventual completion will be dropped when comparing versions.
                    self.connectionAttemptVersion += 1
                    self.updateState(.connecting)
                    self.establishConnection(attemptVersion: self.connectionAttemptVersion)
                }
                return
            }
            
            guard self.config != nil else {
                throw RuntimeError("NitroSse not configured. Call setup() first.")
            }
            
            self.isRunning = true
            self.isDispatcherDestroyed = false
            self.consecutiveAuthErrors = 0
            self.reconnectStrategy.reset()
            self.connectionAttemptVersion += 1
            self.updateState(.connecting)
            let version = self.connectionAttemptVersion
            
            self.establishConnection(attemptVersion: version)
        }

        if dispatcher.isCurrentDispatcher() {
            try startBody()
        } else {
            try dispatcher.sync(startBody)
        }
    }

    /// Stops active network streaming and invalidates pending reconnection timers by incrementing attempt version.
    func stop() {
        let task = {
            if self.isRunning {
                self.disconnectReason = .userStop
            }
            self.connectionAttemptVersion += 1
            self.stopInternal()
        }
        if dispatcher.isCurrentDispatcher() {
            task()
        } else {
            dispatcher.async(task)
        }
    }

    /// Immediately flushes all buffered events to JavaScript via the bridge callback.
    func flush() {
        dispatcher.async {
            self.eventBuffer.flush()
        }
    }

    /// Teardown existing connection and initiate a new request attempt.
    func restart() {
        let task = {
            guard self.config != nil else { return }
            self.stopInternal(emitClosed: false)
            self.isRunning = true
            self.requestId = nil
            self.connectionAttemptVersion += 1
            self.updateState(.reconnecting)
            self.establishConnection(attemptVersion: self.connectionAttemptVersion)
        }
        if dispatcher.isCurrentDispatcher() {
            task()
        } else {
            dispatcher.async(task)
        }
    }

    /// Indicates whether the client is currently running or reconnecting.
    func isConnected() -> Bool {
        return dispatcher.sync {
            return isRunning
        }
    }

    // MARK: - Network Monitoring

    private func startNetworkMonitoring() {
        dispatcher.assertOnQueue()
        guard networkMonitor == nil else { return }
        
        let monitor = SseNetworkMonitor(dispatcher: dispatcher) { [weak self] isSatisfied, interfaceChanged, interfaceType in
            self?.handleNetworkChange(isSatisfied: isSatisfied, interfaceChanged: interfaceChanged, interfaceType: interfaceType)
        }
        self.networkMonitor = monitor
        monitor.start()
    }
    
    private func stopNetworkMonitoring() {
        dispatcher.assertOnQueue()
        networkMonitor?.stop()
        networkMonitor = nil
    }

    private func handleNetworkChange(isSatisfied: Bool, interfaceChanged: Bool, interfaceType: NWInterface.InterfaceType?) {
        dispatcher.assertOnQueue()
        
        if isSatisfied {
            if wasRunningBeforeNetworkLoss {
                print("[NitroSse] Network restored. Resuming stream.")
                wasRunningBeforeNetworkLoss = false
                if lifecycleManager?.isAppInBackground == true && self.config?.backgroundExecution != true {
                    self.wasRunningBeforeHibernation = true
                } else if isRunning {
                    self.restart()
                } else {
                    try? self.start()
                }
            } else if isRunning {
                if interfaceChanged {
                    print("[NitroSse] Network interface changed. Restarting stream.")
                    self.restart()
                }
            }
        } else {
            if isRunning {
                print("[NitroSse] Network lost. Hibernating.")
                wasRunningBeforeNetworkLoss = true
                self.updateState(.paused)
                self.hibernateConnection()
            }
        }
    }

    // MARK: - App Lifecycle Handling

    private func handleAppDidEnterBackground() {
        dispatcher.assertOnQueue()
        guard self.isRunning, let config = self.config else { return }
        
        if config.backgroundExecution == true {
            print("[NitroSse] App backgrounded. backgroundExecution is true, keeping connection alive.")
            self.lifecycleManager?.beginBackgroundKeepAlive { [weak self] in
                guard let self = self, self.isRunning else { return }
                print("[NitroSse] Background task expired. Hibernating now.")
                self.wasRunningBeforeHibernation = true
                self.updateState(.paused)
                self.hibernateConnection()
            }
            return
        }
        
        self.wasRunningBeforeHibernation = true
        self.updateState(.paused)
        self.hibernateConnection()
    }

    private func handleAppWillEnterForeground() {
        dispatcher.assertOnQueue()
        if self.wasRunningBeforeHibernation {
            self.wasRunningBeforeHibernation = false
            let isOnline = self.networkMonitor?.isPathSatisfied ?? true
            if isOnline {
                print("[NitroSse] App foregrounded. Resuming stream.")
                try? self.start()
            } else {
                print("[NitroSse] App foregrounded while offline. Handing over intent to network monitor.")
                self.wasRunningBeforeNetworkLoss = true
            }
        }
    }

    private func finishActiveRequestInspector() {
        if let rid = self.requestId {
            NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(self.totalBytesReceived))
            self.requestId = nil
        }
    }

    private func hibernateConnection() {
        dispatcher.assertOnQueue()
        guard self.isRunning else { return }
        
        print("[NitroSse] Hibernating NitroSse connection.")
        
        self.connectionAttemptVersion += 1
        self.currentInterceptorToken?.isCancelled = true
        self.currentInterceptorToken = nil
        
        self.eventBuffer.flush()
        
        self.eventSource?.stop()
        self.eventSource = nil
        self.finishActiveRequestInspector()
        self.isRunning = false
        
        self.lifecycleManager?.cleanupBackgroundTask()
    }

    // MARK: - Connection

    /// Initiates an SSE connection attempt, invoking `onBeforeRequest` interceptor if configured.
    /// Ignores stale calls where `attemptVersion` no longer matches `self.connectionAttemptVersion`.
    private func establishConnection(attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard isRunning, let config = config, attemptVersion == self.connectionAttemptVersion else { return }

        if let interceptor = self.requestInterceptor {
            self.currentInterceptorToken?.isCancelled = true
            let token = InterceptorCancellationToken()
            self.currentInterceptorToken = token
            
            // Await async JS interceptor (with timeout guard) before creating connection.
            let capturedConfig = config
            // Reference-type completion flag to prevent races between interceptor promise resolution and connection timeout.
            class CompletionFlag {
                var isCompleted = false
            }
            let flag = CompletionFlag()
            let timeoutMs = capturedConfig.connectionTimeoutMs ?? 15000.0
            
            // Recovers execution state if JS async interceptor fails to settle within connectionTimeoutMs.
            dispatcher.asyncAfter(delay: (timeoutMs / 1000.0)) { [weak self] in
                guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion, !token.isCancelled else { return }
                if !flag.isCompleted {
                    flag.isCompleted = true
                    token.isCancelled = true
                    let error = NSError(domain: "NitroSse", code: -1, userInfo: [NSLocalizedDescriptionKey: "onBeforeRequest interceptor timed out after \(timeoutMs) ms"])
                    self.handleInterceptorError(error, attemptVersion: attemptVersion)
                }
            }

            let safeHandleError: (Error) -> Void = { [weak self] error in
                self?.dispatcher.async { [weak self] in
                    guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion, !token.isCancelled else { return }
                    if !flag.isCompleted {
                        flag.isCompleted = true
                        token.isCancelled = true
                        self.handleInterceptorError(error, attemptVersion: attemptVersion)
                    }
                }
            }

            interceptor().then { [weak self] promise2 in
                promise2.then { [weak self] newHeaders in
                    self?.dispatcher.async { [weak self] in
                        guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion, !token.isCancelled else { return }
                        if !flag.isCompleted {
                            flag.isCompleted = true
                            token.isCancelled = true
                            let baseConfig = self.config ?? capturedConfig
                            var mergedHeaders = baseConfig.headers ?? [:]
                            for (k, v) in newHeaders {
                                mergedHeaders[k] = v
                            }
                            let connectionConfig = baseConfig.copyWith(headers: mergedHeaders)
                            self.performEstablishConnection(attemptVersion: attemptVersion, connectionConfig: connectionConfig)
                        }
                    }
                }.catch(safeHandleError)
            }.catch(safeHandleError)
        } else {
            self.performEstablishConnection(attemptVersion: attemptVersion, connectionConfig: nil)
        }
    }

    private func handleInterceptorError(_ error: Error, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
        let desc = error.localizedDescription
        // react-native-nitro-modules throws a generic std::runtime_error from C++ when the Dispatcher is destroyed.
        // Message inspection is required as no specialized exception type is surfaced to Swift.
        if desc.contains("Dispatcher has already been destroyed") {
            print("[NitroSse] JS Dispatcher destroyed. Disposing NitroSse instance.")
            self.isDispatcherDestroyed = true
            self.dispose()
            return
        }

        self.consecutiveAuthErrors += 1
        let limit = Int(self.config?.maxAuthRetries ?? Double(Self.defaultMaxAuthRetries))
        if self.consecutiveAuthErrors > limit {
            self.failAndStop(message: "Auth retry limit reached (\(limit)). Stopping.", statusCode: -1)
            return
        }

        self.eventBuffer.push(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Interceptor Error: \(error.localizedDescription)", statusCode: -1, retry: nil, state: nil))
        self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
    }

    private func performEstablishConnection(attemptVersion: Int, connectionConfig: SseConfig? = nil) {
        dispatcher.assertOnQueue()
        let activeConfig = connectionConfig ?? self.config
        guard isRunning, let config = activeConfig, attemptVersion == self.connectionAttemptVersion else { return }
        let targetUrlString = config.url
        guard let url = URL(string: targetUrlString), let scheme = url.scheme, ["http", "https"].contains(scheme.lowercased()) else {
            print("[NitroSse] Invalid SSE URL: \(targetUrlString)")
            self.failAndStop(message: "Invalid URL: \(targetUrlString)", statusCode: -1)
            return
        }
        
        self.connectionAttempts += 1
        self.connectionAttemptStartTime = Date().timeIntervalSince1970 * 1000
        self.timeToFirstByteMs = nil
        self.currentAttemptHasParseError = false
        
        self.updateState(.connecting)
        self.finishActiveRequestInspector()
        
        let es = SseConnectionHandler.createEventSource(
            url: url,
            config: config,
            lastProcessedId: lastProcessedId,
            delegate: self,
            attemptVersion: attemptVersion,
            dispatcher: dispatcher
        )
        self.eventSource = es
        
        var request = URLRequest(url: url)
        request.httpMethod = config.method?.stringValue.uppercased() ?? "GET"
        request.allHTTPHeaderFields = config.headers
        if let body = config.body {
            request.httpBody = body.data(using: .utf8)
        }
        // Injected explicitly so lastProcessedId outlives EventSource recreation.
        if let lastId = lastProcessedId, !lastId.isEmpty {
            request.setValue(lastId, forHTTPHeaderField: "Last-Event-ID")
        }
        self.requestId = NitroSseNetworkInspector.reportRequestStart(request, encodedDataLength: 0)
    }

    // MARK: - Stop / Reconnect

    private func flushTaskBytes() {
        self.sessionRawBytesBase += self.currentTaskRawBytes
        self.currentTaskRawBytes = 0
        if self.decompressedBytesReceived != nil {
            self.sessionDecompressedBytesBase += self.currentTaskDecompressedBytes
            self.currentTaskDecompressedBytes = 0
        }
    }

    private func stopInternal(emitClosed: Bool = true) {
        dispatcher.assertOnQueue()
        self.connectedAt = nil
        self.flushTaskBytes()
        self.isReconnecting = false
        self.isRunning = false
        if emitClosed && !isDispatcherDestroyed && self.currentState != .failed {
            self.updateState(.closed)
        }
        if isDispatcherDestroyed {
            eventBuffer.clear()
        }
        self.wasRunningBeforeNetworkLoss = false
        self.wasRunningBeforeHibernation = false
        self.currentInterceptorToken?.isCancelled = true
        self.currentInterceptorToken = nil
        self.eventSource?.stop()
        self.eventSource = nil
        self.finishActiveRequestInspector()
        self.reconnectStrategy.reset()
        self.lifecycleManager?.cleanupBackgroundTask()
    }

    private func failAndStop(message: String, statusCode: Double? = nil) {
        dispatcher.assertOnQueue()
        self.connectionAttemptVersion += 1
        self.eventBuffer.push(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: message, statusCode: statusCode, retry: nil, state: nil))
        self.updateState(.failed)
        self.stopInternal()
    }

    /// Reconnects with exponential backoff coordinated externally via SseDispatcher and attemptVersion.
    private func scheduleAutomaticReconnect(isError: Bool, fixedDelay: TimeInterval? = nil, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard isRunning, attemptVersion == self.connectionAttemptVersion else { return }

        if reconnectStrategy.hasReachedMaxAttempts() {
            let maxAttempts = Int(config?.maxReconnectAttempts ?? -1.0)
            print("[NitroSse] Max reconnection attempts reached (\(maxAttempts)). Stopping.")
            failAndStop(message: "Max reconnection attempts reached (\(maxAttempts)).")
            return
        }

        let delay: TimeInterval
        if let customDelay = fixedDelay {
            reconnectStrategy.recordAttempt()
            delay = customDelay
        } else {
            delay = reconnectStrategy.nextDelay(isError: isError)
        }
        self.lastReconnectDelayMs = delay * 1000.0

        // Increment connectionAttemptVersion before stopping eventSource to invalidate any in-flight
        // or asynchronous onError/onClosed callbacks triggered during shutdown/teardown.
        self.connectionAttemptVersion += 1
        let newVersion = self.connectionAttemptVersion
        self.isReconnecting = true
        self.updateState(.reconnecting)
        eventSource?.stop()
        eventSource = nil
        dispatcher.asyncAfter(delay: delay) { [weak self] in
            guard let self = self, self.isRunning, newVersion == self.connectionAttemptVersion else { return }
            self.establishConnection(attemptVersion: newVersion)
        }
    }
}

// MARK: - SseConnectionDelegate

extension NitroSse: SseConnectionDelegate {
    func connectionDidOpen(response: HTTPURLResponse, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard attemptVersion == self.connectionAttemptVersion else { return }
        self.reconnectStrategy.reset()
        self.consecutiveAuthErrors = 0
        if self.isReconnecting || self.currentState == .reconnecting {
            self.reconnectCount += 1
            self.isReconnecting = false
        }
        self.updateState(.open)
        self.lastStatusCode = Double(response.statusCode)
        self.connectedAt = Date().timeIntervalSince1970 * 1000
        
        var headersDict: [String: String] = [:]
        for (k, v) in response.allHeaderFields {
            headersDict["\(k)"] = "\(v)"
        }
        
        NitroSseNetworkInspector.reportResponseStart(
            self.requestId,
            url: response.url?.absoluteString ?? self.config?.url,
            response: response,
            statusCode: response.statusCode,
            headers: headersDict
        )
        
        // WHATWG SSE spec: HTTP response headers are not exposed to client JS event listeners (`open` event only carries statusCode).
        self.eventBuffer.push(SseEvent(type: .open, data: nil, parsedData: nil, id: nil, event: nil, message: nil, statusCode: Double(response.statusCode), retry: nil, state: nil))
    }
    
    func connectionDidReceiveDataChunk(chunkLength: Int, rawWireBytes: Int64, decompressedBytes: Int64?, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard attemptVersion == self.connectionAttemptVersion else { return }
        self.chunksReceived += 1
        self.currentTaskRawBytes = Double(rawWireBytes)
        self.rawBytesReceived = self.sessionRawBytesBase + self.currentTaskRawBytes
        if let decomp = decompressedBytes {
            self.currentTaskDecompressedBytes = Double(decomp)
            self.decompressedBytesReceived = self.sessionDecompressedBytesBase + self.currentTaskDecompressedBytes
        }
        if self.timeToFirstByteMs == nil, let start = self.connectionAttemptStartTime {
            self.timeToFirstByteMs = (Date().timeIntervalSince1970 * 1000) - start
        }
    }
    
    func connectionDidParseLines(count: Int, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard attemptVersion == self.connectionAttemptVersion else { return }
        self.linesParsed += Double(count)
    }
    
    func connectionDidEncounterParseError(attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard attemptVersion == self.connectionAttemptVersion else { return }
        self.parseErrors += 1
        self.currentAttemptHasParseError = true
        self.disconnectReason = .parserError
    }
    
    func connectionDidClose(attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard attemptVersion == self.connectionAttemptVersion else { return }
        self.connectedAt = nil
        self.flushTaskBytes()
        self.finishActiveRequestInspector()
        if self.isRunning {
            self.scheduleAutomaticReconnect(isError: false, attemptVersion: attemptVersion)
        }
    }
    
    func connectionDidReceiveMessage(eventType: String, data: String, lastEventId: String, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard attemptVersion == self.connectionAttemptVersion else { return }
        let encodedDataSize = Double(data.utf8.count)
        // WHATWG SSE accounting:
        // - `message` is the default event type and is often omitted on the wire, so don't count it.
        // - id byte accounting is handled when id: is encountered to avoid duplicate counting.
        let eventTypeSize = (eventType.isEmpty || eventType == "message") ? 0.0 : Double(eventType.utf8.count)
        self.totalBytesReceived += encodedDataSize + eventTypeSize
        
        let newId = (lastEventId.isEmpty) ? nil : lastEventId
        if newId != self.lastProcessedId {
            if let idStr = newId {
                self.totalBytesReceived += Double(idStr.utf8.count)
            }
            self.lastProcessedId = newId
        }
        
        self.totalEventsReceived += 1
        let now = Date().timeIntervalSince1970 * 1000
        self.lastEventTime = now
        if self.lastActivityTime > 0 {
            let gap = now - self.lastActivityTime
            if gap > self.maxEventGapMs {
                self.maxEventGapMs = gap
            }
        }
        self.lastActivityTime = now
        
        let parsedData = (self.config?.autoParseJSON == true) ? SseEventBuffer.parseJsonToAnyMap(data) : nil
        
        self.eventBuffer.push(SseEvent(type: .message, data: data, parsedData: parsedData, id: lastEventId, event: eventType, message: nil, statusCode: 200, retry: nil, state: nil))
    }
    
    func connectionDidReceiveComment(_ comment: String, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard attemptVersion == self.connectionAttemptVersion else { return }
        self.totalBytesReceived += Double(comment.utf8.count)
        self.commentsReceived += 1
        let now = Date().timeIntervalSince1970 * 1000
        self.lastHeartbeatTime = now
        if self.lastActivityTime > 0 {
            let gap = now - self.lastActivityTime
            if gap > self.maxEventGapMs {
                self.maxEventGapMs = gap
            }
        }
        self.lastActivityTime = now
        // TODO(breaking-change): In next major version, avoid pushing HEARTBEAT event across JSI; use internal watchdog or dedicated onHeartbeat callback to eliminate bridge overhead.
        self.eventBuffer.push(SseEvent(type: .heartbeat, data: nil, parsedData: nil, id: nil, event: nil, message: comment, statusCode: nil, retry: nil, state: nil))
    }
    
    func connectionDidReceiveRetry(retryMs: Int64, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard attemptVersion == self.connectionAttemptVersion else { return }
        self.serverRetryDelayMs = Double(retryMs)
        self.reconnectStrategy.updateRetryInterval(Double(retryMs))
    }
    
    func connectionDidUpdateLastEventId(id: String?, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
        let newId = (id?.isEmpty == false) ? id : nil
        if let idStr = newId, idStr != self.lastProcessedId {
            self.totalBytesReceived += Double(idStr.utf8.count)
        }
        self.lastProcessedId = newId
    }

    func connectionDidFail(error: Error, response: HTTPURLResponse?, errorBody: String?, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
        
        self.connectedAt = nil
        self.flushTaskBytes()
        let nsError = error as NSError
        // Decouple HTTP status code (meaningful only for HTTP 4xx/5xx/204) from transport and parser error codes
        let httpStatusCode: Int? = {
            if let resp = response, resp.statusCode >= 400 || resp.statusCode == 204 {
                return resp.statusCode
            }
            if nsError.code >= 100 && nsError.code < 600 {
                return nsError.code
            }
            return nil
        }()
        
        let reportedStatusCode: Int = httpStatusCode ?? nsError.code
        let isParserLimit = (nsError.domain == "NitroSse" && (nsError.code == -2001 || nsError.code == -2002 || nsError.code == -2003))
        
        if let resp = response {
            self.lastStatusCode = Double(resp.statusCode)
        }
        
        if isParserLimit || self.currentAttemptHasParseError {
            self.disconnectReason = .parserError
        } else if let http = httpStatusCode, http >= 400 || http == 204 {
            self.disconnectReason = .serverError
        } else if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut {
            self.disconnectReason = .timeout
        } else if nsError.localizedDescription.lowercased().contains("timed out") {
            self.disconnectReason = .timeout
        } else if nsError.domain == NSURLErrorDomain && (
            nsError.code == NSURLErrorNotConnectedToInternet ||
            nsError.code == NSURLErrorNetworkConnectionLost ||
            nsError.code == NSURLErrorCannotFindHost ||
            nsError.code == NSURLErrorCannotConnectToHost ||
            nsError.code == NSURLErrorDNSLookupFailed ||
            nsError.code == NSURLErrorInternationalRoamingOff ||
            nsError.code == NSURLErrorCallIsActive ||
            nsError.code == NSURLErrorDataNotAllowed
        ) {
            self.disconnectReason = .networkError
        } else {
            self.disconnectReason = .networkError
        }
        
        self.lastErrorTime = Date().timeIntervalSince1970 * 1000
        if let http = httpStatusCode {
            self.lastErrorCode = "\(nsError.domain)(\(http))"
        } else {
            self.lastErrorCode = "\(nsError.domain)(\(nsError.code))"
        }

        // Only report response start to inspector if an actual HTTP error response arrived (200 is reported in connectionDidOpen)
        if let http = httpStatusCode {
            var headersDict: [String: String] = [:]
            if let headers = response?.allHeaderFields {
                for (k, v) in headers {
                    headersDict["\(k)"] = "\(v)"
                }
            }
            NitroSseNetworkInspector.reportResponseStart(
                self.requestId,
                url: response?.url?.absoluteString ?? self.config?.url,
                response: response,
                statusCode: http,
                headers: headersDict
            )
        }
        NitroSseNetworkInspector.reportRequestFailed(self.requestId, cancelled: false)
        self.requestId = nil
        
        // WHATWG EventSource Section 7: HTTP 204 No Content explicitly terminates stream across platforms.
        if httpStatusCode == 204 {
            self.failAndStop(message: "No Content (204). Stopping.", statusCode: 204)
            return
        }

        // Strict WHATWG SSE: permanently close without reconnecting on non-event-stream Content-Type.
        let rawContentType = response?.value(forHTTPHeaderField: "Content-Type") ?? (response?.allHeaderFields["Content-Type"] as? String) ?? ""
        let mimeType = rawContentType.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        let isInvalidContentType = (nsError.domain == "NitroSse" && nsError.code == -2001) ||
            (response != nil && response!.statusCode >= 200 && response!.statusCode < 300 && mimeType != "text/event-stream")
        if isInvalidContentType {
            self.failAndStop(message: "Invalid Content-Type: expected text/event-stream. Stopping.", statusCode: Double(reportedStatusCode))
            return
        }

        // Parser resource violations (-2002 line length, -2003 event data size) are fatal and must not reconnect
        let isParserLimitError = (nsError.domain == "NitroSse" && (nsError.code == -2002 || nsError.code == -2003))
        if isParserLimitError {
            self.failAndStop(message: nsError.localizedDescription, statusCode: Double(reportedStatusCode))
            return
        }

        // HTTP 401/403 Auth errors trigger token refresh via onBeforeRequest interceptor up to maxAuthRetries.
        let limit = Int(self.config?.maxAuthRetries ?? Double(Self.defaultMaxAuthRetries))
        if let http = httpStatusCode, (http == 401 || http == 403) {
            if self.requestInterceptor == nil {
                self.failAndStop(message: "Auth Error (\(http)) - No interceptor provided. Stopping.", statusCode: Double(http))
                return
            }

            self.consecutiveAuthErrors += 1
            if self.consecutiveAuthErrors > limit {
                self.failAndStop(message: "Auth Error (\(http)) - Retry limit reached (\(limit)). Stopping.", statusCode: Double(http))
                return
            }
            
            self.eventBuffer.push(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Auth Error (\(http)) - Retry \(self.consecutiveAuthErrors)/\(limit). Refreshing token...", statusCode: Double(http), retry: nil, state: nil))
            self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
            return
        }

        let isFatal = (httpStatusCode != nil && httpStatusCode! >= 400 && httpStatusCode! <= 499 && httpStatusCode! != 401 && httpStatusCode! != 403 && httpStatusCode! != 408 && httpStatusCode! != 429)
        if isFatal, let fatalHttp = httpStatusCode {
            let bodyText = errorBody?.trimmingCharacters(in: .whitespacesAndNewlines)
            let fatalMessage = (bodyText?.isEmpty == false) ? "Fatal Error (\(fatalHttp)): \(bodyText!)" : "Fatal Error (\(fatalHttp)). Stopping."
            self.failAndStop(message: fatalMessage, statusCode: Double(fatalHttp))
            return
        }

        // HTTP 429 Rate Limit / 503 Service Unavailable: Honor server Retry-After delay with randomized jitter to prevent thundering herd.
        let retryAfterSeconds = response.flatMap { SseReconnectStrategy.extractRetryAfterSeconds(from: $0) } ?? SseReconnectStrategy.extractRetryAfterSeconds(from: error)
        
        if let http = httpStatusCode, (http == 429 || http == 503), let retryAfter = retryAfterSeconds {
            let maxInterval = (self.config?.maxRetryIntervalMs ?? 30000.0) / 1000.0
            let boundedRetryAfter = max(0.0, min(retryAfter, maxInterval))
            let jitter = Double.random(in: 0.5...1.5)
            let totalDelay = boundedRetryAfter + jitter
            self.eventBuffer.push(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Retry-After received: \(Int(totalDelay))s", statusCode: Double(http), retry: totalDelay * 1000.0, state: nil))
            self.scheduleAutomaticReconnect(isError: true, fixedDelay: totalDelay, attemptVersion: attemptVersion)
            return
        }

        // HTTP 429 without Retry-After: Fallback to exponential backoff rather than stopping permanently,
        // as rate limits are transient and recoverable.
        if httpStatusCode == 429 {
            self.eventBuffer.push(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Rate Limited (429). Retrying with backoff...", statusCode: 429, retry: nil, state: nil))
            self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
            return
        }

        // Map request timeout to stale state before initiating reconnect.
        let isTimeout = (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut) || reportedStatusCode == -1001
        if isTimeout {
            self.updateState(.stale)
        }

        let defaultErrorMsg: String = {
            if let http = httpStatusCode, http >= 500, let bodyText = errorBody?.trimmingCharacters(in: .whitespacesAndNewlines), !bodyText.isEmpty {
                return "Server Error (\(http)): \(bodyText)"
            }
            return error.localizedDescription
        }()
        self.eventBuffer.push(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: defaultErrorMsg, statusCode: Double(reportedStatusCode), retry: nil, state: nil))
        self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
    }
}
