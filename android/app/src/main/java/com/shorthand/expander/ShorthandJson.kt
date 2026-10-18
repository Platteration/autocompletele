package com.shorthand.expander

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** Reads and writes the cross-platform JSON format described in shared/SPEC.md. */
object ShorthandJson {
    fun toJson(list: List<Shorthand>): String {
        val arr = JSONArray()
        for (sh in list) {
            arr.put(JSONObject().put("trigger", sh.trigger).put("expansion", sh.expansion))
        }
        return JSONObject().put("version", 1).put("shorthands", arr).toString(2)
    }

    /** Accepts either the full file object or a bare array of shorthands. */
    @Throws(JSONException::class)
    fun parse(json: String): List<Shorthand> {
        val trimmed = json.trim()
        val arr: JSONArray = if (trimmed.startsWith("[")) {
            JSONArray(trimmed)
        } else {
            val obj = JSONObject(trimmed)
            obj.optJSONArray("shorthands") ?: throw JSONException("No \"shorthands\" array found.")
        }
        val list = ArrayList<Shorthand?>()
        for (i in 0 until arr.length()) {
            val el = arr.optJSONObject(i) ?: continue
            list.add(Shorthand(el.optString("trigger", ""), el.optString("expansion", "")))
        }
        return Expander.sanitize(list)
    }

    /** What [read] found: the shorthands, or the exact text that could not be parsed. */
    sealed class ReadResult {
        class Parsed(val shorthands: List<Shorthand>) : ReadResult()
        class Unreadable(val raw: String) : ReadResult()
    }

    /** Like [parse], but returns unparseable input unchanged instead of throwing. */
    fun read(json: String): ReadResult =
        try {
            ReadResult.Parsed(parse(json))
        } catch (e: Exception) {
            ReadResult.Unreadable(json)
        }
}
