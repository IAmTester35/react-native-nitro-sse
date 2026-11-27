import Foundation

/// Delegate protocol for receiving lifecycle and stream events from `SseConnectionHandler`.
protocol SseConnectionDelegate: AnyObject {
    func connectionDidOpen(response: HTTPURLResponse, attemptVersion: Int)
    func connectionDidClose(attemptVersion: Int)
    func connectionDidReceiveMessage(eventType: String, data: String, lastEventId: String, attemptVersion: Int)
    func connectionDidReceiveComment(_ comment: String, attemptVersion: Int)
    func connectionDidReceiveRetry(retryMs: Int64, attemptVersion: Int)
    func connectionDidFail(error: Error, response: HTTPURLResponse?, errorBody: String?, attemptVersion: Int)
    func connectionDidUpdateLastEventId(id: String?, attemptVersion: Int)
    func connectionDidReceiveDataChunk(
        rawWireBytes: Int64,
        decompressedBytes: Int64?,
        attemptVersion: Int
    )
    func connectionDidParseLines(count: Int, attemptVersion: Int)
    func connectionDidEncounterParseError(attemptVersion: Int)
}

extension SseConnectionDelegate {
    func connectionDidFail(error: Error, attemptVersion: Int) {
        connectionDidFail(error: error, response: nil, errorBody: nil, attemptVersion: attemptVersion)
    }

    func connectionDidFail(error: Error, response: HTTPURLResponse?, attemptVersion: Int) {
        connectionDidFail(error: error, response: response, errorBody: nil, attemptVersion: attemptVersion)
    }

    func connectionDidReceiveRetry(retryMs: Int64, attemptVersion: Int) {}

    func connectionDidUpdateLastEventId(id: String?, attemptVersion: Int) {}

    func connectionDidReceiveDataChunk(
        rawWireBytes: Int64,
        decompressedBytes: Int64?,
        attemptVersion: Int
    ) {}

    func connectionDidParseLines(count: Int, attemptVersion: Int) {}

    func connectionDidEncounterParseError(attemptVersion: Int) {}
}

/// Maximum bytes to read from HTTP error responses to prevent Out-Of-Memory errors.
private let maxErrorBodyBytes: Int = 8192

/// Protocol representing an active SSE connection that can be cancelled.
protocol SseEventSource: AnyObject {
    func stop()
}

// MARK: - RealSseEventSource

/// Native EventSource implementation backed by Apple Foundation `URLSession` and `URLSessionDataDelegate`.
internal class RealSseEventSource: NSObject, SseEventSource {
    private weak var delegate: SseConnectionDelegate?
    private let attemptVersion: Int
    private let dispatcher: SseDispatcher

    private var session: URLSession?
    private var task: URLSessionDataTask?
    private let parser: SseEventParser

    private var didReceiveValidResponse: Bool = false
    private var isFinished: Bool = false
    private var isTerminalDispatched: Bool = false
    private var isCancelled: Bool = false
    private var lastResponse: HTTPURLResponse?
    private var isGzip: Bool = false
    private var decompressedBytesReceived: Int64 = 0
    private var isCollectingErrorBody: Bool = false
    private var errorBodyData = Data()
    private var pendingErrorResponse: HTTPURLResponse?

    init(
        delegate: SseConnectionDelegate,
        attemptVersion: Int,
        dispatcher: SseDispatcher,
        initialLastEventId: String? = nil
    ) {
        self.delegate = delegate
        self.attemptVersion = attemptVersion
        self.dispatcher = dispatcher
        self.parser = SseEventParser(initialLastEventId: initialLastEventId)
        super.init()
        self.parser.delegate = self
    }

    func start(
        request: URLRequest,
        sessionConfig: URLSessionConfiguration,
        connectionTimeout: TimeInterval
    ) {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "com.margelo.nitro.sse.urlsession"

        let session = URLSession(configuration: sessionConfig, delegate: self, delegateQueue: queue)
        self.session = session

        let task = session.dataTask(with: request)
        self.task = task

        if connectionTimeout > 0 {
            startConnectionTimer(timeout: connectionTimeout)
        }
        task.resume()
    }

    func stop() {
        dispatcher.async { [weak self] in
            guard let self = self, !self.isCancelled else { return }
            self.isCancelled = true
            self.isFinished = true
            self.cleanupTransport()
        }
    }

