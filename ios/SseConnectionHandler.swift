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
    func connectionDidReceiveDataChunk(chunkLength: Int, rawWireBytes: Int64, decompressedBytes: Int64?, attemptVersion: Int)
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

    func connectionDidReceiveDataChunk(chunkLength: Int, rawWireBytes: Int64, decompressedBytes: Int64?, attemptVersion: Int) {}

    func connectionDidParseLines(count: Int, attemptVersion: Int) {}

    func connectionDidEncounterParseError(attemptVersion: Int) {}
}

/// Maximum bytes to read from HTTP error responses to prevent Out-Of-Memory errors.
private let MAX_ERROR_BODY_BYTES: Int = 8192

/// Maximum bytes allowed for a single SSE line to prevent Out-Of-Memory errors.
private let MAX_SSE_LINE_LENGTH: Int = 16 * 1024 * 1024

/// Maximum bytes allowed for accumulated event data to prevent Out-Of-Memory errors.
private let MAX_SSE_EVENT_DATA_SIZE: Int = 16 * 1024 * 1024

/// Protocol representing an active SSE connection that can be cancelled.
protocol SseEventSource: AnyObject {
    func stop()
}

// MARK: - WHATWG SseEventParser

protocol SseEventParserDelegate: AnyObject {
    func parserDidReceiveEvent(id: String?, type: String?, data: String)
    func parserDidReceiveComment(_ comment: String)
    func parserDidReceiveRetry(retryMs: Int64)
    func parserDidUpdateLastEventId(_ id: String?)
    func parserDidFail(error: Error)
    func parserDidParseLines(_ count: Int)
}

extension SseEventParserDelegate {
    func parserDidUpdateLastEventId(_ id: String?) {}
    func parserDidFail(error: Error) {}
    func parserDidParseLines(_ count: Int) {}
}

/// Sequential streaming line-by-line SSE parser complying strictly with WHATWG Server-Sent Events specification.
/// Handles CR, LF, and CRLF line breaks, multi-line data concatenation, comments, IDs, and retry directives.
internal class SseEventParser {
    weak var delegate: SseEventParserDelegate?
    
    private var buffer = Data()
    private var dataBuffer: String = ""
    private var hasData: Bool = false
    private var eventType: String? = nil
    private var lastEventId: String? = nil
    private var isAtStreamStart: Bool = true
    
    init(initialLastEventId: String? = nil) {
        self.lastEventId = initialLastEventId
    }
    
    func reset(initialLastEventId: String? = nil) {
        buffer.removeAll()
        dataBuffer = ""
        hasData = false
        eventType = nil
        lastEventId = initialLastEventId
        isAtStreamStart = true
    }
    
    /// Flushes any pending data or un-terminated line when the stream reaches EOF.
    /// Per WHATWG SSE specification: "Once the end of the file is reached, any pending data must be dispatched as an event."
    func endOfStream() {
        if !buffer.isEmpty {
            if buffer.last == 0x0D {
                buffer.removeLast()
            }
            let line = String(decoding: buffer, as: UTF8.self)
            buffer.removeAll()
            processLine(line)
            delegate?.parserDidParseLines(1)
        }
        if hasData {
            let eventData = dataBuffer
            let id = lastEventId
            let type = eventType
            
            dataBuffer = ""
            hasData = false
            eventType = nil
            
            delegate?.parserDidReceiveEvent(id: id, type: type, data: eventData)
        }
    }
    
