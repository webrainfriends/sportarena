// Federation licence ID card (#703): a live, wallet-style card for a federation licence.
// Nothing here stores a new copy of the licence. The status on the card is always read from the register (LIC_STATUS) at the moment it is built,
// the QR carries a short-lived signed token (or the public code, for a shared card) that `verify_licence` resolves live, and a young person's card
// never carries their name outwards.
import { createHmac, timingSafeEqual } from 'node:crypto';
import qrcode from 'qrcode-generator';
import PDFDocument from 'pdfkit';
import { blindIndex } from './crypto.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import { fonts, assertGlyphs } from './documents/render.js';

// ------------------------------------------------------------------ rotating token  LC1.<licence id>.<window>.<mac>
const STEP_S = 60, AHEAD = 1, BEHIND = 3;      // a screenshot of the QR stops verifying about four minutes later
const keyOf = (licenceId) => blindIndex(`licence-card|${licenceId}`);
const windowOf = (at = new Date()) => Math.floor(at.getTime() / 1000 / STEP_S);
const macOf = (licenceId, w) => createHmac('sha256', keyOf(licenceId)).update(`LC1|${licenceId}|${w}`).digest('hex').slice(0, 24);
export const TOKEN_RE = /^LC1\.([0-9a-f-]{36})\.(\d{1,10})\.([0-9a-f]{24})$/;

