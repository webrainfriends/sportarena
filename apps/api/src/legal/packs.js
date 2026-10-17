// Legal-services jurisdiction packs (issue #231): US, UK, Canada, UAE, India, Singapore, Malaysia, China, Japan, Australia, New Zealand.
// A pack is a RESEARCH ANCHOR and an applicability checklist, not a legal opinion and not a certification. Selecting a country is never
// compliance: regulated workflows (public requests, lawyer responses, private intake, quotes, engagement, matters) stay OFF for a country
// until qualified local counsel has approved that pack (legal_pack_approvals, recorded by the platform team). Informational discovery is
// always on. Nothing here is a seeded record: approvals are real rows written by a real reviewer.
export const PACK_VERSION = 1;

/** Workflows an approval can switch on. Informational search and profiles need no approval. */
export const REGULATED_FEATURES = ['requests', 'responses', 'intake', 'quotes', 'engagement'];

// What is never offered, in any country, until a regulated arrangement is built and reviewed separately (issue #231 sections 4 and 11).
export const NOT_SUPPORTED = ['trust_or_client_money', 'escrow', 'referral_fees', 'percentage_commission_on_legal_fees', 'contingency_fees', 'automatic_court_deadlines', 'ai_legal_advice'];

const CURRENCY = {'US': 'USD', 'GB': 'GBP', 'CA': 'CAD', 'AE': 'AED', 'IN': 'INR', 'SG': 'SGD', 'MY': 'MYR', 'CN': 'CNY', 'JP': 'JPY', 'AU': 'AUD', 'NZ': 'NZD'};
const pack = (code, name, o) => ({ code, name, currency: CURRENCY[code], advertising: 'regulated', ...o });

