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

    fun jsonObjectToMap(jsonObject: JSONObject, depth: Int = 0): Map<String, Any?> {
        if (depth > MAX_DEPTH) {
            throw IllegalArgumentException("JSON nesting depth limit ($MAX_DEPTH) exceeded")
        }
        val map = mutableMapOf<String, Any?>()
        val keys = jsonObject.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            var value: Any? = jsonObject.get(key)
            if (value is JSONObject) {
                value = jsonObjectToMap(value, depth + 1)
            } else if (value is JSONArray) {
                value = jsonArrayToList(value, depth + 1)
            } else if (value == JSONObject.NULL) {
                value = null
            }
            map[key] = value
        }
        return map
    }

    fun jsonArrayToList(jsonArray: JSONArray, depth: Int = 0): List<Any?> {
        if (depth > MAX_DEPTH) {
            throw IllegalArgumentException("JSON nesting depth limit ($MAX_DEPTH) exceeded")
        }
        val list = mutableListOf<Any?>()
        for (i in 0 until jsonArray.length()) {
            var value: Any? = jsonArray.get(i)
            if (value is JSONObject) {
                value = jsonObjectToMap(value, depth + 1)
            } else if (value is JSONArray) {
                value = jsonArrayToList(value, depth + 1)
            } else if (value == JSONObject.NULL) {
                value = null
            }
            list.add(value)
        }
        return list
    }

    /**
     * Parses a raw JSON string into [AnyMap]. Returns null on malformed JSON or non-object roots
     * to prevent invalid SSE payloads from interrupting stream processing.
     */
    fun parseJsonToAnyMap(data: String): AnyMap? {
        return try {
            val trimmed = data.trim()
            if (trimmed.startsWith("{")) {
                val jsonObject = JSONObject(trimmed)
                val map = jsonObjectToMap(jsonObject)
                AnyMap.fromMap(map, true)
            } else {
                null
            }
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
