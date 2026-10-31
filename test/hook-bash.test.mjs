import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// The hooks this file runs record their blocks in the state folder; keep those rows out of the real one.
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');

// Runs the hook with `input` on stdin and no override set.
function bashHook(input, env = {}) {
  return spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { ...process.env, ...env } });
}

const bash = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: process.cwd() });

test('a command a rule objects to exits 2 with that rule`s reason on stderr', () => {
  const { status, stdout, stderr } = bashHook(bash('git commit --amend'));
  assert.deepEqual([status, stdout], [2, '']);
  assert.match(stderr, /^Blocked: `git commit --amend`/);
});

test('rules run in order and the first objection wins', () => {
  const { status, stderr } = bashHook(bash('git commit --amend --no-verify'));
  assert.equal(status, 2);
  assert.match(stderr, /^Blocked: this skips a git hook\./, 'the hook-bypass rule runs before the amend rule');
  assert.equal(bashHook(bash('git commit --amend --no-verify'), { AIDRIAN_ALLOW_GIT_AMEND: '1' }).status, 2);
});

test('every rule is wired: process kill and listing, and the grep chain', () => {
  assert.match(bashHook(bash('pkill -f eslint')).stderr, /^Blocked: stopping processes by name/);
  assert.match(bashHook(bash('ps aux')).stderr, /^Blocked: this process listing prints full command lines/);
  assert.match(bashHook(bash('grep -c x f && npm test')).stderr, /^Blocked: a counting grep is chained with `&&`/);
  assert.equal(bashHook(bash('pkill -f eslint'), { AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME: '1' }).status, 0);
});

test('the pull request body rule is wired, inside a project folder', () => {
  const inExample = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: path.resolve(import.meta.dirname, '../examples/consumer') });
  assert.match(bashHook(inExample(['gh', 'pr', 'create', '--fill'].join(' '))).stderr, /^Blocked: `--fill` writes the body/);
});

test('an allowed command, another tool, and any unreadable stdin exit 0 silently', () => {
  for (const input of [
    bash('git commit -m "fix: x"'),
    JSON.stringify({ tool_name: 'Edit', tool_input: { command: 'git commit --amend' } }),
    JSON.stringify({ tool_name: 'Bash' }),
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 42 } }),
    '',
    'not json',
    '[]',
  ]) {
    assert.deepEqual(Object.values((({ status, stdout, stderr }) => ({ status, stdout, stderr }))(bashHook(input))), [0, '', ''], input);
  }
});
