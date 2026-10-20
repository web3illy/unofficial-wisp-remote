// Development-only, loopback-only synthetic UI fixture. Never imports Wisp code.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = 4187;
const project = { id: '10000000-0000-4000-8000-000000000001', name: 'Field Notes', path: '/synthetic/Field Notes' };
const first = '20000000-0000-4000-8000-000000000001';
let sessions, views, scenario, projects, connectorEnabled, sandboxFixture;
const streams = new Map();
const attachments = new Map();
function reset(value = 'empty') {
  for (const responses of streams.values()) for (const response of responses) response.end();
  streams.clear();
  attachments.clear();
  scenario = value;
  sandboxFixture = { enabled: true, allowNetwork: false };
  connectorEnabled = new Map();
  projects = [project];
  sessions = [
    { id: first, title: 'New Chat', projectId: null, updatedAt: '2026-10-16T12:00:00Z', active: false },
    { id: '20000000-0000-4000-8000-000000000002', title: 'Weekend reading list and research notes', projectId: null, updatedAt: '2026-10-15T12:00:00Z', active: false },
    { id: '20000000-0000-4000-8000-000000000004', title: 'Detached project conversation', projectId: '10000000-0000-4000-8000-000000000002', updatedAt: '2026-10-13T12:00:00Z', active: false },
    { id: '20000000-0000-4000-8000-000000000003', title: 'A quiet place to think', projectId: project.id, updatedAt: '2026-10-14T12:00:00Z', active: false },
  ];
  const messages = value === 'empty' ? [] : [
    { id: 'user-fixture', role: 'user', text: 'Turn these notes into a clear plan.', attachments: [{ kind: 'file', filename: 'reading-notes.txt' }] },
    { id: 'assistant-fixture', role: 'assistant', text: '## A little more room to think\n\nStart with **one useful question**, then make time to explore it.\n\n- Read the notes\n- Pick the strongest idea\n- Write a short summary\n\n```javascript\nconst focus = "One thing at a time";\n```\n\n[Read more](https://example.com)', thinking: 'I will organize the notes by theme.', activities: [{ id: 'activity-fixture', type: 'fs.read', title: 'fs_read', status: 'done', detail: 'reading-notes.txt', text: 'A synthetic note used only for UI checks.' }] },
  ];
  views = new Map(sessions.map(session => [session.id, { session, messages: session.id === first ? messages : [], run: null, settings: { mode: 'auto', modelId: null, thinking: true } }]));
  if (value === 'approval') views.get(first).run = { id: 'run-fixture', state: 'awaiting_approval', activities: [], confirmation: { id: 'confirm-fixture', title: 'fs_write', description: 'Create a synthetic summary in notes.md.' } };
  if (value === 'long') views.get(first).messages.push(...Array.from({ length: 12 }, (_, i) => ({ id: `long-${i}`, role: i % 2 ? 'assistant' : 'user', text: `${i + 1}. A synthetic paragraph for checking scrolling and preserving reading position.\n\n${'Long content should wrap naturally. '.repeat(6)}` })));
}
reset();
const send = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
const publish = (id, kind, data) => { for (const response of streams.get(id) || []) response.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`); };
const server = http.createServer(async (request, response) => {
  if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(403).end(); return; }
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === '/preview') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Wisp Remote — Synthetic preview</title><style>body{margin:0;background:#272727;color:#fff;font:14px system-ui}header{padding:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}select,button{font:inherit;padding:6px}iframe{display:block;margin:0 auto;border:1px solid #555;border-radius:24px;background:#100f0d;max-width:100%}</style><header><strong>Synthetic preview · No Wisp connection</strong><label>Device <select id="size"><option value="390,844">390 × 844</option><option value="320,700">320 × 700</option><option value="430,932">430 × 932</option><option value="1024,768">1024 × 768</option></select></label><label>State <select id="state"><option>empty</option><option>chat</option><option>approval</option><option>long</option><option>offline</option></select></label><button id="reset">Reset</button></header><iframe id="phone" title="Mobile client" width="390" height="844" src="/"></iframe><script>const frame=document.querySelector('iframe');document.querySelector('#size').onchange=e=>{[frame.width,frame.height]=e.target.value.split(',')};document.querySelector('#reset').onclick=async()=>{await fetch('/fixture',{method:'POST',body:JSON.stringify({state:document.querySelector('#state').value})});frame.src='/'};document.querySelector('#state').onchange=()=>document.querySelector('#reset').click();</script></html>`); return;
    }
    let body = {};
    if (request.method !== 'GET') {
      if (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${port}`) { response.writeHead(403).end(); return; }
      let raw = ''; for await (const part of request) { raw += part; if (raw.length > 100_000) throw new Error('Fixture body limit'); }
      body = JSON.parse(raw || '{}');
    }
    if (url.pathname === '/fixture' && request.method === 'POST') { reset(['empty', 'chat', 'approval', 'long', 'offline'].includes(body.state) ? body.state : 'empty'); send(response, 200, { ok: true }); return; }
    if (url.pathname.startsWith('/bridge/')) {
      if (scenario === 'offline') { send(response, 503, { error: { code: 'wisp_offline', message: 'Wisp is not available. Open Wisp on your Mac, then try again.' } }); return; }
      if (url.pathname === '/bridge/profile') { send(response, 200, { displayName: 'Alex' }); return; }
      if (url.pathname === '/bridge/privacy' || url.pathname === '/bridge/privacy/refresh') {
        send(response, 200, { status: 'verified', measurements: { appId: { value: 'synthetic-app-id', match: true }, composeHash: { value: 'synthetic-compose-hash', match: true }, imageDigest: { value: 'sha256:synthetic-image', match: true }, mrtd: { value: 'synthetic-enclave-measurement', match: true } }, failedChecks: [], keyProvider: 'Synthetic fixture', tcbStatus: 'Up to date', quoteFingerprint: 'synthetic-quote-fingerprint', verifiedAt: '2026-10-16T17:00:00Z' }); return;
      }
      if (url.pathname === '/bridge/sandbox') {
        if (request.method === 'POST') {
          if (typeof body.enabled === 'boolean') sandboxFixture.enabled = body.enabled;
          else if (typeof body.allowNetwork === 'boolean' && sandboxFixture.enabled) sandboxFixture.allowNetwork = body.allowNetwork;
        }
        send(response, 200, sandboxFixture); return;
      }
      if (url.pathname === '/bridge/usage') {
        send(response, 200, {available:true,planName:'Wisp Pro',usage:{cycle:{percentUsed:34,resetsAt:'2026-11-01T00:00:00Z'},daily:{percentUsed:12,resetsAt:new Date(Date.now()+7200000).toISOString()},weekly:{percentUsed:27,resetsAt:new Date(Date.now()+172800000).toISOString()}}}); return;
      }
      if (url.pathname === '/bridge/bootstrap') { send(response, 200, { connection: { state: 'connected', runtimeVersion: '0.1.3' }, sessions, projects, selectedSessionId: first, modes: [{ id: 'balanced', label: 'Balanced', description: 'Optimal for everyday tasks' }, { id: 'auto', label: 'Advanced', description: 'Best models, for complex tasks' }, { id: 'model', label: 'More', description: 'Pick a specific model' }], models: [{ id: 'fixture-reasoning', label: 'Reasoning model', description: 'A synthetic model for interface checks' }, { id: 'fixture-fast', label: 'Fast model', description: 'A second synthetic model' }], preferences: { mode: 'auto', thinking: true }, capabilities: { models: true, modes: true, thinking: true, projects: true, approvals: true, attachments: true, connectors: true, projectRemoval: true, sessionRemoval: true }, sandbox: sandboxFixture }); return; }
      const removal = url.pathname.match(/^\/bridge\/projects\/([^/]+)\/remove$/);
      if (removal && request.method === 'POST') {
        const ids = sessions.filter(session => session.projectId === removal[1]).map(session => session.id);
        if (!Array.isArray(body.sessionIds) || ids.length !== body.sessionIds.length || !ids.every(id => body.sessionIds.includes(id))) { send(response, 409, {error:{code:'project_changed',message:'Project conversations changed. Review them again.'}}); return; }
        sessions = sessions.filter(session => !ids.includes(session.id));
        for (const id of ids) { views.delete(id); for (const stream of streams.get(id) || []) stream.end(); streams.delete(id); }
        send(response, 200, {removedSessionIds:ids,complete:true}); return;
      }
      if (url.pathname === '/bridge/events') {
        const id = url.searchParams.get('sessionId');
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        if (!streams.has(id)) streams.set(id, new Set()); streams.get(id).add(response);
        response.write(`event: snapshot\ndata: ${JSON.stringify(views.get(id))}\n\n`);
        const heartbeat = setInterval(() => response.write('event: ping\ndata: {}\n\n'), 3000);
        response.on('close', () => { clearInterval(heartbeat); streams.get(id)?.delete(response); }); return;
      }
      if (request.method === 'POST' && ['/bridge/sessions', '/bridge/projects'].includes(url.pathname)) {
        const newProject = url.pathname.endsWith('projects') ? { id: randomUUID(), name: body.name, path: '/synthetic/New Project' } : null;
        if (newProject) projects.push(newProject);
        const session = { id: randomUUID(), title: 'New Chat', projectId: newProject?.id || body.projectId || null, updatedAt: new Date().toISOString(), active: false }; sessions.unshift(session); views.set(session.id, { session, messages: [], run: null, settings: { mode: 'auto', thinking: true } }); send(response, 201, { session, ...(newProject ? { project: newProject } : {}) }); return;
      }
      if (url.pathname.startsWith('/bridge/attachments/') && request.method === 'POST') {
        const action = url.pathname.split('/').pop();
        if (action === 'begin') {
          const attachment = { id: randomUUID(), ...body };
          attachments.set(attachment.id, attachment);
          send(response, 201, attachment); return;
        }
        const attachment = attachments.get(body.id);
        if (!attachment) { send(response, 404, { error: { code: 'attachment_missing', message: 'Synthetic attachment expired.' } }); return; }
        if (action === 'remove') attachments.delete(body.id);
        send(response, 200, action === 'commit' ? attachment : { ok: true }); return;
      }
      const parts = url.pathname.split('/'); const view = views.get(parts[3]);
      if (parts[2] === 'sessions' && view) {
        if (parts[4] === 'remove' && request.method === 'POST') {
          const id = view.session.id;
          sessions = sessions.filter(session => session.id !== id); views.delete(id);
          for (const stream of streams.get(id) || []) stream.end(); streams.delete(id);
          send(response, 200, { removedSessionId: id }); return;
        }
        if (parts[4] === 'connectors') {
          if (request.method === 'POST') connectorEnabled.set(view.session.id, body.enabled);
          send(response, 200, { available: true, connectors: [
            { id: 'notes', label: 'Notes', status: 'connected', enabled: connectorEnabled.get(view.session.id) ?? true },
            { id: 'calendar', label: 'Calendar', status: 'requires_auth', enabled: false },
          ] }); return;
        }
        if (parts.length === 4 && request.method === 'GET') { send(response, 200, view); return; }
        if (parts.length === 4 && request.method === 'PATCH') { view.session.title = body.title; send(response, 200, { session: view.session }); return; }
        if (parts[4] === 'messages') {
          view.messages.push({ id: body.id, role: 'user', text: body.text, attachments: (body.attachments || []).map(id => attachments.get(id)).filter(Boolean) });
          view.run = { id: randomUUID(), state: 'running', text: '', activities: [{ id: 'reading', title: 'fs_read', status: 'running', detail: 'Synthetic notes' }] };
          send(response, 202, { accepted: true }); publish(view.session.id, 'snapshot', view);
          const answer = 'Here is a concise answer from the **synthetic preview**.\n\nThe real client uses the same controls and rendering for Wisp on your Mac.'; let cursor = 0;
          const timer = setInterval(() => { if (!view.run || view.run.state !== 'running') { clearInterval(timer); return; } cursor += 8; view.run.text = answer.slice(0, cursor); publish(view.session.id, 'run', view.run); if (cursor >= answer.length) { clearInterval(timer); view.messages.push({ id: view.run.id, role: 'assistant', text: answer, activities: [{ id: 'reading', title: 'fs_read', status: 'done', text: 'Synthetic check completed.' }] }); view.run = null; publish(view.session.id, 'complete', view); } }, 160); return;
        }
        if (parts[4] === 'cancel') { if (view.run) view.run.state = 'cancelled'; send(response, 200, { ok: true }); publish(view.session.id, 'snapshot', view); return; }
        if (parts[4] === 'confirmations') { view.run = null; send(response, 200, { ok: true }); publish(view.session.id, 'snapshot', view); return; }
      }
      send(response, 404, { error: { code: 'fixture_unavailable', message: 'This action is unavailable in the synthetic preview.' } }); return;
    }
    const path = url.pathname === '/' ? '/mobile.html' : url.pathname;
    if (!['/mobile.html', '/mobile.js', '/mobile.css', '/account-settings.js', '/account-settings.css'].includes(path) && !/^\/wisp-assets\/[a-zA-Z0-9_-]+\.(woff2|otf|svg|png)$/.test(path)) { response.writeHead(404).end(); return; }
    const data = await readFile(`${root}public${path}`);
    const ext = path.split('.').pop(); response.writeHead(200, { 'Content-Type': ({ html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2', otf: 'font/otf' })[ext], 'Cache-Control': 'no-store' }); response.end(data);
  } catch { send(response, 500, { error: { code: 'fixture_error', message: 'Synthetic preview request failed.' } }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Synthetic preview only: http://127.0.0.1:${port}/preview`));
