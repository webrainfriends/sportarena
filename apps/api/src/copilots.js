// Role copilots (issue #598): the catalogue of copilots and their tasks, the guardrails, and the plain-rule derivation of items. Nothing here
// touches the database or a model. A task names the existing capabilities it reads (each applies its own ownership, consent and youth rules)
// and a pure `derive` that turns what they returned into items that cite their source. Actions are proposed from the items by code, never by a model.
export const RULES_VERSION = 'copilots-1';

// Decisions a copilot never takes or executes, whoever asks and however it is worded. Proposals of these kinds are stored as advisory only.
export const FORBIDDEN = {
  procurement_award: /\b(award(ing)? (the )?(tender|contract|rfp|bid)|select(ing)? (the )?winning (bid|supplier))\b/i,
  medical_clearance: /\b(clear(ed|ing)? (him|her|them|the (player|athlete)) (to|for) (play|train)|return[- ]to[- ]play|fit to play|medical clearance)\b/i,
  discipline: /\b(suspend(ing)?|sanction(ing)?|ban(ning)?|disciplin\w*|expel\w*)\b/i,
  classification: /\b(classif\w*|re-?grad\w*|reclassif\w*)\b/i,
  contract_signature: /\b(sign(ing)? (the|a|this|my) (contract|agreement)|countersign\w*|execute (the )?contract)\b/i,
  transfer_approval: /\b(approv\w* (the |a )?transfer|release (the )?(player|athlete) registration)\b/i,
  money_movement: /\b(pay(ing)? out|payout|refund\w*|transfer funds|release (the )?funds|wire|settle(ment)? now|mark (as )?paid)\b/i,
};
export const forbiddenKind = (text) => Object.entries(FORBIDDEN).find(([, re]) => re.test(String(text ?? '')))?.[0] ?? null;

// The only things approving an action may run. Everything else is advisory: the person decides in the screen that owns the decision.
export const EXECUTABLE = { todo: null, create_event_task: 'create_event_task' };

export const COPILOTS = {
  coach: { roles: ['coach'], scope: null, delegate: 'coaching' },
  athlete: { roles: ['athlete'], scope: null, delegate: 'player' },
  event: { roles: ['organizer'], scope: 'event' },
  federation: { roles: null, scope: 'body' },
  sponsor: { roles: ['sponsor'], scope: null },
  supplier: { roles: ['supplier'], scope: null },
  venue: { roles: ['venue_manager'], scope: 'venue' },
  official: { roles: ['referee'], scope: null },
  organisation: { roles: null, scope: 'organisation' },
};

const rows = (x) => (Array.isArray(x) ? x : x?.items ?? x?.rows ?? []);
const day = (v) => (v ? String(v).slice(0, 10) : null);
const name = (r) => r.title ?? r.name ?? r.label ?? r.display_name ?? r.holder_name ?? r.organisation_name ?? r.sponsor_name ?? r.ref ?? 'Record';
const sev = (s) => (['critical', 'urgent', 'high', 'bad'].includes(s) ? 'high' : ['medium', 'warn'].includes(s) ? 'medium' : 'low');
const it = (o) => ({ severity: 'low', ...o });

