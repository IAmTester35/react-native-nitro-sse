package com.margelo.nitro.nitrosse

import okhttp3.Response
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import kotlin.random.Random

internal object SseHttpStatus {
    const val OK = 200
    const val OK_DOUBLE = 200.0
    const val NO_CONTENT = 204
    const val NO_CONTENT_DOUBLE = 204.0
    const val SUCCESS_MAX = 299
    const val BAD_REQUEST = 400
    const val UNAUTHORIZED = 401
    const val FORBIDDEN = 403
    const val REQUEST_TIMEOUT = 408
    const val TOO_MANY_REQUESTS = 429
    const val TOO_MANY_REQUESTS_DOUBLE = 429.0
    const val CLIENT_ERROR_MAX = 499
    const val INTERNAL_ERROR = 500
    const val SERVICE_UNAVAILABLE = 503
    const val UNKNOWN = -1
    const val UNKNOWN_DOUBLE = -1.0
}

internal data class SseFailureContext(
    val throwable: Throwable?,
    val response: Response?,
    val errorBody: String?,
    val statusCode: Int,
    val isTimeout: Boolean,
    val isParserLimit: Boolean,
    val isInvalidContentType: Boolean
)

internal data class SseFailurePolicyInput(
    val hasInterceptor: Boolean,
    val nextAuthAttempt: Int,
    val maxAuthRetries: Int,
    val maxRetryIntervalMs: Long,
    val retryAfterJitterMs: Long = defaultRetryAfterJitterMs()
)

private const val RETRY_AFTER_JITTER_BASE_MS = 500
private const val RETRY_AFTER_JITTER_BOUND_MS = 1001
private const val MILLIS_PER_SECOND = 1000L

private fun defaultRetryAfterJitterMs(): Long =
    (RETRY_AFTER_JITTER_BASE_MS + Random.nextInt(RETRY_AFTER_JITTER_BOUND_MS)).toLong()

private fun isTimeoutThrowable(t: Throwable?): Boolean =
    t is SocketTimeoutException ||
        t is InterruptedIOException ||
        t?.message?.contains("timeout", ignoreCase = true) == true

private fun formatTransientErrorMessage(
    t: Throwable?,
    statusCode: Int,
    reportedStatusCode: Double?,
    errorBody: String?
): String = when {
    statusCode >= SseHttpStatus.INTERNAL_ERROR && !errorBody.isNullOrBlank() ->
        "Server Error ($statusCode): ${errorBody.trim()}"
    else ->
        t?.message ?: if (reportedStatusCode != null) {
            "Link lost (${reportedStatusCode.toInt()})"
        } else {
            "Link lost"
        }
}

internal sealed class SseFailureDecision {
    data class FailAndStop(val message: String, val statusCode: Double?) : SseFailureDecision()
    data class AuthLimitReached(val message: String, val statusCode: Double) : SseFailureDecision()
    data class AuthRetry(val message: String, val statusCode: Double) : SseFailureDecision()
    data class RetryAfter(val message: String, val statusCode: Double, val delayMs: Long) : SseFailureDecision()
    data class RateLimitBackoff(val message: String, val statusCode: Double) : SseFailureDecision()
    data class TransientRetry(
        val message: String,
        val statusCode: Double?,
        val markStale: Boolean
    ) : SseFailureDecision()
}

/**
 * Pure classifier mapping OkHttp/parser failures into disconnect metrics and reconnection decisions.
 */
internal object SseFailureClassifier {
    fun isEventStreamContentType(contentTypeHeader: String?): Boolean {
        val rawMime = contentTypeHeader?.substringBefore(';')?.trim()?.lowercase()
        return rawMime == "text/event-stream"
    }

    fun isInvalidEventStreamResponse(t: Throwable?, response: Response?): Boolean {
        val hasInvalidBodyType = response != null &&
            response.code in SseHttpStatus.OK..SseHttpStatus.SUCCESS_MAX &&
            !isEventStreamContentType(response.header("Content-Type"))
        return t is InvalidContentTypeException || hasInvalidBodyType
    }

    fun buildContext(t: Throwable?, response: Response?, errorBody: String?): SseFailureContext =
        SseFailureContext(
            throwable = t,
            response = response,
            errorBody = errorBody,
            statusCode = response?.code ?: SseHttpStatus.UNKNOWN,
            isTimeout = isTimeoutThrowable(t),
            isParserLimit = t is SseParserLimitException,
            isInvalidContentType = isInvalidEventStreamResponse(t, response)
        )

    fun disconnectReason(context: SseFailureContext): SseDisconnectReason = when {
        context.statusCode >= SseHttpStatus.BAD_REQUEST ||
            context.statusCode == SseHttpStatus.NO_CONTENT ||
            context.isInvalidContentType -> SseDisconnectReason.SERVER_ERROR
        context.isParserLimit -> SseDisconnectReason.PARSER_ERROR
        context.isTimeout -> SseDisconnectReason.TIMEOUT
        else -> SseDisconnectReason.NETWORK_ERROR
    }

