// Guarded JSON fetch for integration adapters: https only (loopback http outside production), no private addresses, size and time limits.
import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';
import net from 'node:net';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { isPrivateAddress } from '../ics.js';

const MAX_BYTES = 2_000_000;
const loopbackHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';

/** Returns an error string, or null when the address may be called. */
export function checkTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'That is not a valid URL'; }
  if (u.username || u.password) return 'Do not put credentials in the URL';
  const host = u.hostname.toLowerCase();
  if (!config.isProd && u.protocol === 'http:' && loopbackHost(host)) return null;
  if (u.protocol !== 'https:') return 'The address must use https';
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare) ? isPrivateAddress(bare) : /^localhost$|\.(local|internal|localhost)$/i.test(bare)) return 'That address points to a private network';
  return null;
}

const safeLookup = (hostname, opts, cb) => dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
  if (err) return cb(err);
  if (addrs.find((a) => isPrivateAddress(a.address))) return cb(new Error('private address'));
  if (opts?.all) return cb(null, addrs);
  cb(null, addrs[0].address, addrs[0].family);
});

function request(method, raw, { headers = {}, body } = {}) {
  const bad = checkTarget(raw);
  if (bad) return Promise.reject(new AppError(400, 'bad_request', bad));
  const u = new URL(raw);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({ method, host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search, headers, timeout: 10_000, lookup: loopbackHost(u.hostname) ? undefined : safeLookup }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) req.destroy(new AppError(502, 'too_large', 'The response is larger than 2 MB')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new AppError(502, 'timeout', 'The other system took too long to answer')));
    req.on('error', (e) => reject(e instanceof AppError ? e : new AppError(502, 'unreachable', e.message === 'private address' ? 'That address points to a private network' : 'Could not reach the other system')));
    if (body) req.write(body);
    req.end();
  });
}

let transport = request;
/** Test seam: replace the network call. Pass nothing to restore. */
export const setIntegrationTransport = (f) => { transport = f ?? request; };
export const send = (method, url, opts) => transport(method, url, opts);
