// Pre-match checks an official ticks before kick-off. The list is configuration (generic items plus a few sport-specific ones); the state is an
// append-only log (fixture_checklist_log) so history records who ticked what and when. Operational only: it never holds clinical information.
import { many } from './db.js';

const BASE = [
  { key: 'field_ready', label: 'Field / court is marked, clear and safe' },
  { key: 'equipment_checked', label: 'Match equipment checked' },
  { key: 'teams_present', label: 'Both teams / participants are present' },
  { key: 'lineups_confirmed', label: 'Line-ups confirmed' },
  { key: 'crew_present', label: 'Officiating crew present' },
  { key: 'rules_acknowledged', label: 'Rules and local adaptations acknowledged' },
];
const TOSS = { key: 'toss_done', label: 'Coin toss / side selection done' };
const TOSS_SPORTS = new Set(['football', 'futsal', 'hockey', 'cricket', 'rugby', 'handball', 'basketball', 'netball', 'volleyball', 'water-polo', 'kabaddi', 'kho-kho', 'lacrosse', 'ice-hockey', 'baseball', 'softball']);

export const checklistItems = (sportSlug) => (TOSS_SPORTS.has(sportSlug) ? [...BASE.slice(0, 5), TOSS, BASE[5]] : BASE);

/** The checklist with each item's latest state (done, who, when). */
export async function checklistFor(fixtureId, sportSlug) {
  const rows = await many(
    `SELECT DISTINCT ON (l.item_key) l.item_key, l.done, l.at, u.display_name AS actor_name
       FROM fixture_checklist_log l JOIN users u ON u.id=l.actor_id WHERE l.fixture_id=$1 ORDER BY l.item_key, l.at DESC, l.id DESC`, [fixtureId]);
  const by = new Map(rows.map((r) => [r.item_key, r]));
  return checklistItems(sportSlug).map((it) => ({ ...it, done: by.get(it.key)?.done ?? false, by: by.get(it.key)?.actor_name ?? null, at: by.get(it.key)?.at ?? null }));
}
