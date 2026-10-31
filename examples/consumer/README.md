# Example consumer: Acme Notes

A made-up note-taking app that uses the aidrian harness.
It shows the only things a project adds: its [project folder](../../docs/project-folder.md), its rules, and two small settings files.

| File | Why it is here |
| --- | --- |
| `.aidrian/config.json` | The folder version, the main-checkout guard, the pull request contract, and the review gate, which this project turns on. [docs/config.md](../../docs/config.md) lists the other keys. |
| `.aidrian/terms.json` | The project's banned terms and their replacements, for agent writes and `aidrian lint terms` ([docs/config.md](../../docs/config.md#terms)). |
| `.aidrian/knowledge/*.json` | Each bucket's index: its doc folder, a one-line summary and the tags of every doc, and which docs load always. |
| `docs/knowledge/**/*.md` | The project's rules, in the project's own words. |
| `.claude/settings.json` | Offers the aidrian plugin to everyone who opens the project in Claude Code. |
| `AGENTS.md`, `CLAUDE.md` | Point the main session at the knowledge buckets. |
| `.gitignore` | Keeps `.aidrian.local.json`, a developer's own knowledge sources, and `.worktrees/`, the task worktrees, out of git. |

Agents, skills, and the loading rules come from the plugin. Nothing here copies them.

Check the project folder, see what an agent with the `testing` tag reads, and search the summaries:

```sh
../../plugins/aidrian/bin/aidrian check
../../plugins/aidrian/bin/aidrian-knowledge route testing
../../plugins/aidrian/bin/aidrian-knowledge search sharing rules
```

Try the plugin in this folder without installing it:

```sh
claude --plugin-dir ../../plugins/aidrian
```
