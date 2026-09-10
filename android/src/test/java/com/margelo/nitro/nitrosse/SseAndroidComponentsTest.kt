package com.margelo.nitro.nitrosse

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito.mock
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowConnectivityManager
import org.robolectric.shadows.ShadowNetworkCapabilities

/**
 * Unit tests for [SseLifecycleManager] and [SseNetworkMonitor].
 *
 * Verifies Android process lifecycle background/foreground event handling and ConnectivityManager network
 * callback registrations using Robolectric shadows.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.O])
class SseAndroidComponentsTest {

    private lateinit var context: Context
    private lateinit var connectivityManager: ConnectivityManager
    private lateinit var shadowConnectivityManager: ShadowConnectivityManager

    @Before
    fun setup() {
        context = ApplicationProvider.getApplicationContext()
        connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        shadowConnectivityManager = shadowOf(connectivityManager)
    }

    // MARK: - SseLifecycleManager Tests

    @Test
    fun testLifecycleManagerCallbacks() {
        var onBackgroundCalled = false
        var onForegroundCalled = false

        val mockOwner = object : LifecycleOwner {
            private val registry = LifecycleRegistry(this)
            override val lifecycle: Lifecycle get() = registry
        }
        val dispatcher = TestSseDispatcher()
        val manager = SseLifecycleManager(
            lifecycleProvider = { mockOwner.lifecycle },
            mainDispatcher = dispatcher,
            sseDispatcher = dispatcher,
            onBackground = { onBackgroundCalled = true },
            onForeground = { onForegroundCalled = true }
        )


        // Verify default lifecycle observer initialization state
        assertFalse(manager.isAppInBackground)

        // Trigger onStop event to verify transition to background state and callback execution
        manager.onStop(mockOwner)
        dispatcher.executePending()
        assertTrue(manager.isAppInBackground)
        assertTrue(onBackgroundCalled)

        // Trigger onStart event to verify transition back to foreground state and callback execution
        manager.onStart(mockOwner)
        dispatcher.executePending()
        assertFalse(manager.isAppInBackground)
        assertTrue(onForegroundCalled)
    }

    @Test
    fun testLifecycleManagerObserving() {
        val mockOwner = object : LifecycleOwner {
            val registry = LifecycleRegistry(this)
            override val lifecycle: Lifecycle get() = registry
        }
        val dispatcher = TestSseDispatcher()
        val manager = SseLifecycleManager(
            lifecycleProvider = { mockOwner.lifecycle },
            mainDispatcher = dispatcher,
            sseDispatcher = dispatcher,
            onBackground = {}, 
            onForeground = {}
        )
        
        manager.startObserving()
        dispatcher.executePending()
        assertEquals(1, mockOwner.registry.observerCount)

        manager.stopObserving()
        dispatcher.executePending()
        assertEquals(0, mockOwner.registry.observerCount)
    }

    @Test
    fun testNetworkMonitorCallbacks() {
        var isAvailable = false
        var interfaceChanged = false
        var capabilities: NetworkCapabilities? = null

        val dispatcher = TestSseDispatcher()
        val monitor = SseNetworkMonitor(context, dispatcher) { available, changed, caps ->
            isAvailable = available
            interfaceChanged = changed
            capabilities = caps
        }

        monitor.start()

        // Inspect Robolectric ConnectivityManager shadow to retrieve registered system callbacks
        val callbacks = shadowConnectivityManager.networkCallbacks
        assertTrue("Callback should be registered", callbacks.isNotEmpty())

        val networkCallback = callbacks.first()

        // Simulate initial network availability: initial snapshot must NOT flag interface change
        val mockNetwork = mock(Network::class.java)
        val wifiCaps = ShadowNetworkCapabilities.newInstance()
        shadowOf(wifiCaps).addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
        
        networkCallback.onAvailable(mockNetwork)
        networkCallback.onCapabilitiesChanged(mockNetwork, wifiCaps)
        
        dispatcher.executePending()
        
        assertTrue(isAvailable)
        assertFalse("Initial network detection must not be flagged as interface changed", interfaceChanged)
        assertNotNull(capabilities)

        // Simulate interface change from Wi-Fi to Cellular
        val cellularCaps = ShadowNetworkCapabilities.newInstance()
        shadowOf(cellularCaps).addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
        networkCallback.onCapabilitiesChanged(mockNetwork, cellularCaps)

        dispatcher.executePending()

        assertTrue(isAvailable)
        assertTrue("Transport switch from WiFi to Cellular must be flagged as interface changed", interfaceChanged)

        // Simulate network disconnect transition
        networkCallback.onLost(mockNetwork)
        
        dispatcher.executePending()
        
        assertFalse(isAvailable)
        assertFalse(interfaceChanged)
        assertNull(capabilities)

        monitor.stop()
        
        // Confirm network callback unregistration clean-up
        assertTrue("Callback should be unregistered", shadowConnectivityManager.networkCallbacks.isEmpty())
    }

    @Test
    fun testNetworkMonitorNoHandler() {
        var isAvailable = false

        // Verify synchronous execution path when no task dispatcher is provided
        val monitor = SseNetworkMonitor(context, null) { available, _, _ ->
            isAvailable = available
        }

        monitor.start()
        val networkCallback = shadowConnectivityManager.networkCallbacks.first()
        
        val mockNetwork = mock(Network::class.java)
        networkCallback.onAvailable(mockNetwork)
        
        assertTrue("Should be synchronous when no handler provided", isAvailable)
        
        monitor.stop()
    }
}
