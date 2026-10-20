const $ = (selector, root = document) => root.querySelector(selector);
const app = $("#app");
const chat = $("#chat");
const messagesNode = $("#messages");
const emptyNode = $("#empty");
const loadingNode = $("#loading");
const noticeNode = $("#notice");
const input = $("#message");
const sendButton = $("#send");
const stopButton = $("#stop");
const attachButton = $("#attach");
const attachmentInput = $("#attachment-input");
const attachmentChips = $("#attachment-chips");
const modeButton = $("#mode-button");
const modeMenu = $("#mode-menu");
const thinkingButton = $("#thinking");
const projectButton = $("#project-button");
const projectMenu = $("#project-menu");
const projectDialog = $("#project-dialog");
const projectForm = $("#project-form");
const projectName = $("#project-name");
const projectError = $("#project-error");
const renameDialog = $("#rename-dialog");
const renameForm = $("#rename-form");
const renameTitle = $("#rename-title");
const renameError = $("#rename-error");
const ACTIVITY_LABELS = {
  "fs.read": "Read file", fs_read: "Read file",
  "fs.read_media": "Read image", fs_read_media: "Read image",
  "fs.write": "Write file", fs_write: "Write file",
  "fs.list": "List files", fs_list: "List files",
  "fs.edit": "Edit file", fs_edit: "Edit file",
  "fs.glob": "Find files", fs_glob: "Find files",
  "fs.grep": "Search text", fs_grep: "Search text",
  "bash.run": "Run command", bash_run: "Run command",
  "private_search.query": "Web search", private_search_query: "Web search",
  "memory.store": "Save memory", memory_store: "Save memory",
  "memory.recall": "Recall memory", memory_recall: "Recall memory",
  "memory.get_all": "List memory", memory_get_all: "List memory",
  "memory.update": "Update memory", memory_update: "Update memory",
  "memory.delete": "Delete memory", memory_delete: "Delete memory",
  spawn_agent: "Agent", skill_invoke: "Skill",
};

const state = {
  bootstrap: null,
  view: null,
  selectedId: null,
  selectedProjectId: null,
  draftActive: false,
  draftId: null,
  creationUnknown: false,
  settings: { mode: "auto", modelId: null, thinking: true },
  source: null,
  loading: true,
  working: false,
  uploading: false,
  attachments: [],
  optimistic: null,
  pendingUnknown: false,
  openMenu: null,
  bootstrapRequest: 0,
  sessionRequest: 0,
  settingsBySession: new Map(),
  expandedProjects: new Map(),
  collapsedSections: new Set(),
  sidebarActionAnchor: null,
  sidebarRename: null,
  sessionRemoval: null,
  sessionRemovalBusy: false,
  removal: null,
  removalBusy: false,
  expandedActivities: new Map(),
  sidebarKey: null,
  modelsExpanded: false,
  drafts: new Map(),
  expandedThinking: new Map(),
  messageRenderKey: null,
  messageNodes: new Map(),
  stickToBottom: true,
  streamRetry: null,
  showAllRecents: false,
  theme: "dark",
  largestViewportHeight: 0,
  viewportWidth: 0,
  refreshPromise: null,
  bootstrapValid: false,
  streamAcknowledged: false,
  streamSnapshot: false,
  awaitingSnapshot: false,
  lastStreamEvent: 0,
  phase: "connecting",
  connectionCode: null,
  profile: null,
  profilePromise: null,
  profileLoadedAt: 0,
  readinessSending: false,
  privacyToken: 0,
  privacyCloseTimer: null,
  motionTimer: null,
  sandboxBusy: false,
  sandboxRevision: 0,
  sandboxPending: null,
  avatarUrl: null,
  accountSettings: null,
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function appendInlineMarkdown(parent, text) {
  const tokens = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    if (match[1] !== undefined) {
      parent.append(node("code", "", match[1]));
    } else if (match[2] !== undefined) {
      parent.append(node("strong", "", match[2]));
    } else {
      try {
        const url = new URL(match[4]);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Unsupported link protocol");
        const link = node("a", "", match[3]);
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        parent.append(link);
      } catch {
        parent.append(document.createTextNode(match[0]));
      }
    }
    offset = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}

function markdownBlockStart(line) {
  return /^\s*```/.test(line) || /^#{1,6}\s+/.test(line) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line);
}

function renderAssistantMarkdown(text) {
  const root = node("div", "message-text message-markdown");
  const lines = String(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = node("pre");
      const code = node("code", "", codeLines.join("\n"));
      const language = fence[1].trim();
      if (language) code.setAttribute("aria-label", `${language} code`);
      pre.append(code);
      root.append(pre);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const title = node(`h${heading[1].length}`);
      appendInlineMarkdown(title, heading[2]);
      root.append(title);
      index += 1;
      continue;
    }
    const listItem = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      const ordered = /^\d/.test(listItem[1]);
      const list = node(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const entry = node("li");
        appendInlineMarkdown(entry, item[2]);
        list.append(entry);
        index += 1;
      }
      root.append(list);
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !markdownBlockStart(lines[index])) paragraphLines.push(lines[index++]);
    const paragraph = node("p");
    paragraphLines.forEach((part, partIndex) => {
      if (partIndex) paragraph.append(document.createElement("br"));
      appendInlineMarkdown(paragraph, part);
    });
    root.append(paragraph);
  }
  return root;
}

// Exact Lucide node geometry from the pinned original Wisp UI. See docs/ui-sources.md
// and licenses/LUCIDE.txt; do not replace these with approximate path sketches.
const UI_ICONS = {
  "image": [
    ["rect", {"width": "18", "height": "18", "x": "3", "y": "3", "rx": "2", "ry": "2"}],
    ["circle", {"cx": "9", "cy": "9", "r": "2"}],
    ["path", {"d": "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"}]
  ],
  "file-text": [
    ["path", {"d": "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],
    ["path", {"d": "M14 2v5a1 1 0 0 0 1 1h5"}],
    ["path", {"d": "M10 9H8"}],
    ["path", {"d": "M16 13H8"}],
    ["path", {"d": "M16 17H8"}]
  ],
  "chevron-down": [
    ["path", {"d": "m6 9 6 6 6-6"}]
  ],
  "chevron-left": [
    ["path", {"d": "m15 18-6-6 6-6"}]
  ],
  "shield-check": [
    ["path", {"d": "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],
    ["path", {"d": "m9 12 2 2 4-4"}]
  ],
  "shield-x": [
    ["path", {"d": "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],
    ["path", {"d": "m14.5 9.5-5 5"}],
    ["path", {"d": "m9.5 9.5 5 5"}]
  ],
  "trash-2": [
    ["path", {"d": "M10 11v6"}],
    ["path", {"d": "M14 11v6"}],
    ["path", {"d": "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"}],
    ["path", {"d": "M3 6h18"}],
    ["path", {"d": "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"}]
  ],
  "pencil": [
    ["path", {"d": "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}],
    ["path", {"d": "m15 5 4 4"}]
  ],
  "square-pen": [
    ["path", {"d": "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"}],
    ["path", {"d": "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"}]
  ],
  "plus": [
    ["path", {"d": "M5 12h14"}],
    ["path", {"d": "M12 5v14"}]
  ],
  "folder-open": [
    ["path", {"d": "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"}]
  ],
  "folder-closed": [
    ["path", {"d": "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}],
    ["path", {"d": "M2 10h20"}]
  ],
  "folder": [
    ["path", {"d": "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]
  ],
  "folder-plus": [
    ["path", {"d": "M12 10v6"}],
    ["path", {"d": "M9 13h6"}],
    ["path", {"d": "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]
  ],
  "copy": [
    ["rect", {"width": "14", "height": "14", "x": "8", "y": "8", "rx": "2", "ry": "2"}],
    ["path", {"d": "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]
  ],
  "check": [
    ["path", {"d": "M20 6 9 17l-5-5"}]
  ],
  "sun": [
    ["circle", {"cx": "12", "cy": "12", "r": "4"}],
    ["path", {"d": "M12 2v2"}],
    ["path", {"d": "M12 20v2"}],
    ["path", {"d": "m4.93 4.93 1.41 1.41"}],
    ["path", {"d": "m17.66 17.66 1.41 1.41"}],
    ["path", {"d": "M2 12h2"}],
    ["path", {"d": "M20 12h2"}],
    ["path", {"d": "m6.34 17.66-1.41 1.41"}],
    ["path", {"d": "m19.07 4.93-1.41 1.41"}]
  ],
  "moon": [
    ["path", {"d": "M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"}]
  ],
  "x": [
    ["path", {"d": "M18 6 6 18"}],
    ["path", {"d": "m6 6 12 12"}]
  ],
  "circle-user": [
    ["circle", {"cx": "12", "cy": "12", "r": "10"}],
    ["circle", {"cx": "12", "cy": "10", "r": "3"}],
    ["path", {"d": "M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"}]
  ],
  "file-pen": [
    ["path", {"d": "M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34"}],
    ["path", {"d": "M14 2v5a1 1 0 0 0 1 1h5"}],
    ["path", {"d": "M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z"}]
  ],
  "search": [
    ["path", {"d": "m21 21-4.34-4.34"}],
    ["circle", {"cx": "11", "cy": "11", "r": "8"}]
  ],
  "terminal": [
    ["path", {"d": "M12 19h8"}],
    ["path", {"d": "m4 17 6-6-6-6"}]
  ],
  "brain": [
    ["path", {"d": "M12 18V5"}],
    ["path", {"d": "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"}],
    ["path", {"d": "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"}],
    ["path", {"d": "M17.997 5.125a4 4 0 0 1 2.526 5.77"}],
    ["path", {"d": "M18 18a4 4 0 0 0 2-7.464"}],
    ["path", {"d": "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"}],
    ["path", {"d": "M6 18a4 4 0 0 1-2-7.464"}],
    ["path", {"d": "M6.003 5.125a4 4 0 0 0-2.526 5.77"}]
  ],
  "bot": [
    ["path", {"d": "M12 8V4H8"}],
    ["rect", {"width": "16", "height": "12", "x": "4", "y": "8", "rx": "2"}],
    ["path", {"d": "M2 14h2"}],
    ["path", {"d": "M20 14h2"}],
    ["path", {"d": "M15 13v2"}],
    ["path", {"d": "M9 13v2"}]
  ],
  "sparkles": [
    ["path", {"d": "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"}],
    ["path", {"d": "M20 2v4"}],
    ["path", {"d": "M22 4h-4"}],
    ["circle", {"cx": "4", "cy": "20", "r": "2"}]
  ],
  "wrench": [
    ["path", {"d": "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"}]
  ],
  "globe": [
    ["circle", {"cx": "12", "cy": "12", "r": "10"}],
    ["path", {"d": "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"}],
    ["path", {"d": "M2 12h20"}]
  ],
  "database": [
    ["ellipse", {"cx": "12", "cy": "5", "rx": "9", "ry": "3"}],
    ["path", {"d": "M3 5V19A9 3 0 0 0 21 19V5"}],
    ["path", {"d": "M3 12A9 3 0 0 0 21 12"}]
  ],
  "mail": [
    ["path", {"d": "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"}],
    ["rect", {"x": "2", "y": "4", "width": "20", "height": "16", "rx": "2"}]
  ],
  "code": [
    ["path", {"d": "m16 18 6-6-6-6"}],
    ["path", {"d": "m8 6-6 6 6 6"}]
  ],
  "triangle-alert": [
    ["path", {"d": "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"}],
    ["path", {"d": "M12 9v4"}],
    ["path", {"d": "M12 17h.01"}]
  ]
};
let hapticGeneration = 0;
const HAPTIC_EVENTS = new Set(["prepare", "selection", "light", "context", "success", "warning", "error"]);
function feedbackFor(event) {
  if (event?.isTrusted !== true || event.currentTarget?.disabled || document.hidden) return () => {};
  const generation = hapticGeneration;
  return effect => {
    if (generation !== hapticGeneration || document.hidden || !HAPTIC_EVENTS.has(effect)) return;
    const bridge = window.webkit?.messageHandlers?.wisp;
    if (!bridge) return;
    // Tactile feedback is local and optional; it must never block a user action.
    try { Promise.resolve(bridge.postMessage({ kind: "haptic", event: effect })).catch(() => {}); }
    catch { /* Older native shells and browser previews remain fully functional. */ }
  };
}
function invalidateFeedback(event) { if (event?.isTrusted === true) hapticGeneration += 1; }
document.addEventListener("pointerdown", invalidateFeedback, { capture: true, passive: true });
document.addEventListener("keydown", invalidateFeedback, { capture: true });

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-icon", name);
  for (const [tag, attributes] of UI_ICONS[name]) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    svg.append(element);
  }
  return svg;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

async function request(path, options = {}) {
  if (window.webkit?.messageHandlers?.wisp) {
    const result = await window.webkit.messageHandlers.wisp.postMessage({
      kind: 'request', path, method: options.method || 'GET',
      ...(options.body ? { body: JSON.parse(options.body) } : {}),
    });
    if (!result?.ok) {
      const error = new Error(result?.error?.message || 'Mac is unavailable.');
      error.code = result?.error?.code || 'delivery_unknown';
      error.known = error.code !== 'delivery_unknown'; error.status = result?.status || 503;
      throw error;
    }
    return result.body;
  }
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    cache: "no-store",
  });
  let body = null;
  try { body = await response.json(); } catch { /* An empty success response is valid. */ }
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Request failed (${response.status})`);
    error.code = body?.error?.code || null;
    error.known = error.code !== "delivery_unknown";
    error.status = response.status;
    throw error;
  }
  return body;
}

function bytesBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 4096) binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  return btoa(binary);
}

function base64Bytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4) throw new Error("The iPhone returned an unreadable attachment.");
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function uploadPrepared(prepared, bytes, { append = true } = {}) {
  if (!state.selectedId && !state.draftActive) throw new Error("Choose a chat before adding an attachment.");
  if (append && state.attachments.length >= 10) throw new Error("You can add up to 10 attachments.");
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 5 * 1024 * 1024 || prepared.size !== bytes.length) throw new Error("Each attachment must be smaller than 5 MB.");
  if (state.draftActive) {
    if (state.attachments.reduce((total, item) => total + (item.size || 0), 0) + bytes.length > 15 * 1024 * 1024) throw new Error("Attachments must be smaller than 15 MB in total.");
    const queued = { ...prepared, id: uuid(), local: true, prepared, bytes };
    state.attachments.push(queued);
    return queued;
  }
  const sessionId = state.selectedId;
  let created;
  try {
    created = await request("/bridge/attachments/begin", { method: "POST", body: JSON.stringify({
      sessionId, kind: prepared.kind, filename: prepared.filename, size: bytes.length,
      ...(prepared.mimeType ? { mimeType: prepared.mimeType } : {}),
      ...(prepared.kind === "image" ? { width: prepared.width, height: prepared.height } : {}),
    }) });
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      const chunk = bytes.subarray(offset, offset + 16 * 1024);
      await request("/bridge/attachments/chunk", { method: "POST", body: JSON.stringify({ id: created.id, offset, dataBase64: bytesBase64(chunk) }) });
    }
    const committed = await request("/bridge/attachments/commit", { method: "POST", body: JSON.stringify({ id: created.id }) });
    if (state.selectedId !== sessionId) {
      await request("/bridge/attachments/remove", { method: "POST", body: JSON.stringify({ id: created.id }) }).catch(() => {});
      throw new Error("The selected chat changed while the attachment was uploading.");
    }
    if (append) state.attachments.push(committed);
    return committed;
  } catch (error) {
    if (created?.id) await request("/bridge/attachments/remove", { method: "POST", body: JSON.stringify({ id: created.id }) }).catch(() => {});
    throw error;
  }
}

async function rasterizeImage(file) {
  let source;
  try {
    if (typeof createImageBitmap === "function") source = await createImageBitmap(file);
    else {
      const url = URL.createObjectURL(file);
      try { source = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; }); }
      finally { URL.revokeObjectURL(url); }
    }
    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    const scale = Math.min(1, 2048 / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth; canvas.height = targetHeight;
    canvas.getContext("2d", { alpha: false }).drawImage(source, 0, 0, targetWidth, targetHeight);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("The image could not be prepared.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const stem = file.name.replace(/\.[^.]+$/, "") || "Image";
    return { prepared: { kind: "image", filename: `${stem}.jpg`, size: bytes.length, mimeType: "image/jpeg", width: targetWidth, height: targetHeight }, bytes };
  } finally { source?.close?.(); }
}

async function prepareBrowserFile(file) {
  if (file.type.startsWith("image/")) return rasterizeImage(file);
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) throw new Error("PDFs can be attached from the iPhone app, where their text is extracted safely.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Each attachment must be smaller than 5 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("Browser attachments must be UTF-8 text or images."); }
  if (bytes.subarray(0, 8192).includes(0)) throw new Error("Binary files are not supported.");
  return { prepared: { kind: "file", filename: file.name, size: bytes.length, ...(file.type ? { mimeType: file.type } : {}) }, bytes };
}

async function addPreparedFiles(files) {
  if (!Array.isArray(files) || !files.length || state.uploading) return;
  state.uploading = true; updateControls(); setNotice("Preparing attachment…");
  try {
    for (const value of files.slice(0, 10 - state.attachments.length)) {
      const bytes = base64Bytes(value.dataBase64);
      const prepared = { ...value }; delete prepared.dataBase64;
      await uploadPrepared(prepared, bytes);
      renderAttachmentChips();
    }
    setNotice("");
  } catch (error) { setNotice(error.message || "The attachment could not be added.", true); }
  finally { state.uploading = false; updateControls(); }
}

async function chooseAttachments(event) {
  if ((!state.selectedId && !state.draftActive) || state.uploading || state.attachments.length >= 10) return;
  feedbackFor(event)("light");
  const selectionId = state.selectedId || state.draftId;
  const native = window.webkit?.messageHandlers?.wisp;
  if (native) {
    try {
      const result = await native.postMessage({ kind: "pickFiles", sessionId: selectionId });
      if (!result?.ok) throw new Error(result?.error?.message || "The iPhone file picker could not open.");
      if (selectionId !== (state.selectedId || state.draftId)) return;
      if (result.body?.files) await addPreparedFiles(result.body.files);
    } catch (error) { setNotice(error.message || "The iPhone file picker could not open.", true); }
    return;
  }
  attachmentInput.click();
}

async function addBrowserFiles(files) {
  if (!files.length || state.uploading) return;
  state.uploading = true; updateControls(); setNotice("Preparing attachment…");
  try {
    for (const file of [...files].slice(0, 10 - state.attachments.length)) {
      const { prepared, bytes } = await prepareBrowserFile(file);
      await uploadPrepared(prepared, bytes);
      renderAttachmentChips();
    }
    setNotice("");
  } catch (error) { setNotice(error.message || "The attachment could not be added.", true); }
  finally { attachmentInput.value = ""; state.uploading = false; updateControls(); }
}

async function removeAttachment(id, event) {
  const index = state.attachments.findIndex(item => item.id === id);
  if (index < 0 || state.uploading) return;
  feedbackFor(event)("selection");
  const [item] = state.attachments.splice(index, 1); renderAttachmentChips(); updateControls();
  if (item.local) return;
  try { await request("/bridge/attachments/remove", { method: "POST", body: JSON.stringify({ id: item.id }) }); }
  catch (error) { setNotice(error.message, true); }
}

function attachmentLabel(value) {
  if (value.kind === "image") return value.filename || "Image";
  if (value.kind === "pdf_text") return value.filename || "PDF";
  return value.filename || "File";
}

function attachmentList(values, removable = false) {
  const list = node("div", removable ? "attachment-list composer-attachments" : "attachment-list");
  for (const value of values || []) {
    const chip = node("span", "attachment-chip");
    chip.append(icon(value.kind === "image" ? "image" : "file-text"), node("span", "attachment-name", attachmentLabel(value)));
    if (removable) {
      const remove = node("button", "attachment-remove"); remove.append(icon("x")); remove.type = "button"; remove.setAttribute("aria-label", `Remove ${attachmentLabel(value)}`);
      remove.addEventListener("click", event => removeAttachment(value.id, event)); chip.append(remove);
    }
    list.append(chip);
  }
  return list;
}

function renderAttachmentChips() {
  attachmentChips.replaceChildren();
  if (state.attachments.length) attachmentChips.append(attachmentList(state.attachments, true));
  attachmentChips.hidden = !state.attachments.length;
}

function setNotice(message, isError = false, source = null) {
  state.noticeSource = message ? source : null;
  noticeNode.hidden = !message;
  noticeNode.classList.toggle("error", isError);
  noticeNode.textContent = message || "";
}

function setConnection(connection) {
  if (connection?.state === "connected") state.connectionCode = null;
  else if (connection?.code) state.connectionCode = connection.code;
  if (state.bootstrap) state.bootstrap.connection = { ...state.bootstrap.connection, ...connection };
  const raw = connection?.state || "offline";
  if (raw !== "connected") {
    state.bootstrapValid = false;
    state.streamSnapshot = false;
    if (raw === "error" || raw === "offline") closeStream();
    setPhase(raw === "error" || raw === "offline" ? "offline" : "connecting");
  } else updateReadiness();
  updateControls();
}

function setPhase(phase) {
  state.phase = phase;
  const labels = { connecting: "Connecting to Mac…", bootstrap: "Loading chats…", history: "Loading chat…", live: "Starting live updates…", ready: "Connected", offline: "Mac unavailable" };
  if (state.connectionCode === "wisp_offline") labels.offline = "Open Wisp on your Mac";
  $("#connection").textContent = labels[phase] || labels.connecting;
  $("#connection").dataset.state = phase === "ready" ? "connected" : phase === "offline" ? "offline" : "connecting";
  $("#loading-label").textContent = labels[phase] || labels.connecting;
  state.accountSettings?.refreshConnection();
}

function uiReady() {
  return !document.hidden && state.bootstrapValid && state.bootstrap?.connection?.state === "connected" &&
    (!state.selectedId || (state.streamAcknowledged && state.streamSnapshot && Date.now() - state.lastStreamEvent < 25_000));
}

function updateReadiness() {
  if (uiReady()) setPhase("ready");
  else if (state.bootstrapValid && state.selectedId) setPhase(state.streamSnapshot ? "live" : "history");
  void reportReadiness();
  updateControls();
}

async function reportReadiness() {
  if (!window.webkit?.messageHandlers?.wisp || state.readinessSending) return;
  state.readinessSending = true;
  const ready = uiReady();
  try { await window.webkit.messageHandlers.wisp.postMessage({ kind: "appState", ready }); }
  catch { /* Older companions can still display chats without readiness reporting. */ }
  finally {
    state.readinessSending = false;
    // A background/error transition must not wait for the next heartbeat.
    if (ready && !uiReady()) void reportReadiness();
  }
}

function saveDraft() {
  const key = state.draftActive ? "new-chat" : state.selectedId;
  if (!key) return;
  state.drafts.set(key, {
    text: input.value, attachments: state.attachments,
    optimistic: state.optimistic, pendingUnknown: state.pendingUnknown,
    projectId: state.selectedProjectId, settings: { ...state.settings }, draftId: state.draftId,
  });
}

function restoreDraft(id) {
  const draft = state.drafts.get(id);
  input.value = draft?.text || "";
  state.attachments = draft?.attachments || [];
  state.optimistic = draft?.optimistic || null;
  state.pendingUnknown = draft?.pendingUnknown || false;
  if (id === "new-chat") {
    state.draftId = draft?.draftId || uuid();
    state.selectedProjectId = draft?.projectId || null;
    state.settings = draft?.settings || { mode: state.bootstrap?.preferences?.mode || "auto", modelId: null, thinking: state.bootstrap?.preferences?.thinking ?? true };
  }
  renderAttachmentChips();
  resizeInput();
}

let drawerGesture = null;

function clearDrawerGesture() {
  drawerGesture = null;
  delete app.dataset.drawerDragging;
  app.style.removeProperty("--drawer-offset");
  app.style.removeProperty("--drawer-progress");
}

function openDrawer(open) {
  clearDrawerGesture();
  app.dataset.drawer = open ? "open" : "closed";
  $("#open-sidebar").setAttribute("aria-expanded", String(open));
  $("#open-sidebar").setAttribute("aria-label", open ? "Close conversations" : "Open conversations");
  syncOverlayAccess();
  closeMenus();
  if (open) $("#new-chat").focus();

}

function cancelDrawerGesture() {
  if (!drawerGesture) return;
  const wasOpen = drawerGesture.wasOpen;
  openDrawer(wasOpen);
}

function startDrawerGesture(event) {
  cancelDrawerGesture();
  if (event.touches.length !== 1 || app.inert || !window.matchMedia("(max-width: 760px)").matches) return;
  const target = event.target;
  if (!app.contains(target) || target.closest("input, textarea, select, button, a, summary, pre, code, [contenteditable]")) return;
  const touch = event.touches[0];
  const wasOpen = app.dataset.drawer === "open";
  if ((!wasOpen && touch.clientX > 24) || touch.clientY < $(".topbar").getBoundingClientRect().bottom) return;
  const width = $("#sidebar").getBoundingClientRect().width;
  drawerGesture = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp, width, wasOpen, active: false, offset: wasOpen ? 0 : -width };
}

function moveDrawerGesture(event) {
  const gesture = drawerGesture;
  if (!gesture) return;
  if (event.touches.length !== 1 || app.inert) { cancelDrawerGesture(); return; }
  const touch = [...event.touches].find(value => value.identifier === gesture.identifier);
  if (!touch) { cancelDrawerGesture(); return; }
  const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
  if (!gesture.active) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
    // Decide the axis once: a vertical scroll must never turn into a menu drag.
    if (Math.abs(dx) < Math.abs(dy) * 1.3 || (gesture.wasOpen ? dx >= 0 : dx <= 0)) {
      clearDrawerGesture();
      return;
    }
    if (!event.cancelable) { clearDrawerGesture(); return; }
    gesture.active = true;
    closeMenus();
    app.dataset.drawerDragging = "true";
  }
  if (!event.cancelable) { cancelDrawerGesture(); return; }
  event.preventDefault();
  gesture.offset = Math.max(-gesture.width, Math.min(0, (gesture.wasOpen ? 0 : -gesture.width) + dx));
  app.style.setProperty("--drawer-offset", `${gesture.offset}px`);
  app.style.setProperty("--drawer-progress", String(1 + gesture.offset / gesture.width));
}

