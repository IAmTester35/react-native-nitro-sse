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
            if (isAtStartOfLine && b == ':'.toByte()) {
                heartbeatCount++
            }
            isAtStartOfLine = (b == '\n'.toByte() || b == '\r'.toByte())
        }
    }
}

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
        
        // Packet 1 ends right before heartbeat
        val p1 = "data: hello\n".toByteArray()
        scanner.scan(p1, p1.size)
        
        // Packet 2 starts with heartbeat
        val p2 = ":heartbeat\n".toByteArray()
        scanner.scan(p2, p2.size)
        
        assertEquals(1, scanner.heartbeatCount)
    }

    @Test
    fun testHeartbeatSplitAcrossPackets() {
        val scanner = HeartbeatScanner()
        
        // Packet 1 ends with newline
        val p1 = "data: hello\n".toByteArray()
        scanner.scan(p1, p1.size)
        
        // Packet 2 starts with ':' but no more
        val p2 = ":".toByteArray()
        scanner.scan(p2, p2.size)
        assertEquals(1, scanner.heartbeatCount)
        
        // Packet 3 contains the rest of comment
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
