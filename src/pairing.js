import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { BridgeError } from './wisp-client.js';

const KEY = /^[a-f0-9]{64}$/;
const denied = () => new BridgeError(403, 'not_paired', 'This device is not authorized to connect.');

// Public-key allowlist only. Private endpoint keys are supplied by the native
// companion from its own Keychain over a pipe, never stored in this file.
export async function createPairing({ file, now = Date.now, invitationTTL = 120_000, approvalTTL = 120_000 } = {}) {
  const events = new EventEmitter();
  let trusted = new Map(), invitation = null, pending = null, serial = Promise.resolve();
  if (file) {
    try {
      const s = await lstat(file);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 8192 || (s.mode & 0o077)) throw new Error('Unsafe pairing state');
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.v !== 1 || !Array.isArray(data.peers) || data.peers.length > 5 || data.peers.some(p => !KEY.test(p.id) || typeof p.name !== 'string' || p.name.length > 60)) throw new Error('Invalid pairing state');
      trusted = new Map(data.peers.map(p => [p.id, p]));
    } catch (e) { if (e.code !== 'ENOENT') throw new Error('Pairing state unavailable'); }
  }
  async function persist(next) {
    if (!file) return;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ v: 1, peers: [...next.values()] }), { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  }
  function prune() {
    if (invitation && invitation.expiresAt <= now()) invitation = null;
    if (pending && pending.expiresAt <= now()) { pending = null; events.emit('change'); }
  }
  function status() {
    prune();
    return { peers: [...trusted.values()], pending: pending && { id: pending.id, peerId: pending.peerId, name: pending.name, expiresAt: pending.expiresAt }, pairingOpen: Boolean(invitation) };
  }
  function enqueue(fn) { const work = serial.then(fn); serial = work.catch(() => {}); return work; }
  return {
    events, status,
    isTrusted(peerId) { return KEY.test(peerId) && trusted.has(peerId); },
    canPair() { prune(); return Boolean(invitation || pending); },
    invite() {
      prune(); if (trusted.size >= 5) throw new BridgeError(409, 'device_limit', 'Remove a paired device before adding another.');
      pending = null;
      invitation = { token: randomBytes(32).toString('base64url'), expiresAt: now() + invitationTTL };
      events.emit('change'); return { ...invitation };
    },
    request(peerId, token, name) {
      prune();
      if (!KEY.test(peerId) || typeof token !== 'string' || !/^[\w-]{43}$/.test(token) || !invitation ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(invitation.token))) throw denied();
      if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw denied();
      invitation = null;
      pending = { id: randomUUID(), peerId, name: name.trim(), expiresAt: now() + approvalTTL };
      events.emit('change'); return { pendingId: pending.id, state: 'pending' };
    },
    poll(peerId, pendingId) {
      prune();
      if (trusted.has(peerId)) return { state: 'approved' };
      if (pending?.id === pendingId && pending.peerId === peerId) return { state: 'pending' };
      throw denied();
    },
    approve(pendingId) {
      return enqueue(async () => {
        prune(); if (!pending || pending.id !== pendingId) throw new BridgeError(409, 'pairing_expired', 'The pairing request expired. Generate a new QR code.');
        const candidate = pending;
        const next = new Map(trusted); next.set(candidate.peerId, { id: candidate.peerId, name: candidate.name, addedAt: now() });
        await persist(next);
        // A replaced/expired invitation cannot be approved by a stale UI action.
        if (pending !== candidate || candidate.expiresAt <= now()) { await persist(trusted); throw denied(); }
        trusted = next; pending = null; events.emit('change'); return { ok: true };
      });
    },
    reject(pendingId) { if (pending?.id === pendingId) { pending = null; events.emit('change'); } },
    revoke(peerId) {
      return enqueue(async () => {
        if (!KEY.test(peerId)) throw denied();
        const next = new Map(trusted); next.delete(peerId);
        await persist(next); trusted = next;
        if (pending?.peerId === peerId) pending = null;
        events.emit('revoke', peerId); events.emit('change'); return { ok: true };
      });
    },
  };
}
