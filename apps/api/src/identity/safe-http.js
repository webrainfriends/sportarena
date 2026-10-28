// Outbound HTTPS for IdP discovery / JWKS / token exchange. The URLs are supplied by organisation admins, so they are treated as
// untrusted: https only, no credentials in the URL, no redirects, a size and time limit, and the *connection* is refused when the
// resolved address is private, loopback or link-local (checked in the socket lookup, so DNS rebinding cannot swap it afterwards).
import { request } from 'node:https';
import { lookup } from 'node:dns';
import net from 'node:net';
import { badRequest } from '../errors.js';

export const isPrivateAddress = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
};

/** Syntactic check used when a URL is saved; the connection-time check above is what actually protects the network. */
export function assertPublicHttpsUrl(value, what = 'URL') {
  let u;
  try { u = new URL(String(value)); } catch { throw badRequest(`${what} is not a valid URL`); }
  if (u.protocol !== 'https:') throw badRequest(`${what} must use https`);
  if (u.username || u.password) throw badRequest(`${what} must not contain credentials`);
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''))) throw badRequest(`${what} must be a public address`);
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) throw badRequest(`${what} must be a public address`);
  return u;
}

const guardedLookup = (hostname, opts, cb) => lookup(hostname, { ...opts, all: true }, (err, addrs) => {
  if (err) return cb(err);
  const ok = addrs.filter((a) => !isPrivateAddress(a.address));
  if (!ok.length) return cb(new Error('blocked: address is not public'));
  if (opts?.all) return cb(null, ok);
  return cb(null, ok[0].address, ok[0].family);
});

/** Replaceable in tests (`transport.fetch = ...`): same shape as this function's return value. */
export const transport = {
  fetch({ url, method = 'GET', headers = {}, body, timeoutMs = 8000, maxBytes = 1_000_000 }) {
    const u = assertPublicHttpsUrl(url);
    return new Promise((resolve, reject) => {
      const req = request(u, { method, headers, lookup: guardedLookup, timeout: timeoutMs }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(new Error('response too large')); return; } chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  },
};

export async function fetchJson(url, opts = {}) {
  const r = await transport.fetch({ url, ...opts, headers: { accept: 'application/json', ...(opts.headers ?? {}) } });
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(r.text);
}
