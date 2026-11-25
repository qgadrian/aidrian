# Accepted residuals against decisions

Read this when the body has a `## Accepted residuals` section, or the section config.json
`github.pullRequest.residuals.section` names, after the body file is written and before `gh pr create` or `gh pr edit`.
An accepted residual that contradicts a decision on record never ships.

1. Run `aidrian decisions residuals --body <file> --json`, with `--adr <folder>` only when the project's `docs` knowledge
   names an ADR folder other than `docs/adr/`. It lists each decision on record and each `## Consequences` line of the
   ADRs once, in `decisions` and `adrs`, then each residual by its number `n`: every residual is set against the whole
   record. An ADR whose Status starts `Superseded` is skipped, and a note names it.
   A residual an earlier run of step 3 found clean against this same record is marked `kept`; `owed` holds the numbers of
   the others, and `record` the record's hash. When it says `nothing` is true (`nothing to check`,
   `nothing on record: no judgment owed`, or `every residual was judged against this record`), it exited 0 and no dispatch
   is owed: the body ships.
2. Dispatch `product-manager` for the owed residuals alone, with that output as its brief, the numbers in `owed`, and the
   knowledge tag `product_sensitive`. A narrowed listing marks nothing `kept`, so the numbers still come from step 1.
   When the output is still too long for one brief, split the record with `--path <doc or folder>`, which lists every
   decision and ADR line there, and dispatch once per part; `--residual <n>` lists one residual. A single document too
   long for one brief is not split further: `product-manager` reads it in parts, and no residual's row is `null` until
   every part was read. A residual's row is `null` only when no part found a contradiction. It returns the rows
   in its handoff's `residual_rows` field, one row per owed residual, `{ residual, contradicts, evidence }`: `residual` the text
   exactly as printed, `contradicts` a decision id or ADR `path:line` from the pairing, or `null`, and `evidence` the quoted
   wording it contradicts. The pairing lists only `confirmed` and `unconfirmed` decisions: a `rejected` one is no rule,
   so the command leaves it out.
3. Write `{ "record": <step 1's record>, "rows": [...] }` as JSON to `<state>/tmp/pr-residuals-<branch>.json`, with the
   same `<branch>` spelling as the body file, and run `aidrian decisions residuals --body <file> --judged <that file>`,
   with the same `--adr <folder>` as step 1. The rows answer the record step 1 listed, so a later listing's `record`
   never goes beside them, and a file with another `record` than the run reads exits 1: run step 1 again, and judge
   again. Spell both paths out, with the folder `aidrian state` prints and the branch put in before the command, as the
   body file's is: the Bash hook refuses a write to a path built in a shell variable, such as `> $S/pr-residuals.json`.
   A `kept` residual needs no row; the exit covers the whole body, and on 0 each clean verdict is kept. An exit 1 that
   says `is locked by another process` judged nothing: run the same command again. To judge every residual again, add
   `--rejudge` here and in step 1.
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
