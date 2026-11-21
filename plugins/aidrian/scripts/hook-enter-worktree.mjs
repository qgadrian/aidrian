// PreToolUse hook for EnterWorktree (Claude Code): a subagent may not call it. The tool moves the whole session's working
// folder, not only the subagent's, so the main session and every other running subagent would land in that worktree.
// A subagent works in a task worktree by its absolute path, or is dispatched with the Agent tool's worktree isolation.
// The main session may not enter an existing worktree (`path`) either: the host asks the Human before a move into one
// outside the repository's `.claude/worktrees/`, such as one `aidrian worktree new` made, and no permission rule
// silences the question, so a session no Human attends would stop there. It needs no move: the host lets a session edit
// files in any linked worktree, so it works there by absolute path. Creating a worktree by name passes.

import { block, isMain, runHook } from '../lib/hook-io.mjs';

const REASON = 'Blocked: EnterWorktree moves the whole session into the worktree, the main session and every other ' +
  'running agent with it. Create the task worktree with `aidrian worktree new`, then run each command with its absolute ' +
  'path (`git -C <worktree> …`, `env -C <worktree> …`) and edit files by absolute path.';

const EXISTING = 'Blocked: this project never enters an existing worktree by path, wherever it lies. Outside the ' +
  'repository\'s .claude/worktrees/ the host asks the Human before the move, and no rule answers that question, so a ' +
  'session no Human attends would stop on it; inside, the move is not needed either. Stay where you are and work in the ' +
  'worktree by absolute path: the host lets a session edit files in a linked worktree, such as one `aidrian worktree new` ' +
  'made. Run each command with `git -C <worktree> …` or `env -C <worktree> …`, and edit files by absolute path.';

// The hook's body, for the payload `input` (lib/hook-io.mjs callHook).
export async function handle(input) {
  if (input.tool_name !== 'EnterWorktree') return;
  if (typeof input.agent_id === 'string' && input.agent_id !== '') {
    await block(input, 'enter-worktree', REASON);
    return;
  }
  const given = input.tool_input?.path;
  if (typeof given === 'string' && given !== '') await block(input, 'enter-worktree', EXISTING);
}

if (isMain(import.meta.url)) await runHook(handle);
