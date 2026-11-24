// The override guard (lib/override-guard.mjs): no session, attended or not, writes an AIDRIAN_ALLOW_* override into a
// host settings file whose env reaches every later session's hooks; the Human sets one in their own shell.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config-defaults.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { envSettingsFiles } from '../plugins/aidrian/lib/hosts/index.mjs';
import opencode from '../plugins/aidrian/lib/hosts/opencode.mjs';
import { overrideSettingsDenial } from '../plugins/aidrian/lib/override-guard.mjs';

import { hookCall } from './hook-call.mjs';

// The hook this file runs records its blocks in the state folder; keep those rows out of the real one.
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));
const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');

// A project folder and a Claude Code config folder of its own, with `.claude` folders and settings files there.
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-override-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project');
  const config = path.join(root, 'claude-config');
  for (const each of [path.join(dir, '.claude'), path.join(dir, '.aidrian'), config]) mkdirSync(each, { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  writeFileSync(path.join(dir, '.claude/settings.json'), '{}\n');
  const env = { ...process.env, CLAUDECODE: '1', CLAUDE_CONFIG_DIR: config };
  const ask = (tool_name, tool_input, { project = { checkouts: [dir] }, cwd = dir } = {}) => overrideSettingsDenial({ tool_name, tool_input, cwd, session_id: 's' }, project, DEFAULTS, { env });
  return { dir, config, env, ask };
}

const ENV = '{ "env": { "AIDRIAN_ALLOW_MAIN_WRITE": "1" } }';

test('a write, an edit, a patch, or a shell write that puts an override in a host settings file is refused, naming the Human\'s shell', (t) => {
  const { dir, config, ask } = fixture(t);
  for (const [tool, input] of [
    ['Write', { file_path: path.join(dir, '.claude/settings.json'), content: ENV }],
    ['Write', { file_path: '.claude/settings.local.json', content: ENV }],
    ['Edit', { file_path: '.claude/settings.json', old_string: '{}', new_string: ENV }],
    ['apply_patch', { command: `*** Begin Patch\n*** Update File: .claude/settings.json\n@@\n-{}\n+${ENV}\n*** End Patch\n` }],
    ['Write', { file_path: '.claude/settings.json', content: '{ "env": { "\\u0041IDRIAN\\u005fALLOW_X": "1" } }' }],
    ['Bash', { command: `echo '${ENV}' > .claude/settings.local.json` }],
    ['Bash', { command: `cat > ${path.join(config, 'settings.json')} <<'EOF'\n${ENV}\nEOF` }],
  ]) {
    const denial = ask(tool, input);
    assert.ok(denial, `${tool} ${JSON.stringify(input)}`);
    assert.match(denial.reason, /writes an AIDRIAN_ALLOW_\* override into \S+settings(?:\.local)?\.json, whose env reaches every later session's hooks/u);
    assert.match(denial.reason, /set in their own shell before a session starts/u);
  }
  // Outside a project, the user's own settings still count.
  assert.ok(ask('Write', { file_path: path.join(config, 'settings.json'), content: ENV }, { project: null, cwd: tmpdir() }));
});

test('an unrelated settings change, and an override named in any other file, pass', (t) => {
  const { dir, ask } = fixture(t);
  assert.equal(ask('Write', { file_path: '.claude/settings.json', content: '{ "env": { "NODE_ENV": "test" } }' }), null);
  assert.equal(ask('Edit', { file_path: '.claude/settings.json', old_string: '{}', new_string: '{ "permissions": {} }' }), null);
  assert.equal(ask('Write', { file_path: path.join(dir, 'docs.md'), content: 'Set AIDRIAN_ALLOW_MAIN_WRITE=1 in your shell.' }), null);
  assert.equal(ask('Bash', { command: 'echo AIDRIAN_ALLOW_MAIN_WRITE=1 >> notes.txt' }), null);
  assert.equal(ask('Bash', { command: 'grep AIDRIAN_ALLOW_ .claude/settings.json' }), null, 'a read');
});

test('only a host that names its env settings files adds any: Codex and OpenCode name none', (t) => {
  const { dir, config, env } = fixture(t);
  assert.deepEqual(envSettingsFiles([dir], env, [codex, opencode]), []);
  assert.deepEqual(envSettingsFiles([dir], env).sort(), [path.join(config, 'settings.json'), path.join(dir, '.claude/settings.json'), path.join(dir, '.claude/settings.local.json')].sort());
});

test('the agent gate hook refuses the write in an attended main session', async (t) => {
  const { dir, env } = fixture(t);
  const input = { session_id: 'abcd1234-0000-4000-8000-00000000a001', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, '.claude/settings.local.json'), content: ENV }, cwd: dir };
  const blocked = await hookCall(HOOK, { input: JSON.stringify(input), cwd: dir, env, encoding: 'utf8' });
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /^aidrian: Write is blocked for the main session in this project: it writes an AIDRIAN_ALLOW_\* override/u);
  const plain = await hookCall(HOOK, { input: JSON.stringify({ ...input, tool_input: { ...input.tool_input, content: '{}' } }), cwd: dir, env, encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
});
