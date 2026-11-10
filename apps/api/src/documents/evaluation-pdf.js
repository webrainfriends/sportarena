// Printable evaluation: the same view the screen shows, so the document can never hold more than the person exporting may see. A coach's private note is
// left out unless the caller already put it in the view; an athlete's copy is built from the frozen shared version. pdfkit with the shared font helper.
import PDFDocument from 'pdfkit';
import { fonts, assertGlyphs } from './render.js';
import { drawWordmark, ICON } from './brand-font.js';

const PILLAR = { technical: 'Technical', tactical: 'Tactical', physical: 'Physical', mental: 'Mental', behaviour: 'Behaviour', lifestyle: 'Lifestyle', other: 'Other' };
const STATUS = { draft: 'Draft', shared: 'Shared', responded: 'Responded', closed: 'Closed' };
const REACT = { agree: 'Agrees', discuss: 'Wants to discuss', disagree: 'Disagrees' };
const pillarName = (ev, k) => ev.pillar_labels?.[k] ?? PILLAR[k] ?? String(k).replace(/_/g, ' ');
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const sign = (n) => (n == null ? '' : n > 0 ? `+${n}` : String(n));

/** @param ev the evaluation view (coach or athlete) with coach_name, athlete, sheet, thread and viewer. @returns {Promise<{buffer: Buffer, pages: number}>} */
export const SECTIONS = ['summary', 'scores', 'comments', 'evidence', 'feedback', 'response', 'conversation'];

