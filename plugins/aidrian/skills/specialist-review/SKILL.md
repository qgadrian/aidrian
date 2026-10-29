---
name: specialist-review
description: One agent's focused review of the current branch's diff and uncommitted changes, kept warm for follow-up questions. Not a pull request review.
---

# specialist-review

Run one agent's review of the current branch: its commits since the base, plus tracked changes not yet committed.
The agent stays available afterwards, so the user can discuss its findings with it.
For a review of a pull request by several agents, use the `pr-review` skill.

Spawn the project's agent of that name when the host lists one; otherwise spawn this plugin's agent,
as `aidrian:<name>` in Claude Code and `aidrian-<name>` in Codex.
The agent loads its own knowledge; this skill reads only the project's `issue_tracker` knowledge, to find the linked issue.

## Arguments

```text
<agent> [--base <ref>] [--full] [--fresh] [--stop] [--stop-all]
```

| Argument | Effect |
| --- | --- |
| `<agent>` | The reviewer, by agent name. Short forms: `arch`, `backend`, `design`, `pm`, `ux`, `security`. |
| `--base <ref>` | Compare against this ref instead of `origin/<defaultBranch>`. |
| `--full` | Send the whole diff, even past 50 files or 2,000 lines. |
| `--fresh` | Forget the kept agent for this branch and agent, and spawn a new one. |
| `--stop` | Forget the kept agent for this branch and agent. Spawn nothing. |
| `--stop-all` | Forget every kept agent for this branch. Spawn nothing; `<agent>` is optional. |

`references/lenses.md` has a lens for `architect`, `backend-developer`, `designer`, `product-manager`, `ux-specialist`,
and `security-engineer`. Any other agent, such as a project's own reviewer, gets the generic lens there.
When neither the project nor this plugin has an agent of that name, stop and list the names the host shows.

## State

`<state>/reviews/specialist-agents.json`, where `<state>` is the folder `aidrian state` prints, keeps one entry per warm agent,
keyed `<branch>:<agent>`:

```json
{
  "feat/search:architect": {
    "agent_id": "a1b2c3d4", "agent": "architect", "branch": "feat/search",
    "base_sha": "<merge base>", "head_sha": "<head at the last review>",
    "created_at": "<ISO 8601>", "last_used_at": "<ISO 8601>"
  }
}
```

- A missing or unreadable file counts as empty. Write the whole file to a temporary file, then rename it over the old one.
- An entry is a hint, not a promise: the agent may have ended with its session. Then the skill spawns a new one.

## Procedure

### 1. Scope

Read `references/scope-resolver.md` and follow it.
On `blocked`, render the blocked block from `references/render.md` and stop.
On `nothing_to_review`, render the empty block and stop without a spawn.

### 2. State and flags

Read the state file, then take the first line that applies:

- `--stop`: delete `<branch>:<agent>`, write the file, render the stopped block, and stop.
- `--stop-all`: delete every entry that starts with `<branch>:`, write the file, render the stopped block with each key, and stop.
- `--fresh`: delete `<branch>:<agent>` and go to 3a.
- An entry whose `head_sha` differs from the current head, with `diff_lines` under 2,000: go to 3b.
- Anything else goes to 3a: no entry, the same head (the user asked for a new look),
  or a diff too large to send again to an agent that already holds the last one.

### 3a. Cold spawn

Read `references/lenses.md` and build the cold brief with the agent's lens and brief shape. Spawn the agent with it.

Claude Code ends an agent's first reply with `agentId: <id>`. Capture `<id>` and write the entry,
with `created_at` and `last_used_at` set to now.
Without an id (Codex, or a reply without that line), note `agent id not captured`:
the review stands, and the next run spawns a new agent.

### 3b. Warm refresh

Send the refresh message from `references/lenses.md` to the stored `agent_id` with the host's message tool
(`SendMessage` in Claude Code), and wait for the agent's reply.
When the host says no agent has that id, delete the entry, note `warm reuse failed`, and go to 3a.
On a reply, set the entry's `head_sha` and `last_used_at`.

### 4. Render

Compute each finding's verdict from the agent's own axes:

```bash
aidrian pr disposition --severity <s> --likelihood <l> --affects <a> [--cost <c>]
```

A finding without `likelihood` or `affects` gets `needs_axis`; never fill in an axis for the agent.
Then render with `references/render.md`: the findings in the order to fix them, and the agent's status as it returned it.

## Invariants

- Read-only on git: no stage, commit, push, or branch switch. No verification commands, and no other agents.
- Relay the agent's status, axes, and words as it returned them. `needs_input` and `blocked` are not a finished review.
- Print the agent id whenever there is one: follow-up questions reach the agent through it.
- A follow-up question about a finding goes straight to the kept agent; the skill does not run again for it.
