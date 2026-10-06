import XCTest
import NitroModules
@testable import NitroSse

class NitroSseCoordinatorTests: XCTestCase {
    private let TEST_URL = "http://localhost:33333/events"
    
    private func createMockConfig(maxReconnectAttempts: Double = 2) -> SseConfig {
        return SseConfig(
            url: TEST_URL,
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
            maxReconnectAttempts: maxReconnectAttempts,
            maxAuthRetries: 3,
            autoParseJSON: false,
            monitorNetwork: false,
            mock: nil
        )
    }

    func testRequestInterceptorIsNotEmbeddedInCopiedConfig() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        var interceptorCalls = 0
        let config = createMockConfig()
        let interceptor = { () -> Promise<Promise<Dictionary<String, String>>> in
            interceptorCalls += 1
            return Promise<Promise<Dictionary<String, String>>>.async {
                return Promise<Dictionary<String, String>>.async { [:] }
            }
        }

        try! sse.setup(config: config, onEvent: { _ in }, onBeforeRequest: interceptor)
        for index in 0..<10 {
            try! sse.updateHeaders(headers: ["X-Test": "\(index)"])
        }

        let storedConfigValue = Mirror(reflecting: sse).children.first { $0.label == "config" }?.value
        let storedConfig = storedConfigValue.flatMap {
            Mirror(reflecting: $0).children.first?.value as? SseConfig
        }
        XCTAssertNotNil(storedConfig)

        let storedInterceptor = Mirror(reflecting: sse).children.first { $0.label == "requestInterceptor" }?.value
        XCTAssertNotNil(storedInterceptor, "requestInterceptor should be stored separately on NitroSse instance")

