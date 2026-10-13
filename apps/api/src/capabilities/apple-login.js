import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { cap } from '../registry.js';
import { config } from '../config.js';
import { badRequest, unauthorized } from '../errors.js';
import { socialSignIn } from '../social-login.js';

const jwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

/** Check an Apple identity token (signature, issuer, audience, expiry) and return its claims. Replaceable in tests. */
export const appleVerifier = {
  async verify(credential) {
    const audience = [config.appleClientId, config.appleAppId].filter(Boolean);
    const { payload } = await jwtVerify(credential, jwks, { issuer: 'https://appleid.apple.com', audience });
    return payload;
  },
};

cap({
  name: 'login_apple', method: 'POST', path: '/auth/apple', tag: 'Identity', auth: 'public',
  summary: 'Sign in (or create an account) with an Apple identity token from "Sign in with Apple" (web Services ID or the native app). Matches the account by Apple id, then by verified email; a new Apple user gets an athlete account with a generated handle that waits for administrator approval. Apple only sends the person\'s name the first time, so pass it as `name` if you have it. Returns the same session as login, or mfa_required + mfa_token when two-step verification is on.',
  input: z.object({
    credential: z.string().min(20).max(4000).describe('the Apple identity token (JWT)'),
    name: z.string().max(120).optional().describe('the person\'s name, as Apple gave it to the app on first sign-in'),
    nonce: z.string().min(8).max(200).optional().describe('when you sent a nonce to Apple, the same value: it must match the token'),
  }),
  async handler({ meta }, i) {
    if (!config.appleClientId && !config.appleAppId) throw badRequest('Apple sign-in is not set up on this site');
    let claims;
    try { claims = await appleVerifier.verify(i.credential); } catch { throw unauthorized('Apple sign-in could not be verified. Please try again.'); }
    if (i.nonce && claims.nonce !== i.nonce) throw unauthorized('Apple sign-in could not be verified. Please try again.');
    const email = String(claims.email ?? '').toLowerCase();
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    // Apple omits the email on later sign-ins; an existing Apple account is found by its id alone, so the email is only needed to create/link one.
    return socialSignIn({ provider: 'apple', sub: claims.sub, email, verified, name: i.name, meta });
  },
});
