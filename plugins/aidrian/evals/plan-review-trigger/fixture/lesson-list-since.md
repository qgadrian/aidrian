# Plan: filter `aidrian lesson list` by age

## Goal

`aidrian lesson list --since <duration>` lists only the lessons filed within that duration, such as `--since 7d`,
so a reader can see what the last week added without paging through the whole inbox.

## Approach

1. Accept `since` in `list` in `plugins/aidrian/lib/lesson-cli.mjs`; the option already exists for `stats`.
2. Parse it with the same `parseSince` that `stats` uses, and keep the lessons whose `at` falls inside it.
3. Apply it after the `--status`, `--tier`, `--kind`, and `--target` filters, and before `--limit`.
4. Add `[--since 30d]` to the `list` usage line.

## Tests

- A `node --test` case in `test/` lists three lessons of different ages with `--since 7d` and gets the newer ones.
- An invalid duration exits non-zero with the same message `stats` prints.

## Out of scope

- A `--until` bound.
