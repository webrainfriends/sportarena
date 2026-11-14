// Invoice PDF renderer (pdfkit). Layout comes from a validated template; every figure comes from the canonical invoice row and is only
// formatted here - nothing is recalculated. The same function renders previews (sample data, labelled SAMPLE) and issued documents.
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { AppError } from '../errors.js';
import { toMajor } from '../currency.js';
import { drawForm } from './sheet-forms.js';
import { formStrings } from '../tracking/forms.js';
import { drawWordmark, ICON } from './brand-font.js';

const MM = 72 / 25.4;
const BASE_FONTS = { regular: 'Helvetica', bold: 'Helvetica-Bold' };
// System Unicode fonts tried in order when DOC_FONT_REGULAR is not set.
// GNU Unifont covers the full Unicode BMP (all Indic scripts, Arabic/Urdu, Sinhala, etc.).
const SYSTEM_FONTS = [
  { regular: '/usr/share/fonts/opentype/unifont/unifont_sample.otf', bold: '/usr/share/fonts/opentype/unifont/unifont_sample.otf' },
  { regular: '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',  bold: '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf' },
  { regular: '/usr/share/fonts/truetype/freefont/FreeSans.ttf',      bold: '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf' },
];
let _sysFonts;
const detectSystemFonts = () => { if (_sysFonts === undefined) _sysFonts = SYSTEM_FONTS.find(p => existsSync(p.regular)) ?? null; return _sysFonts; };
export const fonts = () => { const cfg = process.env.DOC_FONT_REGULAR || null; const sys = cfg ? null : detectSystemFonts(); return { regular: cfg || sys?.regular || BASE_FONTS.regular, bold: process.env.DOC_FONT_BOLD || cfg || sys?.bold || BASE_FONTS.bold, unicode: !!(cfg || sys) }; };
// What the built-in PDF fonts can show (Latin-1 plus common punctuation). Anything else needs a Unicode font (auto-detected above, or set DOC_FONT_REGULAR).
const BASIC = /^[ -~ -ÿ‐-‟•…€\n]*$/;

