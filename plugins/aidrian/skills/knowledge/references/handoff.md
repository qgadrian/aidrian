# Machine handoff: optional fields

Add a field only when your role emits it or the dispatch asks for it. Use these exact names.

- `findings[]` (reviewers, developers in review mode, `security-engineer`, `product-manager`), or `[]` when none:
  `severity`, `likelihood`, `affects`, `cost` (`aidrian pr disposition --vocab` defines each word),
  `file`, `line`, `violated_rule`, `summary` (the impact), and `next_step` (the fix direction).
  A finding never carries its own disposition.
- `sign_off`: `approved` or `blocked` (`architect` and `product-manager` may also return `needs_evidence`).
  `approved` only when `findings` is empty or every finding is severity `low`; otherwise `blocked`.
  The dispatcher runs `aidrian pr disposition` on each finding; its `fix_now` result decides what gets fixed and wins over `sign_off`.
- `critical_flow[]` (`product-manager`): `{flow, planning_artifact_confirmed, mandatory_review_confirmed, sign_off}`, one per touched flow.
  A gate passes only when every `critical_flow[].sign_off` is `approved`.
- `pending_commit` (any agent dispatched not to commit): each changed file; the dispatcher compares it to `git status --porcelain`.
- `dirty_handoff` (developers): uncommitted changes with no reason when the dispatch asked for a commit.
- `commands_run` (developers, `integrator`, `e2e-runner`, `helper-scout`, `github-archaeologist`): the exact commands run.
- `compliance` (developers: `not_bypassed` or `hook_failed`; `product-manager`, `architect`: each rule and whether it holds).
- `defer_reason`: `non_goals_collision`, `confirmed_missing_authority`, `human_only`, or `user_chose`, on a finding deferred to a new issue.
- `decision_options` (when the Human must choose): `id`, `summary`, `tradeoffs`, `recommended` (advisory).
