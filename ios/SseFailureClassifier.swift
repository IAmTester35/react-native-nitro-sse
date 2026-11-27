import Foundation

internal enum SseFailureDisconnectCategory: Equatable {
    case parserError
    case serverError
    case timeout
    case networkError
}

internal struct SseFailureContext {
    let response: HTTPURLResponse?
    let errorBody: String?
    let nsError: NSError
    let httpStatusCode: Int?
    let reportedStatusCode: Int
    let isTimeout: Bool
    let isParserLimit: Bool
    let isInvalidContentType: Bool
}

internal struct SseFailurePolicyInput {
    let hasInterceptor: Bool
    let nextAuthAttempt: Int
    let maxAuthRetries: Int
    let maxRetryIntervalSeconds: TimeInterval
    let retryAfterJitterSeconds: TimeInterval

    init(
        hasInterceptor: Bool,
        nextAuthAttempt: Int,
        maxAuthRetries: Int,
        maxRetryIntervalSeconds: TimeInterval,
        retryAfterJitterSeconds: TimeInterval = Double.random(in: 0.5...1.5)
    ) {
        self.hasInterceptor = hasInterceptor
        self.nextAuthAttempt = nextAuthAttempt
        self.maxAuthRetries = maxAuthRetries
        self.maxRetryIntervalSeconds = maxRetryIntervalSeconds
        self.retryAfterJitterSeconds = retryAfterJitterSeconds
    }
}

internal enum SseFailureDecision: Equatable {
    case failAndStop(message: String, statusCode: Double?)
    case authLimitReached(message: String, statusCode: Double)
    case authRetry(message: String, statusCode: Double)
    case retryAfter(message: String, statusCode: Double, delaySeconds: TimeInterval)
    case rateLimitBackoff(message: String, statusCode: Double)
    case transientRetry(message: String, statusCode: Double, markStale: Bool)
}

/// Pure classifier translating transport, parser, and HTTP errors into disconnection metrics and retry decisions.
internal enum SseFailureClassifier {
    static func isEventStreamMimeType(_ contentType: String) -> Bool {
        let rawMime = contentType.split(separator: ";").first
        let mimeType = rawMime?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        return mimeType == "text/event-stream"
    }

    static func resolveHttpStatusCode(response: HTTPURLResponse?, nsError: NSError) -> Int? {
        // Decouple HTTP status code (meaningful only for HTTP 4xx/5xx/204) from transport and parser error codes
        if let resp = response, resp.statusCode >= 400 || resp.statusCode == 204 {
            return resp.statusCode
        }
        if nsError.code >= 100 && nsError.code < 600 {
            return nsError.code
        }
        return nil
    }

    static func isInvalidEventStreamContentType(response: HTTPURLResponse?, nsError: NSError) -> Bool {
        if nsError.domain == "NitroSse" && nsError.code == -2001 {
            return true
        }
        guard let resp = response, (200..<300).contains(resp.statusCode) else {
            return false
        }
        let rawContentType = resp.value(forHTTPHeaderField: "Content-Type") ??
            (resp.allHeaderFields["Content-Type"] as? String) ?? ""
        return !isEventStreamMimeType(rawContentType)
    }

    static func buildContext(
        error: Error,
        response: HTTPURLResponse?,
        errorBody: String?
    ) -> SseFailureContext {
        let nsError = error as NSError
        let httpStatusCode = resolveHttpStatusCode(response: response, nsError: nsError)
        return SseFailureContext(
            response: response,
            errorBody: errorBody,
            nsError: nsError,
            httpStatusCode: httpStatusCode,
            reportedStatusCode: httpStatusCode ?? nsError.code,
            isTimeout: nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut,
            isParserLimit: nsError.domain == "NitroSse" && (nsError.code == -2002 || nsError.code == -2003),
            isInvalidContentType: isInvalidEventStreamContentType(response: response, nsError: nsError)
        )
    }

    static func disconnectCategory(
        for context: SseFailureContext,
        hasAttemptParseError: Bool
    ) -> SseFailureDisconnectCategory {
        if context.isParserLimit || hasAttemptParseError {
            return .parserError
        }
        if context.isInvalidContentType ||
            context.httpStatusCode == 204 ||
            (context.httpStatusCode ?? 0) >= 400 {
            return .serverError
        }
        if context.isTimeout {
            return .timeout
        }
        return .networkError
    }

    static func errorCodeString(for context: SseFailureContext) -> String {
        let codeValue = context.httpStatusCode ?? context.nsError.code
        return "\(context.nsError.domain)(\(codeValue))"
    }

