import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../public/mobile.js', import.meta.url), 'utf8');

// Small DOM double: tests exercise the real state transitions, not a second client.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } }; this.hidden = false; this.value = ''; this.scrollTop = 0;
    this.clientHeight = 400; this.scrollHeight = 800; this.parentNode = null;
    this.listeners = new Map(); this.attributes = new Map(); this.textContent = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  append(...items) { for (const item of items) { item.parentNode = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  insertBefore(item, next) { item.remove(); const index = next ? this.children.indexOf(next) : this.children.length; this.children.splice(index, 0, item); item.parentNode = this; }
  remove() { if (this.parentNode) { const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; } }
  get lastElementChild() { return this.children.at(-1); }
  get isConnected() { return Boolean(this.parentNode); }
  contains(item) { return item === this || this.children.some(child => child.contains(item)); }
  closest() { return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY', 'PRE', 'CODE'].includes(this.tagName) ? this : this.parentNode?.closest() || null; }
  getBoundingClientRect() { return { width: 320, bottom: 44 }; }
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
  focus() {}
  select() {}
  blur() { this.blurred = true; }
  scrollTo({ top }) { this.scrollTop = top; }
}

function harness() {
  const elements = new Map(), timers = new Map(), posts = [], intervals = [], documentEvents = new Map(), windowEvents = new Map();
  const document = {
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); },
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    createTextNode: text => Object.assign(new Element('#text'), { textContent: text }),
    addEventListener(type, fn) { documentEvents.set(type, fn); },
    querySelectorAll() { return []; },
    documentElement: new Element('html'), hidden: false,
  };
  let nextTimer = 0;
  const window = {
    addEventListener(type, fn) { if (!windowEvents.has(type)) windowEvents.set(type, new Set()); windowEvents.get(type).add(fn); },
    removeEventListener(type, fn) { windowEvents.get(type)?.delete(fn); },
    matchMedia(query) { return { matches: query === "(max-width: 760px)", addEventListener() {} }; },
    webkit: { messageHandlers: { wisp: { async postMessage(packet) { posts.push(packet); return { ok: false }; } } } },
  };
  const context = vm.createContext({ document, window, crypto: webcrypto, Uint8Array, URL, btoa, atob,
    requestAnimationFrame: fn => fn(), setInterval(fn) { intervals.push(fn); },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source.replace('initializeInterface();\nstart();', ''), context);
  return { context, elements, posts, timers, intervals, document, windowEvents, documentEvents,
    emit(type, detail) { for (const fn of windowEvents.get(type) || []) fn({ detail }); },
    run: code => vm.runInContext(code, context), element: id => document.querySelector(`#${id}`) };
}

test('chat switches isolate text, attachment references and unknown-delivery IDs in memory', async () => {
  const h = harness();
  h.run(`
    renderAttachmentChips = () => {}; resizeInput = () => {}; setNotice = () => {};
    openDrawer = () => {}; renderSidebar = () => {}; closeStream = () => {}; openStream = () => {};
    loadSession = async () => {};
    state.selectedId = 'chat-a'; input.value = 'draft A';
    state.attachments = [{id:'attachment-a'}];
    state.optimistic = {id:'same-message-id',text:'draft A'}; state.pendingUnknown = true;
  `);
  await h.run(`selectSession('chat-b')`);
  assert.equal(h.element('message').value, '');
  assert.equal(h.run('state.attachments.length'), 0);
  assert.equal(h.run('state.pendingUnknown'), false);
  h.element('message').value = 'draft B';
  await h.run(`selectSession('chat-a')`);
  assert.equal(h.element('message').value, 'draft A');
  assert.equal(h.run('state.attachments[0].id'), 'attachment-a');
  assert.equal(h.run('state.optimistic.id'), 'same-message-id');
  assert.equal(h.run('state.pendingUnknown'), true);
  assert.equal(h.posts.length, 0, 'Switching never deletes or transmits a draft');
});

test('navigation waits for an in-flight mutation or upload', async () => {
  const h = harness(); h.run(`setNotice = () => {}; state.selectedId = 'chat-a'; state.working = true;`);
  await h.run(`selectSession('chat-b')`); assert.equal(h.run('state.selectedId'), 'chat-a');
  h.run('state.working = false; state.uploading = true;');
  await h.run(`selectSession('chat-b')`); assert.equal(h.run('state.selectedId'), 'chat-a');
});

test('idle refresh and streamed tokens retain history DOM and reading position', () => {
  const h = harness();
  h.run(`updateControls = () => {}; state.loading = false; state.selectedId = 'chat-a'; state.stickToBottom = false;
    state.view = {messages:[{id:'answer',role:'assistant',text:'A useful answer',thinking:'Thoughts'}],run:null};
    renderMessages();`);
  const first = h.element('messages').children[0];
  first.children[0].open = true;
  h.element('chat').scrollTop = 95;
  h.run('renderMessages();');
  assert.strictEqual(h.element('messages').children[0], first);
  h.run(`state.view.run = {id:'run',state:'running',text:'Next'}; renderMessages(); scrollToBottom();`);
  assert.strictEqual(h.element('messages').children[0], first);
  assert.equal(first.children[0].open, true);
  assert.equal(h.element('chat').scrollTop, 95);
  h.run('scrollToBottom(true);'); assert.equal(h.element('chat').scrollTop, 800);
});

test('a confirmed unknown delivery clears the stale composer without generating a new ID', () => {
  const h = harness();
  h.run(`updateControls = () => {}; resizeInput = () => {}; renderAttachmentChips = () => {};
    state.loading = false; input.value = 'sent'; state.attachments = [{id:'attachment'}];
    state.optimistic = {id:'message-a',text:'sent'}; state.pendingUnknown = true;
    state.view = {messages:[{id:'message-a',role:'user',text:'sent'}]}; renderMessages();`);
  assert.equal(h.element('message').value, '');
  assert.equal(h.run('state.pendingUnknown'), false);
  assert.equal(h.run('state.attachments.length'), 0);
  assert.equal(h.posts.length, 0);
});

test('failed initial native subscription retries, and closing cancels the retry', async () => {
  const h = harness(); h.run(`setConnection = () => {}; setNotice = () => {}; state.selectedId = 'chat-a'; openStream();`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.timers.size, 1);
  const callback = [...h.timers.values()][0]; callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.posts.filter(packet => packet.kind === 'subscribe').length, 2);
  h.run('closeStream();');
  assert.equal(h.timers.size, 0);
});

test('a stale EventSource cannot replace the selected chat', () => {
  const h = harness(); const sources = [];
  h.context.EventSource = class { constructor() { this.listeners = {}; sources.push(this); } addEventListener(name, fn) { this.listeners[name] = fn; } close() {} };
  h.run(`window.webkit = null; state.selectedId = 'chat-a'; openStream(); state.selectedId = 'chat-b'; openStream(); state.view = {session:{id:'chat-b'}};`);
  sources[0].listeners.snapshot({ data: JSON.stringify({ session: { id: 'chat-a' } }) });
  assert.equal(h.run('state.view.session.id'), 'chat-b');
});


test('recovery from an initial offline launch opens a stream after discovering the first chat', async () => {
  const h = harness();
  h.run(`state.selectedId = null; state.source = null;
    loadBootstrap = async () => { state.selectedId = 'recovered-chat'; return true; };
    loadSession = async id => { if (id !== 'recovered-chat') throw Error('Wrong recovery order'); };
    openStream = () => { state.source = { recovered: true }; };`);
  await h.run('refreshConnection()');
  assert.equal(h.run('state.source.recovered'), true);
});

test('cold launch opens a local New Chat before bootstrap and never loads the saved chat', async () => {
  const h = harness(), requests = [];
  let finishBootstrap;
  h.context.fixture = (path, options) => {
    requests.push({path, method: options?.method || 'GET'});
    if (path === '/bridge/bootstrap') return new Promise(resolve => { finishBootstrap = resolve; });
    throw new Error(`Unexpected request: ${path}`);
  };
  h.run(`request=fixture; loadProfile=async()=>{}; openStream=()=>{globalThis.streamOpened=true;};`);
  const starting = h.run('start()');
  assert.equal(h.run('state.draftActive'), true);
  assert.equal(h.run('state.selectedId'), null);
  assert.equal(h.element('chat-title').textContent, 'New Chat');
  assert.equal(h.element('new-chat-top').disabled, true);
  await new Promise(resolve => setImmediate(resolve));
  finishBootstrap({connection:{state:'connected'},selectedSessionId:'old-chat',sessions:[{id:'old-chat',title:'Old Chat'}],projects:[]});
  await starting;
  assert.equal(h.run('state.draftActive'), true);
  assert.equal(h.run('state.selectedId'), null);
  assert.equal(h.run('globalThis.streamOpened'), undefined);
  assert.deepEqual(requests, [{path:'/bridge/bootstrap',method:'GET'}]);
});

