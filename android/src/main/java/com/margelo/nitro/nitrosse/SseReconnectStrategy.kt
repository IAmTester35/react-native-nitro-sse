package com.margelo.nitro.nitrosse

import okhttp3.Response
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/**
 * Calculates retry backoff intervals using randomized jitter exponential backoff.
 * Maintains mathematical parity with iOS SseReconnectStrategy.
 */
class SseReconnectStrategy {
    private var retryIntervalMs: Double = 1000.0
    private var maxRetryIntervalMs: Double = 30000.0
    private var jitterFactor: Double = 0.5
    private var maxReconnectAttempts: Int = -1

    private var backoffCounter = 0
    var currentReconnectAttempts = 0
        private set

    fun configure(
        retryIntervalMs: Double,
        maxRetryIntervalMs: Double,
        jitterFactor: Double,
        maxReconnectAttempts: Int
    ) {
        this.retryIntervalMs = if (!retryIntervalMs.isNaN() && !retryIntervalMs.isInfinite() && retryIntervalMs >= 0) retryIntervalMs else 1000.0
        this.maxRetryIntervalMs = if (!maxRetryIntervalMs.isNaN() && !maxRetryIntervalMs.isInfinite() && maxRetryIntervalMs >= 0) maxRetryIntervalMs else 30000.0
        this.jitterFactor = if (!jitterFactor.isNaN() && !jitterFactor.isInfinite()) jitterFactor.coerceIn(0.0, 1.0) else 0.5
        this.maxReconnectAttempts = if (maxReconnectAttempts == -1 || maxReconnectAttempts >= 0) maxReconnectAttempts else -1
    }

    /**
     * Updates base retry interval when server sends a 'retry: <ms>' directive.
     */
    fun updateRetryInterval(retryMs: Double) {
        if (!retryMs.isNaN() && !retryMs.isInfinite() && retryMs >= 0) {
            this.retryIntervalMs = retryMs
        }
    }

    fun nextDelay(isError: Boolean): Long {
        currentReconnectAttempts++
        val baseDelay = if (isError) {
            val exponent = backoffCounter.toDouble()
            val base = min(retryIntervalMs * 2.0.pow(exponent), maxRetryIntervalMs)
            backoffCounter++
            base
        } else {
            retryIntervalMs
        }

        // Apply randomized jitter factor to decorrelate client reconnection requests
        val delayWithJitter = baseDelay * (1.0 - jitterFactor + Random.nextDouble() * 2 * jitterFactor)
        
        // Enforce a 1000ms minimum threshold to prevent aggressive rapid retry loops
        return delayWithJitter.toLong().coerceAtLeast(1000L)
    }

    fun hasReachedMaxAttempts(): Boolean {
        if (maxReconnectAttempts == -1) return false
        return currentReconnectAttempts >= maxReconnectAttempts
    }

    fun recordAttempt(): Int {
        return ++currentReconnectAttempts
    }

    fun reset() {
        backoffCounter = 0
        currentReconnectAttempts = 0
    }

    companion object {
        fun extractRetryAfterMillis(response: Response?): Long? {
            val header = response?.header("Retry-After") ?: return null
            return try {
                header.toLong() * 1000L
            } catch (e: NumberFormatException) {
                response.headers.getDate("Retry-After")?.let {
                    val diff = it.time - System.currentTimeMillis()
                    if (diff > 0) diff else null
                }
            }
        }
    }
}
