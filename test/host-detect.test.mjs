// Which host a process runs under, and what shared code learns from it (lib/hosts/index.mjs). An unknown host is reported as
// unknown, never as one of the hosts it may not be.

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { currentAuthor, runEnv } from '../plugins/aidrian/lib/attribution.mjs';
import { detectHost, normalizeHookInput, sessionIdentity } from '../plugins/aidrian/lib/hosts/index.mjs';

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
  assert.equal(detectHost({ env: { CLAUDECODE: '1', PLUGIN_ROOT: '/p' } }).id, 'codex');
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