test('foreground resume preserves the selected chat and its unsent text', async () => {
  const h = harness(), requests = [];
  h.context.fixture = async (path, options) => {
    requests.push({path, method: options?.method || 'GET'});
    if (path === '/bridge/bootstrap') return {
      connection:{state:'connected'}, selectedSessionId:'server-choice',
      sessions:[{id:'chosen-chat',title:'Chosen Chat'},{id:'server-choice',title:'Server Choice'}], projects:[],
    };
    throw new Error(`Unexpected request: ${path}`);
  };
  h.run(`
    request=fixture; loadProfile=async()=>{}; openStream=()=>{};
    state.bootstrap={connection:{state:'connected'},sessions:[{id:'chosen-chat',title:'Chosen Chat'}]};
    state.bootstrapValid=true; state.selectedId='chosen-chat'; state.view={session:{id:'chosen-chat'},messages:[]};
    input.value='Keep this unsent'; resumeConnection();
  `);
  await h.run('state.refreshPromise');
  assert.equal(h.run('state.selectedId'), 'chosen-chat');
  assert.equal(h.run('state.draftActive'), false);
  assert.equal(h.element('message').value, 'Keep this unsent');
  assert.deepEqual(requests, [{path:'/bridge/bootstrap',method:'GET'}]);
});

test('slow startup coalesces timer and focus refreshes and uses one stream snapshot for history', async () => {
  const h = harness();
  h.run(`
    window.webkit.messageHandlers.wisp.postMessage = packet => {
      if (packet.kind === 'request' && packet.path === '/bridge/bootstrap') {
        bootstrapCalls = (globalThis.bootstrapCalls || 0) + 1;
        return new Promise(resolve => { globalThis.finishBootstrap = resolve; });
      }
      if (packet.kind === 'request' && packet.path.includes('/bridge/sessions/')) throw Error('Duplicate history hydration');
      if (packet.kind === 'subscribe') globalThis.openSubscription = packet.subscription;
      return Promise.resolve({ok:true,body:{}});
    };
  `);
  const first = h.run('refreshConnection()');
  const second = h.run('refreshConnection()');
  h.intervals[0](); h.emit('focus');
  assert.strictEqual(first, second);
  assert.equal(h.run('bootstrapCalls'), 1);
  h.run(`finishBootstrap({ok:true,body:{connection:{state:'connected'},sessions:[{id:'chat-a',title:'Hello'}],projects:[]}})`);
  await first;
  assert.equal(h.run('state.selectedId'), 'chat-a');
  assert.equal(h.run('state.phase'), 'history');
  assert.equal(h.run('uiReady()'), false);
  assert.equal(h.run('state.loading'), true);
  h.emit('wisp-remote-event', {subscription:h.run('openSubscription'),event:'snapshot',data:{session:{id:'chat-a'},messages:[],settings:{thinking:false}}});
  assert.equal(h.run('uiReady()'), true);
  assert.equal(h.run('state.settings.thinking'), false);
  assert.equal(h.element('connection').textContent, 'Connected');
});

test('Mac readiness needs both snapshot and acknowledgement and is cleared on background', async () => {
  const h = harness();
  h.run(`
    state.bootstrap={connection:{state:'connected'},sessions:[]}; state.bootstrapValid=true; state.selectedId='chat-a';
    window.webkit.messageHandlers.wisp.postMessage = packet => {
      if (packet.kind === 'subscribe') return new Promise(resolve => { globalThis.acknowledge = resolve; });
      return Promise.resolve({ok:true});
    };
    openStream();
    applyStreamData('snapshot',{session:{id:'chat-a'},messages:[],settings:{}});
  `);
  assert.equal(h.run('uiReady()'), false, 'Snapshot before acknowledgement cannot turn green');
  h.run('acknowledge({ok:true})');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.run('uiReady()'), true);
  h.document.hidden = true;
  h.documentEvents.get('visibilitychange')();
  assert.equal(h.run('uiReady()'), false);
  assert.equal(h.run('state.source'), null);
  h.document.hidden = false;
  assert.equal(h.run('uiReady()'), false, 'Foreground requires fresh validation');
});

test('open drawer keeps header usable and only blocks chat/composer behind it', () => {
  const h = harness();
  for (const id of ['project-dialog','remove-project-dialog','remove-session-dialog','rename-dialog','settings-dialog','account-settings-dialog','feature-dialog']) h.element(id).hidden = true;
  h.run('openDrawer(true)');
  assert.equal(h.element('app').inert, false);
  assert.equal(h.elements.get('.workspace').inert, false);
  assert.equal(h.element('chat').inert, true);
  assert.equal(h.element('open-sidebar').attributes.get('aria-expanded'), 'true');
  assert.equal(h.element('open-sidebar').attributes.get('aria-label'), 'Close conversations');
  h.run('openDrawer(false)');
  assert.equal(h.element('chat').inert, false);
  assert.equal(h.element('sidebar').inert, true);
});

test('header New Chat opens an idempotent local draft and bootstrap cannot replace it', async () => {
  const h = harness(), requests = [];
  h.context.captureRequest = (path, options) => requests.push({path,options});
  h.run(`
    state.bootstrap={connection:{state:'connected'},sessions:[{id:'old',title:'Old',projectId:'project'}]};
    state.selectedId='old'; state.selectedProjectId='project';
    request=async (path,options) => { captureRequest(path,options); return {session:{id:'new',title:'New Chat',projectId:null}}; };
    openStream=()=>{}; state.view={session:state.bootstrap.sessions[0],messages:[]};
  `);
  await h.element('new-chat-top').listeners.get('click')();
  assert.equal(requests.length, 0);
  assert.equal(h.run('state.selectedId'), null);
  assert.equal(h.run('state.draftActive'), true);
  assert.equal(h.run('state.selectedProjectId'), null);
  h.element('message').value = 'Unsent draft';
  await h.run('createSession()');
  assert.equal(h.element('message').value, 'Unsent draft');
  assert.equal(requests.length, 0);
  h.run(`request=async()=>({connection:{state:'connected'},sessions:[{id:'old'}],selectedSessionId:'old'});`);
  await h.run('loadBootstrap({quiet:true})');
  assert.equal(h.run('state.selectedId'), null);
  assert.equal(h.run('state.draftActive'), true);
  assert.equal(h.element('new-chat-top').disabled, true);
});

test('optional name is rendered as text and theme toggle changes appearance without opening settings', async () => {
  const h = harness();
  h.run(`request=async()=>({displayName:'Alex <img src=x>'});`);
  await h.run('loadProfile()');
  assert.match(h.element('greeting').textContent, /Alex <img src=x> ✋$/);
  assert.equal(h.element('greeting').children.length, 0);
  h.run('applyTheme("dark")');
  h.element('toggle-theme').listeners.get('click')();
  assert.equal(h.document.documentElement.dataset.theme, 'light');
  assert.equal(h.element('toggle-theme').attributes.get('aria-label'), 'Switch to dark theme');
});

test('a failed first event stream does not suppress bootstrap recovery forever', async () => {
  const h = harness(), sources = [];
  h.context.EventSource = class { constructor() { this.listeners={};sources.push(this); } addEventListener(name,fn) { this.listeners[name]=fn; } close() {} };
  h.run(`
    window.webkit=null;
    state.bootstrap={connection:{state:'connected'},sessions:[{id:'a'}]};state.bootstrapValid=true;state.selectedId='a';
    openStream(); globalThis.bootstrapRecoveries=0;
    loadBootstrap=async()=>{bootstrapRecoveries++;return false;};
  `);
  await h.run('refreshConnection()');
  assert.equal(h.run('bootstrapRecoveries'), 0, 'Initial snapshot is not duplicated');
  sources[0].listeners.error();
  await h.run('refreshConnection()');
  assert.equal(h.run('bootstrapRecoveries'), 1, 'Stream failure permits the ordinary recovery path');
});

