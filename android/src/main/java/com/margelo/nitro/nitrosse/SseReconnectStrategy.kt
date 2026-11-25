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
    private var retryIntervalMs: Double = DEFAULT_RETRY_INTERVAL_MS
    private var maxRetryIntervalMs: Double = DEFAULT_MAX_RETRY_INTERVAL_MS
    private var jitterFactor: Double = DEFAULT_JITTER_FACTOR
    private var maxReconnectAttempts: Int = -1

    private var backoffCounter = 0
    var currentReconnectAttempts = 0
        private set

    private fun Double.isValidNonNegative(): Boolean = !isNaN() && !isInfinite() && this >= 0.0

    fun configure(
        retryIntervalMs: Double,
        maxRetryIntervalMs: Double,
        jitterFactor: Double,
        maxReconnectAttempts: Int
    ) {
        this.retryIntervalMs = if (retryIntervalMs.isValidNonNegative()) {
            retryIntervalMs
        } else {
            DEFAULT_RETRY_INTERVAL_MS
        }
        this.maxRetryIntervalMs = if (maxRetryIntervalMs.isValidNonNegative()) {
            maxRetryIntervalMs
        } else {
            DEFAULT_MAX_RETRY_INTERVAL_MS
        }
        this.jitterFactor = if (!jitterFactor.isNaN() && !jitterFactor.isInfinite()) {
            jitterFactor.coerceIn(0.0, 1.0)
        } else {
            DEFAULT_JITTER_FACTOR
        }
        this.maxReconnectAttempts = if (maxReconnectAttempts >= 0) {
            maxReconnectAttempts
        } else {
            -1
        }
    }

    /**
     * Updates base retry interval when server sends a 'retry: <ms>' directive.
     */
    fun updateRetryInterval(retryMs: Double) {
        if (retryMs.isValidNonNegative()) {
            this.retryIntervalMs = retryMs
        }
    }

    fun nextDelay(isError: Boolean): Long {
        currentReconnectAttempts++
        val baseDelay = if (isError) {
            val base = if (retryIntervalMs <= 0.0) {
                0.0
            } else {
                val rawBase = retryIntervalMs * 2.0.pow(backoffCounter.toDouble())
                if (rawBase.isFinite()) min(rawBase, maxRetryIntervalMs) else maxRetryIntervalMs
            }
            backoffCounter++
            base
        } else {
            retryIntervalMs
        }

        // Apply randomized jitter factor to decorrelate client reconnection requests
        val delayWithJitter = baseDelay * (1.0 - jitterFactor + Random.nextDouble() * 2 * jitterFactor)
        val safeDelay = if (delayWithJitter.isFinite()) delayWithJitter else maxRetryIntervalMs

        // Enforce a 1000ms minimum threshold to prevent aggressive rapid retry loops
        return safeDelay.toLong().coerceAtLeast(MIN_RETRY_DELAY_MS)
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
        private const val DEFAULT_RETRY_INTERVAL_MS = 1000.0
        private const val DEFAULT_MAX_RETRY_INTERVAL_MS = 30000.0
        private const val DEFAULT_JITTER_FACTOR = 0.5
        private const val MIN_RETRY_DELAY_MS = 1000L
        private const val MILLIS_PER_SECOND = 1000L

        fun extractRetryAfterMillis(response: Response?): Long? {
            val header = response?.header("Retry-After") ?: return null
            return try {
                header.toLong() * MILLIS_PER_SECOND
            } catch (e: NumberFormatException) {
                response.headers.getDate("Retry-After")?.let {
                    val diff = it.time - System.currentTimeMillis()
                    if (diff > 0) diff else null
                }
            }
        }
    }
}
