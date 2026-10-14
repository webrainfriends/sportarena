// Health-data regimes: what each supported country expects of a platform that handles patient, health and event-coverage data.
// This is operator REFERENCE CONFIGURATION, not legal advice and not a compliance certificate: the numbers drive due dates and warnings
// in the app, every entry carries `reviewed_on`, and an operator's counsel must confirm them (and any state/province/emirate rules)
// before relying on them. Where a rule is not a fixed number we say so (null + a plain-language note) rather than guess.
// Binding rules come from statutes and their regulators; professional associations (AMA, BMA, ...) issue ethics codes that sit on top.
// Bump REGIME_VERSION whenever an entry changes: people who accepted an earlier notice are asked to read the new one.

export const REGIME_VERSION = 1;
export const REGIMES_REVIEWED_ON = '2026-10-14';

/** How personal health data may leave the country: open | safeguards (contract/adequacy/consent needed) | restricted (state assessment) | localised (stays in-country by default). */
export const TRANSFER_MODES = ['open', 'safeguards', 'restricted', 'localised'];

// access_days.statutory=false means the law gives no fixed number and the platform's own commitment (30 days) is used.
// breach.first_hours is the first clock that matters to an operator (null = "as soon as practicable", no fixed hours).
export const REGIMES = {
  US: {
    code: 'US', name: 'United States', flag: '🇺🇸',
    laws: ['HIPAA Privacy, Security and Breach Notification Rules', 'HITECH Act', 'State health-privacy laws (e.g. CMIA, Washington My Health My Data Act)', '42 CFR Part 2 (substance-use records)'],
    regulator: 'HHS Office for Civil Rights (plus state attorneys general)',
    medical_bodies: ['State medical boards', 'American Medical Association (ethics code)'],
    physio_bodies: ['State physical-therapy boards', 'American Physical Therapy Association'],
    roles: 'Providers are covered entities; the platform acts as a business associate and needs a signed BAA with each practice.',
    consent: { explicit: true, note: 'Authorisation is needed beyond treatment, payment and operations; minimum-necessary applies to every disclosure.' },
    access_days: { days: 30, statutory: true, label: '30 days (one 30-day extension with notice)' },
    breach: { first_hours: 1440, regulator: 'HHS within 60 days (at once for 500+ people); individuals within 60 days', note: 'Media notice also required for 500+ people in a state.' },
    retention: { adult_years: 6, minor_until_age: null, note: 'HIPAA documentation is kept 6 years; medical-record retention is set by each state (often 7-10 years and, for children, to majority plus several years).' },
    transfer: { mode: 'open', note: 'No general localisation rule; offshore storage needs the same safeguards and a BAA.' },
    telehealth: 'The clinician must be licensed in the state where the patient is located.',
    minors: 'Parents/guardians act for minors; state law decides which services a minor may consent to.',
  },
  GB: {
    code: 'GB', name: 'United Kingdom', flag: '🇬🇧',
    laws: ['UK GDPR', 'Data Protection Act 2018', 'Common-law duty of confidentiality and Caldicott principles', 'Health and Social Care Act 2008 (CQC registration)'],
    regulator: 'Information Commissioner’s Office (ICO)',
    medical_bodies: ['General Medical Council', 'British Medical Association (ethics guidance)'],
    physio_bodies: ['Health and Care Professions Council', 'Chartered Society of Physiotherapy'],
    roles: 'The practice is the controller; the platform is a processor and needs a written processing agreement.',
    consent: { explicit: true, note: 'Health data is special-category: a lawful basis and an Article 9 condition are both needed; explicit consent is used for optional sharing.' },
    access_days: { days: 30, statutory: true, label: 'One month (extendable by two months for complex requests)' },
    breach: { first_hours: 72, regulator: 'ICO within 72 hours of becoming aware; individuals without undue delay if high risk', note: 'NHS-connected services also report through the DSP Toolkit.' },
    retention: { adult_years: 8, minor_until_age: 25, note: 'NHS Records Management Code: 8 years after last contact for adults; children until their 25th birthday (26th if 17 at last entry).' },
    transfer: { mode: 'safeguards', note: 'Transfers need an adequacy regulation, the IDTA/UK addendum or another Article 46 safeguard.' },
    telehealth: 'Remote care across borders must meet the rules of the patient’s country and the clinician’s registration.',
    minors: 'Under-16s may consent if competent (Gillick); otherwise a parent decides.',
  },
  CA: {
    code: 'CA', name: 'Canada', flag: '🇨🇦',
    laws: ['PIPEDA (federal)', 'Provincial health-information laws (e.g. PHIPA Ontario, HIA Alberta, Quebec Law 25)'],
    regulator: 'Office of the Privacy Commissioner of Canada and the provincial commissioner',
    medical_bodies: ['Provincial colleges of physicians and surgeons', 'Canadian Medical Association (code of ethics)'],
    physio_bodies: ['Provincial physiotherapy colleges (e.g. College of Physiotherapists of Ontario)', 'Canadian Physiotherapy Association'],
    roles: 'The practice is the custodian/trustee; the platform is its agent or service provider.',
    consent: { explicit: true, note: 'Knowledgeable consent is needed; Quebec requires express consent for sensitive data.' },
    access_days: { days: 30, statutory: true, label: '30 days (provincial laws may differ)' },
    breach: { first_hours: null, regulator: 'Report to the privacy commissioner and affected people as soon as feasible when there is a real risk of significant harm', note: 'Keep a breach record for 24 months (PIPEDA).' },
    retention: { adult_years: 10, minor_until_age: 28, note: 'Example: Ontario keeps records 10 years after the last entry, or 10 years after a child turns 18. Some provinces require longer.' },
    transfer: { mode: 'safeguards', note: 'Cross-border processing must be disclosed and comparably protected; some provinces and public bodies restrict storage outside Canada.' },
    telehealth: 'The clinician must be registered in the province where the patient is.',
    minors: 'Capacity rather than a fixed age governs consent in most provinces (Quebec: 14).',
  },
  AE: {
    code: 'AE', name: 'United Arab Emirates', flag: '🇦🇪',
    laws: ['Federal Law No. 2 of 2019 on ICT in Health Fields', 'Federal Decree-Law No. 45 of 2021 (PDPL)', 'Emirate health authority rules (DHA, DoH Abu Dhabi, MOHAP)'],
    regulator: 'Ministry of Health and Prevention and the emirate health authority',
    medical_bodies: ['MOHAP / DHA / DoH licensing', 'Emirates Medical Association'],
    physio_bodies: ['DHA / DoH / MOHAP professional licensing'],
    roles: 'The licensed facility is responsible for patient data; the platform is its processor.',
    consent: { explicit: true, note: 'Patient consent is needed for use outside care; health data may be used only for the permitted purposes in the ICT Health Law.' },
    access_days: { days: 30, statutory: false, label: '30 days (platform commitment)' },
    breach: { first_hours: null, regulator: 'Notify the health authority and the UAE Data Office promptly', note: 'Follow the emirate authority’s incident procedure.' },
    retention: { adult_years: 25, minor_until_age: null, note: 'Health information is kept at least 25 years from the last procedure.' },
    transfer: { mode: 'localised', note: 'Health data may not be stored or moved outside the UAE except in cases the Ministry permits (Ministerial Decision No. 51 of 2021).' },
    telehealth: 'Telehealth requires a licence from the authority in the emirate where the patient is.',
    minors: 'A parent or guardian consents for under-18s.',
  },
  IN: {
    code: 'IN', name: 'India', flag: '🇮🇳',
    laws: ['Digital Personal Data Protection Act 2023 and DPDP Rules', 'Telemedicine Practice Guidelines 2020 (NMC)', 'ABDM Health Data Management Policy', 'Clinical Establishments Act 2010', 'NCAHP Act 2021 (allied health)'],
    regulator: 'Data Protection Board of India',
    medical_bodies: ['National Medical Commission', 'Indian Medical Association (ethics)'],
    physio_bodies: ['National Commission for Allied and Healthcare Professions', 'Indian Association of Physiotherapists'],
    roles: 'The practice (or platform operator) is the data fiduciary; processors act under a contract.',
    consent: { explicit: true, note: 'Free, specific, informed, unambiguous consent with a notice in plain language; withdrawal must be as easy as giving it.' },
    access_days: { days: 30, statutory: false, label: '30 days (grievances must be answered within the Rules’ outer limit)' },
    breach: { first_hours: 72, regulator: 'Inform the Board and each affected person without delay; detailed report to the Board within 72 hours', note: 'Penalties are per breach of safeguards.' },
    retention: { adult_years: 3, minor_until_age: null, note: 'The NMC code asks doctors to keep outpatient records 3 years; hospitals and state rules are often longer.' },
    transfer: { mode: 'safeguards', note: 'Transfers are allowed except to countries the Government restricts; sectoral rules may be stricter.' },
    telehealth: 'Registered practitioners may consult remotely under the NMC guidelines.',
    minors: 'Verifiable parental consent for under-18s; no tracking or targeted ads aimed at children.',
  },
  SG: {
    code: 'SG', name: 'Singapore', flag: '🇸🇬',
    laws: ['Personal Data Protection Act 2012', 'Healthcare Services Act 2020', 'MOH Licensing Terms and Conditions and Telemedicine guidelines'],
    regulator: 'Personal Data Protection Commission (PDPC) and Ministry of Health',
    medical_bodies: ['Singapore Medical Council', 'Singapore Medical Association (ethics)'],
    physio_bodies: ['Allied Health Professions Council'],
    roles: 'The licensee is responsible for records; the platform is a data intermediary.',
    consent: { explicit: true, note: 'Consent and notification; deemed consent only for clear, obvious purposes.' },
    access_days: { days: 30, statutory: true, label: '30 days' },
    breach: { first_hours: 72, regulator: 'PDPC within 3 calendar days once a breach is assessed as notifiable (assessment within 30 days); affected people at the same time if significant harm', note: 'Notifiable: significant harm or 500+ people.' },
    retention: { adult_years: 6, minor_until_age: null, note: 'MOH guidance is at least 6 years from the last treatment; check licence conditions for children and special services.' },
    transfer: { mode: 'safeguards', note: 'Transfer Limitation Obligation: comparable protection by contract or binding rules.' },
    telehealth: 'Remote care needs a licensed provider; overseas clinicians are limited.',
    minors: 'Under-13s need a parent; 13-17 are assessed for understanding.',
  },
  MY: {
    code: 'MY', name: 'Malaysia', flag: '🇲🇾',
    laws: ['Personal Data Protection Act 2010 (as amended 2024)', 'Private Healthcare Facilities and Services Act 1998', 'Medical Act 1971 and Malaysian Medical Council guidelines', 'Allied Health Professions Act 2016'],
    regulator: 'Personal Data Protection Commissioner and the Ministry of Health',
    medical_bodies: ['Malaysian Medical Council', 'Malaysian Medical Association (ethics)'],
    physio_bodies: ['Malaysian Allied Health Professions Council', 'Malaysian Physiotherapy Association'],
    roles: 'The facility is the data user; the platform is a data processor and must keep security safeguards.',
    consent: { explicit: true, note: 'Explicit consent for sensitive personal data, which includes physical or mental health.' },
    access_days: { days: 21, statutory: true, label: '21 days' },
    breach: { first_hours: 72, regulator: 'Commissioner within 72 hours of a notifiable breach; affected people within 7 days after', note: 'Mandatory since 1 June 2025.' },
    retention: { adult_years: 7, minor_until_age: null, note: 'Commonly 7 years for private facilities; check licence conditions.' },
    transfer: { mode: 'safeguards', note: 'Transfers need comparable protection, consent or another listed basis.' },
    telehealth: 'Remote care by a registered practitioner; clinics must be licensed.',
    minors: 'A parent or guardian consents for under-18s.',
  },
  CN: {
    code: 'CN', name: 'China (mainland)', flag: '🇨🇳',
    laws: ['Personal Information Protection Law (PIPL)', 'Data Security Law', 'Cybersecurity Law', 'Measures for the Administration of Medical Records of Medical Institutions', 'Regulation on Human Genetic Resources'],
    regulator: 'Cyberspace Administration of China and the National Health Commission',
    medical_bodies: ['National Health Commission', 'Chinese Medical Association (ethics)'],
    physio_bodies: ['National Health Commission and provincial health commissions'],
    roles: 'The medical institution is the handler; the platform is an entrusted party and a local representative may be required.',
    consent: { explicit: true, note: 'Medical and health data is sensitive: separate consent, a necessity test and an impact assessment are required. Under-14s need guardian consent.' },
    access_days: { days: 30, statutory: false, label: '30 days (the law says "promptly"; platform commitment)' },
    breach: { first_hours: null, regulator: 'Take remedial steps at once and notify the authority and affected people', note: 'Notice must say what, why, harm and steps taken.' },
    retention: { adult_years: 15, minor_until_age: null, note: 'Outpatient records at least 15 years and inpatient records 30 years under the medical-records measures.' },
    transfer: { mode: 'restricted', note: 'Sending data abroad needs a CAC security assessment, standard contract or certification plus separate consent; important or large-volume data stays in China.' },
    telehealth: 'Internet hospitals and remote care need a licensed medical institution.',
    minors: 'Under-14s are treated as sensitive: parental consent and special rules.',
  },
  JP: {
    code: 'JP', name: 'Japan', flag: '🇯🇵',
    laws: ['Act on the Protection of Personal Information (APPI)', 'Medical Care Act', 'MHLW Safety Management Guidelines for Medical Information Systems', 'Act on Physical Therapists and Occupational Therapists'],
    regulator: 'Personal Information Protection Commission (PPC) and the Ministry of Health, Labour and Welfare',
    medical_bodies: ['Ministry of Health, Labour and Welfare', 'Japan Medical Association (ethics)'],
    physio_bodies: ['Ministry of Health, Labour and Welfare (national licence)', 'Japanese Physical Therapy Association'],
    roles: 'The medical institution is the business operator; entrusted processors are supervised by it.',
    consent: { explicit: true, note: 'Medical history is "special care-required" information: acquire it only with consent; opt-out sharing is not allowed.' },
    access_days: { days: 30, statutory: false, label: 'Without delay (platform commitment: 30 days)' },
    breach: { first_hours: 120, regulator: 'PPC promptly (a preliminary report within about 3-5 days) and a final report within 30 days (60 if malicious); notify affected people promptly', note: 'Mandatory for sensitive data leaks regardless of count.' },
    retention: { adult_years: 5, minor_until_age: null, note: 'Physicians keep medical records 5 years from the end of treatment; check facility rules.' },
    transfer: { mode: 'safeguards', note: 'Overseas transfer needs consent with information about the destination, or an equivalent-protection arrangement.' },
    telehealth: 'Online treatment follows MHLW guidelines; the physician must be licensed in Japan.',
    minors: 'No fixed age in the Act; guidance treats roughly under-12 to 15 as needing a guardian.',
  },
  AU: {
    code: 'AU', name: 'Australia', flag: '🇦🇺',
    laws: ['Privacy Act 1988 and the Australian Privacy Principles', 'Notifiable Data Breaches scheme', 'My Health Records Act 2012', 'State health-records laws (e.g. Vic Health Records Act 2001, NSW HRIP Act 2002)'],
    regulator: 'Office of the Australian Information Commissioner (OAIC) and state health complaints bodies',
    medical_bodies: ['Medical Board of Australia (AHPRA)', 'Australian Medical Association (ethics code)'],
    physio_bodies: ['Physiotherapy Board of Australia (AHPRA)', 'Australian Physiotherapy Association'],
    roles: 'The provider is the APP entity; the platform is a contracted service provider.',
    consent: { explicit: true, note: 'Health information is sensitive: collect with consent or as the Act otherwise permits.' },
    access_days: { days: 30, statutory: true, label: '30 days (APP 12)' },
    breach: { first_hours: 720, regulator: 'Assess within 30 days; notify the OAIC and affected people as soon as practicable for eligible breaches', note: 'Eligible = likely serious harm.' },
    retention: { adult_years: 7, minor_until_age: 25, note: 'Typically 7 years after the last service; for children until age 25 (e.g. Victoria).' },
    transfer: { mode: 'safeguards', note: 'APP 8: take reasonable steps so the overseas recipient protects the data; My Health Record data must stay in Australia.' },
    telehealth: 'The clinician must be registered with AHPRA.',
    minors: 'Capacity rather than age; guardians act for those who lack it.',
  },
  NZ: {
    code: 'NZ', name: 'New Zealand', flag: '🇳🇿',
    laws: ['Privacy Act 2020', 'Health Information Privacy Code 2020', 'Health (Retention of Health Information) Regulations 1996', 'Health Practitioners Competence Assurance Act 2003'],
    regulator: 'Office of the Privacy Commissioner',
    medical_bodies: ['Medical Council of New Zealand', 'New Zealand Medical Association (ethics)'],
    physio_bodies: ['Physiotherapy Board of New Zealand', 'Physiotherapy New Zealand'],
    roles: 'The health agency is responsible; the platform holds data on its behalf.',
    consent: { explicit: true, note: 'Collect directly with the person’s knowledge and authorisation; use only for the purpose collected.' },
    access_days: { days: 28, statutory: true, label: '20 working days' },
    breach: { first_hours: 72, regulator: 'Notify the Commissioner and affected people as soon as practicable once serious harm is likely (the Commissioner expects about 72 hours)', note: 'Failure to notify is an offence.' },
    retention: { adult_years: 10, minor_until_age: null, note: 'Health information is kept 10 years from the last service.' },
    transfer: { mode: 'safeguards', note: 'Disclose overseas only if the recipient has comparable safeguards or the person authorises it.' },
    telehealth: 'The clinician must hold current New Zealand registration.',
    minors: 'Under-16s’ representatives may act; a competent young person can decide.',
  },
};

