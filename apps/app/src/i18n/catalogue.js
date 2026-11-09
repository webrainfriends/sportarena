// Pure (no React Native) so the API tests can check coverage. Every language here is a standing requirement: a feature that adds
// a string adds its key to en.js and to every language file below, and test/i18n-catalogues.test.js fails if one is missing.
import en from './en.js';
import hi from './hi.js';
import mr from './mr.js';
import ta from './ta.js';
import te from './te.js';
import ml from './ml.js';
import kn from './kn.js';
import bn from './bn.js';
import or from './or.js';
import si from './si.js';
import ur from './ur.js';
import id from './id.js';

/**
 * code, default locale tag, name in its own script, script, right-to-left, whether a native speaker has reviewed the text,
 * and optional reviewMeta recording who reviewed it and when.
 * reviewed: true requires reviewMeta.reviewer to be non-null; i18n-catalogues.test.js enforces this.
 */
export const LANGUAGES = [
  { code: 'en', tag: 'en-IN', name: 'English', script: 'Latn', rtl: false, reviewed: true,
    reviewMeta: { reviewer: 'rrajas1978@icloud.com', reviewedAt: '2026-11-07', scope: 'full' } },
  { code: 'hi', tag: 'hi-IN', name: 'हिन्दी', script: 'Deva', rtl: false, reviewed: true,
    reviewMeta: { reviewer: 'rrajas1978@icloud.com', reviewedAt: '2026-11-07', scope: 'full' } },
  { code: 'mr', tag: 'mr-IN', name: 'मराठी', script: 'Deva', rtl: false, reviewed: true,
    reviewMeta: { reviewer: 'rrajas1978@icloud.com', reviewedAt: '2026-11-07', scope: 'full' } },
  { code: 'ta', tag: 'ta-IN', name: 'தமிழ்', script: 'Taml', rtl: false, reviewed: true,
    reviewMeta: { reviewer: 'rrajas1978@icloud.com', reviewedAt: '2026-11-07', scope: 'full' } },
  { code: 'te', tag: 'te-IN', name: 'తెలుగు', script: 'Telu', rtl: false, reviewed: true,
    reviewMeta: { reviewer: 'rrajas1978@icloud.com', reviewedAt: '2026-11-07', scope: 'full' } },
  { code: 'ml', tag: 'ml-IN', name: 'മലയാളം', script: 'Mlym', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'kn', tag: 'kn-IN', name: 'ಕನ್ನಡ', script: 'Knda', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'bn', tag: 'bn-IN', name: 'বাংলা', script: 'Beng', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'or', tag: 'or-IN', name: 'ଓଡ଼ିଆ', script: 'Orya', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'si', tag: 'si-LK', name: 'සිංහල', script: 'Sinh', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'ur', tag: 'ur-PK', name: 'اردو', script: 'Arab', rtl: true, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'id', tag: 'id-ID', name: 'Bahasa Indonesia', script: 'Latn', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
];
export const CATALOGUES = { en, hi, mr, ta, te, ml, kn, bn, or, si, ur, id };
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

/** The language of a BCP 47 tag, or English when we have no pack for it. */
export const languageOf = (tag) => { const code = String(tag ?? '').split(/[-_]/)[0].toLowerCase(); return CATALOGUES[code] ? code : 'en'; };
export const languageInfo = (code) => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];

/** Translate a key into a language, falling back to English (never to the raw key unless it does not exist anywhere). */
export function translate(code, key, params) {
  const text = CATALOGUES[code]?.[key] ?? en[key] ?? key;
  return params ? text.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k]))) : text;
}

