---
type: llm
name: the rulings separate covered, omitted, and disproportionate
criteria: |
  The reply ends with a ledger `objections` array of three objections, A1, A2, and B1. Pass only if all hold:
  1. Each ruling's change_or_reason opens with a line of exactly one of two forms: `Covers: #<anchor> "<quote>"`,
     a plan heading's anchor followed by a quoted line of the plan, or `Covers: nothing`. A line that restates the
     objection or names its id instead, such as `Covers: A1.` or `Covers: the order of the filter`, fails.
  2. A1, which asks where the age filter runs against --limit, is rejected with "ground": "covered", and its Covers
     line quotes the plan's step that applies the filter before --limit. Its ruling's "tested" list marks its second
     citation (index 1, the "--limit takes a whole number above 0" line, which does not support the claim) with
     "supports": false.
  3. In every ruling, each citation its "tested" list marks "supports": false is named in that ruling's
     change_or_reason, by its index or its quote, with why it does not support the claim.
  4. A2, that the plan names no update to docs/lessons.md for the new option, is accepted; its ruling's citations
     include one with "kind": "plan", its change_or_reason has a `Cost: ` line and a `Removes: ` line, and its ruling
     has a non-empty "tested" list.
  5. B1, which asks for a new lib/duration.mjs module and a move of three commands onto it, is either rejected with
     "ground": "disproportionate", or rejected with "ground": "off-goal" and a citation, or accepted only in part with
     a smaller change and a `Rejected part:` line that names the extraction it does not take.
  6. No line of the check that the reply shows names a ruling invalid. A check line that counts problems above 0
     because one citation did not pass, while the ruling keeps another citation that passes, does not fail this.
---
