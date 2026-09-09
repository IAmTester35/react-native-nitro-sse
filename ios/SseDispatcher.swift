import Foundation

/// Token representing a scheduled asynchronous delayed work item that can be cancelled.
protocol SseCancellable: AnyObject {
    func cancel()
}

/// Abstraction layer for serializing operations and scheduling timers across production and test environments.
/// Enables deterministic synchronous control in unit tests (`MockSseDispatcher`) without real-time wait delays.
protocol SseDispatcher: AnyObject {
    func async(_ block: @escaping () -> Void)
    @discardableResult
    func asyncAfter(delay: TimeInterval, _ block: @escaping () -> Void) -> SseCancellable?
    func sync<T>(_ block: () throws -> T) rethrows -> T
    
    /// Checks whether the caller is running on the dispatcher's execution context to avoid re-entrant deadlocks on `sync`.
    func isCurrentDispatcher() -> Bool
    
    /// Asserts execution context during debug builds to verify thread safety invariants.
    func assertOnQueue()
    
    /// Underlying `DispatchQueue` required by system frameworks (e.g. `NWPathMonitor`).
    var underlyingQueue: DispatchQueue? { get }
}
