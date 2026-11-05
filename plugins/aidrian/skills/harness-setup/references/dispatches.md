# Librarian dispatches

The `harness-librarian` briefs of the `harness-setup` skill: the R4 brief of step 1, the briefs of steps 3 and 4,
and the tracker key the step 3 brief writes.
No brief passes a model or effort. Every brief gives the librarian:

- the absolute path of the checkout;
- the absolute plugin root, with: "run `aidrian` and `aidrian-knowledge` from `<plugin root>/bin/` when they are not on the PATH,
  and use it as `<plugin root>` in `references/setup-files.md` and this file";
- "do not commit; return `pending_commit`".

## R4 brief: the review bot only

Write config.json `github.reviewer: null` and nothing else, then run `aidrian check`.

## Step 3 brief: set up and propose

Also give the librarian:

- the answers to Q1 to Q6, and the readiness items that were missing at step 1;
- knowledge tags `docs` and `harness_engineering`;
- the absolute path of `references/setup-files.md`, which it reads for the `AGENTS.md`, `CLAUDE.md`, and settings text;
- the folder new docs go to: Q3's folder, or `docs/knowledge/` with Q3 none;
- with Q1 Linear, the absolute path of this file, which it reads for [the tracker key](#the-tracker-key-linear-only).

It follows its "A new project" procedure, in this order, skipping what holds:

1. `aidrian init`; `aidrian-knowledge init <Q3 folder>` when the folder has `.md` files and no index,
   then each doc's summary and tags. An index that exists gets the same pass for each doc whose summary is still the
   drafted one (its first heading and first sentence, or its file name) or that has no tags.
2. Q4 team names to config.json `names`, a developer's own names to `.aidrian.local.json`, Q2 no to
   config.json `github.reviewer: null`, and Q1 Linear to config.json `tracker` and `requires.aidrian`,
   as [The tracker key](#the-tracker-key-linear-only) says. No other config key.
3. The `AGENTS.md` and `CLAUDE.md` lines; in Claude Code with Q6 yes, `.claude/settings.json`.
4. On every onboarding, whatever R2 was: the `knowledge-update` skill on the topics `working-agreement`, `testing`,
   `architecture`, and `issue-tracker` when Q1 is not none. Each topic carries an area hint for the explorer brief:
   stack and build, tests, domain modules, existing docs.
   - A topic a real doc covers is never `generate`: that doc gets its summary and tags, and an `extend` only when the
     evidence names a gap.
   - Only the working-agreement doc takes the `always` place, and the proposal shows it; every other doc gets a summary
     and tags.
   - Q1's answer is the `issue-tracker` packet's `other` evidence, and that doc gets the `issue_tracker` tag.
     For Linear, that evidence is the tracker's name and the project's conventions: the workspace and team stay in config.json.
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

## The tracker key: Linear only

With Q1 Linear, merge this into config.json, keeping every other key, with the Human's answers in the placeholders.
GitHub Issues writes no key, and neither does none.

```json
{
  "tracker": {
    "enabled": true,
    "provider": "linear",
    "workspace": { "expect": "<workspace URL>" },
    "team": { "key": "<team key>", "values": ["<team name>"] }
  }
}
```

- `<workspace URL>` is the address of the workspace, such as `https://linear.app/<slug>`, with nothing after the slug:
  a write compares it as exact text.
- `<team key>` is the prefix of the team's issues, such as `ABC` in `ABC-123`.
  `<team name>` is the name Linear shows, with its case and spaces.
- `"provider": "linear"` holds the tools and fields, so write none of them:
  `readTools`, `writeTools`, `field`, `createFields`, and `keyFields` all come from it.
  A connection under a server name the plugin does not know goes in `"servers": ["<name>"]`, when the Human names one.

Only when the Human names a project, add this group to `tracker`:

```json
{ "project": { "values": ["<project name>"] } }
```

Writing the key also sets `requires.aidrian`, since an older plugin rejects the key.
Read the running plugin's version, and set `requires.aidrian` to it when that key is absent, null, or lower,
comparing part by part, as numbers.
Leave a higher value. This is the plugin running now, not the release that first shipped the key, which this text cannot name.

```sh
plugin_root='<plugin root>'
node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$plugin_root/plugin.json"
```
