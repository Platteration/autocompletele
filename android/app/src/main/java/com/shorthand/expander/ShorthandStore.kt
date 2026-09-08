package com.shorthand.expander

import android.content.Context
import android.content.SharedPreferences

/** Persists shorthands and settings in SharedPreferences. */
class ShorthandStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var shorthands: List<Shorthand>
        get() {
            val json = prefs.getString(KEY_JSON, null) ?: return emptyList()
            return try {
                ShorthandJson.parse(json)
            } catch (e: Exception) {
                emptyList()
            }
        }
        set(value) {
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

    companion object {
        const val PREFS_NAME = "shorthands"
        const val KEY_JSON = "shorthands_json"
        const val KEY_ENABLED = "enabled"

        fun defaults(): List<Shorthand> = listOf(
            Shorthand("cool/", "That is really cool, thanks for sharing!"),
            Shorthand("sig/", "Best regards,\n{cursor}"),
            Shorthand("td/", "{date}"),
        )
    }
}
