// Fills a LOCAL, throwaway capture database with a lived-in athlete (matches, wellness, a coach listing) through the real
// capabilities, so the app shows real screens rather than empty states. Never run against production.
// Run after `npm run migrate && npm run seed`, with the same env as the API:  node showcase-data.mjs
import { config } from '../../apps/api/src/config.js';
import { pool, one } from '../../apps/api/src/db.js';
import { capabilities } from '../../apps/api/src/capabilities/index.js';
import { invoke } from '../../apps/api/src/invoke.js';
if (config.isProd) throw new Error('Refusing to run against production');
const by = Object.fromEntries(capabilities.map((c) => [c.name, c]));
const call = (n, u, i) => invoke(by[n], u, i);
const user = async (h) => (await one('SELECT id, handle, display_name, roles FROM users WHERE handle=$1', [h]));
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const tryIt = async (label, f) => { try { await f(); console.log('ok  ', label); } catch (e) { console.log('FAIL', label, e.message?.slice(0, 160), JSON.stringify(e.details ?? '').slice(0, 200)); } };

const aarav = await user('aarav'), coach = await user('coach_dev');
const sp = await one('SELECT id FROM sport_profiles WHERE user_id=$1 AND role=$2', [aarav.id, 'athlete']);
const games = [[-27, 'Pixel Panthers', 'win', 3, 1, 7.8, 2, 1, 90], [-21, 'Electric Eels', 'draw', 2, 2, 7.1, 1, 0, 90], [-15, 'Mango Mavericks', 'win', 4, 2, 8.6, 2, 2, 85],
  [-9, 'Pixel Panthers', 'loss', 0, 1, 6.4, 0, 0, 90], [-4, 'Electric Eels', 'win', 2, 0, 8.9, 1, 1, 90], [-2, 'Mango Mavericks', 'win', 3, 2, 9.1, 3, 0, 90]];
for (const [d, opp, result, sf, sa, rating, goals, assists, minutes] of games)
  await tryIt('match ' + d, () => call('record_match', aarav, { sport_profile_id: sp.id, played_on: day(d), opponent: opp, competition: 'Neon League Season 1', venue: 'Arena One Sports Complex', result, score_for: sf, score_against: sa, rating, minutes, stats: { goals, assists }, client_key: `showcase-${d}-${opp}`.replace(/\W/g, '-') }));
for (const [d, sh, sq, so, mood, ml] of [[-6, 7.5, 4, 3, 4, 2200], [-5, 8, 5, 2, 5, 2600], [-4, 6.5, 3, 5, 3, 2000], [-3, 7.5, 4, 3, 4, 2400], [-2, 8.5, 5, 2, 5, 2800], [-1, 7.5, 4, 2, 4, 2500], [0, 8, 5, 1, 5, 1800]])
  await tryIt('wellness ' + d, () => call('log_wellness', aarav, { date: day(d), sleep_hours: sh, sleep_quality: sq, soreness: so, mood, water_ml: ml }));
await tryIt('coach profile', () => call('upsert_coach_profile', coach, { headline: 'Forwards & finishing · ex-state league striker', bio: 'I help attackers read the game, finish under pressure and train smarter.', sports: ['football'] }));
await tryIt('passport link', () => call('create_passport_link', aarav, { label: 'For the Pune FC scouts', expires_in_days: 30 }));
await pool.end();
