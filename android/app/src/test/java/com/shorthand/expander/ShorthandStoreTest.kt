package com.shorthand.expander

import android.content.SharedPreferences
import com.shorthand.expander.ShorthandStore.Companion.KEY_BEFORE_IMPORT
import com.shorthand.expander.ShorthandStore.Companion.KEY_JSON
import com.shorthand.expander.ShorthandStore.Companion.KEY_UNREADABLE
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A saved list that cannot be parsed must be copied aside before anything can replace it.
 * These run against [FakePrefs], not Android's own SharedPreferences implementation.
 */
class ShorthandStoreTest {
    private val unreadable = "{\"version\": 1, \"shorthands\": [{\"trigger\": \"cool/\", \"expans"
    private val edited = listOf(Shorthand("a/", "A"))

    @Test fun unreadableListIsCopiedAsideBeforeItCanBeReplaced() {
        val prefs = FakePrefs(KEY_JSON to unreadable)
        val store = ShorthandStore(prefs)

        assertEquals(emptyList<Shorthand>(), store.shorthands)
        assertEquals(KEY_UNREADABLE, store.unreadableCopyKey)
        assertTrue(store.savedListUnreadable)
        assertEquals(listOf("commit $KEY_UNREADABLE"), prefs.writes)

        store.shorthands = edited
        assertEquals(edited, store.shorthands)
        // Once the saved list reads normally again, the store no longer reports it as unreadable.
        assertNull(store.unreadableCopyKey)
        assertFalse(store.savedListUnreadable)
        assertEquals(unreadable, prefs.values[KEY_UNREADABLE])
        assertEquals(listOf("commit $KEY_UNREADABLE", "commit $KEY_UNREADABLE", "apply $KEY_JSON"), prefs.writes)
    }

    @Test fun savingWithoutReadingFirstStillCopiesTheUnreadableListAside() {
        val prefs = FakePrefs(KEY_JSON to unreadable)
        ShorthandStore(prefs).shorthands = edited

        assertEquals(unreadable, prefs.values[KEY_UNREADABLE])
        assertEquals(listOf("commit $KEY_UNREADABLE", "apply $KEY_JSON"), prefs.writes)
    }

    @Test fun earlierCopiesAreNeverReplaced() {
        val prefs = FakePrefs(KEY_JSON to "third", KEY_UNREADABLE to "first", "${KEY_UNREADABLE}_2" to "second")
        val store = ShorthandStore(prefs)
        store.shorthands = edited

        assertEquals("${KEY_UNREADABLE}_3", store.unreadableCopyKey)
        assertEquals("first", prefs.values[KEY_UNREADABLE])
        assertEquals("second", prefs.values["${KEY_UNREADABLE}_2"])
        assertEquals("third", prefs.values["${KEY_UNREADABLE}_3"])
    }

    @Test fun theSameUnreadableTextIsCopiedOnlyOnce() {
        val prefs = FakePrefs(KEY_JSON to unreadable)
        // The activity and the accessibility service each read through their own store.
        ShorthandStore(prefs).shorthands
        val store = ShorthandStore(prefs)
        store.shorthands

        assertEquals(KEY_UNREADABLE, store.unreadableCopyKey)
        assertEquals(setOf(KEY_JSON, KEY_UNREADABLE), prefs.values.keys)
    }

    @Test fun savingIsRefusedWhileTheUnreadableListCannotBeCopiedAside() {
        val prefs = FakePrefs(KEY_JSON to unreadable)
        prefs.failCommits = true
        val store = ShorthandStore(prefs)

        assertEquals(emptyList<Shorthand>(), store.shorthands)
        assertNull(store.unreadableCopyKey)
        // The activity still warns when the copy failed.
        assertTrue(store.savedListUnreadable)
        assertThrows(IllegalStateException::class.java) { store.shorthands = edited }
        assertEquals(unreadable, prefs.values[KEY_JSON])
        assertEquals(listOf("commit $KEY_UNREADABLE", "commit $KEY_UNREADABLE"), prefs.writes)

        prefs.failCommits = false
        store.shorthands = edited
        assertEquals(KEY_UNREADABLE, store.unreadableCopyKey)
        assertEquals(unreadable, prefs.values[KEY_UNREADABLE])
        assertEquals(edited, store.shorthands)
    }

