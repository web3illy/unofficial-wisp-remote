import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createMobileIpAdapter } from '../src/mobile-ip-adapter.js';
import { createMobileServer } from '../src/mobile-server.js';
import { execFileSync } from 'node:child_process';

const bridgeCapability = 'ab'.repeat(32);
const SESSION = '01234567-89ab-4cde-8f01-234567890abc';
const baseIdentity = {
  phoneIp: '127.0.0.1', ownIp: '100.109.220.79', dnsName: 'mac.example.ts.net',
  login: 'owner@example.test', userId: 42, peerId: 'phone-stable-id',
};
const origin = `http://${baseIdentity.ownIp}:8081`;
const eventPath = `/bridge/events?sessionId=${SESSION}`;

function validWhois(identity = baseIdentity) {
  return { Node: { StableID: identity.peerId, User: identity.userId, Addresses: [`${identity.phoneIp}/32`] }, UserProfile: { ID: identity.userId } };
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function send(port, { method = 'GET', path = '/', host = `${baseIdentity.ownIp}:8081`, origin: requestOrigin, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method, path, headers: { Host: host, ...(requestOrigin ? { Origin: requestOrigin } : {}), ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function openStream(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: eventPath, headers: { Host: `${baseIdentity.ownIp}:8081` } }, response => resolve({ request, response }));
    request.on('error', reject);
  });
}

async function fixture(options = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (options.respond) return options.respond(req, res);
      const types = { '/': 'text/html', '/mobile.js': 'text/javascript', '/mobile.css': 'text/css', '/account-settings.js': 'text/javascript', '/account-settings.css': 'text/css', '/wisp-assets/NotoSans-Variable-latin.woff2': 'font/woff2', '/wisp-assets/AscellaPixel-Regular.otf': 'font/otf' };
      const type = types[req.url] || 'application/json';
      res.writeHead(req.method === 'POST' ? 202 : 200, { 'Content-Type': type, 'Set-Cookie': 'internal=not-forwarded', 'X-Upstream-Secret': 'not-forwarded', 'Access-Control-Allow-Origin': '*' });
      res.end(type === 'application/json' ? '{"ok":true}' : 'original-asset');
    });
  });
  const upstreamPort = await listen(upstream);
  const identity = options.identity || baseIdentity;
  const adapter = createMobileIpAdapter({ identity, bridgeCapability, identityResolver: options.identityResolver || (async () => validWhois(identity)), upstreamPort, timing: options.timing });
  const port = await listen(adapter);
  return { port, seen, identity, close: async () => { await close(adapter); await close(upstream); } };
}

test('pinned phone can reach bridge; credentials and arbitrary headers never propagate', async t => {
  const app = await fixture(); t.after(app.close);
  const body = JSON.stringify({ id: SESSION, text: 'Hello' });
  const result = await send(app.port, {
    method: 'POST', path: `/bridge/sessions/${SESSION}/messages`, origin, body,
    headers: { 'Content-Type': 'application/json', Authorization: 'forged', 'X-Wisp-Bridge-Capability': 'cd'.repeat(32), Cookie: 'bad=1', 'Tailscale-User-Login': 'attacker', 'Last-Event-ID': 'fake', 'X-Forwarded-For': 'spoof' },
  });
  assert.equal(result.status, 202);
  assert.equal(app.seen.length, 1);
  const forwarded = app.seen[0];
  assert.equal(forwarded.headers['x-wisp-bridge-capability'], bridgeCapability);
  assert.equal(result.headers['x-wisp-bridge-capability'], undefined);
  assert.equal(forwarded.headers.host, baseIdentity.dnsName);
  assert.equal(forwarded.headers.origin, `https://${baseIdentity.dnsName}`);
  assert.equal(forwarded.headers['tailscale-user-login'], baseIdentity.login);
  for (const name of ['authorization', 'cookie', 'last-event-id', 'x-forwarded-for']) assert.equal(forwarded.headers[name], undefined);
  assert.equal(forwarded.body, body);
  for (const name of ['set-cookie', 'x-upstream-secret', 'access-control-allow-origin']) assert.equal(result.headers[name], undefined);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.headers['content-security-policy'], /font-src 'self'/);
  assert.match(result.headers['content-security-policy'], /img-src 'self' blob:/);
  assert.doesNotMatch(result.headers['content-security-policy'], /unsafe-inline|data:|https?:/);
});

