// Explore directories: the public list of academies (organisations with at least one published, publicly listed programme) and its detail page.
// Suppliers use the existing public `search_suppliers` / `get_supplier_profile`. These are the organic lists that sponsored academy and supplier
// placements (#524) sit beside, and, like every capability, they are tools for MCP agents as well as screens in the app.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { notFound } from '../errors.js';

const TAG = 'Academy';
const LIVE = `FROM organisations o JOIN academy_profiles ap ON ap.organisation_id=o.id AND ap.listed
  WHERE o.status='active' AND EXISTS (SELECT 1 FROM academy_programmes p WHERE p.organisation_id=o.id AND p.status='published' AND p.public)`;

cap({
  name: 'search_academies', method: 'GET', path: '/academies', tag: TAG, auth: 'public',
  summary: 'Discover listed academies by name, city or sport: each has at least one published, public programme. Returns the academy, where it is, its sports and how many programmes it runs. Order is by name only — never by anything paid.',
  input: z.object({ q: z.string().max(80).optional(), sport: z.string().max(40).optional(), city: z.string().max(60).optional(), ...page }),
  async handler(_ctx, i) {
    return many(
      `SELECT o.id, o.name, o.city, ap.sports, ap.focus,
              (SELECT count(*)::int FROM academy_programmes p WHERE p.organisation_id=o.id AND p.status='published' AND p.public) AS programmes
         ${LIVE} AND ($1::text IS NULL OR o.name ILIKE '%'||$1||'%') AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM unnest(ap.sports) s WHERE lower(s)=lower($2)))
         AND ($3::text IS NULL OR lower(o.city)=lower($3)) ORDER BY o.name, o.id LIMIT $4 OFFSET $5`, [i.q ?? null, i.sport ?? null, i.city ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_academy_listing', method: 'GET', path: '/academies/:id', tag: TAG, auth: 'public',
  summary: 'The public page of a listed academy: who it is, where, its sports and its published programmes with fees and seats left.',
  input: z.object({ id }),
  async handler(_ctx, i) {
    const a = await one(`SELECT o.id, o.name, o.city, ap.sports, ap.focus, ap.age_min, ap.age_max ${LIVE} AND o.id=$1`, [i.id]);
    if (!a) throw notFound('Academy');
    const programmes = await many(
      `SELECT p.id, p.title, p.sport, p.focus, p.format, p.age_min, p.age_max, p.starts_on, v.currency, v.fee_minor, v.billing_model
         FROM academy_programmes p JOIN academy_programme_versions v ON v.programme_id=p.id AND v.version=p.current_version
        WHERE p.organisation_id=$1 AND p.status='published' AND p.public ORDER BY p.starts_on NULLS LAST, p.title, p.id`, [i.id]);
    return { ...a, programmes };
  },
});
