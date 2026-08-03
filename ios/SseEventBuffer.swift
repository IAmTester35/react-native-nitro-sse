import Foundation
import NitroModules

/// Buffers incoming SSE events to batch bridge dispatches to JavaScript, reducing JSI overhead.
/// All mutating operations must be synchronized on the associated `SseDispatcher`.
class SseEventBuffer {
    private var eventBuffer: [SseEvent] = []
    private var isFlushPending: Bool = false
    private var onFlush: ((_ events: [SseEvent]) -> Void)?
    
    private var batchingIntervalMs: Double = 0
    private var maxBufferSize: Int = 1000
    private weak var dispatcher: SseDispatcher?
    
    /// Initializes buffer batching thresholds and dispatch target.
    func configure(
        batchingIntervalMs: Double,
        maxBufferSize: Double,
        dispatcher: SseDispatcher,
        onFlush: @escaping (_ events: [SseEvent]) -> Void
    ) {
        self.batchingIntervalMs = batchingIntervalMs
        self.maxBufferSize = Int(maxBufferSize)
        self.dispatcher = dispatcher
        self.onFlush = onFlush
    }
    
    /// Appends an event to the queue. Triggers immediate flush if buffer capacity is reached or batching is disabled (interval <= 0).
    func push(_ event: SseEvent) {
        dispatcher?.assertOnQueue()
        eventBuffer.append(event)
        
        if eventBuffer.count >= maxBufferSize || batchingIntervalMs <= 0 {
            flush()
        } else if !isFlushPending, let dispatcher = dispatcher {
            isFlushPending = true
            dispatcher.asyncAfter(delay: batchingIntervalMs / 1000.0) { [weak self] in
                self?.flush()
            }
        }
    }
    
    /// Flushes all pending buffered events to JavaScript.
    func flush() {
        dispatcher?.assertOnQueue()
        guard !eventBuffer.isEmpty else { return }
        
        let batch = eventBuffer
        eventBuffer.removeAll()
        isFlushPending = false
        
        onFlush?(batch)
    }
    
    /// Clears buffered events without invoking the flush callback.
    /// Used during teardown to avoid executing JS callbacks after the bridge runtime is destroyed.
    func clear() {
        eventBuffer.removeAll()
        isFlushPending = false
    }
    
    /// Converts a raw JSON payload string into a Nitro `AnyMap`.
    /// Returns `nil` if payload is not a valid JSON dictionary required by `AnyMap`.
    static func parseJsonToAnyMap(_ data: String) -> AnyMap? {
        guard let jsonData = data.data(using: .utf8) else { return nil }
        do {
            if let dictionary = try JSONSerialization.jsonObject(with: jsonData, options: []) as? [String: Any?] {
                return AnyMap.fromDictionaryIgnoreIncompatible(dictionary)
            }
        } catch {
            print("[NitroSse] Failed to parse JSON: \(error.localizedDescription)")
        }
        return nil
    }
}
