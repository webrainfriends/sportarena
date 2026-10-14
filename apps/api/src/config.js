import { randomBytes } from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';
/** MFA policy default: on in production unless MFA_ENFORCE=false (explicit opt-out); elsewhere only when MFA_ENFORCE=true. */
export const mfaDefault = (e) => (e.NODE_ENV === 'production' ? e.MFA_ENFORCE !== 'false' : e.MFA_ENFORCE === 'true');

function secret(name) {
  const v = env[name];
  if (v) return v;
  if (isProd) throw new Error(`${name} is required in production`);
  // Dev/test only: ephemeral key. Data encrypted with it is unreadable after restart,
  // so set SPORTARENA_MASTER_KEY in .env for anything you want to keep.
  const generated = randomBytes(32).toString('base64');
  console.warn(`[config] ${name} not set — using an ephemeral dev key`);
  env[name] = generated;
  return generated;
}

export const config = {
  isProd,
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://postgres@/sportarena?host=/tmp',
  // Postgres in transit: set PGSSLMODE=require (or DATABASE_SSL=true) for TLS to the database.
  databaseSsl: env.DATABASE_SSL === 'true',
  // 'env': master key comes from SPORTARENA_MASTER_KEY.
  // 'aws-kms': a random master key is generated once, wrapped by AWS KMS and stored in masterKeyFile
  // (see scripts/kms-init.js); the app unwraps it at start-up, so the plaintext key never sits on disk.
  keyProvider: env.KEY_PROVIDER ?? 'env',
  masterKey: (env.KEY_PROVIDER ?? 'env') === 'env' ? secret('SPORTARENA_MASTER_KEY') : null,
  kmsKeyId: env.KMS_KEY_ID,
  kmsRegion: env.KMS_REGION ?? 'ap-southeast-1',
  masterKeyFile: env.MASTER_KEY_FILE ?? '/var/lib/sportarena/master.key.enc',
  jwtSecret: secret('SPORTARENA_JWT_SECRET'),
  // Password hashing (scrypt) runs off the event loop; at most `concurrency` derivations run at once and
  // up to `maxQueue` more wait. Beyond that requests get 503 + Retry-After.
  hashing: { concurrency: Number(env.HASH_CONCURRENCY ?? 2), maxQueue: Number(env.HASH_MAX_QUEUE ?? 64) },
  // Sign in with Google: the OAuth client id (public) from Google Cloud Console. Unset = the Google button is hidden and the endpoint refuses.
  googleClientId: env.GOOGLE_CLIENT_ID,
  // The iOS OAuth client id (public) used by the native app's Google button; its tokens carry this audience instead of the web client id.
  googleIosClientId: env.GOOGLE_IOS_CLIENT_ID ?? '909476957194-bmrrif4q7qdffemon7mrrm3puoovbg5r.apps.googleusercontent.com',
  // Sign in with Apple. appleClientId = the Services ID (web button; public). appleAppId = the app's bundle id (primary App ID, used by the native button).
  // Both are accepted as the id token's audience. Unset appleClientId = the Apple button is hidden and the endpoint refuses web sign-in.
  appleClientId: env.APPLE_CLIENT_ID,
  appleAppId: env.APPLE_APP_ID ?? 'dev.gotmygame.app',
  appleRedirectUri: env.APPLE_REDIRECT_URI ?? 'https://gotmygame.com/api/v1/auth/apple/callback',
  // The Google account that approves or rejects everyone else's access (and holds the platform owner role). Set by the deploy workflow; unset = nobody gets it.
  superAdminEmail: env.SUPER_ADMIN_EMAIL,
  tokenTtl: env.TOKEN_TTL ?? '12h', // access-token lifetime
  refreshTtlDays: Number(env.REFRESH_TTL_DAYS ?? 30), // sliding: each rotation extends the session by this much
  requireSession: env.AUTH_REQUIRE_SESSION === 'true', // refuse pre-session JWTs that carry no session id
  // HTTPS: terminate TLS in-process (SSL_KEY_FILE/SSL_CERT_FILE) or behind a proxy (TRUST_PROXY=true).
  sslKeyFile: env.SSL_KEY_FILE,
  sslCertFile: env.SSL_CERT_FILE,
  trustProxy: env.TRUST_PROXY === 'true',
  // Production refuses plain HTTP unless this is set explicitly (interim setups without a certificate).
  allowInsecureHttp: env.ALLOW_INSECURE_HTTP === 'true',
  // Web cookie sessions. 'auto' marks cookies Secure when the request arrived over HTTPS (TRUST_PROXY honours X-Forwarded-Proto);
  // plain-HTTP interim setups (ALLOW_INSECURE_HTTP) cannot carry Secure cookies. Origins allowed to send credentials = CORS_ORIGINS (never '*').
  cookieSecure: env.COOKIE_SECURE ?? 'auto',
  cookieSameSite: env.COOKIE_SAMESITE ?? 'lax',
  // MFA policy: when true, people holding doctor/physio/admin/platform_admin roles must have two-step verification enabled and verified
  // in their session to use clinical- or admin-class capabilities. ON by default in production (MFA_ENFORCE=false is the explicit, documented opt-out
  // for a rollout window while people enrol); off in development/test unless MFA_ENFORCE=true.
  mfaEnforce: mfaDefault(env),
  corsOrigins: (env.CORS_ORIGINS ?? '*').split(','),
  // Uploaded venue photos/videos. Must be a persistent directory (deploys never touch it). Files are never deleted.
  mediaDir: env.MEDIA_DIR ?? './data/media',
  // Venues that require online payment hold the slots for this many minutes while the customer pays.
  holdMinutes: Number(env.PAYMENT_HOLD_MINUTES ?? 15),
  // A slot offered from the waitlist is held for the person at the head of the queue for this long.
  waitlistHoldMinutes: Number(env.WAITLIST_HOLD_MINUTES ?? 15),
  // Notifications: queued emails are POSTed as JSON to this webhook (your SES/SendGrid/n8n bridge). Unset = they stay queued.
  notifyWebhook: { url: env.NOTIFY_WEBHOOK_URL, secret: env.NOTIFY_WEBHOOK_SECRET },
  // Push: phone apps go through the Expo push service; browsers through Web Push (VAPID keys, generated once by the deploy).
  push: {
    expoUrl: env.EXPO_PUSH_URL ?? 'https://exp.host/--/api/v2/push/send', expoToken: env.EXPO_ACCESS_TOKEN,
    vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT ?? 'mailto:admin@sportarena.local' },
  },
  // Clinical actions need a current doctor/physio verification case (src/clinical-access.js, docs/verification.md).
  clinical: {
    // Countries (codes from src/health/regimes.js) this deployment physically stores health data in. Unset = guessed from KMS_REGION.
    // A patient can pick a "keep it in-country" regime (AE, CN) only when it is listed here.
    hostingRegions: (env.HEALTH_HOSTING_REGIONS ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    // Days after an EXPIRED (never revoked) credential during which a provider may still complete existing appointments. 0 = no grace.
    graceDays: Number(env.CLINICAL_GRACE_DAYS ?? 0),
    // Optional allow-list of credential jurisdictions, e.g. "IN,GB". Empty = any (including unrecorded).
    jurisdictions: (env.CLINICAL_JURISDICTIONS ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  },
  // Background worker for booking reminders + email dispatch. 0 disables it (tests do).
  // WORKER_MODE: 'inprocess' (default) runs maintenance inside the API process; 'external' leaves it to `npm run worker`
  // (set it on both processes). A worker is considered stale after WORKER_STALE_SECONDS without a heartbeat.
  workerMode: env.WORKER_MODE === 'external' ? 'external' : 'inprocess',
  // A maintenance category failing this many cycles in a row is reported by get_worker_health (and makes it unhealthy).
  stepFailureThreshold: Math.max(1, Number(env.STEP_FAILURE_THRESHOLD ?? 3)),
  workerStaleSeconds: Number(env.WORKER_STALE_SECONDS ?? 180),
  // One JSON access line per request (method, path, status, ms, request id; never bodies or tokens).
  accessLog: (env.ACCESS_LOG ?? (isProd ? 'true' : 'false')) === 'true',
  notifyIntervalSeconds: Number(env.NOTIFY_INTERVAL_SECONDS ?? 60),
  // Payments (redirect checkout; no card data ever touches this server). A provider is enabled when its keys are set.
  appUrl: env.APP_URL,
  payments: {
    currency: (env.PAYMENT_CURRENCY ?? 'INR').toUpperCase(),
    stripe: { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, base: env.STRIPE_API_BASE ?? 'https://api.stripe.com' },
    paypal: {
      clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, webhookId: env.PAYPAL_WEBHOOK_ID,
      base: env.PAYPAL_API_BASE ?? (env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'),
    },
  },
};
