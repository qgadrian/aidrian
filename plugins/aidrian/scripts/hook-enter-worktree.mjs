// PreToolUse hook for EnterWorktree (Claude Code): a subagent may not call it. The tool moves the whole session's working
// folder, not only the subagent's, so the main session and every other running subagent would land in that worktree.
// A subagent works in a task worktree by its absolute path, or is dispatched with the Agent tool's worktree isolation.

import { block, runHook } from '../lib/hook-io.mjs';

const REASON = 'Blocked: EnterWorktree moves the whole session into the worktree, the main session and every other ' +
  'running agent with it. Create the task worktree with `aidrian worktree new`, then run each command with its absolute ' +
  'path (`git -C <worktree>`, `cd <worktree> && …` in the same call) and edit files by absolute path.';

await runHook(async (input) => {
  if (input.tool_name !== 'EnterWorktree' || typeof input.agent_id !== 'string' || input.agent_id === '') return;
  await block(input, 'enter-worktree', REASON);
});
