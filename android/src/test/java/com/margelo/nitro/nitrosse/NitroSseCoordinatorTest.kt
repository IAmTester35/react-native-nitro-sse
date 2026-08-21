package com.margelo.nitro.nitrosse

import android.os.Build
import android.os.Looper
import com.facebook.soloader.SoLoader
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * End-to-end unit tests for [NitroSse] state machine transitions, lifecycle events,
 * and HTTP failure response code handling (400, 204, 401, 429).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.O], shadows = [ShadowHybridNitroSseSpecCxxPart::class])
class NitroSseCoordinatorTest {

    private fun createMockConfig(): SseConfig {
        return SseConfig(
            "http://localhost:9999/dummy",
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
            2.0,
            3.0,
            false,
            false,
            null,
            null
        )
    }

    private fun createResponse(code: Int, message: String): Response {
        val request = Request.Builder().url("http://localhost:9999/dummy").build()
        return Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(message)
            .body("".toResponseBody(null))
            .build()
    }

    private lateinit var dispatcher: TestSseDispatcher

    @Before
    fun setUp() {
        SoLoader.setInTestMode()
        dispatcher = TestSseDispatcher()
    }

    private fun drainLoopers() {
        dispatcher.executePending()
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test
    fun testCoordinatorLifecycleStartStop() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        sse.setup(config) { _ -> }
        drainLoopers()

        assertFalse(sse.isConnected())
        assertEquals(SseState.IDLE, sse.getState())
        
        val stats = sse.getStats()
        assertEquals(0.0, stats.totalBytesReceived, 0.0)
        
        sse.start()
        drainLoopers()
        assertTrue(sse.isConnected())
        assertEquals(SseState.CONNECTING, sse.getState())
        
        sse.stop()
        drainLoopers()
        assertFalse(sse.isConnected())
        assertEquals(SseState.CLOSED, sse.getState())
    }

    @Test
    fun testStopAndRestartBeforeSetupDoesNotThrow() {
        val sse = NitroSse(dispatcher)
        assertEquals(SseState.IDLE, sse.getState())

        sse.stop()
        drainLoopers()
        assertEquals(SseState.CLOSED, sse.getState())

        sse.restart()
        drainLoopers()
        assertEquals(SseState.CLOSED, sse.getState())
    }

    @Test
    fun testCoordinatorStateTransitions() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        val emittedStates = mutableListOf<SseState>()
        sse.setup(config) { events ->
            for (event in events) {
                if (event.type == SseEventType.STATE && event.state != null) {
                    emittedStates.add(event.state)
                }
            }
        }
        drainLoopers()
        
        assertEquals(SseState.IDLE, sse.getState())
        
        sse.start()
        drainLoopers()
        assertEquals(SseState.CONNECTING, emittedStates.last())
        
        // Retrieve active request ID dynamically generated during start phase
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        // Simulate OkHttp onOpen event callback to trigger state transition to OPEN
        sse.connectionDidOpen(createResponse(200, "OK"), actualReqId)
        drainLoopers()
        assertEquals("Emitted states: $emittedStates", SseState.OPEN, emittedStates.last())
        assertEquals(SseState.OPEN, sse.getState())
        
