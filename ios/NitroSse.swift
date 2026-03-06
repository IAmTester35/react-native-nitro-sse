import Foundation
import NitroModules
import LDSwiftEventSource

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
    private var eventSource: EventSource?
    private var config: SseConfig?
    private var onEventsCallback: ((_ events: [SseEvent]) -> Void)?
    private var isRunning: Bool = false
    private var needsHeaderRefresh: Bool = true
    private var consecutiveAuthErrors: Int = 0
    private let maxAuthRetries: Int = 3
    private var requestId: String? = nil   
    private var eventBuffer: [SseEvent] = []
    private var isFlushPending: Bool = false
    
    private var backoffCounter: Int = 0
    private var lastProcessedId: String? = nil
    
    private var totalBytesReceived: Double = 0
    private var reconnectCount: Double = 0
    private var lastErrorTime: Double? = nil
    private var lastErrorCode: String? = nil
    
    private let defaultRetryDelay: TimeInterval = 3.0
    private let baseBackoffDelay: TimeInterval = 1.0
    private let maxBackoffDelay: TimeInterval = 30.0
    
    private let sseQueue = DispatchQueue(label: "com.margelo.nitro.sse", qos: .utility)
    private var backgroundTaskIdentifier: UIBackgroundTaskIdentifier = .invalid
    private var wasRunningBeforeHibernation: Bool = false

    func setup(config: SseConfig, onEvent: @escaping ((_ events: [SseEvent]) -> Void)) throws {
        self.config = config
        self.onEventsCallback = onEvent
        
        NotificationCenter.default.removeObserver(self)
        NotificationCenter.default.addObserver(self, selector: #selector(handleAppDidEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleAppWillEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
    }
    
    @objc private func handleAppDidEnterBackground() {
        sseQueue.async {
            guard self.isRunning else { return }
            
            self.wasRunningBeforeHibernation = true
            print("[NitroSse] App backgrounded. Hibernating connection.")
            
            self.backgroundTaskIdentifier = UIApplication.shared.beginBackgroundTask(withName: "NitroSse-GracefulHibernate") {
                self.cleanupBackgroundTask()
            }
            
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
    }
    
    @objc private func handleAppWillEnterForeground() {
        sseQueue.async {
            self.cleanupBackgroundTask()
            if self.wasRunningBeforeHibernation {
                print("[NitroSse] App foregrounded. Resuming stream.")
                self.wasRunningBeforeHibernation = false
                try? self.start()
            }
        }
    }
    
    private func cleanupBackgroundTask() {
        if self.backgroundTaskIdentifier != .invalid {
            UIApplication.shared.endBackgroundTask(self.backgroundTaskIdentifier)
            self.backgroundTaskIdentifier = .invalid
        }
    }

    private func pushEventToBuffer(_ event: SseEvent) {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        
        let batchIntervalMs = config?.batchingIntervalMs ?? 0
        let bufferCapacity = Int(config?.maxBufferSize ?? 1000)
        
        while eventBuffer.count >= bufferCapacity {
            eventBuffer.removeFirst()
        }
        eventBuffer.append(event)
        
        if batchIntervalMs <= 0 {
            flushEventsToJs()
        } else if !isFlushPending {
            isFlushPending = true
            sseQueue.asyncAfter(deadline: .now() + (Double(batchIntervalMs) / 1000.0)) { [weak self] in
                self?.flushEventsToJs()
            }
        }
    }
    
    private func flushEventsToJs() {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        guard !eventBuffer.isEmpty else { 
            isFlushPending = false
            return 
        }
        
        let batch = eventBuffer
        eventBuffer.removeAll()
        isFlushPending = false
        onEventsCallback?(batch)
    }

    func setLastProcessedId(id: String) {
        sseQueue.async {
            self.lastProcessedId = id
        }
    }

    func updateHeaders(headers: [String: String]) throws {
        sseQueue.async {
            guard var config = self.config else { return }
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
                onBeforeRequest: config.onBeforeRequest // Ensure onBeforeRequest is copied
            )
            self.needsHeaderRefresh = false // Explicit update satisfies refresh
            print("[NitroSse] Headers updated for subsequent connections.")
        }
    }

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

    func start() throws {
        sseQueue.async {
            guard !self.isRunning else { return }
            self.isRunning = true
            self.needsHeaderRefresh = true // Fresh start needs refresh
            self.backoffCounter = 0
            self.establishConnection()
        }
    }

    private func establishConnection() {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        guard isRunning, let config = config else { return }

        if let interceptor = config.onBeforeRequest, needsHeaderRefresh {
            // Strong reference to config to avoid it changing under us during async call
            let capturedConfig = config
            interceptor().then { [weak self] promise2 in
                promise2.then { [weak self] newHeaders in
                    self?.sseQueue.async {
                        guard let self = self, self.isRunning else { return }
                        self.config = SseConfig(
                            url: capturedConfig.url,
                            method: capturedConfig.method,
                            headers: newHeaders,
                            body: capturedConfig.body,
                            backgroundExecution: capturedConfig.backgroundExecution,
                            batchingIntervalMs: capturedConfig.batchingIntervalMs,
                            maxBufferSize: capturedConfig.maxBufferSize,
                            connectionTimeoutMs: capturedConfig.connectionTimeoutMs,
                            readTimeoutMs: capturedConfig.readTimeoutMs,
                            onBeforeRequest: capturedConfig.onBeforeRequest
                        )
                        self.needsHeaderRefresh = false
                        self.performEstablishConnection()
                    }
                }.catch { [weak self] error in
                    self?.handleInterceptorError(error)
                }
            }.catch { [weak self] error in
                self?.handleInterceptorError(error)
            }
        } else {
            self.performEstablishConnection()
        }
    }

    private func handleInterceptorError(_ error: Error) {
        sseQueue.async {
            guard self.isRunning else { return }
            print("[NitroSse] Interceptor failed: \(error.localizedDescription)")
            self.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Interceptor Error: \(error.localizedDescription)", statusCode: -1, retry: nil))
            // Reconnect after delay, marking that we still need a refresh
            self.needsHeaderRefresh = true
            self.scheduleAutomaticReconnect(isError: true)
        }
    }

    private func performEstablishConnection() {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        guard isRunning, let config = config, let url = URL(string: config.url) else { return }
        
        if let rid = self.requestId {
            NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(self.totalBytesReceived))
            self.requestId = nil
        }
        
        let handler = SseHandler(parent: self)
        var esConfig = EventSource.Config(handler: handler, url: url)
        esConfig.headers = config.headers ?? [:]
        
        if let lastId = self.lastProcessedId, !lastId.isEmpty {
            esConfig.headers["Last-Event-ID"] = lastId
        }
        
        esConfig.idleTimeout = (config.readTimeoutMs ?? 35000.0) / 1000.0
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

    func stop() {
        sseQueue.async {
            self.stopInternal()
        }
    }

    private func stopInternal() {
        self.isRunning = false
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

    func flush() {
        sseQueue.async {
            self.flushEventsToJs()
        }
    }

    func restart() {
        sseQueue.async {
            self.stopInternal()
            guard !self.isRunning else { return } // Should be false now
            self.isRunning = true
            self.requestId = nil
            self.establishConnection()
        }
    }

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

    // EventSource callback handling is done via SseHandler class below.

    
    private func scheduleAutomaticReconnectWithFixedDelay(_ delay: TimeInterval) {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        eventSource?.stop()
        eventSource = nil
        sseQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, self.isRunning else { return }
            self.establishConnection()
        }
    }
    
    private func scheduleAutomaticReconnect(isError: Bool) {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        eventSource?.stop()
        var delay: TimeInterval = defaultRetryDelay
        if isError {
            let exponent = Double(backoffCounter)
            let base = min(baseBackoffDelay * pow(2.0, exponent), maxBackoffDelay)
            backoffCounter += 1
            delay = base * (0.5 + Double.random(in: 0...1))
        } else {
            delay = defaultRetryDelay * (0.8 + Double.random(in: 0...0.4))
        }
        let safeDelay = max(delay, 2.0)
        let currentSource = self.eventSource
        eventSource?.stop()
        eventSource = nil
        sseQueue.asyncAfter(deadline: .now() + safeDelay) { [weak self] in
            guard let self = self, self.isRunning else { return }
            self.establishConnection()
        }
    }
    
    private class SseHandler: EventHandler {
        weak var parent: NitroSse?
        weak var source: EventSource?
        
        init(parent: NitroSse) {
            self.parent = parent
        }
        
        func onOpened() {
            guard let parent = parent, source === parent.eventSource else { return }
            parent.sseQueue.async { [weak parent] in
                guard let parent = parent else { return }
                parent.backoffCounter = 0
                parent.consecutiveAuthErrors = 0 // Successful connection, reset error counter
                // LDSwiftEventSource doesn't easily expose the response code in onOpened,
                // but we assume 200 if onOpened is called. 
                parent.pushEventToBuffer(SseEvent(type: .open, data: nil, id: nil, event: nil, message: nil, statusCode: 200, retry: nil))
            }
        }
        
        func onClosed() {
            guard let parent = parent, source === parent.eventSource else { return }
            parent.sseQueue.async { [weak parent] in
                guard let parent = parent else { return }
                if let rid = parent.requestId {
                    NitroSseNetworkInspector.reportResponseEnd(rid, encodedDataLength: Int(parent.totalBytesReceived))
                    parent.requestId = nil
                }
                if parent.isRunning {
                    parent.scheduleAutomaticReconnect(isError: false)
                }
            }
        }
        
        func onMessage(eventType: String, messageEvent: MessageEvent) {
            guard let parent = parent, source === parent.eventSource else { return }
            parent.sseQueue.async { [weak parent] in
                guard let parent = parent else { return }
                let encodedDataSize = Double(messageEvent.data.utf8.count)
                let metadataSize = Double(eventType.utf8.count) + Double((messageEvent.lastEventId).utf8.count)
                parent.totalBytesReceived += encodedDataSize + metadataSize
                
                if !messageEvent.lastEventId.isEmpty {
                    parent.lastProcessedId = messageEvent.lastEventId
                }
                
                parent.pushEventToBuffer(SseEvent(type: .message, data: messageEvent.data, id: messageEvent.lastEventId, event: eventType, message: nil, statusCode: 200, retry: nil))
            }
        }
        
        func onComment(comment: String) {
            guard let parent = parent, source === parent.eventSource else { return }
            parent.sseQueue.async { [weak parent] in
                guard let parent = parent else { return }
                parent.totalBytesReceived += Double(comment.utf8.count)
                parent.pushEventToBuffer(SseEvent(type: .heartbeat, data: nil, id: nil, event: nil, message: comment, statusCode: nil, retry: nil))
            }
        }
        
        func onError(error: Error) {
            guard let parent = parent, source === parent.eventSource else { return }
            parent.sseQueue.async { [weak parent] in
                guard let parent = parent, parent.isRunning else { return }
                let nsError = error as NSError
                let statusCode = nsError.code
                
                parent.reconnectCount += 1
                parent.lastErrorTime = Date().timeIntervalSince1970 * 1000
                parent.lastErrorCode = "\(nsError.domain)(\(statusCode))"

                NitroSseNetworkInspector.reportRequestFailed(parent.requestId, cancelled: false)
                parent.requestId = nil
                
                
                if statusCode == 204 {
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "No Content (204). Stopping.", statusCode: 204, retry: nil))
                    parent.stopInternal()
                    return
                }

                // 401/403 are recoverable if we have an interceptor, but with a limit
                if statusCode == 401 || statusCode == 403 {
                    parent.consecutiveAuthErrors += 1
                    if parent.consecutiveAuthErrors > parent.maxAuthRetries {
                        parent.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Auth Error (\(statusCode)) - Retry limit reached (\(parent.maxAuthRetries)). Stopping.", statusCode: Double(statusCode), retry: nil))
                        parent.stopInternal()
                        return
                    }
                    
                    parent.needsHeaderRefresh = true
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Auth Error (\(statusCode)) - Retry \(parent.consecutiveAuthErrors)/\(parent.maxAuthRetries). Refreshing token...", statusCode: Double(statusCode), retry: nil))
                    parent.scheduleAutomaticReconnect(isError: true)
                    return
                }

                let isFatal = (statusCode == 400)
                if isFatal {
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Fatal Error (\(statusCode)). Stopping.", statusCode: Double(statusCode), retry: nil))
                    parent.stopInternal()
                    return
                }

                let retryAfterSeconds = parent.extractRetryAfterSeconds(error: error)
                if (statusCode == 429 || statusCode == 503), let retryAfter = retryAfterSeconds {
                    let jitter = Double.random(in: 0.5...1.5)
                    let totalDelay = retryAfter + jitter
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Retry-After received: \(Int(totalDelay))s", statusCode: Double(statusCode), retry: totalDelay * 1000.0))
                    parent.scheduleAutomaticReconnectWithFixedDelay(totalDelay)
                    return
                }

                if statusCode == 429 {
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Rate Limited (429) without Retry-After. Stopping.", statusCode: 429, retry: nil))
                    parent.stopInternal()
                    return
                }

                parent.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: error.localizedDescription, statusCode: Double(statusCode), retry: nil))
                parent.scheduleAutomaticReconnect(isError: true)
            }
        }
    }
}
