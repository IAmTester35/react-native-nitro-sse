import Foundation
@testable import NitroSse

/// Test double implementing `SseDispatcher` to allow deterministic unit testing of async and delayed blocks.
/// Supports immediate synchronous execution or manual flushing of queued blocks to eliminate real-time test delays.
public class MockSseDispatcher: SseDispatcher {
    public var underlyingQueue: DispatchQueue? = nil
    
    /// Controls whether async work is executed synchronously inline or captured in pending queues.
    public var executeImmediately: Bool = true
    
    public var pendingBlocks: [() -> Void] = []
    public var pendingDelayedBlocks: [(delay: TimeInterval, block: () -> Void)] = []
    
    public init() {}
    
    public func async(_ block: @escaping () -> Void) {
        if executeImmediately {
            block()
        } else {
            pendingBlocks.append(block)
        }
    }
    
    public func asyncAfter(delay: TimeInterval, _ block: @escaping () -> Void) {
        if executeImmediately && delay <= 0.001 {
            block()
        } else {
            pendingDelayedBlocks.append((delay: delay, block: block))
        }
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
        let blocks = pendingBlocks
        pendingBlocks.removeAll()
        blocks.forEach { $0() }
    }
    
    public func executeDelayedBlocks() {
        let delayedBlocks = pendingDelayedBlocks.sorted { $0.delay < $1.delay }
        pendingDelayedBlocks.removeAll()
        delayedBlocks.forEach { $0.block() }
    }
}
