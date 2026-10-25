// Draws the sport-specific scoresheet forms described in tracking/forms.js onto a pdfkit page. Print-only: nothing here computes a score.
// render.js owns the document, header, QR code, notes, signatures and footer; this module owns the body between the names and the notes.
const numbered = (n, from = 1) => Array.from({ length: n }, (_, i) => String(from + i));

/**
 * @param {object} form  layout.form
 * @param {object} ctx   { doc, left, width, accent, label, box, room, bottom, home, away }
 */
export function drawForm(form, ctx) {
  const { doc, left, width, accent, label, box, room, bottom } = ctx;
  const side = (s) => (s === 'home' ? ctx.home : ctx.away) || (s === 'home' ? 'HOME' : 'AWAY');

  /** One table at x/w. Weights are relative. Returns the y below it. Splits over pages unless nobreak. */
  function table(spec, { x = left, w = width, nobreak = false, title = spec.title } = {}) {
    const tw = w * (spec.width ?? 1), total = spec.cols.reduce((a, c) => a + c.w, 0), cw = spec.cols.map((c) => (c.w / total) * tw);
    const h = spec.h ?? 16;
    if (!nobreak) room(26 + Math.min(spec.rows, 4) * h);
    if (title) { const ty = doc.y; label(String(title).toUpperCase(), x, ty, w, { bold: true, size: 7.5, color: accent }); doc.y = ty + 11; }
    const head = (y0) => {
      doc.rect(x, y0, tw, 14).fill(accent);
      let cx = x;
      spec.cols.forEach((c, i) => { label(c.t, cx + 2.5, y0 + 3.5, cw[i] - 4, { bold: true, size: 6.5, color: '#FFFFFF' }); cx += cw[i]; });
      return y0 + 14;
    };
    let y = head(doc.y);
    for (let r = 0; r < spec.rows; r++) {
      if (!nobreak && y + h > bottom()) { doc.addPage(); y = head(doc.y); }
      let cx = x;
      spec.cols.forEach((c, i) => { box(cx, y, cw[i], h); if (c.fixed?.[r] != null) label(String(c.fixed[r]), cx + 2.5, y + Math.max(2, (h - 8) / 2), cw[i] - 4, { size: 7 }); cx += cw[i]; });
      y += h;
    }
    doc.y = y + 8;
    return y;
  }

  function pair(spec) {
    const gap = 12, w = (width - gap) / 2, h = (spec.h ?? 15) * spec.rows + 30;
    room(h);
    const y0 = doc.y;
    table(spec, { x: left, w, nobreak: true, title: `${spec.title} - ${side('home')}` });
    const y1 = doc.y; doc.y = y0;
    table(spec, { x: left + w + gap, w, nobreak: true, title: `${spec.title} - ${side('away')}` });
    doc.y = Math.max(y1, doc.y);
  }

  function running(spec) {
    const labelW = 40, per = spec.per, cellW = (width - labelW) / per, ch = spec.compact ? 10.5 : 12, rows = Math.ceil(spec.max / per);
    const blockH = rows * ch + 4;
    room(14 + 2 * blockH);
    const ty = doc.y; label(String(spec.title).toUpperCase(), left, ty, width, { bold: true, size: 7.5, color: accent }); doc.y = ty + 11;
    for (const s of ['home', 'away']) {
      const y0 = doc.y;
      label(side(s), left, y0 + 1, labelW - 4, { bold: true, size: 7 });
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < per; k++) {
          const n = r * per + k + 1;
          if (n > spec.max) break;
          const x = left + labelW + k * cellW;
          box(x, y0 + r * ch, cellW, ch);
          label(String(n), x, y0 + r * ch + 2.2, cellW, { size: 5.2, align: 'center', color: '#444444' });
        }
      }
      doc.y = y0 + blockH;
    }
    doc.y += 6;
  }

  function ticks(spec) {
    const labelW = 130, half = (width - labelW) / 2;
    room(18 + spec.items.length * 14);
    const ty = doc.y;
    label(String(spec.title).toUpperCase(), left, ty, width, { bold: true, size: 7.5, color: accent });
    label(side('home'), left + labelW, ty, half, { size: 6.5, color: '#666666' }); label(side('away'), left + labelW + half, ty, half, { size: 6.5, color: '#666666' });
    let y = ty + 11;
    for (const it of spec.items) {
      label(it.label, left, y + 1, labelW - 6, { size: 7.5 });
      for (let k = 0; k < it.n; k++) { box(left + labelW + k * 11, y, 9, 9); box(left + labelW + half + k * 11, y, 9, 9); }
      y += 14;
    }
    doc.y = y;
    doc.y += 4;
  }

  function choices(spec) {
    room(30);
    const ty = doc.y; label(String(spec.title).toUpperCase(), left, ty, width, { bold: true, size: 7.5, color: accent });
    let x = left, y = ty + 11;
    for (const it of spec.items) {
      const w = 22 + it.length * 4.2;
      if (x + w > left + width) { x = left; y += 14; }
      box(x, y, 9, 9); label(it, x + 13, y + 1, w - 14, { size: 7.5 });
      x += w + 10;
    }
    doc.y = y + 18;
  }

  function fields(spec) {
    const per = spec.per ?? 3, w = width / per;
    for (let i = 0; i < spec.items.length; i += per) {
      room(30);
      const y = doc.y;
      spec.items.slice(i, i + per).forEach((t, k) => {
        label(t.toUpperCase(), left + k * w, y, w - 8, { size: 6.2, color: '#666666' });
        doc.moveTo(left + k * w, y + 20).lineTo(left + (k + 1) * w - 8, y + 20).lineWidth(0.5).stroke('#888888');
      });
      doc.y = y + 26;
    }
  }

  /** A bordered text box: local rules in force, or any printed instructions. */
  function note(spec) {
    const lines = spec.lines ?? [], h = 18 + lines.length * 10;
    room(h + 8);
    const y = doc.y;
    doc.lineWidth(1).strokeColor('#B54708').rect(left, y, width, h).stroke();
    label(String(spec.title).toUpperCase(), left + 5, y + 4, width - 10, { bold: true, size: 7, color: '#B54708' });
    lines.forEach((t, i) => label(t, left + 5, y + 15 + i * 10, width - 10, { size: 7.5 }));
    doc.y = y + h + 8;
  }

  function cricket(spec) {
    doc.addPage();
    const iy = doc.y; label(`INNINGS ${spec.innings}`, left, iy, 120, { bold: true, size: 13, color: accent }); doc.y = iy + 20;
    fields({ items: spec.test ? ['Batting team', 'Bowling team', 'Innings start (day / time)', 'Innings end', 'Declared at', 'Follow-on?'] : ['Batting team', 'Bowling team', 'Innings start', 'Innings end'], per: spec.test ? 6 : 4 });
    const blocks = width <= 600 ? 1 : spec.overs > 30 ? 3 : spec.overs > 12 ? 2 : 1, perBlock = Math.ceil(spec.overs / blocks), gap = 14, bw = (width - gap * (blocks - 1)) / blocks;
    const y0 = doc.y; let yEnd = y0;
    for (let b = 0; b < blocks; b++) {
      doc.y = y0;
      const rows = Math.min(perBlock, spec.overs - b * perBlock);
      table({ title: b === 0 ? 'Ball by ball (runs; W wicket, wd wide, nb no-ball, b bye, lb leg-bye)' : ' ', rows, h: 11.5,
        cols: [{ t: 'Over', w: 0.7, fixed: numbered(rows, b * perBlock + 1) }, { t: 'Bowler', w: 2.4 }, ...numbered(6).map((n) => ({ t: n, w: 0.75 })), { t: 'Runs', w: 0.8 }, { t: 'Total', w: 0.9 }] },
      { x: left + b * (bw + gap), w: bw, nobreak: true });
      yEnd = Math.max(yEnd, doc.y);
    }
    doc.y = yEnd;
    const gapB = 14, wBat = (width - gapB) * 0.58, wBowl = (width - gapB) * 0.42;
    room(11 + 14 + 11 * 13.5 + 12);
    const yc = doc.y;
    table({ title: 'Batting', rows: 11, h: 13.5, cols: [{ t: '#', w: 0.4, fixed: numbered(11) }, { t: 'Batter', w: 2.4 }, { t: 'How out', w: 1.6 }, { t: 'Bowler', w: 1.6 }, { t: 'Runs', w: 0.8 }, { t: 'Balls', w: 0.8 }, { t: '4s', w: 0.6 }, { t: '6s', w: 0.6 }] }, { x: left, w: wBat, nobreak: true });
    const yb = doc.y; doc.y = yc;
    table({ title: 'Bowling', rows: 11, h: 13.5, cols: [{ t: 'Bowler', w: 2.4 }, { t: 'O', w: 0.6 }, { t: 'M', w: 0.6 }, { t: 'R', w: 0.7 }, { t: 'W', w: 0.6 }, { t: 'Wd', w: 0.6 }, { t: 'Nb', w: 0.6 }] }, { x: left + wBat + gapB, w: wBowl, nobreak: true });
    doc.y = Math.max(yb, doc.y);
    room(26 + 11 + 14 + 2 * 18 + 8);
    fields({ items: ['Byes', 'Leg byes', 'Wides', 'No-balls', 'Penalty runs', 'Total extras', 'Total runs', 'Wickets', 'Overs', 'Run rate'], per: 10 });
    table({ title: 'Fall of wickets (score - batter - over)', rows: 2, h: 18, cols: numbered(10).map((n) => ({ t: n, w: 1 })) });
  }

  for (const s of form.sections) {
    switch (s.t) {
      case 'fields': fields(s); break;
      case 'table': table(s); break;
      case 'pair': pair(s); break;
      case 'running': running(s); break;
      case 'ticks': ticks(s); break;
      case 'choices': choices(s); break;
      case 'cricket': cricket(s); break;
      case 'note': note(s); break;
      default: break;
    }
  }
}
