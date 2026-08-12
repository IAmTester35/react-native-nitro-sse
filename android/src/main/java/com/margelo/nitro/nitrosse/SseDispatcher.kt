package com.margelo.nitro.nitrosse

/**
 * Abstract task dispatcher for scheduling and executing asynchronous SSE operations.
 *
 * Decouples SSE lifecycle management from Android framework dependencies, allowing production code
 * to run on Android [android.os.Handler] threads and test environments to run on virtual time dispatchers.
 */
interface SseDispatcher {
    fun post(runnable: Runnable)
    fun postDelayed(runnable: Runnable, delayMillis: Long)
    fun removeCallbacks(runnable: Runnable)
    fun removeCallbacksAndMessages(token: Any?)
}
