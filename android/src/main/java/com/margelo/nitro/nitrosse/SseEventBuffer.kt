package com.margelo.nitro.nitrosse

import android.util.Log
import com.margelo.nitro.core.AnyMap
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Thread-safe event buffer that accumulates incoming SSE events and flushes them in batches.
 *
 * Batching reduces cross-bridge serialization calls to the JavaScript engine during high-frequency
 * streaming, while ensuring events are delivered on the main UI thread via [mainDispatcher].
 */
class SseEventBuffer(
    private var onFlush: (Array<SseEvent>) -> Unit,
    private val dispatcher: SseDispatcher?,
    private val mainDispatcher: SseDispatcher? = null
) {
    private val eventBuffer = mutableListOf<SseEvent>()
    private val isFlushPending = AtomicBoolean(false)
    
    private var batchingIntervalMs: Double = 0.0
    private var maxBufferSize: Int = 1000

    private val flushRunnable = Runnable { flush() }

    fun configure(batchingIntervalMs: Double, maxBufferSize: Int) {
        this.batchingIntervalMs = batchingIntervalMs
        this.maxBufferSize = maxBufferSize
    }

    fun setCallback(newCallback: (Array<SseEvent>) -> Unit) {
        this.onFlush = newCallback
    }

    fun clearCallback() {
        this.onFlush = {}
    }

    fun push(event: SseEvent) {
        var shouldFlush = false
        synchronized(eventBuffer) {
            eventBuffer.add(event)
            if (eventBuffer.size >= maxBufferSize) {
                shouldFlush = true
            }
        }

        dispatcher?.post {
            if (batchingIntervalMs <= 0 || shouldFlush) {
                dispatcher.removeCallbacks(flushRunnable)
                flush()
            } else if (!isFlushPending.getAndSet(true)) {
                dispatcher.postDelayed(flushRunnable, batchingIntervalMs.toLong())
            }
        } ?: run {
            // Direct synchronous flush fallback when background dispatcher is absent
            if (shouldFlush || batchingIntervalMs <= 0) {
                flush()
            }
        }
    }

    fun flush() {
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

        mainDispatcher?.post {
            try {
                onFlush(eventsToEmit)
            } catch (e: Exception) {
                Log.e("SseEventBuffer", "Error invoking onFlush: ${e.message}")
            }
        } ?: run {
            try {
                onFlush(eventsToEmit)
            } catch (e: Exception) {
                Log.e("SseEventBuffer", "Error invoking onFlush (fallback): ${e.message}")
            }
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
