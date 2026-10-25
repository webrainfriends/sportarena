// One generic PDF renderer for every supplier-services document (RFQ, comparison, quote, service order, agreement, job sheet, timesheet, service receipt,
// completion report, receipt, supplier statement). Content comes from a source-authoritative snapshot built by the capability; this file only lays it out:
// multi-page tables with repeated headers, page numbers, a visible DRAFT / pro forma watermark, and the brand kit's name, colours and logo.
import PDFDocument from 'pdfkit';
import { fonts, assertGlyphs } from './render.js';

const MM = 72 / 25.4;
const hex = (c, d) => (/^#[0-9A-Fa-f]{6}$/.test(c ?? '') ? c : d);

/**
 * @param {{doc: {title:string, number?:string, status?:string, watermark?:string, issued_at?:string, parties?:{label:string, lines:string[]}[],
 *   sections?:({heading?:string, kind:'table', columns:{t:string, w:number, a?:string}[], rows:string[][]}|{heading?:string, kind:'kv', rows:string[][]}|{heading?:string, kind:'text', text:string})[],
 *   totals?:[string,string,boolean?][], footnote?:string}, kit?:object|null, logo?:Buffer|null}} a
 * @returns {Promise<{buffer: Buffer, pages: number}>}
 */
export async function renderServiceDocument({ doc: d, kit = null, logo = null }) {
  const f = fonts();
  const strings = [kit?.display_name, kit?.legal_name, kit?.address, kit?.footer_text, d.title, d.number, d.footnote, ...(d.parties ?? []).flatMap((p) => p.lines), ...(d.sections ?? []).flatMap((s) => (s.kind === 'text' ? [s.text, s.heading] : [s.heading, ...(s.rows ?? []).flat(), ...(s.columns ?? []).map((c) => c.t)]))];
  assertGlyphs(strings.map((x) => (x == null ? '' : String(x))), f);
  const accent = hex(kit?.primary_color, '#0F6E56'), ink = hex(kit?.secondary_color, '#444441');
  const pdf = new PDFDocument({ size: 'A4', margin: 15 * MM, bufferPages: true, compress: true, info: { Title: `${d.title}${d.number ? ` ${d.number}` : ''}`, Author: kit?.display_name ?? 'Sportarena', CreationDate: new Date(d.issued_at ?? Date.now()) } });
  const chunks = []; pdf.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { pdf.on('end', res); pdf.on('error', rej); });
  const left = pdf.page.margins.left, width = pdf.page.width - left - pdf.page.margins.right;
  const bottom = () => pdf.page.height - pdf.page.margins.bottom - 24;
  const text = (t, x, y, w, o = {}) => pdf.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(String(t ?? ''), x, y, { width: w, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });

  const header = () => {
    let x = left;
    if (logo) { try { pdf.image(logo, left, pdf.page.margins.top, { fit: [90, 36] }); x = left + 100; } catch { /* unreadable logo: skip it */ } }
    text(kit?.display_name ?? '', x, pdf.page.margins.top, width - (x - left), { bold: true, size: 13, color: accent });
    if (kit?.legal_name || kit?.address) text([kit.legal_name, kit.address].filter(Boolean).join(' · '), x, pdf.y, width - (x - left), { size: 8 });
    pdf.y = Math.max(pdf.y, pdf.page.margins.top + 40) + 4;
    pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).lineWidth(0.6).stroke(accent); pdf.y += 10;
  };
  header();
  text(d.title.toUpperCase() + (d.number ? `  ${d.number}` : ''), left, pdf.y, width, { bold: true, size: 15, color: accent });
  if (d.status) text(`${d.status}${d.issued_at ? ` · ${String(d.issued_at).slice(0, 10)} (UTC)` : ''}`, left, pdf.y + 2, width, { size: 9 });
  pdf.y += 10;

  if (d.parties?.length) {
    const y = pdf.y, w = width / d.parties.length - 8; let end = y;
    d.parties.forEach((p, n) => { const x = left + n * (w + 16); text(p.label.toUpperCase(), x, y, w, { bold: true, size: 8, color: accent }); text(p.lines.filter(Boolean).join('\n') || '—', x, y + 12, w); end = Math.max(end, pdf.y); });
    pdf.y = end + 14;
  }
  pdf.on('pageAdded', () => { header(); });
  for (const s of d.sections ?? []) {
    if (pdf.y + 40 > bottom()) pdf.addPage();
    if (s.heading) { text(s.heading, left, pdf.y, width, { bold: true, size: 10, color: accent }); pdf.y += 3; }
    if (s.kind === 'text') { text(s.text, left, pdf.y, width); pdf.y += 8; continue; }
    if (s.kind === 'kv') { for (const [k, v] of s.rows) { if (pdf.y + 16 > bottom()) pdf.addPage(); const y = pdf.y; text(k, left, y, 150, { bold: true }); text(v, left + 155, y, width - 155); pdf.y = Math.max(pdf.y, y + 12); } pdf.y += 6; continue; }
    const total = s.columns.reduce((a, c) => a + c.w, 0), cols = s.columns.map((c) => ({ ...c, w: (c.w / total) * width }));
    const head = () => { const y = pdf.y; pdf.rect(left, y - 2, width, 16).fill(accent); let x = left; cols.forEach((c) => { text(c.t, x, y + 1, c.w - 6, { bold: true, color: '#FFFFFF', align: c.a }); x += c.w; }); pdf.y = y + 18; };
    head();
    for (const r of s.rows) {
      pdf.font(f.regular).fontSize(9);
      const h = Math.max(...r.map((c, i) => pdf.heightOfString(String(c ?? ' ') || ' ', { width: cols[i].w - 6 })));
      if (pdf.y + h + 6 > bottom()) { pdf.addPage(); head(); }
      let x = left; const y = pdf.y; r.forEach((c, i) => { text(c, x, y, cols[i].w - 6, { align: cols[i].a }); x += cols[i].w; });
      pdf.y = y + h + 5; pdf.moveTo(left, pdf.y - 2).lineTo(left + width, pdf.y - 2).lineWidth(0.3).stroke('#D3D1C7');
    }
    pdf.y += 8;
  }
  if (d.totals?.length) {
    if (pdf.y + d.totals.length * 15 + 10 > bottom()) pdf.addPage();
    const tx = left + width - 240;
    for (const [k, v, bold] of d.totals) { const y = pdf.y; text(k, tx, y, 130, { bold }); text(v, tx + 130, y, 110, { bold, align: 'right' }); pdf.y = y + 14; }
    pdf.y += 8;
  }
  if (d.footnote) { if (pdf.y + 30 > bottom()) pdf.addPage(); text(d.footnote, left, pdf.y, width, { size: 8 }); }

  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    if (d.watermark) { pdf.save(); pdf.rotate(-35, { origin: [pdf.page.width / 2, pdf.page.height / 2] }); pdf.font(f.bold).fontSize(70).fillOpacity(0.08).fillColor('#B42318').text(d.watermark, 0, pdf.page.height / 2 - 40, { width: pdf.page.width, align: 'center', lineBreak: false }); pdf.restore(); pdf.fillOpacity(1); }
    const y = pdf.page.height - pdf.page.margins.bottom - 12; pdf.page.margins.bottom = 0;
    if (kit?.footer_text) text(kit.footer_text, left, y, width - 120, { size: 8, lineBreak: false });
    text(`${d.number ?? d.title} · Page ${i + 1} of ${range.count}`, left + width - 200, y, 200, { size: 8, align: 'right', lineBreak: false });
  }
  pdf.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}
