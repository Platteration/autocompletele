package com.shorthand.expander

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.LayoutInflater
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

/** Lets the user manage shorthands, toggle expansion and enable the accessibility service. */
class MainActivity : Activity() {

    private lateinit var store: ShorthandStore
    private lateinit var adapter: ShorthandAdapter
    private lateinit var statusText: TextView
    private lateinit var enableServiceButton: Button
    private lateinit var enabledSwitch: Switch
    private lateinit var emptyText: TextView

    private val items = ArrayList<Shorthand>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = ShorthandStore(this)

        statusText = findViewById(R.id.statusText)
        enableServiceButton = findViewById(R.id.enableServiceButton)
        enabledSwitch = findViewById(R.id.enabledSwitch)
        emptyText = findViewById(R.id.emptyText)
        val list: ListView = findViewById(R.id.list)
        val addButton: Button = findViewById(R.id.addButton)

        adapter = ShorthandAdapter(this, items)
        list.adapter = adapter
        list.setOnItemClickListener { _, _, position, _ -> showEditDialog(items[position]) }

        addButton.setOnClickListener { showEditDialog(null) }
        enableServiceButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        enabledSwitch.setOnCheckedChangeListener { _, checked -> store.enabled = checked }

        refresh()
    }

    override fun onResume() {
        super.onResume()
        updateServiceStatus()
        enabledSwitch.isChecked = store.enabled
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_import -> { startImport(); true }
            R.id.action_export -> { startExport(); true }
            else -> super.onOptionsItemSelected(item)
        }
    }

    private fun refresh() {
        items.clear()
        items.addAll(store.shorthands)
        adapter.notifyDataSetChanged()
        emptyText.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
    }

    private fun persist() {
        store.shorthands = ArrayList(items)
        refresh()
    }

    private fun updateServiceStatus() {
        val on = isServiceEnabled(this)
        statusText.text = getString(if (on) R.string.status_service_on else R.string.status_service_off)
        enableServiceButton.visibility = if (on) View.GONE else View.VISIBLE
    }

    private fun showEditDialog(existing: Shorthand?) {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_edit, null)
        val triggerEdit: EditText = view.findViewById(R.id.editTrigger)
        val expansionEdit: EditText = view.findViewById(R.id.editExpansion)
        if (existing != null) {
            triggerEdit.setText(existing.trigger)
            expansionEdit.setText(existing.expansion)
        }

        val builder = AlertDialog.Builder(this)
            .setTitle(if (existing == null) R.string.add_shorthand else R.string.edit_shorthand)
            .setView(view)
            .setPositiveButton(R.string.save, null) // handled below so validation can keep the dialog open
            .setNegativeButton(R.string.cancel, null)
        if (existing != null) {
            builder.setNeutralButton(R.string.delete) { _, _ ->
                items.remove(existing)
                persist()
            }
        }
        val dialog = builder.create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val trigger = triggerEdit.text.toString().trim()
                val expansion = expansionEdit.text.toString()
                when {
                    trigger.isEmpty() -> triggerEdit.error = getString(R.string.error_trigger_empty)
                    trigger.any { it.isWhitespace() } -> triggerEdit.error = getString(R.string.error_trigger_space)
                    items.any { it.trigger == trigger && it !== existing } ->
                        triggerEdit.error = getString(R.string.error_trigger_duplicate)
                    else -> {
                        val updated = Shorthand(trigger, expansion)
                        if (existing != null) {
                            val index = items.indexOf(existing)
                            if (index >= 0) items[index] = updated else items.add(updated)
                        } else {
                            items.add(updated)
                        }
                        persist()
                        dialog.dismiss()
                    }
                }
            }
        }
        dialog.show()
    }

    // ---- import / export ----------------------------------------------------

    private fun startImport() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain", "application/octet-stream"))
        }
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQUEST_IMPORT)
    }

    private fun startExport() {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/json"
            putExtra(Intent.EXTRA_TITLE, getString(R.string.export_file_name))
        }
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQUEST_EXPORT)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        when (requestCode) {
            REQUEST_IMPORT -> importFrom(uri)
            REQUEST_EXPORT -> exportTo(uri)
        }
    }

    private fun importFrom(uri: Uri) {
        val imported: List<Shorthand> = try {
            val json = contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            ShorthandJson.parse(json)
        } catch (e: Exception) {
            toast(getString(R.string.import_failed, e.message ?: e.javaClass.simpleName))
            return
        }
        if (imported.isEmpty()) {
            toast(getString(R.string.import_empty))
            return
        }
        if (items.isEmpty()) {
            applyImport(imported, replace = true)
            return
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.import_replace_title)
            .setMessage(getString(R.string.import_replace_message, items.size, imported.size))
            .setPositiveButton(R.string.replace) { _, _ -> applyImport(imported, replace = true) }
            .setNeutralButton(R.string.merge) { _, _ -> applyImport(imported, replace = false) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun applyImport(imported: List<Shorthand>, replace: Boolean) {
        if (replace) {
            items.clear()
        } else {
            val triggers = imported.map { it.trigger }.toSet()
            items.removeAll { it.trigger in triggers }
        }
        items.addAll(imported)
        persist()
        toast(getString(R.string.import_done, imported.size))
    }

    private fun exportTo(uri: Uri) {
        try {
            contentResolver.openOutputStream(uri, "wt")?.use {
                it.write(ShorthandJson.toJson(items).toByteArray(Charsets.UTF_8))
            } ?: throw IllegalStateException("No output stream")
            toast(getString(R.string.export_done, items.size))
        } catch (e: Exception) {
            toast(getString(R.string.export_failed, e.message ?: e.javaClass.simpleName))
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    /** Simple two-line list row: trigger and a preview of the expansion. */
    private class ShorthandAdapter(context: Context, items: List<Shorthand>) :
        ArrayAdapter<Shorthand>(context, R.layout.item_shorthand, items) {

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView ?: LayoutInflater.from(context).inflate(R.layout.item_shorthand, parent, false)
            val sh = getItem(position)!!
            view.findViewById<TextView>(R.id.itemTrigger).text = sh.trigger
            view.findViewById<TextView>(R.id.itemExpansion).text = sh.expansion.replace("\n", " ⏎ ")
            return view
        }
    }

    companion object {
        private const val REQUEST_IMPORT = 1
        private const val REQUEST_EXPORT = 2

        fun isServiceEnabled(context: Context): Boolean {
            val expected = context.packageName + "/" + ShorthandAccessibilityService::class.java.name
            val shortForm = context.packageName + "/" +
                ShorthandAccessibilityService::class.java.name.removePrefix(context.packageName)
            val enabled = Settings.Secure.getString(
                context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: return false
            return enabled.split(':').any { it.equals(expected, ignoreCase = true) || it.equals(shortForm, ignoreCase = true) }
        }
    }
}
