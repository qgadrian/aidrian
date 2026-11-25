// Which host a process runs under, and what shared code learns from it (lib/hosts/index.mjs). An unknown host is reported as
// unknown, never as one of the hosts it may not be.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { currentAuthor, runEnv } from '../plugins/aidrian/lib/attribution.mjs';
import { detectHost, normalizeHookInput, sessionIdentity } from '../plugins/aidrian/lib/hosts/index.mjs';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/hosts');
// What an OpenCode shell sets, and every process started from it inherits.
const OPENCODE_ENV = Object.freeze({ OPENCODE: '1', OPENCODE_SESSION_ID: 'ses_df7be4557ffeQDs22tHr3NYxUx' });
const MARKED = Object.freeze({ opencode: { version: '2.4.0' }, session_id: 'ses_a', tool_name: 'shell', tool_input: { command: 'gh pr view 3' } });
// Claude Code's marker variables besides CLAUDECODE (lib/hosts/claude-code.mjs MARKERS), each enough alone.
const CLAUDE_MARKERS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_AGENT', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_EFFORT'];

// Every hook payload a recorded fixture of `host` holds: its pre and post, and each call laid over its pre.
function recordedPayloads(host) {
  return readdirSync(path.join(FIXTURES, host)).filter((name) => name.endsWith('.json')).map((name) => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES, host, name), 'utf8'));
    const calls = Object.values(fixture).flat().filter((each) => typeof each?.tool_name === 'string' && each.session_id === undefined);
    const payloads = [fixture.pre, fixture.post, ...calls.map((call) => ({ ...fixture.pre, tool_name: call.tool_name, tool_input: call.tool_input }))].filter(Boolean);
    return { name, env: fixture.env, payloads };
  });
}

function folder(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-hosts-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a host payload is normalised on its way into a hook, and a Claude Code payload is left as it came', () => {
  const app = { tool_name: 'mcp__codex_apps__linear__save_issue', turn_id: 't' };
  assert.equal(normalizeHookInput(app, {}).tool_name, 'mcp__codex_apps_linear__save_issue');
  const claude = { tool_name: 'mcp__plugin_linear_linear__save_issue' };
  assert.equal(normalizeHookInput(claude, { CLAUDECODE: '1' }), claude);
});

test('host detection: a payload or plugin hook variable tells Codex even inside a Claude Code shell', () => {
  assert.equal(detectHost({ env: { CLAUDECODE: '1' }, input: { turn_id: 't' } }).id, 'codex');
  assert.equal(detectHost({ env: { CLAUDECODE: '1', PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_ROOT: '/p' } }).id, 'codex', 'Codex sets both to one value');
  assert.equal(detectHost({ env: { CLAUDECODE: '1', PLUGIN_ROOT: '/somewhere', CLAUDE_PLUGIN_ROOT: '/p' } }).id, 'claude-code', 'a PLUGIN_ROOT the shell inherited');
  assert.equal(detectHost({ env: { PLUGIN_ROOT: '/p' } }).id, 'unknown', 'PLUGIN_ROOT alone names no host');
  assert.equal(detectHost({ env: { CLAUDECODE: '1', CODEX_THREAD_ID: 't' } }).id, 'claude-code', 'a Claude Code started from a Codex shell');
  assert.equal(detectHost({ env: { CODEX_THREAD_ID: 't' } }).id, 'codex');
  assert.equal(detectHost({ env: { CLAUDE_CODE_SESSION_ID: 's' } }).id, 'claude-code');
  assert.equal(detectHost({ env: {} }).id, 'unknown');
});

test('a session\'s identity comes from its host, and a process no host claims has none', () => {
  assert.deepEqual(sessionIdentity({ CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_AGENT: 'a' }), { session: 's', agent: 'a' });
  assert.deepEqual(sessionIdentity({ CODEX_THREAD_ID: 't' }), { session: 't', agent: null });
  assert.deepEqual(sessionIdentity({}), { session: null, agent: null });
});

test('a Codex subagent thread\'s command reads the root session\'s id, which its hooks carry, not its own thread\'s', () => {
  // Codex gives every shell call CODEX_SESSION_ID, the root session's, and CODEX_THREAD_ID, the running thread's own.
  assert.deepEqual(sessionIdentity({ CODEX_SESSION_ID: 'root', CODEX_THREAD_ID: 'child' }), { session: 'root', agent: null }, 'a subagent\'s thread');
  assert.deepEqual(sessionIdentity({ CODEX_SESSION_ID: 'root', CODEX_THREAD_ID: 'root' }), { session: 'root', agent: null }, 'the root thread');
  assert.deepEqual(sessionIdentity({ CODEX_THREAD_ID: 'root' }), { session: 'root', agent: null }, 'a Codex that sets no CODEX_SESSION_ID');
  assert.equal(detectHost({ env: { CLAUDECODE: '1', CODEX_SESSION_ID: 'root', CODEX_THREAD_ID: 'child' } }).id, 'claude-code', 'a Claude Code started from a Codex subagent\'s shell');
});

