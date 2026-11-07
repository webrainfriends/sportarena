// PS-26: Accessible para-sport spectator results, media and broadcasts.
// All endpoints are public-read or organiser-write. No medical or clinical data is stored or exposed here;
// para_class_code is organisational metadata only (like a category or division label).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { loadViewableEvent, loadViewableFixture, publicMedia, publicStreams, isOrganiserOf } from '../spectator.js';
import { isYouthEvent } from '../youth.js';

const A11Y_STATUS = z.enum(['unknown', 'partial', 'verified', 'not_available']);
const ENTRY_KIND  = z.enum(['update', 'result', 'record', 'alert', 'info']);

// ------------------------------------------------------------------ scoreboard

cap({
  name: 'para_spectator_scoreboard',
  method: 'GET',
  path: '/public/events/:event_id/para-scoreboard',
  summary: 'Class-aware para-sport scoreboard: per-class rankings with optional combined view, screen-reader friendly',
  tag: 'para-accessibility',
  auth: 'public',
  input: z.object({
    event_id:         id,
    fixture_id:       id.optional(),
    para_class_code:  z.string().max(20).optional(),
    include_combined: z.coerce.boolean().default(false),
    limit:            z.coerce.number().int().min(1).max(100).default(25),
    offset:           z.coerce.number().int().min(0).default(0),
  }),
  async handler(_, inp) {
    const ev = await loadViewableEvent(inp.event_id);
    if (!ev) throw notFound();
    const youth = isYouthEvent(ev);

    // settings for this event (may be null — use sensible defaults)
    const settings = await one(
      `SELECT fas.* FROM fixture_accessibility_settings fas
        JOIN fixtures f ON f.id = fas.fixture_id
       WHERE f.event_id = $1 ${inp.fixture_id ? 'AND fas.fixture_id = $2' : ''}
       ORDER BY fas.updated_at DESC LIMIT 1`,
      inp.fixture_id ? [inp.event_id, inp.fixture_id] : [inp.event_id],
    );

    // per-class results from fixture results, grouped by para_class_code
    const classFilter = inp.para_class_code ? `AND pg.para_class_code = $3` : '';
    const classArgs   = inp.para_class_code
      ? [inp.event_id, inp.fixture_id ?? null, inp.para_class_code, inp.limit, inp.offset]
      : [inp.event_id, inp.fixture_id ?? null, inp.limit, inp.offset];

    // para_class_code is an optional column on para_game_entries (or similar results table)
    // We fall back to participant-level data if the sport's model doesn't have class codes
    const rows = await many(
      `SELECT
          pg.para_class_code,
          pg.athlete_id,
          CASE WHEN $6 THEN NULL ELSE u.display_name END AS display_name,
          pg.result_value,
          pg.result_unit,
          pg.rank_in_class,
          pg.rank_overall,
          pg.personal_best,
          pg.season_best,
          pg.world_record,
          pg.fixture_id,
          f.scheduled_at,
          f.status AS fixture_status
        FROM para_game_entries pg
        JOIN fixtures f ON f.id = pg.fixture_id
        LEFT JOIN users u ON u.id = pg.athlete_id
       WHERE f.event_id = $1
         AND ($2::uuid IS NULL OR pg.fixture_id = $2)
         ${classFilter}
         AND pg.voided_at IS NULL
       ORDER BY pg.para_class_code NULLS LAST, pg.rank_in_class NULLS LAST, pg.rank_overall NULLS LAST
       LIMIT $${classArgs.length - 1} OFFSET $${classArgs.length}`,
      [...classArgs.slice(0, -2), youth, ...classArgs.slice(-2)],
    ).catch(() => []); // table may not exist for non-para events

    const classes = [...new Set(rows.map((r) => r.para_class_code).filter(Boolean))];

    const byClass = classes.reduce((acc, code) => {
      acc[code] = rows.filter((r) => r.para_class_code === code);
      return acc;
    }, {});

    return {
      event_id: inp.event_id,
      fixture_id: inp.fixture_id ?? null,
      class_aware_scoreboard: settings?.class_aware_scoreboard ?? true,
      show_combined_view: settings?.show_combined_view ?? true,
      combined_disclaimer: 'Rankings across different para-sport classes are not directly comparable.',
      classes: classes.map((code) => ({ code, entries: byClass[code] })),
      combined: (settings?.show_combined_view ?? true) && inp.include_combined
        ? rows.map((r) => ({ ...r, combined_view_disclaimer: true }))
        : null,
    };
  },
});

