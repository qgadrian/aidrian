# Turn 1: preflight, snapshot, init

Read in the attended first turn. Every step here runs while the Human is still here, so each blocker is named once,
together, with its fix. `aidrian project init` runs last, only once nothing blocks: before it, nothing is written.

## 1. The project

Take `<project>` from the launch, else config.json `tracker.project.values` when it holds exactly one value.
None, or several: ask the Human which project, naming the values, and stop until the answer.

## 2. The checks

Run `aidrian project preflight`. It runs every check a start makes, at once, and starts nothing.
Each line is `ok <name>`, `blocker <name>: <why and fix>`, `note <name>: <what>`, or `ask <name>: <what>`.

| Line | What it checks | The usual fix |
| --- | --- | --- |
| `repository` | origin names a forge repository | set origin to the repository's HTTPS URL |
| `state`, `run` | the state folder; no other run of this project active | as its line says |
| `policy` | the default branch on the forge sets `projectRun.allow` | a pull request that sets it, merged |
| `machine` | this machine allows sessions no Human attends | `"handoff": { "background": "on" }` in its git-ignored local file, or the team sets `solo` |
| `host` | a confined start; an unverified host needs `projectRun.unverifiedHosts`; hooks trusted | as its line says |
| `access` | push rights; an HTTPS origin, since the sandbox refuses SSH; nothing that runs outside the sandbox: other enabled plugins, user hooks, a status line, a credential helper | turn each off in the host's user settings, or the team names it in `projectRun.outsideSandbox` |
| `usage-limit` | the host carries on by itself after a usage limit, which stops this driver too | as its line says: in Claude Code, `"autoContinueAtUsageLimit": true` in the user's settings |
| `tracker` | the base branch's tracker, with a server of it in `projectRun.mcpServers`, the only servers an issue's session loads; no server there named like a tracker that the run rule cannot map | add the tracker's server there, on the default branch |
| `auto-merge` | the default branch allows auto-merge and lists `github.requiredChecks`; this machine's switch is on | a CI workflow and its checks in `github.requiredChecks`, merged before the run |
| `handoff` | the base branch's `session.handoff.continue` is `"background"`, so the driver can hand itself on | set it on the default branch |
| `reviewer`, `reviewer-seen` | `github.reviewer` is set, and the bot reviewed a recent pull request | install the bot and request one review; with no pull request yet, a `note`: the first one proves it, and the merge's trust check holds every merge until then |
| `ci` | the repository has an active CI workflow | merge one before the run |

Answer each `ask` line with the tool it names, or the forge's and tracker's own tools; a `no` is a blocker.
`ask labels` names the tracker's label and status reads: the decision label, and `projectRun.blockedStatus` when set,
must exist in the team.

## 3. The snapshot

Hand the read to one subagent, so its hundreds of issues never enter this session. Give it the project, the run id
(the project's name in lowercase words joined by `-`, then the date, such as `billing-v2-20261118`), the file
`<state>/tmp/<run>.snapshot.json`, where `<state>` is the folder `aidrian state` prints, and these rules:

- Read with the tracker's tools (`knowledge/references/tracker.md`): Linear's `list_issues` with the project and
  `fields` `id`, `gitBranchName`, `statusType`, `priority`, `parentId`, page by page; then each issue's blockers
  through `get_issue` with relations.
- Keep for each issue only `key`, `branch`, `status` (its status type), `blockedBy` (keys), and `priority` (0 to 4).
  A blocker outside the project goes in `outside` as `{ key, status }`. No title, body, or comment.
- A parent whose children are in the project is not run: its children are. A parent with no children there runs.
- Write `{ "issues": [...], "outside": [...] }` to the file, and return only the counts and each blocker it met.

Then run `aidrian project init <run> --file <that file> --check`. It checks the input as init will, writes no run,
and prints `ok snapshot <n> issues`, a `blocker snapshot:` line for each problem, cycle, or issue started outside the
run, and the `next` lines.

## 4. Tell the Human

One message, with every blocker of steps 2 and 3, each with its fix.

- With blockers: ask the Human to fix them and say when. Then run steps 2 and 3 again, and start nothing until both
  are clean.
- With none: run `aidrian project init <run> --file <that file>`, then tell the Human the issue count, how many can
  start now, and that nothing is needed until the report. Start the loop of [loop.md](loop.md) in this same turn:
  the Human may leave. A later preflight names the run, `aidrian project preflight <run>`, so the run it made is no blocker.
