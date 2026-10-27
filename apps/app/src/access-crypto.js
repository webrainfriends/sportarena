// Offline pass check for a scanner device (#510). The same HMAC-SHA256 the server uses to sign rotating passes, in plain JavaScript so it runs
// identically on iOS, iPadOS, Android and the web. A scanner that lost its connection uses the key from get_access_offline_pack (limited to one
// session or team event, expiring shortly after it ends) to tell a genuine, current pass from noise. It can never say "recorded": that only
// happens when the server re-judges the scan after it syncs.
const primes = (() => { const out = []; for (let n = 2; out.length < 64; n++) if (out.every((p) => n % p)) out.push(n); return out; })();
const frac = (x) => (x - Math.floor(x)) * 4294967296 >>> 0;
const K = primes.map((p) => frac(Math.cbrt(p)));
const H0 = primes.slice(0, 8).map((p) => frac(Math.sqrt(p)));
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

export function sha256(bytes) {
  const h = H0.slice();
  const len = bytes.length, total = (((len + 9 + 63) >> 6) << 6);
  const m = new Uint8Array(total);
  m.set(bytes); m[len] = 0x80;
  const bits = len * 8, dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(bits / 4294967296)); dv.setUint32(total - 4, bits >>> 0);
  const w = new Uint32Array(64);
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3), s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32), o = new DataView(out.buffer);
  h.forEach((v, i) => o.setUint32(i * 4, v));
  return out;
}
const utf8 = (s) => { const out = []; for (const ch of unescape(encodeURIComponent(s))) out.push(ch.charCodeAt(0)); return Uint8Array.from(out); };
const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

export function hmacHex(key, message) {
  let k = utf8(key);
  if (k.length > 64) k = sha256(k);
  const ipad = new Uint8Array(64).fill(0x36), opad = new Uint8Array(64).fill(0x5c);
  k.forEach((b, i) => { ipad[i] ^= b; opad[i] ^= b; });
  const inner = sha256(Uint8Array.from([...ipad, ...utf8(message)]));
  return hex(sha256(Uint8Array.from([...opad, ...inner])));
}

const TOKEN_RE = /^GQ1\.([PS])\.([atve])\.([0-9a-f_-]{36,80})\.(-|[0-9a-f-]{36})\.(\d{1,10})\.([0-9a-f]{24})$/;
const DOMAIN = { a: 'academy_session', t: 'team_event', v: 'venue_access', e: 'event_gate' };
export function readToken(raw) {
  const m = TOKEN_RE.exec(String(raw ?? '').trim());
  return m ? { type: m[1], domain: DOMAIN[m[2]], ref: m[3], userId: m[4] === '-' ? null : m[4], w: Number(m[5]), mac: m[6] } : null;
}
/** 'ok' | 'invalid' | 'expired', judged with the offline pack: { key, steps: {P,S}, skew: {P:[ahead, behind], S:[..]} }. */
export function checkOffline(t, at, pack) {
  if (!t || hmacHex(pack.key, `${t.type}|${t.userId ?? ''}|${t.w}`).slice(0, 24) !== t.mac) return 'invalid';
  const d = Math.floor(at.getTime() / 1000 / pack.steps[t.type]) - t.w;
  return d >= -pack.skew[t.type][0] && d <= pack.skew[t.type][1] ? 'ok' : 'expired';
}
