const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isProtected } = require("../src/field-safety.js");

// Small metadata fixtures; browser suites separately exercise real labels/forms.
function element(tagName = "input", attrs = {}, children = []) {
  const el = {
    nodeType: 1, tagName: tagName.toUpperCase(), attrs: { ...attrs }, childNodes: children,
    parentElement: null, labels: [], form: null,
    getAttribute(name) { return this.attrs[name] ?? null; },
    getRootNode() { return this.ownerDocument; },
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector === "form" && node.tagName === "FORM") return node;
      }
      return null;
    },
    get isContentEditable() {
      if (this.attrs.contenteditable != null) return this.attrs.contenteditable !== "false";
      return !!this.parentElement?.isContentEditable;
    },
  };
  for (const child of children) child.parentElement = el;
  Object.defineProperty(el, "value", { get() { throw new Error("Field values must not be read"); } });
  Object.defineProperty(el, "textContent", { get() { throw new Error("Editor text must not be read"); } });
  return el;
}

const text = (value) => ({ nodeType: 3, nodeValue: value });
function formWith(attrs, ...children) {
  const form = element("form", attrs, children);
  form.elements = children;
  for (const child of children) child.form = form;
  return form;
}

test("password types and sensitive autocomplete tokens are protected", () => {
  assert.equal(isProtected(element("input", { type: "PASSWORD" })), true);
  for (const token of ["username", "current-password", "new-password", "one-time-code", "cc-number", "cc-name", "cc-exp"]) {
    assert.equal(isProtected(element("input", { autocomplete: `section-account billing ${token.toUpperCase()} webauthn` })), true, token);
  }
  for (const value of ["on", "off", "email", "name", "street-address", "username-extra", "x-current-password", "section-username", "cc"]) {
    assert.equal(isProtected(element("input", { autocomplete: value })), false, value);
  }
});

test("identifiers cover username variants and passwords revealed as text", () => {
  for (const name of ["username", "user_name", "accountUserName", "user-id", "UserID", "password", "currentPassword", "new_password", "password2", "passwd", "pwd", "passcode"]) {
    assert.equal(isProtected(element("input", { type: "text", name })), true, name);
  }
  assert.equal(isProtected(element("input", { id: "ctl00_accountPassword" })), true);
  for (const name of ["display_name", "company", "message", "user", "account", "email", "usernameish", "passwordless"]) {
    assert.equal(isProtected(element("input", { name })), false, name);
  }
});

test("accessible labels, placeholders and associated labels identify credentials", () => {
  for (const attribute of ["aria-label", "placeholder"]) {
    for (const label of ["Username", "Enter your user name", "Confirm password", "Current password"])
      assert.equal(isProtected(element("input", { [attribute]: label })), true, `${attribute}: ${label}`);
  }
  const input = element();
  input.labels = [element("label", {}, [text("Your "), element("strong", {}, [text("username")]), input])];
  assert.equal(isProtected(input), true);
  input.labels = [element("label", {}, [element("strong", {}, [text("Pass")]), text("word")])];
  assert.equal(isProtected(input), true, "Inline formatting does not split a label's words");
});

test("aria-labelledby resolves all references in the field's tree", () => {
  const label = element("span", {}, [text("User name")]);
  const input = element("input", { "aria-labelledby": "missing title credential" });
  input.ownerDocument = { getElementById(id) { return id === "credential" ? label : null; } };
  assert.equal(isProtected(input), true);
  input.ownerDocument = { getElementById() { return null; } };
  assert.equal(isProtected(input), false);
});

test("label metadata does not read values or text from nested editable controls", () => {
  const input = element();
  const editor = element("div", { contenteditable: "true" }, [text("password")]);
  const textarea = element("textarea", {}, [text("username")]);
  const custom = element("div", { role: "textbox" }, [text("password")]);
  input.labels = [element("label", {}, [text("Message"), input, editor, textarea, custom])];
  assert.equal(isProtected(input), false);
  input.attrs["aria-labelledby"] = "self";
  input.ownerDocument = { getElementById() { return input; } };
  assert.equal(isProtected(input), false);
});