    private func cleanupTransport() {
        dispatcher.assertOnQueue()
        task?.cancel()
        session?.invalidateAndCancel()
        task = nil
        session = nil
    }

    private func startConnectionTimer(timeout: TimeInterval) {
        dispatcher.asyncAfter(delay: timeout) { [weak self] in
            guard let self = self, !self.didReceiveValidResponse, !self.isFinished, !self.isCancelled else { return }
            self.isFinished = true
            if self.isCollectingErrorBody, let resp = self.pendingErrorResponse {
                self.isCollectingErrorBody = false
                let error = NSError(
                    domain: "NitroSse",
                    code: resp.statusCode,
                    userInfo: [NSLocalizedDescriptionKey: "HTTP \(resp.statusCode)"]
                )
                // WHATWG SSE Section 9.2.2: invalid UTF-8 bytes must be replaced with U+FFFD, not dropped.
                // swiftlint:disable:next optional_data_string_conversion
                let bodyString = self.errorBodyData.isEmpty ? nil : String(decoding: self.errorBodyData, as: UTF8.self)
                self.dispatchTerminalFailure(error: error, response: resp, errorBody: bodyString)
                return
            }
            let error = NSError(
                domain: NSURLErrorDomain,
                code: NSURLErrorTimedOut,
                userInfo: [NSLocalizedDescriptionKey: "Connection timed out after \(timeout) seconds"]
            )
            self.dispatchTerminalFailure(error: error, response: nil, errorBody: nil)
        }
    }

    private func dispatchTerminalFailure(error: Error, response: HTTPURLResponse?, errorBody: String? = nil) {
        guard !isTerminalDispatched else { return }
        isTerminalDispatched = true
        isFinished = true
        cleanupTransport()
        delegate?.connectionDidFail(
            error: error,
            response: response,
            errorBody: errorBody,
            attemptVersion: attemptVersion
        )
    }
}

// MARK: - URLSessionDataDelegate

