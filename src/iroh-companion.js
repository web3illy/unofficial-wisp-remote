import { Endpoint, EndpointTicket } from '@number0/iroh';
import { BridgeError } from './wisp-client.js';
import { UUID } from './mobile-store.js';
import { fields, dispatchCompanion } from './companion-rpc.js';

export const ALPN = Array.from(Buffer.from('wisp-remote/1'));
export const keyHex = id => Buffer.from(id.toBytes()).toString('hex');
const REQUEST_LIMIT = 64 * 1024, FRAME_LIMIT = 8 * 1024 * 1024;
const READINESS_TTL_MS = 15_000;
const reason = Array.from(Buffer.from('Connection closed'));
const denied = () => new BridgeError(403, 'not_paired', 'This device is not authorized to connect.');
const fail = e => e instanceof BridgeError ? { ok: false, status: e.status, error: { code: e.code, message: e.message } } : { ok: false, status: 503, error: { code: 'unavailable', message: 'The connection is unavailable. Check your Mac.' } };

export async function deadline(promise, ms, timeout) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { timeout?.(); reject(new BridgeError(408, 'timeout', 'The request timed out.')); }, ms); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}
export async function writeFrame(send, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > FRAME_LIMIT) throw new BridgeError(413, 'response_large', 'The response is too large.');
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  await deadline(send.writeAll(Array.from(Buffer.concat([size, bytes]))), 20_000, () => void send.reset(1n).catch(() => {}));
}
export async function readFrame(recv) {
  const header = Buffer.from(await recv.readExact(4)); const length = header.readUInt32BE();
  if (!length || length > FRAME_LIMIT) throw new Error('Invalid frame size');
  return JSON.parse(Buffer.from(await recv.readExact(length)).toString('utf8'));
}