        sse.stop()
        drainLoopers()
        assertEquals(SseState.CLOSED, emittedStates.last())
        assertEquals(SseState.CLOSED, sse.getState())
    }

    @Test
    fun testCoordinatorHandlesFatalError400() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        val emittedEvents = mutableListOf<SseEvent>()
        sse.setup(config) { events ->
            emittedEvents.addAll(events)
        }
        drainLoopers()
        
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        // Simulate HTTP 400 Bad Request error to verify non-retryable state transition to FAILED
        val errorResponse = createResponse(400, "Bad Request")
        sse.connectionDidFail(Exception("Fatal Error"), errorResponse, actualReqId)
        drainLoopers()
        
        assertFalse(sse.isConnected())
        assertEquals(SseState.FAILED, sse.getState())
        
        val errorEvent = emittedEvents.find { it.type == SseEventType.ERROR }
        assertNotNull(errorEvent)
        assertTrue(errorEvent?.message?.contains("Fatal Error") == true || errorEvent?.message?.contains("400") == true)
    }

    @Test
    fun testCoordinatorHandlesFatalError404() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        val emittedEvents = mutableListOf<SseEvent>()
        sse.setup(config) { events ->
            emittedEvents.addAll(events)
        }
        drainLoopers()
        
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        val errorResponse = createResponse(404, "Not Found")
        sse.connectionDidFail(Exception("Not Found"), errorResponse, actualReqId)
        drainLoopers()
        
        assertFalse(sse.isConnected())
        assertEquals(SseState.FAILED, sse.getState())
        
        val errorEvent = emittedEvents.find { it.type == SseEventType.ERROR }
        assertNotNull(errorEvent)
        assertTrue(errorEvent?.message?.contains("Fatal Error") == true || errorEvent?.message?.contains("404") == true)
    }

    @Test
    fun testCoordinatorHandlesFatalError405MethodNotAllowed() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        sse.setup(config) { _ -> }
        drainLoopers()
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        val errorResponse = createResponse(405, "Method Not Allowed")
        sse.connectionDidFail(Exception("Method Not Allowed"), errorResponse, actualReqId)
        drainLoopers()
        
        assertFalse(sse.isConnected())
        assertEquals(SseState.FAILED, sse.getState())
    }

    @Test
    fun testCoordinatorHandlesFatalError410Gone() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        sse.setup(config) { _ -> }
        drainLoopers()
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        val errorResponse = createResponse(410, "Gone")
        sse.connectionDidFail(Exception("Gone"), errorResponse, actualReqId)
        drainLoopers()
        
        assertFalse(sse.isConnected())
        assertEquals(SseState.FAILED, sse.getState())
    }

    @Test
    fun testCoordinatorHandlesFatalError422UnprocessableEntity() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        sse.setup(config) { _ -> }
        drainLoopers()
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        val errorResponse = createResponse(422, "Unprocessable Entity")
        sse.connectionDidFail(Exception("Unprocessable Entity"), errorResponse, actualReqId)
        drainLoopers()
        
        assertFalse(sse.isConnected())
        assertEquals(SseState.FAILED, sse.getState())
    }

    @Test
    fun testCoordinatorHandlesTimeout408Reconnecting() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        sse.setup(config) { _ -> }
        drainLoopers()
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        val errorResponse = createResponse(408, "Request Timeout")
        sse.connectionDidFail(Exception("Request Timeout"), errorResponse, actualReqId)
        drainLoopers()
        
        // 408 is recoverable, should transition to RECONNECTING
        assertEquals(SseState.RECONNECTING, sse.getState())
    }

    @Test
    fun testCoordinatorHandlesServerError500Reconnecting() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        sse.setup(config) { _ -> }
        drainLoopers()
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        val errorResponse = createResponse(500, "Internal Server Error")
        sse.connectionDidFail(Exception("Server Error"), errorResponse, actualReqId)
        drainLoopers()
        
        // 500 is recoverable, should transition to RECONNECTING
        assertEquals(SseState.RECONNECTING, sse.getState())
    }

    @Test
    fun testCoordinatorEmitsHeartbeatWithCommentPayload() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        val emittedEvents = mutableListOf<SseEvent>()
        sse.setup(config) { events ->
            emittedEvents.addAll(events)
        }
        drainLoopers()
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        val clientField = NitroSse::class.java.getDeclaredField("client")
        clientField.isAccessible = true
        val client = clientField.get(sse) as okhttp3.OkHttpClient
        val interceptor = client.networkInterceptors.filterIsInstance<HeartbeatNetworkInterceptor>().first()
        
        val onHeartbeatField = HeartbeatNetworkInterceptor::class.java.getDeclaredField("onHeartbeat")
        onHeartbeatField.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val onHeartbeat = onHeartbeatField.get(interceptor) as (String?, String) -> Unit

        onHeartbeat(actualReqId, "keepalive-text-payload")
        sse.flush()
        drainLoopers()
        
        val heartbeatEvent = emittedEvents.find { it.type == SseEventType.HEARTBEAT }
        assertNotNull(heartbeatEvent)
        assertEquals("keepalive-text-payload", heartbeatEvent?.message)
    }

    @Test
    fun testCoordinatorHandlesNoContent204() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        sse.setup(config) { _ -> }
        drainLoopers()
        
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        val errorResponse = createResponse(204, "No Content")
        sse.connectionDidFail(Exception("No Content"), errorResponse, actualReqId)
        drainLoopers()
        
        assertFalse(sse.isConnected())
        assertEquals(SseState.FAILED, sse.getState())
    }

    @Test
    fun testCoordinatorHandlesAuthError401WithoutInterceptor() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        sse.setup(config) { _ -> }
        drainLoopers()
        
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        val errorResponse = createResponse(401, "Unauthorized")
        sse.connectionDidFail(Exception("Auth Error"), errorResponse, actualReqId)
        drainLoopers()
        
        assertFalse(sse.isConnected())
        assertEquals(SseState.FAILED, sse.getState())
    }

    @Test
    fun testCoordinatorRateLimit429() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        sse.setup(config) { _ -> }
        drainLoopers()
        
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val actualReqId = reqIdField.get(sse) as String
        
        val errorResponse = createResponse(429, "Too Many Requests")
        sse.connectionDidFail(Exception("Rate Limited"), errorResponse, actualReqId)
        drainLoopers()
        
        // 429 without Retry-After header falls back to exponential backoff reconnection
        assertTrue(sse.isConnected())
        assertEquals(SseState.RECONNECTING, sse.getState())
        sse.stop()
        drainLoopers()
    }

    @Test
    fun testHeartbeatGuardedByRequestId() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        val emittedEvents = mutableListOf<SseEvent>()
        sse.setup(config) { events ->
            emittedEvents.addAll(events)
        }
        drainLoopers()
        
        sse.start()
        drainLoopers()
        
        val clientField = NitroSse::class.java.getDeclaredField("client")
        clientField.isAccessible = true
        val client = clientField.get(sse) as okhttp3.OkHttpClient
        val interceptor = client.networkInterceptors.filterIsInstance<HeartbeatNetworkInterceptor>().first()
        
        val onHeartbeatField = HeartbeatNetworkInterceptor::class.java.getDeclaredField("onHeartbeat")
        onHeartbeatField.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val onHeartbeat = onHeartbeatField.get(interceptor) as (String?, String) -> Unit

        // Simulates stale RID mismatch: heartbeat should not be pushed
        val staleRid = "stale-rid-999"
        onHeartbeat(staleRid, "keep-alive")
        sse.flush()
        drainLoopers()
        
        assertFalse(emittedEvents.any { it.type == SseEventType.HEARTBEAT })
    }

    @Test
    fun testRetryAfterReconnectionStopsAtMaxAttempts() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig().copy(maxReconnectAttempts = 1.0)
        
        val emittedEvents = mutableListOf<SseEvent>()
        sse.setup(config) { events ->
            emittedEvents.addAll(events)
        }
        drainLoopers()
        
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        
        // Attempt 1: 429 with Retry-After (1 second) -> schedules 1st reconnect
        var currentReqId = reqIdField.get(sse) as String
        val response1 = Response.Builder()
            .request(Request.Builder().url(config.url).build())
            .protocol(Protocol.HTTP_1_1)
            .code(429)
            .message("Too Many Requests")
            .header("Retry-After", "1")
            .body("".toResponseBody(null))
            .build()
        sse.connectionDidFail(Exception("Rate Limited"), response1, currentReqId)
        drainLoopers()
        assertEquals(SseState.RECONNECTING, sse.getState())
        
        // Advance time to execute delayed reconnect (Retry-After 1000ms + jitter)
        dispatcher.advanceTimeBy(3000)
        drainLoopers()
        
        // Attempt 2: 429 with Retry-After (reaches maxReconnectAttempts = 1) -> stops
        currentReqId = reqIdField.get(sse) as String
        val response2 = Response.Builder()
            .request(Request.Builder().url(config.url).build())
            .protocol(Protocol.HTTP_1_1)
            .code(429)
            .message("Too Many Requests")
            .header("Retry-After", "1")
            .body("".toResponseBody(null))
            .build()
        sse.connectionDidFail(Exception("Rate Limited"), response2, currentReqId)
        drainLoopers()
        
        // Max reconnection attempts (1) reached, stops scheduling and transitions to FAILED
        assertFalse(sse.isConnected())
        assertEquals(SseState.FAILED, sse.getState())
    }
}
