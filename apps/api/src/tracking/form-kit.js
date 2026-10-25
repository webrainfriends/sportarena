// Building blocks for printable scoresheet forms (see forms.js for the section types). Pure functions, no database.

export const col = (t, w = 1, fixed) => ({ t, w, ...(fixed ? { fixed } : {}) });
export const cols = (...list) => list.map((c) => (Array.isArray(c) ? col(...c) : col(c)));
export const nums = (n, from = 1) => Array.from({ length: n }, (_, i) => String(from + i));

export const fields = (items, per = 3) => ({ t: 'fields', items, per });
export const table = (title, c, rows, o = {}) => ({ t: 'table', title, cols: cols(...c), rows, h: o.h ?? 16, width: o.width ?? 1 });
export const pair = (title, c, rows, o = {}) => ({ t: 'pair', title, cols: cols(...c), rows, h: o.h ?? 15 });
export const running = (title, max, per, o = {}) => ({ t: 'running', title, max, per, ...o });
export const ticks = (title, ...items) => ({ t: 'ticks', title, items: items.map(([label, n]) => ({ label, n })) });
export const choices = (title, ...items) => ({ t: 'choices', title, items });

export const SIGN_INDIVIDUAL = ['Chief judge / referee', 'Scorer', 'Competitor / team rep'];
export const WINNER = choices('Winner', 'Home', 'Away', 'Draw / no result');
export const finalResult = (extra = []) => [
  table('Final result', [['', 2, ['Result as recorded by the official']], ['Home', 1.5], ['Away', 1.5]], 1, { h: 26, width: 0.7 }),
  WINNER, ...extra,
];
export const officials = (...names) => fields(names.length ? names : ['Referee / umpire', 'Scorer', 'Timekeeper'], 3);

