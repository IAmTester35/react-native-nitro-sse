package com.margelo.nitro.nitrosse

import java.util.PriorityQueue

/**
 * In-memory [SseDispatcher] implementation using a priority queue to simulate task scheduling.
 *
 * Allows unit tests to advance virtual clock time and execute scheduled tasks deterministically
 * without relying on Android framework Handler threads or system timers.
 */
class TestSseDispatcher : SseDispatcher {
    private val pendingTasks = PriorityQueue<ScheduledTask>()
    private var currentTimeMillis: Long = 0

    private data class ScheduledTask(
        val executeAt: Long,
        val runnable: Runnable,
        val seq: Long
    ) : Comparable<ScheduledTask> {
        override fun compareTo(other: ScheduledTask): Int {
            val timeDiff = this.executeAt.compareTo(other.executeAt)
            if (timeDiff != 0) return timeDiff
            return this.seq.compareTo(other.seq)
        }
    }

    private var sequenceNumber: Long = 0

    override fun post(runnable: Runnable) {
        println("TestSseDispatcher: posting task seq=$sequenceNumber")
        pendingTasks.add(ScheduledTask(currentTimeMillis, runnable, sequenceNumber++))
    }

    override fun postDelayed(runnable: Runnable, delayMillis: Long) {
        pendingTasks.add(ScheduledTask(currentTimeMillis + delayMillis, runnable, sequenceNumber++))
    }

    override fun removeCallbacks(runnable: Runnable) {
        val iterator = pendingTasks.iterator()
        while (iterator.hasNext()) {
            if (iterator.next().runnable == runnable) {
                iterator.remove()
            }
        }
    }

    override fun removeCallbacksAndMessages(token: Any?) {
        pendingTasks.clear()
    }

    fun advanceTimeBy(millis: Long) {
        currentTimeMillis += millis
        executePending()
    }
    
    fun executePending() {
        println("TestSseDispatcher: executePending with ${pendingTasks.size} tasks")
        while (pendingTasks.isNotEmpty() && pendingTasks.peek()!!.executeAt <= currentTimeMillis) {
            val task = pendingTasks.poll()
            println("TestSseDispatcher: running task seq=${task?.seq}")
            task?.runnable?.run()
        }
    }
}
