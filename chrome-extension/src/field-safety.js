// Decide from field metadata, never from what a person has entered.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ShorthandFieldSafety = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PASSWORD = /\b(?:password|passwd|pwd|passcode)\b/;
  const USERNAME = /\b(?:username|userid|user name|user id)\b/;
  const ACCOUNT_FIELD = /\b(?:e ?mail|user|login|log in|account|identifier)\b/;
  const ACCOUNT_FORM = /\b(?:login|log in|signin|sign in|signup|sign up|register|registration|auth|authenticate|authentication)\b/;

  const tag = (el) => String(el && el.tagName || "").toUpperCase();
  const attr = (el, name) => el && typeof el.getAttribute === "function" ? el.getAttribute(name) || "" : "";
  const words = (value) => String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = (value) => String(value).toLowerCase().trim().split(/\s+/);

  function sensitiveAutocomplete(value) {
    return tokens(value).some((token) => token === "username" || token === "current-password"
      || token === "new-password" || token === "one-time-code" || token.startsWith("cc-"));
  }

  function labelText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    // Labels may wrap a control. Do not inspect its entered text, including
    // custom editable controls used inside an aria-labelledby reference.
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag(node)) || node.isContentEditable
        || attr(node, "role").toLowerCase() === "textbox") return "";
    return Array.from(node.childNodes || [], labelText).join("");
  }

  function metadata(el) {
    const parts = ["id", "name", "aria-label", "placeholder"].map((name) => attr(el, name));
    for (const label of el.labels || []) parts.push(labelText(label));
    const tree = typeof el.getRootNode === "function" ? el.getRootNode() : el.ownerDocument;
    const lookup = tree && typeof tree.getElementById === "function" ? tree : el.ownerDocument;
    if (lookup && typeof lookup.getElementById === "function") {
      for (const id of attr(el, "aria-labelledby").trim().split(/\s+/)) {
        if (id) parts.push(labelText(lookup.getElementById(id)));
      }
    }
    return parts.map(words);
  }

  function passwordControl(el) {
    if (tag(el) !== "INPUT") return false;
    return attr(el, "type").toLowerCase() === "password"
      || tokens(attr(el, "autocomplete")).some((token) => token === "current-password" || token === "new-password")
      || metadata(el).some((description) => PASSWORD.test(description));
  }

  function accountForm(form) {
    return ["id", "name", "action", "aria-label"].some((name) => ACCOUNT_FORM.test(words(attr(form, name))))
      || Array.from(form.elements || []).some(passwordControl);
  }

  function isProtected(el) {
    if (el && el.nodeType === 3) el = el.parentElement;
    if (!el || !tag(el)) return false;
    for (let node = el; node && !["BODY", "HTML"].includes(tag(node)); node = node.parentElement) {
      if (sensitiveAutocomplete(attr(node, "autocomplete"))) return true;
      // Rich editors emit events from their editing host; checking an active
      // descendant separately also picks up credential metadata on that node.
      if (node === el || node.isContentEditable || attr(node, "role").toLowerCase() === "textbox") {
        if (tag(node) === "INPUT" && attr(node, "type").toLowerCase() === "password") return true;
        if (metadata(node).some((description) => PASSWORD.test(description) || USERNAME.test(description))) return true;
      }
      if (tag(node) === "FORM") break;
    }

    const form = el.form || (typeof el.closest === "function" ? el.closest("form") : null);
    if (!form) return false;
    if (sensitiveAutocomplete(attr(form, "autocomplete"))) return true;
    // An email field becomes a likely username when its own form is clearly
    // for an account. Do not disable ordinary email or the form's message box.
    if (tag(el) !== "INPUT") return false;
    const candidate = attr(el, "type").toLowerCase() === "email"
      || tokens(attr(el, "autocomplete")).includes("email")
      || metadata(el).some((description) => ACCOUNT_FIELD.test(description));
    return candidate && accountForm(form);
  }

  return { isProtected };
});
