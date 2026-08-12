package com.margelo.nitro.nitrosse

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests verifying [JsonUtils] conversion logic between org.json structures
 * and nested Kotlin primitives, maps, and arrays compatible with Nitro AnyMap.
 */
class NitroSseJsonTest {
    @Test
    fun testSimpleJsonObject() {
        val json = """{"name": "Nitro", "version": 2.5, "active": true, "nullVal": null}"""
        val jsonObject = JSONObject(json)
        val map = JsonUtils.jsonObjectToMap(jsonObject)

        assertEquals("Nitro", map["name"])
        assertEquals(2.5, (map["version"] as Number).toDouble(), 0.0)
        assertEquals(true, map["active"])
        assertNull(map["nullVal"])
    }

    @Test
    fun testNestedJsonObject() {
        val json = """{
            "user": {
                "id": 123,
                "profile": {
                    "theme": "dark"
                }
            }
        }"""
        val jsonObject = JSONObject(json)
        val map = JsonUtils.jsonObjectToMap(jsonObject)

        val user = map["user"] as Map<*, *>
        assertEquals(123.0, (user["id"] as Number).toDouble(), 0.0)
        
        val profile = user["profile"] as Map<*, *>
        assertEquals("dark", profile["theme"])
    }

    @Test
    fun testJsonArray() {
        val json = """{
            "tags": ["react-native", "nitro", "sse"],
            "scores": [1, 2, 3]
        }"""
        val jsonObject = JSONObject(json)
        val map = JsonUtils.jsonObjectToMap(jsonObject)

        val tags = map["tags"] as List<*>
        assertEquals(3, tags.size)
        assertEquals("nitro", tags[1])

        val scores = map["scores"] as List<*>
        assertEquals(1.0, (scores[0] as Number).toDouble(), 0.0)
    }

    @Test
    fun testMixedNestedStructures() {
        val json = """{
            "data": [
                {"id": 1, "val": "a"},
                {"id": 2, "val": "b"}
            ],
            "meta": {
                "total": 2
            }
        }"""
        val jsonObject = JSONObject(json)
        val map = JsonUtils.jsonObjectToMap(jsonObject)

        val data = map["data"] as List<*>
        val firstItem = data[0] as Map<*, *>
        assertEquals(1.0, (firstItem["id"] as Number).toDouble(), 0.0)
        assertEquals("a", firstItem["val"])

        val meta = map["meta"] as Map<*, *>
        assertEquals(2.0, (meta["total"] as Number).toDouble(), 0.0)
    }

    @Test
    fun testEmptyJson() {
        val json = "{}"
        val jsonObject = JSONObject(json)
        val map = JsonUtils.jsonObjectToMap(jsonObject)
        assertTrue(map.isEmpty())
    }

    @Test
    fun testDeeplyNestedJsonReturnsNull() {
        val depth = 600
        val sb = StringBuilder()
        for (i in 0 until depth) sb.append("""{"a":""")
        sb.append("1")
        for (i in 0 until depth) sb.append("}")

        val result = JsonUtils.parseJsonToAnyMap(sb.toString())
        assertNull(result)
    }
}
