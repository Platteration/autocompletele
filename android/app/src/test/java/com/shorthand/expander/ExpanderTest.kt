package com.shorthand.expander

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

class ExpanderTest {
    private val list = listOf(
        Shorthand("cool/", "That is really cool!"),
        Shorthand("verycool/", "Extremely cool!"),
        Shorthand("sig/", "Best regards,\n{cursor}\nAlex"),
    )

    @Test fun matchesAtEndOfText() {
        val m = Expander.findMatch("hey cool/", list)
        assertNotNull(m)
        assertEquals("cool/", m!!.shorthand.trigger)
        assertEquals(4, m.start)
    }

    @Test fun matchesAtStartOfField() {
        assertEquals(0, Expander.findMatch("cool/", list)!!.start)
    }

    @Test fun doesNotFireInsideWord() {
        assertNull(Expander.findMatch("school/", list))
        assertNull(Expander.findMatch("x_cool/", list))
        assertNull(Expander.findMatch("1cool/", list))
    }

    @Test fun punctuationIsBoundary() {
        assertNotNull(Expander.findMatch("(cool/", list))
        assertNotNull(Expander.findMatch("hi,cool/", list))
        assertNotNull(Expander.findMatch("line\ncool/", list))
    }

    @Test fun triggerMustBeAtCaret() {
        assertNull(Expander.findMatch("cool/ and more", list))
    }

    @Test fun longestTriggerWins() {
        assertEquals("verycool/", Expander.findMatch("verycool/", list)!!.shorthand.trigger)
    }

    @Test fun caseSensitive() {
        assertNull(Expander.findMatch("COOL/", list))
    }

    @Test fun rendersDateAndTime() {
        val cal = Calendar.getInstance().apply { set(2026, Calendar.SEPTEMBER, 8, 14, 5, 0) }
        val now = cal.time
        assertEquals("Today is 2026-09-08 at 14:05", Expander.render("Today is {date} at {time}", now).text)
        assertEquals("2026-09-08 14:05", Expander.render("{datetime}", now).text)
        assertEquals("2026-09-08", Expander.render("{DATE}", now).text)
    }

    @Test fun rendersCursor() {
        val r = Expander.render("Best regards,\n{cursor}\nAlex")
        assertEquals("Best regards,\n\nAlex", r.text)
        assertEquals(14, r.cursorOffset)
        assertEquals(5, Expander.render("hello").cursorOffset)
    }

    @Test fun leavesUnknownPlaceholdersAndEscapes() {
        assertEquals("{nope} {date} {", Expander.render("{nope} {{date}} {").text)
    }

    @Test fun sanitizeTrimsAndDedupes() {
        val out = Expander.sanitize(listOf(Shorthand("  a/ ", "A"), Shorthand("a/", "dup"), Shorthand("", "x"), null, Shorthand("b/", "B")))
        assertEquals(listOf(Shorthand("a/", "A"), Shorthand("b/", "B")), out)
        assertTrue(Expander.sanitize(null).isEmpty())
    }

    @Test fun jsonRoundTrip() {
        val json = ShorthandJson.toJson(list)
        assertTrue(json.contains("\"version\": 1"))
        assertEquals(list, ShorthandJson.parse(json))
        assertEquals(1, ShorthandJson.parse("[{\"trigger\":\"q/\",\"expansion\":\"Q\"}]").size)
    }

    @Test(expected = org.json.JSONException::class)
    fun jsonRejectsFilesWithoutShorthands() {
        ShorthandJson.parse("{\"foo\":1}")
    }
}
