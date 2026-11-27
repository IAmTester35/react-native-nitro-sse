import XCTest
@testable import NitroSse

final class SseFailureClassifierTests: XCTestCase {
    private let testURL = URL(string: "http://localhost:33333/events")!

    private func makeHttpResponse(
        statusCode: Int,
        headers: [String: String]? = nil
    ) -> HTTPURLResponse {
        return HTTPURLResponse(
            url: testURL,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
    }

    func testIsEventStreamMimeTypeMatchesExactMimeAndRejectsSpoofedTypes() {
        XCTAssertTrue(SseFailureClassifier.isEventStreamMimeType("text/event-stream"))
        XCTAssertTrue(SseFailureClassifier.isEventStreamMimeType("TEXT/EVENT-STREAM; charset=utf-8"))
        XCTAssertTrue(SseFailureClassifier.isEventStreamMimeType("  text/event-stream ; charset=utf-8 "))

        XCTAssertFalse(SseFailureClassifier.isEventStreamMimeType(""))
        XCTAssertFalse(SseFailureClassifier.isEventStreamMimeType("application/json"))
        XCTAssertFalse(SseFailureClassifier.isEventStreamMimeType("application/text/event-stream"))
        XCTAssertFalse(SseFailureClassifier.isEventStreamMimeType("text/event-stream-v2"))
    }

    func testResolveHttpStatusCodeDecouplesTransportErrorsFromHttpStatus() {
        let transportError = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut, userInfo: nil)
        XCTAssertNil(SseFailureClassifier.resolveHttpStatusCode(response: nil, nsError: transportError))

        let okResponse = makeHttpResponse(statusCode: 200)
        XCTAssertNil(SseFailureClassifier.resolveHttpStatusCode(response: okResponse, nsError: transportError))

        let noContentResponse = makeHttpResponse(statusCode: 204)
        XCTAssertEqual(
            SseFailureClassifier.resolveHttpStatusCode(response: noContentResponse, nsError: transportError),
            204
        )

        let errorWithHttpCode = NSError(domain: "NitroSse", code: 503, userInfo: nil)
        XCTAssertEqual(SseFailureClassifier.resolveHttpStatusCode(response: nil, nsError: errorWithHttpCode), 503)
    }

    func testDisconnectReasonClassification() {
        let parserErr = NSError(domain: "NitroSse", code: -2002, userInfo: nil)
        let parserCtx = SseFailureClassifier.buildContext(error: parserErr, response: nil, errorBody: nil)
        XCTAssertEqual(
            SseFailureClassifier.disconnectCategory(for: parserCtx, hasAttemptParseError: false),
            .parserError
        )

        let timeoutErr = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut, userInfo: nil)
        let timeoutCtx = SseFailureClassifier.buildContext(error: timeoutErr, response: nil, errorBody: nil)
        XCTAssertEqual(
            SseFailureClassifier.disconnectCategory(for: timeoutCtx, hasAttemptParseError: false),
            .timeout
        )
        XCTAssertEqual(
            SseFailureClassifier.disconnectCategory(for: timeoutCtx, hasAttemptParseError: true),
            .parserError
        )

        let badContentTypeResp = makeHttpResponse(statusCode: 200, headers: ["Content-Type": "application/json"])
        let badMimeCtx = SseFailureClassifier.buildContext(error: timeoutErr, response: badContentTypeResp, errorBody: nil)
        XCTAssertEqual(
            SseFailureClassifier.disconnectCategory(for: badMimeCtx, hasAttemptParseError: false),
            .serverError
        )

