// REF-R10: AI-powered official crew requirements — sport catalog + deficit alerts + compliance reports.
// Based on governing body standards (FIFA, ICC, Olympics, Para, Aquatic, etc.).
// Platform admin configures penalties; event organiser accepts/overrides AI suggestions.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { isOrganiser } from './event-departments.js';
import { notify } from '../notify.js';

const TAG = 'Officials';
const PLATFORM_ADMIN_EMAILS = new Set(['rraja.edge@gmail.com', 'rrajas1978@icloud.com']);

function mustBePlatformAdmin(user) {
  if (!PLATFORM_ADMIN_EMAILS.has(user.email)) throw forbidden('Platform admin only');
}

async function requireEventOrganiser(user, eventId) {
  if (isAdmin(user)) return;
  const ev = await one('SELECT * FROM events WHERE id=$1', [eventId]);
  if (!ev) throw notFound('Event');
  const ok = await isOrganiser(user, ev, pool);
  if (!ok) throw forbidden('Organiser only');
}

// Governing-body priority for catalog lookup
const GB_PRIORITY = ['Olympics', 'FIFA', 'ICC', 'BWF', 'FIBA', 'World Athletics', 'Para', 'Aquatic', 'Winter Olympics', 'generic'];
function gbScore(gb) { const i = GB_PRIORITY.findIndex((x) => gb.toLowerCase().includes(x.toLowerCase())); return i < 0 ? GB_PRIORITY.length : i; }

cap({
  name: 'suggest_crew_requirements', method: 'POST', path: '/crew-ai/suggest', tag: TAG,
  summary: 'AI-powered crew suggestion for a fixture based on the governing-body catalog for the sport. Returns deficit analysis and creates alerts for organiser and officials.',
  input: z.object({ fixture_id: id() }),
  async handler({ user }, i) {
    const f = await one(
      `SELECT f.*, e.id AS event_id, e.name AS event_name, s.slug AS sport_slug, s.name AS sport_name
         FROM fixtures f JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id WHERE f.id=$1`,
      [i.fixture_id],
    );
    if (!f) throw notFound('Fixture');
    await requireEventOrganiser(user, f.event_id);

    // Load catalog for sport, ordered by GB priority then all 'all' entries
    const catalog = await many(
      `SELECT crew_role, min_required, recommended, governing_body, notes
         FROM official_crew_catalog
        WHERE (sport=$1 OR sport='all') AND retired_at IS NULL
        ORDER BY min_required DESC`,
      [f.sport_slug],
    );
    // Deduplicate by role: highest-priority governing body wins
    const roleMap = new Map();
    for (const row of catalog.sort((a, b) => gbScore(a.governing_body) - gbScore(b.governing_body))) {
      if (!roleMap.has(row.crew_role)) roleMap.set(row.crew_role, row);
    }
    const required = [...roleMap.values()];

    // Current crew
    const assigned = await many(
      `SELECT role, COUNT(*)::int AS count FROM fixture_officials WHERE fixture_id=$1 AND status IN ('accepted','invited') GROUP BY role`,
      [i.fixture_id],
    );
    const assignedMap = new Map(assigned.map((r) => [r.role, r.count]));

    // Compute deficit
    const suggestions = required.map((req) => ({
      role: req.crew_role,
      min_required: req.min_required,
      recommended: req.recommended,
      assigned: assignedMap.get(req.crew_role) ?? 0,
      deficit: Math.max(0, req.min_required - (assignedMap.get(req.crew_role) ?? 0)),
      governing_body: req.governing_body,
      basis: req.notes ?? `${req.governing_body} minimum`,
    }));
    const deficitRoles = suggestions.filter((s) => s.deficit > 0);
    const deficitExists = deficitRoles.length > 0;

    // Load penalty config
    const penaltyConfig = await one('SELECT * FROM event_crew_deficit_config WHERE event_id=$1', [f.event_id]);

    return tx(async (c) => {
      // Store suggestion
      const sugg = (await c.query(
        `INSERT INTO fixture_crew_suggestions(fixture_id, suggested_roles)
         VALUES ($1,$2::jsonb) RETURNING id, suggested_at`,
        [i.fixture_id, JSON.stringify(suggestions)],
      )).rows[0];

      // Alert organiser and all accepted officials if deficit
      if (deficitExists) {
        const deficitDetail = { deficit_roles: deficitRoles, fixture_id: i.fixture_id, event_name: f.event_name };
        const ev = await one('SELECT organizer_id FROM events WHERE id=$1', [f.event_id]);
        await notify(c, ev.organizer_id, {
          kind: 'crew_deficit_alert',
          title: 'Crew deficit detected',
          body: `${deficitRoles.length} required role(s) unfilled for ${f.event_name}`,
          data: { fixture_id: i.fixture_id, deficit_roles: deficitRoles.map((r) => r.role) },
        });
        await c.query(
          `INSERT INTO crew_deficit_alerts(fixture_id, event_id, alerted_user_id, alert_type, deficit_detail)
           VALUES ($1,$2,$3,'organiser',$4::jsonb) ON CONFLICT DO NOTHING`,
          [i.fixture_id, f.event_id, ev.organizer_id, JSON.stringify(deficitDetail)],
        );

        const officials = await many(
          `SELECT DISTINCT fo.user_id FROM fixture_officials fo WHERE fo.fixture_id=$1 AND fo.status='accepted'`,
          [i.fixture_id],
        );
        for (const off of officials) {
          await notify(c, off.user_id, {
            kind: 'crew_deficit_alert',
            title: 'Crew deficit alert',
            body: `${deficitRoles.length} required role(s) unfilled for this fixture`,
            data: { fixture_id: i.fixture_id },
          });
          await c.query(
            `INSERT INTO crew_deficit_alerts(fixture_id, event_id, alerted_user_id, alert_type, deficit_detail)
             VALUES ($1,$2,$3,'official',$4::jsonb) ON CONFLICT DO NOTHING`,
            [i.fixture_id, f.event_id, off.user_id, JSON.stringify({ deficit_roles: deficitRoles.map((r) => r.role) })],
          );
        }
      }

      await audit(c, user.id, 'crew_ai.suggested', 'fixture_crew_suggestions', sugg.id);
      return { suggestion_id: sugg.id, suggested_at: sugg.suggested_at, sport: f.sport_slug, suggestions, deficit_exists: deficitExists, deficit_roles: deficitRoles, penalty_config: penaltyConfig ?? null };
    });
  },
});

