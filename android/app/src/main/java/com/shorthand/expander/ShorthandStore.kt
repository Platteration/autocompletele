package com.shorthand.expander

import android.content.Context
import android.content.SharedPreferences

/** Persists shorthands and settings in SharedPreferences. */
class ShorthandStore internal constructor(private val prefs: SharedPreferences) {
    constructor(context: Context) :
        this(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))

    /**
     * After [shorthands] found a saved list it could not read: the key that list's text was
     * copied to, unchanged, with commit(). Null while the list reads normally, or if that copy
     * could not be written.
     */
    var unreadableCopyKey: String? = null
        private set

    var shorthands: List<Shorthand>
        get() {
            val json = prefs.getString(KEY_JSON, null) ?: return emptyList()
            return when (val result = ShorthandJson.read(json)) {
                is ShorthandJson.ReadResult.Parsed -> result.shorthands
                is ShorthandJson.ReadResult.Unreadable -> {
                    keepUnreadable(result.raw)
                    emptyList()
                }
            }
        }
        set(value) {
            // Never replace a saved list that could not be read until a copy of it is on disk.
            // If that copy cannot be written, throw IllegalStateException and leave the saved list as it is.
            val saved = prefs.getString(KEY_JSON, null)
            if (saved != null && ShorthandJson.read(saved) is ShorthandJson.ReadResult.Unreadable) {
                checkNotNull(keepUnreadable(saved)) { "The saved shorthands could not be read or copied aside" }
            }
            prefs.edit().putString(KEY_JSON, ShorthandJson.toJson(Expander.sanitize(value))).apply()
        }

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_ENABLED, value).apply()
        }

    init {
        if (!prefs.contains(KEY_JSON)) {
            shorthands = defaults()
        }
    }

    fun registerListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) =
        prefs.registerOnSharedPreferenceChangeListener(listener)

    fun unregisterListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) =
        prefs.unregisterOnSharedPreferenceChangeListener(listener)

    /**
     * Copies [raw] with commit() to the first recovery key that is free or already holds exactly
     * this text, so an earlier copy is never replaced. Returns that key, or null if the write failed.
     */
    private fun keepUnreadable(raw: String): String? {
        val all = prefs.all
        var key = KEY_UNREADABLE
        var n = 1
        while (key in all && all[key] != raw) {
            n++
            key = "${KEY_UNREADABLE}_$n"
        }
        if (!prefs.edit().putString(key, raw).commit()) return null
        unreadableCopyKey = key
        return key
    }

    companion object {
        const val PREFS_NAME = "shorthands"
        const val KEY_JSON = "shorthands_json"
        const val KEY_UNREADABLE = "shorthands_json_unreadable"
        const val KEY_ENABLED = "enabled"

        fun defaults(): List<Shorthand> = listOf(
            Shorthand("cool/", "That is really cool, thanks for sharing!"),
            Shorthand("sig/", "Best regards,\n{cursor}"),
            Shorthand("td/", "{date}"),
        )
    }
}
