package com.margelo.nitro.nitrosse

import android.util.Log
import com.margelo.nitro.core.AnyMap
import org.json.JSONArray
import org.json.JSONObject

/**
 * Utility for recursive conversion of Android [JSONObject] and [JSONArray] structures
 * into [AnyMap] representations required by the Nitro JavaScript bridge.
 */
object JsonUtils {
    private const val MAX_DEPTH = 500

    private fun convertJsonValue(value: Any?, depth: Int): Any? {
        return when (value) {
            is JSONObject -> jsonObjectToMap(value, depth + 1)
            is JSONArray -> jsonArrayToList(value, depth + 1)
            JSONObject.NULL -> null
            else -> value
        }
    }

    fun jsonObjectToMap(jsonObject: JSONObject, depth: Int = 0): Map<String, Any?> {
        if (depth > MAX_DEPTH) {
            throw IllegalArgumentException("JSON nesting depth limit ($MAX_DEPTH) exceeded")
        }
        val map = HashMap<String, Any?>(jsonObject.length())
        val keys = jsonObject.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            map[key] = convertJsonValue(jsonObject.get(key), depth)
        }
        return map
    }

    fun jsonArrayToList(jsonArray: JSONArray, depth: Int = 0): List<Any?> {
        if (depth > MAX_DEPTH) {
            throw IllegalArgumentException("JSON nesting depth limit ($MAX_DEPTH) exceeded")
        }
        val list = ArrayList<Any?>(jsonArray.length())
        for (i in 0 until jsonArray.length()) {
            list.add(convertJsonValue(jsonArray.get(i), depth))
        }
        return list
    }

    /**
     * Parses a raw JSON string into a [Map]. Returns null on non-object roots.
     * Throws [org.json.JSONException] on malformed JSON objects.
     */
    fun parseJsonToMap(data: String): Map<String, Any?>? {
        val len = data.length
        var firstChar = ' '
        var idx = 0
        var needsSubstring = false
        while (idx < len) {
            val c = data[idx]
            if (c > ' ') {
                if (c.isWhitespace()) {
                    needsSubstring = true
                } else {
                    firstChar = c
                    break
                }
            }
            idx++
        }
        if (firstChar != '{') {
            return null
        }
        val jsonStr = if (needsSubstring) data.substring(idx) else data
        val jsonObject = JSONObject(jsonStr)
        return jsonObjectToMap(jsonObject)
    }

    /**
     * Parses a raw JSON string into [AnyMap]. Returns null on malformed JSON or non-object roots
     * to prevent invalid SSE payloads from interrupting stream processing.
     */
    fun parseJsonToAnyMap(data: String): AnyMap? {
        return try {
            val map = parseJsonToMap(data) ?: return null
            AnyMap.fromMap(map, true)
        } catch (t: Throwable) {
            try {
                Log.w("JsonUtils", "Failed to parse JSON: ${t.message}")
            } catch (_: Throwable) {
                // Ignored in unit test environments where Log is unmocked
            }
            null
        }
    }
}
