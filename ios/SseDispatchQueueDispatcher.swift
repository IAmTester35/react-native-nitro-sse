import Foundation

/// Production implementation of `SseDispatcher` wrapping a GCD `DispatchQueue`.
class SseDispatchQueueDispatcher: SseDispatcher {
    let queue: DispatchQueue
    var underlyingQueue: DispatchQueue? { queue }
    private let queueKey: DispatchSpecificKey<Void>
    
    init(queue: DispatchQueue, queueKey: DispatchSpecificKey<Void>) {
        self.queue = queue
        self.queueKey = queueKey
    }
    
    func async(_ block: @escaping () -> Void) {
        queue.async(execute: block)
    }
    
    private class WorkItemCancellable: SseCancellable {
        private let item: DispatchWorkItem
        init(item: DispatchWorkItem) {
            self.item = item
        }
        func cancel() {
            item.cancel()
        }
    }
    
    @discardableResult
    func asyncAfter(delay: TimeInterval, _ block: @escaping () -> Void) -> SseCancellable? {
        let workItem = DispatchWorkItem(block: block)
        queue.asyncAfter(deadline: .now() + delay, execute: workItem)
        return WorkItemCancellable(item: workItem)
    }
    
    /// Executes block inline if already running on queue to avoid re-entrant deadlocks.
    func sync<T>(_ block: () throws -> T) rethrows -> T {
        if isCurrentDispatcher() {
            return try block()
        } else {
            return try queue.sync(execute: block)
        }
    }
    
    func isCurrentDispatcher() -> Bool {
        return DispatchQueue.getSpecific(key: queueKey) != nil
    }
    
    func assertOnQueue() {
        dispatchPrecondition(condition: .onQueue(queue))
    }
}
