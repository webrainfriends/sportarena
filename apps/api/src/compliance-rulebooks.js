// Standard country rulebooks (#568 follow-up, ported from PR 622 onto the compliance policy layer): a reference catalogue for the eight priority
// countries, written in the portable jurisdiction-pack shape that import_compliance_rules takes. Each rule names the instrument it is anchored to
// and links the regulator's own site. Laws and regulations arrive waiting for a second platform administrator, like any imported law.
//
// This is a research anchor and an applicability checklist, NOT legal advice and NOT a certification: the approval owner on every rule is
// "qualified local counsel", and where a duty varies by state, province or municipality the rule is written for the whole country and is meant to
// be narrowed (by region / municipality on its obligation) when approved. starts_on is the date the platform adopts the rule, not the commencement
// date of the instrument.
import { FIRST_JURISDICTIONS } from './compliance-policy.js';

export const STANDARD_VERSION = '2026.1';
const FROM = '2026-01-01';

/** Per country: what each of the standard topics is anchored to. */
const COUNTRIES = {
  IN: {
    name: 'India', counsel: 'Qualified local counsel, India',
    permit: { cls: 'regulatory', title: 'Police and local-authority permission for a public event', src: 'State police and municipal rules for public gatherings', url: 'https://www.mha.gov.in/', note: 'Varies by state and municipality: narrow the place when approving.' },
    insurance: { src: 'Industry practice; venue and local-authority conditions', url: null },
    child: { cls: 'legal_mandatory', title: 'Child protection: checks for adults working with children', src: 'Protection of Children from Sexual Offences Act, 2012', url: 'https://ncpcr.gov.in/' },
    train: { src: 'Sports body safeguarding and member-protection policies', url: 'https://yas.nic.in/' },
    privacy: { cls: 'legal_mandatory', title: 'Personal data: notice and consent for event data', src: 'Digital Personal Data Protection Act, 2023', url: 'https://www.meity.gov.in/' },
    consent: { src: 'Digital Personal Data Protection Act, 2023 (verifiable parental consent for a child)', url: 'https://www.meity.gov.in/' },
  },
  US: {
    name: 'United States', counsel: 'Qualified local counsel, United States',
    permit: { cls: 'regulatory', title: 'Local special-event permit', src: 'City and county special-event ordinances', url: 'https://www.usa.gov/local-governments', note: 'Set by each city or county: narrow the place when approving.' },
    insurance: { src: 'Venue, municipal and league requirements', url: null },
    child: { cls: 'regulatory', title: 'Youth protection: background screening and reporting', src: 'Protecting Young Victims from Sexual Abuse and Safe Sport Authorization Act of 2017 and state child-protection laws', url: 'https://uscenterforsafesport.org/' },
    train: { src: 'U.S. Center for SafeSport policies and training', url: 'https://uscenterforsafesport.org/' },
    privacy: { cls: 'regulatory', title: 'Personal data: notice for event data and children under 13', src: "Children's Online Privacy Protection Act and state privacy laws", url: 'https://www.ftc.gov/' },
    consent: { src: "Children's Online Privacy Protection Act (parental consent under 13)", url: 'https://www.ftc.gov/' },
  },
  CA: {
    name: 'Canada', counsel: 'Qualified local counsel, Canada',
    permit: { cls: 'regulatory', title: 'Municipal special-event permit', src: 'Municipal special-event by-laws', url: 'https://www.canada.ca/', note: 'Set by each municipality: narrow the place when approving.' },
    insurance: { src: 'Municipal and venue permit conditions', url: null },
    child: { cls: 'regulatory', title: 'Vulnerable-sector screening for people working with children', src: 'Provincial child-protection laws and the Criminal Records Act framework', url: 'https://www.rcmp-grc.gc.ca/' },
    train: { src: 'Universal Code of Conduct to Prevent and Address Maltreatment in Sport', url: 'https://sportintegritycommissioner.ca/' },
    privacy: { cls: 'legal_mandatory', title: 'Personal information: consent and safeguards for event data', src: 'Personal Information Protection and Electronic Documents Act and provincial laws', url: 'https://www.priv.gc.ca/' },
    consent: { src: 'PIPEDA and provincial law (meaningful consent for minors)', url: 'https://www.priv.gc.ca/' },
  },
  SG: {
    name: 'Singapore', counsel: 'Qualified local counsel, Singapore',
    permit: { cls: 'regulatory', title: 'Police permit for a public entertainment or assembly', src: 'Public Order Act 2009 and Public Entertainments and Meetings Act 1958', url: 'https://www.police.gov.sg/', note: 'Apply only where the event falls within the Act: confirm when approving.' },
    insurance: { src: 'Venue operator and agency conditions', url: null },
    child: { cls: 'regulatory', title: 'Screening and conduct for adults working with children', src: 'Children and Young Persons Act 1993 and the Safe Sport Code', url: 'https://www.sportsingapore.gov.sg/' },
    train: { src: 'Safe Sport Code and SportSG safeguarding guidance', url: 'https://www.sportsingapore.gov.sg/' },
    privacy: { cls: 'legal_mandatory', title: 'Personal data: notification and consent for event data', src: 'Personal Data Protection Act 2012', url: 'https://www.pdpc.gov.sg/' },
    consent: { src: 'PDPC guidance on personal data of minors', url: 'https://www.pdpc.gov.sg/' },
  },
  MY: {
    name: 'Malaysia', counsel: 'Qualified local counsel, Malaysia',
    permit: { cls: 'regulatory', title: 'Police and local-authority permit for a public event', src: 'Local authority licensing and police event permits', url: 'https://www.rmp.gov.my/', note: 'Varies by state and local authority: narrow the place when approving.' },
    insurance: { src: 'Local authority and venue conditions', url: null },
    child: { cls: 'legal_mandatory', title: 'Child protection duties for adults working with children', src: 'Child Act 2001', url: 'https://www.jkm.gov.my/' },
    train: { src: 'Sports body safeguarding and member-protection policies', url: 'https://www.kbs.gov.my/' },
    privacy: { cls: 'legal_mandatory', title: 'Personal data: notice and consent for event data', src: 'Personal Data Protection Act 2010', url: 'https://www.pdp.gov.my/' },
    consent: { src: 'Personal Data Protection Act 2010 (guardian consent for a child)', url: 'https://www.pdp.gov.my/' },
  },
  LK: {
    name: 'Sri Lanka', counsel: 'Qualified local counsel, Sri Lanka',
    permit: { cls: 'regulatory', title: 'Police and local-authority permission for a public event', src: 'Police and local-authority requirements for public events', url: 'https://www.police.lk/', note: 'Confirm the authority and narrow the place when approving.' },
    insurance: { src: 'Venue and local-authority conditions', url: null },
    child: { cls: 'legal_mandatory', title: 'Child protection duties for adults working with children', src: 'National Child Protection Authority Act, No. 50 of 1998', url: 'https://www.childprotection.gov.lk/' },
    train: { src: 'Sports body safeguarding and member-protection policies', url: 'https://sports.gov.lk/' },
    privacy: { cls: 'legal_mandatory', title: 'Personal data: notice and consent for event data', src: 'Personal Data Protection Act, No. 9 of 2022', url: 'https://www.parliament.lk/' },
    consent: { src: 'Personal Data Protection Act, No. 9 of 2022 (guardian consent for a child)', url: 'https://www.parliament.lk/' },
  },
  AU: {
    name: 'Australia', counsel: 'Qualified local counsel, Australia',
    permit: { cls: 'regulatory', title: 'Council event approval and permit', src: 'Local council event and public-land permit rules', url: 'https://www.australia.gov.au/', note: 'Set by each council and state: narrow the place when approving.' },
    insurance: { src: 'Council and venue permit conditions', url: null },
    child: { cls: 'legal_mandatory', title: 'Working with Children Check', src: 'State and territory Working with Children laws', url: 'https://www.sportintegrity.gov.au/' },
    train: { src: 'National Integrity Framework and Safeguarding Children in sport guidance', url: 'https://www.sportintegrity.gov.au/' },
    privacy: { cls: 'legal_mandatory', title: 'Personal information: Australian Privacy Principles for event data', src: 'Privacy Act 1988 (Australian Privacy Principles)', url: 'https://www.oaic.gov.au/' },
    consent: { src: 'OAIC guidance on the privacy of children and young people', url: 'https://www.oaic.gov.au/' },
  },
  GB: {
    name: 'United Kingdom', counsel: 'Qualified local counsel, United Kingdom',
    permit: { cls: 'regulatory', title: 'Licensing and safety advisory approval for a public event', src: 'Licensing Act 2003 (where licensable activity is provided) and local Safety Advisory Group process', url: 'https://www.gov.uk/guidance/temporary-event-notices', note: 'England, Scotland, Wales and Northern Ireland differ: narrow the place when approving.' },
    insurance: { src: 'Local authority and venue conditions; Health and Safety at Work etc. Act 1974 risk assessment', url: 'https://www.hse.gov.uk/' },
    child: { cls: 'legal_mandatory', title: 'Enhanced criminal-record check for regulated activity with children', src: 'Safeguarding Vulnerable Groups Act 2006 and the DBS regime (Disclosure Scotland and AccessNI in their nations)', url: 'https://www.gov.uk/government/organisations/disclosure-and-barring-service' },
    train: { src: 'Working Together to Safeguard Children and sport safeguarding standards', url: 'https://thecpsu.org.uk/' },
    privacy: { cls: 'legal_mandatory', title: 'Personal data: privacy notice and lawful basis for event data', src: 'UK GDPR and Data Protection Act 2018', url: 'https://ico.org.uk/' },
    consent: { src: 'UK GDPR Article 8 and the ICO Children\'s code', url: 'https://ico.org.uk/' },
  },
};


