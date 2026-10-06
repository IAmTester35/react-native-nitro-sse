import Foundation
@testable import NitroSse

/// Test double implementing `SseDispatcher` to allow deterministic unit testing of async and delayed blocks.
/// Supports immediate synchronous execution or manual flushing of queued blocks to eliminate real-time test delays.
public class MockSseDispatcher: SseDispatcher {
    public var underlyingQueue: DispatchQueue? = nil
    
    /// Controls whether async work is executed synchronously inline or captured in pending queues.
    public var executeImmediately: Bool = true
    
    private let lock = NSLock()
    public var pendingBlocks: [() -> Void] = []
    public var pendingDelayedBlocks: [(delay: TimeInterval, block: () -> Void)] = []
    public var onDelayedBlockScheduled: ((TimeInterval) -> Void)?
    
    public init() {}
    
    public func async(_ block: @escaping () -> Void) {
        if executeImmediately {
            block()
        } else {
            lock.lock()
            pendingBlocks.append(block)
            lock.unlock()
        }
    }
    
    private class MockCancellable: SseCancellable {
        var isCancelled = false
        func cancel() {
            isCancelled = true
        }
    }
    
    @discardableResult
    public func asyncAfter(delay: TimeInterval, _ block: @escaping () -> Void) -> SseCancellable? {
        let cancellable = MockCancellable()
        if executeImmediately && delay <= 0.001 {
            block()
        } else {
            lock.lock()
            pendingDelayedBlocks.append((delay: delay, block: {
                if !cancellable.isCancelled {
                    block()
                }
            }))
            let callback = onDelayedBlockScheduled
            lock.unlock()
            callback?(delay)
        }
        return cancellable
    }
    
    public func sync<T>(_ block: () throws -> T) rethrows -> T {
        return try block()
    }
    
    public func isCurrentDispatcher() -> Bool {
        return true
    }
    
    public func assertOnQueue() {
        // Validation skipped for synchronous test double context.
    }
    
    public func executeAllPendingBlocks() {
        lock.lock()
        let blocks = pendingBlocks
        pendingBlocks.removeAll()
        lock.unlock()
        blocks.forEach { $0() }
    }
    
    public func executeDelayedBlocks() {
        lock.lock()
        let delayedBlocks = pendingDelayedBlocks.sorted { $0.delay < $1.delay }
        pendingDelayedBlocks.removeAll()
        lock.unlock()
        delayedBlocks.forEach { $0.block() }
    }
}
