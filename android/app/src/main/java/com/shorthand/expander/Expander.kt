package com.shorthand.expander

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One shorthand: a trigger the user types and the text it expands to. */
data class Shorthand(val trigger: String, val expansion: String)

/** A trigger found at the caret; [start] is the index where the trigger begins. */
data class Match(val shorthand: Shorthand, val start: Int)

/** Expansion text with placeholders substituted and the caret offset inside it. */
data class Rendered(val text: String, val cursorOffset: Int)

/**
 * Pure matching and placeholder logic. Mirrors chrome-extension/src/expander.js
 * and the rules in shared/SPEC.md.
 */
object Expander {
    private val ESCAPED = Regex("""^\{\{([a-zA-Z]+)\}\}""")
    private val PLACEHOLDER = Regex("""^\{([a-zA-Z]+)\}""")

    /** A trigger may only fire after start-of-text, whitespace or punctuation. */
    fun isBoundary(ch: Char?): Boolean {
        if (ch == null) return true
        if (ch == '_' || ch.isLetter() || ch.isDigit()) return false
        val type = Character.getType(ch)
        return type != Character.LETTER_NUMBER.toInt() && type != Character.OTHER_NUMBER.toInt()
    }

    fun findMatch(textBeforeCaret: CharSequence?, shorthands: List<Shorthand>): Match? {
        if (textBeforeCaret.isNullOrEmpty() || shorthands.isEmpty()) return null
        val text = textBeforeCaret.toString()
        var best: Match? = null
        for (sh in shorthands) {
            val t = sh.trigger
            if (t.isEmpty() || t.length > text.length) continue
            if (!text.endsWith(t)) continue
            val start = text.length - t.length
            val before = if (start > 0) text[start - 1] else null
            if (!isBoundary(before)) continue
            if (best == null || t.length > best.shorthand.trigger.length) {
                best = Match(sh, start)
            }
        }
        return best
    }

    fun render(expansion: String?, now: Date = Date()): Rendered {
        val src = expansion ?: ""
        val date = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(now)
        val time = SimpleDateFormat("HH:mm", Locale.US).format(now)
        val values = mapOf(
            "date" to date,
            "time" to time,
            "datetime" to "$date $time",
        )
        val sb = StringBuilder(src.length)
        var cursor = -1
        var i = 0
        while (i < src.length) {
            val ch = src[i]
            if (ch == '{') {
                val rest = src.substring(i)
                val esc = ESCAPED.find(rest)
                if (esc != null) {
                    sb.append('{').append(esc.groupValues[1]).append('}')
                    i += esc.value.length
                    continue
                }
                val m = PLACEHOLDER.find(rest)
                if (m != null) {
                    val name = m.groupValues[1].lowercase(Locale.ROOT)
                    if (name == "cursor") {
                        if (cursor < 0) cursor = sb.length
                        i += m.value.length
                        continue
                    }
                    val v = values[name]
                    if (v != null) {
                        sb.append(v)
                        i += m.value.length
                        continue
                    }
                }
            }
            sb.append(ch)
            i++
        }
        val text = sb.toString()
        return Rendered(text, if (cursor < 0) text.length else cursor)
    }

    /** Trim triggers, drop empties and duplicates (first one wins). */
    fun sanitize(list: List<Shorthand?>?): List<Shorthand> {
        if (list == null) return emptyList()
        val seen = HashSet<String>()
        val out = ArrayList<Shorthand>()
        for (item in list) {
            if (item == null) continue
            val trigger = item.trigger.trim()
            if (trigger.isEmpty() || !seen.add(trigger)) continue
            out.add(Shorthand(trigger, item.expansion))
        }
        return out
    }
}
