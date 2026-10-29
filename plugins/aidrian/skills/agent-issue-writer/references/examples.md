# Agent Issue Writer Examples

Use these as formatting references. Keep the structure, specificity, Linear focus, and contract discipline.

## Standalone Issue Example

Title: `[insights-v2] Add insights overview types and aggregation helpers`

Body excerpt:

```md
## Size

S

One bounded helper/types addition with colocated tests and no rollout sequencing.

## Scope

- Create `src/lib/insights/types/insights-overview.ts` with the shared API response contract.
- Create pure helpers in `src/lib/insights/helpers/` for KPI, volume, attribution, and breakdown aggregation.
- Add colocated tests for each helper using `buildOrder` fixtures from `src/tests/fixtures/`.

## Tasks

- Add the shared overview response type in `src/lib/insights/types/insights-overview.ts`.
- Add KPI, volume, attribution, and breakdown aggregation helpers in `src/lib/insights/helpers/`.
- Add colocated helper tests using fixtures from `src/tests/fixtures/`.

## Non-goals

- Do not build UI components.
- Do not add database queries or route handlers.

## Dependencies & Sequencing

- depends on: `none`
- PR group: `none`
- target branch: `main`
- merge after: `none`
- merge is production deployment: `true`

## Tracker Metadata

- labels: `feature`, `insights`
- Linear Project: `none`
- parent issue: `none`
- Priority: `Medium` (feature, inferred)
- Effort: `Low` (Size S → Low)

## Agent Action Plan

Compact mode with:
- planning owner: `initiative-agent`
- execution owner: `backend-developer`
- review owners: `code-reviewer`
- validation owners: `code-reviewer`

## Verification

- `npm run typecheck`
- `npm run lint`
- `npx jest src/lib/insights --no-coverage`
- `not_required` for e2e
```

## Parent Issue Example

Title: `[subscriptions] Soft-cancel rollout and data-integrity hardening`

Body excerpt:

```md
## Initiative Shape

- topology: `tracker_project_plus_parent_issue`
- canonical release-plan artifact: `this parent issue`

## Success Criteria

- [ ] Subscription cancellation no longer deletes rows in production paths.
- [ ] Soft-cancel behavior ships before restrictive FK changes.
- [ ] All migration-carrying PR groups document merge gates before landing on `main`.

## Issue Tree

- `cancel-hotfix` `[subscriptions] Stop physical deletion of subscription rows` size `S` - immediate data-loss stopgap
- `soft-cancel-foundation` `[subscriptions] Add clearOrganizationSubscriptionPointer` size `S` - prerequisite mutation helper
- `fk-restrict` `[subscriptions] Change FK to ON DELETE RESTRICT` size `S` - final high-risk migration

## PR & Merge Plan

| PR Group | Issues | Target Branch | Merge After | Risk | Migrations |
| --- | --- | --- | --- | --- | --- |
| `hotfix` | `cancel-hotfix` | `main` | `none` | `low` | `0` |
| `foundation` | `soft-cancel-foundation` | `main` | `hotfix` | `low` | `0` |
| `fk-restrict` | `fk-restrict` | `main` | `foundation` | `high` | `1` |

Merge into `main` is production deployment for every group above.

`fk-restrict` deployment gates:
- soft-cancel handler is live in production before merge
- rollback migration is prepared before merge
```

## Initiative Child Issue Example

Title: `[orders] Fix default delivery day when holiday overrides skip today`

Body excerpt:

```md
## Context

Part of the delivery-days initiative. This issue fixes the default-day regression before the follow-up UI polish issue can ship.

## Size

S

One bounded delivery-date logic fix with focused regression coverage.

## Scope

- Update the default-day selection logic to choose the first day open for delivery.
- Add regression coverage for closed-today and open-tomorrow scenarios.

## Tasks

- Update the default-day selection logic to skip closed-today and choose the first day open for delivery.
- Add regression coverage for closed-today and open-tomorrow scenarios.

## Dependencies & Sequencing

- depends on: `none`
- PR group: `delivery-default-day`
- target branch: `main`
- merge after: `none`
- merge is production deployment: `true`

## Tracker Metadata

- labels: `bug`, `orders`
- Linear Project: `Delivery Days Reliability`
- parent issue: `ABC-1234`
- depends on: `none`
- Priority: `Medium` (bug, inferred)
- Effort: `Low` (Size S → Low)

## Agent Action Plan

Compact mode with:
- planning owner: `initiative-agent`
- execution owner: `frontend-developer`
- review owners: `code-reviewer`, `frontend-developer`
- validation owners: `e2e-runner`
```