export const COUNTRIES = Object.keys(REGIMES);
export const DISCLAIMER = 'Operator reference summary, reviewed on ' + REGIMES_REVIEWED_ON + '. Not legal advice and not a certificate of compliance: confirm with counsel and the regulator, including state, provincial and emirate rules.';
export const DEFAULT_ACCESS_DAYS = 30;

/** Every right a person can ask for. Some regimes have no statutory right; the platform still accepts the request and answers inside its own deadline. */
export const REQUEST_KINDS = ['access', 'export', 'correction', 'restriction', 'erasure', 'objection'];

export const regimeFor = (code) => REGIMES[String(code ?? '').toUpperCase()] ?? null;

/** Public shape of one regime (everything here is public reference text). */
export const publicRegime = (r) => ({ ...r, version: REGIME_VERSION, reviewed_on: REGIMES_REVIEWED_ON, disclaimer: DISCLAIMER });

const addDays = (d, n) => new Date(new Date(d).getTime() + n * 864e5);
const addYears = (d, n) => { const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + n); return x; };

/** When a rights request must be answered. */
export const requestDue = (regime, from = new Date()) => addDays(from, regime?.access_days?.days ?? DEFAULT_ACCESS_DAYS);

/** First breach deadline measured from awareness. null = "as soon as practicable". */
export const breachDue = (regime, awareAt) => (regime?.breach?.first_hours ? new Date(new Date(awareAt).getTime() + regime.breach.first_hours * 36e5) : null);

/**
 * The date before which a record may not be erased. Adults: last entry + adult_years. Children: the later of that and the birthday
 * `minor_until_age` (needs dob). Without a regime the platform's own rule is never to delete, so this only informs the person.
 */
export function retainUntil(regime, lastEntryAt, dob = null) {
  if (!regime || !lastEntryAt) return null;
  let until = addYears(lastEntryAt, regime.retention.adult_years);
  if (regime.retention.minor_until_age && dob) {
    const d = new Date(dob);
    if (!isNaN(d)) { const b = new Date(Date.UTC(d.getUTCFullYear() + regime.retention.minor_until_age, d.getUTCMonth(), d.getUTCDate())); if (b > until) until = b; }
  }
  return until;
}
