import Foundation
import Network

/// Wraps `NWPathMonitor` to observe system network interface transitions (cellular, Wi-Fi, Ethernet).
/// Emits path updates to the caller on the specified `SseDispatcher`.
class SseNetworkMonitor {
    typealias NetworkChangeHandler = (
        _ isSatisfied: Bool,
        _ interfaceChanged: Bool,
        _ interfaceType: NWInterface.InterfaceType?
    ) -> Void
    
    private var pathMonitor: NWPathMonitor?
    private var lastPathInterface: NWInterface.InterfaceType?
    private var monitorGeneration = 0
    private let dispatcher: SseDispatcher
    private let queue: DispatchQueue
    private let onChange: NetworkChangeHandler
    
    init(dispatcher: SseDispatcher, onChange: @escaping NetworkChangeHandler) {
        self.dispatcher = dispatcher
        // NWPathMonitor strictly requires a DispatchQueue instance for path callbacks.
        self.queue = dispatcher.underlyingQueue ?? DispatchQueue(label: "com.nitrosse.networkmonitor.fallback")
        self.onChange = onChange
    }
    
    /// Starts observing system network changes. Idempotent call.
    func start() {
        guard pathMonitor == nil else { return }
        
        monitorGeneration += 1
        let generation = monitorGeneration
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            self?.dispatcher.async { [weak self] in
                guard let self = self, self.monitorGeneration == generation else { return }
                self.handlePathUpdate(path)
            }
        }
        self.pathMonitor = monitor
        monitor.start(queue: queue)
    }
    
    /// Cancels active path monitoring and releases resources.
    func stop() {
        monitorGeneration += 1
        pathMonitor?.cancel()
        pathMonitor = nil
        lastPathInterface = nil
    }
    
    private func handlePathUpdate(_ path: NWPath) {
        let isSatisfied = path.status == .satisfied
        
        var interfaceType: NWInterface.InterfaceType? = nil
        if path.usesInterfaceType(.wifi) {
            interfaceType = .wifi
        } else if path.usesInterfaceType(.cellular) {
            interfaceType = .cellular
        } else if path.usesInterfaceType(.wiredEthernet) {
            interfaceType = .wiredEthernet
        } else {
            interfaceType = path.availableInterfaces.first?.type
        }
        
        print("[NitroSse] Network path changed: status=\(path.status), interface=\(String(describing: interfaceType))")
        
        // Only trigger an interface change if both the previous and current interfaces are known and differ.
        // Initial detection (lastPathInterface == nil) must NOT be flagged as an interface change to avoid
        // falsely triggering an immediate stream restart right after connection startup.
        let interfaceChanged: Bool
        if isSatisfied {
            if let lastInterface = lastPathInterface, let currentInterface = interfaceType {
                interfaceChanged = lastInterface != currentInterface
            } else {
                interfaceChanged = false
            }
            self.lastPathInterface = interfaceType
        } else {
            interfaceChanged = false
        }
        
        onChange(isSatisfied, interfaceChanged, interfaceType)
    }
}
