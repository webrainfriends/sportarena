// Sign in with Apple, web redirect flow. /auth/apple/start sends the browser to Apple; Apple POSTs the result (form_post) to
// /auth/apple/callback, which verifies it through the same `login_apple` capability, sets the HttpOnly session cookies and returns to the app.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { capabilities } from './capabilities/index.js';
import { invoke, toErrorBody } from './invoke.js';
import { parseCookies, setWebCookies } from './web-session.js';

const STATE_COOKIE = 'sa_apple_state';
const loginApple = () => capabilities.find((c) => c.name === 'login_apple');
const back = (res, params) => res.redirect(303, `/?${new URLSearchParams(params)}`);
// Apple's POST is a cross-site navigation, so the state cookie must be SameSite=None (which requires Secure); plain-HTTP dev falls back to lax.
const cookieOpts = (req) => ({ httpOnly: true, path: '/api/v1/auth/apple', maxAge: 10 * 60_000, secure: Boolean(req.secure), sameSite: req.secure ? 'none' : 'lax' });

export function appleWebRouter() {
  const r = express.Router();

  r.get('/auth/apple/start', (req, res) => {
    if (!config.appleClientId) return back(res, { apple_error: 'Apple sign-in is not set up on this site' });
    const state = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    res.cookie(STATE_COOKIE, `${state}.${nonce}`, cookieOpts(req));
    const q = new URLSearchParams({
      client_id: config.appleClientId, redirect_uri: config.appleRedirectUri, response_type: 'code id_token',
      response_mode: 'form_post', scope: 'name email', state, nonce,
    });
    res.redirect(302, `https://appleid.apple.com/auth/authorize?${q}`);
  });

  r.post('/auth/apple/callback', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
    const saved = String(parseCookies(req.headers.cookie)[STATE_COOKIE] ?? '');
    res.clearCookie(STATE_COOKIE, { ...cookieOpts(req), maxAge: undefined });
    const { id_token, state, user, error } = req.body ?? {};
    if (error) return back(res, { apple_error: error === 'user_cancelled_authorize' ? 'Apple sign-in was cancelled' : 'Apple sign-in failed' });
    const [wantState, nonce] = saved.split('.');
    if (!wantState || !nonce || state !== wantState || typeof id_token !== 'string') return back(res, { apple_error: 'Apple sign-in expired. Please try again.' });
    let name;
    try { const n = JSON.parse(user ?? '{}').name; name = [n?.firstName, n?.lastName].filter(Boolean).join(' ') || undefined; } catch { /* name is optional */ }
    try {
      const out = await invoke(loginApple(), null, { credential: id_token, name, nonce }, { ip: req.ip, userAgent: req.headers['user-agent'] });
      if (out.mfa_required) return back(res, { apple_mfa: out.mfa_token });
      setWebCookies(req, res, { token: out.token, refresh_token: out.refresh_token });
      return res.redirect(303, '/');
    } catch (e) {
      return back(res, { apple_error: toErrorBody(e).message });
    }
  });
  return r;
}
