import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPairing } from '../src/pairing.js';
const a = 'a'.repeat(64), b = 'b'.repeat(64);

test('QR is single-use, bound to TLS peer and needs explicit local approval', async () => {
  const pairing = await createPairing(); const invitation = pairing.invite();
  assert.equal(pairing.isTrusted(a), false);
  assert.throws(() => pairing.request(a, 'x'.repeat(43), 'Phone'), e => e.code === 'not_paired');
  const pending = pairing.request(a, invitation.token, 'Phone');
  assert.equal(pairing.isTrusted(a), false);
  assert.throws(() => pairing.request(b, invitation.token, 'Intruder'));
  assert.throws(() => pairing.poll(b, pending.pendingId));
  assert.equal(pairing.poll(a, pending.pendingId).state, 'pending');
  await pairing.approve(pending.pendingId);
  assert.equal(pairing.poll(a, pending.pendingId).state, 'approved');
  assert.equal(pairing.isTrusted(a), true); assert.equal(pairing.isTrusted(b), false);
});
test('expired invitations, approval and replaced pending requests fail closed', async () => {
  let clock = 1000; const pairing = await createPairing({ now: () => clock, invitationTTL: 100, approvalTTL: 100 });
  const expired = pairing.invite(); clock += 101;
  assert.throws(() => pairing.request(a, expired.token, 'Phone'));
  const invitation = pairing.invite(), pending = pairing.request(a, invitation.token, 'Phone');
  clock += 101; await assert.rejects(pairing.approve(pending.pendingId));
  const newInvite = pairing.invite(); const newPending = pairing.request(a, newInvite.token, 'Phone');
  pairing.invite(); await assert.rejects(pairing.approve(newPending.pendingId));
  assert.equal(pairing.isTrusted(a), false);
});
test('allowlist persists privately, revocation survives restart and emits closure signal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wisp-pairing-')); t.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, 'peers.json'); const pairing = await createPairing({ file });
  const invite = pairing.invite(), pending = pairing.request(a, invite.token, 'Phone'); await pairing.approve(pending.pendingId);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restarted = await createPairing({ file }); assert.equal(restarted.isTrusted(a), true);
  let revoked; restarted.events.on('revoke', key => { revoked = key; }); await restarted.revoke(a);
  assert.equal(revoked, a); assert.equal((await createPairing({ file })).isTrusted(a), false);
});
