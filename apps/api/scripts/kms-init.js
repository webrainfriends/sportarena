#!/usr/bin/env node
// Deploy-time preflight: ensure the KMS-wrapped master key exists and this host can unwrap it.
// Prints status only — never key material. Exit 1 on any failure so the deploy aborts.
import { config } from '../src/config.js';
import { initWrappedMasterKey } from '../src/kms.js';

try {
  const { created } = await initWrappedMasterKey(config);
  console.log(created ? `[kms] created wrapped master key at ${config.masterKeyFile}` : '[kms] wrapped master key present');
  console.log('[kms] OK: this host can unwrap the master key');
} catch (e) {
  console.error(`[kms] FAILED: ${e.name}: ${e.message}`);
  console.error('[kms] Check KMS_KEY_ID and that the EC2 instance role allows kms:GenerateDataKey and kms:Decrypt on it.');
  process.exit(1);
}