    @Test fun readableListIsNotCopied() {
        val prefs = FakePrefs(KEY_JSON to ShorthandJson.toJson(edited))
        val store = ShorthandStore(prefs)

        assertEquals(edited, store.shorthands)
        assertFalse(store.savedListUnreadable)
        store.shorthands = listOf(Shorthand("b/", "B"))
        assertNull(store.unreadableCopyKey)
        assertEquals(listOf("apply $KEY_JSON"), prefs.writes)
    }

    @Test fun firstRunStillSavesTheDefaults() {
        val prefs = FakePrefs()
        val store = ShorthandStore(prefs)

        assertEquals(ShorthandStore.defaults(), store.shorthands)
        assertNull(store.unreadableCopyKey)
        assertEquals(listOf("apply $KEY_JSON"), prefs.writes)
    }

    // ---- the list kept before an import --------------------------------------

    private val before = listOf(Shorthand("a/", "Alpha\nline two"), Shorthand("b/", "{date}"))
    private val imported = listOf(Shorthand("i/", "Imported"))

    @Test fun nothingIsKeptUntilAnImport() {
        val prefs = FakePrefs(KEY_JSON to ShorthandJson.toJson(before))
        val store = ShorthandStore(prefs)

        assertNull(store.listBeforeImport)
        assertNull(store.restoreListBeforeImport())
        assertEquals(before, store.shorthands)
        assertEquals(emptyList<String>(), prefs.writes)
    }

    @Test fun theSavedListIsKeptWithCommitBeforeAnImport() {
        val saved = ShorthandJson.toJson(before)
        val prefs = FakePrefs(KEY_JSON to saved)
        val store = ShorthandStore(prefs)

        assertTrue(store.keepListBeforeImport())
        assertEquals(saved, prefs.values[KEY_BEFORE_IMPORT])
        assertEquals(listOf("commit $KEY_BEFORE_IMPORT"), prefs.writes)

        store.shorthands = imported
        assertEquals(imported, store.shorthands)
        assertEquals(before, store.listBeforeImport)
        // A store opened later (after a restart) still finds it.
        assertEquals(before, ShorthandStore(prefs).listBeforeImport)
    }

    @Test fun aLaterImportKeepsOnlyTheListBeforeIt() {
        val prefs = FakePrefs(KEY_JSON to ShorthandJson.toJson(before))
        val store = ShorthandStore(prefs)
        store.keepListBeforeImport()
        store.shorthands = imported
        store.keepListBeforeImport()
        store.shorthands = listOf(Shorthand("z/", "Z"))

        assertEquals(imported, store.listBeforeImport)
    }

    @Test fun aKeepThatCannotBeWrittenIsReported() {
        val saved = ShorthandJson.toJson(before)
        val prefs = FakePrefs(KEY_JSON to saved)
        prefs.failCommits = true
        val store = ShorthandStore(prefs)

        assertFalse(store.keepListBeforeImport())
        assertEquals(saved, prefs.values[KEY_JSON])
        assertEquals(before, store.shorthands)
        assertEquals(listOf("commit $KEY_BEFORE_IMPORT"), prefs.writes)
    }

    @Test fun restoringSavesTheKeptListAndOnlyThenClearsIt() {
        val prefs = FakePrefs(KEY_JSON to ShorthandJson.toJson(before))
        val store = ShorthandStore(prefs)
        store.keepListBeforeImport()
        store.shorthands = imported
        prefs.writes.clear()

        assertEquals(before, store.restoreListBeforeImport())
        assertEquals(before, store.shorthands)
        assertNull(store.listBeforeImport)
        assertFalse(KEY_BEFORE_IMPORT in prefs.values)
        // The restored list is saved first; the kept list is removed after that save.
        assertEquals(listOf("apply $KEY_JSON", "apply $KEY_BEFORE_IMPORT"), prefs.writes)
    }