export const PACKS = {
  US: pack('US', 'United States', {
    instruments: ['HIPAA (role-dependent: covered entity / business associate)', 'State privacy, health and breach laws', 'State bar admission and conduct rules', 'State advertising / referral rules'],
    regulators: ['State bars', 'HHS Office for Civil Rights', 'State attorneys general'],
    sources: ['https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html'],
    open_questions: ['Admission is per state: a lawyer is only listed for the states on their credential.', 'Whether a given legal upload is HIPAA data depends on the platform and lawyer roles.'],
  }),
  GB: pack('GB', 'United Kingdom', {
    instruments: ['UK GDPR', 'Data Protection Act 2018 (as amended)', 'SRA / Bar Standards Board / Law Society of Scotland / Law Society of NI rules'],
    regulators: ['Information Commissioner (ICO)', 'Solicitors Regulation Authority (England & Wales)', 'Law Society of Scotland', 'Law Society of Northern Ireland'],
    sources: ['https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/', 'https://www.sra.org.uk/solicitors/resources/innovate/common-queries-answered/'],
    open_questions: ['England & Wales, Scotland and Northern Ireland are separate legal systems: the credential must name which one.', 'Referral-fee and claims-marketing limits depend on the matter.'],
  }),
  CA: pack('CA', 'Canada', {
    instruments: ['PIPEDA where it applies', 'Provincial private-sector and health privacy laws (incl. Quebec)', 'Law society rules of each province'],
    regulators: ['Office of the Privacy Commissioner', 'Provincial privacy commissioners', 'Provincial law societies'],
    sources: ['https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda_brief/'],
    open_questions: ['PIPEDA alone does not cover every province or matter.', 'Client-money rules are provincial.'],
  }),
  AE: pack('AE', 'United Arab Emirates', {
    instruments: ['Federal Personal Data Protection Law', 'Sector health-data rules', 'DIFC / ADGM data regimes where they apply', 'Advocate and legal-consultant licensing'],
    regulators: ['UAE Data Office', 'DIFC / ADGM commissioners', 'Ministry of Justice and emirate courts'],
    sources: ['https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws'],
    open_questions: ['Storage and transfer of patient or legal documents must be validated before they move.'],
  }),
  IN: pack('IN', 'India', {
    advertising: 'informational_only',
    instruments: ['Digital Personal Data Protection Act and Rules (phased commencement)', 'IT Act and applicable security / sector requirements', 'Advocates Act, Bar Council of India rules, state bar rules'],
    regulators: ['Data Protection Board of India', 'Bar Council of India', 'State bar councils'],
    sources: ['https://www.meity.gov.in/documents/act-and-policies?persona=It-professional', 'https://www.barcouncilofindia.org/info/bci-rules'],
    open_questions: ['Advertising and solicitation restrictions: lawyers are shown as a restricted informational directory; no public-request responses, no promotions, until qualified local review approves a specific activity.'],
  }),
  SG: pack('SG', 'Singapore', {
    instruments: ['Personal Data Protection Act', 'Legal Profession Act and publicity / client-account rules', 'Professional confidentiality'],
    regulators: ['Personal Data Protection Commission', 'Law Society of Singapore', 'Ministry of Law'],
    sources: ['https://www.pdpc.gov.sg/data-protection-obligations'],
    open_questions: ['Overseas transfers need comparable-protection arrangements; consent is not a universal substitute.'],
  }),
  MY: pack('MY', 'Malaysia', {
    instruments: ['Personal Data Protection Act 2010 (as amended)', 'Legal Profession Act and publicity / client-money rules'],
    regulators: ['Personal Data Protection Commissioner', 'Malaysian Bar', 'Sabah / Sarawak law societies'],
    sources: ['https://www.pdp.gov.my/ppdpv1/en/akta/personal-data-protection-amendment-act-2024/'],
    open_questions: ['Peninsular Malaysia, Sabah and Sarawak admit lawyers separately.'],
  }),
  CN: pack('CN', 'China', {
    instruments: ['Personal Information Protection Law', 'Data Security Law', 'Cybersecurity Law', 'Lawyers Law and local bar rules'],
    regulators: ['Cyberspace Administration of China', 'Ministry of Justice and local lawyers associations'],
    sources: ['https://www.cac.gov.cn/2024-03/22/c_1712776611775634.htm'],
    open_questions: ['Mainland deployment, data export and local lawyer authority need specialist review before any regulated workflow.'],
  }),
  JP: pack('JP', 'Japan', {
    instruments: ['Act on the Protection of Personal Information', 'Attorney Act and bar association rules'],
    regulators: ['Personal Information Protection Commission', 'Japan Federation of Bar Associations'],
    sources: ['https://www.ppc.go.jp/en/', 'https://www.japaneselawtranslation.go.jp/en/laws/view/4241/en'],
    open_questions: ['Domestic licensed legal practice and foreign-law services are different permissions.'],
  }),
  AU: pack('AU', 'Australia', {
    instruments: ['Privacy Act 1988 and Australian Privacy Principles', 'Notifiable Data Breaches scheme', 'State / territory legal profession and trust-account rules'],
    regulators: ['OAIC', 'State and territory law societies and regulators'],
    sources: ['https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines'],
    open_questions: ['Do not rely on a small-business exemption for health-related workflows.'],
  }),
  NZ: pack('NZ', 'New Zealand', {
    instruments: ['Privacy Act 2020', 'Health Information Privacy Code 2020 where the health-agency role applies', 'Lawyers and Conveyancers Act rules'],
    regulators: ['Office of the Privacy Commissioner', 'New Zealand Law Society'],
    sources: ['https://www.privacy.org.nz/privacy-principles/', 'https://www.privacy.org.nz/privacy-principles/codes-of-practice/hipc2020/'],
    open_questions: ['Overseas disclosure and indirect-collection notices apply where relevant.'],
  }),
};

export const PACK_CODES = Object.keys(PACKS);

/** The practice areas a lawyer can be listed for and a client can ask for. */
export const PRACTICE_AREAS = {
  sports_contracts: 'Sports contracts', sponsorship: 'Sponsorship & endorsements', team_governance: 'Team & club governance', event_liability: 'Event permits & liability',
  insurance_disputes: 'Insurance disputes', employment: 'Employment', ip_media: 'IP & media rights', safeguarding: 'Safeguarding',
  professional_liability: 'Medical & professional liability', disciplinary: 'Disciplinary & arbitration',
};
export const FEE_MODELS = { flat: 'Flat fee', hourly: 'Hourly', capped: 'Capped hourly', milestone: 'Milestone', retainer: 'Recurring retainer' }; // contingency is deliberately absent
export const DELIVERY_MODES = ['remote', 'in_person'];

/** Pack view with its approval state. `approvals` = latest legal_pack_approvals row per country (or none). */
export function packView(code, approval) {
  const p = PACKS[code];
  const live = approval && approval.status === 'approved' && approval.pack_version === PACK_VERSION;
  return {
    ...p, pack_version: PACK_VERSION,
    approval: approval ? { status: approval.status, features: approval.features, reviewer: approval.reviewer_name, reviewer_firm: approval.reviewer_firm, reviewed_on: approval.reviewed_on, pack_version: approval.pack_version, decided_at: approval.created_at } : null,
    enabled: live ? approval.features : [],
    informational: true, not_supported: NOT_SUPPORTED,
    disclaimer: 'Research anchor, not legal advice or certification. Regulated features are off until qualified local counsel approves this pack.',
  };
}
