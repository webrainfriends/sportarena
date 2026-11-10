// Documents that travel as base64 inside a JSON body (evidence, case attachments ...) need a bigger JSON limit than the 100 kb default on
// exactly their own routes, and that limit must follow the platform admin's document size setting. The routes are found from the capability
// schemas themselves (any field called `data` that may hold more than 1 MB), so a new upload capability is covered without a second list.
import { z } from 'zod';
import express from 'express';
import { capabilities } from './capabilities/index.js';
import { documentMaxMb } from './platform-settings.js';

const big = (node, depth = 0) => {
  if (!node || typeof node !== 'object' || depth > 8) return false;
  if (node.properties?.data && Number(node.properties.data.maxLength) >= 1_000_000) return true;
  return Object.values(node.properties ?? {}).some((p) => big(p, depth + 1)) || big(node.items, depth + 1);
};

export function uploadPathPatterns() {
  const out = [];
  for (const c of capabilities) {
    if (!['POST', 'PATCH', 'PUT'].includes(c.method)) continue;
    let js; try { js = z.toJSONSchema(c.input, { unrepresentable: 'any', io: 'input' }); } catch { continue; }
    if (big(js)) out.push(new RegExp(`^/api/v1${c.path.replace(/:[A-Za-z_]+/g, '[^/]+')}/?$`));
  }
  return out;
}

const parsers = new Map();
/** JSON parser whose limit is the current document limit, encoded as base64, plus room for the other fields. */
export function uploadJson(req, res, next) {
  const mb = documentMaxMb();
  if (!parsers.has(mb)) parsers.set(mb, express.json({ limit: Math.ceil(mb * 2 ** 20 * 4 / 3) + 2 ** 20 }));
  return parsers.get(mb)(req, res, next);
}
