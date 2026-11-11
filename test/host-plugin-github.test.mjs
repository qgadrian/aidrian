// A GitHub MCP server that a Claude Code plugin installs reaches a hook as mcp__plugin_<plugin>_<server>__<tool>. The Claude Code
// adapter reads it as mcp__github__<tool> when the plugin or server name holds "github" and the tool is one the GitHub MCP hook
// judges, and hooks.json runs that hook on those names. Without both, a merge or ready through such a server ran unchecked.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import claudeCode, { PLUGIN_GITHUB_MATCHER } from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import { githubCall, UNKNOWN_HOST } from '../plugins/aidrian/lib/hosts/index.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOKS = JSON.parse(readFileSync(path.join(ROOT, 'plugins/aidrian/hooks/hooks.json'), 'utf8')).hooks;
const GROUPS = HOOKS.PreToolUse.filter((group) => group.hooks.some(({ command }) => command.includes('hook-mcp-github.mjs')));
// The plain list of standard and Codex names, and the one pattern for plugin names.
const [LIST, PLUGIN] = GROUPS.map((group) => group.matcher);
// The GitHub MCP server's tools the hook judges, as the plain list names them.
const JUDGED = LIST.split('|').filter((name) => name.startsWith('mcp__github__')).map((name) => name.slice('mcp__github__'.length));

// Claude Code tests a matcher with any character outside [A-Za-z0-9_ ,|-] as an unanchored JavaScript regular expression;
// the conformance suite reads matchers anchored, as a host that compares whole names would. The pattern must agree on both.
const fires = (matcher, name) => new RegExp(matcher, 'u').test(name) && new RegExp(`^(?:${matcher})$`, 'u').test(name);

const OTHERS = [
  'mcp__plugin_gitea_gitea__merge_pull_request',
  'mcp__plugin_bitbucket_bitbucket__update_pull_request',
  'mcp__plugin_github_github__get_me',
  'mcp__plugin_github_github__merge_pull_request_extra',
  'mcp__github__merge_pull_request',
  'mcp__plugin_github_github__merge_pull_request__x',
];

test('a plugin\'s GitHub MCP tool reads as the server\'s own, whatever the plugin and server are named', () => {
  assert.ok(JUDGED.length >= 6, JUDGED.join(', '));
  for (const tool of JUDGED) {
    for (const segment of ['github_github', 'acme-tools_GitHub', 'github-enterprise_gh', 'tools_my-github']) {
      const raw = `mcp__plugin_${segment}__${tool}`;
      assert.equal(claudeCode.toolName(raw), `mcp__github__${tool}`, raw);
      assert.equal(UNKNOWN_HOST.toolName(raw), `mcp__github__${tool}`, `${raw}, with the host unknown`);
      assert.match(githubCall(claudeCode.toolName(raw), {}).tool, /^mcp__github__/u);
    }
  }
});

test('a call no GitHub server makes, or a tool the hook does not judge, keeps its name', () => {
  for (const name of OTHERS) assert.equal(claudeCode.toolName(name), name, name);
  assert.equal(claudeCode.toolName(undefined), undefined);
});

test('the payload keeps the name Claude Code sent, so a pattern a project wrote in that form still matches', () => {
  const raw = { tool_name: 'mcp__plugin_github_github__merge_pull_request', tool_input: { pullNumber: 5 } };
  assert.deepEqual(claudeCode.hookInput(raw), { ...raw, tool_name: 'mcp__github__merge_pull_request', raw_tool_name: raw.tool_name });
  const plain = { tool_name: 'mcp__github__merge_pull_request' };
  assert.equal(claudeCode.hookInput(plain), plain);
});

test('hooks.json runs the GitHub MCP hook on the plugin names, through the adapter\'s own pattern', () => {
  assert.equal(GROUPS.length, 2, 'the plain list, then the pattern for plugin names');
  assert.equal(PLUGIN, PLUGIN_GITHUB_MATCHER);
  // Codex keys its trust in a hook by the hook's place in its event, so a group put before others would untrust them.
  assert.equal(HOOKS.PreToolUse.at(-1), GROUPS[1], 'the pattern\'s group comes last');
  for (const tool of JUDGED) {
    for (const name of [`mcp__plugin_github_github__${tool}`, `mcp__plugin_acme-tools_GitHub__${tool}`]) {
      assert.ok(fires(PLUGIN, name), name);
      assert.equal(claudeCode.toolName(name), `mcp__github__${tool}`, `${name} fires the hook and is read there`);
    }
  }
  // The standard name fires only the plain list, so the hook runs once for it.
  for (const name of OTHERS) assert.equal(fires(PLUGIN, name), false, name);
});