// Each task: label key (for the app, via i18n), the capabilities it reads, and derive(results, scope) -> items [{key,title,detail,severity,ref,action?}]
// `ref` names which read the item came from; the capability turns it into a numbered source reference.
export const TASKS = {
  event: {
    readiness_gaps: {
      reads: [{ key: 'readiness', cap: 'get_event_readiness', input: (s) => ({ id: s.id }) }],
      derive: ({ readiness: r }, s) => rows(r?.items).filter((x) => x.state === 'open' && x.required !== false).slice(0, 25).map((x) => it({
        key: `req-${x.id ?? x.title}`, title: name(x), detail: x.detail ?? (x.owner_name ? `Owner: ${x.owner_name}` : 'No owner yet'), severity: x.owner_name ? 'medium' : 'high', ref: 'readiness',
        action: { kind: 'create_event_task', label: `Create a task: ${name(x)}`, payload: { id: s.id, title: String(name(x)).slice(0, 160), priority: 'high' } },
      })),
      headline: (items, { readiness: r }) => (r ? `${r.percent ?? 0}% ready; ${items.length} open requirement${items.length === 1 ? '' : 's'} need attention` : 'Readiness could not be read'),
    },
    incidents: {
      reads: [{ key: 'incidents', cap: 'list_event_incidents', input: (s) => ({ id: s.id, status: 'active' }) }],
      derive: ({ incidents: r }) => rows(r).slice(0, 25).map((x) => it({ key: `inc-${x.id}`, title: `${x.ref ?? ''} ${x.title}`.trim(), detail: `${x.severity} · ${x.status}${x.assignee_name ? ` · handled by ${x.assignee_name}` : ' · nobody assigned'}`, severity: sev(x.severity), ref: 'incidents' })),
      headline: (items) => `${items.length} active incident${items.length === 1 ? '' : 's'}`,
    },
    vendor_followup: {
      reads: [{ key: 'vendors', cap: 'list_event_vendors', input: (s) => ({ id: s.id }) }],
      derive: ({ vendors: r }, s) => rows(r).filter((v) => v.status !== 'confirmed').slice(0, 25).map((v) => it({
        key: `ven-${v.id}`, title: `${name(v)}: ${v.kind ?? 'vendor'}`, detail: `Status ${String(v.status).replace(/_/g, ' ')}`, severity: v.status === 'invited' ? 'medium' : 'low', ref: 'vendors',
        action: { kind: 'create_event_task', label: `Create a task: follow up ${name(v)}`, payload: { id: s.id, title: `Follow up ${name(v)}`.slice(0, 160), priority: 'normal' } },
      })),
      headline: (items) => `${items.length} vendor${items.length === 1 ? '' : 's'} not yet confirmed`,
    },
    run_of_show: {
      reads: [{ key: 'readiness', cap: 'get_event_readiness', input: (s) => ({ id: s.id }) }, { key: 'incidents', cap: 'list_event_incidents', input: (s) => ({ id: s.id, status: 'active' }) }],
      derive: ({ readiness: r, incidents: inc }) => [
        ...rows(inc).slice(0, 5).map((x) => it({ key: `inc-${x.id}`, title: `Before doors: resolve ${x.title}`, detail: `${x.severity} incident, ${x.status}`, severity: sev(x.severity), ref: 'incidents' })),
        ...rows(r?.items).filter((x) => x.state === 'open' && x.required !== false).slice(0, 10).map((x) => it({ key: `req-${x.id ?? x.title}`, title: `Confirm ${name(x)}`, detail: x.detail ?? 'Open requirement', severity: 'medium', ref: 'readiness' })),
      ],
      headline: (items) => `${items.length} item${items.length === 1 ? '' : 's'} to clear before the run of show starts`,
    },
  },
  federation: {
    expiring_affiliations: {
      reads: [{ key: 'affiliations', cap: 'list_affiliations', input: (s) => ({ body_id: s.id, expiring_within_days: 90, include_descendants: true }) }],
      derive: ({ affiliations: r }) => rows(r).slice(0, 25).map((x) => it({ key: `aff-${x.id}`, title: name(x), detail: `Affiliation ${x.status ?? ''} · ends ${day(x.ends_on ?? x.end_date ?? x.valid_to) ?? 'soon'}`, severity: 'medium', ref: 'affiliations' })),
      headline: (items) => `${items.length} affiliation${items.length === 1 ? '' : 's'} expiring within 90 days`,
    },
    expiring_licences: {
      reads: [{ key: 'licences', cap: 'list_licences', input: (s) => ({ body_id: s.id, expiring_within_days: 90, include_descendants: true }) }],
      derive: ({ licences: r }) => rows(r).slice(0, 25).map((x) => it({ key: `lic-${x.id}`, title: name(x), detail: `Licence ${x.status ?? ''} · expires ${day(x.expires_on ?? x.expiry_date ?? x.valid_to) ?? 'soon'}`, severity: 'medium', ref: 'licences' })),
      headline: (items) => `${items.length} licence${items.length === 1 ? '' : 's'} expiring within 90 days`,
    },
    registration_exceptions: {
      reads: [{ key: 'exceptions', cap: 'list_federation_exceptions', input: (s) => ({ id: s.id, status: 'open', include_descendants: true }) }],
      derive: ({ exceptions: r }) => rows(r).slice(0, 25).map((x) => it({ key: `exc-${x.id}`, title: name(x), detail: `${x.subject_type ?? 'record'} approved over a failed requirement${x.review_due_on ? ` · review due ${day(x.review_due_on)}` : ''}`, severity: x.overdue ? 'high' : 'medium', ref: 'exceptions' })),
      headline: (items) => `${items.length} open compliance exception${items.length === 1 ? '' : 's'}`,
    },
    governance_report: {
      reads: [{ key: 'campaigns', cap: 'list_renewal_campaigns', input: (s) => ({ id: s.id }) }, { key: 'exceptions', cap: 'list_federation_exceptions', input: (s) => ({ id: s.id, status: 'overdue' }) }],
      derive: ({ campaigns: c, exceptions: e }) => [
        ...rows(c).map((x) => it({ key: `cmp-${x.id}`, title: `Renewal campaign: ${name(x)}`, detail: `Status ${x.status}${x.progress ? ` · ${x.progress.renewed ?? 0} renewed, ${x.progress.lapsed ?? 0} lapsed` : ''}`, severity: x.progress?.lapsed ? 'medium' : 'low', ref: 'campaigns' })),
        ...rows(e).map((x) => it({ key: `exc-${x.id}`, title: `Overdue exception review: ${name(x)}`, detail: 'Review date has passed', severity: 'high', ref: 'exceptions' })),
      ],
      headline: (items) => `${items.length} governance item${items.length === 1 ? '' : 's'} for the report`,
    },
  },
  sponsor: {
    fulfilment: {
      reads: [{ key: 'obligations', cap: 'list_sponsorship_obligations', input: () => ({ state: 'overdue' }) }, { key: 'upcoming', cap: 'list_sponsorship_obligations', input: () => ({ state: 'upcoming' }) }],
      derive: ({ obligations: o, upcoming: u }) => [
        ...rows(o).slice(0, 15).map((x) => it({ key: `ob-${x.id}`, title: name(x), detail: `Overdue${x.due_on ? ` since ${day(x.due_on)}` : ''}`, severity: 'high', ref: 'obligations' })),
        ...rows(u).slice(0, 15).map((x) => it({ key: `ob-${x.id}`, title: name(x), detail: `Due ${day(x.due_on) ?? 'soon'}`, severity: 'low', ref: 'upcoming' })),
      ],
      headline: (items) => `${items.filter((i) => i.severity === 'high').length} overdue, ${items.filter((i) => i.severity === 'low').length} upcoming obligations`,
    },
    expiring_rights: {
      reads: [{ key: 'deals', cap: 'list_sponsorships', input: () => ({ status: 'active' }) }],
      derive: ({ deals: r }) => rows(r).filter((x) => { const e = x.ends_on ?? x.end_date ?? x.term_end; return e && new Date(e) - Date.now() < 90 * 864e5; }).slice(0, 25).map((x) => it({ key: `deal-${x.id}`, title: name(x), detail: `Ends ${day(x.ends_on ?? x.end_date ?? x.term_end)}`, severity: 'medium', ref: 'deals' })),
      headline: (items) => `${items.length} sponsorship${items.length === 1 ? '' : 's'} ending within 90 days`,
    },
    renewal_prep: {
      reads: [{ key: 'renewals', cap: 'list_sponsorship_renewals', input: () => ({ as: 'sponsor' }) }],
      derive: ({ renewals: r }) => rows(r).slice(0, 25).map((x) => it({ key: `ren-${x.id}`, title: name(x), detail: `Renewal ${String(x.status ?? 'open').replace(/_/g, ' ')}`, severity: 'medium', ref: 'renewals' })),
      headline: (items) => `${items.length} renewal${items.length === 1 ? '' : 's'} to prepare`,
    },
  },
  supplier: {
    opportunities: {
      reads: [{ key: 'rfqs', cap: 'list_my_rfq_invitations', input: () => ({ status: 'invited' }) }],
      derive: ({ rfqs: r }) => rows(r).slice(0, 25).map((x) => it({ key: `rfq-${x.id}`, title: name(x), detail: `Invited${x.respond_by ? `, respond by ${day(x.respond_by)}` : ''}`, severity: 'medium', ref: 'rfqs' })),
      headline: (items) => `${items.length} open RFQ invitation${items.length === 1 ? '' : 's'}`,
    },
    delivery_obligations: {
      reads: [{ key: 'proposals', cap: 'list_my_tender_proposals', input: () => ({}) }],
      derive: ({ proposals: r }) => rows(r).filter((x) => x.status === 'draft').slice(0, 25).map((x) => it({ key: `prop-${x.id}`, title: name(x), detail: `Draft proposal${x.deadline ? `, deadline ${day(x.deadline)}` : ''}`, severity: 'medium', ref: 'proposals' })),
      headline: (items) => `${items.length} draft proposal${items.length === 1 ? '' : 's'} not yet submitted`,
    },
  },
  venue: {
    maintenance: {
      reads: [{ key: 'maintenance', cap: 'list_maintenance', input: (s) => ({ id: s.id }) }],
      derive: ({ maintenance: r }) => rows(r).filter((x) => !['done', 'closed', 'completed'].includes(x.status)).slice(0, 25).map((x) => it({ key: `mnt-${x.id}`, title: name(x), detail: `Status ${x.status ?? 'open'}`, severity: sev(x.priority), ref: 'maintenance' })),
      headline: (items) => `${items.length} open maintenance item${items.length === 1 ? '' : 's'}`,
    },
    operations: {
      reads: [{ key: 'ops', cap: 'venue_operations_overview', input: (s) => ({ id: s.id }) }],
      derive: ({ ops: r }) => rows(r?.alerts ?? r?.attention).slice(0, 25).map((x, n) => it({ key: `ops-${x.id ?? n}`, title: name(x), detail: x.detail ?? x.summary ?? '', severity: sev(x.severity), ref: 'ops' })),
      headline: (items) => `${items.length} item${items.length === 1 ? '' : 's'} need attention at this venue`,
    },
  },
  official: {
    my_week: {
      reads: [{ key: 'home', cap: 'get_officials_home', input: () => ({}) }],
      derive: ({ home: r }) => rows(r?.inbox ?? r?.actions).slice(0, 25).map((x, n) => it({ key: `off-${x.id ?? n}`, title: name(x), detail: x.detail ?? x.kind ?? '', severity: 'medium', ref: 'home' })),
      headline: (items) => `${items.length} action${items.length === 1 ? '' : 's'} in your officiating inbox`,
    },
  },
  organisation: {
    attention: {
      reads: [{ key: 'centre', cap: 'get_org_command_centre', input: (s) => ({ id: s.id }) }],
      derive: ({ centre: r }) => [...rows(r?.alerts).map((x, n) => it({ key: `al-${x.id ?? n}`, title: name(x), detail: x.detail ?? x.summary ?? '', severity: sev(x.severity), ref: 'centre' })),
        ...rows(r?.tiles).filter((x) => x.severity && x.severity !== 'ok').map((x) => it({ key: `tile-${x.key ?? x.area}`, title: name(x), detail: x.summary ?? '', severity: sev(x.severity), ref: 'centre' }))].slice(0, 25),
      headline: (items) => `${items.length} area${items.length === 1 ? '' : 's'} need attention`,
    },
  },
};

// Coach and athlete copilots add nothing of their own: they run the existing assistants and re-present what those cite (no second implementation).
export const DELEGATED = {
  athlete: { week: 'week', goals: 'focus', training: 'overview' },
  coach: { plan_session: 'plan_session', player_focus: 'player_focus', outstanding_actions: 'suggest_actions' },
};

export const taskNames = (copilot) => [...Object.keys(TASKS[copilot] ?? {}), ...Object.keys(DELEGATED[copilot] ?? {})];
