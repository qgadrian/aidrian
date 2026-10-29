# Mode: extend

Fold one resource into the doc it belongs in.

Input: one resource; optionally a target doc path or a tag.

1. **Classify the resource**, first match wins:

   | Resource | Research it with |
   | --- | --- |
   | A pull request or issue URL | `github-archaeologist` |
   | A bare `#N` | Resolve it first, `gh pr view N --json url -q .url`, else `gh issue view N --json url -q .url`; then as above |
   | A tracker key or URL | The tracker tool, with its relations and attached links |
   | A commit hash | `git show --stat <hash>`, and `github-archaeologist` for its pull request |
   | A doc path | `explorer`, to check the doc's claims against the code |
   | A link to another system the project names | That system's tool, read-only |
   | Anything else | Ask the user what it is |

2. **Pick the target.** A given doc path is the target. For a given tag, take the best fit `aidrian-knowledge route <tag>` lists.
   Otherwise search with the resource's title, labels, and changed paths. Collect the links the target already cites.
   If the resource clearly spans three or more docs, stop and suggest `refresh` mode instead.
3. **Research the seed** with its one researcher.
4. **Follow its links one level.** Take the links and doc paths in the seed's findings, minus the seed and anything already cited.
   Classify each as in step 1 and research them all in one parallel batch, each briefly.
   Never follow the links those return: list them in the report as not followed.
5. **Route.** The seed's findings go to the target; each followed finding to the doc it fits best.
   A followed finding that no doc fits: propose `generate` mode for it with a topic name, or list it for the user
   when no clear name comes out.
   The mode is `update_section` or `append`; `create` only for a new path the user named.

Go on with step 4 of the skill. The report adds the resource's type and link, the decisions and won't-do entries it held,
and the links not followed. Commit message: `docs(<area>): fold <resource title> into <doc>`.