test('HTTP bridge requires its private capability for reads, writes, events and attachments', async t => {
  let calls = 0;
  const count = async () => { calls++; return { fixture: true }; };
  const bridge = createMobileServer({ bridgeCapability,
    identity: { hostname: baseIdentity.dnsName, login: baseIdentity.login },
    bridge: { bootstrap: count, setSandbox: count, getView: count, attachmentRemove: count } });
  const port = await listen(bridge); t.after(() => close(bridge));
  const routes = [['GET', '/'], ['GET', '/bridge/bootstrap'], ['GET', eventPath], ['POST', '/bridge/sandbox'], ['POST', '/bridge/attachments/remove']];
  for (const value of [undefined, '', 'bad', 'cd'.repeat(32), 'ab'.repeat(33)]) {
    for (const [method, path] of routes) {
      const result = await send(port, { method, path, host: '127.0.0.1:4191', origin: 'http://127.0.0.1:4191', body: method === 'POST' ? '{}' : undefined,
        headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...(value === undefined ? {} : { 'X-Wisp-Bridge-Capability': value }) } });
      assert.equal(result.status, 403);
      assert.doesNotMatch(result.body, new RegExp(bridgeCapability));
    }
  }
  assert.equal(calls, 0, 'forged Host/Origin cannot reach the Runtime bridge');
  const adapter = createMobileIpAdapter({ identity: baseIdentity, bridgeCapability, upstreamPort: port, identityResolver: async () => validWhois() });
  const adapterPort = await listen(adapter); t.after(() => close(adapter));
  assert.equal((await send(adapterPort, { path: '/bridge/bootstrap', headers: { 'X-Wisp-Bridge-Capability': 'cd'.repeat(32) } })).status, 200);
  assert.equal((await send(adapterPort, { method: 'POST', path: '/bridge/sandbox', origin, headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' })).status, 200);
  assert.equal((await send(adapterPort, { method: 'POST', path: '/bridge/attachments/remove', origin, headers: { 'Content-Type': 'application/json' }, body: `{"id":"${SESSION}"}` })).status, 200);
  assert.equal(calls, 3);
});

test('unconfigured HTTP components and standalone launches fail closed', () => {
  assert.throws(() => createMobileServer(), /private bridge capability/);
  assert.throws(() => createMobileIpAdapter({ identity: baseIdentity }), /private bridge capability/);
  for (const script of ['mobile-server.js', 'mobile-ip-adapter.js']) {
    assert.throws(() => execFileSync(process.execPath, [new URL(`../src/${script}`, import.meta.url).pathname], { encoding: 'utf8', stdio: 'pipe' }),
      error => error.status === 2 && /Standalone HTTP startup is disabled/.test(error.stderr));
  }
});

test('wrong socket is rejected before identity lookup; live node and owner must match', async t => {
  let calls = 0;
  const identity = { ...baseIdentity, phoneIp: '100.106.81.92' };
  const wrongSocket = await fixture({ identity, identityResolver: async () => { calls += 1; return validWhois(identity); } });
  assert.equal((await send(wrongSocket.port)).status, 403);
  assert.equal(calls, 0); await wrongSocket.close();
  const variants = [
    { ...validWhois(), Node: { ...validWhois().Node, StableID: 'other' } },
    { ...validWhois(), Node: { ...validWhois().Node, User: 99 } },
    { ...validWhois(), UserProfile: { ID: 99 } },
    { ...validWhois(), Node: { ...validWhois().Node, Addresses: ['100.0.0.1/32'] } },
  ];
  for (const value of variants) {
    const app = await fixture({ identityResolver: async () => value });
    assert.equal((await send(app.port)).status, 403); assert.equal(app.seen.length, 0); await app.close();
  }
  const failed = await fixture({ identityResolver: async () => { throw new Error('sensitive internal error'); } }); t.after(failed.close);
  const result = await send(failed.port);
  assert.equal(result.status, 403); assert.doesNotMatch(result.body, /sensitive/); assert.equal(failed.seen.length, 0);
});

test('identity lookup timeout fails closed', async t => {
  const app = await fixture({ identityResolver: () => new Promise(() => {}), timing: { identity: 20 } }); t.after(app.close);
  assert.equal((await send(app.port)).status, 403); assert.equal(app.seen.length, 0);
});

test('exact Host, write Origin and Fetch-Site checks cover POST and PATCH', async t => {
  const app = await fixture(); t.after(app.close);
  assert.equal((await send(app.port, { host: 'localhost:8081' })).status, 403);
  assert.equal((await send(app.port, { origin: 'http://evil.test' })).status, 403);
  assert.equal((await send(app.port, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  for (const [method, path] of [['POST', '/bridge/sessions'], ['PATCH', `/bridge/sessions/${SESSION}`]]) {
    for (const badOrigin of [undefined, 'http://evil.test']) {
      assert.equal((await send(app.port, { method, path, origin: badOrigin, headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    }
  }
  assert.equal(app.seen.length, 0);
});

test('allowlist admits only supported routes, UUID sessions, a single SSE query and local assets', async t => {
  const app = await fixture(); t.after(app.close);
  const rejected = [
    '/api/sessions', '/bridge/bootstrap?extra=1', '/bridge/profile?extra=1', '/bridge/usage?raw=1', '/bridge/account', '/bridge/payments', '/bridge/permissions', `/bridge/projects/${SESSION}/permissions`, '/bridge/privacy?raw=1', '/bridge/privacy/refresh?force=1', '/bridge/sessions/not-uuid', '/bridge/events', '/bridge/sessions/not-uuid/connectors',
    `${eventPath}&sessionId=${SESSION}`, `${eventPath}&x=1`, `/bridge/events?sessionId=%30${SESSION.slice(1)}`,
    '/x/../bridge/bootstrap', '/account-settings.js?raw=1', '/account-settings.css/extra', '/wisp-assets/../mobile.js', '/wisp-assets/%2e%2e/mobile.js',
    '/wisp-assets/nested/font.woff2', '/wisp-assets/a.js', '/wisp-assets/a.svg?x=1', 'http://evil.test/',
  ];
  for (const path of rejected) assert.equal((await send(app.port, { path })).status, 404, path);
  assert.equal((await send(app.port, { method: 'DELETE', path: `/bridge/sessions/${SESSION}` })).status, 404);
  assert.equal((await send(app.port, { method: 'HEAD', path: '/bridge/privacy' })).status, 404);
  assert.equal(app.seen.length, 0);
  for (const path of ['/', '/mobile.js', '/mobile.css', '/account-settings.js', '/account-settings.css', '/bridge/bootstrap', '/bridge/profile', '/bridge/privacy', '/bridge/sandbox', '/bridge/usage', `/bridge/sessions/${SESSION}/connectors`, `/bridge/sessions/${SESSION}`, '/wisp-assets/NotoSans-Variable-latin.woff2', '/wisp-assets/AscellaPixel-Regular.otf']) {
    assert.equal((await send(app.port, { path })).status, 200, path);
  }
  assert.equal((await send(app.port, { method: 'HEAD', path: '/mobile.js' })).body, '');
  assert.equal((await send(app.port, { method: 'HEAD', path: '/account-settings.js' })).body, '');
  for (const path of ['/bridge/privacy/refresh', '/bridge/sandbox', '/bridge/sessions', '/bridge/projects', `/bridge/projects/${SESSION}/remove`, `/bridge/sessions/${SESSION}/remove`, `/bridge/sessions/${SESSION}/cancel`, `/bridge/sessions/${SESSION}/connectors`, `/bridge/sessions/${SESSION}/confirmations/confirmation_123-abc`,
    '/bridge/attachments/begin', '/bridge/attachments/chunk', '/bridge/attachments/commit', '/bridge/attachments/remove']) {
    assert.equal((await send(app.port, { method: 'POST', path, origin, headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 202, path);
  }
  assert.equal((await send(app.port, { method: 'POST', path: '/bridge/projects/not-a-uuid/remove', origin, headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await send(app.port, { method: 'POST', path: '/bridge/sessions/not-a-uuid/remove', origin, headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await send(app.port, { method: 'POST', path: `/bridge/sessions/${SESSION}/remove/extra`, origin, headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await send(app.port, { method: 'PATCH', path: `/bridge/sessions/${SESSION}`, origin, headers: { 'Content-Type': 'application/json' }, body: '{"title":"New title"}' })).status, 200);
});

test('JSON, 32KB body, and 8000-character text limits are enforced before upstream', async t => {
  const app = await fixture(); t.after(app.close);
  const path = `/bridge/sessions/${SESSION}/messages`;
  const post = (body, headers = { 'Content-Type': 'application/json' }) => send(app.port, { method: 'POST', path, origin, headers, body });
  assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('not-json')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post('{"text":""}')).status, 400);
  assert.equal((await post(JSON.stringify({ text: 'x'.repeat(8001) }))).status, 400);
  assert.equal((await post('x'.repeat(32 * 1024 + 1))).status, 413);
  assert.equal(app.seen.length, 0);
  assert.equal((await post(JSON.stringify({ attachments: [SESSION] }))).status, 202);
  assert.equal((await post(JSON.stringify({ text: 'x'.repeat(8000) }))).status, 202);
});

test('unexpected upstream MIME is rejected and errors do not expose upstream headers', async t => {
  const app = await fixture({ respond: (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'secret' }); res.end('<script>bad</script>'); } }); t.after(app.close);
  const result = await send(app.port, { path: '/bridge/bootstrap' });
  assert.equal(result.status, 502); assert.doesNotMatch(result.body, /script/); assert.equal(result.headers['set-cookie'], undefined);
});

test('SSE arrives before completion; phone disconnect closes subscription without canceling Wisp', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const app = await fixture({ respond: (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'secret' });
    res.write('event: snapshot\ndata: {"messages":[]}\n\n');
    res.on('close', upstreamClosed);
  } }); t.after(app.close);
  const { request, response } = await openStream(app.port);
  assert.equal(response.statusCode, 200); assert.equal(response.headers['set-cookie'], undefined);
  const [chunk] = await once(response, 'data');
  assert.match(chunk.toString(), /event: snapshot/);
  request.destroy(); response.destroy();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream subscription left open')), 500))]);
  assert.deepEqual(app.seen.map(item => item.path), [eventPath]);
});

test('SSE identity revocation terminates a live subscription', async t => {
  let checks = 0;
  const app = await fixture({
    identityResolver: async () => { checks += 1; return checks === 1 ? validWhois() : { ...validWhois(), Node: { ...validWhois().Node, StableID: 'revoked' } }; },
    timing: { recheck: 25, heartbeat: 10 },
    respond: (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); },
  }); t.after(app.close);
  const result = await send(app.port, { path: eventPath });
  assert.equal(result.status, 200); assert.ok(checks >= 2); assert.match(result.body, /ready/);
});

test('heartbeat never splits an upstream event and stream lifetime bounds subscriptions', async t => {
  const app = await fixture({
    timing: { heartbeat: 5, lifetime: 60 },
    respond: (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: run\ndata: {"text":"hel');
      const timer = setTimeout(() => res.write('lo"}\n\n'), 25);
      res.on('close', () => clearTimeout(timer));
    },
  }); t.after(app.close);
  const result = await send(app.port, { path: eventPath });
  assert.equal(result.status, 200);
  assert.ok(result.body.startsWith('event: run\ndata: {"text":"hello"}\n\n'));
  assert.match(result.body, /: keepalive/);
});

test('two live SSE subscriptions are allowed and a third fails closed', async t => {
  const app = await fixture({ respond: (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); } }); t.after(app.close);
  const first = await openStream(app.port); const second = await openStream(app.port);
  assert.equal(first.response.statusCode, 200); assert.equal(second.response.statusCode, 200);
  const third = await send(app.port, { path: eventPath });
  assert.equal(third.status, 503); assert.equal(app.seen.length, 2);
  first.request.destroy(); first.response.destroy(); second.request.destroy(); second.response.destroy();
});
