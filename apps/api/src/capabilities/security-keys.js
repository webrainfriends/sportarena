// Platform security: encryption key rotation and the tamper-evident audit log (#632). Platform admin only, enforced on the server.
// The engine is src/key-rotation.js (keyring in src/crypto.js) and src/audit-chain.js. Nothing here stores key material or values.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one } from '../db.js';
import { notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';
import { config } from '../config.js';
import { activeKeyId, knownKeyIds } from '../crypto.js';
import { keyUsage, startRotation, summariseReport } from '../key-rotation.js';
import { exportAuditLog, verifyAuditChain } from '../audit-chain.js';

const TAG = 'Platform security';
const shape = (r) => r && ({ id: r.id, target_key: r.target_key, status: r.status, started_at: r.started_at, finished_at: r.finished_at, error: r.error, summary: summariseReport(r.report), columns: Object.entries(r.report ?? {}).filter(([, v]) => !v.done || v.unmapped || v.blocked).map(([column, v]) => ({ column, reencrypted: v.reencrypted, unmapped: v.unmapped, blocked: v.blocked, done: v.done })) });

cap({
  name: 'get_key_status', method: 'GET', path: '/platform/security/keys', tag: TAG, auth: ['admin'],
  summary: 'Where encryption keys stand: the key provider (environment or AWS KMS), the key new values are written with, every key still loaded, how many stored values each key protects, whether an older key could be retired now (only when no value still depends on it), and the latest rotation runs. Counts only; no key material and no values.',
  input: z.object({}),
  async handler({ user }) {
    await mustBePlatformAdmin(user);
    await audit(null, user.id, 'read_key_status', 'platform', null);
    const active = activeKeyId();
    const { usage, unreadable, skipped } = await keyUsage();
    const keys = knownKeyIds().map((k) => ({ key_id: k, active: k === active, values: usage[k] ?? 0, retirable: k !== active && !(usage[k] ?? 0) }));
    const runs = (await many('SELECT * FROM key_rotation_runs ORDER BY started_at DESC LIMIT 5')).map(shape);
    return { provider: config.keyProvider, active_key: active, keys, unreadable_values: unreadable, columns_without_primary_key: skipped, runs };
  },
});

cap({
  name: 'start_key_rotation', method: 'POST', path: '/platform/security/keys/rotations', tag: TAG, status: 202, auth: ['admin'],
  summary: 'Re-encrypt every stored value under the active key (KEY_ACTIVE). Resumable and idempotent: calling it again continues an interrupted run and skips what is already current. Nothing is deleted; a value that cannot be mapped to its context, or sits in an append-only table, is left exactly as it is and reported. Returns the run immediately; poll get_key_rotation_run.',
  input: z.object({}),
  async handler({ user }) {
    await mustBePlatformAdmin(user);
    const run = await startRotation(user.id);
    await audit(null, user.id, 'start_key_rotation', 'key_rotation_runs', run.id);
    return shape(run);
  },
});

cap({
  name: 'get_key_rotation_run', method: 'GET', path: '/platform/security/keys/rotations/:id', tag: TAG, auth: ['admin'],
  summary: 'Progress of one key rotation run: status, totals (re-encrypted, unmapped, blocked) and every column that is not yet fully done.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const run = await one('SELECT * FROM key_rotation_runs WHERE id = $1', [i.id]);
    if (!run) throw notFound('Rotation run');
    return shape(run);
  },
});

cap({
  name: 'verify_audit_chain', method: 'POST', path: '/platform/security/audit-chain/verify', tag: TAG, auth: ['admin'],
  summary: 'Seal any audit rows not yet chained, then recompute the whole chain. Says whether it is intact, the first sequence number that fails if not, how many rows are sealed or pending, and the head hash to keep outside the database.',
  input: z.object({}),
  async handler({ user }) {
    await mustBePlatformAdmin(user);
    const r = await verifyAuditChain();
    await audit(null, user.id, 'verify_audit_chain', 'platform', null);
    return r;
  },
});

cap({
  name: 'export_audit_log', method: 'GET', path: '/platform/security/audit-log', tag: TAG, auth: ['admin'],
  summary: 'A page of the audit log in sequence order with each row\'s hash and the previous hash, plus the chain head, for keeping a copy outside the database or handing to an auditor. The log records who did what and when, never the values. Reading it is itself audit-logged.',
  input: z.object({ since_seq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(500) }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    await audit(null, user.id, 'export_audit_log', 'platform', null);
    return exportAuditLog(i);
  },
});
