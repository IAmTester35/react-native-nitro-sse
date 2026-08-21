import Foundation
#if os(iOS)
import UIKit
#endif

/// Monitors iOS app lifecycle notifications (`didEnterBackground`, `willEnterForeground`) and manages `UIBackgroundTask`.
/// Decouples iOS platform lifecycle hooks from connection state transitions.
class SseLifecycleManager {
    private let dispatcher: SseDispatcher
    private let onBackground: () -> Void
    private let onForeground: () -> Void
    
    private(set) var isAppInBackground: Bool = false
    
#if os(iOS)
    private var backgroundTaskIdentifier: UIBackgroundTaskIdentifier = .invalid
    private var isBackgroundTaskActive: Bool = false
#endif
    
    init(
        dispatcher: SseDispatcher,
        onBackground: @escaping () -> Void,
        onForeground: @escaping () -> Void
    ) {
        self.dispatcher = dispatcher
        self.onBackground = onBackground
        self.onForeground = onForeground
    }
    
    /// Registers observer for iOS application state transitions via `NotificationCenter`.
    /// Calls `removeObserver(self)` first to guarantee idempotency without mutable state.
    func startObserving() {
#if os(iOS)
        NotificationCenter.default.removeObserver(self)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
#endif
    }
    
    /// Unregisters all lifecycle notification observers.
    func stopObserving() {
#if os(iOS)
        NotificationCenter.default.removeObserver(self)
#endif
    }
    
    /// Begins a `UIBackgroundTask` to request background execution time from iOS.
    /// `UIApplication` background task calls are routed through `DispatchQueue.main` as required by UIKit,
    /// while task expiration callbacks dispatch safely back to the serial `SseDispatcher`.
    func beginBackgroundKeepAlive(expirationHandler: @escaping () -> Void) {
#if os(iOS)
        cleanupBackgroundTask()
        isBackgroundTaskActive = true
        
        DispatchQueue.main.async { [weak self] in
            let taskId = UIApplication.shared.beginBackgroundTask(withName: "NitroSse-KeepAlive") {
                self?.dispatcher.async {
                    expirationHandler()
                }
            }
            self?.dispatcher.async {
                guard let self = self else { return }
                if self.isBackgroundTaskActive {
                    if self.backgroundTaskIdentifier != .invalid {
                        let oldTaskId = self.backgroundTaskIdentifier
                        DispatchQueue.main.async {
                            UIApplication.shared.endBackgroundTask(oldTaskId)
                        }
                    }
                    self.backgroundTaskIdentifier = taskId
                } else {
                    DispatchQueue.main.async {
                        UIApplication.shared.endBackgroundTask(taskId)
                    }
                }
            }
        }
#endif
    }
    
    /// Ends active `UIBackgroundTask` on the main queue and invalidates the task identifier.
    func cleanupBackgroundTask() {
#if os(iOS)
        isBackgroundTaskActive = false
        let taskId = backgroundTaskIdentifier
        if taskId != .invalid {
            backgroundTaskIdentifier = .invalid
            DispatchQueue.main.async {
                UIApplication.shared.endBackgroundTask(taskId)
            }
        }
#endif
    }
    
    @objc private func handleAppDidEnterBackground() {
        dispatcher.async { [weak self] in
            guard let self = self else { return }
            self.isAppInBackground = true
            self.onBackground()
        }
    }
    
    @objc private func handleAppWillEnterForeground() {
        dispatcher.async { [weak self] in
            guard let self = self else { return }
            self.isAppInBackground = false
            self.cleanupBackgroundTask()
            self.onForeground()
        }
    }
}