## L Split Alert Example

Title: `[billing] Replace subscription cancellation pipeline`

Body excerpt:

```md
## Size

L

Red alert: this issue is still `L` after planning because the webhook cutover and FK migration are intentionally being drafted together for user review.

Split candidates considered:
- split webhook handler cutover into its own `M` issue
- split FK restriction migration into its own `S` migration issue

Why not split yet:
- the user explicitly asked for one review artifact before issue creation, so this draft is a temporary planning hold and must be decomposed before execution issues are published
```

## Blocked Example

```md
Blocked because:
- The target route and owning module for the payment retry flow were not identified from the repo.

Missing information:
- Exact endpoint or page responsible for retrying failed prepayments.

Recommended repo paths to inspect:
- `src/app`
- `src/lib/payments`
- `docs/knowledge/product/product-rules.md`

Questions to unblock:
- Which payment retry surface should this issue target?
```

## Standalone Action Plan JSON Example

```json
{
  "mode": "compact",
  "orchestrator_required": false,
  "planning_owner": "initiative-agent",
  "execution_owner": "backend-developer",
  "review_owners": ["code-reviewer"],
  "validation_owners": ["code-reviewer"],
  "required_authority_docs": {
    "execution": [
      "docs/knowledge/engineering/working-agreement.md",
      "docs/knowledge/engineering/safety-rules.md",
      "docs/knowledge/engineering/code-style.md",
      "docs/knowledge/engineering/testing.md"
    ],
    "review": [
      "docs/knowledge/engineering/working-agreement.md",
      "docs/knowledge/engineering/safety-rules.md",
      "docs/knowledge/engineering/code-style.md",
      "docs/knowledge/engineering/testing.md"
    ],
    "validation": [
      "docs/knowledge/engineering/working-agreement.md",
      "docs/knowledge/engineering/safety-rules.md",
      "docs/knowledge/engineering/testing.md"
    ]
  },
  "deliverables": [
    "add the shared insights overview type",
    "add aggregation helpers with colocated tests"
  ],
  "verification_flow": [
    "npx jest src/lib/insights --no-coverage",
    "npm run typecheck",
    "npm run lint"
  ],
  "escalation_triggers": [
    "the existing insights helpers cannot be reused cleanly",
    "the issue grows beyond a single reviewable PR"
  ],
  "required_agents": ["backend-developer", "code-reviewer"],
  "agent_responsibilities": [
    {
      "agent": "code-reviewer",
      "responsibility": "Confirm helper reuse, test coverage, and repo-pattern compliance."
    }
  ],
  "handoff_order": ["backend-developer", "code-reviewer"],
  "review_chain": ["code-reviewer"],
  "validation_chain": ["code-reviewer"],
  "approval_gates": [
    {
      "id": "execution-complete",
      "phase": "execution",
      "owners": ["backend-developer"],
      "requires": [
        "handoff_complete",
        "required_authority_docs_loaded",
        "commands_reported",
        "tests_reported",
        "docs_status_reported"
      ]
    },
    {
      "id": "review-signoff",
      "phase": "review",
      "owners": ["code-reviewer"],
      "requires": [
        "handoff_complete",
        "required_authority_docs_loaded",
        "no_fix_now_findings"
      ]
    },
    {
      "id": "validation-signoff",
      "phase": "validation",
      "owners": ["code-reviewer"],
      "requires": [
        "handoff_complete",
        "required_authority_docs_loaded",
        "verification_passed"
      ]
    }
  ]
}
```

## Security Action Plan JSON Example

