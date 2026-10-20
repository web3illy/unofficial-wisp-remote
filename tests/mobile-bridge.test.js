import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createWispClient, BridgeError, readSse } from '../src/wisp-client.js';
import { createProjectStore, modelPreference, normalizeMessages } from '../src/mobile-store.js';
import { createBridge } from '../src/mobile-bridge.js';
import { createMobileServer } from '../src/mobile-server.js';

const bridgeCapability = 'ab'.repeat(32);

test('backend session creation stays projectless unless an explicit project is supplied', async () => {
  const projectId = randomUUID(), projectRoot = '/synthetic/explicit-project';
  const nativeCreates = [];
  const bridge = createBridge({
    client: { async request(path, options) {
      assert.equal(path, '/v1/sessions');
      assert.equal(options.method, 'POST');
      nativeCreates.push(options.body);
      return { id: randomUUID(), ...options.body, projectId: options.body.projectRoot ? projectId : null };
    } },
    projects: { roots: async () => [{ id: projectId, name: 'Explicit', path: projectRoot }],
      create: async () => assert.fail('Starting a chat must not create a project') },
  });
  const projectless = await bridge.createSession({});
  const scoped = await bridge.createSession({ projectId });
  assert.equal(nativeCreates.length, 2);
  assert.equal(Object.hasOwn(nativeCreates[0], 'projectRoot'), false);
  assert.equal(nativeCreates[0].origin, 'desktop');
  assert.equal(nativeCreates[0].title, 'New Chat');
  assert.equal(projectless.session.projectId, null);
  assert.equal(nativeCreates[1].projectRoot, projectRoot);
  assert.equal(scoped.session.projectId, projectId);
});