test('first send materializes one chat and dismisses keyboard; repeated send cannot duplicate creation', async () => {
  const h = harness(), requests = [];
  h.context.record = (path, options) => requests.push({path, body: options?.body && JSON.parse(options.body)});
  h.run(`
    state.bootstrap={connection:{state:'connected'},sessions:[]}; state.bootstrapValid=true;
    state.draftActive=true; state.draftId=uuid(); state.loading=false; input.value='Hello';
    request=async(path, options)=>{
      record(path,options);
      if(path==='/bridge/sessions') return new Promise(resolve=>{globalThis.created=resolve;});
      return {accepted:true};
    };
    loadSession=async()=>{}; openStream=()=>{};
  `);
  const first = h.run('sendMessage()');
  await h.run('sendMessage()');
  assert.equal(requests.length, 1);
  assert.equal(h.element('message').blurred, true);
  h.run(`created({session:{id:'created-chat',title:'New Chat',projectId:null}})`);
  await first;
  assert.deepEqual(requests.map(item=>item.path), ['/bridge/sessions','/bridge/sessions/created-chat/messages']);
  assert.equal(requests[1].body.text, 'Hello');
  assert.equal(h.run('state.draftActive'), false);
  assert.equal(h.element('message').value, '');
});

test('unsent draft attachments remain local until first send and upload to its new chat', async () => {
  const h = harness(), requests=[];
  h.context.record=(path,options)=>requests.push({path,body:options?.body && JSON.parse(options.body)});
  h.run(`
    state.bootstrap={connection:{state:'connected'},sessions:[]};state.bootstrapValid=true;
    state.draftActive=true;state.draftId=uuid();state.loading=false;
    request=async(path,options)=>{
      record(path,options);
      if(path==='/bridge/sessions')return{session:{id:'new',title:'New Chat'}};
      if(path==='/bridge/attachments/begin')return{id:'uploaded'};
      if(path==='/bridge/attachments/commit')return{id:'uploaded',kind:'file',filename:'note.txt'};
      return{accepted:true};
    };
    loadSession=async()=>{};openStream=()=>{};
  `);
  await h.run(`uploadPrepared({kind:'file',filename:'note.txt',size:2},new Uint8Array([65,66]))`);
  assert.equal(requests.length,0);
  assert.equal(h.run('state.attachments[0].local'),true);
  await h.run('sendMessage()');
  assert.deepEqual(requests.map(item=>item.path),['/bridge/sessions','/bridge/attachments/begin','/bridge/attachments/chunk','/bridge/attachments/commit','/bridge/sessions/new/messages']);
  assert.equal(requests[1].body.sessionId,'new');
  assert.deepEqual(requests.at(-1).body.attachments,['uploaded']);
});

test('a lost create acknowledgement blocks automatic repeat creation and preserves typed text',async()=>{
  const h=harness();
  h.run(`state.bootstrap={connection:{state:'connected'},sessions:[]};state.bootstrapValid=true;
    state.draftActive=true;state.loading=false;input.value='Keep this';globalThis.creates=0;
    request=async()=>{creates++;throw new Error('Lost acknowledgement');};`);
  await h.run('sendMessage()');await h.run('sendMessage()');
  assert.equal(h.run('creates'),1);assert.equal(h.run('state.creationUnknown'),true);
  assert.equal(h.element('message').value,'Keep this');
  assert.match(h.element('notice').textContent,/Chat creation could not be confirmed/);
});

test('production-shaped native or Mac creation failures cannot replay a create request',async()=>{
  for(const [code,status] of [['delivery_unknown',409],['disconnected',503],['transport_error',503],['wisp_offline',503]]){
    const h=harness();
    h.context.failure={ok:false,status,error:{code,message:'Safe connection failure'}};
    h.run(`state.bootstrap={connection:{state:'connected'},sessions:[]};state.bootstrapValid=true;
      state.draftActive=true;state.loading=false;input.value='Keep first message';globalThis.creates=0;
      window.webkit.messageHandlers.wisp.postMessage=async packet=>{
        if(packet.kind==='request'&&packet.path==='/bridge/sessions'){creates++;return failure;}
        return{ok:true};
      };`);
    await h.run('sendMessage()');await h.run('sendMessage()');
    assert.equal(h.run('creates'),1,code);
    assert.equal(h.run('state.creationUnknown'),true,code);
    assert.equal(h.element('message').value,'Keep first message',code);
    assert.match(h.element('notice').textContent,/Chat creation could not be confirmed/,code);
  }
});

test('draft survives visiting another chat and returning without creating anything',async()=>{
  const h=harness();
  h.run(`state.bootstrap={connection:{state:'connected'},sessions:[]};state.bootstrapValid=true;
    openStream=()=>{};state.draftActive=true;state.draftId=uuid();input.value='Draft text';state.loading=false;`);
  await h.run(`selectSession('existing')`);
  await h.run('createSession()');
  assert.equal(h.element('message').value,'Draft text');
  assert.equal(h.run('state.selectedId'),null);
  assert.equal(h.posts.filter(packet=>packet.kind==='request').length,0);
});

test('send pointerdown preserves focus until submit; keyboard click submits once',async()=>{
  const h=harness();let prevented=false;
  h.document.activeElement=h.element('message');h.element('send').disabled=false;
  h.element('send').listeners.get('pointerdown')({button:0,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(h.element('message').blurred,undefined);
  h.run('globalThis.sends=0;sendMessage=()=>{sends++;};');
  h.element('composer').listeners.get('submit')({preventDefault(){}});
  assert.equal(h.run('sends'),1);
});

test('both message roles have icon copy controls using the native clipboard bridge',async()=>{
  const h=harness();
  h.run(`window.webkit.messageHandlers.wisp.postMessage=async packet=>{globalThis.copied=packet;return{ok:true};};`);
  for(const role of ['user','assistant']){
    const article=h.run(`messageNode({id:'one',role:'${role}',text:'Copy exactly this'})`);
    const button=article.children.at(-1);
    assert.equal(button.textContent,'');assert.equal(button.children[0].tagName,'SVG');
    await button.listeners.get('click')();
    assert.equal(h.run('copied.kind'),'copyText');assert.equal(h.run('copied.text'),'Copy exactly this');
    assert.equal(button.attributes.get('aria-label'),'Copied');
  }
});

test('background Wisp failures appear in header without covering the composer',async()=>{
  const h=harness();
  h.element('notice').hidden=true;
  h.run(`request=async()=>{const error=new Error('Request not completed');error.code='wisp_offline';throw error;};`);
  await h.run('loadBootstrap()');
  assert.equal(h.element('notice').hidden,true);
  assert.equal(h.element('connection').textContent,'Open Wisp on your Mac');
});

test('privacy fields render as text, unknown status never appears verified',()=>{
  const h=harness();
  h.run(`renderPrivacy({status:'made-up',measurements:{appId:{value:'<script>no</script>',match:false}},failedChecks:[]});`);
  assert.equal(h.element('privacy-verdict').dataset.state,'unavailable');
  const value = h.element('privacy-fields').children[0].children[0].children[1];
  assert.equal(value.textContent,'<script>no</script>');
  assert.equal(value.children.length,0);
  assert.equal(h.element('privacy-measurements').hidden,true);
  assert.equal(h.element('privacy-refresh').hidden,true);
});


test('privacy success has expandable measurements and only failures offer the original retry', () => {
  const h = harness();
  h.run(`renderPrivacy({status:'verified',measurements:{appId:{value:'synthetic',match:true}},failedChecks:[]});`);
  assert.equal(h.element('privacy-measurements').hidden, false);
  assert.equal(h.element('privacy-verdict').hidden, true);
  assert.equal(h.element('privacy-refresh').hidden, true);
  h.run(`renderPrivacy({status:'failed',measurements:{},failedChecks:['nonce_freshness']});`);
  assert.equal(h.element('privacy-measurements').hidden, true);
  assert.equal(h.element('privacy-verdict').hidden, false);
  assert.equal(h.element('privacy-refresh').hidden, false);
  assert.equal(h.element('privacy-failures').children[1].children[0].textContent, 'Nonce freshness');
});

test('sandbox sends one explicit mode after a fresh read and never exposes network changes', async () => {
  const h = harness(), requests = [];
  let finish;
  h.context.readSandbox = () => new Promise(resolve => { finish = resolve; });
  h.context.capture = (path, options) => requests.push([path, options]);
  h.run(`state.phase='ready';state.bootstrap={sandbox:{enabled:true,allowNetwork:false}};
    renderComposerOptions=()=>{}; request=async(path,options)=>{capture(path,options);if(options)return {enabled:false,allowNetwork:false};return readSandbox()};`);
  const first = h.run('toggleSandbox()');
  await h.run('toggleSandbox()');
  assert.equal(requests.length, 1);
  finish({enabled:true,allowNetwork:false}); await first;
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1][1].body), {enabled:false});
  assert.equal(h.run('state.bootstrap.sandbox.enabled'), false);
  assert.equal(h.run('state.sandboxBusy'), false);
});

