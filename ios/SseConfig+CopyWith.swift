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
        mock: SseMockConfig?? = nil
    ) -> SseConfig {
        let newUrl: String = url ?? self.url
        let newMethod: HttpMethod? = method ?? self.method
        let newHeaders: [String: String]? = headers ?? self.headers
        let newBody: String? = body ?? self.body
        let newBackgroundExecution: Bool? = backgroundExecution ?? self.backgroundExecution
        let newBatchingIntervalMs: Double? = batchingIntervalMs ?? self.batchingIntervalMs
        let newMaxBufferSize: Double? = maxBufferSize ?? self.maxBufferSize
        let newConnectionTimeoutMs: Double? = connectionTimeoutMs ?? self.connectionTimeoutMs
        let newReadTimeoutMs: Double? = readTimeoutMs ?? self.readTimeoutMs
        let newRetryIntervalMs: Double? = retryIntervalMs ?? self.retryIntervalMs
        let newMaxRetryIntervalMs: Double? = maxRetryIntervalMs ?? self.maxRetryIntervalMs
        let newJitterFactor: Double? = jitterFactor ?? self.jitterFactor
        let newMaxReconnectAttempts: Double? = maxReconnectAttempts ?? self.maxReconnectAttempts
        let newMaxAuthRetries: Double? = maxAuthRetries ?? self.maxAuthRetries
        let newAutoParseJSON: Bool? = autoParseJSON ?? self.autoParseJSON
        let newMonitorNetwork: Bool? = monitorNetwork ?? self.monitorNetwork
        let newMock: SseMockConfig? = mock ?? self.mock

        return SseConfig(
            url: newUrl,
            method: newMethod,
            headers: newHeaders,
            body: newBody,
            backgroundExecution: newBackgroundExecution,
            batchingIntervalMs: newBatchingIntervalMs,
            maxBufferSize: newMaxBufferSize,
            connectionTimeoutMs: newConnectionTimeoutMs,
            readTimeoutMs: newReadTimeoutMs,
            retryIntervalMs: newRetryIntervalMs,
            maxRetryIntervalMs: newMaxRetryIntervalMs,
            jitterFactor: newJitterFactor,
            maxReconnectAttempts: newMaxReconnectAttempts,
            maxAuthRetries: newMaxAuthRetries,
            autoParseJSON: newAutoParseJSON,
            monitorNetwork: newMonitorNetwork,
            mock: newMock
        )
    }
}