    func feed(data: Data) {
        guard !data.isEmpty else { return }
        var parsedLinesInChunk = 0
        defer {
            if parsedLinesInChunk > 0 {
                delegate?.parserDidParseLines(parsedLinesInChunk)
            }
        }
        
        var currentData = data
        if isAtStreamStart {
            if buffer.isEmpty && currentData.count >= 3 {
                let sIdx = currentData.startIndex
                if currentData[sIdx] == 0xEF && currentData[sIdx + 1] == 0xBB && currentData[sIdx + 2] == 0xBF {
                    currentData = currentData.subdata(in: (sIdx + 3)..<currentData.endIndex)
                }
                isAtStreamStart = false
            } else {
                let bom: [UInt8] = [0xEF, 0xBB, 0xBF]
                buffer.append(currentData)
                if buffer.count >= 3 {
                    if buffer[0] == 0xEF && buffer[1] == 0xBB && buffer[2] == 0xBF {
                        buffer.removeSubrange(0..<3)
                    }
                    isAtStreamStart = false
                    currentData = buffer
                    buffer.removeAll()
                } else {
                    for i in 0..<buffer.count {
                        if buffer[i] != bom[i] {
                            isAtStreamStart = false
                            currentData = buffer
                            buffer.removeAll()
                            break
                        }
                    }
                    if isAtStreamStart {
                        return
                    }
                }
            }
        }
        
        var readIndex = currentData.startIndex
        let endIndex = currentData.endIndex
        
        // If buffer has leftover bytes from previous chunks, handle line boundary first
        if !buffer.isEmpty {
            // Handle CR/CRLF split across chunk boundary
            if buffer.last == 0x0D {
                buffer.removeLast()
                let line = String(decoding: buffer, as: UTF8.self)
                buffer.removeAll()
                processLine(line)
                parsedLinesInChunk += 1
                if currentData.first == 0x0A {
                    readIndex = currentData.startIndex + 1
                }
            } else if let firstLine = findNextLine(in: currentData, from: readIndex) {
                if buffer.count + firstLine.content.count > MAX_SSE_LINE_LENGTH {
                    let error = NSError(domain: "NitroSse", code: -2002, userInfo: [NSLocalizedDescriptionKey: "SSE line exceeded maximum limit of \(MAX_SSE_LINE_LENGTH) bytes"])
                    delegate?.parserDidFail(error: error)
                    buffer.removeAll()
                    return
                }
                buffer.append(currentData.subdata(in: firstLine.content))
                let line = String(decoding: buffer, as: UTF8.self)
                buffer.removeAll()
                processLine(line)
                parsedLinesInChunk += 1
                readIndex = firstLine.nextIndex
            } else {
                // currentData has no line ending: append chunk to buffer if within limit
                if buffer.count + currentData.count > MAX_SSE_LINE_LENGTH {
                    let error = NSError(domain: "NitroSse", code: -2002, userInfo: [NSLocalizedDescriptionKey: "SSE line exceeded maximum limit of \(MAX_SSE_LINE_LENGTH) bytes"])
                    delegate?.parserDidFail(error: error)
                    buffer.removeAll()
                    return
                }
                buffer.append(currentData)
                return
            }
        }
        
        // Scan remaining lines directly from currentData without buffering full chunk
        while readIndex < endIndex {
            guard let lineRange = findNextLine(in: currentData, from: readIndex) else {
                break
            }
            
            if lineRange.content.count > MAX_SSE_LINE_LENGTH {
                let error = NSError(domain: "NitroSse", code: -2002, userInfo: [NSLocalizedDescriptionKey: "SSE line exceeded maximum limit of \(MAX_SSE_LINE_LENGTH) bytes"])
                delegate?.parserDidFail(error: error)
                buffer.removeAll()
                return
            }
            
            let lineData = currentData.subdata(in: lineRange.content)
            readIndex = lineRange.nextIndex
            
            let line = String(decoding: lineData, as: UTF8.self)
            processLine(line)
            parsedLinesInChunk += 1
        }
        
        // Save trailing incomplete line fragment into buffer
        if readIndex < endIndex {
            let trailingData = currentData.subdata(in: readIndex..<endIndex)
            if buffer.count + trailingData.count > MAX_SSE_LINE_LENGTH {
                let error = NSError(domain: "NitroSse", code: -2002, userInfo: [NSLocalizedDescriptionKey: "SSE line exceeded maximum limit of \(MAX_SSE_LINE_LENGTH) bytes"])
                delegate?.parserDidFail(error: error)
                buffer.removeAll()
                return
            }
            buffer.append(trailingData)
        }
    }
    
    private struct LineRange {
        let content: Range<Int>
        let nextIndex: Int
    }
    
    /// Finds next line in data from startIndex handling \r\n, \r, and \n.
    /// If data ends with \r at the very end, returns nil to defer until next chunk so \r\n can be resolved.
    private func findNextLine(in data: Data, from startIndex: Int) -> LineRange? {
        let endIndex = data.endIndex
        guard startIndex < endIndex else { return nil }
        
        var index = startIndex
        while index < endIndex {
            let byte = data[index]
            if byte == 0x0A { // \n (LF)
                return LineRange(content: startIndex..<index, nextIndex: index + 1)
            } else if byte == 0x0D { // \r (CR)
                if index + 1 < endIndex {
                    if data[index + 1] == 0x0A { // \r\n (CRLF)
                        return LineRange(content: startIndex..<index, nextIndex: index + 2)
                    } else { // Single \r
                        return LineRange(content: startIndex..<index, nextIndex: index + 1)
                    }
                } else {
                    // Buffer ends with \r; wait for next chunk to verify if it is \r\n
                    return nil
                }
            }
            index += 1
        }
        return nil
    }
    
