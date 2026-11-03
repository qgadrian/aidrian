# Quorum briefs: shared parts

What every brief of every mode pastes. Each mode file holds its own briefs, and names the parts below where they go.
Fill every `<placeholder>`, and paste the Evidence block where a brief says `<evidence>`.

## Shared parts

Placeholders:

- `<plan>`: the plan's absolute path. `<ledger>`: the ledger's absolute path.
- `<gates>`: the gate verdicts a calling skill passed, word for word, or `none`.
- `<knowledge>`: `aidrian-knowledge`, or its full path from the start hook when it is not on PATH.
  A brief for Codex always takes the full path, since Codex's PATH may not include it.
- `<settled>`: the Settled answers block below, or `none`.

### Evidence block

Paste this, word for word, where a brief says `<evidence>`:

```text
Evidence: every objection, ruling, and rebuttal carries at least one citation {kind, ref, quote}, all three required.
- doc: ref is path#anchor of a knowledge doc; the quote is in that section.
- adr: ref is path#anchor of a decision record; the quote is in that section.
- code: ref is path:line; the quote is in that file (the line is advisory).
- plan: ref is #anchor of a heading in the plan under review; the quote is in that section.
- absence: ref is a file or folder path; the quote is a needle that no file git tracks there contains.
Paths are relative to the repository root and stay inside it. An anchor is a heading's text or its slug.
The quote is verbatim, at most 200 characters, and compared with whitespace collapsed.
A citation that fails this check does not count; an objection with no passing citation is dropped as opinion.
Each statement of fact your claim rests on carries its own citation. A statement you cannot cite goes on a line of
its own, starting with the label, as: inference: <statement>
The judge tests each such line and each citation. A claim that rests on inferences alone is an opinion.
Where a knowledge doc or a decision record covers the point, prefer a `doc` or `adr` citation to a `code` or `plan`
one; find them with `<knowledge> route <tag>` and `<knowledge> search <words>`.
A concession cites the evidence of the ruling it accepts.
```

### Settled answers

When earlier `complete` ledgers of this plan hold `human_answers` (the `quorum` skill's `references/ledger.md`
§ Settled answers says which ledgers), paste one line per answer, with the claim of the objection it answered:

```text
Settled by the Human, not to be reopened:
- "<the earlier objection's claim>": <the Human's answer>
The plan's revision history records each one it applied.
```
