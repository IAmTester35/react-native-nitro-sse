package com.margelo.nitro.nitrosse

import org.junit.Assert.assertEquals
import org.junit.Test

class HeartbeatScanner {
    private var isAtStartOfLine = true
    var heartbeatCount = 0
        private set

    fun scan(bytes: ByteArray, length: Int) {
        for (i in 0 until length) {
            val b = bytes[i]
            if (isAtStartOfLine && b == ':'.code.toByte()) {
                heartbeatCount++
            }
            isAtStartOfLine = (b == '\n'.code.toByte() || b == '\r'.code.toByte())
        }
    }
}

/**
 * Unit tests verifying raw byte stream scanning logic for SSE keep-alive comments (`:`).
 * Tests parsing behavior across arbitrary TCP packet boundaries and chunked transfer encodings.
 */
class HeartbeatScannerTest {

    @Test
    fun testNormalHeartbeat() {
        val scanner = HeartbeatScanner()
        val data = ":heartbeat\n".toByteArray()
        scanner.scan(data, data.size)
        assertEquals(1, scanner.heartbeatCount)
    }

    @Test
    fun testHeartbeatAfterNewline() {
        val scanner = HeartbeatScanner()
        val data = "data: hello\n:heartbeat\n".toByteArray()
        scanner.scan(data, data.size)
        assertEquals(1, scanner.heartbeatCount)
    }

    @Test
    fun testSplitPacketHeartbeat() {
        val scanner = HeartbeatScanner()
        
        // Packet 1 ends on newline boundary immediately prior to heartbeat line
        val p1 = "data: hello\n".toByteArray()
        scanner.scan(p1, p1.size)
        
        // Packet 2 begins with SSE comment colon prefix
        val p2 = ":heartbeat\n".toByteArray()
        scanner.scan(p2, p2.size)
        
        assertEquals(1, scanner.heartbeatCount)
    }

    @Test
    fun testHeartbeatSplitAcrossPackets() {
        val scanner = HeartbeatScanner()
        
        // Packet 1 ends on newline boundary
        val p1 = "data: hello\n".toByteArray()
        scanner.scan(p1, p1.size)
        
        // Packet 2 receives colon character on initial byte
        val p2 = ":".toByteArray()
        scanner.scan(p2, p2.size)
        assertEquals(1, scanner.heartbeatCount)
        
        // Packet 3 receives remainder of comment body and newline without double-counting
        val p3 = "heartbeat\n".toByteArray()
        scanner.scan(p3, p3.size)
        
        assertEquals(1, scanner.heartbeatCount)
    }

    @Test
    fun testColonsInDataAreNotHeartbeats() {
        val scanner = HeartbeatScanner()
        val data = "data: something:with:colons\n".toByteArray()
        scanner.scan(data, data.size)
        assertEquals(0, scanner.heartbeatCount)
    }

    @Test
    fun testMultipleHeartbeats() {
        val scanner = HeartbeatScanner()
        val data = ":h1\n:h2\n\n:h3\n".toByteArray()
        scanner.scan(data, data.size)
        assertEquals(3, scanner.heartbeatCount)
    }

    @Test
    fun testCRLFHeartbeat() {
        val scanner = HeartbeatScanner()
        val data = "data: ok\r\n:heartbeat\r\n".toByteArray()
        scanner.scan(data, data.size)
        assertEquals(1, scanner.heartbeatCount)
    }
}
