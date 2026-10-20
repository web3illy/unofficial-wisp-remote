import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const htmlSource = readFileSync(new URL("../public/menu.html", import.meta.url), "utf8");
const scriptSource = readFileSync(new URL("../public/menu.js", import.meta.url), "utf8");
const nativeSource = readFileSync(new URL("../native/MacMenu.swift", import.meta.url), "utf8");

class FakeElement {
  constructor(ownerDocument, tagName = "div") {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.className = "";
    this.src = "";
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click() {
    if (this.disabled) return;
    for (const listener of this.listeners.get("click") || []) listener({ target: this, preventDefault() {} });
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
  }

  getBoundingClientRect() {
    return { height: 420 };
  }
}

function createHarness(surface = "main") {
  const clock = { now: 1_800_000_000_000 };
  const elements = new Map();
  const special = new Map();
  const document = {
    activeElement: null,
    listeners: new Map(),
    querySelector(selector) {
      if (selector === "#qr-expired strong" || selector === "#qr-expired span") return special.get(selector);
      return elements.get(selector.slice(1));
    },
    createElement(tagName) {
      return new FakeElement(document, tagName);
    },
    addEventListener(type, listener) {
      document.listeners.set(type, listener);
    },
  };
  document.body = new FakeElement(document, "body");
  document.activeElement = document.body;

  for (const match of htmlSource.matchAll(/<([a-z]+)[^>]*\sid="([^"]+)"/gi)) {
    elements.set(match[2], new FakeElement(document, match[1]));
  }
  special.set("#qr-expired strong", new FakeElement(document, "strong"));
  special.set("#qr-expired span", new FakeElement(document, "span"));

