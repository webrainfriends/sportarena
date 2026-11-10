// Printable training plan with the athlete's actuals (issue #326). Built from the SAME view the screen shows (get_training_plan), so the
// PDF can never contain more than the person exporting may see: when access to the athlete's recorded results has ended, the results
// columns are omitted and the document says so.
import PDFDocument from 'pdfkit';
import { fonts, assertGlyphs } from './render.js';
import { drawWordmark, ICON } from './brand-font.js';

const fmtDist = (m) => (m >= 1000 ? `${Math.round(m / 10) / 100} km` : `${m} m`);
const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} min` : `${s} s`);
const fmtPace = (s, per) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} ${per === 1000 ? '/km' : `/${per} m`}`;
const when = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const KIND = { warmup: 'Warm-up', work: 'Main work', interval: 'Intervals', strength: 'Strength', rest: 'Rest', cooldown: 'Cool-down' };
const PHASE = { preparation: 'Preparation', pre_competition: 'Pre-competition', competition: 'Competition', transition: 'Transition', return_to_play: 'Return to play' };
const STATUS_LABEL = { scheduled: 'SCHEDULED', completed: 'COMPLETED', skipped: 'SKIPPED', cancelled: 'CANCELLED' };
const STATUS_COLOR = { scheduled: '#494D5F', completed: '#1A7F4B', skipped: '#8458B3', cancelled: '#888' };

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
  const strings = [plan.title, plan.goal, plan.athlete_name, plan.coach_name, plan.sport, ...(plan.phases ?? []).flatMap((p) => [p.label, p.focus]), ...plan.sessions.flatMap((s) => [s.title, s.objective, s.instructions, s.athlete_feedback, s.coach_feedback, s.coach_technical_notes, s.coach_tactical_notes, s.coach_physical_notes, s.coach_next_focus, ...(s.structure ?? []).flatMap((b) => [b.label, b.notes, b.demo?.title, b.demo?.url])]), ...(plan.targets ?? []).flatMap((t) => [t.label, t.value])];
  assertGlyphs(strings, f);
  const accent = '#8458B3', ink = '#2F3242', mute = '#5F6580', green = '#1A7F4B', slate = '#494D5F';
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, compress: true, info: { Title: `Training plan - ${plan.title}`, Author: 'GotMyGame', CreationDate: generatedAt, Producer: 'GotMyGame' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 20;
  const t = (s, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(s ?? '', o.x ?? left, o.y ?? doc.y, { width: o.w ?? width, align: o.align ?? 'left', lineBreak: o.lineBreak ?? true });
  const room = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
  const h2 = (s) => { room(40); doc.y += 8; t(s.toUpperCase(), { bold: true, size: 8.5, color: accent }); doc.moveTo(left, doc.y + 1).lineTo(left + width, doc.y + 1).lineWidth(0.5).stroke(accent); doc.y += 5; };

  // ── Header strip ──────────────────────────────────────────────────────────
  doc.rect(0, 0, doc.page.width, 8).fill(accent);
  try { doc.image(ICON, left, 16, { height: 28, width: 28 }); } catch { /* decoration */ }
  try { drawWordmark(doc, left + 34, 22, { size: 13 }); } catch { /* decoration */ }
  doc.y = 52;
  t('TRAINING PLAN', { bold: true, size: 8.5, color: accent });
  t(plan.title, { bold: true, size: 18 });
  t([plan.sport, `Athlete: ${plan.athlete_name}`, `Coach: ${plan.coach_name}`, `Status: ${plan.status.replace('_', ' ')}`, `Revision ${plan.accepted_rev ?? plan.current_rev}`].filter(Boolean).join('   |   '), { size: 9, color: mute });
  if (plan.goal) { doc.y += 4; t(`Goal: ${plan.goal}`, { size: 10 }); }

  // ── Targets ───────────────────────────────────────────────────────────────
  if (plan.targets?.length) { h2('Targets'); for (const x of plan.targets) t(`- ${x.label}${x.value ? `: ${x.value}` : ''}`, { size: 9 }); }

  // ── Periodisation phases ──────────────────────────────────────────────────
  if (plan.phases?.length) {
    h2('Periodisation');
    for (const p of plan.phases) { room(26); t(`${PHASE[p.kind] ?? p.kind} - ${p.label}   (${p.from} to ${p.to})`, { bold: true, size: 9 }); if (p.focus) t(p.focus, { size: 8.5, color: mute }); }
  }

  // ── Weekly load summary ───────────────────────────────────────────────────
  if (plan.weeks?.length) {
    h2('Weekly load and completion');
    const cols = [['Week of', 62], ['Phase', 92], ['Done', 44], ['Plan min', 48], ['Done min', 48], ['Plan load', 52], ['Actual load', 56], ['Compl.', 40], ['Change', 40]];
    const sum = cols.reduce((a, c) => a + c[1], 0), k = width / sum;
    const row = (vals, bold, shade) => {
      room(14); const y = doc.y; let x = left;
      if (shade) doc.rect(left, y - 2, width, 13).fill('#EEE9F8');
      vals.forEach((v, i) => { t(v === null || v === undefined ? '-' : String(v), { x: x + 2, y, w: cols[i][1] * k - 4, size: 8, bold, lineBreak: false }); x += cols[i][1] * k; });
      doc.y = y + 13;
    };
    row(cols.map((c) => c[0]), true, true);
    for (const w of plan.weeks) row([w.week_start, w.phase, w.completed === null ? `-/${w.sessions}` : `${w.completed}/${w.sessions}`, w.planned_min, w.completed_min, w.planned_load, w.actual_load, w.compliance_pct === null ? null : `${w.compliance_pct}%`, w.planned_load_change_pct === null ? null : `${w.planned_load_change_pct > 0 ? '+' : ''}${w.planned_load_change_pct}%${w.large_planned_increase ? ' !' : ''}`]);
    t('Load = session effort (1-10) x minutes (session-RPE method). A planning aid, not medical advice. "!" marks a planned rise of more than 30% on the previous week - review before confirming.', { size: 7, color: mute });
  }

  // ── Sessions (detailed) ───────────────────────────────────────────────────
  h2('Sessions');
  if (!plan.sessions.length) t('No sessions scheduled yet.', { size: 9, color: mute });

  for (const s of plan.sessions) {
    room(80);
    const statusColor = STATUS_COLOR[s.status] ?? mute;

    // Session title bar
    doc.rect(left, doc.y, 3, 14).fill(accent);
    const titleY = doc.y;
    t(`${when(s.starts_at)}  —  ${s.title}`, { bold: true, size: 11, x: left + 8, w: width - 100, lineBreak: false });

    // Status badge (top-right of the session row)
    const badgeLabel = STATUS_LABEL[s.status] ?? s.status.toUpperCase();
    const badgeW = 70, badgeH = 14;
    const badgeX = left + width - badgeW;
    doc.rect(badgeX, titleY, badgeW, badgeH).fill(statusColor);
    doc.font(f.bold).fontSize(7.5).fillColor('#FFFFFF').text(badgeLabel, badgeX, titleY + 3.5, { width: badgeW, align: 'center', lineBreak: false });
    doc.y = titleY + badgeH + 2;

    // Session meta row
    const metaParts = [s.kind, s.focus, `${s.duration_min} min`, s.target_rpe ? `Target effort ${s.target_rpe}/10` : null, s.planned_load ? `Planned load ${s.planned_load}` : null].filter(Boolean);
    t(metaParts.join('   ·   '), { size: 8.5, color: mute, x: left + 8, w: width - 8 });

    if (s.objective) { doc.y += 2; t(`Objective: ${s.objective}`, { size: 9, x: left + 8, w: width - 8 }); }
    if (s.instructions) { doc.y += 1; t(`Instructions: ${s.instructions}`, { size: 9, x: left + 8, w: width - 8 }); }

    // ── Planned structure + actuals ────────────────────────────────────────
    if ((s.structure ?? []).length > 0) {
      doc.y += 4;
      room(20);
      // Column header
      const colY = doc.y;
      doc.rect(left + 8, colY, width - 8, 13).fill('#EEE9F8');
      doc.font(f.bold).fontSize(7.5).fillColor(mute).text('EXERCISE / BLOCK', left + 12, colY + 3, { width: (width - 8) * 0.5, lineBreak: false });
      doc.font(f.bold).fontSize(7.5).fillColor(mute).text('PLAN', left + 8 + (width - 8) * 0.5, colY + 3, { width: (width - 8) * 0.22, lineBreak: false });
      doc.font(f.bold).fontSize(7.5).fillColor(mute).text('ACTUAL', left + 8 + (width - 8) * 0.72, colY + 3, { width: (width - 8) * 0.28, lineBreak: false });
      doc.y = colY + 14;

      const comp = new Map((s.compliance?.blocks ?? []).map((b) => [b.block_id, b]));
      let shade = false;
      for (const b of s.structure) {
        room(22);
        const bY = doc.y;
        const bLeft = left + 8;
        const col0w = (width - 8) * 0.5 - 4;
        const col1x = bLeft + (width - 8) * 0.5;
        const col1w = (width - 8) * 0.22 - 4;
        const col2x = bLeft + (width - 8) * 0.72;
        const col2w = (width - 8) * 0.28 - 4;

        if (shade) doc.rect(bLeft, bY - 1, width - 8, 1).fill('#F8F8FA'); // hairline separator
        shade = !shade;

        // Block label + kind
        doc.font(f.bold).fontSize(8.5).fillColor(ink).text(`${KIND[b.kind] ?? b.kind}: ${b.label ?? ''}`, bLeft + 4, bY, { width: col0w, lineBreak: true });
        const afterLabel = doc.y;
        if (b.notes) { doc.font(f.regular).fontSize(7.5).fillColor(mute).text(b.notes, bLeft + 4, afterLabel, { width: col0w }); }

        // Plan column
        const planDesc = describeBlock(b, s.rules ?? plan.sport_rules);
        doc.font(f.regular).fontSize(8).fillColor(ink).text(planDesc || '—', col1x, bY, { width: col1w });

        // Actual column
        const r = comp.get(b.id);
        let actualStr = '—';
        let actualColor = mute;
        if (!s.athlete_data_hidden && r) {
          if (!r.recorded) {
            actualStr = 'Not recorded';
          } else {
            const pct = r.pct !== undefined ? `${r.pct}%` : null;
            const done = r.completed ? 'Done' : 'Part done';
            const metrics = r.metrics?.map((m) => actualText(m, plan.sport_rules)).filter(Boolean).join(', ') ?? '';
            actualStr = [done, pct, metrics].filter(Boolean).join(' · ');
            actualColor = r.completed ? green : '#B07010';
          }
        } else if (s.athlete_data_hidden) {
          actualStr = 'Hidden';
        }
        doc.font(f.regular).fontSize(8).fillColor(actualColor).text(actualStr, col2x, bY, { width: col2w });
        doc.y = Math.max(doc.y, afterLabel);

        if (b.demo) { room(10); t(`Demo: ${b.demo.title ? `${b.demo.title}  ` : ''}${b.demo.url}`, { size: 7.5, color: mute, x: bLeft + 4, w: width - 12 }); }
      }
    }

    // ── Compliance summary ─────────────────────────────────────────────────
    if (s.compliance?.pct !== null && s.compliance && !s.athlete_data_hidden) {
      doc.y += 3;
      room(12);
      t(`Workout compliance: ${s.compliance.pct}% of planned work recorded`, { size: 8.5, bold: true, x: left + 8, w: width - 8, color: s.compliance.pct >= 80 ? green : s.compliance.pct >= 50 ? '#B07010' : accent });
    }

    // ── Athlete report ─────────────────────────────────────────────────────
    if (s.status === 'completed' || s.status === 'skipped') {
      doc.y += 4;
      room(14);
      doc.rect(left + 8, doc.y, width - 8, 13).fill('#F0F7F2');
      const arY = doc.y + 2.5;
      doc.font(f.bold).fontSize(8).fillColor(green).text('ATHLETE REPORT', left + 12, arY, { lineBreak: false });
      doc.y = arY + 11;

      if (s.athlete_data_hidden) {
        t('Athlete-recorded results are not included: access to them has ended.', { size: 8.5, color: mute, x: left + 8, w: width - 8 });
      } else {
        const reported = [`Status: ${s.status.toUpperCase()}`, s.athlete_rpe ? `Effort: ${s.athlete_rpe}/10` : null, s.actual_load ? `Load: ${s.actual_load}` : null].filter(Boolean);
        t(reported.join('   ·   '), { size: 8.5, x: left + 12, w: width - 12 });
        if (s.athlete_feedback) { doc.y += 2; t(`Athlete feedback: "${s.athlete_feedback}"`, { size: 8.5, x: left + 12, w: width - 12 }); }
      }
    }

    // ── Coach notes ────────────────────────────────────────────────────────
    const hasCoachNotes = s.coach_feedback || s.coach_effort_rating || s.coach_technical_notes || s.coach_tactical_notes || s.coach_physical_notes || s.coach_next_focus;
    if (hasCoachNotes) {
      doc.y += 4;
      room(14);
      doc.rect(left + 8, doc.y, width - 8, 13).fill('#EAE0F5');
      const cnY = doc.y + 2.5;
      doc.font(f.bold).fontSize(8).fillColor(slate).text('COACH NOTES', left + 12, cnY, { lineBreak: false });
      doc.y = cnY + 11;

      if (s.coach_feedback) t(`Overall: ${s.coach_feedback}`, { size: 8.5, x: left + 12, w: width - 12 });
      if (s.coach_effort_rating) t(`Effort rating: ${s.coach_effort_rating}/10`, { size: 8.5, x: left + 12, w: width - 12 });
      if (s.coach_technical_notes) t(`Technical: ${s.coach_technical_notes}`, { size: 8.5, x: left + 12, w: width - 12 });
      if (s.coach_tactical_notes) t(`Tactical: ${s.coach_tactical_notes}`, { size: 8.5, x: left + 12, w: width - 12 });
      if (s.coach_physical_notes) t(`Physical: ${s.coach_physical_notes}`, { size: 8.5, x: left + 12, w: width - 12 });
      if (s.coach_next_focus) { doc.y += 1; t(`Next focus: ${s.coach_next_focus}`, { size: 8.5, bold: true, x: left + 12, w: width - 12 }); }
    }

    doc.y += 10;
  }

  // ── Hidden data notice ────────────────────────────────────────────────────
  if (hidden) {
    h2('Note');
    t('Some athlete-recorded results are not included because the exporter no longer has access to them (relationship ended or guardian consent withdrawn).', { size: 8.5, color: mute });
  }

  // ── Summary and alignment signatures ─────────────────────────────────────
  room(170);
  h2('Plan alignment and sign-off');
  t('By signing below, the coach and athlete confirm that this training plan has been reviewed together and both parties are aligned on its objectives, load, and schedule.', { size: 9 });
  doc.y += 12;

  const halfW = (width - 20) / 2;

  // Coach signature box
  const coachBoxY = doc.y;
  doc.rect(left, coachBoxY, halfW, 100).strokeColor('#C4B5D9').lineWidth(0.5).stroke();
  t('COACH', { bold: true, size: 8, color: accent, x: left + 8, y: coachBoxY + 8 });
  t(plan.coach_name ?? '', { size: 9, x: left + 8, y: coachBoxY + 20 });
  doc.moveTo(left + 8, coachBoxY + 55).lineTo(left + halfW - 8, coachBoxY + 55).lineWidth(0.5).strokeColor('#AAAAAA').dash(2, { space: 2 }).stroke();
  doc.undash();
  t('Signature', { size: 7.5, color: mute, x: left + 8, y: coachBoxY + 57 });
  doc.moveTo(left + 8, coachBoxY + 85).lineTo(left + halfW - 8, coachBoxY + 85).lineWidth(0.5).strokeColor('#AAAAAA').dash(2, { space: 2 }).stroke();
  doc.undash();
  t('Date', { size: 7.5, color: mute, x: left + 8, y: coachBoxY + 87 });

  // Athlete signature box
  const athBoxX = left + halfW + 20;
  doc.rect(athBoxX, coachBoxY, halfW, 100).strokeColor('#C4B5D9').lineWidth(0.5).stroke();
  t('ATHLETE', { bold: true, size: 8, color: slate, x: athBoxX + 8, y: coachBoxY + 8 });
  t(plan.athlete_name ?? '', { size: 9, x: athBoxX + 8, y: coachBoxY + 20 });
  doc.moveTo(athBoxX + 8, coachBoxY + 55).lineTo(athBoxX + halfW - 8, coachBoxY + 55).lineWidth(0.5).strokeColor('#AAAAAA').dash(2, { space: 2 }).stroke();
  doc.undash();
  t('Signature', { size: 7.5, color: mute, x: athBoxX + 8, y: coachBoxY + 57 });
  doc.moveTo(athBoxX + 8, coachBoxY + 85).lineTo(athBoxX + halfW - 8, coachBoxY + 85).lineWidth(0.5).strokeColor('#AAAAAA').dash(2, { space: 2 }).stroke();
  doc.undash();
  t('Date', { size: 7.5, color: mute, x: athBoxX + 8, y: coachBoxY + 87 });

  doc.y = coachBoxY + 108;
  t(`Generated: ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC   ·   Revision ${plan.accepted_rev ?? plan.current_rev}   ·   ${plan.athlete_name} / ${plan.coach_name}`, { size: 7.5, color: mute, align: 'center' });

  // ── Page footers ──────────────────────────────────────────────────────────
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i); doc.page.margins.bottom = 0;
    t(`${plan.title}  |  generated ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC  |  Page ${i + 1} of ${range.count}`, { size: 7, color: mute, y: doc.page.height - 28, lineBreak: false, align: 'center' });
  }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}