test("nested editable descendants inherit credential metadata", () => {
  const span = element("span", {}, [text("ordinary text")]);
  const editor = element("div", { contenteditable: "true", "aria-label": "Username" }, [span]);
  assert.equal(isProtected(span), true);
  assert.equal(isProtected(span.childNodes[0]), true);
  delete editor.attrs["aria-label"];
  assert.equal(isProtected(span), false);
  span.attrs["aria-label"] = "Password";
  assert.equal(isProtected(span), true);
  assert.equal(isProtected(editor), false, "A rich editor's body text and unrelated descendants are not scanned");
});

test("sensitive autocomplete can be declared on wrappers or associated forms", () => {
  const input = element("input", { autocomplete: "off" });
  const wrapper = element("div", { autocomplete: "username" }, [input]);
  assert.equal(isProtected(input), true);
  delete wrapper.attrs.autocomplete;
  assert.equal(isProtected(input), false);
  const form = formWith({ autocomplete: "current-password" });
  input.form = form;
  assert.equal(isProtected(input), true, "External form-associated controls inherit protection");
});

test("password forms protect email and ambiguous credential identifiers", () => {
  for (const attrs of [{ type: "email" }, { name: "email_address" }, { autocomplete: "email" }, { name: "user" }, { id: "login" }, { name: "accountIdentifier" }]) {
    const input = element("input", attrs);
    formWith({}, input, element("input", { type: "password" }));
    assert.equal(isProtected(input), true, JSON.stringify(attrs));
  }
});

test("password metadata still identifies an account form after password reveal", () => {
  for (const attrs of [{ type: "text", name: "password" }, { type: "text", autocomplete: "new-password" }, { type: "text", "aria-label": "Password" }]) {
    const email = element("input", { autocomplete: "email" });
    formWith({}, email, element("input", attrs));
    assert.equal(isProtected(email), true, JSON.stringify(attrs));
  }
});

test("explicit login form metadata protects email before a password field appears", () => {
  for (const attrs of [{ id: "login-form" }, { name: "signInForm" }, { action: "/account/login" }, { "aria-label": "Sign in" }, { id: "registration" }]) {
    const email = element("input", { name: "email" });
    formWith(attrs, email);
    assert.equal(isProtected(email), true, JSON.stringify(attrs));
  }
});

test("ordinary contact fields and message textareas remain usable", () => {
  for (const attrs of [{ type: "email" }, { name: "contact_email" }, { autocomplete: "email" }, { name: "user" }]) {
    const input = element("input", attrs);
    formWith({ id: "contact-form", action: "/contact" }, input);
    assert.equal(isProtected(input), false, JSON.stringify(attrs));
  }
  const message = element("textarea", { name: "message", placeholder: "Message" });
  const displayName = element("input", { name: "display_name" });
  formWith({ id: "login-form" }, message, displayName, element("input", { type: "password" }));
  assert.equal(isProtected(message), false);
  assert.equal(isProtected(displayName), false);
});

test("layout identifiers do not classify an entire form as password fields", () => {
  const message = element("textarea", { name: "message" });
  element("div", { id: "password-panel" }, [message]);
  assert.equal(isProtected(message), false);
  message.attrs.autocomplete = "username";
  assert.equal(isProtected(message), true);
});

test("separate metadata attributes cannot accidentally combine into a credential label", () => {
  assert.equal(isProtected(element("input", { id: "user", "aria-label": "Name" })), false);
  const email = element("input", { name: "email" });
  formWith({ id: "sign", name: "in" }, email);
  assert.equal(isProtected(email), false);
});

test("classification reflects changed metadata immediately without reading entered text", () => {
  const input = element("input", { type: "text", name: "message" });
  assert.equal(isProtected(input), false);
  input.attrs.name = "username";
  assert.equal(isProtected(input), true);
  input.attrs.name = "message";
  input.attrs.type = "password";
  assert.equal(isProtected(input), true);
  input.attrs.type = "text";
  assert.equal(isProtected(input), false);
});

test("missing nodes and minimal metadata fixtures are harmless", () => {
  assert.equal(isProtected(null), false);
  assert.equal(isProtected({ tagName: "TEXTAREA" }), false);
  assert.equal(isProtected({ nodeType: 9 }), false);
});

test("field safety loads as a browser global without CommonJS", () => {
  const context = vm.createContext({ self: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/field-safety.js"), "utf8"), context);
  assert.equal(context.self.ShorthandFieldSafety.isProtected(element("input", { autocomplete: "username" })), true);
});
