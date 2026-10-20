import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWispClient, BridgeError, readSse } from './wisp-client.js';
import { createProjectStore, UUID, normalizeMessages, plainContent, modelPreference } from './mobile-store.js';
import { createAttachmentStore } from './attachments.js';

const MODEL_INFO = {
  'glm-5-3': ['GLM 5.3', 'Sharp reasoning and analysis'],
  'glm-5-3-flash': ['GLM 5.3 Flash', 'Smart and fast'],
  'deepseek-v4-flash': ['Deepseek V4 Flash', 'Quick and frugal'],
  'kimi-k2-6': ['Kimi K2.6', 'Creative writing, reads images'],
  'kimi-k3': ['Kimi K3', 'Most capable, eats limits very fast'],
  'qwen3-8-27b': ['QWEN3.8 27B', 'Strong coder, reads images'],
  'muse-glimmer-30b': ['Muse Glimmer 30B', 'Reliable with tools, reads images'],
  'qwen3-8-uncensored': ['QWEN3.8 Uncensored', 'Answers without content restrictions'],
};
const safeError = error => error instanceof BridgeError ? error.message : 'The Wisp connection was interrupted. Refresh the chat to check the result.';
const detail = value => value == null ? '' : (typeof value === 'string' ? value : JSON.stringify(value, null, 2)).slice(0, 50_000);
const CONNECTOR_STATUSES = new Set(['connected', 'disconnected', 'connecting', 'failed', 'requires_auth']);
const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENABLED_CONNECTOR_LIMIT = 500, ENABLED_CONNECTOR_ID_LIMIT = 512;
const PRIVACY_STATUSES = new Set(['verified', 'failed', 'unreachable', 'unavailable', 'pending']);
const PRIVACY_MEASUREMENTS = ['appId', 'composeHash', 'imageDigest', 'mrtd'];
const AVATAR_MAX_BYTES = 256 * 1024;
const PROJECT_REMOVAL_LIMIT = 750;
const PROJECT_REMOVAL_RETRY_MS = [200, 400, 800, 1600];
const safeText = (value, limit) => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
  : '';
const connectorUnavailable = () => new BridgeError(503, 'connectors_unavailable', 'Connectors are unavailable right now. Check Wisp on your Mac and try again.');
const profileUnavailable = () => new BridgeError(503, 'profile_unavailable', 'Your Wisp profile is unavailable right now.');
const sandboxUnavailable = () => new BridgeError(503, 'sandbox_unavailable', 'The Wisp sandbox setting is unavailable right now.');
const sandboxWriteUnknown = () => new BridgeError(503, 'sandbox_write_unknown', 'Wisp could not confirm the sandbox change. Check the setting on your Mac before trying again.');
const sandboxDisabled = () => new BridgeError(409, 'sandbox_disabled', 'Turn on Sandbox before changing network access.');
const privacyUnavailable = () => ({ status: 'unavailable', measurements: {}, failedChecks: [] });
const usageUnavailable = () => ({ available: false });

const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const boundedText = (value, limit) => {
  if (typeof value !== 'string') return null;
  const normalized = safeText(value, limit);
  return normalized && value.length <= limit * 4 ? normalized : null;
};
const isoDate = value => {
  if (typeof value !== 'string' || value.length > 80 || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

function avatarDataUrl(value) {
  if (typeof value !== 'string' || value.length > 350_000) return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > AVATAR_MAX_BYTES || bytes.toString('base64') !== match[2]) return null;
  const type = match[1];
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if ((type === 'image/png' && !png) || (type === 'image/jpeg' && !jpeg) || (type === 'image/webp' && !webp)) return null;
  return value;
}

function normalizeSandbox(value) {
  if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.allowNetwork !== 'boolean') throw sandboxUnavailable();
  return { enabled: value.enabled, allowNetwork: value.allowNetwork };
}

function normalizeUsage(value) {
  if (!record(value)) return null;
  const result = { available: true };
  if (value.plan != null) {
    if (!record(value.plan)) return null;
    const planName = boundedText(value.plan.name, 160);
    if (!planName) return null;
    result.planName = planName;
  }
  if (value.usage != null) {
    if (!record(value.usage)) return null;
    const usage = {};
    for (const key of ['cycle', 'daily', 'weekly']) {
      if (value.usage[key] === undefined) continue;
      const window = value.usage[key];
      if (!record(window) || !Number.isFinite(window.percentUsed)) return null;
      const normalized = { percentUsed: window.percentUsed };
      if (window.resetsAt !== undefined) {
        const resetsAt = isoDate(window.resetsAt);
        if (!resetsAt) return null;
        normalized.resetsAt = resetsAt;
      }
      usage[key] = normalized;
    }
    result.usage = usage;
  }
  return result;
}

