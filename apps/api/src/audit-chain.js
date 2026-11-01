// Tamper-evident audit log (migration 129). Rows are inserted as before; sealing chains them in order, each sealed row holding the hash of the
// previous one, so changing, removing or reordering a sealed row breaks every hash after it. The database refuses any other change to a row.
// What this proves: nothing sealed was altered or removed through the app or ordinary SQL. What it does not: a database superuser who can
// disable triggers could rewrite the whole chain, so an export carries the head hash for keeping outside the database.
import { many, one } from './db.js';

const SEAL_BATCH = 5000;

/** Chain every unsealed row (oldest first). Safe to call concurrently: callers queue on the head row. */
export async function sealAuditLog() {
  let total = 0;
  for (let i = 0; i < 200; i++) {
    const n = (await one('SELECT seal_audit_log($1) AS n', [SEAL_BATCH])).n;
    total += n;
    if (n < SEAL_BATCH) break;
  }
  return total;
}

/** Seal, then recompute the whole chain. `first_break` is the sequence number of the first row that does not verify, or null. */
export async function verifyAuditChain() {
  const sealedNow = await sealAuditLog();
  const head = await one('SELECT seq::int AS seq, hash, sealed_at FROM audit_chain_head WHERE singleton');
  const bad = await one(
    `WITH s AS (
       SELECT seq, prev_hash, hash, id, actor_id, action, entity, entity_id, at,
              lag(hash) OVER (ORDER BY seq) AS expected_prev, lag(seq) OVER (ORDER BY seq) AS prev_seq
         FROM audit_log WHERE seq IS NOT NULL)
     SELECT seq::int AS seq FROM s
      WHERE prev_hash IS DISTINCT FROM expected_prev OR seq <> coalesce(prev_seq, 0) + 1
         OR hash <> audit_row_hash(prev_hash, seq, id, actor_id, action, entity, entity_id, at)
      ORDER BY seq LIMIT 1`);
  const tail = await one('SELECT max(seq)::int AS seq, count(*)::int AS n, (array_agg(hash ORDER BY seq DESC))[1] AS hash FROM audit_log WHERE seq IS NOT NULL');
  const pending = (await one('SELECT count(*)::int AS n FROM audit_log WHERE hash IS NULL')).n;
  const headMatches = (tail.seq ?? 0) === head.seq && (tail.hash ?? null) === (head.hash ?? null);
  return {
    intact: !bad && headMatches,
    first_break: bad?.seq ?? null,
    head_mismatch: !headMatches,
    sealed_rows: tail.n, sealed_now: sealedNow, pending_rows: pending,
    head: { seq: head.seq, hash: head.hash, sealed_at: head.sealed_at },
  };
}

/** A page of the chain for keeping elsewhere: rows in sequence order after `since_seq`, with their hashes (no values were ever stored). */
export async function exportAuditLog({ since_seq = 0, limit = 1000 }) {
  await sealAuditLog();
  const rows = await many(
    `SELECT seq::int AS seq, id::text AS id, actor_id, action, entity, entity_id, at, prev_hash, hash FROM audit_log WHERE seq > $1 ORDER BY seq LIMIT $2`, [since_seq, limit]);
  const head = await one('SELECT seq::int AS seq, hash, sealed_at FROM audit_chain_head WHERE singleton');
  return { rows, next_since_seq: rows.length === limit ? rows[rows.length - 1].seq : null, head };
}

