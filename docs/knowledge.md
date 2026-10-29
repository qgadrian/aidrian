# Knowledge buckets

A project that uses the aidrian plugin supplies one thing: its knowledge.
The plugin supplies the agents, the skills, and the rule for loading that knowledge.

A knowledge bucket is a folder of Markdown docs with a `bucket.json` index.
A project lists its buckets in `.aidrian/knowledge.json`.
Agents read the `always` docs of every bucket, plus the docs of the tags they work with.

[`examples/consumer`](../examples/consumer) is a complete, checked example.

## Layout

```text
.aidrian/knowledge.json          lists the buckets, in load order
docs/knowledge/engineering/
├── bucket.json                  the bucket's index
├── README.md                    optional: what the bucket covers; agents do not load it
├── working-agreement.md
└── testing.md
docs/knowledge/product/
├── bucket.json
└── product-rules.md
```

Buckets can live anywhere inside the project. Use one bucket per owner, so each team edits its own folder.

## `.aidrian/knowledge.json`

```json
{
  "buckets": ["docs/knowledge/engineering", "docs/knowledge/product"]
}
```

`buckets` is a non-empty list of folders, relative to the project root. Agents load buckets in this order.

## `bucket.json`

```json
{
  "id": "engineering",
  "description": "How Acme Notes is built, tested, tracked, and shipped.",
  "always": ["working-agreement.md"],
  "tags": {
    "testing": ["testing.md"],
    "issue_tracker": ["issue-tracker.md"]
  }
}
```

- `id`: lowercase letters, digits, and `-`. Unique across the project's buckets.
- `description`: one sentence on what the bucket covers.
- `always`: docs every agent reads, for every task. Keep this list short; each doc costs context on every run.
- `tags`: docs an agent reads when it works with that tag. A doc may appear under several tags.

Doc paths are relative to the bucket folder and must stay inside it.

## Tags

Each plugin agent states its knowledge tags, and the plugin's skills name the tags they need.
The full list, with what each tag should cover, is in the [`knowledge` skill](../plugins/aidrian/skills/knowledge/SKILL.md#tags).
Define the tags that matter to your project; an agent whose tags you do not define still gets your `always` docs.

## Overriding plugin defaults

Project knowledge wins over the plugin.
The `knowledge` skill lists the defaults a project can change, such as where plans and worktrees go and the shape of a machine handoff.
To change one, say so in an `always` doc.

## Checking buckets

`aidrian-knowledge` validates the buckets and shows what an agent would load.
In Claude Code it is on the PATH while the plugin is enabled. Elsewhere, run it from a checkout of this repository.

```sh
aidrian-knowledge check                # validate .aidrian/knowledge.json and every bucket
aidrian-knowledge route testing        # the docs an agent with the testing tag reads
aidrian-knowledge tags                 # every tag the project defines
```

`check` fails when a file is missing or malformed, a path leaves its bucket, an id repeats, or a key is unknown.
A symlink fails too when it leads a bucket outside the project, or a doc outside its bucket.
`check` also fails when a `.md` file in a bucket is in no list, because no agent would ever read it.
Run it in the project's CI so broken buckets never reach the agents.

`route` fails on a tag that neither the plugin's agents nor the project's buckets use, so a typo never loads only the `always` docs.
A plugin tag the project does not define is fine: it loads nothing beyond the `always` docs.