// ------------------------------------------------------------------ play-by-play (read)

cap({
  name: 'para_spectator_play_by_play',
  method: 'GET',
  path: '/public/fixtures/:fixture_id/play-by-play',
  summary: 'Text play-by-play feed — screen-reader friendly, non-video coverage for hearing/vision-impaired spectators',
  tag: 'para-accessibility',
  auth: 'public',
  input: z.object({
    fixture_id:      id,
    para_class_code: z.string().max(20).optional(),
    since_id:        id.optional(),
    ...page,
  }),
  async handler(_, inp) {
    const fx = await loadViewableFixture(inp.fixture_id);
    if (!fx) throw notFound();

    const rows = await many(
      `SELECT id, para_class_code, entry_at, entry_text, entry_kind, authored_source
         FROM fixture_play_by_play
        WHERE fixture_id = $1
          AND removed_at IS NULL
          AND ($2::uuid IS NULL OR id > $2)
          AND ($3::text IS NULL OR para_class_code = $3)
        ORDER BY entry_at DESC
        LIMIT $4 OFFSET $5`,
      [inp.fixture_id, inp.since_id ?? null, inp.para_class_code ?? null, inp.limit, inp.offset],
    );

    return { fixture_id: inp.fixture_id, entries: rows };
  },
});

// ------------------------------------------------------------------ play-by-play (write — organiser only)

cap({
  name: 'para_spectator_play_by_play_add',
  method: 'POST',
  path: '/fixtures/:fixture_id/play-by-play',
  summary: 'Add a play-by-play text entry (organiser only)',
  tag: 'para-accessibility',
  auth: 'user',
  input: z.object({
    fixture_id:      id,
    para_class_code: z.string().max(20).optional(),
    entry_text:      z.string().min(1).max(2000),
    entry_kind:      ENTRY_KIND.default('update'),
  }),
  async handler(ctx, inp) {
    const fx = await loadViewableFixture(inp.fixture_id);
    if (!fx) throw notFound();
    if (!(await isOrganiserOf(ctx.user.id, fx.event_id))) throw forbidden();

    const row = await one(
      `INSERT INTO fixture_play_by_play (fixture_id, event_id, para_class_code, entry_text, entry_kind, authored_by, authored_source)
         SELECT $1, f.event_id, $2, $3, $4, $5, 'staff'
           FROM fixtures f WHERE f.id = $1
       RETURNING id, entry_at, entry_text, entry_kind, para_class_code`,
      [inp.fixture_id, inp.para_class_code ?? null, inp.entry_text, inp.entry_kind, ctx.user.id],
    );
    return row;
  },
});

// ------------------------------------------------------------------ play-by-play (remove — organiser only)

cap({
  name: 'para_spectator_play_by_play_remove',
  method: 'DELETE',
  path: '/fixtures/:fixture_id/play-by-play/:entry_id',
  summary: 'Soft-remove a play-by-play entry (organiser only)',
  tag: 'para-accessibility',
  auth: 'user',
  input: z.object({ fixture_id: id, entry_id: id }),
  async handler(ctx, inp) {
    const fx = await loadViewableFixture(inp.fixture_id);
    if (!fx) throw notFound();
    if (!(await isOrganiserOf(ctx.user.id, fx.event_id))) throw forbidden();

    const row = await one(
      `UPDATE fixture_play_by_play SET removed_at = now() WHERE id = $1 AND fixture_id = $2 AND removed_at IS NULL RETURNING id`,
      [inp.entry_id, inp.fixture_id],
    );
    if (!row) throw notFound();
    return { removed: true, id: row.id };
  },
});

// ------------------------------------------------------------------ accessible media (public)

cap({
  name: 'para_spectator_accessible_media',
  method: 'GET',
  path: '/public/events/:event_id/accessible-media',
  summary: 'Public media assets enriched with caption, audio description, transcript and alt-text links',
  tag: 'para-accessibility',
  auth: 'public',
  input: z.object({
    event_id:   id,
    fixture_id: id.optional(),
    a11y_status: A11Y_STATUS.optional(),
    limit:      z.coerce.number().int().min(1).max(100).default(24),
  }),
  async handler(_, inp) {
    const ev = await loadViewableEvent(inp.event_id);
    if (!ev) throw notFound();

    const assets = await publicMedia(inp.event_id, { fixtureId: inp.fixture_id, limit: inp.limit });
    // publicMedia now returns a11y fields; filter if status requested
    const filtered = inp.a11y_status
      ? assets.filter((a) => a.a11y_status === inp.a11y_status)
      : assets;

    return { event_id: inp.event_id, assets: filtered };
  },
});

