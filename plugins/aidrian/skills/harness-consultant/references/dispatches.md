# Librarian dispatches

The `harness-librarian` briefs of the `harness-consultant` skill: the R4 brief of step 1, and the briefs of steps 3 and 4.
No brief passes a model or effort. Every brief gives the librarian:

- the absolute path of the checkout;
- the absolute plugin root, with: "run `aidrian` and `aidrian-knowledge` from `<plugin root>/bin/` when they are not on the PATH,
  and use it as `<plugin root>` in `references/setup-files.md`";
- "do not commit; return `pending_commit`".

## R4 brief: the review bot only

Write config.json `github.reviewer: null` and nothing else, then run `aidrian check`.

## Step 3 brief: set up and propose

Also give the librarian:

- the answers to Q1 to Q6, and the readiness items that were missing at step 1;
- knowledge tags `docs` and `harness_engineering`;
- the absolute path of `references/setup-files.md`, which it reads for the `AGENTS.md`, `CLAUDE.md`, and settings text;
- the folder new docs go to: Q3's folder, or `docs/knowledge/` with Q3 none.

It follows its "A new project" procedure, in this order, skipping what holds:

1. `aidrian init`; `aidrian-knowledge init <Q3 folder>` when the folder has `.md` files and no index,
   then each doc's summary and tags. An index that exists gets the same pass for each doc whose summary is still the
   drafted one (its first heading or file name) or that has no tags.
2. Q4 team names to config.json `names`, a developer's own names to `.aidrian.local.json`, and Q2 no to
   config.json `github.reviewer: null`. No other config key.
3. The `AGENTS.md` and `CLAUDE.md` lines; in Claude Code with Q6 yes, `.claude/settings.json`.
4. On every onboarding, whatever R2 was: the `knowledge-update` skill on the topics `working-agreement`, `testing`,
   `architecture`, and `issue-tracker` when Q1 is not none. Each topic carries an area hint for the explorer brief:
   stack and build, tests, domain modules, existing docs.
   - A topic a real doc covers is never `generate`: that doc gets its summary and tags, and an `extend` only when the
     evidence names a gap.
   - Only the working-agreement doc takes the `always` place, and the proposal shows it; every other doc gets a summary
     and tags.
   - Q1's answer is the `issue-tracker` packet's `other` evidence, and that doc gets the `issue_tracker` tag.
   - It returns the proposal as `needs_input`, with the files it already wrote in `pending_commit`.

## Step 4 brief: write and check

Also give the librarian the approved proposal, if any, and the Q5 answer.
It, in order:

1. Writes the approved docs and their index entries; `create` never overwrites. With Q3 none, it writes them to
   `docs/knowledge/`, runs `aidrian-knowledge init docs/knowledge`, then sets each entry's summary and tags from the proposal.
2. Runs `aidrian check` and `aidrian lint`, fixes what they report without raising a limit, and runs both again until they exit 0,
   or returns `blocked` naming what the Human must approve; then it does not write the guard.
3. Writes `git.mainCheckout.guard: true` when Q5 is yes, as the last write: once the guard is on, a write in the main
   checkout is blocked.
4. Runs `aidrian check` once more, read-only, and returns `pending_commit` with every file it wrote in this run.
