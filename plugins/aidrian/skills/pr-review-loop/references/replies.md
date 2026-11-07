# Reply shapes

Read before the first reply of a run. A thread that does not apply gets the evidence and stays open for the reviewer to confirm.
Each reply starts with the shape for its verdict:

```text
Addressed in <sha>: <one line>.
Not applicable: <evidence>. Leaving this open for you to confirm.
Already handled in <sha>.
Conflicts with <doc path>: <one-line citation>. Open to discussion.
Accepted residual: <why the fix is not worth it now>; marked in <path>.
```

## Where each reply goes

- Inline thread: reply through `gh api repos/{owner}/{repo}/pulls/<n>/comments/<id>/replies -f body=...`.
  Resolve a bot's thread with the `resolveReviewThread` GraphQL mutation when the fix addressed it.
- Review summary or conversation comment: one conversation comment that names the SHA.
