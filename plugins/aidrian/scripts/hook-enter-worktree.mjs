// PreToolUse hook for EnterWorktree (Claude Code): a subagent may not call it. The tool moves the whole session's working
// folder, not only the subagent's, so the main session and every other running subagent would land in that worktree.
// A subagent works in a task worktree by its absolute path, or is dispatched with the Agent tool's worktree isolation.
// The main session may not enter an existing worktree outside the repository's `.claude/worktrees/` either, such as one
// `aidrian worktree new` made: the host asks the Human before every such move, and no permission rule silences the
// question, so a session no Human attends would stop there. It needs no move: the host lets a session edit files in any
// linked worktree, so it works there by absolute path. Creating a worktree by name, under `.claude/worktrees/`, passes.

import { realpathSync } from 'node:fs';
import path from 'node:path';

import { isWithin } from '../lib/fs.mjs';
import { mainRoot } from '../lib/git.mjs';
import { block, isMain, runHook } from '../lib/hook-io.mjs';

const REASON = 'Blocked: EnterWorktree moves the whole session into the worktree, the main session and every other ' +
  'running agent with it. Create the task worktree with `aidrian worktree new`, then run each command with its absolute ' +
  'path (`git -C <worktree>`, `cd <worktree> && …` in the same call) and edit files by absolute path.';

const OUTSIDE = (folder) => `Blocked: entering ${folder}, a worktree outside the repository's .claude/worktrees/, makes ` +
  'the host ask the Human first, and no rule answers that question, so a session no Human attends would stop on it. ' +
  'Stay where you are and work in the worktree by absolute path: the host lets a session edit files in a linked ' +
  'worktree, such as one `aidrian worktree new` made. Run each command with `git -C <worktree>` or ' +
  '`cd <worktree> && …` in the same call, and edit files by absolute path.';

// The real path of `file`, or its resolved path when it is not there.
function real(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// The hook's body, for the payload `input` (lib/hook-io.mjs callHook).
export async function handle(input) {
  if (input.tool_name !== 'EnterWorktree') return;
  if (typeof input.agent_id === 'string' && input.agent_id !== '') {
    await block(input, 'enter-worktree', REASON);
    return;
  }
  const given = input.tool_input?.path;
  if (typeof given !== 'string' || given === '' || typeof input.cwd !== 'string') return;
  const main = mainRoot(input.cwd);
  if (!main) return;
  const folder = real(path.resolve(input.cwd, given));
  const own = real(path.join(main, '.claude', 'worktrees'));
  if (isWithin(own, folder) && folder !== own) return;
  await block(input, 'enter-worktree', OUTSIDE(folder));
}

if (isMain(import.meta.url)) await runHook(handle);