cap({
  name: 'accept_crew_suggestion', method: 'POST', path: '/crew-ai/suggestions/:id/accept', tag: TAG,
  summary: 'Organiser acknowledges the AI crew suggestion. The final roster decision remains with the organiser.',
  input: z.object({ id: id(), override_note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const sugg = await one('SELECT * FROM fixture_crew_suggestions WHERE id=$1', [i.id]);
    if (!sugg) throw notFound('Suggestion');
    const f = await one('SELECT event_id FROM fixtures WHERE id=$1', [sugg.fixture_id]);
    await requireEventOrganiser(user, f.event_id);
    await pool.query(
      `UPDATE fixture_crew_suggestions SET accepted_by=$1, accepted_at=now(), override_note=$2 WHERE id=$3`,
      [user.id, i.override_note ?? null, i.id],
    );
    await audit(null, user.id, 'crew_ai.accepted', 'fixture_crew_suggestions', i.id);
    return { accepted: true };
  },
});

cap({
  name: 'get_crew_compliance_report', method: 'GET', path: '/fixtures/:id/crew-compliance', tag: TAG,
  summary: 'Crew compliance section for match/event reports. Shows required vs assigned crew, deficit, penalty impact, and AI suggestion history.',
  input: z.object({ id: id() }),
  async handler({ user }, i) {
    const f = await one(
      `SELECT f.*, e.id AS event_id, e.name AS event_name, s.slug AS sport_slug
         FROM fixtures f JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id WHERE f.id=$1`,
      [i.id],
    );
    if (!f) throw notFound('Fixture');
    // Any crew member, organiser, or admin may view
    const isCrew = !!(await one(
      `SELECT 1 FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status IN ('accepted','invited')`,
      [i.id, user.id],
    ));
    const ev = await one('SELECT organizer_id FROM events WHERE id=$1', [f.event_id]);
    if (!isCrew && ev.organizer_id !== user.id && !isAdmin(user)) throw notFound('Fixture');

    const latestSugg = await one(
      `SELECT * FROM fixture_crew_suggestions WHERE fixture_id=$1 ORDER BY suggested_at DESC LIMIT 1`,
      [i.id],
    );
    const penaltyConfig = await one('SELECT * FROM event_crew_deficit_config WHERE event_id=$1', [f.event_id]);
    const assigned = await many(
      `SELECT fo.role, COUNT(*)::int AS count, u.display_name
         FROM fixture_officials fo JOIN users u ON u.id=fo.user_id
        WHERE fo.fixture_id=$1 AND fo.status='accepted'
        GROUP BY fo.role, u.display_name`,
      [i.id],
    );

    const suggestions = latestSugg?.suggested_roles ?? [];
    const deficitRoles = Array.isArray(suggestions) ? suggestions.filter((s) => s.deficit > 0) : [];
    const complianceStatus = deficitRoles.length === 0 ? 'compliant' : deficitRoles.some((s) => s.deficit >= 2) ? 'severe_deficit' : 'deficit';

    return {
      fixture_id: i.id,
      sport: f.sport_slug,
      event_name: f.event_name,
      required_crew: suggestions,
      assigned_crew: assigned,
      deficit_roles: deficitRoles,
      compliance_status: complianceStatus,
      penalty_applicable: !!penaltyConfig && complianceStatus !== 'compliant',
      penalty_detail: penaltyConfig ?? null,
      ai_suggestion_at: latestSugg?.suggested_at ?? null,
      organiser_accepted: latestSugg?.accepted_at ?? null,
    };
  },
});

cap({
  name: 'list_crew_deficit_alerts', method: 'GET', path: '/crew-ai/alerts', tag: TAG,
  summary: 'Crew deficit alerts for the authenticated user, optionally filtered by event.',
  input: z.object({ event_id: id().optional(), ...page }),
  async handler({ user }, i) {
    const params = [user.id];
    let filter = 'WHERE a.alerted_user_id=$1 AND a.read_at IS NULL';
    if (i.event_id) { params.push(i.event_id); filter += ` AND a.event_id=$${params.length}`; }
    params.push(i.limit, i.offset);
    return many(
      `SELECT a.id, a.fixture_id, a.event_id, a.alert_type, a.deficit_detail, a.sent_at, a.read_at
         FROM crew_deficit_alerts a ${filter}
        ORDER BY a.sent_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  },
});

cap({
  name: 'platform_admin_configure_crew_penalty', method: 'POST', path: '/crew-ai/penalty-config', tag: TAG,
  summary: 'Platform admin configures points/rank degradation rules for under-staffed events.',
  input: z.object({
    event_id: id(),
    penalty_type: z.enum(['points_deduction', 'rank_degradation', 'void_result', 'warning_only']),
    penalty_value: z.number().min(0),
    applies_after: z.number().int().min(1).default(1),
    notes: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    mustBePlatformAdmin(user);
    const ev = await one('SELECT id FROM events WHERE id=$1', [i.event_id]);
    if (!ev) throw notFound('Event');
    return tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO event_crew_deficit_config(event_id, penalty_type, penalty_value, applies_after, notes, overridden_by, overridden_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (event_id) DO UPDATE SET penalty_type=EXCLUDED.penalty_type, penalty_value=EXCLUDED.penalty_value,
           applies_after=EXCLUDED.applies_after, notes=EXCLUDED.notes, overridden_by=EXCLUDED.overridden_by, overridden_at=now()
         RETURNING *`,
        [i.event_id, i.penalty_type, i.penalty_value, i.applies_after, i.notes ?? null, user.id],
      )).rows[0];
      await audit(c, user.id, 'crew_penalty_config.set', 'event_crew_deficit_config', row.id);
      return row;
    });
  },
});

