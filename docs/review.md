# Review

`aidrian pr review <PR>` reviews a pull request by a plan: what the change can affect decides how deep the review
goes, the project's critical flows add reviewers that must answer for their invariants, and the reviewers run in
stages. The `pr-review-loop` skill is a loop around it. Projects write config, never code, unless they want to.

With no config at all, a change to docs or assets gets no review, and anything else gets one pass by this machine's
engine. Everything below is optional.

## The plan

A plan has a **depth**, **stages**, and **flows**.

- **Depth** is `none`, `single`, or `split`. `split` is accepted and runs as one pass until the split executor ships;
  the summary says so.
- **Stages** run in order, and the passes inside a stage run in parallel. A stage starts only when every finding of
  the stage before it is fixed or dispositioned, and every flow it holds is signed. The defaults:
  1. `local`: the agents the plan requires, and the flow passes.
  2. `independent`: a model other than the author's, such as `codex-local`.
  3. `remote`: the review bot on the pull request.
- **Flows** are the project's critical use cases, below.

### Rules

`review.rules` sets depth and required reviewers from the diff. Every matching rule applies: the depth is the deepest
any matching rule asks for, and the required reviewers are the union. Order never matters, so a rule can never hide
another.

```json
"review": {
  "rules": [
    { "when": { "onlyFiles": ["**/*.css"] }, "depth": "none" },
    { "when": { "anyFiles": ["src/auth/**"] }, "require": ["agent:security-engineer", "independent-model"] },
    { "when": { "lines": { "over": 1500 } }, "depth": "split" }
  ]
}
```

- `when` takes `onlyFiles` (every reviewed file matches), `anyFiles` (some changed file matches), and `lines.over`
  (changed lines, not counting `review.ignore`). That is all it will ever take: anything smarter is a plan command.
- `depth: "none"` needs `onlyFiles`, so it only covers the files it names, and any rule that asks for more wins.
- `require` takes `agent:<name>` and `independent-model`. A plan that requires what this machine cannot run stops as
  `unsatisfied`; it never falls back to a weaker reviewer. So does a flow whose only reviewer would be the review bot,
  which gives no verdicts.

`review.ignore` lists files no review reads and no size counts: lockfiles, snapshots, generated, vendored, and
minified files by default. `review.nonBehaviour` lists files that cannot change behaviour: prose docs and static
assets by default. Tests are not on it: deleting a test changes what the code is held to.

## Flows

A flow is a promise the project makes about a use case or a critical surface: creating a booking, taking a payment, a
library's public API, a schema migration. A pull request that touches one gets a reviewer that must answer for each
of its invariants, with evidence, and the flow must be signed before the review passes.

```json
"review": {
  "flows": {
    "booking-creation": {
      "files": ["src/app/api/bookings/**", "src/lib/booking/**"],
      "added": ["holdSlot\\("],
      "invariants": "docs/product/booking-invariants.md",
      "require": ["agent:product-manager"],
      "tests": ["e2e/booking*"],
      "checks": ["E2E booking"]
    },
    "payments": {
      "files": ["src/lib/payments/**"],
      "added": ["service_role"],
      "invariants": [{ "id": "refund-cap", "text": "A refund never exceeds the charge." }],
      "require": ["agent:security-engineer", "independent-model"],
      "signoff": "human"
    }
  }
}
```

| Key | |
| --- | --- |
| `files` | required: globs; a changed file that can change behaviour triggers the flow |
| `added` | regular expressions over the added lines of any file, for a use that lives outside the flow's folders |
| `invariants` | a doc, whose `##` and `###` headings are the invariants, or a list of `{ id, text, cite? }` |
| `require` | the flow's reviewers; the code-reviewer agent by default |
| `tests` | the flow's tests: deleting one stops the review until it is restored or the Human accepts it |
| `checks` | check names that must be `SUCCESS` on the head; a skipped or missing one does not pass |
| `signoff` | `reviewer` (default), or `human`: the Human also signs it off with `aidrian pr signoff` |

The flow's reviewer answers every invariant `holds`, `violated`, `not_affected`, or `cannot_verify`. `holds` and
`not_affected` must cite `path:line` at the head or `test:<name>`, and the command checks that the place exists. A
citation proves the line is there, not that it proves the point, so the independent stage gets every flow's
invariants and the earlier verdicts and is asked to challenge each `holds`. A flow with no invariants is held to one
generic invariant, that nothing in it is removed or weakened, and is marked unspecified.

