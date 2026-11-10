// The submitted application for an event position as a document the applicant keeps and the organiser files. It is built from the same view the
// screen shows (capabilities/event-openings.js applicationView), so it can never hold more than the person downloading may see.
import PDFDocument from 'pdfkit';
import { fonts, assertGlyphs } from './render.js';
import { drawWordmark, ICON } from './brand-font.js';

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** @param v the application view. @returns {Promise<{buffer: Buffer, pages: number}>} */
export async function renderApplication(v, { generatedAt = new Date() } = {}) {
  const f = fonts();
  assertGlyphs([v.position.title, v.event.name, v.event.city, v.applicant.display_name, v.organiser.display_name, v.position.requirements, v.position.notes, v.message,
    ...v.sections.flatMap((s) => [s.title, ...s.rows.flatMap((r) => [r.label, r.text])]), ...v.documents.flatMap((d) => [d.title, d.uploaded_by_name]), ...v.timeline.flatMap((h) => [h.label, h.actor, h.reason])], f);
  const accent = '#8458B3', ink = '#2A2D3A', mute = '#5F6580', wash = '#F1EEF8', line = '#CDD5E8';
  const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true, compress: true, info: { Title: `Application - ${v.position.title} - ${v.event.name}`, Author: 'GotMyGame', CreationDate: generatedAt, Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 22;
  const t = (s, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9.5).fillColor(o.color ?? ink).text(s ?? '', o.x ?? left, o.y ?? doc.y, { width: o.w ?? width, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) { doc.addPage(); doc.y = doc.page.margins.top; } };
  const h2 = (s) => { room(44); doc.y += 12; t(s.toUpperCase(), { bold: true, size: 8.5, color: accent }); doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).lineWidth(0.6).stroke(accent); doc.y += 8; };
  const LABEL_W = 170;
  const row = (label, text) => {
    const h = Math.max(doc.font(f.regular).fontSize(9.5).heightOfString(text || '-', { width: width - LABEL_W - 8 }), doc.font(f.bold).fontSize(9).heightOfString(label, { width: LABEL_W - 8 }));
    room(h + 8);
    const y = doc.y;
    t(label, { x: left, y, w: LABEL_W - 8, size: 9, bold: true, color: mute });
    t(text || '-', { x: left + LABEL_W, y, w: width - LABEL_W - 8 });
    doc.y = y + h + 5;
    doc.moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).lineWidth(0.3).stroke(line);
  };

  doc.rect(0, 0, doc.page.width, 8).fill(accent);
  try { doc.image(ICON, left, 16, { height: 28, width: 28 }); } catch { /* decoration */ }
  try { drawWordmark(doc, left + 34, 22, { size: 13 }); } catch { /* the wordmark is decoration: a missing asset must not block the document */ }
  t(`Reference ${v.reference}`, { x: left, y: 24, size: 8.5, color: mute, align: 'right', lineBreak: false });
  doc.y = 52;
  t('APPLICATION FOR AN EVENT POSITION', { bold: true, size: 8.5, color: accent });
  t(v.position.title, { bold: true, size: 20 });
  t([v.event.name, v.event.city, v.event.dates].filter(Boolean).join('   |   '), { size: 10, color: mute });
  doc.y += 8;

  const boxY = doc.y, cols = [['Status', v.status_label], ['Submitted', day(v.submitted_at)], ['Posted fee', v.fee.posted], ['Your fee', v.fee.proposed ?? 'As posted']];
  doc.roundedRect(left, boxY, width, 44, 6).fill(wash);
  cols.forEach(([k, val], i) => {
    const x = left + 12 + (i * (width - 24)) / cols.length, w = (width - 24) / cols.length - 6;
    t(k.toUpperCase(), { x, y: boxY + 8, w, size: 7, bold: true, color: mute, lineBreak: false });
    t(val || '-', { x, y: boxY + 20, w, size: 11, bold: true, lineBreak: false });
  });
  doc.y = boxY + 52;

  h2('Parties');
  row('Applicant', v.applicant.display_name);
  row('Organiser', v.organiser.display_name);
  row('Position', [...new Set([v.position.title, v.position.kind_label].filter(Boolean))].join(' - '));
  if (v.position.requirements) row('Requirements set by the organiser', v.position.requirements);

  if (v.message) { h2('Cover statement'); t(v.message, { size: 10 }); }

  for (const s of v.sections) {
    h2(s.title);
    for (const r of s.rows) row(r.label, r.text);
  }

  h2(`Supporting documents (${v.documents.length})`);
  if (!v.documents.length) t('No documents have been added to this application.', { color: mute });
  for (const d of v.documents) row(d.title, `${d.kind} - ${Math.max(1, Math.round(d.size_bytes / 1024))} KB - added ${day(d.created_at)} by ${d.uploaded_by_name}`);
  if (v.documents.length) { doc.y += 2; t('The files themselves stay encrypted on GotMyGame and open only for the applicant and the organiser.', { size: 8, color: mute }); }

  h2('Progress');
  for (const h of v.timeline) row(day(h.at), [h.label, h.actor ? `by ${h.actor}` : null, h.reason].filter(Boolean).join(' - '));
  if (v.contract) row('Contract', v.contract.status_label);

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font(f.regular).fontSize(7.5).fillColor(mute).text(`Confidential - application ${v.reference} - generated ${day(generatedAt)} - page ${i + 1} of ${range.count}`, left, doc.page.height - 34, { width, align: 'center', lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}
