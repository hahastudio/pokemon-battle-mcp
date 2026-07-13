#!/usr/bin/env node
/**
 * MCP server entry & tool registration (Architecture.md sections 1, 3, 5.2).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { name, version } from '../package.json';
import { registerDamageTools } from './tools/damage';
import { registerMetaTools } from './tools/meta';
import { registerSpeedTools } from './tools/speed';

export function createServer(): McpServer {
  const server = new McpServer({
    name,
    version,
  });

  registerMetaTools(server);
  registerDamageTools(server);
  registerSpeedTools(server);

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
