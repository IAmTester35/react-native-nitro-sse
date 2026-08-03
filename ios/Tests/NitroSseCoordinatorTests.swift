import XCTest
import NitroModules
@testable import NitroSse

class NitroSseCoordinatorTests: XCTestCase {
    
    private func createMockConfig() -> SseConfig {
        return SseConfig(
            url: "http://localhost:9999/dummy",
            method: .get,
            headers: [:],
            body: nil,
            backgroundExecution: false,
            batchingIntervalMs: 100,
            maxBufferSize: 1000,
            connectionTimeoutMs: 15000,
            readTimeoutMs: 300000,
            retryIntervalMs: 100,
            maxRetryIntervalMs: 30000,
            jitterFactor: 0.0,
            maxReconnectAttempts: 2,
            autoParseJSON: false,
            monitorNetwork: false,
            onBeforeRequest: nil,
            mock: nil
        )
    }

    func testCoordinatorLifecycleStartStop() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        try! sse.setup(config: config) { _ in }
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .idle)
        
        let stats = try! sse.getStats()
        XCTAssertEqual(stats.totalBytesReceived, 0)
        
        try! sse.start()
        XCTAssertTrue(sse.isConnected())
        
        try! sse.updateHeaders(headers: ["Authorization": "Bearer token"])
        sse.setLastProcessedId(id: "last-event-123")
        
        sse.stop()
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .closed)
    }
    
    func testCoordinatorRestartAndFlush() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        try! sse.setup(config: config) { _ in }
        
        sse.restart()
        XCTAssertTrue(sse.isConnected())
        
        sse.flush()
        
        sse.stop()
        XCTAssertFalse(sse.isConnected())
    }
    
    func testCoordinatorDelegateFailsSilentlyOnDummyUrl() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        try! sse.setup(config: config) { _ in }
        try! sse.start()
        XCTAssertTrue(sse.isConnected())
        
        // Simulates network connection failure surfacing from EventSource layer.
        let error = NSError(domain: "NSURLErrorDomain", code: -1004, userInfo: nil)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        
        let stats = try! sse.getStats()
        XCTAssertNotNil(stats)
        
        sse.stop()
        XCTAssertFalse(sse.isConnected())
    }
    
    func testCoordinatorHandlesFatalError400() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var emittedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            emittedEvents.append(contentsOf: events)
        }
        try! sse.start()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 400, userInfo: nil)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        
        sse.flush()
        
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .failed)
        XCTAssertTrue(emittedEvents.contains { $0.type == .error && $0.message?.contains("400") == true })
    }

    func testCoordinatorHandlesNoContent204() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var emittedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            emittedEvents.append(contentsOf: events)
        }
        try! sse.start()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 204, userInfo: nil)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        
        sse.flush()
        
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .failed)
        XCTAssertTrue(emittedEvents.contains { $0.type == .error && $0.message?.contains("204") == true })
    }
    
    func testCoordinatorHandlesAuthError401WithoutInterceptor() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var emittedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            emittedEvents.append(contentsOf: events)
        }
        try! sse.start()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 401, userInfo: nil)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        
        sse.flush()
        
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .failed)
        XCTAssertTrue(emittedEvents.contains { $0.type == .error && $0.message?.contains("401") == true })
    }
    
    func testCoordinatorHandlesRateLimit429() {
        let dispatcher = MockSseDispatcher()
        // Queue execution is deferred (`executeImmediately = false`) to verify async backoff scheduling.
        dispatcher.executeImmediately = false
        
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        
        // Construct standard HTTP 429 response containing Retry-After headers.
        let url = URL(string: "http://localhost:9999/dummy")!
        let response = HTTPURLResponse(url: url, statusCode: 429, httpVersion: nil, headerFields: ["Retry-After": "5", "retry-after": "5"])!
        let error = NSError(domain: "NSURLErrorDomain", code: 429, userInfo: ["response": response])
        
        // Discard initial dummy connection failure tasks before asserting Retry-After timer.
        dispatcher.pendingDelayedBlocks.removeAll()
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        
        let delayedBlock = dispatcher.pendingDelayedBlocks.first(where: { $0.delay >= 5.0 })
        XCTAssertNotNil(delayedBlock, "Should have scheduled a reconnect with delay >= 5.0")
        if let delay = delayedBlock?.delay {
            XCTAssertGreaterThanOrEqual(delay, 5.0)
            XCTAssertLessThanOrEqual(delay, 6.5)
        }
        
        sse.stop()
        dispatcher.executeAllPendingBlocks()
    }
    
    func testCoordinatorParsesMessage() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        var testConfig = createMockConfig()
        testConfig = testConfig.copyWith(autoParseJSON: true)
        
        var emittedEvents: [SseEvent] = []
        try! sse.setup(config: testConfig) { events in
            emittedEvents.append(contentsOf: events)
        }
        try! sse.start()
        
        sse.connectionDidReceiveMessage(eventType: "message", data: "{\"key\":\"value\"}", lastEventId: "100", attemptVersion: sse.connectionAttemptVersion)
        sse.flush()
        
        XCTAssertFalse(emittedEvents.isEmpty)
        let messageEvent = emittedEvents.first(where: { $0.type == .message })
        XCTAssertNotNil(messageEvent)
        XCTAssertEqual(messageEvent?.id, "100")
        
        sse.stop()
    }
    
    func testCoordinatorHandlesAuthError401WithInterceptor() {
        let dispatcher = MockSseDispatcher()
        dispatcher.executeImmediately = false
        
        let sse = NitroSse(dispatcher: dispatcher)
        var config = createMockConfig()
        
        config = config.copyWith(onBeforeRequest: {
            return Promise<Promise<Dictionary<String, String>>>.async {
                return Promise<Dictionary<String, String>>.async {
                    return ["Authorization": "Bearer token"]
                }
            }
        })
        
        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()
        
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 401, userInfo: nil)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        
        let retryBlock = dispatcher.pendingDelayedBlocks.first(where: { $0.delay > 0 })
        XCTAssertNotNil(retryBlock, "Should have scheduled a reconnect for 401 because interceptor is provided")
        
        sse.stop()
    }

    func testCoordinatorStateTransitions() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var states: [SseState] = []
        try! sse.setup(config: config) { events in
            states.append(contentsOf: events.filter { $0.type == .state }.compactMap { $0.state })
        }
        
        XCTAssertEqual(try! sse.getState(), .idle)
        
        try! sse.start()
        sse.flush()
        
        XCTAssertEqual(states.last, .connecting)
        
        sse.connectionDidOpen(attemptVersion: sse.connectionAttemptVersion)
        sse.flush()
        XCTAssertEqual(states.last, .open)
        
        sse.stop()
        sse.flush()
        XCTAssertEqual(states.last, .closed)
    }

    func testCoordinatorRestartBehavior() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var states: [SseState] = []
        try! sse.setup(config: config) { events in
            states.append(contentsOf: events.filter { $0.type == .state }.compactMap { $0.state })
        }
        
        try! sse.start()
        sse.flush()
        
        sse.connectionDidOpen(attemptVersion: sse.connectionAttemptVersion)
        sse.flush()
        
        let preRestartVersion = sse.connectionAttemptVersion
        
        sse.restart()
        sse.flush()
        
        XCTAssertGreaterThan(sse.connectionAttemptVersion, preRestartVersion)
        
        let lastTwoStates = Array(states.suffix(2))
        XCTAssertEqual(lastTwoStates, [.closed, .connecting])
        
        sse.stop()
    }

    func testCoordinatorStaleAttemptVersion() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var messages: [SseEvent] = []
        try! sse.setup(config: config) { events in
            messages.append(contentsOf: events.filter { $0.type == .message })
        }
        
        try! sse.start()
        let currentVersion = sse.connectionAttemptVersion
        
        sse.connectionDidReceiveMessage(eventType: "message", data: "valid", lastEventId: "1", attemptVersion: currentVersion)
        sse.flush()
        XCTAssertEqual(messages.count, 1)
        
        // Verifies events matching outdated attempt versions are dropped to prevent stale data emission.
        sse.connectionDidReceiveMessage(eventType: "message", data: "stale", lastEventId: "2", attemptVersion: currentVersion - 1)
        sse.flush()
        XCTAssertEqual(messages.count, 1, "Stale event should be ignored")
        
        sse.stop()
    }
}
