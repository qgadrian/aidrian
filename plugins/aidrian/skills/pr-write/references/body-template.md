# Pull request body

The required sections come first, in the order config.json `pr.requiredSections` lists them.
The optional sections follow, in this order, only when they carry something.

```md
## Summary

<one to three sentences: what a user or developer gets, and why>

- <change area>: <what changed in it>
- <change area>: <what changed in it>

Fixes <ISSUE-KEY>

## Tests run

- `<exact command>`: <what it proved>
- <manual check>: <surface and scenario>, <result>

## Risk

<low | medium | high>: <what breaks if this is wrong, who notices, and how to undo it>

## Accepted residuals

- <a real defect consciously not fixed>: <why the fix is not worth it now; the code comment that marks it>

## Follow-up for a person

- <an action only a person can take after merge, such as a credential or a vendor setting>
```

- **Summary** leads with the outcome, not the file list. Group the bullets by area, not by commit.
- **Tests run** is evidence: the behaviour each command or check proved. A test count alone proves nothing.
- **Risk** names the blast radius, data or security impact, backward compatibility, and how to roll back.
- **Accepted residuals** come from `aidrian pr disposition` verdicts of `accepted_residual`.
- **Follow-up for a person** never lists a check CI runs, or work an agent can do now.