extension RealSseEventSource: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        // Delegate callback confirming invalidation of the session and its delegate retain cycle.
    }

    private func handleNonOkResponse(
        _ httpResponse: HTTPURLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        let statusCode = httpResponse.statusCode
        // WHATWG EventSource Section 7: HTTP 204 No Content explicitly fails connection and halts reconnection
        if statusCode == 204 {
            let error = NSError(
                domain: "NitroSse",
                code: 204,
                userInfo: [NSLocalizedDescriptionKey: "HTTP 204 No Content"]
            )
            self.dispatchTerminalFailure(error: error, response: httpResponse, errorBody: nil)
            completionHandler(.cancel)
            return
        }

        if httpResponse.expectedContentLength == 0 {
            let error = NSError(
                domain: "NitroSse",
                code: statusCode,
                userInfo: [NSLocalizedDescriptionKey: "HTTP \(statusCode)"]
            )
            self.dispatchTerminalFailure(error: error, response: httpResponse, errorBody: nil)
            completionHandler(.cancel)
            return
        }

        self.isCollectingErrorBody = true
        self.pendingErrorResponse = httpResponse
        self.errorBodyData.removeAll()
        completionHandler(.allow)
    }

    private func handleHttpResponse(
        _ httpResponse: HTTPURLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        self.lastResponse = httpResponse
        guard httpResponse.statusCode == 200 else {
            handleNonOkResponse(httpResponse, completionHandler: completionHandler)
            return
        }

        // Validate Content-Type: exact MIME type before parameters must match text/event-stream
        let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type") ??
            (httpResponse.allHeaderFields["Content-Type"] as? String) ?? ""
        guard SseFailureClassifier.isEventStreamMimeType(contentType) else {
            let error = NSError(
                domain: "NitroSse",
                code: -2001,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Invalid Content-Type: expected text/event-stream but received '\(contentType)'"
                ]
            )
            self.dispatchTerminalFailure(error: error, response: httpResponse, errorBody: nil)
            completionHandler(.cancel)
            return
        }

        let contentEncoding = httpResponse.value(forHTTPHeaderField: "Content-Encoding") ??
            (httpResponse.allHeaderFields["Content-Encoding"] as? String) ?? ""
        if contentEncoding.lowercased().contains("gzip") {
            self.isGzip = true
        }

        self.didReceiveValidResponse = true
        self.delegate?.connectionDidOpen(response: httpResponse, attemptVersion: self.attemptVersion)
        completionHandler(.allow)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        dispatcher.async { [weak self] in
            guard let self = self, !self.isCancelled else {
                completionHandler(.cancel)
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                let error = NSError(
                    domain: "NitroSse",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid non-HTTP response"]
                )
                self.dispatchTerminalFailure(error: error, response: nil, errorBody: nil)
                completionHandler(.cancel)
                return
            }

            self.handleHttpResponse(httpResponse, completionHandler: completionHandler)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        dispatcher.async { [weak self] in
            guard let self = self, !self.isCancelled, !self.isTerminalDispatched else { return }
            if self.isCollectingErrorBody {
                let remaining = maxErrorBodyBytes - self.errorBodyData.count
                self.errorBodyData.append(data.prefix(remaining))
                if self.errorBodyData.count >= maxErrorBodyBytes {
                    self.isCollectingErrorBody = false
                    let resp = self.pendingErrorResponse
                    let statusCode = resp?.statusCode ?? 500
                    let error = NSError(
                        domain: "NitroSse",
                        code: statusCode,
                        userInfo: [NSLocalizedDescriptionKey: "HTTP \(statusCode)"]
                    )
                    // WHATWG SSE Section 9.2.2: invalid UTF-8 bytes must be replaced with U+FFFD, not dropped.
                    // swiftlint:disable:next optional_data_string_conversion
                    let bodyString = String(decoding: self.errorBodyData, as: UTF8.self)
                    self.dispatchTerminalFailure(error: error, response: resp, errorBody: bodyString)
                }
                return
            }
            self.decompressedBytesReceived += Int64(data.count)
            let rawBytesCount = dataTask.countOfBytesReceived > 0
                ? dataTask.countOfBytesReceived
                : self.decompressedBytesReceived
            if !self.isGzip &&
                dataTask.countOfBytesReceived > 0 &&
                self.decompressedBytesReceived > dataTask.countOfBytesReceived {
                self.isGzip = true
            }
            self.delegate?.connectionDidReceiveDataChunk(
                rawWireBytes: rawBytesCount,
                decompressedBytes: self.isGzip ? self.decompressedBytesReceived : nil,
                attemptVersion: self.attemptVersion
            )
            self.parser.feed(data: data)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        dispatcher.async { [weak self] in
            guard let self = self, !self.isCancelled else { return }
            self.isFinished = true

            if self.isCollectingErrorBody {
                self.isCollectingErrorBody = false
                let resp = self.pendingErrorResponse
                let statusCode = resp?.statusCode ?? 500
                let finalError = error ?? NSError(
                    domain: "NitroSse",
                    code: statusCode,
                    userInfo: [NSLocalizedDescriptionKey: "HTTP \(statusCode)"]
                )
                // WHATWG SSE Section 9.2.2: invalid UTF-8 bytes must be replaced with U+FFFD, not dropped.
                // swiftlint:disable:next optional_data_string_conversion
                let bodyString = self.errorBodyData.isEmpty ? nil : String(decoding: self.errorBodyData, as: UTF8.self)
                self.dispatchTerminalFailure(error: finalError, response: resp, errorBody: bodyString)
                return
            }

            if let error = error {
                let nsError = error as NSError
                if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
                    // Intentionally cancelled or stopped
                    self.cleanupTransport()
                    return
                }
                self.dispatchTerminalFailure(error: error, response: self.lastResponse, errorBody: nil)
            } else {
                guard !self.isTerminalDispatched else { return }
                self.isTerminalDispatched = true
                self.parser.endOfStream()
                self.cleanupTransport()
                self.delegate?.connectionDidClose(attemptVersion: self.attemptVersion)
            }
        }
    }
}

// MARK: - SseEventParserDelegate

extension RealSseEventSource: SseEventParserDelegate {
    func parserDidReceiveEvent(id: String?, type: String?, data: String) {
        dispatcher.assertOnQueue()
        guard !isCancelled, !isTerminalDispatched else { return }
        delegate?.connectionDidReceiveMessage(
            eventType: type ?? "message",
            data: data,
            lastEventId: id ?? "",
            attemptVersion: attemptVersion
        )
    }

