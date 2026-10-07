// AWS KMS envelope for the field-encryption master key.
//  * kms-init (deploy time, once): KMS GenerateDataKey -> only the *wrapped* key is written to disk (mode 600).
//  * app start-up: KMS Decrypt unwraps it into memory. Without KMS access the app refuses to start.
// The EC2 instance role needs kms:GenerateDataKey and kms:Decrypt on KMS_KEY_ID.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CONTEXT = { app: 'sportarena', purpose: 'field-encryption-master-key' };

async function client(cfg, injected) {
  if (injected) return injected;
  const { KMSClient } = await import('@aws-sdk/client-kms');
  return new KMSClient({ region: cfg.kmsRegion });
}

export async function unwrapMasterKey(cfg, injected) {
  if (!existsSync(cfg.masterKeyFile)) throw new Error(`Wrapped master key not found at ${cfg.masterKeyFile} — run scripts/kms-init.js`);
  const { DecryptCommand } = await import('@aws-sdk/client-kms');
  const kms = await client(cfg, injected);
  const out = await kms.send(new DecryptCommand({
    CiphertextBlob: Buffer.from(readFileSync(cfg.masterKeyFile, 'utf8').trim(), 'base64'),
    EncryptionContext: CONTEXT,
    ...(cfg.kmsKeyId ? { KeyId: cfg.kmsKeyId } : {}),
  }));
  const key = Buffer.from(out.Plaintext);
  if (key.length < 32) throw new Error('Unwrapped master key is too short');
  return key;
}

/** Idempotent: creates the wrapped key if missing, then verifies it can be unwrapped. */
export async function initWrappedMasterKey(cfg, injected) {
  if (!cfg.kmsKeyId) throw new Error('KMS_KEY_ID is required');
  const kms = await client(cfg, injected);
  let created = false;
  if (!existsSync(cfg.masterKeyFile)) {
    const { GenerateDataKeyCommand } = await import('@aws-sdk/client-kms');
    const out = await kms.send(new GenerateDataKeyCommand({ KeyId: cfg.kmsKeyId, KeySpec: 'AES_256', EncryptionContext: CONTEXT }));
    mkdirSync(dirname(cfg.masterKeyFile), { recursive: true, mode: 0o700 });
    writeFileSync(cfg.masterKeyFile, Buffer.from(out.CiphertextBlob).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    created = true;
  }
  await unwrapMasterKey(cfg, kms);
  return { created };
}
