// Health-data regimes for the doctors module: what each country's health-privacy and medical-practice rules ask of a platform that
// handles patient, health and event-coverage data. This is an ENGINEERING BASELINE mapped from public law and professional codes so the
// product can enforce and show the right behaviour per country (notice, consent, cross-border, breach clocks, patient rights, retention).
// It is operator configuration, not legal advice: counsel must confirm each country before real patient data of that country is processed.
// Nothing here ever deletes data (retention figures are minimum floors; the platform keeps health data longer - see docs/health-compliance.md).
//
// Shape of a regime:
//   deadlines  breach-notification clocks: { audience, hours|null, internal_hours, rule } - hours is the legal clock where one is fixed,
//              otherwise null and `internal_hours` is the target the platform holds itself to ("as soon as practicable").
//   respond_days  the platform's target to answer a patient-rights request (never longer than the legal period where one is fixed).
//   localisation  'strict' = health data must stay in the country (a patient can only choose this regime when the deployment is hosted there);
//                 'transfer_notice' = data may be hosted elsewhere if the patient is told and agrees; both are recorded.
export const REGIME_NOTICE_VERSION = 1;

const RIGHTS = ['access', 'portability', 'correction', 'restriction', 'objection', 'erasure', 'accounting', 'withdraw_consent', 'complaint'];

