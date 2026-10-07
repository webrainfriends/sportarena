// Demo data for local development: `npm run seed`. Refuses to run in production.
import { config } from './config.js';
import { pool, one } from './db.js';
import { migrate } from './migrate.js';
import { capabilities } from './capabilities/index.js';
import { invoke } from './invoke.js';
import { hashPassword, blindIndex, encrypt } from './crypto.js';

if (config.isProd) throw new Error('Refusing to seed production');
await migrate();

const by = Object.fromEntries(capabilities.map((c) => [c.name, c]));
const call = (name, user, input) => invoke(by[name], user, input);
const PASSWORD = 'sportarena-demo';
const soon = (d, h = 17) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };

if (await one("SELECT 1 FROM users WHERE handle='aarav'")) { console.log('Already seeded.'); await pool.end(); process.exit(0); }

const mk = async (handle, display_name, roles, emoji, color, extra = {}) =>
  (await call('register', null, { handle, display_name, email: `${handle}@demo.sportarena.dev`, password: PASSWORD, roles, avatar_emoji: emoji, avatar_color: color, ...extra })).user;

const admin = await one("INSERT INTO users(handle, display_name, roles, password_hash, email_enc, email_idx, avatar_emoji, avatar_color) VALUES ('admin','Arena Admin','{admin}',$1,$2,$3,'👑','#FFC400') RETURNING id, handle, display_name, roles", [hashPassword(PASSWORD), encrypt('admin@demo.sportarena.dev', 'users.email'), blindIndex('admin@demo.sportarena.dev')]);
const org = await mk('kavya_events', 'Kavya (Organizer)', ['organizer', 'athlete'], '🎪', '#7C4DFF', { full_name: 'Kavya Menon', phone: '+91 90000 00001' });
const venueMgr = await mk('arena_one', 'Arena One', ['venue_manager'], '🏟️', '#00E5A8');
const sponsor = await mk('volt_drink', 'VoltDrink', ['sponsor'], '⚡', '#FFD600');
const doc = await mk('dr_rhea', 'Dr. Rhea (Sports Med)', ['doctor'], '🩺', '#FF5252');
const physio = await mk('physio_zane', 'Zane (Physio)', ['physio'], '💆', '#40C4FF');
const ref = await mk('ref_imran', 'Imran (Referee)', ['referee'], '🟨', '#FF9100');
const coach = await mk('coach_dev', 'Coach Dev', ['coach'], '📣', '#FF3D81');
const names = [['aarav', 'Aarav', '🦁', '#FF3D81'], ['mia', 'Mia', '🦄', '#7C4DFF'], ['zoya', 'Zoya', '🔥', '#FF6D00'], ['kabir', 'Kabir', '🐺', '#00B0FF'], ['ananya', 'Ananya', '🌸', '#F50057'], ['rohan', 'Rohan', '⚡', '#00E5A8'], ['sara', 'Sara', '🎧', '#AA00FF'], ['vik', 'Vik', '🛹', '#FFC400']];
const players = [];
for (const [h, n, e, c] of names) players.push(await mk(h, n, ['athlete'], e, c, { full_name: `${n} Demo`, phone: '+91 90000 0' + String(players.length).padStart(4, '0'), dob: '2002-05-1' + (players.length % 9) }));

await call('add_sport_profile', ref, { sport: 'football', role: 'referee', level: 'semi_pro', license_no: 'FIFA-DEMO-77' });
await call('add_sport_profile', doc, { sport: 'football', role: 'doctor', level: 'pro' });
await call('add_sport_profile', physio, { sport: 'football', role: 'physio', level: 'pro' });
await call('add_sport_profile', coach, { sport: 'football', role: 'coach', level: 'pro' });
for (const p of players) await call('add_sport_profile', p, { sport: 'football', role: 'athlete', level: 'amateur', position: 'Forward' });

