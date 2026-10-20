import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { BridgeError } from './wisp-client.js';
import { UUID } from './mobile-store.js';

export const ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 10,
  maxFileBytes: 5 * 1024 * 1024,
  maxOwnerBytes: 15 * 1024 * 1024,
  maxChunkBytes: 16 * 1024,
  ttlMs: 15 * 60 * 1000,
});

const bad = (code, message, status = 400) => new BridgeError(status, code, message);
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function ownerKey(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw bad('attachment_owner', 'Could not identify the attachment owner.', 403);
  }
  return value;
}

function filename(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || value !== value.trim() ||
      /[\x00-\x1f\x7f/\\]/.test(value) || value === '.' || value === '..') {
    throw bad('attachment_name', 'Invalid attachment name.');
  }
  return value;
}

function metadata(value, limits) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('attachment_meta', 'Invalid attachment details.');
  const allowed = ['sessionId', 'kind', 'filename', 'size', 'mimeType', 'width', 'height'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw bad('attachment_meta', 'Invalid attachment details.');
  if (!UUID.test(value.sessionId || '')) throw bad('attachment_session', 'Choose a chat before adding an attachment.');
  if (!['file', 'pdf_text', 'image'].includes(value.kind)) throw bad('attachment_kind', 'This attachment type is not supported.');
  const name = filename(value.filename);
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > limits.maxFileBytes) {
    throw bad('attachment_size', 'Each attachment must be smaller than 5 MB.', 413);
  }
  const mimeType = value.mimeType;
  if (mimeType !== undefined && (typeof mimeType !== 'string' || mimeType.length > 120 || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType))) {
    throw bad('attachment_mime', 'Invalid attachment type.');
  }
  if (value.kind === 'image') {
    if (mimeType !== 'image/jpeg') throw bad('attachment_mime', 'The image must be prepared as JPEG.');
    if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width > 2048 || value.height > 2048) {
      throw bad('attachment_dimensions', 'The image must be no larger than 2048 × 2048.');
    }
  } else if (value.width !== undefined || value.height !== undefined) {
    throw bad('attachment_dimensions', 'Dimensions are only valid for images.');
  }
  return { sessionId: value.sessionId, kind: value.kind, filename: name, size: value.size,
    ...(mimeType ? { mimeType } : {}), ...(value.kind === 'image' ? { width: value.width, height: value.height } : {}) };
}

function decodedChunk(value, limits) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(limits.maxChunkBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw bad('attachment_chunk', 'Invalid attachment chunk.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > limits.maxChunkBytes || bytes.toString('base64') !== value) throw bad('attachment_chunk', 'Invalid attachment chunk.');
  return bytes;
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  let offset = 2;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (sof.has(marker)) {
      if (length < 7) return null;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function publicMeta(item) {
  return { id: item.id, kind: item.kind, filename: item.filename, size: item.size,
    ...(item.mimeType ? { mimeType: item.mimeType } : {}), ...(item.kind === 'image' ? { width: item.width, height: item.height } : {}) };
}

export function createAttachmentStore({ limits = ATTACHMENT_LIMITS, now = () => Date.now() } = {}) {
  const items = new Map();

  function cleanup() {
    const cutoff = now() - limits.ttlMs;
    for (const [id, item] of items) if (item.createdAt < cutoff) items.delete(id);
  }
  function owned(owner, id) {
    cleanup(); owner = ownerKey(owner);
    if (!UUID.test(id || '')) throw bad('attachment_id', 'Invalid attachment.');
    const item = items.get(id);
    if (!item || item.owner !== owner) throw bad('attachment_missing', 'The attachment was not found or has expired.', 404);
    return item;
  }

  return {
    begin(owner, meta) {
      cleanup(); owner = ownerKey(owner); meta = metadata(meta, limits);
      const current = [...items.values()].filter(item => item.owner === owner);
      if (current.length >= limits.maxCount) throw bad('attachment_count', 'You can add up to 10 attachments.', 413);
      if (current.reduce((sum, item) => sum + item.size, 0) + meta.size > limits.maxOwnerBytes) {
        throw bad('attachment_total', 'Combined attachments must be smaller than 15 MB.', 413);
      }
      const item = { ...meta, id: randomUUID(), owner, offset: 0, chunks: [], committed: false, createdAt: now() };
      items.set(item.id, item);
      return publicMeta(item);
    },
    chunk(owner, value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['id', 'offset', 'dataBase64'].includes(k))) throw bad('attachment_chunk', 'Invalid attachment chunk.');
      const item = owned(owner, value.id);
      if (item.committed) throw bad('attachment_committed', 'The attachment is already prepared.', 409);
      if (!Number.isSafeInteger(value.offset) || value.offset !== item.offset) throw bad('attachment_offset', 'Attachment chunks arrived out of order.', 409);
      const bytes = decodedChunk(value.dataBase64, limits);
      if (item.offset + bytes.length > item.size) throw bad('attachment_size', 'More data was received than declared.', 413);
      item.chunks.push(bytes); item.offset += bytes.length;
      return { id: item.id, offset: item.offset };
    },
    commit(owner, value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'id')) throw bad('attachment_id', 'Invalid attachment.');
      const item = owned(owner, value.id);
      if (item.committed) return publicMeta(item);
      if (item.offset !== item.size) throw bad('attachment_incomplete', 'The attachment upload is incomplete.', 409);
      const bytes = Buffer.concat(item.chunks, item.size);
      if (item.kind === 'image') {
        const dimensions = jpegDimensions(bytes);
        if (!dimensions || dimensions.width !== item.width || dimensions.height !== item.height) throw bad('attachment_image', 'The JPEG is damaged or its dimensions do not match.');
      } else {
        try { item.text = textDecoder.decode(bytes); } catch { throw bad('attachment_encoding', 'Text files must use UTF-8 encoding.'); }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.text)) throw bad('attachment_binary', 'Binary files are not supported yet.');
      }
      item.bytes = bytes; item.chunks = []; item.committed = true;
      return publicMeta(item);
    },
    remove(owner, value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'id')) throw bad('attachment_id', 'Invalid attachment.');
      const item = owned(owner, value.id); items.delete(item.id); return { ok: true };
    },
    resolve(owner, ids, sessionId) {
      cleanup(); owner = ownerKey(owner);
      if (!Array.isArray(ids) || ids.length > limits.maxCount || ids.some(id => !UUID.test(id || '')) || new Set(ids).size !== ids.length) {
        throw bad('attachments', 'Invalid attachment list.');
      }
      return ids.map(id => {
        const item = owned(owner, id);
        if (!item.committed) throw bad('attachment_incomplete', 'Wait for the attachment to finish uploading.', 409);
        if (item.sessionId !== sessionId) throw bad('attachment_session', 'This attachment belongs to another chat.', 409);
        if (item.kind === 'image') return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${item.bytes.toString('base64')}` }, mimeType: 'image/jpeg', width: item.width, height: item.height };
        return { type: item.kind, filename: item.filename, content: item.text };
      });
    },
    consume(owner, ids) {
      owner = ownerKey(owner);
      for (const id of ids) { const item = items.get(id); if (item?.owner === owner) items.delete(id); }
    },
    dropOwner(owner) {
      owner = ownerKey(owner);
      for (const [id, item] of items) if (item.owner === owner) items.delete(id);
    },
  };
}
