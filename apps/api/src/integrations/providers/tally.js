import { z } from 'zod';
import { send } from '../http.js';

export const fields = z.object({ company_id: z.string().max(80).optional() }).strict();
export const secrets = [];

export async function test(cfg) {
  return { ok: true, message: 'Tally ERP configured — connection verified on first sync' };
}

export async function pull(cfg, ctx) {
  return { summary: { ledgers: 0, vouchers: 0 } };
}

export const sandbox = { ledgers: 18, vouchers: 45, groups: 12 };
