# Project setup

Read when a check verdict surprises you, when `aidrian pr auto-merge` says off, or before changing the `github` check lists.

`aidrian pr checks` takes its policy from the `github` group in the `config.json` of the checkout it runs in.
So run this skill from a checkout of the pull request's repository: `aidrian pr checks -R` refuses any repository that is
not a remote of the current checkout.
Each entry is part of a check name and matches any check whose name contains it, so pick parts that match only the checks meant.

- `requiredChecks`: put the end-to-end check family here (`["e2e"]`, say).
  Every matching check must exist and be `SUCCESS`: a skipped, neutral, or cancelled one fails, and a missing one keeps the
  run waiting. Without the entry, a skipped end-to-end check reads as a pass.
- `conditionalChecks`: the checks a path filter turns off when the diff does not touch their files.
  Once the list has an entry, any other `SKIPPED` or `NEUTRAL` check fails as an unexpected skip.
  A check belongs here only when the diff alone decides its skip. One that a label or another person's choice can skip
  does not, or that choice could turn a pull request green.
- `ignoreCancelledChecks`: checks whose `CANCELLED` is routine, such as a preview deploy an ignored build cancels.

When a run stops on an unexpected skip that looks routine, ask the user before adding it to `conditionalChecks`.
Never add an entry on your own during a merge run.

## Auto-merge

`aidrian pr auto-merge` exits 0 only when all seven hold; with `--json`, `reason` names the first that fails:

- `team`: config.json `github.autoMerge.allow` is true on both the repository's default branch and the pull request's base.
  It reads them from GitHub as each branch commits them now, never from the checkout, so a branch cannot raise them.
- `checks`: the default branch names `github.requiredChecks`, and this checkout's three check lists equal the default
  branch's, as sets, and its `state.dir` too. A named check that has not registered is pending, not passed;
  `aidrian pr checks` reads this checkout, so equal lists make its verdict the default branch's policy.
  A config this checkout cannot read is off too.
- `paths`: gh lists every changed file, and none instructs an AI session or decides CI: `AGENTS.md`, `CLAUDE.md`, `SKILL.md`,
  `CODEOWNERS`, `.aidrian.json`, or a file under `.claude/`, `.codex/`, `.aidrian/`, `.github/workflows/`, or `.github/actions/`.
- `local`: this machine opted in, with `"github": { "autoMerge": "on" }` in the main checkout's `.aidrian.local.json`, which git must not track.
- `author`: the pull request is the gh user's own.
- `outsider`: every comment and review on the pull request is by an owner, member, or collaborator, or by the `github.reviewer` bot.
- `review`: nobody's latest review requests changes, and this machine's review record holds a finished review of exactly the current head, with nothing owed.

The team's `strategy` (null: step 0's order), `deleteBranch`, and `deleteWorktree` come from the default branch.
They decide an unattended run, and fill the choices the Human leaves out of a run the Human starts.
`aidrian check` warns when the machine opts in and the team does not allow it.
Never change either setting during a merge run.
