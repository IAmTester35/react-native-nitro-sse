package com.margelo.nitro.nitrosse

import android.os.Handler

/**
 * Android implementation of [SseDispatcher] delegating execution to an [android.os.Handler].
 *
 * Decouples thread scheduling from Android OS dependencies, allowing unit tests
 * to swap handler execution with deterministic in-memory dispatchers.
 */
class AndroidSseDispatcher(private val handler: Handler) : SseDispatcher {
    override fun post(runnable: Runnable) {
        handler.post(runnable)
    }

    override fun postDelayed(runnable: Runnable, delayMillis: Long) {
        handler.postDelayed(runnable, delayMillis)
    }

    override fun removeCallbacks(runnable: Runnable) {
        handler.removeCallbacks(runnable)
    }

    override fun removeCallbacksAndMessages(token: Any?) {
        handler.removeCallbacksAndMessages(token)
    }
}
