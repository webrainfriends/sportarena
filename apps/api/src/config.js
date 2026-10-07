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
  masterKey: secret('SPORTARENA_MASTER_KEY'),
  jwtSecret: secret('SPORTARENA_JWT_SECRET'),
  tokenTtl: env.TOKEN_TTL ?? '12h',
  // HTTPS: terminate TLS in-process (SSL_KEY_FILE/SSL_CERT_FILE) or behind a proxy (TRUST_PROXY=true).
  sslKeyFile: env.SSL_KEY_FILE,
  sslCertFile: env.SSL_CERT_FILE,
  trustProxy: env.TRUST_PROXY === 'true',
  corsOrigins: (env.CORS_ORIGINS ?? '*').split(','),
};
