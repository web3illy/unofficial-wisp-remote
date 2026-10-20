import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/account-settings.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/account-settings.css", import.meta.url), "utf8");

class Element {
  constructor(tag = "div", fragment = false) {
    this.tagName = tag.toUpperCase();
    this.fragment = fragment;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.hidden = false;
    this.tabIndex = 0;
    this.type = "";
    this.id = "";
    this._className = "";
    this._text = "";
    this.classList = {
      add: (...names) => {
        const values = new Set(this._className.split(/\s+/).filter(Boolean));
        for (const name of names) values.add(name);
        this._className = [...values].join(" ");
      },
      contains: name => this._className.split(/\s+/).includes(name),
    };
  }
  set className(value) { this._className = String(value); }
  get className() { return this._className; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === "id") this.id = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  append(...items) {
    for (const item of items) {
      if (item.fragment) { this.append(...[...item.children]); continue; }
      item.parentNode = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = "";
    this.append(...items);
  }
  focus() { this.focused = true; }
  async dispatch(type, fields = {}) {
    const event = { type, key: fields.key, preventDefault() { this.defaultPrevented = true; }, ...fields };
    for (const listener of this.listeners.get(type) || []) await listener(event);
    return event;
  }
}

function harness({ request, sandbox, connection, feedbackFor } = {}) {
  const documentListeners = new Map();
  const document = {
    createElement: tag => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
    createTextNode: text => Object.assign(new Element("#text"), { textContent: text }),
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
  };
  const window = {};
  const context = vm.createContext({ window, document, console, Date, Intl, Object, Number, Math });
  vm.runInContext(source, context);
  const host = new Element("div");
  const calls = [];
  let closeCount = 0;
  const api = window.WispAccountSettings.create({
    host,
    request: async (...args) => {
      calls.push(args);
      if (request) return request(...args);
      return { available: true, planName: "Personal", usage: {} };
    },
    sandbox: sandbox || { read: async () => ({enabled:true,allowNetwork:false}), change: async () => ({enabled:true,allowNetwork:false}) },
    connection, feedbackFor,
    onClose: () => { closeCount += 1; },
  });
  return {
    api,
    host,
    calls,
    closeCount: () => closeCount,
    async keydown(key) {
      const event = { key, preventDefault() { this.defaultPrevented = true; } };
      for (const listener of documentListeners.get("keydown") || []) await listener(event);
      return event;
    },
  };
}

function all(root) {
  const found = [];
  for (const child of root.children) found.push(child, ...all(child));
  return found;
}

function byClass(root, className) {
  return all(root).filter(item => item.classList.contains(className));
}

function button(root, text) {
  const item = all(root).find(candidate => candidate.tagName === "BUTTON" && candidate.textContent.trim() === text);
  assert.ok(item, `Expected button ${text}`);
  return item;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test("opens with the original six tabs plus Connection last and performs only one finite GET", async () => {
  const h = harness();
  h.api.open();
  assert.equal(h.host.hidden, false);
  assert.deepEqual(h.calls, [["/bridge/usage"]]);
  assert.equal(byClass(h.host, "account-settings-dialog")[0].getAttribute("aria-modal"), "true");
  const tabs = byClass(h.host, "account-settings-tab");
  assert.deepEqual(tabs.map(item => item.textContent), ["Permissions", "Recording", "Billing", "Usage", "Sandbox", "General", "Connection"]);
  assert.equal(button(h.host, "Usage").getAttribute("aria-selected"), "true");
  assert.equal(button(h.host, "Usage").tabIndex, 0);
  await settle();
  assert.match(h.host.textContent, /No usage information is available/);
});

test("uses the original six tab icon geometries", () => {
  const h = harness();
  h.api.open();
  const expected = {
    Permissions: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z", "m9 12 2 2 4-4"],
    Recording: ["M12 19v3", "M19 10v2a7 7 0 0 1-14 0v-2"],
    Usage: ["M3 3v16a2 2 0 0 0 2 2h16", "M18 17V9", "M13 17V5", "M8 17v-3"],
    Sandbox: ["M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z", "m3.3 7 8.7 5 8.7-5", "M12 22V12"],
    General: ["M10 5H3", "M12 19H3", "M14 3v4", "M16 17v4", "M21 12h-9", "M21 19h-5", "M21 5h-7", "M8 10v4", "M8 12H3"],
  };
  for (const [label, paths] of Object.entries(expected)) {
    const actual = all(button(h.host, label)).filter(item => item.tagName === "PATH").map(item => item.getAttribute("d"));
    assert.deepEqual(actual, paths, label);
  }
  const billing = all(button(h.host, "Billing"));
  assert.deepEqual(billing.filter(item => ["RECT", "LINE"].includes(item.tagName)).map(item => item.tagName), ["RECT", "LINE"]);
  assert.equal(all(button(h.host, "Recording")).find(item => item.tagName === "RECT").getAttribute("rx"), "3");
});

test("renders original usage rows, reset captions, rounding, and bounded fills", async () => {
  const now = Date.now();
  const h = harness({ request: async () => ({
    available: true,
    planName: "Personal",
    usage: {
      cycle: { percentUsed: 49.6, resetsAt: new Date(now - 1000).toISOString() },
      daily: { percentUsed: 5.2, resetsAt: new Date(now + 2 * 3600000 + 25 * 60000).toISOString() },
      weekly: { percentUsed: 107.7, resetsAt: new Date(now + 2 * 86400000).toISOString() },
    },
  }) });
  h.api.open();
  await settle();
  assert.match(h.host.textContent, /PlanPersonalThis billing periodResetting…50% used/);
  assert.match(h.host.textContent, /TodayResets in 2h 24m5% used|TodayResets in 2h 25m5% used/);
  assert.match(h.host.textContent, /This weekResets [A-Z][a-z]+108% used/);
  const meters = all(h.host).filter(item => item.getAttribute("role") === "progressbar");
  assert.deepEqual(meters.map(item => item.getAttribute("aria-valuenow")), ["50", "5", "100"]);
  assert.deepEqual(meters.map(item => item.getAttribute("aria-valuetext")), ["50% used", "5% used", "108% used"]);
  assert.deepEqual(byClass(h.host, "account-settings-meter-fill").map(item => item.style.width), ["50%", "5%", "100%"]);
});

test("every unsupported tab shows only its heading and the required Mac message", async () => {
  const h = harness();
  h.api.open();
  await settle();
  for (const label of ["Permissions", "Recording", "Billing", "General"]) {
    await button(h.host, label).dispatch("click");
    assert.equal(byClass(h.host, "account-settings-section-title")[0].textContent, label);
    assert.match(h.host.textContent, new RegExp(`${label}Not available on mobile\\. Use the original Wisp app on your Mac\\.`));
    assert.equal(all(h.host).filter(item => item.tagName === "SELECT" || item.getAttribute("role") === "switch").length, 0);
  }
  assert.deepEqual(h.calls, [["/bridge/usage"]]);
});

test("vertical tab keyboard navigation follows original order and focus behavior", async () => {
  const h = harness();
  h.api.open();
  let tablist = all(h.host).find(item => item.getAttribute("role") === "tablist");
  await tablist.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(button(h.host, "Sandbox").getAttribute("aria-selected"), "true");
  assert.equal(button(h.host, "Sandbox").focused, true);
  tablist = all(h.host).find(item => item.getAttribute("role") === "tablist");
  await tablist.dispatch("keydown", { key: "Home" });
  assert.equal(button(h.host, "Permissions").getAttribute("aria-selected"), "true");
  tablist = all(h.host).find(item => item.getAttribute("role") === "tablist");
  await tablist.dispatch("keydown", { key: "End" });
  assert.equal(button(h.host, "Connection").getAttribute("aria-selected"), "true");
  assert.deepEqual(h.calls, [["/bridge/usage"]]);
});

test("Connection reads local state on selection and refreshes the visible panel in place", async () => {
  let state = { phase: "connecting", label: "Connecting…", native: false };
  let reads = 0;
  const h = harness({ connection: { getState: () => { reads += 1; return state; }, manage: async () => {}, reconnect: () => {} } });
  h.api.open();
  await settle();
  await button(h.host, "Connection").dispatch("click");
  assert.equal(reads, 1);
  assert.match(h.host.textContent, /Connecting…/);
  assert.match(h.host.textContent, /web preview does not establish an encrypted iPhone–Mac connection/);
  assert.doesNotMatch(h.host.textContent, /Your paired iPhone–Mac connection is end-to-end encrypted/);
  assert.equal(button(h.host, "Manage connection").hidden, true);
  assert.deepEqual(h.calls, [["/bridge/usage"]]);

  const panel = byClass(h.host, "account-settings-connection")[0];
  panel.scrollTop = 23;
  state = { phase: "offline", label: "Open Wisp on your Mac", native: false };
  h.api.refreshConnection();
  assert.equal(reads, 2);
  assert.equal(byClass(h.host, "account-settings-connection")[0], panel);
  assert.equal(panel.scrollTop, 23);
  assert.match(h.host.textContent, /Open Wisp on your Mac/);
  assert.equal(byClass(h.host, "account-settings-connection-dot")[0].getAttribute("data-phase"), "offline");
  assert.equal(button(h.host, "Reconnect").hidden, false);
  assert.deepEqual(h.calls, [["/bridge/usage"]]);
});

test("Connection routes reconnect and native management through callbacks", async t => {
  await t.test("offline reconnect refreshes status without a request", async () => {
    let state = { phase: "offline", label: "Offline", native: true };
    let reconnects = 0;
    const h = harness({ connection: {
      getState: () => state,
      manage: async () => {},
      reconnect: () => { reconnects += 1; state = { phase: "connecting", label: "Connecting…", native: true }; },
    } });
    h.api.open(); await settle(); await button(h.host, "Connection").dispatch("click");
    await button(h.host, "Reconnect").dispatch("click"); await settle();
    assert.equal(reconnects, 1);
    assert.match(h.host.textContent, /Connecting…/);
    assert.equal(button(h.host, "Reconnect").hidden, true);
    assert.equal(h.closeCount(), 0);
    assert.deepEqual(h.calls, [["/bridge/usage"]]);
  });

  await t.test("successful native management closes Settings", async () => {
    let manages = 0;
    const h = harness({ connection: {
      getState: () => ({ phase: "ready", label: "Connected", native: true }),
      manage: async () => { manages += 1; },
      reconnect: () => {},
    } });
    h.api.open(); await settle(); await button(h.host, "Connection").dispatch("click");
    assert.equal(button(h.host, "Manage connection").hidden, false);
    assert.match(h.host.textContent, /Your paired iPhone–Mac connection is end-to-end encrypted/);
    assert.doesNotMatch(h.host.textContent, /web preview does not establish/);
    await button(h.host, "Manage connection").dispatch("click");
    await settle();
    assert.equal(manages, 1);
    assert.equal(h.host.hidden, true);
    assert.equal(h.closeCount(), 1);
  });

  await t.test("management failure stays open with a safe message", async () => {
    const h = harness({ connection: {
      getState: () => ({ phase: "ready", label: "Connected", native: true }),
      manage: async () => { throw new Error("private native detail"); },
      reconnect: () => {},
    } });
    h.api.open(); await settle(); await button(h.host, "Connection").dispatch("click");
    await button(h.host, "Manage connection").dispatch("click"); await settle();
    assert.equal(h.host.hidden, false);
    assert.match(h.host.textContent, /Couldn't open connection management\. Try again\./);
    assert.doesNotMatch(h.host.textContent, /private native detail/);
  });
});

test("loading, failure, and retry remain scoped to Usage", async () => {
  const pending = deferred();
  let reads = 0;
  const h = harness({ request: () => {
    reads += 1;
    if (reads === 1) return pending.promise;
    return Promise.resolve({ available: true, planName: "Fresh", usage: { daily: { percentUsed: 9 } } });
  } });
  h.api.open();
  assert.match(h.host.textContent, /Loading…/);
  pending.reject(new Error("offline"));
  await settle();
  assert.match(h.host.textContent, /Couldn't load usage/);
  await button(h.host, "Retry").dispatch("click");
  await settle();
  assert.equal(reads, 2);
  assert.match(h.host.textContent, /Today9% used/);
  assert.deepEqual(h.calls, [["/bridge/usage"], ["/bridge/usage"]]);
});

test("unavailable and empty responses are honest empty states", async t => {
  await t.test("unavailable", async () => {
    const h = harness({ request: async () => ({ available: false }) });
    h.api.open();
    await settle();
    assert.match(h.host.textContent, /Usage is not available for this account/);
    assert.equal(byClass(h.host, "account-settings-meter").length, 0);
  });
  await t.test("available without windows", async () => {
    const h = harness({ request: async () => ({ available: true, planName: "Personal", usage: {} }) });
    h.api.open();
    await settle();
    assert.match(h.host.textContent, /No usage information is available/);
    assert.equal(byClass(h.host, "account-settings-meter").length, 0);
  });
});

test("a stale closed response cannot replace a fresh reopening", async () => {
  const first = deferred();
  let reads = 0;
  const h = harness({ request: () => {
    reads += 1;
    if (reads === 1) return first.promise;
    return Promise.resolve({ available: true, planName: "Fresh", usage: { cycle: { percentUsed: 12 } } });
  } });
  h.api.open();
  h.api.close();
  h.api.open();
  await settle();
  assert.match(h.host.textContent, /Fresh/);
  first.resolve({ available: true, planName: "Stale", usage: { cycle: { percentUsed: 99 } } });
  await settle();
  assert.match(h.host.textContent, /Fresh/);
  assert.doesNotMatch(h.host.textContent, /Stale|99%/);
});

test("Escape and the backdrop close once through the integration callback", async () => {
  const h = harness();
  h.api.open();
  const event = await h.keydown("Escape");
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.host.hidden, true);
  assert.equal(h.closeCount(), 1);
  await h.keydown("Escape");
  assert.equal(h.closeCount(), 1);
  h.api.open();
  await h.host.dispatch("pointerdown", { target: h.host });
  assert.equal(h.host.hidden, true);
  assert.equal(h.closeCount(), 2);
});

test("source has no forbidden settings reads, callbacks, or full-screen phone override", () => {
  for (const forbidden of ["/bridge/permissions", "/bridge/account", "/bridge/payments", "/bridge/sandbox", "getProject", "onSandboxChanged"]) {
    assert.doesNotMatch(source, new RegExp(forbidden.replaceAll("/", "\\/")));
  }
  assert.match(source, /request\("\/bridge\/usage"\)/);
  assert.match(css, /background:\s*var\(--bg-overlay-brand\)/);
  assert.match(css, /backdrop-filter:\s*blur\(5px\)/);
  assert.match(css, /width:\s*727px/);
  assert.match(css, /border-radius:\s*var\(--radius-xl/);
  assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 2fr\) 4\.5rem/);
  assert.doesNotMatch(css, /place-items:\s*stretch|border-radius:\s*0\s*;/);
});


function sandboxSwitch(h, label) {
  const control = all(h.host).find(item => item.getAttribute("role") === "switch" && item.getAttribute("aria-label") === label);
  assert.ok(control, `Expected switch ${label}`);
  return control;
}

test("Sandbox loads on selection and mode changes disable network without changing its saved value", async () => {
  let value = {enabled:true, allowNetwork:true}; let reads = 0; const writes = [];
  const h = harness({sandbox:{read:async()=>{reads++;return value;},change:async(field,target)=>{writes.push([field,target]);value={...value,[field]:target};return value;}}});
  h.api.open(); await settle(); assert.equal(reads,0);
  await button(h.host,"Sandbox").dispatch("click"); await settle();
  assert.equal(reads,1);
  assert.match(h.host.textContent,/Applies to all chats on your Mac/);
  await sandboxSwitch(h,"Sandbox terminal commands").dispatch("click"); await settle();
  assert.deepEqual(writes,[["enabled",false]]);
  assert.equal(sandboxSwitch(h,"Sandbox terminal commands").getAttribute("aria-checked"),"false");
  assert.equal(sandboxSwitch(h,"Allow network in the sandbox").disabled,true);
  assert.equal(sandboxSwitch(h,"Allow network in the sandbox").getAttribute("aria-checked"),"true");
  await sandboxSwitch(h,"Allow network in the sandbox").dispatch("click");
  assert.equal(writes.length,1);
});

test("Sandbox waits for authoritative network confirmation and blocks duplicate taps", async () => {
  const pending=deferred(); const writes=[];
  const h=harness({sandbox:{read:async()=>({enabled:true,allowNetwork:false}),change:async(...args)=>{writes.push(args);return pending.promise;}}});
  h.api.open();await button(h.host,"Sandbox").dispatch("click");await settle();
  await sandboxSwitch(h,"Allow network in the sandbox").dispatch("click");
  assert.equal(sandboxSwitch(h,"Allow network in the sandbox").getAttribute("aria-checked"),"false");
  assert.equal(sandboxSwitch(h,"Sandbox terminal commands").disabled,true);
  await sandboxSwitch(h,"Sandbox terminal commands").dispatch("click");
  assert.deepEqual(writes,[["allowNetwork",true]]);
  pending.resolve({enabled:true,allowNetwork:true});await settle();
  assert.equal(sandboxSwitch(h,"Allow network in the sandbox").getAttribute("aria-checked"),"true");
  assert.equal(sandboxSwitch(h,"Sandbox terminal commands").disabled,false);
});

test("Sandbox failures show reconciled state without repeating a write and a later success clears the error", async () => {
  let writes=0;
  const h=harness({sandbox:{read:async()=>({enabled:true,allowNetwork:false}),change:async()=>{
    writes++; if(writes===1) throw Object.assign(new Error('uncertain'),{sandbox:{enabled:false,allowNetwork:false}});
    return {enabled:true,allowNetwork:false};
  }}});
  h.api.open();await button(h.host,"Sandbox").dispatch("click");await settle();
  await sandboxSwitch(h,"Sandbox terminal commands").dispatch("click");await settle();
  assert.equal(writes,1);assert.match(h.host.textContent,/Could not confirm/);
  assert.equal(sandboxSwitch(h,"Sandbox terminal commands").getAttribute("aria-checked"),"false");
  await sandboxSwitch(h,"Sandbox terminal commands").dispatch("click");await settle();
  assert.equal(writes,2);assert.doesNotMatch(h.host.textContent,/Could not confirm/);
});

test("Sandbox load failure can retry and stale responses cannot overwrite a reopened section", async () => {
  const stale=deferred();let reads=0;
  const h=harness({sandbox:{read:async()=>{reads++;if(reads===1)throw new Error();if(reads===2)return stale.promise;return {enabled:false,allowNetwork:false};}}});
  h.api.open();await button(h.host,"Sandbox").dispatch("click");await settle();
  assert.match(h.host.textContent,/Couldn't load sandbox settings/);
  await button(h.host,"Retry").dispatch("click");
  h.api.close();h.api.open();await button(h.host,"Sandbox").dispatch("click");await settle();
  stale.resolve({enabled:true,allowNetwork:true});await settle();
  assert.equal(sandboxSwitch(h,"Sandbox terminal commands").getAttribute("aria-checked"),"false");
});

test('Settings haptics follow tab changes and confirmed switches, never rendering or an unchanged tab', async () => {
  const effects=[];let resolveChange;
  const h=harness({feedbackFor:event=>effect=>{if(event?.isTrusted)effects.push(effect);},
    sandbox:{read:async()=>({enabled:true,allowNetwork:false}),change:()=>new Promise(resolve=>{resolveChange=resolve;})}});
  h.api.open();await settle();
  assert.deepEqual(effects,[]);
  await button(h.host,'Usage').dispatch('click',{isTrusted:true});
  assert.deepEqual(effects,[]);
  await button(h.host,'Sandbox').dispatch('click',{isTrusted:true});await settle();
  assert.deepEqual(effects,['selection']);
  const control=byClass(h.host,'account-settings-switch')[0];
  await control.dispatch('click',{isTrusted:true});
  assert.deepEqual(effects,['selection']);
  resolveChange({enabled:false,allowNetwork:false});await settle();
  assert.deepEqual(effects,['selection','selection']);
});
