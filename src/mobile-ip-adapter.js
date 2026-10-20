import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TAILSCALE = '/usr/local/bin/tailscale';
const PORT = 8081;
const BODY_LIMIT = 32 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const MAX_IN_FLIGHT = 12;
const MAX_STREAMS = 2;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SESSION = new RegExp(`^/bridge/sessions/(${UUID})$`);
const MESSAGE = new RegExp(`^/bridge/sessions/(${UUID})/messages$`);
const CANCEL = new RegExp(`^/bridge/sessions/(${UUID})/cancel$`);
const SESSION_REMOVAL = new RegExp(`^/bridge/sessions/(${UUID})/remove$`);
const CONNECTORS = new RegExp(`^/bridge/sessions/(${UUID})/connectors$`);
const PROJECT_REMOVAL = new RegExp(`^/bridge/projects/(${UUID})/remove$`);
const CONFIRMATION = new RegExp(`^/bridge/sessions/(${UUID})/confirmations/[A-Za-z0-9_-]{1,128}$`);
const ATTACHMENT = /^\/bridge\/attachments\/(begin|chunk|commit|remove)$/;
const EVENTS = new RegExp(`^/bridge/events\\?sessionId=${UUID}$`);
const ASSET = /^\/wisp-assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(woff2|woff|otf|ttf|png|svg|jpg|jpeg|webp)$/;
const TYPES = {
  woff2: 'font/woff2', woff: 'font/woff', otf: 'font/otf', ttf: 'font/ttf',
  png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};
const DEFAULT_TIMING = { identity: 3_500, recheck: 60_000, heartbeat: 15_000, upstreamIdle: 90_000, lifetime: 30 * 60_000 };

class AdapterError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function runFile(args, timeout = 3_000) {
  return new Promise((resolve, reject) => {
    execFile(TAILSCALE, args, { timeout, maxBuffer: 2_000_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

function ipv4(value) {
  return typeof value === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split('.').every(part => Number(part) <= 255);
}

export async function startupIdentity(phoneIp) {
  const value = JSON.parse(await runFile(['status', '--json'], 5_000));
  const userId = value?.Self?.UserID;
  const login = value?.User?.[userId]?.LoginName;
  const dnsName = value?.Self?.DNSName?.replace(/\.$/, '').toLowerCase();
  const ownIp = value?.Self?.TailscaleIPs?.find(ipv4);
  const peer = Object.values(value?.Peer || {}).find(item => item?.OS === 'iOS' && item?.UserID === userId && item?.TailscaleIPs?.includes(phoneIp));
  if (!userId || !login || !dnsName || !ownIp || !peer?.ID) throw new Error('identity');
  return { phoneIp, ownIp, dnsName, login, userId, peerId: peer.ID };
}

async function resolveWhois(phoneIp) {
  return JSON.parse(await runFile(['whois', '--json', phoneIp]));
}

function whoisMatches(value, identity) {
  return value?.Node?.StableID === identity.peerId && value?.Node?.User === identity.userId &&
    value?.UserProfile?.ID === identity.userId && Array.isArray(value?.Node?.Addresses) &&
    value.Node.Addresses.includes(`${identity.phoneIp}/32`);
}

async function verifyIdentity(identityResolver, identity, timeout) {
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => identityResolver(identity.phoneIp)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeout); timer.unref(); }),
    ]);
    if (!whoisMatches(value, identity)) throw new Error('identity');
  } catch {
    throw new AdapterError(403, 'identity_rejected', 'This device is not authorized.');
  } finally { clearTimeout(timer); }
}

function routeFor(method, path) {
  // Match the original request target, not URL-normalized paths: no traversal,
  // encoded separators, duplicate query parameters, or arbitrary upstream URLs.
  if (method === 'GET' && EVENTS.test(path)) return { type: 'text/event-stream', stream: true };
  if (method === 'GET' && ['/bridge/privacy', '/bridge/sandbox', '/bridge/usage'].includes(path)) return { type: 'application/json' };
  if (['GET', 'HEAD'].includes(method)) {
    if (path === '/') return { type: 'text/html' };
    if (path === '/mobile.js') return { type: 'text/javascript' };
    if (path === '/mobile.css') return { type: 'text/css' };
    if (path === '/account-settings.js') return { type: 'text/javascript' };
    if (path === '/account-settings.css') return { type: 'text/css' };
    const asset = ASSET.exec(path);
    if (asset) return { type: TYPES[asset[1]] };
    if (path === '/bridge/bootstrap' || path === '/bridge/profile' || SESSION.test(path) || CONNECTORS.test(path)) return { type: 'application/json' };
  }
  if (method === 'POST' && (path === '/bridge/privacy/refresh' || path === '/bridge/sandbox' || path === '/bridge/sessions' || path === '/bridge/projects' || PROJECT_REMOVAL.test(path) || SESSION_REMOVAL.test(path) || MESSAGE.test(path) || CANCEL.test(path) || CONNECTORS.test(path) || CONFIRMATION.test(path) || ATTACHMENT.test(path))) {
    return { type: 'application/json', write: true, message: MESSAGE.test(path) };
  }
  if (method === 'PATCH' && SESSION.test(path)) return { type: 'application/json', write: true };
  throw new AdapterError(404, 'not_found', 'This route is unavailable.');
}

