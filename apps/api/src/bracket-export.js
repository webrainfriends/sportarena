// Printable / embeddable / PDF outputs of an event's published brackets. One model (`sheetOf`) is built from the same public stage views the app
// shows, then rendered as accessible HTML (lists and tables, no reliance on drawn lines; also the print stylesheet and the embed) or as a PDF.
import PDFDocument from 'pdfkit';
import { esc } from './share-cards.js';
import { assertGlyphs, fonts } from './documents/render.js';

const teamName = (g, side) => g[`${side}_name`] ?? g[`${side}_placeholder`] ?? 'To be decided';
const STATE = { scheduled: 'Scheduled', live: 'Live', provisional: 'Provisional', final: 'Final', not_required: 'Not required', cancelled: 'Cancelled' };
const whenOf = (g) => { try { return g.scheduled_at ? new Date(g.scheduled_at).toLocaleString('en-GB', { timeZone: g.venue_timezone || 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null; } catch { return null; } };

function lineOf(g) {
  const shown = ['live', 'provisional', 'final'].includes(g.state) || g.tie;
  const score = g.tie ? g.tie.summary : shown && g.home_score != null ? `${g.home_score}–${g.away_score}` : null;
  return { label: g.round ?? '', home: teamName(g, 'home'), away: teamName(g, 'away'), score, state: g.state, state_label: STATE[g.state] ?? g.state, when: g.state === 'scheduled' ? whenOf(g) : null, winner: g.winner_team_id && g.state === 'final' ? (g.winner_team_id === g.home_team_id ? 'home' : 'away') : null,
    legs: g.tie?.games?.map((x) => `${x.leg_no}: ${x.state === 'scheduled' || x.state === 'not_required' ? (STATE[x.state]) : `${x.home_score}–${x.away_score}`}`) ?? null };
}

/** The sheet for an event: only published stages (the caller passes the public views). */
export function sheetOf(ev, stages) {
  const out = { title: ev.name, sport: [ev.sport_emoji, ev.sport].filter(Boolean).join(' '), sport_text: ev.sport ?? '', generated_at: new Date().toISOString(), stages: [] };
  for (const s of stages) {
    const st = { name: s.name, kind: s.kind, status: s.status, algorithm: s.algorithm, draw_seed: s.draw_seed, revision: s.revision, sections: [], tables: [], notes: [] };
    for (const sec of s.sections ?? []) st.sections.push({ label: sec.label, rounds: sec.rounds.map((r) => ({ label: r.label, games: r.games.map(lineOf) })) });
    if (s.third_place) st.sections.push({ label: 'Third place', rounds: [{ label: 'Third place', games: [lineOf(s.third_place)] }] });
    if (s.champion) st.notes.push(`Champion: ${s.champion.name}`);
    if (s.placements?.length > 3) st.tables.push({ title: 'Final placings', head: ['Place', 'Team'], rows: s.placements.map((p) => [`${p.place}${p.shared ? '=' : ''}`, p.name]) });
    if (s.swiss) {
      st.tables.push({ title: `Swiss standings (${s.swiss.rounds.length} of ${s.swiss.rounds_total} rounds, ${s.swiss.policy.replace(/_/g, ' ')})`, head: ['#', 'Team', 'Pts', 'W', 'D', 'L', 'Buchholz'], rows: s.swiss.table.map((r) => [r.rank, r.name, r.points, r.wins, r.draws, r.losses, r.buchholz]) });
      for (const r of s.swiss.rounds) st.sections.push({ label: `Round ${r.round}`, rounds: [{ label: `Round ${r.round}${r.bye ? ` · bye: ${r.bye.name}` : ''}`, games: r.games.map(lineOf) }] });
    }
    for (const p of s.pools ?? []) {
      st.tables.push({ title: `Pool ${p.name}`, head: ['#', 'Team', 'P', 'W', 'D', 'L', 'GD', 'Pts'], rows: p.table.map((r) => [r.rank, r.name, r.played, r.won, r.drawn, r.lost, r.goal_diff, r.points]) });
      st.sections.push({ label: `Pool ${p.name} games`, rounds: [{ label: `Pool ${p.name}`, games: p.games.map(lineOf) }] });
    }
    if (s.draw_seed) st.notes.push(`Draw ${s.algorithm}, seed ${s.draw_seed}, revision ${s.revision}`);
    out.stages.push(st);
  }
  return out;
}

const CSS = `:root{color-scheme:light dark;--bg:#fff;--ink:#181A2F;--mute:#5B6480;--line:#D9DCEB;--win:#E7F6E1;--live:#F43F5E;--accent:#6D4BC8}
@media (prefers-color-scheme:dark){:root{--bg:#23252F;--ink:#F8F5FF;--mute:#A79FCB;--line:#3A3D4F;--win:#27402B}}
[data-theme=light]{--bg:#fff;--ink:#181A2F;--mute:#5B6480;--line:#D9DCEB;--win:#E7F6E1}[data-theme=dark]{--bg:#23252F;--ink:#F8F5FF;--mute:#A79FCB;--line:#3A3D4F;--win:#27402B}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink);line-height:1.4}main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:clamp(22px,4vw,34px);margin:.2em 0}h2{font-size:20px;margin:1.4em 0 .4em}h3{font-size:15px;margin:1em 0 .4em;color:var(--mute);text-transform:uppercase;letter-spacing:.05em}.k{color:var(--mute)}
.rounds{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px}.round{min-width:230px;flex:1}.round ol{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.g{border:1px solid var(--line);border-radius:12px;padding:8px 10px}.g.live{border-color:var(--live)}.g .t{display:flex;justify-content:space-between;gap:8px}.g .w{font-weight:800;background:var(--win);border-radius:6px;padding:0 4px}
.g small{color:var(--mute)}.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:800;background:var(--accent);color:#fff}
table{border-collapse:collapse;width:100%;max-width:640px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}td.n,th.n{text-align:right}.foot{margin-top:24px;font-size:12px;color:var(--mute)}
@media print{:root{--bg:#fff;--ink:#000;--mute:#444;--line:#999;--win:#eee}body{font-size:11pt}.rounds{display:block}.round{min-width:0;break-inside:avoid;margin-bottom:10px}.noprint{display:none}}`;

export function sheetHtml(sheet, { embed = false, theme = null, link = null } = {}) {
  const game = (g) => `<li class="g ${g.state === 'live' ? 'live' : ''}"><div class="t"><span class="${g.winner === 'home' ? 'w' : ''}">${esc(g.home)}</span></div><div class="t"><span class="${g.winner === 'away' ? 'w' : ''}">${esc(g.away)}</span>${g.score ? `<strong>${esc(g.score)}</strong>` : ''}</div>
<small>${esc(g.state_label)}${g.when ? ` · ${esc(g.when)}` : ''}${g.legs ? ` · ${esc(g.legs.join('; '))}` : ''}</small></li>`;
  const table = (t) => `<h3>${esc(t.title)}</h3><table><thead><tr>${t.head.map((h, i) => `<th class="${i > 1 ? 'n' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i > 1 ? 'n' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const body = sheet.stages.length ? sheet.stages.map((s) => `<section aria-label="${esc(s.name)}"><h2>${esc(s.name)} <span class="pill">${esc(s.status.replace('_', ' '))}</span></h2>${s.notes.map((x) => `<p class="k">${esc(x)}</p>`).join('')}
${s.sections.map((sec) => `<h3>${esc(sec.label)}</h3><div class="rounds">${sec.rounds.map((r) => `<div class="round"><strong>${esc(r.label)}</strong><ol>${r.games.map(game).join('')}</ol></div>`).join('')}</div>`).join('')}${s.tables.map(table).join('')}</section>`).join('')
    : '<p class="k">No bracket has been published for this event yet.</p>';
  return `<!doctype html><html lang="en"${theme ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow, noarchive">
<title>${esc(sheet.title)} — bracket</title><style>${CSS}</style></head><body><main>
${embed ? '' : `<p class="k">${esc(sheet.sport)}</p>`}<h1>${esc(sheet.title)}</h1>${body}
<p class="foot">Built from live event data${embed ? '' : ` on ${esc(sheet.generated_at.slice(0, 16).replace('T', ' '))} UTC`}. Provisional results change when official results are published or corrected.${link ? ` <a class="noprint" href="${esc(link)}">Open the full page</a>` : ''}</p></main></body></html>`;
}

/** A4 landscape PDF: games listed round by round under each section, tables for standings. */
export async function sheetPdf(sheet) {
  const f = fonts();
  const strings = [sheet.title, sheet.sport_text, ...sheet.stages.flatMap((s) => [s.name, ...s.notes, ...s.sections.flatMap((x) => [x.label, ...x.rounds.flatMap((r) => [r.label, ...r.games.flatMap((g) => [g.home, g.away, g.score])])]), ...s.tables.flatMap((t) => [t.title, ...t.rows.flat().map(String)])])].filter(Boolean).map(String);
  assertGlyphs(strings, f);
  const M = 36;
  const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margin: M, bufferPages: true, compress: true, info: { Title: `${sheet.title} — bracket`, Author: 'Sportarena', Producer: 'Sportarena' } });
  const chunks = [];
  pdf.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { pdf.on('end', res); pdf.on('error', rej); });
  const W = pdf.page.width - M * 2, bottom = () => pdf.page.height - M - 14;
  let y = M;
  const ensure = (h) => { if (y + h > bottom()) { pdf.addPage(); y = M; } };
  const text = (t, x, w, o = {}) => { pdf.font(o.bold ? f.bold : f.regular).fontSize(o.size ?? 9).fillColor(o.color ?? '#181A2F').text(String(t ?? ''), x, y, { width: w, align: o.align ?? 'left', lineBreak: false, ellipsis: true }); };
  text(sheet.title, M, W, { bold: true, size: 20 }); y += 28;
  text(`${sheet.sport_text} · bracket sheet · ${sheet.generated_at.slice(0, 16).replace('T', ' ')} UTC`, M, W, { size: 9, color: '#5B6480' }); y += 20;
  for (const s of sheet.stages) {
    ensure(40); text(`${s.name}  (${s.status.replace('_', ' ')})`, M, W, { bold: true, size: 14 }); y += 20;
    for (const n of s.notes) { text(n, M, W, { size: 9, color: '#5B6480' }); y += 13; }
    for (const sec of s.sections) {
      ensure(30); text(sec.label.toUpperCase(), M, W, { bold: true, size: 9, color: '#6D4BC8' }); y += 14;
      for (const r of sec.rounds) {
        ensure(24); text(r.label, M, W, { bold: true, size: 10 }); y += 14;
        for (const g of r.games) {
          ensure(16);
          pdf.rect(M, y - 1, W, 15).strokeColor('#D9DCEB').lineWidth(0.5).stroke();
          text(g.home, M + 6, 230, { bold: g.winner === 'home' }); text(g.score ?? 'v', M + 240, 90, { bold: true, align: 'center' }); text(g.away, M + 340, 230, { bold: g.winner === 'away' });
          text([g.state_label, g.when].filter(Boolean).join(' · '), M + 580, W - 580 - 6, { size: 8, color: '#5B6480', align: 'right' });
          y += 17;
        }
        y += 4;
      }
    }
    for (const t of s.tables) {
      ensure(40); text(t.title, M, W, { bold: true, size: 10 }); y += 14;
      const cw = [34, 220, ...t.head.slice(2).map(() => 44)];
      let x = M; t.head.forEach((h, i) => { text(h, x, cw[i], { bold: true, size: 8, align: i > 1 ? 'right' : 'left' }); x += cw[i]; }); y += 12;
      for (const row of t.rows) { ensure(14); x = M; row.forEach((c, i) => { text(c, x, cw[i], { size: 9, align: i > 1 ? 'right' : 'left' }); x += cw[i]; }); y += 13; }
      y += 8;
    }
  }
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) { pdf.switchToPage(i); pdf.font(f.regular).fontSize(8).fillColor('#5B6480').text(`Page ${i + 1} of ${range.count} · provisional results change when official results are published or corrected`, M, pdf.page.height - M, { width: W, align: 'center', lineBreak: false }); }
  pdf.end();
  await done;
  return { buffer: Buffer.concat(chunks), pages: range.count };
}
