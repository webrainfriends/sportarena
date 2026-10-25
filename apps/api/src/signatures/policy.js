// Signature level per jurisdiction (#386). Levels follow eIDAS: simple < advanced < qualified.
//  - internal (signed in Sportarena while logged in) is a SIMPLE electronic signature.
//  - an external vendor (DocuSign, ...) signs with the vendor's ADVANCED flow (signer identity bound to an email-verified envelope + audit trail).
//  - qualified signatures need a qualified trust service and are not offered by any configured provider.
// `minimum` is what we refuse to go below; `recommended` is what the sheet suggests. Commercial sponsorship agreements are valid with a
// simple signature in every region below, so no region forces more yet; the table is where counsel's decision for a region is recorded.
export const LEVELS = ['simple', 'advanced', 'qualified'];
const rank = (l) => LEVELS.indexOf(l);

const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
const rule = (law, note, minimum = 'simple', recommended = 'advanced') => ({ law, note, minimum, recommended });
export const POLICY = {
  ...Object.fromEntries(EU.map((c) => [c, rule('eIDAS (EU 910/2014)', 'A simple electronic signature is legally valid for a commercial contract; advanced gives stronger proof of who signed.')])),
  GB: rule('Electronic Communications Act 2000 / UK eIDAS', 'A simple electronic signature is valid; advanced is recommended for higher-value deals.'),
  US: rule('ESIGN Act / UETA', 'A simple electronic signature is valid for commercial contracts; advanced gives a stronger audit trail.'),
  IN: rule('Information Technology Act 2000', 'Simple electronic signatures are valid for commercial contracts, but Aadhaar eSign or a digital certificate is stronger evidence and accepted for more document types.'),
  SG: rule('Electronic Transactions Act 2010', 'A simple electronic signature is valid; advanced is recommended.'),
  AE: rule('Federal Decree-Law 46/2021 on Electronic Transactions', 'Simple electronic signatures are valid; advanced (reliable) signatures carry a presumption of authenticity.'),
  AU: rule('Electronic Transactions Act 1999', 'A simple electronic signature is valid; advanced is recommended.'),
};
export const DEFAULT_RULE = rule('No specific rule recorded', 'No rule has been recorded for this country. A simple electronic signature is accepted, but have counsel confirm before relying on it for a high-value deal.', 'simple', 'advanced');

export const ruleFor = (country, table = POLICY) => ({ country: country ?? null, ...(table[String(country ?? '').toUpperCase()] ?? DEFAULT_RULE) });

/** Whether a provider's signature level is acceptable in a country; `ok:false` means sending must be refused. */
export function checkLevel(country, level, table = POLICY) {
  const r = ruleFor(country, table);
  return { ...r, level, ok: rank(level) >= rank(r.minimum), meets_recommended: rank(level) >= rank(r.recommended) };
}