```json
{
  "mode": "expanded",
  "orchestrator_required": false,
  "planning_owner": "initiative-agent",
  "execution_owner": "backend-developer",
  "review_owners": ["security-engineer", "code-reviewer"],
  "validation_owners": ["security-engineer"],
  "required_authority_docs": {
    "execution": [
      "docs/knowledge/engineering/working-agreement.md",
      "docs/knowledge/engineering/safety-rules.md",
      "docs/knowledge/engineering/code-style.md",
      "docs/knowledge/engineering/testing.md"
    ],
    "review": [
      "docs/knowledge/engineering/working-agreement.md",
      "docs/knowledge/engineering/safety-rules.md",
      "docs/knowledge/engineering/code-style.md",
      "docs/knowledge/engineering/testing.md"
    ],
    "validation": [
      "docs/knowledge/engineering/working-agreement.md",
      "docs/knowledge/engineering/safety-rules.md",
      "docs/knowledge/engineering/testing.md"
    ]
  },
  "deliverables": [
    "harden the inbound webhook trust boundary",
    "add regression coverage for signature verification and replay rejection"
  ],
  "verification_flow": [
    "npx jest src/app/api/payments --no-coverage",
    "npm run typecheck",
    "npm run lint"
  ],
  "escalation_triggers": [
    "the webhook provider contract is undocumented",
    "the fix requires a product decision about customer-visible failure handling"
  ],
  "required_agents": ["backend-developer", "security-engineer", "code-reviewer"],
  "agent_responsibilities": [
    {
      "agent": "security-engineer",
      "responsibility": "Review exploitability, trust-boundary controls, and security-hardening completeness."
    },
    {
      "agent": "code-reviewer",
      "responsibility": "Confirm repo-pattern compliance after security review signoff."
    }
  ],
  "handoff_order": ["backend-developer", "security-engineer", "code-reviewer"],
  "review_chain": ["security-engineer", "code-reviewer"],
  "validation_chain": ["security-engineer"],
  "approval_gates": [
    {
      "id": "execution-complete",
      "phase": "execution",
      "owners": ["backend-developer"],
      "requires": [
        "handoff_complete",
        "required_authority_docs_loaded",
        "commands_reported",
        "tests_reported",
        "docs_status_reported"
      ]
    },
    {
      "id": "review-signoff",
      "phase": "review",
      "owners": ["security-engineer", "code-reviewer"],
      "requires": [
        "handoff_complete",
        "required_authority_docs_loaded",
        "no_fix_now_findings"
      ]
    },
    {
      "id": "validation-signoff",
      "phase": "validation",
      "owners": ["security-engineer"],
      "requires": [
        "handoff_complete",
        "required_authority_docs_loaded",
        "verification_passed"
      ]
    }
  ]
}
```

## Initiative Contract JSON Example

```json
{
  "schema_version": "2.0",
  "tracker": "linear",
  "initiative_title": "[delivery-days] Default day reliability",
  "initiative_goal": "Ship the delivery-days default-day fix with explicit multi-agent review and validation ownership.",
  "topology": "parent_issue_only",
  "create_linear_project": false,
  "create_parent_issue": true,
  "parent_issue_is_canonical_release_plan": true,
  "success_criteria": [
    "Default-day selection uses the first day open for delivery.",
    "The issue tree encodes explicit review and validation defaults."
  ],
  "issue_order": ["default-day-fix", "ux-follow-up"],
  "dependencies": [
    {
      "from": "ux-follow-up",
      "to": "default-day-fix",
      "type": "depends_on",
      "reason": "The UX follow-up relies on the logic fix landing first."
    }
  ],
  "pr_release_plan": {
    "groups": [
      {
        "key": "delivery-default-day",
        "title": "Default selected day fix",
        "summary": "Land the default-day logic fix before the UI follow-up.",
        "issue_keys": ["default-day-fix"],
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
      "key": "default-day-fix",
      "title": "[orders] Fix default delivery day when holiday overrides skip today",
      "issue_type": "bug",
      "goal": "Choose the first day open for delivery when a holiday override closes today.",
      "size": {
        "tshirt": "S",
        "rationale": "One bounded delivery-date logic fix with focused regression coverage.",
        "split_alert": null,
        "split_candidates": []
      },
      "scope": [
        "Update the default-day selection logic to choose the first day open for delivery.",
        "Add regression coverage for closed-today and open-tomorrow scenarios."
      ],
      "tasks": [
        "Patch the default-day selection logic.",
        "Add focused regression coverage."
      ],
      "non_goals": [
        "Do not change the delivery-days UI."
      ],
      "dependencies": [],
      "sequencing": {
        "pr_group": "delivery-default-day",
        "target_branch": "main",
        "merge_after": [],
        "merge_is_deploy": true,
        "deployment_gates": []
      },
      "default_execution_owner": "frontend-developer",
      "default_review_owners": ["code-reviewer", "frontend-developer"],
      "default_validation_owners": ["e2e-runner"],
      "requires_orchestrator": false
    }
  ]
}
```