function endDrawerGesture(event) {
  const gesture = drawerGesture;
  if (!gesture) return;
  if (!gesture.active) { clearDrawerGesture(); return; }
  if (event.cancelable) event.preventDefault();
  const travel = gesture.wasOpen ? -gesture.offset : gesture.width + gesture.offset;
  const elapsed = Math.max(1, event.timeStamp - gesture.time);
  const committed = travel >= Math.min(100, gesture.width / 3) || (travel >= 32 && travel / elapsed > .45);
  const open = committed ? !gesture.wasOpen : gesture.wasOpen;
  openDrawer(open);
  if (open !== gesture.wasOpen) feedbackFor(event)("light");
  if (!open) $("#open-sidebar").focus();
}

function openProjectDialog(event) {
  openDrawer(false);
  closeMenus();
  projectError.hidden = true;
  projectError.textContent = "";
  projectName.value = "";
  projectDialog.hidden = false;
  feedbackFor(event)("light");
  syncOverlayAccess();
  requestAnimationFrame(() => projectName.focus());
}

function closeProjectDialog(event) {
  if (state.working || projectDialog.hidden) return;
  feedbackFor(event)("light");
  projectDialog.hidden = true;
  projectName.value = "";
  syncOverlayAccess();
  $("#new-chat").focus();
}

function openRenameDialog(event) {
  const session = state.view?.session || state.bootstrap?.sessions?.find((item) => item.id === state.selectedId);
  if (!session || state.working) return;
  closeMenus();
  renameError.hidden = true;
  renameError.textContent = "";
  renameTitle.value = session.title || "";
  renameDialog.hidden = false;
  feedbackFor(event)("light");
  syncOverlayAccess();
  requestAnimationFrame(() => { renameTitle.focus(); renameTitle.select(); });
}

function closeRenameDialog(event) {
  if (state.working || renameDialog.hidden) return;
  feedbackFor(event)("light");
  renameDialog.hidden = true;
  syncOverlayAccess();
  $("#rename-chat").focus();
}

function closeMenus() {
  state.openMenu = null;
  $("#sidebar-context-menu").hidden = true;
  if (state.sidebarActionAnchor) delete state.sidebarActionAnchor.dataset.menuOpen;
  state.sidebarActionAnchor = null;
  for (const [button, menu] of [[modeButton, modeMenu], [projectButton, projectMenu]]) {
    button.setAttribute("aria-expanded", "false");
    menu.hidden = true;
  }
}

function toggleMenu(name, event) {
  if ((name === "mode" ? modeButton : projectButton).disabled) return;
  feedbackFor(event)("light");
  const next = state.openMenu === name ? null : name;
  closeMenus();
  state.openMenu = next;
  if (next === "mode") {
    state.modelsExpanded = state.settings.mode === "model";
    renderModeMenu();
    modeMenu.hidden = false;
    modeButton.setAttribute("aria-expanded", "true");
  } else if (next === "project") {
    renderProjectMenu();
    projectMenu.hidden = false;
    projectButton.setAttribute("aria-expanded", "true");
  }
  positionMenu();
}

function menuItem(choice, selected, onSelect) {
  const button = node("button", "menu-item");
  button.type = "button";
  button.setAttribute("role", "menuitemradio");
  button.setAttribute("aria-checked", String(selected));
  button.disabled = Boolean(choice.disabled);
  button.append(node("span", "menu-check"));
  const copy = node("span", "menu-copy");
  copy.append(node("span", "menu-label", choice.label));
  if (choice.description || choice.disabledReason) copy.append(node("span", "menu-description", choice.disabledReason || choice.description));
  button.append(copy);
  button.addEventListener("click", event => {
    if (button.disabled) return;
    if (!selected) feedbackFor(event)("selection");
    onSelect(); closeMenus(); renderComposerOptions();
  });
  return button;
}

function rememberSettings() {
  if (state.selectedId) state.settingsBySession.set(state.selectedId, { ...state.settings });
}

function renderModeMenu() {
  modeMenu.replaceChildren();
  const modes = state.bootstrap?.modes || [];
  for (const choice of modes) {
    if (choice.id === "model") continue;
    modeMenu.append(menuItem(choice, state.settings.mode === choice.id, () => {
      state.settings.mode = choice.id;
      if (choice.id !== "model") state.settings.modelId = null;
      rememberSettings();
    }));
  }
  const models = state.bootstrap?.models || [];
  if (state.bootstrap?.capabilities?.models && models.length) {
    const group = node("div", "menu-group");
    const moreChoice = modes.find((choice) => choice.id === "model") || { label: "More", description: "Pick a specific model" };
    const more = node("button", "menu-item");
    more.type = "button";
    more.setAttribute("role", "menuitem");
    more.setAttribute("aria-expanded", String(state.modelsExpanded));
    more.append(node("span", "menu-check"));
    const copy = node("span", "menu-copy");
    copy.append(node("span", "menu-label", moreChoice.label), node("span", "menu-description", moreChoice.description));
    more.append(copy, icon("chevron-left"));
    more.addEventListener("click", event => { feedbackFor(event)("light"); state.modelsExpanded = !state.modelsExpanded; renderModeMenu(); positionMenu(); });
    group.append(more);
    if (state.modelsExpanded) {
      for (const choice of models) {
        group.append(menuItem(choice, state.settings.mode === "model" && state.settings.modelId === choice.id, () => {
          state.settings.mode = "model";
          state.settings.modelId = choice.id;
          rememberSettings();
        }));
      }
    }
    modeMenu.append(group);
  }
}

function renderProjectMenu() {
  projectMenu.replaceChildren();
  const projects = state.bootstrap?.projects || [];
  projectMenu.append(menuItem({ id: "", label: "No Project", description: "Start a general chat" }, !state.selectedProjectId, () => {
    createSession(null);
  }));
  for (const project of projects) {
    projectMenu.append(menuItem({ id: project.id, label: project.name, description: "New Chat" }, state.selectedProjectId === project.id, () => {
      createSession(project.id);
    }));
  }
  const create = node("button", "menu-item", "New Project");
  create.type = "button";
  create.setAttribute("role", "menuitem");
  create.addEventListener("click", openProjectDialog);
  projectMenu.append(create);
}

function selectedModeLabel() {
  if (state.settings.mode === "model") {
    return state.bootstrap?.models?.find((item) => item.id === state.settings.modelId)?.label || "More";
  }
  return state.bootstrap?.modes?.find((item) => item.id === state.settings.mode)?.label || "Advanced";
}

function renderComposerOptions() {
  const capabilities = state.bootstrap?.capabilities || {};
  modeButton.hidden = !(capabilities.modes || capabilities.models);
  $("span", modeButton).textContent = selectedModeLabel();
  thinkingButton.hidden = !capabilities.thinking;
  thinkingButton.setAttribute("aria-pressed", String(Boolean(state.settings.thinking)));
  thinkingButton.setAttribute("aria-label", state.settings.thinking ? "Thinking on" : "Thinking off");
  thinkingButton.title = state.settings.thinking ? "Extended thinking: on" : "Extended thinking: off";

  projectButton.hidden = !capabilities.projects;
  if (!projectButton.hidden) {
    const project = state.bootstrap.projects?.find((item) => item.id === state.selectedProjectId);
    $("span", projectButton).textContent = project?.name || "Project";
    const projectIcon = $("svg", projectButton);
    projectIcon.setAttribute("data-icon", project ? "folder" : "folder-plus");
    projectIcon.replaceChildren(...icon(project ? "folder" : "folder-plus").children);
    projectButton.setAttribute("aria-label", project ? `Project: ${project.name}` : "Choose project");
  }
  projectButton.dataset.active = String(Boolean(state.selectedProjectId));
  const sandbox = state.bootstrap?.sandbox;
  const sandboxNode = $("#sandbox-status");
  sandboxNode.hidden = typeof sandbox?.enabled !== "boolean";
  if (!sandboxNode.hidden) {
    $("span", sandboxNode).textContent = sandbox.enabled ? "Sandboxed" : "Unrestricted";
    sandboxNode.setAttribute("aria-label", sandbox.enabled ? "Sandboxed" : "Unrestricted");
    sandboxNode.setAttribute("aria-pressed", String(sandbox.enabled));
    sandboxNode.setAttribute("aria-busy", String(state.sandboxBusy));
    sandboxNode.disabled = state.sandboxBusy || !uiReady();
    const sandboxIcon = $("svg", sandboxNode);
    sandboxIcon.setAttribute("data-icon", sandbox.enabled ? "shield-check" : "shield-x");
    sandboxIcon.replaceChildren(...icon(sandbox.enabled ? "shield-check" : "shield-x").children);
    sandboxNode.title = sandbox.enabled ? "Terminal commands run in OS isolation — click to turn the sandbox off on your Mac for all chats" : "Terminal commands run without OS isolation — click to sandbox them on your Mac for all chats";
    sandboxNode.dataset.active = String(sandbox.enabled);
  }
  const context = state.view?.context;
  const contextNode = $("#context-status");
  contextNode.hidden = !(context?.usedLabel && context?.limitLabel);
  if (!contextNode.hidden) contextNode.textContent = `Context: ${context.usedLabel} / ${context.limitLabel}`;
  $("#rename-chat").disabled = !state.selectedId || state.working;
}

// Native-style context actions without enabling WebKit text selection/callouts.
let sidebarHold = null;
function cancelSidebarHold() {
  if (sidebarHold) clearTimeout(sidebarHold.timer);
  sidebarHold = null;
}

function bindSidebarPress(button, activate, showMenu) {
  let suppressClick = false;
  button.setAttribute("aria-haspopup", "menu");
  const open = feedback => {
    cancelSidebarHold(); suppressClick = true; showMenu();
    if (state.sidebarActionAnchor === button) feedback("context");
  };
  button.addEventListener("pointerdown", event => {
    cancelSidebarHold();
    if (event.isPrimary === false || event.button !== 0 || state.working || state.uploading) return;
    suppressClick = false;
    const feedback = feedbackFor(event); feedback("prepare");
    const hold = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer: null };
    hold.timer = setTimeout(() => {
      if (sidebarHold === hold && button.isConnected) open(feedback);
    }, 450);
    sidebarHold = hold;
  });
  button.addEventListener("pointermove", event => {
    if (sidebarHold?.pointerId === event.pointerId && Math.hypot(event.clientX - sidebarHold.x, event.clientY - sidebarHold.y) > 8) cancelSidebarHold();
  });
  button.addEventListener("pointerup", event => {
    cancelSidebarHold();
    if (suppressClick) event.preventDefault();
  });
  for (const event of ["pointercancel", "pointerleave", "lostpointercapture"]) button.addEventListener(event, cancelSidebarHold);
  button.addEventListener("click", event => {
    if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; return; }
    activate(event);
  });
  button.addEventListener("contextmenu", event => { event.preventDefault(); if (state.sidebarActionAnchor !== button) open(feedbackFor(event)); });
  button.addEventListener("keydown", event => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); open(feedbackFor(event)); }
  });
}

function sessionButton(session) {
  if (state.sidebarRename?.id === session.id) {
    const row = node("div", "session-button session-editing");
    const edit = node("input", "session-rename-input");
    edit.type = "text"; edit.value = state.sidebarRename.title;
    edit.maxLength = 120; edit.setAttribute("aria-label", "Rename conversation");
    edit.addEventListener("input", () => { if (state.sidebarRename?.id === session.id) state.sidebarRename.title = edit.value; });
    edit.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        state.sidebarRename = null; renderSidebar();
      } else if (event.key === "Enter") { event.preventDefault(); void finishSidebarRename(session.id, edit.value, event); }
    });
    edit.addEventListener("blur", event => { void finishSidebarRename(session.id, edit.value, event); });
    row.append(edit);
    requestAnimationFrame(() => { edit.focus(); edit.select(); });
    return row;
  }
  const button = node("button", "session-button", session.title || "New Session");
  button.type = "button";
  button.dataset.active = String(session.id === state.selectedId);
  button.dataset.sessionId = session.id;
  button.title = session.title || "New Session";
  bindSidebarPress(button, event => selectSession(session.id, { event }), () => openSessionActions(session, button));
  return button;
}

function sidebarMenuAction(label, name, action, danger = false) {
  const button = node("button", `sidebar-menu-action${danger ? " danger" : ""}`);
  button.type = "button"; button.setAttribute("role", "menuitem");
  button.append(icon(name), node("span", "", label));
  button.addEventListener("click", action);
  return button;
}

