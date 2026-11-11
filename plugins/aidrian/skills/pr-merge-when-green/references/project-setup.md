# Project setup

Read when a check verdict surprises you, when `aidrian pr auto-merge` says off, or before changing the `github` check lists.

`aidrian pr checks` takes its policy from the `github` group in the `config.json` of the checkout it runs in.
So run this skill from a checkout of the pull request's repository: `aidrian pr checks -R` refuses any repository that is
not a remote of the current checkout.
A host-qualified `-R`, such as `github.com/acme/notes`, must match the remote's host; an SSH alias remote or a local remote matches by path, and a bare `owner/repo` matches any host.
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
- `paths`: gh lists every changed file with its change type, past `gh pr view`'s 100 through the paged files route at the same head, none is a rename, and none instructs an AI session or decides CI: `AGENTS.md`, `CLAUDE.md`, `SKILL.md`,
  `CODEOWNERS`, `.aidrian.json`, or a file under `.claude/`, `.codex/`, `.aidrian/`, `.github/workflows/`, or `.github/actions/`.
  The plugin's own code that decides auto-merge also keeps it off, so the gate never approves a change to itself.
  The exception: with `github.autoMerge.includeGuardedPaths` true on both the default branch and the base, these pass,
  except the policy files, which stay off: `.aidrian/config.json` at any depth, `.aidrian.json`, `.aidrian.local.json`,
  and the `.aidrian` entry itself.
  With the key on or off, none is one of the files the gate reads its policy from, including a folder `.aidrian.json` names.
- `local`: this machine opted in, with `"github": { "autoMerge": { "enabled": true } }` in the main checkout's `.aidrian.local.json`, which git must not track, or it has no setting and the default branch's `github.autoMerge.default` is `"on"`.
- `author`: the pull request is the gh user's own.
- `outsider`: every comment and review on the pull request is by an owner, member, or collaborator, or by the `github.reviewer` bot.
- `review`: nobody's latest review requests changes, and this machine's review record holds a `received` review of exactly the current head, with nothing owed. A `none_needed` record of that head counts too only when its plan's reasons are exactly "only files that cannot change behaviour" at depth `none`, and every changed file is one `github.autoMerge.unreviewedPaths` lists on both the default branch and the base (empty by default, so off), one the default branch's `review.nonBehaviour` names and its `review.ignore` does not, is `.md` or a raster image, and is no guarded file even with `includeGuardedPaths` on, no path with a folder or name that starts with `.`, no host instruction name such as `GEMINI.md` or `AGENTS.override.md`, and no test file, fixture, or golden file. Each entry matches the whole path, and a `re:` entry is anchored. The team lists only files that no AI session reads as instructions and no build, docs site, or test reads as code or as an expected result, such as Markdown a docs site parses as MDX (Docusaurus) or as VitePress pages, a README run as doctests (cargo, pytest `--doctest-glob`), or an end-to-end test's expected files: the gate cannot tell. Any other pull request that needed no review waits for the Human.

The team's `strategy` (null: step 0's order), `deleteBranch`, and `deleteWorktree` come from the default branch.
They decide an unattended run, and fill the choices the Human leaves out of a run the Human starts.
`aidrian check` warns when the machine opts in and the team does not allow it.
Never change either setting during a merge run.
