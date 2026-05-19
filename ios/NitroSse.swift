import Foundation
import NitroModules
import LDSwiftEventSource
import Network
#if os(iOS)
import UIKit
#endif

/**
 * NitroSse implements a high-performance SSE client for iOS using LDSwiftEventSource.
 *
 * ARCHITECTURE DECISIONS:
 * 1. Threading Serialization: All operations are strictly serialized on a dedicated background queue (sseQueue).
 *    This ensures thread-safety for internal states (buffer, backoff) and prevents blocking the JS/Main threads.
 * 2. Mobile Survival Logic: Implements a "Hibernation" pattern. When the app enters the background, 
 *    we flush remaining events and stop the socket to preserve battery and follow Apple's background policies. 
 *    The connection is automatically resumed from the last known ID when the app returns to foreground.
 * 3. Batching: Reduces JSI bridge overhead by accumulating events and dispatching them 
 *    as a single array after a configurable interval.
 */
class NitroSse: HybridNitroSseSpec {
    private static let sseQueueKey = DispatchSpecificKey<Void>()

    deinit {
        if DispatchQueue.getSpecific(key: NitroSse.sseQueueKey) != nil {
            self.stopInternal()
            self.stopNetworkMonitoring()
        } else {
            sseQueue.sync {
                self.stopInternal()
                self.stopNetworkMonitoring()
            }
        }
        NotificationCenter.default.removeObserver(self)
    }
    private var eventSource: EventSource?
    private var config: SseConfig?
    private var onEventsCallback: ((_ events: [SseEvent]) -> Void)?
    private var isRunning: Bool = false
    private var consecutiveAuthErrors: Int = 0
    private let maxAuthRetries: Int = 3
    private var requestId: String? = nil   
    private var eventBuffer: [SseEvent] = []
    private var isFlushPending: Bool = false
    
    private var backoffCounter: Int = 0
    private var currentReconnectAttempts: Int = 0
    private var lastProcessedId: String? = nil
    
    private var totalBytesReceived: Double = 0
    private var reconnectCount: Double = 0
    private var lastErrorTime: Double? = nil
    private var lastErrorCode: String? = nil
    
    private let sseQueue: DispatchQueue = {
        let queue = DispatchQueue(label: "com.margelo.nitro.sse", qos: .utility)
        queue.setSpecific(key: NitroSse.sseQueueKey, value: ())
        return queue
    }()
    private var connectionAttemptVersion: Int = 0
#if os(iOS)
    private var backgroundTaskIdentifier: UIBackgroundTaskIdentifier = .invalid
#endif
    private var wasRunningBeforeHibernation: Bool = false
    private var isAppInBackground: Bool = false

    private var pathMonitor: NWPathMonitor?
    private var lastPathInterface: NWInterface.InterfaceType?
    private var wasRunningBeforeNetworkLoss: Bool = false

    /**
     * Set up the NitroSse instance with configuration and an event callback.
     * This prepares the lifecycle observers and internal dispatch queue.
     *
     * - Parameters:
     *   - config: The SSE configuration containing URL, headers, and more.
     *   - onEvent: Callback function to receive batched SSE events.
     */
    func setup(config: SseConfig, onEvent: @escaping ((_ events: [SseEvent]) -> Void)) throws {
        sseQueue.async {
            self.config = config
            self.onEventsCallback = onEvent
            
            NotificationCenter.default.removeObserver(self)
#if os(iOS)
            NotificationCenter.default.addObserver(self, selector: #selector(self.handleAppDidEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(self.handleAppWillEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
#endif
            
            if config.monitorNetwork != false {
                self.startNetworkMonitoring()
            } else {
                self.stopNetworkMonitoring()
            }
        }
    }

    private func stopNetworkMonitoring() {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        pathMonitor?.cancel()
        pathMonitor = nil
        lastPathInterface = nil
    }
    
    private func startNetworkMonitoring() {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        guard pathMonitor == nil else { return }
        
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            self?.sseQueue.async {
                self?.handleNetworkChange(path: path)
            }
        }
        self.pathMonitor = monitor
        monitor.start(queue: sseQueue)
    }
    
