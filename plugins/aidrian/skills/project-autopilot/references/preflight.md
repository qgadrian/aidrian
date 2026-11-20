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
| `instructions` | no host instruction file, such as a `CLAUDE.md`, in a folder above the runs folder, which every attempt's clone would load | move it away, or set `state.dir` to a folder with none above it |
| `policy` | the default branch on the forge sets `projectRun.allow` | a pull request that sets it, merged |
| `machine` | this machine allows sessions no Human attends | `"handoff": { "background": "on" }` in its git-ignored local file, or the team sets `solo` |
| `host` | a confined start; an unverified host needs `projectRun.unverifiedHosts`; hooks trusted | as its line says |
| `access` | push rights; an HTTPS origin, since the sandbox refuses SSH; nothing that runs outside the sandbox: other enabled plugins, user hooks, a status line, a credential helper | turn each off in the host's user settings, or the team names it in `projectRun.outsideSandbox` |
| `usage-limit` | the host carries on by itself after a usage limit, which stops this driver too | as its line says: in Claude Code, `"autoContinueAtUsageLimit": true` in the user's settings |
| `tracker` | the base branch's tracker, and no server in `projectRun.mcpServers` named like a tracker that the run rule cannot map; with no tracker server there, a `note`: issue sessions read their issue from a file and write no tracker, and the driver reports | point the server at the tracker's own endpoint, or remove it |
| `auto-merge` | the default branch allows auto-merge and lists `github.requiredChecks`; this machine's switch is on | a CI workflow and its checks in `github.requiredChecks`, merged before the run |
| `handoff` | the base branch's `session.handoff.continue` is `"background"`, so the driver can hand itself on; `"clear"` needs a person, so it blocks | set it on the default branch |
| `reviewer`, `reviewer-seen` | `github.reviewer` is set, and the bot reviewed a recent pull request | install the bot and request one review; with no pull request yet, a `note`: the first one proves it, and the merge's trust check holds every merge until then |
| `ci` | the repository has an active CI workflow | merge one before the run |
| `branch-protection` | a rule on the default branch asks the signed-in user, whose token an issue's session keeps, for a pull request, administrator or not, and lets that user bypass nothing | a ruleset that asks for a pull request with no bypass for that user, or branch protection that includes administrators; an `ask` when only an administrator can read the protection; or the team sets `projectRun.forgeProtectionAccepted` |
| `release-tags` | an active tag rule names every tag (`~ALL` or `refs/tags/**/*`, excluding none; `refs/tags/*` stops at a slash), restricts creating and updating one, and that user can never bypass it | such a tag ruleset, with no bypass for that user; or the team sets `projectRun.forgeProtectionAccepted` |
| `workflow-secrets` | no CI secret of the repository, its organization, or an open environment: one with no reviewer rule that prevents self-review or names only other users, or one whose admins may bypass its reviewers when the signed-in user is an admin; one limited to protected branches or branch patterns counts, since a deployment branch rule is no hold against code the run pushes; the token's `workflow` scope only narrows it, since the workflows run the branch's own code | the secrets in environments held for a reviewer who is not the signed-in user, with admin bypass off for an admin; or the team sets `projectRun.workflowSecretsAccepted`, which accepts all current and future workflow secret exposure for project runs, repository, organization, and environment secrets alike, only when that is acceptable; `projectRun.forgeProtectionAccepted` waives no secret |

Answer each `ask` line with the tool it names, or the forge's and tracker's own tools; a `no` is a blocker.
When the forge's plan offers no branch or tag rule, as for a private repository on a free plan, both protection blockers
name the plan and its remedies. Setting `projectRun.forgeProtectionAccepted` is the team's decision on the default branch,
never this session's: it turns both lines into a `note` that a script an issue session runs can push to the default branch
or a tag, held by the hooks alone.
A `note mcp-servers` line names servers the run rule maps to no tracker: each must be no tracker connection.
A `note workflows` line says the forge runs a pushed branch's workflow files, and the code they call, with the repository's
secrets: keep release and deploy secrets in environments held for a reviewer who is not the signed-in user, since
the preflight counts a branch-limited environment as open, and trust a cloud role
through OIDC only for a protected branch or such an environment, never `repo:<owner>/<name>:*`. A `note triggers` line names other services,
such as preview deploys and ChatOps bots, that act on an issue's push or comment.
`ask labels` names the tracker's label and status reads: the decision label, and `projectRun.blockedStatus` when set,
must exist in the team.

## 3. The snapshot

Hand the read to one subagent, so its hundreds of issues never enter this session: one that can write files and call
the tracker's tools. Give it the project, the run id (the project's name in lowercase words joined by `-`, then the
date, such as `billing-v2-20261118`), the file `<state>/tmp/<run>.snapshot.json`, where `<state>` is the folder
`aidrian state` prints, and these rules:

- Read with the tracker's tools (`knowledge/references/tracker.md`): Linear's `list_issues` with the project and
  `fields` `id`, `title`, `description`, `labels`, `gitBranchName`, `statusType`, `priority`, `parentId`, page by page;
  then each issue's blockers through `get_issue` with relations.
- Read the tracker's team list, Linear's `list_teams` page by page, and keep every team's key, of the whole workspace
  and not only the project's, as `teams`: a pull request may close only its own issue, and the closing-word check sees
  a key only of a team it knows. A tracker whose keys are numbers alone, such as GitHub Issues, has no teams: leave
  `teams` out.
- The snapshot keeps for each issue only `key`, `branch`, `status` (its status type), `blockedBy` (keys), and
  `priority` (0 to 4); a blocker outside the project goes in `outside` as `{ key, status }`. Write
  `{ "issues": [...], "outside": [...], "teams": [...] }` to the snapshot file.
- Each issue's text comes from the tracker's own answers to these reads: the run records every issue an issue read
  (`get_issue`, `list_issues`) answers, by its key, and init keeps that text for the issue's session to read instead
  of the tracker. Write no text into any file: a text a session writes is never taken. No comment.
- A parent whose children are in the project is not run: its children are. A parent with no children there runs.
- Return only the counts and each blocker it met.

Then run `aidrian project init <run> --file <snapshot file> --check`. It checks the input as init will, writes no run,
and prints `ok snapshot <n> issues, <m> with text`, a `blocker snapshot:` line for each problem, cycle, or issue
started outside the run, a `blocker texts:` line for each issue whose text no read recorded when
`projectRun.mcpServers` holds no tracker server its session could read it through, the `next` lines for turn 1, as
many as `projectRun.maxParallel` starts at once, and a
`note teams` line when the snapshot names no `teams`: read the team list again and add them before init.

## 4. Tell the Human

One message, with every blocker of steps 2 and 3, each with its fix.

- With blockers: ask the Human to fix them and say when. Then run steps 2 and 3 again, and start nothing until both
  are clean.
- With none: run `aidrian project init <run> --file <snapshot file>`, then tell the Human the issue count, how many can
  start now, and that nothing is needed until the report. Start the loop of [loop.md](loop.md) in this same turn:
  the Human may leave. A later preflight names the run, `aidrian project preflight <run>`, so the run it made is no blocker.
