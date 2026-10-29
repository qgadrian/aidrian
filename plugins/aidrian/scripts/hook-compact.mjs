// PreCompact hook: when compaction starts without typed instructions, print the checklist below. Claude Code uses a
// PreCompact hook's stdout as the compaction's instructions, so the summary keeps what the task needs to go on, not a
// generic recap. Instructions typed after /compact win: then this prints nothing. If a host ignores the output,
// compaction falls back to its default summary.

import { runHook } from '../lib/hook-io.mjs';

const CHECKLIST = `Preserve everything needed to continue the current task, through implementation, review, and fixes, until it is done. Omit a section below that does not apply to this session.

Keep:

- Task definition: the goal and the acceptance or "done" criteria
- Pointers to durable artifacts: issues, pull requests, the branch, the worktree path, plan files, handoff briefs, review files, and the output path of any agent whose result is still needed. A path is the cheapest thing to keep and the most expensive to lose
- Locked decisions, with the reason behind each
- Critical gotchas, constraints, and invariants found while working
- Current state: what is done, and what is committed and what is not
- Progress through a phased plan: which phases are done and which remain, with each phase's verification results and reviewers' verdicts word for word, or the path of the file that holds a verdict
- Verification status: the last typecheck, lint, and test results: what passed, what failed, and why
- Open review findings: each finding's owner, verdict, and status, word for word. Do not soften or re-judge them
- Dead ends: approaches tried and abandoned, with the reason, so they are not retried
- Lessons noticed but not yet captured with the lesson skill, with their evidence. Capture is one command; a lesson kept only here is lost
- Output preferences the user set in this session, so they do not silently reset
- The immediate next steps, and context for planned follow-ups not yet done

Discard:

- Background task notifications and stale system reminders, but keep any file path they carried, and keep a notification while its result is still being acted on
- Resolved review findings whose fix is committed and verified (keep a one-line trace)
- Anything unrelated to the current task`;

await runHook((input) => {
  if (typeof input.custom_instructions === 'string' && input.custom_instructions.trim() !== '') return;
  console.log(CHECKLIST);
});