test('sandbox uncertain write reconciles with a read and does not replay the mutation', async () => {
  const h = harness();let writes=0, reads=0;
  h.context.fixture = async (_, options) => {
    if (options) { writes++; throw Object.assign(new Error('lost'), {code:'sandbox_write_unknown'}); }
    return {enabled: ++reads === 1, allowNetwork:false};
  };
  h.run(`state.phase='ready';state.bootstrap={sandbox:{enabled:true,allowNetwork:false}};
    renderComposerOptions=()=>{};request=fixture;`);
  await h.run('toggleSandbox()');
  assert.equal(writes,1);assert.equal(reads,2);
  assert.equal(h.run('state.bootstrap.sandbox.enabled'),false);
  assert.match(h.element('notice').textContent,/Could not confirm/);
});

test('a bootstrap started before a sandbox change cannot overwrite its confirmed state', async () => {
  const h=harness();let release;
  h.context.waitForBootstrap=()=>new Promise(resolve=>{release=resolve});
  h.run(`state.phase='ready';state.bootstrap={sandbox:{enabled:true,allowNetwork:false}};
    request=waitForBootstrap;renderComposerOptions=()=>{};renderSidebar=()=>{};setConnection=()=>{};`);
  const pending=h.run('loadBootstrap({quiet:true})');
  h.run('applySandbox({enabled:false,allowNetwork:false})');
  release({connection:{state:'connected'},sessions:[],sandbox:{enabled:true,allowNetwork:false}});
  await pending;
  assert.equal(h.run('state.bootstrap.sandbox.enabled'),false);
});

test('both native WebViews keep fixed zoom and suppress browser link previews', () => {
  const html=readFileSync(new URL('../public/mobile.html',import.meta.url),'utf8');
  const swift=readFileSync(new URL('../native/App/RemoteWebView.swift',import.meta.url),'utf8');
  assert.match(html,/minimum-scale=1, maximum-scale=1, user-scalable=no/);
  assert.equal((swift.match(/configuration\.ignoresViewportScaleLimits = false/g)||[]).length,2);
  assert.equal((swift.match(/pinchGestureRecognizer\?\.isEnabled = false/g)||[]).length,2);
  assert.equal((swift.match(/webView\.allowsLinkPreview = false/g)||[]).length,2);
});


test('a confirmed sandbox retry clears its old error but preserves an unrelated notice', async () => {
  const h = harness(); let fail = true; let enabled = true;
  h.context.fixture = async (_, options) => {
    if (options) {
      if (fail) throw Object.assign(new Error('lost'), {code:'sandbox_write_unknown'});
      enabled = JSON.parse(options.body).enabled;
    }
    return {enabled,allowNetwork:false};
  };
  h.run(`state.phase='ready';state.bootstrap={sandbox:{enabled:true,allowNetwork:false}};
    renderComposerOptions=()=>{};request=fixture;`);
  await h.run('toggleSandbox()');
  assert.equal(h.run('state.noticeSource'), 'sandbox');
  fail = false;
  await h.run('toggleSandbox()');
  assert.equal(h.element('notice').hidden, true);
  h.run('setNotice("Attachment upload failed.", true)');
  await h.run('toggleSandbox()');
  assert.equal(h.element('notice').textContent, 'Attachment upload failed.');
});

test('Sandbox becomes interactive as soon as the initial stream is ready and disables on disconnect', () => {
  const h = harness();
  h.run(`state.phase='history'; state.bootstrapValid=true;
    state.bootstrap={connection:{state:'connected'},sandbox:{enabled:true,allowNetwork:false}};
    state.selectedId='chat-a'; state.streamSnapshot=false;state.streamAcknowledged=false;
    renderComposerOptions();`);
  assert.equal(h.element('sandbox-status').disabled, true);
  h.run(`state.streamSnapshot=true;state.streamAcknowledged=true;state.lastStreamEvent=Date.now();updateReadiness();`);
  assert.equal(h.run('state.phase'), 'ready');
  assert.equal(h.element('sandbox-status').disabled, false);
  h.run(`state.sandboxBusy=true;updateControls();`);
  assert.equal(h.element('sandbox-status').disabled, true);
  h.run(`state.sandboxBusy=false;state.bootstrapValid=false;updateControls();`);
  assert.equal(h.element('sandbox-status').disabled, true);
});


test('Settings uses the shared sandbox mutation and synchronizes the composer for either field', async () => {
  const h=harness(), writes=[];let value={enabled:true,allowNetwork:false};
  h.context.fixture=async(_,options)=>{if(options){const patch=JSON.parse(options.body);writes.push(patch);value={...value,...patch};}return value;};
  h.run(`state.phase='ready';state.bootstrap={sandbox:{enabled:true,allowNetwork:false}};renderComposerOptions=()=>{};request=fixture;`);
  await h.run('changeSandbox("allowNetwork",true)');
  assert.deepEqual(writes,[{allowNetwork:true}]);
  assert.equal(h.run('state.bootstrap.sandbox.allowNetwork'),true);
  await h.run('changeSandbox("enabled",false)');
  assert.deepEqual(writes,[{allowNetwork:true},{enabled:false}]);
  assert.equal(h.run('state.bootstrap.sandbox.enabled'),false);
  assert.equal(h.run('state.bootstrap.sandbox.allowNetwork'),true);
  await assert.rejects(h.run('changeSandbox("allowNetwork",false)'));
  assert.equal(writes.length,2);
});

test('reopening Settings waits for a pending sandbox write before fetching fresh state', async () => {
  const h=harness();let release,reads=0;let value={enabled:true,allowNetwork:false};
  h.context.fixture=async(_,options)=>{
    if(options){await new Promise(resolve=>{release=resolve});value={...value,...JSON.parse(options.body)};}
    else reads++;
    return value;
  };
  h.run(`state.phase='ready';state.bootstrap={sandbox:{enabled:true,allowNetwork:false}};renderComposerOptions=()=>{};request=fixture;`);
  const pending=h.run('changeSandbox("enabled",false)');
  await new Promise(resolve=>setImmediate(resolve));
  const reopened=h.run('readSandboxForSettings()');
  assert.equal(reads,1);
  release();await pending;
  const result=await reopened;
  assert.equal(result.enabled,false);assert.equal(reads,2);
});

function drawerHarness() {
  const h = harness();
  for (const id of ['project-dialog', 'remove-project-dialog','remove-session-dialog', 'rename-dialog', 'settings-dialog', 'account-settings-dialog', 'feature-dialog']) h.element(id).hidden = true;
  h.element('app').append(h.element('chat'), h.element('sidebar'));
  h.run('openDrawer(false)');
  const event = (x, y = 200, timeStamp = 100, target = h.element('chat')) => ({
    target, timeStamp, cancelable: true, touches: [{ identifier: 1, clientX: x, clientY: y }],
    preventDefault() { this.prevented = true; },
  });
  return { ...h, touch: event, start: e => h.run('startDrawerGesture')(e), move: e => h.run('moveDrawerGesture')(e), end: e => h.run('endDrawerGesture')(e) };
}

test('left-edge drag follows the finger, opens the drawer and can swipe closed without requests', () => {
  const h = drawerHarness();
  h.start(h.touch(12));
  const move = h.touch(92, 203, 300);
  h.move(move);
  assert.equal(move.prevented, true);
  assert.equal(h.element('app').dataset.drawerDragging, 'true');
  assert.equal(h.element('app').style['--drawer-offset'], '-240px');
  assert.equal(h.element('app').dataset.drawer, 'closed');
  h.move(h.touch(172, 203, 400));
  h.end(h.touch(172, 203, 450));
  assert.equal(h.element('app').dataset.drawer, 'open');
  assert.equal(h.element('open-sidebar').attributes.get('aria-expanded'), 'true');
  assert.equal(h.element('sidebar').inert, false);
  assert.equal(h.element('chat').inert, true);
  assert.equal(h.element('app').dataset.drawerDragging, undefined);
  h.start(h.touch(230, 200, 600, h.element('sidebar')));
  h.move(h.touch(80, 205, 900, h.element('sidebar')));
  h.end(h.touch(80, 205, 950, h.element('sidebar')));
  assert.equal(h.element('app').dataset.drawer, 'closed');
  assert.equal(h.element('chat').inert, false);
  assert.equal(h.posts.length, 0);
});

test('short or interrupted edge drags settle closed; deliberate fast flick opens', () => {
  const h = drawerHarness();
  h.start(h.touch(10)); h.move(h.touch(40, 200, 500)); h.end(h.touch(40, 200, 550));
  assert.equal(h.element('app').dataset.drawer, 'closed');
  h.start(h.touch(10)); h.move(h.touch(160)); h.run('cancelDrawerGesture()');
  assert.equal(h.element('app').dataset.drawer, 'closed');
  assert.equal(h.element('app').style['--drawer-offset'], undefined);
  h.start(h.touch(10, 200, 100)); h.move(h.touch(65, 200, 160)); h.end(h.touch(65, 200, 180));
  assert.equal(h.element('app').dataset.drawer, 'open');
});

