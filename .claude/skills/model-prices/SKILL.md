---
name: model-prices
description: Update the plugin's model price tables from each vendor's pricing page and open a pull request. Use when a price changes, a model ships, or health flags prices.
---

# Model prices

Every cost the plugin reports comes from price rows the host adapters own as data.
This skill reads each vendor's page and brings the rows in line with it. A price the page does not show is never guessed.

`docs/dispatch-log.md` § Model prices lists the fields of a table and how a row matches a model id.

## Where each host's prices are

| Host | Rows | `source` page |
| --- | --- | --- |
| Claude Code | `plugins/aidrian/lib/hosts/claude-code-prices.mjs` | `https://platform.claude.com/docs/en/about-claude/pricing` |
| Codex | `modelPrices` in `plugins/aidrian/lib/hosts/codex.mjs`, empty | `https://developers.openai.com/api/docs/pricing` |

Codex keeps an empty table while its adapter has `capabilities.transcripts: false`: no Codex transcript is read, so no row would ever be used.
Fill it in the same change that adds a Codex transcript reader.

## Steps

Copy this checklist and tick each step:

```text
- [ ] 1. Task worktree
- [ ] 2. Page read in full, date noted
- [ ] 3. Each row compared, changes listed old -> new
- [ ] 4. Rows and readOn updated
- [ ] 5. New models added, models list and fallback rows current
- [ ] 6. Tests and npm run check pass
- [ ] 7. Draft pull request with the change list
```

### 1. Task worktree

`aidrian worktree new fix/model-prices`. Never edit in the main checkout.

### 2. Read the page

Fetch the `source` page with WebFetch. A long page comes back as a saved file of the page's own Markdown: read its tables there.
A short answer from the fetch's summarizer is not a read, since it may reorder or round columns.
Ask it to reproduce the tables verbatim, or read the saved file.
Note today's date: it becomes `readOn`.

For Claude, read the "Model pricing" table, its footnotes (the cache-hit multiples other than 0.1x), and "Long context pricing".

**Check:** each model row of the table is in front of you as the page writes it.

### 3. Compare each row

For each model on the page:

- `input`: "Base input tokens". `output`: "Output tokens".
- `cacheRead`: set only when "Cache hits and refreshes" divided by the base input is not 0.1, as the footnotes say.
- `over`: a higher price for long prompts, as Haiku 5.5's over 100,000 tokens: `{ prompt, input, output }`.
- The 5-minute and 1-hour cache writes must be 1.25x and 2x the base input.
  If a model differs, stop: `lib/model-prices.mjs` assumes them, so that needs a code change first.

Write each difference down as `<model>: <field> <old> -> <new>`.

**Check:** every page row has a table row, or is listed as new.

### 4. Update the rows

- Change each differing value.
  Set `readOn` to today on every row the page confirmed: in Claude Code's file that is the `READ` constant.
- A model the page no longer lists keeps its last price: move its row to the `RETIRED` spread, which marks it `unconfirmed`.
  Never delete it, and never change its price.
- Keep `source` the page you read.

### 5. Add a new model

- `match` is the version part of the API model id: `claude-opus-5-6` gets `opus-5-6`.
  It matches where the version ends, so it needs no ordering against `opus-5`.
- When a model choice now names it (`sonnet`, `opus`, `haiku`, `fable` in `modelChoices.model` of `claude-code.mjs`), replace that family's id in `models`.
- Set the family's `fallback: true` row to its newest model's price.

**Check:** `node --test test/model-prices.test.mjs` passes: every id in `models` has a row of its own.

### 6. Run the checks

```bash
node --test test/model-prices.test.mjs test/transcript.test.mjs test/session-length.test.mjs test/report-health.test.mjs
npm run check
```

A test that pins a price you changed, such as the rates in `test/transcript.test.mjs`, changes with the price; name each in the pull request.
Then `plugins/aidrian/bin/aidrian report health --project .` in this repository, the one project where a stale table ranks:
its "Model prices" line says `ok`, or names only models the page does not list.

Fix what failed and run both again.

### 7. Open the pull request

Commit as `fix(prices): <what changed>`, push, and open a draft pull request with the `pr-write` skill. The body lists:

- each change, `<model>: <field> <old> -> <new>`, under the source link and the date read;
- each new row, and each row moved to `RETIRED`;
- each price the page did not confirm, and why it stays.

When the plugin's inbox holds a `health:price-stale` or `health:price-fallback` lesson (`aidrian lesson list --target plugin`),
resolve it with the pull request:

```bash
aidrian lesson resolve <id> --outcome mechanism --link <pull request> --expect 'aidrian report health: Model prices ok'
```
