# Re-check fixes

For each fix in `aidrian lesson stats` that has held for 14 days or more and has an `expect` line, run the command it names.
When the number did not move, record that as one more occurrence, with the numbers as evidence:

```bash
aidrian lesson add --same <id> <<'LESSON'
evidence: <the command and its output>
the fix did not move <the number>
LESSON
```

That reopens the lesson for the next batch. When the number moved, record nothing.
