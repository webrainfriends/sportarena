import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const { initWrappedMasterKey, unwrapMasterKey } = await import('../src/kms.js');

// In-memory stand-in for the KMS client: "wraps" by reversing bytes, enforces encryption context.
const fakeKms = () => {
  const dataKey = randomBytes(32);
  return {
    dataKey,
    async send(cmd) {
      const { name } = cmd.constructor;
      assert.deepEqual(cmd.input.EncryptionContext, { app: 'sportarena', purpose: 'field-encryption-master-key' });
      if (name === 'GenerateDataKeyCommand') return { Plaintext: dataKey, CiphertextBlob: Buffer.from(dataKey).reverse() };
      if (name === 'DecryptCommand') return { Plaintext: Buffer.from(cmd.input.CiphertextBlob).reverse() };
      throw new Error('unexpected ' + name);
    },
  };
};

test('KMS-wrapped master key: created once, never stored in plaintext, unwraps to the same key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kms-'));
  const cfg = { kmsKeyId: 'alias/test', kmsRegion: 'ap-southeast-1', masterKeyFile: join(dir, 'sub', 'master.key.enc') };
  const kms = fakeKms();
  assert.equal((await initWrappedMasterKey(cfg, kms)).created, true);
  const onDisk = readFileSync(cfg.masterKeyFile, 'utf8');
  assert.ok(!onDisk.includes(kms.dataKey.toString('base64')), 'plaintext key must not be on disk');
  assert.equal(statSync(cfg.masterKeyFile).mode & 0o777, 0o600);
  assert.equal((await initWrappedMasterKey(cfg, kms)).created, false, 'idempotent');
  assert.deepEqual(await unwrapMasterKey(cfg, kms), kms.dataKey);
});

test('missing wrapped key or KMS_KEY_ID fails loudly', async () => {
  await assert.rejects(unwrapMasterKey({ masterKeyFile: '/nonexistent/x' }, fakeKms()), /not found/);
  await assert.rejects(initWrappedMasterKey({ masterKeyFile: '/tmp/x' }, fakeKms()), /KMS_KEY_ID/);
});
