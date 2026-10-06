import XCTest
@testable import NitroSse

/// Wire protocol tests verifying WHATWG Server-Sent Events framing,
/// chronological event sequencing, UTF-8 multibyte chunk buffering, and directives.
final class NitroSseWireProtocolTests: XCTestCase {
    
    private class MockParserDelegate: SseEventParserDelegate {
        var events: [(id: String?, type: String?, data: String)] = []
        var comments: [String] = []
        var retries: [Int64] = []
        var chronologicalItems: [String] = []
        var failedError: Error?
        
        func parserDidReceiveEvent(id: String?, type: String?, data: String) {
            events.append((id: id, type: type, data: data))
            chronologicalItems.append("event:\(data)")
        }
        
        func parserDidReceiveComment(_ comment: String) {
            comments.append(comment)
            chronologicalItems.append("comment:\(comment)")
        }
        
        func parserDidReceiveRetry(retryMs: Int64) {
            retries.append(retryMs)
            chronologicalItems.append("retry:\(retryMs)")
        }
        
        func parserDidFail(error: Error) {
            failedError = error
        }
    }
    
    func testMessageAndCommentWireOrder() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        let raw = "data: first_msg\n\n: ping1\ndata: second_msg\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.chronologicalItems, [
            "event:first_msg",
            "comment:ping1",
            "event:second_msg"
        ])
        XCTAssertEqual(delegate.events.count, 2)
        XCTAssertEqual(delegate.comments.count, 1)
        XCTAssertEqual(delegate.comments.first, "ping1")
    }
    
    func testMultilineDataFraming() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        let raw = "data: line 1\ndata: line 2\ndata: line 3\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.events.count, 1)
        XCTAssertEqual(delegate.events.first?.data, "line 1\nline 2\nline 3")
    }
    
    func testEmptyIdResetsLastProcessedId() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        let raw = "id: 101\ndata: with id\n\nid:\ndata: without id\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.events.count, 2)
        XCTAssertEqual(delegate.events[0].id, "101")
        XCTAssertNil(delegate.events[1].id)
    }
    
    func testNullCharacterInIdIsIgnored() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        // WHATWG SSE: If field value contains a U+0000 NULL character, the field must be ignored.
        let raw = "id: 100\ndata: initial\n\nid: bad\u{0000}id\ndata: secondary\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.events.count, 2)
        XCTAssertEqual(delegate.events[0].id, "100")
        // Id retains previous valid ID "100" because the invalid field is ignored
        XCTAssertEqual(delegate.events[1].id, "100")
    }
    
    func testCustomEventType() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        let raw = "event: user_join\ndata: Alice\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.events.count, 1)
        XCTAssertEqual(delegate.events[0].type, "user_join")
        XCTAssertEqual(delegate.events[0].data, "Alice")
    }
    
    func testLeadingSpaceStripping() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        // Per WHATWG: Only ONE leading space after colon is stripped
        let raw = "data:  two spaces\n:  comment with leading space\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.events.first?.data, " two spaces")
        XCTAssertEqual(delegate.comments.first, " comment with leading space")
    }
    
    func testMixedLineEndings() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        // Supports CRLF (\r\n), CR (\r), and LF (\n)
        let raw = "data: crlf\r\n\r\ndata: cr\r\rdata: lf\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.events.count, 3)
        XCTAssertEqual(delegate.events[0].data, "crlf")
        XCTAssertEqual(delegate.events[1].data, "cr")
        XCTAssertEqual(delegate.events[2].data, "lf")
    }
    
    func testRetryDirective() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        let raw = "retry: 4500\ndata: after retry\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.retries, [4500])
        XCTAssertEqual(delegate.events.count, 1)
        XCTAssertEqual(delegate.events[0].data, "after retry")
    }
    
    func testSplitUtf8MultibyteChunks() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        // Character "🚀" is UTF-8 4-bytes: 0xF0 0x9F 0x9A 0x80
        // Character "ế" is UTF-8 3-bytes: 0xE1 0xBA 0xBF
        let fullString = "data: Xin chào ế 🚀\n\n"
        let fullData = fullString.data(using: .utf8)!
        
        // Split chunk right in the middle of the multibyte sequence
        let splitIndex = 17
        let chunk1 = fullData.subdata(in: 0..<splitIndex)
        let chunk2 = fullData.subdata(in: splitIndex..<fullData.count)
        
        parser.feed(data: chunk1)
        XCTAssertEqual(delegate.events.count, 0, "Event should not fire prematurely on split chunk")
        
        parser.feed(data: chunk2)
        XCTAssertEqual(delegate.events.count, 1)
        XCTAssertEqual(delegate.events.first?.data, "Xin chào ế 🚀")
    }
    
    func testEmptyLinesWithoutDataAreIgnored() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        // Multiple empty lines should not generate empty events
        let raw = "\n\n\r\n\r\ndata: valid\n\n\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.events.count, 1)
        XCTAssertEqual(delegate.events.first?.data, "valid")
    }
    
    func testCrlfSplitAcrossChunkBoundary() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        // Chunk 1 ends right at the trailing \r of \r\n\r\n
        let chunk1 = "data: split_crlf\r\n\r".data(using: .utf8)!
        let chunk2 = "\ndata: second\r\n\r\n".data(using: .utf8)!
        
        parser.feed(data: chunk1)
        XCTAssertEqual(delegate.events.count, 0, "Event must not be emitted prematurely while CRLF boundary is incomplete")
        
        parser.feed(data: chunk2)
        XCTAssertEqual(delegate.events.count, 2)
        XCTAssertEqual(delegate.events[0].data, "split_crlf")
        XCTAssertEqual(delegate.events[1].data, "second")
    }
    
    func testFieldWithoutColonDispatchesEmptyValue() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        // Per WHATWG SSE: Line without colon is treated as field name with empty value ("")
        let raw = "data\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.events.count, 1)
        XCTAssertEqual(delegate.events[0].data, "")
    }
    
    func testEventTypeResetsAfterEachDispatchedEvent() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        let raw = "event: custom_alert\ndata: msg1\n\ndata: msg2\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.events.count, 2)
        XCTAssertEqual(delegate.events[0].type, "custom_alert")
        XCTAssertNil(delegate.events[1].type, "eventType must reset to nil after event dispatch")
    }
    
    func testInvalidRetryDirectiveIsIgnored() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        // WHATWG SSE: retry values that are not non-negative integers must be ignored
        let raw = "retry: not_a_number\nretry: -500\ndata: ok\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.retries.count, 0, "Invalid retry directives must be ignored")
        XCTAssertEqual(delegate.events.first?.data, "ok")
    }
    
    func testInvalidRetryDirectiveWithPlusSignIsIgnored() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate
        
        // WHATWG SSE: Only ASCII digits 0-9 are allowed; plus sign must be ignored
        let raw = "retry: +1000\ndata: after retry\n\n"
        parser.feed(data: raw.data(using: .utf8)!)
        
        XCTAssertEqual(delegate.retries.count, 0, "Retry with plus sign must be ignored per WHATWG SSE")
        XCTAssertEqual(delegate.events.first?.data, "after retry")
    }

    func testUtf8BomAtStreamStartIsIgnored() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate

        // WHATWG SSE: The decode algorithm must treat any byte sequence matching
        // 0xEF 0xBB 0xBF (the UTF-8 BOM) at the beginning of the stream as if it were not present.
        let bom: [UInt8] = [0xEF, 0xBB, 0xBF]
        var data = Data(bom)
        data.append("data: hello\n\n".data(using: .utf8)!)
        parser.feed(data: data)

        XCTAssertEqual(delegate.events.count, 1, "First event should be parsed even if preceded by UTF-8 BOM")
        XCTAssertEqual(delegate.events.first?.data, "hello")
    }

    func testLargeChunkWithManySmallLinesDoesNotTriggerLineLengthLimit() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate

        // Construct a single Data chunk > 16 MB (MAX_SSE_LINE_LENGTH = 16,777,216)
        // containing valid small lines (e.g. 1 KB per event)
        let line = "data: " + String(repeating: "a", count: 1000) + "\n\n"
        let lineData = line.data(using: .utf8)!
        let eventCount = 17_000 // 17,000 * 1008 bytes = 17,136,000 bytes (> 16 MB)
        var largeData = Data(capacity: eventCount * lineData.count)
        for _ in 0..<eventCount {
            largeData.append(lineData)
        }

        parser.feed(data: largeData)

        XCTAssertNil(delegate.failedError, "Valid small lines in a chunk > 16MB must not trigger line length limit error")
        XCTAssertEqual(delegate.events.count, eventCount)
    }

    func testUnterminatedLineExceeding16MBFails() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate

        // Construct an unterminated single line > 16 MB (16,777,216 bytes)
        let limit = 16 * 1024 * 1024
        let overLimitData = Data(repeating: UInt8(ascii: "a"), count: limit + 10)

        parser.feed(data: overLimitData)

        XCTAssertNotNil(delegate.failedError, "An unterminated line exceeding 16 MB must fail")
        let nsError = delegate.failedError as NSError?
        XCTAssertEqual(nsError?.domain, "NitroSse")
        XCTAssertEqual(nsError?.code, -2002)
    }

    func testDataLimitBoundaryOffByOneCheck() {
        let maxLimit = 16 * 1024 * 1024
        let half = 8 * 1024 * 1024
        
        let prefixData = "data: ".data(using: .utf8)!
        let nlData = "\n".data(using: .utf8)!
        let endData = "\n\n".data(using: .utf8)!

        // 1. Boundary: Exactly MAX bytes (half + 1 separator + (half - 1) bytes = MAX) -> Succeeds
        do {
            let parser = SseEventParser()
            let delegate = MockParserDelegate()
            parser.delegate = delegate
            
            var chunk1 = prefixData
            chunk1.append(Data(repeating: UInt8(ascii: "a"), count: half))
            chunk1.append(nlData)
            
            var chunk2 = prefixData
            chunk2.append(Data(repeating: UInt8(ascii: "b"), count: half - 1))
            chunk2.append(endData)
            
            parser.feed(data: chunk1)
            parser.feed(data: chunk2)
            
            XCTAssertNil(delegate.failedError, "Exactly MAX bytes including newline separator must succeed")
            XCTAssertEqual(delegate.events.count, 1)
            XCTAssertEqual(delegate.events.first?.data.count, maxLimit)
        }

        // 2. Boundary: Off-by-one verification - raw data is exactly MAX (half + half),
        // but newline separator brings total data buffer to MAX + 1 -> Must fail with -2003
        do {
            let parser = SseEventParser()
            let delegate = MockParserDelegate()
            parser.delegate = delegate
            
            var chunk1 = prefixData
            chunk1.append(Data(repeating: UInt8(ascii: "a"), count: half))
            chunk1.append(nlData)
            
            var chunk2 = prefixData
            chunk2.append(Data(repeating: UInt8(ascii: "b"), count: half))
            chunk2.append(endData)
            
            parser.feed(data: chunk1)
            parser.feed(data: chunk2)
            
            XCTAssertNotNil(delegate.failedError, "Data buffer exceeding MAX due to newline separator must fail")
            let nsError = delegate.failedError as NSError?
            XCTAssertEqual(nsError?.domain, "NitroSse")
            XCTAssertEqual(nsError?.code, -2003, "Must fail with -2003 event data limit exceeded")
        }

        // 3. Boundary: MAX + 1 in raw data -> Must fail with -2003
        do {
            let parser = SseEventParser()
            let delegate = MockParserDelegate()
            parser.delegate = delegate
            
            var chunk1 = prefixData
            chunk1.append(Data(repeating: UInt8(ascii: "a"), count: half))
            chunk1.append(nlData)
            
            var chunk2 = prefixData
            chunk2.append(Data(repeating: UInt8(ascii: "b"), count: half + 1))
            chunk2.append(endData)
            
            parser.feed(data: chunk1)
            parser.feed(data: chunk2)
            
            XCTAssertNotNil(delegate.failedError, "Data buffer exceeding MAX must fail")
            let nsError = delegate.failedError as NSError?
            XCTAssertEqual(nsError?.domain, "NitroSse")
            XCTAssertEqual(nsError?.code, -2003)
        }
    }

    func testStreamEndingAtEofWithoutTrailingEmptyLineDispatchesPendingEvent() {
        let parser = SseEventParser()
        let delegate = MockParserDelegate()
        parser.delegate = delegate

        // Stream ends with data line without trailing empty line
        let raw = "id: 999\nevent: finish\ndata: payload_at_eof\n"
        parser.feed(data: raw.data(using: .utf8)!)

        // Before EOF, no event dispatched yet because of missing blank line
        XCTAssertEqual(delegate.events.count, 0)

        // WHATWG SSE: EOF triggers flush of pending data event
        parser.endOfStream()

        XCTAssertEqual(delegate.events.count, 1)
        XCTAssertEqual(delegate.events.first?.id, "999")
        XCTAssertEqual(delegate.events.first?.type, "finish")
        XCTAssertEqual(delegate.events.first?.data, "payload_at_eof")
    }
}