    func parserDidReceiveComment(_ comment: String) {
        dispatcher.assertOnQueue()
        guard !isCancelled, !isTerminalDispatched else { return }
        delegate?.connectionDidReceiveComment(comment, attemptVersion: attemptVersion)
    }

    func parserDidReceiveRetry(retryMs: Int64) {
        dispatcher.assertOnQueue()
        guard !isCancelled, !isTerminalDispatched else { return }
        delegate?.connectionDidReceiveRetry(retryMs: retryMs, attemptVersion: attemptVersion)
    }

    func parserDidUpdateLastEventId(_ id: String?) {
        dispatcher.assertOnQueue()
        guard !isCancelled, !isTerminalDispatched else { return }
        delegate?.connectionDidUpdateLastEventId(id: id, attemptVersion: attemptVersion)
    }

    func parserDidParseLines(_ count: Int) {
        dispatcher.assertOnQueue()
        guard !isCancelled, !isTerminalDispatched else { return }
        delegate?.connectionDidParseLines(count: count, attemptVersion: attemptVersion)
    }

    func parserDidFail(error: Error) {
        dispatcher.assertOnQueue()
        guard !isCancelled, !isTerminalDispatched else { return }
        delegate?.connectionDidEncounterParseError(attemptVersion: attemptVersion)
        dispatchTerminalFailure(error: error, response: lastResponse, errorBody: nil)
    }
}

// MARK: - SseConnectionHandler Factory

/// Factory creating native `RealSseEventSource` instances configured with custom timeouts, headers, and HTTP methods.
enum SseConnectionHandler {

    /// Constructs a standardized and sanitized URLRequest for SSE streaming.
    static func createRequest(
        url: URL,
        config: SseConfig,
        lastProcessedId: String?
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = config.method?.stringValue.uppercased() ?? "GET"

        // Prevent initial headers from overriding dynamic Last-Event-ID or disabling transparent gzip decompression.
        var headers = config.headers ?? [:]
        headers = headers.filter {
            $0.key.caseInsensitiveCompare("Last-Event-Id") != .orderedSame &&
            $0.key.caseInsensitiveCompare("Accept-Encoding") != .orderedSame
        }

        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }

        if let lastId = lastProcessedId, !lastId.isEmpty {
            request.setValue(lastId, forHTTPHeaderField: "Last-Event-ID")
        }

        if request.value(forHTTPHeaderField: "Accept") == nil {
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        }
        if request.value(forHTTPHeaderField: "Cache-Control") == nil {
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        }

        if let body = config.body {
            request.httpBody = body.data(using: .utf8)
        }
        return request
    }

    // swiftlint:disable function_parameter_count
    /// Instantiates and starts a native `SseEventSource` connection using `SseConfig` and session parameters.
    static func createEventSource(
        url: URL,
        config: SseConfig,
        lastProcessedId: String?,
        delegate: SseConnectionDelegate,
        attemptVersion: Int,
        dispatcher: SseDispatcher,
        protocolClasses: [AnyClass]? = nil
    ) -> SseEventSource {
        // swiftlint:enable function_parameter_count
        let sessionConfig = URLSessionConfiguration.default
        let rawReadTimeout = (config.readTimeoutMs ?? 300000.0) / 1000.0
        // Use timeoutIntervalForRequest (resets on incoming chunks) rather than timeoutIntervalForResource.
        // Setting timeoutIntervalForResource would hard-cap the total lifetime of persistent SSE streams.
        // A non-positive timeout interval is treated as infinite fallback (7 days) to prevent immediate timeout.
        let readTimeout = rawReadTimeout > 0 ? rawReadTimeout : 604800.0
        sessionConfig.timeoutIntervalForRequest = readTimeout

        if let protocolClasses = protocolClasses {
            sessionConfig.protocolClasses = protocolClasses
        }

        let rawConnectionTimeout = (config.connectionTimeoutMs ?? 15000.0) / 1000.0
        let connectionTimeout = rawConnectionTimeout > 0 ? rawConnectionTimeout : 0.0

        let request = createRequest(url: url, config: config, lastProcessedId: lastProcessedId)

        let source = RealSseEventSource(
            delegate: delegate,
            attemptVersion: attemptVersion,
            dispatcher: dispatcher,
            initialLastEventId: lastProcessedId
        )
        source.start(request: request, sessionConfig: sessionConfig, connectionTimeout: connectionTimeout)
        return source
    }
}
