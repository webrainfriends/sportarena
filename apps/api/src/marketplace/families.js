// Provider families of the Sports Services & Opportunity Marketplace (#600). Reference data, not demo data: adding a family is a code change here.
// A family says who may list (account role or organisation) and which approved verification case (verification.js RULES) must be current before a contract.
import { badRequest } from '../errors.js';

export const FAMILIES = [
  { slug: 'athlete', label: 'Athletes', roles: ['athlete'], credential: null, org: false, blurb: 'Appearances, clinics, endorsements and training partners.' },
  { slug: 'coach', label: 'Coaches', roles: ['coach'], credential: 'coach', org: false, blurb: 'Coaching blocks, programmes and camps.' },
  { slug: 'club', label: 'Teams & clubs', roles: [], credential: null, org: true, blurb: 'Fixtures, friendlies, hire of squads and facilities.' },
  { slug: 'official', label: 'Officials', roles: ['referee'], credential: 'referee', org: false, blurb: 'Referees, umpires, scorers and match officials.' },
  { slug: 'doctor', label: 'Doctors', roles: ['doctor'], credential: 'doctor', org: false, blurb: 'Event medical cover and sports medicine services.' },
  { slug: 'physio', label: 'Physios', roles: ['physio'], credential: 'physio', org: false, blurb: 'Event physio cover and treatment programmes.' },
  { slug: 'venue', label: 'Venues', roles: ['venue_manager'], credential: null, org: false, blurb: 'Venue hire and hosting packages.' },
  { slug: 'sponsor', label: 'Sponsors', roles: ['sponsor'], credential: 'sponsor', org: false, blurb: 'Sponsors and brands looking to back athletes, teams and events.' },
  { slug: 'supplier', label: 'Suppliers', roles: ['supplier'], credential: null, org: false, blurb: 'Equipment, ground, crew, catering and event services.' },
  { slug: 'agent', label: 'Agents & recruiters', roles: ['recruiter'], credential: 'recruiter', org: false, blurb: 'Representation, scouting and placement.' },
  { slug: 'lawyer', label: 'Lawyers', roles: ['lawyer'], credential: 'lawyer', org: false, blurb: 'Contracts, disputes, eligibility and governance advice.' },
  { slug: 'insurer', label: 'Insurers', roles: ['insurer'], credential: 'insurer', org: false, blurb: 'Cover for teams, events and athletes.' },
  { slug: 'media', label: 'Media professionals', roles: [], credential: null, org: false, blurb: 'Photographers, broadcasters, commentators and writers.' },
  { slug: 'other', label: 'Other services', roles: [], credential: null, org: false, blurb: 'Any other approved sports-service provider.' },
];
export const FAMILY = Object.fromEntries(FAMILIES.map((f) => [f.slug, f]));
export const FAMILY_SLUGS = FAMILIES.map((f) => f.slug);
export const RATE_UNITS = ['hour', 'session', 'day', 'match', 'project', 'month'];
export const STAGES = ['requested', 'quoted', 'negotiating', 'contracted', 'scheduled', 'delivered', 'invoiced', 'paid', 'reviewed'];
export const CLOSED = ['declined', 'cancelled'];

export const catalogue = () => ({ families: FAMILIES.map(({ slug, label, credential, org, blurb }) => ({ slug, label, credential_required: !!credential, organisation: org, blurb })), rate_units: RATE_UNITS, stages: STAGES });

/** May this account list under the family? Account roles only count when the family names them; organisation families need an organisation. */
export function mayList(user, family, organisationId) {
  const f = FAMILY[family];
  if (!f) throw badRequest(`Unknown provider family: ${family}`);
  if (f.org && !organisationId) throw badRequest(`${f.label} list through an organisation you run`);
  if (f.roles.length && !f.roles.some((r) => user.roles?.includes(r))) throw badRequest(`Listing under ${f.label} needs the ${f.roles.join(' / ')} role on your account`);
  return f;
}
