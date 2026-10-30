#!/usr/bin/env node
// Deploy-time preflight: ensure the KMS-wrapped master key exists and this host can unwrap it.
// Prints status only — never key material. Exit 1 on any failure so the deploy aborts.
import { config } from '../src/config.js';
import { initWrappedMasterKey } from '../src/kms.js';
import { wrappedKeyFile } from '../src/crypto.js';

// --key-id <id> creates the wrapped key for a new ring entry (key rotation); the default is the original key k1.
const keyId = process.argv.includes('--key-id') ? process.argv[process.argv.indexOf('--key-id') + 1] : 'k1';
if (!/^[a-z0-9_-]{1,32}$/.test(keyId ?? '')) { console.error('[kms] --key-id must be lowercase letters, digits, - or _'); process.exit(1); }
const cfg = { ...config, masterKeyFile: wrappedKeyFile(config, keyId) };

try {
  const { created } = await initWrappedMasterKey(cfg);
  console.log(created ? `[kms] created wrapped master key at ${cfg.masterKeyFile}` : '[kms] wrapped master key present');
  console.log('[kms] OK: this host can unwrap the master key');
} catch (e) {
  console.error(`[kms] FAILED: ${e.name}: ${e.message}`);
  console.error('[kms] Check KMS_KEY_ID and that the EC2 instance role allows kms:GenerateDataKey and kms:Decrypt on it.');
  process.exit(1);
}