    private func handleNetworkChange(path: NWPath) {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        let isSatisfied = path.status == .satisfied
        
        var interfaceType: NWInterface.InterfaceType? = nil
        if path.usesInterfaceType(.wifi) {
            interfaceType = .wifi
        } else if path.usesInterfaceType(.cellular) {
            interfaceType = .cellular
        } else if path.usesInterfaceType(.wiredEthernet) {
            interfaceType = .wiredEthernet
        } else {
            interfaceType = path.availableInterfaces.first?.type
        }
        
        print("[NitroSse] Network path changed: status=\(path.status), interface=\(String(describing: interfaceType))")
        
        if isSatisfied {
            if wasRunningBeforeNetworkLoss {
                print("[NitroSse] Network restored. Resuming stream.")
                wasRunningBeforeNetworkLoss = false
                if self.isAppInBackground && self.config?.backgroundExecution != true {
                    self.wasRunningBeforeHibernation = true
                } else if isRunning {
                    self.restart()
                } else {
                    try? self.start()
                }
            } else if isRunning {
                if let lastInterface = lastPathInterface, let currentInterface = interfaceType, lastInterface != currentInterface {
                    print("[NitroSse] Network interface changed (\(lastInterface) -> \(currentInterface)). Restarting stream.")
                    self.restart()
                } else if lastPathInterface == nil {
                    print("[NitroSse] Network interface acquired. Restarting stream.")
                    self.restart()
                }
            }
        } else {
            if isRunning {
                print("[NitroSse] Network lost. Hibernating.")
                wasRunningBeforeNetworkLoss = true
                self.hibernateConnection()
            }
        }
        
        if isSatisfied {
            self.lastPathInterface = interfaceType
        }
    }
    
    @objc private func handleAppDidEnterBackground() {
        sseQueue.async {
            self.isAppInBackground = true
            guard self.isRunning, let config = self.config else { return }
            
            if config.backgroundExecution == true {
                print("[NitroSse] App backgrounded. backgroundExecution is true, keeping connection alive.")
#if os(iOS)
                // Start a background task to tell the OS we want to keep running
                self.cleanupBackgroundTask()
                self.backgroundTaskIdentifier = UIApplication.shared.beginBackgroundTask(withName: "NitroSse-KeepAlive") { [weak self] in
                    self?.sseQueue.async {
                        print("[NitroSse] Background task expired. Hibernating now.")
                        self?.hibernateConnection()
                    }
                }
#endif
                return
            }
            
            self.hibernateConnection()
        }
    }

    private func hibernateConnection() {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        guard self.isRunning else { return }
        
        self.wasRunningBeforeHibernation = true
        print("[NitroSse] Hibernating NitroSse connection.")
        
        self.flushEventsToJs()
        
        self.eventSource?.stop()
        self.eventSource = nil
        if let rid = self.requestId {
            NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(self.totalBytesReceived))
            self.requestId = nil
        }
        self.isRunning = false
        
