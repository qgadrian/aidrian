# Review manifest

`<state>/reviews/pr-<n>.json`, where `<state>` is the folder `aidrian state` prints.
There is one file per pull request, and every worktree of the repository shares it.
The `pr-review` skill writes the rounds and the findings; the `pr-review-fix` skill writes the progress of each fix.

```json
{
  "pr": 42,
  "head_sha": "<the head the last round reviewed>",
  "base_sha": "<its merge base>",
  "round": 2,
  "comment_id": 123456789,
  "findings": [
    {
      "id": "F1",
      "specialist": "code-reviewer",
      "severity": "high",
      "likelihood": "plausible",
      "affects": "users",
      "cost": "bounded",
      "file": "src/orders.js",
      "line": 42,
      "summary": "A failed save is reported to the user as a success.",
      "next_step": "Return the error to the caller, and test the failure path.",
      "disposition": "fix_now",
      "status": "open",
      "raised_in": 1,
      "commit": null,
      "attempts": 0,
      "note": null
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `head_sha`, `base_sha` | The commits the last round reviewed. Written with that round's findings, never before. |
| `round` | How many review rounds have run. |
| `comment_id` | The pull request comment every round updates; `null` while nothing was posted. |
| `id` | `F<n>`, numbered on from the highest id in the file, never reused. |
| `specialist` | The agent that raised the finding; two agents, comma-separated, when both raised it. |
| `severity`, `likelihood`, `affects`, `cost` | The agent's axes, as it gave them. A missing `cost` means `bounded`. |
| `file`, `line` | Where it is; `line` is the first line, `null` for a whole file. |
| `summary`, `next_step` | The agent's words. |
| `disposition` | The output of `aidrian pr disposition` for the axes. Never set by hand. |
| `raised_in` | The round that raised it. |
| `commit`, `attempts`, `note` | Fix progress: the commit that fixed it, the fix passes so far, and why a fix is blocked. |

## Status

| Status | Set by | Meaning |
| --- | --- | --- |
| `open` | `pr-review` | Raised and not fixed. |
| `disputed` | `pr-review` | Two agents disagree; waits for the user. |
| `pre_existing` | `pr-review` | Real, but the pull request did not introduce it. Reported, not fixed here. |
| `in_progress` | `pr-review-fix` | A fix was dispatched. |
| `fixed` | `pr-review-fix` | The fix is committed and waits for the next round. |
| `blocked` | `pr-review-fix` | Two passes did not fix it, or the fix needs a decision; `note` says which. |
| `resolved` | `pr-review` | A later round confirmed the fix. |

A fix is not `resolved` until a review round says so.
When the user settles a disputed finding, the skill that asked writes the choice into `note`,
and sets `open` with the chosen direction in `next_step`, or `resolved` when the user decides it needs no change.

## Writing

Read the file just before each write, change only your own fields, and keep every other field and finding as it is.
Write the whole file to a temporary file in the same folder, then rename it over the old one.
A missing file is round 0 with no findings; an unreadable one is reported, never overwritten.
