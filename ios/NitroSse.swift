import Foundation
import NitroModules
import Network

/// NitroSse implements a high-performance SSE client for iOS using native Foundation URLSession.
///
/// Architectural Principles:
/// 1. Threading Serialization: All mutable state and operations are strictly serialized on a dedicated
///    background dispatcher (`SseDispatcher`) to eliminate data races and prevent blocking JS/UI threads.
/// 2. Mobile Lifecycle Hibernation: When entering background without background execution enabled,
///    the connection is gracefully hibernated (flushing pending events and stopping sockets)
///    to comply with iOS background execution limits and conserve battery.
/// 3. Event Batching: Events are buffered and flushed in batches to minimize JSI bridge overhead.
/// 4. Versioned Connection Attempts: Reconnection attempts use `connectionAttemptVersion` counters
///    to discard stale async callbacks.
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
    /// Dynamic request interceptor decoupled from SseConfig (v3.0) to prevent closure re-wrapping and retain leaks.
    private var requestInterceptor: (() -> Promise<Promise<[String: String]>>)?
    private var isRunning: Bool = false
    private var isDisposed: Bool = false
    /// Indicates whether the JS Dispatcher/CallInvoker has been destroyed to prevent invoking dead callbacks.
    private var isDispatcherDestroyed: Bool = false
    internal var connectionAttemptVersion: Int = 0
    private var requestId: String?
    internal var lastProcessedId: String?
    private var currentState: SseState = .idle

    private var consecutiveAuthErrors: Int = 0
    private static let defaultMaxAuthRetries: Int = 3

    // MARK: - Metrics
    private var rawBytesReceived: Double = 0
    private var decompressedBytesReceived: Double?
    private var sessionRawBytesBase: Double = 0
    private var currentTaskRawBytes: Double = 0
    private var sessionDecompressedBytesBase: Double = 0
    private var currentTaskDecompressedBytes: Double = 0
    private var totalBytesReceived: Double = 0
    private var chunksReceived: Double = 0
    private var lastStatusCode: Double?

    private var totalEventsReceived: Double = 0
    private var commentsReceived: Double = 0
    private var linesParsed: Double = 0
    private var parseErrors: Double = 0
    private var serverRetryDelayMs: Double?

    private var connectedAt: Double?
    private var connectionAttemptStartTime: Double?
    private var timeToFirstByteMs: Double?
    private var lastEventTime: Double?
    private var lastHeartbeatTime: Double?
    private var lastActivityTime: Double = 0
    private var maxEventGapMs: Double = 0

    private var connectionAttempts: Double = 0
    private var reconnectCount: Double = 0
    private var isReconnecting: Bool = false
    private var lastReconnectDelayMs: Double?
    private var disconnectReason: SseDisconnectReason?
    private var currentAttemptHasParseError: Bool = false
    private var lastErrorTime: Double?
    private var lastErrorCode: String?

    private var wasRunningBeforeHibernation: Bool = false
    private var wasRunningBeforeNetworkLoss: Bool = false

    private var interceptorTimeoutCancellable: SseCancellable?

    private var networkChangeDebounceCancellable: SseCancellable?
    private static let networkChangeDebounceInterval: TimeInterval = 1.0

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
        onBeforeRequest: (() -> Promise<Promise<[String: String]>>)? = nil
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
            let manager = SseLifecycleManager(
                dispatcher: self.dispatcher,
                onBackground: { [weak self] in self?.handleAppDidEnterBackground() },
                onForeground: { [weak self] in self?.handleAppWillEnterForeground() }
            )
            self.lifecycleManager = manager
            manager.startObserving()

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
            for (key, value) in headers {
                merged[key] = value
            }
            self.config = config.copyWith(headers: merged)
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

    /// Begins connection establishment and resets retry counters.
    /// If the client is currently in a backoff reconnection delay, start() acts as an immediate "Retry Now",
    /// resetting the retry strategy and establishing connection immediately.
    func start() throws {
        let startBody = {
            if self.isRunning {
                if self.currentState == .reconnecting {
                    // Note: Incrementing connectionAttemptVersion invalidates in-flight callbacks from prior attempt.
                    // `establishConnection` cancels `interceptorTimeoutCancellable`; stale JS promises drop on check.
                    self.startConnectionAttempt(state: .connecting, resetRetryState: true)
                }
                return
            }

            guard self.config != nil else {
                throw RuntimeError("NitroSse not configured. Call setup() first.")
            }

            self.isRunning = true
            self.isDispatcherDestroyed = false
            self.startConnectionAttempt(state: .connecting, resetRetryState: true)
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
            self.startConnectionAttempt(state: .reconnecting, resetRetryState: false)
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
}

// MARK: - Network Monitoring & App Lifecycle Handling

extension NitroSse {
    private func startNetworkMonitoring() {
        dispatcher.assertOnQueue()
        guard networkMonitor == nil else { return }

        let monitor = SseNetworkMonitor(dispatcher: dispatcher) { [weak self] isSatisfied, interfaceChanged, _ in
            self?.handleNetworkChange(isSatisfied: isSatisfied, interfaceChanged: interfaceChanged)
        }
        self.networkMonitor = monitor
        monitor.start()
    }

    private func stopNetworkMonitoring() {
        dispatcher.assertOnQueue()
        networkChangeDebounceCancellable?.cancel()
        networkChangeDebounceCancellable = nil
        networkMonitor?.stop()
        networkMonitor = nil
    }

    internal func handleNetworkChange(isSatisfied: Bool, interfaceChanged: Bool) {
        dispatcher.assertOnQueue()

        if isSatisfied {
            if wasRunningBeforeNetworkLoss {
                networkChangeDebounceCancellable?.cancel()
                networkChangeDebounceCancellable = nil
                wasRunningBeforeNetworkLoss = false
                if lifecycleManager?.isAppInBackground == true && self.config?.backgroundExecution != true {
                    self.wasRunningBeforeHibernation = true
                } else if isRunning {
                    self.restart()
                } else {
                    try? self.start()
                }
            } else if isRunning && interfaceChanged {
                networkChangeDebounceCancellable?.cancel()
                let delay = Self.networkChangeDebounceInterval
                networkChangeDebounceCancellable = dispatcher.asyncAfter(delay: delay) { [weak self] in
                    guard let self = self, self.isRunning else { return }
                    self.networkChangeDebounceCancellable = nil
                    self.restart()
                }
            }
        } else {
            networkChangeDebounceCancellable?.cancel()
            networkChangeDebounceCancellable = nil
            if isRunning {
                wasRunningBeforeNetworkLoss = true
                self.updateState(.paused)
                self.hibernateConnection()
            }
        }
    }

    private func handleAppDidEnterBackground() {
        dispatcher.assertOnQueue()
        guard self.isRunning, let config = self.config else { return }

        if config.backgroundExecution == true {
            self.lifecycleManager?.beginBackgroundKeepAlive { [weak self] in
                guard let self = self, self.isRunning else { return }
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
                try? self.start()
            } else {
                self.wasRunningBeforeNetworkLoss = true
            }
        }
    }
}

// MARK: - Connection & Stop / Reconnect

extension NitroSse {
    private func updateState(_ newState: SseState) {
        dispatcher.assertOnQueue()
        if self.currentState != newState {
            self.currentState = newState
            self.eventBuffer.push(
                SseEvent(
                    type: .state,
                    data: nil,
                    parsedData: nil,
                    id: nil,
                    event: nil,
                    message: nil,
                    statusCode: nil,
                    retry: nil,
                    state: newState
                )
            )
            // State events represent immediate connection lifecycle transitions and must be flushed
            // to JS immediately to prevent UI and React hook state desynchronization.
            self.eventBuffer.flush()
        }
    }

    private func startConnectionAttempt(state: SseState, resetRetryState: Bool) {
        dispatcher.assertOnQueue()
        if resetRetryState {
            self.consecutiveAuthErrors = 0
            self.reconnectStrategy.reset()
        }
        self.connectionAttemptVersion += 1
        self.updateState(state)
        self.establishConnection(attemptVersion: self.connectionAttemptVersion)
    }

    private func finishActiveRequestInspector() {
        if let rid = self.requestId {
            NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(self.totalBytesReceived))
            self.requestId = nil
        }
    }

    private func teardownActiveTransport() {
        dispatcher.assertOnQueue()
        self.networkChangeDebounceCancellable?.cancel()
        self.networkChangeDebounceCancellable = nil
        self.interceptorTimeoutCancellable?.cancel()
        self.interceptorTimeoutCancellable = nil
        self.eventSource?.stop()
        self.eventSource = nil
        self.finishActiveRequestInspector()
        self.isRunning = false
        self.lifecycleManager?.cleanupBackgroundTask()
    }

    private func hibernateConnection() {
        dispatcher.assertOnQueue()
        guard self.isRunning else { return }

        self.connectionAttemptVersion += 1
        self.eventBuffer.flush()
        self.teardownActiveTransport()
    }

    /// Initiates an SSE connection attempt, invoking `onBeforeRequest` interceptor if configured.
    /// Ignores stale calls where `attemptVersion` no longer matches `self.connectionAttemptVersion`.
    private func establishConnection(attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard isRunning, let config = config, attemptVersion == self.connectionAttemptVersion else { return }

        if let interceptor = self.requestInterceptor {
            runInterceptor(interceptor, capturedConfig: config, attemptVersion: attemptVersion)
        } else {
            self.performEstablishConnection(attemptVersion: attemptVersion, connectionConfig: nil)
        }
    }

    private func scheduleInterceptorTimeout(attemptVersion: Int, timeoutMs: Double) {
        self.interceptorTimeoutCancellable?.cancel()
        self.interceptorTimeoutCancellable = nil
        self.interceptorTimeoutCancellable = dispatcher.asyncAfter(delay: timeoutMs / 1000.0) { [weak self] in
            guard let self = self,
                  self.isRunning,
                  attemptVersion == self.connectionAttemptVersion,
                  self.interceptorTimeoutCancellable != nil else {
                return
            }
            self.interceptorTimeoutCancellable = nil
            let error = NSError(
                domain: "NitroSse",
                code: -1,
                userInfo: [
                    NSLocalizedDescriptionKey: "onBeforeRequest interceptor timed out after \(timeoutMs) ms"
                ]
            )
            self.handleInterceptorError(error, attemptVersion: attemptVersion)
        }
    }

    private func runInterceptor(
        _ interceptor: () -> Promise<Promise<[String: String]>>,
        capturedConfig: SseConfig,
        attemptVersion: Int
    ) {
        let timeoutMs = capturedConfig.connectionTimeoutMs ?? 15000.0
        scheduleInterceptorTimeout(attemptVersion: attemptVersion, timeoutMs: timeoutMs)

        let settleInterceptor: (@escaping (NitroSse) -> Void) -> Void = { [weak self] action in
            self?.dispatcher.async { [weak self] in
                guard let self = self,
                      self.isRunning,
                      attemptVersion == self.connectionAttemptVersion,
                      self.interceptorTimeoutCancellable != nil else {
                    return
                }
                self.interceptorTimeoutCancellable?.cancel()
                self.interceptorTimeoutCancellable = nil
                action(self)
            }
        }

        let safeHandleError: (Error) -> Void = { error in
            settleInterceptor { strongSelf in
                strongSelf.handleInterceptorError(error, attemptVersion: attemptVersion)
            }
        }

        interceptor().then { promise2 in
            promise2.then { newHeaders in
                settleInterceptor { strongSelf in
                    let baseConfig = strongSelf.config ?? capturedConfig
                    var mergedHeaders = baseConfig.headers ?? [:]
                    for (key, value) in newHeaders {
                        mergedHeaders[key] = value
                    }
                    let connectionConfig = baseConfig.copyWith(headers: mergedHeaders)
                    strongSelf.performEstablishConnection(
                        attemptVersion: attemptVersion,
                        connectionConfig: connectionConfig
                    )
                }
            }.catch(safeHandleError)
        }.catch(safeHandleError)
    }

    private func handleInterceptorError(_ error: Error, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
        let desc = error.localizedDescription
        // react-native-nitro-modules throws std::runtime_error from C++ when the Dispatcher is destroyed.
        // Message inspection is required as no specialized exception type is surfaced to Swift.
        if desc.contains("Dispatcher has already been destroyed") {
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

        self.eventBuffer.push(
            SseEvent(
                type: .error,
                data: nil,
                parsedData: nil,
                id: nil,
                event: nil,
                message: "Interceptor Error: \(error.localizedDescription)",
                statusCode: -1,
                retry: nil,
                state: nil
            )
        )
        self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
    }

    private func performEstablishConnection(attemptVersion: Int, connectionConfig: SseConfig? = nil) {
        dispatcher.assertOnQueue()
        let activeConfig = connectionConfig ?? self.config
        guard isRunning, let config = activeConfig, attemptVersion == self.connectionAttemptVersion else { return }
        let targetUrlString = config.url
        let parsedUrl = URL(string: targetUrlString)
        let scheme = parsedUrl?.scheme?.lowercased()
        guard let url = parsedUrl, let validScheme = scheme, ["http", "https"].contains(validScheme) else {
            self.failAndStop(message: "Invalid URL: \(targetUrlString)", statusCode: -1)
            return
        }

        self.connectionAttempts += 1
        self.connectionAttemptStartTime = Date().timeIntervalSince1970 * 1000
        self.timeToFirstByteMs = nil
        self.currentAttemptHasParseError = false

        self.updateState(.connecting)
        self.finishActiveRequestInspector()

        let request = SseConnectionHandler.createRequest(url: url, config: config, lastProcessedId: lastProcessedId)
        self.requestId = NitroSseNetworkInspector.reportRequestStart(request, encodedDataLength: 0)

        self.eventSource = SseConnectionHandler.createEventSource(
            url: url,
            config: config,
            lastProcessedId: lastProcessedId,
            delegate: self,
            attemptVersion: attemptVersion,
            dispatcher: dispatcher
        )
    }

    private func recordActivity(now: Double) {
        if self.lastActivityTime > 0 {
            let gap = now - self.lastActivityTime
            if gap > self.maxEventGapMs {
                self.maxEventGapMs = gap
            }
        }
        self.lastActivityTime = now
    }

    private func flushTaskBytes() {
        self.sessionRawBytesBase += self.currentTaskRawBytes
        self.currentTaskRawBytes = 0
        self.sessionDecompressedBytesBase += self.currentTaskDecompressedBytes
        self.currentTaskDecompressedBytes = 0
    }

    private func stopInternal(emitClosed: Bool = true) {
        dispatcher.assertOnQueue()
        self.connectedAt = nil
        self.flushTaskBytes()
        self.isReconnecting = false
        self.isRunning = false
        if emitClosed && !isDispatcherDestroyed && self.currentState != .failed {
            self.updateState(.closed)
        } else if isDispatcherDestroyed && self.currentState != .failed {
            // JS callback is unusable: record the terminal state silently so getState() stays accurate.
            self.currentState = .closed
        }
        if isDispatcherDestroyed {
            self.eventBuffer.clear()
        }
        self.wasRunningBeforeNetworkLoss = false
        self.wasRunningBeforeHibernation = false
        self.teardownActiveTransport()
        self.reconnectStrategy.reset()
    }

    private func failAndStop(message: String, statusCode: Double? = nil) {
        dispatcher.assertOnQueue()
        self.connectionAttemptVersion += 1
        self.eventBuffer.push(
            SseEvent(
                type: .error,
                data: nil,
                parsedData: nil,
                id: nil,
                event: nil,
                message: message,
                statusCode: statusCode,
                retry: nil,
                state: nil
            )
        )
        self.updateState(.failed)
        self.stopInternal()
    }

    /// Reconnects with exponential backoff coordinated externally via SseDispatcher and attemptVersion.
    private func scheduleAutomaticReconnect(isError: Bool, fixedDelay: TimeInterval? = nil, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard isRunning, attemptVersion == self.connectionAttemptVersion else { return }

        if reconnectStrategy.hasReachedMaxAttempts() {
            let maxAttempts = reconnectStrategy.maxReconnectAttempts
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

private extension HTTPURLResponse {
    var stringHeaders: [String: String] {
        return allHeaderFields.reduce(into: [:]) { $0["\($1.key)"] = "\($1.value)" }
    }
}

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

        NitroSseNetworkInspector.reportResponseStart(
            self.requestId,
            url: response.url?.absoluteString ?? self.config?.url,
            response: response,
            statusCode: response.statusCode,
            headers: response.stringHeaders
        )

        // WHATWG SSE spec: response headers are not exposed to JS listeners (`open` only carries statusCode).
        self.eventBuffer.push(
            SseEvent(
                type: .open,
                data: nil,
                parsedData: nil,
                id: nil,
                event: nil,
                message: nil,
                statusCode: Double(response.statusCode),
                retry: nil,
                state: nil
            )
        )
    }

    func connectionDidReceiveDataChunk(
        rawWireBytes: Int64,
        decompressedBytes: Int64?,
        attemptVersion: Int
    ) {
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

        self.totalEventsReceived += 1
        let now = Date().timeIntervalSince1970 * 1000
        self.lastEventTime = now
        self.recordActivity(now: now)

        let parsedData = (self.config?.autoParseJSON == true) ? SseEventBuffer.parseJsonToAnyMap(data) : nil

        self.eventBuffer.push(
            SseEvent(
                type: .message,
                data: data,
                parsedData: parsedData,
                id: lastEventId,
                event: eventType,
                message: nil,
                statusCode: 200,
                retry: nil,
                state: nil
            )
        )
    }

    func connectionDidReceiveComment(_ comment: String, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard attemptVersion == self.connectionAttemptVersion else { return }
        self.totalBytesReceived += Double(comment.utf8.count)
        self.commentsReceived += 1
        let now = Date().timeIntervalSince1970 * 1000
        self.lastHeartbeatTime = now
        self.recordActivity(now: now)
        // Note (v4.0 roadmap): Avoid pushing HEARTBEAT event across JSI; use internal watchdog or onHeartbeat.
        self.eventBuffer.push(
            SseEvent(
                type: .heartbeat,
                data: nil,
                parsedData: nil,
                id: nil,
                event: nil,
                message: comment,
                statusCode: nil,
                retry: nil,
                state: nil
            )
        )
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

    private struct FailureContext {
        let response: HTTPURLResponse?
        let errorBody: String?
        let nsError: NSError
        let httpStatusCode: Int?
        let reportedStatusCode: Int
        let isTimeout: Bool
        let isParserLimit: Bool
        let isInvalidContentType: Bool
    }

    func connectionDidFail(error: Error, response: HTTPURLResponse?, errorBody: String?, attemptVersion: Int) {
        dispatcher.assertOnQueue()
        guard self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }

        self.connectedAt = nil
        self.flushTaskBytes()
        let context = buildFailureContext(error: error, response: response, errorBody: errorBody)
        recordFailureMetrics(context)
        reportFailureToInspector(response: response, httpStatusCode: context.httpStatusCode)

        let handled = handleTerminalFailureIfNeeded(context) ||
            handleAuthFailureIfNeeded(httpStatusCode: context.httpStatusCode, attemptVersion: attemptVersion) ||
            handleRetryAfterOrRateLimitIfNeeded(
                httpStatusCode: context.httpStatusCode,
                response: response,
                attemptVersion: attemptVersion
            )
        if handled { return }

        if context.isTimeout {
            self.updateState(.stale)
        }

        let defaultErrorMsg = buildDefaultErrorMessage(
            error: error,
            httpStatusCode: context.httpStatusCode,
            errorBody: errorBody
        )
        self.eventBuffer.push(
            SseEvent(
                type: .error,
                data: nil,
                parsedData: nil,
                id: nil,
                event: nil,
                message: defaultErrorMsg,
                statusCode: Double(context.reportedStatusCode),
                retry: nil,
                state: nil
            )
        )
        self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
    }

    private func buildFailureContext(
        error: Error,
        response: HTTPURLResponse?,
        errorBody: String?
    ) -> FailureContext {
        let nsError = error as NSError
        let httpStatusCode = resolveHttpStatusCode(response: response, nsError: nsError)
        return FailureContext(
            response: response,
            errorBody: errorBody,
            nsError: nsError,
            httpStatusCode: httpStatusCode,
            reportedStatusCode: httpStatusCode ?? nsError.code,
            isTimeout: nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut,
            isParserLimit: nsError.domain == "NitroSse" && (nsError.code == -2002 || nsError.code == -2003),
            isInvalidContentType: isInvalidEventStreamContentType(response: response, nsError: nsError)
        )
    }

    private func resolveHttpStatusCode(response: HTTPURLResponse?, nsError: NSError) -> Int? {
        // Decouple HTTP status code (meaningful only for HTTP 4xx/5xx/204) from transport and parser error codes
        if let resp = response, resp.statusCode >= 400 || resp.statusCode == 204 {
            return resp.statusCode
        }
        if nsError.code >= 100 && nsError.code < 600 {
            return nsError.code
        }
        return nil
    }

    private func isInvalidEventStreamContentType(response: HTTPURLResponse?, nsError: NSError) -> Bool {
        if nsError.domain == "NitroSse" && nsError.code == -2001 {
            return true
        }
        let rawContentType = response?.value(forHTTPHeaderField: "Content-Type") ?? ""
        let rawMime = rawContentType.split(separator: ";").first
        let mimeType = rawMime?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        return (200..<300).contains(response?.statusCode ?? 0) && mimeType != "text/event-stream"
    }

    private func recordFailureMetrics(_ context: FailureContext) {
        if let resp = context.response {
            self.lastStatusCode = Double(resp.statusCode)
        }

        if context.isParserLimit || self.currentAttemptHasParseError {
            self.disconnectReason = .parserError
        } else if context.isInvalidContentType ||
                    context.httpStatusCode == 204 ||
                    (context.httpStatusCode ?? 0) >= 400 {
            self.disconnectReason = .serverError
        } else if context.isTimeout {
            self.disconnectReason = .timeout
        } else {
            self.disconnectReason = .networkError
        }

        self.lastErrorTime = Date().timeIntervalSince1970 * 1000
        let codeValue = context.httpStatusCode ?? context.nsError.code
        self.lastErrorCode = "\(context.nsError.domain)(\(codeValue))"
    }

    private func reportFailureToInspector(response: HTTPURLResponse?, httpStatusCode: Int?) {
        // Only report response start if an actual HTTP error response arrived (200 is reported in connectionDidOpen)
        if let http = httpStatusCode {
            NitroSseNetworkInspector.reportResponseStart(
                self.requestId,
                url: response?.url?.absoluteString ?? self.config?.url,
                response: response,
                statusCode: http,
                headers: response?.stringHeaders ?? [:]
            )
        }
        NitroSseNetworkInspector.reportRequestFailed(self.requestId, cancelled: false)
        self.requestId = nil
    }

    private func handleTerminalFailureIfNeeded(_ context: FailureContext) -> Bool {
        // WHATWG EventSource Section 7: HTTP 204 No Content explicitly terminates stream across platforms.
        if context.httpStatusCode == 204 {
            self.failAndStop(message: "No Content (204). Stopping.", statusCode: 204)
            return true
        }
        if context.isInvalidContentType {
            self.failAndStop(
                message: "Invalid Content-Type: expected text/event-stream. Stopping.",
                statusCode: Double(context.reportedStatusCode)
            )
            return true
        }
        if context.isParserLimit {
            self.failAndStop(
                message: context.nsError.localizedDescription,
                statusCode: Double(context.reportedStatusCode)
            )
            return true
        }
        if let fatalHttp = context.httpStatusCode,
           (400...499).contains(fatalHttp),
           ![401, 403, 408, 429].contains(fatalHttp) {
            let trimmedBody = context.errorBody?.trimmingCharacters(in: .whitespacesAndNewlines)
            let fatalMessage = (trimmedBody?.isEmpty == false)
                ? "Fatal Error (\(fatalHttp)): \(trimmedBody!)"
                : "Fatal Error (\(fatalHttp)). Stopping."
            self.failAndStop(message: fatalMessage, statusCode: Double(fatalHttp))
            return true
        }
        return false
    }

    private func handleAuthFailureIfNeeded(httpStatusCode: Int?, attemptVersion: Int) -> Bool {
        // HTTP 401/403 Auth errors trigger token refresh via onBeforeRequest interceptor up to maxAuthRetries.
        guard let http = httpStatusCode, http == 401 || http == 403 else {
            return false
        }
        if self.requestInterceptor == nil {
            self.failAndStop(
                message: "Auth Error (\(http)) - No interceptor provided. Stopping.",
                statusCode: Double(http)
            )
            return true
        }
        let limit = Int(self.config?.maxAuthRetries ?? Double(Self.defaultMaxAuthRetries))
        self.consecutiveAuthErrors += 1
        if self.consecutiveAuthErrors > limit {
            self.failAndStop(
                message: "Auth Error (\(http)) - Retry limit reached (\(limit)). Stopping.",
                statusCode: Double(http)
            )
            return true
        }
        let message = "Auth Error (\(http)) - Retry \(self.consecutiveAuthErrors)/\(limit). Refreshing token..."
        self.eventBuffer.push(
            SseEvent(
                type: .error,
                data: nil,
                parsedData: nil,
                id: nil,
                event: nil,
                message: message,
                statusCode: Double(http),
                retry: nil,
                state: nil
            )
        )
        self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
        return true
    }

    private func handleRetryAfterOrRateLimitIfNeeded(
        httpStatusCode: Int?,
        response: HTTPURLResponse?,
        attemptVersion: Int
    ) -> Bool {
        // HTTP 429/503: Honor server Retry-After delay with randomized jitter to prevent thundering herd.
        let retryAfterSeconds = response.flatMap { SseReconnectStrategy.extractRetryAfterSeconds(from: $0) }
        if let http = httpStatusCode, http == 429 || http == 503, let retryAfter = retryAfterSeconds {
            let maxInterval = (self.config?.maxRetryIntervalMs ?? 30000.0) / 1000.0
            let boundedRetryAfter = max(0.0, min(retryAfter, maxInterval))
            let totalDelay = boundedRetryAfter + Double.random(in: 0.5...1.5)
            self.eventBuffer.push(
                SseEvent(
                    type: .error,
                    data: nil,
                    parsedData: nil,
                    id: nil,
                    event: nil,
                    message: "Retry-After received: \(Int(totalDelay))s",
                    statusCode: Double(http),
                    retry: totalDelay * 1000.0,
                    state: nil
                )
            )
            self.scheduleAutomaticReconnect(isError: true, fixedDelay: totalDelay, attemptVersion: attemptVersion)
            return true
        }

        // HTTP 429 without Retry-After: Fallback to exponential backoff as rate limits are recoverable.
        if httpStatusCode == 429 {
            self.eventBuffer.push(
                SseEvent(
                    type: .error,
                    data: nil,
                    parsedData: nil,
                    id: nil,
                    event: nil,
                    message: "Rate Limited (429). Retrying with backoff...",
                    statusCode: 429,
                    retry: nil,
                    state: nil
                )
            )
            self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
            return true
        }
        return false
    }

    private func buildDefaultErrorMessage(error: Error, httpStatusCode: Int?, errorBody: String?) -> String {
        if let http = httpStatusCode,
           http >= 500,
           let bodyText = errorBody?.trimmingCharacters(in: .whitespacesAndNewlines),
           !bodyText.isEmpty {
            return "Server Error (\(http)): \(bodyText)"
        }
        return error.localizedDescription
    }
}
