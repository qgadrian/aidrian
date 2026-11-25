# Gate and quorum re-runs

Read this file for the `plan-review` skill's step 3 or 3b when the plan's `## Revision history` shows that the gate,
or the quorum, ran on this plan before. It holds the stop rule, the cap, and the carry-forward that the skill's
steps 3, 3b, 5, and 6 name. It changes only what happens to a re-run's findings, never what a gate checks or its severity scale.

## Counting runs

- A gate's runs are counted from the plan's `## Revision history`: each applied entry names the gate runs before it,
  as `security gate run 2: medium, webhook retries`. This run takes the next number.
- The quorum's runs are its `complete` ledgers whose `plan` is this plan's path, which the `quorum` skill's
  `references/ledger.md` § Settled answers finds, plus this run.
- A restart from step 5.1 keeps both counts. Only step 6's critique count starts again.

## The stop rule

On a re-run, compare each finding with the previous run's findings, as its revision-history entry names them.

- **Low**: severity `low` on the gate's scale. A quorum objection is never low: only the narrower test applies to it.
- **Narrower**: it names a smaller surface than, or a sub-case of, a finding the previous run raised,
  and it adds no new required invariant. A finding the previous run raised again, unchanged, is not narrower:
  the fix for it did not hold.
- **Blocking**: severity `critical` or `high`, a quorum objection of severity `blocking`, or any finding that adds
  a required invariant. A blocking finding is never narrower: it goes into the critique as step 3 says.

When every finding of the re-run is low or narrower, the gate approves for this plan, and its findings are carried:
the critique proposes no plan revision for them. For the quorum, its findings are its accepted objections.
With any other finding, the whole verdict goes into the critique as usual.

The stop rule never drops a required invariant. Every invariant a gate required, on any run, still binds the critique,
as step 3 says. The critical-flow gate's `blocked` or `needs_evidence` sign-off still stops the run as step 3 says:
no authority covers that sign-off, and no stop rule clears it.

## The cap

A gate runs at most 3 times on a plan, the first run included, and so does the quorum. The third run is the last:

- Its findings that are not blocking are carried, whatever their size.
- A blocking finding stops the run and escalates to the Human, with the finding and the revision-history entries
  of the earlier runs.

## Carrying findings

1. Carried findings go into step 4's critique brief as notes to record, never as findings to revise the plan for.
2. The proposed diff adds them to the plan's `## Risks`, under the line `Implementation notes from plan review:`,
   one item each: the gate or the quorum and its run number, the severity, the surface, and the finding in a few words.
3. The report's Gates item names each carried finding, with the run, as `security gate run 3 of 3: approved by the stop rule`.
4. Step 5.5 checks that the applied plan holds them. The `issue-implement` skill, which `plan-implement` runs,
   puts that list in the brief of each slice's `code-reviewer` and `security-engineer`.