function normalizePrivacy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !PRIVACY_STATUSES.has(value.status)) return privacyUnavailable();
  const source = value.measurements;
  const expected = value.expected;
  const sourceObject = source && typeof source === 'object' && !Array.isArray(source);
  const expectedObject = expected && typeof expected === 'object' && !Array.isArray(expected);
  const measurements = {};
  let verifiedProofValid = Boolean(sourceObject && expectedObject), proofCount = 0;
  if (sourceObject) {
    for (const name of PRIVACY_MEASUREMENTS) {
      const nativeCurrent = source[name];
      if (nativeCurrent === undefined) continue;
      const current = safeText(nativeCurrent, 2_048);
      if (typeof nativeCurrent !== 'string' || !current) { verifiedProofValid = false; continue; }
      proofCount++;
      // Match the original attestation values exactly; sanitization is only for
      // the bounded display copy and must not turn distinct evidence into a match.
      const nativeExpected = expectedObject ? expected[name] : undefined;
      const expectedValid = typeof nativeExpected === 'string' && Boolean(safeText(nativeExpected, 2_048));
      if (!expectedValid) verifiedProofValid = false;
      const match = expectedValid && nativeCurrent === nativeExpected;
      measurements[name] = { value: current, match };
    }
  }
  if (!proofCount) verifiedProofValid = false;
  const mismatch = Object.values(measurements).some(item => !item.match);
  const nativeReason = typeof value.reason === 'string' ? value.reason : '';
  const nativeTcb = value.tcb?.status;
  const checkTypesValid =
    (value.nonceEchoed === undefined || typeof value.nonceEchoed === 'boolean') &&
    (value.signerBound === undefined || typeof value.signerBound === 'boolean') &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    (value.tcb === undefined || (value.tcb && typeof value.tcb === 'object' && !Array.isArray(value.tcb))) &&
    (nativeTcb === undefined || typeof nativeTcb === 'string');
  const evidenceFailures = [];
  if (mismatch) evidenceFailures.push('measurement_mismatch');
  if (value.nonceEchoed === false) evidenceFailures.push('nonce_freshness');
  if (value.signerBound === false) evidenceFailures.push('signer_binding');
  if (typeof nativeTcb === 'string' && nativeTcb && nativeTcb.toLowerCase().replace(/[\s_-]/g, '') !== 'uptodate') evidenceFailures.push('tcb_status');
  if (nativeReason.toLowerCase().includes('signature')) evidenceFailures.push('quote_signature');
  let status = value.status;
  if (status === 'failed' && nativeReason.startsWith('attestation_unreachable')) status = 'unreachable';
  if (status === 'verified') {
    // The installed UI reads measurements and expected unconditionally, but
    // treats each known measurement row as optional. Require both objects and
    // at least one usable known pair before preserving a verified claim.
    if (!checkTypesValid || !verifiedProofValid) return privacyUnavailable();
    if (evidenceFailures.length) status = 'failed';
  }
  const failedChecks = status === 'failed' ? evidenceFailures : [];
  const keyProvider = safeText(sourceObject ? source.keyProvider : undefined, 120);
  const tcbStatus = safeText(nativeTcb, 120);
  const quoteFingerprint = safeText(value.quoteFingerprint, 512);
  const verifiedAt = safeText(value.verifiedAt, 80);
  return {
    status, measurements, failedChecks,
    ...(keyProvider ? { keyProvider } : {}),
    ...(tcbStatus ? { tcbStatus } : {}),
    ...(quoteFingerprint ? { quoteFingerprint } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
  };
}

