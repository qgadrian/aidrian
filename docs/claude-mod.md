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
   2.3x · handoff worth it if 38+ calls left · armed 1/3 · 📥 1 P1 · 🧹 1 worktree
   PRs ✓5 ✗1 ⏳1 · #4012, #4019, #4023, #4031, #4036, +2
```

- **The band.** The model and effort, context use, the prompt cache time left (counted from when the last main-chain
  model request was sent, once its response starts to stream, or from the main turn's end, so a long turn keeps it
  warm; after an API retry, from the step's first attempt, so the band may show less time left than there is, never
  more; a subagent's request does not count, and the lifetime is read from the transcript when a main turn ends), the
  5-hour and 7-day limits (each only once Claude Code reports it, so a plan with no 5-hour limit shows none), the branch
  or linked worktree (`detached` with no branch), the session's tickets, and the running subagents. The tickets are
  the snapshot's `tickets`, from the branch, the session ledger, and the pull requests the session touched
  ([The snapshot](handoff.md#the-snapshot)): one shows its key with its title and state; two or more show the first
  three keys and `+N` for the rest, `ABC-12, ABC-15, #42, +2`.
  Two rows below them are `aidrian session snapshot` ([The snapshot](handoff.md#the-snapshot)): first the handoff verdict the Stop hook would give
  and the harness signals to act on, P1 lessons, provisional decisions, merged worktrees to clean, and untriaged
  persona findings; then, on a row of their own so a long list never cuts the signals off, the pull requests the
  session touched: the check counts first, so a narrow terminal cuts numbers and never a failure, then up to five
  numbers, each in the color of its checks, and `+N` for the rest. When the numbers come from more than one
  repository, each carries its repository's letter, `PRs ✓1 ✗1 ⏳0 · a#42, b#42`: `a` is the first repository when
  their hosts and paths are sorted, so one name under two owners, or on two hosts, gets two letters, and a letter
  changes only when the set of repositories does. A pull request with no number takes no letter. The summary is at
  most 58 characters, which fits a 64-column band, and lists fewer numbers and a larger `+N` rather than cut one.
  At 70% context or more, a context
  alert row follows it. Each part shows only when it holds something, in the words of the snapshot's `--line`, but
  for four: an armed chain above its limit draws `armed <n>` with no fraction; a `maxChain` of `unlimited` draws
  `armed <n>` where the line prints `<n>/unlimited`; pull requests from mixed forges, or from a forge with no
  entry in the mod's table, count as `changes` where the line says `PRs`; and, since that word is longer, near the
  58-character budget the band may list fewer numbers than the line, with a larger `+N`: one or more, since dropping a
  short number such as `#1` for a larger `+N` can free no room.
  The band's numbers are always the first of the line's.
  The line keeps one row: the handoff, then the pull requests, then the harness signals.
- **The pane.** `/aidrian-mod` shows the same data with one row per ticket, its key, title, and state, and a link to
  its issue, one row per pull request and a link to it, and one row per subagent.
  Each pull request's row starts with its number as the band lists it, `PR a#42`,
  then its repository, so each letter shows beside the repository it names.
  `/aidrian-mod hide` closes the pane. When there is no snapshot, the pane says why, in
  one of six notices: the `aidrian` plugin is not installed for the folder, is off for it, or failed the mod's safety
  checks; the mod found no `node` on a PATH folder outside the session's folder; or the plugin returned no snapshot
  (update it), or took longer than 10 seconds.
- **The agent list.** Each subagent's row in Claude Code's agent list under the prompt reads
  `reviewer [aidrian:code-reviewer]  48% (96k) · 🪐 Opus 5.5 xhigh`: its name, its agent type, its context use and
  tokens, its model and effort, then its status once it stops running. A narrow row cuts the name first, then drops the
  type, so the context and the model always show. It is drawn from the engine's own agent info, on the terminal only,
  and replaces a `subagentStatusLine` script, which Claude Code 2.1.330 deprecates in favor of mods.
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
that `statusLine` from `~/.claude/settings.json`. The mod draws the agent list's rows too, so a `subagentStatusLine`
there can go as well.

## Settings

Each is a row of Claude Code's config menu, from `userConfig` in the mod's
[`plugin.json`](../plugins/aidrian-claude-mod/.claude-plugin/plugin.json):

| Setting | Default | What it does |
| --- | --- | --- |
| `mode` | `live` | `live` sends alerts; `shadow` only logs what it would send. |
| `notifyMinTurnSeconds` | `20` | A turn shorter than this ends with no Done alert. |
| `focusCheck`, `focusApp` | `true`, `kitty` | Skip desktop notifications while the app named `focusApp` is in front. |
| `sounds`, `volume` | `true`, `0.5` | The sounds, and their gain from 0 to 4. |
| `ticketPrefixes` | empty | Pipe-separated issue key prefixes, such as `ABC\|XY`: at most 32, each a letter and up to 15 letters or digits. The snapshot reads a key they match in the branch name and in the session's pull requests, their titles and the keys their bodies say they close, in any letter case, so a short prefix such as `PR` also reads `pr-12` in a title. Each key they match is looked up in Linear. A `#N`, from a `<type>/<N>-slug` branch or an issue a pull request closes, shows as it is. |
| `cacheTtlSeconds` | `3600` | The prompt cache lifetime until the transcript shows the real one. |

## How it runs

- **The snapshot.** The mod runs the `lib/cli.mjs` of the `aidrian` plugin installed for the folder, from Claude
  Code's plugin cache: of the local and project entries of `installed_plugins.json` whose folder holds the session's,
  and the user entry, the newest version, a tie going to local, then project, the deeper folder first, then user.
  Claude Code runs the newest install it holds, not the folder's own record: on 2.1.330, a folder with a local entry
  at 0.7.0 and a user entry at 0.84.14 ran 0.84.14, and a mod that read the 0.7.0 entry got no snapshot, so it drew
  no pull requests, tickets, or handoff. It runs that cli by `node`, one run at a time with a 10-second limit, and
  reads nothing more from the plugin.
  With the plugin enabled but no entry for the folder, or when the mod runs outside a plugin cache, as with
  `--plugin-dir`, it runs instead the `lib/cli.mjs` beside an `aidrian` command on a checked PATH folder: a regular
  file, not a link, below that plugin folder, and outside the session's folder.
  The mod reads the snapshot's `tickets`, and its `ticket` only from an `aidrian` plugin that prints no `tickets`, so
  a snapshot with both draws each ticket once and looks each key up once.
  A mod older than this one reads the deprecated `ticket` alone, so with a newer plugin it shows the session's first
  ticket only. The plugin keeps `ticket` for those older mods alone, and removes it 30 days after the `aidrian-mod`
  release that reads `tickets` ships, or at the next major version of `aidrian` or `aidrian-mod`, whichever comes first.
  <!-- aidrian:decision id=snapshot-legacy-ticket-mod status=confirmed class=product-behaviour domain=product date=2026-11-20 pr=439 -->
  <!-- aidrian:decision-new id=snapshot-legacy-ticket-mod text="  A mod older than this one reads the deprecated `ticket` alone, so with a newer plugin it shows the session's first\n  ticket only. The plugin keeps `ticket` for those older mods alone, and removes it 30 days after the `aidrian-mod`\n  release that reads `tickets` ships, or at the next major version of `aidrian` or `aidrian-mod`, whichever comes first." -->
- **Processes.** Every process starts by an absolute path through one resolver, never through a shell: `node` and
  `git` from PATH folders outside the session's folder, and `/usr/bin/osascript` with one constant script for the
  focus check. `focusApp` is only compared with what that script prints. Each process gets as its PATH only those
  folders, and of them only the ones whose `git` and `gh` are shown absent or resolve outside the session's folder
  too: the snapshot runs both by name. The check fails closed: a folder whose `git` or `gh` is a link to nothing, or
  whose lookup is denied, is dropped, and so is a folder whose real path holds the PATH separator `:`.
- **The git status read.** The branch read passes `--no-optional-locks` and `-c core.fsmonitor=false` to git, so it
  takes no lock and starts no fsmonitor program. A repository's own configured filter drivers can still run, as in
  Claude Code's own start-up status read.
- **Folder trust.** Observed on Claude Code 2.1.327: `session.start` does not fire before the trust dialog is
  answered. In a folder never trusted, a tmux probe held the dialog open and no mod hook ran; in a trusted folder the
  same probe saw `session.start` within 10 s. So the mod starts its processes from `session.start`, with no wait for
  the first prompt. This holds by observation on Claude Code 2.1.327, not by a documented contract; a later version
  is not verified.
- **What reaches the model.** Nothing the mod reads. Its one MCP call is `get_issue` with `{ id }`, once per ticket
  key a prefix matched, at most 10 a draw, all started at once. Each answer is reused for 5 minutes from when it was
  asked, through a snapshot that fails or a draw its key is not in, and at most 20 are kept, the oldest of keys not
  drawn forgotten first; only the current snapshot's keys are drawn. The key is a tool argument, never part of a
  command or a URL. `/aidrian-mod` answers with constant text.
- **Text.** Every text it draws or sends passes one filter that removes control, format, and bidi characters. A link
  is drawn only for a pull request URL that matches its row, or the Linear page of the ticket key it was looked up for.

## The forge seam

The mod reads only the snapshot and calls no forge: the `aidrian` plugin's forge adapter in `lib/forges/` fills the
snapshot's `prs`. The forge table in [`lib/format.mjs`](../plugins/aidrian-claude-mod/lib/format.mjs), keyed by each
row's `forge`, holds the mod's only forge words and links. The resolver also names the `gh` executable, but only to
check the PATH it hands the snapshot, which runs `gh` by name: it never runs `gh` or calls a forge itself.
A new forge adapter ([Adding a forge](providers/adding-a-host.md#adding-a-forge)) adds one entry there, its words for a change and
its link pattern; until then its rows show as a `change`, with no link.

## The status line fallback

Without the mod, Claude Code's status line can show the snapshot's line, `aidrian session snapshot --line`.
The snapshot reads no stdin and no host variable, so a script passes it the session from the status line's stdin
JSON. Save this as `~/.claude/aidrian-statusline.mjs`:

```js
// The aidrian session line for Claude Code's status line: node ~/.claude/aidrian-statusline.mjs
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const cwd = input.workspace?.current_dir ?? input.cwd;
  const config = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'));
  const installed = JSON.parse(readFileSync(path.join(config, 'plugins/installed_plugins.json'), 'utf8'));
  const records = installed.plugins['aidrian@aidrian-harness'] ?? [];
  // The install for this folder, as the mod picks it: of the local and project entries whose real folder holds it, and
  // the first user entry, the newest version; a tie goes to local, then project, the deeper folder first, then user.
  const real = (folder) => {
    try { return typeof folder === 'string' && path.isAbsolute(folder) ? realpathSync(folder) : null; } catch { return null; }
  };
  const here = real(cwd);
  const holds = (folder) => folder !== null && here !== null
    && (here === folder || here.startsWith(folder.endsWith('/') ? folder : `${folder}/`));
  const version = (entry) => {
    const text = typeof entry.version === 'string' ? entry.version : path.basename(String(entry.installPath));
    return /^\d+(\.\d+)*$/u.test(text) ? text.split('.').map(Number) : [];
  };
  const newer = (a, b) => {
    const [x, y] = [version(a.entry), version(b.entry)];
    for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
      if ((x[index] ?? -1) !== (y[index] ?? -1)) return (y[index] ?? -1) - (x[index] ?? -1);
    }
    return 0;
  };
  const entries = records.filter((entry) => entry !== null && typeof entry === 'object');
  const user = entries.find((entry) => entry.scope === 'user');
  const ranked = entries.flatMap((entry) => {
    if (entry === user) return [{ entry, rank: 2, depth: 0 }];
    const rank = ['local', 'project'].indexOf(entry.scope);
    const folder = rank >= 0 ? real(entry.projectPath) : null;
    return holds(folder) ? [{ entry, rank, depth: folder.length }] : [];
  });
  ranked.sort((a, b) => newer(a, b) || a.rank - b.rank || b.depth - a.depth);
  // The chosen install's cli, as the mod checks it: the install's real path below the plugin cache's aidrian folder,
  // and its lib/cli.mjs a regular file, not a link, whose real path stays below the install. Else a blank line: like
  // the mod, it tries no older install.
  const below = (child, parent) => child !== null && parent !== null && child.startsWith(`${parent}/`);
  const cache = real(path.join(config, 'plugins/cache/aidrian-harness/aidrian'));
  const install = real(ranked[0]?.entry.installPath);
  const cli = below(install, cache) ? path.join(install, 'lib/cli.mjs') : null;
  const isFile = cli !== null && lstatSync(cli, { throwIfNoEntry: false })?.isFile() === true;
  if (!isFile || !below(real(cli), install)) throw new Error('no aidrian cli');
  const args = [cli, 'session', 'snapshot', '--line'];
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
  plugin's `lib/cli.mjs`. It takes the install path Claude Code records in `installed_plugins.json`, chosen as the
  mod chooses it: of the entries whose real folder holds the session's folder and the first user entry, the newest
  version, a version that is not numbers last, and a tie to local, then project, the deeper folder first, then user.
  It checks that install as the mod does: its real path below the plugin cache's `aidrian` folder, and its
  `lib/cli.mjs` a regular file, not a link, below it. Otherwise it prints a blank line and tries no older install.
  It needs no `aidrian` on the status line's PATH: the plugin's `bin/` is on the PATH of Claude Code's Bash tool, which the status
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
  `2.1x · handoff worth it if 53+ calls left · 📥 1 P1 · 🧹 9 worktrees` in under 3 seconds.
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
- **Tickets from pull requests.** A pull request gives the keys its title names and the keys its body says it closes
  after one of the forge's own closing keywords (on GitHub `close`, `fix`, or `resolve` and their forms), and `#N` for
  an issue of its own repository the forge links as closed; no tracker's own words, such as Linear's `part of`, count.
  The snapshot holds 10 keys at most, and reads pull requests only on the hosts a forge adapter declares, github.com
  today. A key in a pull request's title or body is the text of whoever wrote it ([The snapshot](handoff.md#the-snapshot)
  says whose bodies count), so its title in the pane is whatever the tracker answers for that key.
- **One project's ledger.** The ledger is kept per project, so the band shows the pull requests of the project at the
  session's folder.
- **The background hand-off.** After a hand-off on the
  [background route](handoff.md#the-background-route), the old session's band says nothing of it: a background
  start arms nothing, so in the session that handed off `continueArmed` stays false and its handoff level stands.
- **Managed settings.** On a machine with managed settings, Claude Code does not pass its `classic.*` hook events to
  a plugin a person installs, so approval prompts and Claude Code's other notifications send no alert.
- **Layout.** The blank row between the band and the prompt belongs to Claude Code; a mod cannot remove it.
- **Subagent context.** A subagent's context window is taken as 200k tokens unless its model name includes `[1m]`.