test('drawer gestures leave vertical scroll, editing, multi-touch, overlays and desktop alone', () => {
  const h = drawerHarness();
  h.start(h.touch(10));
  const vertical = h.touch(12, 245); h.move(vertical);
  h.move(h.touch(180, 245)); h.end(h.touch(180, 245));
  assert.equal(vertical.prevented, undefined);
  assert.equal(h.element('app').dataset.drawer, 'closed', 'axis locks to vertical');
  h.start(h.touch(50)); h.move(h.touch(200)); h.end(h.touch(200));
  assert.equal(h.element('app').dataset.drawer, 'closed', 'must start within edge');
  const textarea = new Element('textarea'); h.element('app').append(textarea);
  h.start(h.touch(10, 200, 100, textarea)); h.move(h.touch(180)); h.end(h.touch(180));
  assert.equal(h.element('app').dataset.drawer, 'closed', 'editing is not intercepted');
  h.start(h.touch(10)); h.move(h.touch(170));
  h.move({ ...h.touch(170), touches: [{identifier: 1}, {identifier: 2}] });
  assert.equal(h.element('app').dataset.drawer, 'closed', 'second finger cancels');
  h.element('app').inert = true;
  h.start(h.touch(10)); assert.equal(h.run('drawerGesture'), null, 'modal blocks gestures');
  h.element('app').inert = false;
  h.run('window.matchMedia = () => ({matches:false})');
  h.start(h.touch(10)); assert.equal(h.run('drawerGesture'), null, 'desktop ignores edge gesture');
});

function sidebarFixture(h) {
  h.run(`state.bootstrap={connection:{state:'connected'},capabilities:{projects:true,projectRemoval:true,sessionRemoval:true},projects:[{id:'project-a',name:'Field Notes',path:'/synthetic/Field Notes'},{id:'empty-project',name:'Empty',path:'/synthetic/Empty'}],sessions:[{id:'project-chat',projectId:'project-a',title:'Project chat'},{id:'ordinary-chat',projectId:null,title:'Ordinary chat'}]};`);
  for (const id of ['project-dialog','rename-dialog','remove-project-dialog','remove-session-dialog','settings-dialog','account-settings-dialog','feature-dialog']) h.element(id).hidden = true;
}
const descendant = (element, predicate) => predicate(element) ? element : element.children.map(child => descendant(child, predicate)).find(Boolean);
const actionNamed = (h, name) => descendant(h.element('session-nav'), element => element.attributes.get('aria-label') === name);

test('Projects and Recents fold independently and stay folded through refreshed sidebar data', () => {
  const h=harness(); sidebarFixture(h); h.run('renderSidebar()');
  const projects = h.element('session-nav').children[0];
  projects.children[0].children[0].listeners.get('click')();
  assert.equal(h.element('session-nav').children[0].children[1].hidden,true);
  assert.equal(h.element('session-nav').children[1].children[1].hidden,false);
  h.element('session-nav').children[1].children[0].children[0].listeners.get('click')();
  h.run(`state.bootstrap.sessions.push({id:'new',title:'New arrival'});renderSidebar()`);
  assert.equal(h.element('session-nav').children[0].children[1].hidden,true);
  assert.equal(h.element('session-nav').children[1].children[1].hidden,true);
  assert.equal(h.posts.length,0);
});

test('project and recent chat actions choose their proper draft scope without creating sessions', async () => {
  const h=harness();sidebarFixture(h);h.run('state.draftActive=true;renderSidebar()');
  assert.equal(actionNamed(h,'Options for Empty'),undefined,'Empty folders remain picker choices, not sidebar groups');
  await actionNamed(h,'New Chat in Field Notes').listeners.get('click')();
  assert.equal(h.run('state.selectedProjectId'),'project-a');
  await actionNamed(h,'New Chat in Recents').listeners.get('click')();
  assert.equal(h.run('state.selectedProjectId'),null);
  assert.equal(h.posts.length,0,'No create request until first send');
});

test('project removal opens explicit counted confirmation, and Cancel never sends a request', () => {
  const h=harness();sidebarFixture(h);
  h.run('openProjectRemoval(state.bootstrap.projects[0])');
  assert.match(h.element('remove-project-copy').textContent,/1 conversation/);
  assert.match(h.element('remove-project-copy').textContent,/folder stays on disk/);
  assert.equal(h.element('app').inert,true);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(state.removal.sessionIds)')),['project-chat']);
  h.run('closeProjectRemoval()');
  assert.equal(h.element('remove-project-dialog').hidden,true);
  assert.equal(h.posts.length,0);
});

test('confirmed project removal sends its original snapshot once, preserves unrelated chats and clears deleted active chat', async () => {
  const h=harness();sidebarFixture(h);const requests=[];let finish;
  h.context.removeFixture=async(path,options)=>{requests.push({path,body:JSON.parse(options.body)});return new Promise(resolve=>{finish=resolve;});};
  h.run(`request=removeFixture;state.selectedId='project-chat';state.view={session:{id:'project-chat'},messages:[]};loadBootstrap=async()=>true;openStream=()=>{};closeStream=()=>{};openProjectRemoval(state.bootstrap.projects[0]);`);
  const pending=h.run('removeProjectConversations()');
  await h.run('removeProjectConversations()');
  h.run('closeProjectRemoval()');assert.equal(h.element('remove-project-dialog').hidden,false,'Cannot dismiss an in-flight destructive command');
  assert.equal(requests.length,1);
  assert.deepEqual(requests[0],{path:'/bridge/projects/project-a/remove',body:{sessionIds:['project-chat'],activeSessionId:'project-chat'}});
  finish({removedSessionIds:['project-chat'],complete:true});await pending;
  assert.equal(h.run('state.selectedId'),null);assert.equal(h.run('state.draftActive'),true);
  assert.equal(h.run('state.drafts.has("project-chat")'),false);
  assert.equal(h.run('state.bootstrap.sessions[0].id'),'ordinary-chat');
  assert.equal(h.run('state.bootstrap.projects.length'),2,'Folder registry is untouched');
  assert.equal(h.element('remove-project-dialog').hidden,true);
});

test('partial or unknown project removal refreshes and requires a new confirmation instead of replay', async () => {
  for(const outcome of ['partial','unknown']){
    const h=harness();sidebarFixture(h);let calls=0,refreshes=0;
    h.context.removeFixture=async()=>{calls++;if(outcome==='unknown')throw Error('Disconnected');return{removedSessionIds:[],complete:false};};
    h.context.refreshFixture=async()=>{refreshes++;return true;};
    h.run(`request=removeFixture;loadBootstrap=refreshFixture;openProjectRemoval(state.bootstrap.projects[0]);`);
    await h.run('removeProjectConversations()');
    assert.equal(calls,1);assert.equal(refreshes,1);
    assert.equal(h.element('remove-project-confirm').hidden,true);
    assert.equal(h.element('remove-project-error').hidden,false);
    assert.equal(h.element('remove-project-dialog').hidden,false);
    assert.equal(h.run('state.working'),false);
  }
});

test('older companions show an upgrade message and cannot dispatch removal', async () => {
  const h=harness();sidebarFixture(h);h.run('delete state.bootstrap.capabilities.projectRemoval;openProjectRemoval(state.bootstrap.projects[0]);');
  assert.equal(h.element('remove-project-confirm').hidden,true);
  await h.run('removeProjectConversations()');assert.equal(h.posts.length,0);
});

test('system context menus are blocked on app content but retained for text editing', () => {
  const h=harness();const listener=h.documentEvents.get('contextmenu');
  for(const tag of ['DIV','SPAN','P','A','IMG','BUTTON','SUMMARY']){
    const event={target:new Element(tag),preventDefault(){this.prevented=true;}};
    listener(event);assert.equal(event.prevented,true,tag);
  }
  for(const target of [new Element('input'),new Element('textarea'),Object.assign(new Element('span'),{isContentEditable:true})]){
    const event={target,preventDefault(){this.prevented=true;}};
    listener(event);assert.equal(event.prevented,undefined,target.tagName);
  }
});