export function createBridge({
  client = createWispClient(), projects = createProjectStore(), attachmentStore = createAttachmentStore(),
  metadataTtlMs = 60_000, profileTtlMs = 60_000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const events = new EventEmitter(); events.setMaxListeners(20);
  const sessionIndex = new Map(), runs = new Map(), submission = new Map(), sendLocks = new Set(), connectorMutations = new Map();
  let lastRefresh = 0, refreshingSessions = null, sessionLoadSequence = 0, appliedSessionSequence = 0;
  let sandboxMutation = Promise.resolve(), projectRemovalMutation = Promise.resolve();
  const changed = (id, type, data) => events.emit(id, { type, data });
  const viewSession = (s, active = false) => ({ id: s.id, title: s.title || 'New Chat', projectId: s.projectId || null, updatedAt: s.updatedAt, active, hasArtifacts: Boolean(s.deskPath) });

  function cached(load, ttlMs) {
    let value, expiresAt = 0, inFlight = null;
    return async () => {
      if (value !== undefined && now() < expiresAt) return value;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        const loaded = await load();
        value = loaded; expiresAt = now() + ttlMs;
        return loaded;
      })();
      try { return await inFlight; } finally { inFlight = null; }
    };
  }

  function coalesced(load) {
    let inFlight = null;
    return async () => {
      if (inFlight) return inFlight;
      inFlight = Promise.resolve().then(load);
      try { return await inFlight; } finally { inFlight = null; }
    };
  }

  async function loadSessionSnapshot() {
    const sequence = ++sessionLoadSequence;
    const [roots, global, nativeRuns] = await Promise.all([
      projects.roots(), client.request('/v1/sessions?origin=desktop'), client.request('/api/runs'),
    ]);
    return { sequence, roots, global, nativeRuns: Array.isArray(nativeRuns) ? nativeRuns : [] };
  }

  function applySessionSnapshot(snapshot) {
    if (snapshot.sequence < appliedSessionSequence) return;
    const rootById = new Map(snapshot.roots.map(project => [project.id, project]));
    sessionIndex.clear();
    for (const s of Array.isArray(snapshot.global) ? snapshot.global : []) {
      if (!UUID.test(s?.id) || s.origin !== 'desktop') continue;
      const { projectRoot: _untrustedRoot, ...native } = s;
      const project = rootById.get(native.projectId);
      sessionIndex.set(native.id, project ? { ...native, projectRoot: project.path } : native);
    }
    appliedSessionSequence = snapshot.sequence;
    lastRefresh = now();
  }

  async function refreshSessions() {
    if (refreshingSessions) return refreshingSessions;
    refreshingSessions = (async () => {
      const snapshot = await loadSessionSnapshot();
      applySessionSnapshot(snapshot);
      return { roots: snapshot.roots, nativeRuns: snapshot.nativeRuns };
    })();
    try { return await refreshingSessions; } finally { refreshingSessions = null; }
  }

  function projectMembers(snapshot, projectId, requireProject = true) {
    if (!Array.isArray(snapshot.global) || !Array.isArray(snapshot.roots)) {
      throw new BridgeError(503, 'project_removal_unavailable', 'Project chats could not be verified. Refresh and try again.');
    }
    const project = snapshot.roots.find(item => item?.id === projectId);
    if (project && (typeof project.path !== 'string' || !project.path.startsWith('/') || project.path.length > 4096 || project.path.includes('\0'))) {
      throw new BridgeError(503, 'project_removal_unavailable', 'Project chats could not be verified. Refresh and try again.');
    }
    const members = [], seen = new Set();
    for (const item of snapshot.global) {
      if (item?.projectId !== projectId) continue;
      if (!record(item) || item.origin !== 'desktop' || !UUID.test(item.id || '') || seen.has(item.id)) {
        throw new BridgeError(503, 'project_removal_unavailable', 'Project chats could not be verified. Refresh and try again.');
      }
      seen.add(item.id);
      const { projectRoot: _untrustedRoot, ...native } = item;
      members.push(project ? { ...native, projectRoot: project.path } : native);
    }
    if (requireProject && !project && members.length === 0) throw new BridgeError(404, 'project_missing', 'Project not found.');
    if (members.length > PROJECT_REMOVAL_LIMIT) {
      throw new BridgeError(409, 'project_removal_large', 'This project has too many chats to remove from the phone.');
    }
    return members;
  }

  function validateProjectRemoval(projectId, body) {
    const keys = record(body) ? Object.keys(body) : [];
    if (!UUID.test(projectId || '') || keys.length !== 2 || !keys.includes('sessionIds') || !keys.includes('activeSessionId') ||
        !Array.isArray(body.sessionIds) || body.sessionIds.length > PROJECT_REMOVAL_LIMIT ||
        body.sessionIds.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(body.sessionIds).size !== body.sessionIds.length ||
        (body.activeSessionId !== null && (typeof body.activeSessionId !== 'string' || !UUID.test(body.activeSessionId)))) {
      throw new BridgeError(400, 'invalid_project_removal', 'Refresh the project and try again.');
    }
  }

  function serializeProjectRemoval(operation) {
    const current = projectRemovalMutation.catch(() => {}).then(operation);
    projectRemovalMutation = current;
    return current;
  }

  function removalUnknown() {
    return new BridgeError(409, 'session_removal_unknown', 'Wisp could not confirm that the chat was removed. Refresh your chats before trying again.');
  }

  function removableSession(snapshot, id) {
    if (!Array.isArray(snapshot.global) || !Array.isArray(snapshot.roots)) throw removalUnknown();
    const matches = snapshot.global.filter(item => item?.id === id);
    if (matches.length !== 1 || !record(matches[0]) || matches[0].origin !== 'desktop' || !UUID.test(matches[0].id || '')) {
      if (!matches.length || matches.every(item => item?.origin !== 'desktop')) {
        throw new BridgeError(404, 'session_missing', 'This chat is not available in Wisp Desktop.');
      }
      throw removalUnknown();
    }
    const { projectRoot: _untrustedRoot, ...native } = matches[0];
    if (!native.projectId) return native;
    const projectsForId = snapshot.roots.filter(item => item?.id === native.projectId);
    if (projectsForId.length === 0) return native;
    const project = projectsForId.length === 1 ? projectsForId[0] : null;
    if (!project || typeof project.path !== 'string' || !project.path.startsWith('/') || project.path.length > 4096 || project.path.includes('\0')) {
      throw removalUnknown();
    }
    return { ...native, projectRoot: project.path };
  }

  async function cancelAndDeleteSession(member) {
    try {
      await client.request(`/v1/sessions/${member.id}/cancel${hint(member)}`, { method: 'POST', body: {} });
    } catch {
      // Original Wisp treats cancellation as best effort and lets DELETE
      // determine whether the session can be removed safely.
    }
    for (let attempt = 0; attempt <= PROJECT_REMOVAL_RETRY_MS.length; attempt++) {
      try {
        await client.request(`/v1/sessions/${member.id}${hint(member)}`, { method: 'DELETE' });
        return true;
      } catch (error) {
        if (error instanceof BridgeError && error.status === 404) return true;
        if (!(error instanceof BridgeError) || error.status !== 409 || attempt >= PROJECT_REMOVAL_RETRY_MS.length) return false;
        await sleep(PROJECT_REMOVAL_RETRY_MS[attempt]);
      }
    }
    return false;
  }

  const metadata = cached(async () => {
    const [models, entitlement] = await Promise.all([
      client.request('/api/models'),
      client.request('/api/billing/me').then(x => ({ free: x?.plan?.priceCents === 0 })).catch(() => ({ free: null })),
    ]);
    const catalog = Array.isArray(models?.data) ? models.data.filter(m => typeof m.id === 'string' && m.id.length < 120 && /^[\w.:-]+$/.test(m.id)) : [];
    return { catalog, entitlement };
  }, metadataTtlMs);

  const profile = cached(async () => {
    let result;
    try { result = await client.request('/v1/auth/status'); } catch { throw profileUnavailable(); }
    const displayName = safeText(result?.user?.name, 80);
    const avatar = avatarDataUrl(result?.user?.picture);
    return { ...(displayName ? { displayName } : {}), ...(avatar ? { avatarDataUrl: avatar } : {}) };
  }, profileTtlMs);

  async function sandbox() {
    try { return normalizeSandbox(await client.request('/api/sandbox')); }
    catch (error) { if (error instanceof BridgeError && error.code === 'sandbox_unavailable') throw error; throw sandboxUnavailable(); }
  }

  function applySandboxMutation(body) {
    const field = Object.keys(body)[0];
    const preservedField = field === 'enabled' ? 'allowNetwork' : 'enabled';
    const current = sandboxMutation.catch(() => {}).then(async () => {
      const before = await sandbox();
      if (field === 'allowNetwork' && !before.enabled) throw sandboxDisabled();
      let returned, readBack;
      try {
        returned = await client.request('/api/sandbox', { method: 'POST', body: { [field]: body[field] } });
        readBack = await client.request('/api/sandbox');
        returned = normalizeSandbox(returned);
        readBack = normalizeSandbox(readBack);
      } catch { throw sandboxWriteUnknown(); }
      if (returned[field] !== body[field] || readBack[field] !== body[field] ||
          returned[preservedField] !== before[preservedField] || readBack[preservedField] !== before[preservedField]) throw sandboxWriteUnknown();
      return readBack;
    });
    sandboxMutation = current;
    return current;
  }

  const usage = coalesced(async () => {
    try { return normalizeUsage(await client.request('/api/billing/me')) || usageUnavailable(); }
    catch { return usageUnavailable(); }
  });

  async function privacy(refresh = false) {
    try {
      return normalizePrivacy(await client.request(refresh ? '/v1/attestation/refresh' : '/v1/attestation', refresh ? { method: 'POST' } : undefined));
    } catch {
      return privacyUnavailable();
    }
  }

  async function session(id) {
    if (!UUID.test(id)) throw new BridgeError(400, 'session_id', 'Invalid chat.');
    if (!sessionIndex.has(id) || now() - lastRefresh > 15_000) await refreshSessions();
    const s = sessionIndex.get(id);
    if (!s) throw new BridgeError(404, 'session_missing', 'This chat was not found in the available Wisp projects.');
    return s;
  }

  function normalizeEnabled(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.enabledConnectors) ||
        value.enabledConnectors.length > ENABLED_CONNECTOR_LIMIT ||
        value.enabledConnectors.some(id => typeof id !== 'string' || !id.length || id.length > ENABLED_CONNECTOR_ID_LIMIT)) throw connectorUnavailable();
    return [...value.enabledConnectors];
  }
  function normalizeConnectors(value, enabled) {
    if (!Array.isArray(value)) throw connectorUnavailable();
    const enabledSet = new Set(enabled), seen = new Set(), connectors = [];
    for (const item of value) {
      if (!item || !CONNECTOR_ID.test(item.name || '') || !CONNECTOR_STATUSES.has(item.status) || seen.has(item.name)) continue;
      seen.add(item.name);
      connectors.push({ id: item.name, label: safeText(item.displayName, 120) || item.name, status: item.status, enabled: enabledSet.has(item.name) });
    }
    return connectors;
  }
  async function connectorState(id, unavailableAsResult = false) {
    await session(id);
    try {
      const [configured, enabledResult] = await Promise.all([
        client.request('/v1/connectors'), client.request(`/v1/connectors/enabled?sessionId=${encodeURIComponent(id)}`),
      ]);
      const enabled = normalizeEnabled(enabledResult);
      return { connectors: normalizeConnectors(configured, enabled), available: true };
    } catch (error) {
      if (unavailableAsResult) return { connectors: [], available: false };
      throw error instanceof BridgeError && error.code === 'session_missing' ? error : connectorUnavailable();
    }
  }
  function mutateConnectors(id, operation) {
    const previous = connectorMutations.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    connectorMutations.set(id, current);
    return current.finally(() => { if (connectorMutations.get(id) === current) connectorMutations.delete(id); });
  }
  const hint = s => s.projectRoot ? '?projectRoot=' + encodeURIComponent(s.projectRoot) : '';
  const confirmations = async id => {
    const result = await client.request(`/api/sessions/${id}/confirmations`);
    return (result.confirmations || []).map(c => ({ id: c.id, title: c.toolName, description: detail(c.args) }));
  };
  const runPublic = r => ({ id: r.id, state: r.state, text: r.text, activities: r.activities, ...(r.confirmation ? { confirmation: r.confirmation } : {}), ...(r.error ? { error: r.error } : {}), ...(r.thinking ? { thinking: r.thinking } : {}) });

  async function getView(id, attach = true) {
    const s = await session(id);
    const [native, history, pending, nativeRuns] = await Promise.all([
      client.request(`/v1/sessions/${id}${hint(s)}`), client.request(`/v1/sessions/${id}/history${hint(s)}`), confirmations(id), client.request('/api/runs'),
    ]);
    const live = nativeRuns.find(r => r.sessionId === id);
    let r = runs.get(id);
    if (live && (!r || r.id !== live.runId || !r.connected) && attach) {
      r = { id: live.runId, state: live.status, text: '', activities: [], connected: true, native: true, lastSeq: 0 };
      runs.set(id, r);
      void attachRun(s, r);
    }
    if (r && live && pending.length) { r.confirmation = pending[0]; r.state = 'awaiting_approval'; }
    if (r && !live && r.connected === false && !['unknown', 'error'].includes(r.state)) r = null;
    const active = Boolean(live || (r && r.connected));
    return {
      session: viewSession(native, active), messages: normalizeMessages(history?.[0]?.values?.messages || native.messages),
      run: r && (active || ['unknown', 'error'].includes(r.state)) ? runPublic(r) : null,
      settings: await projects.settings(id),
    };
  }

  function applyEvent(s, r, e) {
    if (e.id) r.lastSeq = Number(e.id) || r.lastSeq;
    const d = e.data;
    if (e.event === 'metadata') r.id = d.run_id;
    else if (e.event === 'queued') r.state = 'queued';
    else if (e.event === 'status') r.state = 'running';
    else if (e.event === 'values' && Array.isArray(d.messages)) {
      const normalized = normalizeMessages(d.messages);
      const last = normalized.at(-1);
      r.text = last?.role === 'assistant' ? last.text : '';
      r.snapshot = normalized;
      // Authoritative message snapshots replace token assembly, not append to it.
      r.chunks.clear();
    } else if (e.event === 'messages' && Array.isArray(d)) {
      const m = d[0];
      if (m?.type === 'ai' || m?.role === 'assistant') {
        const key = m.id || 'current';
        r.chunks.set(key, (r.chunks.get(key) || '') + plainContent(m.content));
        r.text = [...r.chunks.values()].join('\n\n');
        const reasoning = m.additional_kwargs?.reasoning_content;
        if (typeof reasoning === 'string') r.thinking = (r.thinking || '') + reasoning;
      }
    } else if (e.event === 'custom') {
      const type = d?.type;
      if (type === 'confirmation_required') {
        r.confirmation = { id: d.id, title: d.toolName, description: detail(d.args) }; r.state = 'awaiting_approval';
      } else if (type === 'confirmation_resolved') { delete r.confirmation; r.state = 'running'; }
      else if (type === 'tool_activity_start') {
        r.activities.push({ id: d.id || `activity-${e.id}`, type: 'tool', title: d.name || 'Tool', status: 'running', detail: detail(d.args) });
      } else if (type === 'tool_activity_end') {
        const a = [...r.activities].reverse().find(a => a.title === d.name && a.status === 'running');
        if (a) { a.status = d.error ? 'error' : 'complete'; if (d.error) a.text = detail(d.error); }
      } else if (type === 'tool_call_progress') {
        const a = [...r.activities].reverse().find(a => a.title === d.name && a.status === 'running');
        if (a) a.text = [d.path, Number.isFinite(d.bytes) ? `${d.bytes} bytes` : null].filter(Boolean).join(' · ');
      } else if (type === 'subagent_start') {
        r.activities.push({ id: d.agentId, type: 'agent', title: d.description || 'Agent', status: 'running', detail: detail(d.task) });
      } else if (type === 'subagent_end') {
        const a = r.activities.find(a => a.id === d.agentId); if (a) { a.status = d.error ? 'error' : 'complete'; if (d.error) a.text = detail(d.error); }
      } else if (type === 'subagent_event') {
        const a = r.activities.find(a => a.id === d.agentId); if (a) a.text = detail(d.event);
      } else if (type === 'llm_retry') {
        r.activities.push({ id: `retry-${e.id}`, type: 'status', title: 'Wisp reconnecting', status: 'running' });
      } else if (type === 'llm_retry_resolved') {
        for (const a of r.activities) if (a.type === 'status') a.status = 'complete';
      } else if (typeof type === 'string') {
        r.activities.push({ id: `event-${e.id}`, type: 'status', title: type.replaceAll('_', ' '), status: 'complete', detail: detail(d) });
      }
    } else if (e.event === 'done') { r.state = d.outcome === 'cancelled' ? 'cancelled' : 'complete'; delete r.confirmation; }
    else if (e.event === 'error') { r.state = 'error'; r.error = 'Wisp could not complete the task. Check the app on your Mac for details.'; delete r.confirmation; }
    else if (e.event === 'replay_gap') r.gap = true;
    if (r.activities.length > 300) r.activities.splice(0, r.activities.length - 300);
    changed(s.id, 'run', runPublic(r));
  }

  async function consume(s, r, response) {
    r.chunks ||= new Map();
    try {
      for await (const e of readSse(response)) applyEvent(s, r, e);
      if (!['complete', 'cancelled', 'error'].includes(r.state) && !r.gap) {
        r.state = 'unknown'; r.error = 'The stream was interrupted. Refresh the chat to get the latest state from your Mac.';
      }
    } catch (e) { r.state = 'unknown'; r.error = safeError(e); }
    finally {
      r.connected = false;
      try { changed(s.id, 'complete', await getView(s.id, false)); } catch { changed(s.id, 'run', runPublic(r)); }
    }
  }
  async function attachRun(s, r) {
    try {
      const query = new URLSearchParams(); if (s.projectRoot) query.set('projectRoot', s.projectRoot);
      const response = await client.request(`/api/sessions/${s.id}/stream?${query}`, { stream: true });
      await consume(s, r, response);
    } catch (e) { r.connected = false; r.state = 'unknown'; r.error = safeError(e); changed(s.id, 'run', runPublic(r)); }
  }

  return {
    events,
    async bootstrap() {
      const [{ roots, nativeRuns }, { catalog, entitlement }, currentSandbox] = await Promise.all([refreshSessions(), metadata(), sandbox()]);
      const active = new Set(nativeRuns.map(x => x.sessionId));
      const choices = catalog.map(m => ({ id: m.id, label: MODEL_INFO[m.id]?.[0] || m.id, description: MODEL_INFO[m.id]?.[1] || '', reasoning: Boolean(m.reasoning), contextLength: m.context_length,
        ...(m.id === 'kimi-k3' && entitlement.free ? { disabled: true, disabledReason: 'Upgrade to a paid plan to unlock' } : {}) }));
      choices.sort((a, b) => { const keys = Object.keys(MODEL_INFO); return (keys.indexOf(a.id) < 0 ? 99 : keys.indexOf(a.id)) - (keys.indexOf(b.id) < 0 ? 99 : keys.indexOf(b.id)); });
      return {
        connection: { state: 'connected', runtimeVersion: await client.version() },
        sessions: [...sessionIndex.values()].map(s => viewSession(s, active.has(s.id))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
        projects: roots, models: choices,
        modes: [{ id: 'balanced', label: 'Balanced', description: 'Optimal for everyday tasks' }, { id: 'auto', label: 'Advanced', description: 'Best models, for complex tasks' }, { id: 'model', label: 'More', description: 'Pick a specific model' }],
        preferences: { mode: 'auto', thinking: true }, capabilities: { models: true, modes: true, thinking: true, projects: true, projectRemoval: true, sessionRemoval: true, approvals: true, attachments: true, connectors: true },
        sandbox: currentSandbox,
      };
    },
    profile,
    sandbox,
    setSandbox(body) {
      const keys = record(body) ? Object.keys(body) : [];
      if (keys.length !== 1 || !['enabled', 'allowNetwork'].includes(keys[0]) || typeof body[keys[0]] !== 'boolean') {
        throw new BridgeError(400, 'invalid_sandbox', 'Choose one Sandbox setting.');
      }
      return applySandboxMutation(body);
    },
    usage,
    privacy: () => privacy(false),
    refreshPrivacy: () => privacy(true),
    getConnectors(id) { return connectorState(id, true); },
    setConnector(id, body) {
      if (!body || !CONNECTOR_ID.test(body.id || '') || typeof body.enabled !== 'boolean') throw new BridgeError(400, 'invalid_connector', 'Choose an available connector.');
      return mutateConnectors(id, async () => {
        await session(id);
        let configured, enabledResult;
        try {
          [configured, enabledResult] = await Promise.all([
            client.request('/v1/connectors'), client.request(`/v1/connectors/enabled?sessionId=${encodeURIComponent(id)}`),
          ]);
        } catch { throw connectorUnavailable(); }
        const enabled = normalizeEnabled(enabledResult);
        const connectors = normalizeConnectors(configured, enabled);
        const connector = connectors.find(item => item.id === body.id);
        if (!connector) throw new BridgeError(404, 'connector_missing', 'This connector is not configured in Wisp.');
        if (body.enabled && connector.status !== 'connected') throw new BridgeError(409, 'connector_unavailable', 'Connect this connector in Wisp before enabling it for the chat.');
        const next = body.enabled ? (enabled.includes(body.id) ? [...enabled] : [...enabled, body.id]) : enabled.filter(value => value !== body.id);
        let updated;
        try {
          updated = await client.request(`/v1/connectors/enabled?sessionId=${encodeURIComponent(id)}`, { method: 'PUT', body: { enabledConnectors: next } });
        } catch { throw connectorUnavailable(); }
        const applied = normalizeEnabled(updated);
        return { connectors: normalizeConnectors(configured, applied), available: true };
      });
    },
    getView,
    async createSession(body) {
      const roots = await projects.roots();
      const project = body.projectId ? roots.find(x => x.id === body.projectId) : null;
      if (body.projectId && !project) throw new BridgeError(404, 'project_missing', 'Project not found.');
      const s = await client.request('/v1/sessions', { method: 'POST', body: { origin: 'desktop', title: body.title || 'New Chat', externalKey: `mobile-${randomUUID()}`, ...(project ? { projectRoot: project.path } : {}) } });
      sessionIndex.set(s.id, { ...s, projectRoot: project?.path });
      return { session: viewSession(s) };
    },
    async createProject(body) {
      const result = await projects.create(body.name, path => client.request('/v1/sessions', { method: 'POST', body: { origin: 'desktop', title: 'New Chat', projectRoot: path, externalKey: `mobile-${randomUUID()}` } }));
      sessionIndex.set(result.session.id, { ...result.session, projectRoot: result.project.path });
      return { project: result.project, session: viewSession(result.session) };
    },
    removeProject(projectId, body) {
      validateProjectRemoval(projectId, body);
      return serializeProjectRemoval(async () => {
        const before = await loadSessionSnapshot();
        const members = projectMembers(before, projectId);
        applySessionSnapshot(before);
        const byId = new Map(members.map(item => [item.id, item]));
        const requested = new Set(body.sessionIds);
        if (members.length !== requested.size || members.some(item => !requested.has(item.id)) ||
            (body.activeSessionId !== null && !byId.has(body.activeSessionId))) {
          throw new BridgeError(409, 'project_snapshot_changed', 'Project chats changed. Refresh and confirm removal again.');
        }

        const ordered = body.sessionIds.filter(id => id !== body.activeSessionId);
        if (body.activeSessionId !== null) ordered.push(body.activeSessionId);
        const confirmed = new Set();
        for (const id of ordered) {
          const member = byId.get(id);
          const removed = await cancelAndDeleteSession(member);
          if (!removed) break;
          confirmed.add(id);
          runs.delete(id);
        }

        try {
          const after = await loadSessionSnapshot();
          applySessionSnapshot(after);
          const remaining = new Set(projectMembers(after, projectId, false).map(item => item.id));
          const removedSessionIds = body.sessionIds.filter(id => !remaining.has(id));
          for (const id of removedSessionIds) runs.delete(id);
          return { removedSessionIds, complete: remaining.size === 0 };
        } catch {
          return { removedSessionIds: body.sessionIds.filter(id => confirmed.has(id)), complete: false };
        }
      });
    },
    removeSession(id, body) {
      const keys = record(body) ? Object.keys(body) : [];
      if (!UUID.test(id || '') || !record(body) || keys.length !== 0) throw new BridgeError(400, 'invalid_session_removal', 'Refresh the chat and try again.');
      return serializeProjectRemoval(async () => {
        let before;
        try { before = await loadSessionSnapshot(); }
        catch { throw removalUnknown(); }
        const member = removableSession(before, id);
        applySessionSnapshot(before);
        await cancelAndDeleteSession(member);
        let after;
        try { after = await loadSessionSnapshot(); }
        catch { throw removalUnknown(); }
        if (!Array.isArray(after.global) || !Array.isArray(after.roots) || after.global.some(item => item?.id === id)) throw removalUnknown();
        applySessionSnapshot(after);
        runs.delete(id);
        return { removedSessionId: id };
      });
    },
    async rename(id, body) {
      const s = await session(id);
      const renamed = await client.request(`/v1/sessions/${id}${hint(s)}`, { method: 'PATCH', body: { title: body.title } });
      sessionIndex.set(id, { ...renamed, projectRoot: s.projectRoot });
      return { session: viewSession(renamed) };
    },
    attachmentBegin(owner, meta) { return attachmentStore.begin(owner, meta); },
    attachmentChunk(owner, value) { return attachmentStore.chunk(owner, value); },
    attachmentCommit(owner, value) { return attachmentStore.commit(owner, value); },
    attachmentRemove(owner, value) { return attachmentStore.remove(owner, value); },
    dropAttachments(owner) { attachmentStore.dropOwner(owner); return { ok: true }; },
    async send(id, body, owner) {
      const s = await session(id);
      if (s.projectId && !s.projectRoot) throw new BridgeError(409, 'project_unavailable', 'This project folder is unavailable on your Mac. Add the project to Wisp again.');
      const attachmentIds = body.attachments ?? [];
      if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || attachmentIds.some(value => !UUID.test(value || ''))) {
        throw new BridgeError(400, 'attachments', 'Invalid attachment list.');
      }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text && !attachmentIds.length) throw new BridgeError(400, 'empty_message', 'Add a message or attachment.');
      const key = JSON.stringify([owner || 'legacy-local', id, body.id]);
      const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const old = submission.get(key);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new BridgeError(409, 'id_conflict', 'This message was already sent with different content.');
        if (old.confirmed) return { accepted: true, runId: old.run.id };
        const native = await client.request(`/api/sessions/${id}/messages/${body.id}/run`).catch(() => null);
        if (!native || native.status === 'unknown') throw new BridgeError(409, 'delivery_unknown', 'Wisp has not confirmed delivery. Resending is blocked; check the chat on your Mac.');
        old.confirmed = true;
        // Reconciliation never dispatches another turn. A native active run is
        // attached by getView; a terminal result is loaded from saved history.
        old.run.state = 'complete'; old.run.connected = false;
        changed(id, 'complete', await getView(id));
        return { accepted: true, runId: old.run.id };
      }
      if (sendLocks.has(id)) throw new BridgeError(409, 'busy', 'A message is already being sent in this chat.');
      sendLocks.add(id);
      try {
        const current = await client.request('/api/runs');
        if (current.some(x => x.sessionId === id)) throw new BridgeError(409, 'busy', 'Wait for the current task to finish or stop it.');
        if (body.modelId && !(await metadata()).catalog.some(x => x.id === body.modelId)) throw new BridgeError(400, 'model_missing', 'The selected model is no longer available.');
        const settings = { mode: body.mode || 'auto', thinking: body.thinking !== false, ...(body.modelId ? { modelId: body.modelId } : {}) };
        const attachmentBlocks = attachmentIds.length ? attachmentStore.resolve(owner, attachmentIds, id) : [];
        const r = { id: body.id, state: 'running', text: '', activities: [], connected: true, chunks: new Map(), lastSeq: 0 };
        submission.set(key, { fingerprint, run: r, confirmed: false }); runs.set(id, r);
        const content = [...(text ? [{ type: 'text', text }] : []), ...attachmentBlocks];
        // Native idempotency uses this exact human message ID and survives bridge restart.
        const response = await client.request(`/api/sessions/${id}/stream`, { method: 'POST', stream: true, body: {
          input: { messages: [{ role: 'human', content, id: body.id }] },
          modelPreference: modelPreference(settings), ...(s.projectRoot ? { config: { configurable: { projectRoot: s.projectRoot } } } : {}),
        } });
        submission.get(key).confirmed = true;
        if (attachmentIds.length) attachmentStore.consume(owner, attachmentIds);
        await projects.setSettings(id, settings).catch(() => {});
        void consume(s, r, response);
        changed(id, 'run', runPublic(r));
        if (submission.size > 2000) { const first = submission.keys().next().value; submission.delete(first); }
        return { accepted: true, runId: r.id };
      } catch (e) {
        const r = submission.get(key)?.run;
        if (r) {
          r.connected = false;
          if (e.code === 'delivery_unknown') { r.state = 'unknown'; r.error = safeError(e); changed(id, 'run', runPublic(r)); }
          else { submission.delete(key); runs.delete(id); }
        }
        throw e;
      } finally { sendLocks.delete(id); }
    },
    async cancel(id) {
      const s = await session(id);
      await client.request(`/v1/sessions/${id}/cancel${hint(s)}`, { method: 'POST' });
      const r = runs.get(id); if (r) { r.state = 'cancelling'; changed(id, 'run', runPublic(r)); }
      return { ok: true };
    },
    async confirm(id, confirmationId, decision) {
      await session(id);
      const pending = await confirmations(id);
      if (!pending.some(c => c.id === confirmationId)) throw new BridgeError(409, 'confirmation_expired', 'This approval request has closed. Refresh the chat.');
      await client.request(`/api/sessions/${id}/confirmations/${confirmationId}`, { method: 'POST', body: { decision: decision === 'approve_once' ? 'approve' : 'deny' } });
      return { ok: true };
    },
  };
}