export const REGIMES = {
  US: {
    code: 'US', name: 'United States', flag: '🇺🇸', currency: 'USD',
    laws: ['HIPAA Privacy, Security and Breach Notification Rules (45 CFR 160/164)', 'State health-privacy laws (e.g. California CMIA)', 'FTC Health Breach Notification Rule (consumer health apps)'],
    regulators: ['HHS Office for Civil Rights', 'State attorneys general', 'State medical boards (FSMB)'],
    medical_bodies: ['American Medical Association Code of Medical Ethics (patient privacy and confidentiality, Opinions 3.1.1 and 3.3.x)'],
    data_class: 'Protected health information (PHI)',
    consent_basis: 'Treatment, payment and operations need no extra consent; any other disclosure needs the patient\'s written authorization.',
    minors: { age: 18, note: 'Parents or guardians act for minors; some states let minors consent to specific care.' },
    retention: { years: 10, basis: 'HIPAA documentation 6 years; medical-record retention is set by each state (commonly 6-10 years, minors until majority plus several years).' },
    deadlines: [{ audience: 'individuals', hours: 1440, internal_hours: 1440, rule: 'Without unreasonable delay and within 60 days of discovery' }, { audience: 'regulator', hours: 1440, internal_hours: 1440, rule: '500 or more people: within 60 days to HHS and media; fewer: logged and reported within 60 days of year end' }],
    respond_days: 30, response_rule: 'Access within 30 days; amendment 60 days; accounting of disclosures 60 days',
    localisation: 'transfer_notice', cross_border: 'No general ban; vendors handling PHI need a business-associate agreement and the patient is told where data is processed.',
    telehealth: 'Provider must be licensed in the state where the patient is located.',
    rights: RIGHTS.filter((r) => r !== 'erasure' && r !== 'objection'),
  },
  GB: {
    code: 'GB', name: 'United Kingdom', flag: '🇬🇧', currency: 'GBP',
    laws: ['UK GDPR', 'Data Protection Act 2018', 'Common-law duty of confidentiality; National Data Guardian Caldicott Principles'],
    regulators: ['Information Commissioner\'s Office (ICO)', 'General Medical Council (GMC)', 'Care Quality Commission (CQC)'],
    medical_bodies: ['GMC "Confidentiality: good practice in handling patient information"', 'British Medical Association guidance'],
    data_class: 'Special category data (health), Art. 9(2)(h) UK GDPR',
    consent_basis: 'Care is delivered under Art. 9(2)(h); everything beyond direct care (research, sharing with third parties) needs explicit consent.',
    minors: { age: 16, note: 'Competent children (Gillick) can consent; Scotland presumes capacity from 12.' },
    retention: { years: 8, basis: 'NHS Records Management Code of Practice: adults 8 years after last contact; children until age 25 (26 if 17 at last entry).' },
    deadlines: [{ audience: 'regulator', hours: 72, internal_hours: 72, rule: 'ICO within 72 hours of becoming aware, unless unlikely to risk people\'s rights' }, { audience: 'individuals', hours: null, internal_hours: 168, rule: 'Without undue delay when the risk to them is high' }],
    respond_days: 30, response_rule: 'One calendar month (extendable by two months for complex requests)',
    localisation: 'transfer_notice', cross_border: 'UK GDPR Chapter V: adequacy regulations, International Data Transfer Agreement or UK Addendum.',
    telehealth: 'Provider must hold GMC registration with a licence to practise; services in England are CQC-registered.',
    rights: RIGHTS,
  },
  CA: {
    code: 'CA', name: 'Canada', flag: '🇨🇦', currency: 'CAD',
    laws: ['PIPEDA', 'Provincial health-information laws (Ontario PHIPA, Alberta HIA, Manitoba PHIA, Saskatchewan HIPA…)', 'Quebec Law 25'],
    regulators: ['Office of the Privacy Commissioner of Canada', 'Provincial privacy commissioners', 'Provincial Colleges of Physicians and Surgeons'],
    medical_bodies: ['Canadian Medical Association Code of Ethics and Professionalism', 'Canadian Medical Protective Association (CMPA) records guidance'],
    data_class: 'Personal health information (PHI)',
    consent_basis: 'Knowledgeable, express consent for sharing outside the circle of care; implied consent inside it where the province allows.',
    minors: { age: 18, note: 'Age of majority differs by province (18 or 19); mature minors may consent to their own care.' },
    retention: { years: 10, basis: 'CMPA: 10 years from the last entry; minors 10 years from the age of majority (provincial rules vary).' },
    deadlines: [{ audience: 'regulator', hours: null, internal_hours: 72, rule: 'As soon as feasible when there is a real risk of significant harm; breach records kept 24 months' }, { audience: 'individuals', hours: null, internal_hours: 72, rule: 'As soon as feasible when there is a real risk of significant harm' }],
    respond_days: 30, response_rule: '30 days (PIPEDA); provincial laws may be shorter',
    localisation: 'transfer_notice', cross_border: 'The organisation stays accountable for data processed abroad; people are told it may be accessed under foreign law (Quebec requires a privacy impact assessment).',
    telehealth: 'Provider must be licensed in the province where the patient is located.',
    rights: RIGHTS.filter((r) => r !== 'portability' && r !== 'objection'),
  },
  AE: {
    code: 'AE', name: 'United Arab Emirates', flag: '🇦🇪', currency: 'AED',
    laws: ['Federal Law No. 2 of 2019 on the use of ICT in health fields', 'Federal Decree-Law No. 45 of 2021 (PDPL)', 'DHA / DOH health-data policies; DIFC and ADGM have their own data-protection laws'],
    regulators: ['Ministry of Health and Prevention (MOHAP)', 'Dubai Health Authority (DHA)', 'Department of Health Abu Dhabi (DOH)', 'UAE Data Office'],
    medical_bodies: ['Emirates Medical Association', 'Federal Decree-Law No. 4 of 2016 on medical liability (confidentiality duty)'],
    data_class: 'Health information (restricted)',
    consent_basis: 'Health data may be used only for the health purposes it was collected for; other uses need the patient\'s consent.',
    minors: { age: 18, note: 'A guardian consents for minors.' },
    retention: { years: 25, basis: 'ICT Health Law: at least 25 years from the date of the last health procedure.' },
    deadlines: [{ audience: 'regulator', hours: null, internal_hours: 24, rule: 'Report promptly to the health authority and UAE Data Office' }, { audience: 'individuals', hours: null, internal_hours: 72, rule: 'Without delay where the breach could harm them' }],
    respond_days: 30, response_rule: 'Platform target 30 days',
    localisation: 'strict', cross_border: 'Health data may not be stored or transferred outside the UAE except in cases listed by ministerial decision.',
    telehealth: 'Provider must be licensed by the emirate\'s health authority and the platform\'s service by the regulator.',
    rights: RIGHTS,
  },
  IN: {
    code: 'IN', name: 'India', flag: '🇮🇳', currency: 'INR',
    laws: ['Digital Personal Data Protection Act 2023 and Rules', 'IT Act 2000 / SPDI Rules 2011 (health data as sensitive data until superseded)', 'Telemedicine Practice Guidelines 2020', 'ABDM Health Data Management Policy'],
    regulators: ['Data Protection Board of India', 'National Medical Commission (NMC)', 'State Medical Councils'],
    medical_bodies: ['NMC Registered Medical Practitioner (Professional Conduct) Regulations', 'Indian Medical Association code of ethics'],
    data_class: 'Digital personal data (health: sensitive personal data)',
    consent_basis: 'Free, specific, informed, unambiguous consent with a notice in plain language; withdrawal as easy as giving it.',
    minors: { age: 18, note: 'Verifiable parental consent for anyone under 18.' },
    retention: { years: 3, basis: 'NMC/IMC regulations: at least 3 years for outpatient records; longer for medico-legal cases.' },
    deadlines: [{ audience: 'regulator', hours: 72, internal_hours: 72, rule: 'Intimate the Board without delay; detailed report within 72 hours' }, { audience: 'individuals', hours: null, internal_hours: 72, rule: 'Each affected person, without delay' }],
    respond_days: 30, response_rule: 'Platform target 30 days (the Rules say a reasonable period)',
    localisation: 'transfer_notice', cross_border: 'Allowed except to countries the Central Government restricts; sector rules can be stricter.',
    telehealth: 'Provider must be a Registered Medical Practitioner on the NMC / State Medical Register.',
    rights: RIGHTS.filter((r) => r !== 'portability' && r !== 'accounting'),
  },
  SG: {
    code: 'SG', name: 'Singapore', flag: '🇸🇬', currency: 'SGD',
    laws: ['Personal Data Protection Act 2012', 'Healthcare Services Act 2020 and Regulations', 'MOH Licensing Terms and Conditions (telemedicine, records)'],
    regulators: ['Personal Data Protection Commission (PDPC)', 'Ministry of Health (MOH)', 'Singapore Medical Council (SMC)'],
    medical_bodies: ['SMC Ethical Code and Ethical Guidelines', 'Singapore Medical Association'],
    data_class: 'Personal data (health: higher-risk, sensitive in practice)',
    consent_basis: 'Consent with notification of purpose; deemed consent only in narrow cases.',
    minors: { age: 18, note: 'PDPC guidance: from about 13 a young person can generally give consent themselves.' },
    retention: { years: 6, basis: 'Healthcare Services Act: records kept for at least 6 years from the last visit.' },
    deadlines: [{ audience: 'regulator', hours: 72, internal_hours: 72, rule: 'PDPC within 3 calendar days of deciding the breach is notifiable (assessment within 30 days)' }, { audience: 'individuals', hours: null, internal_hours: 72, rule: 'As soon as practicable where significant harm is likely' }],
    respond_days: 30, response_rule: 'Access within 30 days',
    localisation: 'transfer_notice', cross_border: 'Transfer Limitation Obligation (s.26): the recipient must give a comparable standard of protection.',
    telehealth: 'Provider must be registered with the SMC and the service licensed under the Healthcare Services Act.',
    rights: RIGHTS.filter((r) => r !== 'erasure' && r !== 'objection' && r !== 'accounting'),
  },
  MY: {
    code: 'MY', name: 'Malaysia', flag: '🇲🇾', currency: 'MYR',
    laws: ['Personal Data Protection Act 2010 (as amended 2024)', 'Private Healthcare Facilities and Services Act 1998', 'Medical Act 1971'],
    regulators: ['Personal Data Protection Commissioner', 'Ministry of Health Malaysia', 'Malaysian Medical Council (MMC)'],
    medical_bodies: ['MMC Code of Professional Conduct', 'Malaysian Medical Association'],
    data_class: 'Sensitive personal data (physical or mental health)',
    consent_basis: 'Explicit consent for sensitive data, except where needed for medical purposes by a healthcare professional bound by confidentiality.',
    minors: { age: 18, note: 'A parent or guardian consents for a minor.' },
    retention: { years: 7, basis: 'Private healthcare facilities regulations: records kept at least 7 years from the last treatment.' },
    deadlines: [{ audience: 'regulator', hours: 72, internal_hours: 72, rule: 'Commissioner as soon as practicable and within 72 hours of the breach being known' }, { audience: 'individuals', hours: 168, internal_hours: 168, rule: 'Within 7 days after notifying the Commissioner where significant harm is likely' }],
    respond_days: 21, response_rule: 'Access and correction requests within 21 days',
    localisation: 'transfer_notice', cross_border: 'PDPA s.129 as amended: transfer only where comparable protection exists, with consent, or by contract.',
    telehealth: 'Provider must be fully registered with the MMC with a practising certificate; the Telemedicine Act 1997 is not yet in force.',
    rights: RIGHTS.filter((r) => r !== 'portability' && r !== 'accounting' && r !== 'erasure'),
  },
  CN: {
    code: 'CN', name: 'China (mainland)', flag: '🇨🇳', currency: 'CNY',
    laws: ['Personal Information Protection Law (PIPL)', 'Data Security Law', 'Cybersecurity Law', 'Measures for the Administration of Medical Records of Medical Institutions (2013)', 'Measures for Internet-based Diagnosis and Treatment (2022)'],
    regulators: ['Cyberspace Administration of China (CAC)', 'National Health Commission (NHC)'],
    medical_bodies: ['Chinese Medical Association', 'Chinese Medical Doctor Association (Doctors Law duties of confidentiality)'],
    data_class: 'Sensitive personal information (medical health)',
    consent_basis: 'Separate, specific consent for sensitive information, with the necessity and impact explained; a personal information protection impact assessment is required.',
    minors: { age: 18, note: 'Under 14: personal information of a minor is sensitive and needs the guardian\'s consent.' },
    retention: { years: 15, basis: 'Medical records measures: outpatient records at least 15 years, inpatient at least 30 years.' },
    deadlines: [{ audience: 'regulator', hours: null, internal_hours: 24, rule: 'Immediately notify the competent department; major incidents have shorter statutory reporting windows' }, { audience: 'individuals', hours: null, internal_hours: 72, rule: 'Immediately, unless measures prevent harm' }],
    respond_days: 15, response_rule: 'Platform target 15 days; reply promptly and give reasons for any refusal',
    localisation: 'strict', cross_border: 'Health data stays in mainland China; leaving needs a CAC security assessment, standard contract or certification, plus the patient\'s separate consent.',
    telehealth: 'Only licensed medical institutions and doctors registered in mainland China may diagnose and treat online.',
    rights: RIGHTS,
  },
  JP: {
    code: 'JP', name: 'Japan', flag: '🇯🇵', currency: 'JPY',
    laws: ['Act on the Protection of Personal Information (APPI)', 'Medical Care Act and Medical Practitioners Act (Art. 24 clinical records)', 'MHLW Guidelines for the Safety Management of Medical Information Systems', 'Act on Promotion of Next-Generation Medical Infrastructure'],
    regulators: ['Personal Information Protection Commission (PPC)', 'Ministry of Health, Labour and Welfare (MHLW)'],
    medical_bodies: ['Japan Medical Association (Medical Ethics guidance)'],
    data_class: 'Special care-required personal information (medical history, diagnoses)',
    consent_basis: 'Prior opt-in consent to acquire special care-required information; third-party provision needs consent.',
    minors: { age: 18, note: 'PPC guidance: for children about 12-15 or younger a legal representative\'s consent is expected.' },
    retention: { years: 5, basis: 'Medical Practitioners Act: clinical records kept 5 years (insured-care records 3-5 years).' },
    deadlines: [{ audience: 'regulator', hours: 120, internal_hours: 72, rule: 'PPC preliminary report promptly (about 3-5 days); final report within 30 days (60 if unauthorised access)' }, { audience: 'individuals', hours: null, internal_hours: 168, rule: 'Promptly, with what happened and what they should do' }],
    respond_days: 30, response_rule: 'Disclosure without delay; platform target 30 days',
    localisation: 'transfer_notice', cross_border: 'Art. 28: consent that names the destination country and its data-protection regime, or equivalent safeguards.',
    telehealth: 'Online medical care is given by physicians licensed in Japan under MHLW online-care guidelines.',
    rights: RIGHTS.filter((r) => r !== 'portability' && r !== 'accounting'),
  },
  AU: {
    code: 'AU', name: 'Australia', flag: '🇦🇺', currency: 'AUD',
    laws: ['Privacy Act 1988 (Australian Privacy Principles; Notifiable Data Breaches scheme)', 'My Health Records Act 2012', 'State health-records laws (NSW HRIP Act, Victoria Health Records Act, ACT)', 'Health Practitioner Regulation National Law'],
    regulators: ['Office of the Australian Information Commissioner (OAIC)', 'Australian Health Practitioner Regulation Agency (AHPRA)', 'Medical Board of Australia'],
    medical_bodies: ['Medical Board "Good medical practice: a code of conduct for doctors in Australia"', 'AMA Code of Ethics'],
    data_class: 'Health information (sensitive information)',
    consent_basis: 'Consent for collecting and sharing health information, except where the law or direct care allows it.',
    minors: { age: 18, note: 'Mature minors can consent when they understand the care (Gillick competence).' },
    retention: { years: 7, basis: 'Victoria and NSW: adults 7 years from the last service; children until age 25.' },
    deadlines: [{ audience: 'regulator', hours: null, internal_hours: 72, rule: 'OAIC as soon as practicable once an eligible data breach is confirmed (assessment within 30 days)' }, { audience: 'individuals', hours: null, internal_hours: 72, rule: 'As soon as practicable once an eligible data breach is confirmed' }],
    respond_days: 30, response_rule: 'Access within 30 days',
    localisation: 'transfer_notice', cross_border: 'APP 8: the organisation remains accountable; the recipient must protect the data to a comparable standard, or the person consents.',
    telehealth: 'Provider must be registered with AHPRA; My Health Record data is not to be held outside Australia.',
    rights: RIGHTS.filter((r) => r !== 'portability' && r !== 'objection' && r !== 'accounting'),
  },
  NZ: {
    code: 'NZ', name: 'New Zealand', flag: '🇳🇿', currency: 'NZD',
    laws: ['Privacy Act 2020', 'Health Information Privacy Code 2020', 'Health (Retention of Health Information) Regulations 1996', 'Code of Health and Disability Services Consumers\' Rights'],
    regulators: ['Office of the Privacy Commissioner', 'Health and Disability Commissioner', 'Medical Council of New Zealand'],
    medical_bodies: ['Medical Council of New Zealand statements on confidentiality', 'New Zealand Medical Association Code of Ethics'],
    data_class: 'Health information (Health Information Privacy Code)',
    consent_basis: 'Collect directly from the person; disclosure for care is allowed, other disclosure needs their authorisation.',
    minors: { age: 16, note: 'People of 16 consent for themselves; younger children can where they understand.' },
    retention: { years: 10, basis: 'Retention Regulations: 10 years from the last time care was provided.' },
    deadlines: [{ audience: 'regulator', hours: 72, internal_hours: 72, rule: 'Privacy Commissioner as soon as practicable (the Commissioner expects within 72 hours) for a serious-harm breach' }, { audience: 'individuals', hours: null, internal_hours: 72, rule: 'As soon as practicable for a serious-harm breach' }],
    respond_days: 28, response_rule: '20 working days (about 28 calendar days)',
    localisation: 'transfer_notice', cross_border: 'IPP 12: disclose abroad only to a recipient with comparable safeguards, or with the person\'s authorisation after being told the risks.',
    telehealth: 'Provider must hold a current MCNZ registration and practising certificate.',
    rights: RIGHTS.filter((r) => r !== 'portability' && r !== 'erasure' && r !== 'objection' && r !== 'accounting'),
  },
};