test('sidebar hold opens custom actions without switching; movement, cancel and short taps stay ordinary', () => {
  const h=harness();
  h.run(`globalThis.taps=0;globalThis.menus=0;globalThis.press=node('button');app.append(press);bindSidebarPress(press,()=>taps++,()=>menus++);`);
  const press=h.run('press');
  const event=(x=40,y=40)=>({button:0,isPrimary:true,pointerId:1,clientX:x,clientY:y,preventDefault(){this.prevented=true;},stopPropagation(){}});
  press.listeners.get('pointerdown')(event());
  [...h.timers.values()][0]();
  assert.equal(h.run('menus'),1);assert.equal(h.run('taps'),0);
  press.listeners.get('pointerup')(event());press.listeners.get('click')(event());
  assert.equal(h.run('taps'),0,'Release click must not navigate after hold');
  press.listeners.get('pointerdown')(event());press.listeners.get('pointermove')(event(42,65));
  assert.equal(h.timers.size,0,'Vertical scroll cancels hold');
  press.listeners.get('pointerdown')(event());press.listeners.get('pointercancel')(event());
  assert.equal(h.timers.size,0);
  press.listeners.get('pointerdown')(event());press.listeners.get('pointerup')(event());press.listeners.get('click')(event());
  assert.equal(h.run('taps'),1);assert.equal(h.run('menus'),1);
});

test('chat menu has original Rename/Delete order, hides unsupported Pin and renames its own row inline', async () => {
  const h=harness();sidebarFixture(h);const calls=[];
  h.context.renameFixture=async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return{session:{id:'ordinary-chat',title:'Updated title'}};};
  h.run(`request=renameFixture;state.selectedId='project-chat';positionMenu=()=>{};renderSidebar();openSessionActions(state.bootstrap.sessions[1],node('button'));`);
  const menu=h.element('sidebar-context-menu');
  assert.deepEqual(menu.children.map(button=>button.children[1].textContent),['Rename','Delete']);
  menu.children[0].listeners.get('click')();
  const edit=descendant(h.element('session-nav'),element=>element.tagName==='INPUT');
  assert.equal(edit.value,'Ordinary chat');edit.value=' Updated title ';
  edit.listeners.get('keydown')({key:'Enter',preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[{path:'/bridge/sessions/ordinary-chat',body:{title:'Updated title'}}]);
  assert.equal(h.run('state.selectedId'),'project-chat','Rename does not navigate to target');
  edit.listeners.get('blur')();assert.equal(calls.length,1,'Blur after Enter cannot double submit');
});

test('inline Escape, blank or unchanged title does not mutate; failure rolls back', async () => {
  const h=harness();sidebarFixture(h);h.run(`state.sidebarRename={id:'ordinary-chat',title:'Ordinary chat'};renderSidebar()`);
  const edit=descendant(h.element('session-nav'),element=>element.tagName==='INPUT');
  edit.listeners.get('keydown')({key:'Escape',preventDefault(){},stopPropagation(){}});
  edit.listeners.get('blur')();assert.equal(h.posts.length,0);
  for(const value of ['', 'Ordinary chat']){
    h.run(`state.sidebarRename={id:'ordinary-chat',title:'Ordinary chat'}`);
    await h.run(`finishSidebarRename('ordinary-chat',${JSON.stringify(value)})`);
  }
  assert.equal(h.posts.length,0);
  h.run(`request=async()=>{throw Error('offline')};state.sidebarRename={id:'ordinary-chat',title:'Ordinary chat'}`);
  await h.run(`finishSidebarRename('ordinary-chat','Changed')`);
  assert.equal(h.run('state.bootstrap.sessions[1].title'),'Ordinary chat');
});

test('pathless project groups remain visible and use the exact original deletion warning', () => {
  const h=harness();sidebarFixture(h);h.run(`state.bootstrap.projects=[];renderSidebar();openProjectRemoval({id:'project-a',name:'(no folder)',path:null})`);
  assert.ok(actionNamed(h,'(no folder)'));
  assert.equal(actionNamed(h,'New Chat in (no folder)'),undefined);
  assert.equal(h.element('remove-project-title').textContent,'Remove these conversations from Wisp?');
  assert.equal(h.element('remove-project-copy').textContent,'This deletes the 1 conversation in this project. Nothing on disk is touched.');
  assert.equal(h.posts.length,0);
});

test('chat deletion confirmation is exact and Cancel sends nothing', () => {
  const h=harness();sidebarFixture(h);h.run(`openSessionRemoval(state.bootstrap.sessions[1])`);
  assert.equal(h.element('remove-session-title').textContent,'Delete “Ordinary chat”?');
  assert.equal(h.element('remove-session-copy').textContent,'This deletes the conversation.');
  assert.equal(h.element('remove-session-confirm').textContent,'Delete conversation');
  h.run('closeSessionRemoval()');assert.equal(h.posts.length,0);
  h.run(`openSessionRemoval({...state.bootstrap.sessions[1],hasArtifacts:true})`);
  assert.equal(h.element('remove-session-copy').textContent,'This deletes the conversation. The files it made stay on your disk — you can find them in Artifacts.');
});

test('chat deletion targets the held row once and preserves another selected chat and drafts', async () => {
  const h=harness();sidebarFixture(h);const calls=[];let finish;
  h.context.removeFixture=async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return new Promise(resolve=>finish=resolve);};
  h.run(`request=removeFixture;loadBootstrap=async()=>true;state.selectedId='project-chat';state.drafts.set('project-chat',{text:'keep'});openSessionRemoval(state.bootstrap.sessions[1]);`);
  const pending=h.run('removeSessionConversation()');await h.run('removeSessionConversation()');
  h.run('closeSessionRemoval()');assert.equal(h.element('remove-session-dialog').hidden,false);
  assert.deepEqual(calls,[{path:'/bridge/sessions/ordinary-chat/remove',body:{}}]);
  finish({removedSessionId:'ordinary-chat'});await pending;
  assert.equal(h.run('state.selectedId'),'project-chat');assert.equal(h.run('state.drafts.has("project-chat")'),true);
  assert.equal(h.run('state.bootstrap.sessions.length'),1);
  assert.equal(h.element('remove-session-dialog').hidden,true);
});

test('unknown deletion refreshes and never replays or reports success while chat still exists', async () => {
  const h=harness();sidebarFixture(h);let calls=0;
  h.context.removeFixture=async()=>{calls++;throw Error('lost')};
  h.run(`request=removeFixture;loadBootstrap=async()=>true;openSessionRemoval(state.bootstrap.sessions[1]);`);
  await h.run('removeSessionConversation()');
  assert.equal(calls,1);assert.equal(h.run('state.bootstrap.sessions.length'),2);
  assert.equal(h.element('remove-session-confirm').hidden,true);
  assert.equal(h.element('remove-session-error').hidden,false);
});

test('haptics are optional, gesture-bound and never replay after another gesture or backgrounding', async () => {
  const h = harness();
  h.run(`feedbackFor()('light'); feedbackFor({isTrusted:false})('selection'); feedbackFor({isTrusted:true,currentTarget:{disabled:true}})('light');`);
  assert.equal(h.posts.length, 0);
  h.run(`globalThis.feedback = feedbackFor({isTrusted:true}); feedback('selection'); feedback('invented-pattern');`);
  assert.deepEqual(h.posts.map(p => ({...p})), [{kind:'haptic',event:'selection'}]);
  h.run(`invalidateFeedback({isTrusted:true}); feedback('success');`);
  h.document.hidden = true;
  h.run(`feedbackFor({isTrusted:true})('error');`);
  assert.equal(h.posts.length, 1);
  h.document.hidden = false;
  h.run(`window.webkit=null; feedbackFor({isTrusted:true})('light');
    window.webkit={messageHandlers:{wisp:{postMessage(){throw Error('old shell')}}}}; feedbackFor({isTrusted:true})('light');
    window.webkit.messageHandlers.wisp.postMessage=()=>Promise.reject(Error('unsupported')); feedbackFor({isTrusted:true})('light');`);
  await new Promise(resolve => setImmediate(resolve));
});

test('a real completed hold pulses once; release, movement and cancellation never add a pulse', () => {
  const h=harness(); sidebarFixture(h);
  h.run(`positionMenu=()=>{};globalThis.press=sessionButton(state.bootstrap.sessions[1]);app.append(press);`);
  const press=h.run('press');
  const event=(x=40,y=40)=>({isTrusted:true,button:0,isPrimary:true,pointerId:1,clientX:x,clientY:y,preventDefault(){},stopPropagation(){}});
  press.listeners.get('pointerdown')(event());
  [...h.timers.values()][0]();
  press.listeners.get('pointerup')(event());press.listeners.get('click')(event());
  assert.deepEqual(h.posts.map(p=>p.event),['prepare','context']);
  h.posts.length=0;
  press.listeners.get('pointerdown')(event());press.listeners.get('pointermove')(event(40,65));
  press.listeners.get('pointerup')(event());
  press.listeners.get('pointerdown')(event());press.listeners.get('pointercancel')(event());
  assert.deepEqual(h.posts.map(p=>p.event),['prepare','prepare'],'Preparation is silent; cancelled holds never play context feedback');
});

