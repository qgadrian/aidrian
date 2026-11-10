// Every hook in hooks.json, run with input it cannot use, lets the action run: exit 0 and nothing on stderr.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins/aidrian');
const HOOKS = JSON.parse(readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks;
const HOSTILE = [
  '',
  'not json',
  '[]',
  '{}',
  'null',
  JSON.stringify({ tool_name: 'Nope', tool_input: { command: 42, file_path: 7 } }),
  JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
  JSON.stringify({ tool_name: 'Agent', cwd: 42, tool_response: 'text' }),
];

// [{ event, script, args }] for every command in hooks.json.
function hookCommands() {
  return Object.entries(HOOKS).flatMap(([event, groups]) =>
    groups.flatMap((group) =>
      group.hooks.map(({ command }) => {
        const [, script, rest] = /^node "\$CLAUDE_PLUGIN_ROOT\/(scripts\/[\w-]+\.mjs)"(.*)$/.exec(command);
        return { event, script, args: rest.trim().split(/\s+/).filter(Boolean) };
      }),
    ),
  );
}

test('every hooks.json command runs a script in this plugin, through $CLAUDE_PLUGIN_ROOT', () => {
  const commands = hookCommands();
  assert.equal(commands.length, Object.values(HOOKS).flat().flatMap((group) => group.hooks).length, 'every command has the one shape');
  for (const { script } of commands) assert.ok(readFileSync(path.join(PLUGIN, script)), script);
});

test('the tracker hooks run on every MCP tool, and on nothing else', () => {
  const groupOf = (event, script) => HOOKS[event].filter((group) => group.hooks.some(({ command }) => command.includes(script)));
  for (const [event, script] of [['PreToolUse', 'hook-tracker-pre.mjs'], ['PostToolUse', 'hook-tracker-post.mjs']]) {
    assert.deepEqual(groupOf(event, script).map((group) => group.matcher), ['mcp__.*'], script);
  }
});

test('the GitHub MCP hook runs on the server\'s tools that mark a draft ready, so the ready hold reads them', () => {
  const group = HOOKS.PreToolUse.find((each) => each.hooks.some(({ command }) => command.includes('hook-mcp-github.mjs')));
  const names = group.matcher.split('|');
  for (const name of ['mcp__github__update_pull_request', 'mcp__github__update_pull_request_draft_state']) assert.ok(names.includes(name), name);
});

test('the tracker hooks, with the tracker on, let input they cannot use run and write no file', (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-hooks-tracker-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const state = path.join(base, 'state');
  const cwd = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', '-b', 'main', cwd]);
  mkdirSync(path.join(cwd, '.aidrian'));
  const tracker = { enabled: true, workspace: { expect: 'acme', field: 'url' }, readTools: ['mcp__x__read'], writeTools: ['mcp__x__write'] };
  writeFileSync(path.join(cwd, '.aidrian/config.json'), JSON.stringify({ version: 1, tracker }));
  const env = { ...process.env, XDG_STATE_HOME: state };
  for (const script of ['scripts/hook-tracker-pre.mjs', 'scripts/hook-tracker-post.mjs']) {
    for (const input of HOSTILE) {
      const { status, stderr } = spawnSync(process.execPath, [path.join(PLUGIN, script)], { input, cwd, env, encoding: 'utf8' });
      assert.deepEqual([status, stderr], [0, ''], `${script}: ${input}`);
    }
  }
  assert.equal(existsSync(state), false);
});

test('every hook exits 0 with nothing on stderr for input it cannot use, inside a project and outside one', (t) => {
  const state = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-hooks-state-')));
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-hooks-cwd-')));
  t.after(() => {
    rmSync(state, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const env = { ...process.env, XDG_STATE_HOME: state };
  for (const { event, script, args } of hookCommands()) {
    for (const cwd of [outside, path.join(ROOT, 'examples/consumer')]) {
      for (const input of HOSTILE) {
        const { status, stderr } = spawnSync(process.execPath, [path.join(PLUGIN, script), ...args], { input, cwd, env, encoding: 'utf8' });
        assert.deepEqual([status, stderr], [0, ''], `${event} ${script} in ${path.basename(cwd)}: ${input}`);
      }
    }
  }
});
