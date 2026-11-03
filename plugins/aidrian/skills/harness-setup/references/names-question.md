# The names question

The `harness-setup` skill asks Q4 as written here, with the host's name in place of `<host>`.
A question about names must not itself say "you" or "I", and the question hook blocks one that does.

```text
Question: Agents name both sides instead of writing "you" and "I". What should agents call the person they work for,
and what should agents call themselves?
Options:
- "the Human" and "<host>", for the whole team (Recommended): the plugin's default, so nothing is written.
- Other names, for the whole team: the next question asks for both; they go in config.json.
- Other names, for one developer only: the next question asks for both; they go in the git-ignored `.aidrian.local.json`.
```
