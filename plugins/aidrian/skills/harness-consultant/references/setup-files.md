# Setup files

The text `harness-librarian` writes into a project during the `harness-consultant` skill's setup, and how to fill it.
`<plugin root>` is the absolute plugin root the dispatch brief gives.

## AGENTS.md and CLAUDE.md

Add these two lines to `AGENTS.md`; create the file when it is absent, and append when it exists and lacks them:

```md
Project rules live in knowledge buckets, indexed in `.aidrian/knowledge/`.
Load them with the `knowledge` skill before you plan, edit, or review.
```

`CLAUDE.md` holds this line; create the file when it is absent, and append when it exists and lacks it:

```md
@AGENTS.md
```

## Claude Code team install

`.claude/settings.json`, committed, makes Claude Code offer the plugin to everyone who opens the project.
Replace `<owner>/<repo>` with the slug the command below prints. When the file exists, merge these keys into it
and never drop a key it has.

```json
{
  "extraKnownMarketplaces": {
    "aidrian-harness": { "source": { "source": "github", "repo": "<owner>/<repo>" } }
  },
  "enabledPlugins": { "aidrian@aidrian-harness": true }
}
```

The slug comes from the `repository` of the running plugin's manifest, never from memory.
Set `plugin_root` to the plugin root, then run:

```sh
plugin_root='<plugin root>'
node -p 'new URL(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).repository).pathname.replace(/^\/|\.git$/g, "")' \
  "$plugin_root/plugin.json"
```

## Codex

No settings file: each developer installs the plugin once per machine. Print the install page, the manifest's
`repository` URL followed by `#codex`, the README section with the Codex install:

```sh
plugin_root='<plugin root>'
node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).repository + "#codex"' "$plugin_root/plugin.json"
```