        try! sse.start()
        XCTAssertEqual(interceptorCalls, 1)
        sse.stop()
    }

    func testDisposeReleasesRequestInterceptorAndConfigAndIsIdempotent() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        let interceptor = { () -> Promise<Promise<Dictionary<String, String>>> in
            return Promise<Promise<Dictionary<String, String>>>.async {
                return Promise<Dictionary<String, String>>.async { [:] }
            }
        }

        try! sse.setup(config: config, onEvent: { _ in }, onBeforeRequest: interceptor)

        let storedInterceptorBefore = Mirror(reflecting: sse).children.first { $0.label == "requestInterceptor" }?.value
        XCTAssertNotNil(storedInterceptorBefore)

        let storedConfigBefore = Mirror(reflecting: sse).children.first { $0.label == "config" }?.value
        XCTAssertNotNil(storedConfigBefore)

        sse.dispose()

        let storedInterceptorAfter = Mirror(reflecting: sse).children.first { $0.label == "requestInterceptor" }?.value
        let unwrappedInterceptor = storedInterceptorAfter.flatMap { Mirror(reflecting: $0).children.first?.value }
        XCTAssertNil(unwrappedInterceptor, "requestInterceptor should be nil after dispose")

        let storedConfigAfter = Mirror(reflecting: sse).children.first { $0.label == "config" }?.value
        let unwrappedConfig = storedConfigAfter.flatMap { Mirror(reflecting: $0).children.first?.value }
        XCTAssertNil(unwrappedConfig, "config should be nil after dispose")

        // Idempotency check: calling dispose() second time must not crash
        sse.dispose()
    }

    func testSetupReplacesOrClearsRequestInterceptor() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()

        var interceptorACalls = 0
        let interceptorA = { () -> Promise<Promise<Dictionary<String, String>>> in
            interceptorACalls += 1
            return Promise<Promise<Dictionary<String, String>>>.async {
                return Promise<Dictionary<String, String>>.async { [:] }
            }
        }

        var interceptorBCalls = 0
        let interceptorB = { () -> Promise<Promise<Dictionary<String, String>>> in
            interceptorBCalls += 1
            return Promise<Promise<Dictionary<String, String>>>.async {
                return Promise<Dictionary<String, String>>.async { [:] }
            }
        }

        // Setup with A
        try! sse.setup(config: config, onEvent: { _ in }, onBeforeRequest: interceptorA)
        try! sse.start()
        XCTAssertEqual(interceptorACalls, 1)
        sse.stop()

        // Setup with B replaces A
        try! sse.setup(config: config, onEvent: { _ in }, onBeforeRequest: interceptorB)
        try! sse.start()
        XCTAssertEqual(interceptorACalls, 1, "A should not be called again")
        XCTAssertEqual(interceptorBCalls, 1, "B should be called")
        sse.stop()

        // Setup without interceptor clears previous interceptor
        try! sse.setup(config: config, onEvent: { _ in })
        try! sse.start()
        XCTAssertEqual(interceptorACalls, 1)
        XCTAssertEqual(interceptorBCalls, 1)
        sse.stop()

        sse.dispose()
    }

    func testRestartAndStopInlineWhenAlreadyOnDispatcher() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()

        try! sse.setup(config: config, onEvent: { _ in })
        try! sse.start()
        XCTAssertTrue(sse.isConnected())

        // Execute while current dispatcher queue is active: must execute inline without deadlocking or pending queue
        dispatcher.sync {
            sse.restart()
            XCTAssertTrue(sse.isConnected())
            sse.stop()
            XCTAssertFalse(sse.isConnected())
        }

        sse.dispose()
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

    func testCoordinatorHandlesFatalError404() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var emittedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            emittedEvents.append(contentsOf: events)
        }
        try! sse.start()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 404, userInfo: nil)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        
        sse.flush()
        
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .failed)
        XCTAssertTrue(emittedEvents.contains { $0.type == .error && $0.message?.contains("404") == true })
    }

    func testCoordinatorHandlesFatalError405() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        try! sse.setup(config: config) { _ in }
        try! sse.start()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 405, userInfo: nil)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        sse.flush()
        
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .failed)
    }

    func testCoordinatorHandlesFatalError410() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        try! sse.setup(config: config) { _ in }
        try! sse.start()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 410, userInfo: nil)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        sse.flush()
        
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .failed)
    }

    func testCoordinatorHandlesFatalError422() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        try! sse.setup(config: config) { _ in }
        try! sse.start()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 422, userInfo: nil)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        sse.flush()
        
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .failed)
    }

    func testCoordinatorHandlesTimeout408Reconnecting() {
        let dispatcher = MockSseDispatcher()
        dispatcher.executeImmediately = false
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 408, userInfo: nil)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        
        XCTAssertEqual(try! sse.getState(), .reconnecting)
    }

    func testCoordinatorHandlesServerError500Reconnecting() {
        let dispatcher = MockSseDispatcher()
        dispatcher.executeImmediately = false
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 500, userInfo: nil)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        
        XCTAssertEqual(try! sse.getState(), .reconnecting)
    }

    func testCoordinatorEmitsHeartbeatWithCommentPayload() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var emittedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            emittedEvents.append(contentsOf: events)
        }
        try! sse.start()
        
        sse.connectionDidReceiveComment("keepalive-comment", attemptVersion: sse.connectionAttemptVersion)
        sse.flush()
        
        let heartbeat = emittedEvents.first(where: { $0.type == .heartbeat })
        XCTAssertNotNil(heartbeat)
        XCTAssertEqual(heartbeat?.message, "keepalive-comment")
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
        let url = URL(string: TEST_URL)!
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

    func testCoordinatorHandlesRateLimit429WithoutRetryAfter() {
        let dispatcher = MockSseDispatcher()
        dispatcher.executeImmediately = false
        
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var emittedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            emittedEvents.append(contentsOf: events)
        }
        dispatcher.executeAllPendingBlocks()
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 429, userInfo: nil)
        dispatcher.pendingDelayedBlocks.removeAll()
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        sse.flush()
        dispatcher.executeAllPendingBlocks()
        
        // HTTP 429 without Retry-After should fallback to exponential backoff retry rather than failing.
        XCTAssertEqual(try! sse.getState(), .reconnecting)
        let retryBlock = dispatcher.pendingDelayedBlocks.first(where: { $0.delay > 0 })
        XCTAssertNotNil(retryBlock, "Should have scheduled an automatic reconnect with exponential backoff for 429")
        XCTAssertTrue(emittedEvents.contains { $0.type == .error && $0.message?.contains("Rate Limited (429)") == true })
        
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
        let config = createMockConfig()
        
        let interceptor = { () -> Promise<Promise<Dictionary<String, String>>> in
            return Promise<Promise<Dictionary<String, String>>>.async {
                return Promise<Dictionary<String, String>>.async {
                    return ["Authorization": "Bearer token"]
                }
            }
        }
        
        try! sse.setup(config: config, onEvent: { _ in }, onBeforeRequest: interceptor)
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

    func testOnBeforeRequestHeadersDoNotMutateBaseConfig() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let initialHeaders = ["X-Base": "base-val"]
        let config = createMockConfig().copyWith(headers: initialHeaders)
        
        let interceptor = { () -> Promise<Promise<Dictionary<String, String>>> in
            return Promise<Promise<Dictionary<String, String>>>.async {
                return Promise<Dictionary<String, String>>.async {
                    return ["Authorization": "Bearer dynamic-token", "X-Temp": "temp-val"]
                }
            }
        }
        
        try! sse.setup(config: config, onEvent: { _ in }, onBeforeRequest: interceptor)
        dispatcher.executeAllPendingBlocks()
        
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        
        let storedConfigValue = Mirror(reflecting: sse).children.first { $0.label == "config" }?.value
        let storedConfig = storedConfigValue.flatMap {
            Mirror(reflecting: $0).children.first?.value as? SseConfig
        }
        XCTAssertNotNil(storedConfig)
        
        // Base config headers should remain strictly untouched
        XCTAssertEqual(storedConfig?.headers, ["X-Base": "base-val"])
        XCTAssertNil(storedConfig?.headers?["Authorization"])
        XCTAssertNil(storedConfig?.headers?["X-Temp"])
        
        sse.stop()
        dispatcher.executeAllPendingBlocks()
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
        
        let dummyResponse = HTTPURLResponse(url: URL(string: TEST_URL)!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!
        sse.connectionDidOpen(response: dummyResponse, attemptVersion: sse.connectionAttemptVersion)
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
        
        let dummyResponse = HTTPURLResponse(url: URL(string: TEST_URL)!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!
        sse.connectionDidOpen(response: dummyResponse, attemptVersion: sse.connectionAttemptVersion)
        sse.flush()
        
        let preRestartVersion = sse.connectionAttemptVersion
        
        sse.restart()
        sse.flush()
        
        XCTAssertGreaterThan(sse.connectionAttemptVersion, preRestartVersion)
        
        let lastTwoStates = Array(states.suffix(2))
        XCTAssertEqual(lastTwoStates, [.reconnecting, .connecting])
        
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

    func testRetryAfterReconnectionStopsAtMaxAttempts() {
        let dispatcher = MockSseDispatcher()
        dispatcher.executeImmediately = false
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig(maxReconnectAttempts: 1.0)
        
        var emittedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            emittedEvents.append(contentsOf: events)
        }
        dispatcher.executeAllPendingBlocks()
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        
        let response1 = HTTPURLResponse(
            url: URL(string: config.url)!,
            statusCode: 429,
            httpVersion: "HTTP/1.1",
            headerFields: ["Retry-After": "1"]
        )!
        let error1 = NSError(domain: "NSURLErrorDomain", code: 429, userInfo: ["response": response1])
        
        // Attempt 1: 429 Retry-After -> schedules 1st reconnect
        let version1 = sse.connectionAttemptVersion
        sse.connectionDidFail(error: error1, attemptVersion: version1)
        dispatcher.executeAllPendingBlocks()
        XCTAssertEqual(try! sse.getState(), .reconnecting)
        
        // Execute delayed reconnect
        dispatcher.executeDelayedBlocks()
        dispatcher.executeAllPendingBlocks()
        
        // Attempt 2: 429 Retry-After (reaches maxReconnectAttempts = 1) -> stops
        let version2 = sse.connectionAttemptVersion
        sse.connectionDidFail(error: error1, attemptVersion: version2)
        dispatcher.executeAllPendingBlocks()
        
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .failed)
    }

    func testUpdateHeadersMergesWithExistingHeaders() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig().copyWith(headers: ["X-Initial": "1", "Authorization": "old"])
        
        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()
        
        try! sse.updateHeaders(headers: ["Authorization": "new", "Tenant": "tenant-1"])
        dispatcher.executeAllPendingBlocks()
        
        let mirror = Mirror(reflecting: sse)
        if let configProp = mirror.children.first(where: { $0.label == "config" })?.value as? SseConfig {
            XCTAssertEqual(configProp.headers?["X-Initial"], "1")
            XCTAssertEqual(configProp.headers?["Authorization"], "new")
            XCTAssertEqual(configProp.headers?["Tenant"], "tenant-1")
        } else {
            XCTFail("Could not access config property on NitroSse")
        }
    }

    func testLogicalBytesReceivedAccounting() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()

        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        dispatcher.executeAllPendingBlocks()

        let currentVersion = sse.connectionAttemptVersion

        XCTAssertEqual(try! sse.getStats().totalBytesReceived, 0)

        // 1. Push message with data (12 B), id (4 B), type (6 B) -> total 22 B
        sse.connectionDidReceiveMessage(eventType: "custom", data: "payload-data", lastEventId: "id-1", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        XCTAssertEqual(try! sse.getStats().totalBytesReceived, 22.0)

        // 2. Push default message with LDSwift default eventType="message" and retained lastEventId="id-1"
        // Should NOT add 7 B for "message" and should NOT re-add 4 B for retained "id-1" -> only data (5 B)
        sse.connectionDidReceiveMessage(eventType: "message", data: "hello", lastEventId: "id-1", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        XCTAssertEqual(try! sse.getStats().totalBytesReceived, 27.0)

        // 3. Push message with a newly updated id ("id-2" = 4 B) and default eventType="message" -> 4 B (new id) + 5 B (data) = 9 B
        sse.connectionDidReceiveMessage(eventType: "message", data: "world", lastEventId: "id-2", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        XCTAssertEqual(try! sse.getStats().totalBytesReceived, 36.0)

        // 4. Push heartbeat comment ("ping" = 4 B)
        sse.connectionDidReceiveComment("ping", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        XCTAssertEqual(try! sse.getStats().totalBytesReceived, 40.0)

        // 5. Push message with empty id ("" = 0 B) resetting lastProcessedId per WHATWG SSE -> only data (5 B)
        sse.connectionDidReceiveMessage(eventType: "message", data: "reset", lastEventId: "", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        XCTAssertEqual(try! sse.getStats().totalBytesReceived, 45.0)

        // 6. Push message re-using "id-2" (4 B) after reset -> counts as new id because lastProcessedId was cleared -> 4 B + 5 B = 9 B
        sse.connectionDidReceiveMessage(eventType: "message", data: "after", lastEventId: "id-2", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        XCTAssertEqual(try! sse.getStats().totalBytesReceived, 54.0)
    }

    func testEmptyIdResetsLastProcessedId() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()

        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        dispatcher.executeAllPendingBlocks()

        let currentVersion = sse.connectionAttemptVersion

        // 1. Receive event with id "event-1"
        sse.connectionDidReceiveMessage(eventType: "message", data: "hello", lastEventId: "event-1", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()
        XCTAssertEqual(sse.lastProcessedId, "event-1")

        // 2. Receive event with empty id -> resets to nil per WHATWG SSE spec
        sse.connectionDidReceiveMessage(eventType: "message", data: "world", lastEventId: "", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()
        XCTAssertNil(sse.lastProcessedId)

        // 3. Receive event with new id -> sets new id
        sse.connectionDidReceiveMessage(eventType: "message", data: "foo", lastEventId: "event-2", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()
        XCTAssertEqual(sse.lastProcessedId, "event-2")
    }

    func testCoordinatorRetriesUpToMaxAuthRetries() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig(maxReconnectAttempts: 10).copyWith(maxAuthRetries: 3)

        let interceptor = { () -> Promise<Promise<Dictionary<String, String>>> in
            return Promise<Promise<Dictionary<String, String>>>.async {
                return Promise<Dictionary<String, String>>.async {
                    return ["Authorization": "Bearer token"]
                }
            }
        }

        try! sse.setup(config: config, onEvent: { _ in }, onBeforeRequest: interceptor)
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        Thread.sleep(forTimeInterval: 0.05)
        dispatcher.executeAllPendingBlocks()

        let error = NSError(domain: "NSURLErrorDomain", code: 401, userInfo: nil)

        // 1st error -> Retry 1
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        XCTAssertEqual(try! sse.getState(), .reconnecting)

        // 2nd error -> Retry 2
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        XCTAssertEqual(try! sse.getState(), .reconnecting)

        // 3rd error -> Retry 3 (MUST still be reconnecting because maxAuthRetries=3 allows 3 retries)
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        XCTAssertEqual(try! sse.getState(), .reconnecting)

        // 4th error -> Exceeded 3 retries, now failed
        sse.connectionDidFail(error: error, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        XCTAssertEqual(try! sse.getState(), .failed)

        sse.stop()
    }

    func testCoordinatorCapturesBoundedErrorBodyOnFatalError() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var emittedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            emittedEvents.append(contentsOf: events)
        }
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 400, userInfo: nil)
        let response = HTTPURLResponse(url: URL(string: "http://localhost:33333/events")!, statusCode: 400, httpVersion: "HTTP/1.1", headerFields: nil)
        let jsonErrorBody = "{\"error\":\"invalid_param\",\"field\":\"user_id\"}"
        
        sse.connectionDidFail(error: error, response: response, errorBody: jsonErrorBody, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        sse.flush()
        
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .failed)
        XCTAssertTrue(emittedEvents.contains { $0.type == .error && $0.message == "Fatal Error (400): \(jsonErrorBody)" })
    }

    func testCoordinatorMasksHtmlErrorBody() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var emittedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            emittedEvents.append(contentsOf: events)
        }
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        
        let error = NSError(domain: "NSURLErrorDomain", code: 404, userInfo: nil)
        let response = HTTPURLResponse(url: URL(string: "http://localhost:33333/events")!, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)
        let htmlBody = "<html><body><h1>404 Not Found</h1></body></html>"
        
        sse.connectionDidFail(error: error, response: response, errorBody: htmlBody, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        sse.flush()
        
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .failed)
        XCTAssertTrue(emittedEvents.contains { $0.type == .error && $0.message == "Fatal Error (404): \(htmlBody)" })
    }

    func testCoordinatorStrictContentTypeCaptivePortalFatalNoReconnect() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        var emittedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            emittedEvents.append(contentsOf: events)
        }
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        
        let captivePortalResponse = HTTPURLResponse(
            url: URL(string: "http://localhost:33333/events")!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/html; charset=UTF-8"]
        )
        let error = NSError(
            domain: "NitroSse",
            code: -2001,
            userInfo: [NSLocalizedDescriptionKey: "Invalid Content-Type: expected text/event-stream but received 'text/html'"]
        )
        
        sse.connectionDidFail(error: error, response: captivePortalResponse, errorBody: nil, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        sse.flush()
        
        XCTAssertFalse(sse.isConnected())
        XCTAssertEqual(try! sse.getState(), .failed)
        XCTAssertTrue(emittedEvents.contains { $0.type == .error && $0.message?.contains("Invalid Content-Type") == true })
    }

    func testCoordinatorPreservesLastEventIdFromIdUpdateWithoutData() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()
        
        try! sse.setup(config: config) { _ in }
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        
        // Server sends id: 456 without data field -> connectionDidUpdateLastEventId called
        sse.connectionDidUpdateLastEventId(id: "456", attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        
        XCTAssertEqual(sse.lastProcessedId, "456", "lastProcessedId must be updated even when no message is dispatched")
        
        // Then empty id clears it
        sse.connectionDidUpdateLastEventId(id: nil, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()
        
        XCTAssertNil(sse.lastProcessedId, "empty id must reset lastProcessedId to nil")
        
        sse.stop()
    }

    func testSetupInitializesLastProcessedIdFromConfigHeaders() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig().copyWith(headers: ["Last-Event-Id": "initial-checkpoint-42"])
        
        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()
        
        XCTAssertEqual(sse.lastProcessedId, "initial-checkpoint-42", "setup must extract initial Last-Event-Id from config.headers")
    }

    func testRealParserFlowByteAccountingCountsId() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()

        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        dispatcher.executeAllPendingBlocks()

        let currentVersion = sse.connectionAttemptVersion

        // Real parser flow: When parser encounters "id: id-1", it notifies connectionDidUpdateLastEventId:
        sse.connectionDidUpdateLastEventId(id: "id-1", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        // Then on empty line \n\n, parser dispatches the message:
        sse.connectionDidReceiveMessage(eventType: "message", data: "hello", lastEventId: "id-1", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        // Expected: data (5 B) + id (4 B) = 9 B
        XCTAssertEqual(try! sse.getStats().totalBytesReceived, 9.0)
    }

    func testRetryDirectiveUpdatesReconnectIntervalAcrossReconnections() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig().copyWith(retryIntervalMs: 1000)

        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        dispatcher.executeAllPendingBlocks()

        let currentVersion = sse.connectionAttemptVersion

        // Server sends retry: 5000
        sse.connectionDidReceiveRetry(retryMs: 5000, attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        let strategyMirror = Mirror(reflecting: sse)
        if let strat = strategyMirror.children.first(where: { $0.label == "reconnectStrategy" })?.value as? SseReconnectStrategy {
            let innerMirror = Mirror(reflecting: strat)
            let interval = innerMirror.children.first(where: { $0.label == "retryInterval" })?.value as? Double
            XCTAssertEqual(interval, 5.0)
        }
    }

    func testNegativeAndExtremeRetryAfterIsBounded() {
        // WHATWG / RFC 7231: Retry-After delta-seconds must be a 1*DIGIT sequence. Negative and float values are invalid and ignored.
        let invalidHeaders = ["-100", "-1", "1.5", "1e3", "abc", "+10"]
        for headerVal in invalidHeaders {
            let resp = HTTPURLResponse(url: URL(string: "http://localhost:33333/events")!, statusCode: 429, httpVersion: "HTTP/1.1", headerFields: ["Retry-After": headerVal])!
            let extracted = SseReconnectStrategy.extractRetryAfterSeconds(from: resp)
            XCTAssertNil(extracted, "Invalid Retry-After '\(headerVal)' must be ignored (return nil)")
        }
        
        let validHeaders = [("45", 45.0), ("0", 0.0), ("120", 120.0)]
        for (headerVal, expected) in validHeaders {
            let resp = HTTPURLResponse(url: URL(string: "http://localhost:33333/events")!, statusCode: 429, httpVersion: "HTTP/1.1", headerFields: ["Retry-After": headerVal])!
            let extracted = SseReconnectStrategy.extractRetryAfterSeconds(from: resp)
            XCTAssertEqual(extracted, expected, "Valid integer Retry-After '\(headerVal)' must parse correctly")
        }
    }

    func testParserResourceLimitViolationIsFatalNoReconnect() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()

        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        dispatcher.executeAllPendingBlocks()

        let error = NSError(domain: "NitroSse", code: -2002, userInfo: [NSLocalizedDescriptionKey: "SSE line exceeded maximum limit"])
        sse.connectionDidFail(error: error, response: nil, errorBody: nil, attemptVersion: sse.connectionAttemptVersion)
        dispatcher.executeAllPendingBlocks()

        XCTAssertEqual(try! sse.getState(), .failed, "Resource limit violation -2002 must be fatal (.failed) rather than entering .reconnecting")
    }

    func testTransportTimeoutAfter200ResponseDoesNotOverwriteWithStatusCode200() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()

        var capturedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            capturedEvents.append(contentsOf: events)
        }
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        dispatcher.executeAllPendingBlocks()

        let currentVersion = sse.connectionAttemptVersion

        // Stream opens with HTTP 200 OK
        let response = HTTPURLResponse(
            url: URL(string: TEST_URL)!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"]
        )!
        sse.connectionDidOpen(response: response, attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        // Stream later times out with NSURLErrorTimedOut (-1001), passing the existing HTTP 200 response
        let timeoutError = NSError(
            domain: NSURLErrorDomain,
            code: NSURLErrorTimedOut,
            userInfo: [NSLocalizedDescriptionKey: "The request timed out."]
        )
        sse.connectionDidFail(error: timeoutError, response: response, errorBody: nil, attemptVersion: currentVersion)
        sse.flush()
        dispatcher.executeAllPendingBlocks()

        let errorEvent = capturedEvents.first(where: { $0.type == .error })
        XCTAssertNotNil(errorEvent, "Error event must be emitted on transport timeout")
        XCTAssertNotEqual(errorEvent?.statusCode, 200.0, "Transport error must NOT be overwritten with HTTP 200 status code")
        XCTAssertEqual(errorEvent?.statusCode, Double(NSURLErrorTimedOut), "Transport error code -1001 must be preserved")
    }

    func testParserFailureAfter200ResponsePreservesParserErrorCode() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig()

        var capturedEvents: [SseEvent] = []
        try! sse.setup(config: config) { events in
            capturedEvents.append(contentsOf: events)
        }
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        dispatcher.executeAllPendingBlocks()

        let currentVersion = sse.connectionAttemptVersion

        // Stream opens with HTTP 200 OK
        let response = HTTPURLResponse(
            url: URL(string: TEST_URL)!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"]
        )!
        sse.connectionDidOpen(response: response, attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        // Parser fails with line length limit exceeded (-2002), passing the 200 response
        let parserError = NSError(
            domain: "NitroSse",
            code: -2002,
            userInfo: [NSLocalizedDescriptionKey: "SSE line exceeded maximum limit"]
        )
        sse.connectionDidFail(error: parserError, response: response, errorBody: nil, attemptVersion: currentVersion)
        sse.flush()
        dispatcher.executeAllPendingBlocks()

        let errorEvent = capturedEvents.first(where: { $0.type == .error })
        XCTAssertNotNil(errorEvent, "Error event must be emitted on parser failure")
        XCTAssertNotEqual(errorEvent?.statusCode, 200.0, "Parser error must NOT be overwritten with HTTP 200 status code")
        XCTAssertEqual(errorEvent?.statusCode, -2002.0, "Parser error code -2002 must be preserved")
        XCTAssertEqual(try! sse.getState(), .failed, "Parser resource limit violation must be fatal (.failed)")
    }

    func testRetryDirectivePersistsAndGovernsReconnectDelay() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig().copyWith(batchingIntervalMs: 0.0, retryIntervalMs: 1000, jitterFactor: 0.0)

        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        dispatcher.executeAllPendingBlocks()

        let currentVersion = sse.connectionAttemptVersion

        // Server sends retry: 5000
        sse.connectionDidReceiveRetry(retryMs: 5000, attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        // Clear pre-existing timers (such as connectionTimeout timer)
        dispatcher.pendingDelayedBlocks.removeAll()

        // Connection drops with a transport error
        let transportError = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost, userInfo: nil)
        sse.connectionDidFail(error: transportError, response: nil, errorBody: nil, attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        // Verify sse entered .reconnecting state
        XCTAssertEqual(try! sse.getState(), .reconnecting)

        // Verify dispatcher scheduled a reconnect delay of 5.0 seconds (5000 ms)
        let reconnectBlock = dispatcher.pendingDelayedBlocks.first(where: { $0.delay >= 1.0 })
        XCTAssertNotNil(reconnectBlock, "A reconnect timer block must be scheduled")
        XCTAssertEqual(reconnectBlock?.delay, 5.0, "Subsequent reconnect must use the updated 5000ms retry interval")

        // Execute the delayed block to verify reconnect execution
        dispatcher.executeDelayedBlocks()
        dispatcher.executeAllPendingBlocks()
        XCTAssertEqual(try! sse.getState(), .connecting)
    }

    func testComprehensiveMetricsTracking() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig().copyWith(batchingIntervalMs: 0.0)

        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()

        let initialStats = try! sse.getStats()
        XCTAssertEqual(initialStats.rawBytesReceived, 0.0)
        XCTAssertEqual(initialStats.totalBytesReceived, 0.0)
        XCTAssertEqual(initialStats.chunksReceived, 0.0)
        XCTAssertEqual(initialStats.totalEventsReceived, 0.0)
        XCTAssertEqual(initialStats.commentsReceived, 0.0)
        XCTAssertEqual(initialStats.linesParsed, 0.0)
        XCTAssertEqual(initialStats.parseErrors, 0.0)
        XCTAssertEqual(initialStats.connectionAttempts, 0.0)
        XCTAssertEqual(initialStats.reconnectCount, 0.0)
        XCTAssertNil(initialStats.connectedAt)
        XCTAssertNil(initialStats.lastStatusCode)
        XCTAssertNil(initialStats.serverRetryDelayMs)
        XCTAssertNil(initialStats.timeToFirstByteMs)
        XCTAssertNil(initialStats.disconnectReason)

        try! sse.start()
        dispatcher.executeAllPendingBlocks()

        let currentVersion = sse.connectionAttemptVersion
        var stats = try! sse.getStats()
        XCTAssertEqual(stats.connectionAttempts, 1.0)

        // 1. Connection DidOpen
        let response = HTTPURLResponse(url: URL(string: TEST_URL)!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!
        sse.connectionDidOpen(response: response, attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.lastStatusCode, 200.0)
        XCTAssertNotNil(stats.connectedAt)

        // 2. Data chunk received
        sse.connectionDidReceiveDataChunk(chunkLength: 128, rawWireBytes: 128, decompressedBytes: 128, attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.chunksReceived, 1.0)
        XCTAssertEqual(stats.rawBytesReceived, 128.0)
        XCTAssertEqual(stats.decompressedBytesReceived, 128.0)
        XCTAssertNotNil(stats.timeToFirstByteMs)

        // 3. Lines parsed
        sse.connectionDidParseLines(count: 4, attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.linesParsed, 4.0)

        // 4. Message received
        sse.connectionDidReceiveMessage(eventType: "message", data: "Hello World", lastEventId: "evt-1", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.totalEventsReceived, 1.0)
        XCTAssertNotNil(stats.lastEventTime)
        XCTAssertGreaterThan(stats.totalBytesReceived, 0.0)

        // 5. Comment received
        sse.connectionDidReceiveComment("keepalive", attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.commentsReceived, 1.0)
        XCTAssertNotNil(stats.lastHeartbeatTime)
        XCTAssertGreaterThanOrEqual(stats.maxEventGapMs, 0.0)

        // 6. Retry delay received
        sse.connectionDidReceiveRetry(retryMs: 5000, attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.serverRetryDelayMs, 5000.0)

        // 7. Parse error
        sse.connectionDidEncounterParseError(attemptVersion: currentVersion)
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.parseErrors, 1.0)
        XCTAssertEqual(stats.disconnectReason, .parserError)

        // 8. Buffer flush
        sse.flush()
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertGreaterThan(stats.bufferFlushCount, 0.0)

        // 9. Stop by user
        sse.stop()
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.disconnectReason, .userStop)
        XCTAssertNil(stats.connectedAt)
    }

    func testDisconnectReasonsMetrics() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig().copyWith(batchingIntervalMs: 0.0, retryIntervalMs: 1000, jitterFactor: 0.0)

        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()

        // 1. Server Error (500)
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        var version = sse.connectionAttemptVersion
        let resp500 = HTTPURLResponse(url: URL(string: TEST_URL)!, statusCode: 500, httpVersion: nil, headerFields: [:])!
        sse.connectionDidFail(error: NSError(domain: "HTTP", code: 500, userInfo: nil), response: resp500, errorBody: "Internal Server Error", attemptVersion: version)
        dispatcher.executeAllPendingBlocks()

        var stats = try! sse.getStats()
        XCTAssertEqual(stats.disconnectReason, .serverError)
        XCTAssertEqual(stats.lastStatusCode, 500.0)
        XCTAssertNotNil(stats.lastErrorTime)
        XCTAssertNotNil(stats.lastReconnectDelayMs)

        // 2. Timeout
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        version = sse.connectionAttemptVersion
        let timeoutErr = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut, userInfo: nil)
        sse.connectionDidFail(error: timeoutErr, response: nil, errorBody: nil, attemptVersion: version)
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.disconnectReason, .timeout)

        // 3. Network Error
        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        version = sse.connectionAttemptVersion
        let netErr = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost, userInfo: nil)
        sse.connectionDidFail(error: netErr, response: nil, errorBody: nil, attemptVersion: version)
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.disconnectReason, .networkError)

        // 4. Reconnect count increments when moving from reconnecting to open
        XCTAssertEqual(try! sse.getState(), .reconnecting)
        let reconnectVersion = sse.connectionAttemptVersion
        let resp200 = HTTPURLResponse(url: URL(string: TEST_URL)!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!
        sse.connectionDidOpen(response: resp200, attemptVersion: reconnectVersion)
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.reconnectCount, 1.0)
        XCTAssertEqual(try! sse.getState(), .open)

        sse.stop()
        dispatcher.executeAllPendingBlocks()
    }

    func testParserLimitDisconnectReasonNotOverwrittenByResponse() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig().copyWith(batchingIntervalMs: 0.0)

        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        let version = sse.connectionAttemptVersion

        // Simulate parser error followed by connectionDidFail with HTTP 200 response
        sse.connectionDidEncounterParseError(attemptVersion: version)
        let resp200 = HTTPURLResponse(url: URL(string: TEST_URL)!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/html"])!
        let parseError = NSError(domain: "NitroSse", code: -2001, userInfo: [NSLocalizedDescriptionKey: "Invalid Content-Type"])
        sse.connectionDidFail(error: parseError, response: resp200, errorBody: nil, attemptVersion: version)
        dispatcher.executeAllPendingBlocks()

        let stats = try! sse.getStats()
        XCTAssertEqual(stats.disconnectReason, .parserError, "Parse error must retain .parserError even when response is non-nil")
        XCTAssertEqual(try! sse.getState(), .failed)
    }

    func testRawBytesAccumulatesAcrossReconnections() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig().copyWith(batchingIntervalMs: 0.0, retryIntervalMs: 1000, jitterFactor: 0.0)

        try! sse.setup(config: config) { _ in }
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        dispatcher.executeAllPendingBlocks()
        var version = sse.connectionAttemptVersion

        // Attempt 1 receives 150 bytes, then fails
        sse.connectionDidReceiveDataChunk(chunkLength: 150, rawWireBytes: 150, decompressedBytes: nil, attemptVersion: version)
        sse.connectionDidFail(error: NSError(domain: "HTTP", code: 500, userInfo: nil), response: nil, errorBody: nil, attemptVersion: version)
        dispatcher.executeAllPendingBlocks()

        var stats = try! sse.getStats()
        XCTAssertEqual(stats.rawBytesReceived, 150.0)

        // Attempt 2 reconnects, receives 200 bytes
        version = sse.connectionAttemptVersion
        sse.connectionDidReceiveDataChunk(chunkLength: 200, rawWireBytes: 200, decompressedBytes: nil, attemptVersion: version)
        dispatcher.executeAllPendingBlocks()

        stats = try! sse.getStats()
        XCTAssertEqual(stats.rawBytesReceived, 350.0, "rawBytesReceived must accumulate across reconnections")
    }

    func testInterceptorErrorsStopAfterMaxAuthRetries() {
        let dispatcher = MockSseDispatcher()
        let sse = NitroSse(dispatcher: dispatcher)
        let config = createMockConfig().copyWith(batchingIntervalMs: 0.0, retryIntervalMs: 1000, jitterFactor: 0.0, maxAuthRetries: 2)

        var callCount = 0
        let interceptor: () -> Promise<Promise<Dictionary<String, String>>> = {
            callCount += 1
            return Promise.rejected(withError: NSError(domain: "Auth", code: -1, userInfo: [NSLocalizedDescriptionKey: "Token refresh failed"]))
        }

        try! sse.setup(config: config, onEvent: { _ in }, onBeforeRequest: interceptor)
        dispatcher.executeAllPendingBlocks()

        try! sse.start()
        // Execute backoff retry cycles
        for _ in 0..<5 {
            dispatcher.executeAllPendingBlocks()
            dispatcher.executeDelayedBlocks()
        }

        let state = try! sse.getState()
        XCTAssertEqual(state, .failed, "Should stop permanently after exceeding maxAuthRetries")
        XCTAssertLessThanOrEqual(callCount, 3)
    }
}

