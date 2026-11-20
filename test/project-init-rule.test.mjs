// The project-init Bash rule (lib/rules/project-init.mjs): a subagent never runs `aidrian project init`, however it runs
// aidrian; the main session does, and outside a project the rule is off.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { check, REASON } from '../plugins/aidrian/lib/rules/project-init.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');
const SUBAGENT = { agent_id: 'agent-1' };

function project(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-project-init-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  return dir;
}

test('a subagent cannot start a project run, however it runs aidrian', (t) => {
  const cwd = project(t);
  for (const command of [
    'aidrian project init launch --file snapshot.json',
    '/usr/local/bin/aidrian project init launch --file s.json',
    'node plugins/aidrian/lib/cli.mjs project init launch --file s.json',
    'node "$CLAUDE_PLUGIN_ROOT/bin/aidrian" project init launch --file s.json',
    'cd x && aidrian project init launch --file s.json --project .',
    'echo $(aidrian project init launch --file s.json)',
    'env FOO=1 aidrian project init launch --file s.json',
    "bash -c 'aidrian project init launch --file s.json'",
    "sh -c 'aidrian project init launch --file s.json'",
    "eval 'aidrian project init launch --file s.json'",
    "bash <<'EOF'\naidrian project init launch --file s.json\nEOF",
    "echo 'aidrian project init launch --file s.json' | bash",
  ]) assert.equal(check(command, { cwd, input: SUBAGENT }), REASON, command);
  for (const command of ['aidrian project next launch', 'aidrian project summary launch', 'echo "aidrian project init launch"', 'grep "project init" docs/config.md', 'node other.mjs project init launch']) {
    assert.equal(check(command, { cwd, input: SUBAGENT }), null, command);
  }
});

test('the main session, with no agent_id, runs init, and outside a project the rule is off', (t) => {
  const cwd = project(t);
  const command = 'aidrian project init launch --file s.json';
  for (const input of [{}, { agent_id: '' }, { agent_id: 7 }, undefined]) assert.equal(check(command, { cwd, input }), null, JSON.stringify(input));
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-project-init-bare-')));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(check(command, { cwd: bare, input: SUBAGENT }), null);
});

test('the Bash hook runs the rule: exit 2 for a subagent, and the same command passes for the main session', (t) => {
  const cwd = project(t);
  const state = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-project-init-state-')));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const hook = (extra) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'aidrian project init launch --file s.json' }, cwd, session_id: 's', ...extra }),
    encoding: 'utf8',
    env: { ...process.env, XDG_STATE_HOME: state },
  });
  const denied = hook(SUBAGENT);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /`aidrian project init` makes the session that runs it the driver of a project run/u);
  assert.equal(hook({}).status, 0);
});
