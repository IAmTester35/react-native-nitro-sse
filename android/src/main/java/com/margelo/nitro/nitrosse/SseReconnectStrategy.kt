package com.margelo.nitro.nitrosse

import okhttp3.Response
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/**
 * Calculates retry backoff intervals for reconnecting failed SSE connections.
 *
 * Employs exponential backoff with randomized jitter to prevent thundering herd pressure on backend
 * servers during outage recovery, and parses standard HTTP `Retry-After` headers.
 *
 * ARCHITECTURAL DECISION:
 * Square's okhttp-sse library provides no built-in reconnection loop or backoff algorithm.
 * This class is maintained natively in Kotlin to provide 100% mathematical parity with iOS's
 * SseReconnectStrategy.swift (identical exponential backoff, jitter formula, retry attempt accounting,
 * and maxReconnectAttempts enforcement), while remaining decoupled from any Android networking threads.
 */
class SseReconnectStrategy {
    private var retryIntervalMs: Double = 1000.0
    private var maxRetryIntervalMs: Double = 30000.0
    private var jitterFactor: Double = 0.5
    private var maxReconnectAttempts: Int = -1

    private var backoffCounter = 0
    private val _currentReconnectAttempts = AtomicInteger(0)
    
    val currentReconnectAttempts: Int
        get() = _currentReconnectAttempts.get()

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

    fun nextDelay(isError: Boolean): Long {
        _currentReconnectAttempts.incrementAndGet()
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
        return _currentReconnectAttempts.get() >= maxReconnectAttempts
    }

    fun recordAttempt(): Int {
        return _currentReconnectAttempts.incrementAndGet()
    }

    fun reset() {
        backoffCounter = 0
        _currentReconnectAttempts.set(0)
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
