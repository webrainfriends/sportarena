import { z } from 'zod';
import { capabilities } from './capabilities/index.js';

const toPath = (p) => p.replace(/:(\w+)/g, '{$1}');
const pathParams = (p) => [...p.matchAll(/:(\w+)/g)].map((m) => m[1]);

export function buildOpenApi(serverUrl = '/api/v1') {
  const paths = {};
  for (const c of capabilities) {
    const schema = z.toJSONSchema(c.input, { io: 'input', unrepresentable: 'any' });
    const pp = pathParams(c.path);
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const params = pp.map((n) => ({ name: n, in: 'path', required: true, schema: props[n] ?? { type: 'string' } }));
    const op = {
      operationId: c.name, summary: c.summary, tags: [c.tag],
      security: c.auth === 'public' ? [] : [{ bearerAuth: [] }],
      'x-mcp-tool': c.name,
      'x-required-roles': Array.isArray(c.auth) ? c.auth : undefined,
      responses: {
        [c.status ?? 200]: { description: 'OK', content: { 'application/json': { schema: {} } } },
        400: { $ref: '#/components/responses/Error' }, 401: { $ref: '#/components/responses/Error' },
        403: { $ref: '#/components/responses/Error' }, 404: { $ref: '#/components/responses/Error' }, 409: { $ref: '#/components/responses/Error' },
      },
    };
    const rest = Object.fromEntries(Object.entries(props).filter(([k]) => !pp.includes(k)));
    if (c.method === 'GET' || c.method === 'DELETE') {
      for (const [k, v] of Object.entries(rest)) params.push({ name: k, in: 'query', required: required.has(k), schema: v });
    } else if (Object.keys(rest).length) {
      op.requestBody = { required: true, content: { 'application/json': { schema: { type: 'object', properties: rest, required: [...required].filter((k) => !pp.includes(k)) } } } };
    }
    if (params.length) op.parameters = params;
    (paths[toPath(c.path)] ??= {})[c.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'SportArena API', version: '0.1.0', description: 'API-first sports ecosystem. Every operation is also exposed as an MCP tool of the same name at /mcp.' },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'JWT from /auth/login or an sa_… API token' } },
      responses: { Error: { description: 'Error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } } } } } },
    },
  };
}
