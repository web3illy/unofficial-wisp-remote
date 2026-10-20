import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class BridgeError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const offline = () => new BridgeError(503, 'wisp_offline', 'Open Wisp on your Mac to continue.');

// Discovery is consumed inside the Mac process only. Never return the record or
// pass a native response/error object into public responses or diagnostic logs.
export function createWispClient({ home = process.env.WISP_HOME || join(homedir(), '.wisp'), transport = fetch } = {}) {
  async function connection() {
    let record;
    try {
      const file = join(home, 'runtime.lock');
      const info = await stat(file);
      if (!info.isFile() || info.size > 8192 || (info.mode & 0o077)) throw offline();
      record = JSON.parse(await readFile(file, 'utf8'));
      if (typeof record.token !== 'string' || record.token.length < 32 || record.token.length > 4096 ||
          record.kind !== 'desktop' || !Number.isSafeInteger(record.pid) || record.pid < 1) throw offline();
      process.kill(record.pid, 0);
      const url = new URL(record.url);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
          url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw offline();
      if (record.version !== '0.1.3') throw new BridgeError(503, 'version_changed', 'The Wisp version has changed. Compatibility must be verified before connecting.');
      return { url: url.origin, token: record.token, version: record.version };
    } catch (error) { throw error instanceof BridgeError ? error : offline(); }
  }

  async function request(path, { method = 'GET', body, signal, stream = false } = {}) {
    if (!/^\/(?:v1|api)\//.test(path) || path.includes('://')) throw new BridgeError(500, 'route', 'Invalid internal route.');
    const record = await connection();
    let response;
    try {
      response = await transport(record.url + path, {
        method, redirect: 'error', signal: signal || AbortSignal.timeout(stream ? 3_600_000 : 12_000),
        headers: { Authorization: `Bearer ${record.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      if (method === 'POST' && stream) throw new BridgeError(503, 'delivery_unknown', 'Message delivery is unconfirmed. Check the chat status; resending is blocked.');
      throw offline();
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (method === 'POST' && stream && response.status >= 500) throw new BridgeError(503, 'delivery_unknown', 'Wisp has not confirmed message delivery. Check the chat status.');
      const status = [400, 404, 409, 429].includes(response.status) ? response.status : 503;
      const message = status === 409 ? 'A task is already running in this chat.' : status === 404 ? 'This chat or action is no longer available.' : 'Wisp could not complete the request. Check the app on your Mac.';
      throw new BridgeError(status, status === 409 ? 'busy' : 'wisp_request_failed', message);
    }
    if (stream) return response;
    if (response.status === 204) return null;
    const reader = response.body.getReader();
    // Native history includes inline file/PDF text; it is normalized/redacted
    // before reaching the phone. Keep a separate bounded Mac-side allowance.
    const responseLimit = /^\/v1\/sessions\/[0-9a-f-]+\/history(?:\?|$)/i.test(path) ? 64 * 1024 * 1024 : 8_000_000;
    let size = 0; const chunks = [];
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > responseLimit) { await reader.cancel(); throw new BridgeError(502, 'history_large', 'This history is too large for the current client.'); }
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BridgeError(502, 'wisp_format', 'Could not read the Wisp response.'); }
  }
  return { request, version: async () => (await connection()).version };
}

export async function* readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      if (buffer.length > 64 * 1024 * 1024) throw new BridgeError(502, 'event_large', 'The Wisp event is too large.');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        let event = 'message', id = '', data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length) { try { yield { event, id, data: JSON.parse(data.join('\n')) }; } catch (e) { if (e instanceof BridgeError) throw e; } }
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
}