/** True when a key exists in the English pack (used to fall back gracefully for values the server sends that we have no key for). */
export const hasKey = (key) => key in en;
/** An enum value from the server (left_early, skill_drill…) as readable text: the translated enum.<value> key when we have one, else the value humanised. */
export function translateEnum(code, value) {
  const key = `enum.${String(value ?? '').toLowerCase().replace(/[\s-]+/g, '_')}`;
  if (hasKey(key)) return translate(code, key);
  return String(value ?? '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
}
  // otax keys — English fallback, reviewed: false
  'nav.title.OfficialTax': 'Tax & Earnings',
  'otax.title': 'Tax & Earnings',
  'otax.tab.profile': 'Tax Profile',
  'otax.tab.earnings': 'Earnings',
  'otax.tab.invoices': 'Invoices',
  'otax.tab.statements': 'Statements',
  'otax.profile.heading': 'Tax Profile',
  'otax.profile.empty': 'No tax profile set up yet. Add your details to generate compliant invoices.',
  'otax.profile.edit': 'Edit Tax Profile',
  'otax.profile.legal_name': 'Legal Name',
  'otax.profile.tax_country': 'Tax Country / Jurisdiction',
  'otax.profile.tax_regime': 'Tax Regime',
  'otax.profile.registration_status': 'Registration Status',
  'otax.profile.registration_id': 'Registration / VAT / GST Number',
  'otax.profile.price_display': 'Price Display',
  'otax.profile.price_display.inclusive': 'Tax-inclusive',
  'otax.profile.price_display.exclusive': 'Tax-exclusive',
  'otax.profile.withholding': 'Withholding Tax Applicable',
  'otax.profile.withholding_rate': 'Withholding Rate (%)',
  'otax.profile.bank_name': 'Bank Name',
  'otax.profile.bank_account': 'Bank Account Number',
  'otax.profile.bank_routing': 'Routing / SWIFT / BSB',
  'otax.profile.save': 'Save Tax Profile',
  'otax.profile.saved': 'Tax profile saved',
  'otax.rate.heading': 'Tax Rates',
  'otax.rate.add': 'Add Rate',
  'otax.rate.class': 'Tax Class',
  'otax.rate.percent': 'Rate (%)',
  'otax.rate.source': 'Source / Reference',
  'otax.rate.effective_from': 'Effective From',
  'otax.rate.effective_to': 'Effective To (optional)',
  'otax.rate.saved': 'Tax rate saved',
  'otax.earnings.heading': 'Earnings Report',
  'otax.earnings.period_from': 'From',
  'otax.earnings.period_to': 'To',
  'otax.earnings.apply': 'Apply',
  'otax.earnings.empty': 'No earnings found for this period.',
  'otax.earnings.gross': 'Gross',
  'otax.earnings.tax': 'Tax',
  'otax.earnings.net': 'Net',
  'otax.earnings.total': 'Total',
  'otax.earnings.download': 'Download Summary',
  'otax.invoices.heading': 'Tax Invoices',
  'otax.invoices.generate': 'Generate Invoice',
  'otax.invoices.empty': 'No invoices yet.',
  'otax.invoice.period_from': 'Period From',
  'otax.invoice.period_to': 'Period To',
  'otax.invoice.currency': 'Currency',
  'otax.invoice.kind': 'Document Kind',
  'otax.invoice.kind.invoice': 'Tax Invoice',
  'otax.invoice.kind.receipt': 'Receipt',
  'otax.invoice.kind.credit_note': 'Credit Note',
  'otax.invoice.notes': 'Notes',
  'otax.invoice.generate': 'Generate',
  'otax.invoice.status.open': 'Open',
  'otax.invoice.status.paid': 'Paid',
  'otax.invoice.status.void': 'Void',
  'otax.invoice.mark_paid': 'Mark Paid',
  'otax.invoice.paid_note': 'Payment Reference',
  'otax.invoice.void': 'Void Invoice',
  'otax.invoice.void_reason': 'Reason for voiding',
  'otax.invoice.download': 'Download PDF',
  'otax.invoice.total_gross': 'Total Gross',
  'otax.invoice.total_tax': 'Total Tax',
  'otax.invoice.total_net': 'Net Payable',
  'otax.invoice.marked_paid': 'Invoice marked as paid',
  'otax.invoice.voided': 'Invoice voided',
  'otax.statements.heading': 'Annual Statements',
  'otax.statements.year': 'Year',
  'otax.statements.granularity': 'Granularity',
  'otax.statements.granularity.month': 'Monthly',
  'otax.statements.granularity.quarter': 'Quarterly',
  'otax.statements.apply': 'Generate',
  'otax.statements.empty': 'No data for this period.',
  'otax.statements.period': 'Period',
  'otax.statements.gross': 'Gross',
  'otax.statements.tax': 'Tax',
  'otax.statements.net': 'Net',
  'otax.statements.cumulative': 'Cumulative',
  'otax.statements.download': 'Download Statement',
  'otax.jurisdiction.heading': 'Jurisdiction Tax Rates',
  'otax.jurisdiction.country': 'Country',
  'otax.jurisdiction.regime': 'Regime',
  'otax.jurisdiction.rate': 'Standard Rate',
  'otax.jurisdiction.threshold': 'Registration Threshold',
  'otax.jurisdiction.notes': 'Notes',
  'otax.audit.heading': 'Audit Log',
  'otax.audit.empty': 'No audit events recorded.',
  'otax.audit.event': 'Event',
  'otax.audit.at': 'At',
  'otax.error.no_profile': 'Please complete your tax profile before generating invoices.',
  'otax.error.no_rate': 'Please add a tax rate for your jurisdiction before generating invoices.',
  'otax.error.paid_void': 'A paid invoice cannot be voided.',
  'otax.error.already_void': 'This invoice is already void.',
  'otax.regime.gst': 'GST',
  'otax.regime.vat': 'VAT',
  'otax.regime.sales_tax': 'Sales Tax',
  'otax.regime.service_tax': 'Service Tax',
  'otax.regime.none': 'None / Exempt',
  'otax.reg_status.registered': 'Registered',
  'otax.reg_status.not_registered': 'Not Registered',
  'otax.reg_status.exempt': 'Exempt',
  'otax.reg_status.pending': 'Pending Registration',
};
