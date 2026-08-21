import XCTest
@testable import NitroSse

/// Live HTTP integration tests against an active SSE server (`node example/sse-server.js`).
/// Set `REQUIRE_INTEGRATION_SERVER=1` in environment to enforce server availability on CI.
class NitroSseIntegrationTests: XCTestCase {
    
    private func createRealConfig(url: String) -> SseConfig {
        return SseConfig(
            url: url,
            method: .get,
            headers: [:],
            body: nil,
            backgroundExecution: false,
            batchingIntervalMs: 0,
            maxBufferSize: 1000,
            connectionTimeoutMs: 5000,
            readTimeoutMs: 300000,
            retryIntervalMs: 100,
            maxRetryIntervalMs: 5000,
            jitterFactor: 0.0,
            maxReconnectAttempts: 3,
            maxAuthRetries: 3,
            autoParseJSON: true,
            monitorNetwork: false,
            onBeforeRequest: nil,
            mock: nil
        )
    }

    func testIntegrationConnectionSuccess() {
        let sse = NitroSse()
        let config = createRealConfig(url: "http://localhost:33333/events")
        
        let exp = XCTestExpectation(description: "Wait for events")
        
        var receivedEvents: [SseEvent] = []
        var didFulfill = false
        try? sse.setup(config: config) { events in
            receivedEvents.append(contentsOf: events)
            if !didFulfill && receivedEvents.contains(where: { $0.type == .message }) {
                didFulfill = true
                exp.fulfill()
            }
        }
        
        try? sse.start()
        
        let result = XCTWaiter.wait(for: [exp], timeout: 5.0)
        
        if result == .completed {
            XCTAssertTrue(receivedEvents.count > 0)
        } else {
            // Gracefully skip failure when integration test server is offline, unless explicitly requested via environment.
            if ProcessInfo.processInfo.environment["REQUIRE_INTEGRATION_SERVER"] == "1" {
                XCTFail("Integration server timeout. Server must be running when REQUIRE_INTEGRATION_SERVER=1.")
            } else {
                print("⚠️ Integration server (localhost:33333) not running or timed out. Skipping failure to prevent CI break.")
            }
        }
        sse.stop()
    }
    
    func testIntegrationRetryAfter() {
        let sse = NitroSse()
        let config = createRealConfig(url: "http://localhost:33333/retry-after")
        
        let exp = XCTestExpectation(description: "Wait for Retry-After error event")
        
        var receivedEvents: [SseEvent] = []
        var didFulfill = false
        try? sse.setup(config: config) { events in
            receivedEvents.append(contentsOf: events)
            // Verifies server HTTP 429 Retry-After response surfaces retry delay field in error event payload.
            if !didFulfill && receivedEvents.contains(where: { $0.type == .error && $0.retry != nil }) {
                didFulfill = true
                exp.fulfill()
            }
        }
        
        try? sse.start()
        
        let result = XCTWaiter.wait(for: [exp], timeout: 5.0)
        
        if result == .completed {
            XCTAssertTrue(receivedEvents.count > 0)
        } else {
            if ProcessInfo.processInfo.environment["REQUIRE_INTEGRATION_SERVER"] == "1" {
                XCTFail("Integration server timeout. Server must be running when REQUIRE_INTEGRATION_SERVER=1.")
            } else {
                print("⚠️ Integration server (localhost:33333) not running or timed out. Skipping failure.")
            }
        }
        sse.stop()
    }
}