    static func classify(context: SseFailureContext, policy: SseFailurePolicyInput) -> SseFailureDecision {
        if let terminal = classifyTerminal(context) {
            return terminal
        }
        if let auth = classifyAuth(httpStatusCode: context.httpStatusCode, policy: policy) {
            return auth
        }
        if let rateLimit = classifyRetryAfterOrRateLimit(context: context, policy: policy) {
            return rateLimit
        }
        return .transientRetry(
            message: buildDefaultErrorMessage(context),
            statusCode: Double(context.reportedStatusCode),
            markStale: context.isTimeout
        )
    }

    private static func classifyTerminal(_ context: SseFailureContext) -> SseFailureDecision? {
        // WHATWG EventSource Section 7: HTTP 204 No Content explicitly terminates stream across platforms.
        if context.httpStatusCode == 204 {
            return .failAndStop(message: "No Content (204). Stopping.", statusCode: 204)
        }
        if context.isInvalidContentType {
            return .failAndStop(
                message: "Invalid Content-Type: expected text/event-stream. Stopping.",
                statusCode: Double(context.reportedStatusCode)
            )
        }
        if context.isParserLimit {
            return .failAndStop(
                message: context.nsError.localizedDescription,
                statusCode: Double(context.reportedStatusCode)
            )
        }
        if let fatalHttp = context.httpStatusCode,
           (400...499).contains(fatalHttp),
           ![401, 403, 408, 429].contains(fatalHttp) {
            let trimmedBody = context.errorBody?.trimmingCharacters(in: .whitespacesAndNewlines)
            let fatalMessage = (trimmedBody?.isEmpty == false)
                ? "Fatal Error (\(fatalHttp)): \(trimmedBody!)"
                : "Fatal Error (\(fatalHttp)). Stopping."
            return .failAndStop(message: fatalMessage, statusCode: Double(fatalHttp))
        }
        return nil
    }

    private static func classifyAuth(
        httpStatusCode: Int?,
        policy: SseFailurePolicyInput
    ) -> SseFailureDecision? {
        // HTTP 401/403 Auth errors trigger token refresh via onBeforeRequest interceptor up to maxAuthRetries.
        guard let http = httpStatusCode, http == 401 || http == 403 else {
            return nil
        }
        if !policy.hasInterceptor {
            return .failAndStop(
                message: "Auth Error (\(http)) - No interceptor provided. Stopping.",
                statusCode: Double(http)
            )
        }
        if policy.nextAuthAttempt > policy.maxAuthRetries {
            return .authLimitReached(
                message: "Auth Error (\(http)) - Retry limit reached (\(policy.maxAuthRetries)). Stopping.",
                statusCode: Double(http)
            )
        }
        return .authRetry(
            message: "Auth Error (\(http)) - Retry \(policy.nextAuthAttempt)/\(policy.maxAuthRetries). " +
                "Refreshing token...",
            statusCode: Double(http)
        )
    }

    private static func classifyRetryAfterOrRateLimit(
        context: SseFailureContext,
        policy: SseFailurePolicyInput
    ) -> SseFailureDecision? {
        // HTTP 429/503: Honor server Retry-After delay with randomized jitter to prevent thundering herd.
        let retryAfterSeconds = context.response.flatMap { SseReconnectStrategy.extractRetryAfterSeconds(from: $0) }
        if let http = context.httpStatusCode, http == 429 || http == 503, let retryAfter = retryAfterSeconds {
            let boundedRetryAfter = max(0.0, min(retryAfter, policy.maxRetryIntervalSeconds))
            let totalDelay = max(1.0, boundedRetryAfter + policy.retryAfterJitterSeconds)
            return .retryAfter(
                message: "Retry-After received: \(Int(totalDelay))s",
                statusCode: Double(http),
                delaySeconds: totalDelay
            )
        }
        // HTTP 429 without Retry-After: Fallback to exponential backoff as rate limits are recoverable.
        if context.httpStatusCode == 429 {
            return .rateLimitBackoff(
                message: "Rate Limited (429). Retrying with backoff...",
                statusCode: 429
            )
        }
        return nil
    }

    private static func buildDefaultErrorMessage(_ context: SseFailureContext) -> String {
        if let http = context.httpStatusCode,
           http >= 500,
           let bodyText = context.errorBody?.trimmingCharacters(in: .whitespacesAndNewlines),
           !bodyText.isEmpty {
            return "Server Error (\(http)): \(bodyText)"
        }
        return context.nsError.localizedDescription
    }
}
