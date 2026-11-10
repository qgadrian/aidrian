# Pull request body

The required sections come first, in the order config.json `github.requiredSections` lists them.
The optional sections follow, in this order, only when they carry something.

```md
## Summary

<one to three sentences: what a user or developer gets, and why>

- <change area>: <what changed in it>
- <change area>: <what changed in it>

Fixes <ISSUE-KEY, such as ABC-12 or #12>

## Tests run

- `<exact command>`: <what it proved>
- <manual check>: <surface and scenario>, <result>

## Risk

<low | medium | high>: <what breaks if this is wrong, who notices, and how to undo it>

## Decisions

- `<marker id>` (<class>, <domain>), <replaces a written rule | fills a gap>: <what was decided and why>. Revisit when <its revisit trigger>. Reverts by <how>. <The doc that holds its marker.>
- Closure criterion, <slice title>: <what the plan asked> is now proven by <the tests>, which failed when <the break>.

## Accepted residuals

- <the finding's exact title when a reviewer raised it, else a real defect consciously not fixed>: <why the fix is not worth it now; the code comment that marks it>

## Follow-up for a person

- <an action only a person can take after merge, such as a credential or a vendor setting>
```

- **Summary** leads with the outcome, not the file list. Group the bullets by area, not by commit.
- **Tests run** is evidence: the behaviour each command or check proved. A test count alone proves nothing.
- **Risk** names the blast radius, data or security impact, backward compatibility, and how to roll back.
- **Decisions** lists each decision an agent made alone, so the reviewer can keep or reject it. It never names the agent.
  A closure criterion changed during the run is one such decision: what the plan asked, the tests that now prove it, and the break they failed on.
  A decision with `hasOldWording` true replaces a written rule; with false, it fills a gap.
  A marker of `settled` is listed as settled in this branch. A marker of `removed` is listed as removed in this branch, with its status at the base.
  A bullet shows the status when it is not `unconfirmed`.
  When config.json `github.pullRequest.sections` is set without `Decisions`, the same list goes at the end of `## Summary`,
  or of the first section on the closed list when Summary is not on it, as a `Decisions:` line and its bullets.
  When the `queue` that `aidrian decisions list --added-since` prints is `report`, it stays out of the body.
- **Accepted residuals** come from `aidrian pr disposition` verdicts of `accepted_residual`.
  Before the body ships, each one is set against the decisions on record and the ADR consequences (`aidrian decisions residuals`),
  and one that contradicts a decision is fixed or dropped, never shipped. A residual is dropped only when the defect no longer
  ships or is shown to be no defect, and then one line of why stays in the body: never delete the bullet alone while the defect ships.
- **Follow-up for a person** never lists a check CI runs, or work an agent can do now.
