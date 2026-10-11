// Field-level encryption for personal identification data.
//
//  * AES-256-GCM, random 96-bit IV per value, ciphertext bound to a context string (AAD) such as
//    "users.phone" so a ciphertext cannot be copy-pasted into another column.
//  * Keys are derived (HKDF) from SPORTARENA_MASTER_KEY: one for encryption, one for blind indexes.
//  * Format: "v1.<iv>.<tag>.<ciphertext>" (base64url). The version prefix lets us rotate keys later.
//  * blindIndex() = HMAC-SHA256 of the normalised value: equality lookup (e.g. login by email)
//    without storing the plaintext.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { config } from './config.js';
import { AppError } from './errors.js';

let keys;
let unwrappedMaster = null;

/** Call once at start-up. With KEY_PROVIDER=aws-kms this unwraps the master key via KMS. */
export async function initKeys(kms) {
  if (config.keyProvider === 'env') return;
  if (config.keyProvider !== 'aws-kms') throw new Error(`Unknown KEY_PROVIDER ${config.keyProvider}`);
  const { unwrapMasterKey } = await import('./kms.js');
  unwrappedMaster = await unwrapMasterKey(config, kms);
  keys = undefined;
}

function getKeys() {
  if (keys) return keys;
  const master = unwrappedMaster ?? (config.masterKey ? Buffer.from(config.masterKey, 'base64') : null);
  if (!master) throw new Error('Encryption keys not initialised — call initKeys() first');
  if (master.length < 32) throw new Error('SPORTARENA_MASTER_KEY must be >= 32 bytes, base64-encoded');
  const derive = (info) => Buffer.from(hkdfSync('sha256', master, 'sportarena-v1', info, 32));
  keys = { enc: derive('field-encryption'), idx: derive('blind-index') };
  return keys;
}

export function encrypt(plaintext, context) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKeys().enc, iv);
  cipher.setAAD(Buffer.from(context));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(payload, context) {
  if (!payload) return null;
  const [v, iv, tag, ct] = payload.split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = createDecipheriv('aes-256-gcm', getKeys().enc, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export function blindIndex(value) {
  return createHmac('sha256', getKeys().idx).update(String(value).trim().toLowerCase()).digest('hex');
}

// ---- Password hashing -------------------------------------------------------------------------
// scrypt runs on the libuv thread pool (async), so a burst of logins never blocks the event loop.
// A bounded semaphore caps concurrent derivations (each uses ~16 MiB and a pool thread) and a bounded
// wait queue turns overload into a fast 503 + Retry-After instead of unbounded memory/latency.
// Stored format is unchanged: scrypt$<salt b64url>$<hash b64url>, N=16384 r=8 p=1, 64-byte key.
const SCRYPT = { N: 16384, r: 8, p: 1 };
const gate = {
  active: 0, queue: [], peakQueue: 0, rejected: 0, completed: 0,
  get limit() { return Math.max(1, Number(config.hashing?.concurrency) || 2); },
  get maxQueue() { return Math.max(0, Number(config.hashing?.maxQueue ?? 64)); },
};

export function hashingStats() {
  return { active: gate.active, queued: gate.queue.length, peak_queued: gate.peakQueue, rejected: gate.rejected, completed: gate.completed, concurrency: gate.limit, max_queue: gate.maxQueue };
}

function acquire() {
  if (gate.active < gate.limit) { gate.active++; return Promise.resolve(); }
  if (gate.queue.length >= gate.maxQueue) {
    gate.rejected++;
    return Promise.reject(new AppError(503, 'busy', 'The server is busy signing people in. Please try again in a moment.', { retry_after_seconds: 2 }));
  }
  return new Promise((resolve) => { gate.queue.push(resolve); gate.peakQueue = Math.max(gate.peakQueue, gate.queue.length); });
}
function release() {
  const next = gate.queue.shift();
  if (next) next(); else gate.active--;
}

function derive(password, salt, len) {
  return new Promise((resolve, reject) => scrypt(password, salt, len, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));
}
async function limitedDerive(password, salt, len) {
  await acquire();
  try { return await derive(password, salt, len); } finally { gate.completed++; release(); }
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await limitedDerive(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored ?? '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await limitedDerive(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const newOpaqueToken = () => 'sa_' + randomBytes(32).toString('base64url');

// Helpers for rows: encryptFields({phone:'1'}, 'users', ['phone']) -> {phone_enc: '...'}
export function encryptFields(obj, table, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[`${f}_enc`] = encrypt(obj[f], `${table}.${f}`);
  return out;
}
export function decryptFields(row, table, fields) {
  const out = {};
  for (const f of fields) out[f] = decrypt(row[`${f}_enc`], `${table}.${f}`);
  return out;
}
