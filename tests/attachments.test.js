import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAttachmentStore } from '../src/attachments.js';
import { createBridge } from '../src/mobile-bridge.js';
import { createMobileServer } from '../src/mobile-server.js';

const bridgeCapability = 'ab'.repeat(32);
import { normalizeMessages } from '../src/mobile-store.js';
import { BridgeError } from '../src/wisp-client.js';

const OWNER = 'peer:synthetic-phone';
const SESSION = randomUUID();
const base64 = value => Buffer.from(value).toString('base64');

function addText(store, { owner = OWNER, sessionId = SESSION, kind = 'file', filename = 'fixture.txt', text = 'synthetic text' } = {}) {
  const bytes = Buffer.from(text);
  const draft = store.begin(owner, { sessionId, kind, filename, size: bytes.length, mimeType: kind === 'pdf_text' ? 'application/pdf' : 'text/plain' });
  store.chunk(owner, { id: draft.id, offset: 0, dataBase64: bytes.toString('base64') });
  return store.commit(owner, { id: draft.id });
}

test('attachment store binds owner and session, requires ordered canonical chunks, and hides content in metadata', () => {
  const store = createAttachmentStore();
  const bytes = Buffer.from('safe synthetic content');
  const draft = store.begin(OWNER, { sessionId: SESSION, kind: 'file', filename: 'notes.txt', size: bytes.length, mimeType: 'text/plain' });
  assert.deepEqual(Object.keys(draft).sort(), ['filename', 'id', 'kind', 'mimeType', 'size']);
  assert.throws(() => store.chunk(OWNER, { id: draft.id, offset: 1, dataBase64: bytes.toString('base64') }), error => error.code === 'attachment_offset');
  assert.throws(() => store.chunk(OWNER, { id: draft.id, offset: 0, dataBase64: 'YR==' }), error => error.code === 'attachment_chunk');
  store.chunk(OWNER, { id: draft.id, offset: 0, dataBase64: bytes.subarray(0, 4).toString('base64') });
  store.chunk(OWNER, { id: draft.id, offset: 4, dataBase64: bytes.subarray(4).toString('base64') });
  store.commit(OWNER, { id: draft.id });
  assert.throws(() => store.resolve('peer:other', [draft.id], SESSION), error => error.status === 404);
  assert.throws(() => store.resolve(OWNER, [draft.id], randomUUID()), error => error.code === 'attachment_session');
  assert.deepEqual(store.resolve(OWNER, [draft.id], SESSION), [{ type: 'file', filename: 'notes.txt', content: 'safe synthetic content' }]);
  store.consume(OWNER, [draft.id]);
  assert.throws(() => store.resolve(OWNER, [draft.id], SESSION), error => error.status === 404);
});