export const REGIME_CODES = Object.keys(REGIMES);
export const REQUEST_KINDS = { // patient rights, in plain words
  access: 'See everything held about me', portability: 'Get a copy I can take elsewhere', correction: 'Correct something', restriction: 'Limit how my data is used or shared',
  objection: 'Object to a use', erasure: 'Delete my data', accounting: 'See who accessed or received my data', withdraw_consent: 'Withdraw a consent', complaint: 'Raise a privacy complaint',
};
export const BREACH_AUDIENCES = ['regulator', 'individuals'];

const ALIASES = { UK: 'GB', 'UNITED KINGDOM': 'GB', BRITAIN: 'GB', ENGLAND: 'GB', SCOTLAND: 'GB', WALES: 'GB', USA: 'US', 'UNITED STATES': 'US', AMERICA: 'US', CANADA: 'CA', UAE: 'AE', 'UNITED ARAB EMIRATES': 'AE', DUBAI: 'AE', INDIA: 'IN', SINGAPORE: 'SG', MALAYSIA: 'MY', CHINA: 'CN', PRC: 'CN', JAPAN: 'JP', AUSTRALIA: 'AU', 'NEW ZEALAND': 'NZ', NZL: 'NZ', AUS: 'AU', IND: 'IN', SGP: 'SG', MYS: 'MY', CHN: 'CN', JPN: 'JP', ARE: 'AE', CAN: 'CA', GBR: 'GB' };
/** Map a free-text jurisdiction ("in", "India", "UK", "AU-NSW") to a regime code, or null when it is not one of the supported countries. */
export function regimeOf(text) {
  if (!text) return null;
  const t = String(text).trim().toUpperCase();
  if (REGIMES[t]) return t;
  if (ALIASES[t]) return ALIASES[t];
  const head = t.split(/[\s,/_-]/)[0];
  return REGIMES[head] ? head : ALIASES[head] ?? null;
}

