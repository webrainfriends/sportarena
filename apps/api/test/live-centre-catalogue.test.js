// Every sport in the catalogue has a native live model or a labelled generic fallback for the live game centre (#578); none is a silent default.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { liveModelOf, builtinRuleset } = await import('../src/scoring/rulesets.js');
const { statsOf } = await import('../src/live-centre.js');
before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); });
after(() => pool.end());

test('the whole sport catalogue: each sport has a live model, and a generic ruleset says so', async () => {
  const sports = (await pool.query('SELECT * FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 20, 'the catalogue is seeded by migrations');
  const MODELS = ['points_events', 'sets', 'racket', 'cricket', 'cards', 'outcome', 'session'];
  const generic = [];
  for (const sp of sports) {
    const model = liveModelOf(sp);
    assert.ok(MODELS.includes(model?.model ?? model), `${sp.slug} has no live model (${JSON.stringify(model)})`);
    const rs = builtinRuleset(sp);
    assert.ok(rs.label, `${sp.slug} ruleset has a label`);
    if (/\(points\)$/.test(rs.label) || rs.kind === 'manual') generic.push(sp.slug);
    // the live centre's stats projection works for any ruleset, with or without events
    const stats = statsOf({ ruleset: rs, events: [] });
    assert.deepEqual(stats.rows, []);
  }
  console.log(`# live-centre sports: ${sports.length} total, ${generic.length} on a labelled generic/manual fallback`);
});
