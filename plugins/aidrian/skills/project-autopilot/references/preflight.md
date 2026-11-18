# Turn 1: preflight and init

Read in the attended first turn. Every step here runs while the Human is still here, so each blocker is named once,
together, with its fix. Nothing starts until every one is cleared.

## 1. The project

Take `<project>` from the launch, else config.json `tracker.project.values` when it holds exactly one value.
None, or several: ask the Human which project, naming the values, and stop until the answer.

## 2. The checks

1. Run `aidrian project preflight`. It runs every check a start makes, at once, and starts nothing:

   | Line | What it checks | The usual fix |
   | --- | --- | --- |
   | `repository` | origin names a forge repository | set origin to the repository's HTTPS URL |
   | `state` | the state folder the base branch names | as its line says |
   | `run` | no other run of this project is active | finish or end that run first |
   | `policy` | the default branch on the forge sets `projectRun.allow` | a pull request that sets it, merged |
   | `machine` | this machine allows sessions no Human attends | `"handoff": { "background": "on" }` in `.aidrian.local.json`, or the team sets `solo` |
   | `host` | this host starts confined sessions; an unverified one needs `projectRun.unverifiedHosts`; hooks trusted | as its line says |
   | `access` | push rights; an HTTPS origin, since the sandbox refuses SSH; nothing that runs outside the sandbox: other enabled plugins, user hooks, a status line, a credential helper | turn each off in the host's user settings, or the team names it in `projectRun.outsideSandbox` |
   | `usage-limit` | the host carries on by itself after a usage limit, which is the account's, so it stops this driver with the issues' sessions | as its line says: in Claude Code, `"autoContinueAtUsageLimit": true` in the user's settings |
   | `reviewer` | the base branch sets `github.reviewer` | set the bot's login |

2. Answer its two `ask` lines yourself, with the forge's tools:
   - `reviewer-seen`: the reviewer bot reviewed one of the last 20 pull requests
     (`gh pr list --state all --limit 20 --json number,reviews`; match its login with or without `[bot]`).
     Not seen: a blocker, since only review stands between an issue's session and a merge.
   - `ci`: the default branch runs a workflow on pull requests (`gh workflow list`, then its `on:` keys). None: a blocker,
     unless the first issue the run starts creates CI; say which issue.
   - `usage-limit`, on a host with no `usage-limit` line above: the host's own setting that continues a session after a
     usage limit. Not set, or not known: a blocker, since after a limit nothing would wake the driver.

## 3. The snapshot and init

1. Read the project's issues with the tracker's tools (`knowledge/references/tracker.md`), every page, each with its
   relations. Keep for each only: `key`, `branch` (Linear's `gitBranchName`), `status` as its status type (`triage`,
   `backlog`, `unstarted`, `started`, `completed`, `canceled`), `blockedBy` (keys), and `priority` (0 to 4).
   A blocker outside the project goes in `outside` as `{ key, status }`. No title, body, or comment: the run keeps none.
2. Pick the run id: the project's name in lowercase words joined by `-`, then the date, such as `billing-v2-20261118`.
3. Write `{ "issues": [...], "outside": [...] }` to `<state>/tmp/<run>.snapshot.json`, where `<state>` is the folder
   `aidrian state` prints, and run `aidrian project init <run> --file <that file>`. On exit 1, fix what it lists and run it again.
4. Run `aidrian project next <run>`. A `blocked` line with `cycle` or `status` is a blocker too: a cycle never starts,
   and an issue started outside the run waits on its owner.

## 4. Tell the Human

One message, with every blocker of steps 2 and 3, each with its fix, then:

- With blockers: ask the Human to fix them and say when. Then run step 2 again, and start nothing until it is clean.
- With none: the issue count, how many can start now, and that nothing is needed until the report. Then start the
  loop of [loop.md](loop.md) in this same turn: the Human may leave.
