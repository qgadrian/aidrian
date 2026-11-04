# The project folder

A project that uses the aidrian plugin keeps everything the plugin reads in one folder: `.aidrian/` at the project root.
The plugin's commands, hooks, agents, and skills find the project's knowledge and settings there.
Nothing else in the project configures the plugin.
What the plugin writes on one machine, such as plans and lessons, goes to a [state folder](#local-state) outside the repository.
Task worktrees go in `.worktrees/` at the repository root, which git ignores.

[`examples/consumer`](../examples/consumer) is a complete, checked example.

## Structure

```text
.aidrian.json                    names another folder as the project folder (optional, committed)
.aidrian.local.json              adds knowledge sources, models, names, telemetry, agent gates, and decisions on one machine (optional, git-ignored)
.worktrees/                      task worktrees, one folder per branch (git-ignored)
.aidrian/
├── config.json                  the folder version and the project settings (committed)
├── terms.json                   the banned terms, when config.json terms.file names it here (optional, committed)
└── knowledge/<bucket-id>.json   one index per knowledge bucket (committed)
```

The committed files are JSON, and the project folder holds nothing else.
The docs a bucket indexes stay where they are: each index names its doc folder in `dir`.

- `config.json` needs `version`; every other key is optional. [config.md](config.md) lists the keys.
- `knowledge/<bucket-id>.json`: the file name is the bucket id. [knowledge.md](knowledge.md) describes the file.
  Buckets load in file-name order, so `10-engineering.json` comes before `20-product.json`.
- `terms.json`: the [terms file](config.md#terms); config.json `terms.file` may name another place.

## Location

The project root is the nearest folder, at or above the current one, that has `.aidrian.json` or `.aidrian/config.json`.
In a git checkout the search stops at the checkout's top folder.
In a git worktree that is the worktree itself, so a branch reads its own committed knowledge.
A worktree whose branch has no project folder has no project, even inside a main checkout that has one: the hooks stay silent there.
`aidrian check` there says the worktree was created before the project folder was committed and pushed.

To keep the folder somewhere else, commit `.aidrian.json` at the project root:

```json
{ "dir": "tools/aidrian" }
```

`dir` is the relative path of a folder inside the project.
Every `.aidrian/` path in this document then starts with `tools/aidrian/` instead.
`.aidrian.json` is the only place that moves the folder; nothing inside the folder names its own location.

## Versioning

`version` in `config.json` is a whole number that names the format of the whole folder: the config keys and the index files.
This plugin reads version 1 only.
When `version` is missing, older, or newer, `aidrian check` fails with a link to [Migrating](#migrating),
every other `aidrian` command that reads `config.json` stops with the same error, and the hooks read nothing else from the folder.

A release that changes the format raises the version and lists, under Migrating, what a project changes.

## Setting up and checking

`aidrian init` creates the folder and keeps its local state out of git. Run it at the project root:

```console
$ aidrian init
wrote .aidrian/config.json
added to .gitignore: .aidrian.local.json, .worktrees/
next: add a knowledge index with aidrian-knowledge init <folder of docs>, then run aidrian check
```

It writes `config.json` with `version` alone, and adds each `.gitignore` line for an entry git does not ignore yet:
`.aidrian.local.json`, the [worktrees folder](#task-worktrees), and the [state folder](#local-state) when config.json puts it in the repository.
Init writes only inside the checkout it runs in.
In a linked worktree, a folder that resolves into the main checkout, such as the default `.worktrees`, is left to the main checkout's own `.gitignore`.
It never overwrites a file. Run again, it prints `nothing to do: .aidrian is set up`.
It writes nothing at all when a symlink would take a write outside the project, or a `.gitignore` outside its own folder.

`aidrian check` validates the whole folder. Run it locally and in CI. It prints `ok`, or one line per problem and exits 1:

- `.aidrian.json`, when present: valid JSON, no key but `dir`, and `dir` inside the project.
- `config.json`: the version first, then every key and value.
- Every knowledge index, as [knowledge.md](knowledge.md#checks) describes.
- `.aidrian.local.json`, when present: every source, as [Local knowledge sources](#local-knowledge-sources) describes,
  `models`, as [config.md](config.md#models) describes, and `names`, as [config.md](config.md#names) describes.
- `.gitignore`: git ignores `.aidrian.local.json`, and the worktrees and state folders when they are inside the repository.

On success it also prints the state folder, and the size of the `always` docs against their [budget](config.md#knowledge-budgets):

```console
$ aidrian check
ok: .aidrian (2 buckets, 8 docs)
state: /home/you/.local/state/aidrian/projects/notes-1a2b3c4d
budget: 2479 of 16384 always-doc bytes (engineering 2479, product 0)
```

In a Claude Code session, `aidrian` is on the PATH while the plugin is enabled. It needs Node 22 or later.
Elsewhere, run it from the plugin folder the host installed: [Claude Code](providers/claude-code.md#running-aidrian),
[Codex](providers/codex.md#running-aidrian). In CI, run it from a clone: the README's [In CI](../README.md#in-ci).
`bin/aidrian` is a shell script, so run it directly, not with `node`.
Where no shell runs it, use `node <plugin folder>/lib/cli.mjs`, and `node <plugin folder>/lib/knowledge-cli.mjs` for `aidrian-knowledge`.

`aidrian lint` keeps the project's AI instructions cheap and portable, with the limits in config.json. Run it beside `aidrian check`:

- `skills`: each `.claude/skills/<name>/SKILL.md` has a one-line YAML `description` within `skills.descriptionChars`,
  and all skill names and descriptions together fit in `skills.listingBytes`. Both hosts list them in every session.
  A `SKILL.md` of 8,000 bytes or more fails, because Codex cuts it there; one above 7,500 bytes passes with a warning.
  No Markdown file in a skill's folder, its references and brief templates included, asks for `git commit --amend`:
  the [amend rule](hooks.md#bash-rules) refuses it, so the dispatch that asked is wasted. Ask for a new commit instead.
  A prohibition passes when it governs the amend directly, as "never `git commit --amend`", "instead of amending",
  or "`git commit --amend` is blocked"; write any other one that way.
- `agents`: each `.claude/agents/*.md` has `name` equal to its file name, a `description`, and a known `model` and `effort`,
  and asks for no amend.
- `paths`: no tracked file holds a personal home folder such as `/Users/<name>/`; `--staged` checks the staged files only, as the index holds them.
- `budget`: the [knowledge budgets](config.md#knowledge-budgets) that `aidrian check` also holds. It prints the `always` bytes per bucket.
- `personas`: each knowledge doc tagged `personas`, except `product-access`, has the [persona sections](personas.md#the-persona-contract),
  a `Success:` line under every `### <task>`, and no two tasks with one title.
  A `Success:` paragraph that holds a span in double quotes or backticks passes with a warning. A project with no personas passes.

`aidrian lint skills <folder>` and `aidrian lint agents <folder>` check other folders.

## Local state

The plugin writes plans, session handoff briefs, agents' machine handoffs, review state, quorum ledgers, persona audits, pull request body drafts, the lesson inbox,
and the dispatch log on each machine. They live in one state folder per project, outside the repository, so git never sees them:

```text
$XDG_STATE_HOME/aidrian/projects/<project-id>/
├── plans/                local plans
├── handoffs/             session handoff briefs, which the session-continue skill reads
├── dispatch/             machine handoffs that dispatched agents write for the orchestrator and the skills it runs
├── reviews/              review manifests, and the agents the specialist-review skill keeps warm
├── quorum/               quorum ledgers, one per plan or question file and its hash
│   └── questions/        the question files of the quorum's decide mode
├── audits/               persona-audit reports, and the screenshots each cites
├── lessons/inbox.jsonl   the lesson inbox, and its inbox.jsonl.lock.<n> lock files
├── tmp/                  pull request bodies and review comments that skills draft
├── dispatch-log.jsonl    the dispatch log
└── dispatch-log.1.jsonl  its rotated part, once the log reaches config.json telemetry.maxMb
```

- `$XDG_STATE_HOME` defaults to `~/.local/state`.
- `<project-id>` is the repository name and a short hash of its `origin` URL, such as `notes-1a2b3c4d`.
  Every worktree and every clone of the repository shares it.
  A repository with no `origin` uses its folder name and a hash of the main checkout's path.
  A project in a subfolder of the repository adds that subfolder's path to the hash, so two projects in one repository
  get two state folders; a project at the repository root keeps the id above.
- `"state": { "dir": "<path>" }` in config.json moves the folder; [config.md](config.md) lists the key.
  A relative path starts at the repository root, and `aidrian check` then requires git to ignore it.

`aidrian state` prints the folder. Skills use it to find plans and handoff briefs, and to draft pull request bodies;
the orchestrator uses it to name each background agent's handoff file.
`aidrian lesson` adds, lists, resolves, and counts lessons in the inbox ([lessons.md](lessons.md)).
A lesson for the plugin goes to the [plugin's inbox](lessons.md#the-plugins-inbox), in the state folder of the plugin's own repository.
`aidrian handoff` checks a handoff brief against the one it supersedes.
`aidrian report` summarizes the [dispatch log](dispatch-log.md).

The `quorum` skill runs in one of two modes, and its ledger records which in `mode`.
A plan-mode ledger, `quorum/<name>-<plan-hash>.json`, records the objections two adversaries raised against a plan,
the architect's ruling on each, and the Human's answers. `<name>` is the plan's file name without `.md`,
or `<parent-folder>-plan` for a file named `plan.md`, and `<plan-hash>` is `git hash-object` of the plan.
`lib/quorum.mjs` holds its schema, `LEDGER_SCHEMA`, and the schemas of Codex's answers, `OBJECTIONS_SCHEMA` and `REBUTTALS_SCHEMA`.
Each objection, ruling, and rebuttal cites its evidence as `{kind, ref, quote}`.
The `quorum` skill's `references/ledger.md` lists every field.

A ledger written by the plan mode of the `quorum` skill carries `mode: plan`, and with it the fields its briefs fill:

- `notes`: improvements no one rules on.
- `merged_into`, on an objection whose status is `merged`: the other adversary's duplicate it was folded into.
- On each first and final ruling: `tested`, one verdict per citation of the entry ruled on; `inferences`, one verdict
  per `inference:` line of its claim; and `ground` on a reject, one of `covered`, `implementation`, `settled`,
  `off-goal`, `disproportionate`, or `speculative`.
- `proportionality`: the architect's review of the accepted changes as a set, with the ones it flagged, and
  `failed: true`, with nothing flagged, when the pass returned no usable answer.

`runners`, on any plan ledger, records each adversary's final runner, `agent` or `codex`: `codex` while every run went
to Codex, `agent` once one did not. A ledger written before it has none.

A ledger with no `mode` is plan mode under the rules it was written with: 7 objections each, `improvement` allowed,
and none of the rules below that need `mode`. `check` never adds the field. Such a ledger is `complete`: `check`
exits 1 on an `open` plan ledger with no `mode`, since the skill writes it on every ledger it opens.
Two commands keep a ledger honest, and `roles` tells the skill who runs each role:

- `aidrian quorum codex --plan PLAN --brief BRIEF --out FILE [--mode object|case]` runs Codex read-only on the brief
  and then the plan, for at most 780 seconds, and writes its answer to FILE. `--mode object`, the default, holds the answer
  to `OBJECTIONS_SCHEMA`, Codex's objections. `--mode case` holds it to `CASE_SCHEMA`, an advocate's opening case.
  `aidrian quorum codex --mode rebut|cross --ledger LEDGER --plan PLAN --brief BRIEF --out FILE` answers a ledger.
  `--mode cross` holds the answer to `CROSS_SCHEMA`: at most 5 points `{against, claim, citations}`, each against a
  position LEDGER holds. LEDGER must be a decide ledger, or the run fails with
  `--mode cross answers a decide ledger, and this ledger is in plan mode`.
  On a decide ledger, `--mode rebut` holds the answer to `DECIDE_REBUTTAL_SCHEMA`, `{rebuttal: {verdict, claim, citations}}`,
  and a concession must cite at least one citation.
  On a plan ledger, `--mode rebut` holds it to `REBUTTALS_SCHEMA`:
  at most 7 entries `{objection_id, verdict, claim, citations}`, where `verdict` is `rebut` or `concede` and a concession
  cites at least one citation when LEDGER carries `mode`, and may cite nothing when it does not; without
  `objection_id`, an entry is that objection's ledger `rebuttal`, whose `ruling` starts null.
  The answer must also fit LEDGER, which may live anywhere and is read and schema-checked before Codex starts:
  each id once, each one of B's objections ruled `reject` or `accept` (a partial accept's rebuttal covers the rejected
  part) and not `escalated`, since an escalated objection goes to the Human, and an entry for every one of B's objections
  with status `rejected`. The reason names each id that breaks this.
  An answer off its schema or its ledger is `failed` and is not written. It prints one line, `{"status", "reason"}`, where status is
  `done`, `unavailable`, `timed_out`, `quota`, or `failed`, and exits 0 on `done`, 3 on `unavailable`, and 1 otherwise.
  Any other `--mode`, `--mode rebut` or `cross` without `--ledger`, `--ledger` with `object` or `case`, or a missing flag
  prints the usage error and exits 1 without starting Codex.
- `aidrian quorum roles plan|decide` prints that mode's roles, judge, and caps as one JSON line, from config.json
  [`quorum`](config.md#quorum), with today's values where it sets none. Each role has `provider`, `agent`, and
  `fallback`: the agent on `agent`, or the agent that takes over on `codex`. Plan adversary A is always `agent`;
  plan caps are `maxObjections` and `maxDispatches`. Decide prints the `odd` runner of positions A and C and the
  `even` one of B and D, `swap`, and `caps`, the dispatch cap for each position count from 2 to 4. It reads nothing
  else and writes nothing. An invalid config.json, or a mode other than `plan` or `decide`, exits 1.
- `aidrian quorum check LEDGER --plan PLAN` checks every citation. `doc` and `adr` cite `path#anchor`, and the quote
  must be in that section; `code` cites `path:line`, and the quote must be in the file; `plan` cites `#anchor` in PLAN;
  `absence` cites a path, and the quote must be in no regular file `git ls-files` lists there; a path with no tracked file fails.
  When `git ls-files` itself fails, the citation fails with git's exit code and its last stderr line.
  An anchor matches a heading by its text, the anchor GitHub gives it (`-1` for a repeated heading's second copy), or that anchor with `_` dropped and hyphens collapsed;
  a `#` line in a fenced code block is not a heading.
  A fence counts at any indentation, and may open after a list marker, as in "- ```bash".
  A quote is at most 200 characters, compared with whitespace collapsed.
  A `pending` objection with no passing citation becomes `opinion`; one already ruled on keeps its status and is named.
  A ruling, or a rebuttal that rebuts, with no passing citation is named invalid.
  Each citation of a ruling's `inferences` is checked as well, named as `<ruling>.inferences[i].citations[j]` when it
  fails, and a ruling, first or final, is invalid when an inference that holds has no passing citation:
  `inference "<statement>" holds on no passing citation`. One that does not hold may cite nothing.
  A rebuttal that rebuts is also invalid when it cites nothing new: every passing citation of it is already cited by an
  objection or its ruling, by kind, path, anchor, and quote. Other rebuttals do not count. It prints each problem and writes the ledger back.
  A ref path outside the repository, as `..`, an absolute path, or through a symlink, is a failed citation that it warns
  about on stderr; it never reads that file. A ref with a control character is not a relative path, and `doc` and
  `code` read only a regular file.
  It exits 1 on a schema error, on an objection id other than `A1` to `A7` or `B1` to `B7` or one used twice, on
  `same_model` true with no `same_model_reason` or false with one, on a ledger with `runners` whose `same_model` is
  not whether `runners.A` and `runners.B` match, on a Human answer for an objection the ledger does
  not hold or a second answer for one, or on a `complete` ledger with an objection still `pending` or ruled on with no
  `ruling`. On an objection the Human did not settle (not `escalated`, not answered), a `complete` ledger also fails
  on a rebuttal with no final ruling, a final ruling other than `accept`, a status its final decision does not give, a
  `rejected` objection with no rebuttal or concession, or an invalid ruling or rebuttal, as after cited code changed.
  An unflagged valid partial accept's first ruling counts even on an escalated or answered objection, since its
  accepted part stands. A flagged one does not count: the flag escalated its accepted part too, so it is the Human's.
  Such a ledger is not written back, so it is not reused. It runs no command but `git ls-files`. PLAN and the ledger
  may live anywhere, such as this folder.
  On every ledger, it exits 1 on a `merged` objection with a ruling or a rebuttal, or whose `merged_into` names no
  objection, one of its own adversary, or one that is merged or an opinion, or one whose citations are not all among
  its survivor's (by kind, ref, and quote, whitespace collapsed), and on a `proportionality` with
  `failed: true` that flags any objection; it removes a note with no passing citation and names it.
  On a ledger that carries `mode`, it also exits 1 on more objections from one adversary than config.json
  `quorum.plan.maxObjections`, 5 by default, while the ledger is `open`, which is the only time it reads config.json,
  so it also exits 1 on an invalid config.json; on more than 5 once it is `complete`, so a cap lowered after a run
  finished never voids its ledger; on an `improvement`
  objection, on a complete ledger with an accept ruling and `proportionality` null, and on a flagged objection with no
  accept ruling or one neither escalated nor answered. It names a ruling invalid, first or final, when:
  - an accept cites no `plan` section, or rests on no citation of the entry that passes and that `tested` marks
    supporting;
  - `tested` does not name each citation of the ruled entry once;
  - an `inference:` line of the ruled claim has no `inferences` entry;
  - a reject has no `ground`, or another decision has one;
  - the reason does not open with a `Covers: ` line;
  - an accept has no `Cost: ` or `Removes: ` line.

  With `mode`, it also names a concession invalid when no citation of it passes.
  On every plan ledger, with `mode` or without, its last line reads
  `checked: mode plan, N objections, N opinion, N problems`.

A decide-mode ledger carries `mode: decide`. Advocates argue 2 to 4 positions on a question, and the architect rules
which one the evidence supports. The question is a file, `quorum/questions/<slug>-<h7>.md`.
`<h7>` is the first 7 characters of `git hash-object` of the file. `<slug>` comes from the question's first line,
without its `# `: lowercase it; drop backticks, `*`, and `_`; turn each run of other characters outside a-z and 0-9
into one `-`; leave no `-` at either end; cut it to 60 characters, with no `-` left at the end; use `question` when
nothing is left.
The skill names the file, and never overwrites one. An edited question file is a new question, and inherits no earlier
answer. `check` does not enforce the name. The ledger is `quorum/<name>-<hash>.json`, where `<name>` is the question
file's name without `.md` and `<hash>` is `git hash-object` of it; its `plan` field holds the question file's path.
`DECIDE_LEDGER_SCHEMA` holds its shape: `positions`, `cases`, `cross` (the cross-examination points), `ruling`,
`rebuttals`, `final_ruling`, and `human_answer`.

On a decide ledger, `check` holds the decide rules only. It exits 1 on a schema error, and on any of these:

- positions that are not 2 to 4, from `A` in order;
- a case for a position the ledger does not hold, or a second case for one;
- a cross id other than `A1` to `D5`, or one used twice;
- a cross point by a position other than its id's letter, or `is by X, not a position in this ledger`;
- a cross point against its own position, or against one the ledger does not hold;
- a rebuttal from a position the ledger does not hold, from the first ruling's winner, or a second one from a position;
- a ruling of `rule` with no winner, an `escalate` that names one, or a winner the ledger does not hold;
- a final winner that is neither the first ruling's winner nor a position that rebutted;
- `rebuttals and a final ruling follow a first ruling of rule only`;
- `final ruling rules, but no position rebutted`;
- `human_answer: set but nothing escalated`;
- `same_model` that does not match the runners: it is `true` exactly when two positions share a runner;
- `same_model is true, so same_model_reason must say why two positions share a runner`;
- `same_model is false, so same_model_reason must be null`.

A `complete` decide ledger also fails when a position `has no case in a complete ledger`, or when
`ruling is null in a complete ledger`.
Under a first ruling of `rule`, unless the final ruling escalates, it also fails when a position
`lost the ruling and has no rebuttal in a complete ledger`, or a rebuttal `rebuts with no final ruling in a complete ledger`.

Then it checks every citation as for a plan ledger, and names each problem:

- A case with no passing citation is named, `case X: no citation passes`; its position cannot win.
- A `pending` cross point becomes `backed` when a citation passes, or `opinion` when none does:
  `relabeled opinion (was pending): no citation passes`. A `backed` one whose citations stop passing is named:
  `no citation passes; kept backed`.
- A ruling or final ruling is invalid when `the ruling has no passing citation`, when `tested` does not name each
  citation it rules on once, or when an `inference:` line has no `inferences` entry. The first ruling rules on every
  case and every backed cross point, each verdict keyed by `of`; a final ruling of `rule` on every rebuttal.
  A verdict keyed to anything else reads `tested names X, which the ruling does not rule on`.
  A final `escalate` is not held to `tested` or to an `inferences` entry per line, so the skill can write one when the rebuttals fall short.
- Each citation of a ruling's `inferences`, first or final, of any decision, is checked as every citation is, and the
  ruling is invalid when an inference that holds has no passing citation: `inference "<statement>" holds on no passing citation`.
  A first `escalate` is held to both, but no invalid line fails a ledger that escalates, so the skill can write one
  with `tested: []` when the architect's first ruling is invalid twice.
- A `rule`, first or final, is invalid when `the winner's case has no passing citation`.
- A first `rule` is invalid when `a rule rests on no supporting citation of the winner's case`, and a final ruling
  that names another winner when `a flip rests on no supporting citation of the winner's rebuttal`.
  A supporting citation is one that passes now and that `tested` marks `supports: true`: a verdict on a citation
  that stopped passing supports nothing.
- A rebuttal is invalid when `the rebuttal has no passing citation` or `the rebuttal cites nothing new`: every one of
  its passing citations is already in a case, a cross point, or the first ruling. A concession is invalid when
  `the concession has no passing citation`.

When a complete decide ledger has no `human_answer` and no `escalate` ruling, first or final, each invalid line fails
it, and it is not written back. Any `complete` decide ledger fails, unwritten, when
`the governing winner's case has no passing citation`. The governing winner is the final ruling's winner when the final
ruling is `rule`, and the first ruling's otherwise.
Otherwise it writes the ledger back, and its last line reads
`checked: mode decide, N cases, N cross points, N opinion, N problems`.

## Task worktrees

Each task gets its own git worktree, so the main checkout stays clean and on the default branch.
`aidrian worktree new <branch>` creates one and runs config.json `git.worktrees.bootstrap` in it, such as `npm ci`;
`aidrian worktree cleanup` removes the ones whose pull request merged. The `worktree-new` and `worktree-cleanup` skills drive both.
Both commands print JSON for those skills to read, not for a person.
`aidrian worktree cleanup` alone prints the plan; `aidrian worktree cleanup execute` reads the decisions for its `confirm` rows on stdin,
as `{"<worktree path>": "delete", "<other path>": "keep"}`, or `{}` for none.
Empty stdin, other JSON, or a value other than `"delete"` or `"keep"` stops it with nothing removed.
They live in `.worktrees/` at the repository root: editors show them beside the code,
and Claude Code edits them without asking, because they are inside the folder the session opened.
`"git": { "worktrees": { "dir": "<path>" } }` in config.json moves them; a relative path starts at the repository root,
and `aidrian check` requires git to ignore the folder while it is inside the repository.

- The folder takes the last part of the branch name: `feat/login` goes to `.worktrees/login`.
  `--slug <name>` picks another name. When the folder already exists, the command stops and creates nothing.
- A new branch starts at `origin/<default branch>`, or at the local default branch when there is no `origin`; `--base` picks another.
  So `.aidrian/` must be on that branch first: committed, and pushed when there is an `origin`.
  A worktree made earlier has no project folder ([Location](#location)); push, then create a new worktree.
- The command prints its result as one line of JSON, with `status` and `worktree_path`, for the skills that run it.

To keep agents from editing the main checkout at all, turn on the main-checkout guard: [hooks.md](hooks.md#main-checkout).

## Local knowledge sources

This is an advanced option; most projects never need it.

A developer can add knowledge from outside the repository, such as personal notes or a knowledge base several repositories share,
without committing it. List the folders in `.aidrian.local.json` at the project root:

```json
{ "sources": ["~/kb/personal", "../shared-kb"] }
```

`aidrian init` adds the file to `.gitignore`, so it stays on one machine. In a git worktree, the plugin reads it from the main checkout.
The same file can hold one developer's model and effort choices for the plugin's agents, [config.md](config.md#models),
the [names](config.md#names) agents use for that developer and for themselves, the [telemetry](config.md#telemetry) settings,
and the [`decisions`](config.md#decisions) keys `mode`, `domains`, and `unreviewed`, which the team's `maxMode` and pause limits hold down.
`decisions` is read only from the main checkout's copy.

- A leading `~` is the home folder. Any other relative path starts at the folder that holds `.aidrian.local.json`.
- Each source is a folder with the project folder's knowledge layout: `knowledge/<bucket-id>.json`, and optionally a `config.json`
  that holds only `version`.
- A source's index names its doc folder in `dir`, relative to the source, and every doc stays inside that source.
  The sources are the only paths that may be outside the repository.
- The project folder is always the first source; the others follow in the listed order.
  Two sources that define the same bucket id fail, and the error names both index files.

`aidrian check`, the `aidrian-knowledge` commands, and the start hook cover every source.
`aidrian check` prints a count per source, such as `ok: .aidrian (2 buckets, 8 docs), ~/kb/personal (1 bucket, 1 doc)`.
A doc from a local source prints with its absolute path, and `route`, `search`, and `index` add its source as the last column:

```console
$ aidrian-knowledge route testing
docs/knowledge/engineering/working-agreement.md
docs/knowledge/engineering/testing.md
/home/you/kb/personal/notes/testing-habits.md	~/kb/personal
```

## Decision markers

A decision an agent made alone, under [`decisions`](config.md#decisions), stays on record in git, in the indexed knowledge doc that governs it.
It is one HTML comment on a line of its own, directly below the rule's last line, the one place undo looks for that rule.
A table row's marker goes directly below the table, with the row named in the old wording. Under a bullet, the marker is indented to the bullet's text:

```md
Refunds take five days.
<!-- aidrian:decision id=refund-copy status=unconfirmed class=copy domain=ux date=2026-11-04 pr=41 -->
```

- `id` is lowercase letters, digits, and `-`, unique across the docs.
  It takes at most 32 characters, so the longest marker fits on one screen at the default `docs.wrapLimit`.
- `status` is `unconfirmed`, `confirmed`, or `rejected`. An agent writes `unconfirmed`; only the Human moves it, and nothing settles a decision by time.
- `class` is an ordinary class of `lib/decisions.json`, since a floor class never reaches an agent.
- `domain` is `product`, `ux`, `architecture`, or `backlog`.
- `pr` is `none` until the pull request exists; a writer on a branch whose pull request already exists writes the real number.
  The [`pr-write`](../plugins/aidrian/skills/pr-write/SKILL.md) skill writes the number on each marker the branch added with `none`, commits, and pushes.
  That push moves the head, so it comes before the review of the new head, or the report says it did not.

The slice's implementer writes the marker in its commit; else `doc-updater`.
The dispatcher gives the writer the decision, its domain, and the doc that governs it.
`product-manager` and `architect` decide, and neither writes.
[`decisions.md`](../plugins/aidrian/skills/knowledge/references/decisions.md) is the rule they follow.

A decision that replaces a written rule must keep the old wording, in lines directly below its marker, so undo can restore it.
One that fills a gap has no such line:

```md
Refunds take five days.
<!-- aidrian:decision id=refund-copy status=unconfirmed class=copy domain=ux date=2026-11-04 pr=41 -->
<!-- aidrian:decision-old id=refund-copy text="Refunds take ten days.\nAsk support first." -->
```

`text` is a JSON string, so a line break or a quote stays on one line. `-->` would end the comment, so it is written `-\u002d>`.
Wording may span several `decision-old` lines, one piece each, joined with nothing between them.
The [line-length check](hooks.md#markdown-line-length) skips marker and `decision-old` lines, since wrapping one would break it.

`aidrian decisions list` reads the indexed docs of the working copy, so a decision on an unmerged branch lists only on that branch.
Each row is the id, status, class, domain, age, doc and line, pull request, and whether it has old wording.
`--json` adds the date and the wording:

```json
{ "decisions": [{ "id": "", "status": "", "class": "", "domain": "", "date": "", "pr": 41, "line": 2, "hasOldWording": true, "oldWording": "", "doc": "", "ageDays": 0 }],
  "problems": [{ "doc": "", "line": 2, "problem": "" }] }
```

A marker it cannot read, or an id on two markers, is a `problem` and the list goes on, with exit 0.
So is a marker out of place, which still lists: one on a doc's first line, one inside a table,
or one under a blank line, a heading, a code fence, or another decision line.
`hasOldWording` true with `oldWording` null means the old wording cannot be read.
A marker in a code fence or a code span is a quote, not a decision.
A doc from a [local source](#local-knowledge-sources) lists too, but no other machine sees it, so markers belong in committed docs.
`aidrian check` warns about each problem, and still passes.

`aidrian decisions list --added-since <ref>` lists only what the branch committed since it left `<ref>`, read from git at the merge base and at `HEAD`.
A decision counts when no marker at the merge base has its id, whatever its status and however it is indented,
so a moved marker or a changed status does not.
A problem counts when its line is new, so one the branch inherited does not.
A new decision in a Markdown file no index lists is a `problem`: markers belong in an indexed doc.
Its JSON adds `settled`, each inherited marker whose status the branch changed, with `was`, the status at the merge base.
It also adds `pullRequest`, the branch's number from `gh`; `null` means no pull request, or `gh` could not say.
With a number, a new marker still at `pr=none` is a `problem`.
It exits 1 when git cannot compare the two.

`aidrian decisions set <id> confirmed|rejected` rewrites only that marker's `status`, every other byte as it was, and leaves the old wording in place.
It changes the working copy, so run it in a task worktree and commit the change. It refuses an unknown id, an unreadable marker, and an id on two markers.
With [`git.mainCheckout.guard`](hooks.md#main-checkout) on, it refuses a tracked doc in the main checkout, as an edit is refused,
under the same `AIDRIAN_ALLOW_MAIN_WRITE=1` and `allowWrites`.
The [`decisions-set` rule](hooks.md#bash-rules) denies it to a subagent: the main session runs it on the Human's word.

Markers count toward the [knowledge budgets](config.md#knowledge-budgets), as any line of a doc does.

## Migrating

Version 1 is the first version of the folder, so there is nothing to migrate.
