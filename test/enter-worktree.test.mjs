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
