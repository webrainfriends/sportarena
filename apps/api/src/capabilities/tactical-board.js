import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';

// Tactical Board — issue #581. Canvas boards linked to videos/fixtures/events.
const TAG = 'Tactical board';

const PITCH_TEMPLATES = ['full_pitch','half_pitch','penalty_area','basketball_full','basketball_half','tennis_full','rugby_full','blank'];
const ITEM_KINDS = ['player','marker','arrow','zone','text','line'];

const posSchema = z.union([
  z.object({ x: z.number(), y: z.number() }),
  z.array(z.object({ x: z.number(), y: z.number() })).min(1),
]);

async function ownedBoard(userId, bid) {
  const b = await one(`SELECT id, owner_id, version FROM tactical_boards WHERE id=$1 AND archived_at IS NULL`, [bid]);
  if (!b || b.owner_id !== userId) throw notFound('Tactical board');
  return b;
}

cap({
  name: 'create_tactical_board', method: 'POST', path: '/tactical-boards', tag: TAG,
  summary: 'Create a new tactical board canvas. Choose a pitch template matching the sport. Optionally link to a specific event or fixture.',
  input: z.object({
    title: z.string().min(1).max(200),
    sport_slug: z.string().max(60).optional(),
    event_id: id.optional(),
    fixture_id: id.optional(),
    pitch_template: z.enum(PITCH_TEMPLATES).default('full_pitch'),
  }),
  async handler({ user }, i) {
    const sportId = i.sport_slug
      ? (await one('SELECT id FROM sports WHERE slug=$1', [i.sport_slug]))?.id ?? null
      : null;
    if (i.sport_slug && !sportId) throw notFound('Sport');
    const row = await one(
      `INSERT INTO tactical_boards (owner_id, title, sport_id, event_id, fixture_id, pitch_template)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, title, pitch_template, version, created_at`,
      [user.id, i.title, sportId, i.event_id ?? null, i.fixture_id ?? null, i.pitch_template]);
    return row;
  },
});

