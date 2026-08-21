import Foundation
import LDSwiftEventSource

/// Delegate protocol for receiving lifecycle and stream events from `SseConnectionHandler`.
protocol SseConnectionDelegate: AnyObject {
    func connectionDidOpen(attemptVersion: Int)
    func connectionDidClose(attemptVersion: Int)
    func connectionDidReceiveMessage(eventType: String, data: String, lastEventId: String, attemptVersion: Int)
    func connectionDidReceiveComment(_ comment: String, attemptVersion: Int)
    func connectionDidFail(error: Error, attemptVersion: Int)
}

/// Factory constructing `LDSwiftEventSource.EventSource` instances configured with custom timeouts, headers, and HTTP methods.
enum SseConnectionHandler {
    
    /// Instantiates and starts an `EventSource` connection using `SseConfig` properties and initial event ID state.
    static func createEventSource(
        url: URL,
        config: SseConfig,
        lastProcessedId: String?,
        delegate: SseConnectionDelegate,
        attemptVersion: Int,
        dispatcher: SseDispatcher
    ) -> EventSource {
        let sessionConfig = URLSessionConfiguration.default
        let readTimeout = (config.readTimeoutMs ?? 300000.0) / 1000.0
        // Use timeoutIntervalForRequest (resets on incoming chunks) rather than timeoutIntervalForResource.
        // Setting timeoutIntervalForResource would hard-cap the total lifetime of persistent SSE streams.
        sessionConfig.timeoutIntervalForRequest = readTimeout
        
        let connectionTimeout = (config.connectionTimeoutMs ?? 15000.0) / 1000.0
        let handler = SseHandler(delegate: delegate, attemptVersion: attemptVersion, dispatcher: dispatcher)
        var esConfig = EventSource.Config(handler: handler, url: url)
        esConfig.connectionErrorHandler = { [weak handler] error in
            handler?.onError(error: error)
            return .shutdown
        }
        esConfig.urlSessionConfiguration = sessionConfig
        esConfig.headers = config.headers ?? [:]
        esConfig.lastEventId = lastProcessedId ?? ""
        esConfig.method = config.method?.stringValue.uppercased() ?? "GET"
        esConfig.body = config.body?.data(using: .utf8)
        
        let es = EventSource(config: esConfig)
        handler.source = es
        handler.startConnectionTimer(timeout: connectionTimeout)
        es.start()
        return es
    }
}

// MARK: - SseHandler

/// Adapts `LDSwiftEventSource.EventHandler` callbacks into `SseConnectionDelegate` dispatches.
/// Ensures all events are safely posted to the specified `SseDispatcher` queue and checks source identity to filter stale events.
private class SseHandler: EventHandler {
    weak var delegate: SseConnectionDelegate?
    weak var source: EventSource?
    let attemptVersion: Int
    let dispatcher: SseDispatcher
    private var isConnectedOrFinished: Bool = false
    
    init(delegate: SseConnectionDelegate, attemptVersion: Int, dispatcher: SseDispatcher) {
        self.delegate = delegate
        self.attemptVersion = attemptVersion
        self.dispatcher = dispatcher
    }
    
    private func dispatchToDelegate(isTerminal: Bool = false, _ action: @escaping (SseConnectionDelegate) -> Void) {
        dispatcher.async { [weak self] in
            guard let self = self, self.source != nil else { return }
            if isTerminal {
                self.isConnectedOrFinished = true
            }
            guard let delegate = self.delegate else { return }
            action(delegate)
        }
    }
    
    func startConnectionTimer(timeout: TimeInterval) {
        guard timeout > 0 else { return }
        dispatcher.asyncAfter(delay: timeout) { [weak self] in
            guard let self = self, !self.isConnectedOrFinished, self.source != nil else { return }
            self.isConnectedOrFinished = true
            self.source?.stop()
            self.source = nil
            self.delegate?.connectionDidFail(
                error: NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut, userInfo: [NSLocalizedDescriptionKey: "Connection timed out"]),
                attemptVersion: self.attemptVersion
            )
        }
    }
    
    func onOpened() {
        dispatchToDelegate(isTerminal: true) { delegate in
            delegate.connectionDidOpen(attemptVersion: self.attemptVersion)
        }
    }
    
    func onClosed() {
        dispatchToDelegate(isTerminal: true) { delegate in
            delegate.connectionDidClose(attemptVersion: self.attemptVersion)
        }
    }
    
    func onMessage(eventType: String, messageEvent: MessageEvent) {
        dispatchToDelegate { delegate in
            delegate.connectionDidReceiveMessage(
                eventType: eventType,
                data: messageEvent.data,
                lastEventId: messageEvent.lastEventId,
                attemptVersion: self.attemptVersion
            )
        }
    }
    
    /// Maps native SSE comments (lines starting with ':') to heartbeat events.
    /// LDSwiftEventSource parses comments natively via `onComment`, avoiding manual byte parsing.
    func onComment(comment: String) {
        dispatchToDelegate { delegate in
            delegate.connectionDidReceiveComment(comment, attemptVersion: self.attemptVersion)
        }
    }
    
    func onError(error: Error) {
        dispatchToDelegate(isTerminal: true) { delegate in
            delegate.connectionDidFail(error: error, attemptVersion: self.attemptVersion)
        }
    }
}
