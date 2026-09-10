package com.shorthand.expander

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.util.Calendar

/**
 * Runs the shared conformance suite (shared/conformance.json). The Chrome
 * extension and Windows test suites run the same file, so a change to the
 * matching rules applied to only one platform fails on the others.
 */
class ConformanceTest {

    private val suite: JSONObject by lazy { JSONObject(findSuiteFile().readText()) }

    private val shorthands: List<Shorthand> by lazy {
        val arr = suite.getJSONArray("shorthands")
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            Shorthand(o.getString("trigger"), o.getString("expansion"))
        }
    }

    /** Walk up from the working directory to find the repository's shared/ folder. */
    private fun findSuiteFile(): File {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            val candidate = File(File(dir, "shared"), "conformance.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile
        }
        throw IllegalStateException(
            "Could not find shared/conformance.json in any parent of ${System.getProperty("user.dir")}"
        )
    }

    @Test
    fun findMatch() {
        val cases = suite.getJSONArray("match")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val actual = Expander.findMatch(c.getString("input"), shorthands)
            if (c.isNull("expect")) {
                assertNull(name, actual)
                continue
            }
            val expect = c.getJSONObject("expect")
            assertNotNull(name, actual)
            assertEquals(name, expect.getString("trigger"), actual!!.shorthand.trigger)
            assertEquals(name, expect.getInt("start"), actual.start)
        }
    }

    @Test
    fun render() {
        val cases = suite.getJSONArray("render")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val now = c.getJSONArray("now")
            val cal = Calendar.getInstance().apply {
                clear()
                set(now.getInt(0), now.getInt(1) - 1, now.getInt(2), now.getInt(3), now.getInt(4), 0)
            }
            val actual = Expander.render(c.getString("expansion"), cal.time)
            assertEquals(name, c.getString("expectText"), actual.text)
            assertEquals(name, c.getInt("expectCursor"), actual.cursorOffset)
        }
    }

    @Test
    fun sanitize() {
        val cases = suite.getJSONArray("sanitize")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            assertEquals(name, toList(c.getJSONArray("expect")), Expander.sanitize(toNullableList(c.getJSONArray("input"))))
        }
    }

    private fun toList(arr: JSONArray): List<Shorthand> =
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            Shorthand(o.getString("trigger"), o.getString("expansion"))
        }

    private fun toNullableList(arr: JSONArray): List<Shorthand?> =
        (0 until arr.length()).map {
            if (arr.isNull(it)) null else {
                val o = arr.getJSONObject(it)
                Shorthand(o.getString("trigger"), o.getString("expansion"))
            }
        }
}
