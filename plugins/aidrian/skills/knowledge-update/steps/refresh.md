# Mode: refresh

Bring existing docs up to date with what changed in a time window.

Input: a window; optionally a tag or a topic; optionally `deep`, for a wide sweep.

1. **Set the window** in UTC dates, today included:

   | Input | Window |
   | --- | --- |
   | `7d`, `last 7 days` | after today minus 7 days |
   | `last week` | after today minus 7 days |
   | `last month` | after today minus 30 days |
   | `since 2026-10-01` | after that date |
   | `2026-10-01..2026-10-15` | after the first date, before the second |

   For anything else, ask; never guess. The report states the window.
2. **Scope.** For a tag, `aidrian-knowledge route <tag>`. For a topic, `aidrian-knowledge search <words> --all`.
   With neither, every doc `aidrian-knowledge index` lists.
   More than 10 docs without `deep`: ask the user to narrow it first.
3. **Filter.** Skip docs the project's `docs` knowledge marks read-only or authoritative, decision records,
   and docs from a local knowledge source outside the repository. Record each with its reason.
4. **Collect what each doc already cites**, as `references/evidence.md` shows.
   Give researchers the union, and give each doc's packet its own list.
5. **Gather** with the window on every source: `github-archaeologist` for pull requests and issues updated in it,
   `git log --since <date>`, the other sources the project names, and `explorer` only for docs that describe code behavior.
6. **Route the findings.** Give each finding to the one doc it fits best; never to two.
   A doc with no new evidence is skipped and reported, never touched.
   Three or more findings on a subtopic that no doc covers: plan a new doc, mode `create`.
   Put each contradiction between sources in the proposal.

Go on with step 4 of the skill. The report adds the window, the scope, the docs with no new evidence,
and the filtered docs with their reasons. Commit message: `docs(<area>): refresh <topic> knowledge for <window>`.