test('discovery refuses non-loopback and unsafe credential files without transporting secrets', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wisp-client-test-')); t.after(() => rm(home, { recursive: true, force: true }));
  const lock = { url: 'http://127.0.0.1:3008', token: 'synthetic-fixture-'.repeat(3), pid: process.pid, version: '0.1.3', kind: 'desktop' };
  const calls = [];
  const client = createWispClient({ home, transport: async (url, options) => { calls.push({ url, options }); return new Response('{"ok":true}'); } });
  await writeFile(join(home, 'runtime.lock'), JSON.stringify(lock), { mode: 0o600 });
  assert.deepEqual(await client.request('/v1/health'), { ok: true });
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${lock.token}`);
  assert.equal(calls[0].options.redirect, 'error');
  for (const url of ['https://evil.invalid', 'http://127.0.0.1.evil.invalid', 'http://user:pass@localhost:3008', 'http://127.0.0.1:3008/path']) {
    await writeFile(join(home, 'runtime.lock'), JSON.stringify({ ...lock, url }));
    await assert.rejects(client.request('/v1/health'), e => e.code === 'wisp_offline' && !e.message.includes(lock.token));
  }
  assert.equal(calls.length, 1);
  await writeFile(join(home, 'runtime.lock'), JSON.stringify(lock)); await chmod(join(home, 'runtime.lock'), 0o644);
  await assert.rejects(client.request('/v1/health'), e => e.code === 'wisp_offline');
});

test('stream parser handles arbitrary chunk boundaries and ignores heartbeat', async () => {
  const encoded = new TextEncoder().encode(': ping\n\nevent: messages\nid: 7\ndata: [{"content":"Привет"}]\n\nevent: done\ndata: {"outcome":"completed"}\n\n');
  const response = new Response(new ReadableStream({ start(c) { for (let i = 0; i < encoded.length; i += 3) c.enqueue(encoded.slice(i, i + 3)); c.close(); } }));
  const result = []; for await (const e of readSse(response)) result.push(e);
  assert.equal(result[0].data[0].content, 'Привет'); assert.equal(result[0].id, '7'); assert.equal(result[1].event, 'done');
});

test('native transcript grouping preserves text, tools and plain markup safely', () => {
  const result = normalizeMessages([
    { role: 'human', id: 'u', content: '[{"type":"text","text":"<img onerror=bad>"}]' },
    { role: 'ai', id: 'a', content: '', toolCalls: [{ id: 't', name: 'fs_read', args: { path: 'seed.txt' } }] },
    { role: 'tool', toolCallId: 't', content: 'synthetic file', status: 'success' },
    { role: 'ai', content: 'Answer' },
  ]);
  assert.equal(result.length, 2); assert.equal(result[0].text, '<img onerror=bad>'); assert.equal(result[1].text, 'Answer');
  assert.equal(result[1].activities[0].text, 'synthetic file');
});

test('Desktop exact model preference encodings', () => {
  assert.equal(modelPreference({ mode: 'auto', thinking: false }), undefined);
  assert.equal(modelPreference({ mode: 'auto', thinking: true }), 'tier:thinking');
  assert.equal(modelPreference({ mode: 'balanced', thinking: true }), 'tier:thinking:balanced');
  assert.equal(modelPreference({ mode: 'balanced', thinking: false }), 'tier:balanced');
  assert.equal(modelPreference({ mode: 'model', modelId: 'fixture', thinking: true }), 'tier:thinking:fixture');
});

test('native registry is the sole project membership source and legacy roots remain preserved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wisp-project-membership-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, 'picked.json'), stateFile = join(root, 'state.json');
  const nativePath = join(root, 'Native'), stalePath = join(root, 'Stale');
  const nativeId = randomUUID(), staleId = randomUUID();
  for (const [path, id] of [[nativePath, nativeId], [stalePath, staleId]]) {
    await mkdir(join(path, '.wisp'), { recursive: true });
    await writeFile(join(path, '.wisp/project-id'), `${id}\n${path}\n`);
  }
  const legacy = { roots: [stalePath], settings: { fixture: { mode: 'balanced', thinking: false } }, preferredSession: null };
  await writeFile(registry, JSON.stringify([nativePath]));
  await writeFile(stateFile, JSON.stringify(legacy));

  const store = createProjectStore({ registry, stateFile, managed: join(root, 'projects') });
  assert.deepEqual((await store.roots()).map(({ id, name }) => ({ id, name })), [{ id: nativeId, name: 'Native' }]);
  await store.setSettings('new-session', { mode: 'auto', thinking: true });
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).roots, [stalePath]);
});

test('managed project creation registers Desktop before Runtime and survives a fresh store', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wisp-project-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, 'picked.json'), stateFile = join(root, 'state.json'), managed = join(root, 'projects');
  await writeFile(registry, JSON.stringify(['/existing/native/project']));
  const store = createProjectStore({ registry, stateFile, managed }); const id = randomUUID(); let registeredBeforeAnchor = false;
  const anchor = async path => {
    registeredBeforeAnchor = JSON.parse(await readFile(registry, 'utf8')).includes(path);
    await mkdir(join(path, '.wisp')); await writeFile(join(path, '.wisp/project-id'), `${id}\n${path}\n`);
    return { id: randomUUID(), projectId: id };
  };
  await assert.rejects(store.create('../escape', anchor));
  const result = await store.create('Mobile', anchor);
  assert.equal(registeredBeforeAnchor, true);
  assert.equal(result.project.desktopRegistered, true);
  assert.deepEqual(JSON.parse(await readFile(registry, 'utf8')), ['/existing/native/project', result.project.path]);
  assert.deepEqual(JSON.parse(await readFile(`${registry}.wisp-remote-backup`, 'utf8')), ['/existing/native/project']);
  await store.setSettings('fixture', { mode: 'balanced', thinking: false });
  const fresh = createProjectStore({ registry, stateFile, managed });
  assert.equal((await fresh.roots())[0].id, id);
  assert.equal((await fresh.settings('fixture')).mode, 'balanced');
  const freshClient = { version: async () => '0.1.3', async request(path) {
    if (path === '/v1/sessions?origin=desktop') return [{ ...result.session, origin: 'desktop', projectId: id }];
    if (path === '/api/runs') return [];
    if (path === '/api/models') return { data: [] };
    if (path === '/api/sandbox') return { enabled: true, allowNetwork: false };
    if (path === '/api/billing/me') return {};
    throw Error(`unexpected ${path}`);
  } };
  const restored = await createBridge({ client: freshClient, projects: fresh }).bootstrap();
  assert.equal(restored.projects[0].id, id);
  assert.equal(restored.sessions[0].id, result.session.id);
});

test('Desktop registration failure is safe and creates no orphan Runtime session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wisp-project-registration-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, 'picked.json'), managed = join(root, 'projects');
  await writeFile(registry, '{invalid json');
  let sessionPosts = 0;
  const client = { async request(path) { if (path === '/v1/sessions') sessionPosts++; throw Error(`unexpected ${path}`); } };
  const bridge = createBridge({ client, projects: createProjectStore({ registry, stateFile: join(root, 'state.json'), managed }) });

  await assert.rejects(bridge.createProject({ name: 'Preserved' }), error =>
    error instanceof BridgeError && error.status === 503 && error.code === 'desktop_registration_failed');
  assert.equal(sessionPosts, 0);
  assert.equal((await readFile(registry, 'utf8')), '{invalid json');
  assert.equal((await stat(join(managed, 'Preserved'))).isDirectory(), true);
});

test('committed project creation does not depend on obsolete legacy state writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wisp-project-state-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, 'picked.json'), stateFile = join(root, 'state-directory'), managed = join(root, 'projects');
  await writeFile(registry, '[]');
  await mkdir(stateFile);
  const projectId = randomUUID(), sessionId = randomUUID(); let anchors = 0;
  const store = createProjectStore({ registry, stateFile, managed });
  const created = await store.create('Independent', async path => {
    anchors++;
    await mkdir(join(path, '.wisp'));
    await writeFile(join(path, '.wisp/project-id'), `${projectId}\n${path}\n`);
    return { id: sessionId, projectId };
  });

  assert.equal(anchors, 1);
  assert.equal(created.session.id, sessionId);
  assert.equal(created.project.id, projectId);
  assert.deepEqual(JSON.parse(await readFile(registry, 'utf8')), [created.project.path]);
});

test('global Desktop session response alone determines chat membership and root hints', async () => {
  const rootId = randomUUID(), looseId = randomUUID(), knownId = randomUUID(), unknownId = randomUUID(), cliId = randomUUID();
  const root = { id: rootId, name: 'Known', path: '/synthetic/known' };
  const global = [
    { id: looseId, origin: 'desktop', projectId: null, title: 'Loose', updatedAt: '2026-10-16T10:00:00Z' },
    { id: knownId, origin: 'desktop', projectId: rootId, deskPath: '/private/native/artifact', title: 'Known', updatedAt: '2026-10-16T11:00:00Z' },
    { id: unknownId, origin: 'desktop', projectId: randomUUID(), projectRoot: '/untrusted/from-runtime', title: 'Unknown', updatedAt: '2026-10-16T12:00:00Z' },
    { id: cliId, origin: 'cli', projectId: null, title: 'CLI', updatedAt: '2026-10-16T13:00:00Z' },
  ];
  const calls = [];
  const client = { version: async () => '0.1.3', async request(path) {
    calls.push(path);
    if (path === '/v1/sessions?origin=desktop') return global;
    if (path === '/api/runs') return [];
    if (path === '/api/models') return { data: [] };
    if (path === '/api/sandbox') return { enabled: true, allowNetwork: false };
    if (path === '/api/billing/me') return {};
    if (path === `/v1/sessions/${knownId}?projectRoot=%2Fsynthetic%2Fknown`) return global[1];
    if (path === `/v1/sessions/${knownId}/history?projectRoot=%2Fsynthetic%2Fknown`) return [{ values: { messages: [] } }];
    if (path === `/api/sessions/${knownId}/confirmations`) return { confirmations: [] };
    if (path === `/v1/sessions/${unknownId}`) return global[2];
    if (path === `/v1/sessions/${unknownId}/history`) return [{ values: { messages: [] } }];
    if (path === `/api/sessions/${unknownId}/confirmations`) return { confirmations: [] };
    throw Error(`unexpected ${path}`);
  } };
  const projects = { roots: async () => [root], settings: async () => ({}), setSettings: async () => {} };
  const bridge = createBridge({ client, projects });

  const bootstrap = await bridge.bootstrap();
  assert.deepEqual(bootstrap.sessions.map(session => session.id), [unknownId, knownId, looseId]);
  assert.equal(bootstrap.capabilities.sessionRemoval, true);
  assert.equal(bootstrap.sessions.find(session => session.id === knownId).hasArtifacts, true);
  assert.equal(bootstrap.sessions.find(session => session.id === looseId).hasArtifacts, false);
  assert.equal(Object.hasOwn(bootstrap.sessions.find(session => session.id === knownId), 'deskPath'), false);
  assert.equal(calls.filter(path => path.startsWith('/v1/sessions?')).length, 1);
  await bridge.getView(knownId);
  await bridge.getView(unknownId);
  assert(calls.includes(`/v1/sessions/${knownId}?projectRoot=%2Fsynthetic%2Fknown`));
  assert(calls.includes(`/v1/sessions/${unknownId}`));
  assert(calls.includes(`/v1/sessions/${unknownId}/history`));
  assert.equal(calls.some(path => path.startsWith(`/v1/sessions/${unknownId}`) && path.includes('projectRoot=')), false);
  await assert.rejects(bridge.send(unknownId, { id: randomUUID(), text: 'must not use a fallback' }), error =>
    error instanceof BridgeError && error.code === 'project_unavailable');
});

test('project removal validates a fresh exact membership, retries busy deletes and removes the active chat last', async () => {
  const projectId = randomUUID(), inactiveId = randomUUID(), activeId = randomUUID();
  const root = { id: projectId, name: 'Synthetic', path: '/synthetic/project' };
  let global = [
    { id: inactiveId, origin: 'desktop', projectId, title: 'Inactive' },
    { id: activeId, origin: 'desktop', projectId, title: 'Active' },
  ];
  const calls = [], delays = []; let inactiveDeletes = 0;
  const client = { async request(path, options = {}) {
    calls.push({ path, options });
    if (path === '/v1/sessions?origin=desktop') return global.map(item => ({ ...item }));
    if (path === '/api/runs') return [{ sessionId: activeId, runId: 'synthetic-run', status: 'running' }];
    if (path.endsWith('/cancel?projectRoot=%2Fsynthetic%2Fproject')) return null;
    if (options.method === 'DELETE' && path.startsWith(`/v1/sessions/${inactiveId}`)) {
      if (inactiveDeletes++ === 0) throw new BridgeError(409, 'busy', 'busy');
      global = global.filter(item => item.id !== inactiveId);
      return null;
    }
    if (options.method === 'DELETE' && path.startsWith(`/v1/sessions/${activeId}`)) {
      global = global.filter(item => item.id !== activeId);
      throw new BridgeError(404, 'wisp_request_failed', 'absent');
    }
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, projects: { roots: async () => [root] }, sleep: async ms => delays.push(ms) });
  const result = await bridge.removeProject(projectId, { sessionIds: [activeId, inactiveId], activeSessionId: activeId });

  assert.deepEqual(result, { removedSessionIds: [activeId, inactiveId], complete: true });
  assert.deepEqual(delays, [200]);
  assert.deepEqual(calls.filter(call => call.options.method === 'POST').map(call => call.path), [
    `/v1/sessions/${inactiveId}/cancel?projectRoot=%2Fsynthetic%2Fproject`,
    `/v1/sessions/${activeId}/cancel?projectRoot=%2Fsynthetic%2Fproject`,
  ]);
  assert.deepEqual(calls.filter(call => call.options.method === 'DELETE').map(call => call.path), [
    `/v1/sessions/${inactiveId}?projectRoot=%2Fsynthetic%2Fproject`,
    `/v1/sessions/${inactiveId}?projectRoot=%2Fsynthetic%2Fproject`,
    `/v1/sessions/${activeId}?projectRoot=%2Fsynthetic%2Fproject`,
  ]);
});

test('pathless original project groups remove their exact fresh Desktop membership without inventing a root hint', async () => {
  const projectId = randomUUID(), sessionId = randomUUID();
  let global = [{ id: sessionId, origin: 'desktop', projectId }];
  const mutations = [];
  const client = { async request(path, options = {}) {
    if (path === '/v1/sessions?origin=desktop') return global.map(item => ({ ...item }));
    if (path === '/api/runs') return [];
    if (options.method === 'POST' || options.method === 'DELETE') mutations.push({ path, method: options.method });
    if (options.method === 'POST') return null;
    if (options.method === 'DELETE') { global = []; return null; }
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, projects: { roots: async () => [] } });

  assert.deepEqual(await bridge.removeProject(projectId, { sessionIds: [sessionId], activeSessionId: sessionId }), {
    removedSessionIds: [sessionId], complete: true,
  });
  assert.deepEqual(mutations, [
    { path: `/v1/sessions/${sessionId}/cancel`, method: 'POST' },
    { path: `/v1/sessions/${sessionId}`, method: 'DELETE' },
  ]);
});

test('single chat removal uses fresh Desktop membership, trusted root hints and bounded original retries', async () => {
  const projectId = randomUUID(), sessionId = randomUUID();
  let global = [{ id: sessionId, origin: 'desktop', projectId, deskPath: '/private/native/artifact' }];
  const calls = [], delays = []; let deletes = 0;
  const client = { async request(path, options = {}) {
    calls.push({ path, options });
    if (path === '/v1/sessions?origin=desktop') return global.map(item => ({ ...item }));
    if (path === '/api/runs') return [];
    if (options.method === 'POST') throw new BridgeError(503, 'cancel_failed', 'private cancel detail');
    if (options.method === 'DELETE') {
      deletes++;
      if (deletes === 1) throw new BridgeError(409, 'busy', 'private busy detail');
      global = [];
      return null;
    }
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({
    client, projects: { roots: async () => [{ id: projectId, name: 'Synthetic', path: '/synthetic/project' }] },
    sleep: async ms => delays.push(ms),
  });

  assert.deepEqual(await bridge.removeSession(sessionId, {}), { removedSessionId: sessionId });
  assert.deepEqual(delays, [200]);
  assert.deepEqual(calls.filter(call => call.options.method === 'POST').map(call => call.path), [
    `/v1/sessions/${sessionId}/cancel?projectRoot=%2Fsynthetic%2Fproject`,
  ]);
  assert.deepEqual(calls.filter(call => call.options.method === 'DELETE').map(call => call.path), [
    `/v1/sessions/${sessionId}?projectRoot=%2Fsynthetic%2Fproject`,
    `/v1/sessions/${sessionId}?projectRoot=%2Fsynthetic%2Fproject`,
  ]);
  assert.equal(calls.filter(call => call.path === '/v1/sessions?origin=desktop').length, 2);
});

test('single chat removal rejects invalid and non-Desktop targets before mutation', async () => {
  const desktopId = randomUUID(), cliId = randomUUID(); let writes = 0;
  const client = { async request(path, options = {}) {
    if (options.method) writes++;
    if (path === '/v1/sessions?origin=desktop') return [{ id: cliId, origin: 'cli', projectId: null }];
    if (path === '/api/runs') return [];
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, projects: { roots: async () => [] } });

  for (const body of [null, [], 'invalid', 1, { extra: true }]) {
    assert.throws(() => bridge.removeSession(desktopId, body), error => error.code === 'invalid_session_removal');
  }
  await assert.rejects(bridge.removeSession(cliId, {}), error => error.code === 'session_missing' && error.status === 404);
  assert.equal(writes, 0);

  const projectId = randomUUID(), pathlessId = randomUUID();
  let pathlessGlobal = [{ id: pathlessId, origin: 'desktop', projectId }];
  const pathlessWrites = [];
  const pathless = createBridge({
    client: { async request(path, options = {}) {
      if (path === '/v1/sessions?origin=desktop') return pathlessGlobal.map(item => ({ ...item }));
      if (path === '/api/runs') return [];
      if (options.method === 'POST') { pathlessWrites.push(path); return null; }
      if (options.method === 'DELETE') { pathlessWrites.push(path); pathlessGlobal = []; return null; }
      throw Error(`unexpected ${path}`);
    } },
    projects: { roots: async () => [] },
  });
  assert.deepEqual(await pathless.removeSession(pathlessId, {}), { removedSessionId: pathlessId });
  assert.deepEqual(pathlessWrites, [`/v1/sessions/${pathlessId}/cancel`, `/v1/sessions/${pathlessId}`]);

  for (const roots of [
    [{ id: projectId, name: 'Malformed', path: 'relative/path' }],
    [{ id: projectId, name: 'One', path: '/synthetic/one' }, { id: projectId, name: 'Two', path: '/synthetic/two' }],
  ]) {
    let rootWrites = 0;
    const guarded = createBridge({
      client: { async request(path, options = {}) {
        if (options.method) rootWrites++;
        if (path === '/v1/sessions?origin=desktop') return [{ id: pathlessId, origin: 'desktop', projectId }];
        if (path === '/api/runs') return [];
        throw Error(`unexpected ${path}`);
      } },
      projects: { roots: async () => roots },
    });
    await assert.rejects(guarded.removeSession(pathlessId, {}), error => error.code === 'session_removal_unknown');
    assert.equal(rootWrites, 0);
  }
});

test('single chat removal reports safe uncertainty and never replays an unknown delete outcome', async () => {
  const sessionId = randomUUID(); let deletes = 0, snapshots = 0;
  const client = { async request(path, options = {}) {
    if (path === '/v1/sessions?origin=desktop') { snapshots++; return [{ id: sessionId, origin: 'desktop', projectId: null }]; }
    if (path === '/api/runs') return [];
    if (options.method === 'POST') return null;
    if (options.method === 'DELETE') { deletes++; throw new BridgeError(503, 'private_failure', 'token=must-not-escape'); }
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, projects: { roots: async () => [] } });

  await assert.rejects(bridge.removeSession(sessionId, {}), error =>
    error.code === 'session_removal_unknown' && error.status === 409 && !error.message.includes('token='));
  assert.equal(deletes, 1);
  assert.equal(snapshots, 2);
});

test('single chat and project removals share one destructive-operation queue', async () => {
  const projectId = randomUUID(), projectSessionId = randomUUID(), sessionId = randomUUID();
  let global = [
    { id: projectSessionId, origin: 'desktop', projectId },
    { id: sessionId, origin: 'desktop', projectId: null },
  ];
  const mutations = [];
  let releaseProjectDelete;
  const projectDeleteGate = new Promise(resolve => { releaseProjectDelete = resolve; });
  const client = { async request(path, options = {}) {
    if (path === '/v1/sessions?origin=desktop') return global.map(item => ({ ...item }));
    if (path === '/api/runs') return [];
    if (options.method === 'POST') { mutations.push(path); return null; }
    if (options.method === 'DELETE') {
      mutations.push(path);
      const id = path.split('/')[3].split('?')[0];
      if (id === projectSessionId) await projectDeleteGate;
      global = global.filter(item => item.id !== id);
      return null;
    }
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({
    client, projects: { roots: async () => [{ id: projectId, name: 'Synthetic', path: '/synthetic/project' }] },
  });

  const projectRemoval = bridge.removeProject(projectId, { sessionIds: [projectSessionId], activeSessionId: projectSessionId });
  await new Promise(resolve => setImmediate(resolve));
  const sessionRemoval = bridge.removeSession(sessionId, {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutations.some(path => path.includes(sessionId)), false);
  releaseProjectDelete();
  assert.deepEqual(await projectRemoval, { removedSessionIds: [projectSessionId], complete: true });
  assert.deepEqual(await sessionRemoval, { removedSessionId: sessionId });
  assert.deepEqual(mutations.map(path => path.includes(projectSessionId) ? 'project' : 'session'), ['project', 'project', 'session', 'session']);
});

test('project removal rejects invalid, duplicate, out-of-project and stale snapshots before mutation', async () => {
  const projectId = randomUUID(), first = randomUUID(), second = randomUUID(), outside = randomUUID();
  const roots = [{ id: projectId, name: 'Synthetic', path: '/synthetic/project' }];
  const global = [
    { id: first, origin: 'desktop', projectId }, { id: second, origin: 'desktop', projectId },
    { id: outside, origin: 'desktop', projectId: randomUUID() },
  ];
  let mutations = 0;
  const client = { async request(path, options = {}) {
    if (options.method) mutations++;
    if (path === '/v1/sessions?origin=desktop') return global;
    if (path === '/api/runs') return [];
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, projects: { roots: async () => roots } });

  assert.throws(() => bridge.removeProject(projectId, { sessionIds: [first, first], activeSessionId: first }), error => error.code === 'invalid_project_removal');
  assert.throws(() => bridge.removeProject(projectId, { sessionIds: [first, second], activeSessionId: first, extra: true }), error => error.code === 'invalid_project_removal');
  await assert.rejects(bridge.removeProject(projectId, { sessionIds: [first, outside], activeSessionId: first }), error => error.code === 'project_snapshot_changed');
  await assert.rejects(bridge.removeProject(projectId, { sessionIds: [first], activeSessionId: first }), error => error.code === 'project_snapshot_changed');
  await assert.rejects(bridge.removeProject(projectId, { sessionIds: [first, second], activeSessionId: outside }), error => error.code === 'project_snapshot_changed');
  assert.equal(mutations, 0);
});

test('project removal returns a safe partial result after bounded busy retries and does not touch later chats', async () => {
  const projectId = randomUUID(), removed = randomUUID(), blocked = randomUUID(), untouched = randomUUID();
  let global = [removed, blocked, untouched].map(id => ({ id, origin: 'desktop', projectId }));
  const deletes = [], delays = [];
  const client = { async request(path, options = {}) {
    if (path === '/v1/sessions?origin=desktop') return global.map(item => ({ ...item }));
    if (path === '/api/runs') return [];
    if (options.method === 'POST' && path.includes('/cancel')) return null;
    if (options.method === 'DELETE') {
      const id = path.split('/')[3].split('?')[0]; deletes.push(id);
      if (id === removed) { global = global.filter(item => item.id !== id); return null; }
      if (id === blocked) throw new BridgeError(409, 'busy', 'busy');
      assert.fail('later chat must not be touched after an unresolved delete');
    }
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({
    client, projects: { roots: async () => [{ id: projectId, name: 'Synthetic', path: '/synthetic/project' }] },
    sleep: async ms => delays.push(ms),
  });
  const result = await bridge.removeProject(projectId, { sessionIds: [removed, blocked, untouched], activeSessionId: untouched });

  assert.deepEqual(result, { removedSessionIds: [removed], complete: false });
  assert.deepEqual(deletes, [removed, blocked, blocked, blocked, blocked, blocked]);
  assert.deepEqual(delays, [200, 400, 800, 1600]);
});

test('project removal never replays an unknown delete outcome', async () => {
  const projectId = randomUUID(), sessionId = randomUUID(); let deletes = 0;
  const global = [{ id: sessionId, origin: 'desktop', projectId }];
  const client = { async request(path, options = {}) {
    if (path === '/v1/sessions?origin=desktop') return global;
    if (path === '/api/runs') return [];
    if (options.method === 'POST') return null;
    if (options.method === 'DELETE') { deletes++; throw new BridgeError(503, 'wisp_offline', 'unknown'); }
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, projects: { roots: async () => [{ id: projectId, name: 'Synthetic', path: '/synthetic/project' }] } });
  assert.deepEqual(await bridge.removeProject(projectId, { sessionIds: [sessionId], activeSessionId: sessionId }), { removedSessionIds: [], complete: false });
  assert.equal(deletes, 1);
});

test('empty project removal is a verified no-op and reports complete', async () => {
  const projectId = randomUUID(); let writes = 0;
  const client = { async request(path, options = {}) {
    if (options.method) writes++;
    if (path === '/v1/sessions?origin=desktop') return [];
    if (path === '/api/runs') return [];
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, projects: { roots: async () => [{ id: projectId, name: 'Empty', path: '/synthetic/empty' }] } });
  assert.deepEqual(await bridge.removeProject(projectId, { sessionIds: [], activeSessionId: null }), { removedSessionIds: [], complete: true });
  assert.equal(writes, 0);
});

test('bootstrap coalesces and caches only slow metadata, retries failures and keeps session refresh current', async () => {
  let clock = 1_000, failModels = true;
  const calls = new Map();
  const count = path => calls.set(path, (calls.get(path) || 0) + 1);
  const client = { version: async () => '0.1.3', async request(path) {
    count(path);
    if (path === '/v1/sessions?origin=desktop') return [];
    if (path === '/api/runs') return [];
    if (path === '/api/models') { await new Promise(resolve => setImmediate(resolve)); if (failModels) throw Error('synthetic metadata failure'); return { data: [{ id: 'fixture' }] }; }
    if (path === '/api/sandbox') return { enabled: true, allowNetwork: false };
    if (path === '/api/billing/me') return { plan: { priceCents: 0 } };
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, projects: { roots: async () => [] }, metadataTtlMs: 60_000, now: () => clock });

  const failed = await Promise.allSettled([bridge.bootstrap(), bridge.bootstrap()]);
  assert(failed.every(result => result.status === 'rejected'));
  assert.equal(calls.get('/api/models'), 1);
  failModels = false;
  const [first, second] = await Promise.all([bridge.bootstrap(), bridge.bootstrap()]);
  assert.equal(first.models[0].id, 'fixture');
  assert.equal(second.capabilities.connectors, true);
  assert.equal(second.capabilities.projectRemoval, true);
  assert.equal(calls.get('/api/models'), 2);
  assert.equal(calls.get('/v1/sessions?origin=desktop'), 2);

  await bridge.bootstrap();
  assert.equal(calls.get('/api/models'), 2);
  assert.equal(calls.get('/v1/sessions?origin=desktop'), 3);
  clock += 60_001;
  await bridge.bootstrap();
  assert.equal(calls.get('/api/models'), 3);
  assert.equal(calls.get('/v1/sessions?origin=desktop'), 4);
});

test('profile is lazy, sanitized, TTL-cached and recovers without caching failures', async () => {
  let clock = 10, calls = 0, fail = false;
  const client = { async request(path) {
    assert.equal(path, '/v1/auth/status'); calls++;
    await new Promise(resolve => setImmediate(resolve));
    if (fail) throw Error('private native error with token=never-forward');
    return { user: { name: '  Alice\u0000\n\u202e Example  ', email: 'private@example.invalid', picture: 'private-data' }, token: 'private' };
  } };
  const bridge = createBridge({ client, profileTtlMs: 60_000, now: () => clock });
  const [one, two] = await Promise.all([bridge.profile(), bridge.profile()]);
  assert.deepEqual(one, { displayName: 'Alice Example' });
  assert.deepEqual(two, one);
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(one), ['displayName']);

  clock += 60_001; fail = true;
  await assert.rejects(bridge.profile(), error => error.code === 'profile_unavailable' && !error.message.includes('token'));
  assert.equal(calls, 2);
  fail = false;
  assert.deepEqual(await bridge.profile(), { displayName: 'Alice Example' });
  assert.equal(calls, 3);
});

test('profile exposes only bounded raster data URLs with matching file magic', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  const valid = `data:image/png;base64,${png.toString('base64')}`;
  let picture = valid;
  const bridge = createBridge({ client: { async request() { return { user: { name: 'Fixture', picture, image: valid, email: 'private@example.invalid' }, token: 'private' }; } }, profileTtlMs: 0 });
  assert.deepEqual(await bridge.profile(), { displayName: 'Fixture', avatarDataUrl: valid });

  for (const rejected of [
    'https://example.invalid/avatar.png',
    `data:image/jpeg;base64,${png.toString('base64')}`,
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    `data:image/png;base64,${Buffer.alloc(256 * 1024 + 1, 0x41).toString('base64')}`,
  ]) {
    picture = rejected;
    assert.deepEqual(await bridge.profile(), { displayName: 'Fixture' });
  }
  picture = undefined;
  assert.deepEqual(await bridge.profile(), { displayName: 'Fixture' });
});

test('sandbox reads are fresh and serialized enabled/network writes preserve the other field', async () => {
  let state = { enabled: false, allowNetwork: true };
  const calls = [];
  const client = { async request(path, options = {}) {
    assert.equal(path, '/api/sandbox');
    calls.push({ method: options.method || 'GET', body: options.body });
    if (options.method === 'POST') {
      const keys = Object.keys(options.body);
      assert.equal(keys.length, 1);
      assert(['enabled', 'allowNetwork'].includes(keys[0]));
      await new Promise(resolve => setImmediate(resolve));
      state = { ...state, [keys[0]]: options.body[keys[0]] };
    }
    return { ...state, private: 'never-forward' };
  } };
  const bridge = createBridge({ client });
  assert.deepEqual(await bridge.sandbox(), { enabled: false, allowNetwork: true });
  state.enabled = true;
  assert.deepEqual(await bridge.sandbox(), { enabled: true, allowNetwork: true });
  state.enabled = false;
  const [enabled, networkDisabled] = await Promise.all([
    bridge.setSandbox({ enabled: true }),
    bridge.setSandbox({ allowNetwork: false }),
  ]);
  assert.deepEqual(enabled, { enabled: true, allowNetwork: true });
  assert.deepEqual(networkDisabled, { enabled: true, allowNetwork: false });
  assert.deepEqual(calls.slice(2).map(call => call.method), ['GET', 'POST', 'GET', 'GET', 'POST', 'GET']);
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body), [{ enabled: true }, { allowNetwork: false }]);
  assert.deepEqual(await bridge.setSandbox({ enabled: false }), { enabled: false, allowNetwork: false });
  const posts = calls.filter(call => call.method === 'POST').length;
  await assert.rejects(bridge.setSandbox({ allowNetwork: true }), error => error.code === 'sandbox_disabled');
  assert.equal(calls.filter(call => call.method === 'POST').length, posts);
});

test('direct sandbox mutations reject empty, combined, unknown and non-boolean fields before native access', async () => {
  let calls = 0;
  const bridge = createBridge({ client: { async request() { calls++; throw Error('must not reach native'); } } });
  for (const value of [null, {}, { enabled: true, allowNetwork: false }, { unknown: true }, { enabled: 1 }, { allowNetwork: 'yes' }]) {
    assert.throws(() => bridge.setSandbox(value), error => error.code === 'invalid_sandbox');
  }
  assert.equal(calls, 0);
});

test('sandbox write failures and unverifiable results are explicit and never replayed', async () => {
  let posts = 0, state = { enabled: true, allowNetwork: false }, fail = 'post';
  const client = { async request(_path, options = {}) {
    if (options.method === 'POST') {
      posts++;
      const field = Object.keys(options.body)[0];
      state = { ...state, [field]: options.body[field] };
      if (fail === 'post') throw Error('private native error');
      return { ...state };
    }
    if (fail === 'readback' && posts) return { enabled: state.enabled, allowNetwork: true };
    return { ...state };
  } };
  const bridge = createBridge({ client });
  await assert.rejects(bridge.setSandbox({ allowNetwork: true }), error => error.code === 'sandbox_write_unknown' && !error.message.includes('private'));
  assert.equal(posts, 1);
  fail = 'readback'; posts = 0; state = { enabled: true, allowNetwork: false };
  await assert.rejects(bridge.setSandbox({ enabled: false }), error => error.code === 'sandbox_write_unknown');
  assert.equal(posts, 1);
});

test('usage exposes only plan name and finite usage windows with a safe unavailable fallback', async () => {
  let calls = 0, response = 'valid';
  const client = { async request(path) {
    assert.equal(path, '/api/billing/me');
    calls++;
    await new Promise(resolve => setImmediate(resolve));
    if (response === 'throw') throw Error('private native billing error');
    if (response === 'malformed') return { usage: { daily: { percentUsed: Infinity } }, token: 'never' };
    if (response === 'empty') return {};
    return {
      plan: { id: 'pro', code: 'pro-monthly', name: ' Pro ', priceCents: 2000, interval: 'month', checkoutUrl: 'never' },
      subscription: { status: 'active', cancelAtPeriodEnd: false, id: 'never' },
      paymentMethod: { brand: 'Visa', last4: '4242' },
      payments: [{ id: 'never', amountCents: 2000 }],
      permissions: { private: true },
      usage: { cycle: { percentUsed: 42, resetsAt: '2026-11-01T00:00:00Z', tokens: 999 }, daily: { percentUsed: 10 }, weekly: { percentUsed: 125 } },
      email: 'private@example.invalid',
    };
  } };
  const bridge = createBridge({ client });
  const [usageOne, usageTwo] = await Promise.all([bridge.usage(), bridge.usage()]);
  assert.deepEqual(usageOne, {
    available: true,
    planName: 'Pro',
    usage: { cycle: { percentUsed: 42, resetsAt: '2026-11-01T00:00:00.000Z' }, daily: { percentUsed: 10 }, weekly: { percentUsed: 125 } },
  });
  assert.deepEqual(usageTwo, usageOne);
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(usageOne), ['available', 'planName', 'usage']);
  assert.doesNotMatch(JSON.stringify(usageOne), /price|subscription|payment|card|permission|email|token/i);
  response = 'empty';
  assert.deepEqual(await bridge.usage(), { available: true });
  response = 'malformed';
  assert.deepEqual(await bridge.usage(), { available: false });
  response = 'throw';
  assert.deepEqual(await bridge.usage(), { available: false });
  assert.equal(calls, 4);
});

test('privacy attestation is bounded, fail-closed and refreshes only the verified native route', async () => {
  const calls = [];
  let result = {
    status: 'verified',
    measurements: { appId: ' app\nid ', composeHash: 'compose', imageDigest: 'image', mrtd: 'mrtd', keyProvider: ' enclave\u0000 provider ', secret: 'never' },
    expected: { appId: ' app\nid ', composeHash: 'compose', imageDigest: 'image', mrtd: 'mrtd', private: 'never' },
    nonceEchoed: true, signerBound: true,
    tcb: { status: 'Up_To_Date', private: 'never' },
    quoteFingerprint: ' fingerprint ', verifiedAt: '2026-10-16T12:00:00.000Z',
    token: 'never-forward', config: { private: true },
  };
  const bridge = createBridge({ client: { async request(path, options) { calls.push({ path, options }); return result; } } });
  const verified = await bridge.privacy();
  assert.deepEqual(verified, {
    status: 'verified',
    measurements: {
      appId: { value: 'app id', match: true },
      composeHash: { value: 'compose', match: true },
      imageDigest: { value: 'image', match: true },
      mrtd: { value: 'mrtd', match: true },
    },
    failedChecks: [], keyProvider: 'enclave provider', tcbStatus: 'Up_To_Date',
    quoteFingerprint: 'fingerprint', verifiedAt: '2026-10-16T12:00:00.000Z',
  });
  assert.deepEqual(Object.keys(verified), ['status', 'measurements', 'failedChecks', 'keyProvider', 'tcbStatus', 'quoteFingerprint', 'verifiedAt']);
  assert.doesNotMatch(JSON.stringify(verified), /never|token|config|expected|reason|nonceEchoed|signerBound/);

  result = { ...result, status: 'verified', expected: { ...result.expected, composeHash: 'different' }, nonceEchoed: false,
    signerBound: false, tcb: { status: 'Outdated' }, reason: 'quote signature invalid: private native detail' };
  const failed = await bridge.refreshPrivacy();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.measurements.composeHash.match, false);
  assert.deepEqual(failed.failedChecks, ['measurement_mismatch', 'nonce_freshness', 'signer_binding', 'tcb_status', 'quote_signature']);
  assert.deepEqual(calls, [
    { path: '/v1/attestation', options: undefined },
    { path: '/v1/attestation/refresh', options: { method: 'POST' } },
  ]);

  result = { status: 'verified', measurements: { appId: 'a\u0000b' }, expected: { appId: 'a b' }, nonceEchoed: true, signerBound: true };
  assert.deepEqual(await bridge.privacy(), {
    status: 'failed', measurements: { appId: { value: 'a b', match: false } }, failedChecks: ['measurement_mismatch'],
  });

  result = { status: 'verified', measurements: { appId: 'same' }, expected: { appId: 'same' },
    nonceEchoed: false, signerBound: false, tcb: { status: 'Outdated' } };
  assert.deepEqual(await bridge.privacy(), {
    status: 'failed', measurements: { appId: { value: 'same', match: true } },
    failedChecks: ['nonce_freshness', 'signer_binding', 'tcb_status'], tcbStatus: 'Outdated',
  });

  result = { status: 'verified', measurements: { appId: 'same' }, expected: { appId: 'same' }, reason: 'Quote signature invalid' };
  assert.deepEqual(await bridge.privacy(), {
    status: 'failed', measurements: { appId: { value: 'same', match: true } }, failedChecks: ['quote_signature'],
  });

  result = { status: 'failed', reason: 'generic native failure' };
  assert.deepEqual(await bridge.privacy(), { status: 'failed', measurements: {}, failedChecks: [] });

  const validProof = { status: 'verified', measurements: { appId: 'same' }, expected: { appId: 'same' } };
  for (const malformedCheck of [{ nonceEchoed: 'yes' }, { signerBound: {} }, { tcb: { status: 42 } }, { reason: { private: true } }]) {
    result = { ...validProof, ...malformedCheck };
    assert.deepEqual(await bridge.privacy(), { status: 'unavailable', measurements: {}, failedChecks: [] });
  }

  for (const unsupported of [null, {}, { status: 'verified' }, { status: 'verified', measurements: {}, expected: {} },
    { status: 'verified', measurements: { appId: 'one' }, expected: null }, { status: 'invented', measurements: {} }]) {
    result = unsupported;
    assert.deepEqual(await bridge.privacy(), { status: 'unavailable', measurements: {}, failedChecks: [] });
  }
  result = { status: 'failed', reason: 'attestation_unreachable: private host detail', token: 'never-forward' };
  assert.deepEqual(await bridge.privacy(), { status: 'unreachable', measurements: {}, failedChecks: [] });
  result = { status: 'pending', arbitrary: 'never-forward' };
  assert.deepEqual(await bridge.privacy(), { status: 'pending', measurements: {}, failedChecks: [] });

  const unavailable = createBridge({ client: { async request() { throw Error('private native error token=never-forward'); } } });
  assert.deepEqual(await unavailable.privacy(), { status: 'unavailable', measurements: {}, failedChecks: [] });
});

test('connector snapshots expose finite fields and serialized toggles preserve the latest unrelated enabled set', async () => {
  const sessionId = randomUUID(), puts = [], calls = [];
  let enabled = ['google-drive', 'Legacy Ω source', 'calendar'];
  const configured = [
    { name: 'google-drive', displayName: ' Google\n Drive ', type: 'http', status: 'connected', toolCount: 10, resourceCount: 2, promptCount: 1, hasSecrets: true, isPrebuilt: true, error: 'private', url: 'https://private.invalid' },
    { name: 'slack', displayName: 'Slack', type: 'http', status: 'connected', authFailureAttemptId: 'private' },
    { name: 'calendar', displayName: 'Calendar', type: 'http', status: 'disconnected' },
    { name: 'Legacy Ω source', displayName: 'Legacy Unicode', type: 'http', status: 'connected' },
    { name: '../invalid', displayName: 'Invalid', type: 'http', status: 'connected' },
    { name: 'bad-status', displayName: 'Invalid', type: 'http', status: 'unknown' },
  ];
  const client = { async request(path, options = {}) {
    calls.push({ path, options });
    if (path === '/v1/sessions?origin=desktop') return [{ id: sessionId, origin: 'desktop', projectId: null, title: 'Fixture' }];
    if (path === '/api/runs') return [];
    if (path === '/v1/connectors') return configured;
    if (path === `/v1/connectors/enabled?sessionId=${sessionId}` && !options.method) return { enabledConnectors: [...enabled] };
    if (path === `/v1/connectors/enabled?sessionId=${sessionId}` && options.method === 'PUT') {
      puts.push([...options.body.enabledConnectors]);
      await new Promise(resolve => setImmediate(resolve));
      enabled = [...options.body.enabledConnectors];
      return { enabledConnectors: [...enabled] };
    }
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, projects: { roots: async () => [] } });
  const initial = await bridge.getConnectors(sessionId);
  assert.deepEqual(initial, { available: true, connectors: [
    { id: 'google-drive', label: 'Google Drive', status: 'connected', enabled: true },
    { id: 'slack', label: 'Slack', status: 'connected', enabled: false },
    { id: 'calendar', label: 'Calendar', status: 'disconnected', enabled: true },
  ] });
  assert.deepEqual(Object.keys(initial.connectors[0]), ['id', 'label', 'status', 'enabled']);

  const [added, removed] = await Promise.all([
    bridge.setConnector(sessionId, { id: 'slack', enabled: true }),
    bridge.setConnector(sessionId, { id: 'google-drive', enabled: false }),
  ]);
  assert.equal(added.connectors.find(item => item.id === 'slack').enabled, true);
  assert.deepEqual(removed.connectors.map(item => [item.id, item.enabled]), [['google-drive', false], ['slack', true], ['calendar', true]]);
  assert.deepEqual(puts, [
    ['google-drive', 'Legacy Ω source', 'calendar', 'slack'],
    ['Legacy Ω source', 'calendar', 'slack'],
  ]);
  const disabled = await bridge.setConnector(sessionId, { id: 'calendar', enabled: false });
  assert.equal(disabled.connectors.find(item => item.id === 'calendar').enabled, false);
  assert.deepEqual(puts[2], ['Legacy Ω source', 'slack']);
  await assert.rejects(bridge.setConnector(sessionId, { id: 'calendar', enabled: true }), error => error.code === 'connector_unavailable');
  assert.equal(calls.some(call => call.path.includes('projectRoot=')), false);
  await assert.rejects(bridge.setConnector(sessionId, { id: 'not-configured', enabled: true }), error => error.code === 'connector_missing');
  assert.equal(puts.length, 3);
});

test('connector reads map upstream failures to an unavailable finite response', async () => {
  const sessionId = randomUUID();
  const client = { async request(path) {
    if (path === '/v1/sessions?origin=desktop') return [{ id: sessionId, origin: 'desktop', projectId: null, title: 'Fixture' }];
    if (path === '/api/runs') return [];
    if (path === '/v1/connectors') throw Error('native private details');
    if (path.startsWith('/v1/connectors/enabled?')) return { enabledConnectors: [] };
    throw Error(`unexpected ${path}`);
  } };
  const bridge = createBridge({ client, projects: { roots: async () => [] } });
  assert.deepEqual(await bridge.getConnectors(sessionId), { connectors: [], available: false });
});

test('malformed or unbounded upstream enabled lists are rejected without a connector PUT', async () => {
  const malformed = [
    { enabledConnectors: ['target', 7] },
    { enabledConnectors: ['x'.repeat(513)] },
    { enabledConnectors: Array.from({ length: 501 }, () => 'target') },
  ];
  for (const enabledResult of malformed) {
    const sessionId = randomUUID(); let puts = 0;
    const client = { async request(path, options = {}) {
      if (path === '/v1/sessions?origin=desktop') return [{ id: sessionId, origin: 'desktop', projectId: null, title: 'Fixture' }];
      if (path === '/api/runs') return [];
      if (path === '/v1/connectors') return [{ name: 'target', displayName: 'Target', type: 'http', status: 'connected' }];
      if (path === `/v1/connectors/enabled?sessionId=${sessionId}` && !options.method) return enabledResult;
      if (options.method === 'PUT') { puts++; return { enabledConnectors: options.body.enabledConnectors }; }
      throw Error(`unexpected ${path}`);
    } };
    const bridge = createBridge({ client, projects: { roots: async () => [] } });
    assert.deepEqual(await bridge.getConnectors(sessionId), { connectors: [], available: false });
    await assert.rejects(bridge.setConnector(sessionId, { id: 'target', enabled: true }), error => error.code === 'connectors_unavailable');
    assert.equal(puts, 0);
  }
});

test('bridge maps desktop origin, native idempotency, activity and explicit approvals', async () => {
  const id = randomUUID(), msgId = randomUUID(); let nativeMessages = [], controller, active = false; const calls = [];
  const base = { id, origin: 'desktop', projectId: null, title: 'Fixture', updatedAt: new Date().toISOString() };
  const client = { version: async () => '0.1.3', async request(path, opts = {}) {
    calls.push({ path, opts });
    if (path === '/v1/sessions?origin=desktop') return [base];
    if (path === '/api/models') return { data: [{ id: 'fixture' }] };
    if (path === '/api/sandbox') return { enabled: true, allowNetwork: false };
    if (path === '/api/runs') return active ? [{ sessionId: id, runId: 'native-run', status: 'running' }] : [];
    if (path === `/v1/sessions/${id}`) return { ...base, messages: nativeMessages };
    if (path === `/v1/sessions/${id}/history`) return [{ values: { messages: nativeMessages } }];
    if (path.endsWith('/confirmations')) return { confirmations: [{ id: 'approval', toolName: 'read', args: {} }] };
    if (path.endsWith('/confirmations/approval')) return { status: 'resolved' };
    if (path.endsWith('/stream') && opts.method === 'POST') { active = true; return new Response(new ReadableStream({ start(c) { controller = c; } })); }
    throw Error('unexpected fixture route');
  } };
  const projects = { roots: async () => [], settings: async () => ({}), setSettings: async () => {} };
  const bridge = createBridge({ client, projects }); await bridge.bootstrap();
  const observed = []; bridge.events.on(id, e => observed.push(e));
  const payload = { id: msgId, text: 'synthetic', mode: 'model', modelId: 'fixture', thinking: true };
  await bridge.send(id, payload); await bridge.send(id, payload);
  await assert.rejects(bridge.send(id, { ...payload, text: 'different' }), e => e.code === 'id_conflict');
  assert.equal(calls.filter(x => x.path.endsWith('/stream')).length, 1);
  assert.equal(calls.find(x => x.path.endsWith('/stream')).opts.body.modelPreference, 'tier:thinking:fixture');
  const frame = (event, data) => controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  frame('metadata', { run_id: 'native-run' }); frame('custom', { type: 'tool_activity_start', name: 'read', args: { path: 'seed.txt' } });
  frame('messages', [{ type: 'ai', id: 'a', content: 'Hello' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert(observed.some(e => e.type === 'run' && e.data.text === 'Hello'));
  assert(observed.some(e => e.data.activities?.[0]?.title === 'read'));
  await bridge.confirm(id, 'approval', 'approve_once');
  assert.equal(calls.at(-1).opts.body.decision, 'approve');
  await assert.rejects(bridge.confirm(id, 'wrong', 'approve_once'));
  active = false; nativeMessages = [{ role: 'human', id: msgId, content: 'synthetic' }, { role: 'ai', content: 'Hello' }];
  frame('done', { outcome: 'completed' }); controller.close(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await bridge.getView(id)).messages.at(-1).text, 'Hello');
});

test('HTTP boundary rejects cross-site mutations, unexpected fields and raw proxy routes', async t => {
  let calls = 0; const server = createMobileServer({ bridgeCapability, port: 4191, bridge: { bootstrap: async () => ({ connection: { state: 'connected' } }), createSession: async () => { calls++; return {}; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(url + path, { method: options.method || 'GET', headers: { 'X-Wisp-Bridge-Capability': bridgeCapability, Host: '127.0.0.1:4191', ...options.headers } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject); req.end(options.body);
  });
  assert.equal((await send('/bridge/bootstrap')).status, 200);
  assert.equal((await send('/account-settings.js')).status, 200);
  assert.equal((await send('/account-settings.css')).status, 200);
  assert.equal((await send('/account-settings.js?raw=true')).status, 400);
  assert.equal((await send('/api/models')).status, 404);
  assert.equal((await send('/bridge/sessions', { method: 'POST', headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await send('/bridge/sessions', { method: 'POST', headers: { Origin: 'http://127.0.0.1:4191', 'Content-Type': 'application/json' }, body: '{"projectRoot":"/arbitrary"}' })).status, 400);
  assert.equal((await send('/bridge/sessions', { method: 'POST', headers: { Origin: 'http://127.0.0.1:4191', 'Content-Type': 'application/json' }, body: '{}' })).status, 201);
  assert.equal(calls, 1);
});

test('HTTP profile, usage, sandbox and connector routes enforce exact methods, IDs and toggle bodies', async t => {
  const sessionId = randomUUID(), calls = [], settingsCalls = [];
  const bridge = {
    profile: async () => ({ displayName: 'Fixture' }),
    sandbox: async () => ({ enabled: true, allowNetwork: false }),
    setSandbox: async value => { settingsCalls.push(['sandbox', value]); return 'enabled' in value
      ? { enabled: value.enabled, allowNetwork: false }
      : { enabled: true, allowNetwork: value.allowNetwork }; },
    usage: async () => ({ available: true, planName: 'Fixture' }),
    getConnectors: async id => { calls.push(['get', id]); return { connectors: [], available: true }; },
    setConnector: async (id, value) => { calls.push(['set', id, value]); return { connectors: [], available: true }; },
  };
  const server = createMobileServer({ bridgeCapability, port: 4191, bridge });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (path, { method = 'GET', body: value } = {}) => new Promise((resolve, reject) => {
    const request = http.request(url + path, { method, headers: {
      'X-Wisp-Bridge-Capability': bridgeCapability, Host: '127.0.0.1:4191', ...(method === 'GET' ? {} : { Origin: 'http://127.0.0.1:4191', 'Content-Type': 'application/json' }),
    } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject); request.end(value === undefined ? undefined : JSON.stringify(value));
  });
  assert.deepEqual(await send('/bridge/profile'), { status: 200, data: { displayName: 'Fixture' } });
  assert.deepEqual(await send('/bridge/sandbox'), { status: 200, data: { enabled: true, allowNetwork: false } });
  assert.deepEqual(await send('/bridge/sandbox', { method: 'POST', body: { enabled: false } }), { status: 200, data: { enabled: false, allowNetwork: false } });
  assert.deepEqual(await send('/bridge/sandbox', { method: 'POST', body: { allowNetwork: true } }), { status: 200, data: { enabled: true, allowNetwork: true } });
  assert.deepEqual(await send('/bridge/usage'), { status: 200, data: { available: true, planName: 'Fixture' } });
  for (const path of ['/bridge/account', '/bridge/payments', '/bridge/permissions', `/bridge/projects/${randomUUID()}/permissions`]) assert.equal((await send(path)).status, 404);
  assert.deepEqual(settingsCalls, [['sandbox', { enabled: false }], ['sandbox', { allowNetwork: true }]]);
  assert.equal((await send(`/bridge/sessions/${sessionId}/connectors`)).status, 200);
  assert.equal((await send(`/bridge/sessions/${sessionId}/connectors`, { method: 'POST', body: { id: 'slack', enabled: true } })).status, 200);
  assert.deepEqual(calls, [['get', sessionId], ['set', sessionId, { id: 'slack', enabled: true }]]);
  for (const value of [{ id: 'slack' }, { id: '../slack', enabled: true }, { id: 'slack', enabled: true, token: 'forbidden' }]) {
    assert.equal((await send(`/bridge/sessions/${sessionId}/connectors`, { method: 'POST', body: value })).status, 400);
  }
  assert.equal((await send(`/bridge/sessions/${sessionId}/connectors`, { method: 'PUT', body: { id: 'slack', enabled: true } })).status, 405);
  assert.equal((await send('/bridge/sessions/not-a-uuid/connectors')).status, 404);
  assert.equal((await send('/bridge/profile?raw=true')).status, 400);
  assert.equal((await send('/bridge/usage?raw=true')).status, 400);
  assert.equal((await send('/bridge/sandbox', { method: 'POST', body: {} })).status, 400);
  assert.equal((await send('/bridge/sandbox', { method: 'POST', body: { enabled: true, allowNetwork: true } })).status, 400);
  assert.equal((await send('/bridge/sandbox', { method: 'POST', body: { enabled: 1 } })).status, 400);
  assert.equal((await send('/bridge/sandbox', { method: 'POST', body: { allowNetwork: 'yes' } })).status, 400);
  assert.equal((await send('/bridge/sandbox', { method: 'POST', body: { unknown: true } })).status, 400);
  assert.equal((await send('/bridge/usage', { method: 'POST', body: {} })).status, 405);
});

test('HTTP project removal route enforces exact bounded UUID snapshots', async t => {
  const projectId = randomUUID(), first = randomUUID(), second = randomUUID(); const calls = [], sessionCalls = [];
  const bridge = { removeProject: async (id, value) => {
    calls.push([id, value]);
    return { removedSessionIds: value.sessionIds, complete: true };
  }, removeSession: async (id, value) => {
    sessionCalls.push([id, value]);
    return { removedSessionId: id };
  } };
  const server = createMobileServer({ bridgeCapability, port: 4191, bridge });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (path, { method = 'POST', body: value } = {}) => new Promise((resolve, reject) => {
    const request = http.request(url + path, { method, headers: {
      'X-Wisp-Bridge-Capability': bridgeCapability, Host: '127.0.0.1:4191', ...(method === 'GET' ? {} : { Origin: 'http://127.0.0.1:4191', 'Content-Type': 'application/json' }),
    } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject); request.end(value === undefined ? undefined : JSON.stringify(value));
  });
  const body = { sessionIds: [first, second], activeSessionId: second };
  assert.deepEqual(await send(`/bridge/projects/${projectId}/remove`, { body }), {
    status: 200, data: { removedSessionIds: [first, second], complete: true },
  });
  assert.deepEqual(calls, [[projectId, body]]);
  for (const value of [
    {}, { sessionIds: [first, second] }, { sessionIds: [first, first], activeSessionId: first },
    { sessionIds: [first], activeSessionId: 'invalid' }, { sessionIds: [first], activeSessionId: null, extra: true },
  ]) assert.equal((await send(`/bridge/projects/${projectId}/remove`, { body: value })).status, 400);
  assert.equal((await send('/bridge/projects/not-a-uuid/remove', { body })).status, 404);
  assert.equal((await send(`/bridge/projects/${projectId}/remove`, { method: 'GET' })).status, 404);
  assert.equal(calls.length, 1);

  assert.deepEqual(await send(`/bridge/sessions/${first}/remove`, { body: {} }), {
    status: 200, data: { removedSessionId: first },
  });
  assert.deepEqual(sessionCalls, [[first, {}]]);
  for (const value of [undefined, { retry: true }]) {
    assert.equal((await send(`/bridge/sessions/${first}/remove`, { body: value })).status, 400);
  }
  assert.equal((await send('/bridge/sessions/not-a-uuid/remove', { body: {} })).status, 404);
  assert.equal((await send(`/bridge/sessions/${first}/remove/extra`, { body: {} })).status, 404);
  assert.equal((await send(`/bridge/sessions/${first}/remove`, { method: 'GET' })).status, 404);
  assert.equal(sessionCalls.length, 1);
});

test('HTTP privacy routes allow a finite read and exact empty refresh body', async t => {
  const calls = [];
  const response = { status: 'unavailable', measurements: {}, failedChecks: [] };
  const bridge = {
    privacy: async () => { calls.push('get'); return response; },
    refreshPrivacy: async () => { calls.push('refresh'); return response; },
  };
  const server = createMobileServer({ bridgeCapability, port: 4191, bridge });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (path, { method = 'GET', body: value } = {}) => new Promise((resolve, reject) => {
    const request = http.request(url + path, { method, headers: {
      'X-Wisp-Bridge-Capability': bridgeCapability, Host: '127.0.0.1:4191', ...(method === 'GET' ? {} : { Origin: 'http://127.0.0.1:4191', 'Content-Type': 'application/json' }),
    } }, httpResponse => {
      const chunks = []; httpResponse.on('data', chunk => chunks.push(chunk));
      httpResponse.on('end', () => resolve({ status: httpResponse.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject); request.end(value === undefined ? undefined : JSON.stringify(value));
  });
  assert.deepEqual(await send('/bridge/privacy'), { status: 200, data: response });
  assert.deepEqual(await send('/bridge/privacy/refresh', { method: 'POST', body: {} }), { status: 200, data: response });
  assert.deepEqual(calls, ['get', 'refresh']);
  assert.equal((await send('/bridge/privacy?raw=true')).status, 400);
  assert.equal((await send('/bridge/privacy/refresh', { method: 'POST', body: { force: true } })).status, 400);
  assert.equal((await send('/bridge/privacy', { method: 'POST', body: {} })).status, 405);
});

test('HTTP event stream starts with an authoritative snapshot, emits JSON ping, and rejects snapshot failure', async t => {
  const sessionId = randomUUID(), events = new EventEmitter();
  let fail = false;
  const bridge = { events, async getView() {
    if (fail) throw new BridgeError(503, 'snapshot_unavailable', 'Chat snapshot is unavailable.');
    return { session: { id: sessionId, title: 'Fixture' }, messages: [], run: null, settings: {} };
  } };
  const server = createMobileServer({ bridgeCapability, port: 4191, bridge, heartbeatMs: 5 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/bridge/events?sessionId=${sessionId}`;

  const received = await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { 'X-Wisp-Bridge-Capability': bridgeCapability, Host: '127.0.0.1:4191' } }, response => {
      assert.equal(response.statusCode, 200); let text = '';
      const timeout = setTimeout(() => { request.destroy(); reject(Error('timed out waiting for ping')); }, 500);
      response.on('data', chunk => {
        text += chunk.toString('utf8');
        if (text.includes('event: ping')) { clearTimeout(timeout); response.destroy(); resolve(text); }
      });
      response.on('error', error => { if (!text.includes('event: ping')) reject(error); });
    });
    request.on('error', reject);
  });
  assert.match(received, /^event: snapshot\ndata: /);
  assert.match(received, /event: ping\ndata: \{\}/);

  fail = true;
  const unavailable = await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { 'X-Wisp-Bridge-Capability': bridgeCapability, Host: '127.0.0.1:4191' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject);
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.data, { error: { code: 'snapshot_unavailable', message: 'Chat snapshot is unavailable.' } });
});

