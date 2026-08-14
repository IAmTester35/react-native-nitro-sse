import Foundation
import NitroModules
import LDSwiftEventSource
import Network

/// NitroSse implements a high-performance SSE client for iOS using LDSwiftEventSource.
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
    
    private var eventSource: EventSource?
    private var config: SseConfig?
    private var isRunning: Bool = false
    private var isDispatcherDestroyed: Bool = false
    internal var connectionAttemptVersion: Int = 0
    private var requestId: String? = nil
    private var lastProcessedId: String? = nil
    private var currentState: SseState = .idle

    private var consecutiveAuthErrors: Int = 0
    private let maxAuthRetries: Int = 3

    private var totalBytesReceived: Double = 0
    private var reconnectCount: Double = 0
    private var lastErrorTime: Double? = nil
    private var lastErrorCode: String? = nil

    private var wasRunningBeforeHibernation: Bool = false
    private var wasRunningBeforeNetworkLoss: Bool = false

    // MARK: - Collaborators
    
    private let eventBuffer = SseEventBuffer()
    private let reconnectStrategy = SseReconnectStrategy()
    private var networkMonitor: SseNetworkMonitor?
    private var lifecycleManager: SseLifecycleManager?

    // MARK: - Lifecycle

    deinit {
        // Synchronous cleanup is required during deallocation to avoid executing callbacks on deallocated instances.
        if dispatcher.isCurrentDispatcher() {
            self.stopInternal()
            self.networkMonitor?.stop()
        } else {
            dispatcher.sync {
                self.stopInternal()
                self.networkMonitor?.stop()
            }
        }
        lifecycleManager?.stopObserving()
    }

    // MARK: - HybridNitroSseSpec

    /// Configures the SSE client parameters, event buffer, backoff strategy, and lifecycle observers.
    func setup(config: SseConfig, onEvent: @escaping ((_ events: [SseEvent]) -> Void)) throws {
        dispatcher.async {
            self.config = config
            
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

    /// Replaces active HTTP headers for subsequent request attempts (e.g. updating authorization tokens).
    func updateHeaders(headers: [String: String]) throws {
        dispatcher.async {
            guard let config = self.config else { return }
            self.config = config.copyWith(headers: headers)
            print("[NitroSse] Headers updated for subsequent connections.")
        }
    }

    /// Fetches runtime metrics synchronously on the dispatcher to avoid data races.
    func getStats() throws -> SseStats {
        return dispatcher.sync {
            return SseStats(
                totalBytesReceived: totalBytesReceived,
                reconnectCount: reconnectCount,
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
        }
    }

    /// Begins connection establishment and resets retry counters.
    func start() throws {
        let startBody = {
            guard !self.isRunning else { return }
            
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
        dispatcher.async {
            self.connectionAttemptVersion += 1
            self.stopInternal()
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
        dispatcher.async {
            guard self.config != nil else { return }
            self.stopInternal(emitClosed: false)
            self.isRunning = true
            self.requestId = nil
            self.connectionAttemptVersion += 1
            self.updateState(.reconnecting)
            self.establishConnection(attemptVersion: self.connectionAttemptVersion)
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
                print("[NitroSse] Background task expired. Hibernating now.")
                self?.updateState(.paused)
                self?.hibernateConnection()
            }
            return
        }
        
        self.updateState(.paused)
        self.hibernateConnection()
    }

    private func handleAppWillEnterForeground() {
        dispatcher.assertOnQueue()
        if self.wasRunningBeforeHibernation {
            print("[NitroSse] App foregrounded. Resuming stream.")
            self.wasRunningBeforeHibernation = false
            try? self.start()
        }
    }

    private func hibernateConnection() {
        dispatcher.assertOnQueue()
        guard self.isRunning else { return }
        
        self.wasRunningBeforeHibernation = true
        print("[NitroSse] Hibernating NitroSse connection.")
        
        self.eventBuffer.flush()
        
        self.eventSource?.stop()
        self.eventSource = nil
        if let rid = self.requestId {
            NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(self.totalBytesReceived))
            self.requestId = nil
        }
        self.isRunning = false
        
        self.lifecycleManager?.cleanupBackgroundTask()
    }

    // MARK: - Connection

    /// Initiates an SSE connection attempt, invoking `onBeforeRequest` interceptor if configured.
    /// Ignores stale calls where `attemptVersion` no longer matches `self.connectionAttemptVersion`.
    private func establishConnection(attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard isRunning, let config = config, attemptVersion == self.connectionAttemptVersion else { return }

        if let interceptor = config.onBeforeRequest {
            
            let capturedConfig = config
            // Reference-type completion flag to prevent races between interceptor promise resolution and connection timeout.
            class CompletionFlag {
                var isCompleted = false
            }
            let flag = CompletionFlag()
            let timeoutMs = capturedConfig.connectionTimeoutMs ?? 15000.0
            
            // Recovers execution state if JS async interceptor fails to settle within connectionTimeoutMs.
            dispatcher.asyncAfter(delay: (timeoutMs / 1000.0)) { [weak self] in
                guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
                if !flag.isCompleted {
                    flag.isCompleted = true
                    let error = NSError(domain: "NitroSse", code: -1, userInfo: [NSLocalizedDescriptionKey: "onBeforeRequest interceptor timed out after \(timeoutMs) ms"])
                    self.handleInterceptorError(error, attemptVersion: attemptVersion)
                }
            }

            interceptor().then { [weak self] promise2 in
                promise2.then { [weak self] newHeaders in
                    self?.dispatcher.async { [weak self] in
                        guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
                        if !flag.isCompleted {
                            flag.isCompleted = true
                            let currentConfig = self.config ?? capturedConfig
                            var mergedHeaders = currentConfig.headers ?? [:]
                            for (k, v) in newHeaders {
                                mergedHeaders[k] = v
                            }
                            self.config = currentConfig.copyWith(headers: mergedHeaders)
                            self.performEstablishConnection(attemptVersion: attemptVersion)
                        }
                    }
                }.catch { [weak self] error in
                    self?.dispatcher.async { [weak self] in
                        guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
                        if !flag.isCompleted {
                            flag.isCompleted = true
                            self.handleInterceptorError(error, attemptVersion: attemptVersion)
                        }
                    }
                }
            }.catch { [weak self] error in
                self?.dispatcher.async { [weak self] in
                    guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
                    if !flag.isCompleted {
                        flag.isCompleted = true
                        self.handleInterceptorError(error, attemptVersion: attemptVersion)
                    }
                }
            }
        } else {
            self.performEstablishConnection(attemptVersion: attemptVersion)
        }
    }

    private func handleInterceptorError(_ error: Error, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
        let desc = error.localizedDescription
        // react-native-nitro-modules throws a generic std::runtime_error from C++ when the Dispatcher is destroyed.
        // Message inspection is required as no specialized exception type is surfaced to Swift.
        if desc.contains("Dispatcher has already been destroyed") {
            print("[NitroSse] JS Dispatcher destroyed. Stopping SSE stream.")
            self.isDispatcherDestroyed = true
            self.stopInternal()
            return
        }
        self.eventBuffer.push(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Interceptor Error: \(error.localizedDescription)", statusCode: -1, retry: nil, state: nil))
        self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
    }

    private func performEstablishConnection(attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard isRunning, let config = config, let url = URL(string: config.url), attemptVersion == self.connectionAttemptVersion else { return }
        
        self.updateState(.connecting)
        
        if let rid = self.requestId {
            NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(self.totalBytesReceived))
            self.requestId = nil
        }
        
        let es = SseConnectionHandler.createEventSource(
            url: url,
            config: config,
            lastProcessedId: lastProcessedId,
            delegate: self,
            attemptVersion: attemptVersion,
            dispatcher: dispatcher
        )
        self.eventSource = es
        
        let request = URLRequest(url: url)
        self.requestId = NitroSseNetworkInspector.reportRequestStart(request, encodedDataLength: 0)
    }

    // MARK: - Stop / Reconnect

    private func stopInternal(emitClosed: Bool = true) {
        dispatcher.assertOnQueue()
        self.isRunning = false
        if emitClosed && !isDispatcherDestroyed && self.currentState != .failed {
            self.updateState(.closed)
        }
        if isDispatcherDestroyed {
            eventBuffer.clear()
        }
        self.wasRunningBeforeNetworkLoss = false
        self.wasRunningBeforeHibernation = false
        self.eventSource?.stop()
        self.eventSource = nil
        if let rid = self.requestId {
            NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(self.totalBytesReceived))
            self.requestId = nil
        }
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

    private func scheduleAutomaticReconnect(isError: Bool, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard isRunning, attemptVersion == self.connectionAttemptVersion else { return }

        if reconnectStrategy.hasReachedMaxAttempts() {
            let maxAttempts = Int(config?.maxReconnectAttempts ?? -1.0)
            print("[NitroSse] Max reconnection attempts reached (\(maxAttempts)). Stopping.")
            failAndStop(message: "Max reconnection attempts reached (\(maxAttempts)).")
            return
        }

        // Increment connectionAttemptVersion before stopping eventSource to invalidate any in-flight
        // or asynchronous onError/onClosed callbacks triggered during shutdown/teardown.
        self.connectionAttemptVersion += 1
        let newVersion = self.connectionAttemptVersion
        let safeDelay = reconnectStrategy.nextDelay(isError: isError)
        self.updateState(.reconnecting)
        eventSource?.stop()
        eventSource = nil
        dispatcher.asyncAfter(delay: safeDelay) { [weak self] in
            guard let self = self, self.isRunning, newVersion == self.connectionAttemptVersion else { return }
            self.establishConnection(attemptVersion: newVersion)
        }
    }

    private func scheduleAutomaticReconnectWithFixedDelay(_ delay: TimeInterval, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard isRunning, attemptVersion == self.connectionAttemptVersion else { return }

        if reconnectStrategy.hasReachedMaxAttempts() {
            let maxAttempts = Int(config?.maxReconnectAttempts ?? -1.0)
            print("[NitroSse] Max reconnection attempts reached (\(maxAttempts)). Stopping.")
            failAndStop(message: "Max reconnection attempts reached (\(maxAttempts)).")
            return
        }
        reconnectStrategy.recordAttempt()

        // Increment connectionAttemptVersion to discard stale callbacks from previous cycle
        self.connectionAttemptVersion += 1
        let newVersion = self.connectionAttemptVersion
        eventSource?.stop()
        eventSource = nil
        self.updateState(.reconnecting)
        dispatcher.asyncAfter(delay: delay) { [weak self] in
            guard let self = self, self.isRunning, newVersion == self.connectionAttemptVersion else { return }
            self.establishConnection(attemptVersion: newVersion)
        }
    }
}

// MARK: - SseConnectionDelegate

extension NitroSse: SseConnectionDelegate {
    func connectionDidOpen(attemptVersion: Int) {
        dispatcher.async { [weak self] in
            guard let self = self, attemptVersion == self.connectionAttemptVersion else { return }
            self.reconnectStrategy.reset()
            self.consecutiveAuthErrors = 0
            self.updateState(.open)
            
            NitroSseNetworkInspector.reportResponseStart(
                self.requestId,
                url: self.config?.url,
                response: nil,
                statusCode: 200,
                headers: self.config?.headers ?? [:]
            )
            
            self.eventBuffer.push(SseEvent(type: .open, data: nil, parsedData: nil, id: nil, event: nil, message: nil, statusCode: 200, retry: nil, state: nil))
        }
    }
    
    func connectionDidClose(attemptVersion: Int) {
        dispatcher.async { [weak self] in
            guard let self = self, attemptVersion == self.connectionAttemptVersion else { return }
            if let rid = self.requestId {
                NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(self.totalBytesReceived))
                self.requestId = nil
            }
            if self.isRunning {
                self.scheduleAutomaticReconnect(isError: false, attemptVersion: attemptVersion)
            }
        }
    }
    
    func connectionDidReceiveMessage(eventType: String, data: String, lastEventId: String, attemptVersion: Int) {
        dispatcher.async { [weak self] in
            guard let self = self, attemptVersion == self.connectionAttemptVersion else { return }
            let encodedDataSize = Double(data.utf8.count)
            let metadataSize = Double(eventType.utf8.count) + Double(lastEventId.utf8.count)
            self.totalBytesReceived += encodedDataSize + metadataSize
            
            if !lastEventId.isEmpty {
                self.lastProcessedId = lastEventId
            }
            
            let parsedData = (self.config?.autoParseJSON == true) ? SseEventBuffer.parseJsonToAnyMap(data) : nil
            
            self.eventBuffer.push(SseEvent(type: .message, data: data, parsedData: parsedData, id: lastEventId, event: eventType, message: nil, statusCode: 200, retry: nil, state: nil))
        }
    }
    
    func connectionDidReceiveComment(_ comment: String, attemptVersion: Int) {
        dispatcher.async { [weak self] in
            guard let self = self, attemptVersion == self.connectionAttemptVersion else { return }
            self.totalBytesReceived += Double(comment.utf8.count)
            self.eventBuffer.push(SseEvent(type: .heartbeat, data: nil, parsedData: nil, id: nil, event: nil, message: comment, statusCode: nil, retry: nil, state: nil))
        }
    }
    
    func connectionDidFail(error: Error, attemptVersion: Int) {
        dispatcher.async { [weak self] in
            guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
            
            let nsError = error as NSError
            var statusCode = nsError.code
            if let responseError = error as? UnsuccessfulResponseError {
                statusCode = responseError.responseCode
            }
            
            self.reconnectCount += 1
            self.lastErrorTime = Date().timeIntervalSince1970 * 1000
            self.lastErrorCode = "\(nsError.domain)(\(statusCode))"

            if statusCode >= 100 && statusCode < 600 {
                NitroSseNetworkInspector.reportResponseStart(
                    self.requestId,
                    url: self.config?.url,
                    response: nil,
                    statusCode: statusCode,
                    headers: [:]
                )
            }
            NitroSseNetworkInspector.reportRequestFailed(self.requestId, cancelled: false)
            self.requestId = nil
            
            // HTTP 204 No Content indicates the server closed the stream intentionally without error.
            if statusCode == 204 {
                self.failAndStop(message: "No Content (204). Stopping.", statusCode: 204)
                return
            }

            // HTTP 401/403 Auth errors trigger token refresh via onBeforeRequest interceptor up to maxAuthRetries.
            if statusCode == 401 || statusCode == 403 {
                if self.config?.onBeforeRequest == nil {
                    self.failAndStop(message: "Auth Error (\(statusCode)) - No interceptor provided. Stopping.", statusCode: Double(statusCode))
                    return
                }

                self.consecutiveAuthErrors += 1
                if self.consecutiveAuthErrors >= self.maxAuthRetries {
                    self.failAndStop(message: "Auth Error (\(statusCode)) - Retry limit reached (\(self.maxAuthRetries)). Stopping.", statusCode: Double(statusCode))
                    return
                }
                
                self.eventBuffer.push(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Auth Error (\(statusCode)) - Retry \(self.consecutiveAuthErrors)/\(self.maxAuthRetries). Refreshing token...", statusCode: Double(statusCode), retry: nil, state: nil))
                self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
                return
            }

            let isFatal = (statusCode == 400)
            if isFatal {
                self.failAndStop(message: "Fatal Error (\(statusCode)). Stopping.", statusCode: Double(statusCode))
                return
            }

            // HTTP 429 Rate Limit / 503 Service Unavailable: Honor server Retry-After delay with randomized jitter to prevent thundering herd.
            let retryAfterSeconds = SseReconnectStrategy.extractRetryAfterSeconds(from: error)
            if (statusCode == 429 || statusCode == 503), let retryAfter = retryAfterSeconds {
                let jitter = Double.random(in: 0.5...1.5)
                let totalDelay = retryAfter + jitter
                self.eventBuffer.push(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Retry-After received: \(Int(totalDelay))s", statusCode: Double(statusCode), retry: totalDelay * 1000.0, state: nil))
                self.scheduleAutomaticReconnectWithFixedDelay(totalDelay, attemptVersion: attemptVersion)
                return
            }

            // HTTP 429 without Retry-After: Fallback to exponential backoff rather than stopping permanently,
            // as rate limits are transient and recoverable.
            if statusCode == 429 {
                self.eventBuffer.push(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Rate Limited (429). Retrying with backoff...", statusCode: 429, retry: nil, state: nil))
                self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
                return
            }

            let isTimeout = (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut) || statusCode == -1001
            if isTimeout {
                self.updateState(.stale)
            }

            self.eventBuffer.push(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: error.localizedDescription, statusCode: Double(statusCode), retry: nil, state: nil))
            self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
        }
    }
}
