// Shared by every document folder (insurance locker, team / event / venue documents): the size limits, "PDF or photo" detection from
// the bytes, a size-capped body reader, and the encrypted-on-disk store. Files are never deleted; callers only hide rows.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { AppError } from './errors.js';
import { decrypt, encrypt } from './crypto.js';
import { sniff } from './media.js';

export const DOC_LIMITS = { bytes: 10 * 2 ** 20, perParent: 50 };

/** PDF or a photo, decided from the bytes (never from what the client says). */
export function sniffDoc(b) {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  const t = sniff(b);
  return t && t.kind === 'photo' ? { type: t.type, ext: t.ext } : null;
}

export async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', `Documents can be up to ${DOC_LIMITS.bytes / 2 ** 20} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Write `buf` encrypted (context = 'table.column') under mediaDir/<folder>. Returns the new id and the file name to store. */
export async function saveEncrypted(folder, context, buf) {
  const root = resolve(config.mediaDir, folder);
  const did = randomUUID(), file = `${did}.bin`, tmp = join(root, `${did}.part`);
  await mkdir(root, { recursive: true });
  try {
    await writeFile(tmp, encrypt(buf.toString('base64'), context), { mode: 0o640, flag: 'wx' });
    await rename(tmp, join(root, file));
  } catch (e) { await rm(tmp, { force: true }); throw e; }
  return { id: did, file };
}

export async function loadEncrypted(folder, context, file) {
  return Buffer.from(decrypt(await readFile(join(resolve(config.mediaDir, folder), file), 'utf8'), context), 'base64');
}

export const docHeaders = (type, bytes) => ({ 'Content-Type': type, 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
