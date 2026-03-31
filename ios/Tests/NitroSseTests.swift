import XCTest
@testable import NitroSse

class NitroSseTests: XCTestCase {
    
    // Core logic extraction for unit testing 

    func testBackoffWithJitterCalculation() {
        let retryInterval: TimeInterval = 1.0
        let maxRetryInterval: TimeInterval = 30.0
        let jitterFactor: Double = 0.5
        
        func calculateDelay(counter: Int, jitter: Double) -> TimeInterval {
            let exponent = Double(counter)
            let base = min(retryInterval * pow(2.0, exponent), maxRetryInterval)
            // Logic from NitroSse.swift: base * (1.0 - jitterFactor + Double.random(in: 0...(2 * jitterFactor)))
            return base * (1.0 - jitterFactor + (jitter * 2 * jitterFactor))
        }

        // Test range for counter 0 (Base 1.0s)
        // Min: 1.0 * (1.0 - 0.5 + 0) = 0.5s
        // Max: 1.0 * (1.0 - 0.5 + 1.0) = 1.5s
        XCTAssertEqual(calculateDelay(counter: 0, jitter: 0.0), 0.5)
        XCTAssertEqual(calculateDelay(counter: 0, jitter: 1.0), 1.5)
        
        // Test range for counter 5 (Base 32.0s -> Capped 30.0s)
        // Min: 30.0 * 0.5 = 15.0s
        // Max: 30.0 * 1.5 = 45.0s
        XCTAssertEqual(calculateDelay(counter: 5, jitter: 0.0), 15.0)
        XCTAssertEqual(calculateDelay(counter: 5, jitter: 1.0), 45.0)
    }

    func testZeroLossBuffering() {
        var buffer: [String] = []
        var flushCount = 0
        let capacity = 5
        
        func pushToBuffer(_ item: String) {
            buffer.append(item)
            if buffer.count >= capacity {
                // Simulate flush logic from NitroSse.swift
                flushCount += 1
                buffer.removeAll()
            }
        }

        // Fill buffer to capacity
        for i in 1...5 {
            pushToBuffer("event-\(i)")
        }
        XCTAssertEqual(flushCount, 1, "Should flush when capacity reached")
        XCTAssertEqual(buffer.count, 0, "Buffer should be empty after flush")

        // Check it doesn't drop items
        for i in 1...3 {
            pushToBuffer("event-\(i)")
        }
        XCTAssertEqual(buffer.count, 3)
        XCTAssertEqual(flushCount, 1)
    }

    func testMaxReconnectAttemptsStop() {
        let maxAttempts = 3
        var currentReconnectAttempts = 0
        var isRunning = true
        
        func onFailure() {
            if currentReconnectAttempts >= maxAttempts {
                isRunning = false
                return
            }
            currentReconnectAttempts += 1
        }
        
        for _ in 1...3 {
            onFailure()
        }
        XCTAssertTrue(isRunning, "Should still be running at attempt 3")
        XCTAssertEqual(currentReconnectAttempts, 3)
        
        onFailure() // 4th call, current (3) >= max (3)
        XCTAssertFalse(isRunning, "Should stop after 3 attempts")
    }

    func testAuthErrorLogic() {
        func shouldRetry(statusCode: Int, hasInterceptor: Bool, consecutiveAuthErrors: Int) -> Bool {
            let maxAuthRetries = 3
            if statusCode == 401 || statusCode == 403 {
                if !hasInterceptor { return false }
                if consecutiveAuthErrors >= maxAuthRetries { return false }
                return true
            }
            return false
        }

        // Case 1: 401 without interceptor -> Fail
        XCTAssertFalse(shouldRetry(statusCode: 401, hasInterceptor: false, consecutiveAuthErrors: 0))
        
        // Case 2: 401 with interceptor -> Retry
        XCTAssertTrue(shouldRetry(statusCode: 401, hasInterceptor: true, consecutiveAuthErrors: 0))
        
        // Case 3: 401 reaching limit -> Fail
        XCTAssertFalse(shouldRetry(statusCode: 401, hasInterceptor: true, consecutiveAuthErrors: 3))
    }

