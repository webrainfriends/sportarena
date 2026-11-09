/** Locale-aware formatting helpers using the Intl API. Import from i18n/index.js. */

/** Format a number in the given BCP 47 locale. */
export function fmtNumber(value, locale, options = {}) {
  try { return new Intl.NumberFormat(locale, options).format(value); }
  catch { return String(value); }
}

/** Format a currency amount in the given BCP 47 locale. */
export function fmtCurrency(value, currency = 'INR', locale, options = {}) {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency, ...options }).format(value); }
  catch { return `${currency} ${value}`; }
}

/** Format a Date (or timestamp) in the given BCP 47 locale. */
export function fmtDate(value, locale, options = { dateStyle: 'medium' }) {
  try { return new Intl.DateTimeFormat(locale, options).format(value instanceof Date ? value : new Date(value)); }
  catch { return String(value); }
}

/**
 * Locale-aware plural selection.
 * @param {number} n
 * @param {string} locale - BCP 47 tag
 * @param {{ one?: string, other: string, zero?: string, two?: string, few?: string, many?: string }} forms
 */
export function fmtPlural(n, locale, forms) {
  try {
    const rule = new Intl.PluralRules(locale).select(n);
    return (forms[rule] ?? forms.other).replace('{n}', String(n));
  } catch {
    return (n === 1 ? (forms.one ?? forms.other) : forms.other).replace('{n}', String(n));
  }
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
