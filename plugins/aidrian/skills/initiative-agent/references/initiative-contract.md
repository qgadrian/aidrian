# Initiative Contract Schema

The shape of the `initiative_contract` and its `issue_blueprints`, with the rules every contract must meet.

```json
{
  "schema_version": "2.0",
  "tracker": "linear",
  "initiative_title": "[tasks] Rescheduling reliability rollout",
  "initiative_goal": "Ship the task rescheduling fixes in reviewable units with explicit review and validation ownership.",
  "topology": "tracker_project_plus_parent_issue",
  "create_tracker_project": true,
  "create_parent_issue": true,
  "parent_issue_is_canonical_release_plan": true,
  "success_criteria": [
    "Order reassignment fixes ship without violating monitoring, testing, or sequencing contracts."
  ],
  "issue_order": ["reassignment-fix", "validation-hardening"],
  "dependencies": [
    {
      "from": "validation-hardening",
      "to": "reassignment-fix",
      "type": "depends_on",
      "reason": "Validation hardening depends on the core reassignment fix landing first."
    }
  ],
  "pr_release_plan": {
    "groups": [
      {
        "key": "reassignment-core",
        "title": "Order reassignment fix",
        "summary": "Land the bounded task mutation fix before the follow-up validation work.",
        "issue_keys": ["reassignment-fix"],
        "target_branch": "main",
        "merge_after": [],
        "merge_is_deploy": true,
        "risk": "low",
        "migration_count": 0,
        "deployment_gates": []
      }
    ]
  },
  "issue_blueprints": [
    {
      "key": "reassignment-fix",
      "title": "[tasks] Reschedule a task after a due date edit",
      "issue_type": "feature",
      "goal": "Ensure editing a task's due date re-runs scheduling when the task has no slot in the new window.",
      "size": {
        "tshirt": "S",
        "rationale": "One bounded task mutation fix with focused regression coverage.",
        "split_alert": null,
        "split_candidates": []
      },
      "scope": [
        "Update the task mutation to reuse the existing scheduling helper after date edits.",
        "Add focused regression coverage for the reassignment branch."
      ],
      "tasks": [
        "Patch the existing task mutation code path.",
        "Add or update colocated Jest coverage."
      ],
      "non_goals": [
        "Do not change customer-facing checkout flows."
      ],
      "dependencies": [],
      "sequencing": {
        "pr_group": "reassignment-core",
        "target_branch": "main",
        "merge_after": [],
        "merge_is_deploy": true,
        "deployment_gates": []
      },
      "default_execution_owner": "backend-developer",
      "default_review_owners": ["code-reviewer", "backend-developer"],
      "default_validation_owners": ["code-reviewer"],
      "requires_orchestrator": false,
      "priority": "Medium",
      "effort": "Low"
    }
  ]
}
```

Rules:

- `tracker` is the tracker the `issue_tracker` knowledge names: `linear`, `github`, or another.
- `topology` must be `single_issue`, `parent_issue_only`, or `tracker_project_plus_parent_issue`.
- Each `issue_blueprint` may include optional `priority` and `effort` fields. When present, `agent-issue-writer` uses them directly.
  When absent, `agent-issue-writer` applies its default Priority inference rule and Size→Effort derivation rule to fill the gap. Valid values:
  `priority` = `Urgent | High | Medium | Low`; `effort` = `High | Medium | Low`.
- Blueprints set no priority or effort labels.
  `agent-issue-writer` sets Priority and Effort where the tracker keeps them, as its `references/issue-body.md` § Issue Fields says,
  and mirrors Effort in the issue body.
- `parent_issue_is_canonical_release_plan` must be `true` whenever the topology includes a parent issue.
- `issue_blueprints` must be ordered for creation and execution.
- Every `issue_blueprint` must include `size`, `tasks`, and `sequencing`.
- `pr_release_plan.groups` must be creation-order and merge-order complete for any multi-issue initiative.
- If `sequencing.target_branch` is `main`, then `merge_is_deploy` must be `true`.
- `deployment_gates` must be empty for low-risk code-only groups and populated only when the merge has medium/high production risk, migrations, or
  irreversible side effects.
- `requires_orchestrator` should be `true` only when runtime execution requires explicit multi-agent coordination.
- `default_review_owners` must always include `code-reviewer`.
- `default_validation_owners` must include at least one owner outside the execution role.
- Add `security-engineer` to `default_review_owners` only for security-triggered child issues.
- Add `security-engineer` to `default_validation_owners` only when the child issue is primarily a security fix or hardening task and `e2e-runner` is not
  the main validation owner.
- When both `security-engineer` and `code-reviewer` are default review owners, the eventual `review_chain` should place `security-engineer` before
  `code-reviewer`.
