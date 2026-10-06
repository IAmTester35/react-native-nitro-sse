import Foundation

/// Calculates backoff delays using randomized full jitter exponential backoff.
/// Custom implementation guarantees cross-platform parity with Android and enforces maxReconnectAttempts.
class SseReconnectStrategy {
    private var backoffCounter: Int = 0
    private var currentReconnectAttempts: Int = 0
    
    private var retryInterval: TimeInterval = 1.0
    private var maxRetryInterval: TimeInterval = 30.0
    private var jitterFactor: Double = 0.5
    private var maxReconnectAttempts: Int = -1  // -1 represents unlimited reconnection attempts.
    
    /// Configures reconnection parameters.
    func configure(
        retryIntervalMs: Double?,
        maxRetryIntervalMs: Double?,
        jitterFactor: Double?,
        maxReconnectAttempts: Double?
    ) {
        if let retry = retryIntervalMs, retry.isFinite, retry >= 0 {
            self.retryInterval = retry / 1000.0
        } else {
            self.retryInterval = 1.0
        }
        
        if let maxRetry = maxRetryIntervalMs, maxRetry.isFinite, maxRetry >= 0 {
            self.maxRetryInterval = maxRetry / 1000.0
        } else {
            self.maxRetryInterval = 30.0
        }
        
        if let jitter = jitterFactor, jitter.isFinite {
            self.jitterFactor = min(max(0.0, jitter), 1.0)
        } else {
            self.jitterFactor = 0.5
        }
        
        if let maxAttempts = maxReconnectAttempts, maxAttempts.isFinite, maxAttempts >= 0 {
            if maxAttempts >= Double(Int.max) {
                self.maxReconnectAttempts = Int.max
            } else {
                self.maxReconnectAttempts = Int(maxAttempts)
            }
        } else {
            self.maxReconnectAttempts = -1
        }
    }
    
    /// Checks if maximum reconnection attempts threshold has been reached.
    func hasReachedMaxAttempts() -> Bool {
        guard maxReconnectAttempts != -1 else { return false }
        return currentReconnectAttempts >= maxReconnectAttempts
    }

    /// Records an explicit reconnection attempt without altering the backoff exponent.
    func recordAttempt() {
        currentReconnectAttempts += 1
    }
    
    /// Calculates the next reconnection delay in seconds (enforcing a minimum 1.0s floor).
    /// Exponential backoff is applied for errors (`isError == true`), while normal disconnects use the base interval with jitter.
    func nextDelay(isError: Bool) -> TimeInterval {
        currentReconnectAttempts += 1
        
        let delay: TimeInterval
        if isError {
            let exponent = Double(backoffCounter)
            let base = min(retryInterval * pow(2.0, exponent), maxRetryInterval)
            backoffCounter += 1
            delay = base * (1.0 - jitterFactor + Double.random(in: 0...(2 * jitterFactor)))
        } else {
            delay = retryInterval * (1.0 - jitterFactor + Double.random(in: 0...(2 * jitterFactor)))
        }
        
        return max(delay, 1.0)
    }
    
    /// Resets attempt count and backoff exponent after a successful connection open.
    func reset() {
        backoffCounter = 0
        currentReconnectAttempts = 0
    }
    
    /// Updates base retry interval when server sends a 'retry: <ms>' directive.
    func updateRetryInterval(_ retryMs: Double) {
        if retryMs.isFinite && retryMs >= 0 {
            self.retryInterval = retryMs / 1000.0
        }
    }

    /// Parses `Retry-After` HTTP headers per RFC 7231 (integer seconds or RFC 1123 date).
    static func extractRetryAfterSeconds(from response: HTTPURLResponse) -> TimeInterval? {
        guard let retryAfterHeader = response.value(forHTTPHeaderField: "Retry-After") ?? (response.allHeaderFields["Retry-After"] as? String) else { return nil }
        return parseRetryAfterHeader(retryAfterHeader)
    }

    /// Parses `Retry-After` HTTP headers per RFC 7231 (integer seconds or RFC 1123 date) from NSError userInfo.
    static func extractRetryAfterSeconds(from error: Error) -> TimeInterval? {
        let nsError = error as NSError
        if let response = nsError.userInfo["response"] as? HTTPURLResponse {
            return extractRetryAfterSeconds(from: response)
        }
        return nil
    }

    private static func parseRetryAfterHeader(_ retryAfterHeader: String) -> TimeInterval? {
        let trimmed = retryAfterHeader.trimmingCharacters(in: .whitespaces)
        // RFC 7231 Section 7.1.3: delay-seconds is a sequence of 1*DIGIT (ASCII digits only)
        if !trimmed.isEmpty && trimmed.allSatisfy({ $0.isASCII && $0.isNumber }), let seconds = Double(trimmed) {
            return seconds
        }
        
        let rfc1123Formatter = DateFormatter()
        rfc1123Formatter.locale = Locale(identifier: "en_US_POSIX")
        rfc1123Formatter.timeZone = TimeZone(secondsFromGMT: 0)
        rfc1123Formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
        if let date = rfc1123Formatter.date(from: trimmed) {
            let timeUntilDate = date.timeIntervalSinceNow
            return max(0.0, timeUntilDate)
        }
        return nil
    }
}
