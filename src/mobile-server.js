import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createBridge } from './mobile-bridge.js';
import { BridgeError } from './wisp-client.js';
import { UUID } from './mobile-store.js';

const PORT = 4191, PUBLIC = new URL('../public/', import.meta.url);
const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_REMOVAL_LIMIT = 750;
const bad = (message = 'Invalid request.') => new BridgeError(400, 'invalid_request', message);
function headers(res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
async function body(req, allowed) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw new BridgeError(415, 'json_required', 'A JSON request is required.');
  let size = 0; const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw new BridgeError(413, 'too_large', 'The request is too large.');
    parts.push(chunk);
  }
  let value; try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw bad(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw bad();
  return value;
}
function title(value, required = false) { if ((required || value !== undefined) && (typeof value !== 'string' || !value.trim() || value.length > 180)) throw bad('The title must contain between 1 and 180 characters.'); }

export async function attachmentHTTP({ pathname, req, res, bridge, owner = 'http-current-owner' }) {
  const match = /^\/bridge\/attachments\/(begin|chunk|commit|remove)$/.exec(pathname);
  if (!match || req.method !== 'POST') return false;
  const action = match[1];
  if (action === 'begin') json(res, 201, await bridge.attachmentBegin(owner, await body(req, ['sessionId', 'kind', 'filename', 'size', 'mimeType', 'width', 'height'])));
  else if (action === 'chunk') json(res, 200, await bridge.attachmentChunk(owner, await body(req, ['id', 'offset', 'dataBase64'])));
  else if (action === 'commit') json(res, 200, await bridge.attachmentCommit(owner, await body(req, ['id'])));
  else json(res, 200, await bridge.attachmentRemove(owner, await body(req, ['id'])));
  return true;
}

