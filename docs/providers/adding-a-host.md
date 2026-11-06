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
| `githubTools` | Optional: a GitHub connector's merge and comment tools by standard name, each with `as`, the GitHub MCP server's tool it stands for, `repo`, its `owner/name` input, and `fields`. `hooks.json` lists each by its raw name |
| `toolResponse(response)` | The objects a tool's response holds, the most direct first |
| `hookInput(input)` | The hook payload in the standard field names, with `raw_tool_name` holding what it sent when that differs. A standard payload stays as it is |
| `fileEditTools`, `fileEdit(tool, input)` | Its file edit tools, and each call in a shape `fileEditOf` in `lib/hosts/index.mjs` lists |
| `projectFolders` | Where a project keeps its skills and agents for it, if the plugin's lint can read them |
| `modelsKey`, `modelChoices` | Its key under `models` in config.json, and what that key takes |
| `capabilities.transcripts` | Whether `lib/transcript.mjs` reads its transcripts: cost rows, the names reminder, and the session-length reminder need it |
| `capabilities.prFooterSettings` | The settings files that say whether it asks for a generated-by footer, when it does |
| `capabilities.trackerGuard` | `verified` (`live`, `source`, or `none`), `evidence`, `unguardedRoutes`, and, when its hooks wait on a person, `hookTrust`, `trustStep`, and `offStep` |

`unguardedRoutes` is how a host says what cannot be held: `[{ name, reason }]`, one per way a tracker write reaches no hook.
While `tracker.enabled` is true, `aidrian check` warns of each, of a `hookTrust` that answers `untrusted` or `off`,
and of `verified: 'none'` on a host set up here.

The standard the shared code reads is what `hooks.json` matches: `Bash`, `Agent`, the events as Claude Code names them, and `mcp__<server>__<tool>`.
`test/host-coupling.test.mjs` lists each use of those tool names.
`apply_patch` is not one of them: it is one host's file edit, read through `fileEditOf`.
A host that differs maps to the standard in `hookInput` and `toolName`, as `test/fixtures/adapters/fake-host.mjs` does.
A project's pattern may name a tool either way, since the gates and the guard match `tool_name` and `raw_tool_name`.
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
  A change to one keeps auto-merge off.
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
| `plugins/aidrian/lib/forges/<id>.mjs` | The adapter: a function that takes `{ cwd, run, timeoutMs }` and returns the frozen method object below. `run` is the test seam for the forge's command |
| `plugins/aidrian/lib/forges/index.mjs` | `forgeFor(cwd, options)`, which returns GitHub's adapter for every checkout today, and the facade's helper `repoIdentity(value)` from `identity.mjs`. A second forge makes `forgeFor` choose, such as by the host `repoIdentity` reads from the remote, and maps the facade's own options to the adapter's. `strictJson` has two effects: every REST call names the forge's JSON media type, and an empty answer is null, not an empty list. For GitHub it sets the adapter's `mediaType`, which shared code cannot pass |
| `test/forge-<id>.test.mjs` | The exact command or request behind each method, as `test/forge-github.test.mjs` holds gh's |

The adapter implements the methods of `lib/forges/github.mjs`, each with the arguments it takes there:

- `id`, `cwd`, and the helper `isTrustedCommenter(comment)`.
- Pull requests: `change`, `mergedChanges`, `openChanges`, `checks`, and `pull`.
- The repository: `repo`, `repository`, `contents`, `visibility`, and `viewer`.
- Conversation: `conversationComments`, the comments on the pull request rather than on its diff, `postComment`, `editComment`, and `reactions`.
- Review: `reviews`, `reviewComments`, `reviewsWithComments`, and `reviewThreads`.
- Commits: `commit`, `checkRuns`, and `compare`, and `uploadImages` for a pull request's captures.

`repoIdentity(value)` is no method: it reads a remote URL or a `-R` value to `{ host, path }` before any forge is chosen,
so it lives in `lib/forges/identity.mjs`, and an adapter neither implements nor carries it.
It reads a host that reaches the same repositories as another, such as `ssh.github.com`, as that one,
and a bare `owner/repo` as a repository on the default forge's host, github.com.

The payload each method returns is GitHub's, parsed, and its callers read GitHub's field names.
That shape is provisional: it stays as it is until a second adapter shows which fields both forges share,
and that adapter reshapes the payloads and their callers together.

Shared code imports `lib/forges/index.mjs` alone. `test/forge-coupling.test.mjs` fails when code outside `lib/forges/`
imports an adapter module, runs `gh`, builds a `repos/${...}` route, or names `api.github.com`, past its list of what is left.
The rules in `lib/rules/github/` read the gh commands a session runs, and run none, so they stay out of that rule.
It fails too on a code block in a skill or an agent source that runs `gh pr checks`: sessions read checks with
`aidrian pr checks`, which applies the project's `github` policy. Prose that only names gh's behavior is not a command.
