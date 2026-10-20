package com.shorthand.expander

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ShorthandJsonTest {

    private fun parsed(json: String): List<Shorthand> {
        val result = ShorthandJson.read(json)
        assertTrue("expected to parse: $json", result is ShorthandJson.ReadResult.Parsed)
        return (result as ShorthandJson.ReadResult.Parsed).shorthands
    }

    /** The failure must carry the input exactly, so it can be kept aside unchanged. */
    private fun assertUnreadable(json: String) {
        val result = ShorthandJson.read(json)
        assertTrue("expected to be unreadable: $json", result is ShorthandJson.ReadResult.Unreadable)
        assertEquals(json, (result as ShorthandJson.ReadResult.Unreadable).raw)
    }

    @Test fun readReturnsTheListForValidJson() {
        val list = listOf(Shorthand("cool/", "That is really cool!"), Shorthand("sig/", "Best regards,\n{cursor}"))
        assertEquals(list, parsed(ShorthandJson.toJson(list)))
        assertEquals(listOf(Shorthand("q/", "Q")), parsed("[{\"trigger\":\"q/\",\"expansion\":\"Q\"}]"))
        assertEquals(emptyList<Shorthand>(), parsed("{\"version\": 1, \"shorthands\": []}"))
    }

    @Test fun readKeepsTruncatedJsonExactly() {
        assertUnreadable("{\"version\": 1, \"shorthands\": [{\"trigger\": \"cool/\", \"expans")
        assertUnreadable("{\"version\": 1, \"shorthands\": [{\"trigger\": \"cool/\", \"expansion\": \"Cool\"}")
        assertUnreadable("[{\"trigger\":\"q/\",\"expansion\":\"Q\"}")
    }

    @Test fun readKeepsWrongRootTypesExactly() {
        assertUnreadable("\"shorthands\"")
        assertUnreadable("42")
        assertUnreadable("null")
        assertUnreadable("{\"version\": 1, \"shorthands\": {\"trigger\": \"q/\", \"expansion\": \"Q\"}}")
    }

    @Test fun readKeepsGarbageExactly() {
        assertUnreadable("not json at all")
        assertUnreadable("  \n\u0000�}{ ")
        assertUnreadable("")
    }
}
