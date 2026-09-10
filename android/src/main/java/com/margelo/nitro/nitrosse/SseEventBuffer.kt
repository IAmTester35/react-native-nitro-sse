package com.margelo.nitro.nitrosse

import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Thread-safe event buffer that accumulates incoming SSE events and flushes them in batches.
 *
 * Batching reduces cross-bridge serialization calls to the JavaScript engine during high-frequency
 * streaming, executing directly on the background [dispatcher] to prevent blocking the Android Main UI thread.
 */
class SseEventBuffer(
    onFlush: (Array<SseEvent>) -> Unit,
    private val dispatcher: SseDispatcher?
) {
    @Volatile
    private var onFlush: (Array<SseEvent>) -> Unit = onFlush

    var onFlushError: ((Exception) -> Unit)? = null

    private val eventBuffer = mutableListOf<SseEvent>()
    private val isFlushPending = AtomicBoolean(false)
    
    private var batchingIntervalMs: Double = 0.0
    private var maxBufferSize: Int = 1000

    private val flushRunnable = Runnable { flush() }

    fun configure(batchingIntervalMs: Double, maxBufferSize: Int) {
        this.batchingIntervalMs = if (!batchingIntervalMs.isNaN() && !batchingIntervalMs.isInfinite() && batchingIntervalMs >= 0) batchingIntervalMs else 0.0
        this.maxBufferSize = if (maxBufferSize > 0) maxBufferSize else 1000
    }

    fun setCallback(newCallback: (Array<SseEvent>) -> Unit) {
        this.onFlush = newCallback
    }

    fun clearCallback() {
        this.onFlush = {}
    }

    fun push(event: SseEvent) {
        if (batchingIntervalMs <= 0.0) {
            if (dispatcher == null || dispatcher.isCurrentDispatcher()) {
                synchronized(eventBuffer) {
                    eventBuffer.add(event)
                }
                flush()
            } else {
                dispatcher.post {
                    synchronized(eventBuffer) {
                        eventBuffer.add(event)
                    }
                    flush()
                }
            }
            return
        }

        var shouldFlush = false
        synchronized(eventBuffer) {
            eventBuffer.add(event)
            if (eventBuffer.size >= maxBufferSize) {
                shouldFlush = true
            }
        }

        if (shouldFlush) {
            if (dispatcher == null || dispatcher.isCurrentDispatcher()) {
                dispatcher?.removeCallbacks(flushRunnable)
                flush()
            } else {
                dispatcher.post {
                    dispatcher.removeCallbacks(flushRunnable)
                    flush()
                }
            }
        } else if (!isFlushPending.getAndSet(true)) {
            dispatcher?.postDelayed(flushRunnable, batchingIntervalMs.toLong())
        }
    }

    fun flush() {
        dispatcher?.removeCallbacks(flushRunnable)
        val eventsToEmit: Array<SseEvent>
        synchronized(eventBuffer) {
            if (eventBuffer.isEmpty()) {
                isFlushPending.set(false)
                return
            }
            eventsToEmit = eventBuffer.toTypedArray()
            eventBuffer.clear()
            isFlushPending.set(false)
        }

        try {
            onFlush(eventsToEmit)
        } catch (e: Exception) {
            Log.e("SseEventBuffer", "Error invoking onFlush: ${e.message}")
            onFlushError?.invoke(e)
        }
    }

    fun clear() {
        dispatcher?.removeCallbacks(flushRunnable)
        synchronized(eventBuffer) {
            eventBuffer.clear()
            isFlushPending.set(false)
        }
    }
}
