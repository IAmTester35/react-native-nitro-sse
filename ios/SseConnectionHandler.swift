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

/// Maximum bytes allowed for a single SSE line to prevent Out-Of-Memory errors.
private let maxSseLineLength: Int = 16 * 1024 * 1024

/// Maximum bytes allowed for accumulated event data to prevent Out-Of-Memory errors.
private let maxSseEventDataSize: Int = 16 * 1024 * 1024

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
    private var eventType: String?
    private var lastEventId: String?
    private var lastEventIdBuffer: String?
    private var idUpdatedInCurrentEvent: Bool = false
    private var isAtStreamStart: Bool = true
    /// Set once a resource limit violation (-2002 / -2003) is reported; all further input is ignored
    /// until `reset()`, mirroring `_aborted` in the TypeScript parser and `SseParserLimitException` on Android.
    private var isAborted: Bool = false

    init(initialLastEventId: String? = nil) {
        self.lastEventId = initialLastEventId
        self.lastEventIdBuffer = initialLastEventId
    }

    func reset(initialLastEventId: String? = nil) {
        buffer.removeAll()
        dataBuffer = ""
        hasData = false
        eventType = nil
        lastEventId = initialLastEventId
        lastEventIdBuffer = initialLastEventId
        idUpdatedInCurrentEvent = false
        isAtStreamStart = true
        isAborted = false
    }

    /// Reports a fatal parser limit violation exactly once and stops all further parsing.
    private func abort(code: Int, message: String) {
        guard !isAborted else { return }
        isAborted = true
        buffer.removeAll()
        dataBuffer = ""
        hasData = false
        eventType = nil
        lastEventIdBuffer = lastEventId
        idUpdatedInCurrentEvent = false
        let error = NSError(domain: "NitroSse", code: code, userInfo: [NSLocalizedDescriptionKey: message])
        delegate?.parserDidFail(error: error)
    }

    /// Signals end of stream (EOF).
    /// Per WHATWG SSE spec: "Once the end of the file is reached, any pending data must be discarded.
    /// (If the file ends in the middle of an event, before the final empty line,
    /// the incomplete event is not dispatched.)"
    func endOfStream() {
        buffer.removeAll()
        dataBuffer = ""
        hasData = false
        eventType = nil
        lastEventIdBuffer = lastEventId
        idUpdatedInCurrentEvent = false
    }

    func feed(data: Data) {
        guard !data.isEmpty, !isAborted else { return }
        var parsedLinesInChunk = 0
        defer {
            if parsedLinesInChunk > 0 {
                delegate?.parserDidParseLines(parsedLinesInChunk)
            }
        }

        guard let currentData = stripLeadingBomIfAtStart(data) else { return }
        var readIndex = currentData.startIndex

        guard processBufferedPrefix(
            in: currentData,
            readIndex: &readIndex,
            parsedLines: &parsedLinesInChunk
        ) else {
            return
        }

        scanCompleteLines(in: currentData, readIndex: &readIndex, parsedLines: &parsedLinesInChunk)
        if isAborted { return }

        appendTrailingFragment(of: currentData, from: readIndex)
    }
}

private extension SseEventParser {
    struct LineRange {
        let content: Range<Int>
        let nextIndex: Int
    }

    func stripLeadingBomIfAtStart(_ data: Data) -> Data? {
        guard isAtStreamStart else { return data }
        if buffer.isEmpty && data.count >= 3 {
            let sIdx = data.startIndex
            let trimmed = (data[sIdx] == 0xEF && data[sIdx + 1] == 0xBB && data[sIdx + 2] == 0xBF)
                ? data[(sIdx + 3)..<data.endIndex]
                : data
            isAtStreamStart = false
            return trimmed
        }
        let bom: [UInt8] = [0xEF, 0xBB, 0xBF]
        buffer.append(data)
        if buffer.count >= 3 {
            if buffer[0] == 0xEF && buffer[1] == 0xBB && buffer[2] == 0xBF {
                buffer.removeSubrange(0..<3)
            }
            isAtStreamStart = false
            let combined = buffer
            buffer.removeAll()
            return combined
        }
        for index in 0..<buffer.count where buffer[index] != bom[index] {
            isAtStreamStart = false
            let combined = buffer
            buffer.removeAll()
            return combined
        }
        return nil
    }

    func processBufferedPrefix(
        in currentData: Data,
        readIndex: inout Data.Index,
        parsedLines: inout Int
    ) -> Bool {
        guard !buffer.isEmpty else { return true }
        if buffer.last == 0x0D {
            buffer.removeLast()
            // WHATWG SSE Section 9.2.2: invalid UTF-8 bytes must be replaced with U+FFFD, not dropped.
            // swiftlint:disable:next optional_data_string_conversion
            let line = String(decoding: buffer, as: UTF8.self)
            buffer.removeAll()
            processLine(line)
            parsedLines += 1
            if currentData.first == 0x0A {
                readIndex = currentData.startIndex + 1
            }
            return true
        }
        if let firstLine = findNextLine(in: currentData, from: readIndex) {
            if buffer.count + firstLine.content.count > maxSseLineLength {
                abort(code: -2002, message: "SSE line exceeded maximum limit of \(maxSseLineLength) bytes")
                return false
            }
            buffer.append(currentData[firstLine.content])
            // WHATWG SSE Section 9.2.2: invalid UTF-8 bytes must be replaced with U+FFFD, not dropped.
            // swiftlint:disable:next optional_data_string_conversion
            let line = String(decoding: buffer, as: UTF8.self)
            buffer.removeAll()
            processLine(line)
            parsedLines += 1
            readIndex = firstLine.nextIndex
            return true
        }
        // currentData has no line ending: append chunk to buffer if within limit
        if buffer.count + currentData.count > maxSseLineLength {
            abort(code: -2002, message: "SSE line exceeded maximum limit of \(maxSseLineLength) bytes")
            return false
        }
        buffer.append(currentData)
        return false
    }

