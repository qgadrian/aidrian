# Claude mod

`aidrian-mod` is an optional Claude Code mod that shows the session snapshot of the `aidrian` plugin, and more,
in a band above the prompt, an `/aidrian-mod` pane, and notifications.
Its source is [`plugins/aidrian-claude-mod/`](../plugins/aidrian-claude-mod/), and it ships from the same
marketplace with its own version and `aidrian-mod-v*` tags ([Versions](contributing.md#versions)).
It is a Claude Code mod alone; Codex has no mod surface, and the [status line fallback](#the-status-line-fallback)
gives the snapshot's line without it.

## What it shows

```text
🪐 Opus 5.5 xhigh · ctx 48% ━━━━──── · ♨️ cache 5m · 5h 26% ↻3h09m · 7d 15%
   ⧉  feature-band · ABC-12 In Progress · ◐ 2 agents
   2.3x · handoff due, pays back in ~24 calls · armed 1/3 · 2 PRs · ✓1 ✗1 ⏳0 · 📥 1 P1 · 🧹 1 worktree
```

- **The band.** The model and effort, context use, the prompt cache time left, the 5-hour and 7-day limits, the branch
  or linked worktree (`detached` with no branch), the branch's ticket with its title and state, and the running
  subagents. A row below them is `aidrian session snapshot` ([The snapshot](handoff.md#the-snapshot)): the handoff verdict the Stop hook would give,
  the pull requests the session touched with their checks, and the harness signals to act on, P1 lessons,
  provisional decisions, merged worktrees to clean, and untriaged persona findings. At 70% context or more, a context
  alert row follows it. Each part shows only when it holds something, in the words of the snapshot's `--line`, but
  for three: an armed chain above its limit draws `armed <n>` with no fraction; a `maxChain` of `unlimited` draws
  `armed <n>` where the line prints `<n>/unlimited`; and pull requests from mixed forges, or from a forge with no
  entry in the mod's table, count as `changes` where the line says `PRs`.
- **The pane.** `/aidrian-mod` shows the same data with one row per pull request and a link to it, the ticket's
  link, and one row per subagent; `/aidrian-mod hide` closes it. When there is no snapshot, the pane says why, in
  one of six notices: the `aidrian` plugin is not installed for the folder, is off for it, or failed the mod's safety
  checks; the mod found no `node` on a PATH folder outside the session's folder; or the plugin returned no snapshot
  (update it), or took longer than 10 seconds.
- **Alerts.** A long turn done, a turn stopped on an API error, an approval or a question waiting, Claude Code's
  other notifications, a failed Bash command, a compaction, and the rate limits at 85% and 90%. Each alert is a sound
  plus a toast or a desktop notification. They run only in an interactive terminal
  session. The focus check skips the desktop notification while the terminal app is in front; it asks macOS through
  System Events, which needs the terminal app's Automation permission for System Events. Without it the check finds
  no app, and every desktop notification is sent.

## Install

The mod needs Node 22 or later, since it runs the plugin's `lib/`, which uses Node 22 built-ins, and the `aidrian`
plugin installed and enabled for the folder. With the marketplace added ([README](../README.md#claude-code)):

```sh
claude plugin install aidrian@aidrian-harness
claude plugin install aidrian-mod@aidrian-harness
```

A status line that runs the [status line fallback](#the-status-line-fallback) shows the same data as the band: drop
that `statusLine` from `~/.claude/settings.json`.

## Settings

Each is a row of Claude Code's config menu, from `userConfig` in the mod's
[`plugin.json`](../plugins/aidrian-claude-mod/.claude-plugin/plugin.json):

| Setting | Default | What it does |
| --- | --- | --- |
| `mode` | `live` | `live` sends alerts; `shadow` only logs what it would send. |
| `notifyMinTurnSeconds` | `20` | A turn shorter than this ends with no Done alert. |
| `focusCheck`, `focusApp` | `true`, `kitty` | Skip desktop notifications while the app named `focusApp` is in front. |
| `sounds`, `volume` | `true`, `0.5` | The sounds, and their gain from 0 to 4. |
| `ticketPrefixes` | empty | Pipe-separated issue key prefixes found in the branch name, such as `ABC\|XY`: at most 32, each a letter and up to 15 letters or digits. A key they match is looked up in Linear. When none matches, a `#N` from a `<type>/<N>-slug` branch shows as it is. |
| `cacheTtlSeconds` | `3600` | The prompt cache lifetime until the transcript shows the real one. |

## How it runs

- **The snapshot.** The mod runs the `lib/cli.mjs` of the `aidrian` plugin installed for the folder, from Claude
  Code's plugin cache, by `node`, one run at a time with a 10-second limit, and reads nothing more from the plugin.
  With the plugin enabled but no entry for the folder, or when the mod runs outside a plugin cache, as with
  `--plugin-dir`, it runs instead the `lib/cli.mjs` beside an `aidrian` command on a checked PATH folder: a regular
  file, not a link, below that plugin folder, and outside the session's folder.
- **Processes.** Every process starts by an absolute path through one resolver, never through a shell: `node` and
  `git` from PATH folders outside the session's folder, and `/usr/bin/osascript` with one constant script for the
  focus check. `focusApp` is only compared with what that script prints.
- **The git status read.** The branch read passes `--no-optional-locks` and `-c core.fsmonitor=false` to git, so it
  takes no lock and starts no fsmonitor program. A repository's own configured filter drivers can still run, as in
  Claude Code's own start-up status read.
- **Folder trust.** Observed on Claude Code 2.1.327: `session.start` does not fire before the trust dialog is
  answered. In a folder never trusted, a tmux probe held the dialog open and no mod hook ran; in a trusted folder the
  same probe saw `session.start` within 10 s. So the mod starts its processes from `session.start`, with no wait for
  the first prompt. This holds by observation on Claude Code 2.1.327, not by a documented contract; a later version
  is not verified.
- **What reaches the model.** Nothing the mod reads. Its one MCP call is `get_issue` with the ticket key, and
  `/aidrian-mod` answers with constant text.
- **Text.** Every text it draws or sends passes one filter that removes control, format, and bidi characters. A link
  is drawn only for a pull request URL that matches its row, or the Linear page of the ticket looked up.

## The forge seam

The mod reads only the snapshot and calls no forge: the `aidrian` plugin's forge adapter in `lib/forges/` fills the
snapshot's `prs`. The mod's one naming of a forge is the forge table in
[`lib/format.mjs`](../plugins/aidrian-claude-mod/lib/format.mjs), keyed by each row's `forge`.
A new forge adapter ([Adding a forge](providers/adding-a-host.md#adding-a-forge)) adds one entry there, its words for a change and
its link pattern; until then its rows show as a `change`, with no link.

## The status line fallback

Without the mod, Claude Code's status line can show the snapshot's line, `aidrian session snapshot --line`.
The snapshot reads no stdin and no host variable, so a script passes it the session from the status line's stdin
JSON. Save this as `~/.claude/aidrian-statusline.mjs`:

```js
// The aidrian session line for Claude Code's status line: node ~/.claude/aidrian-statusline.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const cwd = input.workspace?.current_dir ?? input.cwd;
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  const installed = JSON.parse(readFileSync(path.join(config, 'plugins/installed_plugins.json'), 'utf8'));
  const entries = installed.plugins['aidrian@aidrian-harness'] ?? [];
  // The install for this folder: the deepest local or project entry that holds it, else the user one.
  const holds = (entry) => entry.projectPath && (cwd === entry.projectPath || cwd.startsWith(`${entry.projectPath}/`));
  const entry = entries.filter(holds).sort((a, b) => b.projectPath.length - a.projectPath.length)[0]
    ?? entries.find((candidate) => candidate.scope === 'user');
  const args = [path.join(entry.installPath, 'lib/cli.mjs'), 'session', 'snapshot', '--line'];
  if (typeof input.session_id === 'string') args.push(`--session=${input.session_id}`);
  if (typeof input.transcript_path === 'string') args.push(`--transcript=${input.transcript_path}`);
  const ran = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 10_000 });
  process.stdout.write(ran.status === 0 ? ran.stdout : '\n');
} catch {
  process.stdout.write('\n');
}
```

And point the status line at it in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"$HOME/.claude/aidrian-statusline.mjs\"",
    "refreshInterval": 60
  }
}
```

- **Finding the command.** The script runs `aidrian session snapshot` as the `aidrian` command does, by `node` on the
  plugin's `lib/cli.mjs`. It takes the install path Claude Code records in `installed_plugins.json`: the local or
  project entry whose folder holds the session's folder, the deepest first, else the user entry. So it needs no
  `aidrian` on the status line's PATH: the plugin's `bin/` is on the PATH of Claude Code's Bash tool, which the status
  line need not share.
- **PATH.** The status line's PATH must hold `node`, `git`, and `gh`: the snapshot runs `git` and `gh` by name from
  the PATH it finds. Unlike the mod, which runs programs only from PATH folders outside the session's folder, it
  checks no folder.
- **The session.** `session_id` and `transcript_path` become `--session` and `--transcript`, each only when the
  stdin JSON holds it, and the snapshot runs in `workspace.current_dir`, the session's folder.
- **Time.** The 10-second limit sits above the snapshot's own, about 8 s past its reading
  ([The snapshot](handoff.md#the-snapshot)). Claude Code cancels a status line command that is still running when the
  next update comes; a snapshot it leaves behind ends within its own limits.
  `refreshInterval` keeps the checks current while the session is idle, and the snapshot caches the forge's answer
  for a minute.
- **Tried.** The script ran on Claude Code 2.1.327 data: a stdin JSON in the status line's shape, with a live
  session's id and transcript in this repository, and a PATH that held no `aidrian`, printed
  `2.1x · handoff due, pays back in ~53 calls · 📥 1 P1 · 🧹 9 worktrees` in under 3 seconds.
  It was not run from a live session's status line.

## Hosts

| Surface | Host |
| --- | --- |
| The band, the pane, and the alerts | Claude Code, verified on 2.1.327 by `claude plugin validate` and `claude plugin test` |
| `aidrian session snapshot` | Claude Code, verified on 2.1.327 by the status line script above |
| `aidrian session snapshot` on Codex | Not verified, and with no handoff section: the snapshot reads no Codex transcript |

## Limits

- **Forges.** Pull requests show only for repositories on a host a forge adapter declares, github.com today.
- **25 refs a call.** The snapshot reads at most 25 refs, the newest, each a pull request number or a branch, counted
  before branches resolve. A branch with no pull request uses one, so fewer than 25 pull requests can show while an
  older one is left out ([Session snapshot](config.md#session-snapshot)).
- **Pull requests opened outside gh.** The [session ledger](hooks.md#session-ledger) records a `created` row only for
  `gh pr create`. One opened another way, such as through a GitHub MCP server or the web, shows once a `git push` or
  a `gh pr` command of the session records its branch or number.
- **One project's ledger.** The ledger is kept per project, so the band shows the pull requests of the project at the
  session's folder.
- **The background hand-off.** After a hand-off on the
  [background route](handoff.md#the-background-route), the old session's band says nothing of it: a background
  start arms nothing, so in the session that handed off `continueArmed` stays false and its handoff level stands.
- **Managed settings.** On a machine with managed settings, Claude Code does not pass its `classic.*` hook events to
  a plugin a person installs, so approval prompts and Claude Code's other notifications send no alert.
- **Layout.** The blank row between the band and the prompt belongs to Claude Code; a mod cannot remove it.
- **Subagent context.** A subagent's context window is taken as 200k tokens unless its model name includes `[1m]`.
