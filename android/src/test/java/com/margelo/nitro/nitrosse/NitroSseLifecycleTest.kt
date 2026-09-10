package com.margelo.nitro.nitrosse

import android.os.Build
import com.facebook.soloader.SoLoader
import com.margelo.nitro.core.Promise
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Tests for resource lifecycle management and proactive disposal on JSI Dispatcher destruction.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.O])
class NitroSseLifecycleTest {
    private lateinit var dispatcher: TestSseDispatcher

    @Before
    fun setUp() {
        SoLoader.setInTestMode()
        dispatcher = TestSseDispatcher()
    }

    private fun createConfig(): SseConfig {
        return SseConfig(
            "http://localhost:33333/events",
            null,
            emptyMap(),
            null,
            false,
            0.0,
            1000.0,
            15000.0,
            300000.0,
            100.0,
            30000.0,
            0.0,
            -1.0,
            3.0,
            false,
            false,
            null
        )
    }

    @Test
    fun testDispatcherDestroyedInInterceptorTriggersFullDispose() {
        val sse = NitroSse(dispatcher)
        val config = createConfig()

        sse.setup(config) {}
        dispatcher.executePending()

        // Inject networkMonitor to verify dispose() cleans it up
        val networkMonitorField = NitroSse::class.java.getDeclaredField("networkMonitor")
        networkMonitorField.isAccessible = true
        val context = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        val mockMonitor = SseNetworkMonitor(context, dispatcher) { _, _, _ -> }
        networkMonitorField.set(sse, mockMonitor)

        sse.start()
        dispatcher.executePending()

        assertTrue(sse.isConnected())

        // Simulate runtime teardown during interceptor execution
        val handleInterceptorErrorMethod = NitroSse::class.java.getDeclaredMethod(
            "handleInterceptorError",
            Throwable::class.java,
            Int::class.javaPrimitiveType
        )
        handleInterceptorErrorMethod.isAccessible = true

        val reqVersionField = NitroSse::class.java.getDeclaredField("connectionAttemptVersion")
        reqVersionField.isAccessible = true
        val version = (reqVersionField.get(sse) as java.util.concurrent.atomic.AtomicInteger).get()

        val runtimeException = RuntimeException("Failed to call onBeforeRequest - the Dispatcher has already been destroyed!")
        handleInterceptorErrorMethod.invoke(sse, runtimeException, version)
        dispatcher.executePending()

        // Verify full dispose was called
        assertFalse("Stream must be stopped", sse.isConnected())
        assertNull("NetworkMonitor must be nullified/stopped", networkMonitorField.get(sse))

        val lifecycleManagerField = NitroSse::class.java.getDeclaredField("lifecycleManager")
        lifecycleManagerField.isAccessible = true
        assertNull("LifecycleManager must be nullified/stopped", lifecycleManagerField.get(sse))
    }

    @Test
    fun testDispatcherDestroyedDuringEventFlushTriggersFullDispose() {
        val sse = NitroSse(dispatcher)
        val config = createConfig()

        sse.setup(config) {}
        dispatcher.executePending()

        val networkMonitorField = NitroSse::class.java.getDeclaredField("networkMonitor")
        networkMonitorField.isAccessible = true
        val context = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        val mockMonitor = SseNetworkMonitor(context, dispatcher) { _, _, _ -> }
        networkMonitorField.set(sse, mockMonitor)

        sse.start()
        dispatcher.executePending()

        assertTrue(sse.isConnected())

        // Simulate runtime teardown during buffer onFlush
        val handleFlushErrorMethod = NitroSse::class.java.getDeclaredMethod(
            "handleRuntimeOrFlushError",
            Throwable::class.java
        )
        handleFlushErrorMethod.isAccessible = true

        val flushException = RuntimeException("Dispatcher has already been destroyed!")
        handleFlushErrorMethod.invoke(sse, flushException)
        dispatcher.executePending()

        assertFalse("Stream must be stopped on flush error", sse.isConnected())
        assertNull("NetworkMonitor must be cleaned up", networkMonitorField.get(sse))
    }

    @Test
    fun testDisposeReleasesRequestInterceptorAndConfigAndIsIdempotent() {
        val sse = NitroSse(dispatcher)
        val config = createConfig()
        @Suppress("UNCHECKED_CAST")
        val dummyPromise = org.mockito.Mockito.mock(Promise::class.java) as Promise<Promise<Map<String, String>>>
        val interceptor = { dummyPromise }

        sse.setup(config, {}, interceptor)
        dispatcher.executePending()

        val interceptorField = NitroSse::class.java.getDeclaredField("requestInterceptor")
        interceptorField.isAccessible = true
        assertNotNull("Interceptor must be registered", interceptorField.get(sse))

        val configField = NitroSse::class.java.getDeclaredField("config")
        configField.isAccessible = true
        assertNotNull("Config must be registered", configField.get(sse))

        // Call dispose() first time
        sse.dispose()

        assertNull("requestInterceptor must be released on dispose", interceptorField.get(sse))
        assertNull("config must be nullified on dispose", configField.get(sse))

        // Call dispose() second time (idempotency check)
        sse.dispose()
        assertNull("requestInterceptor must remain null", interceptorField.get(sse))
        assertNull("config must remain null", configField.get(sse))
    }

    @Test
    fun testSubsequentSetupReplacesOrClearsPreviousInterceptor() {
        val sse = NitroSse(dispatcher)
        val config = createConfig()
        @Suppress("UNCHECKED_CAST")
        val dummyPromise = org.mockito.Mockito.mock(Promise::class.java) as Promise<Promise<Map<String, String>>>

        var interceptorACalled = false
        val interceptorA = {
            interceptorACalled = true
            dummyPromise
        }

        var interceptorBCalled = false
        val interceptorB = {
            interceptorBCalled = true
            dummyPromise
        }

        // Setup with A
        sse.setup(config, {}, interceptorA)
        dispatcher.executePending()

        val interceptorField = NitroSse::class.java.getDeclaredField("requestInterceptor")
        interceptorField.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        var currentInterceptor = interceptorField.get(sse) as? (() -> Promise<Promise<Map<String, String>>>)
        currentInterceptor?.invoke()
        assertTrue("Interceptor A should be active", interceptorACalled)

        // Setup with B
        sse.setup(config, {}, interceptorB)
        dispatcher.executePending()

        @Suppress("UNCHECKED_CAST")
        currentInterceptor = interceptorField.get(sse) as? (() -> Promise<Promise<Map<String, String>>>)
        currentInterceptor?.invoke()
        assertTrue("Interceptor B should be active", interceptorBCalled)

        // Setup with no interceptor
        sse.setup(config, {})
        dispatcher.executePending()

        assertNull("Interceptor must be cleared when setup without interceptor", interceptorField.get(sse))

        sse.dispose()
    }
}