    fun errorCodeString(context: SseFailureContext): String =
        context.throwable?.javaClass?.simpleName ?: context.statusCode.toString()

    fun classify(context: SseFailureContext, policy: SseFailurePolicyInput): SseFailureDecision =
        classifyTerminal(context)
            ?: classifyAuth(context.statusCode, policy)
            ?: classifyRetryAfterOrRateLimit(context, policy)
            ?: buildTransientRetry(context)

    private fun classifyTerminal(context: SseFailureContext): SseFailureDecision? {
        val statusCode = context.statusCode
        val statusDouble = if (statusCode != SseHttpStatus.UNKNOWN) statusCode.toDouble() else null
        val isFatalClientError = statusCode in SseHttpStatus.BAD_REQUEST..SseHttpStatus.CLIENT_ERROR_MAX &&
            statusCode != SseHttpStatus.UNAUTHORIZED &&
            statusCode != SseHttpStatus.FORBIDDEN &&
            statusCode != SseHttpStatus.REQUEST_TIMEOUT &&
            statusCode != SseHttpStatus.TOO_MANY_REQUESTS

        return when {
            statusCode == SseHttpStatus.NO_CONTENT ->
                SseFailureDecision.FailAndStop("No Content (204). Stopping.", SseHttpStatus.NO_CONTENT_DOUBLE)
            context.isInvalidContentType ->
                SseFailureDecision.FailAndStop(
                    "Invalid Content-Type: expected text/event-stream. Stopping.",
                    statusDouble
                )
            context.throwable is SseParserLimitException ->
                // Parser resource violations (line length, event data size) are fatal and must not reconnect
                SseFailureDecision.FailAndStop(context.throwable.message, statusDouble)
            isFatalClientError -> {
                val sanitizedBody = context.errorBody?.trim()?.ifEmpty { null }
                val finalMessage = if (sanitizedBody != null) {
                    "Fatal Error ($statusCode): $sanitizedBody"
                } else {
                    "Fatal Error ($statusCode). Stopping."
                }
                SseFailureDecision.FailAndStop(finalMessage, statusCode.toDouble())
            }
            else -> null
        }
    }

    private fun classifyAuth(statusCode: Int, policy: SseFailurePolicyInput): SseFailureDecision? = when {
        statusCode != SseHttpStatus.UNAUTHORIZED && statusCode != SseHttpStatus.FORBIDDEN -> null
        !policy.hasInterceptor -> SseFailureDecision.FailAndStop(
            "Auth Error ($statusCode) - No interceptor provided. Stopping.",
            statusCode.toDouble()
        )
        policy.nextAuthAttempt > policy.maxAuthRetries -> SseFailureDecision.AuthLimitReached(
            "Auth Error ($statusCode) - Retry limit reached (${policy.maxAuthRetries}). Stopping.",
            statusCode.toDouble()
        )
        else -> SseFailureDecision.AuthRetry(
            "Auth Error ($statusCode) - Retry ${policy.nextAuthAttempt}/${policy.maxAuthRetries}. Refreshing token...",
            statusCode.toDouble()
        )
    }

    private fun classifyRetryAfterOrRateLimit(
        context: SseFailureContext,
        policy: SseFailurePolicyInput
    ): SseFailureDecision? {
        val statusCode = context.statusCode
        val retryAfterMillis = SseReconnectStrategy.extractRetryAfterMillis(context.response)
        val isRetryAfterStatus = statusCode == SseHttpStatus.TOO_MANY_REQUESTS ||
            statusCode == SseHttpStatus.SERVICE_UNAVAILABLE

        return when {
            isRetryAfterStatus && retryAfterMillis != null -> {
                val boundedRetryAfter = retryAfterMillis.coerceIn(0L, policy.maxRetryIntervalMs)
                val totalDelay = (boundedRetryAfter + policy.retryAfterJitterMs).coerceAtLeast(MILLIS_PER_SECOND)
                SseFailureDecision.RetryAfter(
                    message = "Retry-After received: ${totalDelay / MILLIS_PER_SECOND}s",
                    statusCode = statusCode.toDouble(),
                    delayMs = totalDelay
                )
            }
            statusCode == SseHttpStatus.TOO_MANY_REQUESTS ->
                SseFailureDecision.RateLimitBackoff(
                    message = "Rate Limited (429). Retrying with backoff...",
                    statusCode = SseHttpStatus.TOO_MANY_REQUESTS_DOUBLE
                )
            else -> null
        }
    }

    private fun buildTransientRetry(context: SseFailureContext): SseFailureDecision.TransientRetry {
        val statusCode = context.statusCode
        val isReportedCode = statusCode >= SseHttpStatus.BAD_REQUEST
        val reportedStatusCode = if (isReportedCode) statusCode.toDouble() else null
        val defaultErrorMsg = formatTransientErrorMessage(
            t = context.throwable,
            statusCode = statusCode,
            reportedStatusCode = reportedStatusCode,
            errorBody = context.errorBody
        )
        return SseFailureDecision.TransientRetry(
            message = defaultErrorMsg,
            statusCode = reportedStatusCode,
            markStale = context.isTimeout
        )
    }
}
