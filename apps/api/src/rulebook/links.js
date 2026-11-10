// Is the governing body's rulebook page really there? The app only offers "Official book" when this says so, so a moved or retired page is never
// handed to a member. Only addresses written in rulebook/catalog.js are ever requested (the deep link, then the body's home page), never one from input.
const TTL_OK = 12 * 3600_000, TTL_DOWN = 3600_000, TIMEOUT = 6000;
const cache = new Map(); // url -> { ok, at }
// A site that answers but turns robots away (401/403/405/429) is there; a missing page (404/410), a server error or no answer is not.
const ANSWERS = new Set([401, 403, 405, 429]);

let probe = async (url) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; GotMyGame link check)', accept: 'text/html,application/pdf;q=0.9,*/*;q=0.5' } });
    try { await res.body?.cancel(); } catch { /* nothing to release */ }
    return res.ok || ANSWERS.has(res.status);
  } catch { return false; } finally { clearTimeout(timer); }
};
/** Tests swap the network call. Returns the previous one. */
export const setLinkProbe = (fn) => { const was = probe; probe = fn; cache.clear(); return was; };

async function alive(url, now) {
  const hit = cache.get(url);
  if (hit && now - hit.at < (hit.ok ? TTL_OK : TTL_DOWN)) return hit.ok;
  const ok = await probe(url);
  cache.set(url, { ok, at: now });
  return ok;
}

/** The addresses to try for a book, best first: its rulebook page, then the governing body's home page. */
export function linkCandidates(book) {
  const out = [book.official_url, ...(book.official_alt ?? [])];
  try { out.push(`${new URL(book.official_url).origin}/`); } catch { /* not an address: nothing to add */ }
  return [...new Set(out.filter((u) => /^https:\/\//.test(u ?? '')))];
}

/** @returns {Promise<{url: string|null, verified: boolean, exact: boolean, checked_at: string}>} `exact` is false when only the body's home page answered. */
export async function officialLink(book, now = Date.now()) {
  const list = linkCandidates(book);
  for (let i = 0; i < list.length; i++) if (await alive(list[i], now)) return { url: list[i], verified: true, exact: i === 0, checked_at: new Date(now).toISOString() };
  return { url: null, verified: false, exact: false, checked_at: new Date(now).toISOString() };
}
