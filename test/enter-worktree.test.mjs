import '../scripts/test-state.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('the main session may not enter a worktree outside the repository\'s .claude/worktrees/, which the host asks the Human about; it may create one by name, or enter one there', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'enter-worktree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const git = (args, cwd = repo) => assert.equal(spawnSync('git', args, { cwd, encoding: 'utf8' }).status, 0, args.join(' '));
  mkdirSync(repo);
  git(['init', '--quiet']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'first']);
  git(['worktree', 'add', '--quiet', '-b', 'task', path.join(repo, '.worktrees', 'task')]);
  git(['worktree', 'add', '--quiet', '-b', 'own', path.join(repo, '.claude', 'worktrees', 'own')]);
  const outside = run({ cwd: repo, tool_input: { path: '.worktrees/task' } });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /^Blocked: entering .*\.worktrees\/task, a worktree outside the repository's \.claude\/worktrees\//);
  assert.match(outside.stderr, /work in the worktree by absolute path/);
  // From inside another worktree, the main checkout's .claude/worktrees/ is the one the host lets through.
  assert.equal(run({ cwd: path.join(repo, '.worktrees', 'task'), tool_input: { path: path.join(repo, '.claude', 'worktrees', 'own') } }).status, 0);
  assert.equal(run({ cwd: repo, tool_input: { path: path.join(repo, '.claude', 'worktrees') } }).status, 2, 'the folder itself is no worktree of it');
  assert.equal(run({ cwd: repo, tool_input: { name: 'fresh' } }).status, 0);
  assert.equal(run({ cwd: dir, tool_input: { path: path.join(repo, '.worktrees', 'task') } }).status, 0, 'outside a repository the hook cannot tell, and lets it run');
});
