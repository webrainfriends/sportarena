#!/usr/bin/env node
// stdio transport for local agents (Claude Desktop, Claude Code …). Set SPORTARENA_TOKEN to a JWT or sa_ token.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp.js';
import { authenticate } from './auth.js';
import { initKeys } from './crypto.js';

await initKeys();

let cached;
const getUser = async () => (cached ??= await authenticate(`Bearer ${process.env.SPORTARENA_TOKEN ?? ''}`));
await createMcpServer(getUser).connect(new StdioServerTransport());
