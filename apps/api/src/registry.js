// The capability registry is the single source of truth for the platform surface.
// One definition -> REST route, OpenAPI operation, and MCP tool. Business rules live in the
// handler, so REST clients, the mobile/web app and AI agents all get identical behaviour.
import { z } from 'zod';

export const capabilities = [];

/**
 * @param {object} c
 * @param {string} c.name      snake_case id; MCP tool name & OpenAPI operationId
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} c.method
 * @param {string} c.path      e.g. /teams/:id (relative to /api/v1)
 * @param {string} c.summary
 * @param {string} c.tag
 * @param {'public'|'user'|string[]} c.auth  'public', any signed-in user, or a list of allowed roles (admin always allowed)
 * @param {z.ZodObject} c.input path params + query/body merged into one object
 * @param {(ctx:{user:object|null}, input:any)=>Promise<any>} c.handler
 */
export function cap(c) {
  if (capabilities.some((x) => x.name === c.name)) throw new Error(`duplicate capability ${c.name}`);
  capabilities.push({ auth: 'user', input: z.object({}), ...c });
}

// shared schema pieces
export const id = z.string().uuid();
export const page = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
};
export const money = z.coerce.number().int().min(0).describe('amount in minor units (cents/paise)');
export const roles = ['athlete', 'coach', 'referee', 'organizer', 'sponsor', 'physio', 'doctor', 'venue_manager', 'supplier', 'insurer', 'admin', 'platform_admin'];