test('attachment validation rejects paths, binary text, forged images, totals and expired drafts', () => {
  let clock = 100;
  const store = createAttachmentStore({ limits: { maxCount: 2, maxFileBytes: 32, maxOwnerBytes: 16, maxChunkBytes: 8, ttlMs: 50 }, now: () => clock });
  assert.throws(() => store.begin(OWNER, { sessionId: SESSION, kind: 'file', filename: '../bad.txt', size: 1 }), error => error.code === 'attachment_name');
  const binary = store.begin(OWNER, { sessionId: SESSION, kind: 'file', filename: 'binary.txt', size: 3 });
  store.chunk(OWNER, { id: binary.id, offset: 0, dataBase64: base64(Buffer.from([97, 0, 98])) });
  assert.throws(() => store.commit(OWNER, { id: binary.id }), error => error.code === 'attachment_binary');
  store.remove(OWNER, { id: binary.id });
  const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x01, 0x00, 0x01, 0xff, 0xd9]);
  const image = store.begin(OWNER, { sessionId: SESSION, kind: 'image', filename: 'one.jpg', size: imageBytes.length, mimeType: 'image/jpeg', width: 2, height: 1 });
  store.chunk(OWNER, { id: image.id, offset: 0, dataBase64: imageBytes.subarray(0, 8).toString('base64') });
  store.chunk(OWNER, { id: image.id, offset: 8, dataBase64: imageBytes.subarray(8).toString('base64') });
  assert.throws(() => store.commit(OWNER, { id: image.id }), error => error.code === 'attachment_image');
  store.remove(OWNER, { id: image.id });
  const validImage = store.begin(OWNER, { sessionId: SESSION, kind: 'image', filename: 'one.jpg', size: imageBytes.length, mimeType: 'image/jpeg', width: 1, height: 1 });
  store.chunk(OWNER, { id: validImage.id, offset: 0, dataBase64: imageBytes.subarray(0, 8).toString('base64') });
  store.chunk(OWNER, { id: validImage.id, offset: 8, dataBase64: imageBytes.subarray(8).toString('base64') });
  store.commit(OWNER, { id: validImage.id });
  assert.match(store.resolve(OWNER, [validImage.id], SESSION)[0].image_url.url, /^data:image\/jpeg;base64,/);
  store.remove(OWNER, { id: validImage.id });
  const short = store.begin(OWNER, { sessionId: SESSION, kind: 'file', filename: 'short.txt', size: 10 });
  assert.throws(() => store.begin(OWNER, { sessionId: SESSION, kind: 'file', filename: 'total.txt', size: 7 }), error => error.code === 'attachment_total');
  clock += 51;
  assert.throws(() => store.chunk(OWNER, { id: short.id, offset: 0, dataBase64: base64('123456') }), error => error.code === 'attachment_missing');
});

test('bridge sends verified Wisp content blocks, consumes after acceptance, and keeps idempotent retry safe', async () => {
  const store = createAttachmentStore();
  const attachment = addText(store);
  let sent;
  const session = { id: SESSION, origin: 'desktop', title: 'Synthetic' };
  const done = new TextEncoder().encode('event: done\ndata: {"outcome":"completed"}\n\n');
  const client = { version: async () => '0.1.3', async request(path, options = {}) {
    if (path === '/v1/sessions?origin=desktop') return [session];
    if (path === '/api/runs') return [];
    if (path === '/api/models') return { data: [] };
    if (path === '/api/sandbox') return { enabled: true, allowNetwork: false };
    if (path === '/api/billing/me') return {};
    if (path === `/api/sessions/${SESSION}/stream`) { sent = options.body; return new Response(new ReadableStream({ start(controller) { controller.enqueue(done); controller.close(); } })); }
    if (path === `/v1/sessions/${SESSION}`) return { ...session, messages: [] };
    if (path === `/v1/sessions/${SESSION}/history`) return [{ values: { messages: [] } }];
    if (path.endsWith('/confirmations')) return { confirmations: [] };
    throw new Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, attachmentStore: store, projects: { roots: async () => [], settings: async () => ({}), setSettings: async () => {} } });
  await bridge.bootstrap();
  const message = { id: randomUUID(), text: 'question', attachments: [attachment.id] };
  assert.equal((await bridge.send(SESSION, message, OWNER)).accepted, true);
  assert.deepEqual(sent.input.messages[0].content, [
    { type: 'text', text: 'question' },
    { type: 'file', filename: 'fixture.txt', content: 'synthetic text' },
  ]);
  assert.throws(() => store.resolve(OWNER, [attachment.id], SESSION), error => error.code === 'attachment_missing');
  assert.equal((await bridge.send(SESSION, message, OWNER)).accepted, true);
});

