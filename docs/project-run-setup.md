# Project run setup

The one-time steps the Human takes before a project run, the one-shot project autopilot
(`aidrian project init`, `start`, `preflight`, `resume`, and `end`), can work through a tracker project alone.
Each step is done once: per machine, per repository, or per team, as the table says, and kept after each release.

`aidrian project preflight`, run in the run's first, attended turn, names each missing step at once.
Every `blocker` line ends with `(setup: <repository>/blob/main/docs/project-run-setup.md#<section>)`, the section below
that clears it, where `<repository>` is the plugin's repository as its manifest names it, so a project's checkout,
which has no copy of this doc, still reaches it; the `ask labels` line ends so too. Fix each blocker, then run the
preflight again; nothing starts until it prints none.
The keys are in [Project run](config.md#project-run); how a start confines its session is
[Project start](providers/claude-code.md#project-start) on Claude Code and [on Codex](providers/codex.md#project-start).

| Step | Once per | Host | Preflight line |
| --- | --- | --- | --- |
| [Origin over HTTPS](#origin-over-https) | repository checkout | Claude Code | `repository`, `access` |
| [Driver permission mode](#driver-permission-mode) | driver session | Claude Code | none: the start refuses |
| [Trust the runs folder](#trust-the-runs-folder) | machine and project | Claude Code | `trust` |
| [Forge token in the keychain](#forge-token-in-the-keychain) | machine and project | Claude Code | `access`, `note token` |
| [The decision label](#the-decision-label) | tracker team | both | `ask labels` |
| [Local binding](#local-binding) | team | both | `note local-binding` |
| [Keep the user-scope plugin current](#keep-the-user-scope-plugin-current) | machine, after each release | Claude Code | `access` when it is not installed |
| [Team config](#team-config) | team | both | `policy`, `tracker`, `handoff` |
| [Host start](#host-start) | team, and on Codex each install | both | `host` |
| [Auto-merge and CI](#auto-merge-and-ci) | team and machine | both | `auto-merge`, `ci` |
| [Review bot](#review-bot) | repository | both | `reviewer`, `reviewer-seen` |
| [Forge rules](#forge-rules) | repository | both | `branch-protection`, `release-tags`, `workflow-secrets` |
| [This machine](#this-machine) | machine and project | both | `machine` |
| [Host settings](#host-settings) | machine | both | `access`, `usage-limit` |
| [State folder](#state-folder) | machine and project | both | `state`, `instructions` |
| [After a halt or a stop](#after-a-halt-or-a-stop) | each run | both | `run` |

Claude Code is the host most steps name: its issue sessions run in its sandbox, with its trust record and the
user's settings. Neither host's project start is verified by a live run yet ([Host start](#host-start)).

## Origin over HTTPS

The attempt's clone pushes to origin's URL as the main checkout has it. Claude Code's sandbox hides `~/.ssh` and
refuses SSH, so an SSH URL halts every start, and the preflight names it as `blocker access`:

```sh
git remote set-url origin https://github.com/<owner>/<name>.git
git config --show-origin --show-scope --get-regexp 'insteadof$'
```

The second command lists every `url.<base>.insteadOf` rule of every scope, one line each: its scope, `file:` and the
file that defines it, the key, and the value, the URL prefix it rewrites. Remove each one that rewrites the HTTPS URL to
SSH by that exact key and value, from that file (a `system` file may need an administrator); `--fixed-value`, git 2.30
or later, matches the value as it is written rather than as a pattern, so no other rule of the key goes with it:

```sh
git config --file '<file>' --fixed-value --unset '<key>' '<exact value>'
```

Git applies the rule to the URL it reports, so the clone would still push over SSH. A `pushInsteadOf` rule that changes
the push URL, or a second `remote.origin.pushurl` (`git remote get-url --push --all origin` lists them), halts the
start too.

Git's `store` credential helper keeps the token in `~/.git-credentials`, which the sandbox hides, and the access check
reads every credential helper of every scope, so a `store` entry blocks the start wherever it is. `gh auth setup-git`
adds gh's own helper and leaves an existing `store` entry in place, so after it, list the helpers, then remove each
`store` one, such as `store` or `store --file <path>`, by its exact key and value, from the file its line names:

```sh
gh auth setup-git
git config --show-origin --show-scope --get-regexp '^credential\..*helper$'
git config --file '<file>' --fixed-value --unset '<key>' '<exact value>'
```

The key is `credential.helper`, or for a helper of one URL, such as `credential.https://github.com.helper`, that key.
`blocker repository` means origin names no repository a forge serves at all.

## Driver permission mode

The issue sessions start in the driver session's permission mode, which the start reads from the driver's transcript.
A driver in `bypassPermissions`, or one whose mode cannot be read, starts nothing: `the driver session runs with
permission checks bypassed, and a session no Human attends never starts that way`. Start the driver session in another
mode, `acceptEdits`, `auto`, `dontAsk`, `manual`, or `plan`. A start also halts, before the host starts anything, when
the host would refuse the issue session's push in that mode ([the push preflight](handoff.md#the-push-preflight)).
No preflight line reads the mode: the first `aidrian project start` is where it shows.

## Trust the runs folder

On Claude Code, a start in a folder the host has not trusted exits `Workspace not trusted` and starts nothing. Inside a
git repository the host looks trust up at the repository's own root alone, so an attempt's clone, a repository of its
own, never inherits a folder's trust. Each start records the clone's trust in the host's record, `.claude.json` in
`CLAUDE_CONFIG_DIR` or the home folder, from the runs folder's trust at that moment
(`lib/hosts/claude-code-trust.mjs`). So the Human trusts the runs folder once, `<state>/runs`, where `<state>` is
the folder `aidrian state` prints:

```sh
mkdir -p '<state>/runs'
cd '<state>/runs' && claude
```

Accept the trust question, then quit. A trusted folder above the runs folder counts too; an entry for one run's folder
below it never does. The preflight reads the record and prints `blocker trust` with the exact path; a record it cannot
read is a `note`, since the file is the host's own.

## Forge token in the keychain

Claude Code's sandbox hides the system keyring, where gh keeps its login, so the start reads a forge token outside it
and the session's SessionStart hook hands it to the sandboxed commands as `GH_TOKEN` (`lib/project-token.mjs`).
The first of three sources that gives a token is used:

1. The project's keychain entry, on macOS: the entry `.aidrian.local.json` names in `projectRun.forgeTokenKeychain`.
2. The machine's default keychain entry, on macOS, for a github.com run alone: service `aidrian-project-run`, any
   account, shared by every project on the machine.
3. The forge CLI's own login, `gh auth token --hostname <host>`.

The token must belong to the account the preflight checked the forge's rules for. The preflight checks branch
protection, the tag rules, and environment reviewers as gh's login of that moment, so the rules it reads say nothing
of a token of another account, which may bypass them. Each start asks the forge whose token it is, `gh api user` with
the token alone, and halts when that account is not the one the preflight checked for, or when the forge names none,
as for an app's installation token. A preflight that prints no blocker records its account in
`<state>/runs/checked-account.json`, which no issue session may write, and a start compares the token with that record,
never with gh's login at the start. So signing gh in as another account after the preflight changes nothing a start
does. The remedy is to run `aidrian project preflight` again with gh signed in as the account the token belongs to,
or to give the source a token of the account the preflight checked for.

An entry that is not there passes to the next source. A token that is there but may not push, or that belongs to
another account, does not: the start halts. Push rights are checked twice: the forge must let the signed-in user push
to the repository, and the token itself must pass a receive-pack probe, a request for
`https://<host>/<owner>/<name>.git/info/refs?service=git-receive-pack` with the token, which GitHub answers 200 with a
receive-pack advertisement only for a token that may write the contents, and which writes nothing
(`lib/forges/github-token.mjs`). The preflight prints `note token:` with the source it used, and a second note for a
gh login or a classic token, which reach every repository the user can.

A fine-grained token limited to the run's repository narrows that. On GitHub, Settings, Developer settings,
Fine-grained tokens, Generate new token:

- **Resource owner**: the repository's owner. An organization may require approval; until then the token reads only
  public resources, and the probe fails.
- **Repository access**: Only select repositories, and pick the run's repository when the token is created. A token
  that does not name the repository fails the probe.
- **Permissions**: Contents read and write (push, merge), Pull requests read and write (open one, comment, answer
  review threads, update its branch), Actions read and write (read runs, rerun failed jobs), Checks read, and Commit
  statuses read; Metadata read comes with them. Leave Workflows off, so the token cannot push a change to a workflow
  file. This list follows the calls an issue session makes through `lib/forges/github.mjs`; no live run has checked
  a token with exactly these permissions.
- **Expiration**: a token that expires fails the probe, and the preflight names it as `blocker access`.

Store it with macOS's `security`, `-w` last so it asks for the token instead of taking it on the command line:

```sh
security add-generic-password -s '<service>' -a '<account>' -w
```

Pick any service and account names, such as the repository's name and the user's login, and add `-U` to replace an
entry that exists. An entry `security` itself made is read again by `security` with no keychain prompt, which matters:
each read has 1.5 seconds, and the session's SessionStart hook reads it again with no Human there. Then name it in the
main checkout's git-ignored `.aidrian.local.json`:

```json
{
  "projectRun": { "forgeTokenKeychain": { "service": "<service>", "account": "<account>" } }
}
```

`projectRun` there takes this one key, and the entry exactly a `service` and an `account`; any other shape is a config
error and reads unset. It is read only while git tracks no `.aidrian.local.json`, and only the main session may write
it. For one token every github.com project on the machine shares, store it under the default service instead, with no
local key: `security add-generic-password -s aidrian-project-run -a '<account>' -w`.
On another platform the keychain key is a `note`, and the gh login gives the token.

## The decision label

A parked issue gets the tracker label `projectRun.decisionLabel`, `needs-decision` by default, in the driver's
report. Create that label in the tracker team once, and the status `projectRun.blockedStatus` names when it is set.
The preflight cannot read the tracker itself, so it prints `ask labels:`, which the driver answers with the tracker's
own label read; a missing label is a blocker.

## Local binding

`projectRun.localBinding`, default `false`, lets an issue's session bind local ports, for the database, API server,
worker, or browser its checks need. The team sets it in `config.json` on the default branch, and the forge and the
local ref must both say it; no working copy or local file turns it on, and no recipe sets it. On Claude Code the
sandbox then starts with `allowLocalBinding: true`, which on macOS opens binding and inbound connections on every
interface of the machine and lets the session reach every service on its loopback; on Linux it changes nothing.
On Codex it turns the network proxy's local binding on. While it is on, the preflight prints `note local-binding`
with the host's risk. Bind each test server to `127.0.0.1`, never `0.0.0.0` ([Project run](config.md#project-run)).

## Keep the user-scope plugin current

The issue session starts with `--setting-sources user`, so it loads only the plugin the user's settings enable: a
user-scope install, or `"enabledPlugins": { "aidrian@<marketplace>": true }` in `~/.claude/settings.json`. A
project-scope install never loads there, and the start waits for a hook that never runs. Install it at user scope
once:

```sh
claude plugin install aidrian@aidrian-harness --scope user
```

Each scope keeps its own installed version, so after each release update the user scope as well as the project scope:

```sh
claude plugin marketplace update aidrian-harness
claude plugin update aidrian@aidrian-harness --scope user
claude plugin update aidrian@aidrian-harness --scope project
```

The preflight blocks a plugin not enabled at user scope (`blocker access`); no line compares the two versions, so an
issue session on an older user-scope install runs that version's hooks.

## Team config

The team's `.aidrian/config.json`, merged to the default branch, which the preflight reads from the forge and from the
local ref:

- `projectRun.allow: true` (`blocker policy`). A working copy cannot turn runs on; the base branch must also commit
  the config file.
- `tracker.provider`, a tracker the plugin knows (`blocker tracker`). A server in `projectRun.mcpServers` named like a
  tracker must point at that tracker's own endpoint; with no tracker server there, issue sessions read their issue
  from a file and the driver writes the tracker.
- `session.handoff.continue: "background"` (`blocker handoff`), so the driver hands itself on when its session grows
  long; `"clear"` needs a person to start the next session.

The [Full autonomy, solo](config-recipes.md#full-autonomy-solo) recipe sets most of these.

## Host start

Neither host's project start is verified by a live run, so a run starts sessions only where the default branch, on the
forge and by its local ref, sets `projectRun.unverifiedHosts: true` (`blocker host`); read
[its risk](providers/claude-code.md#project-start) first. On Codex, also trust every hook of this plugin in Codex's hooks
panel after each install and update: every hold of a session no Human attends is a hook.

## Auto-merge and CI

An issue's pull request merges with no one there only when (`blocker auto-merge`):

- the default branch on the forge sets `github.autoMerge.allow`;
- this machine turns auto-merge on, `"github": { "autoMerge": "on" }` in its `.aidrian.local.json`, or the team sets
  `github.autoMerge.default` to `"on"`;
- the default branch lists `github.requiredChecks`, since a merge with none waits on no CI.

The repository needs an active CI workflow that runs on pull requests (`blocker ci`).

## Review bot

The default branch sets `github.reviewer`, the bot every unattended merge waits on (`blocker reviewer`). Install it on
the repository and request one review: `blocker reviewer-seen` means it reviewed none of the recent pull requests,
and with no pull request yet a `note` says the first one proves it.

## Forge rules

An issue's session gets the forge token the start read ([Forge token in the keychain](#forge-token-in-the-keychain)),
which may be a keychain entry's rather than gh's own login, but always one of the account the passed preflight checked
these rules for: the start halts on a token of any other. So the forge must hold what a script the session runs could
do with its token:

- `branch-protection`: a rule on the default branch that asks for a pull request, includes administrators, and lets
  that user bypass nothing.
- `release-tags`: an active tag ruleset over every tag (`~ALL` or `refs/tags/**/*`, excluding none; `refs/tags/*`
  stops at a slash) that restricts creating and updating one, with no bypass for that user.
- `workflow-secrets`: no CI secret the repository's workflows see on a pushed branch: keep release and deploy secrets
  in environments held for a reviewer who prevents self-review, or who is not the signed-in user, when that user is not
  an admin of the repository.

A forge whose plan offers no such rule, as GitHub's free plan for a private repository, names the plan in both
protection lines. The team may instead accept each risk on the default branch, `projectRun.forgeProtectionAccepted`
for the two rules and `projectRun.workflowSecretsAccepted` for the secrets; no recipe sets either
([Project run](config.md#project-run)).

## This machine

The machine must allow sessions no Human attends: `"handoff": { "background": "on" }` in the main checkout's
git-ignored `.aidrian.local.json`, or the team sets `solo` (`blocker machine`). A local file git tracks, or one with
an error, reads every switch off. One file can hold this, the auto-merge switch, and the keychain entry:

```json
{
  "handoff": { "background": "on" },
  "github": { "autoMerge": "on" },
  "projectRun": { "forgeTokenKeychain": { "service": "<service>", "account": "<account>" } }
}
```

## Host settings

`blocker access` names what would let an issue's session run outside its sandbox, or keep it from pushing. On Claude
Code, in the user's settings, `~/.claude/settings.json` or the `CLAUDE_CONFIG_DIR` one:

- this plugin enabled at user scope ([Keep the user-scope plugin current](#keep-the-user-scope-plugin-current));
- no other enabled plugin, no `hooks`, `statusLine`, `apiKeyHelper`, or other key that runs a command, and no skill,
  agent, or command of `~/.claude/` whose frontmatter declares hooks or MCP servers, unless the team names it in
  `projectRun.outsideSandbox`;
- no `sandbox` key that widens the sandbox, which no `outsideSandbox` name lifts;
- an HTTPS origin and no `store` credential helper ([Origin over HTTPS](#origin-over-https));
- on Linux, `bwrap` and `socat` on PATH.

On Codex, the line names the sandbox's network, its proxy, or a writable root the gate guards.
A token that no source gives, or that may not push, points at [Forge token in the keychain](#forge-token-in-the-keychain).

A usage limit is the account's, so it stops the driver too: on Claude Code, set `"autoContinueAtUsageLimit": true` in
the user's own settings (`blocker usage-limit`); the host ignores this key in a project's settings.

## State folder

The run lives in `<state>/runs/<run>/`, under the folder `aidrian state` prints, which lies outside every checkout
(`blocker state`). The base branch must commit the project's `config.json`, and `state.dir` there must name the
folder this command resolves. Every attempt's clone lies under the runs folder, so a host instruction file, such as a
`CLAUDE.md` or an `AGENTS.md`, in a folder above it that is not the host's own user folder blocks every start
(`blocker instructions`): move it away, or set `state.dir` to a folder with none above it.

## After a halt or a stop

A **halt** stops every start of the run until a person lifts it: a start whose proof failed, as a session whose hooks
never ran or whose sandbox proof failed, and a usage limit past the run's 24 pauses. `aidrian project next` prints
`halted <cause>` first. Fix the cause, then run, from the Human's own shell, outside the driver:

```sh
aidrian project resume <run>
```

From a shell it lifts the halt only, and the driver goes on. The driver never runs it; another session a person
attends that never drove the run may, and only such a session also takes custody of a run whose driver the host lists
as ended.

A **stop** is an issue the run parked: a decision it waits on, a pull request that did not merge, a blocked result, or
its attempts used up.
A parked issue is final in its run: only open issues start, no command reopens one, and every issue that waits on it is
skipped. To run it again, once the decision is made:

1. End the run: `aidrian project end <run>`, which only the run's driver records, by custody, once no issue runs and no
   session runs on. A shell names no session, so it cannot. The driver records the end at the end of its loop; when the
   driver ended first, an attended session takes custody with `aidrian project resume <run>`, then runs the end.
2. Init a fresh run over the same tracker project. Until the old run ends, the preflight prints `blocker run`: a
   project has one active run at a time.

A first attempt cuts its issue's branch fresh from the base tip, so in the new run a parked issue whose branch is still
on the forge refuses to start: close its pull request and delete the branch, or give the issue another branch in the
snapshot.
