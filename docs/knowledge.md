# Knowledge buckets

A project that uses the aidrian plugin supplies one thing: its knowledge.
The plugin supplies the agents, the skills, and the rule for loading that knowledge.

A knowledge bucket is a folder of Markdown docs with an index file in the [project folder](project-folder.md),
`.aidrian/knowledge/<bucket-id>.json`.
The index gives every doc a one-line summary and its tags, so an agent can pick what to read without opening every doc.

Agents load knowledge in three steps:

1. At the start of every session and subagent, a hook prints one line: the bucket and doc counts, the `always` docs to read now,
   and the two commands below.
2. When a task touches the area of one of its tags, the agent runs `aidrian-knowledge route <tag>` and reads what it lists.
3. For anything else, it runs `aidrian-knowledge search <words>` and reads the docs whose summaries fit the task.

[`examples/consumer`](../examples/consumer) is a complete, checked example.

## Layout

```text
.aidrian/knowledge/
├── engineering.json             the engineering bucket's index
└── product.json
docs/knowledge/engineering/
├── README.md                    optional: what the bucket covers; it needs no index entry
├── working-agreement.md
└── testing.md
docs/knowledge/product/
└── product-rules.md
```

A bucket's docs can live in any folder inside the project; the index names it.
Use one bucket per owner, so each team edits its own folder and its own index.

## The index file

```json
{
  "dir": "docs/knowledge/engineering",
  "description": "How Acme Notes is built, tested, tracked, and shipped.",
  "always": ["working-agreement.md"],
  "docs": {
    "working-agreement.md": {
      "summary": "Rules for every agent and session: read before changing, keep changes small, ship tests and docs with behavior, no secrets.",
      "tags": []
    },
    "testing.md": {
      "summary": "Where unit tests live, how to run them with node --test, and what to mock.",
      "tags": ["testing"]
    }
  }
}
```

- The file name, without `.json`, is the bucket id: lowercase letters, digits, and `-`.
  Buckets load in file-name order.
- `dir`: the folder that holds the bucket's docs, relative to the project root.
- `description`: one sentence on what the bucket covers.
- `always`: docs every agent reads, for every task. Keep this list short; each doc costs context on every run.
  Every `always` doc also needs its entry in `docs`.
- `docs`: one entry per doc in the bucket.
  - `summary`: one line, at most 160 characters, saying what the doc covers. Search matches it, so name the topics.
  - `tags`: the tags whose agents should read this doc. Optional; a doc with no tags is found by search.

Doc paths are relative to `dir` and must stay inside it.
Adding a doc means adding one entry here; the doc itself needs no frontmatter.

## Tags

