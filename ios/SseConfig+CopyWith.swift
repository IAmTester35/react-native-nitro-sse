import Foundation
import NitroModules

extension SseConfig {
    /// Creates an immutable copy of `SseConfig`, allowing field-level updates while preserving unchanged properties.
    /// Used when mutating connection headers or retry parameters across async operations.
    func copyWith(
        url: String? = nil,
        method: HttpMethod?? = nil,
        headers: [String: String]?? = nil,
        body: String?? = nil,
        backgroundExecution: Bool?? = nil,
        batchingIntervalMs: Double?? = nil,
        maxBufferSize: Double?? = nil,
        connectionTimeoutMs: Double?? = nil,
        readTimeoutMs: Double?? = nil,
        retryIntervalMs: Double?? = nil,
        maxRetryIntervalMs: Double?? = nil,
        jitterFactor: Double?? = nil,
        maxReconnectAttempts: Double?? = nil,
        maxAuthRetries: Double?? = nil,
        autoParseJSON: Bool?? = nil,
        monitorNetwork: Bool?? = nil,
        onBeforeRequest: (() -> Promise<Promise<Dictionary<String, String>>>)?? = nil,
        mock: SseMockConfig?? = nil
    ) -> SseConfig {
        return SseConfig(
            url: url ?? self.url,
            method: method ?? self.method,
            headers: headers ?? self.headers,
            body: body ?? self.body,
            backgroundExecution: backgroundExecution ?? self.backgroundExecution,
            batchingIntervalMs: batchingIntervalMs ?? self.batchingIntervalMs,
            maxBufferSize: maxBufferSize ?? self.maxBufferSize,
            connectionTimeoutMs: connectionTimeoutMs ?? self.connectionTimeoutMs,
            readTimeoutMs: readTimeoutMs ?? self.readTimeoutMs,
            retryIntervalMs: retryIntervalMs ?? self.retryIntervalMs,
            maxRetryIntervalMs: maxRetryIntervalMs ?? self.maxRetryIntervalMs,
            jitterFactor: jitterFactor ?? self.jitterFactor,
            maxReconnectAttempts: maxReconnectAttempts ?? self.maxReconnectAttempts,
            maxAuthRetries: maxAuthRetries ?? self.maxAuthRetries,
            autoParseJSON: autoParseJSON ?? self.autoParseJSON,
            monitorNetwork: monitorNetwork ?? self.monitorNetwork,
            onBeforeRequest: onBeforeRequest ?? self.onBeforeRequest,
            mock: mock ?? self.mock
        )
    }
}