        self.cleanupBackgroundTask()
    }
    
    @objc private func handleAppWillEnterForeground() {
        sseQueue.async {
            self.isAppInBackground = false
            self.cleanupBackgroundTask()
            if self.wasRunningBeforeHibernation {
                print("[NitroSse] App foregrounded. Resuming stream.")
                self.wasRunningBeforeHibernation = false
                try? self.start()
            }
        }
    }
    
    private func cleanupBackgroundTask() {
        dispatchPrecondition(condition: .onQueue(sseQueue))
#if os(iOS)
        if self.backgroundTaskIdentifier != .invalid {
            UIApplication.shared.endBackgroundTask(self.backgroundTaskIdentifier)
            self.backgroundTaskIdentifier = .invalid
        }
#endif
    }

    private func pushEventToBuffer(_ event: SseEvent) {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        
        let batchIntervalMs = config?.batchingIntervalMs ?? 0
        let bufferCapacity = Int(config?.maxBufferSize ?? 1000)
        
        eventBuffer.append(event)
        
        // If we reached capacity, flush immediately regardless of interval
        if eventBuffer.count >= bufferCapacity || batchIntervalMs <= 0 {
            flushEventsToJs()
        } else if !isFlushPending {
            isFlushPending = true
            sseQueue.asyncAfter(deadline: .now() + (Double(batchIntervalMs) / 1000.0)) { [weak self] in
                self?.sseQueue.async {
                    self?.flushEventsToJs()
                }
            }
        }
    }
    private func flushEventsToJs() {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        guard !eventBuffer.isEmpty else { return }
        
        let batch = eventBuffer
        eventBuffer.removeAll()
        isFlushPending = false
        
        onEventsCallback?(batch)
    }

    internal func parseJsonToAnyMap(_ data: String) -> AnyMap? {
        guard let jsonData = data.data(using: .utf8) else { return nil }
        do {
            if let dictionary = try JSONSerialization.jsonObject(with: jsonData, options: []) as? [String: Any?] {
                return AnyMap.fromDictionaryIgnoreIncompatible(dictionary)
            }
        } catch {
            // Non-fatal, just log and return nil
            print("[NitroSse] Failed to parse JSON: \(error.localizedDescription)")
        }
        return nil
    }

    /**
     * Manually set the last seen event ID.
     * This will be used as the 'Last-Event-ID' header on the next connection attempt.
     */
    func setLastProcessedId(id: String) {
        sseQueue.async {
            self.lastProcessedId = id
        }
    }

    /// Update the HTTP headers that will be used for subsequent SSE connections.
    /// - Parameters:
    ///   - headers: A dictionary of HTTP header names and values to replace the current headers for future connections.
    func updateHeaders(headers: [String: String]) throws {
        sseQueue.async {
            guard let config = self.config else { return }
            self.config = SseConfig(
                url: config.url,
                method: config.method,
                headers: headers,
                body: config.body,
                backgroundExecution: config.backgroundExecution,
                batchingIntervalMs: config.batchingIntervalMs,
                maxBufferSize: config.maxBufferSize,
                connectionTimeoutMs: config.connectionTimeoutMs,
                readTimeoutMs: config.readTimeoutMs,
                retryIntervalMs: config.retryIntervalMs,
                maxRetryIntervalMs: config.maxRetryIntervalMs,
                jitterFactor: config.jitterFactor,
                maxReconnectAttempts: config.maxReconnectAttempts,
                autoParseJSON: config.autoParseJSON,
                monitorNetwork: config.monitorNetwork,
                onBeforeRequest: config.onBeforeRequest,
                mock: config.mock
            )
            print("[NitroSse] Headers updated for subsequent connections.")
        }
    }

    /**
     * Returns runtime statistics about the SSE connection.
     */
    func getStats() throws -> SseStats {
        return sseQueue.sync {
            return SseStats(
                totalBytesReceived: totalBytesReceived,
                reconnectCount: reconnectCount,
                lastErrorTime: lastErrorTime,
                lastErrorCode: lastErrorCode
            )
        }
    }

    /**
     * Start the SSE connection.
     * This triggers the initial request and handles subsequent reconnections.
     */
    func start() throws {
        let startBody = {
            guard !self.isRunning else { return }
            
            // Critical check: Ensure config is available before starting
            guard self.config != nil else {
                throw RuntimeError("NitroSse not configured. Call setup() first.")
            }
            
            self.isRunning = true
            self.consecutiveAuthErrors = 0 
            self.backoffCounter = 0
            self.connectionAttemptVersion += 1
            let version = self.connectionAttemptVersion
            
            self.establishConnection(attemptVersion: version)
        }

        if DispatchQueue.getSpecific(key: NitroSse.sseQueueKey) != nil {
            try startBody()
        } else {
            try sseQueue.sync(execute: startBody)
        }
    }

    /// Initiates a new SSE connection attempt using the current configuration, honoring the provided attempt version to ignore stale async work.
    /// 
    /// If a configured `onBeforeRequest` interceptor is present, this method executes it (with a configurable timeout); when the interceptor resolves with additional headers those headers are merged into the active configuration before proceeding. If the interceptor fails or times out, interceptor error handling is invoked. If no interceptor is configured, the connection is established immediately.
    /// - Parameters:
    ///   - attemptVersion: A numeric token representing the connection attempt version; the method aborts if this does not match the current `connectionAttemptVersion`, ensuring stale asynchronous results are ignored.
    private func establishConnection(attemptVersion: Int) {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        guard isRunning, let config = config, attemptVersion == self.connectionAttemptVersion else { return }

        if let interceptor = config.onBeforeRequest {
            
            let capturedConfig = config
            class CompletionFlag {
                var isCompleted = false
            }
            let flag = CompletionFlag()
            let timeoutMs = capturedConfig.connectionTimeoutMs ?? 15000.0
            
            sseQueue.asyncAfter(deadline: .now() + (timeoutMs / 1000.0)) { [weak self] in
                guard let self = self else { return }
                self.sseQueue.async { [weak self] in
                    guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
                    if !flag.isCompleted {
                        flag.isCompleted = true
                        let error = NSError(domain: "NitroSse", code: -1, userInfo: [NSLocalizedDescriptionKey: "onBeforeRequest interceptor timed out after \(timeoutMs) ms"])
                        self.handleInterceptorError(error, attemptVersion: attemptVersion)
                    }
                }
            }

            interceptor().then { [weak self] promise2 in
                promise2.then { [weak self] newHeaders in
                    self?.sseQueue.async { [weak self] in
                        guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
                        if !flag.isCompleted {
                            flag.isCompleted = true
                            let currentConfig = self.config ?? capturedConfig
                            var mergedHeaders = currentConfig.headers ?? [:]
                            for (k, v) in newHeaders {
                                mergedHeaders[k] = v
                            }
                            self.config = SseConfig(
                                url: currentConfig.url,
                                method: currentConfig.method,
                                headers: mergedHeaders,
                                body: currentConfig.body,
                                backgroundExecution: currentConfig.backgroundExecution,
                                batchingIntervalMs: currentConfig.batchingIntervalMs,
                                maxBufferSize: currentConfig.maxBufferSize,
                                connectionTimeoutMs: currentConfig.connectionTimeoutMs,
                                readTimeoutMs: currentConfig.readTimeoutMs,
                                retryIntervalMs: currentConfig.retryIntervalMs,
                                maxRetryIntervalMs: currentConfig.maxRetryIntervalMs,
                                jitterFactor: currentConfig.jitterFactor,
                                maxReconnectAttempts: currentConfig.maxReconnectAttempts,
                                autoParseJSON: currentConfig.autoParseJSON,
                                monitorNetwork: currentConfig.monitorNetwork,
                                onBeforeRequest: currentConfig.onBeforeRequest,
                                mock: currentConfig.mock
                            )
                            self.performEstablishConnection(attemptVersion: attemptVersion)
                        }
                    }
                }.catch { [weak self] error in
                    self?.sseQueue.async { [weak self] in
                        guard let self = self, self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
                        if !flag.isCompleted {
                            flag.isCompleted = true
                            self.handleInterceptorError(error, attemptVersion: attemptVersion)
                        }
                    }
                }
            }.catch { [weak self] error in
                self?.sseQueue.async { [weak self] in
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
        dispatchPrecondition(condition: .onQueue(sseQueue))
        guard self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
        print("[NitroSse] Interceptor failed: \(error.localizedDescription)")
        self.pushEventToBuffer(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Interceptor Error: \(error.localizedDescription)", statusCode: -1, retry: nil))
        // Reconnect after delay
        self.scheduleAutomaticReconnect(isError: true, attemptVersion: attemptVersion)
    }

    private func performEstablishConnection(attemptVersion: Int) {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        guard isRunning, let config = config, let url = URL(string: config.url), attemptVersion == self.connectionAttemptVersion else { return }
        
        if let rid = self.requestId {
            NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(self.totalBytesReceived))
            self.requestId = nil
        }
        
        let sessionConfig = URLSessionConfiguration.default
        let readTimeout = (config.readTimeoutMs ?? 300000.0) / 1000.0
        sessionConfig.timeoutIntervalForRequest = readTimeout
        sessionConfig.timeoutIntervalForResource = readTimeout

        let handler = SseHandler(parent: self, attemptVersion: attemptVersion)
        var esConfig = EventSource.Config(handler: handler, url: url)
        esConfig.urlSessionConfiguration = sessionConfig
        esConfig.headers = config.headers ?? [:]
        
        if let lastId = self.lastProcessedId, !lastId.isEmpty {
            esConfig.headers["Last-Event-ID"] = lastId
        }
        
        esConfig.lastEventId = self.lastProcessedId ?? ""
        esConfig.method = config.method?.stringValue.uppercased() ?? "GET"
        esConfig.body = config.body?.data(using: .utf8)
        
        let es = EventSource(config: esConfig)
        self.eventSource = es
        handler.source = es
        
        let request = URLRequest(url: url)
        self.requestId = NitroSseNetworkInspector.reportRequestStart(request, encodedDataLength: 0)
        
        es.start()
    }

    /**
     * Stop the SSE connection and clear any pending reconnect timers.
     */
    func stop() {
        sseQueue.async {
            self.connectionAttemptVersion += 1
            self.stopInternal()
        }
    }

    private func stopInternal() {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        self.isRunning = false
        self.wasRunningBeforeNetworkLoss = false
        self.wasRunningBeforeHibernation = false
        self.eventSource?.stop()
        self.eventSource = nil
        if let rid = self.requestId {
            NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(self.totalBytesReceived))
            self.requestId = nil
        }
        self.backoffCounter = 0
        self.isFlushPending = false
        self.cleanupBackgroundTask()
    }

    /**
     * Immediately emit any pending buffered events to the JS bridge.
     */
    func flush() {
        sseQueue.async {
            self.flushEventsToJs()
        }
    }

    /**
     * Restart the SSE connection by stopping and starting again.
     */
    func restart() {
        sseQueue.async {
            self.stopInternal()
            self.isRunning = true
            self.requestId = nil
            self.connectionAttemptVersion += 1
            self.establishConnection(attemptVersion: self.connectionAttemptVersion)
        }
    }

    /**
     * Indicates if the SSE connection is currently active or trying to connect.
     */
    func isConnected() -> Bool {
        return sseQueue.sync {
            return isRunning
        }
    }
    
    private func extractRetryAfterSeconds(error: Error) -> TimeInterval? {
        let nsError = error as NSError
        guard let response = nsError.userInfo["response"] as? HTTPURLResponse else { return nil }
        guard let retryAfterHeader = response.allHeaderFields["Retry-After"] as? String else { return nil }
        
        if let seconds = Double(retryAfterHeader) {
            return seconds
        }
        
        let rfc1123Formatter = DateFormatter()
        rfc1123Formatter.locale = Locale(identifier: "en_US_POSIX")
        rfc1123Formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
        if let date = rfc1123Formatter.date(from: retryAfterHeader) {
            let timeUntilDate = date.timeIntervalSinceNow
            return timeUntilDate > 0 ? timeUntilDate : nil
        }
        return nil
    }

    private func scheduleAutomaticReconnectWithFixedDelay(_ delay: TimeInterval, attemptVersion: Int) {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        eventSource?.stop()
        eventSource = nil
        sseQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self else { return }
            self.sseQueue.async {
                guard self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
                self.establishConnection(attemptVersion: attemptVersion)
            }
        }
    }
    
    /// Schedules an automatic reconnection attempt using the configured retry interval, exponential backoff, and jitter.
    /// 
    /// If the configured maximum reconnect attempts has been reached, this method emits an error event and stops the connection instead of scheduling a reconnect. Otherwise it increments the reconnect attempt counter, computes a delay (exponential backoff when `isError` is true, with jitter applied and a minimum delay of 1 second), clears the current event source, and schedules `establishConnection(attemptVersion:)` to run after the computed delay only if the client is still running and the provided `attemptVersion` matches the current connection attempt version.
    /// - Parameters:
    ///   - isError: Whether the reconnect is being scheduled in response to an error (affects use of exponential backoff).
    ///   - attemptVersion: The connection attempt version that must match the current `connectionAttemptVersion` when the scheduled reconnect fires; used to ignore stale or superseded reconnect attempts.
    private func scheduleAutomaticReconnect(isError: Bool, attemptVersion: Int) {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        eventSource?.stop()

        let jitterFactor = config?.jitterFactor ?? 0.5
        let retryInterval = (config?.retryIntervalMs ?? 1000.0) / 1000.0
        let maxRetryInterval = (config?.maxRetryIntervalMs ?? 30000.0) / 1000.0

        var delay: TimeInterval = retryInterval
        
        let maxAttempts = Int(config?.maxReconnectAttempts ?? -1.0)
        if maxAttempts != -1 && currentReconnectAttempts >= maxAttempts {
            print("[NitroSse] Max reconnection attempts reached (\(maxAttempts)). Stopping.")
            self.pushEventToBuffer(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Max reconnection attempts reached (\(maxAttempts)).", statusCode: nil, retry: nil))
            self.stopInternal()
            return
        }
        
        currentReconnectAttempts += 1
        
        if isError {
            let exponent = Double(backoffCounter)
            let base = min(retryInterval * pow(2.0, exponent), maxRetryInterval)
            backoffCounter += 1
            delay = base * (1.0 - jitterFactor + Double.random(in: 0...(2 * jitterFactor)))
        } else {
            delay = retryInterval * (1.0 - jitterFactor + Double.random(in: 0...(2 * jitterFactor)))
        }

        let safeDelay = max(delay, 1.0)
        eventSource?.stop()
        eventSource = nil
        sseQueue.asyncAfter(deadline: .now() + safeDelay) { [weak self] in
            guard let self = self else { return }
            self.sseQueue.async {
                guard self.isRunning, attemptVersion == self.connectionAttemptVersion else { return }
                self.establishConnection(attemptVersion: attemptVersion)
            }
        }
    }
    
    private class SseHandler: EventHandler {
        weak var parent: NitroSse?
        weak var source: EventSource?
        let attemptVersion: Int
        
        init(parent: NitroSse, attemptVersion: Int) {
            self.parent = parent
            self.attemptVersion = attemptVersion
        }
        
        /// Handle a successful SSE connection open for this handler.
        /// 
        /// If this handler corresponds to the active connection and its attempt version matches the parent's current connectionAttemptVersion, resets `backoffCounter`, `currentReconnectAttempts`, and `consecutiveAuthErrors`, and enqueues an `.open` `SseEvent` with status code 200.
        func onOpened() {
            guard let parent = self.parent, source === parent.eventSource else { return }
            parent.sseQueue.async { [weak parent] in
                guard let parent = parent, self.attemptVersion == parent.connectionAttemptVersion else { return }
                parent.backoffCounter = 0
                parent.currentReconnectAttempts = 0
                parent.consecutiveAuthErrors = 0 
                parent.pushEventToBuffer(SseEvent(type: .open, data: nil, parsedData: nil, id: nil, event: nil, message: nil, statusCode: 200, retry: nil))
            }
        }
        
        func onClosed() {
            guard let parent = self.parent, source === parent.eventSource else { return }
            parent.sseQueue.async { [weak parent] in
                guard let parent = parent, self.attemptVersion == parent.connectionAttemptVersion else { return }
                if let rid = parent.requestId {
                    NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(parent.totalBytesReceived))
                    parent.requestId = nil
                }
                if parent.isRunning {
                    parent.scheduleAutomaticReconnect(isError: false, attemptVersion: self.attemptVersion)
                }
            }
        }
        
        func onMessage(eventType: String, messageEvent: MessageEvent) {
            guard let parent = self.parent, source === parent.eventSource else { return }
            parent.sseQueue.async { [weak parent] in
                guard let parent = parent, self.attemptVersion == parent.connectionAttemptVersion else { return }
                let encodedDataSize = Double(messageEvent.data.utf8.count)
                let metadataSize = Double(eventType.utf8.count) + Double((messageEvent.lastEventId).utf8.count)
                parent.totalBytesReceived += encodedDataSize + metadataSize
                
                if !messageEvent.lastEventId.isEmpty {
                    parent.lastProcessedId = messageEvent.lastEventId
                }
                
                let parsedData = (parent.config?.autoParseJSON == true) ? parent.parseJsonToAnyMap(messageEvent.data) : nil
                
                parent.pushEventToBuffer(SseEvent(type: .message, data: messageEvent.data, parsedData: parsedData, id: messageEvent.lastEventId, event: eventType, message: nil, statusCode: 200, retry: nil))
            }
        }
        
        func onComment(comment: String) {
            guard let parent = self.parent, source === parent.eventSource else { return }
            parent.sseQueue.async { [weak parent] in
                guard let parent = parent, self.attemptVersion == parent.connectionAttemptVersion else { return }
                parent.totalBytesReceived += Double(comment.utf8.count)
                parent.pushEventToBuffer(SseEvent(type: .heartbeat, data: nil, parsedData: nil, id: nil, event: nil, message: comment, statusCode: nil, retry: nil))
            }
        }
        
        func onError(error: Error) {
            guard let parent = self.parent, source === parent.eventSource else { return }
            parent.sseQueue.async { [weak parent] in
                guard let parent = parent, parent.isRunning, self.attemptVersion == parent.connectionAttemptVersion else { return }
                let nsError = error as NSError
                let statusCode = nsError.code
                
                parent.reconnectCount += 1
                parent.lastErrorTime = Date().timeIntervalSince1970 * 1000
                parent.lastErrorCode = "\(nsError.domain)(\(statusCode))"

                NitroSseNetworkInspector.reportRequestFailed(parent.requestId, cancelled: false)
                parent.requestId = nil
                
                if statusCode == 204 {
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "No Content (204). Stopping.", statusCode: 204, retry: nil))
                    parent.stopInternal()
                    return
                }

                if statusCode == 401 || statusCode == 403 {
                    if parent.config?.onBeforeRequest == nil {
                        parent.pushEventToBuffer(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Auth Error (\(statusCode)) - No interceptor provided. Stopping.", statusCode: Double(statusCode), retry: nil))
                        parent.stopInternal()
                        return
                    }

                    parent.consecutiveAuthErrors += 1
                    if parent.consecutiveAuthErrors >= parent.maxAuthRetries {
                        parent.pushEventToBuffer(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Auth Error (\(statusCode)) - Retry limit reached (\(parent.maxAuthRetries)). Stopping.", statusCode: Double(statusCode), retry: nil))
                        parent.stopInternal()
                        return
                    }
                    
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Auth Error (\(statusCode)) - Retry \(parent.consecutiveAuthErrors)/\(parent.maxAuthRetries). Refreshing token...", statusCode: Double(statusCode), retry: nil))
                    parent.scheduleAutomaticReconnect(isError: true, attemptVersion: self.attemptVersion)
                    return
                }

                let isFatal = (statusCode == 400)
                if isFatal {
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Fatal Error (\(statusCode)). Stopping.", statusCode: Double(statusCode), retry: nil))
                    parent.stopInternal()
                    return
                }

                let retryAfterSeconds = parent.extractRetryAfterSeconds(error: error)
                if (statusCode == 429 || statusCode == 503), let retryAfter = retryAfterSeconds {
                    let jitter = Double.random(in: 0.5...1.5)
                    let totalDelay = retryAfter + jitter
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Retry-After received: \(Int(totalDelay))s", statusCode: Double(statusCode), retry: totalDelay * 1000.0))
                    parent.scheduleAutomaticReconnectWithFixedDelay(totalDelay, attemptVersion: self.attemptVersion)
                    return
                }

                if statusCode == 429 {
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: "Rate Limited (429) without Retry-After. Stopping.", statusCode: 429, retry: nil))
                    parent.stopInternal()
                    return
                }

                parent.pushEventToBuffer(SseEvent(type: .error, data: nil, parsedData: nil, id: nil, event: nil, message: error.localizedDescription, statusCode: Double(statusCode), retry: nil))
                parent.scheduleAutomaticReconnect(isError: true, attemptVersion: self.attemptVersion)
            }
        }
    }
}
