# Adding a host, a tracker, or a forge

The adapter covers the differences behind the hook contract: how a host names its tools, what its payload holds, and who it says is calling.
It does not get the plugin into a host: how a host's hooks are delivered, installed, and put on its PATH is separate work, which depends on the host.
So a host that reads `hooks.json` as it is, as Claude Code and Codex do, is close to one adapter file.
A host that does not needs that delivery built first, and neither host here has needed it, so none of it is proven.

Shared code calls `lib/hosts/index.mjs`, `lib/trackers/index.mjs`, and `lib/forges/index.mjs`, and never reads a host's variables or names a host's own tools.
`test/adapters.test.mjs` iterates the host and tracker registries, so an adapter added to one is checked by that alone,
and `test/host-coupling.test.mjs` fails when shared code reads a host variable or branches on a host's tool or name.
For forges, `test/forge-github.test.mjs` holds the facade's method names and the gh command behind each,
and `test/forge-coupling.test.mjs` fails when shared code reaches a forge other than through `lib/forges/index.mjs`.

## Adding a host

### Delivery comes first

The adapter's required `delivery` field names which of these three the host is:

| `delivery` | The host | What it takes |
| --- | --- | --- |
| `hooks-json` | Reads `hooks/hooks.json` as it is, as Claude Code and Codex do | Its raw names fire each matcher, or it adds them to the matchers; the conformance suite holds that |
| `installer` | Runs command hooks from a config of its own, as Kimi Code is reported to | An installer that writes that config from `hooks.json`, as `codex/install-agents.mjs` writes roles |
| `bridge` | Runs hooks in process, as OpenCode is reported to | A bridge plugin that maps each call, runs the matching `scripts/hook-*.mjs`, and turns exit 2 into a throw |

OpenCode and Kimi Code are examples of the shape, as a review of this page reported them. Check each against the host before relying on it:
neither was run here, neither is supported, and their cases have no code yet.

### Files

