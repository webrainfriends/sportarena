// What the engine offers, as data the API and the app both read: the domains it governs, the classifications and their precedence, the evidence
// kinds and the countries jurisdiction packs are designed for first. Adding a country or a rule never touches code: a pack is a set of rules.
import { CLASS_RANK, CLASSIFICATIONS, EVIDENCE_KINDS, HOLDERS, STATUSES } from './engine.js';

/** The rules a domain judges: `domains` are the rule domains read for it (a rule tagged 'general' is read by every one). */
export const DOMAIN_INFO = {
  procurement: { label: 'Procurement', description: 'Tenders, awards and supplier requirements', judges: ['procurement', 'general'], subjects: ['tender', 'supplier_entity'] },
  event_permit: { label: 'Event permits', description: 'Permits, licences, insurance and safety approvals for an event', judges: ['event_permit', 'privacy', 'general'], subjects: ['event', 'venue'] },
  federation_eligibility: { label: 'Federation eligibility', description: 'Who may play: licences, consent and federation conditions', judges: ['federation_eligibility', 'youth_safeguarding', 'general'], subjects: ['person'] },
  accreditation: { label: 'Accreditation', description: 'Training, background checks and consent before a badge is issued', judges: ['accreditation', 'youth_safeguarding', 'general'], subjects: ['person'] },
  youth_safeguarding: { label: 'Youth safeguarding', description: 'Safeguarding duties for people under 18', judges: ['youth_safeguarding', 'general'], subjects: ['person', 'event', 'organisation'] },
  privacy: { label: 'Privacy', description: 'Data-protection duties', judges: ['privacy', 'general'], subjects: ['event', 'organisation'] },
  general: { label: 'General', description: 'Cross-cutting rules read by every domain', judges: ['general'], subjects: ['event', 'person', 'organisation', 'venue', 'tender', 'supplier_entity'] },
};
export const domainsFor = (domain) => DOMAIN_INFO[domain].judges;

export const CLASS_LABEL = {
  legal_mandatory: 'Legal (mandatory)', regulatory: 'Regulatory', federation_mandated: 'Federation mandated', contractual: 'Contractual', organisation_policy: 'Organisation policy', recommended_standard: 'Recommended standard',
};
/** Who may author a class: laws and regulations only the platform team (after review); an organisation its own policy and contracts. Federation rules are authored in the federation console. */
export const SCOPE_CLASSES = { platform: ['legal_mandatory', 'regulatory', 'recommended_standard'], organisation: ['organisation_policy', 'contractual', 'recommended_standard'] };

/** Packs are designed for these first; any ISO country works the same way. */
export const FIRST_JURISDICTIONS = [
  { code: 'IN', name: 'India' }, { code: 'US', name: 'United States' }, { code: 'CA', name: 'Canada' }, { code: 'SG', name: 'Singapore' },
  { code: 'MY', name: 'Malaysia' }, { code: 'LK', name: 'Sri Lanka' }, { code: 'AU', name: 'Australia' }, { code: 'GB', name: 'United Kingdom' },
];

export const catalogue = () => ({
  domains: Object.entries(DOMAIN_INFO).map(([key, d]) => ({ key, label: d.label, description: d.description, subjects: d.subjects })),
  classifications: CLASSIFICATIONS.map((key) => ({ key, label: CLASS_LABEL[key], rank: CLASS_RANK[key], authored_by: key === 'federation_mandated' ? 'federation' : Object.entries(SCOPE_CLASSES).filter(([, v]) => v.includes(key)).map(([k]) => k) })),
  evidence_kinds: EVIDENCE_KINDS, holders: HOLDERS, statuses: STATUSES,
  outcomes: ['applies', 'does_not_apply', 'unknown', 'exception_required'],
  event_types: ['tournament', 'league', 'friendly', 'camp', 'trial'],
  jurisdictions: FIRST_JURISDICTIONS,
  precedence: ['Higher classification wins within a topic', 'Then the narrower jurisdiction (municipality, state or province, country)', 'Then the more specific applicability', 'Then the later effective date, then the higher version', 'Rules of different topics all apply'],
});
