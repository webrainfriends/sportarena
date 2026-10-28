// Referee reporting extract PDF (#88): drawn only from the frozen snapshot built by officials-extract.js, so it can never show more than the referee may see.
// Layout: a summary page, then one closure report per completed match (each page headed with the event, organisation and match details, their logos and the
// referee's name), then other assignments, payments, feedback and disputes. Every page has margins, a footer with the record's identity and "Page X of Y".
import PDFDocument from 'pdfkit';
import { fonts, assertGlyphs } from './render.js';

const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const cap1 = (s) => nice(s).replace(/^./, (m) => m.toUpperCase());
const when = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');
const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const amt = (minor, cur) => `${(Number(minor) / 100).toFixed(2)} ${cur ?? ''}`.trim();
const ROLE = { referee: 'Referee', umpire: 'Umpire', linesman: 'Assistant referee', scorer: 'Scorer / timekeeper' };

/** The document as plain text blocks. The PDF is drawn from exactly this, so the glyph check and the tests cover everything that is printed. */
export function extractModel(s) {
  const f = s.feedback;
  const rows = s.assignments;
  const model = {
    referee: s.official.name, handle: s.official.handle, period: `${s.period.from} to ${s.period.to}`,
    head: [s.sports.length ? `Officiating sports: ${s.sports.join(', ')}` : 'No officiating sport profile',
      ...s.credentials.map((c) => `${c.sport}: ${c.verified_until ? `verified official until ${day(c.verified_until)}` : 'not currently verified'}${c.licence ? ` · ${c.licence}` : ''}`),
      ...(s.truncated ? ['Only the first 300 assignments of the period are listed.'] : [])],
    stats: [['Assignments', s.counts.assignments], ['Completed', s.counts.completed], ['Reports filed', s.counts.reports], ['Disputes linked', s.counts.disputes]],
    overview: rows.map((a) => [day(a.scheduled_at), a.match, a.event, ROLE[a.role] ?? a.role, cap1(a.status), a.fee_minor != null ? `${amt(a.fee_minor, a.fee_currency)} · ${nice(a.pay_status)}` : '']),
    matches: [], others: [],
  };
  for (const a of rows) {
    const cl = a.closure;
    if (!cl) {
      model.others.push({ title: `${day(a.scheduled_at)}  ${a.match}`, meta: [a.sport, a.event, ROLE[a.role] ?? a.role, cap1(a.status)].filter(Boolean).join(' · '),
        lines: [...(a.reason ? [`Reason recorded: ${a.reason}`] : []), `History: ${a.history.map((h) => `${nice(h.to_status)} ${day(h.at)}${h.reason ? ` (${h.reason})` : ''}`).join(' > ') || 'none'}`, ...(a.fee_minor != null ? [`Fee ${amt(a.fee_minor, a.fee_currency)} · payment ${nice(a.pay_status)}`] : [])] });
      continue;
    }
    const h = a.header ?? {};
    const blocks = [];
    blocks.push({ h: 'Result', lines: [cl.score ?? 'Not recorded'] });
    if (cl.sheet) {
      const sh = cl.sheet;
      const closure = [`Score sheet version ${sh.version} · ${nice(sh.status)} · ${nice(sh.source)}`, `Submitted ${when(sh.submitted_at) || 'n/a'} · approved ${when(sh.approved_at) || 'n/a'} · published ${when(sh.published_at) || 'n/a'}`];
      if (sh.totals && Object.keys(sh.totals).length) closure.push(`Totals: ${JSON.stringify(sh.totals)}`);
      for (const [k, t] of [['Adjusted because', sh.adjusted_reason], ['Approved without every sign-off because', sh.waived_reason], ['Sheet notes', sh.notes]]) if (t) closure.push(`${k}: ${t}`);
      if (sh.anomalies.length) closure.push(`Checks raised: ${sh.anomalies.join('; ')}`);
      blocks.push({ h: 'Closure form', lines: closure });
      blocks.push({ h: 'Sign-offs', lines: cl.signoffs.length ? cl.signoffs.map((g) => `${cap1(g.role)} · ${g.display_name} · ${g.decision} ${when(g.at)}${g.comment ? ` · "${g.comment}"` : ''}`) : ['No sign-offs recorded.'] });
      if (cl.log.length) blocks.push({ h: 'Sheet history', lines: cl.log.map((l) => `${when(l.at)} · ${l.display_name} · ${nice(l.action)}${l.note ? ` · ${l.note}` : ''}`) });
    } else blocks.push({ h: 'Closure form', lines: ['No score sheet: the result was recorded directly by the organiser or referee.'] });
    blocks.push({ h: 'Match reports', lines: cl.reports.length ? cl.reports.flatMap((r) => r.revisions.map((v) => `${cap1(r.category)} · revision ${v.revision} · ${when(v.at)}${v.reason ? ` · reason: ${v.reason}` : ''}\n${v.summary}${v.note ? `\n${v.note}` : ''}`)) : ['No report filed.'] });
    blocks.push({ h: 'Assignment history', lines: [a.history.map((x) => `${nice(x.to_status)} ${day(x.at)}${x.reason ? ` (${x.reason})` : ''}`).join(' > ') || 'none'] });
    if (a.fee_minor != null) blocks.push({ h: 'Fee and payment', lines: [`Fee ${amt(a.fee_minor, a.fee_currency)} · ${nice(a.pay_status)}${a.pay_confirmed_at ? ` · receipt confirmed ${day(a.pay_confirmed_at)}` : ''}`, ...a.pay_log.map((l) => `${when(l.at)} · ${l.actor_name} · ${nice(l.from_status)} > ${nice(l.to_status)}${l.note ? ` · ${l.note}` : ''}`)] });
    model.matches.push({
      organisation: h.organisation ?? null, event: h.event ?? a.event, eventDates: h.starts_on ? `${day(h.starts_on)}${h.ends_on && day(h.ends_on) !== day(h.starts_on) ? ` to ${day(h.ends_on)}` : ''}${h.city ? ` · ${h.city}` : ''}` : (h.city ?? ''),
      logos: [h.event_logo, h.organisation_logo].filter(Boolean),
      match: a.match, when: `${when(a.scheduled_at)} · ${a.duration_min} min`, details: [a.sport, a.round, a.venue, a.city].filter(Boolean).join(' · '), role: ROLE[a.role] ?? a.role, blocks,
    });
  }
  model.payments = [...s.payments.totals.map((t) => `Totals ${t.currency}: agreed ${amt(t.agreed, '')} · due ${amt(t.due, '')} · paid ${amt(t.paid, '')} · disputed ${amt(t.disputed, '')}`),
    ...rows.filter((a) => a.pay_log.length).flatMap((a) => [`${day(a.scheduled_at)}  ${a.match}`, ...a.pay_log.map((l) => `   ${when(l.at)} · ${l.actor_name} · ${nice(l.from_status)} > ${nice(l.to_status)}${l.fee_minor != null ? ` · ${amt(l.fee_minor, l.fee_currency)}` : ''}${l.note ? ` · ${l.note}` : ''}`)])];
  if (!model.payments.length) model.payments = ['No fees were recorded in this period.'];
  model.feedback = !f.enough ? [`${f.responses} response${f.responses === 1 ? '' : 's'} so far. Feedback is shown once at least ${f.minimum} people have answered, so no one person can be identified.`]
    : [`${f.responses} responses. Average per criterion (1 to 5); there is no overall score.`, ...f.criteria.map((c) => `${c.label}: ${c.average ?? 'n/a'} (${c.responses} responses)`),
      ...f.comments.map((c) => `${day(c.match_on)} · ${c.event_name} · ${nice(c.capacity)}${c.status === 'contested' ? ' · contested' : ''}${c.comment ? `\n"${c.comment}"` : ''}${c.reply ? `\nOfficial's reply: "${c.reply}"` : ''}`)];
  model.disputes = s.disputes.length ? s.disputes.map((d) => `Case #${d.case_no} · ${nice(d.status)} · ${d.subject} · ${day(d.created_at)}`) : ['No disputes were linked to these matches.'];
  return model;
}

/** Every printable string of a snapshot (used by tests and the glyph check). */
export function extractLines(s) {
  const m = extractModel(s);
  return [m.referee, m.handle, m.period, ...m.head, ...m.stats.flat().map(String), ...m.overview.flat(),
    ...m.matches.flatMap((x) => [x.organisation, x.event, x.eventDates, x.match, x.when, x.details, x.role, ...x.blocks.flatMap((b) => [b.h, ...b.lines])]),
    ...m.others.flatMap((o) => [o.title, o.meta, ...o.lines]), ...m.payments, ...m.feedback, ...m.disputes].filter((x) => x != null && x !== '');
}

/** @returns {Promise<{buffer: Buffer, pages: number}>} */
export async function renderOfficialExtract({ snapshot, createdAt, id, sha256, logos = new Map() }) {
  const f = fonts();
  const M = extractModel(snapshot);
  assertGlyphs([...extractLines(snapshot), 'Officiating record'], f);
  const accent = '#0F6E56', ink = '#222222', mute = '#666666', rule = '#CCCCCC', wash = '#F1F6F4';
  const MARGIN = 44, TOP = 122, BOTTOM = 64;
  const doc = new PDFDocument({ size: 'A4', margins: { top: TOP, bottom: BOTTOM, left: MARGIN, right: MARGIN }, bufferPages: true, compress: true,
    info: { Title: `Officiating record · ${M.referee}`, Author: 'Sportarena', CreationDate: createdAt, Producer: 'Sportarena' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  const W = doc.page.width - 2 * MARGIN, left = MARGIN, limit = () => doc.page.height - BOTTOM;
  let ctx = { kind: 'summary', title: 'Officiating record' };
  const ctxs = [ctx];
  doc.on('pageAdded', () => ctxs.push(ctx));
  const room = (h) => { if (doc.y + h > limit()) doc.addPage(); };
  const text = (t, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t, left + (o.indent ?? 0), doc.y, { width: W - (o.indent ?? 0), lineGap: 1.6 });
  const h2 = (t) => { room(48); doc.moveDown(0.7); text(t, { bold: true, size: 12, color: accent }); doc.moveTo(left, doc.y + 1).lineTo(left + W, doc.y + 1).lineWidth(0.6).stroke(rule); doc.moveDown(0.4); };
  const h3 = (t) => { room(34); doc.moveDown(0.5); text(t.toUpperCase(), { bold: true, size: 8, color: mute }); doc.moveDown(0.1); };
  const para = (t, o = {}) => { for (const part of String(t).split('\n')) { room(18); text(part, { size: 9, ...o, indent: (o.indent ?? 0) + (part === t ? 0 : 0) }); } };
  const cols = (cells, widths, o = {}) => {
    room(16); const y = doc.y; let x = left;
    cells.forEach((c, i) => { doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 8.5).fillColor(o.color ?? ink).text(String(c ?? ''), x, y, { width: widths[i] - 6, height: 12, ellipsis: true, lineBreak: false }); x += widths[i]; });
    doc.y = y + 14;
  };

  // ---- summary page
  text('This record lists every assignment in the period and, for each completed match, the closure report: result, score sheet, sign-offs, your own reports, assignment history and fee. Payments, feedback and disputes follow at the end.', { size: 9, color: mute });
  doc.moveDown(0.8);
  const bw = (W - 3 * 10) / 4, y0 = doc.y;
  M.stats.forEach(([label, v], i) => { const x = left + i * (bw + 10); doc.roundedRect(x, y0, bw, 46, 6).fill(wash); doc.font(f.bold).fontSize(18).fillColor(accent).text(String(v), x + 10, y0 + 7, { width: bw - 20, lineBreak: false }); doc.font(f.regular).fontSize(8).fillColor(mute).text(label, x + 10, y0 + 29, { width: bw - 20, lineBreak: false }); });
  doc.y = y0 + 58;
  for (const t of M.head) text(t, { size: 9, color: mute });
  h2('Assignments in this period');
  const wd = [56, 138, 92, 64, 56, W - 406];
  cols(['Date', 'Match', 'Event', 'Role', 'Status', 'Fee'], wd, { bold: true, size: 8, color: mute });
  if (!M.overview.length) text('No assignments in this period.', { color: mute });
  M.overview.forEach((r, i) => { if (i % 2 === 0) { room(16); doc.rect(left - 2, doc.y - 2, W + 4, 15).fill(wash); } cols(r, wd); });

  // ---- one closure report per completed match
  for (const m of M.matches) {
    ctx = { kind: 'match', ...m };
    doc.addPage();
    for (const b of m.blocks) {
      h3(b.h);
      for (const l of b.lines) para(l, { indent: 0 });
    }
  }
  // ---- everything else
  ctx = { kind: 'summary', title: 'Payments, feedback and disputes' };
  doc.addPage();
  h2('Other assignments');
  if (!M.others.length) text('None in this period.', { color: mute });
  for (const o of M.others) { room(50); text(o.title, { bold: true, size: 9.5 }); text(o.meta, { size: 8, color: mute }); for (const l of o.lines) text(l, { size: 8.5, indent: 8 }); doc.moveDown(0.4); }
  h2('Payments');
  for (const t of M.payments) para(t);
  text('Fees are the amounts recorded by event organisers. A status here means it was recorded, not that SportArena moved the money.', { size: 8, color: mute });
  h2('Feedback');
  for (const t of M.feedback) para(t);
  h2('Disputes linked to these matches');
  for (const t of M.disputes) para(t);
  doc.moveDown(1);
  text(`Document ${id}. Fingerprint ${sha256}. Generated ${when(createdAt)}. This extract is a frozen snapshot: later changes to the records do not alter it.`, { size: 7.5, color: mute });

  // ---- headers and footers, drawn on every page now that the page count is known
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.top = 0; doc.page.margins.bottom = 0;
    const c = ctxs[i] ?? ctxs[ctxs.length - 1];
    const put = (t, x, y, w, o = {}) => doc.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? ink).text(t ?? '', x, y, { width: w, align: o.align ?? 'left', height: o.h ?? 14, ellipsis: true, lineBreak: false });
    doc.rect(0, 0, doc.page.width, 8).fill(accent);
    if (c.kind === 'match') {
      let x = left;
      for (const sha of c.logos) { const buf = logos.get(sha); if (!buf) continue; try { doc.image(buf, x, 24, { fit: [52, 52] }); x += 60; } catch { /* an unreadable logo is left out rather than failing the report */ } }
      const tw = Math.max(120, left + W - 170 - x);
      if (c.organisation) put(c.organisation.toUpperCase(), x, 24, tw, { size: 7.5, bold: true, color: mute });
      put(c.event, x, 35, tw, { size: 13, bold: true, color: accent, h: 17 });
      put(c.eventDates, x, 54, tw, { size: 8, color: mute });
      put(c.match, left, 84, W - 170, { size: 11.5, bold: true, h: 16 });
      put([c.when, c.details].filter(Boolean).join(' · '), left, 100, W - 170, { size: 8, color: mute });
      put('REFEREE REPORT', left + W - 160, 24, 160, { size: 7.5, bold: true, color: mute, align: 'right' });
      put(M.referee, left + W - 170, 35, 170, { size: 12, bold: true, align: 'right', h: 16 });
      put(c.role, left + W - 160, 52, 160, { size: 8, color: mute, align: 'right' });
    } else {
      put('SPORTARENA', left, 24, 200, { size: 8, bold: true, color: mute });
      put(c.title, left, 36, W - 190, { size: 14, bold: true, color: accent, h: 18 });
      put(M.period, left, 58, W - 190, { size: 8.5, color: mute });
      put('REFEREE', left + W - 160, 24, 160, { size: 7.5, bold: true, color: mute, align: 'right' });
      put(M.referee, left + W - 190, 36, 190, { size: 12, bold: true, align: 'right', h: 16 });
      put(`@${M.handle}`, left + W - 160, 54, 160, { size: 8, color: mute, align: 'right' });
    }
    doc.moveTo(left, TOP - 14).lineTo(left + W, TOP - 14).lineWidth(0.8).stroke(accent);
    const fy = doc.page.height - BOTTOM + 14;
    doc.moveTo(left, fy - 6).lineTo(left + W, fy - 6).lineWidth(0.5).stroke(rule);
    put(`Officiating record · ${M.referee} · ${M.period}`, left, fy, W - 90, { size: 7.5, color: mute });
    put(`Page ${i + 1} of ${range.count}`, left + W - 90, fy, 90, { size: 7.5, color: mute, align: 'right' });
    put(`Document ${String(id).slice(0, 8)} · fingerprint ${String(sha256).slice(0, 16)} · frozen snapshot`, left, fy + 11, W, { size: 6.5, color: mute });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}
