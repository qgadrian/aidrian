# The re-check run

A run of `pr-product-feedback` on a pull request with a record, and no `--full`: it re-checks the fixes alone, and walks
nothing else. `<pr>`, `<number>`, and `<state>` are what the skill names them; step numbers below name the full run's.

1. Take the items whose `state` is `not_rechecked`. None: say so in one line, name `--full` for a new walk, and stop.
   An item whose `found_at` is the head now has no fix pushed yet: leave it, and say so.
2. A persona item: walk its finding's task as its persona, from the report's sidecar, by the `persona-audit` skill's
   `references/reaching-the-product.md`, its build, limits, and levels included. Find its finding by the item's
   `audit_key` in `items --json`, `<report file>#<finding id>`, never by its title nor the record's `report`: in
   `<state>/audits/`, that report's sidecar `<name>.json` holds the finding with that `id`, and its entry in the report is
   the `### ` finding heading at that finding's place in the sidecar's `findings`, with the same title. When that report,
   its sidecar, that `id`, or that heading is missing, leave the item unrecorded: say so in the reply, naming the `audit_key`.
   A persona finding whose entry has a `Width:` bullet (the sidecar holds no width) is walked at each width that bullet
   says it was seen at, and only at those, whatever `walk_widths` says now. A bullet that names personas walks each
   persona at its own widths alone, and each task at its own when it names tasks. A product-manager item: run `diff` again, and dispatch
   `product-manager` as step 2 briefs it, with that item alone.
3. Record each with `aidrian pr product-feedback recheck '<pr>' <id> confirmed --note '<what showed>'` when the finding
   no longer shows at the level it was found at or a better one, else `reopened`. A finding with a `Width:` bullet is
   reopened as soon as it shows at any width the re-check reached. It is confirmed only when it shows at none of them
   and every seen-at width was reached. When it shows at none of the reached widths and a seen-at width was out of
   reach, leave the item unrecorded: say so in the reply, naming that width.
4. Start from the last posted body at `<state>/tmp/product-feedback-<number>.md`, and change only the lines of items
   whose state changed, as [comment-format.md](comment-format.md) words them. When that file is gone, keep the earlier comment and post nothing
   new: say so in the reply. Else post it as step 5 says: it edits the same comment.
