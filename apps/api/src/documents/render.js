// Invoice PDF renderer (pdfkit). Layout comes from a validated template; every figure comes from the canonical invoice row and is only
// formatted here - nothing is recalculated. The same function renders previews (sample data, labelled SAMPLE) and issued documents.
import PDFDocument from 'pdfkit';
import { AppError } from '../errors.js';
import { toMajor } from '../currency.js';

const MM = 72 / 25.4;
const BASE_FONTS = { regular: 'Helvetica', bold: 'Helvetica-Bold' };
const fonts = () => ({ regular: process.env.DOC_FONT_REGULAR || BASE_FONTS.regular, bold: process.env.DOC_FONT_BOLD || process.env.DOC_FONT_REGULAR || BASE_FONTS.bold, unicode: !!process.env.DOC_FONT_REGULAR });
// What the built-in PDF fonts can show (Latin-1 plus common punctuation). Anything else needs DOC_FONT_REGULAR (e.g. Noto Sans Tamil).
const BASIC = /^[ -~ -ÿ‐-‟•…€\n]*$/;

const TEXT_SIZE = { small: 8, normal: 9, large: 12 };
const money = (cents, cur) => `${cur} ${toMajor(cents, cur)}`;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const hex = (c, d) => (/^#[0-9A-Fa-f]{6}$/.test(c ?? '') ? c : d);

function assertGlyphs(strings, f) {
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
  const title = invoice.kind === 'credit_note' ? 'CREDIT NOTE' : 'INVOICE';
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
