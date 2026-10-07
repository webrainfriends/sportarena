// MCP server: every capability in the registry becomes a tool with the same name, schema and rules as REST.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { capabilities } from './capabilities/index.js';
import { invoke, toErrorBody } from './invoke.js';

export function createMcpServer(getUser) {
  const server = new McpServer(
    { name: 'sportarena', version: '0.1.0' },
    { instructions: 'SportArena: manage athletes, coaches, referees, teams, events, fixtures, scores, venues & bookings, sponsors, supply chain, health and insurance. Personal identification data is encrypted at rest; reads of it are audit-logged. Authenticate with a bearer token (create_api_token).' },
  );
  for (const c of capabilities) {
    server.registerTool(
      c.name,
      {
        title: c.summary.split('.')[0],
        description: `${c.summary}${c.auth === 'public' ? '' : Array.isArray(c.auth) ? ` [auth required; roles: ${c.auth.join('/')}]` : ' [auth required]'}`,
        inputSchema: c.input.shape,
        annotations: { readOnlyHint: c.method === 'GET', destructiveHint: c.method === 'DELETE', openWorldHint: false },
      },
      async (args) => {
        try {
          const result = await invoke(c, await getUser(), args);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
        } catch (e) {
          const { code, message, details } = toErrorBody(e);
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, details }) }] };
        }
      },
    );
  }
  return server;
}