export async function renderEvaluation(ev, { generatedAt = new Date(), sections = SECTIONS, confidential = true } = {}) {
  const f = fonts();
  const has = (k) => sections.includes(k);
  const strings = [ev.title, ev.athlete?.display_name, ev.coach_name, ev.sheet?.name, ...Object.values(ev.narrative ?? {}), ev.response?.comment, ev.response?.questions,
    ...Object.values(ev.pillar_labels ?? {}), ...ev.criteria.flatMap((c) => [c.name, c.description, c.comment, c.self_comment, ...Object.values(c.labels ?? {}), ...Object.values(c.anchors ?? {}), ...(c.evidence ?? []).map((x) => x.text)]), ...(ev.thread ?? []).map((m) => m.body)];
  assertGlyphs(strings, f);
  const accent = '#B4182D', ink = '#242E49', mute = '#5B6478', wash = '#F3F4F8';
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, compress: true, info: { Title: `Evaluation - ${ev.title}`, Author: 'GotMyGame', CreationDate: generatedAt, Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 20;
  const t = (s, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(s ?? '', o.x ?? left, o.y ?? doc.y, { width: o.w ?? width, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
  const h2 = (s) => { room(40); doc.y += 8; t(s.toUpperCase(), { bold: true, size: 8.5, color: accent }); doc.moveTo(left, doc.y + 1).lineTo(left + width, doc.y + 1).lineWidth(0.5).stroke(accent); doc.y += 6; };
  const bar = (x, y, w, pct, color) => { doc.rect(x, y, w, 6).fill('#E5E7EF'); if (pct != null) doc.rect(x, y, Math.max(1, (w * Math.min(100, Math.max(0, pct))) / 100), 6).fill(color); };

  doc.rect(0, 0, doc.page.width, 8).fill(accent);
  try { doc.image(ICON, left, 16, { height: 28, width: 28 }); } catch { /* decoration */ }
  try { drawWordmark(doc, left + 34, 22, { size: 13 }); } catch { /* decoration */ }
  doc.y = 52;
  t('EVALUATION', { bold: true, size: 8.5, color: accent });
  t(ev.title, { bold: true, size: 18 });
  t([`Athlete: ${ev.athlete?.display_name ?? ''}`, `Coach: ${ev.coach_name}`, `Sheet: ${ev.sheet?.name} v${ev.sheet?.version}`, `Status: ${STATUS[ev.status] ?? ev.status}`, ev.version ? `Version ${ev.version}` : 'Not shared yet', ev.period_from ? `${day(ev.period_from)} to ${day(ev.period_to) || '...'}` : null].filter(Boolean).join('   |   '), { size: 8.5, color: mute });

  const s = ev.summary;
  if (has('summary')) {
  h2('Summary');
  t(s.overall == null ? 'No weighted score yet.' : `Overall ${s.overall} / 100${s.change != null ? `   (${sign(s.change)} since the previous evaluation)` : ''}`, { bold: true, size: 12 });
  if (s.self_overall != null) t(`Athlete's own overall: ${s.self_overall} / 100`, { size: 9, color: mute });
  doc.y += 4;
  for (const [k, p] of Object.entries(s.pillars)) {
    room(16); const y = doc.y;
    t(pillarName(ev, k), { x: left, y, w: 90, size: 9, bold: true, lineBreak: false });
    bar(left + 95, y + 3, 260, p.score, accent);
    t(`${p.score}${s.pillar_change?.[k] != null ? `  (${sign(s.pillar_change[k])})` : ''}${s.self_pillars?.[k] ? `   self ${s.self_pillars[k].score}` : ''}`, { x: left + 365, y, w: width - 365, size: 8.5, lineBreak: false });
    doc.y = y + 15;
  }
  t(`Scores are the coach's own judgement on each criterion's scale. Pillar and overall figures are computed from the weights set on the sheet (0 to 100). ${s.coverage.scored} of ${s.coverage.total} criteria scored.`, { size: 7.5, color: mute });
  }

  if (has('scores') || has('comments') || has('evidence')) h2('Criteria');
  const groups = {};
  for (const c of ev.criteria) (groups[c.pillar] ??= []).push(c);
  for (const [pk, list] of (has('scores') || has('comments') || has('evidence') ? Object.entries(groups) : [])) {
    room(30); t(pillarName(ev, pk), { bold: true, size: 10 });
    for (const c of list) {
      room(52);
      const y = doc.y; doc.rect(left, y - 2, width, 14).fill(wash);
      t(c.name, { x: left + 4, y, w: width - 190, size: 9, bold: true, lineBreak: false });
      const parts = !has('scores') ? '' : [c.score != null ? `${c.score} / ${c.scale_max}` : 'not scored', c.change != null ? `${sign(c.change)} vs last` : null, c.self != null ? `self ${c.self}${c.gap ? ` (${sign(c.gap)})` : ''}` : null, c.target != null ? `target ${c.target}` : null].filter(Boolean).join('   ');
      t(parts, { x: left + width - 186, y, w: 182, size: 8.5, align: 'right', lineBreak: false });
      doc.y = y + 16;
      const label = !has('scores') ? null : c.score != null ? (c.labels?.[String(c.score)] ?? null) : null, anchor = !has('scores') ? null : c.score != null ? (c.anchors?.[String(c.score)] ?? null) : null;
      if (label || anchor) t([label, anchor].filter(Boolean).join(': '), { size: 8, color: mute });
      if (has('comments') && c.comment) t(c.comment, { size: 8.5 });
      if (has('evidence')) for (const e of c.evidence ?? []) t(`Evidence (${e.type}${e.at ? ` ${e.at}` : ''}): ${e.text ?? ''}${e.url ? ` ${e.url}` : ''}`, { size: 8, color: mute });
      if (has('comments') && c.self_comment) t(`Athlete: ${c.self_comment}`, { size: 8.5, color: mute });
      if (has('response') && c.reaction) t(`Athlete response: ${REACT[c.reaction] ?? c.reaction}`, { size: 8.5, bold: true });
      doc.y += 3;
    }
  }

  const N = ev.narrative ?? {};
  for (const [k, label] of [['strengths', 'Strengths'], ['development', 'Priority development areas'], ['cues', 'Key coaching cues'], ['next_steps', 'Next steps'], ['private', 'Coach private note']]) {
    if (N[k] && has('feedback')) { h2(label); t(N[k], { size: 9.5 }); }
  }
  if (has('response') && ev.response && (ev.response.comment || ev.response.questions)) {
    h2('Athlete response');
    if (ev.response.comment) t(ev.response.comment, { size: 9.5 });
    if (ev.response.questions) { t('Questions', { bold: true, size: 9 }); t(ev.response.questions, { size: 9.5 }); }
  }
  if (has('conversation') && ev.thread?.length) {
    h2('Conversation');
    for (const m of ev.thread) { room(24); t(`${m.author}  (${m.author_role})  ${day(m.created_at)}${m.criterion_key ? `  on ${m.criterion_key}` : ''}`, { bold: true, size: 8.5 }); t(m.body, { size: 9 }); doc.y += 2; }
  }
  if (ev.acknowledged_at) { doc.y += 6; t(`Acknowledged by the athlete or guardian on ${day(ev.acknowledged_at)}.`, { size: 8.5, color: mute }); }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font(f.regular).fontSize(7.5).fillColor(mute).text(`${confidential ? 'Confidential: ' : ''}Evaluation - ${ev.title} - generated ${day(generatedAt)} - page ${i + 1} of ${range.count}`, left, doc.page.height - 34, { width, align: 'center', lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}
