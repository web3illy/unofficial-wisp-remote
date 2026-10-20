const $ = (selector) => document.querySelector(selector);
const post = (message) => window.webkit?.messageHandlers?.menu?.postMessage(message);
const QR_PNG = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

const initialState = {
  phase: "starting", peers: [], connectionCount: 0, pending: null,
  invitation: null, errorMessage: null, loadingInvite: false,
  now: Date.now(), reduceMotion: false, wisp: null,
};
let state = initialState;
let receivedAt = Date.now();
let confirmingPeerId = null;
let lastHeight = 0;
let deviceRenderKey = null;
let surface = ["pairing", "devices"].includes(window.wispMenuSurface) ? window.wispMenuSurface : "main";
let devicePage = 0;
const PAGE_SIZE = 4;

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined && text !== null) item.textContent = String(text);
  return item;
}

function currentNow() {
  return Number(state.now) + Math.max(0, Date.now() - receivedAt);
}

function secondsLeft(expiresAt) {
  const expiration = Number(expiresAt);
  if (!Number.isFinite(expiration)) return 0;
  return Math.max(0, Math.ceil((expiration - currentNow()) / 1000));
}

function countdownLabel(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function phaseCopy() {
  if (state.phase === "online") {
    const count = Math.max(1, Number(state.connectionCount) || 1);
    return count === 1 ? "iPhone connected" : `${count} phones connected`;
  }
  if (state.phase === "connecting") return "Connecting iPhone…";
  if (state.phase === "offline") return "No iPhone connected";
  if (state.phase === "error") return "Connection unavailable";
  return "Starting…";
}

function renderHeader() {
  const phase = ["starting", "connecting", "offline", "online", "error"].includes(state.phase) ? state.phase : "error";
  document.body.dataset.surface = surface;
  $("#panel").dataset.phase = phase;
  $("#status").dataset.phase = phase;
  const copy = phaseCopy();
  const statusText = $("#status-text");
  if (statusText.textContent !== copy) statusText.textContent = copy;
  statusText.setAttribute("title", copy);
  $("#status").setAttribute("aria-label", `iPhone: ${copy}`);
  const icon = state.eyeState || (phase === "online" ? "online" : phase === "connecting" ? "connecting" : "offline");
  $("#mascot").src = `./wisp-assets/remote-ghost-${["online", "connecting", "closed"].includes(icon) ? icon : "offline"}.svg`;
  $("#mascot").alt = "";
  document.body.classList.toggle("reduce-motion", Boolean(state.reduceMotion));
  document.body.classList.toggle("reduce-transparency", Boolean(state.reduceTransparency));
  $("#header").hidden = surface !== "main";
  $("#home").hidden = surface !== "main";
  $("#footer").hidden = surface !== "main";
  $("#pairing").hidden = surface !== "pairing";
  $("#devices").hidden = surface !== "devices";
}

function renderError() {
  const visible = state.phase === "error" || Boolean(state.errorMessage);
  $("#error-card").hidden = !visible;
  $("#error-message").textContent = state.errorMessage || "Couldn’t start the connection.";
}

function renderWisp() {
  const wispState = state.wisp?.state;
  const card = $("#wisp-card");
  const action = $("#wisp-action");
  const valid = ["missing", "closed", "running"].includes(wispState);
  const copy = wispState === "running" ? "Wisp is running" : wispState === "closed" ? "Wisp is closed" : wispState === "missing" ? "Wisp isn’t installed" : "Checking Wisp…";
  card.dataset.state = valid ? wispState : "checking";
  card.setAttribute("aria-label", `Wisp: ${copy}`);
  const title = $("#wisp-title");
  title.textContent = copy;
  title.setAttribute("title", copy);
  action.hidden = !["missing", "closed"].includes(wispState);
  action.textContent = wispState === "missing" ? "Get" : "Open";
  action.setAttribute("aria-label", wispState === "missing" ? "Download Wisp" : "Open Wisp");
}

function renderPending() {
  const pending = state.pending;
  $("#pending-card").hidden = !pending;
  if (!pending) return;
  $("#pending-name").textContent = pending.name || "This phone";
  $("#pending-code").textContent = pending.phoneCode || "—";
  const left = secondsLeft(pending.expiresAt);
  $("#pending-countdown").textContent = left ? `Request expires in ${countdownLabel(left)}` : "Request expired";
  $("#approve").disabled = left === 0;
  $("#reject").disabled = left === 0;
}

function validQrDataUrl(value) {
  return typeof value === "string" && value.length <= 2_000_000 && QR_PNG.test(value);
}

function renderInvitation() {
  const invitation = state.invitation;
  const loading = Boolean(state.loadingInvite);
  $("#invite-loading").hidden = !loading || Boolean(state.pending);
  $("#invite-card").hidden = loading || !invitation || Boolean(state.pending);
  if (!invitation) return;
  const left = secondsLeft(invitation.expiresAt);
  const validQr = validQrDataUrl(invitation.qrDataUrl);
  const expired = left === 0 || !validQr;
  $("#invite-countdown").textContent = validQr ? (left ? `Expires in ${countdownLabel(left)}` : "Expired") : "Unavailable";
  $("#qr-expired").hidden = !expired;
  $("#qr-expired strong").textContent = validQr ? "QR code expired" : "QR code unavailable";
  $("#qr-expired span").textContent = "Create a new code.";
  $("#regenerate").hidden = !expired;
  const qr = $("#qr");
  if (validQr) {
    if (qr.src !== invitation.qrDataUrl) qr.src = invitation.qrDataUrl;
    qr.hidden = false;
  } else {
    qr.removeAttribute("src");
    qr.hidden = true;
  }
  const hasMacCode = Boolean(invitation.macCode);
  $("#mac-code-row").hidden = !hasMacCode;
  $("#mac-code").textContent = hasMacCode ? invitation.macCode : "";
}

function routeLabel(peer) {
  if (!peer.connected) return peer.route === "connecting" ? "Connecting…" : "Offline";
  if (peer.route === "direct") return "Direct connection";
  if (peer.route === "relay") return "Connected through relay";
  return "Connected";
}

function renderDevices() {
  const peers = Array.isArray(state.peers) ? state.peers : [];
  const validIds = new Set(peers.map((peer) => peer.id));
  if (confirmingPeerId && !validIds.has(confirmingPeerId)) confirmingPeerId = null;
  $("#devices-empty").hidden = peers.length > 0;
  $("#device-summary").textContent = String(peers.length);
  const pages = Math.max(1, Math.ceil(peers.length / PAGE_SIZE));
  devicePage = Math.min(devicePage, pages - 1);
  $("#pagination").hidden = pages === 1;
  $("#previous-page").disabled = devicePage === 0;
  $("#next-page").disabled = devicePage === pages - 1;
  $("#page-count").textContent = `${devicePage + 1} / ${pages}`;
  $("#device-count").textContent = `${peers.length} linked`;
  const list = $("#device-list");
  const nextRenderKey = JSON.stringify([
    confirmingPeerId, devicePage,
    peers.map((peer) => [peer.id, peer.name || "iPhone", Boolean(peer.connected), routeLabel(peer)]),
  ]);
  if (nextRenderKey === deviceRenderKey) return;
  deviceRenderKey = nextRenderKey;
  list.replaceChildren();
  for (const peer of peers.slice(devicePage * PAGE_SIZE, (devicePage + 1) * PAGE_SIZE)) {
    const card = element("div", "device");
    card.dataset.connected = String(Boolean(peer.connected));
    const row = element("div", "device-main");
    row.append(element("span", "device-indicator"));
    const copy = element("div", "device-copy");
    const name = element("span", "device-name", peer.name || "iPhone");
    name.title = peer.name || "iPhone";
    copy.append(name, element("span", "device-state", routeLabel(peer)));
    const forget = element("button", "forget-button", "Remove");
    forget.type = "button";
    forget.setAttribute("aria-label", `Remove link to ${peer.name || "phone"}`);
    forget.setAttribute("aria-expanded", String(confirmingPeerId === peer.id));
    forget.addEventListener("click", () => { confirmingPeerId = peer.id; renderDevices(); });
    row.append(copy, forget);
    card.append(row);
    if (confirmingPeerId === peer.id) {
      const confirm = element("div", "revoke-confirm");
      confirm.append(element("span", "", "Remove this device? It will need to be linked again."));
      const cancel = element("button", "confirm-cancel", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => { confirmingPeerId = null; renderDevices(); });
      const revoke = element("button", "confirm-revoke", "Remove");
      revoke.type = "button";
      revoke.addEventListener("click", () => post({ action: "revoke", id: peer.id }));
      confirm.append(cancel, revoke);
      card.append(confirm);
    }
    list.append(card);
  }
}

function renderConnectAction() {
  const pending = Boolean(state.pending);
  $("#invite").textContent = pending ? "Review connection" : state.phase === "online" ? "Add iPhone" : "Connect iPhone";
  $("#invite").disabled = state.phase === "starting" || state.phase === "error" || Boolean(state.errorMessage);
  $("#add-device").disabled = $("#invite").disabled;
  $("#pair-again").disabled = $("#invite").disabled;
  $("#pairing-idle").hidden = Boolean(state.pending || state.invitation || state.loadingInvite);
  $("#pairing-result").textContent = state.phase === "online" ? "iPhone connected" : "Connect an iPhone";
}

function render() {
  renderHeader();
  renderError();
  renderWisp();
  renderPending();
  renderInvitation();
  renderConnectAction();
  renderDevices();
}

window.wispMenuUpdate = (nextState) => {
  if (!nextState || typeof nextState !== "object") return;
  state = { ...initialState, ...nextState };
  state.peers = Array.isArray(nextState.peers) ? nextState.peers : [];
  receivedAt = Date.now();
  render();
};

$("#quit").addEventListener("click", () => post({ action: "quit" }));
$("#github-link").addEventListener("click", (event) => {
  event.preventDefault();
  post({ action: "open-github" });
});
$("#retry").addEventListener("click", () => post({ action: "retry" }));
$("#wisp-action").addEventListener("click", () => {
  if (state.wisp?.state === "missing") post({ action: "download-wisp" });
  if (state.wisp?.state === "closed") post({ action: "open-wisp" });
});
$("#invite").addEventListener("click", () => post({ action: "show-pairing" }));
$("#manage").addEventListener("click", () => post({ action: "show-devices" }));
$("#add-device").addEventListener("click", () => post({ action: "show-pairing" }));
$("#pair-again").addEventListener("click", () => post({ action: "invite" }));
$("#previous-page").addEventListener("click", () => { devicePage--; confirmingPeerId = null; renderDevices(); });
$("#next-page").addEventListener("click", () => { devicePage++; confirmingPeerId = null; renderDevices(); });
window.wispMenuSetSurface = (next) => {
  if (!["main", "pairing", "devices"].includes(next)) return;
  surface = next; confirmingPeerId = null; devicePage = 0; render();
};
$("#regenerate").addEventListener("click", () => post({ action: "invite" }));
$("#approve").addEventListener("click", () => { if (state.pending?.id) post({ action: "approve", id: state.pending.id }); });
$("#reject").addEventListener("click", () => { if (state.pending?.id) post({ action: "reject", id: state.pending.id }); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") post({ action: "close" }); });

setInterval(() => {
  if (state.pending || state.invitation) {
    renderPending();
    renderInvitation();
  }
}, 1000);

const resizeObserver = new ResizeObserver(() => {
  requestAnimationFrame(() => {
    const height = Math.ceil($("#panel").getBoundingClientRect().height);
    if (height !== lastHeight) {
      lastHeight = height;
      post({ action: "resize", height });
    }
  });
});
resizeObserver.observe($("#panel"));
render();
post({ action: "ready" });
