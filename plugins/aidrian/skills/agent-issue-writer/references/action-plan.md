# Agent Action Plan and project defaults

The JSON block every issue body ends with, and the defaults for owners, verification, and authority docs.

## Agent Action Plan Schema

```json
{
  "mode": "expanded",
  "orchestrator_required": true,
  "planning_owner": "initiative-agent",
  "execution_owner": "backend-developer",
  "review_owners": ["code-reviewer", "backend-developer"],
  "validation_owners": ["e2e-runner"],
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
      "docs/knowledge/engineering/testing.md",
      "docs/knowledge/engineering/e2e.md"
    ]
  },
  "deliverables": ["implement the scoped order reassignment fix"],
  "verification_flow": [
    "<the test command the testing knowledge names, narrowed to the order reassignment tests>",
    "<its type check>",
    "<its lint>",
    "<its e2e command, narrowed to the order reassignment flow>"
  ],
  "escalation_triggers": [
    "required authority docs conflict",
    "product-sensitive behavior is undocumented"
  ],
  "required_agents": ["backend-developer", "code-reviewer", "e2e-runner"],
  "agent_responsibilities": [
    {
      "agent": "code-reviewer",
      "responsibility": "Perform final type and repo-pattern review."
    },
    {
      "agent": "e2e-runner",
      "responsibility": "Run affected-flow e2e validation and report failures."
    }
  ],
  "handoff_order": ["backend-developer", "code-reviewer", "e2e-runner"],
  "review_chain": ["code-reviewer", "backend-developer"],
  "validation_chain": ["e2e-runner"],
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
      "owners": ["code-reviewer", "backend-developer"],
      "requires": [
        "handoff_complete",
        "required_authority_docs_loaded",
        "no_fix_now_findings"
      ]
    },
    {
      "id": "validation-signoff",
      "phase": "validation",
      "owners": ["e2e-runner"],
      "requires": [
        "handoff_complete",
        "required_authority_docs_loaded",
        "verification_passed"
      ]
    }
  ]
}
```

Rules:

- Compact mode must fill the first eight fields and include at least one approval gate.
- Expanded mode must fill every array that applies and must define the review and validation sequence explicitly when more than one owner participates.
- `orchestrator_required` should be `true` only when runtime execution needs explicit coordination across multiple specialist agents.
- Every action plan must include at least one review owner, one validation owner, and one approval gate owned by an agent outside the execution role.
- `required_authority_docs` must name authoritative repo docs only. Code, tests, fixtures, and source modules belong in `Repository Context`.

## Project Defaults

The project's `issue_tracker`, `testing`, `e2e`, and `product_sensitive` knowledge overrides every default below.

- Always set Priority and Effort on every created issue, where the tracker keeps them, and mirror Effort in the issue body
  (Issue Fields in `references/issue-body.md`). Defaults when not explicitly supplied:
  - Priority: infer from issue type (critical-flow/security → `High`; hotfix → `Urgent`; bug/feature → `Medium`; docs/chore/refactor → `Low`; unclear →
    `Medium`)
  - Effort: derive from Size t-shirt (`XS` and `S` → `Low`; `M` → `Medium`; `L` → `High`)
- `tracker_fields.labels` carries domain/work-type labels, plus on GitHub the priority and effort labels the `issue_tracker` knowledge names.
- Default verification is the project's typecheck, lint, and the exact test command for the affected files, as its `testing` knowledge names them.
- If the change touches sign-in, onboarding, payments, admin, or other user-facing lifecycle behavior and unit tests cannot prove correctness, require
  exact e2e coverage.
- In initiative work, make the parent issue the canonical sequencing artifact and keep project artifacts as short tracking pointers.
- Use repo conventions:
  - colocated tests, when the project's `testing` knowledge uses them
  - existing fixtures and builders that knowledge names
  - authoritative docs from the project's knowledge buckets and linked product docs
- Default owner routing should be deterministic, using the roles the project has:
  - always include `code-reviewer` in `review_owners`
  - add `security-engineer` to `review_owners` for auth, authorization, sessions, tokens, org membership, tenant isolation, public trust boundaries,
    payments, billing, inbound webhooks, exports/imports, uploads/downloads, redirects, unsafe external content, or explicit security review tasks
  - add `backend-developer` to `review_owners` for backend runtime, API, jobs, auth, database, or data-integrity work
  - add `frontend-developer` to `review_owners` for UI rendering, state, cache, or hydration work
  - add `product-manager` to `review_owners` only for product-sensitive behavior changes
  - use `e2e-runner` in `validation_owners` whenever the issue requires affected-flow e2e proof
  - use `security-engineer` in `validation_owners` when the issue is primarily a security fix or hardening task and affected-flow e2e proof is not the main
    validation gate
  - otherwise use an independent technical reviewer in `validation_owners`; the execution owner alone must never satisfy the final validation gate
  - when both `security-engineer` and `code-reviewer` are in `review_owners`, put `security-engineer` first in `review_chain` and keep `code-reviewer` in
    the chain as the final general repo-consistency reviewer
- Default authority-doc loading should be explicit in `required_authority_docs`: list the knowledge docs each owner needs,
  as `aidrian-knowledge route <tags>` prints them for that owner's tags.
  - execution and review: the `always` docs plus `code_style` and `testing`
  - security review/validation: the same docs as review, plus `product_sensitive` when the work is product-sensitive
  - e2e validation: add `e2e`
  - product-sensitive work: add `product_sensitive` and the exact scoped product doc
