// What a host sends and what a project wrote must still meet after the hosts layer: a server name the host spells its own way,
// and a pattern naming the tool as the host sends it. Each of these passed unchecked, or wrongly refused, without the fix.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS, loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { gateDenial } from '../plugins/aidrian/lib/agent-gates.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { judgeTrackerWrite, unlistedTool } from '../plugins/aidrian/lib/tracker-guard.mjs';

const PLUGIN = path.resolve(import.meta.dirname, '../plugins/aidrian');
const CODEX_ENV = { PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_ROOT: '/p' };
const RAW_WRITE = 'mcp__codex_apps__linear__save_issue';
const STANDARD_WRITE = 'mcp__codex_apps_linear__save_issue';
const SHORT = { enabled: true, provider: 'linear', workspace: { expect: 'https://linear.app/acme' }, team: { key: 'NOTES', values: ['Notes'] } };
const PATHS = { config: '.aidrian/config.json', local: '.aidrian.local.json' };

function project(t, config) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-raw-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, ...config }));
  return dir;
}

const hook = (script, dir, payload, session = 'raw-session') => spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', script)], {
  input: JSON.stringify({ cwd: dir, session_id: session, turn_id: 't', ...payload }),
  encoding: 'utf8',
  env: { ...process.env, ...CODEX_ENV, XDG_STATE_HOME: path.join(dir, 'state') },
});

const pre = (tool, toolInput = { team: 'Other', title: 't' }) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput });

test('the short key covers a server as Codex spells it, whatever its name holds', (t) => {
  const dir = project(t, { tracker: { ...SHORT, servers: ['acme-linear'] } });
  for (const tool of ['mcp__linear_server__save_issue', 'mcp__acme_linear__save_issue', 'mcp__linear-server__save_issue', 'mcp__acme-linear__save_issue']) {
    const { status, stderr } = hook('hook-tracker-pre.mjs', dir, pre(tool));
    assert.equal(status, 2, `${tool} passed unchecked`);
    assert.match(stderr, /has not read the connected workspace/u);
  }
});

test('each spelling has its own read, since a read clears only a write on its server', (t) => {
  const dir = project(t, { tracker: SHORT });
  const { config } = loadConfig({ root: dir, paths: { config: PATHS.config } });
  assert.ok(config.tracker.readTools.includes('mcp__linear_server__get_workspace'));
  assert.ok(config.tracker.readTools.includes('mcp__linear-server__get_workspace'));
  const write = 'mcp__linear_server__save_issue';
  assert.match(judgeTrackerWrite(config, write, {}, null).reason, /Call mcp__linear_server__get_workspace, then write again/u);
});

test('the Codex adapter spells a server the way Codex does', () => {
  assert.equal(codex.serverSpelling('linear-server'), 'linear_server');
  assert.equal(codex.serverSpelling('acme.linear'), 'acme_linear');
  assert.equal(codex.serverSpelling('plain_name'), 'plain_name');
});

test('hookInput keeps what Codex sent, and an unchanged name carries no raw name', () => {
  assert.deepEqual(codex.hookInput({ tool_name: RAW_WRITE }), { tool_name: STANDARD_WRITE, raw_tool_name: RAW_WRITE });
  const plain = { tool_name: 'mcp__linear__save_issue' };
  assert.equal(codex.hookInput(plain), plain);
  const already = codex.hookInput({ tool_name: RAW_WRITE });
  assert.deepEqual(codex.hookInput(already), already, 'a second pass changes nothing');
});

test('agents deny and allow match a pattern in the raw form, through the real hook', (t) => {
  for (const pattern of ['mcp__codex_apps__*', 'mcp__codex_apps__linear__save_*']) {
    const dir = project(t, { agents: { '*': { deny: [pattern] } } });
    const denied = hook('hook-agent-gates.mjs', dir, pre(RAW_WRITE));
    assert.equal(denied.status, 2, `deny ${pattern} no longer matched`);
    assert.match(denied.stderr, new RegExp(`deny has "${pattern.replace('*', '\\*')}"`, 'u'));
  }
  const allowed = project(t, { agents: { '*': { allow: ['Read', 'mcp__codex_apps__linear__*'] } } });
  assert.equal(hook('hook-agent-gates.mjs', allowed, pre(RAW_WRITE)).status, 0, 'allow failed closed');
});

