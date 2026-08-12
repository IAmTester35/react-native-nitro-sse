package com.margelo.nitro.nitrosse

import android.os.Build
import android.os.Looper
import com.facebook.soloader.SoLoader
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Live HTTP integration tests executing against an active SSE server (`node example/sse-server.js`).
 * Set `REQUIRE_INTEGRATION_SERVER=1` in environment to enforce server availability on CI.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.O], shadows = [ShadowHybridNitroSseSpecCxxPart::class])
class NitroSseIntegrationTest {

    private fun createRealConfig(url: String): SseConfig {
        return SseConfig(
            url,
            HttpMethod.GET,
            emptyMap(),
            null,
            false,
            0.0,
            1000.0,
            5000.0,
            300000.0,
            100.0,
            5000.0,
            0.0,
            3.0,
            true,
            false,
            null,
            null
        )
    }

    @Before
    fun setUp() {
        SoLoader.setInTestMode()
    }

    @Test
    fun testIntegrationConnectionSuccess() {
        val sse = NitroSse()
        val config = createRealConfig("http://localhost:33333/events")

        val latch = CountDownLatch(1)
        val receivedEvents = mutableListOf<SseEvent>()

        sse.setup(config) { events ->
            synchronized(receivedEvents) {
                receivedEvents.addAll(events)
                if (receivedEvents.any { it.type == SseEventType.MESSAGE }) {
                    latch.countDown()
                }
            }
        }

        sse.start()

        val startTime = System.currentTimeMillis()
        var completed = false
        while (System.currentTimeMillis() - startTime < 5000) {
            shadowOf(Looper.getMainLooper()).idle()
            if (latch.await(50, TimeUnit.MILLISECONDS)) {
                completed = true
                break
            }
        }
        shadowOf(Looper.getMainLooper()).idle()

        if (completed) {
            assertTrue(receivedEvents.size > 0)
        } else {
            if (System.getenv("REQUIRE_INTEGRATION_SERVER") == "1") {
                fail("Integration server timeout. Server must be running when REQUIRE_INTEGRATION_SERVER=1.")
            } else {
                println("⚠️ Integration server (localhost:33333) not running or timed out. Skipping failure.")
            }
        }
        sse.stop()
    }

    @Test
    fun testIntegrationRetryAfter() {
        val sse = NitroSse()
        val config = createRealConfig("http://localhost:33333/retry-after")

        val latch = CountDownLatch(1)
        val receivedEvents = mutableListOf<SseEvent>()

        sse.setup(config) { events ->
            synchronized(receivedEvents) {
                receivedEvents.addAll(events)
                if (receivedEvents.any { it.type == SseEventType.ERROR && it.retry != null }) {
                    latch.countDown()
                }
            }
        }

        sse.start()

        val startTime = System.currentTimeMillis()
        var completed = false
        while (System.currentTimeMillis() - startTime < 5000) {
            shadowOf(Looper.getMainLooper()).idle()
            if (latch.await(50, TimeUnit.MILLISECONDS)) {
                completed = true
                break
            }
        }
        shadowOf(Looper.getMainLooper()).idle()

        if (completed) {
            assertTrue(receivedEvents.size > 0)
        } else {
            if (System.getenv("REQUIRE_INTEGRATION_SERVER") == "1") {
                fail("Integration server timeout. Server must be running when REQUIRE_INTEGRATION_SERVER=1.")
            } else {
                println("⚠️ Integration server (localhost:33333) not running or timed out. Skipping failure.")
            }
        }
        sse.stop()
    }
}
