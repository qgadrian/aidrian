import '../scripts/test-state.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-enter-worktree.mjs');
const run = (fields) =>
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'EnterWorktree', tool_input: {}, cwd: import.meta.dirname, ...fields }), encoding: 'utf8' });

test('a subagent may not call EnterWorktree, which would move the whole session; the main session may', () => {
  const sub = run({ agent_id: 'a1', agent_type: 'aidrian:backend-developer' });
  assert.equal(sub.status, 2);
  assert.match(sub.stderr, /^Blocked: EnterWorktree moves the whole session/);
  assert.equal(run({}).status, 0);
  assert.equal(run({ agent_id: 'a1', tool_name: 'Read' }).status, 0);
});

test('the main session may not enter an existing worktree, in the repository\'s .claude/worktrees/ or outside it, where the host asks the Human; it may create one by name', () => {
  for (const given of ['.worktrees/task', '.claude/worktrees/own', path.join(import.meta.dirname, '..', '.claude', 'worktrees', 'own'), '/elsewhere/.claude/worktrees/own']) {
    const entered = run({ tool_input: { path: given } });
    assert.equal(entered.status, 2, given);
    assert.match(entered.stderr, /^Blocked: this project never enters an existing worktree by path, wherever it lies\./);
    assert.match(entered.stderr, /work in the worktree by absolute path/);
    assert.doesNotMatch(entered.stderr, /task|own|elsewhere/, 'the reason is fixed, never the path');
  }
  assert.equal(run({ tool_input: { name: 'fresh' } }).status, 0);
  assert.equal(run({ tool_input: { path: '' } }).status, 0);
});
