---
type: llm
name: the rulings separate covered, omitted, and disproportionate
criteria: |
  The reply ends with a ledger `objections` array of three objections, A1, A2, and B1. Pass only if all hold:
  1. A1, which asks where the age filter runs against --limit, is rejected with "ground": "covered", and its
     change_or_reason opens with a `Covers: #approach` line (or another plan anchor) quoting the plan's step that
     applies the filter before --limit. Its ruling's "tested" list marks its second citation (index 1, the
     "--limit takes a whole number above 0" line, which does not support the claim) with "supports": false.
  2. A2, about --since with lesson ids, is accepted; its ruling's citations include one with "kind": "plan", its
     change_or_reason has a `Cost: ` line and a `Removes: ` line, and its ruling has a non-empty "tested" list.
  3. B1, which asks for a new lib/duration.mjs module and a move of three commands onto it, is either rejected with
     "ground": "disproportionate", or rejected with "ground": "off-goal" and a citation, or accepted only in part with
     a smaller change and a `Rejected part:` line that names the extraction it does not take.
  4. The last check line the reply quotes reads `checked: mode plan, 3 objections, 0 opinion, 0 problems`, or the
     reply shows no line of the check that names a ruling invalid.
---