        let netErr = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost, userInfo: nil)
        let netCtx = SseFailureClassifier.buildContext(error: netErr, response: nil, errorBody: nil)
        XCTAssertEqual(
            SseFailureClassifier.disconnectCategory(for: netCtx, hasAttemptParseError: false),
            .networkError
        )
    }

    func testClassifyTerminalFailures() {
        let defaultPolicy = SseFailurePolicyInput(
            hasInterceptor: false,
            nextAuthAttempt: 1,
            maxAuthRetries: 3,
            maxRetryIntervalSeconds: 30.0,
            retryAfterJitterSeconds: 1.0
        )

        // 204 No Content
        let resp204 = makeHttpResponse(statusCode: 204)
        let err204 = NSError(domain: "NitroSse", code: 204, userInfo: nil)
        let ctx204 = SseFailureClassifier.buildContext(error: err204, response: resp204, errorBody: nil)
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctx204, policy: defaultPolicy),
            .failAndStop(message: "No Content (204). Stopping.", statusCode: 204)
        )

        // Invalid Content-Type (-2001)
        let errMime = NSError(domain: "NitroSse", code: -2001, userInfo: nil)
        let respMime = makeHttpResponse(statusCode: 200, headers: ["Content-Type": "text/plain"])
        let ctxMime = SseFailureClassifier.buildContext(error: errMime, response: respMime, errorBody: nil)
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctxMime, policy: defaultPolicy),
            .failAndStop(message: "Invalid Content-Type: expected text/event-stream. Stopping.", statusCode: -2001)
        )

        // Parser Limit (-2003)
        let errLimit = NSError(
            domain: "NitroSse",
            code: -2003,
            userInfo: [NSLocalizedDescriptionKey: "SSE event data exceeded limit"]
        )
        let ctxLimit = SseFailureClassifier.buildContext(error: errLimit, response: nil, errorBody: nil)
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctxLimit, policy: defaultPolicy),
            .failAndStop(message: "SSE event data exceeded limit", statusCode: -2003)
        )

        // Fatal 400 with body
        let resp400 = makeHttpResponse(statusCode: 400)
        let err400 = NSError(domain: "NitroSse", code: 400, userInfo: nil)
        let ctx400 = SseFailureClassifier.buildContext(error: err400, response: resp400, errorBody: "  Bad Request  ")
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctx400, policy: defaultPolicy),
            .failAndStop(message: "Fatal Error (400): Bad Request", statusCode: 400)
        )
    }

    func testClassifyAuthDecisions() {
        let resp401 = makeHttpResponse(statusCode: 401)
        let err401 = NSError(domain: "NitroSse", code: 401, userInfo: nil)
        let ctx401 = SseFailureClassifier.buildContext(error: err401, response: resp401, errorBody: nil)

        let noInterceptorPolicy = SseFailurePolicyInput(
            hasInterceptor: false,
            nextAuthAttempt: 1,
            maxAuthRetries: 3,
            maxRetryIntervalSeconds: 30.0
        )
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctx401, policy: noInterceptorPolicy),
            .failAndStop(message: "Auth Error (401) - No interceptor provided. Stopping.", statusCode: 401)
        )

        let retryPolicy = SseFailurePolicyInput(
            hasInterceptor: true,
            nextAuthAttempt: 2,
            maxAuthRetries: 3,
            maxRetryIntervalSeconds: 30.0
        )
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctx401, policy: retryPolicy),
            .authRetry(message: "Auth Error (401) - Retry 2/3. Refreshing token...", statusCode: 401)
        )

        let exhaustedPolicy = SseFailurePolicyInput(
            hasInterceptor: true,
            nextAuthAttempt: 4,
            maxAuthRetries: 3,
            maxRetryIntervalSeconds: 30.0
        )
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctx401, policy: exhaustedPolicy),
            .authLimitReached(message: "Auth Error (401) - Retry limit reached (3). Stopping.", statusCode: 401)
        )
    }

    func testClassifyRetryAfterRateLimitAndTransientErrors() {
        let policy = SseFailurePolicyInput(
            hasInterceptor: false,
            nextAuthAttempt: 1,
            maxAuthRetries: 3,
            maxRetryIntervalSeconds: 10.0,
            retryAfterJitterSeconds: 1.0
        )

        // 503 with Retry-After clamped to maxRetryIntervalSeconds (10.0) + jitter (1.0) = 11.0s
        let resp503 = makeHttpResponse(statusCode: 503, headers: ["Retry-After": "60"])
        let err503 = NSError(domain: "NitroSse", code: 503, userInfo: nil)
        let ctx503 = SseFailureClassifier.buildContext(error: err503, response: resp503, errorBody: nil)
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctx503, policy: policy),
            .retryAfter(message: "Retry-After received: 11s", statusCode: 503, delaySeconds: 11.0)
        )

        // 429 without Retry-After falls back to exponential backoff
        let resp429 = makeHttpResponse(statusCode: 429)
        let err429 = NSError(domain: "NitroSse", code: 429, userInfo: nil)
        let ctx429 = SseFailureClassifier.buildContext(error: err429, response: resp429, errorBody: nil)
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctx429, policy: policy),
            .rateLimitBackoff(message: "Rate Limited (429). Retrying with backoff...", statusCode: 429)
        )

        // 500 with error body
        let resp500 = makeHttpResponse(statusCode: 500)
        let err500 = NSError(domain: "NitroSse", code: 500, userInfo: nil)
        let ctx500 = SseFailureClassifier.buildContext(error: err500, response: resp500, errorBody: " Gateway down ")
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctx500, policy: policy),
            .transientRetry(message: "Server Error (500): Gateway down", statusCode: 500, markStale: false)
        )

        // Timeout triggers stale state
        let errTimeout = NSError(
            domain: NSURLErrorDomain,
            code: NSURLErrorTimedOut,
            userInfo: [NSLocalizedDescriptionKey: "Timed out"]
        )
        let ctxTimeout = SseFailureClassifier.buildContext(error: errTimeout, response: nil, errorBody: nil)
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctxTimeout, policy: policy),
            .transientRetry(
                message: "Timed out",
                statusCode: Double(NSURLErrorTimedOut),
                markStale: true
            )
        )

        // Retry-After: 0 with 0.5s jitter must still respect 1.0s minimum floor
        let zeroJitterPolicy = SseFailurePolicyInput(
            hasInterceptor: false,
            nextAuthAttempt: 1,
            maxAuthRetries: 3,
            maxRetryIntervalSeconds: 10.0,
            retryAfterJitterSeconds: 0.5
        )
        let resp429Zero = makeHttpResponse(statusCode: 429, headers: ["Retry-After": "0"])
        let ctx429Zero = SseFailureClassifier.buildContext(
            error: NSError(domain: "NitroSse", code: 429, userInfo: nil),
            response: resp429Zero,
            errorBody: nil
        )
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctx429Zero, policy: zeroJitterPolicy),
            .retryAfter(message: "Retry-After received: 1s", statusCode: 429, delaySeconds: 1.0)
        )

        // Large 400/500 body is truncated to 256 chars in message preview
        let longBody = String(repeating: "A", count: 400)
        let ctxLong400 = SseFailureClassifier.buildContext(
            error: NSError(domain: "NitroSse", code: 400, userInfo: nil),
            response: makeHttpResponse(statusCode: 400),
            errorBody: longBody
        )
        XCTAssertEqual(
            SseFailureClassifier.classify(context: ctxLong400, policy: policy),
            .failAndStop(message: "Fatal Error (400): " + String(repeating: "A", count: 256) + "…", statusCode: 400)
        )
    }
}
