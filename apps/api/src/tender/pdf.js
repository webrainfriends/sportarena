// Tender PDF renderer (pdfkit). One layout for every tender document family: branded header, status stamp, label/value blocks, tables with
// repeated headers across pages, and page numbers. Everything printed comes from an immutable snapshot; nothing is recalculated here.
import PDFDocument from 'pdfkit';
import { assertGlyphs, fonts } from '../documents/render.js';

const hex = (c, d) => (/^#[0-9A-Fa-f]{6}$/.test(c ?? '') ? c : d);
const MARGIN = 42;
const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : String(v));

/**
 * doc: { title, subtitle?, reference, stamp ('ISSUED'|'DRAFT'), issued_at, kit: {display_name, legal_name, address, primary_color, footer_text}|null,
 *        sections: [{ heading, text?, rows?: [[label, value]], table?: { head: [..], rows: [[..]], widths?: [fractions], align?: ['l'|'r'] } }], footnote? }
 * @returns {Promise<{ buffer: Buffer, pages: number }>}
 */
export async function renderTenderDocument(doc) {
  const f = fonts();
  const strings = [doc.title, doc.subtitle, doc.reference, doc.kit?.display_name, doc.kit?.legal_name, doc.kit?.address, doc.kit?.footer_text, doc.footnote, ...doc.sections.flatMap((s) => [s.heading, s.text, ...(s.rows ?? []).flat().map(fmt), ...(s.table ? [...s.table.head, ...s.table.rows.flat().map(fmt)] : [])])].filter(Boolean).map(String);
  assertGlyphs(strings, f);
  const accent = hex(doc.kit?.primary_color, '#B4182D');
  const pdf = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, compress: true, info: { Title: `${doc.title} ${doc.reference}`, Author: doc.kit?.display_name ?? 'Sportarena', CreationDate: new Date(doc.issued_at), Producer: 'Sportarena' } });
  const chunks = [];
  pdf.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { pdf.on('end', res); pdf.on('error', rej); });
  const left = MARGIN, width = pdf.page.width - MARGIN * 2;
  const bottom = () => pdf.page.height - MARGIN - 26;
  const text = (t, x, y, w, o = {}) => pdf.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? '#181A2F').text(String(t ?? ''), x, y, { width: w, align: o.align ?? 'left', lineGap: o.gap ?? 1.5 });

  pdf.rect(0, 0, pdf.page.width, 8).fill(accent);
  text(doc.kit?.display_name ?? 'Sportarena', left, MARGIN - 8, width - 150, { bold: true, size: 14, color: accent });
  const sub = [doc.kit?.legal_name, doc.kit?.address].filter(Boolean).join(' · ');
  if (sub) text(sub, left, pdf.y + 1, width - 150, { size: 8, color: '#5B6480' });
  text(`${doc.stamp ?? 'ISSUED'}\n${doc.reference}`, left + width - 150, MARGIN - 8, 150, { bold: true, size: 10, align: 'right', color: doc.stamp === 'DRAFT' ? '#8A5A00' : '#181A2F' });
  pdf.moveDown(0.6);
  let y = Math.max(pdf.y, MARGIN + 34) + 10;
  text(doc.title, left, y, width, { bold: true, size: 17 });
  if (doc.subtitle) text(doc.subtitle, left, pdf.y + 2, width, { size: 10, color: '#5B6480' });
  y = pdf.y + 12;

  const ensure = (h) => { if (y + h > bottom()) { pdf.addPage(); y = MARGIN; } };

  for (const s of doc.sections) {
    ensure(40);
    text(s.heading, left, y, width, { bold: true, size: 11, color: accent });
    y = pdf.y + 4;
    pdf.moveTo(left, y).lineTo(left + width, y).lineWidth(0.6).strokeColor('#F1D9CC').stroke();
    y += 6;
    if (s.text) { const h = pdf.heightOfString(s.text, { width }); ensure(h + 6); text(s.text, left, y, width); y = pdf.y + 6; }
    for (const [k, v] of s.rows ?? []) {
      const vs = fmt(v), h = Math.max(pdf.heightOfString(vs, { width: width * 0.68 }), 11);
      ensure(h + 4);
      text(k, left, y, width * 0.3, { color: '#5B6480', size: 8.5 });
      text(vs, left + width * 0.32, y, width * 0.68, { bold: false, size: 9 });
      y += h + 4;
    }
    if (s.table) {
      const w = (s.table.widths ?? s.table.head.map(() => 1 / s.table.head.length)).map((x) => x * width);
      const align = s.table.align ?? [];
      const head = () => {
        ensure(26);
        pdf.rect(left, y - 2, width, 16).fill('#FFF4EE');
        let x = left;
        s.table.head.forEach((h, i) => { text(h, x + 3, y + 1, w[i] - 6, { bold: true, size: 7.5, color: '#5B6480', align: align[i] === 'r' ? 'right' : 'left' }); x += w[i]; });
        y += 18;
      };
      head();
      for (const row of s.table.rows) {
        const hs = row.map((c, i) => pdf.heightOfString(fmt(c), { width: w[i] - 6 }));
        const h = Math.max(...hs, 10) + 5;
        if (y + h > bottom()) { pdf.addPage(); y = MARGIN; head(); }
        let x = left;
        row.forEach((c, i) => { text(fmt(c), x + 3, y, w[i] - 6, { size: 8.5, align: align[i] === 'r' ? 'right' : 'left' }); x += w[i]; });
        y += h;
        pdf.moveTo(left, y - 2).lineTo(left + width, y - 2).lineWidth(0.3).strokeColor('#F1D9CC').stroke();
      }
      y += 4;
    }
    y += 8;
  }
  if (doc.footnote) { ensure(30); text(doc.footnote, left, y, width, { size: 8, color: '#5B6480' }); }

  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    pdf.moveTo(left, pdf.page.height - MARGIN - 8).lineTo(left + width, pdf.page.height - MARGIN - 8).lineWidth(0.4).strokeColor('#F1D9CC').stroke();
    pdf.font(f.regular).fontSize(7.5).fillColor('#5B6480').text(`${doc.kit?.footer_text ?? 'Generated by Sportarena'} · ${doc.reference}`, left, pdf.page.height - MARGIN - 2, { width: width - 60, lineBreak: false });
    pdf.text(`Page ${i + 1} of ${range.count}`, left + width - 60, pdf.page.height - MARGIN - 2, { width: 60, align: 'right', lineBreak: false });
  }
  pdf.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}