export function mintCardToken(licenceId, at = new Date()) {
  const w = windowOf(at);
  return { token: `LC1.${licenceId}.${w}.${macOf(licenceId, w)}`, refresh_in_s: STEP_S, expires_at: new Date((w + BEHIND + 1) * STEP_S * 1000).toISOString() };
}
/** @returns {{ licenceId: string } | { error: 'invalid' | 'expired' }} */
export function readCardToken(raw, at = new Date()) {
  const m = TOKEN_RE.exec(String(raw ?? '').trim());
  if (!m) return { error: 'invalid' };
  const want = Buffer.from(macOf(m[1], Number(m[2]))), got = Buffer.from(m[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { error: 'invalid' };
  const d = windowOf(at) - Number(m[2]);
  return d >= -AHEAD && d <= BEHIND ? { licenceId: m[1] } : { error: 'expired' };
}

/** What a person scanning the QR opens: the public check page for a token or a code. */
export const verifyUrl = (value) => `${(config.appUrl ?? config.apiPublicUrl).replace(/\/$/, '')}/?verify=${encodeURIComponent(value)}`;

// ------------------------------------------------------------------ the card as data
const STATUS_LABEL = { active: 'VALID', suspended: 'SUSPENDED', expired: 'EXPIRED', revoked: 'REVOKED' };
/** @param {object} l a row from licenceRow(); `minor` hides the name outwards; `shared` also drops the number-bearing contact detail */
export function cardData(l, { minor = false, withName = true } = {}) {
  const showName = withName && !minor;
  return {
    status: l.status, valid: l.status === 'active', standing: l.standing, status_label: STATUS_LABEL[l.status] ?? 'NOT IN FORCE',
    holder_name: showName ? l.holder_name : (minor ? 'Registered athlete (name withheld)' : null),
    licence_no: l.licence_no, type_name: l.type_name, holder_role: l.holder_role, sport_name: l.sport_name, discipline: l.discipline || null, grade: l.grade || null,
    issued_on: l.issued_on, expires_on: l.expires_on, suspended_until: l.suspended_until ?? null, days_to_expiry: l.days_to_expiry ?? null,
    body_name: l.body_name, body_abbreviation: l.body_abbreviation, public_code: l.public_code, minor,
  };
}

// ------------------------------------------------------------------ rendering (the Dusk palette, as in apps/app/src/theme.js)
const DUSK = { bg: '#E5EAF5', paper: '#FFFFFF', ink: '#2F3242', mute: '#5F6580', line: '#CDD5E8', accent: '#8458B3', slate: '#494D5F', lime: '#2F8F5F', sun: '#D97706', red: '#E11D48' };
const BAND = { active: DUSK.lime, suspended: DUSK.sun, expired: DUSK.mute, revoked: DUSK.red };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function qrModules(value) {
  const q = qrcode(0, 'M'); q.addData(value); q.make();
  const n = q.getModuleCount();
  return { n, dark: (r, c) => q.isDark(r, c) };
}

/** The card as an SVG string, 1012 x 638 (credit-card ratio). Also the single source for the PNG. */
export function cardSvg(card, { qrValue, asOf = new Date() }) {
  const W = 1012, H = 638, band = BAND[card.status] ?? DUSK.mute;
  const { n, dark } = qrModules(qrValue);
  const cell = Math.floor(230 / n), qs = cell * n, qx = W - 48 - qs - 16, qy = 196;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) path += `M${qx + c * cell} ${qy + r * cell}h${cell}v${cell}h-${cell}z`;
  const row = (label, value, x, y) => value ? `<text x="${x}" y="${y}" font-size="20" fill="${DUSK.mute}">${esc(label)}</text><text x="${x}" y="${y + 32}" font-size="28" font-weight="700" fill="${DUSK.ink}">${esc(value)}</text>` : '';
  const validity = card.expires_on ? `${card.issued_on ?? ''} – ${card.expires_on}` : null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, Noto Sans, Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" rx="36" fill="${DUSK.paper}"/><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="35" fill="none" stroke="${DUSK.line}" stroke-width="2"/>
<path d="M0 36a36 36 0 0 1 36-36h${W - 72}a36 36 0 0 1 36 36v110H0z" fill="${DUSK.slate}"/>
<text x="48" y="64" font-size="22" fill="#D0BDF4" letter-spacing="2">${esc((card.body_abbreviation || card.body_name || '').toUpperCase())}</text>
<text x="48" y="112" font-size="36" font-weight="700" fill="#FFFFFF">${esc(card.type_name)}</text>
<rect x="${W - 48 - 190}" y="52" width="190" height="52" rx="26" fill="${band}"/><text x="${W - 48 - 95}" y="88" font-size="24" font-weight="700" fill="#FFFFFF" text-anchor="middle">${esc(card.status_label)}</text>
<text x="48" y="206" font-size="40" font-weight="800" fill="${DUSK.ink}">${esc(card.holder_name)}</text>
${row('Licence no.', card.licence_no, 48, 254)}${row('Sport', [card.sport_name, card.discipline].filter(Boolean).join(' · '), 48, 340)}${row('Valid', validity, 48, 426)}${row('Grade', card.grade, 48, 512)}
<rect x="${qx - 16}" y="${qy - 16}" width="${qs + 32}" height="${qs + 32}" rx="16" fill="#FFFFFF" stroke="${DUSK.line}" stroke-width="2"/><path d="${path}" fill="${DUSK.ink}"/>
<text x="${qx + qs / 2}" y="${qy + qs + 52}" font-size="18" fill="${DUSK.mute}" text-anchor="middle">Scan to check live</text>
<text x="${qx + qs / 2}" y="${qy + qs + 78}" font-size="18" font-weight="700" fill="${DUSK.ink}" text-anchor="middle">${esc(card.public_code)}</text>
<text x="48" y="${H - 28}" font-size="16" fill="${DUSK.mute}">Status read from the federation register at ${esc(asOf.toISOString().slice(0, 16).replace('T', ' '))} UTC. Scan the code to confirm it today.</text>
</svg>`;
}

/** PNG of the card (server-rendered so it looks the same on every platform). 503 if the renderer is not installed here. */
export async function cardPng(svg) {
  let Resvg;
  try { ({ Resvg } = await import('@resvg/resvg-js')); } catch { throw new AppError(503, 'png_unavailable', 'Card images are not available on this server. The PDF still is.'); }
  const f = fonts();
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: 1012 }, font: { loadSystemFonts: true, ...(f.unicode ? { fontFiles: [process.env.DOC_FONT_REGULAR, process.env.DOC_FONT_BOLD].filter(Boolean) } : {}) } });
  return r.render().asPng();
}

/** A one-page card-sized PDF (86 x 54 mm scaled up for print/wallet), using the same fonts rule as every other document. */
export async function cardPdf(card, { qrValue, asOf = new Date() }) {
  const f = fonts();
  assertGlyphs([card.holder_name, card.licence_no, card.type_name, card.sport_name, card.discipline, card.grade, card.body_name, card.body_abbreviation], f);
  const W = 486, H = 306;                               // 1 mm = 2.835 pt: this is 171.5 x 108 mm
  const doc = new PDFDocument({ size: [W, H], margin: 0, compress: true, info: { Title: `Licence ${card.licence_no ?? ''}`.trim(), Author: card.body_name ?? 'GotMyGame', CreationDate: asOf, Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (x) => chunks.push(x));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const band = BAND[card.status] ?? DUSK.mute;
  doc.roundedRect(0, 0, W, H, 16).fill(DUSK.paper);
  doc.save().roundedRect(0, 0, W, 70, 16).clip().rect(0, 0, W, 70).fill(DUSK.slate).restore();
  doc.font(f.regular).fontSize(9).fillColor('#D0BDF4').text((card.body_abbreviation || card.body_name || '').toUpperCase(), 24, 18, { width: 260 });
  doc.font(f.bold).fontSize(17).fillColor('#FFFFFF').text(card.type_name ?? '', 24, 34, { width: 280 });
  doc.roundedRect(W - 24 - 96, 22, 96, 26, 13).fill(band);
  doc.font(f.bold).fontSize(11).fillColor('#FFFFFF').text(card.status_label, W - 24 - 96, 30, { width: 96, align: 'center' });
  doc.font(f.bold).fontSize(19).fillColor(DUSK.ink).text(card.holder_name ?? '', 24, 88, { width: 270 });
  const field = (label, value, y) => { if (!value) return; doc.font(f.regular).fontSize(8).fillColor(DUSK.mute).text(label, 24, y, { width: 270 }); doc.font(f.bold).fontSize(13).fillColor(DUSK.ink).text(String(value), 24, y + 11, { width: 270 }); };
  field('Licence no.', card.licence_no, 124); field('Sport', [card.sport_name, card.discipline].filter(Boolean).join(' · '), 160);
  field('Valid', card.expires_on ? `${card.issued_on ?? ''} – ${card.expires_on}` : null, 196); field('Grade', card.grade, 232);
  const { n, dark } = qrModules(qrValue), cell = Math.floor(118 / n), qs = cell * n, qx = W - 24 - qs - 8, qy = 92;
  doc.roundedRect(qx - 8, qy - 8, qs + 16, qs + 16, 8).lineWidth(1).fillAndStroke('#FFFFFF', DUSK.line);
  doc.fillColor(DUSK.ink);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) doc.rect(qx + c * cell, qy + r * cell, cell, cell).fill();
  doc.font(f.regular).fontSize(8).fillColor(DUSK.mute).text('Scan to check live', qx - 8, qy + qs + 14, { width: qs + 16, align: 'center' });
  doc.font(f.bold).fontSize(9).fillColor(DUSK.ink).text(card.public_code ?? '', qx - 8, qy + qs + 26, { width: qs + 16, align: 'center' });
  doc.font(f.regular).fontSize(7).fillColor(DUSK.mute).text(`Status read from the federation register at ${asOf.toISOString().slice(0, 16).replace('T', ' ')} UTC. Scan the code to confirm it today.`, 24, H - 22, { width: W - 48 });
  doc.end(); await done;
  return Buffer.concat(chunks);
}