const teamDefs = [['Neon Foxes', '🦊', '#FF3D81', players[0], [players[0], players[1]]], ['Pixel Panthers', '🐆', '#7C4DFF', players[2], [players[2], players[3]]], ['Electric Eels', '⚡', '#00B0FF', players[4], [players[4], players[5]]], ['Mango Mavericks', '🥭', '#FF9100', players[6], [players[6], players[7]]]];
const teams = [];
for (const [name, emoji, color, owner, roster] of teamDefs) {
  const t = await call('create_team', owner, { name, sport: 'football', emoji, color, city: 'Pune' });
  for (const m of roster.slice(1)) await call('add_team_member', owner, { id: t.id, user_id: m.id, role: 'player', jersey_no: 10 });
  teams.push({ ...t, owner });
}

const venue = await call('create_venue', venueMgr, { name: 'Arena One Sports Complex', city: 'Pune', address: 'Baner Road', emoji: '🏟️' });
const pitch = await call('add_resource', venueMgr, { id: venue.id, kind: 'ground', name: 'Turf Pitch 1', sport: 'football', hourly_rate_cents: 120000 });
await call('add_resource', venueMgr, { id: venue.id, kind: 'court', name: 'Hoops Court', sport: 'basketball', hourly_rate_cents: 60000 });
await call('add_resource', venueMgr, { id: venue.id, kind: 'equipment', name: 'Training cones & bibs', capacity: 10 });

const league = await call('create_event', org, { name: 'Neon League Season 1', sport: 'football', kind: 'league', description: 'The loudest 5-a-side league in town.', venue_id: venue.id, starts_on: soon(-14).slice(0, 10), banner_emoji: '🌈' });
for (const t of teams) { const e = await call('enter_event', t.owner, { id: league.id, team_id: t.id }); await call('decide_entry', org, { id: e.id, status: 'accepted' }); }
await call('update_event', org, { id: league.id, status: 'ongoing' });
const rr = await call('generate_round_robin', org, { id: league.id, first_round_at: soon(-12) });
// play the first 3 rounds' worth of games, leave the rest upcoming
const fixtures = await call('list_fixtures', null, { event_id: league.id, limit: 50 });
const scores = [[3, 1], [2, 2], [1, 0], [0, 2], [4, 3], [1, 1]];
for (const [i, f] of fixtures.entries()) {
  if (i < 4) {
    await call('record_result', org, { id: f.id, home_score: scores[i][0], away_score: scores[i][1] });
  } else await call('reschedule_fixture', org, { id: f.id, scheduled_at: soon(i - 3, 16 + i), referee_id: ref.id });
}
for (const [i, p] of players.entries()) {
  await call('record_performance', org, { user_id: p.id, sport: 'football', metric: 'goals', value: (i * 3) % 7 + 1, points: ((i * 3) % 7 + 1) * 3, event_id: league.id });
  await call('record_performance', org, { user_id: p.id, sport: 'football', metric: 'assists', value: (i * 5) % 4, points: (i * 5) % 4, event_id: league.id });
}
await call('grant_award', org, { name: 'Golden Boot', kind: 'trophy', event_id: league.id, user_id: players[3].id, note: 'Top scorer' });
await call('grant_award', org, { name: 'Player of the Week', kind: 'mvp', event_id: league.id, user_id: players[0].id });

const brand = await call('create_sponsor', sponsor, { name: 'VoltDrink', industry: 'Beverages', website: 'https://volt.example', emoji: '⚡', contact_email: 'partners@volt.example' });
const deal = await call('propose_sponsorship', sponsor, { sponsor_id: brand.id, target_type: 'event', target_id: league.id, amount_cents: 25000000, in_kind: '500 cases of VoltDrink' });
await call('decide_sponsorship', org, { id: deal.id, status: 'active' });
await call('propose_sponsorship', sponsor, { sponsor_id: brand.id, target_type: 'team', target_id: teams[0].id, amount_cents: 1000000 });

