// Generates a .env with fresh secrets for local development (never overwrites an existing one).
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) { console.log('.env already exists — leaving it alone'); process.exit(0); }
const tpl = readFileSync('.env.example', 'utf8')
  .replace('SPORTARENA_MASTER_KEY=', `SPORTARENA_MASTER_KEY=${randomBytes(32).toString('base64')}`)
  .replace('SPORTARENA_JWT_SECRET=', `SPORTARENA_JWT_SECRET=${randomBytes(48).toString('base64')}`);
writeFileSync('.env', tpl, { mode: 0o600 });
console.log('.env created (keep it safe: the master key is needed to read encrypted data)');
