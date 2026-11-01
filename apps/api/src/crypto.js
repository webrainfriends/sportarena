// Field-level encryption for personal identification data.
//
//  * AES-256-GCM, random 96-bit IV per value, ciphertext bound to a context string (AAD) such as
//    "users.phone" so a ciphertext cannot be copy-pasted into another column.
//  * Keys are derived (HKDF) from SPORTARENA_MASTER_KEY: one for encryption, one for blind indexes.
//  * Format: "v1.<iv>.<tag>.<ciphertext>" (base64url), or "v2.<keyId>.<iv>.<tag>.<ciphertext>" once a rotated key is active (see the keyring below).
//  * blindIndex() = HMAC-SHA256 of the normalised value: equality lookup (e.g. login by email)
//    without storing the plaintext.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { config } from './config.js';
import { AppError } from './errors.js';

// Keyring: every key is identified by an id ("k1" is the original key; ciphertext written before key ids existed is "v1" and always means k1).
// KEY_ACTIVE picks the key new values are written with; every id in KEY_IDS stays loaded so older values keep decrypting.
// While k1 is active nothing changes on disk ("v1." values). Once another id is active new values are "v2.<keyId>.<iv>.<tag>.<ciphertext>".
// The blind index (email lookups) is always keyed from k1: changing it would need every lookup column re-hashed, which a rotation does not do.
const KEY_ID = /^[a-z0-9_-]{1,32}$/;
const masters = new Map();   // key id -> master key bytes (KMS provider: unwrapped at start-up)
const derived = new Map();   // key id -> { enc, idx }

/** The file a key's KMS-wrapped master key is stored in: k1 keeps the original path, other ids get a suffix. */
export const wrappedKeyFile = (cfg, keyId) => (keyId === 'k1' ? cfg.masterKeyFile : `${cfg.masterKeyFile}.${keyId}`);

/** Call once at start-up. With KEY_PROVIDER=aws-kms this unwraps every master key in the ring via KMS. */
export async function initKeys(kms) {
  derived.clear(); masters.clear();
  if (config.keyProvider === 'env') return;
  if (config.keyProvider !== 'aws-kms') throw new Error(`Unknown KEY_PROVIDER ${config.keyProvider}`);
  const { unwrapMasterKey } = await import('./kms.js');
  for (const id of knownKeyIds()) masters.set(id, await unwrapMasterKey({ ...config, masterKeyFile: wrappedKeyFile(config, id) }, kms));
}

export const activeKeyId = () => config.activeKeyId ?? 'k1';
export const knownKeyIds = () => {
  const ids = new Set(config.keyIds?.length ? config.keyIds : ['k1']);
  ids.add('k1'); ids.add(activeKeyId());
  for (const id of ids) if (!KEY_ID.test(id)) throw new Error(`Invalid key id "${id}" (lowercase letters, digits, - and _ only)`);
  return [...ids];
};

function getKeys(keyId = 'k1') {
  const hit = derived.get(keyId);
  if (hit) return hit;
  let master = masters.get(keyId) ?? null;
  if (!master && config.keyProvider === 'env') {
    const raw = keyId === 'k1' ? config.masterKey : process.env[`SPORTARENA_MASTER_KEY_${keyId.toUpperCase().replace(/-/g, '_')}`];
    if (raw) master = Buffer.from(raw, 'base64');
  }
  if (!master) throw new Error(keyId === 'k1' ? 'Encryption keys not initialised — call initKeys() first' : `Encryption key "${keyId}" is not loaded`);
  if (master.length < 32) throw new Error('SPORTARENA_MASTER_KEY must be >= 32 bytes, base64-encoded');
  const derive = (info) => Buffer.from(hkdfSync('sha256', master, 'sportarena-v1', info, 32));
  const keys = { enc: derive('field-encryption'), idx: derive('blind-index') };
  derived.set(keyId, keys);
  return keys;
}

/** Which key a stored value was written with: "k1" for v1, the id for v2, null when it is not one of our ciphertexts. */
export function keyIdOf(payload) {
  const p = typeof payload === 'string' ? payload.split('.') : [];
  if (p[0] === 'v1' && p.length === 4) return 'k1';
  if (p[0] === 'v2' && p.length === 5) return p[1];
  return null;
}

export function encrypt(plaintext, context) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const kid = activeKeyId();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKeys(kid).enc, iv);
  cipher.setAAD(Buffer.from(context));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const parts = kid === 'k1' ? ['v1'] : ['v2', kid];
  return [...parts, iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(payload, context) {
  if (!payload) return null;
  const p = payload.split('.');
  let kid; let iv; let tag; let ct;
  if (p[0] === 'v1' && p.length === 4) [, iv, tag, ct] = p, kid = 'k1';
  else if (p[0] === 'v2' && p.length === 5) [, kid, iv, tag, ct] = p;
  else throw new Error('Unknown ciphertext version');
  const decipher = createDecipheriv('aes-256-gcm', getKeys(kid).enc, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** Rewrite a stored value under the active key. Returns the same string when it already is (so callers can skip the write). */
export function reencrypt(payload, context) {
  if (!payload || keyIdOf(payload) === activeKeyId()) return payload;
  return encrypt(decrypt(payload, context), context);
}

export function blindIndex(value) {
  return createHmac('sha256', getKeys('k1').idx).update(String(value).trim().toLowerCase()).digest('hex');
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
