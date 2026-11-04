// Process-guide PDF (pdfkit): cover, then one page per step with the instructions and the screenshots taken from the real app.
// English only: the built-in PDF fonts cannot show Indic or Urdu text, and the guide never silently garbles it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { SHOT_SIZES, shotFile } from './academy-process.js';

export const SHOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/guides');
export const shotPath = (persona, stepId, size) => path.join(SHOT_DIR, persona, shotFile(stepId, size));

// Dusk theme tokens (apps/app/src/theme.js, light): ink, mute, amethyst accent
const INK = '#2F3242', MUTE = '#5F6580', ACCENT = '#8458B3';

/** @returns {Promise<Buffer>} */
export async function renderGuidePdf({ persona, title, steps, generatedAt = new Date() }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, compress: true, info: { Title: title, Author: 'Sportarena', Producer: 'Sportarena', CreationDate: generatedAt } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const W = doc.page.width - 80;

  doc.rect(0, 0, doc.page.width, 8).fill(ACCENT);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(26).text(title, 40, 90, { width: W });
  doc.moveDown(0.5).font('Helvetica').fontSize(12).fillColor(MUTE).text('A step-by-step guide with screenshots from the app. Follow the steps in order; each one builds on the last.', { width: W });
  doc.moveDown(1.5).font('Helvetica-Bold').fontSize(13).fillColor(INK).text('In this guide');
  steps.forEach((s, i) => doc.moveDown(0.3).font('Helvetica').fontSize(12).fillColor(INK).text(`${i + 1}.  ${s.title}`));
  doc.moveDown(2).fontSize(9).fillColor(MUTE).text(`Generated ${generatedAt.toISOString().slice(0, 10)}. Screenshots are taken from the current version of the app and refreshed whenever these screens change.`, { width: W });

  steps.forEach((s, i) => {
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 8).fill(ACCENT);
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(10).text(`STEP ${i + 1} OF ${steps.length}`, 40, 36, { width: W });
    doc.fillColor(INK).fontSize(20).text(s.title, 40, doc.y + 2, { width: W });
    doc.moveDown(0.3).font('Helvetica').fontSize(11).fillColor(MUTE).text(s.why, { width: W });
    doc.moveDown(0.8);
    s.steps.forEach((line, j) => doc.font('Helvetica').fontSize(11).fillColor(INK).text(`${j + 1}.  ${line}`, { width: W, indent: 0, lineGap: 2 }).moveDown(0.25));
    const top = doc.y + 10, room = doc.page.height - 40 - top;
    const phone = shotPath(persona, s.id, 'phone'), desk = shotPath(persona, s.id, 'desktop');
    const havePhone = fs.existsSync(phone), haveDesk = fs.existsSync(desk);
    if (haveDesk) doc.image(desk, 40, top, { fit: [havePhone ? W * 0.62 : W, room] });
    if (havePhone) doc.image(phone, havePhone && haveDesk ? 40 + W * 0.66 : 40, top, { fit: [haveDesk ? W * 0.34 : W * 0.5, room] });
    if (!havePhone && !haveDesk) doc.font('Helvetica-Oblique').fontSize(10).fillColor(MUTE).text('Screenshot not available yet for this step.', 40, top, { width: W });
  });

  const n = doc.bufferedPageRange().count;
  for (let p = 0; p < n; p += 1) { doc.switchToPage(p); doc.page.margins.bottom = 0;   // text below the bottom margin would otherwise add a page
    doc.font('Helvetica').fontSize(8).fillColor(MUTE).text(`${title} · page ${p + 1} of ${n}`, 40, doc.page.height - 28, { width: W, align: 'center', lineBreak: false }); }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
export { SHOT_SIZES };