const TEXT_SIZE = { small: 8, normal: 9, large: 12 };
const money = (cents, cur) => `${cur} ${toMajor(cents, cur)}`;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const hex = (c, d) => (/^#[0-9A-Fa-f]{6}$/.test(c ?? '') ? c : d);

export function assertGlyphs(strings, f) {
  if (f.unicode) return;
  const bad = strings.find((s) => s && !BASIC.test(s));
  if (bad !== undefined) throw new AppError(422, 'unsupported_characters', 'This document contains characters (for example Tamil) that need a Unicode font, which is not installed on this server. Set DOC_FONT_REGULAR to a TTF such as Noto Sans.');
}

/** @returns {Promise<{ buffer: Buffer, pages: number }>} */
export async function renderInvoice({ layout, kit, logo, invoice, sample = false }) {
  const f = fonts();
  const lines = invoice.lines ?? [];
  const parties = [invoice.seller?.name, invoice.seller?.address, invoice.seller?.tax_id, invoice.buyer?.name, invoice.buyer?.address, invoice.buyer?.tax_id];
  assertGlyphs([kit?.display_name, kit?.legal_name, kit?.address, kit?.footer_text, ...parties, ...lines.map((l) => l.description), ...layout.blocks.map((b) => b.text)], f);

  const accent = hex(kit?.primary_color, '#0F6E56'), ink = hex(kit?.secondary_color, '#444441');
  const doc = new PDFDocument({
    size: layout.paper, layout: layout.orientation, margin: layout.margin_mm * MM, bufferPages: true, compress: true,
    info: { Title: `${invoice.kind === 'credit_note' ? 'Credit note' : 'Invoice'} ${invoice.number}`, Author: kit?.display_name ?? invoice.seller?.name ?? 'GotMyGame', CreationDate: new Date(invoice.issued_at), Producer: 'GotMyGame' },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });

  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24; // room kept for the footer
  const title = invoice.kind === 'credit_note' ? 'CREDIT NOTE' : invoice.status === 'paid' ? 'INVOICE · PAID' : 'INVOICE';
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });

  const header = (compact) => {
    const top = doc.page.margins.top;
    let x = left;
    if (layout.style === 'modern' && !compact) doc.rect(0, 0, doc.page.width, 10).fill(accent);
    if (logo) {
      try { doc.image(logo, x, top, { fit: [compact ? 80 : 130, compact ? 28 : 56] }); x += compact ? 90 : 140; }
      catch { throw new AppError(422, 'logo_unreadable', 'The brand logo could not be read. Upload it again as PNG or JPEG.'); }
    }
    label(kit?.display_name ?? invoice.seller?.name ?? '', x, top, width - (x - left) - 150, { bold: true, size: compact ? 10 : 14, color: accent });
    if (!compact) {
      const sub = [kit?.legal_name, kit?.address, [kit?.contact_email, kit?.phone].filter(Boolean).join(' · '), kit?.website].filter(Boolean).join('\n');
      if (sub) label(sub, x, doc.y + 2, width - (x - left) - 150, { size: 8 });
    }
    label(`${title}\n${invoice.number}`, left + width - 150, top, 150, { bold: true, size: compact ? 9 : 11, align: 'right', color: ink });
    doc.y = Math.max(doc.y, top + (logo ? (compact ? 32 : 60) : 0)) + (compact ? 8 : 14);
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).stroke(accent);
    doc.y += 12;
  };
  let first = true;
  doc.on('pageAdded', () => { if (!first) header(true); });

  if (sample) label('SAMPLE — preview with made-up data, not a real document', left, doc.page.margins.top - 12 < 0 ? 4 : Math.max(4, doc.page.margins.top - 14), width, { bold: true, size: 8, color: '#B42318' });

  for (const b of layout.blocks) {
    if (b.type === 'header') { header(false); first = false; continue; }
    if (first) { first = false; }
    if (b.type === 'title') {
      label(`${title} ${invoice.number}`, left, doc.y, width, { bold: true, size: 16, color: accent });
      label(`Issued ${day(invoice.issued_at)} (UTC) · Status: ${invoice.status}${invoice.reservation_code ? ` · Booking ${invoice.reservation_code}` : ''}`, left, doc.y + 2, width, { size: 9 });
      doc.y += 10;
    } else if (b.type === 'parties') {
      const y = doc.y, half = width / 2 - 8;
      label('FROM', left, y, half, { bold: true, size: 8, color: accent });
      label([invoice.seller?.name, invoice.seller?.address, invoice.seller?.tax_id && `Tax ID: ${invoice.seller.tax_id}`].filter(Boolean).join('\n'), left, y + 12, half);
      const endL = doc.y;
      label('BILL TO', left + half + 16, y, half, { bold: true, size: 8, color: accent });
      label(invoice.buyer ? [invoice.buyer.name, invoice.buyer.address, invoice.buyer.tax_id && `Tax ID: ${invoice.buyer.tax_id}`].filter(Boolean).join('\n') : '(bill-to details unavailable)', left + half + 16, y + 12, half);
      doc.y = Math.max(endL, doc.y) + 14;
    } else if (b.type === 'lines') {
      const cols = [{ t: 'Description', w: width - 190, a: 'left' }, { t: 'Date', w: 70, a: 'left' }, { t: 'Tax', w: 55, a: 'right' }, { t: 'Amount', w: 65, a: 'right' }];
      const head = () => { const y = doc.y; doc.rect(left, y - 2, width, 16).fill(accent); drawRow(cols.map((c) => c.t), true, y + 1); };
      const drawRow = (cells, bold, y) => {
        let h = 0;
        cells.forEach((c, i) => { doc.font(bold ? f.bold : f.regular).fontSize(9); h = Math.max(h, doc.heightOfString(c || ' ', { width: cols[i].w - 6 })); });
        let x = left;
        cells.forEach((c, i) => { label(c, x, y, cols[i].w - 6, { bold, align: cols[i].a, color: bold ? '#FFFFFF' : ink }); x += cols[i].w; });
        doc.y = y + h + 5;
        return h;
      };
      head();
      for (const l of lines) {
        const cells = [l.description, day(l.starts_at), l.tax_cents != null ? money(l.tax_cents, invoice.currency) : '', money(l.amount_cents, invoice.currency)];
        doc.font(f.regular).fontSize(9);
        const h = Math.max(...cells.map((c, i) => doc.heightOfString(c || ' ', { width: cols[i].w - 6 })));
        if (doc.y + h + 6 > bottom()) { doc.addPage(); head(); } // repeating table header on every page
        drawRow(cells, false, doc.y);
        doc.moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).lineWidth(0.3).stroke('#D3D1C7');
      }
      doc.y += 6;
    } else if (b.type === 'totals') {
      if (doc.y + 70 > bottom()) doc.addPage();
      const tx = left + width - 220, w = 220;
      const sum = (k, v, bold) => { const y = doc.y; label(k, tx, y, 120, { bold }); label(v, tx + 120, y, 100, { bold, align: 'right' }); doc.y = y + 14; };
      sum(`${invoice.tax_name ?? 'Tax'} ${(invoice.tax_rate_bp / 100).toFixed(2)}%${invoice.tax_inclusive ? ' (included)' : ''}`, money(invoice.tax_cents, invoice.currency));
      if (invoice.credits_cents) sum('Wallet credit applied', `- ${money(invoice.credits_cents, invoice.currency)}`);
      doc.moveTo(tx, doc.y).lineTo(tx + w, doc.y).lineWidth(0.6).stroke(accent); doc.y += 4;
      sum('Total', money(invoice.total_cents, invoice.currency), true);
      if (invoice.status === 'open') sum('Amount due', money(invoice.total_cents - (invoice.credits_cents ?? 0), invoice.currency), true);
      if (invoice.status === 'paid') sum('Paid', `${day(invoice.paid_at)}${invoice.payment_method ? ` · ${invoice.payment_method}` : ''}`);
      doc.y += 10;
    } else if (b.type === 'text') {
      if (doc.y + 30 > bottom()) doc.addPage();
      label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8;
    }
    // 'footer' is drawn on every page below
  }

  const wantsFooter = layout.blocks.some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - doc.page.margins.bottom - 12;
    doc.page.margins.bottom = 0; // allow drawing in the bottom margin without triggering a new page
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 80, { size: 8, lineBreak: false });
    label(`${sample ? 'SAMPLE · ' : ''}${invoice.number} · Page ${i + 1} of ${range.count}`, left + width - 200, y, 200, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * Coaching report PDF. The content is the frozen snapshot of a published report version, formatted only: no figure or sentence is
 * produced here. Branding (kit, logo, layout blocks header/title/text/footer) comes from the same template system as invoices.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderCoachingReport({ layout, kit, logo, snapshot, version }) {
  const f = fonts();
  const strings = [kit?.display_name, kit?.legal_name, kit?.address, kit?.footer_text, snapshot.title, snapshot.subject, snapshot.coach_name, snapshot.disclosure, ...layout.blocks.map((b) => b.text)];
  for (const sec of snapshot.sections) strings.push(sec.title, sec.body, ...(sec.items ?? []).flatMap((x) => [x.title, x.meta, x.body, x.value]), ...(sec.rows ?? []).flatMap((x) => [x.label, x.note]));
  assertGlyphs(strings, f);
  const accent = hex(kit?.primary_color, '#0F6E56'), ink = hex(kit?.secondary_color, '#444441');
  const doc = new PDFDocument({
    size: layout.paper, layout: layout.orientation, margin: layout.margin_mm * MM, bufferPages: true, compress: true,
    info: { Title: snapshot.title, Author: kit?.display_name ?? snapshot.coach_name ?? 'GotMyGame', CreationDate: new Date(snapshot.published_at), Producer: 'GotMyGame' },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  for (const b of layout.blocks) {
    if (b.type === 'header') {
      const top = doc.page.margins.top; let x = left;
      if (layout.style === 'modern') doc.rect(0, 0, doc.page.width, 10).fill(accent);
      if (logo) { try { doc.image(logo, x, top, { fit: [130, 56] }); x += 140; } catch { throw new AppError(422, 'logo_unreadable', 'The brand logo could not be read. Upload it again as PNG or JPEG.'); } }
      label(kit?.display_name ?? snapshot.coach_name ?? '', x, top, width - (x - left), { bold: true, size: 14, color: accent });
      const sub = [kit?.legal_name, kit?.address, [kit?.contact_email, kit?.phone].filter(Boolean).join(' · '), kit?.website].filter(Boolean).join('\n');
      if (sub) label(sub, x, doc.y + 2, width - (x - left), { size: 8 });
      doc.y = Math.max(doc.y, top + (logo ? 60 : 0)) + 14;
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).stroke(accent); doc.y += 12;
    } else if (b.type === 'title') {
      label(snapshot.title, left, doc.y, width, { bold: true, size: 18, color: accent });
      label(`${snapshot.subject} · ${snapshot.period.from} to ${snapshot.period.to} · Coach ${snapshot.coach_name}`, left, doc.y + 2, width, { size: 9 });
      label(`Version ${version} · ${snapshot.disclosure}`, left, doc.y + 2, width, { size: 8 });
      doc.y += 12;
      for (const sec of snapshot.sections) {
        room(48);
        label(sec.title.toUpperCase(), left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 4;
        if (sec.kind === 'text') { label(sec.body, left, doc.y, width, { size: 10 }); doc.y += 10; continue; }
        if (sec.kind === 'bars') {
          // a horizontal bar per row: the label, the bar scaled between the row's own min and max, and the value with its note
          const labelW = Math.min(150, width * 0.28), noteW = Math.min(170, width * 0.3), barW = width - labelW - noteW - 16;
          for (const row of sec.rows) {
            room(18);
            const y = doc.y, min = row.min ?? 0, frac = row.value == null ? 0 : Math.max(0, Math.min(1, (row.value - min) / ((row.max - min) || 1)));
            label(row.label, left, y, labelW, { size: 9 });
            doc.rect(left + labelW + 8, y + 1, barW, 9).fill('#E5E7EB');
            if (frac > 0) doc.rect(left + labelW + 8, y + 1, Math.max(1.5, barW * frac), 9).fill(accent);
            label(`${row.value ?? '-'}${row.note ? `  ${row.note}` : ''}`, left + labelW + barW + 16, y, noteW, { size: 8 });
            doc.y = y + 16;
          }
          doc.y += 6; continue;
        }
        for (const it of sec.items) {
          doc.font(f.bold).fontSize(10); const h = doc.heightOfString(`${it.title}${it.value ? `  ${it.value}` : ''}`, { width }) + (it.meta ? 12 : 0) + (it.body ? doc.font(f.regular).fontSize(9).heightOfString(it.body, { width }) : 0);
          room(Math.min(h + 10, 120));
          label(`${it.title}${it.value ? `   ${it.value}` : ''}`, left, doc.y, width, { bold: true, size: 10 });
          if (it.meta) label(it.meta, left, doc.y, width, { size: 8 });
          if (it.body) label(it.body, left, doc.y + 1, width, { size: 9 });
          doc.y += 8;
        }
        doc.y += 6;
      }
    } else if (b.type === 'text') {
      room(30); label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8;
    }
  }
  const wantsFooter = layout.blocks.some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - doc.page.margins.bottom - 12;
    doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 120, { size: 8, lineBreak: false });
    label(`${snapshot.title} · v${version} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * Enrolment letter: a welcome and confirmation of a place, from a frozen snapshot built at the moment of issue (programme terms, group, fees as
 * charged, agreements accepted). Only the words in the snapshot are printed; a template chooses presentation (header, text, footer) only.
 */
export async function renderEnrolmentLetter({ layout, kit, logo, snapshot }) {
  const f = fonts();
  const strings = [kit?.display_name, kit?.legal_name, kit?.address, kit?.footer_text, snapshot.title, snapshot.organisation, snapshot.address, snapshot.addressee, snapshot.reference, ...layout.blocks.map((b) => b.text)];
  for (const sec of snapshot.sections) strings.push(sec.title, sec.body, ...(sec.items ?? []).flatMap((x) => [x.title, x.value, x.meta]));
  assertGlyphs(strings, f);
  const accent = hex(kit?.primary_color, '#0F6E56'), ink = hex(kit?.secondary_color, '#444441');
  const doc = new PDFDocument({
    size: layout.paper, layout: layout.orientation, margin: layout.margin_mm * MM, bufferPages: true, compress: true,
    info: { Title: snapshot.title, Author: kit?.display_name ?? snapshot.organisation, CreationDate: new Date(snapshot.issued_at), Producer: 'GotMyGame' },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  for (const b of layout.blocks) {
    if (b.type === 'header') {
      const top = doc.page.margins.top; let x = left;
      if (layout.style === 'modern') doc.rect(0, 0, doc.page.width, 10).fill(accent);
      if (logo) { try { doc.image(logo, x, top, { fit: [130, 56] }); x += 140; } catch { throw new AppError(422, 'logo_unreadable', 'The brand logo could not be read. Upload it again as PNG or JPEG.'); } }
      label(kit?.display_name ?? snapshot.organisation, x, top, width - (x - left), { bold: true, size: 14, color: accent });
      const sub = [kit?.legal_name ?? snapshot.legal_name, kit?.address ?? snapshot.address, [kit?.contact_email, kit?.phone].filter(Boolean).join(' · '), kit?.website].filter(Boolean).join('\n');
      if (sub) label(sub, x, doc.y + 2, width - (x - left), { size: 8 });
      doc.y = Math.max(doc.y, top + (logo ? 60 : 0)) + 14;
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).stroke(accent); doc.y += 12;
    } else if (b.type === 'title') {
      label(snapshot.title, left, doc.y, width, { bold: true, size: 18, color: accent });
      label(`${snapshot.addressee} · ${day(snapshot.issued_at)} · Ref ${snapshot.reference}`, left, doc.y + 2, width, { size: 9 });
      doc.y += 12;
      for (const sec of snapshot.sections) {
        room(48);
        label(sec.title.toUpperCase(), left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 4;
        if (sec.body) { label(sec.body, left, doc.y, width, { size: 10 }); doc.y += 10; }
        for (const it of sec.items ?? []) {
          room(26);
          const y = doc.y;
          label(it.title, left, y, width * 0.34, { bold: true, size: 9 });
          const h1 = doc.y - y;
          label(it.value ?? '', left + width * 0.36, y, width * 0.64, { size: 9, align: 'left' });
          if (it.meta) label(it.meta, left + width * 0.36, doc.y, width * 0.64, { size: 8 });
          doc.y = Math.max(doc.y, y + h1) + 4;
        }
        doc.y += 8;
      }
    } else if (b.type === 'text') {
      room(30); label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8;
    }
  }
  const wantsFooter = layout.blocks.some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - doc.page.margins.bottom - 12;
    doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 120, { size: 8, lineBreak: false });
    label(`${snapshot.title} · ${snapshot.reference} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/** The academy packs (progress report, management review, finance pack) are section documents from a frozen snapshot, exactly like the enrolment letter. */
export const renderSectionDocument = renderEnrolmentLetter;

/**
 * Agreement overview + full text, from a snapshot taken when the PDF is made. Letterhead (logo, legal name, address, contact) comes from the
 * brand kit or the organisation profile; parties get signature lines. It is template wording and says so in the footer.
 */
export async function renderAgreement({ kit, logo, snapshot }) {
  const f = fonts();
  const strings = [kit?.display_name, kit?.legal_name, kit?.address, kit?.footer_text, snapshot.title, snapshot.organisation, snapshot.address, snapshot.reference, snapshot.body, snapshot.status, ...snapshot.facts.flatMap((x) => [x.title, x.value]), ...snapshot.parties.flatMap((x) => [x.role, x.name])];
  assertGlyphs(strings, f);
  const accent = hex(kit?.primary_color, '#0F6E56'), ink = hex(kit?.secondary_color, '#444441');
  const doc = new PDFDocument({ size: 'A4', margin: 20 * MM, bufferPages: true, compress: true, info: { Title: snapshot.title, Author: kit?.display_name ?? snapshot.organisation, CreationDate: new Date(snapshot.issued_at), Producer: 'GotMyGame' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  const top = doc.page.margins.top; let x = left;
  doc.rect(0, 0, doc.page.width, 10).fill(accent);
  if (logo) { try { doc.image(logo, x, top, { fit: [130, 56] }); x += 140; } catch { throw new AppError(422, 'logo_unreadable', 'The brand logo could not be read. Upload it again as PNG or JPEG.'); } }
  label(kit?.display_name ?? snapshot.organisation, x, top, width - (x - left), { bold: true, size: 14, color: accent });
  const sub = [kit?.legal_name ?? snapshot.legal_name, kit?.address ?? snapshot.address, [kit?.contact_email ?? snapshot.contact_email, kit?.phone ?? snapshot.contact_phone].filter(Boolean).join(' · '), kit?.website ?? snapshot.website].filter(Boolean).join('\n');
  if (sub) label(sub, x, doc.y + 2, width - (x - left), { size: 8 });
  doc.y = Math.max(doc.y, top + (logo ? 60 : 0)) + 14;
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).stroke(accent); doc.y += 14;

  label(snapshot.title, left, doc.y, width, { bold: true, size: 20, color: accent });
  label(`Ref ${snapshot.reference} · ${snapshot.status} · ${day(snapshot.issued_at)}`, left, doc.y + 2, width, { size: 9 });
  doc.y += 14;
  label('OVERVIEW', left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 4;
  for (const it of snapshot.facts) {
    room(20); const y = doc.y;
    label(it.title, left, y, width * 0.28, { bold: true, size: 9 });
    const h1 = doc.y - y;
    label(it.value ?? '', left + width * 0.3, y, width * 0.7, { size: 9 });
    doc.y = Math.max(doc.y, y + h1) + 4;
  }
  doc.y += 6;
  if (snapshot.parties.length) {
    room(40); label('PARTIES', left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 4;
    for (const p of snapshot.parties) { room(16); label(`${p.role}: ${p.name}`, left, doc.y, width, { size: 9 }); doc.y += 2; }
    doc.y += 8;
  }
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.4).stroke('#BBBBBB'); doc.y += 12;
  const blocks = String(snapshot.body ?? '').split(/\n{2,}/);
  for (const b of blocks) {
    const t = b.trim(); if (!t) continue;
    const head = /^(\d+)\.\s+(.{1,80})$/.exec(t);
    if (head) { room(40); label(t, left, doc.y, width, { bold: true, size: 10, color: accent }); doc.y += 3; continue; }
    const m = /^(\d+\.\s+[^\n]{1,80})\n([\s\S]+)$/.exec(t);
    if (m) { room(50); label(m[1], left, doc.y, width, { bold: true, size: 10, color: accent }); doc.y += 3; label(m[2], left, doc.y, width, { size: 10 }); doc.y += 8; continue; }
    room(24); label(t, left, doc.y, width, { size: 10, bold: t === t.toUpperCase() && t.length < 90 }); doc.y += 8;
  }
  const signers = [{ role: 'For the organisation', name: snapshot.legal_name ?? snapshot.organisation }, ...snapshot.parties];
  room(60 + Math.ceil(signers.length / 2) * 70);
  doc.y += 6; label('SIGNATURES', left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 14;
  const colW = (width - 24) / 2; let sy = doc.y;
  signers.forEach((p, k) => {
    const cx = left + (k % 2) * (colW + 24); if (k % 2 === 0 && k > 0) { sy += 70; if (sy + 70 > bottom()) { doc.addPage(); sy = doc.page.margins.top; } }
    doc.moveTo(cx, sy + 30).lineTo(cx + colW, sy + 30).lineWidth(0.5).stroke(ink);
    label(`${p.name}`, cx, sy + 34, colW, { size: 9, bold: true, lineBreak: false });
    label(`${p.role} · Date: ____________`, cx, sy + 46, colW, { size: 8, lineBreak: false });
  });
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - doc.page.margins.bottom - 12;
    doc.page.margins.bottom = 0;
    label(kit?.footer_text || 'Template wording, not legal advice. Have it reviewed for your situation.', left, y, width - 130, { size: 7, lineBreak: false });
    label(`${snapshot.reference} · Page ${i + 1} of ${range.count}`, left + width - 130, y, 130, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

const CADENCE = { once: 'one-off', weekly: 'weekly', monthly: 'monthly', quarterly: 'quarterly', custom: 'on set dates' };
/** One sentence per contribution line, formatted from the frozen snapshot only. */
export function describeLine(l) {
  const cur = l.currency ?? '';
  const parts = [];
  if (l.kind === 'money') parts.push(l.total_cents != null ? `${money(l.total_cents, cur)} in total` : `${money(l.amount_cents, cur)} per instalment`);
  else if (l.kind === 'goods') parts.push([l.quantity != null ? `${l.quantity}${l.unit ? ` ${l.unit}` : ''}` : null, l.estimate_cents != null ? `estimated value ${money(l.estimate_cents, cur)} (not cash)` : null].filter(Boolean).join(', ') || 'goods');
  else if (l.kind === 'service') parts.push([`${l.service_type ?? 'service'} service${l.quantity != null ? `, ${l.quantity} voucher${l.quantity === 1 ? '' : 's'}` : ''}`, l.estimate_cents != null ? `estimated value ${money(l.estimate_cents, cur)} (not cash)` : null].filter(Boolean).join(', '));
  else parts.push(l.estimate_cents != null ? `endorsement, estimated value ${money(l.estimate_cents, cur)} (not cash)` : 'endorsement');
  parts.push(`${CADENCE[l.cadence] ?? l.cadence}${l.cadence !== 'once' && l.instalments ? `, ${l.instalments} payment${l.instalments === 1 ? '' : 's'}` : ''}`);
  if (l.first_due_on) parts.push(`from ${l.first_due_on}`);
  return parts.join(' · ');
}

/**
 * Sponsorship contract PDF. Everything printed comes from the frozen contract snapshot (and, once signed, the signature evidence rows);
 * the template only chooses presentation and may add its own text clauses. Unsigned drafts are stamped DRAFT on every page, so a draft
 * can never be mistaken for the signed contract. @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderSponsorshipContract({ layout, kit, logo, snapshot, signatures = null, fingerprint }) {
  const f = fonts();
  const signed = !!signatures;
  const strings = [kit?.display_name, kit?.legal_name, kit?.address, kit?.footer_text, snapshot.sponsor.name, snapshot.sponsor.legal_name, snapshot.recipient.name, snapshot.objectives, snapshot.deliverables, ...snapshot.lines.flatMap((l) => [l.label, l.unit, l.promoter]), ...layout.blocks.map((b) => b.text), ...(signatures ?? []).flatMap((s) => [s.name, s.capacity])];
  assertGlyphs(strings, f);
  const accent = hex(kit?.primary_color, '#0F6E56'), ink = hex(kit?.secondary_color, '#444441');
  const doc = new PDFDocument({
    size: layout.paper, layout: layout.orientation, margin: layout.margin_mm * MM, bufferPages: true, compress: true,
    info: { Title: `Sponsorship agreement ${snapshot.ref ?? ''} v${snapshot.terms_version}${signed ? '' : ' (DRAFT)'}`.trim(), Author: kit?.display_name ?? snapshot.sponsor.name ?? 'GotMyGame', CreationDate: new Date(snapshot.generated_at), Producer: 'GotMyGame' },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
  const rule = () => { doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).stroke(accent); doc.y += 12; };

  for (const b of layout.blocks) {
    if (b.type === 'header') {
      const top = doc.page.margins.top; let x = left;
      if (layout.style === 'modern') doc.rect(0, 0, doc.page.width, 10).fill(accent);
      if (logo) { try { doc.image(logo, x, top, { fit: [130, 56] }); x += 140; } catch { throw new AppError(422, 'logo_unreadable', 'The brand logo could not be read. Upload it again as PNG or JPEG.'); } }
      label(kit?.display_name ?? snapshot.sponsor.name ?? '', x, top, width - (x - left), { bold: true, size: 14, color: accent });
      const sub = [kit?.legal_name, kit?.address, [kit?.contact_email, kit?.phone].filter(Boolean).join(' · '), kit?.website].filter(Boolean).join('\n');
      if (sub) label(sub, x, doc.y + 2, width - (x - left), { size: 8 });
      doc.y = Math.max(doc.y, top + (logo ? 60 : 0)) + 14; rule();
    } else if (b.type === 'title') {
      room(60);
      label('SPONSORSHIP AGREEMENT', left, doc.y, width, { bold: true, size: 18, color: accent });
      label(`${snapshot.ref ? `Ref ${snapshot.ref} · ` : ''}Terms version ${snapshot.terms_version}${signed ? ' · SIGNED' : ' · DRAFT — NOT SIGNED'}`, left, doc.y + 2, width, { size: 9, bold: true, color: signed ? accent : '#B42318' });
      const period = [snapshot.period.starts_on && `from ${snapshot.period.starts_on}`, snapshot.period.ends_on && `to ${snapshot.period.ends_on}`].filter(Boolean).join(' ');
      if (period) label(`Period ${period}${snapshot.period.timezone ? ` (${snapshot.period.timezone})` : ''}`, left, doc.y + 2, width, { size: 9 });
      doc.y += 10;
    } else if (b.type === 'parties') {
      room(70);
      const y = doc.y, half = width / 2 - 8;
      label('SPONSOR', left, y, half, { bold: true, size: 8, color: accent });
      label([snapshot.sponsor.name, snapshot.sponsor.legal_name && snapshot.sponsor.legal_name !== snapshot.sponsor.name ? snapshot.sponsor.legal_name : null].filter(Boolean).join('\n'), left, y + 12, half, { size: 10 });
      const endL = doc.y;
      label('RECIPIENT', left + half + 16, y, half, { bold: true, size: 8, color: accent });
      label([snapshot.recipient.name, snapshot.recipient.type].filter(Boolean).join('\n'), left + half + 16, y + 12, half, { size: 10 });
      doc.y = Math.max(endL, doc.y) + 14;
    } else if (b.type === 'lines') {
      room(40);
      label('WHAT THE SPONSOR CONTRIBUTES', left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 4;
      if (!snapshot.lines.length) label('No structured contribution lines were set for this version.', left, doc.y, width, { size: 9 });
      for (const l of snapshot.lines) {
        doc.font(f.bold).fontSize(10); const h = doc.heightOfString(l.label, { width }) + doc.font(f.regular).fontSize(9).heightOfString(describeLine(l), { width }) + 8;
        room(Math.min(h, 90));
        label(l.label, left, doc.y, width, { bold: true, size: 10 });
        label(describeLine(l), left, doc.y + 1, width, { size: 9 });
        doc.y += 6;
      }
      for (const [t, v] of [['OBJECTIVES', snapshot.objectives], ['DELIVERABLES', snapshot.deliverables]]) {
        if (!v) continue;
        room(40); doc.y += 4;
        label(t, left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 4;
        label(v, left, doc.y, width, { size: 9 }); doc.y += 6;
      }
      doc.y += 8;
    } else if (b.type === 'text') {
      room(30); label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8;
    }
  }
  // the signature block is part of every contract (it cannot be templated away): blank lines on a draft, the evidence once signed
  room(signed ? 60 + (signatures.length * 42) : 90);
  doc.y += 6; rule();
  label(signed ? 'SIGNATURES' : 'SIGNATURES (none yet — this draft is not binding)', left, doc.y, width, { bold: true, size: 9, color: signed ? accent : '#B42318' }); doc.y += 6;
  for (const s of signatures ?? []) {
    room(44);
    label(`${s.name} — ${s.side === 'sponsor' ? 'for the sponsor' : 'for the recipient'}${s.capacity ? `, ${s.capacity}` : ''}`, left, doc.y, width, { bold: true, size: 10 });
    label(`Signed ${new Date(s.signed_at).toISOString().replace('T', ' ').slice(0, 19)} UTC · via ${s.provider}${s.provider_ref ? ` (${s.provider_ref})` : ''}`, left, doc.y + 1, width, { size: 8 });
    doc.y += 8;
  }
  doc.y += 4;
  label(`Content fingerprint (SHA-256) ${fingerprint}`, left, doc.y, width, { size: 7 });

  const wantsFooter = layout.blocks.some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - doc.page.margins.bottom - 12;
    doc.page.margins.bottom = 0;
    if (!signed) { doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }); label('DRAFT — NOT SIGNED', left, doc.page.height / 2 - 20, width, { bold: true, size: 34, align: 'center', color: '#F3D4D0', lineBreak: false }); doc.restore(); }
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 160, { size: 8, lineBreak: false });
    label(`Agreement ${snapshot.ref ?? ''} · v${snapshot.terms_version} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

const KIND_TITLE = { ageing: 'Financial ageing', funnel: 'Award funnel', outcomes: 'Beneficiary outcomes', fulfilment: 'Fulfilment', renewals: 'Renewals', roi: 'Sponsorship ROI & exposure', kpi: 'Analytics' };
const SOURCE_MARK = { ok: 'OK', stale: 'STALE', missing: 'MISSING' };

/**
 * Sponsorship portfolio report PDF (#305). Every figure is printed from the report object the dashboard shows (nothing is recalculated here),
 * under the brand kit's name, colours and logo. The reporting date, currency basis, cash/estimate separation and any missing or stale
 * source are printed on the first page, so a printed report can never hide what it was built on.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderSponsorshipReport({ kit, logo, report }) {
  const f = fonts();
  const cols = report.columns;
  const text = (v, c) => (v === null || v === undefined || v === '' ? '' : c.type === 'money' ? toMajor(Number(v), c.currencyOf) : String(v));
  const strings = [kit?.display_name, kit?.legal_name, kit?.address, kit?.footer_text, ...report.basis.notes, ...report.sources.flatMap((s) => [s.label, s.detail]), ...report.rows.flatMap((r) => Object.values(r).filter((v) => typeof v === 'string'))];
  assertGlyphs(strings, f);
  const accent = hex(kit?.primary_color, '#0F6E56'), ink = hex(kit?.secondary_color, '#444441');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, compress: true,
    info: { Title: `${KIND_TITLE[report.kind]} report as of ${report.basis.as_of}`, Author: kit?.display_name ?? 'GotMyGame', CreationDate: new Date(report.basis.generated_at), Producer: 'GotMyGame' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 20;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  let x = left;
  if (logo) { try { doc.image(logo, x, doc.y, { fit: [110, 44] }); x += 120; } catch { throw new AppError(422, 'logo_unreadable', 'The brand logo could not be read. Upload it again as PNG or JPEG.'); } }
  if (kit?.display_name) label(kit.display_name, x, 36, width - (x - left), { bold: true, size: 14, color: accent });
  else if (report.kind === 'kpi') { try { doc.image(ICON, x, 30, { height: 28, width: 28 }); } catch { /* decoration */ } drawWordmark(doc, x + 34, 34, { size: 20 }); label('analytics', x + 34 + 108, 42, 80, { bold: true, size: 9, color: accent }); }
  else label('Sponsorship report', x, 36, width - (x - left), { bold: true, size: 14, color: accent });
  label(report.title ?? `${KIND_TITLE[report.kind]} report`, x, doc.y + 2, width - (x - left), { bold: true, size: 12 });
  label(`As of ${report.basis.as_of} · ${report.basis.currency_basis === 'reporting' ? `converted to ${report.basis.currency} at each agreement's sourced rate` : 'every currency kept apart'} · cash and estimates separate · generated ${report.basis.generated_at.slice(0, 16).replace('T', ' ')} UTC`, x, doc.y + 2, width - (x - left), { size: 8 });
  doc.y = Math.max(doc.y, 36 + (logo ? 48 : 0)) + 8;
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).stroke(accent); doc.y += 8;

  label('DATA SOURCES', left, doc.y, width, { bold: true, size: 8, color: accent }); doc.y += 2;
  for (const s of report.sources) { room(14); label(`${SOURCE_MARK[s.status]}  ${s.label} — ${s.detail}`, left, doc.y + 1, width, { size: 8, bold: s.status !== 'ok', color: s.status === 'ok' ? ink : '#B42318' }); }
  doc.y += 6;
  for (const n of report.basis.notes) { room(12); label(n, left, doc.y, width, { size: 7 }); }
  doc.y += 8;

  if (report.totals.length) {
    room(30); label('TOTALS', left, doc.y, width, { bold: true, size: 8, color: accent }); doc.y += 2;
    for (const t of report.totals) {
      const line = Object.entries(t).filter(([, v]) => v !== null && v !== undefined && v !== false).map(([k, v]) => `${k.replace(/_cents$/, '').replace(/_/g, ' ')} ${k.endsWith('_cents') ? toMajor(Number(v), t.currency) : v}`).join('  ·  ');
      room(14); label(line, left, doc.y + 1, width, { size: 8 });
    }
    doc.y += 8;
  }

  const w = cols.map((c) => (c.type === 'money' ? 62 : c.type === 'int' ? 40 : c.type === 'date' ? 52 : ['recipient', 'sponsor_name', 'label', 'program', 'athlete'].includes(c.key) ? 82 : 58));
  const scale = width / w.reduce((a, b) => a + b, 0);
  const cw = w.map((n) => n * scale);
  const head = () => {
    room(30); let cx = left; const y = doc.y;
    doc.rect(left, y - 2, width, 14).fill(accent);
    cols.forEach((c, i) => { label(c.label, cx + 2, y + 1, cw[i] - 4, { bold: true, size: 6.5, color: '#FFFFFF', align: c.type === 'money' || c.type === 'int' ? 'right' : 'left', lineBreak: false }); cx += cw[i]; });
    doc.y = y + 15;
  };
  head();
  if (!report.rows.length) label('No rows match these filters.', left, doc.y + 4, width, { size: 9 });
  for (const r of report.rows) {
    if (doc.y + 12 > bottom()) { doc.addPage(); head(); }
    let cx = left; const y = doc.y;
    cols.forEach((c, i) => { label(text(r[c.key], { ...c, currencyOf: r.currency }), cx + 2, y, cw[i] - 4, { size: 6.5, align: c.type === 'money' || c.type === 'int' ? 'right' : 'left', lineBreak: false }); cx += cw[i]; });
    doc.y = y + 11;
  }
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 28;
    if (kit?.footer_text) label(kit.footer_text, left, y, width - 160, { size: 7, lineBreak: false });
    label(`${KIND_TITLE[report.kind]} · as of ${report.basis.as_of} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 7, align: 'right', lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * Printable scoring/tracking sheet (#416). The layout comes from the sheet's pinned template version; names and ids come from the sheet
 * (canonical team names when linked). It carries a human-readable reference and a QR with the same signed, non-secret code: the code
 * only locates the template/sheet when the paper is uploaded; it never authorises a result.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderTrackingSheet({ sheet, layout, kit, logo, code, qr, context }) {
  const f = fonts();
  const strings = [...(layout.form ? formStrings(layout.form) : []), kit?.display_name, kit?.footer_text, layout.title, sheet.title, sheet.labels?.home, sheet.labels?.away, context?.event_name, ...layout.scoring.map((s) => s.label), ...layout.stats.map((s) => s.label), ...layout.notes_fields.map((n) => n.label)];
  assertGlyphs(strings, f);
  const accent = hex(kit?.primary_color, '#0F6E56'), ink = hex(kit?.secondary_color, '#222222');
  const doc = new PDFDocument({ size: layout.paper === 'Letter' ? 'LETTER' : 'A4', layout: layout.orientation, margin: 36, bufferPages: true, compress: true,
    info: { Title: `${layout.title} - ${sheet.ref}`, Author: kit?.display_name ?? 'GotMyGame', CreationDate: new Date(sheet.created_at), Producer: 'GotMyGame' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? false });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
  const box = (x, y, w, h) => doc.lineWidth(0.5).strokeColor('#888888').rect(x, y, w, h).stroke();

  // header: logo + title on the left, QR + reference on the right
  let x = left;
  if (logo) { try { doc.image(logo, x, 36, { fit: [90, 40] }); x += 100; } catch { throw new AppError(422, 'logo_unreadable', 'The brand logo could not be read. Upload it again as PNG or JPEG.'); } }
  if (kit?.display_name) label(kit.display_name, x, 36, width - 110, { bold: true, size: 10, color: accent }); else { try { doc.image(ICON, x, 30, { height: 28, width: 28 }); } catch { /* decoration */ } drawWordmark(doc, x + 34, 32, { size: 16 }); }
  label(layout.title, x, 50, width - 110, { bold: true, size: 16 });
  label(sheet.mode === 'linked' ? 'RESULT PROPOSAL - not official until reviewed and approved' : 'UNOFFICIAL - personal tracking sheet', x, 72, width - 110, { size: 8, bold: true, color: '#B42318' });
  if (qr) { // qr = boolean matrix; drawn as vector squares so it prints sharp
    const m = qr.length, cell = 62 / m, ox = left + width - 66, oy = 36;
    doc.rect(ox - 2, oy - 2, 66, 66).fill('#FFFFFF');
    for (let r = 0; r < m; r++) for (let k = 0; k < m; k++) if (qr[r][k]) doc.rect(ox + k * cell, oy + r * cell, cell + 0.2, cell + 0.2).fill('#000000');
  }
  label(sheet.ref, left + width - 190, 38, 118, { size: 9, bold: true, align: 'right' });
  label(code, left + width - 190, 50, 118, { size: 6.5, align: 'right' });
  doc.y = 104;
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.8).stroke(accent); doc.y += 8;

  // who / when
  const meta = [['Date', sheet.occurred_at ? new Date(sheet.occurred_at).toISOString().slice(0, 10) : '____ / ____ / ________'], ['Start time', '___ : ___'], ['End time', '___ : ___'], ['Venue / court', '____________________']];
  if (context?.event_name) meta.unshift(['Event', context.event_name]);
  let cx = left; const mw = width / meta.length, my = doc.y;
  for (const [k, v] of meta) { label(k.toUpperCase(), cx, my, mw - 6, { size: 6.5, color: '#666666' }); label(v, cx, my + 9, mw - 6, { size: 9 }); cx += mw; }
  doc.y = my + 28;
  const home = sheet.labels?.home && sheet.labels.home !== 'Home' ? sheet.labels.home : '', away = sheet.labels?.away && sheet.labels.away !== 'Away' ? sheet.labels.away : '';
  if (!layout.form?.noTeams) {
    const ny = doc.y;
    label('HOME / SIDE A', left, ny, width / 2 - 8, { size: 6.5, color: '#666666' }); label('AWAY / SIDE B', left + width / 2, ny, width / 2 - 8, { size: 6.5, color: '#666666' });
    label(home || '_______________________________', left, ny + 9, width / 2 - 8, { size: 11, bold: true }); label(away || '_______________________________', left + width / 2, ny + 9, width / 2 - 8, { size: 11, bold: true });
    doc.y = ny + 32;
  }

  const grid = (title, cols, rows, o = {}) => {
    room(30 + Math.min(rows, 6) * (o.h ?? 16));
    const gy = doc.y; label(title.toUpperCase(), left, gy, width, { bold: true, size: 8, color: accent }); doc.y = gy + 12;
    const tw = o.width ?? width, cw = cols.map((c) => c.w * tw);
    let y = doc.y; cx = left;
    doc.rect(left, y, tw, 14).fill(accent);
    cols.forEach((c, i) => { label(c.t, cx + 3, y + 3, cw[i] - 6, { bold: true, size: 7, color: '#FFFFFF' }); cx += cw[i]; });
    y += 14;
    for (let r = 0; r < rows; r++) {
      if (y + (o.h ?? 16) > bottom()) { doc.addPage(); y = doc.y; }
      cx = left;
      cols.forEach((c, i) => { box(cx, y, cw[i], o.h ?? 16); if (c.fixed?.[r] != null) label(String(c.fixed[r]), cx + 3, y + 4, cw[i] - 6, { size: 8 }); cx += cw[i]; });
      y += o.h ?? 16;
    }
    doc.y = y + 10;
  };

  if (layout.form) {
    drawForm(layout.form, { doc, left, width, accent, label, box, room, bottom, home, away });
  } else if (layout.mode === 'sets') {
    const n = layout.sets.best_of;
    grid(`Sets - best of ${n}, first to ${layout.sets.points_to_win}${layout.sets.win_by > 1 ? ' (win by 2' + (layout.sets.cap ? `, cap ${layout.sets.cap}` : '') + ')' : ''}`,
      [{ t: 'Set', w: 0.12, fixed: Array.from({ length: n }, (_, i) => i + 1) }, { t: 'Home points', w: 0.22 }, { t: 'Away points', w: 0.22 }, { t: 'Set winner (H / A)', w: 0.2 }, { t: 'Server / side notes', w: 0.24 }], n, { h: 22 });
    grid('Sets won', [{ t: '', w: 0.34, fixed: ['Final sets (home - away)'] }, { t: 'Home', w: 0.33 }, { t: 'Away', w: 0.33 }], 1, { h: 22, width: width * 0.7 });
  } else if (layout.mode === 'points_events') {
    const p = layout.periods;
    grid(`${p.label} scores`, [{ t: p.label, w: 0.2, fixed: Array.from({ length: p.count }, (_, i) => i + 1) }, { t: 'Home', w: 0.4 }, { t: 'Away', w: 0.4 }], p.count + 1, { h: 18, width: width * 0.6 });
    if (layout.scoring.length) grid(`Scoring (${layout.scoring.map((s) => `${s.label} = ${s.points}`).join(', ')})`, [{ t: '#', w: 0.06 }, { t: 'Time', w: 0.1 }, { t: p.label, w: 0.1 }, { t: 'Side (H/A)', w: 0.12 }, { t: 'Scoring event', w: 0.22 }, { t: 'Player', w: 0.3 }, { t: 'Running H-A', w: 0.1 }], 22, { h: 15 });
  } else if (layout.mode === 'results') {
    grid(`Results (${layout.results.unit})`, [{ t: 'Order', w: 0.08 }, { t: 'Lane', w: 0.08 }, { t: 'Participant', w: 0.38 }, { t: layout.results.unit === 'time' ? 'Time' : 'Distance / height', w: 0.2 }, { t: 'DNS / DNF / DQ', w: 0.14 }, { t: 'Rank', w: 0.12 }], layout.results.rows, { h: 18 });
  } else {
    grid('Final totals', [{ t: '', w: 0.4, fixed: ['Result as recorded by the official'] }, { t: 'Home', w: 0.3 }, { t: 'Away', w: 0.3 }], 1, { h: 24, width: width * 0.7 });
  }
  if (layout.stats.length && !(layout.form && (layout.mode === 'manual' || layout.form.noTally))) grid('Tally', [{ t: 'Stat', w: 0.28, fixed: layout.stats.map((s) => s.label) }, { t: 'Home', w: 0.36 }, { t: 'Away', w: 0.36 }], layout.stats.length, { h: 15, width: width * 0.7 });
  for (const n of layout.notes_fields) { room(48); const ny2 = doc.y; label(`${n.label.toUpperCase()}  (custom - not an official field)`, left, ny2, width, { size: 7, color: '#666666' }); box(left, ny2 + 10, width, 28); doc.y = ny2 + 46; }
  room(60); const nty = doc.y; label('NOTES', left, nty, width, { size: 7, color: '#666666' }); box(left, nty + 10, width, 36); doc.y = nty + 56;
  if (layout.signatures) {
    room(44); const roles = sheet.mode === 'linked' ? ['Referee / scorer', 'Home manager', 'Away manager'] : (layout.form?.signatures ?? ['Scorer', 'Home captain', 'Away captain']); const sw = width / roles.length, sy = doc.y;
    roles.forEach((r, i) => { doc.moveTo(left + i * sw + 4, sy + 24).lineTo(left + (i + 1) * sw - 12, sy + 24).lineWidth(0.5).stroke('#888888'); label(r, left + i * sw + 4, sy + 28, sw - 16, { size: 7, color: '#666666' }); });
    doc.y = sy + 40;
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 26;
    label(kit?.footer_text || 'Scores on this sheet are unofficial until a linked result is reviewed and approved in GotMyGame.', left, y, width - 230, { size: 7 });
    label(`${sheet.ref} · template v${context?.template_version ?? 1} · Page ${i + 1} of ${range.count}`, left + width - 230, y, 230, { size: 7, align: 'right' });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

// ─── Shared helpers for new family renderers ───────────────────────────────────────────

function drawLetterhead(doc, { f, accent, ink, kit, logo, left, width, label, layout, snapshot }) {
  const top = doc.page.margins.top; let x = left;
  if (layout?.style === 'modern') doc.rect(0, 0, doc.page.width, 10).fill(accent);
  if (logo) { try { doc.image(logo, x, top, { fit: [130, 56] }); x += 140; } catch { throw new AppError(422, 'logo_unreadable', 'The brand logo could not be read. Upload it again as PNG or JPEG.'); } }
  const displayName = kit?.display_name ?? snapshot?.organisation ?? '';
  if (displayName) doc.font(f.bold).fontSize(14).fillColor(accent).text(displayName, x, top, { width: width - (x - left), lineBreak: false });
  const sub = [kit?.legal_name ?? snapshot?.legal_name, kit?.address ?? snapshot?.address, [kit?.contact_email ?? snapshot?.contact_email, kit?.phone ?? snapshot?.contact_phone].filter(Boolean).join(' · '), kit?.website ?? snapshot?.website].filter(Boolean).join('\n');
  if (sub) label(sub, x, doc.y + 2, width - (x - left), { size: 8 });
  doc.y = Math.max(doc.y, top + (logo ? 60 : 0)) + 14;
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).stroke(accent); doc.y += 12;
}

function drawSignatureBlock(doc, { f, ink, left, width, label, bottom, signers, accent }) {
  const colW = (width - 24) / 2; let sy = doc.y;
  if (sy + 60 > bottom()) { doc.addPage(); sy = doc.page.margins.top; }
  doc.y += 6; label('SIGNATURES', left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 14; sy = doc.y;
  signers.forEach((p, k) => {
    const cx = left + (k % 2) * (colW + 24); if (k % 2 === 0 && k > 0) { sy += 70; if (sy + 70 > bottom()) { doc.addPage(); sy = doc.page.margins.top; } }
    doc.moveTo(cx, sy + 30).lineTo(cx + colW, sy + 30).lineWidth(0.5).stroke(ink);
    label(p.name ?? '', cx, sy + 34, colW, { size: 9, bold: true, lineBreak: false });
    label(`${p.role ?? ''} · Date: ____________`, cx, sy + 46, colW, { size: 8, lineBreak: false });
  });
  doc.y = sy + 70;
}

/**
 * Coaching plan / training schedule PDF. The snapshot is a structured weekly plan from the coaching module.
 * Layout: header, title (athlete, coach, period), activity_table (day/session/drill/duration/notes), text, footer.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderCoachingPlan({ layout, kit, logo, snapshot, sample = false }) {
  const f = fonts();
  const strings = [kit?.display_name, kit?.legal_name, kit?.address, kit?.footer_text, snapshot?.title, snapshot?.athlete_name, snapshot?.coach_name, ...(snapshot?.weeks ?? []).flatMap((w) => w.sessions.flatMap((s) => [s.day, s.session_type, s.drill, s.notes])), ...(layout?.blocks ?? []).map((b) => b.text)];
  assertGlyphs(strings, f);
  const accent = hex(kit?.primary_color, '#8458B3'), ink = hex(kit?.secondary_color, '#494D5F');
  const doc = new PDFDocument({ size: layout?.paper ?? 'A4', layout: layout?.orientation ?? 'portrait', margin: (layout?.margin_mm ?? 18) * MM, bufferPages: true, compress: true, info: { Title: snapshot?.title ?? 'Training plan', Author: kit?.display_name ?? snapshot?.coach_name ?? 'GotMyGame', CreationDate: new Date(), Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  if (sample) label('SAMPLE — preview with made-up data, not a real document', left, Math.max(4, doc.page.margins.top - 14), width, { bold: true, size: 8, color: '#B42318' });

  for (const b of (layout?.blocks ?? [])) {
    if (b.type === 'header') {
      drawLetterhead(doc, { f, accent, ink, kit, logo, left, width, label, layout, snapshot });
    } else if (b.type === 'title') {
      room(50);
      label(snapshot?.title ?? 'Training & Coaching Plan', left, doc.y, width, { bold: true, size: 18, color: accent });
      label([snapshot?.athlete_name && `Athlete: ${snapshot.athlete_name}`, snapshot?.coach_name && `Coach: ${snapshot.coach_name}`, snapshot?.period && `Period: ${snapshot.period.from} to ${snapshot.period.to}`, snapshot?.sport && `Sport: ${snapshot.sport}`, snapshot?.phase && `Phase: ${snapshot.phase}`].filter(Boolean).join(' · '), left, doc.y + 2, width, { size: 9 });
      doc.y += 14;
      if (snapshot?.objectives) { label('OBJECTIVES', left, doc.y, width, { bold: true, size: 8, color: accent }); doc.y += 4; label(snapshot.objectives, left, doc.y, width, { size: 9 }); doc.y += 10; }
    } else if (b.type === 'activity_table') {
      const cols = [{ t: 'Day / Session', w: 0.18 }, { t: 'Session type', w: 0.14 }, { t: 'Drill / Activity', w: 0.30 }, { t: 'Duration', w: 0.09 }, { t: 'Intensity', w: 0.09 }, { t: 'Notes', w: 0.20 }];
      const drawHead = () => {
        room(20); const y = doc.y; doc.rect(left, y - 2, width, 16).fill(accent);
        let cx = left; cols.forEach((c) => { label(c.t, cx + 3, y + 1, width * c.w - 6, { bold: true, size: 7, color: '#FFFFFF', lineBreak: false }); cx += width * c.w; });
        doc.y = y + 16;
      };
      for (const week of (snapshot?.weeks ?? [])) {
        room(30); label(`WEEK ${week.week_number}${week.theme ? ` — ${week.theme}` : ''}`, left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 4;
        drawHead();
        for (const s of week.sessions) {
          const cells = [s.day ?? '', s.session_type ?? '', s.drill ?? '', s.duration ? `${s.duration} min` : '', s.intensity ?? '', s.notes ?? ''];
          doc.font(f.regular).fontSize(8);
          const h = Math.max(14, ...cells.map((c, i) => doc.heightOfString(c || ' ', { width: width * cols[i].w - 6 }) + 4));
          if (doc.y + h > bottom()) { doc.addPage(); drawHead(); }
          let cx = left, y = doc.y;
          cells.forEach((c, i) => { label(c, cx + 3, y + 3, width * cols[i].w - 6, { size: 8, lineBreak: true }); cx += width * cols[i].w; });
          doc.y = y + h;
          doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.3).stroke('#D3D1C7');
        }
        doc.y += 8;
      }
    } else if (b.type === 'text') {
      room(30); label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8;
    }
  }

  const wantsFooter = (layout?.blocks ?? []).some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); const y = doc.page.height - doc.page.margins.bottom - 12; doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 130, { size: 8, lineBreak: false });
    label(`${sample ? 'SAMPLE · ' : ''}${snapshot?.title ?? 'Training plan'} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * Coaching agreement PDF. Parties and engagement terms from the snapshot. Template adds branding, clauses, signature blocks.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderCoachAgreement({ layout, kit, logo, snapshot, sample = false }) {
  const f = fonts();
  assertGlyphs([kit?.display_name, kit?.legal_name, kit?.address, kit?.footer_text, snapshot?.title, snapshot?.venue_name, snapshot?.coach_name, snapshot?.engagement_type, snapshot?.pay_model, snapshot?.body, ...(layout?.blocks ?? []).map((b) => b.text)], f);
  const accent = hex(kit?.primary_color, '#8458B3'), ink = hex(kit?.secondary_color, '#494D5F');
  const doc = new PDFDocument({ size: layout?.paper ?? 'A4', layout: layout?.orientation ?? 'portrait', margin: (layout?.margin_mm ?? 18) * MM, bufferPages: true, compress: true, info: { Title: snapshot?.title ?? 'Coaching agreement', Author: kit?.display_name ?? 'GotMyGame', CreationDate: new Date(), Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  if (sample) label('SAMPLE — template wording, not a real agreement', left, Math.max(4, doc.page.margins.top - 14), width, { bold: true, size: 8, color: '#B42318' });

  for (const b of (layout?.blocks ?? [])) {
    if (b.type === 'header') {
      drawLetterhead(doc, { f, accent, ink, kit, logo, left, width, label, layout, snapshot: { organisation: snapshot?.venue_name } });
    } else if (b.type === 'title') {
      room(50);
      label(snapshot?.title ?? 'Coaching Agreement', left, doc.y, width, { bold: true, size: 20, color: accent });
      label(`${snapshot?.reference ? `Ref ${snapshot.reference} · ` : ''}${snapshot?.status ?? 'Draft'}`, left, doc.y + 2, width, { size: 9, bold: true, color: '#B42318' });
      doc.y += 14;
    } else if (b.type === 'parties') {
      room(60); const y = doc.y, half = width / 2 - 8;
      label('VENUE / EMPLOYER', left, y, half, { bold: true, size: 8, color: accent });
      label([snapshot?.venue_name, snapshot?.venue_address].filter(Boolean).join('\n'), left, y + 12, half, { size: 10 });
      const endL = doc.y;
      label('COACH', left + half + 16, y, half, { bold: true, size: 8, color: accent });
      label([snapshot?.coach_name, snapshot?.coach_sports?.join(', '), snapshot?.coach_email].filter(Boolean).join('\n'), left + half + 16, y + 12, half, { size: 10 });
      doc.y = Math.max(endL, doc.y) + 14;
      const terms = [['Engagement type', snapshot?.engagement_type], ['Sports', snapshot?.coach_sports?.join(', ')], ['Start date', snapshot?.start_date], ['End date', snapshot?.end_date], ['Notice period', snapshot?.notice_period], ['Pay model', snapshot?.pay_model], ['Pay rate', snapshot?.pay_rate], ['Review frequency', snapshot?.review_frequency]].filter(([, v]) => v);
      if (terms.length) {
        label('ENGAGEMENT TERMS', left, doc.y, width, { bold: true, size: 8, color: accent }); doc.y += 4;
        for (const [k, v] of terms) {
          room(16); const ty = doc.y;
          label(k, left, ty, width * 0.3, { bold: true, size: 9 });
          label(String(v), left + width * 0.32, ty, width * 0.68, { size: 9 });
          doc.y = Math.max(doc.y, ty + 14) + 2;
        }
        doc.y += 8;
      }
    } else if (b.type === 'text') {
      room(30);
      if (b.text) { label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8; }
      if (snapshot?.body) {
        for (const para of String(snapshot.body).split(/\n{2,}/)) {
          const t = para.trim(); if (!t) continue; room(24); label(t, left, doc.y, width, { size: 9 }); doc.y += 8;
        }
      }
    } else if (b.type === 'signature_block') {
      drawSignatureBlock(doc, { f, ink, left, width, label, bottom, accent, signers: [{ name: snapshot?.venue_name ?? 'Venue / Employer', role: 'For the venue' }, { name: snapshot?.coach_name ?? 'Coach', role: 'Coach' }] });
    }
  }

  const wantsFooter = (layout?.blocks ?? []).some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); const y = doc.page.height - doc.page.margins.bottom - 12; doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 130, { size: 8, lineBreak: false });
    label(`${sample ? 'SAMPLE · ' : ''}${snapshot?.reference ?? 'Agreement'} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * Referee / official appointment letter. Engagement from the officiating module's snapshot.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderRefereeAppointment({ layout, kit, logo, snapshot, sample = false }) {
  const f = fonts();
  assertGlyphs([kit?.display_name, kit?.legal_name, kit?.footer_text, snapshot?.title, snapshot?.official_name, snapshot?.event_name, snapshot?.role, snapshot?.body, ...(layout?.blocks ?? []).map((b) => b.text)], f);
  const accent = hex(kit?.primary_color, '#8458B3'), ink = hex(kit?.secondary_color, '#494D5F');
  const doc = new PDFDocument({ size: layout?.paper ?? 'A4', layout: layout?.orientation ?? 'portrait', margin: (layout?.margin_mm ?? 18) * MM, bufferPages: true, compress: true, info: { Title: snapshot?.title ?? 'Appointment letter', Author: kit?.display_name ?? 'GotMyGame', CreationDate: new Date(), Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  if (sample) label('SAMPLE — preview only', left, Math.max(4, doc.page.margins.top - 14), width, { bold: true, size: 8, color: '#B42318' });

  for (const b of (layout?.blocks ?? [])) {
    if (b.type === 'header') {
      drawLetterhead(doc, { f, accent, ink, kit, logo, left, width, label, layout, snapshot });
    } else if (b.type === 'title') {
      room(50);
      label(snapshot?.title ?? 'Appointment Letter', left, doc.y, width, { bold: true, size: 18, color: accent });
      label([snapshot?.reference && `Ref ${snapshot.reference}`, snapshot?.issued_date && `Issued ${snapshot.issued_date}`].filter(Boolean).join(' · '), left, doc.y + 2, width, { size: 9 });
      doc.y += 14;
      const facts = [['Official', snapshot?.official_name], ['Role', snapshot?.role], ['Grade / level', snapshot?.grade], ['Event', snapshot?.event_name], ['Venue', snapshot?.venue], ['Date(s)', snapshot?.event_dates], ['Fee', snapshot?.fee], ['Transport', snapshot?.transport_arrangement]].filter(([, v]) => v);
      for (const [k, v] of facts) { room(16); const y = doc.y; label(k, left, y, width * 0.28, { bold: true, size: 9 }); label(String(v), left + width * 0.3, y, width * 0.7, { size: 9 }); doc.y = Math.max(doc.y, y + 14) + 2; }
      doc.y += 8;
      if (snapshot?.body) {
        for (const para of String(snapshot.body).split(/\n{2,}/)) {
          const t = para.trim(); if (!t) continue; room(24); label(t, left, doc.y, width, { size: 10 }); doc.y += 8;
        }
      }
    } else if (b.type === 'parties') {
      room(60); const y = doc.y, half = width / 2 - 8;
      label('ISSUED BY', left, y, half, { bold: true, size: 8, color: accent });
      label([kit?.display_name ?? snapshot?.issuer, kit?.address].filter(Boolean).join('\n'), left, y + 12, half, { size: 10 });
      const endL = doc.y;
      label('OFFICIAL', left + half + 16, y, half, { bold: true, size: 8, color: accent });
      label([snapshot?.official_name, snapshot?.official_grade].filter(Boolean).join('\n'), left + half + 16, y + 12, half, { size: 10 });
      doc.y = Math.max(endL, doc.y) + 14;
    } else if (b.type === 'text') {
      room(30); if (b.text) { label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8; }
    } else if (b.type === 'signature_block') {
      drawSignatureBlock(doc, { f, ink, left, width, label, bottom, accent, signers: [{ name: kit?.display_name ?? snapshot?.issuer ?? 'Issuer', role: 'For the federation / organisation' }, { name: snapshot?.official_name ?? 'Official', role: 'Official (acknowledgement)' }] });
    }
  }

  const wantsFooter = (layout?.blocks ?? []).some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); const y = doc.page.height - doc.page.margins.bottom - 12; doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 130, { size: 8, lineBreak: false });
    label(`${sample ? 'SAMPLE · ' : ''}${snapshot?.reference ?? 'Appointment'} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * Event programme / timetable PDF. The fixture_table block renders slots from the event schedule snapshot.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderEventTimetable({ layout, kit, logo, snapshot, sample = false }) {
  const f = fonts();
  assertGlyphs([kit?.display_name, kit?.footer_text, snapshot?.event_name, snapshot?.venue, ...(snapshot?.slots ?? []).flatMap((s) => [s.time, s.court, s.home, s.away, s.sport, s.round, s.notes]), ...(layout?.blocks ?? []).map((b) => b.text)], f);
  const accent = hex(kit?.primary_color, '#8458B3'), ink = hex(kit?.secondary_color, '#494D5F');
  const isLandscape = layout?.orientation === 'landscape';
  const doc = new PDFDocument({ size: layout?.paper ?? 'A4', layout: layout?.orientation ?? 'landscape', margin: (layout?.margin_mm ?? 15) * MM, bufferPages: true, compress: true, info: { Title: snapshot?.event_name ?? 'Event timetable', Author: kit?.display_name ?? 'GotMyGame', CreationDate: new Date(), Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  if (sample) label('SAMPLE — preview only', left, Math.max(4, doc.page.margins.top - 14), width, { bold: true, size: 8, color: '#B42318' });

  for (const b of (layout?.blocks ?? [])) {
    if (b.type === 'header') {
      drawLetterhead(doc, { f, accent, ink, kit, logo, left, width, label, layout, snapshot: { organisation: snapshot?.organiser } });
    } else if (b.type === 'title') {
      room(50);
      label(snapshot?.event_name ?? 'Event Programme', left, doc.y, width, { bold: true, size: 18, color: accent });
      label([snapshot?.venue, snapshot?.event_date, snapshot?.event_city].filter(Boolean).join(' · '), left, doc.y + 2, width, { size: 10 });
      if (snapshot?.description) { doc.y += 4; label(snapshot.description, left, doc.y, width, { size: 9 }); }
      doc.y += 14;
    } else if (b.type === 'fixture_table') {
      const cols = isLandscape
        ? [{ t: 'Time', w: 0.08 }, { t: 'Court / Field', w: 0.10 }, { t: 'Sport', w: 0.09 }, { t: 'Round', w: 0.09 }, { t: 'Home / Side A', w: 0.22 }, { t: 'Away / Side B', w: 0.22 }, { t: 'Official', w: 0.11 }, { t: 'Notes', w: 0.09 }]
        : [{ t: 'Time', w: 0.10 }, { t: 'Court', w: 0.12 }, { t: 'Round', w: 0.10 }, { t: 'Home', w: 0.26 }, { t: 'Away', w: 0.26 }, { t: 'Notes', w: 0.16 }];
      const drawHead = () => {
        room(18); const y = doc.y; doc.rect(left, y - 2, width, 16).fill(accent);
        let cx = left; cols.forEach((c) => { label(c.t, cx + 3, y + 1, width * c.w - 6, { bold: true, size: 7, color: '#FFFFFF', lineBreak: false }); cx += width * c.w; }); doc.y = y + 16;
      };
      const slots = snapshot?.slots ?? [];
      let currentDay = null;
      for (const s of slots) {
        if (s.day && s.day !== currentDay) {
          room(30); currentDay = s.day;
          label(`DAY: ${s.day}`, left, doc.y, width, { bold: true, size: 10, color: accent }); doc.y += 4;
          drawHead();
        } else if (currentDay === null) { drawHead(); currentDay = ''; }
        const cells = isLandscape
          ? [s.time ?? '', s.court ?? '', s.sport ?? '', s.round ?? '', s.home ?? '', s.away ?? '', s.official ?? '', s.notes ?? '']
          : [s.time ?? '', s.court ?? '', s.round ?? '', s.home ?? '', s.away ?? '', s.notes ?? ''];
        if (doc.y + 14 > bottom()) { doc.addPage(); drawHead(); }
        let cx = left; const y = doc.y;
        cells.forEach((c, i) => { label(c, cx + 3, y + 3, width * cols[i].w - 6, { size: 8, lineBreak: false }); cx += width * cols[i].w; });
        doc.y = y + 14;
        doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.3).stroke('#D3D1C7');
      }
      doc.y += 8;
    } else if (b.type === 'text') {
      room(30); if (b.text) { label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8; }
    }
  }

  const wantsFooter = (layout?.blocks ?? []).some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); const y = doc.page.height - doc.page.margins.bottom - 12; doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 130, { size: 8, lineBreak: false });
    label(`${sample ? 'SAMPLE · ' : ''}${snapshot?.event_name ?? 'Event timetable'} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * Booking confirmation PDF. The booking_block renders canonical booking fields (court, date, time, rate, parties).
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderBookingConfirmation({ layout, kit, logo, snapshot, sample = false }) {
  const f = fonts();
  assertGlyphs([kit?.display_name, kit?.footer_text, snapshot?.booking_ref, snapshot?.venue_name, snapshot?.court_name, snapshot?.customer_name, snapshot?.notes, ...(layout?.blocks ?? []).map((b) => b.text)], f);
  const accent = hex(kit?.primary_color, '#8458B3'), ink = hex(kit?.secondary_color, '#494D5F');
  const doc = new PDFDocument({ size: layout?.paper ?? 'A4', layout: layout?.orientation ?? 'portrait', margin: (layout?.margin_mm ?? 18) * MM, bufferPages: true, compress: true, info: { Title: `Booking ${snapshot?.booking_ref ?? ''}`, Author: kit?.display_name ?? snapshot?.venue_name ?? 'GotMyGame', CreationDate: new Date(), Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  if (sample) label('SAMPLE — not a real booking confirmation', left, Math.max(4, doc.page.margins.top - 14), width, { bold: true, size: 8, color: '#B42318' });

  for (const b of (layout?.blocks ?? [])) {
    if (b.type === 'header') {
      drawLetterhead(doc, { f, accent, ink, kit, logo, left, width, label, layout, snapshot: { organisation: snapshot?.venue_name, address: snapshot?.venue_address } });
    } else if (b.type === 'title') {
      room(50);
      label('BOOKING CONFIRMATION', left, doc.y, width, { bold: true, size: 18, color: accent });
      label(`Ref: ${snapshot?.booking_ref ?? 'N/A'}`, left, doc.y + 2, width, { size: 11, bold: true });
      doc.y += 14;
    } else if (b.type === 'booking_block') {
      const fields = [
        ['Venue', snapshot?.venue_name], ['Court / facility', snapshot?.court_name], ['Sport', snapshot?.sport],
        ['Date', snapshot?.date], ['Start time', snapshot?.start_time], ['End time', snapshot?.end_time],
        ['Duration', snapshot?.duration_minutes ? `${snapshot.duration_minutes} minutes` : null],
        ['Customer', snapshot?.customer_name], ['Contact', snapshot?.customer_email ?? snapshot?.customer_phone],
        ['Booking type', snapshot?.booking_type], ['Status', snapshot?.status],
        ['Rate', snapshot?.rate], ['Total', snapshot?.total], ['Payment status', snapshot?.payment_status],
        ['Cancellation policy', snapshot?.cancellation_policy],
      ].filter(([, v]) => v);
      room(20 + fields.length * 18);
      doc.rect(left, doc.y - 4, width, 18).fill('#F3F4F6'); label('BOOKING DETAILS', left + 6, doc.y, width - 12, { bold: true, size: 9, color: accent }); doc.y += 18;
      for (const [k, v] of fields) {
        room(16); const y = doc.y;
        label(k, left, y, width * 0.3, { bold: true, size: 9 });
        label(String(v), left + width * 0.32, y, width * 0.68, { size: 9 });
        doc.y = Math.max(doc.y, y + 14) + 2;
        doc.moveTo(left, doc.y - 1).lineTo(left + width, doc.y - 1).lineWidth(0.2).stroke('#E5E7EB');
      }
      doc.y += 8;
      if (snapshot?.notes) { room(30); label('NOTES', left, doc.y, width, { bold: true, size: 8, color: accent }); doc.y += 4; label(snapshot.notes, left, doc.y, width, { size: 9 }); doc.y += 10; }
    } else if (b.type === 'text') {
      room(30); if (b.text) { label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8; }
    }
  }

  const wantsFooter = (layout?.blocks ?? []).some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); const y = doc.page.height - doc.page.margins.bottom - 12; doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 130, { size: 8, lineBreak: false });
    label(`${sample ? 'SAMPLE · ' : ''}Booking ${snapshot?.booking_ref ?? ''} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * Rehabilitation / exercise plan PDF. Clinical-access gated; physio-role only.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderRehabPlan({ layout, kit, logo, snapshot, sample = false }) {
  const f = fonts();
  assertGlyphs([kit?.display_name, kit?.footer_text, snapshot?.title, snapshot?.patient_name, snapshot?.physio_name, snapshot?.condition, snapshot?.notes, ...(snapshot?.phases ?? []).flatMap((p) => [p.phase_name, p.goals, ...p.exercises.flatMap((e) => [e.name, e.sets, e.reps, e.duration, e.notes])]), ...(layout?.blocks ?? []).map((b) => b.text)], f);
  const accent = hex(kit?.primary_color, '#8458B3'), ink = hex(kit?.secondary_color, '#494D5F');
  const doc = new PDFDocument({ size: layout?.paper ?? 'A4', layout: layout?.orientation ?? 'portrait', margin: (layout?.margin_mm ?? 18) * MM, bufferPages: true, compress: true, info: { Title: snapshot?.title ?? 'Rehabilitation plan', Author: kit?.display_name ?? snapshot?.physio_name ?? 'GotMyGame', CreationDate: new Date(), Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  if (sample) label('SAMPLE — preview only. Clinical supervision required.', left, Math.max(4, doc.page.margins.top - 14), width, { bold: true, size: 8, color: '#B42318' });

  for (const b of (layout?.blocks ?? [])) {
    if (b.type === 'header') {
      drawLetterhead(doc, { f, accent, ink, kit, logo, left, width, label, layout, snapshot });
    } else if (b.type === 'title') {
      room(60);
      label(snapshot?.title ?? 'Rehabilitation & Exercise Plan', left, doc.y, width, { bold: true, size: 18, color: accent });
      label([snapshot?.patient_name && `Patient: ${snapshot.patient_name}`, snapshot?.physio_name && `Physiotherapist: ${snapshot.physio_name}`, snapshot?.issued_date && `Issued: ${snapshot.issued_date}`, snapshot?.review_date && `Review: ${snapshot.review_date}`].filter(Boolean).join(' · '), left, doc.y + 2, width, { size: 9 });
      doc.y += 10;
      if (snapshot?.condition) { label('Condition / Diagnosis', left, doc.y, width * 0.3, { bold: true, size: 9, color: accent }); label(snapshot.condition, left + width * 0.32, doc.y, width * 0.68, { size: 9 }); doc.y += 14; }
      if (snapshot?.contraindications) { room(20); label('⚠ CONTRAINDICATIONS', left, doc.y, width, { bold: true, size: 9, color: '#B42318' }); doc.y += 4; label(snapshot.contraindications, left, doc.y, width, { size: 9, color: '#B42318' }); doc.y += 10; }
      doc.y += 4;
    } else if (b.type === 'activity_table') {
      const cols = [{ t: 'Exercise / Activity', w: 0.28 }, { t: 'Sets', w: 0.08 }, { t: 'Reps / Duration', w: 0.14 }, { t: 'Load / Resistance', w: 0.14 }, { t: 'Rest', w: 0.08 }, { t: 'Frequency', w: 0.11 }, { t: 'Clinical notes', w: 0.17 }];
      const drawHead = () => {
        room(18); const y = doc.y; doc.rect(left, y - 2, width, 16).fill(accent);
        let cx = left; cols.forEach((c) => { label(c.t, cx + 3, y + 1, width * c.w - 6, { bold: true, size: 7, color: '#FFFFFF', lineBreak: false }); cx += width * c.w; }); doc.y = y + 16;
      };
      for (const phase of (snapshot?.phases ?? [])) {
        room(30); label(`PHASE: ${phase.phase_name}${phase.goals ? ` — ${phase.goals}` : ''}`, left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 4;
        if (phase.duration) { label(`Duration: ${phase.duration}`, left, doc.y, width, { size: 8, color: ink }); doc.y += 4; }
        drawHead();
        for (const e of (phase.exercises ?? [])) {
          const cells = [e.name ?? '', String(e.sets ?? ''), e.reps ? String(e.reps) : e.duration ?? '', e.load ?? '', e.rest ?? '', e.frequency ?? '', e.notes ?? ''];
          if (doc.y + 14 > bottom()) { doc.addPage(); drawHead(); }
          let cx = left; const y = doc.y;
          cells.forEach((c, i) => { label(c, cx + 3, y + 3, width * cols[i].w - 6, { size: 8 }); cx += width * cols[i].w; });
          doc.y = Math.max(doc.y, y + 14);
          doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.3).stroke('#D3D1C7');
        }
        doc.y += 8;
      }
    } else if (b.type === 'text') {
      room(30); if (b.text) { label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8; }
    } else if (b.type === 'signature_block') {
      if (snapshot?.notes) { room(30); label('CLINICAL NOTES', left, doc.y, width, { bold: true, size: 8, color: accent }); doc.y += 4; label(snapshot.notes, left, doc.y, width, { size: 9 }); doc.y += 10; }
      drawSignatureBlock(doc, { f, ink, left, width, label, bottom, accent, signers: [{ name: snapshot?.physio_name ?? 'Physiotherapist', role: 'Physiotherapist (HCPC registered)' }, { name: snapshot?.patient_name ?? 'Patient', role: 'Patient (acknowledgement)' }] });
    }
  }

  const wantsFooter = (layout?.blocks ?? []).some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); const y = doc.page.height - doc.page.margins.bottom - 12; doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 130, { size: 8, lineBreak: false });
    label(`${sample ? 'SAMPLE · ' : ''}${snapshot?.title ?? 'Rehab plan'} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * Approved care plan PDF. Doctor-role only; clinical-access gated.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderCarePlan({ layout, kit, logo, snapshot, sample = false }) {
  const f = fonts();
  assertGlyphs([kit?.display_name, kit?.footer_text, snapshot?.title, snapshot?.patient_name, snapshot?.doctor_name, snapshot?.diagnosis, snapshot?.body, ...(layout?.blocks ?? []).map((b) => b.text)], f);
  const accent = hex(kit?.primary_color, '#8458B3'), ink = hex(kit?.secondary_color, '#494D5F');
  const doc = new PDFDocument({ size: layout?.paper ?? 'A4', layout: layout?.orientation ?? 'portrait', margin: (layout?.margin_mm ?? 18) * MM, bufferPages: true, compress: true, info: { Title: snapshot?.title ?? 'Care plan', Author: kit?.display_name ?? snapshot?.doctor_name ?? 'GotMyGame', CreationDate: new Date(), Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  if (sample) label('SAMPLE — clinical preview only', left, Math.max(4, doc.page.margins.top - 14), width, { bold: true, size: 8, color: '#B42318' });

  for (const b of (layout?.blocks ?? [])) {
    if (b.type === 'header') {
      drawLetterhead(doc, { f, accent, ink, kit, logo, left, width, label, layout, snapshot });
    } else if (b.type === 'title') {
      room(60);
      label(snapshot?.title ?? 'Approved Care Plan', left, doc.y, width, { bold: true, size: 18, color: accent });
      label([snapshot?.patient_name && `Patient: ${snapshot.patient_name}`, snapshot?.dob && `DOB: ${snapshot.dob}`, snapshot?.doctor_name && `Physician: ${snapshot.doctor_name}`, snapshot?.issued_date && `Issued: ${snapshot.issued_date}`, snapshot?.review_date && `Review: ${snapshot.review_date}`].filter(Boolean).join(' · '), left, doc.y + 2, width, { size: 9 });
      doc.y += 14;
      const clinical = [['Diagnosis / condition', snapshot?.diagnosis], ['ICD-10 / SNOMED', snapshot?.code], ['Allergies', snapshot?.allergies], ['Current medication', snapshot?.medication], ['Emergency contact', snapshot?.emergency_contact], ['Emergency phone', snapshot?.emergency_phone]].filter(([, v]) => v);
      for (const [k, v] of clinical) { room(16); const y = doc.y; label(k, left, y, width * 0.28, { bold: true, size: 9 }); label(String(v), left + width * 0.3, y, width * 0.7, { size: 9 }); doc.y = Math.max(doc.y, y + 14) + 2; }
      doc.y += 8;
      if (snapshot?.body) {
        for (const para of String(snapshot.body).split(/\n{2,}/)) {
          const t = para.trim(); if (!t) continue;
          const isHead = /^[A-Z][A-Z\s&]+$/.test(t) && t.length < 60;
          room(isHead ? 30 : 20); label(t, left, doc.y, width, { size: isHead ? 9 : 10, bold: isHead, color: isHead ? accent : ink }); doc.y += isHead ? 6 : 8;
        }
      }
    } else if (b.type === 'text') {
      room(30); if (b.text) { label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8; }
    } else if (b.type === 'signature_block') {
      drawSignatureBlock(doc, { f, ink, left, width, label, bottom, accent, signers: [{ name: snapshot?.doctor_name ?? 'Physician', role: 'Physician (GMC / medical authority)' }, { name: snapshot?.patient_name ?? 'Patient', role: 'Patient (informed consent)' }] });
    }
  }

  const wantsFooter = (layout?.blocks ?? []).some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); const y = doc.page.height - doc.page.margins.bottom - 12; doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 130, { size: 8, lineBreak: false });
    label(`${sample ? 'SAMPLE · ' : ''}${snapshot?.reference ?? 'Care plan'} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * Purchase order / delivery note PDF. Same structure as invoice but for supplier procurement.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderPurchaseOrder({ layout, kit, logo, snapshot, sample = false }) {
  const f = fonts();
  assertGlyphs([kit?.display_name, kit?.footer_text, snapshot?.po_number, snapshot?.supplier_name, snapshot?.buyer_name, ...(snapshot?.lines ?? []).map((l) => l.description), ...(layout?.blocks ?? []).map((b) => b.text)], f);
  const accent = hex(kit?.primary_color, '#8458B3'), ink = hex(kit?.secondary_color, '#494D5F');
  const doc = new PDFDocument({ size: layout?.paper ?? 'A4', layout: layout?.orientation ?? 'portrait', margin: (layout?.margin_mm ?? 18) * MM, bufferPages: true, compress: true, info: { Title: `Purchase order ${snapshot?.po_number ?? ''}`, Author: kit?.display_name ?? snapshot?.buyer_name ?? 'GotMyGame', CreationDate: new Date(), Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  if (sample) label('SAMPLE — not a real purchase order', left, Math.max(4, doc.page.margins.top - 14), width, { bold: true, size: 8, color: '#B42318' });

  for (const b of (layout?.blocks ?? [])) {
    if (b.type === 'header') {
      let x = left;
      if (layout?.style === 'modern') doc.rect(0, 0, doc.page.width, 10).fill(accent);
      if (logo) { try { doc.image(logo, x, doc.page.margins.top, { fit: [130, 56] }); x += 140; } catch { throw new AppError(422, 'logo_unreadable', 'Logo could not be read.'); } }
      label(kit?.display_name ?? snapshot?.buyer_name ?? '', x, doc.page.margins.top, width - (x - left) - 150, { bold: true, size: 14, color: accent });
      label(`PURCHASE ORDER\n${snapshot?.po_number ?? ''}`, left + width - 150, doc.page.margins.top, 150, { bold: true, size: 11, align: 'right', color: ink });
      doc.y = Math.max(doc.y, doc.page.margins.top + (logo ? 60 : 0)) + 14;
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).stroke(accent); doc.y += 12;
    } else if (b.type === 'title') {
      room(50); label(`PURCHASE ORDER ${snapshot?.po_number ?? ''}`, left, doc.y, width, { bold: true, size: 16, color: accent });
      label(`Issued: ${snapshot?.issued_date ?? '—'} · Status: ${snapshot?.status ?? '—'}${snapshot?.delivery_date ? ` · Deliver by: ${snapshot.delivery_date}` : ''}`, left, doc.y + 2, width, { size: 9 }); doc.y += 10;
    } else if (b.type === 'parties') {
      room(60); const y = doc.y, half = width / 2 - 8;
      label('ORDERED BY', left, y, half, { bold: true, size: 8, color: accent });
      label([snapshot?.buyer_name, snapshot?.buyer_address, snapshot?.buyer_tax_id && `Tax ID: ${snapshot.buyer_tax_id}`].filter(Boolean).join('\n'), left, y + 12, half);
      const endL = doc.y;
      label('SUPPLIER', left + half + 16, y, half, { bold: true, size: 8, color: accent });
      label([snapshot?.supplier_name, snapshot?.supplier_address, snapshot?.supplier_tax_id && `Tax ID: ${snapshot.supplier_tax_id}`].filter(Boolean).join('\n'), left + half + 16, y + 12, half);
      doc.y = Math.max(endL, doc.y) + 14;
    } else if (b.type === 'lines') {
      const cols = [{ t: 'Item description', w: width - 230, a: 'left' }, { t: 'Qty', w: 50, a: 'right' }, { t: 'Unit', w: 40, a: 'left' }, { t: 'Unit price', w: 70, a: 'right' }, { t: 'Total', w: 70, a: 'right' }];
      const head = () => { const y = doc.y; doc.rect(left, y - 2, width, 16).fill(accent); let cx = left; cols.forEach((c) => { label(c.t, cx + 3, y + 1, c.w - 6, { bold: true, size: 7.5, color: '#FFFFFF', lineBreak: false }); cx += c.w; }); doc.y = y + 16; };
      head();
      for (const l of (snapshot?.lines ?? [])) {
        const cells = [l.description, String(l.quantity ?? ''), l.unit ?? '', l.unit_price ?? '', l.total ?? ''];
        if (doc.y + 14 > bottom()) { doc.addPage(); head(); }
        let cx = left, y = doc.y;
        cells.forEach((c, i) => { label(c, cx + 3, y + 3, cols[i].w - 6, { size: 9, align: cols[i].a, lineBreak: false }); cx += cols[i].w; });
        doc.y = y + 14; doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.3).stroke('#D3D1C7');
      }
      doc.y += 6;
    } else if (b.type === 'totals') {
      room(70); const tx = left + width - 220, w = 220;
      const sum = (k, v, bold) => { const y = doc.y; label(k, tx, y, 120, { bold }); label(v ?? '', tx + 120, y, 100, { bold, align: 'right' }); doc.y = y + 14; };
      if (snapshot?.subtotal) sum('Subtotal', snapshot.subtotal);
      if (snapshot?.tax_name && snapshot?.tax_amount) sum(`${snapshot.tax_name}`, snapshot.tax_amount);
      doc.moveTo(tx, doc.y).lineTo(tx + w, doc.y).lineWidth(0.6).stroke(accent); doc.y += 4;
      if (snapshot?.total) sum('Total', snapshot.total, true);
      if (snapshot?.delivery_terms) { doc.y += 6; label(`Delivery terms: ${snapshot.delivery_terms}`, left, doc.y, width, { size: 8 }); doc.y += 8; }
    } else if (b.type === 'text') {
      room(30); if (b.text) { label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8; }
    }
  }

  const wantsFooter = (layout?.blocks ?? []).some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); const y = doc.page.height - doc.page.margins.bottom - 12; doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 130, { size: 8, lineBreak: false });
    label(`${sample ? 'SAMPLE · ' : ''}PO ${snapshot?.po_number ?? ''} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * Venue hire agreement PDF. Parties (hirer and venue), terms, signature blocks.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderHireAgreement({ layout, kit, logo, snapshot, sample = false }) {
  const f = fonts();
  assertGlyphs([kit?.display_name, kit?.footer_text, snapshot?.title, snapshot?.venue_name, snapshot?.hirer_name, snapshot?.body, ...(layout?.blocks ?? []).map((b) => b.text)], f);
  const accent = hex(kit?.primary_color, '#8458B3'), ink = hex(kit?.secondary_color, '#494D5F');
  const doc = new PDFDocument({ size: layout?.paper ?? 'A4', layout: layout?.orientation ?? 'portrait', margin: (layout?.margin_mm ?? 18) * MM, bufferPages: true, compress: true, info: { Title: snapshot?.title ?? 'Venue hire agreement', Author: kit?.display_name ?? snapshot?.venue_name ?? 'GotMyGame', CreationDate: new Date(), Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  if (sample) label('SAMPLE — template wording, not a real agreement', left, Math.max(4, doc.page.margins.top - 14), width, { bold: true, size: 8, color: '#B42318' });

  for (const b of (layout?.blocks ?? [])) {
    if (b.type === 'header') {
      drawLetterhead(doc, { f, accent, ink, kit, logo, left, width, label, layout, snapshot: { organisation: snapshot?.venue_name, address: snapshot?.venue_address } });
    } else if (b.type === 'title') {
      room(50);
      label(snapshot?.title ?? 'Venue Hire Agreement', left, doc.y, width, { bold: true, size: 20, color: accent });
      label(`${snapshot?.reference ? `Ref ${snapshot.reference} · ` : ''}${snapshot?.status ?? 'Draft'}${snapshot?.hire_date ? ` · Date: ${snapshot.hire_date}` : ''}`, left, doc.y + 2, width, { size: 9 });
      doc.y += 14;
    } else if (b.type === 'parties') {
      room(80); const y = doc.y, half = width / 2 - 8;
      label('VENUE', left, y, half, { bold: true, size: 8, color: accent });
      label([snapshot?.venue_name, snapshot?.venue_address, snapshot?.venue_contact].filter(Boolean).join('\n'), left, y + 12, half, { size: 10 });
      const endL = doc.y;
      label('HIRER', left + half + 16, y, half, { bold: true, size: 8, color: accent });
      label([snapshot?.hirer_name, snapshot?.hirer_address, snapshot?.hirer_contact, snapshot?.hirer_tax_id && `Tax ID: ${snapshot.hirer_tax_id}`].filter(Boolean).join('\n'), left + half + 16, y + 12, half, { size: 10 });
      doc.y = Math.max(endL, doc.y) + 14;
      const terms = [['Facility hired', snapshot?.facility], ['Purpose', snapshot?.purpose], ['Hire date(s)', snapshot?.hire_date], ['Start time', snapshot?.start_time], ['End time', snapshot?.end_time], ['Setup time', snapshot?.setup_time], ['Capacity', snapshot?.capacity], ['Hire fee', snapshot?.hire_fee], ['Deposit', snapshot?.deposit], ['Cancellation policy', snapshot?.cancellation_policy]].filter(([, v]) => v);
      if (terms.length) {
        label('HIRE DETAILS', left, doc.y, width, { bold: true, size: 8, color: accent }); doc.y += 4;
        for (const [k, v] of terms) { room(16); const ty = doc.y; label(k, left, ty, width * 0.3, { bold: true, size: 9 }); label(String(v), left + width * 0.32, ty, width * 0.68, { size: 9 }); doc.y = Math.max(doc.y, ty + 14) + 2; }
        doc.y += 8;
      }
    } else if (b.type === 'text') {
      room(30);
      if (b.text) { label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8; }
      if (snapshot?.body && b.text === undefined) {
        for (const para of String(snapshot.body).split(/\n{2,}/)) {
          const t = para.trim(); if (!t) continue; room(24); label(t, left, doc.y, width, { size: 9 }); doc.y += 8;
        }
      }
    } else if (b.type === 'signature_block') {
      drawSignatureBlock(doc, { f, ink, left, width, label, bottom, accent, signers: [{ name: snapshot?.venue_name ?? 'Venue', role: 'Venue manager / authorised signatory' }, { name: snapshot?.hirer_name ?? 'Hirer', role: 'Hirer' }] });
    }
  }

  const wantsFooter = (layout?.blocks ?? []).some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); const y = doc.page.height - doc.page.margins.bottom - 12; doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 130, { size: 8, lineBreak: false });
    label(`${sample ? 'SAMPLE · ' : ''}${snapshot?.reference ?? 'Hire agreement'} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * General business letter PDF. Headed letterhead, structured body paragraphs, optional signature block.
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderBusinessLetter({ layout, kit, logo, snapshot, sample = false }) {
  const f = fonts();
  assertGlyphs([kit?.display_name, kit?.legal_name, kit?.address, kit?.footer_text, snapshot?.title, snapshot?.addressee, snapshot?.subject, snapshot?.body, snapshot?.sender_name, ...(layout?.blocks ?? []).map((b) => b.text)], f);
  const accent = hex(kit?.primary_color, '#8458B3'), ink = hex(kit?.secondary_color, '#494D5F');
  const doc = new PDFDocument({ size: layout?.paper ?? 'A4', layout: layout?.orientation ?? 'portrait', margin: (layout?.margin_mm ?? 18) * MM, bufferPages: true, compress: true, info: { Title: snapshot?.subject ?? 'Business letter', Author: kit?.display_name ?? snapshot?.sender_name ?? 'GotMyGame', CreationDate: new Date(), Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  if (sample) label('SAMPLE — preview only', left, Math.max(4, doc.page.margins.top - 14), width, { bold: true, size: 8, color: '#B42318' });

  for (const b of (layout?.blocks ?? [])) {
    if (b.type === 'header') {
      drawLetterhead(doc, { f, accent, ink, kit, logo, left, width, label, layout, snapshot });
    } else if (b.type === 'title') {
      room(50);
      if (snapshot?.date) { label(snapshot.date, left + width - 120, doc.y, 120, { size: 9, align: 'right', lineBreak: false }); doc.y += 14; }
      if (snapshot?.addressee) { label(snapshot.addressee, left, doc.y, width, { size: 10 }); doc.y += 14; }
      if (snapshot?.subject) { label(`Re: ${snapshot.subject}`, left, doc.y, width, { bold: true, size: 11, color: accent }); doc.y += 14; }
      if (snapshot?.salutation) { label(snapshot.salutation, left, doc.y, width, { size: 10 }); doc.y += 10; }
    } else if (b.type === 'parties') {
      room(50); const y = doc.y, half = width / 2 - 8;
      label('FROM', left, y, half, { bold: true, size: 8, color: accent });
      label([kit?.display_name ?? snapshot?.sender_name, kit?.legal_name, kit?.address, [kit?.contact_email, kit?.phone].filter(Boolean).join(' · ')].filter(Boolean).join('\n'), left, y + 12, half, { size: 9 });
      const endL = doc.y;
      if (snapshot?.addressee_org) {
        label('TO', left + half + 16, y, half, { bold: true, size: 8, color: accent });
        label([snapshot?.addressee, snapshot?.addressee_org, snapshot?.addressee_address].filter(Boolean).join('\n'), left + half + 16, y + 12, half, { size: 9 });
      }
      doc.y = Math.max(endL, doc.y) + 14;
    } else if (b.type === 'text') {
      room(30);
      if (b.text) { label(b.text, left, doc.y, width, { size: TEXT_SIZE[b.size] ?? 9, align: b.align }); doc.y += 8; }
      if (snapshot?.body && b.text === undefined) {
        for (const para of String(snapshot.body).split(/\n{2,}/)) {
          const t = para.trim(); if (!t) continue; room(24); label(t, left, doc.y, width, { size: 10 }); doc.y += 8;
        }
        if (snapshot?.closing) { doc.y += 4; label(snapshot.closing, left, doc.y, width, { size: 10 }); doc.y += 4; }
        if (snapshot?.sender_name) { doc.y += 20; label(snapshot.sender_name, left, doc.y, width, { bold: true, size: 10 }); if (snapshot?.sender_title) label(snapshot.sender_title, left, doc.y, width, { size: 9 }); doc.y += 8; }
      }
    } else if (b.type === 'signature_block') {
      drawSignatureBlock(doc, { f, ink, left, width, label, bottom, accent, signers: [{ name: snapshot?.sender_name ?? kit?.display_name ?? 'Sender', role: snapshot?.sender_title ?? 'Authorised signatory' }] });
    }
  }

  const wantsFooter = (layout?.blocks ?? []).some((b) => b.type === 'footer');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); const y = doc.page.height - doc.page.margins.bottom - 12; doc.page.margins.bottom = 0;
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 130, { size: 8, lineBreak: false });
    label(`${sample ? 'SAMPLE · ' : ''}${snapshot?.reference ?? 'Letter'} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * The rulebook as a printable booklet: one card per rule, local changes marked against the standard. Text comes from the catalogue
 * (rulebook/catalog.js) and the local values it is given; nothing is computed here.
 */
export async function renderRulebook({ book, local, link = null, generatedAt = new Date() }) {
  const f = fonts();
  assertGlyphs([book.name, book.body, book.note, local?.name, ...book.cards.flatMap((c) => [c.no, c.title, c.body, ...(c.points ?? []), ...c.params.flatMap((p) => [p.label, String(p.value), String(p.std)])])], f);
  const accent = '#8458B3', ink = '#2A2D3A', mute = '#5F6580', wash = '#F1EEF8', rule = '#CDD5E8', warn = '#B54708';
  const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true, compress: true, info: { Title: `${book.name} rulebook`, Author: 'GotMyGame', Producer: 'GotMyGame', CreationDate: generatedAt } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const text = (t, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9.5).fillColor(o.color ?? ink).text(t, left + (o.indent ?? 0), o.y ?? doc.y, { width: (o.w ?? width) - (o.indent ?? 0), lineGap: o.gap ?? 1.5, align: o.align ?? 'left' });
  const room = (h) => { if (doc.y + h > doc.page.height - doc.page.margins.bottom - 24) { doc.addPage(); doc.y = doc.page.margins.top; } };
  const nice = (v, unit) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : `${v}${unit ? ` ${unit}` : ''}`);
  const h2 = (t) => { room(48); doc.moveDown(0.8); text(t.toUpperCase(), { bold: true, size: 9, color: accent }); doc.moveTo(left, doc.y + 1).lineTo(left + width, doc.y + 1).lineWidth(0.8).stroke(accent); doc.moveDown(0.6); };
  const day = generatedAt.toISOString().slice(0, 10);
  const params = book.cards.flatMap((c) => c.params.map((p) => ({ ...p, card: c })));
  const points = book.cards.reduce((n, c) => n + (c.points?.length ?? 0), 0);
  const handbook = points > 0;

  // ---- cover
  doc.rect(0, 0, doc.page.width, 150).fill(accent);
  doc.font(f.bold).fontSize(9).fillColor('#FFFFFF').text(handbook ? "MATCH OFFICIALS' HANDBOOK" : 'RULEBOOK SUMMARY', left, 46, { width, characterSpacing: 1.2 });
  doc.font(f.bold).fontSize(30).fillColor('#FFFFFF').text(book.name, left, 62, { width });
  doc.font(f.regular).fontSize(11).fillColor('#FFFFFF').text(`${book.format ? `${book.format} format   |   ` : ''}${book.body}`, left, 104, { width });
  doc.y = 168;
  const facts = [['Rules', String(book.cards.length)], ['Decision points', handbook ? String(points) : 'Not yet written'], ['Local settings', String(params.length)], ['Changed locally', String(book.changes.length)]];
  const fy = doc.y;
  doc.roundedRect(left, fy, width, 46, 6).fill(wash);
  facts.forEach(([k, v], i) => {
    const x = left + 12 + (i * (width - 24)) / facts.length, w = (width - 24) / facts.length - 6;
    doc.font(f.bold).fontSize(7).fillColor(mute).text(k.toUpperCase(), x, fy + 9, { width: w, lineBreak: false });
    doc.font(f.bold).fontSize(13).fillColor(ink).text(v, x, fy + 21, { width: w, lineBreak: false });
  });
  doc.y = fy + 58;
  h2('Document control');
  const ctl = [['Source', book.body], ['Official publication', link?.verified ? link.url : 'Ask the governing body named above for its current edition.'], ['Rules in force', local ? `${local.name} (${local.scope}, version ${local.version}${local.by ? `, published by ${local.by}` : ''})` : 'The standard rules, with no local changes'], ['Generated', day], ['Status', handbook ? 'Summary cards with officials\' decision points for every rule.' : 'Summary cards. Officials\' decision points for this sport are not written yet.']];
  for (const [k, v] of ctl) { const y = doc.y; text(k, { bold: true, size: 8.5, color: mute, w: 120 }); doc.y = y; text(v, { indent: 124, size: 9 }); doc.moveDown(0.25); }
  doc.moveDown(0.3);
  text(book.note, { size: 8.5, color: mute });

  h2('Contents');
  book.cards.forEach((c) => { room(14); const y = doc.y; text(c.no, { bold: true, size: 9, color: mute, w: 90 }); doc.y = y; text(`${c.title}${c.params.some((p) => p.changed) ? '   (local change)' : ''}`, { indent: 92, size: 9.5 }); });

  // ---- settings in force
  if (params.length) {
    h2('Settings in force');
    const col = [left, left + 70, left + 262, left + 386];
    const head = doc.y;
    doc.rect(left, head - 3, width, 16).fill(wash);
    [['RULE', 0], ['SETTING', 1], ['IN FORCE', 2], ['STANDARD', 3]].forEach(([t, i]) => doc.font(f.bold).fontSize(7).fillColor(mute).text(t, col[i] + 4, head + 1, { lineBreak: false }));
    doc.y = head + 17;
    for (const p of params) {
      room(16); const y = doc.y;
      doc.font(f.regular).fontSize(8.5).fillColor(mute).text(p.card.no, col[0] + 4, y, { width: 62, height: 10, ellipsis: true });
      doc.font(f.regular).fontSize(8.5).fillColor(ink).text(p.label, col[1] + 4, y, { width: 184, height: 10, ellipsis: true });
      doc.font(f.bold).fontSize(8.5).fillColor(p.changed ? warn : ink).text(nice(p.value, p.unit), col[2] + 4, y, { width: 118, height: 10, ellipsis: true });
      doc.font(f.regular).fontSize(8.5).fillColor(mute).text(nice(p.std, p.unit), col[3] + 4, y, { width: width - 392, height: 10, ellipsis: true });
      doc.y = y + 13; doc.moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).lineWidth(0.3).stroke(rule);
    }
  }

  // ---- the rules
  doc.addPage(); doc.y = doc.page.margins.top;
  text('The rules', { bold: true, size: 18, color: accent });
  text(local ? `As played under ${local.name}. Settings that differ from the standard are marked LOCAL.` : 'Standard rules.', { size: 9, color: local ? warn : mute });
  doc.moveDown(0.6);
  for (const c of book.cards) {
    const changed = c.params.some((p) => p.changed);
    room(70 + c.body.length / 5);
    const y0 = doc.y;
    doc.font(f.bold).fontSize(7.5).fillColor(mute).text(c.no.toUpperCase(), left, y0 + 2, { width: 90 });
    doc.font(f.bold).fontSize(12.5).fillColor(accent).text(c.title, left + 92, y0, { width: width - 92 });
    doc.y = Math.max(doc.y, y0 + 15);
    text(c.body, { indent: 92 });
    for (const pt of c.points ?? []) {
      room(doc.font(f.regular).fontSize(9).heightOfString(pt, { width: width - 104 }) + 4);
      const y = doc.y + 3;
      doc.circle(left + 96, y + 3.5, 1.4).fill(accent);
      doc.font(f.regular).fontSize(9).fillColor(ink).text(pt, left + 104, y, { width: width - 104, lineGap: 1.2 });
    }
    if (c.params.length) doc.moveDown(0.2);
    for (const p of c.params) text(`${p.changed ? 'LOCAL' : 'Setting'}: ${p.label} ${nice(p.value, p.unit)}${p.changed ? `   (standard ${nice(p.std, p.unit)})` : ''}`, { indent: 92, bold: p.changed, size: 8.5, color: p.changed ? warn : mute });
    doc.moveDown(0.35);
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(changed ? 1 : 0.4).stroke(changed ? warn : rule);
    doc.moveDown(0.55);
  }
  text(book.note, { size: 8, color: mute });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    doc.font(f.regular).fontSize(7).fillColor(mute).text(`${book.name} ${handbook ? "officials' handbook" : 'rulebook summary'} - generated ${day} - page ${i + 1} of ${range.count}`, left, doc.page.height - 28, { width, align: 'right', lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}
