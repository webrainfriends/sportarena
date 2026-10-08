// Verification rules (what evidence each badge needs and what a reviewer must tick) and the public badge lookup.
// Rules are versioned: a case records the version it was submitted under so later rule changes never rewrite history.
import { many } from './db.js';

export const RULES_VERSION = 1;

export const EVIDENCE_KINDS = {
  id_document: 'Government photo ID',
  profile_link: 'Public profile / league listing (link)',
  club_letter: 'Letter from a club, academy or league',
  match_record: 'Match or competition record',
  coaching_certificate: 'Coaching certificate',
  federation_licence: 'Federation or association licence',
  professional_licence: 'Professional licence / registration (physio)',
  medical_registration: 'Medical council registration (doctor)',
  business_registration: 'Business registration',
  website_domain_proof: 'Proof of control of the brand website / domain',
  authorisation_letter: 'Letter authorising you to act for the brand',
  sanction_letter: 'Sanction or permit from a federation or authority',
  venue_confirmation: 'Venue confirmation of the booking',
  public_listing: 'Official public listing of the event (link)',
  other: 'Other supporting document',
};

const identity = [
  { key: 'identity_matches', label: 'Name and photo on the ID match the account holder' },
  { key: 'evidence_authentic', label: 'Documents look genuine and unaltered' },
];

export const RULES = {
  gamer: {
    label: 'Verified gamer', subject: 'user', needs_role: 'athlete', validity_months: 12,
    summary: 'Confirms a real person who plays competitively. Having the athlete role alone is not verification.',
    required: ['id_document'], one_of: ['profile_link', 'club_letter', 'match_record'],
    checklist: [...identity, { key: 'play_history', label: 'The listing / letter / record shows the person actually playing' }],
  },
  coach: {
    label: 'Verified coach', subject: 'user', needs_role: 'coach', validity_months: 24,
    summary: 'Confirms a qualified coach with a certificate or licence.',
    required: ['id_document'], one_of: ['coaching_certificate', 'federation_licence'],
    checklist: [...identity, { key: 'credential_valid', label: 'Certificate / licence is current and issued by a recognised body' }, { key: 'sport_matches', label: 'Credential covers the sport on the profile' }],
  },
  physio: {
    label: 'Verified physio', subject: 'user', needs_role: 'physio', validity_months: 12,
    summary: 'Confirms a registered physiotherapist.',
    required: ['id_document', 'professional_licence'],
    checklist: [...identity, { key: 'credential_valid', label: 'Licence number checked with the issuing register and in good standing' }],
  },
  doctor: {
    label: 'Verified doctor', subject: 'user', needs_role: 'doctor', validity_months: 12,
    summary: 'Confirms a registered medical practitioner.',
    required: ['id_document', 'medical_registration'],
    checklist: [...identity, { key: 'credential_valid', label: 'Registration checked with the medical council and in good standing' }],
  },
  sponsor: {
    label: 'Verified sponsor', subject: 'sponsor', needs_role: null, validity_months: 12,
    summary: 'Confirms the brand is a real business and the requester may act for it.',
    required: ['business_registration'], one_of: ['website_domain_proof', 'authorisation_letter'],
    checklist: [{ key: 'business_exists', label: 'Registration is genuine and the business is active' }, { key: 'name_matches', label: 'Registered name matches the sponsor profile' }, { key: 'requester_authorised', label: 'Requester controls the website or is authorised in writing' }],
  },
  event: {
    label: 'Verified event', subject: 'event', needs_role: null, validity_months: 12,
    summary: 'Confirms the event is real, run by the organiser and (where relevant) sanctioned.',
    required: [], one_of: ['sanction_letter', 'venue_confirmation', 'public_listing'],
    checklist: [{ key: 'event_exists', label: 'Event is real and dates / venue are consistent with the evidence' }, { key: 'organiser_authorised', label: 'Organiser is the person running it' }, { key: 'evidence_authentic', label: 'Documents look genuine and unaltered' }],
  },
};

export const TYPES = Object.keys(RULES);
export const OPEN = ['submitted', 'in_review', 'needs_info'];

/** Which required evidence kinds are still missing for a set of provided kinds. */
export function missingEvidence(type, kinds) {
  const r = RULES[type], have = new Set(kinds);
  const missing = r.required.filter((k) => !have.has(k));
  if (r.one_of?.length && !r.one_of.some((k) => have.has(k))) missing.push(`one of: ${r.one_of.join(' / ')}`);
  return missing;
}

/** Public badges: only approved, unrevoked, unexpired cases. Returns Map(subjectId -> [{type, verified_at, expires_at}]). */
export async function badgesFor(subjectType, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = await many(
    `SELECT DISTINCT ON (subject_id, type) subject_id, type, decided_at AS verified_at, expires_at
       FROM verification_cases WHERE subject_type=$1 AND subject_id = ANY($2::uuid[]) AND status='approved' AND expires_at > now()
      ORDER BY subject_id, type, decided_at DESC`, [subjectType, ids]);
  for (const r of rows) out.set(r.subject_id, [...(out.get(r.subject_id) ?? []), { type: r.type, verified_at: r.verified_at, expires_at: r.expires_at }]);
  return out;
}

/** Add `verified` (badge list) to public rows that carry an id. */
export async function withBadges(subjectType, rows) {
  const m = await badgesFor(subjectType, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, verified: m.get(r.id) ?? [] }));
}
