// Invoice PDF renderer (pdfkit). Layout comes from a validated template; every figure comes from the canonical invoice row and is only
// formatted here - nothing is recalculated. The same function renders previews (sample data, labelled SAMPLE) and issued documents.
import PDFDocument from 'pdfkit';
import { AppError } from '../errors.js';
import { toMajor } from '../currency.js';
import { drawForm } from './sheet-forms.js';
import { formStrings } from '../tracking/forms.js';

const MM = 72 / 25.4;
const BASE_FONTS = { regular: 'Helvetica', bold: 'Helvetica-Bold' };
export const fonts = () => ({ regular: process.env.DOC_FONT_REGULAR || BASE_FONTS.regular, bold: process.env.DOC_FONT_BOLD || process.env.DOC_FONT_REGULAR || BASE_FONTS.bold, unicode: !!process.env.DOC_FONT_REGULAR });
// What the built-in PDF fonts can show (Latin-1 plus common punctuation). Anything else needs DOC_FONT_REGULAR (e.g. Noto Sans Tamil).
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
    info: { Title: `${invoice.kind === 'credit_note' ? 'Credit note' : 'Invoice'} ${invoice.number}`, Author: kit?.display_name ?? invoice.seller?.name ?? 'Sportarena', CreationDate: new Date(invoice.issued_at), Producer: 'Sportarena' },
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
  for (const sec of snapshot.sections) strings.push(sec.title, sec.body, ...(sec.items ?? []).flatMap((x) => [x.title, x.meta, x.body, x.value]));
  assertGlyphs(strings, f);
  const accent = hex(kit?.primary_color, '#0F6E56'), ink = hex(kit?.secondary_color, '#444441');
  const doc = new PDFDocument({
    size: layout.paper, layout: layout.orientation, margin: layout.margin_mm * MM, bufferPages: true, compress: true,
    info: { Title: snapshot.title, Author: kit?.display_name ?? snapshot.coach_name ?? 'Sportarena', CreationDate: new Date(snapshot.published_at), Producer: 'Sportarena' },
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
    info: { Title: snapshot.title, Author: kit?.display_name ?? snapshot.organisation, CreationDate: new Date(snapshot.issued_at), Producer: 'Sportarena' },
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
    info: { Title: `Sponsorship agreement ${snapshot.ref ?? ''} v${snapshot.terms_version}${signed ? '' : ' (DRAFT)'}`.trim(), Author: kit?.display_name ?? snapshot.sponsor.name ?? 'Sportarena', CreationDate: new Date(snapshot.generated_at), Producer: 'Sportarena' },
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

const KIND_TITLE = { ageing: 'Financial ageing', funnel: 'Award funnel', outcomes: 'Beneficiary outcomes', fulfilment: 'Fulfilment', renewals: 'Renewals' };
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
    info: { Title: `${KIND_TITLE[report.kind]} report as of ${report.basis.as_of}`, Author: kit?.display_name ?? 'Sportarena', CreationDate: new Date(report.basis.generated_at), Producer: 'Sportarena' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 20;
  const label = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  let x = left;
  if (logo) { try { doc.image(logo, x, doc.y, { fit: [110, 44] }); x += 120; } catch { throw new AppError(422, 'logo_unreadable', 'The brand logo could not be read. Upload it again as PNG or JPEG.'); } }
  label(kit?.display_name ?? 'Sponsorship report', x, 36, width - (x - left), { bold: true, size: 14, color: accent });
  label(`${KIND_TITLE[report.kind]} report`, x, doc.y + 2, width - (x - left), { bold: true, size: 12 });
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
    info: { Title: `${layout.title} - ${sheet.ref}`, Author: kit?.display_name ?? 'Sportarena', CreationDate: new Date(sheet.created_at), Producer: 'Sportarena' } });
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
  label(kit?.display_name ?? 'Sportarena', x, 36, width - 110, { bold: true, size: 10, color: accent });
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
    label(kit?.footer_text || 'Scores on this sheet are unofficial until a linked result is reviewed and approved in SportArena.', left, y, width - 230, { size: 7 });
    label(`${sheet.ref} · template v${context?.template_version ?? 1} · Page ${i + 1} of ${range.count}`, left + width - 230, y, 230, { size: 7, align: 'right' });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}

/**
 * The rulebook as a printable booklet: one card per rule, local changes marked against the standard. Text comes from the catalogue
 * (rulebook/catalog.js) and the local values it is given; nothing is computed here.
 */
export async function renderRulebook({ book, local }) {
  const f = fonts();
  assertGlyphs([book.name, book.body, book.note, local?.name, ...book.cards.flatMap((c) => [c.no, c.title, c.body, ...c.params.flatMap((p) => [p.label, String(p.value), String(p.std)])])], f);
  const accent = '#0F6E56', ink = '#222222';
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, compress: true, info: { Title: `${book.name} rulebook`, Author: 'Sportarena', Producer: 'Sportarena' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const text = (t, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9.5).fillColor(o.color ?? ink).text(t, left + (o.indent ?? 0), doc.y, { width: width - (o.indent ?? 0), lineGap: o.gap ?? 1.5 });
  const room = (h) => { if (doc.y + h > doc.page.height - doc.page.margins.bottom - 20) doc.addPage(); };
  const nice = (v, unit) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : `${v}${unit ? ` ${unit}` : ''}`);

  text(book.name, { bold: true, size: 22, color: accent });
  text(`${book.format ? `${book.format} · ` : ''}Source: ${book.body}`, { size: 9, color: '#555555' });
  text(`Official book: ${book.official_url}`, { size: 8, color: '#555555' });
  doc.moveDown(0.4);
  if (local) text(`Local rules in force: ${local.name} (${local.scope}, version ${local.version}). Changed settings are marked against the standard.`, { bold: true, size: 9, color: '#B54708' });
  else text('Standard rules.', { size: 9, color: '#555555' });
  doc.moveDown(0.6);

  for (const c of book.cards) {
    const changed = c.params.some((p) => p.changed);
    room(60 + c.body.length / 5);
    const y0 = doc.y;
    doc.font(f.bold).fontSize(7.5).fillColor('#666666').text(c.no.toUpperCase(), left, y0, { width: 90 });
    doc.font(f.bold).fontSize(12).fillColor(accent).text(c.title, left + 92, y0, { width: width - 92 });
    doc.y = Math.max(doc.y, y0 + 14);
    text(c.body, { indent: 92 });
    for (const p of c.params) text(`${p.changed ? 'LOCAL' : 'Setting'}: ${p.label} ${nice(p.value, p.unit)}${p.changed ? `   (standard ${nice(p.std, p.unit)})` : ''}`, { indent: 92, bold: p.changed, size: 8.5, color: p.changed ? '#B54708' : '#555555' });
    doc.moveDown(0.3);
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(changed ? 1 : 0.4).stroke(changed ? '#B54708' : '#CCCCCC');
    doc.moveDown(0.5);
  }
  text(book.note, { size: 8, color: '#666666' });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    doc.font(f.regular).fontSize(7).fillColor('#666666').text(`${book.name} rulebook · Page ${i + 1} of ${range.count}`, left, doc.page.height - 28, { width, align: 'right', lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}