test('selection feedback follows changed choices; disabled choices, renders and theme initialization are silent', () => {
  const h=harness(); sidebarFixture(h);
  h.run(`globalThis.changed=menuItem({label:'Advanced'},false,()=>{}); globalThis.same=menuItem({label:'Advanced'},true,()=>{});
    globalThis.disabled=menuItem({label:'Unavailable',disabled:true},false,()=>{});`);
  for(const name of ['same','disabled']) h.run(name).listeners.get('click')({isTrusted:true});
  h.run(`renderSidebar();renderComposerOptions();applyTheme('dark');`);
  assert.equal(h.posts.filter(p=>p.kind==='haptic').length,0);
  h.run('changed').listeners.get('click')({isTrusted:true});
  assert.deepEqual(h.posts.filter(p=>p.kind==='haptic').map(p=>p.event),['selection']);
});

test('destructive feedback distinguishes confirmation, verified deletion and unknown outcome', async () => {
  for(const scope of ['chat','project']) for(const outcome of ['success','unknown','stale']) {
    const h=harness();sidebarFixture(h);
    h.run(`loadBootstrap=async()=>true; state.selectedId='project-chat';`);
    if(scope==='chat') h.run(`openSessionRemoval(state.bootstrap.sessions[1],{isTrusted:true})`);
    else h.run(`state.selectedId='ordinary-chat';openProjectRemoval(state.bootstrap.projects[0],{isTrusted:true})`);
    assert.deepEqual(h.posts.filter(p=>p.kind==='haptic').map(p=>p.event),['warning']);
    let finish;
    h.context.removeFixture=()=>new Promise(resolve=>{finish=resolve;});
    h.run('request=removeFixture');
    const pending=h.run(`${scope==='chat'?'removeSessionConversation':'removeProjectConversations'}({isTrusted:true})`);
    if(outcome==='stale') h.run('invalidateFeedback({isTrusted:true})');
    finish(scope==='chat' ? {removedSessionId:outcome==='unknown'?null:'ordinary-chat'} : {removedSessionIds:outcome==='unknown'?[]:['project-chat'],complete:outcome!=='unknown'});
    await pending;
    const expected=outcome==='stale'?['warning']:['warning',outcome==='success'?'success':'error'];
    assert.deepEqual(h.posts.filter(p=>p.kind==='haptic').map(p=>p.event),expected,`${scope}/${outcome}`);
  }
});

test('sandbox selection feedback waits for confirmation and fails without a false selection pulse', async () => {
  for(const succeeds of [true,false]) {
    const h=harness();let finish;
    h.context.changeFixture=()=>new Promise((resolve,reject)=>{finish=()=>succeeds?resolve({enabled:false,allowNetwork:false}):reject(Error('offline'));});
    h.run(`state.phase='ready';state.bootstrap={sandbox:{enabled:true,allowNetwork:false}};changeSandbox=changeFixture;`);
    const pending=h.run('toggleSandbox({isTrusted:true})');
    assert.equal(h.posts.length,0);
    finish();await pending;
    assert.deepEqual(h.posts.map(p=>p.event),[succeeds?'selection':'error']);
  }
});

test('sidebar tools show the same notice without loading connectors in any chat state', () => {
  for (const view of ['draft', 'selected', 'offline']) {
    const h = harness();
    h.context.fixtureState = view;
    h.run(`state.selectedId=fixtureState==='draft'?null:'chat';
      state.bootstrap={connection:{state:fixtureState==='offline'?'offline':'connected'},capabilities:{connectors:true}};
      globalThis.requests=0;request=async()=>{requests++;return{connectors:[{id:'service',enabled:true}]};};
      initializeInterface();`);
    for (const [feature, title] of [['artifacts','Artifacts'],['connectors','Connectors'],['transcription','Transcripts']]) {
      h.element(`open-${feature}`).listeners.get('click')({isTrusted:true});
      assert.equal(h.element('feature-title').textContent, title);
      assert.equal(h.element('feature-copy').textContent, 'Not available on mobile yet. Use the official Wisp app on macOS.');
      assert.equal(h.element('feature-dialog').hidden, false);
      assert.equal(h.run('requests'), 0, `${view}/${feature}: no feature request`);
      h.element('feature-close').listeners.get('click')({isTrusted:true});
      assert.equal(h.element('feature-dialog').hidden, true);
    }
    assert.equal(h.run('state.selectedId'), view === 'draft' ? null : 'chat');
    assert.deepEqual(h.posts.filter(p=>p.kind==='haptic').map(p=>p.event), Array(6).fill('light'));
  }
});

test('send feedback waits for acceptance and distinguishes failed, unknown and stale outcomes', async () => {
  for (const outcome of ['accepted', 'rejected', 'unknown', 'unconfirmed', 'stale', 'create-failed', 'upload-failed']) {
    const h = harness(); let finish;
    h.context.sendFixture = () => new Promise((resolve, reject) => {
      finish = () => {
        if (['rejected', 'create-failed', 'upload-failed'].includes(outcome)) reject(Object.assign(Error('Not accepted'), {known:true}));
        else if (outcome === 'unknown') reject(Error('Lost acknowledgement'));
        else resolve({accepted:outcome !== 'unconfirmed'});
      };
    });
    h.run(`state.bootstrap={connection:{state:'connected'},sessions:[]};state.bootstrapValid=true;
      state.selectedId='chat';state.loading=false;input.value='Hello';
      state.streamAcknowledged=true;state.streamSnapshot=true;state.lastStreamEvent=Date.now();
      request=sendFixture;loadSession=async()=>{};openStream=()=>{};`);
    if (outcome === 'create-failed') h.run(`state.selectedId=null;state.draftActive=true;state.draftId=uuid();`);
    if (outcome === 'upload-failed') h.run(`state.attachments=[{id:'local',local:true}];uploadPrepared=sendFixture;`);
    const pending = h.run('sendMessage({isTrusted:true})');
    await Promise.resolve();
    assert.equal(h.posts.length, 0, `${outcome}: no acceptance pulse before the response`);
    assert.equal(h.element('message').blurred, true, 'Keyboard still closes immediately');
    if (outcome === 'stale') h.run('invalidateFeedback({isTrusted:true})');
    finish(); await pending;
    const expected = outcome === 'accepted' ? ['light'] : outcome === 'stale' ? [] :
      ['unknown','unconfirmed'].includes(outcome) ? ['warning'] : ['error'];
    assert.deepEqual(h.posts.map(p => p.event), expected, outcome);
  }
});

function dropHarness() {
  const h = harness();
  h.run(`
    state.bootstrap={connection:{state:'connected'},capabilities:{attachments:true},sessions:[]};
    state.bootstrapValid=true;state.loading=false;state.draftActive=true;state.draftId=uuid();
    for(const id of ['project-dialog','rename-dialog','remove-project-dialog','remove-session-dialog','settings-dialog','account-settings-dialog','feature-dialog']) $('#'+id).hidden=true;
  `);
  return h;
}

function fileDrop(files, extra = {}) {
  return { dataTransfer: { types: ['Files'], files, items: [], ...extra },
    prevented: false, preventDefault() { this.prevented = true; } };
}
function droppedFile(name = 'contract.pdf', type = 'application/pdf') {
  const bytes = Uint8Array.from([37,80,68,70,45,49,46,55]);
  return { name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer };
}
function preparedPDF() {
  const text = 'Synthetic contract: approval is still required.';
  return { ok: true, body: { files: [{kind:'pdf_text',filename:'contract.pdf',size:text.length,mimeType:'text/plain',dataBase64:btoa(text)}] } };
}

test('native PDF drop imports an opaque batch and queues in the draft without sending', async () => {
  const h = dropHarness(), packets = [];
  h.context.window.webkit.messageHandlers.wisp.postMessage = async packet => { packets.push(packet); return preparedPDF(); };
  await h.run(`window.wispImportDrop('drop-id',state.draftId)`);
  assert.deepEqual(packets.map(p=>p.kind), ['takeDroppedFiles']);
  assert.equal(packets[0].id, 'drop-id');
  assert.deepEqual(Object.keys(packets[0]).sort(), ['id','kind']);
  assert.equal(h.run('state.attachments.length'), 1);
  assert.equal(h.run('state.attachments[0].local'), true);
  assert.equal(h.run('state.attachments[0].kind'), 'pdf_text');
  assert.equal(h.run('state.uploading'), false);
  assert.equal(h.element('attachment-chips').hidden, false);
  assert.equal(h.element('send').disabled, false);
});

