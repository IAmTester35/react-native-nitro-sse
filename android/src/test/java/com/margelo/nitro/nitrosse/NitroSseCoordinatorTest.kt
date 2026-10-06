package com.margelo.nitro.nitrosse

import android.os.Build
import android.os.Looper
import com.facebook.soloader.SoLoader
import com.margelo.nitro.core.Promise
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    private val TEST_URL = "http://localhost:33333/events"

    private fun createMockConfig(): SseConfig {
        return SseConfig(
            TEST_URL,
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
            null
        )
    }

    private fun createResponse(code: Int, message: String, contentType: String? = null): Response {
        val request = Request.Builder().url(TEST_URL).build()
        val builder = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(message)
            .body("".toResponseBody(null))
        if (contentType != null) {
            builder.header("Content-Type", contentType)
        }
        return builder.build()
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
        
        // 4. Push heartbeat comment via connectionDidReceiveComment
        sse.connectionDidReceiveComment("keepalive-text-payload", actualReqId)
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
        
        // Simulates stale RID mismatch: heartbeat should not be pushed
        val staleRid = "stale-rid-999"
        sse.connectionDidReceiveComment("keep-alive", staleRid)
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

    @Test
    fun testEmptyIdResetsLastProcessedId() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        sse.setup(config) { _ -> }
        drainLoopers()
        
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val currentReqId = reqIdField.get(sse) as String
        
        val lastIdField = NitroSse::class.java.getDeclaredField("lastProcessedId")
        lastIdField.isAccessible = true
        
        // 1. Receive event with id "event-1"
        sse.connectionDidReceiveMessage("event-1", "message", "hello", currentReqId)
        drainLoopers()
        assertEquals("event-1", lastIdField.get(sse))
        
        // 2. Receive event with empty id -> resets to null per WHATWG SSE spec
        sse.connectionDidReceiveMessage("", "message", "world", currentReqId)
        drainLoopers()
        assertNull(lastIdField.get(sse))
        
        // 3. Receive event with null id -> maintains previous state (null)
        sse.connectionDidReceiveMessage(null, "message", "test", currentReqId)
        drainLoopers()
        assertNull(lastIdField.get(sse))
        
        // 4. Receive event with new id -> sets new id
        sse.connectionDidReceiveMessage("event-2", "message", "foo", currentReqId)
        drainLoopers()
        assertEquals("event-2", lastIdField.get(sse))
    }

    @Test
    fun testUpdateHeadersMergesWithExistingHeaders() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig().copy(headers = mapOf("X-Initial" to "1", "Authorization" to "old"))
        
        sse.setup(config) { _ -> }
        drainLoopers()
        
        sse.updateHeaders(mapOf("Authorization" to "new", "Tenant" to "tenant-1"))
        drainLoopers()
        
        val configField = NitroSse::class.java.getDeclaredField("config")
        configField.isAccessible = true
        val currentConfig = configField.get(sse) as SseConfig
        
        assertEquals("1", currentConfig.headers?.get("X-Initial"))
        assertEquals("new", currentConfig.headers?.get("Authorization"))
        assertEquals("tenant-1", currentConfig.headers?.get("Tenant"))
    }

    @Test
    fun testLogicalBytesReceivedAccounting() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        
        sse.setup(config) { _ -> }
        drainLoopers()

        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        val currentReqId = reqIdField.get(sse) as String
        
        assertEquals(0.0, sse.getStats().totalBytesReceived, 0.001)
        
        // 1. Push message with data (12 B), id (4 B), type (6 B) -> total 22 B
        sse.connectionDidReceiveMessage("id-1", "custom", "payload-data", currentReqId)
        drainLoopers()
        
        assertEquals(22.0, sse.getStats().totalBytesReceived, 0.001)

        // 2. Push default message with type="message" and retained id="id-1" -> only data (5 B)
        sse.connectionDidReceiveMessage("id-1", "message", "hello", currentReqId)
        drainLoopers()

        assertEquals(27.0, sse.getStats().totalBytesReceived, 0.001)

        // 3. Push message with a newly updated id ("id-2" = 4 B) and default type="message" -> 4 B (new id) + 5 B (data) = 9 B
        sse.connectionDidReceiveMessage("id-2", "message", "world", currentReqId)
        drainLoopers()

        assertEquals(36.0, sse.getStats().totalBytesReceived, 0.001)

        // 4. Push heartbeat comment ("ping" = 4 B) via connectionDidReceiveComment
        sse.connectionDidReceiveComment("ping", currentReqId)
        drainLoopers()

        assertEquals(40.0, sse.getStats().totalBytesReceived, 0.001)

        // 5. Push message with empty id ("" = 0 B) resetting lastProcessedId per WHATWG SSE -> only data (5 B)
        sse.connectionDidReceiveMessage("", "message", "reset", currentReqId)
        drainLoopers()

        assertEquals(45.0, sse.getStats().totalBytesReceived, 0.001)

        // 6. Push message re-using "id-2" (4 B) after reset -> counts as new id because lastProcessedId was cleared -> 4 B + 5 B = 9 B
        sse.connectionDidReceiveMessage("id-2", "message", "after", currentReqId)
        drainLoopers()

        assertEquals(54.0, sse.getStats().totalBytesReceived, 0.001)

        // 7. Push message with null id and null type -> only data (6 B)
        sse.connectionDidReceiveMessage(null, null, "nullid", currentReqId)
        drainLoopers()

        assertEquals(60.0, sse.getStats().totalBytesReceived, 0.001)
    }

    private fun <T> anyLambda(): T {
        org.mockito.Mockito.any<T>()
        @Suppress("UNCHECKED_CAST")
        return { _: Any? -> } as T
    }

    @Test
    fun testOnBeforeRequestHeadersDoNotMutateBaseConfig() {
        val sse = NitroSse(dispatcher)
        val initialHeaders = mapOf("X-Base" to "base-val")
        val config = createMockConfig().copy(headers = initialHeaders)
        
        @Suppress("UNCHECKED_CAST")
        val p1 = org.mockito.Mockito.mock(Promise::class.java) as Promise<Promise<Map<String, String>>>
        @Suppress("UNCHECKED_CAST")
        val p2 = org.mockito.Mockito.mock(Promise::class.java) as Promise<Map<String, String>>
        
        org.mockito.Mockito.`when`(p1.then(anyLambda())).thenAnswer { invocation ->
            @Suppress("UNCHECKED_CAST")
            val cb = invocation.getArgument<(Promise<Map<String, String>>) -> Unit>(0)
            cb(p2)
            p1
        }
        org.mockito.Mockito.`when`(p1.catch(anyLambda())).thenReturn(p1)

        org.mockito.Mockito.`when`(p2.then(anyLambda())).thenAnswer { invocation ->
            @Suppress("UNCHECKED_CAST")
            val cb = invocation.getArgument<(Map<String, String>) -> Unit>(0)
            cb(mapOf("Authorization" to "Bearer dynamic-token", "X-Temp" to "temp-val"))
            p2
        }
        org.mockito.Mockito.`when`(p2.catch(anyLambda())).thenReturn(p2)
        
        val interceptor = { p1 }
        sse.setup(config, { _ -> }, interceptor)
        drainLoopers()
        
        sse.start()
        drainLoopers()
        
        val configField = NitroSse::class.java.getDeclaredField("config")
        configField.isAccessible = true
        val storedConfig = configField.get(sse) as SseConfig
        
        // Base config headers should remain strictly untouched
        assertEquals(mapOf("X-Base" to "base-val"), storedConfig.headers)
        assertFalse(storedConfig.headers?.containsKey("Authorization") == true)
        assertFalse(storedConfig.headers?.containsKey("X-Temp") == true)
        
        sse.stop()
        drainLoopers()
    }

    @Test
    fun testCoordinatorRetriesUpToMaxAuthRetries() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig().copy(maxAuthRetries = 3.0, maxReconnectAttempts = 10.0)
        
        @Suppress("UNCHECKED_CAST")
        val p1 = org.mockito.Mockito.mock(Promise::class.java) as Promise<Promise<Map<String, String>>>
        val interceptor = { p1 }
        
        sse.setup(config, { _ -> }, interceptor)
        drainLoopers()
        
        sse.start()
        drainLoopers()
        
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true

        val errorResponse = createResponse(401, "Unauthorized")
        
        // 1st error -> Retry 1
        reqIdField.set(sse, "test-req-id")
        sse.connectionDidFail(Exception("Auth Error 1"), errorResponse, "test-req-id")
        drainLoopers()
        assertEquals(SseState.RECONNECTING, sse.getState())
        
        // 2nd error -> Retry 2
        reqIdField.set(sse, "test-req-id")
        sse.connectionDidFail(Exception("Auth Error 2"), errorResponse, "test-req-id")
        drainLoopers()
        assertEquals(SseState.RECONNECTING, sse.getState())
        
        // 3rd error -> Retry 3 (MUST still be RECONNECTING because maxAuthRetries=3 allows 3 retries)
        reqIdField.set(sse, "test-req-id")
        sse.connectionDidFail(Exception("Auth Error 3"), errorResponse, "test-req-id")
        drainLoopers()
        assertEquals(SseState.RECONNECTING, sse.getState())
        
        // 4th error -> Exceeded 3 retries, now FAILED
        reqIdField.set(sse, "test-req-id")
        sse.connectionDidFail(Exception("Auth Error 4"), errorResponse, "test-req-id")
        drainLoopers()
        assertEquals(SseState.FAILED, sse.getState())
        
        sse.stop()
        drainLoopers()
    }

    @Test
    fun testStopThenImmediateStartPreservesConnectingState() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        sse.setup(config) { _ -> }
        drainLoopers()

        // 1. Start client
        sse.start()
        drainLoopers()
        assertTrue("Client should be running", sse.isConnected())
        assertEquals(SseState.CONNECTING, sse.getState())

        // 2. Caller thread calls stop() then immediately start() (e.g. React component re-render)
        sse.stop()
        sse.start()

        // 3. Process dispatcher queue
        drainLoopers()

        assertTrue("Client should remain connected after stop() then immediate start()", sse.isConnected())
        assertEquals("State should be CONNECTING after stop() then immediate start()", SseState.CONNECTING, sse.getState())

        sse.stop()
        drainLoopers()
    }

    @Test
    fun testOkHttpClientDispatcherShutdownOnDispose() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        sse.setup(config) { _ -> }
        drainLoopers()

        val clientField = NitroSse::class.java.getDeclaredField("client").apply { isAccessible = true }
        val okHttpClient = clientField.get(sse) as okhttp3.OkHttpClient

        assertFalse(okHttpClient.dispatcher.executorService.isShutdown)

        sse.dispose()

        assertTrue("OkHttpClient Dispatcher executorService must be shutdown on dispose()", okHttpClient.dispatcher.executorService.isShutdown)
    }

    @Test
    fun testConsecutiveAuthErrorsHaltAfterMaxRetriesOnInterceptorException() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig().copy(
            maxAuthRetries = 2.0,
            maxReconnectAttempts = -1.0
        )

        val failingInterceptor: () -> com.margelo.nitro.core.Promise<com.margelo.nitro.core.Promise<Map<String, String>>> = {
            throw RuntimeException("Refresh token permanently revoked")
        }

        sse.setup(config, { _ -> }, failingInterceptor)
        drainLoopers()

        sse.start()
        drainLoopers()

        val authErrorsField = NitroSse::class.java.getDeclaredField("consecutiveAuthErrors").apply { isAccessible = true }
        val consecutiveAuth = authErrorsField.get(sse) as java.util.concurrent.atomic.AtomicInteger

        // Advance through multiple reconnect cycles
        for (i in 1..5) {
            dispatcher.advanceTimeBy(35000)
            drainLoopers()
        }

        assertEquals("consecutiveAuthErrors must halt at maxAuthRetries + 1 (3 attempts)", 3, consecutiveAuth.get())
        assertEquals("Client must transition to FAILED once maxAuthRetries is exceeded", SseState.FAILED, sse.getState())

        sse.stop()
        drainLoopers()
    }

    @Test
    fun testStopCancelsSocketImmediatelyEvenWhenDispatcherQueued() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()

        sse.setup(config) { _ -> }
        drainLoopers()

        sse.start()
        drainLoopers()

        val executedTasks = mutableListOf<Int>()
        for (i in 1..10) {
            dispatcher.post { executedTasks.add(i) }
        }

        sse.stop()

        assertFalse("isRunning must be false immediately after stop() returns to caller", sse.isConnected())

        drainLoopers()
        assertFalse(sse.isConnected())
        assertEquals(10, executedTasks.size)
    }

    @Test
    fun testCoordinatorCapturesBoundedErrorBodyOnFatalError() {
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

        val errorResponse = createResponse(400, "Bad Request")
        val jsonErrorBody = "{\"error\":\"invalid_param\",\"field\":\"user_id\"}"
        sse.connectionDidFail(Exception("Bad Request"), errorResponse, jsonErrorBody, actualReqId)
        drainLoopers()

        assertFalse(sse.isConnected())
        assertEquals(SseState.FAILED, sse.getState())

        val errorEvent = emittedEvents.find { it.type == SseEventType.ERROR }
        assertNotNull(errorEvent)
        assertEquals(400.0, errorEvent?.statusCode)
        assertEquals("Fatal Error (400): $jsonErrorBody", errorEvent?.message)
    }

    @Test
    fun testCoordinatorMasksHtmlErrorBody() {
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
        val htmlBody = "<html><body><h1>404 Not Found</h1><p>Cloudflare</p></body></html>"
        sse.connectionDidFail(Exception("Not Found"), errorResponse, htmlBody, actualReqId)
        drainLoopers()

        assertFalse(sse.isConnected())
        assertEquals(SseState.FAILED, sse.getState())

        val errorEvent = emittedEvents.find { it.type == SseEventType.ERROR }
        assertNotNull(errorEvent)
        assertEquals("Fatal Error (404): $htmlBody", errorEvent?.message)
    }

    @Test
    fun testCoordinatorStrictContentTypeCaptivePortalFatalNoReconnect() {
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

        // Captive portal returns 200 OK with text/html
        val captivePortalResponse = createResponse(200, "OK", "text/html; charset=UTF-8")
        val invalidContentTypeErr = InvalidContentTypeException("Invalid Content-Type: expected text/event-stream but received 'text/html; charset=UTF-8'")
        sse.connectionDidFail(invalidContentTypeErr, captivePortalResponse, null, actualReqId)
        drainLoopers()

        assertFalse("Client must not remain connected", sse.isConnected())
        assertEquals("Client must permanently transition to FAILED state", SseState.FAILED, sse.getState())

        val errorEvent = emittedEvents.find { it.type == SseEventType.ERROR }
        assertNotNull(errorEvent)
        assertTrue("Error message must indicate invalid content type", errorEvent?.message?.contains("Invalid Content-Type") == true)

        // Advance virtual time by 60 seconds: verify no reconnect task was scheduled
        dispatcher.advanceTimeBy(60000)
        drainLoopers()
        assertEquals("Client must remain FAILED and not reconnect", SseState.FAILED, sse.getState())
    }

    @Test
    fun testLastProcessedIdUpdatesDynamicallyOnMessage() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        sse.setup(config) { _ -> }
        drainLoopers()

        val lastIdField = NitroSse::class.java.getDeclaredField("lastProcessedId").apply { isAccessible = true }
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId").apply { isAccessible = true }
        val currentReqId = "mock-req-id"
        reqIdField.set(sse, currentReqId)

        // Initial setup has no Last-Event-ID
        assertNull(lastIdField.get(sse))

        // 1. Receive event with id="evt-100"
        sse.connectionDidReceiveMessage("evt-100", "message", "payload", currentReqId)
        drainLoopers()
        assertEquals("evt-100", lastIdField.get(sse))

        // 2. Receive event with null id -> retains previous id per WHATWG SSE spec
        sse.connectionDidReceiveMessage(null, "message", "payload2", currentReqId)
        drainLoopers()
        assertEquals("evt-100", lastIdField.get(sse))

        // 3. Receive event with id="evt-101" -> updates to new id
        sse.connectionDidReceiveMessage("evt-101", "message", "payload3", currentReqId)
        drainLoopers()
        assertEquals("evt-101", lastIdField.get(sse))

        // 4. Receive event with empty id="" -> resets lastProcessedId to null per WHATWG SSE spec
        sse.connectionDidReceiveMessage("", "message", "reset", currentReqId)
        drainLoopers()
        assertNull(lastIdField.get(sse))

        sse.stop()
        drainLoopers()
    }

    @Test
    fun testCoordinatorPreservesLastEventIdFromIdUpdateWithoutData() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        sse.setup(config, { _ -> })
        drainLoopers()

        sse.start()
        drainLoopers()

        val lastIdField = NitroSse::class.java.getDeclaredField("lastProcessedId").apply { isAccessible = true }
        val reqIdField = NitroSse::class.java.getDeclaredField("requestId").apply { isAccessible = true }
        val currentReqId = reqIdField.get(sse) as String

        // Initial setup has no Last-Event-ID
        assertNull(lastIdField.get(sse))

        // 1. Server sends id: 456 without data field -> connectionDidUpdateLastEventId called
        sse.connectionDidUpdateLastEventId("456", currentReqId)
        drainLoopers()
        assertEquals("456", lastIdField.get(sse))

        // 2. Empty or null id resets lastProcessedId per WHATWG SSE spec
        sse.connectionDidUpdateLastEventId(null, currentReqId)
        drainLoopers()
        assertNull(lastIdField.get(sse))

        // 3. Set new id again
        sse.connectionDidUpdateLastEventId("789", currentReqId)
        drainLoopers()
        assertEquals("789", lastIdField.get(sse))

        sse.stop()
        drainLoopers()
    }

    @Test
    fun testNullReturningInterceptorFailsFastSynchronously() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        val emittedEvents = mutableListOf<SseEvent>()

        @Suppress("UNCHECKED_CAST")
        val p1 = org.mockito.Mockito.mock(Promise::class.java) as Promise<Promise<Map<String, String>>>

        org.mockito.Mockito.`when`(p1.then(anyLambda())).thenAnswer { invocation ->
            @Suppress("UNCHECKED_CAST")
            val cb = invocation.getArgument<(Promise<Map<String, String>>?) -> Unit>(0)
            cb(null) // promise2 is null
            p1
        }
        org.mockito.Mockito.`when`(p1.catch(anyLambda())).thenReturn(p1)

        val interceptor = { p1 }
        sse.setup(config, { events -> emittedEvents.addAll(events) }, interceptor)
        drainLoopers()

        sse.start()
        drainLoopers()

        // Kotlin non-null type check catches null synchronously and routes through catch(e: Throwable),
        // failing fast instead of hanging silently.
        val errorEvent = emittedEvents.find { it.type == SseEventType.ERROR }
        assertNotNull("Error must be emitted immediately upon null interceptor parameter", errorEvent)
        assertTrue(errorEvent?.message?.contains("Interceptor Error") == true)

        sse.stop()
        drainLoopers()
    }

    @Test
    fun testComprehensiveMetricsTracking() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        sse.setup(config) { _ -> }
        drainLoopers()

        // Initial stats check
        val initialStats = sse.getStats()
        assertEquals(0.0, initialStats.rawBytesReceived, 0.0)
        assertEquals(0.0, initialStats.totalBytesReceived, 0.0)
        assertEquals(0.0, initialStats.chunksReceived, 0.0)
        assertEquals(0.0, initialStats.totalEventsReceived, 0.0)
        assertEquals(0.0, initialStats.commentsReceived, 0.0)
        assertEquals(0.0, initialStats.linesParsed, 0.0)
        assertEquals(0.0, initialStats.parseErrors, 0.0)
        assertEquals(0.0, initialStats.connectionAttempts, 0.0)
        assertEquals(0.0, initialStats.reconnectCount, 0.0)
        assertNull(initialStats.connectedAt)
        assertNull(initialStats.lastStatusCode)
        assertNull(initialStats.serverRetryDelayMs)
        assertNull(initialStats.timeToFirstByteMs)
        assertNull(initialStats.disconnectReason)

        // Start connection
        sse.start()
        drainLoopers()

        val reqIdField = NitroSse::class.java.getDeclaredField("requestId").apply { isAccessible = true }
        val currentReqId = reqIdField.get(sse) as String

        val eventSourceField = NitroSse::class.java.getDeclaredField("eventSource").apply { isAccessible = true }
        (eventSourceField.get(sse) as? SseEventSource)?.cancel()

        var stats = sse.getStats()
        assertEquals(1.0, stats.connectionAttempts, 0.0)

        // 1. Connection DidOpen
        val openResponse = createResponse(200, "OK", "text/event-stream")
        sse.connectionDidOpen(openResponse, currentReqId)
        drainLoopers()

        stats = sse.getStats()
        assertEquals(200.0, stats.lastStatusCode ?: 0.0, 0.0)
        assertNotNull(stats.connectedAt)

        // 2. Data chunk received
        sse.connectionDidReceiveDataChunk(128L, currentReqId)
        drainLoopers()

        stats = sse.getStats()
        assertEquals(1.0, stats.chunksReceived, 0.0)
        assertEquals(128.0, stats.rawBytesReceived, 0.0)
        assertNotNull(stats.timeToFirstByteMs)

        // 3. Lines parsed
        sse.connectionDidParseLines(4, currentReqId)
        drainLoopers()

        stats = sse.getStats()
        assertEquals(4.0, stats.linesParsed, 0.0)

        // 4. Message received
        sse.connectionDidReceiveMessage("evt-1", "message", "Hello World", currentReqId)
        drainLoopers()

        stats = sse.getStats()
        assertEquals(1.0, stats.totalEventsReceived, 0.0)
        assertNotNull(stats.lastEventTime)
        assertTrue(stats.totalBytesReceived > 0.0)

        // 5. Comment (heartbeat) received
        sse.connectionDidReceiveComment("keepalive", currentReqId)
        drainLoopers()

        stats = sse.getStats()
        assertEquals(1.0, stats.commentsReceived, 0.0)
        assertNotNull(stats.lastHeartbeatTime)
        assertTrue(stats.maxEventGapMs >= 0.0)

        // 6. Server retry delay received
        sse.connectionDidReceiveRetry(5000L, currentReqId)
        drainLoopers()

        stats = sse.getStats()
        assertEquals(5000.0, stats.serverRetryDelayMs ?: 0.0, 0.0)

        // 7. Parse error
        sse.connectionDidEncounterParseError(currentReqId)
        drainLoopers()

        stats = sse.getStats()
        assertEquals(1.0, stats.parseErrors, 0.0)
        assertEquals(SseDisconnectReason.PARSER_ERROR, stats.disconnectReason)

        // 8. Buffer flushes
        sse.flush()
        drainLoopers()

        stats = sse.getStats()
        assertTrue("Buffer flush count should be > 0", stats.bufferFlushCount > 0.0)

        // 9. Stop by user
        sse.stop()
        drainLoopers()

        stats = sse.getStats()
        assertEquals(SseDisconnectReason.USER_STOP, stats.disconnectReason)
        assertNull(stats.connectedAt)
    }

    @Test
    fun testDisconnectReasonsMetrics() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig()
        sse.setup(config) { _ -> }
        drainLoopers()

        val reqIdField = NitroSse::class.java.getDeclaredField("requestId").apply { isAccessible = true }

        // Test 1: Server Error (500)
        sse.start()
        drainLoopers()
        var currentReqId = reqIdField.get(sse) as String
        val resp500 = createResponse(500, "Internal Server Error", "text/plain")
        sse.connectionDidFail(Exception("Server down"), resp500, "Server down", currentReqId)
        drainLoopers()

        var stats = sse.getStats()
        assertEquals(SseDisconnectReason.SERVER_ERROR, stats.disconnectReason)
        assertEquals(500.0, stats.lastStatusCode ?: 0.0, 0.0)
        assertNotNull(stats.lastErrorTime)
        assertNotNull(stats.lastReconnectDelayMs)

        // Test 2: Timeout
        sse.start()
        drainLoopers()
        currentReqId = reqIdField.get(sse) as String
        sse.connectionDidFail(java.net.SocketTimeoutException("Read timed out"), null, null, currentReqId)
        drainLoopers()

        stats = sse.getStats()
        assertEquals(SseDisconnectReason.TIMEOUT, stats.disconnectReason)

        // Test 3: Network Error
        sse.start()
        drainLoopers()
        currentReqId = reqIdField.get(sse) as String
        sse.connectionDidFail(java.net.ConnectException("Connection refused"), null, null, currentReqId)
        drainLoopers()

        stats = sse.getStats()
        assertEquals(SseDisconnectReason.NETWORK_ERROR, stats.disconnectReason)

        // Test 4: Reconnect count increments when moving from RECONNECTING to OPEN
        assertEquals(SseState.RECONNECTING, sse.getState())
        dispatcher.advanceTimeBy(35000)
        drainLoopers()

        currentReqId = reqIdField.get(sse) as String
        val resp200 = createResponse(200, "OK", "text/event-stream")
        sse.connectionDidOpen(resp200, currentReqId)
        drainLoopers()

        stats = sse.getStats()
        assertEquals(1.0, stats.reconnectCount, 0.0)
        assertEquals(SseState.OPEN, sse.getState())

        sse.stop()
        drainLoopers()
    }

    @Test
    fun testRawBytesAccumulatesAcrossReconnections() {
        val sse = NitroSse(dispatcher)
        val config = createMockConfig().copy(batchingIntervalMs = 0.0, retryIntervalMs = 1000.0, jitterFactor = 0.0)

        sse.setup(config) {}
        drainLoopers()

        sse.start()
        drainLoopers()

        val reqIdField = NitroSse::class.java.getDeclaredField("requestId")
        reqIdField.isAccessible = true
        var currentReqId = reqIdField.get(sse) as String

        // Attempt 1 receives 150 bytes, then fails with 500
        sse.connectionDidReceiveDataChunk(150L, currentReqId)
        val resp500 = createResponse(500, "Internal Server Error", "text/plain")
        sse.connectionDidFail(null, resp500, null, currentReqId)
        drainLoopers()

        var stats = sse.getStats()
        assertEquals(150.0, stats.rawBytesReceived, 0.0)

        // Attempt 2 reconnects, receives 200 bytes
        dispatcher.advanceTimeBy(1500)
        drainLoopers()
        currentReqId = reqIdField.get(sse) as String
        sse.connectionDidReceiveDataChunk(200L, currentReqId)
        drainLoopers()

        stats = sse.getStats()
        assertEquals(350.0, stats.rawBytesReceived, 0.0)

        sse.stop()
        drainLoopers()
    }
}

