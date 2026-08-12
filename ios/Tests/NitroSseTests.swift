import XCTest
#if os(iOS)
import UIKit
#endif
@testable import NitroSse

class NitroSseTests: XCTestCase {
    
    // MARK: - SseReconnectStrategy Tests

    func testBackoffWithJitterCalculation() {
        let strategy = SseReconnectStrategy()
        strategy.configure(
            retryIntervalMs: 1000.0,
            maxRetryIntervalMs: 30000.0,
            jitterFactor: 0.5,
            maxReconnectAttempts: nil
        )
        
        // Counter 0 (Base 1.0s, Jitter 0.5): expected delay range [0.5s, 1.5s].
        let delay0 = strategy.nextDelay(isError: true)
        XCTAssertGreaterThanOrEqual(delay0, 0.5)
        XCTAssertLessThanOrEqual(delay0, 1.5)
        
        // Counter 1 (Base 2.0s, Jitter 0.5): expected delay range [1.0s, 3.0s].
        let delay1 = strategy.nextDelay(isError: true)
        XCTAssertGreaterThanOrEqual(delay1, 1.0)
        XCTAssertLessThanOrEqual(delay1, 3.0)
        
        // Non-error retry uses non-exponential base interval: expected delay range [0.5s, 1.5s].
        let delayNonError = strategy.nextDelay(isError: false)
        XCTAssertGreaterThanOrEqual(delayNonError, 0.5)
        XCTAssertLessThanOrEqual(delayNonError, 1.5)
    }

    func testMaxReconnectAttemptsStop() {
        let strategy = SseReconnectStrategy()
        strategy.configure(
            retryIntervalMs: 1000.0,
            maxRetryIntervalMs: 30000.0,
            jitterFactor: 0.0,
            maxReconnectAttempts: 3.0
        )
        
        XCTAssertFalse(strategy.hasReachedMaxAttempts())
        
        _ = strategy.nextDelay(isError: true)
        _ = strategy.nextDelay(isError: true)
        _ = strategy.nextDelay(isError: true)
        
        XCTAssertTrue(strategy.hasReachedMaxAttempts(), "Should reach max after 3 attempts")
    }
    
    func testReconnectStrategyReset() {
        let strategy = SseReconnectStrategy()
        strategy.configure(
            retryIntervalMs: 1000.0,
            maxRetryIntervalMs: 30000.0,
            jitterFactor: 0.0,
            maxReconnectAttempts: 3.0
        )
        
        _ = strategy.nextDelay(isError: true)
        _ = strategy.nextDelay(isError: true)
        _ = strategy.nextDelay(isError: true)
        XCTAssertTrue(strategy.hasReachedMaxAttempts())
        
        strategy.reset()
        XCTAssertFalse(strategy.hasReachedMaxAttempts(), "Should reset after reset()")
    }

    func testReconnectStrategyValidation() {
        let strategy = SseReconnectStrategy()
        strategy.configure(
            retryIntervalMs: .nan,
            maxRetryIntervalMs: -100.0,
            jitterFactor: 2.5,
            maxReconnectAttempts: .infinity
        )
        
        let mirror = Mirror(reflecting: strategy)
        let retryInterval = mirror.children.first { $0.label == "retryInterval" }?.value as? TimeInterval
        let maxRetryInterval = mirror.children.first { $0.label == "maxRetryInterval" }?.value as? TimeInterval
        let jitterFactor = mirror.children.first { $0.label == "jitterFactor" }?.value as? Double
        let maxReconnectAttempts = mirror.children.first { $0.label == "maxReconnectAttempts" }?.value as? Int
        
        XCTAssertEqual(retryInterval, 1.0)
        XCTAssertEqual(maxRetryInterval, 30.0)
        XCTAssertEqual(jitterFactor, 1.0)
        XCTAssertEqual(maxReconnectAttempts, -1)
    }

