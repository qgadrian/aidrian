# aidrian-mod

An optional Claude Code mod for the `aidrian` plugin: a band above the prompt, an `/aidrian-mod` pane, and notifications.
It needs the `aidrian` plugin installed and enabled for the folder, and draws only in an interactive terminal session.

```
─────────────────────────────────────────────────────────────── [-]
🪐 Opus 5.5 xhigh · ctx 48% ━━━━──── · ♨️ cache 5m · 5h 26% ↻3h09m · 7d 15%
   ⧉  feature-band · ABC-12 In Progress · ◐ 2 agents
   2.3x · handoff due, pays back in ~24 calls · armed 1/3 · 📥 1 P1 · 🧹 1 worktree
   PRs ✓5 ✗1 ⏳1 · #4012, #4019, #4023, #4031, #4036, +2
```

## What it shows

- The band: model and effort, context use, prompt cache time left, the 5-hour and 7-day limits (each only once Claude
  Code reports it), the branch or worktree,
  the ticket key with its title and state, and running subagents.
- From `aidrian session snapshot`: the handoff verdict the Stop hook would give, the pull requests the session
  touched on a row of their own (the check counts, then up to five numbers colored by their checks, then `+N`; when
  they span several repositories, each number carries its repository's letter, `a#42, b#42`),
  and the harness signals to act on: P1 lessons, provisional decisions, merged worktrees to
  clean, and untriaged persona findings. Each part shows only when it holds something.
- `/aidrian-mod`: the same data in a pane, with one row per pull request and a link to it, each row showing its
  repository's letter beside the repository, the ticket's link, and one row per subagent.
  `/aidrian-mod hide` closes it. When the snapshot cannot be read, the pane says why.
- Notifications, in an interactive terminal session only: a long turn done, a turn stopped on an API error, an
  approval or a question waiting, Claude Code's other notifications, a failed Bash command, a compaction, and the rate
  limits at 85% and 90%. Desktop notifications are skipped while the terminal app is in front.

## Install

```bash
claude plugin install aidrian@aidrian-harness
claude plugin install aidrian-mod@aidrian-harness
```

A status line that runs the aidrian status line fallback shows the same data as the band: remove that `statusLine`
from `~/.claude/settings.json`. Any other status line can stay.

## Settings

Each is a row of Claude Code's config menu:

- `mode`: `live` sends notifications, `shadow` only logs them.
- `notifyMinTurnSeconds`: turns shorter than this end without a notification.
- `focusCheck`, `focusApp`: skip desktop notifications while the app named `focusApp` (default `kitty`) is in front.
- `sounds`, `volume`.
- `ticketPrefixes`: pipe-separated issue key prefixes found in the branch name, such as `ABC|XY`. A key they match
  is looked up in Linear for its title and state. Empty reads a GitHub `#N` from a `<type>/<N>-slug` branch, shown as it is.
- `cacheTtlSeconds`: used until the transcript shows the real cache length.

## Safety

- Every process the mod starts runs by an absolute path, never through a shell: `node` for the snapshot and `git` for
  the branch, from PATH folders outside the session's folder, and `/usr/bin/osascript` with one constant script for the
  focus check. Its PATH holds only those folders whose `git` and `gh`, which the snapshot runs by name, are absent or
  resolve outside the session's folder too; a folder whose lookup is denied, or whose real path holds `:`, is dropped.
  `focusApp` is only compared with what that script prints.
  It reads files, the transcript included, through Claude Code, with no program.
- The branch read passes `--no-optional-locks` and `-c core.fsmonitor=false` to git, so it takes no lock and starts no
  fsmonitor program. A repository's own configured filter drivers can still run, as in Claude Code's own start-up
  status read.
- The focus check asks macOS for the app in front through System Events, which needs the terminal app's Automation
  permission for System Events. Without it the check finds no app, and every desktop notification is sent.
- The mod runs the `lib/cli.mjs` of the `aidrian` plugin installed for the folder, from Claude Code's plugin cache,
  and only while it is enabled there. With the plugin enabled but no entry for the folder, or when the mod runs outside
  a plugin cache, as with `--plugin-dir`, it runs instead the `lib/cli.mjs` beside an `aidrian` command on a checked
  PATH folder: a regular file, not a link, below that plugin folder, and outside the session's folder.
- Every text it draws or notifies passes one filter that removes control, format, and bidi characters. A link is drawn
  only for a pull request URL that matches its row, or the Linear page of the ticket looked up.
- Its one MCP call is `get_issue` with the ticket key. Nothing it reads reaches the model.
- It starts no process before Claude Code trusts the session's folder: on Claude Code 2.1.327, a session in a folder
  never trusted runs no mod hook while the trust dialog is open.

## Limits

- On a machine with managed settings, Claude Code does not pass its `classic.*` hook events to plugins a person
  installs. Approval prompts and idle reminders then send no notification.
- The blank row between the band and the prompt belongs to Claude Code. A mod cannot remove it.
- A subagent's context window is taken to be 200k tokens unless its model name includes `[1m]`.

## Development

```bash
claude plugin validate plugins/aidrian-claude-mod
claude plugin test plugins/aidrian-claude-mod
node --test --import ./scripts/test-state.mjs test/claude-mod-format.test.mjs
```

The sounds are CC0 1.0 samples from Freesound pack 44741. See `sounds/CREDITS.md`.