A project's plan command can report flows the globs miss, from an import graph or a route map, and mark files as
presentation only. A presentation-only file in a flow does not trigger it unless it removes lines: deleting a button
can remove the way into a flow.

### A pull request cannot weaken its own review

The flows, rules, ignore lists, reviewers, plan command, and invariants docs in force are the **base branch's**. The
pull request's own config can only add flows, rules, and reviewers under new names; its changes to the rest, and a
plan command it adds, take effect once they are merged. The plan command runs from a temporary checkout of the base,
so editing its script changes nothing until the merge. A flow the pull request adds reads its invariants from the
pull request. A change to any of these triggers the built-in `harness-config` flow, which the Human signs off. A
flow's deleted test stops the review even when the change touches nothing else in the flow.

`aidrian lint review` fails on a flow whose globs match no tracked file, an invariants doc that is missing or has no
headings, and a cite to a heading that is not there. It warns past 12 flows, or 10 invariants in one flow: a flow is a
critical path, not every feature.

### Sign-off by the Human

`signoff: "human"` adds `aidrian pr signoff <PR> --flow <id> --head <sha>`, run by the Human. It is an audit entry,
not proof: an agent holds the same shell and the same GitHub token. Every sign-off and override is listed in the
review summary on the pull request. For proof, protect the branch with a required review from a second account.

## Reviewers

Every reviewer is an entry in one map. The built-ins:

| Name | Kind | Stage | |
| --- | --- | --- | --- |
| `codex-local` | exec | independent | Codex on this machine, read-only, findings held to a JSON schema |
| `self` | agent | local | the code-reviewer agent; never the author |
| `pr-bot` | remote | remote | `github.reviewer`, as `aidrian pr await-review` waits for it |

A project adds its own in `review.reviewers`:

```json
"review": {
  "reviewers": {
    "semgrep": { "kind": "exec", "command": ["scripts/review-semgrep.sh"], "stage": "local", "independent": false, "timeoutSec": 300 },
    "a11y": { "kind": "agent", "agent": "a11y-reviewer" }
  }
}
```

- `exec`: the command reads the pass as JSON on stdin (`base`, `head`, `files`, `flows`, `priorFindings`) and prints
  `{ "findings": [{ file, line, title, body, severity }], "verdicts": [...] }`. It runs with no session, override, or
  git variables in its environment, in its own process group, with a time limit: SIGTERM, then SIGKILL. Output that does not parse is a failure, never a pass;
  malformed findings are dropped and named. A failure is `incomplete` and retried; the third is `stuck`.
- A project's own exec reviewer runs from a temporary checkout of the base, like the plan command, and reads the head
  through git: a pull request that edits its script cannot run its own version, and the edit triggers
  `harness-config`. `codex-local` reads the checkout at the head.
- `agent`: the command cannot start an agent, so it returns `dispatch` and the skill runs it and records the result.

### The engine

`review.engine` in `.aidrian.local.json` picks this machine's reviewer: `auto` (default), `codex-local`, `pr-bot`,
`self`, or a reviewer of `review.reviewers`. `auto` takes `codex-local` when Codex is installed and logged in, else the
review bot, else `self`, and the result says which and why. It is a machine setting because the same project runs on
machines with and without Codex.

## Rounds

A round is one run of the plan on one head. The cap is `github.maxReviewRounds`, and raising it needs
`AIDRIAN_ALLOW_EXTRA_ROUNDS=1` in the Human's own shell. The last round runs the final stage first, so a pull request
always gets its independent review before the cap, then lets the earlier stages finish on the same head; it passes
when nothing is left to fix, and stops at the cap when a fix would need another head. A reviewer that fails or hits
its quota gives the round back. After a fix, each pass re-reviews only what changed since its last review; a pass
the change does not touch carries forward.

`--with-bot` adds the review bot as a last stage after this machine's engine.

## The plan command

`review.planCommand` runs a project's own planner: it reads `{ base, head, changes }` on stdin and prints a plan in
the same shape as the built-in one. The built-in plan is computed too, and the two merge: the command may add depth,
flows, passes, and stages, and reorder stages, never remove or replace a built-in pass or flow: a pass with a built-in
pass's id is dropped, and the plan says so. A plan that names a reviewer
nobody can run is refused. The command and its files are the base branch's, like the rest of the review config.

## The record

Each step writes the review's record to the state folder and to one summary comment on the pull request, edited in
place: the rounds, each pass's result per head, the verdicts, the sign-offs, and the overrides used. Another machine
reads it from the comment. It is the reviewers' word, not proof, and it is all visible on the pull request.
