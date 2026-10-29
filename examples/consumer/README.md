# Example consumer: Acme Notes

A made-up note-taking app that uses the aidrian harness.
It shows the only things a project adds: knowledge buckets, and two small settings files.

| File | Why it is here |
| --- | --- |
| `.aidrian/knowledge.json` | Lists the knowledge buckets. |
| `docs/knowledge/*/bucket.json` | Each bucket's index: which docs load always, and which load for each tag. |
| `docs/knowledge/**/*.md` | The project's rules, in the project's own words. |
| `.claude/settings.json` | Offers the aidrian plugin to everyone who opens the project in Claude Code. |
| `AGENTS.md`, `CLAUDE.md` | Point the main session at the knowledge buckets. |
| `.gitignore` | Keeps local plans and worktrees out of git. |

Agents, skills, and the loading rules come from the plugin. Nothing here copies them.

Check the buckets, and see what an agent with the `testing` tag reads:

```sh
../../plugins/aidrian/bin/aidrian-knowledge check
../../plugins/aidrian/bin/aidrian-knowledge route testing
```

Try the plugin in this folder without installing it:

```sh
claude --plugin-dir ../../plugins/aidrian
```