    func testRetryAfterDateParsing() {
        func createError(withRetryAfter headerValue: String?) -> Error {
            let url = URL(string: "https://example.com")!
            var headers: [String: String] = [:]
            if let val = headerValue { headers["Retry-After"] = val }
            
            let response = HTTPURLResponse(url: url, statusCode: 429, httpVersion: nil, headerFields: headers)!
            let userInfo: [String: Any] = ["response": response]
            return NSError(domain: "test", code: 429, userInfo: userInfo)
        }

        let err1 = createError(withRetryAfter: "5")
        XCTAssertEqual(SseReconnectStrategy.extractRetryAfterSeconds(from: err1), 5.0)
        
        // Verifies RFC 1123 HTTP-date string parsing converts to remaining time interval in seconds.
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
        let futureDate = formatter.string(from: Date().addingTimeInterval(3600))
        let err2 = createError(withRetryAfter: futureDate)
        
        let extracted = SseReconnectStrategy.extractRetryAfterSeconds(from: err2)
        XCTAssertNotNil(extracted)
        XCTAssertGreaterThan(extracted!, 3590.0)
        XCTAssertLessThanOrEqual(extracted!, 3600.0)
        
        let err3 = createError(withRetryAfter: nil)
        XCTAssertNil(SseReconnectStrategy.extractRetryAfterSeconds(from: err3))
    }

    // MARK: - SseEventBuffer Tests

    func testEventBufferBatchingByCapacity() {
        let buffer = SseEventBuffer()
        let dispatcher = MockSseDispatcher()
        var flushedBatches: [[SseEvent]] = []
        
        buffer.configure(batchingIntervalMs: 10000, maxBufferSize: 3, dispatcher: dispatcher) { events in
            flushedBatches.append(events)
        }
        
        let mockEvent = SseEvent(type: .message, data: "test", parsedData: nil, id: "1", event: "message", message: nil, statusCode: 200, retry: nil, state: nil)
        
        // Buffer holds items below maxBufferSize threshold without flushing.
        buffer.push(mockEvent)
        buffer.push(mockEvent)
        XCTAssertEqual(flushedBatches.count, 0)
        
        // Reaching maxBufferSize capacity forces an immediate synchronous flush.
        buffer.push(mockEvent)
        XCTAssertEqual(flushedBatches.count, 1)
        XCTAssertEqual(flushedBatches.first?.count, 3)
    }

    func testEventBufferBatchingByTime() {
        let buffer = SseEventBuffer()
        let dispatcher = MockSseDispatcher()
        var flushedEvents: [SseEvent] = []
        
        buffer.configure(batchingIntervalMs: 50, maxBufferSize: 10, dispatcher: dispatcher) { events in
            flushedEvents.append(contentsOf: events)
        }
        
        let mockEvent = SseEvent(type: .message, data: "test", parsedData: nil, id: "1", event: "message", message: nil, statusCode: 200, retry: nil, state: nil)
        
        dispatcher.async {
            buffer.push(mockEvent)
            buffer.push(mockEvent)
        }
        
        dispatcher.executeAllPendingBlocks()
        dispatcher.executeDelayedBlocks()
        XCTAssertEqual(flushedEvents.count, 2)
    }
    
    func testEventBufferClear() {
        let buffer = SseEventBuffer()
        let dispatcher = MockSseDispatcher()
        var didFlush = false
        
        buffer.configure(batchingIntervalMs: 10000, maxBufferSize: 5, dispatcher: dispatcher) { _ in
            didFlush = true
        }
        
        let mockEvent = SseEvent(type: .message, data: "test", parsedData: nil, id: "1", event: "message", message: nil, statusCode: 200, retry: nil, state: nil)
        
        buffer.push(mockEvent)
        buffer.push(mockEvent)
        buffer.clear()
        
        buffer.push(mockEvent)
        XCTAssertFalse(didFlush, "Should not have flushed because buffer was cleared")
    }