    private func processLine(_ line: String) {
        if line.isEmpty {
            // Empty line dispatches the current event per WHATWG specification
            if hasData {
                let eventData = dataBuffer
                let id = lastEventId
                let type = eventType
                
                dataBuffer = ""
                hasData = false
                eventType = nil
                
                delegate?.parserDidReceiveEvent(id: id, type: type, data: eventData)
            }
            return
        }
        
        if line.hasPrefix(":") {
            // WHATWG SSE: Lines starting with ':' are comments (often used for keepalive/heartbeat).
            // Normalizes comment by removing only a single leading space per WHATWG SSE specification.
            let rawComment = String(line.dropFirst())
            let comment = rawComment.hasPrefix(" ") ? String(rawComment.dropFirst()) : rawComment
            delegate?.parserDidReceiveComment(comment)
            return
        }
        
        let colonIndex = line.firstIndex(of: ":")
        let field: String
        var value: String
        
        if let colon = colonIndex {
            field = String(line[..<colon])
            let rawValue = String(line[line.index(after: colon)...])
            value = rawValue.hasPrefix(" ") ? String(rawValue.dropFirst()) : rawValue
        } else {
            field = line
            value = ""
        }
        
        switch field {
        case "data":
            let separatorSize = hasData ? 1 : 0
            if dataBuffer.utf8.count + separatorSize + value.utf8.count > MAX_SSE_EVENT_DATA_SIZE {
                let error = NSError(domain: "NitroSse", code: -2003, userInfo: [NSLocalizedDescriptionKey: "SSE event data exceeded maximum limit of \(MAX_SSE_EVENT_DATA_SIZE) bytes"])
                delegate?.parserDidFail(error: error)
                dataBuffer = ""
                hasData = false
                return
            }
            if hasData {
                dataBuffer.append("\n")
                dataBuffer.append(value)
            } else {
                dataBuffer = value
                hasData = true
            }
        case "id":
            // WHATWG: If field value contains a U+0000 NULL character, the field must be ignored.
            if !value.contains("\0") {
                lastEventId = value.isEmpty ? nil : value
                delegate?.parserDidUpdateLastEventId(lastEventId)
            }
        case "event":
            eventType = value.isEmpty ? nil : value
        case "retry":
            if !value.isEmpty && value.allSatisfy({ $0.isASCII && $0.isNumber }), let retryVal = Int64(value), retryVal >= 0 {
                delegate?.parserDidReceiveRetry(retryMs: retryVal)
            }
        default:
            // Unrecognized fields are ignored per WHATWG specification
            break
        }
    }
}

// MARK: - RealSseEventSource

/// Native EventSource implementation backed by Apple Foundation `URLSession` and `URLSessionDataDelegate`.
internal class RealSseEventSource: NSObject, URLSessionDataDelegate, SseEventSource, SseEventParserDelegate {
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
    
    init(delegate: SseConnectionDelegate, attemptVersion: Int, dispatcher: SseDispatcher, initialLastEventId: String? = nil) {
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
        guard timeout > 0 else { return }
        dispatcher.asyncAfter(delay: timeout) { [weak self] in
            guard let self = self, !self.didReceiveValidResponse, !self.isFinished, !self.isCancelled else { return }
            self.isFinished = true
            let error = NSError(
                domain: NSURLErrorDomain,
                code: NSURLErrorTimedOut,
                userInfo: [NSLocalizedDescriptionKey: "Connection timed out after \(timeout) seconds"]
            )
            self.dispatchTerminalFailure(error: error, response: nil, errorBody: nil)
        }
    }
    
    // MARK: - URLSessionTaskDelegate & URLSessionDataDelegate

    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        // Delegate callback confirming invalidation of the session and its delegate retain cycle.
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
                let error = NSError(domain: "NitroSse", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid non-HTTP response"])
                self.isFinished = true
                self.dispatchTerminalFailure(error: error, response: nil, errorBody: nil)
                completionHandler(.cancel)
                return
            }
            
            self.lastResponse = httpResponse
            let statusCode = httpResponse.statusCode
            
            // WHATWG EventSource Section 7: HTTP 204 No Content explicitly fails connection and halts reconnection
            if statusCode == 204 {
                let error = NSError(
                    domain: "NitroSse",
                    code: 204,
                    userInfo: [NSLocalizedDescriptionKey: "HTTP 204 No Content"]
                )
                self.isFinished = true
                self.dispatchTerminalFailure(error: error, response: httpResponse, errorBody: nil)
                completionHandler(.cancel)
                return
            }
            
