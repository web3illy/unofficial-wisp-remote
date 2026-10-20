import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Endpoint, EndpointAddr } from '@number0/iroh';
import { createPairing } from '../src/pairing.js';
import { ALPN, createIrohCompanion, keyHex, readFrame, deadline } from '../src/iroh-companion.js';

async function localEndpoint() { const builder = Endpoint.builder(); builder.applyMinimal(); builder.bindAddr('127.0.0.1:0'); builder.alpns([ALPN]); return builder.bind(); }
async function rpc(connection, request) {
  const bi = await connection.openBi(); await bi.send.writeAll(Array.from(Buffer.from(JSON.stringify(request)))); await bi.send.finish();
  return deadline(readFrame(bi.recv), 3000);
}
async function eventStream(connection, sessionId) {
  const bi = await connection.openBi();
  await bi.send.writeAll(Array.from(Buffer.from(JSON.stringify({ v: 1, op: 'events', sessionId }))));
  await bi.send.finish();
  return bi;
}
async function trust(pairing, phone) {
  const invitation = pairing.invite();
  const pending = pairing.request(keyHex(phone.id()), invitation.token, 'Synthetic peer');
  await pairing.approve(pending.pendingId);
}
async function waitForStatus(events, statuses, predicate) {
  const current = statuses.find(predicate); if (current) return current;
  let listener;
  return deadline(new Promise(resolve => {
    listener = status => { if (predicate(status)) { events.off('status', listener); resolve(status); } };
    events.on('status', listener);
  }), 3000, () => events.off('status', listener));
}
test('real iroh QUIC enforces pairing, streams snapshot and closes revoked peer', { timeout: 20_000 }, async t => {
  const server = await localEndpoint(), phone = await localEndpoint(); const pairing = await createPairing();
  let calls = 0, releaseSnapshot; const sessionId = randomUUID();
  const snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
  const statuses = [];
  const bridge = { events: new EventEmitter(), bootstrap: async () => { calls++; return { fixture: 'SYNTHETIC-E2EE' }; }, getView: async () => { await snapshotGate; return { session: { id: sessionId }, messages: [] }; } };
  const companion = await createIrohCompanion({ endpoint: server, bridge, pairing, readinessTTL: 60,
    onStatus: status => statuses.push(status) });
  t.after(async () => { await phone.close(); await companion.close(); });
  const invite = pairing.invite();
  const connection = await phone.connect(new EndpointAddr(server.id(), null, server.boundSockets()), ALPN);
  t.diagnostic('QUIC connected');
  const query = { v: 1, op: 'request', method: 'GET', path: '/bridge/bootstrap' };
  assert.equal((await rpc(connection, query)).status, 403); assert.equal(calls, 0);
  t.diagnostic('unpaired request rejected');
  const pair = await rpc(connection, { v: 1, op: 'pair', token: invite.token, name: 'Synthetic phone' });
  assert.equal(pair.body.state, 'pending'); assert.equal((await rpc(connection, query)).status, 403);
  assert.equal((await rpc(connection, { v: 1, op: 'pair', token: invite.token, name: 'Replay' })).status, 403);
  await pairing.approve(pair.body.pendingId);
  t.diagnostic('pair approved');
  assert.equal((await rpc(connection, query)).body.fixture, 'SYNTHETIC-E2EE'); assert.equal(calls, 1);
  const peerId = keyHex(phone.id());
  assert.equal((await rpc(connection, { v: 1, op: 'app.state', ready: true })).body.ready, true);
  assert.equal(statuses.at(-1).connections.find(item => item.peerId === peerId).ready, true);
  assert.equal((await rpc(connection, { v: 1, op: 'app.state', ready: false })).body.ready, false);
  assert.equal(statuses.at(-1).connections.find(item => item.peerId === peerId).ready, false, 'explicit background state must clear readiness');
  await rpc(connection, { v: 1, op: 'app.state', ready: true });
  await new Promise(resolve => setTimeout(resolve, 80)); companion.status();
  assert.equal(statuses.at(-1).connections.find(item => item.peerId === peerId).ready, false, 'readiness lease must expire while transport remains connected');
  assert.equal((await rpc(connection, { v: 1, op: 'app.state', ready: 1 })).status, 400);
  const event = await connection.openBi(); await event.send.writeAll(Array.from(Buffer.from(JSON.stringify({ v: 1, op: 'events', sessionId })))); await event.send.finish();
  assert.equal((await deadline(readFrame(event.recv), 3000)).ok, true);
  bridge.events.emit(sessionId, { type: 'run', data: { text: 'QUEUED-DURING-SNAPSHOT' } });
  releaseSnapshot();
  assert.equal((await deadline(readFrame(event.recv), 3000)).event, 'snapshot');
  assert.equal((await deadline(readFrame(event.recv), 3000)).data.text, 'QUEUED-DURING-SNAPSHOT');
  t.diagnostic('snapshot received');
  bridge.events.emit(sessionId, { type: 'run', data: { text: 'SYNTHETIC-EVENT' } });
  assert.equal((await deadline(readFrame(event.recv), 3000)).data.text, 'SYNTHETIC-EVENT');
  await pairing.revoke(keyHex(phone.id())); await deadline(connection.closed(), 3000);
  t.diagnostic('revocation closed connection');
  await assert.rejects(rpc(connection, query)); assert.equal(calls, 1);
});

