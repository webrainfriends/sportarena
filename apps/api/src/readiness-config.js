// The readiness settings in force for an athlete: the standard values, unless a qualified coach or clinician adjusted them through a share
// that is still live. Resolved on every read, so revoking the share (or losing the relationship, grant or guardian consent) ends the effect.
import { DEFAULT_CONFIG, withDefaults } from './readiness.js';
import { shareBlock, reasonText } from './wellness-sharing.js';

/** The settings in force for an athlete right now. A staff version applies only while the share it was made under is live. */
export async function effective(c, athleteId) {
  const latest = (await c.query('SELECT r.*, u.display_name AS set_by_name FROM readiness_configs r JOIN users u ON u.id=r.set_by WHERE r.athlete_id=$1 ORDER BY r.version DESC LIMIT 1', [athleteId])).rows[0];
  const standard = { version: latest?.version ?? 0, source: 'standard', status: 'active', config: DEFAULT_CONFIG, set_by: null, set_at: null, paused_reason: null };
  if (!latest || latest.source === 'reset') return standard;
  const share = (await c.query('SELECT * FROM wellness_shares WHERE id=$1', [latest.share_id])).rows[0];
  const block = share ? await shareBlock(c, share) : 'revoked';
  const set_by = { id: latest.set_by, name: latest.set_by_name, kind: latest.set_by_kind };
  if (block) return { ...standard, status: 'paused', paused_reason: reasonText(block), set_by, set_at: latest.created_at };
  return { version: latest.version, source: 'custom', status: 'active', config: withDefaults(latest.config), set_by, set_at: latest.created_at, paused_reason: null };
}


export const settingsView = (e) => ({ source: e.source, status: e.status, version: e.version, paused_reason: e.paused_reason, set_by: e.set_by, set_at: e.set_at, ...e.config });
