// Branded PDF of an athlete season / career export pack (#332). Drawn only from the frozen pack snapshot, so the document can never contain
// more than the pack did; a template chooses presentation (header, title, free text, footer) and the brand kit supplies name, colours and logo.
import PDFDocument from 'pdfkit';
import { AppError } from '../errors.js';
import { fonts, assertGlyphs } from './render.js';
import { SECTION_LABEL } from '../export-pack.js';

const MM = 72 / 25.4;
const hex = (c, d) => (/^#[0-9A-Fa-f]{6}$/.test(c ?? '') ? c : d);
const TEXT_SIZE = { small: 8, normal: 9, large: 12 };
const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const when = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** The printable lines of each section: [title, detail, trailing label]. */
export function sectionLines(p) {
  const out = [];
  if (p.matches) {
    out.push({ key: 'matches', note: p.matches.truncated ? 'Only the most recent matches are listed.' : null, summary: p.matches.summary.map((s) => `${s.sport}: ${s.matches} matches (${s.wins} W, ${s.draws} D, ${s.losses} L) · ${s.official} official, ${s.self_reported} self-reported`),
      rows: p.matches.rows.map((m) => [`${m.played_on}  ${m.sport}  ${m.title ?? m.competition ?? nice(m.kind)}`, [m.opponent && `vs ${m.opponent}`, m.competition, m.result && nice(m.result), m.score_for != null && `${m.score_for}${m.score_against != null ? `-${m.score_against}` : ''}`, m.minutes != null && `${m.minutes} min`].filter(Boolean).join(' · '), m.provenance.startsWith('official') ? 'official' : nice(m.provenance)]) });
  }
  if (p.results) {
    out.push({ key: 'results', note: p.results.truncated ? 'Only the most recent results are listed.' : null, summary: p.results.bests.map((b) => `Best ${b.sport} ${nice(b.metric)}: ${b.best}${b.unit ? ` ${b.unit}` : ''} (${b.direction === 'lower' ? 'lower is better' : 'higher is better'}, approved competition, ${b.on_date})`),
      rows: p.results.rows.map((r) => [`${r.on_date}  ${r.sport}  ${nice(r.metric)}: ${r.value}${r.unit ? ` ${r.unit}` : ''}`, [r.event_name, nice(r.status), r.has_evidence && 'evidence attached'].filter(Boolean).join(' · '), r.provenance === 'approved_competition' ? 'approved competition' : nice(r.provenance)]) });
  }
  if (p.goals) {
    out.push({ key: 'goals', summary: [], rows: p.goals.rows.map((g) => [g.title, [nice(g.category), nice(g.status), g.target_value != null && `target ${g.target_value}${g.unit ? ` ${g.unit}` : ''}`, g.latest_value != null && `latest ${g.latest_value}${g.unit ? ` ${g.unit}` : ''} on ${g.latest_on}`, g.measure, g.coach_rating && `coach rating: ${nice(g.coach_rating)}`].filter(Boolean).join(' · '), 'athlete claim']) });
  }
  if (p.awards) out.push({ key: 'awards', summary: [], rows: p.awards.rows.map((a) => [`${a.awarded_on}  ${a.name}`, [nice(a.kind), a.event_name, a.awarded_by && `awarded by ${a.awarded_by}`].filter(Boolean).join(' · '), 'organiser awarded']) });
  if (p.career) out.push({ key: 'career', summary: [], rows: p.career.rows.map((c) => [`${c.starts_on} to ${c.ends_on ?? 'now'}  ${c.club}`, [c.sport, c.season_label, c.position, nice(c.competition_level), c.evidence_items ? `${c.evidence_items} evidence item${c.evidence_items === 1 ? '' : 's'} on file` : null].filter(Boolean).join(' · '), nice(c.verification_status)]) });
  if (p.reports) out.push({ key: 'reports', summary: [], rows: p.reports.rows.map((r) => [`${r.title} (version ${r.version})`, `By ${r.coach_name} · ${r.period_from} to ${r.period_to} · published ${String(r.published_at).slice(0, 10)}`, `sha256 ${r.sha256.slice(0, 12)}`]) });
  if (p.evidence) out.push({ key: 'evidence', summary: p.evidence.notes, rows: [] });
  return out;
}

/** @param {{ layout: object, kit: object|null, logo: Buffer|null, pack: object, createdAt: Date, packId: string, sha256: string }} a @returns {Promise<{buffer: Buffer, pages: number}>} */
export async function renderSeasonReport({ layout, kit, logo, pack, createdAt, packId, sha256 }) {
  const f = fonts();
  const secs = sectionLines(pack);
  const strings = [kit?.display_name, kit?.legal_name, kit?.address, kit?.footer_text, pack.athlete.display_name, pack.scope.label, ...layout.blocks.map((b) => b.text),
    ...secs.flatMap((s) => [...s.summary, s.note, ...s.rows.flat()]), ...pack.withheld.map((w) => w.reason)];
  assertGlyphs(strings, f);
  const accent = hex(kit?.primary_color, '#0F6E56'), ink = hex(kit?.secondary_color, '#444441');
  const title = `${pack.athlete.display_name} · ${pack.scope.label}`;
  const doc = new PDFDocument({ size: layout.paper, layout: layout.orientation, margin: layout.margin_mm * MM, bufferPages: true, compress: true,
    info: { Title: title, Author: kit?.display_name ?? 'Sportarena', CreationDate: createdAt, Producer: 'Sportarena' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
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
      label(kit?.display_name ?? 'Sportarena', x, top, width - (x - left), { bold: true, size: 14, color: accent });
      const sub = [kit?.legal_name, kit?.address, [kit?.contact_email, kit?.phone].filter(Boolean).join(' · '), kit?.website].filter(Boolean).join('\n');
      if (sub) label(sub, x, doc.y + 2, width - (x - left), { size: 8 });
      doc.y = Math.max(doc.y, top + (logo ? 60 : 0)) + 14;
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).stroke(accent); doc.y += 12;
    } else if (b.type === 'title') {
      label(pack.athlete.display_name, left, doc.y, width, { bold: true, size: 18, color: accent });
      label(`${pack.scope.label} · prepared ${when(pack.generated_at)}`, left, doc.y + 2, width, { size: 9 });
      label(pack.notice, left, doc.y + 2, width, { size: 8 });
      doc.y += 10;
      for (const s of secs) {
        room(60);
        label((SECTION_LABEL[s.key] ?? s.key).toUpperCase(), left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 4;
        for (const line of s.summary) { room(14); label(line, left, doc.y, width, { size: 9 }); doc.y += 2; }
        if (s.note) { label(s.note, left, doc.y, width, { size: 8 }); doc.y += 2; }
        if (!s.rows.length && s.key !== 'evidence') { label('Nothing recorded for this selection.', left, doc.y, width, { size: 9 }); doc.y += 4; }
        for (const [head, detail, tag] of s.rows) {
          room(30);
          const y = doc.y;
          label(head, left, y, width - 130, { bold: true, size: 9 });
          label(tag, left + width - 125, y, 125, { size: 7, align: 'right', color: accent });
          if (detail) label(detail, left, doc.y + 1, width, { size: 8 });
          doc.y += 4;
        }
        doc.y += 8;
      }
      if (pack.withheld.length) {
        room(40);
        label('NOT INCLUDED', left, doc.y, width, { bold: true, size: 9, color: accent }); doc.y += 4;
        for (const w of pack.withheld) { label(`${SECTION_LABEL[w.section] ?? w.section}: ${w.reason}`, left, doc.y, width, { size: 8 }); doc.y += 2; }
      }
      room(30);
      label(`Never included: ${pack.never_included.map(nice).join(', ')}.`, left, doc.y + 2, width, { size: 8 });
      label(`Fingerprint sha256:${sha256}`, left, doc.y + 2, width, { size: 7 });
      doc.y += 10;
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
    if (wantsFooter && kit?.footer_text) label(kit.footer_text, left, y, width - 200, { size: 8, lineBreak: false });
    label(`${pack.scope.label} · pack ${packId.slice(0, 8)} · Page ${i + 1} of ${range.count}`, left + width - 260, y, 260, { size: 8, align: 'right', lineBreak: false });
  }
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}
