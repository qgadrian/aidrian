# Product feedback in a flow

The steps a flow runs when it opens a draft or marks one ready: `pr-review-loop`, `orchestration`, `autopilot`, and
`pr-merge-when-green`. `<n>` is the pull request's number. With product feedback off, the default, `status` exits 0, says
why, and nothing else runs. `status --json` gives `state`, `reason`, and `owed`: each owed item's id, title, kind, state,
and the command that answers it.

## After the draft opens

Once per pull request, after the draft opens and before the first bot round, so product fixes go through code review
like any other change:

```bash
aidrian pr product-feedback status <n> --json   # 0 clear, 2 owed, 3 error
```

- Exit 0: go on.
- Exit 2 with `reason` `not_run`: run the `pr-product-feedback` skill on `<n>`, then answer what it found, as below.
- Exit 2 with `reason` `unanswered`: an earlier run left items unanswered. Do not go on: answer them, as below.
- Exit 2 with any other `reason`: go on. Nothing is re-checked here, mid-round: the ready step owns the re-check.
- Exit 3: report its line and go on. The ready step leaves the draft.

After the skill runs, run `status <n> --json` again; on `unanswered`, use the output already in hand. Answer each
`unanswered` item with the command it prints in `owed`:
each `defect` with `fix-now`, and each `minor` with `defer` and a `--reason`, or as a question to the Human.
A `choice` is the Human's, as § Before `gh pr ready` says. Then route each `fix-now` item to its owner as any other
finding, by the `orchestration` skill's § 4, and push the fix with the next round.

`pr-review-loop` run as a step of another skill leaves this to its caller.

## Before `gh pr ready`

1. Run `aidrian pr product-feedback status <n> --json`. Exit 0: mark it ready as the flow says.
2. Exit 2 with `reason` `not_rechecked`, so only fixes not re-checked are owed: run the `pr-product-feedback` skill on
   `<n>` with no `--full`. That is its re-check run: it walks only the fixed items and records each as confirmed or
   reopened. Then run `status` again, and mark it ready only on exit 0.
3. Any other non-zero exit, or reopened after the re-check: leave the draft. Report what is owed, each item by its
   title with its command, the same end as an open product choice.

A product choice is the Human's. In a run with the Human present, ask as the `pr-product-feedback` skill's step 5 says.
In an unattended run, ask nothing: the draft stays a draft, and the report lists each question with its command, as a
decision for the Human. When `reason` is `opted_out`, say in the report that this machine opted out.

A hook holds marking ready while `status` says owed. Never work around it: answer the item, or leave the draft.
