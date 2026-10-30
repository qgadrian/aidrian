# Design-import plans (`plan_kind: technical-design`)

Read this with `references/plan-file.md` when the `design-import` skill dispatched you to write a design-import plan.
Everything in `references/plan-file.md` applies, except the two changes below.

## Frontmatter variant

Design-import plans authored by the `design-import` skill have no GitHub
issue, so the `issue_*` fields do not apply. They use this frontmatter shape
instead. File path convention: `docs/design-imports/<slug>/plan.md`.

```yaml
---
design_slug: "dashboard-v3"          # the design-import slug; matches docs/design-imports/<slug>/
bundle_ref: "tmp/dashboard-v3"       # the resolved Claude Design bundle path (folder or zip) the import was built from
variant: "v2-compact"                # the chosen generation/variant id, from the design-import --variant choice
generated_at: "2026-05-21T14:30:00Z" # ISO 8601 UTC, when the plan was authored
status: "ready"                      # one of: open-questions | ready | in-progress | complete | blocked
workspace_decision:
  mode: "worktree"                   # one of: current_branch | new_branch | worktree
  branch_name: "feat/design-dashboard-v3" # feat/design-<slug>: the branch the design-import skill committed the import on
  worktree_path: "<repo>/.worktrees/design-dashboard-v3"  # only when mode == worktree; absolute, as aidrian worktree new printed it
  rationale: "the import and its implementation share one task worktree"
plan_kind: "technical-design"        # fixed for design-import plans; re-runs keep this value (never flip to revision)
related_plans: []                    # other plan paths that depend on or supersede this one
---
```

The `issue_id`, `issue_ref`, and `ticket_updated_at` fields are omitted for
design-import plans — there is no tracker issue and therefore no staleness
signal. The `design_slug` / `bundle_ref` / `variant` fields carry the
design-import context in their place.

## Slice variant

A design-import slice has no acceptance criteria; it covers a screen (or the
shell/nav). Replace `acceptance_criteria_covered` with `screens_covered` — a
list of screen IDs from the design import's `inventory.md` screen→route
mapping (e.g. `["home-v2", "settings-v2"]`); a shell/nav slice may use a
sentinel such as `["shell"]`. All other per-slice fields are unchanged.

```yaml
screens_covered:
  - "home-v2"                    # screen IDs from docs/design-imports/<slug>/inventory.md
```