// ------------------------------------------------------------------ accessible streams (public)

cap({
  name: 'para_spectator_accessible_streams',
  method: 'GET',
  path: '/public/events/:event_id/accessible-streams',
  summary: 'Public streams enriched with caption and audio description track links',
  tag: 'para-accessibility',
  auth: 'public',
  input: z.object({
    event_id:   id,
    fixture_id: id.optional(),
  }),
  async handler(_, inp) {
    const ev = await loadViewableEvent(inp.event_id);
    if (!ev) throw notFound();

    const streams = await publicStreams(inp.event_id, inp.fixture_id ?? null);
    return { event_id: inp.event_id, streams };
  },
});

// ------------------------------------------------------------------ accessibility settings (read — public)

cap({
  name: 'para_spectator_settings_get',
  method: 'GET',
  path: '/public/fixtures/:fixture_id/accessibility-settings',
  summary: 'Per-fixture accessibility configuration (caption provider, audio description, play-by-play, etc.)',
  tag: 'para-accessibility',
  auth: 'public',
  input: z.object({ fixture_id: id }),
  async handler(_, inp) {
    const fx = await loadViewableFixture(inp.fixture_id);
    if (!fx) throw notFound();

    const row = await one(
      `SELECT fixture_id, caption_provider_url, audio_desc_provider_url,
              play_by_play_enabled, screen_reader_regions, high_contrast_enabled,
              class_aware_scoreboard, show_combined_view,
              caption_status, audio_desc_status, transcript_status, updated_at
         FROM fixture_accessibility_settings WHERE fixture_id = $1`,
      [inp.fixture_id],
    );

    // Return defaults when no settings row exists yet — honest "unknown" for unset services
    return row ?? {
      fixture_id: inp.fixture_id,
      caption_provider_url: null,
      audio_desc_provider_url: null,
      play_by_play_enabled: true,
      screen_reader_regions: true,
      high_contrast_enabled: false,
      class_aware_scoreboard: true,
      show_combined_view: true,
      caption_status: 'unknown',
      audio_desc_status: 'unknown',
      transcript_status: 'unknown',
      updated_at: null,
    };
  },
});

// ------------------------------------------------------------------ accessibility settings (upsert — organiser only)

cap({
  name: 'para_spectator_settings_set',
  method: 'POST',
  path: '/fixtures/:fixture_id/accessibility-settings',
  summary: 'Save per-fixture accessibility configuration (organiser only)',
  tag: 'para-accessibility',
  auth: 'user',
  input: z.object({
    fixture_id:              id,
    caption_provider_url:    z.string().url().optional().nullable(),
    audio_desc_provider_url: z.string().url().optional().nullable(),
    play_by_play_enabled:    z.boolean().optional(),
    screen_reader_regions:   z.boolean().optional(),
    high_contrast_enabled:   z.boolean().optional(),
    class_aware_scoreboard:  z.boolean().optional(),
    show_combined_view:      z.boolean().optional(),
    caption_status:          A11Y_STATUS.optional(),
    audio_desc_status:       A11Y_STATUS.optional(),
    transcript_status:       A11Y_STATUS.optional(),
  }),
  async handler(ctx, inp) {
    const fx = await loadViewableFixture(inp.fixture_id);
    if (!fx) throw notFound();
    if (!(await isOrganiserOf(ctx.user.id, fx.event_id))) throw forbidden();

    const row = await one(
      `INSERT INTO fixture_accessibility_settings AS s (
         fixture_id, caption_provider_url, audio_desc_provider_url,
         play_by_play_enabled, screen_reader_regions, high_contrast_enabled,
         class_aware_scoreboard, show_combined_view,
         caption_status, audio_desc_status, transcript_status,
         updated_by, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (fixture_id) DO UPDATE SET
         caption_provider_url    = COALESCE(EXCLUDED.caption_provider_url,    s.caption_provider_url),
         audio_desc_provider_url = COALESCE(EXCLUDED.audio_desc_provider_url, s.audio_desc_provider_url),
         play_by_play_enabled    = COALESCE(EXCLUDED.play_by_play_enabled,    s.play_by_play_enabled),
         screen_reader_regions   = COALESCE(EXCLUDED.screen_reader_regions,   s.screen_reader_regions),
         high_contrast_enabled   = COALESCE(EXCLUDED.high_contrast_enabled,   s.high_contrast_enabled),
         class_aware_scoreboard  = COALESCE(EXCLUDED.class_aware_scoreboard,  s.class_aware_scoreboard),
         show_combined_view      = COALESCE(EXCLUDED.show_combined_view,      s.show_combined_view),
         caption_status          = COALESCE(EXCLUDED.caption_status,          s.caption_status),
         audio_desc_status       = COALESCE(EXCLUDED.audio_desc_status,       s.audio_desc_status),
         transcript_status       = COALESCE(EXCLUDED.transcript_status,       s.transcript_status),
         updated_by              = EXCLUDED.updated_by,
         updated_at              = EXCLUDED.updated_at
       RETURNING *`,
      [
        inp.fixture_id,
        inp.caption_provider_url ?? null,
        inp.audio_desc_provider_url ?? null,
        inp.play_by_play_enabled ?? true,
        inp.screen_reader_regions ?? true,
        inp.high_contrast_enabled ?? false,
        inp.class_aware_scoreboard ?? true,
        inp.show_combined_view ?? true,
        inp.caption_status ?? 'unknown',
        inp.audio_desc_status ?? 'unknown',
        inp.transcript_status ?? 'unknown',
        ctx.user.id,
      ],
    );
    return row;
  },
});