function showSidebarMenu(anchor, actions, label) {
  closeMenus();
  state.openMenu = "sidebar-actions"; state.sidebarActionAnchor = anchor;
  anchor.dataset.menuOpen = "true";
  const menu = $("#sidebar-context-menu");
  menu.setAttribute("aria-label", label);
  menu.replaceChildren(...actions); menu.hidden = false;
  positionMenu(); actions[0]?.focus();
}

function openSessionActions(session, anchor) {
  if (state.working || state.uploading) return;
  const actions = [sidebarMenuAction("Rename", "pencil", event => {
    feedbackFor(event)("light");
    closeMenus();
    state.sidebarRename = { id: session.id, title: session.title || "New Session" };
    renderSidebar();
  })];
  // Original Pin is WebView-local; hidden until Wisp exposes a shared contract.
  if (state.bootstrap?.capabilities?.sessionRemoval) actions.push(sidebarMenuAction("Delete", "trash-2", event => openSessionRemoval(session, event), true));
  showSidebarMenu(anchor, actions, "Conversation actions");
}

async function finishSidebarRename(id, value, event) {
  if (state.sidebarRename?.id !== id) return;
  state.sidebarRename = null;
  const session = state.bootstrap?.sessions?.find(session => session.id === id);
  const title = value.trim();
  if (!session || !title || title === (session.title || "New Session") || state.working) { renderSidebar(); return; }
  const feedback = feedbackFor(event);
  const previous = session.title;
  const replace = title => {
    session.title = title;
    if (state.view?.session?.id === id) state.view.session.title = title;
    renderSidebar();
    if (state.selectedId === id) $("#chat-title").textContent = title;
  };
  state.working = true; replace(title);
  try {
    const result = await request(`/bridge/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) });
    if (result?.session?.id !== id) throw new Error("Unconfirmed rename");
    replace(result.session.title);
    feedback("light");
  } catch {
    feedback("error");
    replace(previous);
    setNotice("Could not rename the conversation. Check Wisp on your Mac.", true);
  } finally { state.working = false; updateControls(); }
}

function quotedTitle(title) {
  const text = (title || "").trim();
  return `“${text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text}”`;
}

function openSessionRemoval(session, event) {
  if (state.working || state.uploading || !state.bootstrap?.capabilities?.sessionRemoval) return;
  closeMenus(); input.blur();
  state.sessionRemoval = { id: session.id };
  $("#remove-session-title").textContent = `Delete ${quotedTitle(session.title)}?`;
  $("#remove-session-copy").textContent = `This deletes the conversation.${session.hasArtifacts ? " The files it made stay on your disk — you can find them in Artifacts." : ""}`;
  $("#remove-session-error").hidden = true;
  $("#remove-session-confirm").hidden = false;
  $("#remove-session-confirm").disabled = false;
  $("#remove-session-confirm").textContent = "Delete conversation";
  $("#remove-session-cancel").textContent = "Cancel";
  $("#remove-session-dialog").hidden = false;
  syncOverlayAccess(); $("#remove-session-close").focus();
  feedbackFor(event)("warning");
}

function closeSessionRemoval(event) {
  if (state.sessionRemovalBusy || $("#remove-session-dialog").hidden) return;
  feedbackFor(event)("light");
  const id = state.sessionRemoval?.id;
  $("#remove-session-dialog").hidden = true; state.sessionRemoval = null;
  syncOverlayAccess();
  ($(`[data-session-id="${id}"]`) || $("#open-sidebar")).focus();
}

async function removeSessionConversation(event) {
  if (!state.sessionRemoval || state.sessionRemovalBusy || state.working || !state.bootstrap?.capabilities?.sessionRemoval) return;
  const feedback = feedbackFor(event);
  const { id } = state.sessionRemoval;
  state.sessionRemovalBusy = true; state.working = true;
  for (const name of ["confirm", "cancel", "close"]) $(`#remove-session-${name}`).disabled = true;
  $("#remove-session-error").hidden = true;
  let confirmed = false;
  try {
    const result = await request(`/bridge/sessions/${encodeURIComponent(id)}/remove`, { method: "POST", body: "{}" });
    confirmed = result?.removedSessionId === id;
  } catch { /* No replay after a lost acknowledgement. Refresh authoritative membership. */ }
  const refreshed = await loadBootstrap({ quiet: true });
  if (confirmed || (refreshed && !state.bootstrap.sessions.some(session => session.id === id))) {
    if (state.bootstrap) state.bootstrap.sessions = state.bootstrap.sessions.filter(session => session.id !== id);
    state.working = false;
    if (state.selectedId === id) {
      const next = state.bootstrap?.sessions?.[0];
      if (next) await selectSession(next.id); else await createSession(null);
    }
    state.drafts.delete(id); state.settingsBySession.delete(id);
    confirmed = true;
  }
  state.working = false; state.sessionRemovalBusy = false;
  for (const name of ["confirm", "cancel", "close"]) $(`#remove-session-${name}`).disabled = false;
  renderSidebar(); updateControls();
  if (confirmed) { feedback("success"); closeSessionRemoval(); }
  else {
    feedback("error");
    $("#remove-session-confirm").hidden = true;
    $("#remove-session-error").textContent = "Deletion could not be confirmed. Check the conversation before trying again.";
    $("#remove-session-error").hidden = false;
    $("#remove-session-cancel").textContent = "Close";
    $("#remove-session-cancel").focus();
  }
}

function sidebarAction(label, name, action) {
  const button = node("button", "section-new");
  button.type = "button"; button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  button.addEventListener("click", action);
  return button;
}

function sectionHeading(label, id, action) {
  const heading = node("div", "section-title");
  const toggle = node("button", "section-toggle");
  toggle.type = "button"; toggle.id = `${id}-toggle`;
  toggle.setAttribute("aria-expanded", String(!state.collapsedSections.has(id)));
  toggle.setAttribute("aria-controls", `${id}-content`);
  toggle.append(node("span", "", label), icon("chevron-down"));
  toggle.addEventListener("click", event => {
    feedbackFor(event)("selection");
    if (state.collapsedSections.has(id)) state.collapsedSections.delete(id);
    else state.collapsedSections.add(id);
    renderSidebar();
    $(`#${id}-toggle`).focus();
  });
  heading.append(toggle, action);
  return heading;
}

function sectionContent(id) {
  const body = node("div", "nav-section-content");
  body.id = `${id}-content`;
  body.hidden = state.collapsedSections.has(id);
  return body;
}

function renderSidebar() {
  const sessions = state.bootstrap?.sessions || [];
  // Original Wisp groups projects by conversations; registered folders remain in the picker.
  const projectIds = [...new Set(sessions.map(session => session.projectId).filter(Boolean))];
  const projects = projectIds.map(id => (state.bootstrap?.projects || []).find(project => project.id === id) || { id, name: "(no folder)", path: null });
  const key = JSON.stringify([sessions, projects, state.selectedId, state.selectedProjectId, [...state.expandedProjects], [...state.collapsedSections], state.showAllRecents, state.bootstrap?.capabilities?.projectRemoval, state.bootstrap?.capabilities?.sessionRemoval, state.sidebarRename?.id]);
  if (key === state.sidebarKey) return;
  state.sidebarKey = key;
  if (state.openMenu === "sidebar-actions") closeMenus();
  const nav = $("#session-nav");
  nav.replaceChildren();
  if (state.bootstrap?.capabilities?.projects) {
    const section = node("section", "nav-section");
    section.append(sectionHeading("Projects", "projects", sidebarAction("New Project", "plus", openProjectDialog)));
    const body = sectionContent("projects");
    if (!projects.length) body.append(node("div", "nav-empty", "No projects yet"));
    for (const project of projects) {
      const label = node("div", "project-label");
      const expanded = state.expandedProjects.get(project.id) ?? (project.id === state.selectedProjectId);
      const toggle = node("button", "project-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", project.name);
      toggle.append(icon(expanded ? "folder-open" : "folder-closed"), node("span", "", project.name));
      toggle.dataset.projectOptions = project.id;
      bindSidebarPress(toggle,
        event => { feedbackFor(event)("selection"); state.expandedProjects.set(project.id, !expanded); renderSidebar(); },
        () => openProjectActions(project, toggle));
      const actions = node("div", "project-actions");
      if (project.path) actions.append(sidebarAction(`New Chat in ${project.name}`, "square-pen", event => createSession(project.id, event)));
      label.append(toggle, actions); body.append(label);
      if (expanded) for (const session of sessions.filter(session => session.projectId === project.id)) body.append(sessionButton(session));
    }
    section.append(body); nav.append(section);
  }
  const recent = node("section", "nav-section recents");
  recent.append(sectionHeading("Recents", "recents", sidebarAction("New Chat in Recents", "square-pen", event => createSession(null, event))));
  const body = sectionContent("recents");
  const recentSessions = sessions.filter(session => !session.projectId).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (!recentSessions.length) body.append(node("div", "nav-empty", "No conversations yet"));
  for (const session of recentSessions.slice(0, state.showAllRecents ? undefined : 30)) body.append(sessionButton(session));
  if (recentSessions.length > 30) {
    const more = node("button", "session-button", state.showAllRecents ? "Show less" : "Show all chats");
    more.type = "button";
    more.addEventListener("click", event => { feedbackFor(event)("light"); state.showAllRecents = !state.showAllRecents; renderSidebar(); });
    body.append(more);
  }
  recent.append(body); nav.append(recent);
}

function openProjectActions(project, anchor) {
  if (state.working || state.uploading) return;
  showSidebarMenu(anchor, [sidebarMenuAction("Remove from Wisp", "trash-2", event => openProjectRemoval(project, event), true)], "Project actions");
}

function openProjectRemoval(project, event) {
  if (state.working || state.uploading) return;
  const sessionIds = (state.bootstrap?.sessions || []).filter(session => session.projectId === project.id).map(session => session.id);
  if (!sessionIds.length) { closeMenus(); return; }
  closeMenus(); input.blur();
  state.removal = { projectId: project.id, sessionIds, activeSessionId: sessionIds.includes(state.selectedId) ? state.selectedId : null };
  $("#remove-project-title").textContent = project.path ? `Remove ${quotedTitle(project.name)} from Wisp?` : "Remove these conversations from Wisp?";
  const hasArtifacts = (state.bootstrap?.sessions || []).some(session => sessionIds.includes(session.id) && session.hasArtifacts);
  $("#remove-project-copy").textContent = `This deletes the ${sessionIds.length} conversation${sessionIds.length === 1 ? "" : "s"} in this project. ${project.path ? `Your folder stays on disk — nothing in ${project.path} is deleted.` : "Nothing on disk is touched."}${hasArtifacts ? " The files they made before it stay on your disk too." : ""}`;
  const supported = Boolean(state.bootstrap?.capabilities?.projectRemoval);
  $("#remove-project-error").hidden = supported;
  $("#remove-project-error").textContent = supported ? "" : "Update Wisp Remote on your Mac to remove project conversations here.";
  $("#remove-project-confirm").hidden = !supported;
  $("#remove-project-confirm").disabled = !supported;
  $("#remove-project-confirm").textContent = "Remove from Wisp";
  $("#remove-project-cancel").textContent = "Cancel";
  $("#remove-project-dialog").hidden = false;
  syncOverlayAccess(); $("#remove-project-close").focus();
  if (supported) feedbackFor(event)("warning");
}

function closeProjectRemoval(event) {
  if (state.removalBusy || $("#remove-project-dialog").hidden) return;
  feedbackFor(event)("light");
  const projectId = state.removal?.projectId;
  $("#remove-project-dialog").hidden = true;
  state.removal = null;
  syncOverlayAccess();
  ($(`[data-project-options="${projectId}"]`) || $("#open-sidebar")).focus();
}

async function removeProjectConversations(event) {
  if (!state.removal || state.removalBusy || state.working || !state.bootstrap?.capabilities?.projectRemoval) return;
  const feedback = feedbackFor(event);
  const removal = state.removal;
  state.removalBusy = true; state.working = true;
  $("#remove-project-confirm").disabled = true;
  $("#remove-project-cancel").disabled = true;
  $("#remove-project-close").disabled = true;
  $("#remove-project-confirm").textContent = "Removing…";
  $("#remove-project-error").hidden = true;
  let result, message = "";
  try {
    result = await request(`/bridge/projects/${encodeURIComponent(removal.projectId)}/remove`, {
      method: "POST", body: JSON.stringify({ sessionIds: removal.sessionIds, activeSessionId: removal.activeSessionId }),
    });
    if (!result.complete) message = "Some conversations could not be removed. Review the updated project before trying again.";
  } catch {
    message = "Removal could not be confirmed. Check the updated project before trying again.";
  }
  // Never replay a destructive command after a lost acknowledgement.
  const removed = new Set((result?.removedSessionIds || []).filter(id => removal.sessionIds.includes(id)));
  for (const id of removed) { state.drafts.delete(id); state.settingsBySession.delete(id); }
  if (state.bootstrap) state.bootstrap.sessions = state.bootstrap.sessions.filter(session => !removed.has(session.id));
  const refreshed = await loadBootstrap({ quiet: true });
  const selectedGone = removed.has(state.selectedId) || (refreshed && state.selectedId && !state.bootstrap.sessions.some(session => session.id === state.selectedId));
  state.working = false;
  if (selectedGone) {
    const id = state.selectedId;
    await createSession(null);
    state.drafts.delete(id);
  }
  state.removalBusy = false;
  $("#remove-project-cancel").disabled = false;
  $("#remove-project-close").disabled = false;
  renderSidebar(); updateControls();
  if (!message && result?.complete) {
    feedback("success");
    closeProjectRemoval();
  } else {
    feedback("error");
    $("#remove-project-confirm").hidden = true;
    $("#remove-project-error").textContent = message;
    $("#remove-project-error").hidden = false;
    $("#remove-project-cancel").textContent = "Close";
    $("#remove-project-cancel").focus();
  }
}

// Original tool registry entries exposed by Remote, followed by Wisp's ordered
// whole-token fallback rules for unfamiliar tool names.
const ACTIVITY_ICONS = {
  "fs.read": "file-text", "fs.read_media": "image", "fs.write": "file-pen",
  "fs.list": "folder-open", "fs.edit": "file-pen", "fs.glob": "search", "fs.grep": "search",
  "bash.run": "terminal", "private_search.query": "search",
  "memory.store": "brain", "memory.recall": "brain", "memory.get_all": "brain",
  "memory.update": "brain", "memory.delete": "trash-2", spawn_agent: "bot", skill_invoke: "sparkles",
};
const ACTIVITY_ICON_RULES = [
  [["search", "find", "query"], "search"],
  [["fetch", "url", "http", "web", "browse"], "globe"],
  [["read", "file", "open", "load"], "file-text"],
  [["write", "save", "create", "edit", "update", "patch", "append", "replace"], "file-pen"],
  [["run", "exec", "bash", "shell", "command", "terminal"], "terminal"],
  [["delete", "remove", "drop", "destroy"], "trash-2"],
  [["think", "reason", "llm", "generate", "ai"], "brain"],
  [["data", "database", "db", "sql", "table", "record"], "database"],
  [["image", "photo", "picture", "screenshot"], "image"],
  [["mail", "email", "send", "message", "notify"], "mail"],
  [["code", "compile", "build", "lint"], "code"],
];
function activityIconName(name) {
  const known = Object.keys(ACTIVITY_ICONS).find(key => key === name || key.replaceAll(".", "_") === name);
  if (known) return ACTIVITY_ICONS[known];
  const tokens = String(name).toLowerCase().split(/[._\-]+/);
  return ACTIVITY_ICON_RULES.find(([keywords]) => keywords.some(word => tokens.includes(word)))?.[1] || "wrench";
}

function activityNode(activity) {
  const details = node("details", "activity");
  details.dataset.status = activity.status || "";
  const key = `${state.selectedId}:${activity.id}`;
  details.open = state.expandedActivities.get(key) ?? ["running", "confirm_required"].includes(activity.status);
  details.addEventListener("toggle", () => { if (details.isConnected) state.expandedActivities.set(key, details.open); });
  const summary = node("summary");
  const rawTitle = activity.title || activity.type || "Activity";
  const glyph = icon(["error", "failed"].includes(activity.status) ? "triangle-alert" : activityIconName(rawTitle));
  glyph.classList.add("activity-icon");
  summary.append(glyph, node("span", "activity-title", ACTIVITY_LABELS[rawTitle] || rawTitle));
  if (activity.status) summary.append(node("span", "activity-state", activity.status.replaceAll("_", " ")));
  const chevron = icon("chevron-down"); chevron.classList.add("activity-chevron"); summary.append(chevron);
  details.append(summary);
  const content = [activity.detail, activity.text].filter(Boolean).join("\n");
  if (content) details.append(node("div", "activity-body", content));
  return details;
}

function appendActivities(parent, activities) {
  if (!activities?.length) return;
  const list = node("div", "activity-list");
  for (const activity of activities) list.append(activityNode(activity));
  parent.append(list);
}

function thinkingNode(text, id, initiallyOpen = false) {
  const details = node("details", "message-thinking");
  const key = `${state.selectedId}:${id}`;
  details.open = state.expandedThinking.get(key) ?? initiallyOpen;
  details.addEventListener("toggle", () => {
    if (details.isConnected) state.expandedThinking.set(key, details.open);
  });
  details.append(node("summary", "", "Thinking..."), node("div", "activity-body", text));
  return details;
}

function messageNode(message) {
  const article = node("article", `message ${message.role === "user" ? "user" : "assistant"}`);
  article.dataset.messageId = message.id || "";
  const content = message.role === "user" ? node("div", "message-content") : article;
  if (content !== article) article.append(content);
  if (message.thinking) {
    article.append(thinkingNode(message.thinking, message.id));
  }
  if (message.text) content.append(message.role === "assistant" ? renderAssistantMarkdown(message.text) : node("div", "message-text", message.text));
  if (message.attachments?.length) content.append(attachmentList(message.attachments));
  appendActivities(article, message.activities);
  if (message.text) {
    const copy = node("button", "copy-message");
    copy.type = "button";
    const label = message.role === "assistant" ? "Copy response" : "Copy message";
    copy.setAttribute("aria-label", label);
    copy.title = label;
    const copyIcon = () => icon("copy");
    copy.append(copyIcon());
    copy.addEventListener("click", async event => {
      const feedback = feedbackFor(event);
      try {
        const native = window.webkit?.messageHandlers?.wisp;
        if (native) {
          const result = await native.postMessage({ kind: "copyText", text: message.text });
          if (!result?.ok) throw new Error("Copy unavailable");
        } else await navigator.clipboard.writeText(message.text);
        feedback("light");
        copy.replaceChildren(icon("check"));
        copy.setAttribute("aria-label", "Copied");
        setTimeout(() => { copy.replaceChildren(copyIcon()); copy.setAttribute("aria-label", label); }, 1600);
      } catch { feedback("error"); setNotice("Select the message text to copy it."); }
    });
    article.append(copy);
  }
  return article;
}

function confirmationNode(confirmation) {
  const card = node("section", "confirmation");
  card.append(node("h2", "", ACTIVITY_LABELS[confirmation.title] || confirmation.title || "Permission required"));
  if (confirmation.description) card.append(node("p", "", confirmation.description));
  const actions = node("div", "confirmation-actions");
  for (const [decision, label, primary] of [["approve_once", "Allow once", true], ["deny", "Deny", false]]) {
    const button = node("button", `confirm-button${primary ? " primary" : ""}`, label);
    button.type = "button";
    button.addEventListener("click", event => decideConfirmation(confirmation.id, decision, actions, event));
    actions.append(button);
  }
  card.append(actions);
  return card;
}

function renderMessages() {
  const history = state.view?.messages || [];
  const renderKey = JSON.stringify([state.selectedId, history, state.view?.run, state.optimistic, state.loading]);
  if (renderKey === state.messageRenderKey) { updateControls(); return; }
  state.messageRenderKey = renderKey;
  const previousScroll = chat.scrollTop;
  const children = [];
  const retained = new Map();
  for (const [index, message] of history.entries()) {
    const key = `${state.selectedId}:${message.id || index}`;
    const fingerprint = JSON.stringify(message);
    const cached = state.messageNodes.get(key);
    const element = cached?.fingerprint === fingerprint ? cached.element : messageNode(message);
    retained.set(key, { fingerprint, element });
    children.push(element);
  }
  state.messageNodes = retained;
  if (state.optimistic && !history.some((message) => message.id === state.optimistic.id)) {
    const optimistic = messageNode({ ...state.optimistic, role: "user" });
    optimistic.classList.add("optimistic");
    children.push(optimistic);
  } else if (state.optimistic) {
    if (state.pendingUnknown) {
      input.value = "";
      state.attachments = [];
      renderAttachmentChips();
      resizeInput();
    }
    state.optimistic = null;
    state.pendingUnknown = false;
  }
  const run = state.view?.run;
  if (run) {
    const active = node("article", "message assistant");
    if (run.thinking) {
      active.append(thinkingNode(run.thinking, `run:${run.id || "active"}`, run.state === "running"));
    }
    if (!run.text && !run.thinking && !(run.activities?.length) && !run.confirmation && !run.error) {
      const labels = {
        running: "Wisp is working…", queued: "Queued", cancelling: "Stopping…",
        awaiting_approval: "Awaiting approval", awaiting_input: "Awaiting input",
      };
      const status = node("div", "run-status");
      if (["running", "queued", "cancelling"].includes(run.state)) status.append(node("span", "spinner"));
      status.append(node("span", "", labels[run.state] || run.state));
      active.append(status);
    }
    if (run.text) {
      const rendered = renderAssistantMarkdown(run.text);
      if (run.state === "running") rendered.classList.add("streaming-caret");
      active.append(rendered);
    }
    appendActivities(active, run.activities);
    if (run.confirmation) active.append(confirmationNode(run.confirmation));
    if (run.error) active.append(node("div", "run-error", run.error));
    children.push(active);
  }
  // Keep unchanged history nodes attached while tokens arrive, preserving focus,
  // selection, expanded details and the reader's scroll position.
  children.forEach((element, index) => {
    if (messagesNode.children[index] !== element) messagesNode.insertBefore(element, messagesNode.children[index] || null);
  });
  while (messagesNode.children.length > children.length) messagesNode.lastElementChild.remove();
  const hasContent = history.length || state.optimistic || run;
  emptyNode.hidden = Boolean(hasContent) || state.loading;
  messagesNode.hidden = !hasContent;
  loadingNode.hidden = !state.loading;
  app.dataset.empty = String(!hasContent);
  if (!state.stickToBottom) chat.scrollTop = previousScroll;
  $("#jump-bottom").hidden = state.stickToBottom || !hasContent;
  updateControls();
}

function render() {
  const session = state.view?.session || state.bootstrap?.sessions?.find((item) => item.id === state.selectedId);
  if (session) state.selectedProjectId = session.projectId || null;
  renderSidebar();
  renderMessages();
  renderComposerOptions();
  $("#chat-title").textContent = session?.title || "New Chat";
  $("#greeting").textContent = greeting();
}

function runIsActive() {
  return ["running", "queued", "confirm_required", "awaiting_input", "awaiting_approval", "cancelling"].includes(state.view?.run?.state);
}

function updateControls() {
  const connected = uiReady();
  const active = runIsActive();
  $("#sandbox-status").disabled = !connected || state.sandboxBusy || typeof state.bootstrap?.sandbox?.enabled !== "boolean";
  input.disabled = !connected || state.loading || state.working || state.uploading || state.pendingUnknown;
  sendButton.hidden = active;
  stopButton.hidden = !active;
  sendButton.disabled = !connected || (!state.selectedId && !state.draftActive) || state.creationUnknown || state.working || state.uploading || (!state.pendingUnknown && !input.value.trim() && !state.attachments.length);
  sendButton.setAttribute("aria-label", state.pendingUnknown ? "Check delivery" : "Send message");
  sendButton.title = state.pendingUnknown ? "Check delivery" : "Send";
  stopButton.disabled = state.working;
  modeButton.disabled = active || state.working || state.pendingUnknown;
  thinkingButton.disabled = active || state.working || state.pendingUnknown;
  projectButton.disabled = active || state.working || state.pendingUnknown;
  attachButton.hidden = !state.bootstrap?.capabilities?.attachments;
  attachButton.disabled = !connected || (!state.selectedId && !state.draftActive) || active || state.working || state.uploading || state.pendingUnknown || state.attachments.length >= 10;
  for (const id of ["#new-chat", "#new-chat-top"]) $(id).disabled = !connected || state.draftActive || state.working || state.uploading;
  $("#rename-chat").disabled = !state.selectedId || state.working;
}

function scrollToBottom(force = false) {
  if (force) state.stickToBottom = true;
  if (state.stickToBottom) requestAnimationFrame(() => {
    chat.scrollTo({ top: chat.scrollHeight, behavior: "auto" });
    $("#jump-bottom").hidden = true;
  });
}

async function loadBootstrap({ quiet = false } = {}) {
  const requestNumber = ++state.bootstrapRequest;
  const sandboxRevision = state.sandboxRevision;
  if (!quiet) state.loading = true;
  try {
    const bootstrap = await request("/bridge/bootstrap");
    if (requestNumber !== state.bootstrapRequest) return false;
    if (state.sandboxBusy || sandboxRevision !== state.sandboxRevision) bootstrap.sandbox = state.bootstrap?.sandbox;
    state.bootstrap = bootstrap;
    state.bootstrapValid = bootstrap.connection?.state === "connected";
    setConnection(bootstrap.connection);
    if (!state.selectedId && !state.draftActive) {
      state.selectedId = bootstrap.selectedSessionId || bootstrap.sessions?.[0]?.id || null;
      if (!state.selectedId) { state.draftActive = true; state.draftId = uuid(); }
    }
    if (!state.selectedId) state.loading = false;
    renderSidebar();
    renderComposerOptions();
    return true;
  } catch (error) {
    if (requestNumber !== state.bootstrapRequest) return false;
    setConnection({ state: "error", code: error.code });
    state.loading = false;
    renderMessages();
    return false;
  }
}

async function loadSession(id, { quiet = false } = {}) {
  if (!id) { state.loading = false; render(); return; }
  const requestNumber = ++state.sessionRequest;
  if (!quiet) { state.loading = true; renderMessages(); }
  try {
    const view = await request(`/bridge/sessions/${encodeURIComponent(id)}`);
    if (id !== state.selectedId || requestNumber !== state.sessionRequest) return;
    state.view = view;
    restoreSessionSettings(view);
    state.loading = false;
    setNotice(state.pendingUnknown ? "Delivery status is unknown. Check delivery before sending another message." : "", state.pendingUnknown);
    render();
    scrollToBottom(!quiet);
    return true;
  } catch (error) {
    if (requestNumber !== state.sessionRequest || id !== state.selectedId) return;
    state.loading = false;
    setConnection({ state: "error", code: error.code });
    renderMessages();
    return false;
  }
}

async function selectSession(id, { internal = false, event } = {}) {
  if (!id || id === state.selectedId) { openDrawer(false); return; }
  if (state.uploading || (state.working && !internal)) {
    setNotice("Wait for the current request to finish.", true); return;
  }
  feedbackFor(event)("selection");
  saveDraft();
  closeStream();
  state.selectedId = id;
  state.draftActive = false;
  state.creationUnknown = false;
  state.view = null;
  restoreDraft(id);
  state.stickToBottom = true;
  setNotice("");
  openDrawer(false);
  renderSidebar();
  state.loading = true;
  setPhase("history");
  render();
  openStream();
}

async function createSession(projectId = null, event) {
  if (state.working || state.uploading) return;
  openDrawer(false);
  closeMenus();
  if (state.draftActive) {
    if (state.selectedProjectId !== projectId) feedbackFor(event)("selection");
    state.selectedProjectId = projectId;
    renderComposerOptions();
    return;
  }
  feedbackFor(event)("light");
  saveDraft();
  closeStream();
  state.sessionRequest += 1;
  state.selectedId = null;
  state.draftActive = true;
  state.view = null;
  state.loading = false;
  restoreDraft("new-chat");
  state.selectedProjectId = projectId;
  state.stickToBottom = true;
  setNotice("");
  render();
  updateReadiness();
  syncOverlayAccess();
}

async function materializeDraft() {
  if (state.selectedId) return;
  const body = { ...(state.selectedProjectId ? { projectId: state.selectedProjectId } : {}) };
  let result;
  try { result = await request("/bridge/sessions", { method: "POST", body: JSON.stringify(body) }); }
  catch (error) {
    // A lost creation acknowledgement must never silently create another chat.
    if (!error.known || error.status >= 500) {
      state.creationUnknown = true;
      error.known = false;
    }
    throw error;
  }
  if (!result?.session?.id) { state.creationUnknown = true; throw new Error("Chat creation could not be confirmed."); }
  state.selectedId = result.session.id;
  state.draftActive = false;
  state.drafts.delete("new-chat");
  state.view = { session: result.session, messages: [], run: null, settings: { ...state.settings } };
  rememberSettings();
  if (state.bootstrap) state.bootstrap.sessions = [result.session, ...(state.bootstrap.sessions || []).filter(session => session.id !== result.session.id)];
}

async function createProject(event) {
  const feedback = feedbackFor(event);
  const name = projectName.value.trim();
  if (!name) {
    feedback("warning");
    projectError.textContent = "Enter a project name.";
    projectError.hidden = false;
    projectName.focus();
    return;
  }
  if (state.working) return;
  state.working = true;
  projectName.disabled = true;
  $("#project-create").disabled = true;
  $("#project-cancel").disabled = true;
  projectError.hidden = true;
  try {
    const result = await request("/bridge/projects", { method: "POST", body: JSON.stringify({ name }) });
    if (!result?.project || !result?.session) throw new Error("Wisp returned an incomplete project response.");
    projectDialog.hidden = true;
    await loadBootstrap({ quiet: true });
    await selectSession(result.session.id, { internal: true });
    feedback("success");
  } catch (error) {
    feedback(error.known ? "error" : "warning");
    projectError.textContent = error.known ? error.message : "The result is unknown. Refresh before trying again.";
    projectError.hidden = false;
  } finally {
    state.working = false;
    projectName.disabled = false;
    $("#project-create").disabled = false;
    $("#project-cancel").disabled = false;
    updateControls();
    syncOverlayAccess();
    if (projectDialog.hidden) input.focus();
  }
}

async function renameSession(event) {
  const feedback = feedbackFor(event);
  const title = renameTitle.value.trim();
  if (!title) {
    feedback("warning");
    renameError.textContent = "Enter a chat title.";
    renameError.hidden = false;
    renameTitle.focus();
    return;
  }
  if (!state.selectedId || state.working) return;
  const sessionId = state.selectedId;
  state.working = true;
  renameTitle.disabled = true;
  $("#rename-save").disabled = true;
  $("#rename-cancel").disabled = true;
  renameError.hidden = true;
  try {
    const result = await request(`/bridge/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH", body: JSON.stringify({ title }),
    });
    if (!result?.session) throw new Error("Wisp returned an incomplete rename response.");
    if (state.view?.session?.id === sessionId) state.view = { ...state.view, session: result.session };
    if (state.bootstrap?.sessions) state.bootstrap = {
      ...state.bootstrap,
      sessions: state.bootstrap.sessions.map((session) => session.id === sessionId ? result.session : session),
    };
    renameDialog.hidden = true;
    render();
    feedback("success");
  } catch (error) {
    feedback(error.known ? "error" : "warning");
    renameError.textContent = error.known ? error.message : "The result is unknown. Refresh before trying again.";
    renameError.hidden = false;
  } finally {
    state.working = false;
    renameTitle.disabled = false;
    $("#rename-save").disabled = false;
    $("#rename-cancel").disabled = false;
    updateControls();
    syncOverlayAccess();
  }
}

async function sendMessage(event) {
  const feedback = feedbackFor(event);
  if (state.pendingUnknown && state.optimistic) input.value = state.optimistic.text;
  const text = input.value.trim();
  if ((!text && !state.attachments.length && !state.optimistic?.attachments?.length) || (!state.selectedId && !state.draftActive) || state.creationUnknown || state.working || state.uploading || runIsActive() || !uiReady()) return;
  const existing = state.pendingUnknown && state.optimistic?.text === text ? state.optimistic : null;
  if (state.pendingUnknown && !existing) {
    setNotice("Delivery status is unknown. Check delivery or open a different chat.", true);
    return;
  }
  const message = existing || { id: uuid(), text, attachments: state.attachments.map(({ bytes, prepared, ...item }) => ({ ...item })) };
  state.optimistic = message;
  if (!existing) state.pendingUnknown = false;
  state.working = true;
  input.blur();
  input.value = "";
  resizeInput();
  setNotice("");
  renderMessages();
  scrollToBottom(true);
  try {
    await materializeDraft();
    for (let index = 0; index < state.attachments.length; index += 1) {
      const attachment = state.attachments[index];
      if (!attachment.local) continue;
      const uploaded = await uploadPrepared(attachment.prepared, attachment.bytes, { append: false });
      state.attachments[index] = uploaded;
    }
    message.attachments = state.attachments.map(({ bytes, prepared, ...item }) => ({ ...item }));
    const payload = { id: message.id, text: message.text, attachments: (message.attachments || []).map(item => item.id), mode: state.settings.mode, thinking: state.settings.thinking };
    if (state.settings.modelId) payload.modelId = state.settings.modelId;
    if (payload.mode === "model" && !payload.modelId) delete payload.mode;
    const result = await request(`/bridge/sessions/${encodeURIComponent(state.selectedId)}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    feedback(result?.accepted === true ? "light" : "warning");
    state.attachments = [];
    renderAttachmentChips();
    if (existing && result?.accepted === true) state.pendingUnknown = false;
    await loadSession(state.selectedId, { quiet: true });
  } catch (error) {
    feedback(error.known ? "error" : "warning");
    input.value = message.text;
    resizeInput();
    if (error.known) {
      state.optimistic = null;
      setNotice(error.message, true);
    } else {
      state.pendingUnknown = true;
      setNotice(state.creationUnknown ? "Chat creation could not be confirmed. Check your chat list before trying again." : "Delivery status is unknown. Check delivery before sending another message.", true);
    }
  } finally {
    state.working = false;
    render();
    if (state.selectedId && !state.source) openStream();
  }
}

async function cancelRun(event) {
  if (!state.selectedId || state.working) return;
  const feedback = feedbackFor(event); feedback("light");
  state.working = true;
  updateControls();
  try {
    await request(`/bridge/sessions/${encodeURIComponent(state.selectedId)}/cancel`, { method: "POST", body: "{}" });
    await loadSession(state.selectedId, { quiet: true });
  } catch (error) {
    feedback("error"); setNotice(error.message, true); }
  finally { state.working = false; updateControls(); }
}

async function decideConfirmation(id, decision, actions, event) {
  if (!state.selectedId || state.working) return;
  const feedback = feedbackFor(event); feedback("light");
  state.working = true;
  for (const button of actions.querySelectorAll("button")) button.disabled = true;
  try {
    await request(`/bridge/sessions/${encodeURIComponent(state.selectedId)}/confirmations/${encodeURIComponent(id)}`, {
      method: "POST", body: JSON.stringify({ decision }),
    });
    await loadSession(state.selectedId, { quiet: true });
  } catch (error) {
    feedback("error");
    setNotice(error.message, true);
    for (const button of actions.querySelectorAll("button")) button.disabled = false;
  } finally { state.working = false; updateControls(); }
}

function restoreSessionSettings(view) {
  const remembered = state.settingsBySession.get(state.selectedId);
  state.settings = remembered || {
    mode: view.settings?.mode ?? state.bootstrap?.preferences?.mode ?? "auto",
    modelId: view.settings?.modelId ?? state.bootstrap?.preferences?.modelId ?? null,
    thinking: view.settings?.thinking ?? state.bootstrap?.preferences?.thinking ?? true,
  };
  if (!remembered) rememberSettings();
}

function applyStreamData(kind, data) {
  state.lastStreamEvent = Date.now();
  if (kind === "ping") { updateReadiness(); return; }
  if (["snapshot", "run", "complete"].includes(kind)) state.sessionRequest += 1;
  if (kind === "snapshot" || kind === "complete") {
    state.view = data;
    state.streamSnapshot = true;
    state.awaitingSnapshot = false;
    restoreSessionSettings(data);
    setConnection({ state: "connected" });
    if (!state.pendingUnknown) setNotice("");
  } else if (kind === "run") {
    if (state.view) state.view = { ...state.view, run: data };
  } else if (kind === "connection") {
    if (data?.state !== "connected") state.awaitingSnapshot = false;
    if (state.bootstrap) state.bootstrap = { ...state.bootstrap, connection: data };
    setConnection(data);
  } else if (kind === "failure") {
    setConnection({ state: "error" });
  }
  if (["snapshot", "complete", "failure"].includes(kind)) state.loading = false;
  updateReadiness();
  render();
  scrollToBottom();
}

function openStream() {
  closeStream();
  state.awaitingSnapshot = Boolean(state.selectedId);
  if (state.selectedId && window.webkit?.messageHandlers?.wisp) {
    const subscription = uuid();
    const listener = event => {
      if (state.source !== nativeSource || event.detail?.subscription !== subscription) return;
      applyStreamData(event.detail.event, event.detail.data);
    };
    window.addEventListener('wisp-remote-event', listener);
    const nativeSource = { close() {
      window.removeEventListener('wisp-remote-event', listener);
      window.webkit.messageHandlers.wisp.postMessage({ kind: 'unsubscribe', subscription }).catch(() => {});
    } };
    state.source = nativeSource;
    const retry = () => {
      if (state.source !== nativeSource) return;
      state.awaitingSnapshot = false;
      setConnection({ state: 'connecting' });
      state.streamRetry = setTimeout(() => { if (state.source === nativeSource) openStream(); }, 2000);
    };
    window.webkit.messageHandlers.wisp.postMessage({ kind: 'subscribe', sessionId: state.selectedId, subscription })
      .then(result => {
        if (state.source !== nativeSource) return;
        if (!result?.ok) retry();
        else { state.streamAcknowledged = true; updateReadiness(); }
      }).catch(retry);
    return;
  }
  if (!state.selectedId || typeof EventSource === "undefined") return;
  const source = new EventSource(`/bridge/events?sessionId=${encodeURIComponent(state.selectedId)}`);
  state.source = source;
  for (const kind of ["snapshot", "run", "complete", "connection", "failure", "ping"]) {
    source.addEventListener(kind, (event) => {
      if (state.source !== source) return;
      try { applyStreamData(kind, JSON.parse(event.data)); } catch { setNotice("Wisp sent an unreadable update.", true); }
    });
  }
  source.addEventListener("open", () => {
    if (state.source !== source) return;
    state.streamAcknowledged = true;
    state.lastStreamEvent = Date.now();
    updateReadiness();
    if (!state.pendingUnknown) setNotice("");
  });
  source.addEventListener("error", () => {
    if (state.source !== source) return;
    state.awaitingSnapshot = false;
    setConnection({ state: "connecting" });
  });
}

function closeStream() {
  clearTimeout(state.streamRetry);
  state.streamRetry = null;
  state.source?.close();
  state.source = null;
  state.streamAcknowledged = false;
  state.streamSnapshot = false;
  state.awaitingSnapshot = false;
  void reportReadiness();
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  updateControls();
}

function greeting() {
  const hour = new Date().getHours();
  const salutation = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (state.profile?.displayName ? salutation + ", " + state.profile.displayName : salutation) + " ✋";
}

$("#greeting").textContent = greeting();
$("#open-sidebar").addEventListener("click", event => { feedbackFor(event)("light"); openDrawer(app.dataset.drawer !== "open"); });
$("#scrim").addEventListener("click", event => { if (app.dataset.drawer === "open") feedbackFor(event)("light"); openDrawer(false); });
$("#new-chat").addEventListener("click", event => createSession(null, event));
$("#new-chat-top").addEventListener("click", event => createSession(null, event));
$("#rename-chat").addEventListener("click", openRenameDialog);
$("#toggle-theme").addEventListener("click", event => { feedbackFor(event)("selection"); applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"); });
$("#composer").addEventListener("submit", (event) => { event.preventDefault(); sendMessage(event); });
// Keep the focused input and button geometry stable until click submits.
// Otherwise iOS blurs first, reveals the footer, and moves Send under the finger.
sendButton.addEventListener("pointerdown", event => {
  if (event.button === 0 && !sendButton.disabled && document.activeElement === input) event.preventDefault();
});
stopButton.addEventListener("click", cancelRun);
attachButton.addEventListener("click", chooseAttachments);
attachmentInput.addEventListener("change", () => { void addBrowserFiles(attachmentInput.files); });
modeButton.addEventListener("click", event => toggleMenu("mode", event));
projectButton.addEventListener("click", event => toggleMenu("project", event));
thinkingButton.addEventListener("click", event => { if (thinkingButton.disabled) return; feedbackFor(event)("selection"); state.settings.thinking = !state.settings.thinking; rememberSettings(); renderComposerOptions(); });
input.addEventListener("input", resizeInput);
document.addEventListener("contextmenu", event => {
  const target = event.target;
  if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
  event.preventDefault();
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing &&
      (!window.matchMedia?.("(pointer: coarse)").matches || event.metaKey || event.ctrlKey)) { event.preventDefault(); sendMessage(event); }
});
document.addEventListener("pointerdown", (event) => {
  if (state.openMenu && !event.target.closest(".picker-wrap, [data-project-options], .session-button, #sidebar-context-menu")) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!$("#remove-session-dialog").hidden) { closeSessionRemoval(); return; }
    if (!$("#remove-project-dialog").hidden) { closeProjectRemoval(); return; }
    if (state.openMenu === "sidebar-actions") { const anchor = state.sidebarActionAnchor; closeMenus(); anchor?.focus(); return; }
    closeMenus(); openDrawer(false); closeProjectDialog(); closeRenameDialog(); closeSettings(); closeFeature(); state.accountSettings?.close(); }
});
projectForm.addEventListener("submit", (event) => { event.preventDefault(); createProject(event); });
$("#project-cancel").addEventListener("click", closeProjectDialog);
projectDialog.addEventListener("pointerdown", (event) => { if (event.target === projectDialog) closeProjectDialog(); });
renameForm.addEventListener("submit", (event) => { event.preventDefault(); renameSession(event); });
$("#rename-cancel").addEventListener("click", closeRenameDialog);
renameDialog.addEventListener("pointerdown", (event) => { if (event.target === renameDialog) closeRenameDialog(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hapticGeneration += 1;
    cancelDrawerGesture();
    cancelSidebarHold(); closeMenus();
    state.bootstrapValid = false;
    closeStream();
  } else resumeConnection();
});
window.addEventListener("wisp-remote-resume", resumeConnection);
window.addEventListener("focus", () => { if (!document.hidden) void refreshConnection(); });
window.addEventListener("beforeunload", closeStream);
setInterval(() => {
  if (!document.hidden) updateReadiness();
  if (!document.hidden && !runIsActive() && !state.working) {
    void refreshConnection();
  }
}, 5000);

function resumeConnection() {
  state.bootstrapValid = false;
  closeStream();
  setPhase("connecting");
  void refreshConnection();
}

function refreshConnection() {
  if (state.refreshPromise) return state.refreshPromise;
  if (state.working || state.uploading || document.hidden) return Promise.resolve();
  // The first snapshot owns initial history loading; a timer must not duplicate it.
  if (state.source && state.awaitingSnapshot) return Promise.resolve();
  state.refreshPromise = (async () => {
    if (!state.bootstrap) setPhase("bootstrap");
    const connected = await loadBootstrap({ quiet: Boolean(state.bootstrap) });
    if (!connected || document.hidden) return;
    if (state.selectedId) {
      if (!state.source) {
        state.loading = !state.view;
        setPhase("history");
        render();
        openStream();
      } else await loadSession(state.selectedId, { quiet: true });
    } else { state.loading = false; render(); }
    updateReadiness();
    void loadProfile();
  })().finally(() => { state.refreshPromise = null; });
  return state.refreshPromise;
}

async function start() {
  void reportReadiness();
  await createSession(null);
  const hintTimer = setTimeout(() => {
    if (!uiReady()) $("#loading-hint").textContent = "The first connection can take a moment. Keep Wisp open on your Mac.";
  }, 8000);
  await refreshConnection();
  if (uiReady()) clearTimeout(hintTimer);
  resizeInput();
}

initializeInterface();
start();

// UI preferences are the only browser-persisted state. Chat content stays in memory.
function applyTheme(choice) {
  state.theme = ["dark", "light", "system"].includes(choice) ? choice : "dark";
  const light = state.theme === "light" || (state.theme === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  $("#toggle-theme").setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
  $("#toggle-theme").setAttribute("aria-pressed", String(light));
  $("#toggle-theme").replaceChildren(icon(light ? "moon" : "sun"));
  if (window.webkit?.messageHandlers?.wisp) {
    window.webkit.messageHandlers.wisp.postMessage({ kind: "appearance", theme: light ? "light" : "dark" }).catch(() => {});
  }
  document.querySelector('meta[name="theme-color"]').content = light ? "#ffffff" : "#100f0d";
  try { localStorage.setItem("wisp-remote-appearance", state.theme); } catch { /* Private storage may be unavailable. */ }
}

function syncOverlayAccess() {
  const dialogOpen = [projectDialog, renameDialog, $("#remove-project-dialog"), $("#remove-session-dialog"), $("#settings-dialog"), $("#account-settings-dialog"), $("#feature-dialog")].some(element => !element.hidden);
  app.inert = dialogOpen;
  const narrow = window.matchMedia?.("(max-width: 760px)").matches;
  $("#sidebar").inert = Boolean(narrow && app.dataset.drawer !== "open");
  // Keep the menu, New Chat and theme controls reachable above the drawer.
  $(".workspace").inert = false;
  chat.inert = Boolean(narrow && app.dataset.drawer === "open");
  $(".composer-zone").inert = Boolean(narrow && app.dataset.drawer === "open");
}

function openSettings(event) {
  openDrawer(false);
  closeMenus();
  input.blur();
  clearTimeout(state.privacyCloseTimer);
  $("#settings-dialog").classList.remove("closing");
  const connection = state.bootstrap?.connection;
  $("#settings-connection").textContent = connection?.state === "connected"
    ? "Connected to Wisp on your Mac." : "Your Mac and Wisp must be running to connect.";
  $("#manage-connection").hidden = !window.webkit?.messageHandlers?.wisp;
  $("#retry-connection").hidden = connection?.state === "connected";
  $("#settings-dialog").hidden = false;
  feedbackFor(event)("light");
  $("#privacy-details").setAttribute("aria-expanded", "true");
  syncOverlayAccess();
  $("#settings-close").focus();
  startPrivacyMotion();
  void loadPrivacy();
}

function closeSettings(event) {
  if ($("#settings-dialog").hidden) return;
  feedbackFor(event)("light");
  state.privacyToken += 1;
  clearTimeout(state.motionTimer);
  $("#privacy-details").setAttribute("aria-expanded", "false");
  $("#settings-dialog").classList.add("closing");
  const finish = () => {
    $("#settings-dialog").hidden = true;
    $("#settings-dialog").classList.remove("closing");
    syncOverlayAccess();
    $("#privacy-details").focus();
  };
  clearTimeout(state.privacyCloseTimer);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
  else state.privacyCloseTimer = setTimeout(finish, 200);
}

function startPrivacyMotion() {
  clearTimeout(state.motionTimer);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const enabled = !reduced;
  const rows = [...$("#privacy-flow").children];
  let step = 0;
  const tick = () => {
    rows.forEach((row, index) => { row.dataset.active = String(index <= step); });
    if (!enabled || $("#settings-dialog").hidden) return;
    const delay = step === 3 ? 1200 : step < 0 ? 400 : 700;
    step = step === 3 ? -1 : step + 1;
    state.motionTimer = setTimeout(tick, delay);
  };
  tick();
}

async function loadPrivacy(refresh = false) {
  const token = ++state.privacyToken;
  if (!refresh) renderPrivacy({ status: "pending", measurements: {}, failedChecks: [] });
  const retry = $("#privacy-refresh");
  retry.disabled = true;
  $("span", retry).textContent = refresh ? "Retrying…" : "Retry verification";
  let result;
  try { result = await request(refresh ? "/bridge/privacy/refresh" : "/bridge/privacy", refresh ? { method: "POST", body: "{}" } : {}); }
  catch { result = { status: "unavailable", measurements: {}, failedChecks: [] }; }
  if (token !== state.privacyToken || $("#settings-dialog").hidden) return;
  renderPrivacy(result);
  retry.disabled = false;
  $("span", retry).textContent = "Retry verification";
}

function renderPrivacy(result) {
  const labels = {
    verified: "Verified by Wisp — measurements match its expected build",
    failed: "Attestation failed",
    unreachable: "Can't reach the secure proxy — check your connection",
    unavailable: "Verification unavailable",
    pending: "Waiting for verification from Wisp…",
  };
  const status = Object.hasOwn(labels, result?.status) ? result.status : "unavailable";
  const verdict = $("#privacy-verdict");
  verdict.replaceChildren(node("strong", "", labels[status]));
  verdict.dataset.state = status;
  verdict.hidden = status === "verified";
  if (status === "unavailable") verdict.append(node("p", "", "Wisp has not supplied verifiable enclave measurements. Check Wisp on your Mac."));
  if (status === "unreachable") verdict.append(node("p", "", "Wisp keeps retrying in the background and will reconnect automatically. Messaging stays locked until the enclave is verified."));
  $("#privacy-details").dataset.attestation = status;
  const measurements = $("#privacy-measurements");
  measurements.hidden = status !== "verified";
  const fields = $("#privacy-fields");
  fields.replaceChildren();
  for (const [key, label] of Object.entries({ appId: "App ID", composeHash: "Compose hash", imageDigest: "Image digest", mrtd: "MRTD" })) {
    const measurement = result?.measurements?.[key];
    if (typeof measurement?.value !== "string") continue;
    const row = node("div", "measure-row"), text = node("div", "measure-text");
    text.append(node("span", "measure-label", label), node("span", "measure-value", measurement.value));
    const match = node("span", "measure-match", measurement.match === true ? "matches expected" : "mismatch");
    match.dataset.match = String(measurement.match === true);
    row.append(text, match); fields.append(row);
  }
  const add = (label, value) => {
    if (typeof value !== "string" || !value) return;
    const row = node("div", "privacy-detail-row");
    row.append(node("span", "", label), node("span", "", value)); fields.append(row);
  };
  add("Key provider", result?.keyProvider);
  add("TCB status", result?.tcbStatus);
  add("Quote fingerprint", result?.quoteFingerprint);
  if (typeof result?.verifiedAt === "string") {
    const time = new Date(result.verifiedAt);
    if (!Number.isNaN(time.getTime())) add("Verified at", time.toLocaleString());
  }
  const checkLabels = { measurement_mismatch: "Measurement mismatch", nonce_freshness: "Nonce freshness", signer_binding: "Signer binding", tcb_status: "TCB status", quote_signature: "Quote signature" };
  const failed = (Array.isArray(result?.failedChecks) ? result.failedChecks : []).map(key => checkLabels[key]).filter(Boolean);
  const failureList = $("#privacy-failures");
  failureList.replaceChildren(); failureList.hidden = !failed.length || status !== "failed";
  if (failed.length) {
    const list = node("ul"); failed.forEach(label => list.append(node("li", "", label)));
    failureList.append(node("strong", "", "Checks that did not pass"), list);
  }
  $("#privacy-refresh").hidden = status !== "failed" && status !== "unreachable";
}

function applySandbox(value) {
  if (typeof value?.enabled !== "boolean" || typeof value?.allowNetwork !== "boolean") throw new Error("Sandbox status is unavailable. Check Wisp on your Mac.");
  state.sandboxRevision += 1;
  if (state.bootstrap) state.bootstrap.sandbox = { enabled: value.enabled, allowNetwork: value.allowNetwork };
  renderComposerOptions();
}

async function readSandboxForSettings() {
  if (state.sandboxPending) { try { await state.sandboxPending; } catch { /* Refresh after a completed uncertain write. */ } }
  const revision = state.sandboxRevision;
  const value = await request("/bridge/sandbox");
  if (revision !== state.sandboxRevision) {
    if (state.sandboxPending) return state.sandboxPending;
    return state.bootstrap?.sandbox;
  }
  applySandbox(value);
  return state.bootstrap?.sandbox || value;
}

async function changeSandbox(field, enabled) {
  if (!["enabled", "allowNetwork"].includes(field) || typeof enabled !== "boolean") throw new Error("Choose a sandbox setting.");
  if (state.sandboxBusy) throw new Error("A sandbox change is already in progress.");
  if (state.phase !== "ready") throw new Error("Connect to your Mac before changing the sandbox.");
  state.sandboxBusy = true; state.sandboxRevision += 1;
  renderComposerOptions();
  const pending = (async () => {
    let dispatched = false;
    try {
      const current = await request("/bridge/sandbox");
      applySandbox(current);
      if (field === "allowNetwork" && !current.enabled) throw new Error("Turn on the sandbox before changing its network access.");
      if (current[field] !== enabled) {
        dispatched = true;
        applySandbox(await request("/bridge/sandbox", { method: "POST", body: JSON.stringify({ [field]: enabled }) }));
      }
      if (state.noticeSource === "sandbox") setNotice("");
      return state.bootstrap.sandbox;
    } catch (error) {
      let reconciled;
      // Never replay a possibly delivered setting change. A read only updates display state.
      if (dispatched) {
        try { reconciled = await request("/bridge/sandbox"); applySandbox(reconciled); } catch { reconciled = null; }
      }
      const failure = new Error(dispatched ? "Could not confirm the sandbox change. Check Wisp on your Mac before trying again." : "Sandbox settings are unavailable. Check Wisp on your Mac.");
      if (reconciled) failure.sandbox = reconciled;
      throw failure;
    }
  })();
  state.sandboxPending = pending;
  try { return await pending; }
  finally {
    state.sandboxPending = null;
    state.sandboxBusy = false;
    renderComposerOptions();
  }
}

async function toggleSandbox(event) {
  if (state.sandboxBusy || state.phase !== "ready" || typeof state.bootstrap?.sandbox?.enabled !== "boolean") return;
  const feedback = feedbackFor(event);
  try { await changeSandbox("enabled", !state.bootstrap.sandbox.enabled); feedback("selection"); }
  catch (error) { feedback("error"); setNotice(error.message, true, "sandbox"); }
}

function renderProfile() {
  $("#greeting").textContent = greeting();
  $("#profile-name").textContent = state.profile?.displayName || "Username";
  const avatar = $("#profile-avatar");
  if (state.avatarUrl) URL.revokeObjectURL(state.avatarUrl);
  state.avatarUrl = null;
  avatar.replaceChildren(icon("circle-user"));
  const value = state.profile?.avatarDataUrl;
  const match = typeof value === "string" && value.length <= 350000 && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return;
  try {
    const bytes = base64Bytes(match[2]);
    if (bytes.length > 262144) return;
    state.avatarUrl = URL.createObjectURL(new Blob([bytes], { type: match[1] }));
    const image = node("img"); image.src = state.avatarUrl; image.alt = "";
    image.addEventListener("error", () => { image.remove(); avatar.append(icon("circle-user")); });
    avatar.replaceChildren(image);
  } catch { /* The informational avatar must never block the interface. */ }
}

function openAccountSettings(event) {
  if (!window.WispAccountSettings) { setNotice("Settings are unavailable. Update Wisp Remote.", true); return; }
  closeMenus(); openDrawer(false); input.blur();
  if (!state.accountSettings) state.accountSettings = window.WispAccountSettings.create({
    host: $("#account-settings-dialog"), request, feedbackFor,
    sandbox: { read: readSandboxForSettings, change: changeSandbox },
    connection: { getState: connectionSettingsState, manage: manageConnection, reconnect: resumeConnection },
    onClose: () => { syncOverlayAccess(); openDrawer(true); $("#open-account-settings").focus(); },
  });
  state.accountSettings.open();
  feedbackFor(event)("light");
  syncOverlayAccess();
  void loadProfile();
}

function connectionSettingsState() {
  return { phase: state.phase, label: $("#connection").textContent, native: Boolean(window.webkit?.messageHandlers?.wisp) };
}

async function manageConnection() {
  if (!window.webkit?.messageHandlers?.wisp) throw new Error("Native connection settings are unavailable.");
  const result = await window.webkit.messageHandlers.wisp.postMessage({ kind: "connectionSettings" });
  if (result?.ok !== true) throw new Error("Connection settings could not be opened.");
}

function loadProfile() {
  if (state.profilePromise) return state.profilePromise;
  if (Date.now() - state.profileLoadedAt < 60_000) return Promise.resolve();
  state.profilePromise = request("/bridge/profile").then(profile => {
    state.profile = profile;
    state.profileLoadedAt = Date.now();
    renderProfile();
  }).catch(() => {
    // Optional on older companions; never delay or fail chat startup for a name.
    state.profileLoadedAt = Date.now();
  }).finally(() => { state.profilePromise = null; });
  return state.profilePromise;
}

function openFeature(feature, event) {
  const titles = { connectors: "Connectors", artifacts: "Artifacts", transcription: "Transcripts" };
  if (!Object.hasOwn(titles, feature)) return;
  feedbackFor(event)("light");
  openDrawer(false);
  closeMenus();
  $("#feature-title").textContent = titles[feature];
  $("#feature-copy").textContent = "Not available on mobile yet. Use the official Wisp app on macOS.";
  $("#feature-dialog").hidden = false;
  syncOverlayAccess();
  $("#feature-close").focus();
}

function closeFeature(event) {
  if ($("#feature-dialog").hidden) return;
  feedbackFor(event)("light");
  $("#feature-dialog").hidden = true;
  syncOverlayAccess();
  $("#open-sidebar").focus();
}

function positionMenu() {
  if (state.openMenu === "sidebar-actions" && state.sidebarActionAnchor) {
    const menu = $("#sidebar-context-menu"), anchor = state.sidebarActionAnchor.getBoundingClientRect();
    const viewport = window.visualViewport;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const top = viewport?.offsetTop || 0;
    menu.style.left = `${Math.max(12, Math.min(anchor.left, width - menu.offsetWidth - 12))}px`;
    menu.style.top = `${Math.max(top + 12, Math.min(anchor.bottom + 4, top + height - menu.offsetHeight - 12))}px`;
    return;
  }
  const menu = state.openMenu === "mode" ? modeMenu : state.openMenu === "project" ? projectMenu : null;
  const button = state.openMenu === "mode" ? modeButton : projectButton;
  if (!menu) return;
  const viewport = window.visualViewport;
  const width = viewport?.width || window.innerWidth;
  const height = viewport?.height || window.innerHeight;
  const anchor = button.getBoundingClientRect();
  menu.style.width = `${Math.min(300, width - 24)}px`;
  menu.style.left = `${Math.max(12, Math.min(anchor.right - Math.min(300, width - 24), width - menu.offsetWidth - 12))}px`;
  menu.style.bottom = `${Math.max(12, window.innerHeight - anchor.top + 8)}px`;
  menu.style.maxHeight = `${Math.max(100, Math.min(440, anchor.top - (viewport?.offsetTop || 0) - 24, height - 100))}px`;
}

function initializeInterface() {
  let appearance = "dark";
  try { appearance = localStorage.getItem("wisp-remote-appearance") || appearance; } catch { /* Optional preference. */ }
  applyTheme(appearance);
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme(state.theme));
  $("#privacy-details").addEventListener("click", openSettings);
  $("#privacy-refresh").addEventListener("click", () => loadPrivacy(true));
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", startPrivacyMotion);
  $("#sandbox-status").addEventListener("click", toggleSandbox);
  $("#open-account-settings").addEventListener("click", openAccountSettings);
  $("#settings-close").addEventListener("click", closeSettings);
  $("#settings-dialog").addEventListener("pointerdown", event => { if (event.target === $("#settings-dialog")) closeSettings(); });
  for (const feature of ["connectors", "artifacts", "transcription"]) $("#open-" + feature).addEventListener("click", event => openFeature(feature, event));
  $("#feature-close").addEventListener("click", closeFeature);
  $("#remove-project-cancel").addEventListener("click", closeProjectRemoval);
  $("#remove-project-close").addEventListener("click", closeProjectRemoval);
  $("#remove-project-confirm").addEventListener("click", removeProjectConversations);
  $("#remove-session-cancel").addEventListener("click", closeSessionRemoval);
  $("#remove-session-close").addEventListener("click", closeSessionRemoval);
  $("#remove-session-confirm").addEventListener("click", removeSessionConversation);
  $("#remove-session-dialog").addEventListener("pointerdown", event => { if (event.target === $("#remove-session-dialog")) closeSessionRemoval(); });
  $("#sidebar-context-menu").addEventListener("keydown", event => {
    if (event.key === "Tab") { closeMenus(); return; }
    const items = [...$("#sidebar-context-menu").querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const current = items.indexOf(document.activeElement);
    const index = event.key === "ArrowDown" ? (current + 1) % items.length
      : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (index !== null) { event.preventDefault(); items[index]?.focus(); }
  });
  $("#remove-project-dialog").addEventListener("pointerdown", event => { if (event.target === $("#remove-project-dialog")) closeProjectRemoval(); });
  $("#session-nav").addEventListener("scroll", () => { cancelSidebarHold(); if (state.openMenu === "sidebar-actions") closeMenus(); }, { passive: true });
  document.addEventListener("touchstart", event => { if (event.touches.length > 1) cancelSidebarHold(); }, { passive: true });
  $("#feature-dialog").addEventListener("pointerdown", event => { if (event.target === $("#feature-dialog")) closeFeature(); });
  $("#manage-connection").addEventListener("click", async () => {
    closeSettings();
    try { await manageConnection(); }
    catch { setNotice("Connection settings are unavailable. Update Wisp Remote on your iPhone.", true); }
  });
  $("#retry-connection").addEventListener("click", async () => {
    closeSettings();
    resumeConnection();
  });
  document.addEventListener("click", event => {
    if (event.target.closest("summary")) feedbackFor(event)("light");
  });
  document.addEventListener("touchstart", startDrawerGesture, { passive: true });
  document.addEventListener("touchmove", moveDrawerGesture, { passive: false });
  document.addEventListener("touchend", endDrawerGesture, { passive: false });
  document.addEventListener("touchcancel", cancelDrawerGesture, { passive: true });
  window.addEventListener("resize", cancelDrawerGesture);
  chat.addEventListener("scroll", () => {
    state.stickToBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    $("#jump-bottom").hidden = state.stickToBottom;
  }, { passive: true });
  $("#jump-bottom").addEventListener("click", () => scrollToBottom(true));
  const resize = () => {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty("--viewport-height", `${viewport?.height || window.innerHeight}px`);
    document.documentElement.style.setProperty("--viewport-top", `${viewport?.offsetTop || 0}px`);
    const height = viewport?.height || window.innerHeight;
    const width = viewport?.width || window.innerWidth;
    if (Math.abs(width - state.viewportWidth) > 5) state.largestViewportHeight = height;
    state.viewportWidth = width;
    state.largestViewportHeight = Math.max(state.largestViewportHeight, height);
    const inputOrClosingKeyboard = document.activeElement === input || app.dataset.keyboard === "true";
    app.dataset.keyboard = String(inputOrClosingKeyboard && (window.innerHeight - height > 120 || state.largestViewportHeight - height > 120));
    positionMenu();
    syncOverlayAccess();
    if (document.activeElement === input) scrollToBottom();
  };
  input.addEventListener("focus", resize);
  input.addEventListener("blur", resize);
  window.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("scroll", resize);
  document.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const overlay = (state.openMenu === "sidebar-actions" ? $("#sidebar-context-menu") : null) || [projectDialog, renameDialog, $("#remove-project-dialog"), $("#remove-session-dialog"), $("#settings-dialog"), $("#account-settings-dialog"), $("#feature-dialog")].find(element => !element.hidden)
      || (app.dataset.drawer === "open" ? $("#sidebar") : null);
    if (!overlay) return;
    const selector = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]';
    const focusable = [
      ...(overlay === $("#sidebar") ? $(".topbar").querySelectorAll(selector) : []),
      ...overlay.querySelectorAll(selector),
    ].filter(element => element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  resize();
}
