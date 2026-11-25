# Gate and quorum re-runs

Read this file in the `plan-review` skill's step 3, before the first gate or quorum dispatch.
It holds the stop rule, the cap, and the carry-forward that the skill's steps 3, 3b, 5, and 6 name.
It changes only what happens to a re-run's findings, never what a gate checks or its severity scale.

## Counting runs

Count the runs this review made, each gate's and the quorum's. The session keeps the counts and each run's findings itself,
and writes neither to the plan. A restart from step 5.1 keeps the counts; only step 6's critique count starts again.
A new `plan-review` run counts from one.
A reused ledger counts no run; the stop rule applies to it as to a run, and it is the next one's previous run.

## The stop rule

On a re-run, compare each finding with the immediately preceding run's findings in this review.

- **Low**: severity `low` on the gate's scale. A quorum objection is never low: only the narrower test applies to it.
- **Narrower**: it names a smaller surface than, or a sub-case of, a finding the previous run raised,
  and it adds no new required invariant. A finding the previous run raised again, unchanged, is not narrower:
  the fix for it did not hold.
- **Blocking**: severity `critical` or `high`, a quorum objection of severity `blocking`, or any finding that adds
  a required invariant. A blocking finding is never narrower: it goes into the critique as step 3 says.

When the re-run has no blocking finding, and every finding is low or narrower, the gate approves for this plan.
Its findings are then carried: the critique proposes no plan revision for them.
For the quorum, its findings are its accepted objections.
With any other finding, the whole verdict goes into the critique as usual.

The stop rule never drops a required invariant: step 3's rule, that a gate's required invariants bind the critique,
holds unchanged. The critical-flow gate's `blocked` or `needs_evidence` sign-off still stops the run as step 3 says:
no authority covers that sign-off, and no stop rule clears it.

## The cap

A gate runs at most 3 times in this review, the first run included, and so does the quorum. The third run is the last:

- Its findings that are not blocking are carried, whatever their size.
- A blocking finding stops the run and escalates to the Human, with the finding and what the earlier runs found.
- A plan changed after it, which a gate would have to judge again, escalates to the Human too: no gate is skipped.

## Carrying findings

1. Carried findings go into step 4's critique brief as notes to record, never as findings to revise the plan for.
2. The proposed diff adds them to the plan's `## Risks`, under the line `Implementation notes from plan review:`,
   one item each: the gate or the quorum and its run number, the severity, the surface, and the finding in a few words.
3. The report's Gates item names each carried finding, with the run, as `security gate run 3 of 3: approved by the stop rule`.
4. Step 5.5 reports each one as `recorded` or `not recorded in the plan`.
   The `issue-implement` skill, which `plan-implement` runs, puts that list in the brief of each slice's `code-reviewer` and `security-engineer`.