test('attribution records an unknown host as unknown, never as Claude Code', () => {
  assert.equal(currentAuthor({}, {}).tool, 'unknown');
  assert.equal(currentAuthor({}, { SOME_OTHER_HOST: '1' }).tool, 'unknown');
  assert.equal(runEnv({}), 'local');
  assert.equal(runEnv({ CLAUDE_CODE_REMOTE: 'true' }), 'cloud');
});

test('attribution reads no transcript of a host whose format the plugin does not read', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'transcript.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'assistant', requestId: 'r', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } } })}\n`);
  assert.equal(currentAuthor({ transcript_path: file }, { CLAUDECODE: '1' }).model, 'claude-opus-5-5');
  assert.equal(currentAuthor({ transcript_path: file }, { CODEX_THREAD_ID: 't' }).model, null);
});

test('OpenCode\'s payload mark wins over every environment, and Codex\'s turn_id over that mark', () => {
  const envs = [{ CLAUDECODE: '1' }, { CLAUDE_CODE_SESSION_ID: 's' }, { CODEX_THREAD_ID: 't' }, { PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_ROOT: '/p' }, { CLAUDECODE: '1', CODEX_THREAD_ID: 't', PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_ROOT: '/p' }];
  for (const env of envs) assert.equal(detectHost({ env, input: MARKED }).id, 'opencode', JSON.stringify(env));
  assert.equal(detectHost({ env: {}, input: { ...MARKED, turn_id: 't' } }).id, 'codex', 'a payload with both marks is the guarded host\'s');
  assert.equal(normalizeHookInput(MARKED, { CLAUDECODE: '1' }).tool_name, 'Bash', 'and its names are mapped by its own adapter');
});

test('OpenCode\'s environment rule answers only when no other host\'s whole detection does', () => {
  assert.equal(detectHost({ env: { ...OPENCODE_ENV } }).id, 'opencode');
  assert.equal(detectHost({ env: { OPENCODE: '1' } }).id, 'unknown');
  assert.equal(detectHost({ env: { OPENCODE_SESSION_ID: OPENCODE_ENV.OPENCODE_SESSION_ID } }).id, 'unknown');
  assert.equal(detectHost({ env: { ...OPENCODE_ENV, CLAUDECODE: '1' } }).id, 'claude-code');
  for (const name of CLAUDE_MARKERS) assert.equal(detectHost({ env: { ...OPENCODE_ENV, [name]: 'x' } }).id, 'claude-code', name);
  assert.equal(detectHost({ env: { ...OPENCODE_ENV, CODEX_THREAD_ID: 't' } }).id, 'codex');
  assert.equal(detectHost({ env: { ...OPENCODE_ENV, PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_ROOT: '/p' } }).id, 'codex');
  assert.equal(detectHost({ env: { ...OPENCODE_ENV }, input: { turn_id: 't' } }).id, 'codex');
});

test('no recorded payload of another host changes hands under an inherited OpenCode environment', () => {
  for (const host of ['claude-code', 'codex']) {
    const files = recordedPayloads(host);
    assert.ok(files.length >= 2, host);
    for (const { name, env, payloads } of files) {
      assert.ok(payloads.length > 0, `${host}/${name}`);
      for (const input of payloads) {
        const inherited = { ...env, ...OPENCODE_ENV };
        const label = `${host}/${name} ${input.tool_name}`;
        assert.equal(detectHost({ env: inherited, input }).id, host, label);
        assert.deepEqual(normalizeHookInput(input, inherited), normalizeHookInput(input, env), label);
      }
    }
  }
});

test('a command in an OpenCode shell runs under its session', () => {
  assert.deepEqual(sessionIdentity({ OPENCODE: '1', OPENCODE_SESSION_ID: 'ses_x' }), { session: 'ses_x', agent: null });
});

// A hook of another host whose own marks are missing, run under the variables an OpenCode shell left, is no one's: the
// unknown host reads it through every adapter, so no guard reads its names through OpenCode's alone.
test('OpenCode\'s variables alone never claim a hook payload without its mark', () => {
  const plugin = { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'mcp__plugin_github_github__merge_pull_request', tool_input: {} };
  assert.equal(detectHost({ env: { ...OPENCODE_ENV }, input: plugin }).id, 'unknown');
  assert.equal(normalizeHookInput(plugin, { ...OPENCODE_ENV }).tool_name, 'mcp__github__merge_pull_request');
  assert.equal(detectHost({ env: { ...OPENCODE_ENV }, input: { hook_event_name: 'PostToolUse', tool_name: 'shell' } }).id, 'unknown');
  assert.equal(detectHost({ env: { ...OPENCODE_ENV } }).id, 'opencode', 'a command, with no payload, is still OpenCode\'s');
  assert.equal(sessionIdentity({ ...OPENCODE_ENV }).session, OPENCODE_ENV.OPENCODE_SESSION_ID);
});
