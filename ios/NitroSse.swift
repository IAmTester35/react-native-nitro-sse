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
    
    private var eventBuffer: [SseEvent] = []
    private var isFlushPending: Bool = false
    
    private var backoffCounter: Int = 0
    private var lastProcessedId: String? = nil
    
    private var totalBytesReceived: Double = 0
    private var reconnectCount: Double = 0
    private var lastErrorTime: Double? = nil
    private var lastErrorCode: String? = nil
    
    private let defaultRetryDelay: TimeInterval = 3.0
    private let baseBackoffDelay: TimeInterval = 2.0
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
            if let currentConfig = self.config {
                self.config = SseConfig(
                    url: currentConfig.url,
                    method: currentConfig.method,
                    headers: headers,
                    body: currentConfig.body,
                    backgroundExecution: currentConfig.backgroundExecution,
                    batchingIntervalMs: currentConfig.batchingIntervalMs,
                    maxBufferSize: currentConfig.maxBufferSize
                )
            }
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
            self.backoffCounter = 0
            self.establishConnection()
        }
    }

    private func establishConnection() {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        let handler = SseHandler(parent: self)
        var esConfig = EventSource.Config(handler: handler, url: url)
        esConfig.headers = config.headers ?? [:]
        
        if let lastId = self.lastProcessedId, !lastId.isEmpty {
            esConfig.headers["Last-Event-ID"] = lastId
        }
        
        esConfig.idleTimeout = 35.0
        esConfig.method = config.method?.stringValue.uppercased() ?? "GET"
        esConfig.body = config.body?.data(using: .utf8)
        
        let es = EventSource(config: esConfig)
        self.eventSource = es
        handler.source = es
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
        self.backoffCounter = 0
        self.eventBuffer.removeAll()
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
            self.establishConnection()
        }
    }

    func isConnected() -> Bool {
        return sseQueue.sync {
            return isRunning
        }
    }
    
    func onOpened() {
        sseQueue.async {
            self.backoffCounter = 0
            self.pushEventToBuffer(SseEvent(type: .open, data: nil, id: nil, event: nil, message: nil))
        }
    }
    
    func onClosed() {
        sseQueue.async {
            if self.isRunning {
                self.scheduleAutomaticReconnect(isError: false)
            }
        }
    }
    
    func onMessage(eventType: String, messageEvent: MessageEvent) {
        sseQueue.async {
            let encodedDataSize = Double(messageEvent.data.utf8.count)
            let metadataSize = Double(eventType.utf8.count) + Double((messageEvent.lastEventId).utf8.count)
            self.totalBytesReceived += encodedDataSize + metadataSize
            
            self.pushEventToBuffer(SseEvent(type: .message, data: messageEvent.data, id: messageEvent.lastEventId, event: eventType, message: nil))
        }
    }
    
    func onComment(comment: String) {
        sseQueue.async {
            self.totalBytesReceived += Double(comment.utf8.count)
            self.pushEventToBuffer(SseEvent(type: .heartbeat, data: nil, id: nil, event: nil, message: comment))
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

    func onError(error: Error) {
        sseQueue.async {
            guard self.isRunning else { return }
            let nsError = error as NSError
            let statusCode = nsError.code
            
            self.reconnectCount += 1
            self.lastErrorTime = Date().timeIntervalSince1970 * 1000
            self.lastErrorCode = "\(nsError.domain)(\(statusCode))"

            let isFatalError = (statusCode == 401 || statusCode == 403 || statusCode == 400)
            if isFatalError {
                self.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Fatal Error (\(statusCode)). Stopping."))
                self.stop()
                return
            }

            let retryAfterSeconds = self.extractRetryAfterSeconds(error: error)
            if (statusCode == 429 || statusCode == 503), let delay = retryAfterSeconds {
                let jitter = Double.random(in: 0.5...2.0)
                let totalDelay = delay + jitter
                self.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Retry-After received (\(statusCode))"))
                self.scheduleAutomaticReconnectWithFixedDelay(totalDelay)
                return
            }

            if statusCode == 429 {
                self.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Rate Limited (429) without Retry-After. Stopping."))
                self.stop()
                return
            }
            
            self.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: error.localizedDescription))
            self.scheduleAutomaticReconnect(isError: true)
        }
    }
    
    private func scheduleAutomaticReconnectWithFixedDelay(_ delay: TimeInterval) {
        dispatchPrecondition(condition: .onQueue(sseQueue))
        eventSource?.stop()
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
        sseQueue.asyncAfter(deadline: .now() + safeDelay) { [weak self] in
            guard let self = self, self.isRunning, self.eventSource === currentSource else { return }
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
            parent.sseQueue.async {
                parent.backoffCounter = 0
                parent.pushEventToBuffer(SseEvent(type: .open, data: nil, id: nil, event: nil, message: nil))
            }
        }
        
        func onClosed() {
            guard let parent = parent, source === parent.eventSource else { return }
            parent.sseQueue.async {
                if parent.isRunning {
                    parent.scheduleAutomaticReconnect(isError: false)
                }
            }
        }
        
        func onMessage(eventType: String, messageEvent: MessageEvent) {
            guard let parent = parent, source === parent.eventSource else { return }
            parent.sseQueue.async {
                let encodedDataSize = Double(messageEvent.data.utf8.count)
                let metadataSize = Double(eventType.utf8.count) + Double((messageEvent.lastEventId).utf8.count)
                parent.totalBytesReceived += encodedDataSize + metadataSize
                
                parent.pushEventToBuffer(SseEvent(type: .message, data: messageEvent.data, id: messageEvent.lastEventId, event: eventType, message: nil))
            }
        }
        
        func onComment(comment: String) {
            guard let parent = parent, source === parent.eventSource else { return }
            parent.sseQueue.async {
                parent.totalBytesReceived += Double(comment.utf8.count)
                parent.pushEventToBuffer(SseEvent(type: .heartbeat, data: nil, id: nil, event: nil, message: comment))
            }
        }
        
        func onError(error: Error) {
            guard let parent = parent, source === parent.eventSource else { return }
            parent.sseQueue.async {
                guard parent.isRunning else { return }
                let nsError = error as NSError
                let statusCode = nsError.code
                
                parent.reconnectCount += 1
                parent.lastErrorTime = Date().timeIntervalSince1970 * 1000
                parent.lastErrorCode = "\(nsError.domain)(\(statusCode))"

                let isFatalError = (statusCode == 401 || statusCode == 403 || statusCode == 400)
                if isFatalError {
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Fatal Error (\(statusCode)). Stopping."))
                    parent.stopInternal()
                    return
                }

                let retryAfterSeconds = parent.extractRetryAfterSeconds(error: error)
                if (statusCode == 429 || statusCode == 503), let delay = retryAfterSeconds {
                    let jitter = Double.random(in: 0.5...2.0)
                    let totalDelay = delay + jitter
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Retry-After received (\(statusCode))"))
                    parent.scheduleAutomaticReconnectWithFixedDelay(totalDelay)
                    return
                }

                if statusCode == 429 {
                    parent.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: "Rate Limited (429) without Retry-After. Stopping."))
                    parent.stopInternal()
                    return
                }
                
                parent.pushEventToBuffer(SseEvent(type: .error, data: nil, id: nil, event: nil, message: error.localizedDescription))
                parent.scheduleAutomaticReconnect(isError: true)
            }
        }
    }
}
