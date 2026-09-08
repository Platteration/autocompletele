package com.shorthand.expander

import android.accessibilityservice.AccessibilityService
import android.content.SharedPreferences
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Listens for text changes in editable fields of other apps and replaces a
 * trigger at the caret with its expansion.
 */
class ShorthandAccessibilityService : AccessibilityService() {

    private lateinit var store: ShorthandStore

    @Volatile
    private var shorthands: List<Shorthand> = emptyList()

    @Volatile
    private var enabled = true

    /** Text we just wrote ourselves; the resulting change event must be ignored. */
    private var lastInjectedText: String? = null
    private var lastInjectedAt = 0L

    /** Details of the last expansion so a Backspace right after it can restore the trigger. */
    private class UndoInfo(val expandedText: String, val expandedCaret: Int, val originalText: String, val originalCaret: Int)
    private var undo: UndoInfo? = null

    private val prefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> reload() }

    override fun onServiceConnected() {
        super.onServiceConnected()
        store = ShorthandStore(this)
        store.registerListener(prefsListener)
        reload()
        Log.i(TAG, "Shorthand service connected with ${shorthands.size} shorthand(s)")
    }

    private fun reload() {
        shorthands = store.shorthands
        enabled = store.enabled
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) return
        if (!enabled || shorthands.isEmpty()) return
        if (event.packageName == packageName) return // never expand inside our own editor

        val node = event.source ?: findFocusedEditable() ?: return
        try {
            if (!node.isEditable || node.isPassword) return
            val text = node.text?.toString() ?: return

            // Ignore the change caused by our own ACTION_SET_TEXT.
            val injected = lastInjectedText
            if (injected != null) {
                if (text == injected) {
                    lastInjectedText = null
                    return
                }
                if (SystemClock.uptimeMillis() - lastInjectedAt > 1000) lastInjectedText = null
            }

            val caret = caretPosition(node, event, text.length)

            // Backspace right after an expansion: the field now holds the expanded text
            // minus one character before the caret. Put the trigger back.
            val u = undo
            undo = null
            if (u != null && text == Expander.deleteCharBefore(u.expandedText, u.expandedCaret)) {
                writeText(node, u.originalText, u.originalCaret)
                return
            }

            if (caret <= 0 || caret > text.length) return
            val match = Expander.findMatch(text.substring(0, caret), shorthands) ?: return
            val rendered = Expander.render(match.shorthand.expansion)
            val newText = text.substring(0, match.start) + rendered.text + text.substring(caret)
            val newCaret = match.start + rendered.cursorOffset

            if (writeText(node, newText, newCaret)) {
                undo = UndoInfo(newText, newCaret, text, caret)
            } else {
                Log.w(TAG, "ACTION_SET_TEXT rejected by ${event.packageName}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Expansion failed", e)
        } finally {
            @Suppress("DEPRECATION")
            node.recycle()
        }
    }

    /** Replace the field's text and place the caret; returns false if the app refused. */
    private fun writeText(node: AccessibilityNodeInfo, text: String, caret: Int): Boolean {
        lastInjectedText = text
        lastInjectedAt = SystemClock.uptimeMillis()
        val setText = Bundle()
        setText.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setText)) {
            lastInjectedText = null
            return false
        }
        val select = Bundle()
        select.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, caret)
        select.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, caret)
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, select)
        return true
    }

    private fun findFocusedEditable(): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        return root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
    }

    /** Best guess of where the caret is after this text change. */
    private fun caretPosition(node: AccessibilityNodeInfo, event: AccessibilityEvent, length: Int): Int {
        val selEnd = node.textSelectionEnd
        if (selEnd in 0..length && node.textSelectionStart == selEnd) return selEnd
        val from = event.fromIndex
        if (from >= 0 && event.addedCount >= 0) {
            val pos = from + event.addedCount
            if (pos in 0..length) return pos
        }
        return length
    }

    override fun onInterrupt() {
        // Nothing to interrupt: the service does not produce feedback.
    }

    override fun onDestroy() {
        if (::store.isInitialized) store.unregisterListener(prefsListener)
        super.onDestroy()
    }

    companion object {
        private const val TAG = "ShorthandExpander"
    }
}
