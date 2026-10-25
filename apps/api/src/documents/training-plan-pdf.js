// Printable training plan with the athlete's actuals (issue #326). Built from the SAME view the screen shows (get_training_plan), so the
// PDF can never contain more than the person exporting may see: when access to the athlete's recorded results has ended, the results
// columns are omitted and the document says so.
import PDFDocument from 'pdfkit';
import { fonts, assertGlyphs } from './render.js';

const fmtDist = (m) => (m >= 1000 ? `${Math.round(m / 10) / 100} km` : `${m} m`);
const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} min` : `${s} s`);
const fmtPace = (s, per) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} ${per === 1000 ? '/km' : `/${per} m`}`;
const when = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const KIND = { warmup: 'Warm-up', work: 'Main work', interval: 'Intervals', strength: 'Strength', rest: 'Rest', cooldown: 'Cool-down' };
const PHASE = { preparation: 'Preparation', pre_competition: 'Pre-competition', competition: 'Competition', transition: 'Transition', return_to_play: 'Return to play' };

export function describeBlock(b, rules) {
  if (b.kind === 'rest') return `Rest ${fmtTime(b.rest_sec)}`;
  const work = b.work_m ? fmtDist(b.work_m) : b.work_sec ? fmtTime(b.work_sec) : null;
  const reps = b.reps ? `${b.reps} reps` : null;
  const head = b.sets && (work || reps) ? `${b.sets} x ${[reps, work].filter(Boolean).join(' x ')}` : [b.sets ? `${b.sets} sets` : null, reps, work].filter(Boolean).join(', ');
  const u = (v) => (b.zone.kind === 'pace' ? fmtPace(v, rules?.pace_per_m ?? 1000) : `${v} W`);
  const z = b.zone ? `${b.zone.kind} zone ${b.zone.level}${b.zone.min !== undefined || b.zone.max !== undefined ? ` (${[b.zone.min, b.zone.max].map((v) => (v === undefined ? 'open' : u(v))).join(' - ')})` : ''}` : null;
  return [head, b.load_kg ? `${b.load_kg} kg` : null, z, b.rest_sec ? `rest ${fmtTime(b.rest_sec)}` : null].filter(Boolean).join(' | ');
}

const actualText = (m, rules) => {
  if (m.actual === null || m.actual === undefined) return null;
  const v = m.metric === 'distance_m' ? fmtDist(m.actual) : m.metric === 'duration_sec' ? fmtTime(m.actual) : m.metric === 'pace' ? fmtPace(m.actual, rules?.pace_per_m ?? 1000) : m.metric === 'power_w' ? `${m.actual} W` : m.metric === 'load_kg' ? `${m.actual} kg` : String(m.actual);
  return `${m.metric.replace('_m', '').replace('_sec', '').replace('_w', '').replace('_kg', '')} ${v}${m.in_zone === undefined ? '' : m.in_zone ? ' (in zone)' : ' (outside zone)'}`;
};

