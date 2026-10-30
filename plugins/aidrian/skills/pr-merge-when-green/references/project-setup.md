# Project setup

Read when a check verdict surprises you, or before changing the `github` check lists.

`aidrian pr checks` takes its policy from the `github` group in the `config.json` of the checkout it runs in.
So run this skill from a checkout of the pull request's repository: `aidrian pr checks -R` refuses any repository that is
not a remote of the current checkout.
Each entry is part of a check name and matches any check whose name contains it, so pick parts that match only the checks meant.

- `requiredChecks`: put the end-to-end check family here (`["e2e"]`, say).
  Every matching check must exist and be `SUCCESS`: a skipped, neutral, or cancelled one fails, and a missing one keeps the
  run waiting. Without the entry, a skipped end-to-end check reads as a pass.
- `conditionalChecks`: the checks a path filter turns off when the diff does not touch their files.
  Once the list has an entry, any other `SKIPPED` or `NEUTRAL` check fails as an unexpected skip.
  A check belongs here only when the diff alone decides its skip. One that a label or another person's choice can skip
  does not, or that choice could turn a pull request green.
- `ignoreCancelledChecks`: checks whose `CANCELLED` is routine, such as a preview deploy an ignored build cancels.

When a run stops on an unexpected skip that looks routine, ask the user before adding it to `conditionalChecks`.
Never add an entry on your own during a merge run.
