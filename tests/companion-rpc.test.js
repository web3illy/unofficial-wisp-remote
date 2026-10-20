import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dispatchCompanion } from '../src/companion-rpc.js';

test('RPC only accepts finite product routes, schemas and trusted transport owner', async () => {
  const calls = [];
  const bridge = { bootstrap: async () => ({ connection: { state: 'connected' } }), attachmentBegin: async (...args) => { calls.push(args); return {}; } };
  const base = { v: 1, op: 'request', method: 'GET', path: '/bridge/bootstrap' };
  assert.equal((await dispatchCompanion(bridge, base, 'peer')).status, 200);
  for (const path of ['/api/models', 'http://localhost:3008/api/models', '/bridge/../api/models', '/bridge/%62ootstrap', '/bridge/bootstrap?token=x']) await assert.rejects(dispatchCompanion(bridge, { ...base, path }, 'peer'));
  await assert.rejects(dispatchCompanion(bridge, { ...base, headers: { Authorization: 'forbidden' } }, 'peer'));
  await assert.rejects(dispatchCompanion(bridge, { ...base, body: {} }, 'peer'));
  await dispatchCompanion(bridge, { ...base, method: 'POST', path: '/bridge/attachments/begin', body: { filename: 'fixture.txt' } }, 'crypto-peer');
  assert.equal(calls[0][0], 'crypto-peer');
});
test('message validation permits attachments without text, never raw native fields', async () => {
  const session = randomUUID(), id = randomUUID(), attachment = randomUUID(); let sent;
  const bridge = { send: async (...args) => { sent = args; return { accepted: true }; } };
  const packet = { v: 1, op: 'request', method: 'POST', path: `/bridge/sessions/${session}/messages`, body: { id, text: '', attachments: [attachment] } };
  assert.equal((await dispatchCompanion(bridge, packet, 'peer')).status, 202); assert.equal(sent[2], 'peer');
  for (const body of [{ id, text: '' }, { id, text: 'x', content: [{ type: 'image_url' }] }, { id, text: 'x', attachments: ['/etc/passwd'] }, { id, text: 'x', mode: 'model' }]) await assert.rejects(dispatchCompanion(bridge, { ...packet, body }, 'peer'));
});

test('project removal RPC accepts only the exact bounded confirmed snapshot', async () => {
  const projectId = randomUUID(), first = randomUUID(), second = randomUUID(); let received;
  const bridge = { removeProject: async (...args) => { received = args; return { removedSessionIds: [first, second], complete: true }; } };
  const packet = {
    v: 1, op: 'request', method: 'POST', path: `/bridge/projects/${projectId}/remove`,
    body: { sessionIds: [first, second], activeSessionId: second },
  };
  assert.deepEqual(await dispatchCompanion(bridge, packet, 'peer'), {
    status: 200, body: { removedSessionIds: [first, second], complete: true },
  });
  assert.deepEqual(received, [projectId, packet.body]);

  for (const body of [
    undefined, {}, { sessionIds: [first, second] }, { sessionIds: [first, first], activeSessionId: first },
    { sessionIds: [first], activeSessionId: 'not-a-uuid' }, { sessionIds: [first], activeSessionId: null, path: '/forbidden' },
    { sessionIds: Array.from({ length: 751 }, () => randomUUID()), activeSessionId: null },
  ]) await assert.rejects(dispatchCompanion(bridge, { ...packet, body }, 'peer'), error => error.code === 'invalid_request');
  await assert.rejects(dispatchCompanion(bridge, { ...packet, method: 'GET', body: undefined }, 'peer'), error => error.code === 'not_found');
  await assert.rejects(dispatchCompanion(bridge, { ...packet, path: '/bridge/projects/not-a-uuid/remove' }, 'peer'), error => error.code === 'not_found');
});

test('single chat removal RPC accepts only POST with an exact empty body', async () => {
  const sessionId = randomUUID(); let received;
  const bridge = { removeSession: async (...args) => { received = args; return { removedSessionId: sessionId }; } };
  const packet = { v: 1, op: 'request', method: 'POST', path: `/bridge/sessions/${sessionId}/remove`, body: {} };

  assert.deepEqual(await dispatchCompanion(bridge, packet, 'peer'), {
    status: 200, body: { removedSessionId: sessionId },
  });
  assert.deepEqual(received, [sessionId, {}]);
  for (const body of [undefined, null, { retry: true }]) {
    await assert.rejects(dispatchCompanion(bridge, { ...packet, body }, 'peer'), error => error.code === 'invalid_request');
  }
  await assert.rejects(dispatchCompanion(bridge, { ...packet, method: 'GET', body: undefined }, 'peer'), error => error.code === 'not_found');
  await assert.rejects(dispatchCompanion(bridge, { ...packet, path: '/bridge/sessions/not-a-uuid/remove' }, 'peer'), error => error.code === 'not_found');
  await assert.rejects(dispatchCompanion(bridge, { ...packet, path: `/bridge/sessions/${sessionId}/remove/extra` }, 'peer'), error => error.code === 'not_found');
});

