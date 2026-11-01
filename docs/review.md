# Review

`aidrian pr review <PR>` reviews a pull request by a plan: what the change can affect decides how deep the review
goes, the project's critical flows add reviewers that must answer for their invariants, and the reviewers run in
stages. The `pr-review-loop` skill is a loop around it. Projects write config, never code, unless they want to.

With no config at all, a change to docs or assets gets no review, and anything else gets one pass by this machine's
engine. Everything below is optional.

## The plan

A plan has a **depth**, **stages**, and **flows**.

- **Depth** is `none`, `single`, or `split` (below).
- **Stages** run in order, and the passes inside a stage run in parallel. A stage starts only when every finding of
  the stage before it is fixed or dispositioned, and every flow it holds is signed. The defaults:
  1. `local`: the agents the plan requires, and the flow passes.
  2. `independent`: a model other than the author's, such as `codex-local`.
  3. `remote`: the review bot on the pull request.
- **Flows** are the project's critical use cases, below.

### Rules

`review.rules` sets depth and required reviewers from the diff. Every matching rule applies: the depth is the deepest
any matching rule asks for, and the required reviewers are the union. Order never matters, so a rule can never hide
another.

```json
"review": {
  "rules": [
    { "when": { "onlyFiles": ["**/*.css"] }, "depth": "none" },
    { "when": { "anyFiles": ["src/auth/**"] }, "require": ["agent:security-engineer", "independent-model"] },
    { "when": { "lines": { "over": 1500 } }, "depth": "split" }
  ]
}
```

- A path list takes globs and `re:<regex>` entries, matched against the `/`-separated path.
- `when` takes `onlyFiles` (every reviewed file matches), `anyFiles` (some changed file matches), and `lines.over`
  (changed lines, not counting `review.ignore`). That is all it will ever take: anything smarter is a plan command.
- `depth: "none"` needs `onlyFiles`, so it only covers the files it names, and any rule that asks for more wins.
- `require` takes `agent:<name>` and `independent-model`. A plan that requires what this machine cannot run stops as
  `unsatisfied`; it never falls back to a weaker reviewer. So does a flow whose only reviewer would be the review bot,
  which gives no verdicts.

`review.ignore` lists files no review reads and no size counts: lockfiles, snapshots, generated, vendored, and
minified files by default. `review.nonBehaviour` lists files that cannot change behaviour: prose docs and static
assets by default. Tests are not on it: deleting a test changes what the code is held to.

## Split

A large change reviewed in one pass gets a shallow review: the reviewer runs out of attention before it runs out of
diff. `depth: "split"` cuts the change into slices that run in parallel, then one cross-cutting pass.

- **Slices** follow the code: the changed files under one package root (the nearest folder with a `package.json`,
  `go.mod`, `Cargo.toml`, `pyproject.toml`, or similar), else under their first two folders. A slice past
  `review.split.sliceLines` (800) is cut; past `maxSlices` (8), the smallest neighbours merge. A plan command can hand
  over its own partitions as passes.
- **A slice** reads its own files' diff, a manifest of every changed file, and the repository at the head. It reports
  findings in its files only, the contracts its files change (signatures, types, schemas, routes, events), and notes
  about what other files must agree with.
- **The cross-cutting pass** runs after every slice. It reads each slice's contracts, notes, and findings, plus any
  interface files a plan command flags, and reports only bugs that cross slices. It always runs again after a fix.
- **Findings** that two passes report (same file, lines within 3, same title words) are listed once, at the higher
  severity, in `findings_merged`.
- **Failures**: a slice that fails twice runs as two halves; a slice still failing is `stuck`. A review with a slice
  or the cross pass missing is never `received`.
- **Steps**: at most `review.split.parallel` (4) slices run per step, so a step fits one shell call; `running` asks
  for the next. After a fix, only the slices the fix touches run again, and the cross pass.
- The `self` engine splits into one agent dispatch per slice. The review bot cannot split.

Turn it on with a rule, such as `{ "when": { "lines": { "over": 1500 } }, "depth": "split" }`. Before making it a
default above a threshold, measure it on your own history:

```sh
aidrian review bench --prs 812,840,901    # two full reviews per pull request; prints recall per source
```

It replays each merged pull request at the commit its first review saw, once as one pass and once split, against
the problems known to exist: resolved bot threads, resolved human threads, and `fix:` or `revert:` commits that
touched its files within 14 days of the merge. It passes when split finds at least as many as one pass, less one.

## Flows

