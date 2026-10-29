// Standard country rulebooks (#568 follow-up): a reference catalogue for the eight priority countries, written in the same portable shape as any
// jurisdiction pack. Importing one creates DRAFTS only; nothing applies until it is approved (laws and regulations by a second person), and any
// rule can then be tailored as a new version. Each rule names the instrument it is anchored to and links the regulator's own site.
//
// This is a research anchor and an applicability checklist, NOT legal advice and NOT a certification: the approval owner on every rule is
// "qualified local counsel", and where a duty varies by state, province or municipality the rule is written for the whole country and is meant to
// be narrowed when approved. effective_from is the date the platform adopts the rule, not the commencement date of the instrument.
export const STANDARD_VERSION = '2026.1';
const FROM = '2026-01-01';
const CHILD_ROLES = ['official', 'team_staff', 'volunteer', 'medical', 'security'];

/** Per country: what each of the six standard topics is anchored to. `permit`, `child`, `train` and `privacy` name the instrument and the regulator. */
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

const rule = (code, c, slug, domains, topic, v) => ({
  key: `std.${code.toLowerCase()}.${slug}`, domains, topic: `std.${code.toLowerCase()}.${topic}`,
  title: v.title, summary: v.summary, classification: v.cls, country: code, applies: v.applies ?? {}, effective_from: FROM,
  source_title: v.src, ...(v.url ? { source_url: v.url } : {}), pack_code: `STD-${code}-${STANDARD_VERSION}`, approval_owner: `${c.counsel} (review before approving)`,
  requirements: v.requirements ?? [], waivable: v.waivable ?? false, change_note: 'Standard rulebook; review and tailor before approving.',
});

/** The standard rules of one country, in the portable pack shape that import_policy_pack takes. */
export function standardRules(code) {
  const c = COUNTRIES[code];
  if (!c) return null;
  return [
    rule(code, c, 'event-permit', ['event_permit'], 'event-permit', { cls: c.permit.cls, title: c.permit.title, src: c.permit.src, url: c.permit.url, summary: `Written for the whole country. ${c.permit.note}`,
      requirements: [{ key: 'permit', kind: 'permit', label: 'Permit or written permission from the competent authority', holder: 'event', warn_days: 30 }] }),
    rule(code, c, 'public-liability', ['event_permit'], 'liability', { cls: 'recommended_standard', title: 'Public liability insurance for the event', src: c.insurance.src, url: c.insurance.url, summary: 'A recommended standard. Make it stricter where a permit or venue requires it.',
      requirements: [{ key: 'insurance', kind: 'insurance', label: 'Public liability insurance covering the event dates', holder: 'event', warn_days: 45 }], waivable: true }),
    rule(code, c, 'child-protection-checks', ['accreditation', 'youth_safeguarding'], 'child-checks', { cls: c.child.cls, title: c.child.title, src: c.child.src, url: c.child.url, applies: { roles: CHILD_ROLES },
      summary: 'Applies to adults whose role at the event can involve contact with children. Confirm the exact check your state or nation requires when approving.',
      requirements: [{ key: 'check', kind: 'background_check', label: 'Background or vulnerable-sector check, current', holder: 'person', warn_days: 60 }] }),
    rule(code, c, 'safeguarding-training', ['accreditation'], 'safeguarding-training', { cls: 'recommended_standard', title: 'Safeguarding training for staff and volunteers', src: c.train.src, url: c.train.url, applies: { roles: CHILD_ROLES },
      summary: 'A recommended standard that most sports bodies require. Make it mandatory for your federation or organisation by tailoring it.',
      requirements: [{ key: 'training', kind: 'training', label: 'Safeguarding course completed', holder: 'person', max_age_days: 1095 }], waivable: true }),
    rule(code, c, 'children-consent', ['federation_eligibility', 'youth_safeguarding', 'accreditation'], 'children-consent', { cls: 'recommended_standard', title: 'Guardian consent for children', src: c.consent.src, url: c.consent.url, applies: { max_age: 17 },
      summary: 'A recommended standard: a guardian\'s consent for a child to take part and for their data to be used. Check the age of majority and consent age for your place.',
      requirements: [{ key: 'guardian_consent', kind: 'signed_document', label: 'Guardian consent for participation', holder: 'person' }] }),
    rule(code, c, 'event-privacy', ['event_permit', 'privacy'], 'privacy', { cls: c.privacy.cls, title: c.privacy.title, src: c.privacy.src, url: c.privacy.url,
      summary: 'The organiser declares how personal data collected for the event is notified, used and kept.',
      requirements: [{ key: 'privacy', kind: 'declaration', label: 'Privacy notice published and data handling declared', holder: 'event' }] }),
  ];
}

export const standardCountries = () => Object.entries(COUNTRIES).map(([code, c]) => ({ code, name: c.name, version: STANDARD_VERSION, rules: standardRules(code).length }));
export const standardPack = (code) => (COUNTRIES[code] ? { pack_code: `STD-${code}-${STANDARD_VERSION}`, country: code, name: COUNTRIES[code].name, rules: standardRules(code),
  note: 'A standard country rulebook: a research anchor and checklist for people to review, not legal advice and not a certification.' } : null);
