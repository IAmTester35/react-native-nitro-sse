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
        
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            self?.dispatcher.async {
                self?.handlePathUpdate(path)
            }
        }
        self.pathMonitor = monitor
        monitor.start(queue: queue)
    }
    
    /// Cancels active path monitoring and releases resources.
    func stop() {
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
        
        let interfaceChanged: Bool
        if isSatisfied {
            if let lastInterface = lastPathInterface, let currentInterface = interfaceType {
                interfaceChanged = lastInterface != currentInterface
            } else if lastPathInterface == nil && interfaceType != nil {
                interfaceChanged = true
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
