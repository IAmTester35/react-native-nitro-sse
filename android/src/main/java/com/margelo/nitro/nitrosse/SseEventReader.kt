package com.margelo.nitro.nitrosse

import okio.BufferedSource
import okio.ByteString
import java.io.IOException

/**
 * Maximum bytes allowed for a single SSE line to prevent Out-Of-Memory errors.
 */
const val MAX_SSE_LINE_LENGTH = 16 * 1024 * 1024L

/**
 * Maximum characters allowed for accumulated event data to prevent Out-Of-Memory errors.
 */
const val MAX_SSE_EVENT_DATA_SIZE = 16 * 1024 * 1024

/**
 * CRLF delimiter byte sequence (\r, \n) used for optimized line break scanning.
 */
private val CRLF_DELIMITERS = ByteString.of('\r'.code.toByte(), '\n'.code.toByte())

private const val UTF8_BOM_LENGTH = 3L
private const val BOM_BYTE_0: Byte = 0xEF.toByte()
private const val BOM_BYTE_1: Byte = 0xBB.toByte()
private const val BOM_BYTE_2: Byte = 0xBF.toByte()

/**
 * Exception indicating an SSE parser resource limit violation (line length or accumulated event data size).
 * Typed counterpart of iOS NitroSse error codes -2002 / -2003; treated as fatal (no reconnect).
 */
internal class SseParserLimitException(override val message: String) : IOException(message)

private fun parseFieldPair(line: String): Pair<String, String> {
    val colonIndex = line.indexOf(':')
    if (colonIndex == -1) return line to ""
    val field = line.substring(0, colonIndex)
    val hasLeadingSpace = colonIndex + 1 < line.length && line[colonIndex + 1] == ' '
    val valueStart = if (hasLeadingSpace) colonIndex + 2 else colonIndex + 1
    val value = line.substring(valueStart)
    return field to value
}

/**
 * Sequential line-by-line SSE parser complying with WHATWG Server-Sent Events specification.
 * Ensures strict chronological ordering between data messages, comments, and directives.
 */
internal class SseEventReader(private val source: BufferedSource) {
    interface Callback {
        fun onEvent(id: String?, type: String?, data: String)
        fun onComment(comment: String)
        fun onRetryChange(retryMs: Long)
        fun onIdUpdate(id: String?) {}
        fun onLinesParsed(count: Int) {}
    }

    private val dataBuffer = StringBuilder()
    private var hasData = false
    private var eventType: String? = null
    private var lastEventId: String? = null
    private var lastEventIdBuffer: String? = null
    private var idUpdatedInCurrentEvent = false
    private var isAtStreamStart = true
    private var skipLeadingLf = false

    private fun prepareBufferForRead(buffer: okio.Buffer) {
        if (isAtStreamStart) {
            val hasBom = source.request(UTF8_BOM_LENGTH) &&
                buffer[0] == BOM_BYTE_0 &&
                buffer[1] == BOM_BYTE_1 &&
                buffer[2] == BOM_BYTE_2
            if (hasBom) {
                buffer.skip(UTF8_BOM_LENGTH)
            }
            isAtStreamStart = false
        } else if (skipLeadingLf) {
            skipLeadingLf = false
            if (buffer[0] == '\n'.code.toByte()) {
                buffer.skip(1)
            }
        }
    }

    private fun consumeLineAtIndex(buffer: okio.Buffer, newlineIndex: Long): String {
        if (newlineIndex > MAX_SSE_LINE_LENGTH) {
            throw SseParserLimitException("SSE line exceeded maximum limit of $MAX_SSE_LINE_LENGTH bytes")
        }
        val delimiterByte = buffer[newlineIndex]
        val line = buffer.readUtf8(newlineIndex)
        buffer.skip(1)
        if (delimiterByte == '\r'.code.toByte()) {
            // If followed immediately by \n in current buffer, consume \n as CRLF.
            // If buffer is exhausted, defer check via skipLeadingLf to avoid blocking on bare CR.
            if (buffer.size > 0) {
                if (buffer[0] == '\n'.code.toByte()) {
                    buffer.skip(1)
                }
            } else {
                skipLeadingLf = true
            }
        }
        return line
    }