// ------------------------------------------------------------------ update a11y metadata on a media asset (organiser only)

cap({
  name: 'para_spectator_asset_a11y_set',
  method: 'PATCH',
  path: '/media/assets/:asset_id/accessibility',
  summary: 'Set caption, audio description, transcript URL and alt text on a media asset (organiser only)',
  tag: 'para-accessibility',
  auth: 'user',
  input: z.object({
    asset_id:       id,
    caption_ref:    z.string().url().optional().nullable(),
    audio_desc_ref: z.string().url().optional().nullable(),
    transcript_ref: z.string().url().optional().nullable(),
    alt_text:       z.string().max(1000).optional().nullable(),
    a11y_status:    A11Y_STATUS.optional(),
  }),
  async handler(ctx, inp) {
    const asset = await one(
      `SELECT a.id, a.event_id FROM mr_assets a WHERE a.id = $1 AND a.status != 'deleted'`,
      [inp.asset_id],
    );
    if (!asset) throw notFound();
    if (!(await isOrganiserOf(ctx.user.id, asset.event_id))) throw forbidden();

    const row = await one(
      `UPDATE mr_assets SET
         caption_ref    = COALESCE($2, caption_ref),
         audio_desc_ref = COALESCE($3, audio_desc_ref),
         transcript_ref = COALESCE($4, transcript_ref),
         alt_text       = COALESCE($5, alt_text),
         a11y_status    = COALESCE($6, a11y_status)
       WHERE id = $1
       RETURNING id, caption_ref, audio_desc_ref, transcript_ref, alt_text, a11y_status`,
      [inp.asset_id, inp.caption_ref ?? null, inp.audio_desc_ref ?? null,
       inp.transcript_ref ?? null, inp.alt_text ?? null, inp.a11y_status ?? null],
    );
    return row;
  },
});

// ------------------------------------------------------------------ update a11y metadata on a stream (organiser only)

cap({
  name: 'para_spectator_stream_a11y_set',
  method: 'PATCH',
  path: '/media/streams/:stream_id/accessibility',
  summary: 'Set caption and audio description track URLs on a stream (organiser only)',
  tag: 'para-accessibility',
  auth: 'user',
  input: z.object({
    stream_id:      id,
    caption_ref:    z.string().url().optional().nullable(),
    audio_desc_ref: z.string().url().optional().nullable(),
    a11y_status:    A11Y_STATUS.optional(),
  }),
  async handler(ctx, inp) {
    const stream = await one(
      `SELECT s.id, s.event_id FROM mr_streams s WHERE s.id = $1 AND s.status = 'active'`,
      [inp.stream_id],
    );
    if (!stream) throw notFound();
    if (!(await isOrganiserOf(ctx.user.id, stream.event_id))) throw forbidden();

    const row = await one(
      `UPDATE mr_streams SET
         caption_ref    = COALESCE($2, caption_ref),
         audio_desc_ref = COALESCE($3, audio_desc_ref),
         a11y_status    = COALESCE($4, a11y_status)
       WHERE id = $1
       RETURNING id, caption_ref, audio_desc_ref, a11y_status`,
      [inp.stream_id, inp.caption_ref ?? null, inp.audio_desc_ref ?? null, inp.a11y_status ?? null],
    );
    return row;
  },
});
