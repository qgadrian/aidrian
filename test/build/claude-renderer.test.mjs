import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { renderClaudeAgent } from '../../adapters/claude/render.mjs';
import { loadAdapter, loadAgents } from '../../src/build/catalog.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('Claude compiler renders model, effort, tools, tags, output mode, slots, and fragments', async () => {
  const agents = await loadAgents(ROOT);
  const adapter = await loadAdapter('claude', ROOT);
  const explorer = agents.find((agent) => agent.data.id === 'explorer');
  const rendered = await renderClaudeAgent(explorer, adapter, {
    slotValues: { project_bootstrap: 'Consumer overlay.' },
  });
  assert.match(rendered, /^model: sonnet$/m);
  assert.match(rendered, /^effort: medium$/m);
  assert.match(rendered, /^taskTags: \[always, context_hygiene\]$/m);
  assert.match(rendered, /^conditionalTags: \[\]$/m);
  assert.match(rendered, /^outputMode: machine_handoff$/m);
  assert.match(rendered, /^tools: \[ExitPlanMode, Glob, Grep, LSP, Read, ToolSearch\]$/m);
  assert.match(rendered, /^disallowedTools: \[Write, Edit, Bash\]$/m);
  assert.match(rendered, /^changedFilesCoverageExemption: non-authoring-coordination$/m);
  assert.match(rendered, /LSP answers from open files only/);
  assert.match(rendered, /Consumer overlay\./);
  assert.doesNotMatch(rendered, /\{\{/);
});

test('Claude compiler golden includes logical MCP rendering and conditional tags', async () => {
  const agents = await loadAgents(ROOT);
  const adapter = await loadAdapter('claude', ROOT);
  const source = agents.find((agent) => agent.data.id === 'github-archaeologist');
  const agent = structuredClone(source);
  agent.data.conditionalTags = ['history'];
  const rendered = await renderClaudeAgent(agent, adapter);
  assert.match(rendered, /^conditionalTags: \[history\]$/m);
  assert.match(rendered, /mcp__github__pull_request_read/);
  assert.match(rendered, /^tools: .*mcp__github__list_commits.*$/m);
  assert.equal(sha256(rendered), '036b5dab54a21383a4580ef3865b9b30fc44a443b16d001c127d6e252c6221b4');
});

test('Claude compiler fails closed on unsupported capabilities and connectors', async () => {
  const agents = await loadAgents(ROOT);
  const adapter = await loadAdapter('claude', ROOT);
  const agent = structuredClone(agents.find((entry) => entry.data.id === 'explorer'));
  agent.data.capabilities.allow.push('unknown.capability');
  await assert.rejects(renderClaudeAgent(agent, adapter), /explorer: unrenderable capability unknown\.capability for claude/);
  const connectorAgent = structuredClone(agents.find((entry) => entry.data.id === 'explorer'));
  connectorAgent.data.logicalConnectors = ['unknown'];
  await assert.rejects(renderClaudeAgent(connectorAgent, adapter), /explorer: unsupported logical connector unknown for claude/);
});
