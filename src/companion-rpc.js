import { BridgeError } from './wisp-client.js';
import { UUID } from './mobile-store.js';

const invalid = () => new BridgeError(400, 'invalid_request', 'Invalid request.');
const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_REMOVAL_LIMIT = 750;
export function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !names.includes(k))) throw invalid();
  return value;
}
const title = (value, required = false) => {
  if ((required || value !== undefined) && (typeof value !== 'string' || !value.trim() || value.length > 180)) throw invalid();
};

// A finite product RPC surface. No fetch(URL) or runtime-route passthrough.
export async function dispatchCompanion(bridge, request, owner) {
  fields(request, ['v', 'op', 'method', 'path', 'body']);
  const { method, path } = request;
  if (!['GET', 'POST', 'PATCH'].includes(method) || typeof path !== 'string' || path.length > 250 || /[?#%\\]/.test(path)) throw invalid();
  if (method === 'GET' && request.body !== undefined) throw invalid();
  const b = request.body;
  if (method === 'GET' && path === '/bridge/bootstrap') return { status: 200, body: await bridge.bootstrap() };
  if (method === 'GET' && path === '/bridge/profile') return { status: 200, body: await bridge.profile() };
  if (method === 'GET' && path === '/bridge/sandbox') return { status: 200, body: await bridge.sandbox() };
  if (method === 'GET' && path === '/bridge/usage') return { status: 200, body: await bridge.usage() };
  if (method === 'GET' && path === '/bridge/privacy') return { status: 200, body: await bridge.privacy() };
  if (method === 'POST' && path === '/bridge/sandbox') {
    fields(b, ['enabled', 'allowNetwork']);
    const keys = Object.keys(b);
    if (keys.length !== 1 || typeof b[keys[0]] !== 'boolean') throw invalid();
    return { status: 200, body: await bridge.setSandbox(b) };
  }
  if (method === 'POST' && path === '/bridge/privacy/refresh') {
    fields(b, []);
    return { status: 200, body: await bridge.refreshPrivacy() };
  }
  if (method === 'POST' && path === '/bridge/sessions') {
    fields(b, ['projectId', 'title']); title(b.title);
    if (b.projectId !== undefined && !UUID.test(b.projectId)) throw invalid();
    return { status: 201, body: await bridge.createSession(b) };
  }
  if (method === 'POST' && path === '/bridge/projects') {
    fields(b, ['name']); return { status: 201, body: await bridge.createProject(b) };
  }
  const projectRemoval = /^\/bridge\/projects\/([^/]+)\/remove$/.exec(path);
  if (method === 'POST' && projectRemoval && UUID.test(projectRemoval[1])) {
    fields(b, ['sessionIds', 'activeSessionId']);
    if (Object.keys(b).length !== 2 || !Array.isArray(b.sessionIds) || b.sessionIds.length > PROJECT_REMOVAL_LIMIT ||
        b.sessionIds.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(b.sessionIds).size !== b.sessionIds.length ||
        (b.activeSessionId !== null && (typeof b.activeSessionId !== 'string' || !UUID.test(b.activeSessionId)))) throw invalid();
    return { status: 200, body: await bridge.removeProject(projectRemoval[1], b) };
  }
  const upload = /^\/bridge\/attachments\/(begin|chunk|commit|remove)$/.exec(path);
  if (method === 'POST' && upload) {
    const operations = { begin: 'attachmentBegin', chunk: 'attachmentChunk', commit: 'attachmentCommit', remove: 'attachmentRemove' };
    const fn = bridge[operations[upload[1]]];
    if (typeof fn !== 'function') throw new BridgeError(503, 'attachments_unavailable', 'Attachments are currently unavailable.');
    return { status: 200, body: await fn(owner, b) };
  }
  const match = /^\/bridge\/sessions\/([^/]+)(?:\/(messages|cancel|confirmations|connectors|remove)(?:\/([^/]+))?)?$/.exec(path);
  if (match && UUID.test(match[1])) {
    const [, id, action, confirmation] = match;
    if (!action && method === 'GET') return { status: 200, body: await bridge.getView(id) };
    if (!action && method === 'PATCH') { fields(b, ['title']); title(b.title, true); return { status: 200, body: await bridge.rename(id, b) }; }
    if (action === 'connectors' && !confirmation && method === 'GET') return { status: 200, body: await bridge.getConnectors(id) };
    if (action === 'connectors' && !confirmation && method === 'POST') {
      fields(b, ['id', 'enabled']);
      if (!CONNECTOR_ID.test(b.id || '') || typeof b.enabled !== 'boolean') throw invalid();
      return { status: 200, body: await bridge.setConnector(id, b) };
    }
    if (action === 'remove' && !confirmation && method === 'POST') {
      fields(b, []);
      return { status: 200, body: await bridge.removeSession(id, b) };
    }
    if (action === 'messages' && !confirmation && method === 'POST') {
      fields(b, ['id', 'text', 'modelId', 'mode', 'thinking', 'attachments']);
      if (!UUID.test(b.id || '') || typeof b.text !== 'string' || b.text.length > 8000 ||
          (!b.text.trim() && !b.attachments?.length) ||
          (b.attachments !== undefined && (!Array.isArray(b.attachments) || b.attachments.length > 10 || b.attachments.some(x => typeof x !== 'string' || !UUID.test(x)))) ||
          (b.modelId !== undefined && (typeof b.modelId !== 'string' || b.modelId.length > 120)) ||
          (b.mode !== undefined && !['auto', 'balanced', 'model'].includes(b.mode)) ||
          (b.thinking !== undefined && typeof b.thinking !== 'boolean') || (b.mode === 'model' && !b.modelId)) throw invalid();
      return { status: 202, body: await bridge.send(id, b, owner) };
    }
    if (action === 'cancel' && !confirmation && method === 'POST') { fields(b, []); return { status: 200, body: await bridge.cancel(id) }; }
    if (action === 'confirmations' && /^[\w-]{1,128}$/.test(confirmation || '') && method === 'POST') {
      fields(b, ['decision']); if (!['approve_once', 'deny'].includes(b.decision)) throw invalid();
      return { status: 200, body: await bridge.confirm(id, confirmation, b.decision) };
    }
  }
  throw new BridgeError(404, 'not_found', 'This route is unavailable.');
}
