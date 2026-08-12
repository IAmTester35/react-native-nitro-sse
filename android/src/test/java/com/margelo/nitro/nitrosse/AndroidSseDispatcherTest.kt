package com.margelo.nitro.nitrosse

import android.os.Handler
import android.os.Looper
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicBoolean
import android.os.Build

/**
 * Unit tests verifying [AndroidSseDispatcher] scheduling, delay posting, and task cancellation
 * behavior using Robolectric shadow loopers.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.O])
class AndroidSseDispatcherTest {

    private lateinit var handler: Handler
    private lateinit var dispatcher: AndroidSseDispatcher

    @Before
    fun setup() {
        // Use Robolectric shadow main looper to inspect and step message queues deterministically
        handler = Handler(Looper.getMainLooper())
        dispatcher = AndroidSseDispatcher(handler)
    }

    @Test
    fun testPost() {
        val executed = AtomicBoolean(false)
        dispatcher.post {
            executed.set(true)
        }

        assertFalse("Runnable should not execute before looper runs", executed.get())
        shadowOf(Looper.getMainLooper()).idle() // Run pending tasks
        assertTrue("Runnable should have executed", executed.get())
    }

    @Test
    fun testPostDelayed() {
        val executed = AtomicBoolean(false)
        dispatcher.postDelayed({
            executed.set(true)
        }, 1000)

        shadowOf(Looper.getMainLooper()).idle()
        assertFalse("Runnable should not execute before delay", executed.get())

        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(1000))
        assertTrue("Runnable should have executed after delay", executed.get())
    }

    @Test
    fun testRemoveCallbacks() {
        val executed = AtomicBoolean(false)
        val runnable = Runnable { executed.set(true) }

        dispatcher.postDelayed(runnable, 1000)
        dispatcher.removeCallbacks(runnable)

        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(1000))
        assertFalse("Runnable should not have executed because it was removed", executed.get())
    }

    @Test
    fun testRemoveCallbacksAndMessages() {
        val executed = AtomicBoolean(false)
        val runnable = Runnable { executed.set(true) }

        dispatcher.postDelayed(runnable, 1000)
        dispatcher.removeCallbacksAndMessages(null)

        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(1000))
        assertFalse("Runnable should not have executed because all callbacks were removed", executed.get())
    }
}