Each plugin agent states its knowledge tags, and the plugin's skills name the tags they need.
The full list, with what each tag should cover, is in the [`knowledge` skill](../plugins/aidrian/skills/knowledge/SKILL.md#tags).
Use the tags that matter to your project; an agent whose tags you do not use still gets your `always` docs and can search.

## Shaping buckets

Every doc an agent reads costs context on that run, and again on every run that reads it.
Shape the buckets so agents read little by default and find the rest when they need it:

- Keep `always` to one or two short docs, such as names, safety rules, and the shape of a result.
- Give each doc a one-line summary that says when an agent needs it, so `search` finds it without a tag.
- Point tags at small rule cards, about 10 KB or less: a route reads each doc of the tag whole.
  Split a longer doc into a tagged rule card and an untagged reference.
- Leave plans and long references without tags, so only `search` finds them.

`aidrian check` warns when the `always` docs or a tagged doc pass the [knowledge budgets](config.md#knowledge-budgets).
To find a leak, run `aidrian report docs --since 30d`, described in [the dispatch log](dispatch-log.md#doc-reads).
The docs at the top of its list cost the most context, and a doc that every reader opens costs as much as an `always` doc.

## Overriding plugin defaults

Project knowledge wins over the plugin.
The `knowledge` skill lists the defaults a project can change, such as where plans go and the shape of a machine handoff.
To change one, say so in an `always` doc.

## Project agents

A project may keep its own agents beside the plugin's, such as a reviewer that knows its stack.
To make the plugin's agents use them, write an agent registry: a doc tagged `orchestration` that names each project agent and the work it owns.
The `knowledge` skill's [shared defaults](../plugins/aidrian/skills/knowledge/SKILL.md#shared-defaults) say how an agent chooses:
the project's agent wins when it fits the task or has the same name as the plugin's.

## Commands

`aidrian-knowledge` shows what an agent would read, and drafts indexes.
In Claude Code it is on the PATH while the plugin is enabled. Elsewhere, run it by its path; the start hook prints that path.

```sh
aidrian-knowledge route testing        # the docs an agent with the testing tag reads
aidrian-knowledge tags                 # every tag the project uses, with its doc count
aidrian-knowledge search sharing rules # the best 8 matches, with their summaries; --all for every match
aidrian-knowledge index                # every doc: path, tags, and summary, separated by tabs
aidrian-knowledge init docs            # draft .aidrian/knowledge/docs.json for the docs folder
```

`route` fails on a tag that neither the plugin's agents nor the project's buckets use, so a typo never loads only the `always` docs.
A plugin tag the project does not define is fine: it loads nothing beyond the `always` docs.
Then `route`, like `tags` with no tag in use, says so on stderr and still exits 0.

`search` scores each word: 2 when it is part of a tag, 1 when it is part of the path, and 1 when it is part of the summary.
It prints `path<TAB>summary`, best first, and exits 1 with `no match` when no doc scores.

Every command but `init` fails and lists the problems when an index, `config.json`, or `.aidrian.json` is broken,
so agents never read a broken index.

## Checks

`aidrian check` validates every index along with the rest of the [project folder](project-folder.md#setting-up-and-checking).
For each index it fails when the file is malformed, its name is not a valid id, `dir` is not a folder inside the project,
a path leaves its bucket, or a key is unknown.
A symlink fails too when it leads an index or a bucket outside the project, or a doc outside its bucket.
It also fails when a `.md` file in a bucket has no entry in `docs`, because no agent would ever find it,
when a summary is empty, longer than 160 characters, or more than one line, and when an `always` doc has no entry in `docs`.
It warns when the `always` docs or a tagged doc pass the [knowledge budgets](config.md#knowledge-budgets),
and fails when the `always` docs pass twice theirs.

## Indexing a repository that has docs but no buckets

`init` drafts the index for a folder of docs, so an existing docs tree becomes a bucket without editing the docs.
The project folder must exist; `aidrian init` creates it.
`init` writes no index when a symlink would take it outside the project.
It never reads a doc that links outside the folder: it leaves that doc out and names it in a warning.

```console
$ aidrian-knowledge init docs
wrote .aidrian/knowledge/docs.json: 3 docs in docs, each with a drafted summary and no tags
next: correct the summaries, add tags and "always" docs, then run aidrian check
```

The bucket id is the folder's name. Each drafted summary is the doc's first heading and first sentence, cut to 160 characters:

```json
{
  "dir": "docs",
  "description": "Docs in docs.",
  "always": [],
  "docs": {
    "README.md": { "summary": "Getting started: Install the app with `npm ci`.", "tags": [] },
    "guides/deploys.md": { "summary": "Deploys: Every deploy goes through CI.", "tags": [] },
    "guides/releases.md": { "summary": "Releases: Tag a release from main after the changelog is merged.", "tags": [] }
  }
}
```

Then:

1. Rewrite each summary so it names what the doc covers, not only how it starts.
2. Add tags from the `knowledge` skill's list where they fit, and move the few docs every task needs into `always`.
3. Write a real `description`, and run `aidrian check`.

`init` never overwrites an index. For a second folder with the same name, write its index by hand under another id.