test('file drag uses copy only when attachments are available; text drags are left alone', async () => {
  const h = dropHarness();
  for (const blocked of [false, true]) {
    h.run(`state.working=${blocked}`);
    const event = fileDrop([]);
    h.documentEvents.get('dragover')(event);
    assert.equal(event.prevented, true);
    assert.equal(event.dataTransfer.dropEffect, blocked ? 'none' : 'copy');
  }
  const text = fileDrop([], {types:['text/plain']});
  h.documentEvents.get('dragover')(text);
  await h.documentEvents.get('drop')(text);
  assert.equal(text.prevented, false);
  assert.equal(h.posts.length, 0);
});

test('drop respects connection, capability, running, modal and pending-delivery gates', async () => {
  for (const setup of [
    `state.bootstrap.connection.state='offline'`, `state.bootstrap.capabilities.attachments=false`,
    `state.view={run:{state:'running'}}`, `state.pendingUnknown=true`, `state.creationUnknown=true`,
    `state.loading=true`, `app.dataset.drawer='open'`, `$('#settings-dialog').hidden=false`,
    `$('#account-settings-dialog').hidden=false`, `state.uploading=true`,
  ]) {
    const h = dropHarness(); h.run(setup);
    const event = fileDrop([droppedFile()]);
    await h.documentEvents.get('drop')(event);
    assert.equal(event.prevented, true, setup);
    assert.equal(h.run('state.attachments.length'), 0, setup);
    assert.equal(h.posts.length, 0, setup);
  }
});

test('drop rejects oversized/count/empty/folder inputs before reading or bridging them', async () => {
  for (const makeEvent of [
    () => fileDrop(Array.from({length:11}, () => droppedFile())),
    () => fileDrop([{...droppedFile('note.txt','text/plain'),size:25*1024*1024+1,arrayBuffer(){throw Error('must not read')}}]),
    () => fileDrop([{...droppedFile('note.txt','text/plain'),size:0}]),
    () => fileDrop([]),
    () => fileDrop([droppedFile()], {items:[{kind:'file',webkitGetAsEntry:()=>({isDirectory:true})}]}),
  ]) {
    const h = dropHarness(); await h.documentEvents.get('drop')(makeEvent());
    assert.equal(h.posts.length, 0);
    assert.equal(h.run('state.attachments.length'), 0);
    assert.equal(h.run('state.uploading'), false);
    assert.equal(h.element('notice').hidden, false);
  }
});

test('drop preparation locks navigation and a second drop; late results cannot land in another chat', async () => {
  const h = dropHarness(); let release;
  h.context.window.webkit.messageHandlers.wisp.postMessage = () => new Promise(resolve => { release=resolve; });
  const pending = h.run(`window.wispImportDrop('drop-id',state.draftId)`);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.run('state.uploading'), true);
  assert.equal(h.element('send').disabled, true);
  await h.run(`selectSession('another-chat')`);
  assert.equal(h.run('state.selectedId'), null);
  await h.documentEvents.get('drop')(fileDrop([droppedFile()]));
  h.run(`state.draftId=uuid()`); // A reset outside ordinary navigation must also be safe.
  release(preparedPDF()); await pending;
  assert.equal(h.run('state.attachments.length'), 0);
  assert.equal(h.run('state.uploading'), false);
});

test('a failed file in a batch and total-size violations never append a partial batch', async () => {
  const h = dropHarness();
  h.context.window.webkit.messageHandlers.wisp.postMessage = async () => ({ok:false,error:{code:'attachment_unsupported'}});
  await h.run(`window.wispImportDrop('drop-id',state.draftId)`);
  assert.equal(h.run('state.attachments.length'), 0);
  assert.match(h.element('notice').textContent, /readable PDF/);
  h.run(`state.attachments=[{size:15*1024*1024}];`);
  h.context.window.webkit.messageHandlers.wisp.postMessage = async () => preparedPDF();
  await h.run(`window.wispImportDrop('drop-id',state.draftId)`);
  assert.equal(h.run('state.attachments.length'), 1);
  assert.match(h.element('notice').textContent, /15 MB/);
  assert.equal(h.run('state.uploading'), false);
});

test('drop into an existing chat uses bounded upload routes and never submits a message', async () => {
  const h = dropHarness(), routes=[];
  h.run(`state.draftActive=false;state.selectedId='existing-chat';state.streamAcknowledged=true;state.streamSnapshot=true;state.lastStreamEvent=Date.now();`);
  h.context.window.webkit.messageHandlers.wisp.postMessage = async packet => {
    if(packet.kind === 'takeDroppedFiles') return preparedPDF();
    routes.push({path:packet.path,body:packet.body});
    return {ok:true,body:packet.path.endsWith('/commit') ? {id:'attachment-id',filename:'contract.pdf',kind:'pdf_text',size:45} : {id:'attachment-id'}};
  };
  await h.run(`window.wispImportDrop('drop-id',state.selectedId)`);
  assert.deepEqual(routes.map(r=>r.path),['/bridge/attachments/begin','/bridge/attachments/chunk','/bridge/attachments/commit']);
  assert.equal(routes[0].body.sessionId,'existing-chat');
  assert.equal(h.run('state.attachments[0].id'),'attachment-id');
});

test('browser PDF drops explain the native requirement and file-read failure allows retry', async () => {
  const h = dropHarness(); h.context.window.webkit = undefined;
  await h.documentEvents.get('drop')(fileDrop([droppedFile()]));
  assert.match(h.element('notice').textContent, /iPhone app/);
  assert.equal(h.run('state.uploading'), false);
  await h.documentEvents.get('drop')(fileDrop([{...droppedFile('note.txt','text/plain'),arrayBuffer:async()=>{throw Error('File unavailable');}}]));
  assert.match(h.element('notice').textContent, /File unavailable/);
  assert.equal(h.element('attach').disabled, false);
});

test('picker retains a selected draft attachment across a transient disconnect and blocks concurrent drop', async () => {
  const h=dropHarness(); let release; const packets=[];
  h.context.window.webkit.messageHandlers.wisp.postMessage=packet=>{packets.push(packet);return new Promise(resolve=>{release=resolve});};
  const pending=h.run('chooseAttachments()');
  assert.equal(h.run('state.uploading'),true);
  await h.run(`window.wispImportDrop('concurrent-drop',state.draftId)`);
  h.run('state.bootstrapValid=false');
  release(preparedPDF()); await pending;
  assert.deepEqual(packets.map(p=>p.kind),['pickFiles']);
  assert.equal(h.run('state.attachments.length'),1);
  assert.equal(h.run('state.attachments[0].local'),true);
  assert.equal(h.run('state.uploading'),false);
});

test('picker cancellation clears preparation state and native drops reject an obsolete destination', async () => {
  const h=dropHarness();
  h.context.window.webkit.messageHandlers.wisp.postMessage=async()=>({ok:true,body:{files:[]}});
  await h.run('chooseAttachments()');
  assert.equal(h.run('state.uploading'),false);
  assert.equal(h.element('notice').hidden,true);
  await h.run(`window.wispImportDrop('drop-id','old-draft')`);
  assert.equal(h.run('state.attachments.length'),0);
});

test('native drop availability reports destination and disables while importing', async () => {
  const h=dropHarness(); const states=[];
  h.run('window.wispNativeFileDrop=true');
  h.context.window.webkit.messageHandlers.wisp.postMessage=async packet=>{if(packet.kind==='fileDropState'){states.push(packet);return{ok:true};}return preparedPDF();};
  h.run('updateControls()');
  await h.run(`window.wispImportDrop('drop-id',state.draftId)`);
  assert.deepEqual(states.map(s=>s.enabled),[true,false,true]);
  assert.ok(states.every(s=>s.selectionId===h.run('state.draftId')));
});

test('native copy proposal is disabled while a modal or drawer covers the composer', () => {
  const h=dropHarness(), states=[];
  h.run('window.wispNativeFileDrop=true');
  h.context.window.webkit.messageHandlers.wisp.postMessage=async packet=>{if(packet.kind==='fileDropState')states.push(packet.enabled);return{ok:true};};
  h.run(`updateControls(); $('#settings-dialog').hidden=false; syncOverlayAccess(); updateControls();`);
  assert.deepEqual(states,[true,false]);
  h.run(`$('#settings-dialog').hidden=true; syncOverlayAccess(); openDrawer(true); openDrawer(false);`);
  assert.deepEqual(states,[true,false,true,false,true]);
});
