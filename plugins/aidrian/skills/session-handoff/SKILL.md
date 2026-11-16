---
name: session-handoff
description: Write a handoff brief so a fresh session can resume this work, when the Human or session.handoff.mode allows.
---

# session-handoff

Write a self-sufficient brief for the current work, so the user can end this session and resume in a fresh one
without losing context: the brief carries the context instead of the transcript.

## When

Write a brief only when the Human allowed it: the Human asks for one, a run's `--handoff` flag or launch words ask for it,
or config.json `session.handoff.mode` is `"auto"`. The points where `"auto"` writes one: a phase boundary with work left
(plan to implement, implement to review, review to merge), the session-length reminder, a visible usage-limit warning,
or an unattended run that ends with its task unfinished.

- `"ask"`, the default: at those points, ask the Human and write on a yes. An unattended run cannot ask: it writes none,
  and its report carries what a resume needs.
- `"off"`: write none unless the Human asks.
- Never when the task is done and the user is here: with nothing to resume, a brief only costs tokens.

## Steps

1. **Settle running work.** If agents or background jobs are still running, wait for the ones the brief needs,
   stop the rest on purpose, and record each one left running under Still running: what runs, where its output lands,
   and what to do with it.
2. **Read the state with commands, not memory.** Use it to write Done and the Current state line that names the worktree,
   the branch, and the pull request, never as a snapshot:
   `git branch --show-current`, `git rev-parse --show-toplevel`, `git status --porcelain`, `git log --oneline -5`,
   and `gh pr view --json number,url,state,headRefName` when a pull request may exist.
3. **Pick the path.** Run `aidrian state`; the brief is `<state>/handoffs/<UTC date>-<slug>.md`, where `<slug>` is the
   branch name after its last `/`, or a short task name. Every worktree shares that folder, so a fresh session finds it.
4. **Snapshot what it supersedes.** Once per refresh, before the first write, run `aidrian handoff snapshot <brief>`
   (add `--prior <old brief>` when the old brief has another slug). Never in a fix round: it would snapshot your draft.
5. **Write the brief** from the template in `references/brief-template.md`, read for every brief.
   Then reread the brief as a reader with no context, and fix it until:
   - every still-valid decision, gotcha, fact (ids, mappings, hand-edited data), and runbook step of the brief it
     supersedes is carried, not pointed at; the header names each dropped item with why it is obsolete;
   - each command in Next steps matches the tool's real options, read in this session;
   - each conditional step names its condition and its exact command for every branch;
   - each resume command carries every flag that is not stored on disk;
   - open risks and questions from agents' results are under Open risks and questions, whole or by exact path and field;
   - each commit step names the paths to stage and what stays out;
   - lines are one sentence each and within the project's line limit.

   Under a usage-limit warning, write first, then review and rewrite.
6. **Check it.** Run `aidrian handoff check <brief>` (same `--prior` as step 4). Exit 1 lists:
   - long lines, and a missing advice line;
   - each required section that is missing or empty: Objective, Current state with its `Worktree:` and `Branch:`
     values, Still running, Next steps with a numbered item, and Open risks and questions;
   - a header with no `Supersedes:` value, or one that names a brief no prior was found for: rerun with `--prior`;
   - the identifiers from the superseded brief's Decisions locked, Gotchas, Next steps, Key paths, and Open risks and
     questions that the new one no longer names: carry each, name a done step under Done with its command or commit,
     or name it in the header as dropped, with why.

   Fix each finding and run the check again. Compare the prose-only items it prints by hand, at exit 0 too.
   A finding the session cannot fix, such as a superseded brief that no longer exists, is told to the Human with the
   resume instructions.
7. **Print the resume instructions** below.

Refreshing the brief for the same task overwrites the same file. A run that crosses a UTC date starts a new file,
and the newest brief wins.

## Resume instructions

Print these at the end, and nothing about worktree paths or drift checks: the `session-continue` skill handles them.

- Start the new session from the repository, as usual.
- The first message, alone on its own line so it copies in one go, is `/aidrian:session-continue <slug>` in Claude Code.
  In Codex, ask to run the `session-continue` skill with `<slug>`.

## Rules

1. **Self-sufficient or useless.** Write for a reader with zero context: every decision has its reason,
   every step names its files.
2. **No secrets.** Never copy environment values, tokens, or credentials into the brief.
3. **Never commit the brief.** It lives in the state folder, outside the repository.
4. **About 150 lines at most.** Link plans and decision records instead of restating them.
5. **Newest brief wins.** Say in the header which brief this one supersedes, and carry what still holds.
6. **Carry only what the files cannot tell.** Decisions, reasons, dead ends, gotchas, and next steps.
   Never snapshot volatile state such as a clean tree, check results, or pull request state:
   the next session reads it fresh. A failing or pending result that blocks the next step is a Next steps item.
7. **Skip a current brief.** When the brief for this task exists and nothing changed since (no commit, decision,
   or new next step), say it is current and give its path, instead of rewriting it.
8. This skill commits, pushes, and ends nothing; the user decides when to close the session.
