---
name: adr-writer
description: Write an architecture decision record (ADR) with the next free number, or supersede an earlier one. Use to record a hard-to-reverse decision.
---

# adr-writer

Record one decision as a numbered ADR: why it was needed, what was chosen, what lost, and what it costs.
This skill writes the ADR and edits a superseded ADR's status; it never commits, pushes, or opens a pull request.
The caller decides whether a decision deserves an ADR, and the team makes the decision; the ADR records it.

Before you start, follow the `knowledge` skill. Knowledge tags: `docs`.

## Arguments

| Argument | Meaning |
| --- | --- |
| `<slug>` | Required. Kebab-case; the file is `NNNN-<slug>.md` |
| `--from-plan <path>` | Read this plan file as the decision's context |
| `--from-pr <n>` | Read this pull request: `gh pr view <n> --json title,body,closingIssuesReferences` and `gh pr diff <n>` |
| `--supersedes <MMMM>` | The number of the earlier ADR this one replaces |
| `--status <value>` | `Proposed`, or `Accepted` (the default) |

Without `--from-plan` or `--from-pr`, draft from the conversation and the code it names.
When a named plan or pull request cannot be read, stop and report the path or number with the error; never invent context.

## Steps

1. **Find the folder and the template.** Run `aidrian-knowledge search adr decision record`.
   An ADR folder, template, status list, or check that the project's `docs` knowledge names wins.
   Otherwise the folder is `docs/adr/` and the template is [references/template.md](references/template.md): read it now.
   Done when you know the folder, the template, and the check to run, if any.
2. **Check that it is new.** Read the titles in the folder, and open each ADR in the same area.
   When one already records this decision, stop and name it; when the new decision replaces it, it needs `--supersedes`.
3. **Pick the number**: one above the highest number any ADR has had, on any branch, so a deleted or unmerged one is never reused.

   ```bash
   { ls docs/adr; git log --all --format= --name-only -- docs/adr; } | sed -nE 's#^(.*/)?([0-9]{4})-.*#\2#p' | sort -n | tail -1
   ```

   Empty output means `0001`. Put the project's folder in place of `docs/adr` when it differs.
4. **Write `<folder>/NNNN-<slug>.md`** from the template, with real content in every section: no `TBD`, no placeholder.
   - Context cites the files, docs, and earlier ADRs it rests on.
   - Decision states the exact shape: the API, schema, data structure, or behavior.
   - Alternatives names each option and the concrete reason it lost; the do-nothing option counts.
   - Consequences names what changes, what gets harder, and the follow-up work.

   Write the reasoning into the ADR: a plan file or local path it cites dangles once the plan is gone.
5. **Supersede.** With `--supersedes <MMMM>`, set that ADR's Status to `Superseded by [NNNN](NNNN-<slug>.md).`
   and change nothing else in it. The new ADR's Status says `Supersedes [MMMM](MMMM-<old-slug>.md).`
6. **Update the index.** When the folder has one, such as a README that lists the ADRs, add the new row and mark the superseded one.
7. **Check.** Run the project's ADR check when its knowledge names one, and fix the draft until it passes.

## Return

- The new ADR's path, and the superseded ADR's path when there is one.
- A commit subject for the caller, such as `docs(adr): record <the decision in a few words>`.
