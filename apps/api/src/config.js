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
  corsOrigins: (env.CORS_ORIGINS ?? '*').split(','),
};