| File | What it holds |
| --- | --- |
| `plugins/aidrian/lib/hosts/<id>.mjs` | The adapter, with the fields below |
| `plugins/aidrian/lib/hosts/index.mjs` | The adapter in `HOSTS`; order is detection order, the host a shell can start inside another first |
| `plugins/aidrian/hooks/hooks.json` | The host's raw names, where they miss a matcher. Matchers run on the raw name, before any mapping reaches a hook |
| `test/fixtures/hosts/<id>/tracker.json` | Recorded payloads, with `live` and `provenance` saying where they came from |
| `plugins/aidrian/providers/<id>.json` and a `GENERATORS` entry in `scripts/build.mjs` | The agents: [Adding a provider](../agent-sources.md#adding-a-provider) |
| A plugin manifest and marketplace file, and their entry in `scripts/version.mjs` | How the host installs the plugin, and the version it reads |
| An installer, when the host needs one | Whatever the plugin's install format leaves out, such as agents or hooks |
| The way `aidrian` gets on its PATH | The host's own, or the step its docs give, as [Running aidrian](codex.md#running-aidrian) does |
| `test/hosts.test.mjs` | A check against the real command, as each host has, with no model run |
| `lib/agent-models.mjs` | How `models.<key>` reaches a dispatched agent on this host: a call it rewrites, or a role it installs |
| `plugins/aidrian/lib/trackers/<tracker>.mjs` | An entry in each tracker's `servers` for this host, read from a live connection. The conformance suite fails without one |
| `docs/providers/<id>.md` and its index entry | How it installs, and what was verified on it |

### The adapter's fields

| Field | What it says |
| --- | --- |
| `id`, `name`, `ai` | Its id in the registries, what attribution records, and what the names line calls the AI |
| `delivery` | Which delivery case above it is |
| `detect({ env, input })` | Whether this process runs under it. It is false on an empty environment and a plain payload |
| `identityVars`, `detectVars` | The variables a reviewer and a test run without, and those a test run also drops |
| `sessionId(env)`, `agentName(env)`, `effort(env)`, `runEnv(env)` | What its environment says, null where it says nothing |
| `pluginAgentPrefix`, `agentAliases(type)` | How it names this plugin's agents, and the short names a type answers to |
| `toolName(name)` | A tool's name in the standard `mcp__<server>__<tool>`. A standard name stays as it is |
| `rawToolName(standard)` | What a standard tool reaches a hook's matcher as, before any mapping |
| `nativeToolName(standard)` | What its model calls that tool, for a refusal to name |
| `serverSpelling(server)` | How it spells a server's name, such as a hyphen as an underscore |
| `githubTools` | Optional: a GitHub connector's merge, comment, and ready tools by standard name, each with `as`, the GitHub MCP server's tool it stands for, `repo`, its `owner/name` input, `fields`, and `fixed`, the inputs the tool implies without taking them, such as `draft: false`. `hooks.json` lists each by its raw name |
| `toolResponse(response)` | The objects a tool's response holds, the most direct first |
| `hookInput(input)` | The hook payload in the standard field names, with `raw_tool_name` holding what it sent when that differs. A standard payload stays as it is. A call of a tool the host runs under another tool's permission rules may carry `permission_tool_name`, that tool's standard name, which a bare deny of it then covers (`deniedNames` in `lib/hosts/index.mjs`) |
| `opaqueShellTools` | Optional: its tools that run `tool_input.command` in a shell the shared lexer cannot read, such as PowerShell. They keep their own name, so no `Bash(<prefix>)` pattern admits them, and the guards read the command as opaque text, failing closed for a subagent (`opaqueShellCommand` in `lib/hosts/index.mjs`). Every `Bash` and `Bash(<prefix>)` deny covers them (`deniedNames`) |
| `sessionStart` | Optional: `{ programs, starts(args) }`, the host's own command that starts or resumes a session. `programs` are the command's names; `starts` takes the lexer's argument tokens after the name, each `{ text, dynamic }`, and says whether that command line starts or resumes one, failing closed on a word it does not know. The agent gates hook refuses such a command to a subagent and to a session the background handoff route started, for every host's command whatever host runs the session (`hostSessionStartDenial` in `lib/handoff-guard.mjs`) |
| `fileEditTools`, `fileEdit(tool, input)` | Its file edit tools, and each call in a shape `fileEditOf` in `lib/hosts/index.mjs` lists |
| `projectFolders` | Where a project keeps its skills and agents for it, if the plugin's lint can read them |
| `protectedPaths` | The host files of a checkout, from its root, that a later session there loads, such as its settings, skills, agents, hooks, and MCP servers. A name ending `.json` is a file, any other a folder. The agent gate hook refuses their writes, in the session's own worktree and its attempt's clone, to a session no Human attends, whichever host it runs on (`protectedPaths()` in `lib/hosts/index.mjs` is their union). `[]` declares none |
| `nestedProtected` | Optional: `nestedProtected(segments)`, whether the path whose parts from a confined attempt clone's root are `segments` is a host file it loads from any depth, such as a nested `.claude` folder's skills or settings, or any `SKILL.md`. The agent gate hook refuses those writes, at any depth of the attempt's clone, to a session no Human attends (`nestedProtected()` in `lib/hosts/index.mjs` asks every host). None declared, none refused |
| `instructionFiles` | Optional: `{ files, folders, userFolder(env) }`, the instruction files and folders it loads from the folder a session starts in and from each folder above it, by their paths from that folder, and its own user folder, which it reads for every session. A project run refuses a start under such a file above the worktree that the main checkout does not track unchanged from the base tip, skipping the user folder (`ancestorProblem` in `lib/project-run-gate.mjs`) |
| `configCommands` | Optional: `{ programs, subcommands, valueOptions }`, the host's own command, the subcommands of it that write the host's user or project config, each a list of words, such as `['mcp', 'add']`, and its global options that take the next word, which are skipped before the subcommand, as in `codex --profile p login`; a package runner, such as `npx`, is read through. The agent gates hook refuses them to a session no Human attends and its subagents (`unattendedWriteDenial` in `lib/unattended-write.mjs`, through `configCommands()` in `lib/hosts/index.mjs`). A host that names none adds none |
| `mainCheckoutPaths` | Optional: `{ folders, settings }`, what a session in a linked worktree reads from the main checkout wherever the worktree lies: folders from the checkout's root, and settings files, each `{ file, problem(value) }`, where `problem` takes the file's JSON and names the key that a session no Human attends must not run under, or null. A project run refuses a start under an untracked, ignored, or changed file in such a folder, or a settings file `problem` refuses (`mainCheckoutProblem`), and the agent gates hook refuses their writes to a session no Human attends, and to any subagent while the project has a project run under way (`mainCheckoutWriteDenial` in `lib/handoff-guard.mjs`); a project run's attempt clone is no shared main checkout, and its main checkout is the run's. A main checkout that only lags the default branch, at an earlier commit of it, still passes. `{ folders: [], settings: [] }` declares none |
| `modelsKey`, `modelChoices` | Its key under `models` in config.json, and what that key takes |
| `modelPrices` | Optional: its models' prices as data, `{ models, rows }`, for the cost of its transcripts. [Model prices](../dispatch-log.md#model-prices) lists the fields; `test/model-prices.test.mjs` fails on a listed model with no row of its own |
| `capabilities.transcripts` | Whether `lib/transcript.mjs` reads its transcripts: cost rows, the names reminder, and the session-length reminder need it. `true` also opts the host into the `review-rounds` rule's reading of the Human's answers and typed grants of review rounds; `false` makes that rule hand the raise to the Human's own shell |
| `capabilities.prFooterSettings` | The settings files that say whether it asks for a generated-by footer, when it does |
| `capabilities.trackerGuard` | `verified` (`live`, `source`, or `none`), `evidence`, `unguardedRoutes`, and, when its hooks wait on a person, `hookTrust`, `trustStep`, and `offStep` |
| `capabilities.projectStart` | Optional: how `aidrian project start` starts the session of one issue of a project run (`lib/project-run-gate.mjs`): `start({ session, cwd, name, prompt, env, hold, identify, run, wait, log, beacon, grants, git, domains, cacheVars, main, mainGit, tokens, guarded, mcp, home, platform })`, as `startBackground` but in the attempt's clone `cwd` under `name`, with no agent and the driver session's permission mode. `log` is the run log, `logs/<issue>.<attempt>.jsonl` in the run's folder, for a host that writes the session's events there; `identify({ id, session })` files the new session's floor and mark as soon as the adapter knows its id, before it waits on more; `beacon(id)` says whether the agent gate hook ran for session `id` since the start (`readBeacon` in `lib/unattended-mark.mjs`), for a host that must prove it runs the plugin's hooks; `grants` are the folders a confined session may write besides `cwd`, `git` the clone's git folder among them, `domains` the network hosts of the forge (`forgeDomains` in `lib/forges/index.mjs`) and of the registries the base branch's `projectRun.registries` lists (`registryHosts` in `lib/project-registries.mjs`), `cacheVars` the environment that puts each package manager's cache in the attempt's `cache` folder, which the session's sandboxed commands get and the host's own process, its hooks, and its MCP servers never do (`cacheVars` there; a host that takes it at the start, as Codex's shell policy does, passes it on, and a host that cannot declares `shellEnv` below), `main` the main checkout and `mainGit` its git folder, for a sandbox that hides the main checkout but the objects the clone borrows, `tokens` the forge CLI's token variables (`forgeTokenVars`), the one credential a sandbox keeps, `guarded` the folders no sandboxed command may write even where a user's setting would let it, the [sign-off store](../review.md#merge-trust)'s, `mcp` the MCP servers the base branch's `projectRun.mcpServers` names, the only ones the session may load, and `home` and `platform` the user's home folder and the operating system. A start that stopped a session for a failed proof returns `{ problem, uncertain: false, proof }`, which gives the attempt back and halts the run until an attended `aidrian project resume`. `stop({ id, started, env, run })`, where `started`, when given, is the id the start returned; `ended({ id, session, env, run })`, whether the host lists that session as one that runs no more, done, stopped, or failed alike: `true`, `false`, or `null`; `find({ cwd, name, env, run })`, the sessions in a folder under an exact name, as `[{ id, session, state }]`, or null; `limitOf({ id, session, cwd, log, env, home, now })`, optional, whether the session last met a usage or rate limit, read only from the host's own error record, as `{ kind: 'usage' | 'rate', until }` with `until` the reset time in milliseconds or null and `at` the record's own time, which the reset is read against, or null, else null, which `wait` turns into a pause of the run (`lib/project-limit.mjs`); `continuesAtLimit: true` when the host continues its own session once the limit resets, so `wait` keeps a limited session it still lists running instead of stopping it; `attachLine`, `stopLine`; `verified` (`live`, `fixtures`, or anything else, which counts as unverified: a run starts it only under the default branch's `projectRun.unverifiedHosts`, and names it in an `unverified:` line on each answer) and `evidence`. Every project start is confined: `confined: true` says the host's session runs in its sandbox, in a fresh clone made for each attempt with its git folder, a drop folder, and a cache folder granted (`lib/project-start.mjs`), and hands its result over there; a start on a host that does not declare it halts. Optionally: `hookTrust(env)` and `trustStep`, when the host runs the plugin's hooks only once a person trusts them, so a start halts unless it answers `trusted`; `access({ env, home, guarded, pushUrl, platform, allowed, helpers })`, why a session it starts could not push, reach the forge, or run as confined as it is meant to, or would be let write one of the `guarded` folders, which halts the start: `pushUrl` is the URL the clone pushes to, origin's URL in the main checkout, which the start then holds the clone to, `helpers` the git credential helpers the main checkout's config names, `platform` the operating system, and `allowed` the base branch's `projectRun.outsideSandbox`; `cloneProblem({ work, allowed })`, why the clone holds a file that would run a command outside the sandbox, which halts the start; `placeholders`, a list of `{ path, text }` files and `{ path, folder: true }` folders from the clone's root that the start makes where none is there, before the launch, so a sandbox that denies writes only to a path there at launch holds each (`placeHolders` in `lib/project-start.mjs`, which also puts an empty `config.worktree` and a `commondir` of `.` and a newline in the clone's git folder, and writes none through a link below the clone); `sessionNote({ work, branch })`, a line the session's prompt adds; and `shellEnv({ env, vars })`, which the SessionStart hook calls in a confined attempt's session to hand its sandboxed commands `vars`, the gate's `cacheVars` read from the attempt's folder (`confinedShellVars` in `lib/project-start.mjs`), as Claude Code appends them to the file `CLAUDE_ENV_FILE` names. A host without it refuses every start |
| `capabilities.handoffContinue` | The routes of `session.handoff.continue` it can do, as `routes`, never `none`; `[]` or no field means none, and `continueRoutes(host)` in `lib/hosts/index.mjs` reads it. Each listed route has `steps[route]`, what it takes from the Human, as a phrase. A host that lists `clear` declares `keepsArmed(prompt)`, whether a prompt is its own clear or compact command, and `hookHostPid()`, the id of the host process a hook runs under, the same before and after a clear, or null. A host that lists `background` declares `startBackground({ session, slug, chain, env, prompt, hold, run, wait })`, which starts a new session in the folder of the handing-off session `session`, as the host itself places it, whose first message is `prompt`, through `run` (spawnSync's shape, which tests replace), after calling `hold({ cwd, known })` with that folder and the ids of the sessions the host runs, and before the host starts anything; when `hold` returns false, it starts nothing and returns `{ problem }`. `hold` files the gate's pending mark, which holds every session not in `known` as unattended until the host lists the new id. It returns `{ id, session, name, cwd, mode }`: the id to name it by, its full id or null while the host has not listed it, its name when plain text no other session has, else null, its folder, and the permission mode it started in, the handing-off session's, never one that bypasses permission checks; when that mode cannot be read, it starts nothing and returns `{ problem }`, since the host's default may bypass them. It returns `{ problem, uncertain }` when none it can name started, with `uncertain` true when the host's start command ran and may have started a session anyway, which is every failure but a start command that never ran or a refusal the adapter knows came before the host took the start: the gate then keeps the pending mark and arms no fallback, and `findLine()` is the phrase that says how the Human finds and stops such a session. It also declares `stopBackground({ id, env, run })`, which stops a started session the gate cannot hold to a chain floor, `stopLine({ id })`, the phrase that says how the Human stops one when `stopBackground` could not, `attachLine({ id, name })`, the phrase that says how the Human opens one, and `sessionEnded({ id, session, env, run })`, whether the host's own listing shows the session a start record names as ended: `true`, `false`, or `null` when the listing gives no answer. Only `true` lets the session that started it start another; a host without it starts one per session while the start record lives. |

`unguardedRoutes` is how a host says what cannot be held: `[{ name, reason }]`, one per way a tracker write reaches no hook.
While `tracker.enabled` is true, `aidrian check` warns of each, of a `hookTrust` that answers `untrusted` or `off`,
and of `verified: 'none'` on a host set up here.

The standard the shared code reads is what `hooks.json` matches: `Bash`, `Agent`, the events as Claude Code names them, and `mcp__<server>__<tool>`.
`test/host-coupling.test.mjs` lists each use of those tool names.
`apply_patch` is not one of them: it is one host's file edit, read through `fileEditOf`.
A host that differs maps to the standard in `hookInput` and `toolName`, as `test/fixtures/adapters/fake-host.mjs` does.
A project's pattern may name a tool either way, since the gates and the guard match `tool_name` and `raw_tool_name`,
and a block names the tool by `raw_tool_name`, the one the agent called.
Keep the adapter small and let it read no file when it loads: every hook loads it.

### What the fixtures do not prove

`fake-host.mjs` shows that the shared code takes a host with another payload through its registry functions.
It runs no host, so it proves nothing about a real host's payload, its matchers, its trust, or its delivery.
A recorded payload in `test/fixtures/hosts/<id>/` proves only that the hooks judge that payload as expected,
and its `live` field says whether a real host ever sent it.
Only a live session with the hooks running proves a guard holds.
[Where the tracker guard is verified](../hooks.md#where-the-tracker-guard-is-verified) says how far each host has come.

### What else a new host has to check by hand

- **The auto-merge guard.** `GUARDED_PATHS` in `lib/project.mjs` lists the folders that instruct a host, such as `.codex/`.
  A change to one keeps auto-merge off, unless `github.autoMerge.includeGuardedPaths` is true on both the default branch and the base;
  the policy files of [Auto-merge](../config.md#auto-merge) stay off even then.
  It takes the host's folder by hand, since it is one rule over every path. The conformance suite fails on a `projectFolders` entry it does not cover.
- **A separator that does not say where the server ends.** A host that joins server and tool with one underscore needs the known server names to find it,
  longest first. No shipped host does, so `toolName` takes only the name, and such a host adds that lookup with its adapter:
  the servers from `lib/trackers/`, passed through `normalizeHookInput` and, for `tracker.servers`, again once the config is loaded.
- **The agent names in skills.** The `knowledge` skill's sentence on `aidrian:<name>` and `aidrian-<name>` names each host's prefix.
  A new host adds its prefix to that sentence. It stays text, since a start line for it would change what every session reads.
- **Skills.** They are one text for every host, and some name a host's tool, such as `AskUserQuestion`.
- **Quorum.** `quorum.*.provider` takes `agent` or `codex`.
  That names a second-opinion command the plugin runs, whichever host is running, so a new host needs nothing there.

## Adding a tracker

| File | What it holds |
| --- | --- |
| `plugins/aidrian/lib/trackers/<id>.mjs` | The adapter, with the fields below |
| `plugins/aidrian/lib/trackers/index.mjs` | The adapter in `TRACKERS` |

| Field | What it says |
| --- | --- |
| `id`, `name` | What `tracker.provider` takes, and how a message names it |
| `servers` | The server names a connection shows: `any` on every host, then one list per host id, as written. Each host's `serverSpelling` gives its own spelling. The conformance suite needs an entry for every shipped host, even an empty one, so each is looked at on a live connection |
| `readTool`, `workspaceField` | The tool that reports the connected workspace, an exact name, and the field of its response that holds it |
| `workspaceInput` | Instead of those two: the input field each write names its workspace in, judged on the call with no session read, for a tracker whose one read lists every workspace |
| `writeVerbs` | Its write tools, as patterns after `mcp__<server>__` |
| `readVerbs` | Optional: tools that only read under names the plugin's first-word check does not know, so no lesson asks about them |
| `team` | `createFields`, the inputs that put a write in a team, and `keyFields`, the inputs that name an issue |
| `project` | Optional: `field`, the input that names a project |
| `idHint` | Optional: what a refused issue key tells the agent to do when the write is on something else |
| `unguardedRoutes` | `[{ name, reason }]`: each way a write reaches no judgment, such as a tool whose arguments nest the real one. `aidrian check` warns of each |

A project then writes `"tracker": { "enabled": true, "provider": "<id>", ... }` ([Tracker](../config.md#tracker)) and asks a person for no tool name.
`test/fixtures/adapters/fake-tracker.mjs` and `fake-per-call-tracker.mjs` show both shapes,
and `test/adapters.test.mjs` runs them through the guard with no change to shared code.
Those fixtures name tools that do not exist, so a real tracker's names come from a live connection, and they prove nothing of its write tools.

An opaque id names no team: a UUID, or a bare number on a tracker that takes one, skips the team check, so a write by one to another team passes.
State that limit for the tracker in [How a write is judged](../config.md#how-a-write-is-judged), and in a comment on its `idHint`.

### The text a tracker such as Jira needs

An adapter makes the guard hold. The skills that act on a tracker are text, and name Linear and GitHub Issues today, so each of these needs its branch:

| Where | What it needs |
| --- | --- |
| `skills/knowledge/references/tracker.md` | A column: which tool each issue step uses, the key's form, and how a body closes one |
| `skills/harness-setup/SKILL.md`, its Q1 Tracker row | The tracker as a choice, and the answers a person knows for it |
| `skills/harness-setup/references/dispatches.md`, its tracker key section | The short key it writes, which is Linear's alone today |
| `skills/agent-issue-writer/`: `SKILL.md`, `references/linear.md`, `references/issue-body.md`, `references/examples.md` | How an issue is written and published on it |
| `skills/initiative-agent/`: `SKILL.md`, `references/initiative-contract.md` | How a group of issues is made on it |
| `skills/issue-implement/`: `SKILL.md`, `steps/phase-0-resolve.md`, `steps/phases-1-4-implement.md` | How an issue is read and moved on it |
| `skills/persona-audit-triage/references/issues.md`, `skills/planning-agent/references/plan-file.md`, `skills/pr-write/SKILL.md`, `skills/knowledge/SKILL.md` | The places that name Linear in passing |
| `agents-src/planning/agent-issue-writer.md`, `agents-src/planning/initiative-agent.md` | The agents' own wording of the above |

## Adding a forge

A forge is where a pull request lives: its checks, reviews, comments, and repository. GitHub is the one shipped, through gh.

| File | What it holds |
| --- | --- |
| `plugins/aidrian/lib/forges/<id>.mjs` | The adapter: a function that takes `{ cwd, run, timeoutMs, killSignal }` and returns the frozen method object below. `run` is the test seam for the forge's command, and `killSignal` the signal that stops a call at `timeoutMs`, as the ready hold asks for SIGKILL |
| `plugins/aidrian/lib/forges/index.mjs` | `forgeFor(cwd, options)`, which returns GitHub's adapter for every checkout today, the facade's helper `repoIdentity(value)` from `identity.mjs`, `isLogin(name)`, whether a name is shaped like the forge's login, as an invariant's `approvers` must be, `changeNotFound(error)`, whether an error is the forge's answer that it has no such change, such as GitHub's 404, which ends a dropped result at once, `forgeConfigCommands()`, the union of every forge adapter's CLI subcommands that write the user's own config, each `{ programs, subcommands, valueOptions, what }` (`gh config set`, `gh extension install`, `gh auth setup-git`, and `gh auth login`, `logout`, `switch`, and `refresh` on GitHub), which the agent gates hook refuses to a session no Human attends, and `MAX_BODY`, the longest body the forge takes for a comment or a review, which the adapter names (65,536 characters on GitHub) and an inline review checks its escaped length against. A second forge makes `forgeFor` choose, such as by the host `repoIdentity` reads from the remote, and maps the facade's own options to the adapter's. `strictJson` promises shared code one thing: an empty answer is null, not an empty list. The GitHub adapter keeps it by naming GitHub's JSON media type on every REST call, its `mediaType`, which shared code cannot pass |
| `test/forge-<id>.test.mjs` | The exact command or request behind each method, as `test/forge-github.test.mjs` holds gh's |

The adapter implements the methods of `lib/forges/github.mjs`, each with the arguments it takes there:

- `id`, `cwd`, and the helper `isTrustedCommenter(comment)`.
- Pull requests: `change`, `mergedChanges`, `openChanges`, `checks`, `pull`, `diff`, its diff as text,
  `nodeChange`, the pull request a GraphQL node id names, `changeEdits(repo, n, { host })`, when its body was last edited
  and its title last renamed, `changeFiles`, every changed file past the 100 `change` lists, and
  `reviewTrail(repo, n, { host })`, what a merge no Human asks for confirms in one call: the head, the base, the first
  100 changed files, the newest 100 reviews, and the first 100 conversation comments, each author's login and whether it
  is a bot, and every editor of a comment ([Merge trust](../review.md#merge-trust)); and the head branch, title, body,
  and the first 100 commit messages, whole or not, for the closing-word check.
- The repository: `repo`, `repository`, `branchHead`, the commit a branch points to, `contents`, `tree`, one folder of a
  commit's tree with each entry's mode, `visibility`, and `viewer`.
- Conversation: `conversationComments`, the comments on the pull request rather than on its diff, `comment(repo, id, { host, pr })`,
  one of them by id, held to pull request `pr` when the option names it (null for a comment of any other, or one the forge
  does not find), `postComment`, `editComment`, `deleteComment(repo, id)`, and `reactions`.
- Review: `reviews`, `reviewComments`, `reviewsWithComments`, and `reviewThreads`, and `changeEvidence(repo, n, url, { host, withBody })`, which says whether a URL on the pull request's host is one of its comments, reviews, or review comments, found by its id, and with `withBody` gives that item's text too, so the sign-off check refuses an engine post.
- Inline review: `postReview(repo, n, { commitId, body, comments })`, one review of the head with its inline comments
  (`{ path, line, side, body }`), always a plain comment: the adapter sets the event, and takes none. It answers
  `{ refused: false, id, login, comments }`, the review's id, the login the forge answered it with (null with none), and
  its inline comments with their ids, or `{ refused: true }` when the
  forge refuses the review, such as for a line outside the diff (GitHub: any 4xx answer), and throws any other failure:
  shared code reads no status code and no forge message. `reviewComment(repo, n, id)`, one review comment by its id, held
  to pull request `n`, and `deleteReviewComment(repo, id)`: the delete of the engine's own comment for a security finding
  reads it first.
- Replies: `findingThreads(repo, n, { roots })`, the review threads of the pull request, read once a step, up to the
  page that holds the last of `roots`, the root comment ids the caller looks for (every page without them), each as
  `{ resolved, complete, comments }`, its comments in order in the shape the other comment reads give (`id`, `body`,
  `user.login`, `author_association`), the first its root, `complete` false when the forge gave only part of them;
  `replyToReviewComment(repo, n, commentId, body)`, one reply in the thread review comment `commentId` starts, answering
  the reply with its `id`; `resolveThread(repo, n, commentId, { only })`, which resolves that thread, found by its
  root comment's id, so shared code handles no forge-side thread id (GitHub: a GraphQL node id); and
  `unresolveThread(repo, n, commentId)`, which opens it again, found the same way. With `only`, the ids
  of the comments the caller allows there, `resolveThread` reads the thread again first and resolves nothing when that
  read holds any other comment or is only part of the thread, answering `{ resolved: false, others: true }`. It answers
  `{ resolved: true }` for a resolved thread, `unresolveThread` answers `{ resolved: false }` for an open one, and each
  throws on any failure, so the step tries again. The engine replies once a finding with a thread closes, and opens the
  thread again when the finding opens again ([Replies](../review.md#replies)).
  Every write route, and every read of one comment, is built from a safe positive integer alone, and
  text from a pull request reaches a write as a literal string: on GitHub, JSON on gh's stdin or a raw `-f` field, never
  `-F`, which reads a leading `@` as a file.
- Commits: `commit`, `checkRuns`, `compare`, `deployments` of one commit and `deploymentStatuses` of one deployment,
  and `uploadImages` for a pull request's captures.
- Merge stops, which `aidrian project stop-action` reads and takes (`lib/project-stops.mjs`): `mergeState(repo, ref)`,
  where the pull request of a number or a head branch stands for a merge, with its mergeability and merge state;
  `workflowRun(repo, id, { host })`, one Actions run with its head commit, branch, repository, and attempt;
  `rerunFailedChecks(repo, runs, { host })`, which starts the failed jobs of each workflow run again;
  `branchAllowsForce(repo, branch, { host })`, false when the branch is protected or a ruleset forbids a push that is
  no fast-forward; and `updateBranch(repo, n, { host, expectedHead, method })`, which brings it up to date with its
  base on the forge, only while its head is `expectedHead`, by merging the base in or, with `method: 'rebase'`, by a
  rebase. `changeCommits(repo, n, { host })` lists its commits with their messages, for the auto-merge gate's
  closing-word check ([config.md](../config.md#when-it-is-on)).
- Links: `compareUrl(repo, from, to)`, the web link that shows the commits from `from` to `to`, which the review
  summary's findings table gives a finding's closing range. It is built only from two full-hex SHAs and the forge's own
  identity of the repository, never from pull request content: GitHub's adapter reads the repository's `html_url` once,
  so a GitHub Enterprise repository links to its own host. It returns null for anything else, and for a read that
  fails: the table then shows the two short SHAs as text.

`repoIdentity(value)` is no method: it reads a remote URL or a `-R` value to `{ host, path }` before any forge is chosen,
so it lives in `lib/forges/identity.mjs`, and an adapter neither implements nor carries it.
It reads a host that reaches the same repositories as another, such as `ssh.github.com`, as that one,
and a bare `owner/repo` as a repository on the default forge's host, github.com.

The payload each method returns is GitHub's, parsed, and its callers read GitHub's field names.
The arguments are GitHub's too: the `fields` strings callers pass to `change`, `mergedChanges`, and `openChanges`
are gh's `--json` names, such as `number,headRefOid`, and the reaction contents, such as `+1`, are GitHub's.
That shape is provisional: it stays as it is until a second adapter shows which fields both forges share,
and that adapter reshapes the payloads, the `fields` and reaction names, and their callers together.

Shared code imports `lib/forges/index.mjs` alone. `test/forge-coupling.test.mjs` fails when code outside `lib/forges/`
imports an adapter module, runs `gh`, builds a `repos/${...}` route, or names `api.github.com`, past its list of what is left.
It fails too on a code block in a skill or an agent source that runs `gh pr checks`: sessions read checks with
`aidrian pr checks`, which applies the project's `github` policy. Prose that only names gh's behavior is not a command.
A rule in `lib/rules/github/` that compares a session's command to `'gh'` is not a coupling: it judges a command and runs none.
The rules' own reads, such as merge-review's and pr-body's, go through `forgeFor` like any shared code.

A second forge will be chosen by a config key, as a tracker is by `tracker.provider`, with a default read from
the remote's hostname for the public forges. `forgeFor` will memoize that choice per `cwd`, since the hooks that call it
answer within 3 s budgets.

### The text a forge such as GitLab needs

An adapter moves the calls. Some text and code still assume GitHub, so each of these needs its branch:

| Where | What it needs |
| --- | --- |
| Skills that run gh in code blocks: `pr-merge-when-green` (10 lines), `pr-screenshot` (7), `pr-review` (3), `pr-review-loop` (3), `pr-write` (2), `knowledge` (1), `session-continue` (1) | The forge's command for each step, or an `aidrian` command that reads through `forgeFor`, as `aidrian pr checks` does. The counts are the fenced lines that run gh across each skill's folder, `references/` and `steps/` included: recount them before the work starts |
| `lib/review-gate.mjs`: `repoName`, and the review marker `markerFor` writes | Both keep only `owner/name`, the last two parts of a path, so a namespaced path such as `a/sub/project` loses its namespace and its host. They need the full `repoIdentity` |
| `lib/lesson-signals.mjs` | It builds `https://github.com/<owner>/<name>/pull/<n>` as a lesson's evidence; it needs the forge's own link to a pull request |
