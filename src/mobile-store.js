import { readFile, mkdir, realpath, stat, writeFile, rename } from 'node:fs/promises';
import { join, basename, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './wisp-client.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_REGISTRY = join(homedir(), 'Library/Application Support/com.sergeykolesnikov.wisp-desktop/picked-project-dirs.json');
const STATE = new URL('../work/mobile-state.json', import.meta.url);
const MANAGED = new URL('../projects/', import.meta.url);

export function createProjectStore({ registry = DEFAULT_REGISTRY, stateFile = STATE, managed = MANAGED } = {}) {
  let state = { roots: [], settings: {}, preferredSession: null };
  let loaded = false;
  let mutation = Promise.resolve();
  async function init() {
    if (loaded) return;
    try { const parsed = JSON.parse(await readFile(stateFile, 'utf8')); if (Array.isArray(parsed.roots) && parsed.settings && typeof parsed.settings === 'object') state = parsed; } catch {}
    loaded = true;
  }
  async function persist() {
    const path = stateFile instanceof URL ? stateFile : resolve(stateFile);
    await mkdir(dirname(path instanceof URL ? path.pathname : path), { recursive: true });
    const temp = path instanceof URL ? new URL(`${path.pathname}.${randomUUID()}.tmp`, path) : `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await rename(temp, path);
  }
  async function roots() {
    await init(); let picked = [];
    try { const parsed = JSON.parse(await readFile(registry, 'utf8')); if (Array.isArray(parsed)) picked = parsed.filter(x => typeof x === 'string'); } catch {}
    const values = [...new Set(picked)].slice(0, 100);
    const result = [];
    for (const value of values) {
      try {
        const path = await realpath(value);
        if (!(await stat(path)).isDirectory()) continue;
        const id = (await readFile(join(path, '.wisp/project-id'), 'utf8')).split(/\r?\n/)[0].trim();
        if (UUID.test(id) && !result.some(x => x.id === id)) result.push({ id, name: basename(path), path });
      } catch {}
    }
    return result;
  }
  // Only append an already-created managed directory. Preserve all native picks
  // and keep a backup; never expose a path-writing API to the browser.
  async function registerNative(path) {
    let before;
    try { before = await readFile(registry, 'utf8'); } catch { return false; }
    let entries; try { entries = JSON.parse(before); } catch { return false; }
    if (!Array.isArray(entries) || entries.some(x => typeof x !== 'string')) return false;
    if (entries.includes(path)) return true;
    try { await writeFile(`${registry}.wisp-remote-backup`, before, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') return false; }
    if (await readFile(registry, 'utf8') !== before) return false;
    const temp = `${registry}.remote-${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify([...entries, path]), { mode: 0o600 }); await rename(temp, registry); return true; } catch { return false; }
  }
  return {
    roots,
    async create(name, anchor) {
      const work = mutation.then(async () => {
        await init();
        if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\x00-\x1f/\\]/.test(name) || /^\.+$/.test(name.trim())) throw new BridgeError(400, 'project_name', 'Enter a project name without slashes, up to 64 characters.');
        await mkdir(managed, { recursive: true });
        const root = await realpath(managed); const path = join(root, name.trim());
        try { await mkdir(path); } catch (e) { throw new BridgeError(e.code === 'EEXIST' ? 409 : 500, 'project_create', e.code === 'EEXIST' ? 'A project with this name already exists.' : 'Could not create the project folder.'); }
        const desktopRegistered = await registerNative(path);
        if (!desktopRegistered) throw new BridgeError(503, 'desktop_registration_failed', 'Could not register the project in Wisp on your Mac. The project folder was preserved.');
        const session = await anchor(path);
        return { project: { id: session.projectId, name: basename(path), path, desktopRegistered }, session };
      });
      mutation = work.catch(() => {}); return work;
    },
    async settings(id) { await init(); return state.settings[id] || { mode: 'auto', thinking: true }; },
    async setSettings(id, value) { await init(); state.settings[id] = value; await persist(); },
  };
}

export function plainContent(value) {
  if (typeof value === 'string') {
    if (value.trim().startsWith('[')) { try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return plainContent(parsed); } catch {} }
    return value;
  }
  if (Array.isArray(value)) return value.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('');
  return '';
}

export function attachmentMetadata(value) {
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((block, index) => {
    if (!block || typeof block !== 'object') return [];
    if (block.type === 'file' || block.type === 'pdf_text') {
      return [{ id: block.attachmentId || `attachment-${index}`, kind: block.type,
        filename: typeof block.filename === 'string' && block.filename ? block.filename : (block.type === 'pdf_text' ? 'Document.pdf' : 'File') }];
    }
    if (block.type === 'image_url' || block.type === 'image') {
      return [{ id: block.attachmentId || `attachment-${index}`, kind: 'image',
        filename: typeof block.filename === 'string' && block.filename ? block.filename : 'Image',
        mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg',
        ...(Number.isInteger(block.width) ? { width: block.width } : {}), ...(Number.isInteger(block.height) ? { height: block.height } : {}) }];
    }
    return [];
  });
}

export function normalizeMessages(raw = []) {
  const result = []; let assistant = null; const tools = new Map();
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i]; const role = m.role || m.type;
    if (role === 'human' || role === 'user') {
      const attachments = attachmentMetadata(m.content);
      assistant = null; result.push({ id: m.id || `message-${i}`, role: 'user', text: plainContent(m.content), ...(attachments.length ? { attachments } : {}) });
    } else if (['ai', 'assistant', 'tool'].includes(role)) {
      if (!assistant) { assistant = { id: m.id || `message-${i}`, role: 'assistant', text: '', activities: [] }; result.push(assistant); }
      if (role === 'tool') {
        const a = tools.get(m.toolCallId || m.tool_call_id);
        if (a) { a.status = m.status === 'error' ? 'error' : 'complete'; a.text = plainContent(m.content).slice(0, 50_000); }
      } else {
        const text = plainContent(m.content); if (text) assistant.text += `${assistant.text ? '\n\n' : ''}${text}`;
        if (typeof m.additional_kwargs?.reasoning_content === 'string') assistant.thinking = (assistant.thinking || '') + m.additional_kwargs.reasoning_content;
        for (const t of m.toolCalls || m.tool_calls || []) {
          const a = { id: t.id || `tool-${i}-${assistant.activities.length}`, type: 'tool', title: t.name || 'Tool', status: 'complete', detail: JSON.stringify(t.args || {}, null, 2).slice(0, 12_000) };
          assistant.activities.push(a); tools.set(t.id, a);
        }
      }
    }
  }
  return result;
}

export function modelPreference({ mode = 'auto', modelId, thinking = true }) {
  if (mode === 'balanced') return thinking ? 'tier:thinking:balanced' : 'tier:balanced';
  if (mode === 'model' && modelId) return thinking ? `tier:thinking:${modelId}` : modelId;
  return thinking ? 'tier:thinking' : undefined;
}