for (const received of [true, false]) test(`uncertain delivery reconciles without redispatch (native received=${received})`, async () => {
  const id = randomUUID(), messageId = randomUUID(); let posts = 0, reconciles = 0;
  const s = { id, origin: 'desktop', projectId: null, title: 'Fixture' };
  const client = { version: async () => '0.1.3', async request(path, opts = {}) {
    if (path === '/v1/sessions?origin=desktop') return [s];
    if (path === '/api/models') return { data: [] };
    if (path === '/api/billing/me') return {};
    if (path === '/api/sandbox') return { enabled: true };
    if (path === '/api/runs') return [];
    if (path.endsWith(`/messages/${messageId}/run`)) { reconciles++; return { status: received ? 'completed' : 'unknown' }; }
    if (path.endsWith('/confirmations')) return { confirmations: [] };
    if (path === `/v1/sessions/${id}`) return { ...s, messages: received ? [{ role: 'human', id: messageId, content: 'once' }] : [] };
    if (path === `/v1/sessions/${id}/history`) return [{ values: { messages: received ? [{ role: 'human', id: messageId, content: 'once' }] : [] } }];
    if (path.endsWith('/stream') && opts.method === 'POST') { posts++; throw new BridgeError(503, 'delivery_unknown', 'Delivery unknown'); }
    throw Error('unexpected fixture route');
  } };
  const bridge = createBridge({ client, projects: { roots: async () => [], settings: async () => ({}), setSettings: async () => {} } });
  const payload = { id: messageId, text: 'once' };
  await assert.rejects(bridge.send(id, payload), e => e.code === 'delivery_unknown');
  if (received) assert.equal((await bridge.send(id, payload)).accepted, true);
  else await assert.rejects(bridge.send(id, payload), e => e.code === 'delivery_unknown');
  assert.equal(posts, 1); assert.equal(reconciles, 1);
});