    func scanCompleteLines(
        in currentData: Data,
        readIndex: inout Data.Index,
        parsedLines: inout Int
    ) {
        let endIndex = currentData.endIndex
        while readIndex < endIndex && !isAborted {
            guard let lineRange = findNextLine(in: currentData, from: readIndex) else {
                break
            }
            if lineRange.content.count > maxSseLineLength {
                abort(code: -2002, message: "SSE line exceeded maximum limit of \(maxSseLineLength) bytes")
                return
            }
            let lineSlice = currentData[lineRange.content]
            readIndex = lineRange.nextIndex
            // WHATWG SSE Section 9.2.2: invalid UTF-8 bytes must be replaced with U+FFFD, not dropped.
            // swiftlint:disable:next optional_data_string_conversion
            let line = String(decoding: lineSlice, as: UTF8.self)
            processLine(line)
            parsedLines += 1
        }
    }

    func appendTrailingFragment(of currentData: Data, from readIndex: Data.Index) {
        let endIndex = currentData.endIndex
        guard readIndex < endIndex else { return }
        let trailingSlice = currentData[readIndex..<endIndex]
        if buffer.count + trailingSlice.count > maxSseLineLength {
            abort(code: -2002, message: "SSE line exceeded maximum limit of \(maxSseLineLength) bytes")
            return
        }
        buffer.append(trailingSlice)
    }

    /// Finds next line in data from startIndex handling \r\n, \r, and \n using UnsafeRawBufferPointer.
    /// If data ends with \r at the very end, returns nil to defer until next chunk so \r\n can be resolved.
    func findNextLine(in data: Data, from startIndex: Int) -> LineRange? {
        let endIndex = data.endIndex
        let baseIndex = data.startIndex

        return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> LineRange? in
            var offset = startIndex - baseIndex
            let endOffset = endIndex - baseIndex
            while offset < endOffset {
                let byte = raw[offset]
                if byte == 0x0A { // \n (LF)
                    let foundIndex = baseIndex + offset
                    return LineRange(content: startIndex..<foundIndex, nextIndex: foundIndex + 1)
                } else if byte == 0x0D { // \r (CR)
                    let foundIndex = baseIndex + offset
                    if offset + 1 < endOffset {
                        if raw[offset + 1] == 0x0A { // \r\n (CRLF)
                            return LineRange(content: startIndex..<foundIndex, nextIndex: foundIndex + 2)
                        } else { // Single \r
                            return LineRange(content: startIndex..<foundIndex, nextIndex: foundIndex + 1)
                        }
                    } else {
                        // Buffer ends with \r; wait for next chunk to verify if it is \r\n
                        return nil
                    }
                }
                offset += 1
            }
            return nil
        }
    }

    func handleEmptyLine() {
        if idUpdatedInCurrentEvent {
            lastEventId = lastEventIdBuffer
            idUpdatedInCurrentEvent = false
            delegate?.parserDidUpdateLastEventId(lastEventId)
        }
        // Empty line dispatches the current event per WHATWG specification
        if hasData {
            let eventData = dataBuffer
            let id = lastEventId
            let type = eventType

            dataBuffer = ""
            hasData = false
            eventType = nil

            delegate?.parserDidReceiveEvent(id: id, type: type, data: eventData)
        } else {
            // WHATWG SSE: Dispatching an empty event still resets the event type buffer
            eventType = nil
        }
    }

    func appendDataField(_ value: String) {
        let separatorSize = hasData ? 1 : 0
        if dataBuffer.utf8.count + separatorSize + value.utf8.count > maxSseEventDataSize {
            abort(
                code: -2003,
                message: "SSE event data exceeded maximum limit of \(maxSseEventDataSize) bytes"
            )
            return
        }
        if hasData {
            dataBuffer.append("\n")
            dataBuffer.append(value)
        } else {
            dataBuffer = value
            hasData = true
        }
    }

    func handleField(_ field: String, value: String) {
        switch field {
        case "data":
            appendDataField(value)
        case "id":
            // WHATWG: If field value contains a U+0000 NULL character, the field must be ignored.
            if !value.contains("\0") {
                lastEventIdBuffer = value.isEmpty ? nil : value
                idUpdatedInCurrentEvent = true
            }
        case "event":
            eventType = value.isEmpty ? nil : value
        case "retry":
            let isDigitsOnly = !value.isEmpty && value.allSatisfy { $0.isASCII && $0.isNumber }
            if isDigitsOnly, let retryVal = Int64(value) {
                delegate?.parserDidReceiveRetry(retryMs: retryVal)
            }
        default:
            // Unrecognized fields are ignored per WHATWG specification
            break
        }
    }

    func processLine(_ line: String) {
        if line.isEmpty {
            handleEmptyLine()
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

        let field: String
        let value: String
        if let colon = line.firstIndex(of: ":") {
            field = String(line[..<colon])
            let rawValue = String(line[line.index(after: colon)...])
            value = rawValue.hasPrefix(" ") ? String(rawValue.dropFirst()) : rawValue
        } else {
            field = line
            value = ""
        }
        handleField(field, value: value)
    }
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
    private var hasConnectionTimer: Bool = false
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
        hasConnectionTimer = true
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
        if !self.hasConnectionTimer {
            self.startConnectionTimer(timeout: 15.0)
        }
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
        let rawMime = contentType.split(separator: ";").first
        let mimeType = rawMime?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        guard mimeType == "text/event-stream" else {
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
            guard let self = self, !self.isCancelled, !self.isTerminalDispatched else {
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
