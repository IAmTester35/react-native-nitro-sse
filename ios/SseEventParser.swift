import Foundation

/// Maximum bytes allowed for a single SSE line to prevent Out-Of-Memory errors.
private let maxSseLineLength: Int = 16 * 1024 * 1024

/// Maximum bytes allowed for accumulated event data to prevent Out-Of-Memory errors.
private let maxSseEventDataSize: Int = 16 * 1024 * 1024

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