test('delivery_unknown preserves a committed draft for exact retry without redispatch', async () => {
  const store = createAttachmentStore(); const attachment = addText(store); let posts = 0;
  const session = { id: SESSION, origin: 'desktop', title: 'Synthetic' };
  const client = { version: async () => '0.1.3', async request(path, options = {}) {
    if (path === '/v1/sessions?origin=desktop') return [session];
    if (path === '/api/runs') return [];
    if (path === '/api/models') return { data: [] };
    if (path === '/api/sandbox') return { enabled: true, allowNetwork: false };
    if (path === '/api/billing/me') return {};
    if (path.endsWith('/stream') && options.method === 'POST') { posts++; throw new BridgeError(503, 'delivery_unknown', 'unknown'); }
    if (path.includes('/messages/')) return { status: 'unknown' };
    throw new Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, attachmentStore: store, projects: { roots: async () => [], settings: async () => ({}), setSettings: async () => {} } });
  await bridge.bootstrap();
  const message = { id: randomUUID(), text: '', attachments: [attachment.id] };
  await assert.rejects(bridge.send(SESSION, message, OWNER), error => error.code === 'delivery_unknown');
  assert.equal(store.resolve(OWNER, [attachment.id], SESSION)[0].content, 'synthetic text');
  await assert.rejects(bridge.send(SESSION, message, OWNER), error => error.code === 'delivery_unknown');
  assert.equal(posts, 1);
});

test('message idempotency records are scoped to the authenticated owner', async () => {
  let posts = 0;
  const session = { id: SESSION, origin: 'desktop', title: 'Synthetic' };
  const client = { version: async () => '0.1.3', async request(path, options = {}) {
    if (path === '/v1/sessions?origin=desktop') return [session];
    if (path === '/api/runs') return [];
    if (path === '/api/models') return { data: [] };
    if (path === '/api/sandbox') return { enabled: true, allowNetwork: false };
    if (path === '/api/billing/me') return {};
    if (path.endsWith('/stream') && options.method === 'POST') {
      posts++;
      return new Response(new ReadableStream({ start(controller) { controller.close(); } }));
    }
    if (path === `/v1/sessions/${SESSION}`) return { ...session, messages: [] };
    if (path === `/v1/sessions/${SESSION}/history`) return [{ values: { messages: [] } }];
    if (path.endsWith('/confirmations')) return { confirmations: [] };
    throw new Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, projects: { roots: async () => [], settings: async () => ({}), setSettings: async () => {} } });
  await bridge.bootstrap();
  const message = { id: randomUUID(), text: 'same synthetic id' };
  await bridge.send(SESSION, message, 'peer:a');
  await bridge.send(SESSION, message, 'peer:a');
  await bridge.send(SESSION, message, 'peer:b');
  assert.equal(posts, 2);
});

test('normalized history exposes attachment labels without returning file text or image data URLs', () => {
  const content = [
    { type: 'text', text: 'caption' },
    { type: 'file', filename: 'secret-shaped-fixture.txt', content: 'must stay hidden' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' }, mimeType: 'image/jpeg', width: 1, height: 1 },
  ];
  const result = normalizeMessages([{ role: 'human', id: 'm', content }]);
  assert.equal(result[0].text, 'caption');
  assert.deepEqual(result[0].attachments.map(value => value.filename), ['secret-shaped-fixture.txt', 'Image']);
  assert.doesNotMatch(JSON.stringify(result), /must stay hidden|base64/);
});

test('HTTP attachment routes use the fixed owner and strict request fields', async t => {
  const calls = [];
  const bridge = {
    attachmentBegin(owner, value) { calls.push({ action: 'begin', owner, value }); return { id: randomUUID() }; },
    attachmentChunk(owner, value) { calls.push({ action: 'chunk', owner, value }); return { offset: 1 }; },
    attachmentCommit(owner, value) { calls.push({ action: 'commit', owner, value }); return { id: value.id }; },
    attachmentRemove(owner, value) { calls.push({ action: 'remove', owner, value }); return { ok: true }; },
  };
  const server = createMobileServer({ bridgeCapability, bridge });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const post = (path, value) => new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'X-Wisp-Bridge-Capability': bridgeCapability, Host: '127.0.0.1:4191', Origin: 'http://127.0.0.1:4191', 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
  assert.equal(await post('/bridge/attachments/begin', { sessionId: SESSION, kind: 'file', filename: 'x.txt', size: 1 }), 201);
  assert.equal(await post('/bridge/attachments/chunk', { id: randomUUID(), offset: 0, dataBase64: 'eA==', extra: true }), 400);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, 'http-current-owner');
});