/** The public view of a regime (everything above is public law, so nothing is hidden). */
export const regimeView = (code) => {
  const r = REGIMES[code];
  return r ? { ...r, request_kinds: r.rights.map((k) => ({ kind: k, label: REQUEST_KINDS[k] })), notice_version: REGIME_NOTICE_VERSION, disclaimer: DISCLAIMER } : null;
};
export const DISCLAIMER = 'A summary of public rules so the platform can behave correctly in each country. It is not legal advice; the operator confirms it with counsel before handling real patient data.';

const HOSTING_BY_KMS_REGION = { 'ap-southeast-1': 'SG', 'ap-southeast-2': 'AU', 'ap-northeast-1': 'JP', 'ap-south-1': 'IN', 'me-central-1': 'AE', 'ca-central-1': 'CA', 'eu-west-2': 'GB', 'us-east-1': 'US', 'us-east-2': 'US', 'us-west-2': 'US', 'ap-southeast-5': 'MY', 'cn-north-1': 'CN', 'cn-northwest-1': 'CN' };
/** Regime codes the deployment is physically hosted in: HEALTH_HOSTING_REGIONS (comma list) wins, else guessed from the KMS region. */
export function hostingRegimes({ env = process.env, kmsRegion } = {}) {
  const set = (env.HEALTH_HOSTING_REGIONS ?? '').split(',').map((s) => regimeOf(s)).filter(Boolean);
  return set.length ? [...new Set(set)] : [HOSTING_BY_KMS_REGION[kmsRegion]].filter(Boolean);
}

/** Due times for a breach discovered at `at` under each affected regime: [{regime, audience, due_at|null, target_at, rule, legal}] (target_at always set). */
export function breachClocks(regimes, at) {
  const t = new Date(at).getTime();
  return regimes.flatMap((code) => (REGIMES[code]?.deadlines ?? []).map((d) => ({
    regime: code, audience: d.audience, rule: d.rule, legal: d.hours != null,
    due_at: d.hours != null ? new Date(t + d.hours * 36e5).toISOString() : null,
    target_at: new Date(t + Math.min(d.hours ?? Infinity, d.internal_hours) * 36e5).toISOString(),
  })));
}