    func testEventBufferDestroyedDispatcher() {
        let buffer = SseEventBuffer()
        let dispatcher = MockSseDispatcher()
        var flushedEvents: [SseEvent] = []
        
        buffer.configure(batchingIntervalMs: 10000, maxBufferSize: 5, dispatcher: dispatcher) { events in
            flushedEvents.append(contentsOf: events)
        }
        
        let mockEvent = SseEvent(type: .message, data: "test", parsedData: nil, id: "1", event: "message", message: nil, statusCode: 200, retry: nil, state: nil)
        
        buffer.push(mockEvent)
        buffer.clear()
        
        // Verifies event pushing during dispatcher teardown does not flush unhandled payloads.
        let closeEvent = SseEvent(type: .state, data: nil, parsedData: nil, id: nil, event: nil, message: nil, statusCode: nil, retry: nil, state: .closed)
        buffer.push(closeEvent)
        
        dispatcher.executeAllPendingBlocks()
        
        XCTAssertEqual(flushedEvents.count, 0)
    }

    func testEventBufferMaxBufferSizeValidation() {
        let dispatcher = MockSseDispatcher()
        let buffer = SseEventBuffer()

        buffer.configure(batchingIntervalMs: 0, maxBufferSize: 50, dispatcher: dispatcher) { _ in }
        let maxBufferSizeField = Mirror(reflecting: buffer).children.first { $0.label == "maxBufferSize" }?.value as? Int
        XCTAssertEqual(maxBufferSizeField, 50)

        buffer.configure(batchingIntervalMs: 0, maxBufferSize: .nan, dispatcher: dispatcher) { _ in }
        let nanMaxBuffer = Mirror(reflecting: buffer).children.first { $0.label == "maxBufferSize" }?.value as? Int
        XCTAssertEqual(nanMaxBuffer, 1000)

        buffer.configure(batchingIntervalMs: 0, maxBufferSize: -10, dispatcher: dispatcher) { _ in }
        let negMaxBuffer = Mirror(reflecting: buffer).children.first { $0.label == "maxBufferSize" }?.value as? Int
        XCTAssertEqual(negMaxBuffer, 1000)

        buffer.configure(batchingIntervalMs: 0, maxBufferSize: .infinity, dispatcher: dispatcher) { _ in }
        let infMaxBuffer = Mirror(reflecting: buffer).children.first { $0.label == "maxBufferSize" }?.value as? Int
        XCTAssertEqual(infMaxBuffer, 1000)
    }

    func testJsonParsingLogic() {
        let invalid = SseEventBuffer.parseJsonToAnyMap("{ bad json }")
        XCTAssertNil(invalid)
        
        let valid = SseEventBuffer.parseJsonToAnyMap("{\"name\":\"Nitro\"}")
        XCTAssertNotNil(valid)
    }

    func testJsonParsingArrayEdgeCase() {
        // `parseJsonToAnyMap` expects a JSON dictionary to map to Nitro `AnyMap`; arrays are rejected.
        let arrayJson = SseEventBuffer.parseJsonToAnyMap("[\"a\", \"b\"]")
        XCTAssertNil(arrayJson)
    }

    func testEventBufferNoBatching() {
        let buffer = SseEventBuffer()
        let dispatcher = MockSseDispatcher()
        var flushedCount = 0
        
        buffer.configure(batchingIntervalMs: 0, maxBufferSize: 1000, dispatcher: dispatcher) { _ in
            flushedCount += 1
        }
        
        let mockEvent = SseEvent(type: .message, data: "test", parsedData: nil, id: "1", event: "message", message: nil, statusCode: 200, retry: nil, state: nil)
        
        buffer.push(mockEvent)
        XCTAssertEqual(flushedCount, 1, "Should flush immediately when batching is disabled")
    }

    // MARK: - SseNetworkMonitor Tests

    func testNetworkMonitorStartStop() {
        let dispatcher = MockSseDispatcher()
        let expectation = XCTestExpectation(description: "Network monitor callback")
        
        let monitor = SseNetworkMonitor(dispatcher: dispatcher) { isSatisfied, interfaceChanged, interfaceType in
            expectation.fulfill()
        }
        
        monitor.start()
        monitor.start()
        
        wait(for: [expectation], timeout: 2.0)
        
        monitor.stop()
    }

