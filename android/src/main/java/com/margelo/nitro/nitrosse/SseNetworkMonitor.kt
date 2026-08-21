package com.margelo.nitro.nitrosse

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log

typealias NetworkChangeHandler = (isAvailable: Boolean, capabilities: NetworkCapabilities?) -> Unit

/**
 * Monitors system connectivity changes using Android's [ConnectivityManager].
 *
 * Emits network availability and capability updates to enable automatic stream reconnection
 * upon network restoration or interface handovers (e.g. Wi-Fi to cellular transition).
 */
class SseNetworkMonitor(
    private val context: Context,
    private val dispatcher: SseDispatcher?,
    private val onChange: NetworkChangeHandler
) {
    private val lock = Any()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    
    companion object {
        private const val TAG = "SseNetworkMonitor"
    }

    fun start() {
        synchronized(lock) {
            if (networkCallback != null) return

            val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            if (connectivityManager == null) {
                Log.e(TAG, "Failed to get ConnectivityManager.")
                return
            }

            val callback = object : ConnectivityManager.NetworkCallback() {
                private fun dispatchChange(isAvailable: Boolean, capabilities: NetworkCapabilities?) {
                    dispatcher?.post { onChange(isAvailable, capabilities) } ?: onChange(isAvailable, capabilities)
                }

                override fun onAvailable(network: Network) {
                    dispatchChange(true, connectivityManager.getNetworkCapabilities(network))
                }

                override fun onLost(network: Network) {
                    dispatchChange(false, null)
                }

                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    dispatchChange(true, capabilities)
                }
            }

            try {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
                    connectivityManager.registerDefaultNetworkCallback(callback)
                } else {
                    val request = NetworkRequest.Builder()
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .build()
                    connectivityManager.registerNetworkCallback(request, callback)
                }
                networkCallback = callback
            } catch (e: SecurityException) {
                Log.e(TAG, "Failed to register network callback. Missing ACCESS_NETWORK_STATE permission.", e)
                networkCallback = null
            } catch (e: Exception) {
                Log.e(TAG, "Failed to register network callback.", e)
                networkCallback = null
            }
        }
    }

    fun stop() {
        synchronized(lock) {
            val callback = networkCallback ?: return
            try {
                val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                connectivityManager?.unregisterNetworkCallback(callback)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to unregister network callback: ${e.message}")
            }
            networkCallback = null
        }
    }
}