export async function createIrohCompanion({ bridge, pairing, secretKey, endpoint, onStatus = () => {}, readinessTTL = READINESS_TTL_MS } = {}) {
  const ep = endpoint || await Endpoint.bind({ secretKey, alpns: [ALPN] });
  const connections = new Set(); let accepting = 0, closing = false;
  const report = () => {
    const now = Date.now();
    const paths = [...connections].filter(c => pairing.isTrusted(c.peerId)).map(c => {
      const selected = c.conn.paths().find(p => p.isSelected);
      return {
        peerId: c.peerId,
        route: selected?.isIp ? 'direct' : selected?.isRelay ? 'relay' : 'connecting',
        ready: c.readyUntil > now,
      };
    });
    onStatus({ endpointId: keyHex(ep.id()), ...pairing.status(), connections: paths });
  };
  const revoke = peerId => {
    for (const c of connections) if (c.peerId === peerId) c.conn.close(1n, reason);
    bridge.dropAttachments?.(peerId); report();
  };
  pairing.events.on('revoke', revoke); pairing.events.on('change', report);
  const monitor = setInterval(report, 3000); monitor.unref();

  async function handleEvents(c, bi, sessionId) {
    if (!UUID.test(sessionId || '') || c.subscriptions >= 2) throw new BridgeError(400, 'stream_limit', 'The event subscription is unavailable.');
    c.subscriptions++;
    let stopped = false, live = false, bytesQueued = 0, tail = Promise.resolve(), resolveEnd;
    const buffered = [];
    const ended = new Promise(resolve => { resolveEnd = resolve; });
    const stop = () => { if (stopped) return; stopped = true; clearInterval(heartbeat); clearTimeout(lifetime); bridge.events.off(sessionId, enqueue); c.subscriptions--; resolveEnd(); void bi.send.reset(0n).catch(() => {}); };
    const writeEvent = packet => {
      if (stopped) return;
      const bytes = Buffer.byteLength(JSON.stringify(packet)); bytesQueued += bytes;
      if (bytesQueued > FRAME_LIMIT) return stop();
      tail = tail.then(async () => {
        if (stopped || !pairing.isTrusted(c.peerId)) throw denied();
        await writeFrame(bi.send, { event: packet.type, data: packet.data });
      }).catch(stop).finally(() => { bytesQueued -= bytes; });
    };
    const enqueue = packet => {
      if (stopped) return;
      if (!live) {
        const bytes = Buffer.byteLength(JSON.stringify(packet));
        bytesQueued += bytes;
        if (bytesQueued > FRAME_LIMIT) return stop();
        buffered.push({ packet, bytes });
        return;
      }
      writeEvent(packet);
    };
    const heartbeat = setInterval(() => enqueue({ type: 'ping', data: {} }), 15_000);
    const lifetime = setTimeout(stop, 30 * 60_000);
    try {
      // Register before acknowledging so no state change can slip between the
      // subscription acknowledgement and the initial snapshot.
      bridge.events.on(sessionId, enqueue);
      if (!pairing.isTrusted(c.peerId)) throw denied();
      await writeFrame(bi.send, { ok: true, status: 200, body: { subscribed: true } });
      const snapshot = await bridge.getView(sessionId);
      if (!pairing.isTrusted(c.peerId)) throw denied();
      await writeFrame(bi.send, { event: 'snapshot', data: snapshot });
      while (buffered.length) {
        const { packet, bytes } = buffered.shift();
        bytesQueued -= bytes;
        await writeFrame(bi.send, { event: packet.type, data: packet.data });
      }
      live = true;
      // iroh-ffi serializes SendStream methods; awaiting stopped() concurrently
      // with writeAll() holds its mutex and stalls the live event stream.
      await Promise.race([ended, c.conn.closed()]);
    } finally { stop(); }
  }

  async function handleStream(c, bi) {
    try {
      const raw = await deadline(bi.recv.readToEnd(REQUEST_LIMIT), 12_000, () => void bi.recv.stop(1n).catch(() => {}));
      let request;
      try { request = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { throw new BridgeError(400, 'invalid_request', 'Invalid request.'); }
      if (request?.v !== 1 || typeof request.op !== 'string') throw new BridgeError(400, 'protocol_version', 'Update Wisp Remote on both devices.');
      if (request.op === 'pair') {
        fields(request, ['v', 'op', 'token', 'name']);
        await writeFrame(bi.send, { ok: true, status: 200, body: pairing.request(c.peerId, request.token, request.name) });
      } else if (request.op === 'pair.status') {
        fields(request, ['v', 'op', 'pendingId']);
        if (!UUID.test(request.pendingId || '')) throw denied();
        await writeFrame(bi.send, { ok: true, status: 200, body: pairing.poll(c.peerId, request.pendingId) });
      } else {
        if (!pairing.isTrusted(c.peerId)) throw denied();
        if (request.op === 'events') {
          fields(request, ['v', 'op', 'sessionId']);
          await handleEvents(c, bi, request.sessionId);
        } else if (request.op === 'app.state') {
          fields(request, ['v', 'op', 'ready']);
          if (typeof request.ready !== 'boolean') throw new BridgeError(400, 'invalid_request', 'Invalid request.');
          c.readyUntil = request.ready ? Date.now() + readinessTTL : 0;
          report();
          await writeFrame(bi.send, { ok: true, status: 200, body: { ready: request.ready } });
        } else if (request.op === 'request') {
          const result = await dispatchCompanion(bridge, request, c.peerId);
          if (!pairing.isTrusted(c.peerId)) throw denied();
          await writeFrame(bi.send, { ok: true, ...result });
        } else throw new BridgeError(400, 'invalid_request', 'This action is not supported.');
      }
    } catch (error) { await writeFrame(bi.send, fail(error)).catch(() => {}); }
    // Accepted subscriptions reset their stream on exit. Validation failures
    // still need a framed error and FIN, just like any other rejected request.
    finally { await bi.send.finish().catch(() => {}); }
  }

  async function handleIncoming(incoming) {
    accepting++;
    let c;
    try {
      const handshake = await deadline(incoming.accept(), 8000);
      const conn = await deadline(handshake.connect(), 8000);
      c = { conn, peerId: keyHex(conn.remoteId()), subscriptions: 0, streams: 0, started: Date.now(), rateStart: Date.now(), requests: 0, readyUntil: 0 };
      if (!pairing.isTrusted(c.peerId) && !pairing.canPair()) { conn.close(1n, reason); return; }
      if ([...connections].filter(active => active.peerId === c.peerId).length >= 2) { conn.close(1n, reason); return; }
      connections.add(c); report();
      const unauthenticatedTimer = setTimeout(() => { if (!pairing.isTrusted(c.peerId)) conn.close(1n, reason); }, 125_000);
      try {
        while (!closing) {
          const bi = await conn.acceptBi();
          if (Date.now() - c.rateStart > 60_000) { c.rateStart = Date.now(); c.requests = 0; }
          if (c.streams >= 6 || ++c.requests > 1800 || (!pairing.isTrusted(c.peerId) && c.requests > 90)) { conn.close(1n, reason); break; }
          c.streams++;
          void handleStream(c, bi).finally(() => { c.streams--; });
        }
      } finally { clearTimeout(unauthenticatedTimer); }
    } catch { /* Protocol failures contain no user-facing SDK diagnostics. */ }
    finally { accepting--; if (c) { c.conn.close(0n, reason); connections.delete(c); report(); } }
  }

  const acceptLoop = (async () => {
    while (!closing) {
      const incoming = await ep.acceptNext(); if (!incoming) break;
      if (accepting >= 8) { await incoming.refuse(); continue; }
      void handleIncoming(incoming);
    }
  })();
  report();
  return {
    endpoint: ep,
    status: report,
    async invitation() {
      await deadline(ep.online(), 20_000);
      const invitation = { v: 1, endpointId: keyHex(ep.id()), ticket: EndpointTicket.fromAddr(ep.addr()).toString(), ...pairing.invite() };
      return { url: 'wispremote://pair?data=' + Buffer.from(JSON.stringify(invitation)).toString('base64url'), expiresAt: invitation.expiresAt };
    },
    async close() {
      closing = true; clearInterval(monitor); pairing.events.off('revoke', revoke); pairing.events.off('change', report);
      for (const c of connections) c.conn.close(0n, reason);
      await ep.close(); await acceptLoop;
    },
  };
}