test('profile and selected-chat connector RPCs accept only their finite methods and schemas', async () => {
  const session = randomUUID(), calls = [];
  const bridge = {
    profile: async () => ({ displayName: 'Fixture' }),
    getConnectors: async id => { calls.push(['get', id]); return { connectors: [], available: true }; },
    setConnector: async (id, body) => { calls.push(['set', id, body]); return { connectors: [], available: true }; },
  };
  const base = { v: 1, op: 'request', method: 'GET', path: '/bridge/profile' };
  assert.deepEqual((await dispatchCompanion(bridge, base, 'peer')).body, { displayName: 'Fixture' });
  assert.equal((await dispatchCompanion(bridge, { ...base, path: `/bridge/sessions/${session}/connectors` }, 'peer')).status, 200);
  const toggle = { ...base, method: 'POST', path: `/bridge/sessions/${session}/connectors`, body: { id: 'google-drive', enabled: false } };
  assert.equal((await dispatchCompanion(bridge, toggle, 'peer')).status, 200);
  assert.deepEqual(calls, [['get', session], ['set', session, { id: 'google-drive', enabled: false }]]);

  for (const body of [null, {}, { id: 'google-drive' }, { id: 'google-drive', enabled: 1 }, { id: '../drive', enabled: true }, { id: 'google-drive', enabled: true, auth: 'secret' }]) {
    await assert.rejects(dispatchCompanion(bridge, { ...toggle, body }, 'peer'), error => error.code === 'invalid_request');
  }
  await assert.rejects(dispatchCompanion(bridge, { ...toggle, method: 'PATCH' }, 'peer'), error => error.code === 'not_found');
  await assert.rejects(dispatchCompanion(bridge, { ...base, path: '/bridge/profile', body: {} }, 'peer'), error => error.code === 'invalid_request');
  await assert.rejects(dispatchCompanion(bridge, { ...base, path: '/bridge/sessions/not-a-uuid/connectors' }, 'peer'), error => error.code === 'not_found');
});

test('privacy RPC exposes only finite read and exact empty refresh operations', async () => {
  const calls = [];
  const response = { status: 'unavailable', measurements: {}, failedChecks: [] };
  const bridge = {
    privacy: async () => { calls.push('get'); return response; },
    refreshPrivacy: async () => { calls.push('refresh'); return response; },
  };
  const get = { v: 1, op: 'request', method: 'GET', path: '/bridge/privacy' };
  assert.deepEqual(await dispatchCompanion(bridge, get, 'peer'), { status: 200, body: response });
  assert.deepEqual(await dispatchCompanion(bridge, { ...get, method: 'POST', path: '/bridge/privacy/refresh', body: {} }, 'peer'), { status: 200, body: response });
  assert.deepEqual(calls, ['get', 'refresh']);
  await assert.rejects(dispatchCompanion(bridge, { ...get, body: {} }, 'peer'), error => error.code === 'invalid_request');
  await assert.rejects(dispatchCompanion(bridge, { ...get, method: 'POST', path: '/bridge/privacy/refresh' }, 'peer'), error => error.code === 'invalid_request');
  await assert.rejects(dispatchCompanion(bridge, { ...get, method: 'POST', path: '/bridge/privacy/refresh', body: { force: true } }, 'peer'), error => error.code === 'invalid_request');
  await assert.rejects(dispatchCompanion(bridge, { ...get, method: 'PATCH', path: '/bridge/privacy' }, 'peer'), error => error.code === 'not_found');
});

test('settings RPC admits only finite usage read and the exact sandbox toggle', async () => {
  const calls = [];
  const bridge = {
    sandbox: async () => ({ enabled: true, allowNetwork: false }),
    setSandbox: async body => { calls.push(['sandbox', body]); return 'enabled' in body
      ? { enabled: body.enabled, allowNetwork: false }
      : { enabled: true, allowNetwork: body.allowNetwork }; },
    usage: async () => ({ available: true, planName: 'Fixture' }),
  };
  const get = { v: 1, op: 'request', method: 'GET', path: '/bridge/sandbox' };
  assert.deepEqual((await dispatchCompanion(bridge, get, 'peer')).body, { enabled: true, allowNetwork: false });
  assert.deepEqual((await dispatchCompanion(bridge, { ...get, path: '/bridge/usage' }, 'peer')).body, { available: true, planName: 'Fixture' });
  assert.deepEqual((await dispatchCompanion(bridge, { ...get, method: 'POST', body: { enabled: false } }, 'peer')).body, { enabled: false, allowNetwork: false });
  assert.deepEqual((await dispatchCompanion(bridge, { ...get, method: 'POST', body: { allowNetwork: true } }, 'peer')).body, { enabled: true, allowNetwork: true });
  assert.deepEqual(calls, [['sandbox', { enabled: false }], ['sandbox', { allowNetwork: true }]]);

  for (const body of [undefined, {}, { enabled: 0 }, { allowNetwork: 'yes' }, { enabled: true, allowNetwork: true }, { unknown: true }]) {
    await assert.rejects(dispatchCompanion(bridge, { ...get, method: 'POST', body }, 'peer'), error => error.code === 'invalid_request');
  }
  for (const path of ['/bridge/account', '/bridge/payments', '/bridge/permissions', `/bridge/projects/${randomUUID()}/permissions`, '/bridge/usage/extra']) {
    await assert.rejects(dispatchCompanion(bridge, { ...get, path }, 'peer'), error => error.code === 'not_found');
  }
  await assert.rejects(dispatchCompanion(bridge, { ...get, method: 'POST', path: '/bridge/usage', body: {} }, 'peer'), error => error.code === 'not_found');
});