function safeHeaders(res, type, length) {
  res.setHeader('Content-Type', type);
  if (length !== undefined) res.setHeader('Content-Length', String(length));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function json(res, status, code, message) {
  const body = Buffer.from(JSON.stringify({ error: { code, message } }));
  safeHeaders(res, 'application/json; charset=utf-8', body.length);
  res.writeHead(status);
  res.end(body);
}

async function readBody(req, route) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw new AdapterError(415, 'json_required', 'A JSON request is required.');
  if (Number(req.headers['content-length']) > BODY_LIMIT) { req.resume(); throw new AdapterError(413, 'too_large', 'The request is too large.'); }
  const buffer = await new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (!settled && size > BODY_LIMIT) { settled = true; reject(new AdapterError(413, 'too_large', 'The request is too large.')); }
      else if (!settled) chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    const interrupted = () => { if (!settled) { settled = true; reject(new AdapterError(400, 'interrupted', 'The request was interrupted.')); } };
    req.on('aborted', interrupted);
    req.on('error', interrupted);
  });
  let value;
  try { value = JSON.parse(buffer); }
  catch { throw new AdapterError(400, 'invalid_json', 'Invalid JSON request.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterError(400, 'invalid_body', 'Invalid request.');
  if (route.message) {
    const text = typeof value.text === 'string' && value.text.trim() && value.text.length <= 8_000;
    const attachments = Array.isArray(value.attachments) && value.attachments.length > 0 && value.attachments.length <= 10;
    if (!text && !attachments) throw new AdapterError(400, 'invalid_text', 'Add a message or attachment.');
  }
  return buffer;
}

function forward({ req, res, route, body, identity, identityResolver, upstreamPort, bridgeCapability, timing }) {
  return new Promise((resolve, reject) => {
    let response;
    let finished = false;
    let identityCheckRunning = false;
    let frameTail = '';
    let atFrameBoundary = true;
    const timers = [];
    const done = error => {
      if (finished) return;
      finished = true;
      timers.forEach(timer => { clearInterval(timer); clearTimeout(timer); });
      res.off('close', disconnected);
      if (error) reject(error); else resolve();
    };
    const disconnected = () => {
      // A browser disconnect ends only this subscription, never the Wisp turn.
      response?.destroy();
      proxy.destroy();
      done();
    };
    const endStream = () => {
      response?.unpipe(res);
      response?.destroy();
      proxy.destroy();
      if (!res.destroyed) res.end();
      done();
    };
    const headers = {
      Host: identity.dnsName,
      Origin: `https://${identity.dnsName}`,
      'Tailscale-User-Login': identity.login,
      'Sec-Fetch-Site': 'same-origin',
      'X-Wisp-Bridge-Capability': bridgeCapability,
    };
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(body.length); }
    const proxy = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method === 'HEAD' ? 'GET' : req.method, headers, timeout: 15_000 }, upstream => {
      response = upstream;
      const status = upstream.statusCode || 502;
      const type = String(upstream.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const expected = status >= 400 ? 'application/json' : route.type;
      if (type !== expected) {
        upstream.destroy();
        done(new AdapterError(502, 'upstream_type', 'The bridge returned an unexpected response.'));
        return;
      }
      if (route.stream && status === 200) {
        proxy.setTimeout(0);
        upstream.setTimeout(timing.upstreamIdle, endStream);
        safeHeaders(res, 'text/event-stream; charset=utf-8');
        res.writeHead(200);
        res.flushHeaders();
        upstream.on('data', chunk => {
          frameTail = (frameTail + chunk.toString('latin1')).slice(-4);
          atFrameBoundary = /\n\n$|\r\n\r\n$|\r\r$/.test(frameTail);
        });
        timers.push(setInterval(async () => {
          if (finished || identityCheckRunning) return;
          identityCheckRunning = true;
          try { await verifyIdentity(identityResolver, identity, timing.identity); }
          catch { endStream(); }
          finally { identityCheckRunning = false; }
        }, timing.recheck));
        timers.push(setInterval(() => {
          // Never insert a comment in the middle of an upstream SSE frame or
          // defeat pipe backpressure while the phone is reading slowly.
          if (!finished && atFrameBoundary && !res.writableNeedDrain && res.writableLength === 0) res.write(': keepalive\n\n');
        }, timing.heartbeat));
        timers.push(setTimeout(endStream, timing.lifetime));
        timers.forEach(timer => timer.unref());
        upstream.once('end', () => done());
        upstream.once('error', endStream);
        upstream.once('aborted', endStream);
        upstream.pipe(res);
        return;
      }
      const chunks = [];
      let size = 0;
      upstream.on('data', chunk => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) {
          upstream.destroy();
          done(new AdapterError(502, 'upstream_large', 'The bridge response is too large.'));
        } else chunks.push(chunk);
      });
      upstream.once('end', () => {
        if (finished) return;
        const result = Buffer.concat(chunks);
        safeHeaders(res, type.startsWith('text/') || type === 'application/json' ? `${type}; charset=utf-8` : type, result.length);
        res.writeHead(status);
        res.end(req.method === 'HEAD' ? undefined : result);
        done();
      });
      const failed = () => done(new AdapterError(502, 'upstream_error', 'The bridge is unavailable.'));
      upstream.once('error', failed);
      upstream.once('aborted', failed);
    });
    res.once('close', disconnected);
    proxy.once('timeout', () => proxy.destroy());
    proxy.once('error', () => {
      if (res.headersSent) endStream();
      else done(new AdapterError(502, 'upstream_error', 'The bridge is unavailable.'));
    });
    if (body) proxy.write(body);
    proxy.end();
  });
}

