# Accepted residuals against decisions

Read this when the body has a `## Accepted residuals` section, or the section config.json
`github.pullRequest.residuals.section` names, after the body file is written and before `gh pr create` or `gh pr edit`.
An accepted residual that contradicts a decision on record never ships.

1. Run `aidrian decisions residuals --body <file> --json`, with `--adr <folder>` only when the project's `docs` knowledge
   names an ADR folder other than `docs/adr/`. It pairs each residual with every decision on record and every
   `## Consequences` line of the ADRs; an ADR whose Status starts `Superseded` is skipped, and a note names it.
   When it says `nothing` is true (`nothing to check`, or `nothing on record: no judgment owed`), it exited 0 and no
   dispatch is owed: the body ships.
2. Dispatch `product-manager` with that output as its brief and the knowledge tag `product_sensitive`. It returns the rows
   in its handoff's `residual_rows` field, one row per residual, `{ residual, contradicts, evidence }`: `residual` the text
   exactly as printed, `contradicts` a decision id or ADR `path:line` from the pairing, or `null`, and `evidence` the quoted
   wording it contradicts. The pairing lists only `confirmed` and `unconfirmed` decisions: a `rejected` one is no rule,
   so the command leaves it out.
3. Write the rows as a JSON array to `<state>/tmp/pr-residuals-<branch>.json`, with the same `<branch>` spelling as the
   body file, and run `aidrian decisions residuals --body <file> --judged <that file>`.
4. Each printed contradiction goes back to the owner of the change, who fixes the defect or drops the residual; an
   `invalid:` row goes back to `product-manager`. Rerun steps 1 to 3 until the judged run exits 0: the body ships only then.

Dropping a residual means it leaves the body because the defect no longer ships, or because it is shown to be no defect;
then one line of why stays in the body, under the summary or a note, so the reviewer sees the reason.
Deleting the bullet while the defect still ships is never a fix.

A decision found out of date is revised only through the decision's own route, never reworded on this branch to make a
residual pass. The command reads the branch's working copy, so a decision marker or wording this branch changes must already
show under the body's Decisions bullet.

When a run does not exit 0 after one fix round, stop as the skill's last section says, and return the
contradictions and invalid rows with the drafted body, and the owner each went to.