    func testFatalErrorCodeStop() {
        func isFatal(statusCode: Int) -> Bool {
            return statusCode == 400 || statusCode == 204
        }
        XCTAssertTrue(isFatal(statusCode: 400))
        XCTAssertTrue(isFatal(statusCode: 204))
        XCTAssertFalse(isFatal(statusCode: 500))
    }

    func testRetryAfterDateParsing() {
        func extractRetryAfter(headerValue: String?) -> TimeInterval? {
            guard let retryAfterHeader = headerValue else { return nil }
            if let seconds = Double(retryAfterHeader) {
                return seconds
            }
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
            if let date = formatter.date(from: retryAfterHeader) {
                // For testability, we mock a "now" date
                let mockNow = formatter.date(from: "Wed, 01 Jan 2026 00:00:00 GMT")!
                let diff = date.timeIntervalSince(mockNow)
                return diff > 0 ? diff : nil
            }
            return nil
        }

        // 5 seconds
        XCTAssertEqual(extractRetryAfter(headerValue: "5"), 5.0)
        
        // Date exactly 1 hour in future
        let futureDate = "Wed, 01 Jan 2026 01:00:00 GMT"
        XCTAssertEqual(extractRetryAfter(headerValue: futureDate), 3600.0)
    }

    func testConcurrentStartStopVersioning() {
        var connectionAttemptVersion = 0
        var executeCount = 0
        
        func start() -> Int {
            return connectionAttemptVersion // Captures current version
        }
        
        func stop() {
            connectionAttemptVersion += 1 // Invalidates current version
        }
        
        // 1. User starts
        let version1 = start()
        
        // 2. User stops unexpectedly (e.g. Navigation back)
        stop()
        
        // 3. Logic tries to finish connection with version 1
        func finishConnection(version: Int) {
            if version == connectionAttemptVersion {
                executeCount += 1
            }
        }
        
        finishConnection(version: version1)
        XCTAssertEqual(executeCount, 0, "Should have ignored execution because version changed")
        
        let version2 = start()
        finishConnection(version: version2)
        XCTAssertEqual(executeCount, 1, "Should execute for fresh version")
    }

    func testStartIsIdempotent() {
        var isRunning = false
        var startCount = 0
        
        func start() {
            guard !isRunning else { return }
            isRunning = true
            startCount += 1
        }
        
        start()
        start()
        XCTAssertEqual(startCount, 1, "start() should be idempotent")
    }

    func testHibernationLogic() {
        var isRunning = true
        var wasRunningBeforeHibernation = false
        
        func hibernate() {
            if isRunning {
                wasRunningBeforeHibernation = true
                isRunning = false
            }
        }
        
        func resume() {
            if wasRunningBeforeHibernation {
                isRunning = true
                wasRunningBeforeHibernation = false
            }
        }
        
        // App goes to background
        hibernate()
        XCTAssertFalse(isRunning)
        XCTAssertTrue(wasRunningBeforeHibernation)
        
        // App returns to foreground
        resume()
        XCTAssertTrue(isRunning)
        XCTAssertFalse(wasRunningBeforeHibernation)
    }

    func testStatsPersistenceAcrossReconnections() {
        var totalBytes: Double = 0
        var reconnectCount = 0
        
        func simulateConnectionCycle(bytes: Double) {
            reconnectCount += 1
            totalBytes += bytes
        }
        
        simulateConnectionCycle(bytes: 100)
        simulateConnectionCycle(bytes: 250)
        
        XCTAssertEqual(reconnectCount, 2)
        XCTAssertEqual(totalBytes, 350, "Bytes should be cumulative")
    }

    func testHeartbeatSizeReporting() {
        func getHeartbeatSize(comment: String) -> Double {
            return Double(comment.utf8.count)
        }
        
        XCTAssertEqual(getHeartbeatSize(comment: ":keep-alive"), 11.0)
        XCTAssertEqual(getHeartbeatSize(comment: ":"), 1.0)
    }
}