A flow is a promise the project makes about a use case or a critical surface: creating a booking, taking a payment, a
library's public API, a schema migration. A pull request that touches one gets a reviewer that must answer for each
of its invariants, with evidence, and the flow must be signed before the review passes.

```json
"review": {
  "flows": {
    "booking-creation": {
      "files": ["src/app/api/bookings/**", "src/lib/booking/**"],
      "added": ["holdSlot\\("],
      "invariants": "docs/product/booking-invariants.md",
      "require": ["agent:product-manager"],
      "tests": ["e2e/booking*"],
      "checks": ["E2E booking"]
    },
    "payments": {
      "files": ["src/lib/payments/**"],
      "added": ["service_role"],
      "invariants": [{ "id": "refund-cap", "text": "A refund never exceeds the charge." }],
      "require": ["agent:security-engineer", "independent-model"],
      "signoff": "human"
    }
  }
}
```

| Key | |
| --- | --- |
| `files` | required: globs, or `re:<regex>` over the path; a changed file that can change behaviour triggers the flow |
| `added` | regular expressions over the added lines of any file, for a use that lives outside the flow's folders |
| `invariants` | a doc, whose `##` and `###` headings are the invariants, or a list of `{ id, text, cite?, focus? }` |
| `require` | the flow's reviewers; the code-reviewer agent by default |
| `tests` | the flow's tests: deleting one stops the review until it is restored or the Human accepts it |
| `checks` | check names that must be `SUCCESS` on the head; a skipped or missing one does not pass |
| `signoff` | `reviewer` (default), or `human`: the Human also signs it off with `aidrian pr signoff` |
| `content` | whole-file probes and caller tracing for files the globs miss: [Content and tracing](#content-and-tracing) |

The flow's reviewer answers every invariant `holds`, `violated`, `not_affected`, or `cannot_verify`. `holds` and
`not_affected` must cite `path:line` at the head, `test:<name>`, or `capture:<key>` (an image the
[visual capture](#visual-review) took of the head), and the command checks that the place exists. A
citation proves the line is there, not that it proves the point, so the independent stage gets every flow's
invariants and the earlier verdicts and is asked to challenge each `holds`. A flow with no invariants is held to one
generic invariant, that nothing in it is removed or weakened, and is marked unspecified.

An invariant in a list that cites a heading, `{ "id": "no-double", "cite": "docs/product/booking.md#no-double-booking" }`,
reaches its reviewer with that section as `source`: the heading and its text up to the next heading of the same or a
higher level, read from the base branch. The reviewer judges against the source; `text` is only the question, and
without one the question comes from the heading. So the rule lives once, in the doc, and config cannot drift from it.
A change to a cited doc triggers `harness-config`. `aidrian lint review` warns about a cited section with no text.

A reviewer reads at most 4000 characters of a source. A longer section is cut between its top-level blocks (a list
item with its nested lines, a paragraph, a sub-heading, a code fence), and a note names each block left out and the
cite to read. When the rule is one or two blocks of a long section, `focus` sends only those: one string or a list,
each the first words of a top-level block, matched as whole words, without case, markup, or link targets. Focused blocks get up to
8000 characters, since the project chose them as the rule. When any focus starts no block, as after an edit of the doc,
the reviewer gets the whole section instead, and `aidrian lint review` reports the focus.

```json
{ "id": "controls", "cite": "docs/product.md#core-product-invariants", "focus": "Settings controllability" }
```

A verdict says whether the change keeps the rule, not how the question is worded: `holds` is kept, `violated` is
broken. Ask a question a yes answers with `holds`, such as "Does the change still ...?", and leave the rule in the doc.

Every invariant compares the head with the base branch. When a later round reviews only the commits since an earlier
head, the pass input still carries `flowBase`, the merge base, and the reviewer judges each invariant on
`git diff <flowBase> <head>`: a narrowing an earlier push made counts, and one that undoes this pull request's own
addition weakens nothing.

### Content and tracing

Globs and `added` patterns see paths and new lines. A flow about a privileged value, such as a service-role database
client, also needs the files that use it in lines the change did not touch, and the functions it is handed to.
`content` adds them, with no plan command:

```json
"service-role": {
  "files": ["src/core/supabase/get-admin-client.ts"],
  "added": ["\\bget\\w*AdminClient\\s*\\(", "\\bsupabaseAdmin\\b"],
  "require": ["agent:security-engineer"],
  "content": {
    "roots": ["src", "supabase/functions"],
    "exclude": ["re:(?:^|/)(?:__tests__|__mocks__)/", "re:\\.(?:test|spec)\\.[cm]?[jt]sx?$"],
    "probes": ["\\badminClient\\b"],
    "trace": {
      "variables": ["adminClient", "supabaseAdmin", "ctx.adminClient"],
      "factories": ["get\\w*AdminClient\\s*\\("],
      "params": ["client", "supabase", "db"],
      "aliases": { "~/": "src/" },
      "hops": 2
    }
  }
}
```

- **Content**: a changed source file under `roots`, not under `exclude`, whose whole head content matches one of the
  flow's `added` patterns or `probes`, joins the flow, even when the change only edits a query below the client.
  `probes` are for names that only a whole-file read ties to the flow, which `added` would trip on in every test.
- **Hop 1**: a privileged file (one the flow's `files` name, or whose content matches) calls a function imported from
  the changed file, and the call's arguments hold a `variables` name, a variable assigned from a `factories` call, or
  such a call inline. Named, aliased, default, namespace (`ns.fn(client)`), and generic (`fn<T>(client)`) calls
  count, through one level of `export { } from` barrels. Quoted strings in the arguments are ignored.
- **Hop 2** (`hops: 2`): the same once more inside a selected callee, where a `params` name counts as privileged.
- It reads the head through git in batches: one `git grep` per hop and one batched object read. Any git error stops
  the review, never a plan with less in it. The tracer reads JavaScript and TypeScript (`lib/review/trace-js.mjs`); other files are
  not scanned. A parser for another language is a second module with the same exports.

A project's plan command can report flows the globs miss and `content` cannot, and mark files as
presentation only. A presentation-only file in a flow does not trigger it unless it removes lines: deleting a button
can remove the way into a flow.

### A pull request cannot weaken its own review

The flows, rules, ignore lists, reviewers, engine, plan command, and invariants docs in force are the **base branch's**. The
pull request's own config can only add flows, rules, and reviewers under new names; its changes to the rest, and a
plan command it adds, take effect once they are merged. The plan command runs from a temporary checkout of the base,
so editing its script changes nothing until the merge. A flow the pull request adds reads its invariants from the
pull request. A change to any of these triggers the built-in `harness-config` flow, which the Human signs off. A
flow's deleted test stops the review even when the change touches nothing else in the flow.

`aidrian lint review` fails on a flow whose globs match no tracked file, an invariants doc that is missing or has no
headings, a cite to a heading that is not there, and a `focus` that starts no block of its section. It warns past 16
flows, or 10 invariants in one flow; about a source past its limit, 4000 characters or 8000 with `focus`; about a question that asks
whether the change breaks, removes, weakens, or bypasses something, so that yes would be the breach; and about a cited
invariant's text past 200 characters, which restates the rule. The budget
stands for how many passes a review dispatches (an agent reviews up to 3 flows per pass); a flow is a critical path,
not every feature. The warning never blocks.

### Sign-off by the Human

`signoff: "human"` adds `aidrian pr signoff <PR> --flow <id> --head <sha>`, run by the Human in their own shell (`!`
in a Claude Code prompt, or another terminal). The `review-signoff` rule ([hooks.md](hooks.md#bash-rules)) blocks an
agent that runs it. It is still an audit entry, not proof: an agent holds the same GitHub token. Every sign-off and
override is listed in the review summary on the pull request, or only in the local record with `review.record:
"local"`. For proof, protect the branch with a required review from a second account.

A sign-off holds on a later head when the signed head is its ancestor and the change since selects nothing of the
flow, through the same selection the plan uses: its globs, `added` patterns, `content`, the plan command, its tests,
and its invariants docs. A push that touches nothing of the flow does not ask the Human again; a rebase does. A
deleted flow test is still accepted only for the exact head.

## Visual review

A change to a screen gets reviewed as a picture too. `review.visual` names the screens; before the visual reviewers run,
`aidrian pr review` captures every touched route at each width, locale, and variant, and hands them the images with
facts measured in the page: horizontal overflow, text cut off by its box, and controls under 44 px.

```json
"review": {
  "visual": {
    "platform": "web",
    "targets": [{ "files": ["re:^src/app/.*\\.tsx$", "src/components/**"], "routes": ["/dashboard", "/{locale}/book"] }],
    "viewports": [360, 768, 1280],
    "locales": ["en", "de"],
    "variants": [{ "id": "hospitality", "account": "demo-hospitality" }, { "id": "appointments", "account": "demo-appointments" }],
    "login": "node scripts/visual-login.mjs",
    "preview": "node scripts/preview-url.mjs",
    "checklist": "docs/ui/visual-ui.md#fit-checks"
  },
  "flows": {
    "ui-surface": { "files": ["re:^src/app/.*\\.tsx$", "src/components/**"], "require": ["agent:designer", "agent:ux-specialist"],
      "invariants": [{ "id": "fit", "cite": "docs/ui/visual-ui.md#fit-checks" }] }
  }
}
```

| Key | |
| --- | --- |
| `platform` | `web`: Playwright, loaded from the project's own dependencies (`playwright` or `@playwright/test`) |
| `targets` | which changed files capture which routes; a route may hold `{locale}`, and `base` names a base the login prints, for screens on another host or path. `locales` and `variants` narrow the target to a subset of the lists below; `"locales": []` is one capture in the default locale |
| `viewports`, `locales` | the widths and locale tags; each image is taken at one of each |
| `variants` | the product modes to capture, each with the name of a demo account to sign in as, or none for a public page |
| `login` | a command, run from the base branch, that reads `{ account, variant, baseUrl, locales }` on stdin and prints `{ "storageState": {...}, "baseUrl"?, "bases"?, "locales"? }`; the account's secret comes from its environment, never config |
| `preview` | a command, run from the base branch, that reads `{ pr, head }` and prints the base URL, such as a preview deployment |
| `attach` | `auto`, `local`, or `off`; unset, `auto` on a private or internal repository and `local` on a public one |
| `reviewers` | the agents that get the captures; `designer` and `ux-specialist` by default |
| `checklist` | a doc the visual reviewers check against, included in their input |

- The base URL is `review.visual.baseUrl` in `.aidrian.local.json`, a machine setting such as `http://localhost:3000`,
  else the `preview` command's. With neither, or without Playwright, the reviewers get a status instead of images
  and review from code; the review does not stop.
- **Bases**: a variant's routes open on its `baseUrl` from the login, else the machine's. A screen elsewhere, such as
  a public page on a per-variant subdomain or sign-in at the app root, goes in a target with `"base": "guest"`, and
  the login prints it per variant: `"bases": { "guest": "http://shop.localhost:3000", "root": "http://localhost:3000" }`.
  A variant whose login prints no such base gets an error entry for that route, never a capture of another host.
- **Signed in per locale**: a screen that takes its language from a stored user or organization preference ignores
  the browser locale and `{locale}`. The login then prints a persona per locale, `"locales": { "de": { "storageState":
  {...} } }`, and each field it gives (`storageState`, `baseUrl`, `bases`) replaces the variant's for that locale's
  captures. A tag not in `review.visual.locales` fails the capture. A login that ignores `locales` signs in once per
  variant, as before.
- **Per target**: a screen that does not change with the mode or the language narrows its target, such as
  `"variants": ["hospitality"]` or `"locales": ["en"]`. A route two touched targets list gets both targets' captures.
- **Limits**: a route may ask for at most 60 images (viewports x locales x variants, per target), a config error past it. One
  review captures at most 200; past that it stops as `too_large` and names the routes to narrow.
- **Once per head**: the capture runs when a visual reviewer is dispatched, and its manifest (each image's key, file,
  hash, and facts) is kept in the state folder. Flow verdicts cite an image as `capture:<key>`; a key of another head
  is no evidence. Animations are off and motion is reduced, so an unchanged screen gives the same bytes.
- **Attach**: with `auto`, `aidrian pr review` uploads the images through the
  [gh-image](https://github.com/drogers0/gh-image) extension, with no confirmation, into one captures comment edited
  in place. It uploads only images this capture wrote and listed, checked by hash and PNG signature, and each hash
  once. The visibility is read at upload time, so a repository made public later stops uploading by itself, and the
  review summary shows the mode and the visibility. Without gh-image the images stay local and the review goes on.
- `review.visual`, `login`, and `preview` are the base branch's, like the plan command: a pull request cannot switch
  itself to attaching or point the capture elsewhere, and a change to them triggers `harness-config`.
- A presentation-only change, such as a class name, triggers the flow by its path like any other change.

### Findings one by one

A visual reviewer records its pass with `--findings-file` rather than counts, so the
[disposition table](../plugins/aidrian/lib/finding-disposition.json) decides what blocks, not the reviewer's word:

```json
[{ "title": "Label clipped at 360px", "file": "src/app/x.tsx", "line": 4, "severity": "medium", "likelihood": "routine", "affects": "users", "state": "open" }]
```

A finding blocks the pass while it is open and not `acceptable_as_is`, or accepted with a disposition that cannot be
accepted (`fix_now`, or no likelihood and affects yet). Any agent pass may record this way. Flow results gate the
review step; they are not a merge gate by themselves, so protect the branch with the checks the review posts.

## Reviewers

Every reviewer is an entry in one map. The built-ins:

| Name | Kind | Stage | |
| --- | --- | --- | --- |
| `codex-local` | exec | independent | Codex on this machine, read-only, findings held to a JSON schema |
| `self` | agent | local | the code-reviewer agent; never the author |
| `pr-bot` | remote | remote | `github.reviewer`, as `aidrian pr await-review` waits for it |

A project adds its own in `review.reviewers`:

```json
"review": {
  "reviewers": {
    "semgrep": { "kind": "exec", "command": ["scripts/review-semgrep.sh"], "stage": "local", "independent": false, "timeoutSec": 300 },
    "a11y": { "kind": "agent", "agent": "a11y-reviewer" }
  }
}
```

- `exec`: the command reads the pass as JSON on stdin (`base`, `head`, `files`, `flows`, `priorFindings`) and prints
  `{ "findings": [{ file, line, title, body, severity }], "verdicts": [...] }`. It runs with no session, override, or
  git variables in its environment, in its own process group, with a time limit: SIGTERM, then SIGKILL. Output that does not parse is a failure, never a pass;
  malformed findings are dropped and named. A failure is `incomplete` and retried; the third is `stuck`.
- A project's own exec reviewer runs from a temporary checkout of the base, like the plan command, and reads the head
  through git: a pull request that edits its script cannot run its own version, and the edit triggers
  `harness-config`. The checkout's installed dependency folders (`node_modules`, `vendor`, `.venv`) are linked in, so
  the base code runs with this machine's packages. A reviewer the pull request adds runs once it is merged.
  `codex-local` reads the checkout at the head.
- `agent`: the command cannot start an agent, so it returns `dispatch` and the skill runs it and records the result.

### The engine

`review.engine` in `.aidrian.local.json` picks this machine's reviewer: `auto` (default), `codex-local`, `pr-bot`,
`self`, or a reviewer of `review.reviewers`. `auto` takes `codex-local` when Codex is installed and logged in, else the
review bot, else `self`, and the result says which and why. It is a machine setting because the same project runs on
machines with and without Codex.

A project that wants one engine everywhere sets `review.engine` in config.json, with the same values. It is policy:
it wins over every machine's local setting, the result's reason says it came from the project config, and like the
rest of the review config it is the base branch's. Unset, each machine picks its own.

## Rounds

A round is one run of the plan on one head. The cap is `github.maxReviewRounds` as the base branch commits it, so an
edit to the working copy's config cannot raise it, and raising it needs `AIDRIAN_ALLOW_EXTRA_ROUNDS=1` in the Human's
own shell. The `review-rounds` rule ([hooks.md](hooks.md#bash-rules)) refuses an
agent command that sets it, and a bot request posted any way but through `aidrian pr`. The last round runs the final stage first, so a pull request
always gets its independent review before the cap, then lets the earlier stages finish on the same head; it passes
when nothing is left to fix, and stops at the cap when a fix would need another head. A reviewer that fails or hits
its quota gives the round back. After a fix, each pass re-reviews only what changed since its last review; a pass
the change does not touch carries forward.

`--with-bot` adds the review bot as a last stage after this machine's engine. The bot is asked only once every
earlier pass has a result, with the review gate's marker, under the plan's round cap; an answer for a commit other
than the one under review counts for nothing. A flow's required checks are read for that commit too.

## The plan command

`review.planCommand` runs a project's own planner: it reads `{ base, head, changes }` on stdin and prints a plan in
the same shape as the built-in one. The built-in plan is computed too, and the two merge: the command may add depth,
flows, passes, and stages, and reorder stages, never remove or replace a built-in pass or flow: a pass with a built-in
pass's id is dropped, and the plan says so. Its passes then merge with the built-in ones per agent, so an agent both
plans ask for is dispatched once; a flow both plans name keeps the files and reasons of both. A plan that names a
reviewer nobody can run is refused. A failed command shows the last lines of its stderr, with token-shaped strings
masked. The command and its files are the base branch's, like the rest of the review config.

## The record

The review config of the pull request is read from its head commit, so a step run from another branch plans the
same review. Each step writes the review's record to the state folder and to one summary comment on the pull request, edited in
place: the rounds, each pass's result per head, the verdicts, the sign-offs, and the overrides used. Another machine
reads it from the comment. It is the reviewers' word, not proof, and it is all visible on the pull request.

With `review.record: "local"` in config.json, the record is written to the state folder only: nothing is posted or
edited on the pull request, the visual captures comment included, and the record is read back from the state folder alone. Another machine then cannot
see it or resume the review; it starts a record of its own.
