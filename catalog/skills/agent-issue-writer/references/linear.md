# Linear Publishing Rules

Use this reference when converting a concrete issue blueprint into Linear-native artifacts. See `docs/ai-rules/shared/issue-tracker.md` for the full tracker abstraction (active tracker, transition rules, priority mapping, magic-word grammar, status taxonomy) — this doc covers only the tool-call mechanics specific to publishing.

## Native Hierarchy

- Use a real Linear issue (`save_issue`) for executable work.
- Use a parent issue (a `save_issue` call with no `parentId`) when one initiative groups multiple execution issues.
- Set `parentId` on each child issue's `save_issue` call to represent the parent/child hierarchy — Linear's native sub-issue mechanism.
- Use `blockedBy` / `blocks` on `save_issue` for blocking relationships. Both are append-only: a later call adds relations, it never removes ones set by an earlier call. Use `removeBlockedBy` / `removeBlocks` to remove one explicitly.
- Use a Linear Project (`save_project`) when the initiative needs board or roadmap tracking across multiple issues.
- Keep the full issue tree and `PR & Merge Plan` on the parent issue's Markdown body — a Linear Project's `description`/`summary` has no equivalent for this level of prose detail.
- Keep the Linear Project's `description`/`summary` short and pointed back to the parent issue.

## Publishing Order

1. Create the Linear Project first (`save_project`, `name` + `addTeams: ["{{slot:project_name_lower}}"]`) when the initiative needs one.
2. Create the parent issue next (`save_issue`, `team: "{{slot:project_name_lower}}"`) when the initiative has child issues.
3. Create execution issues after the parent issue exists, setting `parentId` to the parent issue's id or key (e.g. `{{slot:tracker_team_key}}-123`).
4. Set `blockedBy` / `blocks` on each child issue's `save_issue` call for dependency links.
5. Set `project` on every execution issue's `save_issue` call to add it to the Linear Project.

## Merge And Deployment Semantics

- Treat merge into `main` as production deployment.
- For `main`-targeting issues, record merge order instead of inventing a separate deploy order.
- If a PR targets a base PR or non-`main` branch first, preserve that target in the issue body
  so intermediate merges are not mistaken for production release.

## Tracker Metadata Expectations

Always preserve these values in both native Linear fields and the issue body when possible:

- labels (domain/work-type only — see Label Rules below)
- Linear Project name or `none`
- parent issue reference (`parentId`) or `none`
- cycle (optional)
- milestone
- assignee
- dependency links (`blockedBy` / `blocks`)
- size
- PR group key
- target branch
- merge sequencing
- deployment gates when required
- Priority issue field (native `priority`, always set — see below)
- Effort issue field (native `estimate`, always set, and mirrored in Tracker Metadata prose — see below)

If a native field cannot be populated in the current runtime, keep it in the Markdown `Tracker Metadata` section.

## Priority (native Linear field)

Linear's native `priority` is an integer set directly on `save_issue(priority: <0-4>)` — there is no separate post-creation step and no org-level GraphQL mutation. Map `issue_fields.priority` 1:1:

| `issue_fields.priority` | native `priority` |
|---|---|
| Urgent | 1 |
| High | 2 |
| Medium | 3 |
| Low | 4 |

(Full mapping rationale: `docs/ai-rules/shared/issue-tracker.md` § Priority and estimate.)

Always set `priority` on every `save_issue` call that creates an issue.

## Effort (native Linear `estimate` field)

Team `{{slot:tracker_team_key}}` uses Linear's **t-shirt estimation scale**, so effort has a native home: `save_issue`'s `estimate` parameter. Map the issue's `## Size` straight onto it:

| `## Size` | `issue_fields.effort` | `save_issue(estimate:)` | Renders in Linear as |
|---|---|---|---|
| XS | Low | 1 | XS |
| S | Low | 2 | S |
| M | Medium | 3 | M |
| L | High | 5 | L |

`estimate` is a plain parameter on the same `save_issue` call that creates the issue — never a separate follow-up call.
Set it on **every** created issue, and also keep the Effort line in the Markdown `Tracker Metadata` section
(the body prose and the native field must agree).

The scale also exposes `8` (XL), but the `## Size` vocabulary stops at `L` — do not emit `8` or any value outside the table.
`L` is the ceiling that forces a split justification, so a larger tier would sanction what that rule exists to prevent;
work beyond `L` is a split, not a bigger t-shirt.
`parent_issue` and `project_issue` artifacts carry no `## Size`, so they take an `estimate` only when an Effort is explicitly supplied.
On update, omitting `estimate` leaves it unchanged; passing `null` clears it.

(Verified live against team `{{slot:tracker_team_key}}` on 2026-08-04. Full rationale: `docs/ai-rules/shared/issue-tracker.md` § Priority and estimate.)

## Label Rules (domain/work-type only)

The retired `priority:*` / `effort:*` label mirror is gone — Linear's native `priority` field is already filterable, so no filterable-copy workaround is needed. `tracker_fields.labels` now carries only domain/work-type labels (`bug`, `chore`, `feature`, etc.) and is optional.

- Before creating a label, check `list_issue_labels(team: "{{slot:project_name_lower}}", name: "<label>")` for an existing match.
- If no match exists, create it with `create_issue_label(name: "<label>", teamId: "{{slot:tracker_team_id}}")` (team `{{slot:tracker_team_key}}`'s id; see `docs/ai-rules/shared/issue-tracker.md`).
- Pass label **names** (not ids) to `save_issue(labels: [...])`.
- `save_issue`'s `labels` parameter **replaces the full label set** — it is not additive. When updating an existing issue, always pass the complete desired label list (existing labels to keep plus any new ones); omitting an existing label removes it.

## Assignee

Use `assignee` (name, email, or `"me"`) — not `assigneeId`. Pass `null` to clear the assignee.

## Milestones

Use `save_milestone(project: "<project name or id>", name: "<milestone name>")` to create a Linear Project Milestone. Reference it on an issue with `save_issue(milestone: "<name>")`.

## Team resolution

`save_issue`'s `team` parameter is a scalar (team name or id, required when creating). Team `{{slot:tracker_team_key}}`'s confirmed name is `"{{slot:project_name_lower}}"` (lowercase) and id is `{{slot:tracker_team_id}}` (confirmed live via `get_team(query: "{{slot:tracker_team_key}}")`, which also resolves the `{{slot:tracker_team_key}}` key directly — but `save_issue`'s own parameter description documents only "name or id", so prefer `team: "{{slot:project_name_lower}}"` or the id over the bare `{{slot:tracker_team_key}}` key when creating an issue).

`save_project` has no scalar `team` parameter — team membership is set via `addTeams` / `removeTeams` (add or remove team names/ids) or `setTeams` (replace the full team set), as used in Publishing Order step 1 above.

## Tool reference

- `mcp__plugin_linear_linear__save_issue` — create or update an issue (`id` present = update). `team` + `title` required on create.
- `mcp__plugin_linear_linear__create_issue_label` — create a new label (`name` required; `teamId` scopes it to team `{{slot:project_name_lower}}`, omit for a workspace-level label).
- `mcp__plugin_linear_linear__list_issue_labels` — check for an existing label before creating a duplicate.
- `mcp__plugin_linear_linear__save_project` — create or update a Linear Project (`name` + `addTeams`/`setTeams` required on create).
- `mcp__plugin_linear_linear__save_milestone` — create or update a Linear Project Milestone (`project` required; `name` required on create).
