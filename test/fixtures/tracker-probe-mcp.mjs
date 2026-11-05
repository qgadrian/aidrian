#!/usr/bin/env node
// A minimal stdio MCP server for checking the tracker write guard (docs/config.md#tracker) in a real host, with no tracker
// behind it. Two tools: `get_workspace` reads a workspace, and `save_issue` writes nothing and says so.
//
// TRACKER_PROBE_URL   the workspace url the read reports.
// TRACKER_PROBE_LOG   a file that gets one JSON line per tool call, so a run can show which calls reached the server.
//
// `get_workspace` with `fail: true` returns a tool error instead, for checking what a host does with a failed read.

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// `node --test` runs every .mjs file under test/, this one too, and holds its stdin open, so a server waiting on stdin
// would hang the whole run. The runner sets this variable in the files it starts.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const WORKSPACE_URL = process.env.TRACKER_PROBE_URL || 'https://tracker.example/probe';
const LOG = process.env.TRACKER_PROBE_LOG;
const DEFAULT_PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'get_workspace',
    description: 'Read the connected workspace: its id, name, and url.',
    inputSchema: { type: 'object', properties: { fail: { type: 'boolean', description: 'Return a tool error instead.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'save_issue',
    description: 'A test write. It stores nothing and changes nothing, and says so.',
    inputSchema: { type: 'object', properties: { team: { type: 'string' }, title: { type: 'string' } } },
  },
];

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

function callTool(name, args) {
  if (name === 'get_workspace') {
    if (args.fail === true) return textResult('tracker probe: this read failed on purpose.', true);
    return textResult(JSON.stringify({ id: 'probe-workspace', name: 'Tracker probe', url: WORKSPACE_URL }));
  }
  if (name === 'save_issue') return textResult('tracker probe: save_issue did nothing. No issue was created or changed.');
  return null;
}

function respond(message) {
  const { id, method, params } = message;
  // A notification, such as notifications/initialized, has no id and gets no answer.
  if (id === undefined) return null;
  if (method === 'initialize') {
    const protocolVersion = params?.protocolVersion ?? DEFAULT_PROTOCOL;
    return { result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'tracker-probe', version: '1.0.0' } } };
  }
  if (method === 'ping') return { result: {} };
  if (method === 'tools/list') return { result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (LOG) appendFileSync(LOG, `${JSON.stringify({ tool: name, arguments: args, at: new Date().toISOString() })}\n`);
    const result = callTool(name, args);
    return result ? { result } : { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  return { error: { code: -32601, message: `Method not found: ${method}` } };
}

const send = (body) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...body })}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
    continue;
  }
  const answer = respond(message);
  if (answer) send({ id: message.id, ...answer });
}