const PACK_FORMAT = 'sportarena.compliance-rules/1';
const bare = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/** One rule of the pack. `ob` is its obligation: who it applies to and what it stops. */
const rule = (code, c, slug, v) => bare({
  code: `std_${code.toLowerCase()}_${slug}`, name: v.title, description: v.summary, category: v.category, subject_kind: v.subject, method: v.method, statement: v.statement,
  requires_review: v.method === 'evidence', validity_days: v.validity_days, classification: v.cls, topic: `std.${code.toLowerCase()}.${slug}`,
  source_title: v.src, source_url: v.url, approval_owner: `${c.counsel} (review before approving)`, waivable: v.waivable ?? false,
  obligations: [bare({ country: code, starts_on: FROM, mandatory: v.cls !== 'recommended_standard', consequences: v.stops, youth_work: v.youth_work, max_age: v.max_age })],
});

/** The standard rules of one country (null for a country with no rulebook). */
export function standardRules(code) {
  const c = COUNTRIES[code];
  if (!c) return null;
  return [
    rule(code, c, 'event_permit', { cls: c.permit.cls, title: c.permit.title, src: c.permit.src, url: c.permit.url, summary: `Written for the whole country. ${c.permit.note}`,
      category: 'event_permit', subject: 'event', method: 'evidence', validity_days: 365, stops: ['event_open'] }),
    rule(code, c, 'public_liability', { cls: 'recommended_standard', title: 'Public liability insurance for the event', src: c.insurance.src, url: c.insurance.url,
      summary: 'A recommended standard: advises and never blocks. Make it mandatory for your organisation by writing your own policy rule.', category: 'insurance', subject: 'event', method: 'evidence', validity_days: 365, stops: [], waivable: true }),
    rule(code, c, 'child_protection_checks', { cls: c.child.cls, title: c.child.title, src: c.child.src, url: c.child.url,
      summary: 'Applies to adults whose role can involve contact with children. Confirm the exact check your state or nation requires when approving.',
      category: 'background_check', subject: 'person', method: 'evidence', validity_days: 1095, stops: ['accreditation', 'youth_contact'], youth_work: true }),
    rule(code, c, 'safeguarding_training', { cls: 'recommended_standard', title: 'Safeguarding training for staff and volunteers', src: c.train.src, url: c.train.url,
      summary: 'A recommended standard that most sports bodies require. Make it mandatory for your federation or organisation by writing your own rule.',
      category: 'safeguarding_training', subject: 'person', method: 'evidence', validity_days: 1095, stops: [], youth_work: true, waivable: true }),
    rule(code, c, 'children_consent', { cls: 'recommended_standard', title: 'Guardian consent for children', src: c.consent.src, url: c.consent.url,
      summary: "A recommended standard: a guardian's consent for a child to take part and for their data to be used. Check the age of majority and consent age for your place.",
      category: 'attestation', subject: 'person', method: 'evidence', stops: [], max_age: 17, waivable: true }),
    rule(code, c, 'event_privacy', { cls: c.privacy.cls, title: c.privacy.title, src: c.privacy.src, url: c.privacy.url,
      summary: 'The organiser declares how personal data collected for the event is notified, used and kept.',
      category: 'declaration', subject: 'event', method: 'declaration', statement: 'We have published a privacy notice and declare how personal data collected for this event is used and kept.', stops: ['event_open'] }),
  ];
}

export const standardCountries = () => FIRST_JURISDICTIONS.filter((j) => COUNTRIES[j.code]).map((j) => ({ code: j.code, name: COUNTRIES[j.code].name, version: STANDARD_VERSION, rules: standardRules(j.code).length }));
export const standardPack = (code) => (COUNTRIES[code] ? { format: PACK_FORMAT, version: STANDARD_VERSION, country: code, name: COUNTRIES[code].name, rules: standardRules(code),
  note: 'A standard country rulebook: a research anchor and checklist for people to review, not legal advice and not a certification.' } : null);
