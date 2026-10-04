#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { decide, status } from './core.mjs';

const server = new Server({ name: 'jev-workflow-decisions', version: '1.0.0' }, { capabilities: { tools: {} } });
const offline = process.argv.includes('--offline');
const inputSchema = {
  type: 'object', properties: { repo: { type: 'string', description: 'Absolute repository path.' }, input: { type: 'object', description: 'Version 1 task input; see scripts/jev/README.md.' } }, required: ['repo', 'input'], additionalProperties: false
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'jev_verification', description: 'Recommend useful focused local feedback; broad suites follow supplied repository policy and mandatory gates remain. Does not execute checks or establish passes.', inputSchema },
  { name: 'jev_review_triage', description: 'Recommend must_fix, investigate or follow_up for supplied findings without waiving protected obligations.', inputSchema },
  { name: 'jev_status', description: 'Report credential availability separately from cached auth and connectivity. No network unless verify_connectivity is true.', inputSchema: { type: 'object', properties: { verify_connectivity: { type: 'boolean' } }, additionalProperties: false } }
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const args = request.params.arguments ?? {};
    let result;
    if (request.params.name === 'jev_status') {
      if (Object.keys(args).some(k => k !== 'verify_connectivity') || (args.verify_connectivity !== undefined && typeof args.verify_connectivity !== 'boolean')) throw new Error();
      result = await status({ offline, verifyConnectivity: args.verify_connectivity ?? false });
    } else {
      const tasks = { jev_verification: 'verification', jev_review_triage: 'review-triage' };
      const task = tasks[request.params.name];
      if (!task || Object.keys(args).some(k => !['repo', 'input'].includes(k))) throw new Error();
      result = await decide(task, { ...args, offline });
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  } catch {
    return { content: [{ type: 'text', text: JSON.stringify({ schema_version: 1, status: 'error', error: 'Invalid task arguments or unavailable input.' }) }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