export function createMobileServer({ bridge, bridgeCapability, identity = null, port = PORT, heartbeatMs = 15_000 } = {}) {
  if (typeof bridgeCapability !== 'string' || !/^[0-9a-f]{64}$/.test(bridgeCapability)) throw new Error('A private bridge capability is required. Use start:legacy.');
  const expectedCapability = Buffer.from(bridgeCapability);
  bridge ??= createBridge();
  let streams = 0;
  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      const supplied = req.headers['x-wisp-bridge-capability'];
      if (typeof supplied !== 'string' || !/^[0-9a-f]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), expectedCapability)) {
        throw new BridgeError(403, 'client_rejected', 'This client is not authorized.');
      }
      const host = req.headers.host;
      let origin;
      if ([`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) origin = `http://${host}`;
      else if (identity && host === identity.hostname && req.headers['tailscale-user-login'] === identity.login) origin = `https://${host}`;
      else throw new BridgeError(403, 'client_rejected', 'This client is not authorized.');
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new BridgeError(403, 'cross_site', 'The request origin was rejected.');
      const mutation = ['POST', 'PATCH'].includes(req.method);
      if ((mutation && req.headers.origin !== origin) || (req.headers.origin && req.headers.origin !== origin)) throw new BridgeError(403, 'origin_rejected', 'The request origin was rejected.');
      const url = new URL(req.url, 'http://bridge.invalid');
      const pathname = url.pathname;
      if (url.search && pathname !== '/bridge/events') throw bad();
      if (await attachmentHTTP({ pathname, req, res, bridge })) return;
      if (pathname === '/bridge/bootstrap' && req.method === 'GET') return json(res, 200, await bridge.bootstrap());
      if (pathname === '/bridge/profile' && req.method === 'GET') return json(res, 200, await bridge.profile());
      if (pathname === '/bridge/sandbox' && req.method === 'GET') return json(res, 200, await bridge.sandbox());
      if (pathname === '/bridge/usage' && req.method === 'GET') return json(res, 200, await bridge.usage());
      if (pathname === '/bridge/privacy' && req.method === 'GET') return json(res, 200, await bridge.privacy());
      if (pathname === '/bridge/sandbox' && req.method === 'POST') {
        const b = await body(req, ['enabled', 'allowNetwork']);
        const keys = Object.keys(b);
        if (keys.length !== 1 || typeof b[keys[0]] !== 'boolean') throw bad();
        return json(res, 200, await bridge.setSandbox(b));
      }
      if (pathname === '/bridge/privacy/refresh' && req.method === 'POST') {
        await body(req, []);
        return json(res, 200, await bridge.refreshPrivacy());
      }
      if (pathname === '/bridge/sessions' && req.method === 'POST') {
        const b = await body(req, ['projectId', 'title']); title(b.title);
        if (b.projectId !== undefined && !UUID.test(b.projectId)) throw bad();
        return json(res, 201, await bridge.createSession(b));
      }
      if (pathname === '/bridge/projects' && req.method === 'POST') return json(res, 201, await bridge.createProject(await body(req, ['name'])));
      const projectRemoval = /^\/bridge\/projects\/([^/]+)\/remove$/.exec(pathname);
      if (projectRemoval && req.method === 'POST') {
        if (!UUID.test(projectRemoval[1])) throw new BridgeError(404, 'not_found', 'This route is unavailable.');
        const b = await body(req, ['sessionIds', 'activeSessionId']);
        if (Object.keys(b).length !== 2 || !Array.isArray(b.sessionIds) || b.sessionIds.length > PROJECT_REMOVAL_LIMIT ||
            b.sessionIds.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(b.sessionIds).size !== b.sessionIds.length ||
            (b.activeSessionId !== null && (typeof b.activeSessionId !== 'string' || !UUID.test(b.activeSessionId)))) throw bad();
        return json(res, 200, await bridge.removeProject(projectRemoval[1], b));
      }
      const sessionRemoval = /^\/bridge\/sessions\/([^/]+)\/remove$/.exec(pathname);
      if (sessionRemoval && req.method === 'POST') {
        if (!UUID.test(sessionRemoval[1])) throw new BridgeError(404, 'not_found', 'This route is unavailable.');
        const b = await body(req, []);
        return json(res, 200, await bridge.removeSession(sessionRemoval[1], b));
      }
      const m = /^\/bridge\/sessions\/([^/]+)(?:\/(messages|cancel|confirmations|connectors|remove)(?:\/([^/]+))?)?$/.exec(pathname);
      if (m && UUID.test(m[1])) {
        const [, id, action, confirmation] = m;
        if (!action && req.method === 'GET') return json(res, 200, await bridge.getView(id));
        if (!action && req.method === 'PATCH') { const b = await body(req, ['title']); title(b.title, true); return json(res, 200, await bridge.rename(id, b)); }
        if (action === 'connectors' && !confirmation && req.method === 'GET') return json(res, 200, await bridge.getConnectors(id));
        if (action === 'connectors' && !confirmation && req.method === 'POST') {
          const b = await body(req, ['id', 'enabled']);
          if (!CONNECTOR_ID.test(b.id || '') || typeof b.enabled !== 'boolean') throw bad();
          return json(res, 200, await bridge.setConnector(id, b));
        }
        if (action === 'remove') throw new BridgeError(404, 'not_found', 'This route is unavailable.');
        if (action === 'messages' && !confirmation && req.method === 'POST') {
          const b = await body(req, ['id', 'text', 'attachments', 'modelId', 'mode', 'thinking']);
          const attachmentIds = b.attachments ?? [];
          if (!UUID.test(b.id || '') || (b.text !== undefined && (typeof b.text !== 'string' || b.text.length > 8000)) ||
              (!String(b.text || '').trim() && (!Array.isArray(attachmentIds) || !attachmentIds.length)) ||
              !Array.isArray(attachmentIds) || attachmentIds.length > 10 || attachmentIds.some(value => !UUID.test(value || '')) ||
              (b.modelId !== undefined && (typeof b.modelId !== 'string' || b.modelId.length > 120)) ||
              (b.mode !== undefined && !['auto', 'balanced', 'model'].includes(b.mode)) ||
              (b.thinking !== undefined && typeof b.thinking !== 'boolean') || (b.mode === 'model' && !b.modelId)) throw bad('Check the message and selected model.');
          return json(res, 202, await bridge.send(id, b, 'http-current-owner'));
        }
        if (action === 'cancel' && !confirmation && req.method === 'POST') { await body(req, []); return json(res, 200, await bridge.cancel(id)); }
        if (action === 'confirmations' && /^[\w-]{1,128}$/.test(confirmation || '') && req.method === 'POST') {
          const b = await body(req, ['decision']); if (!['approve_once', 'deny'].includes(b.decision)) throw bad();
          return json(res, 200, await bridge.confirm(id, confirmation, b.decision));
        }
      }
      if (pathname === '/bridge/events' && req.method === 'GET') {
        const id = url.searchParams.get('sessionId');
        if (!UUID.test(id || '') || [...url.searchParams.keys()].length !== 1) throw bad();
        if (streams >= 6) throw new BridgeError(429, 'stream_limit', 'Too many connections are open.');
        const snapshot = await bridge.getView(id);
        streams++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        let closed = false;
        const send = ({ type, data }) => {
          if (closed) return;
          if (res.writableLength > 2_000_000) return res.destroy();
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        bridge.events.on(id, send);
        send({ type: 'snapshot', data: snapshot });
        const heartbeat = setInterval(() => { if (!closed) res.write('event: ping\ndata: {}\n\n'); }, heartbeatMs);
        const end = () => { if (closed) return; closed = true; streams--; clearInterval(heartbeat); bridge.events.off(id, send); };
        res.on('close', end); res.on('error', end); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new BridgeError(405, 'method', 'This action is not supported.');
      let file, type;
      if (pathname === '/') { file = 'mobile.html'; type = 'text/html; charset=utf-8'; }
      else if (pathname === '/mobile.js') { file = 'mobile.js'; type = 'text/javascript; charset=utf-8'; }
      else if (pathname === '/mobile.css') { file = 'mobile.css'; type = 'text/css; charset=utf-8'; }
      else if (pathname === '/account-settings.js') { file = 'account-settings.js'; type = 'text/javascript; charset=utf-8'; }
      else if (pathname === '/account-settings.css') { file = 'account-settings.css'; type = 'text/css; charset=utf-8'; }
      else if (/^\/wisp-assets\/[A-Za-z0-9_-]+\.(woff2|otf|svg|png)$/.test(pathname)) {
        const name = pathname.split('/').at(-1);
        if ((await readdir(new URL('wisp-assets/', PUBLIC))).includes(name)) {
          file = pathname.slice(1); type = ({ woff2: 'font/woff2', otf: 'font/otf', svg: 'image/svg+xml', png: 'image/png' })[name.split('.').at(-1)];
        }
      }
      if (!file) throw new BridgeError(404, 'not_found', 'Page not found.');
      const bytes = await readFile(new URL(file, PUBLIC));
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length }); res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (e) {
      if (res.headersSent || res.destroyed) return res.end();
      const error = e instanceof BridgeError ? e : new BridgeError(500, 'internal', 'Could not complete the action.');
      json(res, error.status, { error: { code: error.code, message: error.message } });
    }
  });
  server.headersTimeout = 10_000; server.requestTimeout = 20_000; server.maxConnections = 32;
  return server;
}

// The owner starts both components together and shares a private capability in
// memory. Direct launches must never expose an unauthenticated Runtime bridge.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.error('Standalone HTTP startup is disabled. Use npm run start:legacy -- --phone-ip <Tailscale IPv4>.');
  process.exitCode = 2;
}
