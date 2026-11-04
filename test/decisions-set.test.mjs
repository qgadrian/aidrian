import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { check, REASON } from '../plugins/aidrian/lib/rules/decisions-set.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');
const SUBAGENT = { agent_id: 'agent-1' };

function project(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-decisions-set-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  return dir;
}

test('a subagent cannot settle or undo a decision, however it runs aidrian', (t) => {
  const cwd = project(t);
  for (const command of [
    'aidrian decisions undo refund-copy',
    'node plugins/aidrian/lib/cli.mjs decisions undo refund-copy',
    'cd x && aidrian decisions undo refund-copy --project .',
    "bash -c 'aidrian decisions undo refund-copy'",
    "echo 'aidrian decisions undo refund-copy' | bash",
    'aidrian decisions set refund-copy confirmed',
    '/usr/local/bin/aidrian decisions set refund-copy rejected',
    'node plugins/aidrian/lib/cli.mjs decisions set refund-copy confirmed',
    'node "$CLAUDE_PLUGIN_ROOT/bin/aidrian" decisions set refund-copy confirmed',
    'cd x && aidrian decisions set refund-copy confirmed',
    'echo $(aidrian decisions set refund-copy confirmed)',
    'env FOO=1 aidrian decisions set refund-copy confirmed',
    "bash -c 'aidrian decisions set refund-copy confirmed'",
    "sh -c 'aidrian decisions set refund-copy confirmed'",
    "eval 'aidrian decisions set refund-copy confirmed'",
    "bash <<'EOF'\naidrian decisions set refund-copy confirmed\nEOF",
    "echo 'aidrian decisions set refund-copy confirmed' | bash",
  ]) assert.equal(check(command, { cwd, input: SUBAGENT }), REASON, command);
  for (const command of ['aidrian decisions list', 'aidrian decisions resolve --vocab', 'echo "aidrian decisions set a confirmed"', 'echo "aidrian decisions undo a"', 'grep "decisions set" docs/hooks.md', 'node other.mjs decisions set a confirmed']) {
    assert.equal(check(command, { cwd, input: SUBAGENT }), null, command);
  }
});

test('the main session, with no agent_id, runs it, and outside a project the rule is off', (t) => {
  const cwd = project(t);
  const command = 'aidrian decisions set refund-copy confirmed';
  for (const input of [{}, { agent_id: '' }, { agent_id: 7 }, undefined]) {
    assert.equal(check(command, { cwd, input }), null, JSON.stringify(input));
    assert.equal(check('aidrian decisions undo refund-copy', { cwd, input }), null, JSON.stringify(input));
  }
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-decisions-set-bare-')));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(check(command, { cwd: bare, input: SUBAGENT }), null);
});

test('the Bash hook runs the rule: exit 2 for a subagent, and the same command passes for the main session', (t) => {
  const cwd = project(t);
  const state = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-decisions-set-state-')));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: state };
  const hook = (extra) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'aidrian decisions set a confirmed' }, cwd, session_id: 's', ...extra }),
    encoding: 'utf8',
    env,
  });
  const denied = hook(SUBAGENT);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /`aidrian decisions set` and `aidrian decisions undo` carry out the Human's answer/u);
  assert.equal(hook({}).status, 0);
});