export function createMobileIpAdapter({ identity, bridgeCapability, identityResolver = resolveWhois, upstreamPort = 4191, timing: timingOverrides = {} }) {
  if (typeof bridgeCapability !== 'string' || !/^[0-9a-f]{64}$/.test(bridgeCapability)) throw new Error('A private bridge capability is required. Use start:legacy.');
  const timing = { ...DEFAULT_TIMING, ...timingOverrides };
  let inFlight = 0;
  let streams = 0;
  const server = http.createServer(async (req, res) => {
    let counted = false;
    let streamCounted = false;
    try {
      const route = routeFor(req.method, req.url);
      if (req.headers.host !== `${identity.ownIp}:${PORT}`) throw new AdapterError(403, 'host_rejected', 'This client is not authorized.');
      const expectedOrigin = `http://${identity.ownIp}:${PORT}`;
      if ((route.write && req.headers.origin !== expectedOrigin) || (!route.write && req.headers.origin && req.headers.origin !== expectedOrigin)) throw new AdapterError(403, 'origin_rejected', 'The request origin was rejected.');
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) throw new AdapterError(403, 'cross_site', 'Cross-site requests are not allowed.');
      if (req.socket.remoteAddress !== identity.phoneIp) throw new AdapterError(403, 'socket_rejected', 'This device is not authorized.');
      if (inFlight >= MAX_IN_FLIGHT || (route.stream && streams >= MAX_STREAMS)) throw new AdapterError(503, 'busy', 'Too many requests.');
      inFlight += 1; counted = true;
      if (route.stream) { streams += 1; streamCounted = true; }
      await verifyIdentity(identityResolver, identity, timing.identity);
      if (res.destroyed) return;
      const body = route.write ? await readBody(req, route) : null;
      if (res.destroyed) return;
      await forward({ req, res, route, body, identity, identityResolver, upstreamPort, bridgeCapability, timing });
    } catch (error) {
      if (!res.destroyed) {
        if (res.headersSent) res.end();
        else {
          const safe = error instanceof AdapterError ? error : new AdapterError(500, 'internal', 'Internal adapter error.');
          json(res, safe.status, safe.code, safe.message);
        }
      }
    } finally {
      if (counted) inFlight -= 1;
      if (streamCounted) streams -= 1;
    }
  });
  server.maxConnections = 24;
  server.headersTimeout = 5_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

// The owner starts both components together and shares a private capability in
// memory. Direct launches must never expose an unauthenticated Runtime bridge.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.error('Standalone HTTP startup is disabled. Use npm run start:legacy -- --phone-ip <Tailscale IPv4>.');
  process.exitCode = 2;
}
