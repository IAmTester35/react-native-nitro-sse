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
        
        // Unhandled 429 without Retry-After header fails fast to avoid aggressive retry loops
        assertFalse(sse.isConnected())
        assertEquals(SseState.FAILED, sse.getState())
    }
}