test('agents deny and allow match a pattern in the standard form too', () => {
  const settings = (agents) => ({ agents, names: { human: 'the Human' } });
  const input = { tool_name: STANDARD_WRITE, raw_tool_name: RAW_WRITE, tool_input: {} };
  assert.ok(gateDenial(input, settings({ '*': { deny: ['mcp__codex_apps_linear__*'] } }), PATHS));
  assert.equal(gateDenial(input, settings({ '*': { allow: ['mcp__codex_apps_linear__*'] } }), PATHS), null);
  assert.ok(gateDenial(input, settings({ '*': { allow: ['Read'] } }), PATHS), 'neither form listed');
});

test('a written-out key in the raw form still guards, with its read clearing its write', (t) => {
  const tracker = {
    enabled: true,
    workspace: { expect: 'https://linear.app/acme', field: 'url' },
    readTools: ['mcp__codex_apps__linear__get_workspace'],
    writeTools: ['mcp__codex_apps__linear__save_*'],
    team: { key: 'NOTES', values: ['Notes'], createFields: ['team'], keyFields: ['id'] },
  };
  const dir = project(t, { tracker });
  const first = hook('hook-tracker-pre.mjs', dir, pre(RAW_WRITE, { team: 'Notes' }));
  assert.equal(first.status, 2, 'the write passed unchecked');
  assert.match(first.stderr, /has not read the connected workspace/u);
  assert.match(first.stderr, /Call /u, 'a read on its server is named, so the refusal is the routine one');

  const read = { hook_event_name: 'PostToolUse', tool_name: 'mcp__codex_apps__linear__get_workspace', tool_input: {}, tool_response: { content: [{ type: 'text', text: '{"url":"https://linear.app/acme"}' }] } };
  assert.equal(hook('hook-tracker-post.mjs', dir, read).status, 0);
  assert.equal(hook('hook-tracker-pre.mjs', dir, pre(RAW_WRITE, { team: 'Notes' })).status, 0, 'the read clears the write');
  assert.equal(hook('hook-tracker-pre.mjs', dir, pre(RAW_WRITE, { team: 'Other' })).status, 2);
});

test('a refusal names the read as the Codex model sees that tool', (t) => {
  const dir = project(t, { tracker: SHORT });
  const { stderr } = hook('hook-tracker-pre.mjs', dir, pre(RAW_WRITE));
  assert.match(stderr, /Call mcp__codex_apps__linear_get_workspace, then write again/u);
  assert.doesNotMatch(stderr, /mcp__codex_apps_linear__get_workspace/u, 'a name the model never saw');
  assert.equal(codex.nativeToolName('mcp__codex_apps_linear__get_workspace'), 'mcp__codex_apps__linear_get_workspace');
  assert.equal(codex.nativeToolName('mcp__linear_server__get_workspace'), 'mcp__linear_server__get_workspace');
});

test('Codex calls the question tool request_user_input; Claude Code calls it by the standard name', () => {
  assert.equal(codex.nativeToolName('AskUserQuestion'), 'request_user_input');
  assert.equal(codex.nativeToolName('Bash'), 'Bash');
});

test('a tool a raw pattern lists is no unlisted tool', () => {
  const lists = { readTools: ['mcp__codex_apps__linear__get_workspace'], writeTools: ['mcp__codex_apps__linear__save_*'] };
  assert.equal(unlistedTool(lists, STANDARD_WRITE, RAW_WRITE), false);
  assert.equal(unlistedTool(lists, 'mcp__codex_apps_linear__archive_thing', 'mcp__codex_apps__linear__archive_thing'), true, 'on that server, listed by neither');
});

test('the defaults still hold for a gate with no raw name', () => {
  assert.equal(gateDenial({ tool_name: 'Bash', tool_input: { command: 'ls' } }, { ...DEFAULTS, agents: {} }, PATHS), null);
});