/** @param plan the object returned by the plan view. @returns {Promise<{buffer: Buffer, pages: number}>} */
export async function renderTrainingPlan(plan, { generatedAt = new Date() } = {}) {
  const f = fonts();
  const hidden = plan.sessions.some((s) => s.athlete_data_hidden);
  const strings = [plan.title, plan.goal, plan.athlete_name, plan.coach_name, plan.sport, ...(plan.phases ?? []).flatMap((p) => [p.label, p.focus]), ...plan.sessions.flatMap((s) => [s.title, s.objective, s.instructions, s.athlete_feedback, s.coach_feedback, ...(s.structure ?? []).flatMap((b) => [b.label, b.notes, b.demo?.title, b.demo?.url])]), ...(plan.targets ?? []).flatMap((t) => [t.label, t.value])];
  assertGlyphs(strings, f);
  const accent = '#B4182D', ink = '#242E49', mute = '#5B6478';
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, compress: true, info: { Title: `Training plan - ${plan.title}`, Author: 'Sportarena', CreationDate: generatedAt, Producer: 'Sportarena' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 20;
  const t = (s, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(s ?? '', o.x ?? left, o.y ?? doc.y, { width: o.w ?? width, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
  const h2 = (s) => { room(40); doc.y += 8; t(s.toUpperCase(), { bold: true, size: 8.5, color: accent }); doc.moveTo(left, doc.y + 1).lineTo(left + width, doc.y + 1).lineWidth(0.5).stroke(accent); doc.y += 5; };

  doc.rect(0, 0, doc.page.width, 8).fill(accent);
  doc.y = 26;
  t('TRAINING PLAN', { bold: true, size: 8.5, color: accent });
  t(plan.title, { bold: true, size: 18 });
  t([plan.sport, `Athlete: ${plan.athlete_name}`, `Coach: ${plan.coach_name}`, `Status: ${plan.status.replace('_', ' ')}`, `Revision ${plan.accepted_rev ?? plan.current_rev}`].filter(Boolean).join('   |   '), { size: 9, color: mute });
  if (plan.goal) { doc.y += 4; t(`Goal: ${plan.goal}`, { size: 10 }); }

  if (plan.targets?.length) { h2('Targets'); for (const x of plan.targets) t(`- ${x.label}${x.value ? `: ${x.value}` : ''}`, { size: 9 }); }
  if (plan.phases?.length) {
    h2('Periodisation');
    for (const p of plan.phases) { room(26); t(`${PHASE[p.kind] ?? p.kind} - ${p.label}   (${p.from} to ${p.to})`, { bold: true, size: 9 }); if (p.focus) t(p.focus, { size: 8.5, color: mute }); }
  }
  if (plan.weeks?.length) {
    h2('Weekly load and completion');
    const cols = [['Week of', 62], ['Phase', 92], ['Done', 44], ['Plan min', 48], ['Done min', 48], ['Plan load', 52], ['Actual load', 56], ['Compl.', 40], ['Change', 40]];
    const sum = cols.reduce((a, c) => a + c[1], 0), k = width / sum;
    const row = (vals, bold, shade) => {
      room(14); const y = doc.y; let x = left;
      if (shade) doc.rect(left, y - 2, width, 13).fill('#F3F4F8');
      vals.forEach((v, i) => { t(v === null || v === undefined ? '-' : String(v), { x: x + 2, y, w: cols[i][1] * k - 4, size: 8, bold, lineBreak: false }); x += cols[i][1] * k; });
      doc.y = y + 13;
    };
    row(cols.map((c) => c[0]), true, true);
    for (const w of plan.weeks) row([w.week_start, w.phase, w.completed === null ? `-/${w.sessions}` : `${w.completed}/${w.sessions}`, w.planned_min, w.completed_min, w.planned_load, w.actual_load, w.compliance_pct === null ? null : `${w.compliance_pct}%`, w.planned_load_change_pct === null ? null : `${w.planned_load_change_pct > 0 ? '+' : ''}${w.planned_load_change_pct}%${w.large_planned_increase ? ' !' : ''}`]);
    t('Load = session effort (1-10) x minutes (session-RPE method). A planning aid, not medical advice. "!" marks a planned rise of more than 30% on the previous week - review before confirming.', { size: 7, color: mute });
  }

  h2('Sessions');
  if (!plan.sessions.length) t('No sessions scheduled yet.', { size: 9, color: mute });
  for (const s of plan.sessions) {
    room(70);
    doc.rect(left, doc.y, 3, 12).fill(accent);
    t(`${when(s.starts_at)}  -  ${s.title}`, { bold: true, size: 10.5, x: left + 8, w: width - 8 });
    t([s.kind, s.focus, `${s.duration_min} min`, s.target_rpe ? `target effort ${s.target_rpe}/10` : null, s.planned_load ? `planned load ${s.planned_load}` : null, s.status.toUpperCase()].filter(Boolean).join('   |   '), { size: 8.5, color: mute, x: left + 8, w: width - 8 });
    if (s.objective) t(`Objective: ${s.objective}`, { size: 9, x: left + 8, w: width - 8 });
    if (s.instructions) t(s.instructions, { size: 9, x: left + 8, w: width - 8 });
    const comp = new Map((s.compliance?.blocks ?? []).map((b) => [b.block_id, b]));
    for (const b of s.structure ?? []) {
      room(30);
      t(`${KIND[b.kind]}: ${b.label}`, { bold: true, size: 9, x: left + 16, w: width - 16 });
      t(`Plan: ${describeBlock(b, plan.sport_rules)}${b.notes ? `  -  ${b.notes}` : ''}`, { size: 8.5, x: left + 16, w: width - 16 });
      if (b.demo) t(`Demonstration: ${b.demo.title ? `${b.demo.title} - ` : ''}${b.demo.url}`, { size: 8, color: mute, x: left + 16, w: width - 16 });
      const r = comp.get(b.id);
      if (r && !r.recorded) t('Actual: not recorded', { size: 8.5, x: left + 16, w: width - 16 });
      else if (r) t(`Actual: ${r.completed ? 'done' : 'partly done'} (${r.pct}%)${r.metrics.map((m) => actualText(m, plan.sport_rules)).filter(Boolean).map((x) => `, ${x}`).join('')}`, { size: 8.5, bold: true, x: left + 16, w: width - 16 });
    }
    if (s.compliance?.pct !== null && s.compliance) t(`Overall: ${s.compliance.pct}% of the planned work recorded`, { size: 8.5, bold: true, x: left + 8, w: width - 8 });
    if (s.status === 'completed' || s.status === 'skipped') {
      if (s.athlete_data_hidden) t('Athlete-recorded results are not included: access to them has ended.', { size: 8.5, color: mute, x: left + 8, w: width - 8 });
      else t(`Athlete report: ${s.status}${s.athlete_rpe ? `, effort ${s.athlete_rpe}/10` : ''}${s.actual_load ? `, load ${s.actual_load}` : ''}${s.athlete_feedback ? ` - "${s.athlete_feedback}"` : ''}`, { size: 8.5, x: left + 8, w: width - 8 });
      if (s.coach_feedback) t(`Coach feedback: ${s.coach_feedback}`, { size: 8.5, x: left + 8, w: width - 8 });
    }
    doc.y += 8;
  }
  if (hidden) { h2('Note'); t('Some athlete-recorded results are not included because the exporter no longer has access to them (relationship ended or guardian consent withdrawn).', { size: 8.5, color: mute }); }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); doc.page.margins.bottom = 0;
    t(`${plan.title}  |  generated ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC  |  Page ${i + 1} of ${range.count}`, { size: 7, color: mute, y: doc.page.height - 28, lineBreak: false, align: 'center' });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}