test('normal trusted QUIC disconnect clears live status but retains paired peer', { timeout: 20_000 }, async t => {
  const server = await localEndpoint(), phone = await localEndpoint(); const pairing = await createPairing();
  const events = new EventEmitter(), statuses = [];
  const companion = await createIrohCompanion({
    endpoint: server,
    bridge: { events: new EventEmitter() },
    pairing,
    onStatus: status => { statuses.push(status); events.emit('status', status); },
  });
  t.after(async () => { await phone.close(); await companion.close(); });

  const invite = pairing.invite();
  const connection = await phone.connect(new EndpointAddr(server.id(), null, server.boundSockets()), ALPN);
  const peerId = keyHex(phone.id());
  const pair = await rpc(connection, { v: 1, op: 'pair', token: invite.token, name: 'Synthetic phone' });
  const pending = await waitForStatus(events, statuses, status => status.pending?.id === pair.body.pendingId);
  assert.equal(pending.connections.length, 0, 'pending pairing must not count as a live trusted connection');

  await pairing.approve(pair.body.pendingId);
  const connected = await waitForStatus(events, statuses, status => status.connections.some(item => item.peerId === peerId));
  assert.equal(connected.peers.some(peer => peer.id === peerId), true);
  assert.match(connected.connections.find(item => item.peerId === peerId).route, /^(direct|relay|connecting)$/);

  connection.close(0n, Array.from(Buffer.from('client disconnect')));
  await deadline(connection.closed(), 3000);
  const disconnected = await waitForStatus(events, statuses, status =>
    status.peers.some(peer => peer.id === peerId) && !status.connections.some(item => item.peerId === peerId));
  assert.equal(disconnected.peers.some(peer => peer.id === peerId), true, 'normal disconnect must not revoke pairing');
  assert.equal(disconnected.connections.some(item => item.peerId === peerId), false);
});

test('invalid and excess event subscriptions return an error and EOF without breaking RPC', { timeout: 20_000 }, async t => {
  const server = await localEndpoint(), phone = await localEndpoint(), pairing = await createPairing();
  const sessionId = randomUUID();
  const bridge = { events: new EventEmitter(), getView: async () => ({ messages: [] }), bootstrap: async () => ({ fixture: true }) };
  const companion = await createIrohCompanion({ endpoint: server, pairing, bridge });
  t.after(async () => { await phone.close(); await companion.close(); });
  await trust(pairing, phone);
  const connection = await phone.connect(new EndpointAddr(server.id(), null, server.boundSockets()), ALPN);
  const rejectSubscription = async id => {
    const stream = await eventStream(connection, id);
    assert.equal((await deadline(readFrame(stream.recv), 3000)).status, 400);
    assert.deepEqual(await deadline(stream.recv.readToEnd(64), 3000), [], 'rejected subscription must finish');
  };
  await rejectSubscription('not-a-uuid');
  for (let n = 0; n < 2; n++) {
    const stream = await eventStream(connection, sessionId);
    assert.equal((await deadline(readFrame(stream.recv), 3000)).body.subscribed, true);
    assert.equal((await deadline(readFrame(stream.recv), 3000)).event, 'snapshot');
  }
  await rejectSubscription(sessionId);
  assert.equal(bridge.events.listenerCount(sessionId), 2);
  assert.equal((await rpc(connection, { v: 1, op: 'request', method: 'GET', path: '/bridge/bootstrap' })).body.fixture, true);
});

test('one endpoint cannot monopolize connections; another peer and reconnect still work', { timeout: 20_000 }, async t => {
  const server = await localEndpoint(), first = await localEndpoint(), second = await localEndpoint(), pairing = await createPairing();
  const events = new EventEmitter(), statuses = [];
  const companion = await createIrohCompanion({ endpoint: server, pairing,
    bridge: { events: new EventEmitter(), bootstrap: async () => ({ fixture: true }) },
    onStatus: status => { statuses.push(status); events.emit('status', status); } });
  t.after(async () => { await first.close(); await second.close(); await companion.close(); });
  await trust(pairing, first); await trust(pairing, second);
  const address = new EndpointAddr(server.id(), null, server.boundSockets());
  const query = { v: 1, op: 'request', method: 'GET', path: '/bridge/bootstrap' };
  const a = await first.connect(address, ALPN); assert.equal((await rpc(a, query)).status, 200);
  const b = await first.connect(address, ALPN); assert.equal((await rpc(b, query)).status, 200);
  const excess = await first.connect(address, ALPN);
  await deadline(excess.closed(), 3000);
  const other = await second.connect(address, ALPN); assert.equal((await rpc(other, query)).status, 200);
  assert.equal((await rpc(a, query)).status, 200);
  statuses.length = 0;
  a.close(0n, []); await deadline(a.closed(), 3000);
  await waitForStatus(events, statuses, status => status.connections.filter(c => c.peerId === keyHex(first.id())).length === 1);
  const replacement = await first.connect(address, ALPN); assert.equal((await rpc(replacement, query)).status, 200);
  assert.equal((await rpc(b, query)).status, 200);
});
