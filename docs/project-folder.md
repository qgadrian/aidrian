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
.aidrian.local.json              adds knowledge sources on one machine (optional, git-ignored)
.worktrees/                      task worktrees, one folder per branch (git-ignored)
.aidrian/
├── config.json                  the folder version and the project settings (committed)
└── knowledge/<bucket-id>.json   one index per knowledge bucket (committed)
```

The committed files are JSON, and the project folder holds nothing else.
The docs a bucket indexes stay where they are: each index names its doc folder in `dir`.

- `config.json` needs `version`; every other key is optional. [config.md](config.md) lists the keys.
- `knowledge/<bucket-id>.json`: the file name is the bucket id. [knowledge.md](knowledge.md) describes the file.
  Buckets load in file-name order, so `10-engineering.json` comes before `20-product.json`.

## Location

The project root is the nearest folder, at or above the current one, that has `.aidrian.json` or `.aidrian/config.json`.
In a git worktree that is the worktree itself, so a branch reads its own committed knowledge.

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
and the commands and hooks read nothing else from the folder.

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
It never overwrites a file. Run again, it prints `nothing to do: .aidrian is set up`.

`aidrian check` validates the whole folder. Run it locally and in CI. It prints `ok`, or one line per problem and exits 1:

- `.aidrian.json`, when present: valid JSON, no key but `dir`, and `dir` inside the project.
- `config.json`: the version first, then every key and value.
- Every knowledge index, as [knowledge.md](knowledge.md#checks) describes.
- `.aidrian.local.json`, when present: every source, as [Local knowledge sources](#local-knowledge-sources) describes.
- `.gitignore`: git ignores `.aidrian.local.json`, and the worktrees and state folders when they are inside the repository.

On success it also prints the state folder:

```console
$ aidrian check
ok: .aidrian (2 buckets, 8 docs)
state: /home/you/.local/state/aidrian/projects/notes-1a2b3c4d
```

In a Claude Code session, `aidrian` is on the PATH while the plugin is enabled.
Elsewhere, run it by its path, such as `path/to/aidrian-harness/plugins/aidrian/bin/aidrian check`. It needs Node 22 or later.

`aidrian lint` keeps the project's AI instructions cheap and portable, with the limits in config.json. Run it beside `aidrian check`:

- `skills`: each `.claude/skills/<name>/SKILL.md` has a one-line YAML `description` within `skills.descriptionChars`,
  and all skill names and descriptions together fit in `skills.listingBytes`. Both hosts list them in every session.
- `agents`: each `.claude/agents/*.md` has `name` equal to its file name, such a `description`, and a known `model` and `effort`.
- `paths`: no tracked file holds a personal home folder such as `/Users/<name>/`; `--staged` checks the staged files only.
- `budget`: the `always` knowledge docs, read at every session start, fit in `docs.alwaysBudgetBytes`. It prints the bytes per bucket.

`aidrian lint skills <folder>` and `aidrian lint agents <folder>` check other folders.

## Local state

The plugin writes plans, session handoff briefs, the lesson inbox, and the dispatch log on each machine.
They live in one state folder per project, outside the repository, so git never sees them:

```text
$XDG_STATE_HOME/aidrian/projects/<project-id>/
├── plans/                local plans
├── handoffs/             session handoff briefs
├── lessons/inbox.jsonl   the lesson inbox
└── dispatch-log.jsonl    the dispatch log
```

- `$XDG_STATE_HOME` defaults to `~/.local/state`.
- `<project-id>` is the repository name and a short hash of its `origin` URL, such as `notes-1a2b3c4d`.
  Every worktree and every clone of the repository shares it.
  A repository with no `origin` uses its folder name and a hash of the main checkout's path.
  A project in a subfolder of the repository adds that subfolder's path to the hash, so two projects in one repository
  get two state folders; a project at the repository root keeps the id above.
- `"state": { "dir": "<path>" }` in config.json moves the folder; [config.md](config.md) lists the key.
  A relative path starts at the repository root, and `aidrian check` then requires git to ignore it.

`aidrian state` prints the folder. Skills use it to find plans and handoff briefs.
`aidrian lesson` adds, lists, and resolves lessons in the inbox; `aidrian handoff` checks a handoff brief against the one it supersedes.
`aidrian report` summarizes the [dispatch log](dispatch-log.md).

## Task worktrees

Each task gets its own git worktree, so the main checkout stays clean and on the default branch.
`aidrian worktree new <branch>` creates one and runs config.json `worktrees.bootstrap` in it, such as `npm ci`;
`aidrian worktree cleanup` removes the ones whose pull request merged. The `worktree-new` and `worktree-cleanup` skills drive both.
They live in `.worktrees/` at the repository root: editors show them beside the code,
and Claude Code edits them without asking, because they are inside the folder the session opened.
`"worktrees": { "dir": "<path>" }` in config.json moves them; a relative path starts at the repository root,
and `aidrian check` requires git to ignore the folder while it is inside the repository.

To keep agents from editing the main checkout at all, turn on the main-checkout guard: [hooks.md](hooks.md#main-checkout).

## Local knowledge sources

This is an advanced option; most projects never need it.

A developer can add knowledge from outside the repository, such as personal notes or a knowledge base several repositories share,
without committing it. List the folders in `.aidrian.local.json` at the project root:

```json
{ "sources": ["~/kb/personal", "../shared-kb"] }
```

`aidrian init` adds the file to `.gitignore`, so it stays on one machine. In a git worktree, the plugin reads it from the main checkout.

- A leading `~` is the home folder. Any other relative path starts at the folder that holds `.aidrian.local.json`.
- Each source is a folder with the project folder's knowledge layout: `knowledge/<bucket-id>.json`, and optionally a `config.json`
  that holds only `version`.
- A source's index names its doc folder in `dir`, relative to the source, and every doc stays inside that source.
  The sources are the only paths that may be outside the repository.
- The project folder is always the first source; the others follow in the listed order.
  Two sources that define the same bucket id fail, and the error names both index files.

`aidrian check`, the `aidrian-knowledge` commands, and the start hook cover every source.
`aidrian check` prints a count per source, such as `ok: .aidrian (2 buckets, 8 docs), ~/kb/personal (1 buckets, 1 docs)`.
A doc from a local source prints with its absolute path, and `route`, `search`, and `index` add its source as the last column:

```console
$ aidrian-knowledge route testing
docs/knowledge/engineering/working-agreement.md
docs/knowledge/engineering/testing.md
/home/you/kb/personal/notes/testing-habits.md	~/kb/personal
```

## Migrating

Version 1 is the first version of the folder, so there is nothing to migrate.
