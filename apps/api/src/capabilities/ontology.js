import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, query } from '../db.js';
import { conflict, forbidden, notFound, badRequest } from '../errors.js';
import { isAdmin, mustFind, sportBySlugOrId } from '../helpers.js';
import { NS, classes, properties, vocabularies, roles, ROSTER_ROLES, MANAGER_ROLES, TARGET_TYPES, TARGET_CLASS, FIELD_SCOPES, DATATYPES, coreFields, sportTemplates } from '../ontology/iptc.js';
import { resolveFields } from '../ontology/fields.js';

cap({
  name: 'get_ontology', method: 'GET', path: '/ontology', tag: 'Ontology', auth: 'public',
  summary: 'The app ontology (based on the IPTC Sport Schema): classes, properties, controlled vocabularies, person roles and which table holds each class. Agents should read this first.',
  async handler() {
    const children = (k) => Object.entries(classes).filter(([, c]) => c.parent === k).map(([n]) => n);
    return {
      source: 'https://github.com/iptc/sport-schema', license: 'CC-BY 4.0 (c) IPTC', namespaces: NS,
      classes: Object.entries(classes).map(([name, c]) => ({ name, iri: `sport:${name}`, label: c.label, parent: c.parent, children: children(name), stored_in: c.table ?? null, abstract: !!c.abstract, comment: c.comment })),
      properties: Object.entries(properties).map(([name, p]) => ({ name, ...p })),
      vocabularies: Object.fromEntries(Object.entries(vocabularies).map(([k, v]) => [k, v])),
      roles: Object.entries(roles).map(([key, r]) => ({ key, label: r.label, class: { athlete: 'Athlete', official: 'Official', associate: 'Associate' }[r.kind], required_profile: r.profile, can_attach_to: r.targets, class_of_target: r.targets.map((t) => TARGET_CLASS[t]), manages: MANAGER_ROLES.includes(key) })),
      roster_roles: ROSTER_ROLES, association_targets: TARGET_TYPES,
      field_scopes: FIELD_SCOPES, sports_with_templates: Object.keys(sportTemplates),
    };
  },
});

cap({
  name: 'get_vocabulary', method: 'GET', path: '/ontology/vocabularies/:name', tag: 'Ontology', auth: 'public',
  summary: 'One controlled vocabulary (e.g. eventStatus, eventOutcome, playerStatus, tournamentPhase).', input: z.object({ name: z.string() }),
  async handler(_, i) {
    const v = vocabularies[i.name];
    if (!v) throw notFound('Vocabulary');
    return { name: i.name, ...v };
  },
});

cap({
  name: 'get_game_fields', method: 'GET', path: '/sports/:sport/game-fields', tag: 'Ontology', auth: 'public',
  summary: 'The fields a game of this sport can carry: per scope (game, participant, association) the core fields + IPTC-derived sport template + custom fields. Use these keys in `attributes` / `stats` when creating or updating games.',
  input: z.object({ sport: z.string() }),
  async handler(_, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const fields = {};
    for (const scope of FIELD_SCOPES) fields[scope] = await resolveFields(sport, scope);
    return { sport: { id: sport.id, slug: sport.slug, name: sport.name }, scoring: sport.scoring, fields, core_keys: Object.fromEntries(FIELD_SCOPES.map((s) => [s, coreFields[s].map((f) => f.key)])) };
  },
});

cap({
  name: 'create_field_definition', method: 'POST', path: '/field-definitions', tag: 'Ontology', auth: ['organizer', 'admin'], status: 201,
  summary: 'Add a custom field to games (or to participants / people-in-game) of one sport, or of every sport when `sport` is omitted.',
  input: z.object({
    sport: z.string().optional(), scope: z.enum(FIELD_SCOPES), key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), label: z.string().min(1).max(80),
    datatype: z.enum(DATATYPES), options: z.array(z.string().min(1).max(60)).min(1).max(50).optional(), required: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    if (i.datatype === 'enum' && !i.options) throw badRequest('enum fields need options');
    if (i.datatype !== 'enum' && i.options) throw badRequest('options are only for enum fields');
    const builtInFor = sport ? [sportTemplates[sport.slug]?.[i.scope] ?? []] : Object.values(sportTemplates).map((t) => t[i.scope] ?? []);
    const builtIn = coreFields[i.scope].some((f) => f.key === i.key) || builtInFor.flat().some((f) => f.key === i.key);
    if (builtIn) throw conflict(`"${i.key}" is already a built-in field`);
    return one('INSERT INTO field_definitions(sport_id, scope, key, label, datatype, options, required, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [sport?.id ?? null, i.scope, i.key, i.label, i.datatype, i.options ? JSON.stringify(i.options) : null, i.required, user.id]);
  },
});

cap({
  name: 'delete_field_definition', method: 'DELETE', path: '/field-definitions/:id', tag: 'Ontology',
  summary: 'Remove a custom field definition (creator or admin). Values already stored on games are kept but no longer validated.', input: z.object({ id }),
  async handler({ user }, i) {
    const d = await mustFind('field_definitions', i.id);
    if (!isAdmin(user) && d.created_by !== user.id) throw forbidden();
    await query('DELETE FROM field_definitions WHERE id=$1', [i.id]);
    return { ok: true };
  },
});
