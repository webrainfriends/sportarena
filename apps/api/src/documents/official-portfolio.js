// PDF renderer for the official career portfolio (#1009). Returns a {buffer, pages} object.
// Uses PDFKit matching the same infrastructure as official-extract and other document renderers.
import PDFDocument from 'pdfkit';
import { fonts } from './render.js';

const day = (iso) => (iso ? String(iso).slice(0, 10) : '—');
const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const cap1 = (s) => nice(s).replace(/^./, (m) => m.toUpperCase());
const VER_LABEL = { verified: 'Verified', pending: 'Pending', self_declared: 'Self-declared', rejected: 'Not approved', revoked: 'Revoked' };
const REL_LABEL = { worked_with: 'Worked with', supervised: 'Supervised', assessed: 'Assessed', appointed: 'Appointed' };
const PURPLE = '#8458B3';
const INK = '#2F3242';
const MUTE = '#5F6580';
const GREEN = '#0A6640';
const GREEN_BG = '#D1F5E8';

/** Render an official's career portfolio as a PDF. Returns {buffer, pages}. */
export async function renderOfficialPortfolioPdf({ snapshot, id, sha256, createdAt }) {
  const { user, summary, by_sport = [], grades = [], licences = [], verifications = [], milestones = [], references = [] } = snapshot;
  const f = fonts();
  const pdf = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, compress: true, info: { Title: 'Officiating Career Portfolio', Author: user?.display_name ?? 'Official', CreationDate: createdAt } });
  const chunks = []; pdf.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { pdf.on('end', res); pdf.on('error', rej); });
  const W = pdf.page.width - 80; // content width (40 margin each side)
  const bot = () => pdf.page.height - pdf.page.margins.bottom - 20;
  let pageNum = 0;

  const footer = () => {
    pageNum++;
    pdf.font(f.regular).fontSize(7).fillColor(MUTE)
      .text(`Career Portfolio · ${user?.display_name ?? ''} · Page ${pageNum} · ${day(createdAt.toISOString())} · ${sha256.slice(0, 16)}…`, 40, bot(), { width: W, align: 'center' });
  };
  pdf.on('pageAdded', footer);
  footer(); // first page

  const h1 = (txt) => { pdf.font(f.bold).fontSize(20).fillColor(INK).text(txt, 40, pdf.y, { width: W }); pdf.moveDown(0.3); };
  const h2 = (txt) => {
    if (pdf.y > bot() - 60) { pdf.addPage(); }
    pdf.font(f.bold).fontSize(13).fillColor(PURPLE).text(txt, 40, pdf.y, { width: W });
    pdf.moveTo(40, pdf.y).lineTo(40 + W, pdf.y).strokeColor(PURPLE).lineWidth(1).stroke();
    pdf.moveDown(0.5);
  };
  const body = (txt, opts = {}) => { pdf.font(f.regular).fontSize(9).fillColor(opts.color ?? INK).text(txt, 40, pdf.y, { width: opts.w ?? W, continued: opts.cont ?? false }); };
  const small = (txt) => { pdf.font(f.regular).fontSize(8).fillColor(MUTE).text(txt, 40, pdf.y, { width: W }); };
  const rule = () => { pdf.moveTo(40, pdf.y + 2).lineTo(40 + W, pdf.y + 2).strokeColor('#E5EAF5').lineWidth(0.5).stroke(); pdf.moveDown(0.4); };

  // ── Header ──────────────────────────────────────────────────────────────────
  h1(`${user?.display_name ?? 'Official'} — Officiating Career Portfolio`);
  small(`Generated ${day(createdAt.toISOString())} · Document ID ${id} · SHA-256 ${sha256.slice(0, 16)}…`);
  pdf.moveDown(1);

  // ── Verification badge ──────────────────────────────────────────────────────
  const topVer = verifications[0];
  if (topVer) {
    const isVer = topVer.status === 'verified';
    pdf.rect(40, pdf.y, 160, 18).fill(isVer ? GREEN_BG : '#EEF0F7');
    pdf.font(f.bold).fontSize(8.5).fillColor(isVer ? GREEN : MUTE)
      .text(isVer ? '✓ Verified Official' : 'Profile not yet verified', 46, pdf.y - 14, { width: 148 });
    pdf.moveDown(1.2);
  }

  // ── Career Summary ──────────────────────────────────────────────────────────
  h2('Career Summary');
  const metrics = [
    ['Total Matches', summary.total_matches],
    ['Sports', summary.sports_count],
    ['Years Active', summary.years_active],
  ];
  const mW = Math.floor(W / 3) - 8;
  const mY = pdf.y;
  metrics.forEach(([label, val], i) => {
    const mx = 40 + i * (mW + 12);
    pdf.rect(mx, mY, mW, 44).fill('#F3EEFF');
    pdf.font(f.bold).fontSize(22).fillColor(PURPLE).text(String(val), mx, mY + 6, { width: mW, align: 'center' });
    pdf.font(f.regular).fontSize(8).fillColor(MUTE).text(label, mx, mY + 30, { width: mW, align: 'center' });
  });
  pdf.y = mY + 54;
  if (summary.first_match) {
    small(`${day(summary.first_match)} → ${day(summary.last_match)}`);
  }
  pdf.moveDown(1);

  // ── Career by Sport ─────────────────────────────────────────────────────────
  if (by_sport.length) {
    h2('Career by Sport');
    // Table header
    const cols = [{ t: 'Sport', w: 160 }, { t: 'Role(s)', w: 160 }, { t: 'Matches', w: 60 }, { t: 'Platform-verified', w: 90 }];
    let tx = 40;
    const thY = pdf.y;
    pdf.rect(40, thY, W, 16).fill('#F3EEFF');
    for (const col of cols) {
      pdf.font(f.bold).fontSize(8).fillColor(PURPLE).text(col.t, tx, thY + 4, { width: col.w });
      tx += col.w;
    }
    pdf.y = thY + 20;
    for (const s of by_sport) {
      if (pdf.y > bot() - 24) { pdf.addPage(); }
      const rY = pdf.y;
      let rx = 40;
      const rowData = [
        `${s.sport_emoji ?? ''} ${s.sport_name}`,
        (s.roles ?? []).map((r) => cap1(r)).join(', ') || '—',
        String(s.total_matches),
        String(s.verified_matches ?? 0),
      ];
      cols.forEach((col, ci) => {
        pdf.font(f.regular).fontSize(9).fillColor(INK).text(rowData[ci], rx, rY, { width: col.w - 4 });
        rx += col.w;
      });
      pdf.y = rY + 16;
      rule();
    }
    pdf.moveDown(0.5);
  }

  // ── Grades & Credentials ────────────────────────────────────────────────────
  if (grades.length) {
    h2('Grades & Credentials');
    for (const g of grades) {
      if (pdf.y > bot() - 48) { pdf.addPage(); }
      pdf.font(f.bold).fontSize(10).fillColor(INK).text(`${g.level_code} — ${g.level_name}`, 40, pdf.y, { width: W - 120 });
      const verCol = g.verification_status === 'verified' ? GREEN : MUTE;
      pdf.font(f.bold).fontSize(8).fillColor(verCol).text(VER_LABEL[g.verification_status] ?? g.verification_status, 40 + W - 110, pdf.y - 14, { width: 110, align: 'right' });
      pdf.font(f.regular).fontSize(8.5).fillColor(MUTE).text(`${g.scheme_name} · ${g.governing_body_abbr ?? g.governing_body}${g.sport_name ? ' · ' + g.sport_name : ''}${g.effective_from ? ' · From ' + day(g.effective_from) : ''}`, 40, pdf.y, { width: W });
      pdf.moveDown(0.8);
      rule();
    }
    pdf.moveDown(0.5);
  }

  // ── Federation Licences ──────────────────────────────────────────────────────
  if (licences.length) {
    h2('Federation Licences');
    for (const l of licences) {
      if (pdf.y > bot() - 40) { pdf.addPage(); }
      pdf.font(f.bold).fontSize(10).fillColor(INK).text(l.licence_type_name, 40, pdf.y, { width: W });
      pdf.font(f.regular).fontSize(8.5).fillColor(MUTE).text(`${l.body_name}${l.sport_name ? ' · ' + l.sport_name : ''} · ${day(l.issued_on)} → ${l.expires_on ? day(l.expires_on) : 'No expiry'} · ${cap1(l.status)}`, 40, pdf.y, { width: W });
      pdf.moveDown(0.8);
      rule();
    }
    pdf.moveDown(0.5);
  }

  // ── Career Milestones ────────────────────────────────────────────────────────
  if (milestones.length) {
    h2('Career Milestones');
    for (const m of milestones) {
      if (pdf.y > bot() - 48) { pdf.addPage(); }
      const isChamp = m.is_championship;
      pdf.rect(40, pdf.y, 8, 8).fill(isChamp ? '#F97316' : PURPLE);
      pdf.font(f.bold).fontSize(10).fillColor(INK).text(`${isChamp ? '🏆 ' : ''}${m.title}`, 56, pdf.y - 6, { width: W - 20 });
      const verCol = m.verification_status === 'verified' ? GREEN : MUTE;
      pdf.font(f.bold).fontSize(8).fillColor(verCol).text(VER_LABEL[m.verification_status] ?? m.verification_status, 40 + W - 110, pdf.y - 14, { width: 110, align: 'right' });
      pdf.font(f.regular).fontSize(8.5).fillColor(MUTE).text(
        [day(m.milestone_date), m.competition_name, m.role, m.sport_name].filter(Boolean).join(' · '),
        56, pdf.y, { width: W - 20 },
      );
      pdf.moveDown(0.9);
      rule();
    }
    pdf.moveDown(0.5);
  }

  // ── Professional References ──────────────────────────────────────────────────
  if (references.length) {
    h2('Professional References');
    for (const ref of references) {
      if (pdf.y > bot() - 48) { pdf.addPage(); }
      pdf.font(f.bold).fontSize(10).fillColor(INK).text(ref.org_name ?? ref.body_name ?? 'Organisation', 40, pdf.y, { width: W - 120 });
      pdf.font(f.bold).fontSize(8).fillColor(GREEN).text('✓ Approved', 40 + W - 110, pdf.y - 14, { width: 110, align: 'right' });
      if (ref.sport_name) { pdf.font(f.regular).fontSize(8.5).fillColor(MUTE).text(ref.sport_name, 40, pdf.y, { width: W }); }
      pdf.font(f.regular).fontSize(8.5).fillColor(MUTE).text(REL_LABEL[ref.relationship] ?? cap1(ref.relationship), 40, pdf.y, { width: W });
      if (ref.public_summary) { pdf.font(f.regular).fontSize(9).fillColor(INK).text(`"${ref.public_summary}"`, 40, pdf.y, { width: W }); }
      pdf.moveDown(0.9);
      rule();
    }
    pdf.moveDown(0.5);
  }

  pdf.end();
  await done;
  const buffer = Buffer.concat(chunks);
  const pages = pdf.bufferedPageRange().count;
  return { buffer, pages };
}