cap({
  name: 'seed_crew_catalog', method: 'POST', path: '/crew-ai/catalog/seed', tag: TAG,
  summary: 'Platform admin bulk-loads or updates governing body crew requirements. Use to prime FIFA, ICC, Olympics, Para, Aquatic standards.',
  input: z.object({
    entries: z.array(z.object({
      sport: z.string().min(1).max(60),
      governing_body: z.string().min(1).max(100),
      match_format: z.string().max(60).default('standard'),
      crew_role: z.string().min(1).max(60),
      min_required: z.number().int().min(1),
      recommended: z.number().int().min(1),
      notes: z.string().max(500).optional(),
    })).min(1).max(500),
  }),
  async handler({ user }, i) {
    mustBePlatformAdmin(user);
    let upserted = 0;
    return tx(async (c) => {
      for (const e of i.entries) {
        await c.query(
          `INSERT INTO official_crew_catalog(sport, governing_body, match_format, crew_role, min_required, recommended, notes, created_by, effective_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE)
           ON CONFLICT (sport, governing_body, match_format, crew_role)
           DO UPDATE SET min_required=EXCLUDED.min_required, recommended=EXCLUDED.recommended, notes=EXCLUDED.notes, effective_from=CURRENT_DATE`,
          [e.sport, e.governing_body, e.match_format, e.crew_role, e.min_required, e.recommended, e.notes ?? null, user.id],
        );
        upserted++;
      }
      await audit(c, user.id, 'crew_catalog.seeded', 'official_crew_catalog', `${upserted}_entries`);
      return { upserted };
    });
  },
});
