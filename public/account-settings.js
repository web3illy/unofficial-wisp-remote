(function () {
  "use strict";

  const TABS = ["permissions", "recording", "billing", "usage", "sandbox", "general", "connection"];
  const TAB_LABELS = {
    permissions: "Permissions",
    recording: "Recording",
    billing: "Billing",
    usage: "Usage",
    sandbox: "Sandbox",
    general: "General",
    connection: "Connection",
  };
  // The first six tabs retain Wisp 0.2.7's exact Lucide icon paths.
  const TAB_ICONS = {
    permissions: [
      ["path", { d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }],
      ["path", { d: "m9 12 2 2 4-4" }],
    ],
    recording: [
      ["path", { d: "M12 19v3" }],
      ["path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }],
      ["rect", { x: "9", y: "2", width: "6", height: "13", rx: "3" }],
    ],
    billing: [
      ["rect", { width: "20", height: "14", x: "2", y: "5", rx: "2" }],
      ["line", { x1: "2", x2: "22", y1: "10", y2: "10" }],
    ],
    usage: [
      ["path", { d: "M3 3v16a2 2 0 0 0 2 2h16" }],
      ["path", { d: "M18 17V9" }],
      ["path", { d: "M13 17V5" }],
      ["path", { d: "M8 17v-3" }],
    ],
    sandbox: [
      ["path", { d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" }],
      ["path", { d: "m3.3 7 8.7 5 8.7-5" }],
      ["path", { d: "M12 22V12" }],
    ],
    general: [
      ["path", { d: "M10 5H3" }],
      ["path", { d: "M12 19H3" }],
      ["path", { d: "M14 3v4" }],
      ["path", { d: "M16 17v4" }],
      ["path", { d: "M21 12h-9" }],
      ["path", { d: "M21 19h-5" }],
      ["path", { d: "M21 5h-7" }],
      ["path", { d: "M8 10v4" }],
      ["path", { d: "M8 12H3" }],
    ],
    connection: [
      ["rect", { x: "2", y: "4", width: "13", height: "10", rx: "2" }],
      ["path", { d: "M6 18h5" }],
      ["path", { d: "M8.5 14v4" }],
      ["rect", { x: "17", y: "8", width: "5", height: "10", rx: "1" }],
    ],
  };
  const MOBILE_UNAVAILABLE = "Not available on mobile. Use the original Wisp app on your Mac.";
  const CONNECTION_PHASES = new Set(["connecting", "bootstrap", "history", "live", "ready", "offline"]);

  function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }

  function icon(definitions) {
    const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    root.setAttribute("viewBox", "0 0 24 24");
    root.setAttribute("fill", "none");
    root.setAttribute("stroke", "currentColor");
    root.setAttribute("stroke-width", "2");
    root.setAttribute("stroke-linecap", "round");
    root.setAttribute("stroke-linejoin", "round");
    root.setAttribute("aria-hidden", "true");
    for (const [tag, attributes] of definitions) {
      const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [name, value] of Object.entries(attributes)) child.setAttribute(name, value);
      root.append(child);
    }
    return root;
  }

  function message(text, kind = "empty") {
    const item = element("p", `account-settings-message account-settings-message-${kind}`, text);
    item.setAttribute("role", kind === "error" ? "alert" : "status");
    return item;
  }

  function section(title, subtitle = "") {
    const root = element("section", "account-settings-section");
    const header = element("div", "account-settings-section-header");
    const heading = element("h3", "account-settings-section-title", title);
    if (subtitle) heading.append(element("span", "account-settings-section-subtitle", subtitle));
    header.append(heading);
    root.append(header);
    return root;
  }

  // Matches the reset caption used by the original Wisp Usage meter.
  function resetCaption(value, now = Date.now()) {
    const at = new Date(value).getTime();
    if (Number.isNaN(at)) return "";
    const remaining = at - now;
    if (remaining <= 0) return "Resetting…";
    const hours = remaining / 3600000;
    if (hours < 24) {
      const wholeHours = Math.floor(hours);
      return `Resets in ${wholeHours}h ${Math.floor((remaining - wholeHours * 3600000) / 60000)}m`;
    }
    if (hours < 168) return `Resets ${new Date(at).toLocaleDateString(undefined, { weekday: "long" })}`;
    return `Resets ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }

  function usageWindow(value) {
    return value && typeof value.percentUsed === "number" && Number.isFinite(value.percentUsed) ? value : null;
  }

  function meter(label, value, now) {
    const rounded = Math.round(value.percentUsed);
    const clamped = Math.max(0, Math.min(100, rounded));
    const root = element("div", "account-settings-meter");
    const head = element("div", "account-settings-meter-head");
    head.append(
      element("p", "account-settings-item-label", label),
      element("p", "account-settings-meter-caption", resetCaption(value.resetsAt, now)),
    );
    const track = element("div", "account-settings-meter-track");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", label);
    track.setAttribute("aria-valuenow", clamped);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuetext", `${rounded}% used`);
    const fill = element("div", "account-settings-meter-fill");
    fill.style.width = `${clamped}%`;
    track.append(fill);
    root.append(head, track, element("p", "account-settings-meter-value", `${rounded}% used`));
    return root;
  }

  function create(options) {
    if (!options || !options.host || typeof options.request !== "function") {
      throw new TypeError("WispAccountSettings requires host and request");
    }
    const { host, request } = options;
    const feedbackFor = typeof options.feedbackFor === "function" ? options.feedbackFor : () => () => {};
    const onClose = typeof options.onClose === "function" ? options.onClose : () => {};
    let openState = false;
    let generation = 0;
    let selectedTab = "usage";
    let usageState = { status: "idle", value: null };
    let tabButtons = new Map();
    let sandboxRequest = 0;
    let sandboxState = { status: "idle", value: null, error: "", busy: false };
    const sandbox = options.sandbox;
    const connection = options.connection;
    let connectionState = { phase: "offline", label: "Connection unavailable", native: false };
    let connectionError = "";
    let connectionBusy = false;
    let connectionRefs = null;

    host.classList.add("account-settings-host");

    function renderUsage() {
      const panel = element("div", "account-settings-content");
      if (usageState.status === "loading" || usageState.status === "idle") {
        panel.append(message("Loading…"));
        return panel;
      }
      if (usageState.status === "error") {
        const error = element("div", "account-settings-error-state");
        error.append(message("Couldn't load usage.", "error"));
        const retry = element("button", "account-settings-secondary", "Retry");
        retry.type = "button";
        retry.addEventListener("click", event => { feedbackFor(event)("light"); void loadUsage(); });
        error.append(retry);
        panel.append(error);
        return panel;
      }
      const response = usageState.value;
      if (!response || response.available !== true) {
        panel.append(message("Usage is not available for this account."));
        return panel;
      }
      const cycle = usageWindow(response.usage?.cycle);
      const daily = usageWindow(response.usage?.daily);
      const weekly = usageWindow(response.usage?.weekly);
      if (!cycle && !daily && !weekly) {
        panel.append(message("No usage information is available."));
        return panel;
      }
      const now = Date.now();
      if (cycle) {
        const plan = section("Plan", typeof response.planName === "string" ? response.planName : "");
        plan.append(meter("This billing period", cycle, now));
        panel.append(plan);
      }
      if (cycle && (daily || weekly)) panel.append(element("hr", "account-settings-rule"));
      if (daily) panel.append(meter("Today", daily, now));
      if (weekly) panel.append(meter("This week", weekly, now));
      return panel;
    }

    function validSandbox(value) {
      return value && typeof value.enabled === "boolean" && typeof value.allowNetwork === "boolean";
    }

    function sandboxRow(label, caption, field) {
      const row = element("div", "account-settings-sandbox-row");
      const control = element("button", "account-settings-switch");
      const description = element("p", "account-settings-sandbox-caption", caption);
      description.id = `sandbox-${field}-caption`;
      control.type = "button";
      control.setAttribute("role", "switch");
      control.setAttribute("aria-label", label);
      control.setAttribute("aria-describedby", description.id);
      control.setAttribute("aria-checked", String(sandboxState.value[field]));
      control.setAttribute("aria-busy", String(sandboxState.busy));
      control.disabled = sandboxState.busy || (field === "allowNetwork" && !sandboxState.value.enabled);
      control.addEventListener("click", event => { if (!control.disabled) void updateSandbox(field, event); });
      row.append(element("p", "account-settings-item-label", label), control, description);
      return row;
    }

    function renderSandbox() {
      const panel = element("div", "account-settings-content");
      const group = section("Sandbox", "( terminal commands )");
      panel.append(group);
      if (sandboxState.status === "loading" || sandboxState.status === "idle") {
        group.append(message("Loading…"));
        return panel;
      }
      if (validSandbox(sandboxState.value)) {
        group.append(
          element("p", "account-settings-sandbox-caption", "Applies to all chats on your Mac."),
          sandboxRow("Sandbox terminal commands", "Run every terminal command in OS isolation. Off, commands reach your whole machine — including files and secrets outside this project", "enabled"),
          sandboxRow("Allow network in the sandbox", sandboxState.value.enabled
            ? "Let commands reach the internet. Off is safer but breaks installs and fetches (npm, pip, git)"
            : "Only applies while the sandbox is on — without it, commands already have your machine's full network", "allowNetwork"),
        );
      }
      if (sandboxState.error) group.append(message(sandboxState.error, "error"));
      if (!validSandbox(sandboxState.value)) {
        const retry = element("button", "account-settings-secondary", "Retry");
        retry.type = "button";
        retry.addEventListener("click", event => { feedbackFor(event)("light"); void loadSandbox(); });
        group.append(retry);
      }
      return panel;
    }

    function readConnectionState() {
      try {
        const value = typeof connection?.getState === "function" ? connection.getState() : null;
        return {
          phase: CONNECTION_PHASES.has(value?.phase) ? value.phase : "offline",
          label: typeof value?.label === "string" && value.label.trim() ? value.label.trim() : "Connection unavailable",
          native: value?.native === true,
        };
      } catch {
        return { phase: "offline", label: "Connection unavailable", native: false };
      }
    }

    function paintConnection() {
      if (!connectionRefs) return;
      const { dot, status, disclosure, actions, manage, reconnect, error } = connectionRefs;
      dot.setAttribute("data-phase", connectionState.phase);
      status.textContent = connectionState.label;
      disclosure.textContent = connectionState.native
        ? "Wisp Remote is an unofficial companion. Your paired iPhone–Mac connection is end-to-end encrypted. Relay operators can see connection metadata. Device transport is separate from Wisp inference verification."
        : "Wisp Remote is an unofficial companion. This web preview does not establish an encrypted iPhone–Mac connection. On a paired iPhone, device transport is end-to-end encrypted; relay operators can see connection metadata. Device transport is separate from Wisp inference verification.";
      manage.hidden = !connectionState.native || typeof connection?.manage !== "function";
      manage.disabled = connectionBusy;
      reconnect.hidden = connectionState.phase !== "offline" || typeof connection?.reconnect !== "function";
      reconnect.disabled = connectionBusy;
      actions.hidden = manage.hidden && reconnect.hidden;
      error.textContent = connectionError;
      error.hidden = !connectionError;
    }

    async function manageConnection(event) {
      if (connectionBusy || !connectionState.native || typeof connection?.manage !== "function") return;
      const feedback = feedbackFor(event); feedback("light");
      connectionBusy = true;
      connectionError = "";
      paintConnection();
      try {
        await connection.manage();
        if (openState) close();
      } catch {
        if (!openState) return;
        connectionBusy = false;
        feedback("error");
        connectionError = "Couldn't open connection management. Try again.";
        paintConnection();
      }
    }

    async function reconnectConnection(event) {
      if (connectionBusy || connectionState.phase !== "offline" || typeof connection?.reconnect !== "function") return;
      const feedback = feedbackFor(event); feedback("light");
      connectionBusy = true;
      connectionError = "";
      paintConnection();
      try {
        await connection.reconnect();
        if (!openState || selectedTab !== "connection") return;
        connectionState = readConnectionState();
      } catch {
        if (!openState) return;
        feedback("error");
        connectionError = "Couldn't reconnect. Try again.";
      }
      connectionBusy = false;
      paintConnection();
    }

    function renderConnection() {
      const panel = element("div", "account-settings-content account-settings-connection");
      const group = section("Connection");
      const statusRow = element("div", "account-settings-connection-status");
      statusRow.setAttribute("role", "status");
      statusRow.setAttribute("aria-live", "polite");
      const dot = element("span", "account-settings-connection-dot");
      dot.setAttribute("aria-hidden", "true");
      const status = element("p", "account-settings-item-label");
      statusRow.append(dot, status);

      const disclosure = element("p", "account-settings-message");
      const actions = element("div", "account-settings-connection-actions");
      const reconnect = element("button", "account-settings-secondary", "Reconnect");
      reconnect.type = "button";
      reconnect.addEventListener("click", event => { void reconnectConnection(event); });
      const manage = element("button", "account-settings-secondary", "Manage connection");
      manage.type = "button";
      manage.addEventListener("click", event => { void manageConnection(event); });
      actions.append(reconnect, manage);
      const error = message("", "error");
      group.append(statusRow, disclosure, actions, error);
      panel.append(group);
      connectionRefs = { panel, dot, status, disclosure, actions, manage, reconnect, error };
      paintConnection();
      return panel;
    }

    async function loadSandbox() {
      const token = ++sandboxRequest;
      sandboxState = { status: "loading", value: null, error: "", busy: false };
      render();
      try {
        if (typeof sandbox?.read !== "function") throw new Error();
        const value = await sandbox.read();
        if (!openState || token !== sandboxRequest) return;
        if (!validSandbox(value)) throw new Error();
        sandboxState = { status: "ready", value, error: "", busy: false };
      } catch {
        if (!openState || token !== sandboxRequest) return;
        sandboxState = { status: "error", value: null, error: "Couldn't load sandbox settings. Check Wisp on your Mac.", busy: false };
      }
      render();
    }

    async function updateSandbox(field, event) {
      if (!openState || sandboxState.busy || !validSandbox(sandboxState.value) ||
          (field === "allowNetwork" && !sandboxState.value.enabled)) return;
      const feedback = feedbackFor(event);
      const token = ++sandboxRequest;
      const enabled = !sandboxState.value[field];
      sandboxState = { ...sandboxState, busy: true, error: "" };
      render();
      try {
        const value = await sandbox.change(field, enabled);
        if (!openState || token !== sandboxRequest) return;
        if (!validSandbox(value)) throw new Error();
        sandboxState = { status: "ready", value, error: "", busy: false };
        feedback(value[field] === enabled ? "selection" : "warning");
      } catch (error) {
        if (!openState || token !== sandboxRequest) return;
        feedback("error");
        // The shared controller reconciles uncertain writes with a GET only.
        const value = validSandbox(error?.sandbox) ? error.sandbox : null;
        sandboxState = { status: value ? "ready" : "error", value, busy: false,
          error: "Could not confirm the sandbox change. Check Wisp on your Mac before trying again." };
      }
      render();
    }

    function renderPanel() {
      connectionRefs = null;
      const panel = selectedTab === "usage" ? renderUsage()
        : selectedTab === "sandbox" ? renderSandbox()
          : selectedTab === "connection" ? renderConnection()
            : element("div", "account-settings-content");
      panel.id = `settings-panel-${selectedTab}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", `settings-tab-${selectedTab}`);
      if (selectedTab !== "usage" && selectedTab !== "sandbox" && selectedTab !== "connection") {
        const unavailable = section(TAB_LABELS[selectedTab]);
        unavailable.append(message(MOBILE_UNAVAILABLE));
        panel.append(unavailable);
      }
      return panel;
    }

    function selectTab(tab, focus = false, event) {
      if (!TABS.includes(tab)) return;
      const changed = selectedTab !== tab;
      if (changed) feedbackFor(event)("selection");
      selectedTab = tab;
      if (tab === "connection") {
        connectionState = readConnectionState();
        connectionError = "";
        connectionBusy = false;
        render();
      } else if (changed && tab === "sandbox") void loadSandbox();
      else render();
      if (focus) tabButtons.get(tab)?.focus();
    }

    function onTabKeydown(event) {
      const current = TABS.indexOf(selectedTab);
      let next = null;
      if (event.key === "ArrowDown") next = TABS[(current + 1) % TABS.length];
      else if (event.key === "ArrowUp") next = TABS[(current - 1 + TABS.length) % TABS.length];
      else if (event.key === "Home") next = TABS[0];
      else if (event.key === "End") next = TABS[TABS.length - 1];
      if (!next) return;
      event.preventDefault();
      selectTab(next, true, event);
    }

    function render() {
      if (!openState) return;
      tabButtons = new Map();
      const dialog = element("div", "account-settings-dialog");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", "Settings");

      const header = element("div", "account-settings-header");
      header.append(element("h2", "account-settings-title", "Settings"));
      const closeButton = element("button", "account-settings-close");
      closeButton.type = "button";
      closeButton.setAttribute("aria-label", "Close");
      closeButton.append(icon([
        ["path", { d: "M18 6 6 18" }],
        ["path", { d: "m6 6 12 12" }],
      ]));
      closeButton.addEventListener("click", close);
      header.append(closeButton);

      const body = element("div", "account-settings-body");
      const sidebar = element("div", "account-settings-sidebar");
      const tabs = element("div", "account-settings-tabs");
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-orientation", "vertical");
      tabs.setAttribute("aria-label", "Settings sections");
      tabs.addEventListener("keydown", onTabKeydown);
      for (const tab of TABS) {
        const button = element("button", "account-settings-tab");
        button.type = "button";
        button.id = `settings-tab-${tab}`;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", tab === selectedTab ? "true" : "false");
        button.setAttribute("aria-controls", `settings-panel-${tab}`);
        button.tabIndex = tab === selectedTab ? 0 : -1;
        button.append(element("span", "account-settings-tab-icon"));
        button.children[0].append(icon(TAB_ICONS[tab]));
        button.append(document.createTextNode(TAB_LABELS[tab]));
        button.addEventListener("click", event => selectTab(tab, false, event));
        tabButtons.set(tab, button);
        tabs.append(button);
      }
      sidebar.append(tabs);
      body.append(sidebar, renderPanel());
      dialog.append(header, body);
      host.replaceChildren(dialog);
    }

    async function loadUsage() {
      const token = ++generation;
      usageState = { status: "loading", value: null };
      render();
      try {
        const value = await request("/bridge/usage");
        if (!openState || token !== generation) return;
        usageState = { status: "ready", value };
      } catch {
        if (!openState || token !== generation) return;
        usageState = { status: "error", value: null };
      }
      render();
    }

    function open() {
      if (openState) return;
      openState = true;
      selectedTab = "usage";
      usageState = { status: "loading", value: null };
      host.hidden = false;
      render();
      void loadUsage();
    }

    function close(event) {
      if (!openState) return;
      feedbackFor(event)("light");
      openState = false;
      generation += 1;
      sandboxRequest += 1;
      host.hidden = true;
      onClose();
    }

    function refreshConnection() {
      if (!openState || selectedTab !== "connection" || !connectionRefs) return;
      connectionState = readConnectionState();
      paintConnection();
    }

    host.addEventListener("pointerdown", event => {
      if (event.target === host) close();
    });
    document.addEventListener("keydown", event => {
      if (openState && event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    host.hidden = true;
    return { open, close, refreshConnection };
  }

  window.WispAccountSettings = { create };
}());
