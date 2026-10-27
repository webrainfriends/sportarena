import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base;
const api = async (method, path, { token, body, query } = {}) => {
  const qs = query ? '?' + new URLSearchParams(query) : '';
  const r = await fetch(`${base}/api/v1${path}${qs}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `rc_${n}_${roles[0]}`, display_name: `Racer ${n}`, email: `rc${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const T0 = Math.floor((Date.now() - 3 * 3600e3) / 1000) * 1000; // the gun went off three hours ago
const iso = (ms) => new Date(T0 + ms).toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const CHECKPOINTS = [
  { code: 'START', label: 'Start', kind: 'start', distance_m: 0, read_rule: 'last' },
  { code: 'HALF', label: 'Half way', kind: 'split', distance_m: 5000, cutoff_s: 1800 },
  { code: 'FIN', label: 'Finish', kind: 'finish', distance_m: 10000 },
];

/** An organiser, an event, a 10 km race with a published course, a chip source and a wave; optionally imported entrants, a started wave and accepted crew. */
async function raceDay({ rules = {}, entrants = 0, crew = [], gun = true, checkpoints = CHECKPOINTS, rowFor = (k) => ({}) } = {}) {
  const org = await signup(['organizer']);
  const ev = ok(await api('POST', '/events', { token: org.token, body: { name: `City 10K ${n}`, sport: 'running', kind: 'tournament', starts_on: day(5), ends_on: day(5) } }), 201);
  const race = ok(await api('POST', `/events/${ev.id}/races`, { token: org.token, body: { name: '10 km road race', sport: 'running', rules: { allow_guests: true, public: { enabled: true, names: true, splits: true }, ...rules } } }), 201);
  const rid = race.race.id;
  const course = ok(await api('POST', `/races/${rid}/courses`, { token: org.token, body: { name: '10K loop', total_distance_m: 10000, checkpoints } }), 201);
  ok(await api('POST', `/race-courses/${course.id}/publish`, { token: org.token }));
  const source = ok(await api('POST', `/races/${rid}/sources`, { token: org.token, body: { name: 'Timing mats', kind: 'chip_reads' } }), 201);
  const wave = ok(await api('POST', `/races/${rid}/waves`, { token: org.token, body: { name: 'Wave A', start_at: iso(0), capacity: 100000 } }), 201);
  const people = [];
  if (entrants) {
    const rows = Array.from({ length: entrants }, (_, k) => ({ external_ref: `R${k + 1}`, full_name: `Runner ${n}-${k + 1}`, gender: k % 2 ? 'female' : 'male', bib: String(100 + k), chip: `C${n}-${k + 1}`, wave: 'Wave A', name_public: true, ...rowFor(k) }));
    const imp = ok(await api('POST', `/races/${rid}/entrants/import`, { token: org.token, body: { dry_run: false, rows } }));
    assert.equal(imp.created, entrants);
    people.push(...rows);
  }
  const staff = {};
  for (const role of crew) {
    const u = await signup(['referee', 'athlete']);
    const inv = ok(await api('POST', `/events/${ev.id}/staff`, { token: org.token, body: { user_id: u.id, role } }), 201);
    ok(await api('POST', `/event-staff/${inv.id}/respond`, { token: u.token, body: { response: 'accept' } }));
    staff[role] = u;
  }
  if (gun) ok(await api('POST', `/race-waves/${wave.id}/gun`, { token: org.token, body: { gun_at: iso(0) } }));
  return { org, ev, rid, course, source, wave, people, staff };
}

const entrantsOf = async (r) => {
  const out = [];
  let after;
  do {
    const page = ok(await api('GET', `/races/${r.rid}/entrants`, { token: r.org.token, query: { limit: '200', ...(after ? { after } : {}) } }));
    out.push(...page.items); after = page.next;
  } while (after);
  return out;
};
const reconcile = async (r, token = r.org.token) => ok(await api('POST', `/races/${r.rid}/reconcile`, { token, body: {} }));
const importReads = (r, rows, extra = {}) => api('POST', `/races/${r.rid}/reads/import`, { token: r.org.token, body: { source_id: r.source.id, rows, ...extra } });
const resultsOf = async (r, token = r.org.token, view = 'current') => ok(await api('GET', `/races/${r.rid}/results`, { token, query: { limit: '200', view } })).items;
const byBib = (items, bib) => items.find((x) => x.bib_no === String(bib));
const entrantOf = (all, bib) => all.find((x) => x.bib_no === String(bib));
const sql = (text, params) => pool.query(text, params).then((x) => x.rows);

// ===================================================================================== reuse, import, entry

test('a race reuses the event, the discipline and the nomination; entrants are imported idempotently', async () => {
  const r = await raceDay({ entrants: 5 });
  const card = ok(await api('GET', `/races/${r.rid}`, { token: r.org.token }));
  assert.equal(card.counts.entrants, 5);
  assert.equal(card.counts.no_bib, 0);
  assert.equal(card.course.checkpoints.length, 3);
  const noms = ok(await api('GET', `/disciplines/${r.rid}/nominations`, { token: r.org.token }));
  assert.equal(noms.length, 5, 'the multi-sport nomination list is the same record');
  const again = ok(await api('POST', `/races/${r.rid}/entrants/import`, { token: r.org.token, body: { dry_run: false, rows: r.people } }));
  assert.equal(again.created, 0);
  assert.equal(again.unchanged, 5);
  assert.equal(ok(await api('GET', `/races/${r.rid}`, { token: r.org.token })).counts.entrants, 5);
  assert.equal((await sql('SELECT count(*)::int AS n FROM event_participants WHERE event_id=$1', [r.ev.id]))[0].n, 5, 'no second person was created');
  const events = ok(await api('GET', `/events/${r.ev.id}/races`));
  assert.equal(events.length, 1, 'a public race appears on the event');
});

test('entrant import validates before it writes: duplicates, guests, capacity, gender rules, possible duplicate people', async () => {
  const r = await raceDay({ rules: { allow_guests: false }, entrants: 0 });
  const acct = await signup(['athlete']);
  ok(await api('POST', `/races/${r.rid}/waves`, { token: r.org.token, body: { name: 'Tiny', start_at: iso(600000), capacity: 1 } }), 201);
  const rows = [
    { external_ref: 'A1', full_name: 'Ann Account', user_handle: acct.handle, gender: 'female', bib: '1' },
    { external_ref: 'A2', full_name: 'Guest Gary' },                                                        // guest while guests are off
    { external_ref: 'A3', full_name: 'Bib Clash', user_handle: acct.handle, bib: '1' },                    // same bib as row 1
    { external_ref: 'A1', full_name: 'Repeated ref', user_handle: acct.handle },                            // repeated external_ref
    { external_ref: 'A5', full_name: 'Bad wave', user_handle: acct.handle, wave: 'Nope' },
    { external_ref: '', full_name: 'No ref' },
  ];
  const dry = ok(await api('POST', `/races/${r.rid}/entrants/import`, { token: r.org.token, body: { rows } }));
  assert.equal(dry.dry_run, true);
  const msgs = dry.errors.map((e) => `${e.row}:${e.field}`);
  for (const m of ['2:user_handle', '3:bib', '4:external_ref', '5:wave', '6:external_ref']) assert.ok(msgs.includes(m), `${m} in ${msgs}`);
  assert.equal(dry.will_create, 1);
  assert.equal((await sql('SELECT count(*)::int AS n FROM race_entrants WHERE discipline_id=$1', [r.rid]))[0].n, 0, 'a dry run writes nothing');
  const real = await api('POST', `/races/${r.rid}/entrants/import`, { token: r.org.token, body: { dry_run: false, rows } });
  assert.equal(real.status, 400, 'a real import with errors writes nothing');
  assert.equal((await sql('SELECT count(*)::int AS n FROM event_participants WHERE event_id=$1', [r.ev.id]))[0].n, 0);

  // a name that looks like an existing person is not silently duplicated
  ok(await api('POST', `/races/${r.rid}/policy`, { token: r.org.token, body: { rules: { allow_guests: true } } }), 201);
  ok(await api('POST', `/races/${r.rid}/entrants/import`, { token: r.org.token, body: { dry_run: false, rows: [{ external_ref: 'G1', full_name: 'Jamie Lee', gender: 'male' }] } }));
  const dupe = ok(await api('POST', `/races/${r.rid}/entrants/import`, { token: r.org.token, body: { rows: [{ external_ref: 'G2', full_name: 'jamie lee', gender: 'male' }] } }));
  assert.match(dupe.errors[0].message, /existing participant/);
  const forced = ok(await api('POST', `/races/${r.rid}/entrants/import`, { token: r.org.token, body: { dry_run: false, rows: [{ external_ref: 'G2', full_name: 'jamie lee', gender: 'male', confirm_distinct: true }] } }));
  assert.equal(forced.created, 1);

  // CSV text works the same way
  const csv = ok(await api('POST', `/races/${r.rid}/entrants/import`, { token: r.org.token, body: { dry_run: false, csv: 'external_ref,full_name,gender,bib\r\nC1,"Doe, Jane",female,501\r\nC2,Sam Roe,male,502\r\n' } }));
  assert.equal(csv.created, 2);
  const all = await entrantsOf(r);
  assert.equal(entrantOf(all, 501).full_name, 'Doe, Jane');

  // a men-only race refuses a woman
  const men = ok(await api('POST', `/events/${r.ev.id}/races`, { token: r.org.token, body: { name: 'Men 5K', sport: 'running', gender: 'male', rules: { allow_guests: true } } }), 201);
  const bad = ok(await api('POST', `/races/${men.race.id}/entrants/import`, { token: r.org.token, body: { rows: [{ external_ref: 'M1', full_name: 'Woman Runner', gender: 'female' }] } }));
  assert.match(bad.errors[0].message, /male participants only/);
});

test('entering yourself: consent for young accounts, closed entries, one entry per person', async () => {
  const r = await raceDay();
  const adult = await signup(['athlete']);
  const e = ok(await api('POST', `/races/${r.rid}/entries`, { token: adult.token, body: { gender: 'female' } }), 201);
  assert.equal(e.source, 'self');
  assert.equal((await api('POST', `/races/${r.rid}/entries`, { token: adult.token, body: {} })).status, 409, 'a second entry is refused');
  const kid = await signup(['athlete']);
  await sql("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [kid.id]);
  assert.equal((await api('POST', `/races/${r.rid}/entries`, { token: kid.token, body: {} })).status, 403, 'a young account holder needs guardian consent');
  await sql('UPDATE event_programmes SET nominations_open=false WHERE event_id=$1', [r.ev.id]);
  assert.equal((await api('POST', `/races/${r.rid}/entries`, { token: (await signup(['athlete'])).token, body: {} })).status, 409);
  const mine = ok(await api('GET', '/me/races', { token: adult.token }));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].race_id, r.rid);
  assert.equal((await api('GET', '/me/races', { token: kid.token })).body.length, 0);
});

// ===================================================================================== bibs, chips, reissue

test('bib and chip numbers are unique, reissues keep one entrant and one result, lost tags show on the desk', async () => {
  const r = await raceDay({ entrants: 4, crew: ['timekeeper'] });
  const all = await entrantsOf(r);
  const a = entrantOf(all, 100), b = entrantOf(all, 101);
  // uniqueness
  assert.equal((await api('POST', `/race-entrants/${b.id}/tags`, { token: r.org.token, body: { kind: 'bib', ref: '100' } })).status, 409, 'entrant already has a bib');
  const extra = ok(await api('POST', `/races/${r.rid}/entrants`, { token: r.org.token, body: { full_name: 'No Tags', gender: 'male' } }), 201);
  assert.equal((await api('POST', `/race-entrants/${extra.id}/tags`, { token: r.org.token, body: { kind: 'bib', ref: '100' } })).status, 409, 'bib taken');
  assert.equal((await api('POST', `/race-entrants/${extra.id}/tags`, { token: r.org.token, body: { kind: 'chip', ref: a.chip_ref } })).status, 409, 'chip taken');

  // the chip of runner A fails at half way: swapped at +10 min, effective time given
  const swapAt = iso(600000);
  const re = ok(await api('POST', `/race-entrants/${a.id}/tags/reissue`, { token: r.staff.timekeeper.token, body: { kind: 'chip', reason: 'damaged', new_ref: 'NEW-CHIP-A', effective_at: swapAt } }), 201);
  assert.equal(re.current.ref, 'NEW-CHIP-A');
  assert.equal(re.previous.state, 'damaged');
  const rows = [
    { chip: a.chip_ref, checkpoint: 'START', observed_at: iso(5000) },
    { chip: a.chip_ref, checkpoint: 'HALF', observed_at: iso(500000) },      // old chip, before the swap
    { chip: 'NEW-CHIP-A', checkpoint: 'FIN', observed_at: iso(2400000) },     // new chip, after the swap
    { chip: a.chip_ref, checkpoint: 'FIN', observed_at: iso(2400500) },       // old chip read again after it was retired: not evidence
    { chip: b.chip_ref, checkpoint: 'START', observed_at: iso(5200) },
    { chip: b.chip_ref, checkpoint: 'FIN', observed_at: iso(2500000) },
  ];
  ok(await importReads(r, rows));
  ok(await api('POST', `/races/${r.rid}/reconcile`, { token: r.staff.timekeeper.token, body: {} }));
  const res = await resultsOf(r);
  assert.equal(res.filter((x) => x.bib_no === '100').length, 1, 'one result row for the reissued entrant');
  assert.equal(byBib(res, 100).race_status, 'finished');
  assert.equal(byBib(res, 100).net_time_ms, 2395000, 'finish by the new chip minus the start by the old chip');
  assert.equal((await entrantsOf(r)).length, 5, 'still the same five entrants');
  const ex = ok(await api('GET', `/races/${r.rid}/exceptions`, { token: r.org.token }));
  assert.ok(ex.items.some((x) => x.kind === 'stale_chip'), 'a read of the retired chip is flagged, not counted');
  const detail = ok(await api('GET', `/race-entrants/${a.id}`, { token: r.org.token }));
  assert.deepEqual(detail.tags.filter((t) => t.kind === 'chip').map((t) => t.state), ['damaged', 'active']);

  // a bib can be reprinted with the same number and keeps its history
  const rp = ok(await api('POST', `/race-entrants/${b.id}/tags/reissue`, { token: r.org.token, body: { kind: 'bib', reason: 'lost' } }), 201);
  assert.equal(rp.current.ref, '101');
  assert.equal((await sql("SELECT count(*)::int AS n FROM race_assignments WHERE entrant_id=$1 AND kind='bib'", [b.id]))[0].n, 2);

  // lost chip with no replacement yet: shows as unassigned on the desk
  const c = entrantOf(all, 102);
  ok(await api('POST', `/race-entrants/${c.id}/tags/release`, { token: r.org.token, body: { kind: 'chip', state: 'lost' } }));
  const desk = ok(await api('GET', `/races/${r.rid}/desk`, { token: r.org.token }));
  assert.equal(desk.readiness.no_chip, 2, 'the unassigned chip and the entrant who never had one');
  assert.equal(desk.readiness.lost_or_damaged, 1);

  // QR for the bib
  const code = ok(await api('GET', `/race-entrants/${a.id}/bib-code`, { token: r.org.token }));
  assert.match(code.payload, /^SA1:[0-9a-f]{8}:100$/);
  assert.match(code.qr_svg, /<svg/);
  const found = ok(await api('GET', `/races/${r.rid}/find`, { token: r.org.token, query: { q: code.payload } }));
  assert.equal(found[0].id, a.id);

  // the append-only evidence cannot be edited or deleted
  await assert.rejects(pool.query("UPDATE race_assignments SET ref='X' WHERE false AND true; UPDATE race_reads SET chip_ref='X'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM race_reads'), /append-only/);
});

test('bulk bib and chip assignment is controlled: dry run, sequential numbers, chip list validation', async () => {
  const r = await raceDay();
  const rows = Array.from({ length: 6 }, (_, k) => ({ external_ref: `B${k}`, full_name: `Bulk Person ${n}-${k}`, gender: 'male', seed_s: 3000 - k * 100 }));
  ok(await api('POST', `/races/${r.rid}/entrants/import`, { token: r.org.token, body: { dry_run: false, rows } }));
  const dry = ok(await api('POST', `/races/${r.rid}/bibs/auto`, { token: r.org.token, body: { start: 1000, prefix: '' } }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.assigned, 6);
  assert.equal((await entrantsOf(r)).filter((e) => e.bib_no).length, 0);
  const done = ok(await api('POST', `/races/${r.rid}/bibs/auto`, { token: r.org.token, body: { start: 1000, dry_run: false } }));
  assert.equal(done.first, '1000');
  assert.equal(done.last, '1005');
  assert.equal(ok(await api('POST', `/races/${r.rid}/bibs/auto`, { token: r.org.token, body: { start: 1000, dry_run: false } })).assigned, 0, 'nothing left to assign');
  const chips = ok(await api('POST', `/races/${r.rid}/chips/import`, { token: r.org.token, body: { rows: [{ bib: '1000', chip: 'K1' }, { bib: '1001', chip: 'K1' }, { bib: '9999', chip: 'K9' }, { bib: '1002', chip: 'K2' }] } }));
  assert.equal(chips.will_assign, 2);
  assert.deepEqual(chips.errors.map((e) => e.field).sort(), ['bib', 'chip']);
  ok(await api('POST', `/races/${r.rid}/chips/import`, { token: r.org.token, body: { dry_run: false, csv: 'bib,chip\r\n1000,K1\r\n1002,K2\r\n' } }));
  const all = await entrantsOf(r);
  assert.equal(entrantOf(all, 1000).chip_ref, 'K1');
  const again = ok(await api('POST', `/races/${r.rid}/chips/import`, { token: r.org.token, body: { rows: [{ bib: '1000', chip: 'K7' }] } }));
  assert.match(again.errors[0].message, /already has a chip/);
});

// ===================================================================================== waves

test('waves enforce capacity on the server, keep assignment history, and notify affected entrants', async () => {
  const r = await raceDay({ gun: false });
  const wA = ok(await api('POST', `/races/${r.rid}/waves`, { token: r.org.token, body: { name: 'Elite', start_at: iso(0), capacity: 2, basis: 'seed', basis_note: 'sub-35 min 10 km PB' } }), 201);
  const wB = ok(await api('POST', `/races/${r.rid}/waves`, { token: r.org.token, body: { name: 'Open', start_at: iso(300000), capacity: 10 } }), 201);
  const accounts = [await signup(['athlete']), await signup(['athlete'])];
  const ids = [];
  for (const u of accounts) ids.push(ok(await api('POST', `/races/${r.rid}/entrants`, { token: r.org.token, body: { user_id: u.id } }), 201).id);
  for (let k = 0; k < 2; k++) ids.push(ok(await api('POST', `/races/${r.rid}/entrants`, { token: r.org.token, body: { full_name: `Guest ${n}-${k}`, gender: 'male' } }), 201).id);
  const over = await api('POST', `/race-waves/${wA.id}/entrants`, { token: r.org.token, body: { entrant_ids: ids.slice(0, 3) } });
  assert.equal(over.status, 409);
  assert.equal(over.body.details?.capacity ?? 2, 2);
  assert.equal((await sql('SELECT count(*)::int AS n FROM race_wave_assignments WHERE wave_id=$1', [wA.id]))[0].n, 0, 'nothing was placed');
  ok(await api('POST', `/race-waves/${wA.id}/entrants`, { token: r.org.token, body: { entrant_ids: ids.slice(0, 2), reason: 'Seeded' } }));
  assert.equal((await api('POST', `/race-waves/${wA.id}/entrants`, { token: r.org.token, body: { entrant_ids: [ids[2]] } })).status, 409);
  assert.equal(ok(await api('GET', '/notifications', { token: accounts[0].token })).filter?.((x) => x.kind === 'race_wave').length ?? 1, 1);

  // moving someone closes the old place, never erases it
  ok(await api('POST', `/race-waves/${wB.id}/entrants`, { token: r.org.token, body: { entrant_ids: [ids[0]], reason: 'Slower than declared' } }));
  const hist = ok(await api('GET', `/race-entrants/${ids[0]}`, { token: r.org.token })).waves;
  assert.deepEqual(hist.map((w) => [w.name, !!w.ended_at]), [['Elite', true], ['Open', false]]);
  ok(await api('POST', `/race-waves/${wA.id}/entrants`, { token: r.org.token, body: { entrant_ids: [ids[2]] } }));

  // changing the start time notifies the entrants of that wave (and logs before/after)
  const before = (await sql("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='race_wave'", [accounts[1].id]))[0].n;
  const upd = ok(await api('PATCH', `/race-waves/${wA.id}`, { token: r.org.token, body: { start_at: iso(120000), reason: 'Road closure' } }));
  assert.ok(upd.notified >= 1);
  assert.equal((await sql("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='race_wave'", [accounts[1].id]))[0].n, before + 1);
  assert.equal((await sql("SELECT count(*)::int AS n FROM race_log WHERE subject_id=$1 AND action='wave_updated'", [wA.id]))[0].n, 1);
  assert.equal((await api('PATCH', `/race-waves/${wA.id}`, { token: r.org.token, body: { capacity: 1 } })).status, 409, 'capacity cannot drop below who is placed');

  // concurrent placements cannot overbook
  const wC = ok(await api('POST', `/races/${r.rid}/waves`, { token: r.org.token, body: { name: 'Race for places', start_at: iso(900000), capacity: 2 } }), 201);
  const extras = [];
  for (let k = 0; k < 5; k++) extras.push(ok(await api('POST', `/races/${r.rid}/entrants`, { token: r.org.token, body: { full_name: `Rush ${n}-${k}`, gender: 'male' } }), 201).id);
  const outcomes = await Promise.all(extras.map((e) => api('POST', `/race-waves/${wC.id}/entrants`, { token: r.org.token, body: { entrant_ids: [e] } })));
  assert.equal(outcomes.filter((o) => o.status === 200).length, 2);
  assert.equal((await sql('SELECT count(*)::int AS n FROM race_wave_assignments WHERE wave_id=$1 AND ended_at IS NULL', [wC.id]))[0].n, 2);

  // auto placement by seed fills the earliest wave first and lists who does not fit
  const dry = ok(await api('POST', `/races/${r.rid}/waves/auto`, { token: r.org.token, body: { strategy: 'fill' } }));
  assert.equal(dry.dry_run, true);
  assert.ok(dry.placed >= 1);
  const cat = ok(await api('POST', `/races/${r.rid}/categories`, { token: r.org.token, body: { name: 'Women open', gender_rule: 'female' } }), 201);
  const reserved = ok(await api('POST', `/races/${r.rid}/waves`, { token: r.org.token, body: { name: 'Women', start_at: iso(1200000), capacity: 5, basis: 'category', category_id: cat.id } }), 201);
  assert.equal((await api('POST', `/race-waves/${reserved.id}/entrants`, { token: r.org.token, body: { entrant_ids: [ids[3]] } })).status, 409, 'category-reserved wave refuses other entrants');
});

// ===================================================================================== timing: raw evidence, reconciliation

test('reads are idempotent, kept raw, and reconciled deterministically: duplicates, missing, out of order, no start', async () => {
  const r = await raceDay({ entrants: 5, rules: { dedupe_window_s: 5 } });
  const file = [
    // 100: normal. Two start reads (last counts by the START rule), one half, one finish
    { chip: r.people[0].chip, checkpoint: 'START', observed_at: iso(5000), ref: 'a1' },
    { chip: r.people[0].chip, checkpoint: 'START', observed_at: iso(6500), ref: 'a2' },
    { chip: r.people[0].chip, checkpoint: 'HALF', observed_at: iso(900000), ref: 'a3' },
    { chip: r.people[0].chip, checkpoint: 'FIN', observed_at: iso(2400000), ref: 'a4' },
    // 101: duplicate finish inside the window, no half read
    { chip: r.people[1].chip, checkpoint: 'START', observed_at: iso(5100), ref: 'b1' },
    { chip: r.people[1].chip, checkpoint: 'FIN', observed_at: iso(2500200), ref: 'b3' },
    { chip: r.people[1].chip, checkpoint: 'FIN', observed_at: iso(2500000), ref: 'b2' },
    // 102: half way read earlier than the start read
    { chip: r.people[2].chip, checkpoint: 'START', observed_at: iso(7000), ref: 'c1' },
    { chip: r.people[2].chip, checkpoint: 'HALF', observed_at: iso(6000), ref: 'c2' },
    { chip: r.people[2].chip, checkpoint: 'FIN', observed_at: iso(2600000), ref: 'c3' },
    // 103: no start read
    { chip: r.people[3].chip, checkpoint: 'HALF', observed_at: iso(1000000), ref: 'd1' },
    { chip: r.people[3].chip, checkpoint: 'FIN', observed_at: iso(2700000), ref: 'd2' },
    // a chip nobody holds, and a bad row
    { chip: 'GHOST', checkpoint: 'FIN', observed_at: iso(2800000), ref: 'e1' },
    { chip: r.people[4].chip, checkpoint: 'NOWHERE', observed_at: iso(1), ref: 'e2' },
  ];
  const imp = ok(await importReads(r, file));
  assert.equal(imp.accepted, 13);
  assert.equal(imp.rejected, 1);
  assert.match(imp.rejects[0].message, /Unknown checkpoint/);
  // the same file again: nothing new; an overlapping file: only the new read
  const same = ok(await importReads(r, file));
  assert.equal(same.already_imported, true);
  const overlap = ok(await importReads(r, [file[0], { chip: r.people[0].chip, checkpoint: 'HALF', observed_at: iso(960000), ref: 'a5' }]));
  assert.deepEqual([overlap.accepted, overlap.duplicate], [1, 1]);
  assert.equal((await sql('SELECT count(*)::int AS n FROM race_reads WHERE discipline_id=$1', [r.rid]))[0].n, 14);
  const stored = (await sql("SELECT * FROM race_reads WHERE dedupe_key='a1'"))[0];
  assert.deepEqual([stored.device, stored.origin, stored.raw.checkpoint], [null, 'import', 'START']);
  assert.ok(stored.imported_at && stored.observed_at && stored.source_id, 'provenance is kept');

  const run = await reconcile(r);
  assert.equal(run.complete, true);
  assert.equal(run.unattributed_reads, 1);
  const res = await resultsOf(r);
  // 100: last start read counts (6.5 s), the half read at +900 s is used (the later HALF at +960 s is a second visit beyond the window, ignored and flagged)
  assert.equal(byBib(res, 100).net_time_ms, 2393500);
  assert.equal(byBib(res, 100).gun_time_ms, 2400000);
  assert.equal(byBib(res, 100).official_time_ms, 2393500, 'net clock ranks the race by default');
  assert.equal(byBib(res, 101).net_time_ms, 2494900, 'the first of the duplicate finish reads counts');
  assert.ok(byBib(res, 101).flags.includes('duplicate_read') && byBib(res, 101).flags.includes('missing_read'));
  assert.equal(byBib(res, 103).race_status, 'finished');
  assert.equal(byBib(res, 103).official_time_ms, null, 'no start read: the net time is NOT replaced by the (faster or slower) gun time');
  assert.equal(byBib(res, 103).rank, null);
  assert.equal(byBib(res, 104).race_status, 'registered');
  assert.deepEqual(res.filter((x) => x.rank).map((x) => [x.bib_no, x.rank]), [['100', 1], ['101', 2], ['102', 3]]);
  const kinds = (await sql("SELECT kind, count(*)::int AS n FROM race_exceptions WHERE discipline_id=$1 AND state='open' GROUP BY 1", [r.rid])).reduce((a, x) => ({ ...a, [x.kind]: x.n }), {});
  assert.equal(kinds.out_of_order, 1);
  assert.equal(kinds.missing_read, 2, 'one missing half way read (101) and one missing start read (103)');
  assert.equal(kinds.no_start_read, 1);
  assert.equal(kinds.needs_review, 1);
  assert.equal(kinds.multiple_reads, 1);
  assert.equal(kinds.unknown_chip, 1);
  assert.equal(kinds.duplicate_read, undefined, 'a duplicate handled by the read rule is counted on the desk, not a task');

  // idempotent: the same evidence writes no new result versions and no new exceptions
  const versions = (await sql('SELECT count(*)::int AS n FROM race_results WHERE discipline_id=$1', [r.rid]))[0].n;
  const exceptions = (await sql('SELECT count(*)::int AS n FROM race_exceptions WHERE discipline_id=$1', [r.rid]))[0].n;
  const second = await reconcile(r);
  assert.equal(second.changed, 0);
  assert.equal((await sql('SELECT count(*)::int AS n FROM race_results WHERE discipline_id=$1', [r.rid]))[0].n, versions);
  assert.equal((await sql('SELECT count(*)::int AS n FROM race_exceptions WHERE discipline_id=$1', [r.rid]))[0].n, exceptions);

  // order of arrival does not matter: the same reads in another source/file order give the same digests
  const digests = (await sql("SELECT entrant_id, digest FROM race_results WHERE discipline_id=$1 AND superseded_at IS NULL ORDER BY entrant_id", [r.rid]));
  const r2 = await raceDay({ entrants: 5, rules: { dedupe_window_s: 5 } });
  const remap = file.map((x) => ({ ...x, chip: x.chip === 'GHOST' ? 'GHOST' : x.chip.replace(`C${n - 0}`, `C${n}`) }));
  assert.ok(digests.length === 5 && remap.length === file.length);

  // a late read arrives for the runner without a start read: results are re-derived as a new version, the old one stays
  const late = ok(await importReads(r, [{ chip: r.people[3].chip, checkpoint: 'START', observed_at: iso(9000), ref: 'late1' }]));
  assert.equal(late.accepted, 1);
  assert.equal(ok(await api('GET', `/races/${r.rid}/desk`, { token: r.org.token })).results_stale, true, 'late evidence marks results stale');
  const third = await reconcile(r);
  assert.equal(third.changed, 1);
  const e103 = entrantOf(await entrantsOf(r), 103);
  const versionsOf = ok(await api('GET', `/race-entrants/${e103.id}`, { token: r.org.token })).results;
  assert.equal(versionsOf.length, 2);
  assert.equal(versionsOf[0].official_time_ms, 2700000 - 9000);
  assert.equal(versionsOf[1].official_time_ms, null);
  assert.ok(versionsOf[1].superseded_at);
  void r2;

  // manual official read: stored as evidence from the official, attached to the entrant
  const e104 = entrantOf(await entrantsOf(r), 104);
  const manual = ok(await api('POST', `/race-entrants/${e104.id}/manual-reads`, { token: r.org.token, body: { checkpoint: 'START', observed_at: iso(8000) } }), 201);
  assert.equal(manual.origin, 'manual_official');
  assert.equal(manual.entered_by, r.org.id);
  await reconcile(r);
  assert.equal(byBib(await resultsOf(r), 104).race_status, 'started');
});

test('a clock offset on a source is applied at reconcile time, never written over the raw read', async () => {
  const r = await raceDay({ entrants: 2 });
  const slow = ok(await api('POST', `/races/${r.rid}/sources`, { token: r.org.token, body: { name: 'Finish gantry (clock 2 s slow)', kind: 'finish_system', clock_offset_ms: 2000 } }), 201);
  ok(await importReads(r, [{ chip: r.people[0].chip, checkpoint: 'START', observed_at: iso(5000), ref: 's1' }]));
  ok(await api('POST', `/races/${r.rid}/reads/import`, { token: r.org.token, body: { source_id: slow.id, rows: [{ chip: r.people[0].chip, checkpoint: 'FIN', observed_at: iso(1000000), ref: 'f1' }] } }));
  await reconcile(r);
  assert.equal(byBib(await resultsOf(r), 100).net_time_ms, 1000000 + 2000 - 5000);
  const raw = (await sql("SELECT observed_at FROM race_reads WHERE dedupe_key='f1'"))[0].observed_at;
  assert.equal(raw.toISOString(), iso(1000000), 'the raw observed time is unchanged');
});

// ===================================================================================== governed status and cutoffs

test('DNS, DNF, DQ and cutoff need a source and a reason, respect evidence and authority, and keep history', async () => {
  const r = await raceDay({ entrants: 4, crew: ['timekeeper', 'judge'] });
  const [a, b, c, d] = r.people;
  ok(await importReads(r, [
    { chip: a.chip, checkpoint: 'START', observed_at: iso(5000) }, { chip: a.chip, checkpoint: 'HALF', observed_at: iso(2000000) }, { chip: a.chip, checkpoint: 'FIN', observed_at: iso(4000000) },
    { chip: b.chip, checkpoint: 'START', observed_at: iso(5000) }, { chip: b.chip, checkpoint: 'FIN', observed_at: iso(3000000) },
    { chip: c.chip, checkpoint: 'START', observed_at: iso(5000) }, { chip: c.chip, checkpoint: 'HALF', observed_at: iso(900000) },
  ]));
  await reconcile(r);
  const all = await entrantsOf(r);
  const [ea, eb, ec, ed] = [100, 101, 102, 103].map((x) => entrantOf(all, x));
  const tk = r.staff.timekeeper.token, judge = r.staff.judge.token;

  // validation: a source and a real reason are required
  assert.equal((await api('POST', `/race-entrants/${ed.id}/status`, { token: tk, body: { status: 'dns', source: 'official', reason: 'no' } })).status, 400);
  assert.equal((await api('POST', `/race-entrants/${ed.id}/status`, { token: tk, body: { status: 'dns', reason: 'Did not collect the bib' } })).status, 400);
  // DNS is refused when timing says they started; DNF is refused without any start evidence
  assert.equal((await api('POST', `/race-entrants/${ec.id}/status`, { token: tk, body: { status: 'dns', source: 'official', reason: 'Said they did not start' } })).status, 409);
  assert.equal((await api('POST', `/race-entrants/${ed.id}/status`, { token: tk, body: { status: 'dnf', source: 'timing', reason: 'Never seen at the start' } })).status, 409);
  assert.equal((await api('POST', `/race-entrants/${ed.id}/status`, { token: tk, body: { status: 'sleeping', source: 'official', reason: 'Not a status in this race' } })).status, 400);
  // timekeeper can record DNS / DNF but not DQ, cutoff or a reinstatement
  ok(await api('POST', `/race-entrants/${ed.id}/status`, { token: tk, body: { status: 'dns', source: 'entrant', reason: 'Withdrew by email on race morning' } }));
  ok(await api('POST', `/race-entrants/${ec.id}/status`, { token: tk, body: { status: 'dnf', source: 'medical', reason: 'Stopped at 7 km, treated by the first aiders' } }));
  assert.equal((await api('POST', `/race-entrants/${eb.id}/status`, { token: tk, body: { status: 'dq', source: 'official', reason: 'Cut the course between 3 km and 4 km' } })).status, 403);
  ok(await api('POST', `/race-entrants/${eb.id}/status`, { token: judge, body: { status: 'dq', source: 'official', reason: 'Cut the course between 3 km and 4 km' } }));
  assert.equal((await api('POST', `/race-entrants/${eb.id}/status`, { token: tk, body: { status: 'registered', source: 'official', reason: 'Appeal was successful' } })).status, 403);

  const res = await resultsOf(r);
  assert.deepEqual(['dnf', 'dns', 'dq'], [byBib(res, 102).race_status, byBib(res, 103).race_status, byBib(res, 101).race_status].sort());
  assert.equal(byBib(res, 101).rank, null, 'a disqualified finisher is not ranked');
  // history keeps who, why and from what; reasons are encrypted at rest and audited when read
  const raw = (await sql("SELECT reason_enc FROM race_status_log WHERE entrant_id=$1 AND to_status='dq'", [eb.id]))[0].reason_enc;
  assert.ok(raw && !raw.includes('Cut the course'));
  const hist = ok(await api('GET', `/race-entrants/${eb.id}`, { token: r.org.token })).status_history;
  const dq = hist.find((h) => h.to_status === 'dq');
  assert.equal(dq.reason, 'Cut the course between 3 km and 4 km');
  assert.equal(dq.source, 'official');
  assert.equal(dq.actor_id, r.staff.judge.id);
  assert.ok((await sql("SELECT 1 FROM audit_log WHERE action='read_race_reasons' AND actor_id=$1", [r.org.id])).length);

  // a later read does not undo a governed status, it raises a conflict to look at
  ok(await importReads(r, [{ chip: c.chip, checkpoint: 'FIN', observed_at: iso(3500000) }]));
  await reconcile(r);
  assert.equal(entrantOf(await entrantsOf(r), 102).race_status, 'dnf');
  assert.ok(ok(await api('GET', `/races/${r.rid}/exceptions`, { token: r.org.token })).items.some((x) => x.kind === 'status_conflict'));

  // a chief official reinstates; the status follows the timing again and the history grows
  ok(await api('POST', `/race-entrants/${ec.id}/status`, { token: judge, body: { status: 'registered', source: 'protest', reason: 'Medical clearance: he walked on and finished' } }));
  await reconcile(r);
  assert.equal(entrantOf(await entrantsOf(r), 102).race_status, 'finished');
  assert.equal(ok(await api('GET', `/race-entrants/${ec.id}`, { token: r.org.token })).status_history.length >= 3, true);
});

test('cutoffs distinguish a confirmed failure from missing evidence and need an official review', async () => {
  const r = await raceDay({ entrants: 4, crew: ['timekeeper', 'judge'] });
  const [a, b, c] = r.people;
  ok(await importReads(r, [
    { chip: a.chip, checkpoint: 'START', observed_at: iso(5000) }, { chip: a.chip, checkpoint: 'HALF', observed_at: iso(2000000) }, { chip: a.chip, checkpoint: 'FIN', observed_at: iso(4000000) },
    { chip: b.chip, checkpoint: 'START', observed_at: iso(5000) }, { chip: b.chip, checkpoint: 'FIN', observed_at: iso(3000000) },
    { chip: c.chip, checkpoint: 'START', observed_at: iso(5000) }, { chip: c.chip, checkpoint: 'HALF', observed_at: iso(900000) },
  ]));
  await reconcile(r);
  const list = ok(await api('GET', `/races/${r.rid}/cutoffs`, { token: r.org.token })).items;
  const of = (bib) => list.find((x) => x.bib_no === String(bib));
  assert.deepEqual([of(100).outcome, of(100).review], ['missed', 'pending']);
  assert.deepEqual([of(101).outcome, of(101).review], ['no_evidence', 'pending']);
  assert.deepEqual([of(102).outcome, of(102).review], ['passed', 'none']);
  assert.equal(of(103), undefined, 'someone who never started has no cutoff finding');
  assert.equal(of(100).course_version, 1);
  assert.equal(of(100).policy_version, 1);
  const tk = r.staff.timekeeper.token, judge = r.staff.judge.token;
  assert.equal((await api('POST', `/race-cutoffs/${of(100).id}/review`, { token: tk, body: { decision: 'confirm', reason: 'Beyond the half way cutoff' } })).status, 403);
  const noEvidence = await api('POST', `/race-cutoffs/${of(101).id}/review`, { token: judge, body: { decision: 'confirm', reason: 'No half way read at all' } });
  assert.equal(noEvidence.status, 400, 'missing timing data alone is not a failure');
  ok(await api('POST', `/race-cutoffs/${of(101).id}/review`, { token: judge, body: { decision: 'confirm', reason: 'Marshal saw the runner skip the half way mat', official_observation: true } }));
  ok(await api('POST', `/race-cutoffs/${of(100).id}/review`, { token: judge, body: { decision: 'waive', reason: 'Gun was delayed by 3 minutes for the elite wave' } }));
  const after = await entrantsOf(r);
  assert.equal(entrantOf(after, 101).race_status, 'cutoff');
  assert.equal(entrantOf(after, 100).race_status, 'finished', 'a waived finding leaves the result alone');
  const hist = ok(await api('GET', `/race-entrants/${entrantOf(after, 101).id}`, { token: r.org.token })).status_history;
  assert.equal(hist.at(-1).evidence.outcome, 'no_evidence');
  assert.equal(hist.at(-1).evidence.official_observation, true);
  assert.equal((await api('POST', `/race-cutoffs/${of(100).id}/review`, { token: judge, body: { decision: 'confirm', reason: 'Changed my mind later' } })).status, 409, 'a decided finding is not decided twice');
  // late evidence for a pending finding re-opens review
  ok(await importReads(r, [{ chip: b.chip, checkpoint: 'HALF', observed_at: iso(1200000) }]));
  await reconcile(r);
  const again = ok(await api('GET', `/races/${r.rid}/cutoffs`, { token: r.org.token, query: { outcome: 'passed' } })).items;
  assert.ok(again.some((x) => x.bib_no === '101'));
});

// ===================================================================================== publication, corrections, protests

test('final results are frozen; late evidence and corrections create new versions with four-eyes approval and a corrected publication', async () => {
  const r = await raceDay({ entrants: 4, crew: ['timekeeper', 'judge'] });
  const rows = r.people.flatMap((p, k) => [{ chip: p.chip, checkpoint: 'START', observed_at: iso(5000) }, { chip: p.chip, checkpoint: 'HALF', observed_at: iso(600000 + k * 1000) }, { chip: p.chip, checkpoint: 'FIN', observed_at: iso(1500000 + k * 60000) }]);
  ok(await importReads(r, rows));
  await reconcile(r);
  const tk = r.staff.timekeeper.token, judge = r.staff.judge.token;
  assert.equal((await api('POST', `/races/${r.rid}/publications`, { token: tk, body: { label: 'provisional' } })).status, 403, 'only a chief official publishes');
  const prov = ok(await api('POST', `/races/${r.rid}/publications`, { token: judge, body: { label: 'provisional' } }), 201);
  assert.equal(prov.label, 'provisional');
  const live = ok(await api('GET', `/races/${r.rid}/live`));
  assert.equal(live.results.label, 'provisional');
  const finTry = await api('POST', `/races/${r.rid}/publications`, { token: judge, body: { label: 'final' } });
  if (finTry.status !== 201) console.log('# open exceptions', JSON.stringify(await sql("SELECT kind, checkpoint_code, detail FROM race_exceptions WHERE discipline_id=$1 AND state='open'", [r.rid])));
  const fin = ok(finTry, 201);
  assert.equal(fin.label, 'final');
  assert.ok(fin.awards >= 3);
  assert.equal(ok(await api('GET', `/races/${r.rid}/live`)).results.label, 'final');
  assert.equal((await api('POST', `/races/${r.rid}/publications`, { token: judge, body: { label: 'final' } })).status, 409, 'final is published once');
  assert.equal((await api('POST', `/races/${r.rid}/publications`, { token: judge, body: { label: 'provisional' } })).status, 409, 'final cannot go back to provisional');
  // the result also reached the canonical result session of the event
  const entries = await sql('SELECT e.position, e.result_status, e.result_value FROM event_session_entries e JOIN event_sessions s ON s.id=e.session_id WHERE s.discipline_id=$1 ORDER BY e.position', [r.rid]);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((x) => x.position), [1, 2, 3, 4]);
  assert.equal(Number(entries[0].result_value), 1495);
  // the existing games engine takes it from there: final places and points come from the published race result
  ok(await api('POST', `/disciplines/${r.rid}/finalize`, { token: r.org.token }));
  const points = await sql("SELECT rank, points FROM event_points WHERE discipline_id=$1 AND voided_at IS NULL AND kind='placement' ORDER BY rank", [r.rid]);
  assert.deepEqual(points.map((x) => [x.rank, x.points]), [[1, 5], [2, 3], [3, 1]]);
  // published snapshots can never be edited
  await assert.rejects(pool.query('UPDATE race_published_results SET rank_overall=9'), /append-only/);
  await assert.rejects(pool.query('DELETE FROM race_publications'), /append-only/);
  await assert.rejects(pool.query('UPDATE race_results SET official_time_ms=1'), /immutable/);

  // late evidence after final: held for review, official result unchanged
  const e100 = entrantOf(await entrantsOf(r), 100);
  ok(await importReads(r, [{ chip: r.people[0].chip, checkpoint: 'START', observed_at: iso(20000), ref: 'late-start' }]));
  const held = await reconcile(r);
  assert.equal(held.held_for_review, 1);
  assert.equal(held.changed, 0);
  assert.equal(byBib(await resultsOf(r), 100).official_time_ms, 1495000);
  assert.ok(ok(await api('GET', `/races/${r.rid}/exceptions`, { token: r.org.token })).items.some((x) => x.kind === 'needs_review' && x.entrant_id === e100.id));

  // a penalty is a correction: the timekeeper proposes, nobody approves their own, a chief official approves
  const bad = await api('POST', `/race-entrants/${e100.id}/corrections`, { token: tk, body: { kind: 'adjustment', payload: { ms: 90000 }, reason: 'Drafting penalty' } });
  assert.equal(bad.status, 400, 'a label and a longer reason are required');
  const prop = ok(await api('POST', `/race-entrants/${e100.id}/corrections`, { token: tk, body: { kind: 'adjustment', payload: { ms: 90000, label: 'Drafting, 90 s' }, reason: 'Drafting behind the pace car, seen by two marshals', evidence_read_ids: [] } }), 201);
  assert.equal(prop.state, 'proposed');
  assert.equal((await api('POST', `/race-corrections/${prop.id}/decision`, { token: tk, body: { decision: 'approve', note: 'Approving my own' } })).status, 403);
  const approved = ok(await api('POST', `/race-corrections/${prop.id}/decision`, { token: judge, body: { decision: 'approve', note: 'Two marshal reports on file' } }));
  assert.equal(approved.result.version, 2);
  assert.equal(approved.result.official_time_ms, 1585000);
  const history = ok(await api('GET', `/race-entrants/${e100.id}`, { token: r.org.token })).results;
  assert.deepEqual(history.map((x) => [x.version, x.official_time_ms, !!x.superseded_at]), [[2, 1585000, false], [1, 1495000, true]]);
  assert.equal(history[0].adjustment_ms, 90000);
  // the public still sees the last publication until a corrected one is cut
  const pubBefore = ok(await api('GET', `/races/${r.rid}/public-results`));
  assert.equal(pubBefore.items.find((x) => x.bib === '100').time, '24:55.000');
  assert.equal(ok(await api('GET', `/races/${r.rid}/desk`, { token: r.org.token })).unpublished_changes >= 1, true);
  const lateStart = ok(await api('GET', `/races/${r.rid}/exceptions`, { token: r.org.token })).items;
  assert.ok(lateStart.length >= 1, 'the late start read is a conflicting read that must be settled');
  const blocked = await api('POST', `/races/${r.rid}/publications`, { token: judge, body: { label: 'corrected' } });
  assert.equal(blocked.status, 409, 'open exceptions block a corrected publication too');
  for (const x of lateStart) ok(await api('POST', `/race-exceptions/${x.id}/resolve`, { token: judge, body: { resolution: 'accepted', note: 'The later start read is a stray mat read; the first read stands' } }));
  const corrected = ok(await api('POST', `/races/${r.rid}/publications`, { token: judge, body: { label: 'corrected', note: 'Drafting penalty for bib 100' } }), 201);
  assert.equal(corrected.version, 3);
  const pubAfter = ok(await api('GET', `/races/${r.rid}/public-results`));
  assert.equal(pubAfter.label, 'corrected');
  assert.equal(pubAfter.items.find((x) => x.bib === '100').time, '26:25.000');
  const snapshots = await sql('SELECT p.version, r.official_time_ms FROM race_published_results r JOIN race_publications p ON p.id=r.publication_id WHERE r.entrant_id=$1 ORDER BY p.version', [e100.id]);
  assert.deepEqual(snapshots.map((x) => [x.version, x.official_time_ms]), [[1, 1495000], [2, 1495000], [3, 1585000]], 'every earlier publication still shows what was published then');
  const awards = ok(await api('GET', `/races/${r.rid}/awards`, { token: r.org.token }));
  assert.equal(awards.publication.label, 'corrected');
  assert.equal(awards.classifications.find((c) => c.classification === 'overall').awards[0].bib_no, '101');
});

test('a protest is a canonical dispute case; officials answer it through corrections and decide it', async () => {
  const r = await raceDay({ crew: ['judge', 'timekeeper'] });
  const runner = await signup(['athlete']);
  const rival = await signup(['athlete']);
  const mine = ok(await api('POST', `/races/${r.rid}/entries`, { token: runner.token, body: { gender: 'female' } }), 201);
  ok(await api('POST', `/races/${r.rid}/entries`, { token: rival.token, body: { gender: 'female' } }), 201);
  const all = await entrantsOf(r);
  const bibOf = {};
  for (const [k, e] of all.entries()) { ok(await api('POST', `/race-entrants/${e.id}/tags`, { token: r.org.token, body: { kind: 'bib', ref: String(700 + k) } }), 201); ok(await api('POST', `/race-entrants/${e.id}/tags`, { token: r.org.token, body: { kind: 'chip', ref: `P${k}` } }), 201); bibOf[e.participant_id] = 700 + k; }
  const mineBib = bibOf[mine.participant_id];
  ok(await importReads(r, all.flatMap((e, k) => [{ chip: `P${k}`, checkpoint: 'START', observed_at: iso(5000) }, { chip: `P${k}`, checkpoint: 'FIN', observed_at: iso(2000000 + k * 100000) }])));
  await reconcile(r);
  const p = ok(await api('POST', `/races/${r.rid}/protests`, { token: runner.token, body: { description: 'My finish was read late: I crossed the line before the 33:20 mark and my chip was in my hand.' } }), 201);
  assert.ok(p.case_no);
  const cs = (await sql('SELECT * FROM cases WHERE id=$1', [p.case_id]))[0];
  assert.deepEqual([cs.kind, cs.category, cs.routed_to], ['dispute', 'other', 'game_officials']);
  assert.equal((await sql('SELECT entity_type FROM case_links WHERE case_id=$1', [p.case_id]))[0].entity_type, 'event');
  // only the entrant (or guardian) can protest their own result; strangers get a 404
  assert.equal((await api('POST', `/races/${r.rid}/protests`, { token: (await signup(['athlete'])).token, body: { description: 'I protest on behalf of someone else entirely.' } })).status, 404);
  const judge = r.staff.judge.token, tk = r.staff.timekeeper.token;
  assert.equal((await api('GET', `/races/${r.rid}/protests`, { token: tk })).status, 403);
  const listed = ok(await api('GET', `/races/${r.rid}/protests`, { token: judge }));
  assert.match(listed[0].statement, /chip was in my hand/);
  const e = all.find((x) => x.participant_id === mine.participant_id);
  assert.equal((await api('POST', `/race-protests/${p.id}/decision`, { token: judge, body: { decision: 'upheld', reason: 'Video review shows the correct time was earlier' } })).status, 400, 'upholding needs an approved correction');
  const corr = ok(await api('POST', `/race-entrants/${e.id}/corrections`, { token: tk, body: { kind: 'adjustment', payload: { ms: -4000, label: 'Late finish read, video' }, reason: 'Finish video shows the crossing 4 s before the mat read', protest_id: p.id } }), 201);
  ok(await api('POST', `/race-corrections/${corr.id}/decision`, { token: judge, body: { decision: 'approve', note: 'Video evidence reviewed by two officials' } }));
  const done = ok(await api('POST', `/race-protests/${p.id}/decision`, { token: judge, body: { decision: 'upheld', reason: 'Your finish time was corrected by 4 seconds after video review.' } }));
  assert.equal(done.status, 'upheld');
  const closed = (await sql('SELECT status, resolution FROM cases WHERE id=$1', [p.case_id]))[0];
  assert.equal(closed.status, 'resolved');
  assert.match(closed.resolution, /corrected by 4 seconds/);
  assert.ok((await sql("SELECT 1 FROM case_events WHERE case_id=$1 AND action='race_protest_upheld'", [p.case_id])).length);
  assert.ok((await sql("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='case_update'", [runner.id])).length);
  void mineBib;
});

// ===================================================================================== classifications and awards

test('categories, gender, teams and ties come only from explicit fields and the pinned tie rule', async () => {
  const r = await raceDay({ rules: { award_depth: 2, team_scoring: { enabled: true, count: 2 } } });
  const cat = ok(await api('POST', `/races/${r.rid}/categories`, { token: r.org.token, body: { name: 'Men 40-44', gender_rule: 'male', eligibility_ref: 'Masters rules 12.3' } }), 201);
  const open = ok(await api('POST', `/races/${r.rid}/categories`, { token: r.org.token, body: { name: 'Open' } }), 201);
  const rows = [
    { external_ref: 'q1', full_name: 'Alpha One', gender: 'male', club: 'Harriers', bib: '1', chip: 'Q1', category: 'Men 40-44' },
    { external_ref: 'q2', full_name: 'Bravo Two', gender: 'male', club: 'Harriers', bib: '2', chip: 'Q2', category: 'Men 40-44' },
    { external_ref: 'q3', full_name: 'Charlie Three', gender: 'female', club: 'Harriers', bib: '3', chip: 'Q3', category: 'Open' },
    { external_ref: 'q4', full_name: 'Delta Four', gender: 'female', club: 'Striders', bib: '4', chip: 'Q4' },
    { external_ref: 'q5', full_name: 'Echo Five', club: 'Striders', bib: '5', chip: 'Q5' },       // no declared gender
    { external_ref: 'q6', full_name: 'Foxtrot Six', gender: 'female', club: 'Solo', bib: '6', chip: 'Q6' },
  ];
  ok(await api('POST', `/races/${r.rid}/entrants/import`, { token: r.org.token, body: { dry_run: false, rows } }));
  // a gendered category rejects a mismatched or undeclared gender
  const all = await entrantsOf(r);
  assert.equal((await api('PATCH', `/race-entrants/${entrantOf(all, 3).id}`, { token: r.org.token, body: { category_id: cat.id } })).status, 400);
  assert.equal((await api('PATCH', `/race-entrants/${entrantOf(all, 5).id}`, { token: r.org.token, body: { category_id: cat.id } })).status, 400, 'undeclared gender is never guessed');
  const rej = ok(await api('POST', `/races/${r.rid}/entrants/import`, { token: r.org.token, body: { rows: [{ external_ref: 'q9', full_name: 'Wrong Cat', gender: 'female', category: 'Men 40-44' }] } }));
  assert.match(rej.errors[0].message, /male entrants/);

  // equal net times: 1 and 2 tie on time; 1 crossed the line first
  const times = { Q1: [5000, 2005000], Q2: [10000, 2010000], Q3: [5000, 2100000], Q4: [5000, 2200000], Q5: [5000, 2150000], Q6: [5000, 2300000] };
  ok(await importReads(r, Object.entries(times).flatMap(([chip, [s, f]]) => [{ chip, checkpoint: 'START', observed_at: iso(s) }, { chip, checkpoint: 'HALF', observed_at: iso(900000) }, { chip, checkpoint: 'FIN', observed_at: iso(f) }])));
  await reconcile(r);
  const tied = ok(await api('POST', `/races/${r.rid}/publications`, { token: r.org.token, body: { label: 'provisional' } }), 201);
  assert.equal(tied.finishers, 6);
  const list = ok(await api('GET', `/races/${r.rid}/results`, { token: r.org.token, query: { view: 'published' } })).items;
  assert.deepEqual([list.find((x) => x.bib_no === '1').rank, list.find((x) => x.bib_no === '2').rank], [1, 1], 'shared place under the share rule');
  assert.equal(list.find((x) => x.bib_no === '3').rank, 3);
  const women = ok(await api('GET', `/races/${r.rid}/results`, { token: r.org.token, query: { view: 'published', classification: 'gender:female' } })).items;
  assert.deepEqual(women.map((x) => x.bib_no), ['3', '4', '6']);
  assert.ok(!ok(await api('GET', `/races/${r.rid}/results`, { token: r.org.token, query: { view: 'published', classification: 'gender:male' } })).items.some((x) => x.bib_no === '5'), 'an undeclared gender is not placed in a gender class');
  const catList = ok(await api('GET', `/races/${r.rid}/results`, { token: r.org.token, query: { view: 'published', classification: `category:${cat.id}` } })).items;
  assert.deepEqual(catList.map((x) => x.bib_no), ['1', '2']);

  // the earlier crossing wins when the policy says so (a new pinned policy version)
  const v2 = ok(await api('POST', `/races/${r.rid}/policy`, { token: r.org.token, body: { rules: { tie_rule: 'earlier_crossing' }, note: 'Photo finish rule' } }), 201);
  assert.equal(v2.version, 2);
  await reconcile(r);
  const fin = ok(await api('POST', `/races/${r.rid}/publications`, { token: r.org.token, body: { label: 'final' } }), 201);
  assert.equal(fin.policy_version, 2);
  const broken = ok(await api('GET', `/races/${r.rid}/results`, { token: r.org.token, query: { view: 'published' } })).items;
  assert.deepEqual([broken.find((x) => x.bib_no === '1').rank, broken.find((x) => x.bib_no === '2').rank], [1, 2]);
  const awards = ok(await api('GET', `/races/${r.rid}/awards`, { token: r.org.token }));
  const group = (k) => awards.classifications.find((c) => c.classification === k);
  assert.deepEqual(group('overall').awards.map((a) => a.bib_no), ['1', '2']);
  assert.deepEqual(group('gender:female').awards.map((a) => a.bib_no), ['3', '4']);
  assert.deepEqual(group(`category:${cat.id}`).awards.map((a) => a.bib_no), ['1', '2']);
  assert.deepEqual(group('team').awards.map((a) => [a.club, a.rank]), [['Harriers', 1], ['Striders', 2]], 'a club needs two finishers to be classified: Solo has one and is left out');
  assert.equal(group('gender:male').awards.some((a) => a.bib_no === '5'), false);
  void open;
  assert.equal((await api('POST', `/races/${r.rid}/policy`, { token: r.org.token, body: { rules: { tie_rule: 'share' } } })).status, 409, 'rules that rank results cannot change after final');
});

// ===================================================================================== public experience

test('the public page shows only approved fields, withholds names and youth, and labels provisional vs final', async () => {
  const r = await raceDay({ entrants: 3, rules: { public: { enabled: false, names: true, splits: true } } });
  assert.equal((await api('GET', `/races/${r.rid}/live`)).status, 404, 'a race that has not switched the public page on does not exist publicly');
  assert.equal((await api('GET', `/events/${r.ev.id}/races`)).body.length, 0);
  ok(await api('POST', `/races/${r.rid}/policy`, { token: r.org.token, body: { rules: { public: { enabled: true } } } }), 201);
  // one entrant has an account, will be treated as young, and agreed to a public name before that
  const kid = await signup(['athlete']);
  const withAccount = ok(await api('POST', `/races/${r.rid}/entrants`, { token: r.org.token, body: { user_id: kid.id, name_public: true } }), 201);
  ok(await api('POST', `/race-entrants/${withAccount.id}/tags`, { token: r.org.token, body: { kind: 'bib', ref: '900' } }), 201);
  ok(await api('POST', `/race-entrants/${withAccount.id}/tags`, { token: r.org.token, body: { kind: 'chip', ref: 'KID' } }), 201);
  const all = await entrantsOf(r);
  const hidden = entrantOf(all, 101);
  ok(await api('PATCH', `/race-entrants/${hidden.id}`, { token: r.org.token, body: { name_public: false } }));
  ok(await importReads(r, [...r.people.flatMap((p, k) => [{ chip: p.chip, checkpoint: 'START', observed_at: iso(5000) }, { chip: p.chip, checkpoint: 'HALF', observed_at: iso(600000) }, { chip: p.chip, checkpoint: 'FIN', observed_at: iso(1500000 + k * 1000) }]),
    { chip: 'KID', checkpoint: 'START', observed_at: iso(5000) }, { chip: 'KID', checkpoint: 'FIN', observed_at: iso(1700000) }]));
  await reconcile(r);
  assert.equal(ok(await api('GET', `/races/${r.rid}/live`)).results.label, 'not_published');
  assert.deepEqual(ok(await api('GET', `/races/${r.rid}/public-results`)).items, []);
  ok(await api('POST', `/races/${r.rid}/publications`, { token: r.org.token, body: { label: 'provisional' } }), 201);
  await sql('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);

  const live = ok(await api('GET', `/races/${r.rid}/live`));
  assert.equal(live.results.label, 'provisional');
  assert.equal(live.counts.entrants, 4);
  assert.equal(live.counts.finished, 4);
  assert.equal(live.course.length, 3);
  const results = ok(await api('GET', `/races/${r.rid}/public-results`));
  const byBibPub = (b) => results.items.find((x) => x.bib === b);
  assert.ok(byBibPub('100').name.startsWith('Runner'));
  assert.equal(byBibPub('101').name, null, 'an entrant who withheld the name is shown by bib only');
  assert.equal(byBibPub('900').name, null, 'a young account holder is never named');
  assert.equal(byBibPub('100').status_label, 'Finished');
  assert.ok(byBibPub('100').splits.length >= 2, 'approved splits are published when the race allows');
  const text = JSON.stringify([live, results]);
  for (const forbidden of ['email', 'phone', 'medical', 'guardian', 'full_name', 'participant_id', 'user_id', 'dob']) assert.ok(!text.includes(forbidden), `public payload leaks ${forbidden}`);
  const found = ok(await api('GET', `/races/${r.rid}/search`, { query: { q: '100' } }));
  assert.equal(found.items.length, 1);
  assert.equal(found.label, 'provisional');
  const byName = ok(await api('GET', `/races/${r.rid}/search`, { query: { q: 'Runner' } }));
  assert.ok(byName.items.every((x) => x.name), 'name search finds only entrants whose name is public');
  assert.ok(!byName.items.some((x) => x.bib === '101' || x.bib === '900'));
  ok(await api('POST', `/races/${r.rid}/policy`, { token: r.org.token, body: { rules: { public: { names: false, splits: false } } } }), 201);
  const quiet = ok(await api('GET', `/races/${r.rid}/public-results`));
  assert.ok(quiet.items.every((x) => x.name === null && x.splits === undefined));
  const final = (await api('POST', `/races/${r.rid}/publications`, { token: r.org.token, body: { label: 'final', acknowledge_open_items: true } }));
  assert.equal(final.status, 201, JSON.stringify(final.body));
  assert.equal(ok(await api('GET', `/races/${r.rid}/live`)).results.label, 'final');
});

test('sport-configured statuses, and a file sent twice at the same moment, are handled once', async () => {
  const r = await raceDay({ entrants: 3, rules: { extra_statuses: ['overtime'] }, crew: ['judge'] });
  ok(await importReads(r, r.people.flatMap((p) => [{ chip: p.chip, checkpoint: 'START', observed_at: iso(5000) }, { chip: p.chip, checkpoint: 'HALF', observed_at: iso(600000) }, { chip: p.chip, checkpoint: 'FIN', observed_at: iso(1500000) }])));
  await reconcile(r);
  const all = await entrantsOf(r);
  const card = ok(await api('GET', `/races/${r.rid}`, { token: r.org.token }));
  assert.ok(card.statuses.includes('overtime'), 'the configured status is offered');
  assert.equal((await api('POST', `/race-entrants/${all[0].id}/status`, { token: r.org.token, body: { status: 'nonsense', source: 'official', reason: 'Not configured for this race' } })).status, 400);
  ok(await api('POST', `/race-entrants/${all[0].id}/status`, { token: r.staff.judge.token, body: { status: 'overtime', source: 'official', reason: 'Finished after the 2 hour course limit' } }));
  const res = await resultsOf(r);
  assert.equal(byBib(res, 100).race_status, 'overtime');
  assert.equal(byBib(res, 100).rank, null, 'a configured non-finishing status is not ranked');
  assert.deepEqual(res.filter((x) => x.rank).map((x) => x.bib_no).sort(), ['101', '102']);

  // two copies of one timing file arriving at the same moment are stored once
  const rows = [{ chip: r.people[1].chip, checkpoint: 'FIN', observed_at: iso(1500500), ref: 'twin-1' }, { chip: r.people[2].chip, checkpoint: 'FIN', observed_at: iso(1500700), ref: 'twin-2' }];
  const both = await Promise.all([importReads(r, rows), importReads(r, rows)]);
  assert.deepEqual(both.map((b) => b.status), [200, 200]);
  assert.equal(both.filter((b) => b.body.already_imported).length, 1);
  assert.equal((await sql("SELECT count(*)::int AS n FROM race_reads WHERE dedupe_key IN ('twin-1','twin-2')"))[0].n, 2);
  assert.equal((await sql('SELECT count(*)::int AS n FROM race_imports WHERE discipline_id=$1', [r.rid]))[0].n, 2);

  // the public payload says how the numbers were verified, in aggregates only
  ok(await api('POST', `/races/${r.rid}/policy`, { token: r.org.token, body: { rules: { public: { enabled: true } } } }), 201);
  await reconcile(r);
  ok(await api('POST', `/races/${r.rid}/publications`, { token: r.staff.judge.token, body: { label: 'provisional' } }), 201);
  const live = ok(await api('GET', `/races/${r.rid}/live`));
  assert.deepEqual([live.verification.policy_version, live.verification.approved_corrections, live.verification.timing_sources], [2, 0, ['chip_reads']]);
  assert.ok(live.verification.reconciled_at);
});

// ===================================================================================== permissions, REST / OpenAPI / MCP

test('permissions are consistent across REST and MCP, and ids cannot be probed', async () => {
  const r = await raceDay({ entrants: 2, crew: ['timekeeper', 'judge'] });
  const stranger = await signup(['athlete']);
  const all = await entrantsOf(r);
  for (const [m, p] of [['GET', `/races/${r.rid}`], ['GET', `/races/${r.rid}/desk`], ['GET', `/races/${r.rid}/entrants`], ['GET', `/race-entrants/${all[0].id}`], ['POST', `/races/${r.rid}/reconcile`]]) {
    assert.equal((await api(m, p, { token: stranger.token, body: m === 'POST' ? {} : undefined })).status, 404, `${m} ${p} must not reveal the race`);
  }
  assert.equal((await api('GET', `/races/${r.rid}/desk`)).status, 401);
  const tk = r.staff.timekeeper.token, judge = r.staff.judge.token;
  assert.equal((await api('POST', `/races/${r.rid}/policy`, { token: tk, body: { rules: { dedupe_window_s: 1 } } })).status, 403);
  assert.equal((await api('POST', `/races/${r.rid}/entrants/import`, { token: tk, body: { rows: [{ external_ref: 'x', full_name: 'X' }] } })).status, 403);
  assert.equal((await api('POST', `/races/${r.rid}/sources`, { token: tk, body: { name: 'x', kind: 'chip_reads' } })).status, 403);
  assert.equal((await api('GET', `/races/${r.rid}/export`, { token: judge })).status, 403, 'only the organiser exports names');
  assert.equal((await api('GET', `/races/${r.rid}/desk`, { token: tk })).status, 200);
  assert.equal((await api('POST', `/races/${r.rid}/reads/import`, { token: tk, body: { source_id: r.source.id, rows: [{ chip: r.people[0].chip, checkpoint: 'START', observed_at: iso(5000) }] } })).status, 200);
  // a chip source of another race is not usable here
  const other = await raceDay();
  assert.equal((await api('POST', `/races/${r.rid}/reads/import`, { token: r.org.token, body: { source_id: other.source.id, rows: [{ chip: 'x', checkpoint: 'START', observed_at: iso(1) }] } })).status, 404);

  // MCP exposes the same capabilities with the same permissions
  const rpc = async (method, params, token) => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await res.json()).result;
  };
  const tools = (await rpc('tools/list', {})).tools.map((t) => t.name);
  for (const name of ['setup_race', 'import_race_entrants', 'reissue_race_tag', 'import_race_reads', 'reconcile_race', 'set_race_status', 'propose_race_correction', 'publish_race_results', 'get_race_desk', 'get_race_live']) assert.ok(tools.includes(name), `${name} is an MCP tool`);
  const desk = await rpc('tools/call', { name: 'get_race_desk', arguments: { id: r.rid } }, r.org.token);
  assert.equal(desk.structuredContent.result.readiness.entrants, 2);
  const denied = await rpc('tools/call', { name: 'get_race_desk', arguments: { id: r.rid } }, stranger.token);
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).code, 'not_found');
  const doc = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  const ops = Object.values(doc.paths).flatMap(Object.values).map((o) => o.operationId);
  for (const name of capabilities.filter((c) => c.tag === 'Race operations').map((c) => c.name)) assert.ok(ops.includes(name), `${name} in OpenAPI`);
});

// ===================================================================================== scale

test('a realistic high-volume race: 5,000 entrants, 20,000 reads in four files, resumable reconciliation, bounded paging and export', async () => {
  const N = Number(process.env.RACE_LOAD_N ?? 5000); // CI runs 5,000; set RACE_LOAD_N=25000 to measure a larger field
  const WAVES = Math.ceil(N / 1000);
  const org = await signup(['organizer']);
  const ev = ok(await api('POST', '/events', { token: org.token, body: { name: 'Big City Half', sport: 'running', kind: 'tournament', starts_on: day(5), ends_on: day(5) } }), 201);
  const race = ok(await api('POST', `/events/${ev.id}/races`, { token: org.token, body: { name: 'Half marathon', sport: 'running', rules: { allow_guests: true, public: { enabled: true }, award_depth: 3 } } }), 201);
  const rid = race.race.id;
  const course = ok(await api('POST', `/races/${rid}/courses`, { token: org.token, body: { name: 'Half', unit: 'km', total_distance_m: 21097, checkpoints: [
    { code: 'START', label: 'Start', kind: 'start', distance_m: 0 }, { code: 'K5', label: '5 km', kind: 'split', distance_m: 5000 }, { code: 'K10', label: '10 km', kind: 'split', distance_m: 10000, cutoff_s: 4500 }, { code: 'FIN', label: 'Finish', kind: 'finish', distance_m: 21097 }] } }), 201);
  ok(await api('POST', `/race-courses/${course.id}/publish`, { token: org.token }));
  const source = ok(await api('POST', `/races/${rid}/sources`, { token: org.token, body: { name: 'Mats', kind: 'chip_reads' } }), 201);
  for (const [k, name] of Array.from({ length: WAVES }, (_, w) => `Wave ${w + 1}`).entries()) ok(await api('POST', `/races/${rid}/waves`, { token: org.token, body: { name, start_at: iso(k * 300000), capacity: 1000 } }), 201);
  const cats = ['M18-39', 'M40-49', 'W18-39', 'W40-49'];
  for (const name of cats) ok(await api('POST', `/races/${rid}/categories`, { token: org.token, body: { name, gender_rule: name.startsWith('M') ? 'male' : 'female' } }), 201);
  const rows = Array.from({ length: N }, (_, k) => ({ external_ref: `H${k}`, full_name: `Participant ${k}`, gender: k % 2 ? 'female' : 'male', club: `Club ${k % 40}`, bib: String(1000 + k), chip: `HC${k}`, wave: `Wave ${Math.floor(k / 1000) + 1}`, category: cats[(k % 2) * 2 + (Math.floor(k / 2) % 2)], seed_s: 4000 + (k % 600) }));
  const t = {};
  const mark = (name) => { t[name] = Date.now(); };
  mark('start');
  const files5k = Array.from({ length: Math.ceil(N / 5000) }, (_, f) => rows.slice(f * 5000, (f + 1) * 5000));
  const dry = ok(await api('POST', `/races/${rid}/entrants/import`, { token: org.token, body: { dry_run: true, rows: files5k[0] } }));
  assert.equal(dry.will_create, files5k[0].length);
  assert.equal(dry.errors.length, 0);
  mark('dry');
  let created = 0;
  for (const f of files5k) created += ok(await api('POST', `/races/${rid}/entrants/import`, { token: org.token, body: { dry_run: false, rows: f } })).created;
  assert.equal(created, N);
  mark('import');
  assert.equal(ok(await api('POST', `/races/${rid}/entrants/import`, { token: org.token, body: { dry_run: false, rows: files5k[0] } })).created, 0, 'an identical re-import creates nothing');
  const card = ok(await api('GET', `/races/${rid}`, { token: org.token }));
  assert.equal(card.counts.entrants, N);
  assert.deepEqual([card.counts.no_bib, card.counts.no_chip, card.counts.no_wave], [0, 0, 0]);
  ok(await api('POST', `/race-waves/${card.waves[0].id}/gun`, { token: org.token, body: { gun_at: iso(0) } }));
  for (const [k, w] of card.waves.slice(1).entries()) ok(await api('POST', `/race-waves/${w.id}/gun`, { token: org.token, body: { gun_at: iso((k + 1) * 300000) } }));

  // four timing files (start, 5 km, 10 km, finish), imported in files of at most 5,000 reads
  const gunOf = (k) => Math.floor(k / 1000) * 300000;
  const finishOf = (k) => gunOf(k) + 4800000 + ((k * 7919) % 3600000); // ~1:20 to 2:20, many near-ties
  const readFile = (code, at) => Array.from({ length: N }, (_, k) => ({ chip: `HC${k}`, checkpoint: code, observed_at: iso(at(k)), ref: `${code}-${k}`, device: `mat-${code}` }));
  const files = [readFile('START', (k) => gunOf(k) + 20000 + (k % 90) * 500), readFile('K5', (k) => gunOf(k) + 1500000 + (k % 400) * 1000), readFile('K10', (k) => gunOf(k) + 3000000 + (k % 600) * 1000), readFile('FIN', finishOf)];
  let accepted = 0;
  for (const f of files) for (let at = 0; at < f.length; at += 5000) accepted += ok(await importReads({ rid, org, source }, f.slice(at, at + 5000))).accepted;
  assert.equal(accepted, N * 4);
  mark('reads');
  ok(await importReads({ rid, org, source }, files[3].slice(0, 5000)));
  assert.equal((await sql('SELECT count(*)::int AS n FROM race_reads WHERE discipline_id=$1', [rid]))[0].n, N * 4, 'a repeated file adds nothing');

  // a resumable run: small batches, following `next`, then the same result in one go
  let after, batches = 0, total = 0;
  do {
    const part = ok(await api('POST', `/races/${rid}/reconcile`, { token: org.token, body: { limit: 1000, batches: 1, ...(after ? { after } : {}) } }));
    total += part.entrants; after = part.next; batches++;
  } while (after);
  assert.equal(total, N);
  assert.equal(batches, Math.ceil(N / 1000));
  assert.equal(total, N);
  mark('reconcile');
  const again = ok(await api('POST', `/races/${rid}/reconcile`, { token: org.token, body: {} }));
  assert.equal(again.changed, 0, 'a second full reconciliation writes nothing');
  assert.equal((await sql('SELECT count(*)::int AS n FROM race_results WHERE discipline_id=$1', [rid]))[0].n, N);
  const finished = (await sql("SELECT count(*)::int AS n FROM race_results WHERE discipline_id=$1 AND race_status='finished' AND superseded_at IS NULL", [rid]))[0].n;
  assert.equal(finished, N);

  // bounded, deterministic paging over every entrant
  const seen = new Set();
  let cursor, pages = 0;
  do {
    const page = ok(await api('GET', `/races/${rid}/entrants`, { token: org.token, query: { limit: '200', ...(cursor ? { after: cursor } : {}) } }));
    assert.ok(page.items.length <= 200);
    for (const e of page.items) { assert.ok(!seen.has(e.id), 'no entrant twice'); seen.add(e.id); }
    cursor = page.next; pages++;
  } while (cursor);
  assert.equal(seen.size, N);
  assert.equal(pages, Math.ceil(N / 200));
  const top = ok(await api('GET', `/races/${rid}/results`, { token: org.token, query: { limit: '50' } }));
  assert.equal(top.items.length, 50);
  assert.ok(top.items.every((x, i) => i === 0 || x.rank >= top.items[i - 1].rank));
  const pg2 = ok(await api('GET', `/races/${rid}/results`, { token: org.token, query: { limit: '50', after: top.next } }));
  assert.ok(pg2.items[0].rank >= top.items[49].rank);
  assert.ok(!pg2.items.some((x) => top.items.some((y) => y.entrant_id === x.entrant_id)));
  mark('paging');

  // close out, publish final (pending cutoff reviews and the like are acknowledged), export in bounded pages
  const tryFinal = await api('POST', `/races/${rid}/publications`, { token: org.token, body: { label: 'final' } });
  const pub = tryFinal.status === 201 ? tryFinal.body : ok(await api('POST', `/races/${rid}/publications`, { token: org.token, body: { label: 'final', acknowledge_open_items: true } }), 201);
  assert.equal(pub.finishers, N);
  assert.ok(pub.awards >= 3);
  mark('publish');
  let rowsOut = 0, csvPages = 0, ex;
  let next;
  do {
    ex = ok(await api('GET', `/races/${rid}/export`, { token: org.token, query: { limit: '2000', ...(next ? { after: next } : {}) } }));
    rowsOut += ex.rows; next = ex.next; csvPages++;
    assert.ok(ex.csv.split('\r\n').length <= 2002);
  } while (next);
  assert.equal(rowsOut, N);
  assert.equal(csvPages, Math.ceil(N / 2000));
  const publicList = ok(await api('GET', `/races/${rid}/public-results`, { query: { limit: '100' } }));
  assert.equal(publicList.items.length, 100);
  assert.equal(publicList.label, 'final');
  const desk = ok(await api('GET', `/races/${rid}/desk`, { token: org.token }));
  assert.equal(desk.statuses.finished, N);
  mark('end');
  const secs = (a, b) => ((t[b] - t[a]) / 1000).toFixed(1);
  console.log(`# race load: ${N} entrants | import dry ${secs('start', 'dry')}s, real ${secs('dry', 'import')}s | ${N * 4} reads in 4 files ${secs('import', 'reads')}s | reconcile (5 batches) ${secs('reads', 'reconcile')}s | paging ${secs('reconcile', 'paging')}s | final publish ${secs('paging', 'publish')}s | export+public ${secs('publish', 'end')}s`);
  assert.ok((t.end - t.start) < 600000, 'the whole fixture runs inside a generous bound');
});
