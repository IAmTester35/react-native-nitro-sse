import XCTest
@testable import NitroSse

final class SseConnectionHandlerTests: XCTestCase {
    private let TEST_URL = "http://localhost:33333/events"
    
    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }
    
    private func createTestConfig(
        url: String = "http://localhost:33333/events",
        headers: [String: String] = [:]
    ) -> SseConfig {
        return SseConfig(
            url: url,
            method: .get,
            headers: headers,
            body: nil,
            backgroundExecution: false,
            batchingIntervalMs: 0,
            maxBufferSize: 1000,
            connectionTimeoutMs: 5000,
            readTimeoutMs: 60000,
            retryIntervalMs: 1000,
            maxRetryIntervalMs: 30000,
            jitterFactor: 0.0,
            maxReconnectAttempts: nil,
            maxAuthRetries: 3,
            autoParseJSON: false,
            monitorNetwork: false,
            mock: nil
        )
    }
    
    private class TestDelegate: SseConnectionDelegate {
        var didOpenCalled = false
        var openedResponse: HTTPURLResponse?
        var didCloseCalled = false
        var didFailCalled = false
        var failedError: Error?
        var failedResponse: HTTPURLResponse?
        var failedErrorBody: String?
        var receivedMessages: [(type: String, data: String, lastEventId: String)] = []
        var receivedComments: [String] = []
        var receivedRetries: [Int64] = []
        var updatedLastEventIds: [String?] = []
        
        var onOpen: (() -> Void)?
        var onFail: (() -> Void)?
        var onClose: (() -> Void)?
        var onMessage: (() -> Void)?
        var onUpdateLastEventId: (() -> Void)?
        
        func connectionDidOpen(response: HTTPURLResponse, attemptVersion: Int) {
            didOpenCalled = true
            openedResponse = response
            onOpen?()
        }
        
        func connectionDidClose(attemptVersion: Int) {
            didCloseCalled = true
            onClose?()
        }
        
        func connectionDidReceiveMessage(eventType: String, data: String, lastEventId: String, attemptVersion: Int) {
            receivedMessages.append((type: eventType, data: data, lastEventId: lastEventId))
            onMessage?()
        }
        
        func connectionDidReceiveComment(_ comment: String, attemptVersion: Int) {
            receivedComments.append(comment)
        }
        
        func connectionDidReceiveRetry(retryMs: Int64, attemptVersion: Int) {
            receivedRetries.append(retryMs)
        }
        
        func connectionDidUpdateLastEventId(id: String?, attemptVersion: Int) {
            updatedLastEventIds.append(id)
            onUpdateLastEventId?()
        }
        
        func connectionDidFail(error: Error, response: HTTPURLResponse?, errorBody: String?, attemptVersion: Int) {
            didFailCalled = true
            failedError = error
            failedResponse = response
            failedErrorBody = errorBody
            onFail?()
        }

        func connectionDidFail(error: Error, response: HTTPURLResponse?, attemptVersion: Int) {
            connectionDidFail(error: error, response: response, errorBody: nil, attemptVersion: attemptVersion)
        }
    }
    
    func testConnectionDidOpenReceivesHttpResponseHeaders() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let exp = expectation(description: "connectionDidOpen receives response")
        delegate.onOpen = { exp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": "text/event-stream",
                    "X-Server-Version": "1.2.3"
                ]
            )!
            let data = "data: hello\n\n".data(using: .utf8)!
            return (response, [data], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [exp], timeout: 2.0)
        
        XCTAssertTrue(delegate.didOpenCalled)
        XCTAssertEqual(delegate.openedResponse?.statusCode, 200)
        XCTAssertEqual(delegate.openedResponse?.allHeaderFields["X-Server-Version"] as? String, "1.2.3")
    }
    
    func testNonEventStreamContentTypeFails() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let exp = expectation(description: "connectionDidFail on invalid Content-Type")
        delegate.onFail = { exp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": "text/html"
                ]
            )!
            let data = "<html>Error</html>".data(using: .utf8)!
            return (response, [data], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [exp], timeout: 2.0)
        
        XCTAssertTrue(delegate.didFailCalled)
        XCTAssertEqual(delegate.failedResponse?.statusCode, 200)
        XCTAssertFalse(delegate.didOpenCalled)
    }
    
    func testHttp429RetryAfterHeaderSurfaced() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let exp = expectation(description: "connectionDidFail on HTTP 429")
        delegate.onFail = { exp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 429,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": "text/event-stream",
                    "Retry-After": "45"
                ]
            )!
            return (response, [], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [exp], timeout: 2.0)
        
        XCTAssertTrue(delegate.didFailCalled)
        XCTAssertEqual(delegate.failedResponse?.statusCode, 429)
        XCTAssertEqual(delegate.failedResponse?.allHeaderFields["Retry-After"] as? String, "45")
    }
    
    func testLastEventIdHeaderInjectedOnRequest() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        var capturedRequest: URLRequest?
        let exp = expectation(description: "Request received with Last-Event-ID")
        
        MockURLProtocol.setHandler { request in
            capturedRequest = request
            exp.fulfill()
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            return (response, [], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: "resume-token-999",
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [exp], timeout: 2.0)
        
        XCTAssertEqual(capturedRequest?.value(forHTTPHeaderField: "Last-Event-ID"), "resume-token-999")
    }
    
    func testStopCancelsURLSessionTask() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let openExp = expectation(description: "Open connection")
        delegate.onOpen = { openExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            let chunk = "data: msg1\n\n".data(using: .utf8)!
            return (response, [chunk], 0.2)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        
        wait(for: [openExp], timeout: 2.0)
        source.stop()
        
        // After stop, no fail should be surfaced to delegate as an active error
        XCTAssertFalse(delegate.didFailCalled)
    }
    
    func testBoundedErrorBodyCapturedOnHttpError() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let failExp = expectation(description: "Fail connection with body")
        delegate.onFail = { failExp.fulfill() }
        
        let jsonError = "{\"error\":\"not_found\",\"code\":404}"
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 404,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            let chunk = jsonError.data(using: .utf8)!
            return (response, [chunk], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [failExp], timeout: 2.0)
        
        XCTAssertTrue(delegate.didFailCalled)
        XCTAssertEqual(delegate.failedResponse?.statusCode, 404)
        XCTAssertEqual(delegate.failedErrorBody, jsonError)
    }
    
    func testBoundedErrorBodyTruncatedAt8KB() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let failExp = expectation(description: "Fail connection with truncated body")
        delegate.onFail = { failExp.fulfill() }
        
        let largeBody = String(repeating: "A", count: 16384) // 16KB
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 500,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"]
            )!
            let chunk = largeBody.data(using: .utf8)!
            return (response, [chunk], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [failExp], timeout: 2.0)
        
        XCTAssertTrue(delegate.didFailCalled)
        XCTAssertEqual(delegate.failedResponse?.statusCode, 500)
        XCTAssertEqual(delegate.failedErrorBody?.utf8.count, 8192)
    }

    func testNonEventStreamContentTypeTriggersTerminalFailure() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let failExp = expectation(description: "Fail connection on invalid Content-Type")
        delegate.onFail = { failExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/html; charset=UTF-8"]
            )!
            let chunk = "<html><body>Captive Portal</body></html>".data(using: .utf8)!
            return (response, [chunk], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [failExp], timeout: 2.0)
        
        XCTAssertTrue(delegate.didFailCalled)
        let errorDesc = (delegate.failedError as? NSError)?.localizedDescription ?? ""
        XCTAssertTrue(errorDesc.contains("Invalid Content-Type"))
    }

    func testAcceptEncodingHeaderIsStrippedFromRequest() {
        let config = createTestConfig(headers: ["Accept-Encoding": "gzip, br", "X-Custom": "allowed"])
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        var recordedRequest: URLRequest?
        let openExp = expectation(description: "Open connection")
        delegate.onOpen = { openExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            recordedRequest = request
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            let chunk = "data: ok\n\n".data(using: .utf8)!
            return (response, [chunk], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [openExp], timeout: 2.0)
        
        XCTAssertEqual(recordedRequest?.value(forHTTPHeaderField: "X-Custom"), "allowed")
        XCTAssertNil(recordedRequest?.value(forHTTPHeaderField: "Accept-Encoding"), "Accept-Encoding must be stripped so URLSession handles transparent decompression")
    }

    func testHttp204DispatchesTerminalFailureWithCode204() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let failExp = expectation(description: "Fail connection on HTTP 204")
        delegate.onFail = { failExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 204,
                httpVersion: "HTTP/1.1",
                headerFields: [:]
            )!
            return (response, [], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [failExp], timeout: 2.0)
        
        XCTAssertTrue(delegate.didFailCalled)
        XCTAssertEqual(delegate.failedResponse?.statusCode, 204)
        let errorDesc = (delegate.failedError as? NSError)?.localizedDescription ?? ""
        XCTAssertFalse(errorDesc.contains("Invalid Content-Type"), "HTTP 204 should not be reported as Invalid Content-Type")
        XCTAssertEqual((delegate.failedError as? NSError)?.code, 204)
    }

    func testPermanentRedirect301FollowsRedirect() {
        let config = createTestConfig(url: "http://localhost:33333/old-endpoint")
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let messageExp = expectation(description: "Redirect 301 followed and message received")
        delegate.onMessage = { messageExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            if request.url?.absoluteString == "http://localhost:33333/old-endpoint" {
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 301,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Location": "http://localhost:33333/new-endpoint"]
                )!
                return (response, [], 0.0)
            } else {
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "text/event-stream"]
                )!
                let chunk = "data: redirected_ok\n\n".data(using: .utf8)!
                return (response, [chunk], 0.0)
            }
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [messageExp], timeout: 2.0)
        XCTAssertEqual(delegate.receivedMessages.first?.data, "redirected_ok")
    }

    func testRedirect302FollowsRedirect() {
        let config = createTestConfig(url: "http://localhost:33333/old-302")
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let messageExp = expectation(description: "Redirect 302 followed and message received")
        delegate.onMessage = { messageExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            if request.url?.absoluteString == "http://localhost:33333/old-302" {
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 302,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Location": "http://localhost:33333/new-302-endpoint"]
                )!
                return (response, [], 0.0)
            } else {
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "text/event-stream"]
                )!
                let chunk = "data: redirected_302_ok\n\n".data(using: .utf8)!
                return (response, [chunk], 0.0)
            }
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [messageExp], timeout: 2.0)
        XCTAssertEqual(delegate.receivedMessages.first?.data, "redirected_302_ok")
    }

    func testTemporaryRedirect307FollowsRedirect() {
        let config = createTestConfig(url: "http://localhost:33333/old-307")
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let messageExp = expectation(description: "Redirect 307 followed and message received")
        delegate.onMessage = { messageExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            if request.url?.absoluteString == "http://localhost:33333/old-307" {
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 307,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Location": "http://localhost:33333/new-307-endpoint"]
                )!
                return (response, [], 0.0)
            } else {
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "text/event-stream"]
                )!
                let chunk = "data: redirected_307_ok\n\n".data(using: .utf8)!
                return (response, [chunk], 0.0)
            }
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [messageExp], timeout: 2.0)
        XCTAssertEqual(delegate.receivedMessages.first?.data, "redirected_307_ok")
    }

    func testPermanentRedirect308FollowsRedirect() {
        let config = createTestConfig(url: "http://localhost:33333/old-308")
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let messageExp = expectation(description: "Redirect 308 followed and message received")
        delegate.onMessage = { messageExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            if request.url?.absoluteString == "http://localhost:33333/old-308" {
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 308,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Location": "http://localhost:33333/new-308-endpoint"]
                )!
                return (response, [], 0.0)
            } else {
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "text/event-stream"]
                )!
                let chunk = "data: redirected_308_ok\n\n".data(using: .utf8)!
                return (response, [chunk], 0.0)
            }
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [messageExp], timeout: 2.0)
        XCTAssertEqual(delegate.receivedMessages.first?.data, "redirected_308_ok")
    }

    func testPermissiveContentTypeRejected() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let failExp = expectation(description: "Permissive content-type triggers failure")
        delegate.onFail = { failExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/x-text/event-stream-custom"]
            )!
            return (response, [], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [failExp], timeout: 2.0)
        
        XCTAssertTrue(delegate.didFailCalled)
        XCTAssertFalse(delegate.didOpenCalled)
        let errorDesc = (delegate.failedError as? NSError)?.localizedDescription ?? ""
        XCTAssertTrue(errorDesc.contains("Invalid Content-Type"))
    }

    func testRealSseEventSourceReleasesSessionOnEOFWithoutExplicitStop() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let closeExp = expectation(description: "Connection closes on EOF")
        delegate.onClose = { closeExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            let chunk = "data: done\n\n".data(using: .utf8)!
            return (response, [chunk], 0.0)
        }
        
        weak var weakSource: AnyObject?
        autoreleasepool {
            let source = SseConnectionHandler.createEventSource(
                url: URL(string: config.url)!,
                config: config,
                lastProcessedId: nil,
                delegate: delegate,
                attemptVersion: 1,
                dispatcher: dispatcher,
                protocolClasses: [MockURLProtocol.self]
            )
            weakSource = source
        }
        
        wait(for: [closeExp], timeout: 2.0)
        
        let start = Date()
        while weakSource != nil && Date().timeIntervalSince(start) < 2.0 {
            autoreleasepool {
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
            }
        }
        
        XCTAssertNil(weakSource, "RealSseEventSource must be deallocated after EOF even without calling stop(), avoiding URLSession retain cycle")
    }

    func testIdWithoutDataUpdatesLastEventId() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let idExp = expectation(description: "Last-Event-ID updated")
        delegate.onUpdateLastEventId = { idExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            let chunk = "id: sse-cursor-999\n\n".data(using: .utf8)!
            return (response, [chunk], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [idExp], timeout: 2.0)
        
        XCTAssertTrue(delegate.receivedMessages.isEmpty, "No message should be dispatched when data field is absent")
        XCTAssertEqual(delegate.updatedLastEventIds.last, "sse-cursor-999")
    }

    func testEmptyIdWithoutDataClearsLastEventId() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let idExp = expectation(description: "Last-Event-ID cleared")
        delegate.onUpdateLastEventId = { idExp.fulfill() }
        
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            let chunk = "id:\n\n".data(using: .utf8)!
            return (response, [chunk], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: "old-id",
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [idExp], timeout: 2.0)
        
        XCTAssertTrue(delegate.receivedMessages.isEmpty)
        XCTAssertEqual(delegate.updatedLastEventIds.count, 1)
        XCTAssertNil(delegate.updatedLastEventIds.last!)
    }

    func testNon2xxStreamingErrorBodyCollectedOnEOF() {
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        let source = RealSseEventSource(delegate: delegate, attemptVersion: 1, dispatcher: dispatcher)
        
        let dummySession = URLSession(configuration: .default)
        let dummyTask = dummySession.dataTask(with: URL(string: "http://localhost/events")!)
        defer { dummyTask.cancel() }
        
        let response = HTTPURLResponse(
            url: URL(string: "http://localhost/events")!,
            statusCode: 503,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/plain"]
        )!
        
        var disposition: URLSession.ResponseDisposition?
        source.urlSession(dummySession, dataTask: dummyTask, didReceive: response) { disp in
            disposition = disp
        }
        
        XCTAssertEqual(disposition, .allow, "Non-2xx response must allow body streaming to collect bounded error")
        
        let errorChunk = "{\"error\":\"service_unavailable\"}".data(using: .utf8)!
        source.urlSession(dummySession, dataTask: dummyTask, didReceive: errorChunk)
        
        // Complete stream with EOF
        source.urlSession(dummySession, task: dummyTask, didCompleteWithError: nil)
        
        XCTAssertTrue(delegate.didFailCalled, "Terminal failure must be dispatched upon stream completion")
        XCTAssertEqual(delegate.failedResponse?.statusCode, 503)
        XCTAssertEqual(delegate.failedErrorBody, "{\"error\":\"service_unavailable\"}")
    }

    func testHttp206PartialContentFailsWithoutOpeningStream() {
        let config = createTestConfig()
        let delegate = TestDelegate()
        let dispatcher = MockSseDispatcher()
        
        let failExp = expectation(description: "connectionDidFail called for HTTP 206")
        delegate.onFail = {
            failExp.fulfill()
        }
        
        MockURLProtocol.setHandler { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 206,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            let chunk = "data: partial\n\n".data(using: .utf8)!
            return (response, [chunk], 0.0)
        }
        
        let source = SseConnectionHandler.createEventSource(
            url: URL(string: config.url)!,
            config: config,
            lastProcessedId: nil,
            delegate: delegate,
            attemptVersion: 1,
            dispatcher: dispatcher,
            protocolClasses: [MockURLProtocol.self]
        )
        defer { source.stop() }
        
        wait(for: [failExp], timeout: 2.0)
        
        XCTAssertFalse(delegate.didOpenCalled, "HTTP 206 must NOT open the SSE stream per WHATWG SSE spec")
        XCTAssertTrue(delegate.didFailCalled, "HTTP 206 must fail the connection")
        XCTAssertEqual(delegate.failedResponse?.statusCode, 206)
    }
}

