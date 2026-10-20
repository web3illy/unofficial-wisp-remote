// Explicit integration proof creates one synthetic Desktop-origin Wisp chat.
// Never use real documents or output unrelated chat content in this script.
import { randomUUID } from 'node:crypto';
import { createBridge } from '../src/mobile-bridge.js';
import { createWispClient } from '../src/wisp-client.js';
import { deadline } from '../src/iroh-companion.js';

const bridge = createBridge(), native = createWispClient();
const session = (await bridge.createSession({ title: 'Remote attachment verification' })).session;
const owner = 'synthetic-integration-owner', marker = 'ATTACHMENT-VERIFIED-7319';
const bytes = Buffer.from(`Synthetic verification document. Code: ${marker}.`);
const attachment = bridge.attachmentBegin(owner, { sessionId: session.id, kind: 'file', filename: 'connection-test.txt', size: bytes.length, mimeType: 'text/plain' });
bridge.attachmentChunk(owner, { id: attachment.id, offset: 0, dataBase64: bytes.toString('base64') });
bridge.attachmentCommit(owner, { id: attachment.id });
const done = new Promise(resolve => { const listen = packet => { if (packet.type === 'complete') { bridge.events.off(session.id, listen); resolve(packet.data); } }; bridge.events.on(session.id, listen); });
await bridge.send(session.id, { id: randomUUID(), text: 'Read the attached text file. Reply only with its code, without explanations. Do not use tools.', attachments: [attachment.id], mode: 'balanced', thinking: false }, owner);
const view = await deadline(done, 120_000);
const history = await native.request(`/v1/sessions/${session.id}/history`);
const messages = history?.[0]?.values?.messages || [];
const savedFile = messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'file' && b.filename === 'connection-test.txt' && b.content.includes(marker)));
const answered = view.messages.some(m => m.role === 'assistant' && m.text.includes(marker));
const redacted = !JSON.stringify(view).includes(bytes.toString());
console.log(JSON.stringify({ nativeAttachmentSaved: savedFile, modelReadAttachment: answered, normalizedHistoryRedactsFileBody: redacted, sessionId: session.id }));
if (!savedFile || !answered || !redacted) process.exitCode = 1;
