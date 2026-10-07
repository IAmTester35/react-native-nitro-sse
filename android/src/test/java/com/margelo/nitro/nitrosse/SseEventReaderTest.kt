package com.margelo.nitro.nitrosse

import okio.Buffer
import okio.buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Isolated unit tests for [SseEventReader] verifying WHATWG Server-Sent Events parsing rules:
 * UTF-8 BOM stripping, line terminators (LF, CR, CRLF), multi-line data concatenation,
 * comments, null-byte ID rejection, and retry directives.
 */
class SseEventReaderTest {

    private class RecordingCallback : SseEventReader.Callback {
        val events = mutableListOf<EventRecord>()
        val comments = mutableListOf<String>()
        val retries = mutableListOf<Long>()
        val idUpdates = mutableListOf<String?>()

        data class EventRecord(val id: String?, val type: String?, val data: String)

        override fun onEvent(id: String?, type: String?, data: String) {
            events.add(EventRecord(id, type, data))
        }

        override fun onComment(comment: String) {
            comments.add(comment)
        }

        override fun onRetryChange(retryMs: Long) {
            retries.add(retryMs)
        }

        override fun onIdUpdate(id: String?) {
            idUpdates.add(id)
        }
    }

    @Test
    fun testLeadingUtf8BomIsStripped() {
        val buffer = Buffer()
        // Write UTF-8 BOM bytes: 0xEF, 0xBB, 0xBF followed by SSE message
        buffer.write(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()))
        buffer.writeUtf8("data: hello world\n\n")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        assertTrue(reader.processNextEvent(callback))
        assertEquals(1, callback.events.size)
        assertEquals("hello world", callback.events[0].data)
    }

    @Test
    fun testStandardLineEndings() {
        val buffer = Buffer()
        buffer.writeUtf8("data: line1\r\ndata: line2\r\n\r\n")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        assertTrue(reader.processNextEvent(callback))
        assertEquals(1, callback.events.size)
        assertEquals("line1\nline2", callback.events[0].data)
    }

    @Test
    fun testBareCarriageReturnLineEndings() {
        val buffer = Buffer()
        buffer.writeUtf8("data: bare_cr\r\r")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        assertTrue(reader.processNextEvent(callback))
        assertEquals(1, callback.events.size)
        assertEquals("bare_cr", callback.events[0].data)
    }

    @Test
    fun testSplitCrlfAcrossChunks() {
        val buffer = Buffer()
        buffer.writeUtf8("data: split_crlf\r")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        // Read first line ending in \r at buffer boundary
        buffer.writeUtf8("\r") // Empty line terminator with bare CR
        assertTrue(reader.processNextEvent(callback))
        assertEquals(1, callback.events.size)
        assertEquals("split_crlf", callback.events[0].data)

        // Now next chunk arrives starting with \n from a split CRLF, followed by a new message
        buffer.writeUtf8("\ndata: next_msg\n\n")
        assertTrue(reader.processNextEvent(callback))
        assertEquals(2, callback.events.size)
        assertEquals("next_msg", callback.events[1].data)
    }

    @Test
    fun testEventFieldsAndId() {
        val buffer = Buffer()
        buffer.writeUtf8("id: 42\nevent: greeting\ndata: hi\n\n")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        assertTrue(reader.processNextEvent(callback))
        assertEquals(1, callback.events.size)
        assertEquals("42", callback.events[0].id)
        assertEquals("greeting", callback.events[0].type)
        assertEquals("hi", callback.events[0].data)
    }

    @Test
    fun testIdWithNullByteIsIgnored() {
        val buffer = Buffer()
        buffer.writeUtf8("id: invalid\u0000id\ndata: payload\n\n")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        assertTrue(reader.processNextEvent(callback))
        assertEquals(1, callback.events.size)
        assertNull(callback.events[0].id)
        assertEquals("payload", callback.events[0].data)
    }

    @Test
    fun testCommentsDispatchedSeparately() {
        val buffer = Buffer()
        buffer.writeUtf8(": keep-alive ping\ndata: actual data\n\n")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        // First event is the comment
        assertTrue(reader.processNextEvent(callback))
        assertEquals(1, callback.comments.size)
        assertEquals("keep-alive ping", callback.comments[0])
        assertEquals(0, callback.events.size)

        // Second event is the data message
        assertTrue(reader.processNextEvent(callback))
        assertEquals(1, callback.events.size)
        assertEquals("actual data", callback.events[0].data)
    }

    @Test
    fun testRetryDirectiveSetsIntervalAndPropagatesToEvent() {
        val buffer = Buffer()
        buffer.writeUtf8("retry: 4500\ndata: retry test\n\n")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        assertTrue(reader.processNextEvent(callback))
        assertEquals(listOf(4500L), callback.retries)
        assertEquals(1, callback.events.size)
        assertEquals("retry test", callback.events[0].data)

        // Next event without retry
        buffer.writeUtf8("data: next msg\n\n")
        assertTrue(reader.processNextEvent(callback))
        assertEquals(2, callback.events.size)
        assertEquals("next msg", callback.events[1].data)
    }

    @Test
    fun testMultiLineDataConcatenation() {
        val buffer = Buffer()
        buffer.writeUtf8("data: line 1\ndata: line 2\ndata: line 3\n\n")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        assertTrue(reader.processNextEvent(callback))
        assertEquals(1, callback.events.size)
        assertEquals("line 1\nline 2\nline 3", callback.events[0].data)
    }

    @Test
    fun testLeadingSingleSpaceTrimmedPerSpec() {
        val buffer = Buffer()
        // WHATWG SSE: If value starts with a single space, remove only that first space
        buffer.writeUtf8("data:  preserved leading space\n\n")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        assertTrue(reader.processNextEvent(callback))
        assertEquals(1, callback.events.size)
        assertEquals(" preserved leading space", callback.events[0].data)
    }

    @Test
    fun testChunkBoundaryAcrossNetworkReads() {
        val pipe = okio.Pipe(1024)
        val sink = pipe.sink
        val source = pipe.source.buffer()
        val reader = SseEventReader(source)
        val callback = RecordingCallback()

        // Write partial line across chunks
        val firstChunk = Buffer().writeUtf8("data: hel")
        sink.write(firstChunk, firstChunk.size)
        sink.flush()

        val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
        val future = executor.submit(java.util.concurrent.Callable {
            reader.processNextEvent(callback)
        })

        Thread.sleep(50)
        val secondChunk = Buffer().writeUtf8("lo\n\n")
        sink.write(secondChunk, secondChunk.size)
        sink.flush()
        sink.close()

        assertTrue(future.get(2, java.util.concurrent.TimeUnit.SECONDS))
        assertEquals(1, callback.events.size)
        assertEquals("hello", callback.events[0].data)
        executor.shutdown()
    }

    @Test
    fun testIdWithoutDataInvokesOnIdUpdate() {
        val buffer = Buffer()
        buffer.writeUtf8("id: checkpoint-999\n\n")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        // Line with only ID and no data should invoke onIdUpdate and not onEvent
        assertFalse(reader.processNextEvent(callback))
        assertEquals(0, callback.events.size)
        assertEquals(listOf("checkpoint-999"), callback.idUpdates)
    }

    @Test
    fun testStreamEndingAtEofWithoutTrailingEmptyLineDispatchesPendingEvent() {
        val buffer = Buffer()
        // Server sends data line without the second trailing empty line before closing
        buffer.writeUtf8("id: 101\nevent: final_event\ndata: last_payload\n")

        val reader = SseEventReader(buffer)
        val callback = RecordingCallback()

        // WHATWG SSE: EOF must flush and dispatch any pending data event
        assertTrue(reader.processNextEvent(callback))
        assertEquals(1, callback.events.size)
        assertEquals("101", callback.events[0].id)
        assertEquals("final_event", callback.events[0].type)
        assertEquals("last_payload", callback.events[0].data)

        // Subsequent call on exhausted source returns false
        assertFalse(reader.processNextEvent(callback))
    }
}