cap({
  name: 'list_tactical_boards', method: 'GET', path: '/tactical-boards', tag: TAG,
  summary: 'All your tactical boards, newest first. Filter by sport, event or fixture.',
  input: z.object({
    sport_slug: z.string().max(60).optional(),
    event_id: id.optional(),
    fixture_id: id.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    return many(
      `SELECT b.id, b.title, s.slug AS sport_slug, s.name AS sport, b.event_id, b.fixture_id,
         b.pitch_template, b.version, b.created_at,
         (SELECT count(*) FROM tactical_board_items x WHERE x.board_id=b.id AND x.removed_at IS NULL)::int AS item_count,
         (SELECT count(*) FROM tactical_board_video_links l WHERE l.board_id=b.id)::int AS video_link_count
       FROM tactical_boards b LEFT JOIN sports s ON s.id=b.sport_id
       WHERE b.owner_id=$1 AND b.archived_at IS NULL
         AND ($2::text IS NULL OR s.slug=$2)
         AND ($3::uuid IS NULL OR b.event_id=$3)
         AND ($4::uuid IS NULL OR b.fixture_id=$4)
       ORDER BY b.created_at DESC LIMIT $5 OFFSET $6`,
      [user.id, i.sport_slug ?? null, i.event_id ?? null, i.fixture_id ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_tactical_board', method: 'GET', path: '/tactical-boards/:id', tag: TAG,
  summary: 'Full board with all active items (players, arrows, zones, text, lines).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const b = await ownedBoard(user.id, i.id);
    const items = await many(
      `SELECT id, kind, position, style, label, created_at FROM tactical_board_items
       WHERE board_id=$1 AND removed_at IS NULL ORDER BY created_at`,
      [i.id]);
    const board = await one(
      `SELECT b.id, b.title, s.slug AS sport_slug, s.name AS sport, b.event_id, b.fixture_id,
         b.pitch_template, b.version, b.created_at
       FROM tactical_boards b LEFT JOIN sports s ON s.id=b.sport_id WHERE b.id=$1`,
      [i.id]);
    return { ...board, items };
  },
});

cap({
  name: 'update_tactical_board', method: 'PATCH', path: '/tactical-boards/:id/meta', tag: TAG,
  summary: 'Rename a board or change its pitch template. Version is bumped to support optimistic concurrency.',
  input: z.object({
    id,
    title: z.string().min(1).max(200).optional(),
    pitch_template: z.enum(PITCH_TEMPLATES).optional(),
    version: z.number().int().min(1),
  }),
  async handler({ user }, i) {
    const b = await ownedBoard(user.id, i.id);
    if (b.version !== i.version) throw conflict('Board was changed elsewhere; reload and retry', { code: 'stale_version' });
    await one(
      `UPDATE tactical_boards SET title=COALESCE($3,title), pitch_template=COALESCE($4,pitch_template), version=version+1
       WHERE id=$1 AND owner_id=$2`,
      [i.id, user.id, i.title ?? null, i.pitch_template ?? null]);
    return { ok: true, version: b.version + 1 };
  },
});

cap({
  name: 'archive_tactical_board', method: 'DELETE', path: '/tactical-boards/:id', tag: TAG,
  summary: 'Soft-archive a tactical board (data kept).',
  input: z.object({ id }),
  async handler({ user }, i) {
    await ownedBoard(user.id, i.id);
    await one(`UPDATE tactical_boards SET archived_at=now() WHERE id=$1 AND owner_id=$2`, [i.id, user.id]);
    return { ok: true };
  },
});

cap({
  name: 'add_board_item', method: 'POST', path: '/tactical-boards/:id/items', tag: TAG,
  summary: 'Add a single item (player token, arrow, zone, text label, line or marker) to a board.',
  input: z.object({
    id,
    kind: z.enum(ITEM_KINDS),
    position: posSchema,
    style: z.object({
      color: z.string().optional(),
      team_side: z.enum(['home','away','neutral']).optional(),
      jersey_no: z.string().max(3).optional(),
      dash: z.boolean().optional(),
      fill: z.string().optional(),
    }).optional(),
    label: z.string().max(60).optional(),
  }),
  async handler({ user }, i) {
    await ownedBoard(user.id, i.id);
    const row = await one(
      `INSERT INTO tactical_board_items (board_id, kind, position, style, label)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, position, style, label, created_at`,
      [i.id, i.kind, JSON.stringify(i.position), i.style ? JSON.stringify(i.style) : null, i.label ?? null]);
    return row;
  },
});

cap({
  name: 'update_board_item', method: 'PATCH', path: '/tactical-board-items/:item_id', tag: TAG,
  summary: 'Move or restyle a board item.',
  input: z.object({
    item_id: id,
    position: posSchema.optional(),
    style: z.any().optional(),
    label: z.string().max(60).optional().nullable(),
  }),
  async handler({ user }, i) {
    const item = await one(
      `SELECT x.id FROM tactical_board_items x JOIN tactical_boards b ON b.id=x.board_id WHERE x.id=$1 AND b.owner_id=$2 AND x.removed_at IS NULL`,
      [i.item_id, user.id]);
    if (!item) throw notFound('Board item');
    await one(
      `UPDATE tactical_board_items SET position=COALESCE($3::jsonb,position), style=COALESCE($4::jsonb,style), label=COALESCE($5,label)
       WHERE id=$1`,
      [i.item_id, user.id, i.position ? JSON.stringify(i.position) : null,
       i.style ? JSON.stringify(i.style) : null, i.label ?? null]);
    return { ok: true };
  },
});

cap({
  name: 'remove_board_item', method: 'DELETE', path: '/tactical-board-items/:item_id', tag: TAG,
  summary: 'Soft-remove a board item.',
  input: z.object({ item_id: id }),
  async handler({ user }, i) {
    const item = await one(
      `SELECT x.id FROM tactical_board_items x JOIN tactical_boards b ON b.id=x.board_id WHERE x.id=$1 AND b.owner_id=$2 AND x.removed_at IS NULL`,
      [i.item_id, user.id]);
    if (!item) throw notFound('Board item');
    await one(`UPDATE tactical_board_items SET removed_at=now() WHERE id=$1`, [i.item_id]);
    return { ok: true };
  },
});

cap({
  name: 'batch_update_board_items', method: 'POST', path: '/tactical-boards/:id/items/batch', tag: TAG,
  summary: 'Atomically apply multiple add/move/remove operations to a board in one transaction. Provide the current board version for optimistic concurrency.',
  input: z.object({
    id,
    version: z.number().int().min(1),
    ops: z.array(z.discriminatedUnion('op', [
      z.object({ op: z.literal('add'), kind: z.enum(ITEM_KINDS), position: posSchema, style: z.any().optional(), label: z.string().max(60).optional() }),
      z.object({ op: z.literal('move'), item_id: id, position: posSchema }),
      z.object({ op: z.literal('style'), item_id: id, style: z.any() }),
      z.object({ op: z.literal('remove'), item_id: id }),
    ])).min(1).max(100),
  }),
  async handler({ user }, i) {
    return tx(async (client) => {
      const b = await client.query(`SELECT id, version FROM tactical_boards WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL FOR UPDATE`, [i.id, user.id]);
      if (!b.rows[0]) throw notFound('Tactical board');
      if (b.rows[0].version !== i.version) throw conflict('Board was changed elsewhere; reload and retry', { code: 'stale_version' });
      const added = [];
      for (const op of i.ops) {
        if (op.op === 'add') {
          const r = await client.query(
            `INSERT INTO tactical_board_items (board_id, kind, position, style, label) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [i.id, op.kind, JSON.stringify(op.position), op.style ? JSON.stringify(op.style) : null, op.label ?? null]);
          added.push(r.rows[0].id);
        } else if (op.op === 'move') {
          await client.query(`UPDATE tactical_board_items SET position=$2 WHERE id=$1 AND board_id=$3 AND removed_at IS NULL`, [op.item_id, JSON.stringify(op.position), i.id]);
        } else if (op.op === 'style') {
          await client.query(`UPDATE tactical_board_items SET style=$2 WHERE id=$1 AND board_id=$3 AND removed_at IS NULL`, [op.item_id, JSON.stringify(op.style), i.id]);
        } else if (op.op === 'remove') {
          await client.query(`UPDATE tactical_board_items SET removed_at=now() WHERE id=$1 AND board_id=$2 AND removed_at IS NULL`, [op.item_id, i.id]);
        }
      }
      await client.query(`UPDATE tactical_boards SET version=version+1 WHERE id=$1`, [i.id]);
      return { ok: true, version: b.rows[0].version + 1, added_ids: added };
    });
  },
});

cap({
  name: 'link_board_to_video', method: 'POST', path: '/tactical-boards/:id/video-links', tag: TAG,
  summary: 'Link a board snapshot to a specific video timestamp, optionally tying it to an annotation.',
  input: z.object({
    id,
    video_id: id,
    timestamp_ms: z.number().int().min(0),
    annotation_id: id.optional(),
  }),
  async handler({ user }, i) {
    await ownedBoard(user.id, i.id);
    const row = await one(
      `INSERT INTO tactical_board_video_links (board_id, video_id, annotation_id, timestamp_ms, created_by_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (board_id, video_id, timestamp_ms) DO UPDATE SET annotation_id=$3
       RETURNING id, timestamp_ms, created_at`,
      [i.id, i.video_id, i.annotation_id ?? null, i.timestamp_ms, user.id]);
    return row;
  },
});

cap({
  name: 'list_board_video_links', method: 'GET', path: '/tactical-boards/:id/video-links', tag: TAG,
  summary: 'All video timestamp links for a tactical board.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await ownedBoard(user.id, i.id);
    return many(
      `SELECT l.id, l.video_id, pv.title AS video_title, l.annotation_id, l.timestamp_ms, l.created_at
       FROM tactical_board_video_links l JOIN passport_videos pv ON pv.id=l.video_id
       WHERE l.board_id=$1 ORDER BY l.timestamp_ms`,
      [i.id]);
  },
});

cap({
  name: 'remove_board_video_link', method: 'DELETE', path: '/tactical-board-video-links/:link_id', tag: TAG,
  summary: 'Remove a board-to-video link.',
  input: z.object({ link_id: id }),
  async handler({ user }, i) {
    const link = await one(
      `SELECT l.id FROM tactical_board_video_links l JOIN tactical_boards b ON b.id=l.board_id
       WHERE l.id=$1 AND b.owner_id=$2`,
      [i.link_id, user.id]);
    if (!link) throw notFound('Video link');
    await one(`DELETE FROM tactical_board_video_links WHERE id=$1`, [i.link_id]);
    return { ok: true };
  },
});

cap({
  name: 'export_tactical_board', method: 'GET', path: '/tactical-boards/:id/export', tag: TAG,
  summary: 'Export a tactical board as a structured JSON snapshot with all items, style and video links.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const b = await ownedBoard(user.id, i.id);
    audit(user.id, 'tactical_board_export', { board_id: i.id });
    const board = await one(
      `SELECT b.id, b.title, s.slug AS sport_slug, b.pitch_template, b.version, b.created_at
       FROM tactical_boards b LEFT JOIN sports s ON s.id=b.sport_id WHERE b.id=$1`,
      [i.id]);
    const items = await many(`SELECT id, kind, position, style, label FROM tactical_board_items WHERE board_id=$1 AND removed_at IS NULL ORDER BY created_at`, [i.id]);
    const links = await many(
      `SELECT l.id, l.video_id, pv.title AS video_title, l.timestamp_ms FROM tactical_board_video_links l JOIN passport_videos pv ON pv.id=l.video_id WHERE l.board_id=$1 ORDER BY l.timestamp_ms`,
      [i.id]);
    return { ...board, items, video_links: links, exported_at: new Date().toISOString() };
  },
});