    private fun findOrReadLine(buffer: okio.Buffer): String? {
        var scanned = 0L
        var newlineIndex = buffer.indexOfElement(CRLF_DELIMITERS, scanned)
        while (newlineIndex == -1L) {
            if (buffer.size > MAX_SSE_LINE_LENGTH) {
                throw SseParserLimitException("SSE line exceeded maximum limit of $MAX_SSE_LINE_LENGTH bytes")
            }
            scanned = buffer.size
            if (!source.request(buffer.size + 1)) {
                return if (buffer.size > 0) buffer.readUtf8() else null
            }
            newlineIndex = buffer.indexOfElement(CRLF_DELIMITERS, scanned)
        }
        return consumeLineAtIndex(buffer, newlineIndex)
    }

    /**
     * Reads a line from [source] handling CRLF (\r\n), bare CR (\r), and LF (\n).
     * Strips leading UTF-8 BOM (0xEF, 0xBB, 0xBF) if present at stream start per WHATWG SSE spec.
     * Operates on [BufferedSource.buffer] using hardware-accelerated [Buffer.indexOfElement] to locate
     * line endings without byte-by-byte Kotlin loop overhead while properly supporting bare carriage returns.
     */
    private fun readSseLine(): String? {
        if (source.exhausted()) return null
        val buffer = source.buffer
        prepareBufferForRead(buffer)
        return findOrReadLine(buffer)
    }

    private fun handleEof(linesParsedInEvent: Int, callback: Callback) {
        if (linesParsedInEvent > 0) {
            callback.onLinesParsed(linesParsedInEvent)
        }
        dataBuffer.setLength(0)
        hasData = false
        eventType = null
        lastEventIdBuffer = lastEventId
        idUpdatedInCurrentEvent = false
    }

    private fun handleEmptyLine(linesParsedInEvent: Int, callback: Callback): Boolean {
        if (idUpdatedInCurrentEvent) {
            lastEventId = lastEventIdBuffer
            idUpdatedInCurrentEvent = false
            callback.onIdUpdate(lastEventId)
        }
        if (hasData) {
            callback.onLinesParsed(linesParsedInEvent)
            val data = dataBuffer.toString()
            val id = lastEventId
            val type = eventType
            dataBuffer.setLength(0)
            hasData = false
            eventType = null
            callback.onEvent(id, type, data)
            return true
        }
        // WHATWG SSE: Dispatching an empty event still resets the event type buffer
        eventType = null
        return false
    }

    private fun appendDataField(value: String) {
        // Account for the '\n' joining this line to the previous ones (parity with iOS / TypeScript).
        val separatorSize = if (hasData) 1 else 0
        if (dataBuffer.length + separatorSize + value.length > MAX_SSE_EVENT_DATA_SIZE) {
            throw SseParserLimitException(
                "SSE event data exceeded maximum limit of $MAX_SSE_EVENT_DATA_SIZE characters"
            )
        }
        if (hasData) {
            dataBuffer.append('\n')
        }
        dataBuffer.append(value)
        hasData = true
    }

    private fun handleFieldLine(line: String, callback: Callback) {
        val (field, value) = parseFieldPair(line)
        when (field) {
            "data" -> appendDataField(value)
            "id" -> if (!value.contains('\u0000')) {
                lastEventIdBuffer = if (value.isEmpty()) null else value
                idUpdatedInCurrentEvent = true
            }
            "event" -> eventType = if (value.isEmpty()) null else value
            "retry" -> if (value.isNotEmpty() && value.all { it in '0'..'9' }) {
                // WHATWG SSE: If field value consists solely of ASCII digits 0-9, set reconnection time.
                value.toLongOrNull()?.let { callback.onRetryChange(it) }
            }
        }
    }

    private fun processLine(line: String, linesParsedInEvent: Int, callback: Callback): Boolean = when {
        line.isEmpty() -> handleEmptyLine(linesParsedInEvent, callback)
        line.startsWith(":") -> {
            callback.onLinesParsed(linesParsedInEvent)
            val commentStart = if (line.length > 1 && line[1] == ' ') 2 else 1
            callback.onComment(line.substring(commentStart))
            true
        }
        else -> {
            handleFieldLine(line, callback)
            false
        }
    }

    /**
     * Reads lines from source until one event (message or comment) is completed and dispatched.
     * Returns true if an event was dispatched, or false on EOF.
     * Per WHATWG SSE spec: "Once the end of the file is reached, any pending data must be discarded.
     * (If the file ends in the middle of an event, before the final empty line,
     * the incomplete event is not dispatched.)"
     */
    fun processNextEvent(callback: Callback): Boolean {
        var linesParsedInEvent = 0
        var line = readSseLine()
        while (line != null) {
            linesParsedInEvent++
            if (processLine(line, linesParsedInEvent, callback)) {
                return true
            }
            line = readSseLine()
        }
        handleEof(linesParsedInEvent, callback)
        return false
    }
}
