// Field-level encryption for personal identification data.
//
//  * AES-256-GCM, random 96-bit IV per value, ciphertext bound to a context string (AAD) such as
//    "users.phone" so a ciphertext cannot be copy-pasted into another column.
//  * Keys are derived (HKDF) from SPORTARENA_MASTER_KEY: one for encryption, one for blind indexes.
//  * Format: "v1.<iv>.<tag>.<ciphertext>" (base64url). The version prefix lets us rotate keys later.
//  * blindIndex() = HMAC-SHA256 of the normalised value: equality lookup (e.g. login by email)
//    without storing the plaintext.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { config } from './config.js';

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

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, { N: 16384, r: 8, p: 1 });
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
