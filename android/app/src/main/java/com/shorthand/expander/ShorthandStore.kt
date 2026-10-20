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

    /** Whether the last read of [shorthands] found a saved list it could not read, copied aside or not. */
    var savedListUnreadable = false
        private set

    var shorthands: List<Shorthand>
        get() {
            val json = prefs.getString(KEY_JSON, null) ?: return emptyList()
            return when (val result = ShorthandJson.read(json)) {
                is ShorthandJson.ReadResult.Parsed -> {
                    savedListUnreadable = false
                    unreadableCopyKey = null
                    result.shorthands
                }
                is ShorthandJson.ReadResult.Unreadable -> {
                    savedListUnreadable = true
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
     * Before an import changes the list: keeps the saved list's text under [KEY_BEFORE_IMPORT] with
     * commit(), in place of the list kept before an earlier import. Returns false if that write failed;
     * the list kept before the earlier import is then put back, so it is still there.
     */
    fun keepListBeforeImport(): Boolean {
        val earlier = prefs.getString(KEY_BEFORE_IMPORT, null)
        if (prefs.edit().putString(KEY_BEFORE_IMPORT, prefs.getString(KEY_JSON, null)).commit()) return true
        // SharedPreferences changes its values in memory even when commit() cannot write them to disk.
        // Putting null removes the key, as when nothing was kept before.
        prefs.edit().putString(KEY_BEFORE_IMPORT, earlier).apply()
        return false
    }

    /**
     * Saves the list an import produced, through [shorthands]. [kept] tells whether [keepListBeforeImport]
     * kept the list it replaces. When it did not (the list was empty, or the import went ahead after the
     * keep failed), the list kept before an earlier import is removed once the save is done, so Undo last
     * import only ever puts back the list from before the latest import. A refused save throws
     * IllegalStateException, as [shorthands] does, and the kept list stays.
     */
    fun saveImported(list: List<Shorthand>, kept: Boolean) {
        shorthands = list
        if (!kept) prefs.edit().remove(KEY_BEFORE_IMPORT).apply()
    }

    /** The list kept by [keepListBeforeImport], or null when none is kept (or it cannot be read). */
    val listBeforeImport: List<Shorthand>?
        get() {
            val kept = prefs.getString(KEY_BEFORE_IMPORT, null) ?: return null
            return (ShorthandJson.read(kept) as? ShorthandJson.ReadResult.Parsed)?.shorthands
        }

    /**
     * Saves the list kept before the last import as the saved list again, through [shorthands], so a
     * saved list that cannot be read is still copied aside first. The kept list is removed only after
     * that save; if the save is refused, its IllegalStateException is thrown and the kept list stays.
     * Returns the restored list, or null when no list was kept.
     */
    fun restoreListBeforeImport(): List<Shorthand>? {
        val kept = listBeforeImport ?: return null
        shorthands = kept
        prefs.edit().remove(KEY_BEFORE_IMPORT).apply()
        return kept
    }

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
        const val KEY_BEFORE_IMPORT = "shorthands_json_before_import"
        const val KEY_ENABLED = "enabled"

        fun defaults(): List<Shorthand> = listOf(
            Shorthand("cool/", "That is really cool, thanks for sharing!"),
            Shorthand("sig/", "Best regards,\n{cursor}"),
            Shorthand("td/", "{date}"),
        )
    }
}
