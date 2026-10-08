import { randomBytes } from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

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
  tokenTtl: env.TOKEN_TTL ?? '12h',
  // HTTPS: terminate TLS in-process (SSL_KEY_FILE/SSL_CERT_FILE) or behind a proxy (TRUST_PROXY=true).
  sslKeyFile: env.SSL_KEY_FILE,
  sslCertFile: env.SSL_CERT_FILE,
  trustProxy: env.TRUST_PROXY === 'true',
  // Production refuses plain HTTP unless this is set explicitly (interim setups without a certificate).
  allowInsecureHttp: env.ALLOW_INSECURE_HTTP === 'true',
  corsOrigins: (env.CORS_ORIGINS ?? '*').split(','),
  // Uploaded venue photos/videos. Must be a persistent directory (deploys never touch it). Files are never deleted.
  mediaDir: env.MEDIA_DIR ?? './data/media',
  // Venues that require online payment hold the slots for this many minutes while the customer pays.
  holdMinutes: Number(env.PAYMENT_HOLD_MINUTES ?? 15),
  // Notifications: queued emails are POSTed as JSON to this webhook (your SES/SendGrid/n8n bridge). Unset = they stay queued.
  notifyWebhook: { url: env.NOTIFY_WEBHOOK_URL, secret: env.NOTIFY_WEBHOOK_SECRET },
  // Push: phone apps go through the Expo push service; browsers through Web Push (VAPID keys, generated once by the deploy).
  push: {
    expoUrl: env.EXPO_PUSH_URL ?? 'https://exp.host/--/api/v2/push/send', expoToken: env.EXPO_ACCESS_TOKEN,
    vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT ?? 'mailto:admin@sportarena.local' },
  },
  // Background worker for booking reminders + email dispatch. 0 disables it (tests do).
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
