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
    fun jsonObjectToMap(jsonObject: JSONObject): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        val keys = jsonObject.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            var value: Any? = jsonObject.get(key)
            if (value is JSONObject) {
                value = jsonObjectToMap(value)
            } else if (value is JSONArray) {
                value = jsonArrayToList(value)
            } else if (value == JSONObject.NULL) {
                value = null
            }
            map[key] = value
        }
        return map
    }

    fun jsonArrayToList(jsonArray: JSONArray): List<Any?> {
        val list = mutableListOf<Any?>()
        for (i in 0 until jsonArray.length()) {
            var value: Any? = jsonArray.get(i)
            if (value is JSONObject) {
                value = jsonObjectToMap(value)
            } else if (value is JSONArray) {
                value = jsonArrayToList(value)
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
        } catch (e: Exception) {
            Log.w("JsonUtils", "Failed to parse JSON: ${e.message}")
            null
        }
    }
}