    // MARK: - SseLifecycleManager Tests
#if os(iOS)
    func testLifecycleManagerNotifications() {
        let dispatcher = MockSseDispatcher()
        let bgExpectation = XCTestExpectation(description: "Background callback")
        let fgExpectation = XCTestExpectation(description: "Foreground callback")
        
        let manager = SseLifecycleManager(dispatcher: dispatcher, onBackground: {
            bgExpectation.fulfill()
        }, onForeground: {
            fgExpectation.fulfill()
        })
        
        manager.startObserving()
        
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        wait(for: [bgExpectation], timeout: 1.0)
        XCTAssertTrue(manager.isAppInBackground)
        
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        wait(for: [fgExpectation], timeout: 1.0)
        XCTAssertFalse(manager.isAppInBackground)
        
        manager.stopObserving()
    }

    func testLifecycleManagerKeepAlive() {
        let dispatcher = MockSseDispatcher()
        let manager = SseLifecycleManager(dispatcher: dispatcher, onBackground: {}, onForeground: {})
        
        let exp = XCTestExpectation(description: "Keepalive")
        exp.isInverted = true
        
        manager.beginBackgroundKeepAlive {
            exp.fulfill()
        }
        
        wait(for: [exp], timeout: 0.5)
        
        manager.cleanupBackgroundTask()
        
        // Verifies calling cleanup repeated times is idempotent and safe.
        manager.cleanupBackgroundTask()
    }
#endif

    // MARK: - SseConfig+CopyWith Tests
    func testSseConfigCopyWith() {
        let config = SseConfig(
            url: "https://example.com",
            method: .get,
            headers: ["A": "B"],
            body: nil,
            backgroundExecution: false,
            batchingIntervalMs: 0,
            maxBufferSize: 1000,
            connectionTimeoutMs: 15000,
            readTimeoutMs: 300000,
            retryIntervalMs: 1000,
            maxRetryIntervalMs: 30000,
            jitterFactor: 0.5,
            maxReconnectAttempts: nil,
            autoParseJSON: true,
            monitorNetwork: true,
            onBeforeRequest: nil,
            mock: nil
        )
        
        let newConfig = config.copyWith(
            url: "https://new.com",
            headers: ["C": "D"],
            batchingIntervalMs: 500
        )
        
        XCTAssertEqual(newConfig.url, "https://new.com")
        XCTAssertEqual(newConfig.headers?["C"], "D")
        XCTAssertEqual(newConfig.batchingIntervalMs, 500)
        XCTAssertEqual(newConfig.connectionTimeoutMs, 15000)
        XCTAssertEqual(newConfig.autoParseJSON, true)
    }

    // MARK: - SseConnectionHandler Tests
    class MockSseConnectionDelegate: SseConnectionDelegate {
        var didOpen = false
        var didClose = false
        func connectionDidOpen(attemptVersion: Int) { didOpen = true }
        func connectionDidClose(attemptVersion: Int) { didClose = true }
        func connectionDidReceiveMessage(eventType: String, data: String, lastEventId: String, attemptVersion: Int) {}
        func connectionDidReceiveComment(_ comment: String, attemptVersion: Int) {}
        func connectionDidFail(error: Error, attemptVersion: Int) {}
    }

    func testConnectionHandlerCreation() {
        let config = SseConfig(
            url: "https://example.com",
            method: .post,
            headers: ["Test": "Header"],
            body: "test body",
            backgroundExecution: false,
            batchingIntervalMs: 0,
            maxBufferSize: 1000,
            connectionTimeoutMs: 15000,
            readTimeoutMs: 300000,
            retryIntervalMs: 1000,
            maxRetryIntervalMs: 30000,
            jitterFactor: 0.5,
            maxReconnectAttempts: nil,
            autoParseJSON: true,
            monitorNetwork: true,
            onBeforeRequest: nil,
            mock: nil
        )
        
        let delegate = MockSseConnectionDelegate()
        let dispatcher = MockSseDispatcher()
        
        let url = URL(string: config.url)!
        
        let eventSource = SseConnectionHandler.createEventSource(
            url: url,
            config: config,
            lastProcessedId: "last-123",
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher
        )
        
        XCTAssertNotNil(eventSource)
        eventSource.stop()
    }
}