            // Validate HTTP Status Code (Collect bounded body if statusCode is not 200)
            guard statusCode == 200 else {
                self.isFinished = true
                if httpResponse.expectedContentLength == 0 {
                    let error = NSError(domain: "NitroSse", code: statusCode, userInfo: [NSLocalizedDescriptionKey: "HTTP \(statusCode)"])
                    self.dispatchTerminalFailure(error: error, response: httpResponse, errorBody: nil)
                    completionHandler(.cancel)
                    return
                }

                self.isCollectingErrorBody = true
                self.pendingErrorResponse = httpResponse
                self.errorBodyData.removeAll()
                completionHandler(.allow)
                return
            }
            
            // Validate Content-Type: exact MIME type before parameters must match text/event-stream
            let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type") ??
                (httpResponse.allHeaderFields["Content-Type"] as? String) ?? ""
            let mimeType = contentType.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
            guard mimeType == "text/event-stream" else {
                let error = NSError(
                    domain: "NitroSse",
                    code: -2001,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid Content-Type: expected text/event-stream but received '\(contentType)'"]
                )
                self.isFinished = true
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
    }
    
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        dispatcher.async { [weak self] in
            guard let self = self, !self.isCancelled, !self.isTerminalDispatched else { return }
            if self.isCollectingErrorBody {
                let remaining = MAX_ERROR_BODY_BYTES - self.errorBodyData.count
                if remaining > 0 {
                    let chunk = data.count > remaining ? data.prefix(remaining) : data
                    self.errorBodyData.append(chunk)
                }
                if self.errorBodyData.count >= MAX_ERROR_BODY_BYTES {
                    self.isCollectingErrorBody = false
                    let resp = self.pendingErrorResponse ?? self.lastResponse
                    let statusCode = resp?.statusCode ?? 500
                    let error = NSError(domain: "NitroSse", code: statusCode, userInfo: [NSLocalizedDescriptionKey: "HTTP \(statusCode)"])
                    let bodyString = String(decoding: self.errorBodyData, as: UTF8.self)
                    self.dispatchTerminalFailure(error: error, response: resp, errorBody: bodyString)
                }
                return
            }
            self.decompressedBytesReceived += Int64(data.count)
            let rawBytesCount = dataTask.countOfBytesReceived > 0 ? dataTask.countOfBytesReceived : self.decompressedBytesReceived
            if !self.isGzip && dataTask.countOfBytesReceived > 0 && self.decompressedBytesReceived > dataTask.countOfBytesReceived {
                self.isGzip = true
            }
            self.delegate?.connectionDidReceiveDataChunk(
                chunkLength: data.count,
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
                let resp = self.pendingErrorResponse ?? self.lastResponse
                let statusCode = resp?.statusCode ?? 500
                let finalError = error ?? NSError(domain: "NitroSse", code: statusCode, userInfo: [NSLocalizedDescriptionKey: "HTTP \(statusCode)"])
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
    
    private func dispatchTerminalFailure(error: Error, response: HTTPURLResponse?, errorBody: String? = nil) {
        guard !isTerminalDispatched else { return }
        isTerminalDispatched = true
        isFinished = true
        cleanupTransport()
        delegate?.connectionDidFail(error: error, response: response, errorBody: errorBody, attemptVersion: attemptVersion)
    }
    
    // MARK: - SseEventParserDelegate
    
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
        let sessionConfig = URLSessionConfiguration.default
        let rawReadTimeout = (config.readTimeoutMs ?? 300000.0) / 1000.0
        // Use timeoutIntervalForRequest (resets on incoming chunks) rather than timeoutIntervalForResource.
        // Setting timeoutIntervalForResource would hard-cap the total lifetime of persistent SSE streams.
        // A non-positive timeout interval is treated as infinite fallback sentinel (7 days) to prevent immediate timeout.
        let readTimeout = rawReadTimeout > 0 ? rawReadTimeout : 604800.0
        sessionConfig.timeoutIntervalForRequest = readTimeout
        
        if let protocolClasses = protocolClasses {
            sessionConfig.protocolClasses = protocolClasses
        }
        
        let rawConnectionTimeout = (config.connectionTimeoutMs ?? 15000.0) / 1000.0
        let connectionTimeout = rawConnectionTimeout > 0 ? rawConnectionTimeout : 0.0
        
        var request = URLRequest(url: url)
        request.httpMethod = config.method?.stringValue.uppercased() ?? "GET"
        
        // Prevent initial config headers from overriding the dynamic Last-Event-ID or disabling transparent gzip decompression.
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
        
        let source = RealSseEventSource(delegate: delegate, attemptVersion: attemptVersion, dispatcher: dispatcher, initialLastEventId: lastProcessedId)
        source.start(request: request, sessionConfig: sessionConfig, connectionTimeout: connectionTimeout)
        return source
    }
}
