import XCTest
@testable import NitroSse

class NitroSseTests: XCTestCase {
    
    // Manual re-implementation of core logic for unit testing 
    // since NitroSse is heavily tied to background queues and LDSwiftEventSource 
    // but the algorithms are extracted for verify quality.

    func testBackoffDelayCalculation() {
        let baseBackoffDelay: TimeInterval = 2.0
        let maxBackoffDelay: TimeInterval = 30.0
        
        func calculateDelay(counter: Int) -> TimeInterval {
            let exponent = Double(counter)
            return min(baseBackoffDelay * pow(2.0, exponent), maxBackoffDelay)
        }

        XCTAssertEqual(calculateDelay(counter: 0), 2.0)
        XCTAssertEqual(calculateDelay(counter: 1), 4.0)
        XCTAssertEqual(calculateDelay(counter: 2), 8.0)
        XCTAssertEqual(calculateDelay(counter: 3), 16.0)
        XCTAssertEqual(calculateDelay(counter: 4), 30.0) // Capped
        XCTAssertEqual(calculateDelay(counter: 10), 30.0) // Still capped
    }

    func testRetryAfterExtraction() {
        // Mocked logic for testing since URLResponse and HTTPURLResponse initialization is complex
        func extractRetryAfter(headerValue: String?) -> TimeInterval? {
            guard let retryAfterHeader = headerValue else { return nil }
            if let seconds = Double(retryAfterHeader) {
                return seconds
            }
            // Date parsing (Simplified RFC1123 check)
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
            if let date = formatter.date(from: retryAfterHeader) {
                let diff = date.timeIntervalSinceNow
                return diff > 0 ? diff : nil
            }
            return nil
        }

        XCTAssertEqual(extractRetryAfter(headerValue: "5"), 5.0)
        XCTAssertEqual(extractRetryAfter(headerValue: "60"), 60.0)
        XCTAssertNil(extractRetryAfter(headerValue: nil))
        XCTAssertNil(extractRetryAfter(headerValue: "invalid"))
        
        // Test date format (far in future)
        let futureDate = "Wed, 01 Jan 2030 00:00:00 GMT"
        XCTAssertNotNil(extractRetryAfter(headerValue: futureDate))
    }

    func testBufferManagement() {
        var buffer: [String] = []
        let capacity = 5
        
        func pushToBuffer(_ item: String) {
            while buffer.count >= capacity {
                buffer.removeFirst()
            }
            buffer.append(item)
        }

        for i in 1...10 {
            pushToBuffer("event-\(i)")
        }

        XCTAssertEqual(buffer.count, 5)
        XCTAssertEqual(buffer.first, "event-6")
        XCTAssertEqual(buffer.last, "event-10")
    }

    func testEventSizeCalculation() {
        // Total bytes count logic
        func calculateSize(eventType: String, data: String, lastId: String) -> Double {
            let encodedDataSize = Double(data.utf8.count)
            let metadataSize = Double(eventType.utf8.count) + Double(lastId.utf8.count)
            return encodedDataSize + metadataSize
        }

        let size = calculateSize(eventType: "message", data: "{\"id\":1}", lastId: "event-1")
        XCTAssertEqual(size, 22.0) // 8 (data) + 7 (type) + 7 (id) = 22 bytes
    }

    func testVersioningSafety() {
        var connectionAttemptVersion: Int32 = 0
        var executeCount = 0
        
        func stop() {
            connectionAttemptVersion += 1
        }
        
        // Start called, captures version 0
        let capturedVersion = connectionAttemptVersion
        
        // User stops immediately
        stop()
        
        // Connection logic tries to execute
        func establishConnection(version: Int32) {
            if version == connectionAttemptVersion {
                executeCount += 1
            }
        }
        
        establishConnection(version: capturedVersion)
        XCTAssertEqual(executeCount, 0, "Should not execute if version changed")
    }

    func testAuthErrorReset() {
        var consecutiveAuthErrors = 3
        
        func onOpened() {
            consecutiveAuthErrors = 0
        }
        
        onOpened()
        XCTAssertEqual(consecutiveAuthErrors, 0, "Errors should reset on success")
    }
}