  const posts = [];
  let intervalCallback = null;
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const context = {
    Array, Boolean, Date: FakeDate, JSON, Math, Number, Set, String,
    document,
    requestAnimationFrame: (callback) => callback(),
    ResizeObserver: class { observe() {} },
    setInterval(callback) { intervalCallback = callback; return 1; },
    window: { wispMenuSurface: surface, webkit: { messageHandlers: { menu: { postMessage: (message) => posts.push(message) } } } },
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(scriptSource, context, { filename: "public/menu.js" });

  return {
    clock,
    document,
    element: (id) => elements.get(id),
    nested: (selector) => special.get(selector),
    posts,
    tick: () => intervalCallback(),
    update: context.window.wispMenuUpdate,
  };
}

function nativeState(harness, overrides = {}) {
  return {
    phase: "online",
    peers: [],
    connectionCount: 0,
    pending: null,
    invitation: null,
    errorMessage: null,
    loadingInvite: false,
    now: harness.clock.now,
    reduceMotion: false,
    wisp: { state: "running", version: "0.2.7" },
    ...overrides,
  };
}

function firstDevice(harness) {
  return harness.element("device-list").children[0];
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function deviceStateText(card) {
  return card.children[0].children[1].children[1].textContent;
}

test("unchanged native ticks preserve device row identity and keyboard focus", () => {
  const h = createHarness();
  const peer = { id: "peer-1", name: "Мой iPhone", connected: true, route: "connecting" };
  h.update(nativeState(h, { peers: [peer], connectionCount: 1 }));
  const originalCard = firstDevice(h);
  const forgetButton = originalCard.children[0].children[2];
  forgetButton.focus();
  assert.equal(deviceStateText(originalCard), "Connected");

  h.clock.now += 1_000;
  h.update(nativeState(h, { peers: [{ ...peer }], connectionCount: 1 }));
  assert.strictEqual(firstDevice(h), originalCard);
  assert.strictEqual(h.document.activeElement, forgetButton);

  h.update(nativeState(h, { peers: [{ ...peer, connected: false, route: null }], connectionCount: 0 }));
  assert.notStrictEqual(firstDevice(h), originalCard);
  assert.equal(deviceStateText(firstDevice(h)), "Offline");
});

test("approval and inline revoke emit only the expected identifiers", () => {
  const h = createHarness();
  h.update(nativeState(h, {
    peers: [{ id: "peer-7", name: "Телефон", connected: true, route: "direct" }],
    connectionCount: 1,
    pending: { id: "approval-9", name: "Новый iPhone", phoneCode: "4827", expiresAt: h.clock.now + 30_000 },
  }));
  h.element("approve").click();
  h.element("reject").click();

  firstDevice(h).children[0].children[2].click();
  const confirmedCard = firstDevice(h);
  const revokeButton = confirmedCard.children[1].children[2];
  revokeButton.focus();
  h.clock.now += 1_000;
  h.update(nativeState(h, {
    peers: [{ id: "peer-7", name: "Телефон", connected: true, route: "direct" }],
    connectionCount: 1,
    pending: { id: "approval-9", name: "Новый iPhone", phoneCode: "4827", expiresAt: h.clock.now + 30_000 },
  }));
  assert.strictEqual(firstDevice(h), confirmedCard);
  assert.strictEqual(h.document.activeElement, revokeButton);
  revokeButton.click();

  assert.deepEqual(
    plain(h.posts.filter(({ action }) => ["approve", "reject", "revoke"].includes(action))),
    [
      { action: "approve", id: "approval-9" },
      { action: "reject", id: "approval-9" },
      { action: "revoke", id: "peer-7" },
    ],
  );
});

test("pending approval expires locally and disables both decisions", () => {
  const h = createHarness();
  h.update(nativeState(h, {
    pending: { id: "approval-1", name: "iPhone", phoneCode: "1294", expiresAt: h.clock.now + 2_000 },
  }));
  assert.equal(h.element("approve").disabled, false);
  assert.equal(h.element("reject").disabled, false);

  h.clock.now += 2_001;
  h.tick();
  assert.equal(h.element("approve").disabled, true);
  assert.equal(h.element("reject").disabled, true);
  assert.equal(h.element("pending-countdown").textContent, "Request expired");
});

test("QR expiry offers regeneration and invalid non-PNG data URLs never render", () => {
  const h = createHarness();
  const qrDataUrl = "data:image/png;base64,iVBORw0KGgo=";
  h.update(nativeState(h, {
    invitation: { qrDataUrl, expiresAt: h.clock.now + 1_000, macCode: "1934" },
  }));
  assert.equal(h.element("qr").src, qrDataUrl);
  assert.equal(h.element("qr").hidden, false);
  assert.equal(h.element("regenerate").hidden, true);

  h.clock.now += 1_001;
  h.tick();
  assert.equal(h.element("qr-expired").hidden, false);
  assert.equal(h.element("regenerate").hidden, false);
  h.element("regenerate").click();
  assert.deepEqual(plain(h.posts.at(-1)), { action: "invite" });

  h.update(nativeState(h, {
    invitation: { qrDataUrl: "data:text/html;base64,PHNjcmlwdD4=", expiresAt: h.clock.now + 60_000, macCode: null },
  }));
  assert.equal(h.element("qr").hidden, true);
  assert.equal(h.element("qr").src, "");
  assert.equal(h.nested("#qr-expired strong").textContent, "QR code unavailable");
});

test("missing and closed Wisp buttons emit their finite native actions", () => {
  const h = createHarness();
  h.update(nativeState(h, { wisp: { state: "missing" } }));
  h.element("wisp-action").click();
  h.update(nativeState(h, { wisp: { state: "closed" } }));
  h.element("wisp-action").click();
  assert.deepEqual(
    plain(h.posts.filter(({ action }) => action === "download-wisp" || action === "open-wisp")),
    [{ action: "download-wisp" }, { action: "open-wisp" }],
  );
});

test("power control and credit link emit fixed finite native actions", () => {
  const h = createHarness();
  h.element("quit").click();
  h.element("github-link").click();
  assert.deepEqual(plain(h.posts.slice(-2)), [{ action: "quit" }, { action: "open-github" }]);
  assert.match(htmlSource, /<button id="quit"[^>]*aria-label="Quit Wisp Remote"[^>]*><svg\b/);
  assert.match(htmlSource, /Unofficial\s*<span[^>]*>·<\/span>\s*by\s*<a id="github-link" href="https:\/\/github\.com\/web3illy\/unofficial-wisp-remote">web3illy<\/a>/);
  assert.match(nativeSource, /case "open-github": NSWorkspace\.shared\.open\(URL\(string: "https:\/\/github\.com\/web3illy\/unofficial-wisp-remote"\)!\)/);
});

test("native names and errors remain text and never become markup", () => {
  const h = createHarness();
  const injection = '<img src=x onerror="alert(1)">';
  h.update(nativeState(h, {
    peers: [{ id: "peer-x", name: injection, connected: true, route: "relay" }],
    connectionCount: 1,
    pending: { id: "approval-x", name: injection, phoneCode: "0000", expiresAt: h.clock.now + 60_000 },
    errorMessage: injection,
  }));
  const nameNode = firstDevice(h).children[0].children[1].children[0];
  assert.equal(nameNode.textContent, injection);
  assert.equal(nameNode.children.length, 0);
  assert.equal(h.element("pending-name").textContent, injection);
  assert.equal(h.element("error-message").textContent, injection);
});


test("main menu stays separate from pairing and devices and emits finite navigation", () => {
  const h = createHarness();
  h.update(nativeState(h, { phase: "offline" }));
  assert.equal(h.element("home").hidden, false);
  assert.equal(h.element("pairing").hidden, true);
  assert.equal(h.element("devices").hidden, true);
  h.element("invite").click(); h.element("manage").click();
  assert.deepEqual(plain(h.posts.slice(-2)), [{ action: "show-pairing" }, { action: "show-devices" }]);
  h.update(nativeState(h, { phase: "starting" }));
  assert.equal(h.element("invite").disabled, true);
});

test("auxiliary surfaces hide main content and encryption is not a disclosure", () => {
  for (const surface of ["pairing", "devices"]) {
    const h = createHarness(surface);
    h.update(nativeState(h));
    assert.equal(h.element("home").hidden, true);
    assert.equal(h.element("header").hidden, true);
    assert.equal(h.element("footer").hidden, true);
    assert.equal(h.element(surface).hidden, false);
  }
  assert.doesNotMatch(htmlSource, /<(details|summary)\b/);
});

test("many devices use stable pages and clamp when the last device is removed", () => {
  const h = createHarness("devices");
  const peers = Array.from({ length: 9 }, (_, n) => ({ id: `peer-${n}`, name: `iPhone ${n}`, connected: false }));
  h.update(nativeState(h, { peers }));
  assert.equal(h.element("device-list").children.length, 4);
  assert.equal(h.element("page-count").textContent, "1 / 3");
  h.element("next-page").click(); h.element("next-page").click();
  assert.equal(h.element("device-list").children.length, 1);
  assert.equal(h.element("page-count").textContent, "3 / 3");
  assert.equal(h.element("next-page").disabled, true);
  h.update(nativeState(h, { peers: peers.slice(0, 8) }));
  assert.equal(h.element("page-count").textContent, "2 / 2");
  assert.equal(h.element("device-list").children.length, 4);
  h.update(nativeState(h, { peers: [] }));
  assert.equal(h.element("devices-empty").hidden, false);
  assert.equal(h.element("pagination").hidden, true);
});

test("connecting eyes follow native frames and pending approval replaces QR", () => {
  const h = createHarness("pairing");
  const pending = { id: "pending-1", name: "iPhone", phoneCode: "abcd ef01 2345", expiresAt: h.clock.now + 20_000 };
  h.update(nativeState(h, { phase: "connecting", eyeState: "connecting", pending, invitation: { expiresAt: h.clock.now + 20_000, qrDataUrl: "data:image/png;base64,iVBORw0KGgo=" } }));
  assert.match(h.element("mascot").src, /connecting\.svg$/);
  assert.equal(h.element("pending-card").hidden, false);
  assert.equal(h.element("invite-card").hidden, true);
  h.update(nativeState(h, { phase: "connecting", eyeState: "offline", pending }));
  assert.match(h.element("mascot").src, /offline\.svg$/);
});

test("closed Wisp uses red-eye artwork without changing phone readiness copy", () => {
  const h = createHarness();
  h.update(nativeState(h, { phase: "online", eyeState: "closed", wisp: { state: "closed" } }));
  assert.match(h.element("mascot").src, /closed\.svg$/);
  assert.equal(h.element("status-text").textContent, "iPhone connected");
  assert.equal(h.element("wisp-title").textContent, "Wisp is closed");
  assert.equal(h.element("status").getAttribute("aria-label"), "iPhone: iPhone connected");
  assert.equal(h.element("wisp-card").getAttribute("aria-label"), "Wisp: Wisp is closed");
  assert.equal(h.element("wisp-action").getAttribute("aria-label"), "Open Wisp");
});

test("phone and Wisp status remain independent across offline and running states", () => {
  const h = createHarness();
  h.update(nativeState(h, { phase: "offline", eyeState: "offline", wisp: { state: "running" } }));
  assert.equal(h.element("status-text").textContent, "No iPhone connected");
  assert.equal(h.element("wisp-title").textContent, "Wisp is running");
  assert.equal(h.element("wisp-action").hidden, true);

  h.update(nativeState(h, { phase: "error", errorMessage: "A long connection error remains available to assistive technology", wisp: { state: "missing" } }));
  assert.equal(h.element("status-text").textContent, "Connection unavailable");
  assert.equal(h.element("status-text").getAttribute("title"), "Connection unavailable");
  assert.equal(h.element("wisp-title").textContent, "Wisp isn’t installed");
  assert.equal(h.element("wisp-action").getAttribute("aria-label"), "Download Wisp");
});