const plans = [['Player Shield', 'SafeSport', 'individual', 49900, 500000, '🛡️'], ['Squad Cover', 'SafeSport', 'team', 249900, 2500000, '🧢'], ['Event Guard', 'ArenaRe', 'event', 999900, 10000000, '🎟️']];
for (const [name, insurer, cover_for, premium_cents, coverage_cents, emoji] of plans) await call('create_insurance_plan', admin, { name, insurer, cover_for, premium_cents, coverage_cents, emoji, description: `${cover_for} accident & injury cover` });
const [shield] = await call('list_insurance_plans', null, { cover_for: 'individual' });
await call('buy_policy', players[0], { plan_id: shield.id, beneficiary: 'Family' });

await call('grant_medical_access', players[0], { provider_id: doc.id });
await call('add_medical_record', doc, { athlete_id: players[0].id, kind: 'clearance', clearance: 'cleared', summary: 'Pre-season screening passed' });
await call('book_appointment', players[1], { provider_id: physio.id, starts_at: soon(2, 9), reason: 'Hamstring tightness' });

const ball = await call('create_inventory_item', org, { name: 'Match balls', category: 'equipment', quantity: 4, reorder_level: 8, unit_cost_cents: 150000 });
await call('create_inventory_item', org, { name: 'Electrolyte sachets', category: 'nutrition', quantity: 120, reorder_level: 40, unit_cost_cents: 2500 });
await call('create_supply_order', org, { item_id: ball.id, supplier: 'Nivia Sports', quantity: 24 });

for (const [i, p] of players.slice(0, 4).entries()) await call('write_testimonial', p, { subject_type: 'event', subject_id: league.id, rating: 5 - (i % 2), body: ['Best league ever, the vibes are unreal!', 'Great organisation, loved the live table.', 'Referees were fair, pitch was perfect.', 'Cannot wait for season 2!'][i] });
await call('write_testimonial', org, { subject_type: 'venue', subject_id: venue.id, rating: 5, body: 'Turf is immaculate.' });
await call('create_booking', players[0], { resource_id: pitch.id, starts_at: soon(3, 18), ends_at: soon(3, 19), team_id: teams[0].id });

// Player module demo: Aarav plays two sports; cricket is his default card.
const fb = (await one("SELECT p.id FROM sport_profiles p JOIN users u ON u.id=p.user_id WHERE u.handle='aarav' AND p.role='athlete'")).id;
await call('update_sport_profile', players[0], { id: fb, jersey_no: 9, club: 'Neon Foxes', experience_years: 6 });
const cr = await call('add_sport_profile', players[0], { sport: 'cricket', role: 'athlete', level: 'amateur', position: 'Opening batter', jersey_no: 18, club: 'Sunday XI', experience_years: 3, is_default: true });
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
await call('import_matches', players[0], { sport_profile_id: fb, csv: `played_on,opponent,competition,result,score_for,score_against,minutes,rating,goals,assists,shots
${day(40)},Blue Stars,League,win,3,1,90,8.5,2,1,5
${day(33)},Red Hawks,League,draw,1,1,90,6.5,0,1,2
${day(26)},Green Gulls,Cup,loss,0,2,78,5.5,0,0,1
${day(19)},Pixel Panthers,League,win,2,0,90,7.5,1,0,4
${day(12)},Electric Eels,League,win,4,2,90,9,3,0,6
` });
await call('import_matches', players[0], { sport_profile_id: cr.id, csv: `played_on,opponent,competition,result,runs,balls_faced,fours,sixes
${day(30)},Sunday Kings,Friendly,win,64,41,8,2
${day(16)},Park Rangers,League,loss,12,18,1,0
${day(5)},Old Boys,League,win,88,60,11,3
` });

console.log(`Seeded ${rr.created} fixtures. Log in with any of these (password: ${PASSWORD}):`);
console.log('  admin@demo.sportarena.dev, kavya_events@…, aarav@…, arena_one@…, volt_drink@…, dr_rhea@…, ref_imran@… (all @demo.sportarena.dev)');
await pool.end();