    @Test fun restoringCopiesAnUnreadableSavedListAsideFirst() {
        val kept = ShorthandJson.toJson(before)
        val prefs = FakePrefs(KEY_JSON to unreadable, KEY_BEFORE_IMPORT to kept)
        val store = ShorthandStore(prefs)

        assertEquals(before, store.restoreListBeforeImport())
        assertEquals(unreadable, prefs.values[KEY_UNREADABLE])
        assertEquals(before, store.shorthands)
        assertNull(store.listBeforeImport)
        assertEquals(listOf("commit $KEY_UNREADABLE", "apply $KEY_JSON", "apply $KEY_BEFORE_IMPORT"), prefs.writes)
    }

    @Test fun aRefusedRestoreKeepsTheKeptList() {
        val kept = ShorthandJson.toJson(before)
        val prefs = FakePrefs(KEY_JSON to unreadable, KEY_BEFORE_IMPORT to kept)
        prefs.failCommits = true
        val store = ShorthandStore(prefs)

        assertThrows(IllegalStateException::class.java) { store.restoreListBeforeImport() }
        assertEquals(unreadable, prefs.values[KEY_JSON])
        assertEquals(kept, prefs.values[KEY_BEFORE_IMPORT])
        assertEquals(before, store.listBeforeImport)
        assertEquals(listOf("commit $KEY_UNREADABLE"), prefs.writes)

        // Once the unreadable list can be copied aside, the same restore goes through.
        prefs.failCommits = false
        assertEquals(before, store.restoreListBeforeImport())
        assertEquals(unreadable, prefs.values[KEY_UNREADABLE])
        assertEquals(before, store.shorthands)
        assertNull(store.listBeforeImport)
    }
}

/**
 * In-memory SharedPreferences. As in Android's implementation, an edit changes the values in
 * memory whether or not commit() manages to write them to disk; [failCommits] makes commit()
 * report that the disk write failed. [writes] lists each commit() and apply() with its keys.
 */
private class FakePrefs(vararg initial: Pair<String, Any>) : SharedPreferences {
    val values = hashMapOf(*initial)
    val writes = ArrayList<String>()
    var failCommits = false

    override fun getAll(): MutableMap<String, *> = HashMap(values)
    override fun getString(key: String, defValue: String?): String? = values[key] as String? ?: defValue
    override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = defValues
    override fun getInt(key: String, defValue: Int): Int = values[key] as Int? ?: defValue
    override fun getLong(key: String, defValue: Long): Long = values[key] as Long? ?: defValue
    override fun getFloat(key: String, defValue: Float): Float = values[key] as Float? ?: defValue
    override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as Boolean? ?: defValue
    override fun contains(key: String): Boolean = key in values
    override fun edit(): SharedPreferences.Editor = FakeEditor()
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) {}
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) {}

    private inner class FakeEditor : SharedPreferences.Editor {
        private val changes = LinkedHashMap<String, Any?>() // a null value removes the key

        override fun putString(key: String, value: String?) = change(key, value)
        override fun putStringSet(key: String, value: MutableSet<String>?) = change(key, value)
        override fun putInt(key: String, value: Int) = change(key, value)
        override fun putLong(key: String, value: Long) = change(key, value)
        override fun putFloat(key: String, value: Float) = change(key, value)
        override fun putBoolean(key: String, value: Boolean) = change(key, value)
        override fun remove(key: String) = change(key, null)
        override fun clear(): SharedPreferences.Editor = throw UnsupportedOperationException()

        override fun commit(): Boolean {
            write("commit")
            return !failCommits
        }

        override fun apply() = write("apply")

        private fun change(key: String, value: Any?): SharedPreferences.Editor {
            changes[key] = value
            return this
        }

        private fun write(how: String) {
            for ((key, value) in changes) if (value == null) values.remove(key) else values[key] = value
            writes.add("$how ${changes.keys.joinToString(",")}")
        }
    }
}
