package com.margelo.nitro.nitrosse

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Observes Android process lifecycle events to handle stream hibernation and resumption.
 *
 * Automatically pauses active connections when the app enters background (unless background execution
 * is explicitly configured) to conserve mobile network bandwidth and battery.
 */
class SseLifecycleManager(
    private val lifecycleProvider: () -> androidx.lifecycle.Lifecycle,
    private val mainDispatcher: SseDispatcher,
    private val sseDispatcher: SseDispatcher,
    private val onBackground: () -> Unit,
    private val onForeground: () -> Unit
) : DefaultLifecycleObserver {

    private val _isAppInBackground = AtomicBoolean(false)
    val isAppInBackground: Boolean
        get() = _isAppInBackground.get()

    private val _hasSubscribed = AtomicBoolean(false)

    fun startObserving() {
        if (_hasSubscribed.compareAndSet(false, true)) {
            mainDispatcher.post {
                lifecycleProvider().addObserver(this)
            }
        }
    }

    fun stopObserving() {
        if (_hasSubscribed.compareAndSet(true, false)) {
            mainDispatcher.post {
                lifecycleProvider().removeObserver(this)
            }
        }
    }

    override fun onStart(owner: LifecycleOwner) {
        _isAppInBackground.set(false)
        sseDispatcher.post { onForeground() }
    }

    override fun onStop(owner: LifecycleOwner) {
        _isAppInBackground.set(true)
        sseDispatcher.post { onBackground() }
    }
}
