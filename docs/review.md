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
  which gives no verdicts. Only the Human picks a fallback, for a reviewer [out of quota](#out-of-quota), and none
  meets `independent-model`.

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
| `invariants` | a doc, whose `##` and `###` headings are the invariants, a repeated one numbered `-1`, `-2` as GitHub numbers its anchor; or a list of `{ id, text, cite?, focus?, approvers? }` with unique ids, where `approvers` lists the GitHub logins whose review may close the invariant ([Sign-off by the Human](#sign-off-by-the-human)) |
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

The record stores each verdict's evidence as the reviewer wrote it, prose included. Only a citation of the three forms
above signs a `holds` or `not_affected`: prose evidence on either leaves the invariant unverified until a cited verdict
or an outside approval closes it. The verdict schema is unchanged.

An invariant in a list that cites a heading, `{ "id": "no-double", "cite": "docs/product/booking.md#no-double-booking" }`,
reaches its reviewer with that section as `source`: the heading and its text up to the next heading of the same or a
higher level, read from the base branch. The anchor may be copied from GitHub, as the heading's link gives it.
The reviewer judges against the source; `text` is only the question, and
without one the question comes from the heading. So the rule lives once, in the doc, and config cannot drift from it.
A change to a cited section triggers `harness-config`: its heading or text differs between the base and the head,
or its heading is gone, which covers a heading inserted into it or removed after it. An edit elsewhere in the doc
does not. An invariants doc, or a `cite` with no `#anchor`, is
cited whole, so any change to it triggers the flow. `aidrian lint review` warns about a cited section with no text.

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

The flows, rules, ignore lists, reviewers, engine, plan command, approvals switch, invariant approvers, and invariants docs in force are the **base branch's**. The
pull request's own config can only add flows, rules, and reviewers under new names; its changes to the rest, and a
plan command it adds, take effect once they are merged. The plan command runs from a temporary checkout of the base,
so editing its script changes nothing until the merge. A flow the pull request adds reads its invariants from the
pull request, and takes its invariants' `approvers` from there too, so the config change that adds it waits for the
Human's `harness-config` sign-off. A change to any of these triggers the built-in `harness-config` flow, which the Human signs off. A
flow's deleted test stops the review even when the change touches nothing else in the flow.

`aidrian lint review` fails on a flow whose globs match no tracked file, an invariants doc that is missing or has no
headings, a cite to a heading that is not there, a `focus` that starts no block of its section, and an approver that is not a GitHub login. When `git ls-files`
cannot run in the project, it fails with that alone, instead of reading every flow as matching nothing. It warns past 16
flows, or 10 invariants in one flow; about an invariants doc that repeats a heading, naming the ids it gets; about a source past its limit, 4000 characters or 8000 with `focus`; about a question that asks
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
Like `aidrian pr attest`, it files the sign-off under the pull request's repository: `--repo OWNER/NAME`, else the one
`gh pr view` names, else origin.

`aidrian pr signoff <PR> --last` is the short form, short enough to type from a phone, with no sha, flow id, or free
text. It serves one stop only: the last `aidrian pr review` stopped at `human_required` naming one flow. It signs off
that flow, on the head that review ran on, under the git user's name, exactly as `--flow <id> --head <sha>` does; only
`--repo` and `--check` combine with it. It reads the pull request's head from GitHub and the last review's record, and
refuses when:

- no review ran, or the pull request has moved past the reviewed head;
- the last review stopped at any other status, or the Human took over a stage on that head: an unsigned one with
  `--stage`; once signed, the flow with its long command;
- no flow waits, or two or more wait (it lists each with its long command, since the record keeps no order among them);
- the flow still owes an `--overrule` or an `--accept`, which it never records;
- the pull request's repository, from `--repo` or else the one `gh pr view` names, is no remote of this checkout (a
  fork's parent counts once it is a remote, such as `upstream`), or is not the one the record names.

A sign-off the review kept from an older head is not in the record, so `--last` counts that flow as waiting. The
`review-signoff` rule blocks a session that runs it, `--check` aside, as it blocks the long form.

The command signs only a flow the last `aidrian pr review` on that head asks the Human to sign: one with
`signoff: "human"`, the built-in `harness-config`, or one whose test the change deletes. It refuses any other flow, and
a head no review ran on, since such a sign-off would count for nothing. A sign-off never clears a violated invariant.

**A dispute between reviewers.** When one reviewer answers `violated` and another, one that gave no `violated` verdict
of its own, answers `holds` or `not_affected` with valid evidence, the flow in `fix_required` lists the invariant under `disputed`, with an `overrule` command:
`aidrian pr signoff <PR> --flow <id> --overrule <invariant> --head <sha> --reason "<why>"`. The Human runs it in their
own shell, and the invariant then passes on that head on the other reviewer's evidence, never on the Human's word
alone. The ruling holds for that head only and is listed with the overrides in the review summary. The command
refuses an invariant that is not disputed on that head, and a ruling with no reason. On an invariant the last review of
that head lists as `unverified`, the refusal names the two routes that close it on evidence outside the tool: where
the base branch sets `review.visual`, the `aidrian pr ingest` command, for a reviewer to cite the image; or the
`--accept` command below. A violated invariant that no reviewer disputes gets neither: fix the code.

**Evidence outside the tool.** Some invariants no reviewer can verify, because the evidence lives elsewhere: a
designer approved real screenshots while no app runs for the [visual capture](#visual-review). Such an invariant stays
`unverified`, and a second account can close it on one head with no Human in the session:

```json
{ "id": "matches-design", "text": "Does the screen still match the approved design?", "approvers": ["amy-designer"] }
```

A GitHub review closes it when its state is `APPROVED`, it was given on exactly the head under review, its author is
one of the invariant's `approvers` and not the account the session's `gh` token belongs to, and its body holds the line
`aidrian-approve: <flow>/<invariant>`. A comment is never an approval: only a review carries the commit it approves.
Only each approver's latest verdict on the head counts, as GitHub's own review decision reads it: a later review that
requests changes on the head takes the approval back, a comment-only review changes nothing, and the latest
approval must hold the line itself.
A push drops the approval, as it drops every sign-off. The path is on only with both switches on: the team's
`review.approvals.allow: true` on the base branch, and this machine's `"reviewApprovals": "on"` in the git-ignored
`.aidrian.local.json` ([Config](config.md#review-plan)). With either off, `aidrian pr review` ignores approvals and its
`approvals.off` names the switch. The approvals are read once per step; a read that fails closes nothing, and
`approvals.error` says why. The review summary lists each approval apart from the reviewers' verdicts, as
`approved by @login on <sha7>: <review url>`. An approval never clears a violated invariant: fix the code.
The approval is as strong as the approver's account: give `approvers` only accounts no agent can use, and keep a
required review on the protected branch for proof.

With the Human in the session, the Human may close such an invariant themselves:
`aidrian pr signoff <PR> --flow <id> --accept <invariant> --evidence <url> --reason "<what it shows>" --head <sha>`,
run in their own shell. `<url>` is the GitHub link of one of that pull request's own comments
(`#issuecomment-<id>`), reviews (`#pullrequestreview-<id>`), or review comments (`#discussion_r<id>`), on the pull
request's host. The command reads that item from GitHub by its id and checks it belongs to the pull request.
Any other URL is refused, an uploaded screenshot or file included: cite the comment or review that holds it.
The acceptance holds for that head only, and the review summary lists it apart from the verdicts, as
`accepted by <name> on <sha7> on outside evidence: <url>: <reason>`. The command refuses an invariant the last review
of that head does not list as unverified, a violated one above all, an evidence URL GitHub cannot find on the pull
request, and an acceptance with no reason. Like every sign-off, it is an audit entry, not proof.

**Ingesting images.** Screenshots taken outside the tool, such as the ones an end-to-end run took while no app runs
for the visual capture, become captures of one head:
`aidrian pr ingest <PR> --head <sha> --source "<where they came from>" <image>...`. The Human or an agent may run it,
such as the end-to-end runner that took the images; it signs nothing off. Each image is copied into that head's capture
folder and recorded with its key, its hash, and its source: the `--source` text, the file's path, who ingested it (the
git user), and the session it ran in. Where the host layer detects an AI session, the record says so and names the
agent when the host gives one (`via <agent>`, else `in an AI session, agent unknown`); the Human's own shell gives
the name alone. A reviewer then cites the image as `capture:<key>` in a flow verdict, as for any capture, and the
invariant closes on that verdict. The command refuses a file that is not a PNG, JPEG, GIF, or WebP image by its bytes,
a path that is not a file, a file outside the working tree and the state folder (symlinks resolved), and a `--source`
that is empty or holds `<` or `>`; `--check` runs every refusal and records nothing. The same image under the same
file name ingests again in place. The ingest holds for that head only: a push drops it with the head's other state.
It counts only in a review whose base branch sets `review.visual`, since the review reads a head's captures only then.

Every surface shows an ingest as `ingested, not captured`, with its source and who ingested it in code spans, and
never counts it as a capture. An ingest made before a visual reviewer is dispatched on that head is in the captures
comment that capture posts. A later one rewrites that comment when this machine's capture wrote it: a comment a
member or the session's own account posted, whose heading names that head. Where another machine captured the head,
the comment is left as it is: the ingest lives in this machine's state folder and counts only here, and ingesting the
same images on the machine that captured the head shows them on the pull request. With `review.record: "local"` there
is no captures comment to rewrite;
a forge failure is a warning, and the ingest stays recorded. The review summary's visual line names an ingest made
before a visual reviewer is dispatched, unless that capture took every image, as many entries as fit the line whole
and the count of the rest.
A later ingest, or one on a head the tool captured, is not in the summary line or the record's captured keys:
it reaches the reviewer input and the local manifest, and counts only on the machine that holds it. The step does
not dispatch the visual reviewer again for it: the session runs that reviewer by hand with the ingested files, and
records the pass again with `aidrian pr attest --pass <id>`. An ingested image is never uploaded, so its source is what a reader on the pull
request sees. The source is self-reported: like every sign-off, an ingest is an audit entry, not proof.

**The next step.** Each flow in `fix_required` carries `next`, one entry for every open invariant:
`{ invariant, state, commands, notes }`. `commands` holds only `aidrian pr signoff` commands; `notes` holds the rest.
A `violated` one has the note `fix the code`; a `disputed` one gives its `--overrule` command. An `unverified` one
gives the `--accept` command, and as notes the approval to ask for, the review of the head and its
`aidrian-approve:` line, when the invariant names approvers and both switches are on, and, for a flow a visual
reviewer judges while the head has no capture, the capture's status line, such as what it needs to run. A session
offers the Human only these commands, never one of its own making, with one exception: at `human_required` naming one
flow, once `aidrian pr signoff <PR> --last --check` exits 0, it hands the Human `aidrian pr signoff <PR> --last` in
place of the long command, naming the flow and short head that `--check` printed.

**Trying a command first.** `--check` on any `aidrian pr signoff` command, `--flow`, `--overrule`, `--accept`,
`--stage`, or `--last`, runs every refusal of that command and records nothing. It prints `ok` and exits 0, or prints the refusal
and exits 1. The `review-signoff` rule lets an agent run it, so a session can check a command before it hands it to
the Human.

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
  the browser locale and `{locale}`. The login then prints a profile per locale, `"locales": { "de": { "storageState":
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
- **Ingested images**: `aidrian pr ingest` ([Ingesting images](#sign-off-by-the-human)) adds images taken
  elsewhere to the manifest's own `ingested` list, never to the tool's entries. Each key is
  `ingest-<file name>-<6 hex of its hash>`, so the same image under the same file name ingests again in place. The
  visual reviewers find each in `visual.captures` with `ingested: true` and its `source`, and no measured facts. A
  manifest with no tool capture has the status `ingested` and is captured over when the capture next runs; the
  ingested list survives it. The source is self-reported, an audit entry, not proof.
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

## Paths

Every path in `review` and `github.reviewGate.checklist` is relative to the project root, the folder that holds
`.aidrian/` or that `.aidrian.json` names, as `aidrian lint review` reads them. So is the `path:line` of a verdict's
evidence. At the repository root, the usual case, nothing differs.

A project below the repository root, such as `apps/web/`, writes `src/**` for `apps/web/src/**`. Its review covers only
its own folder: it reads the pull request's changes relative to that folder and does not review files outside it, so a
pull request that touches only files outside it reports `none_needed`. Its reviewers, plan command, and visual hooks
run in that folder of the base checkout, with the project's and the checkout top's dependency folders linked in.
The built-in engine and every dispatched agent are told to run `git diff` there with `--relative` and to cite from the
project root; a project's own exec reviewer that runs `git diff` passes `--relative` itself.

## Reviewers

Every reviewer is an entry in one map. The built-ins:

| Name | Kind | Stage | |
| --- | --- | --- | --- |
| `codex-local` | exec | independent | Codex on this machine, read-only, findings held to a JSON schema |
| `self` | agent | local | the code-reviewer agent; never the author |
| `pr-bot` | remote | remote | `github.reviewer`, as `aidrian pr await-review` waits for it |

`codex-local`'s Codex run also serves plans: the `quorum` skill runs it as a plan's adversary, and the `plan-review`
skill runs the quorum on high-stakes plans ([quorum ledgers](project-folder.md#local-state)).

A project adds its own in `review.reviewers`:

```json
"review": {
  "reviewers": {
    "semgrep": { "kind": "exec", "command": ["scripts/review-semgrep.sh"], "stage": "local", "independent": false, "timeoutSec": 300 },
    "a11y": { "kind": "agent", "agent": "a11y-reviewer" }
  }
}
```

- `exec`: the command reads the pass as JSON on stdin (`base`, `head`, `files`, `flows`, `priorFindings`,
  `acceptedResiduals`) and prints `{ "findings": [{ file, line, title, body, severity, already_ruled }], "verdicts": [...] }`;
  a finding keeps only those keys, and `already_ruled` may be left out. It runs with no session, override, or
  git variables in its environment, in its own process group, with a time limit: SIGTERM, then SIGKILL.
  Output that does not parse is a failure, never a pass; malformed findings are dropped and named.
  A failure is `incomplete` and retried; the third is `stuck`.
- Settled findings: an exec pass's `priorFindings` add every finding the record holds as accepted that no longer
  blocks, with the pass that accepted it as `settled_by`, and the pass's own last rulings on such a finding; only an
  entry with a file and a severity the disposition table knows can settle a repeat. `acceptedResiduals` holds the items
  of the pull request body's accepted residuals section (`github.pullRequest.residuals.section`, at most 20, 300
  characters each). A finding that repeats one sets `already_ruled` to that entry's title, or the residual's text,
  verbatim; any other finding sets it empty. A prior entry settles only a finding in its own file at its severity or
  lower, and never above `medium`: a `high` or `critical` repeat is weighed again. A residual settles only a `low`
  finding, unless it is anchored (below), and a prior entry of the same title takes precedence over it. A repeat that
  passes goes on the pass record as `ruled` (title, file, line, severity, `already_ruled`, `from`: `prior` or `residual`,
  and for a prior entry `settled_severity`, its severity, and `settled_by` when known; for an anchored residual
  `settled_severity` and `residual`, its text), counts among the findings but never as open, and the
  summary comment lists each pass's waived count and titles, each with who settled it, every reviewer-supplied text as
  inline code, so none renders as a link, an image, or emphasis. Each line gives the repeat's severity and
  `settled_severity`, and a second line per pass lists the anchored residuals it holds as standing, on each head, whether
  or not the pass repeated them. Under `review.record: "local"` no summary is posted, so the pull request body's line is
  the only trace on the pull request. One that fails stays a new, blocking finding, named in the pass's `dropped` notes,
  which each entry of a `fix_required` result's `open` list repeats. An accepted entry settles only while no pass lists a finding of that title in that file
  that is fixed, open, or otherwise blocking. A ruling on a prior entry carries to later heads at `settled_severity`:
  the pass record keeps the carried rulings its input offered as `carried`, shaped like `ruled`, whether or not the
  pass repeated them, so a ruling holds after the entry leaves the record and across a head with no repeat, also when the
  entry stays listed on that head; rulings are read from every pass record, so a slice whose file list changed keeps
  them. A carried ruling holds only while no pass lists a finding of that title in that file, in any state: a listed one
  governs instead, at its own severity when it is accepted. A ruling on a residual that names no raised finding is not carried.
  On the `--findings-file` path a repeat whose own disposition is `fix_now`, or any other that cannot be accepted, keeps
  no `already_ruled` and stays open; `aidrian pr attest` passes no settled list yet, so there every `already_ruled` is
  left out and the finding read as it stands.
- Anchored residuals: a residual settles a repeat up to `medium` only when it names a finding a reviewer raised on this
  pull request's review record, in that finding's file and no more severe than it. A raised finding above `medium` anchors
  nothing: a residual naming it stays capped at `low`, as does anything else. This takes no step of its own: above low,
  no documented step makes an exec reviewer's finding accepted on the record, since it reaches the record with no state,
  `aidrian pr disposition` only classifies, and the `accepted_residual` route ends in the body. The body's line naming the
  finding is what settles it. A pull request from outside (another repository's branch, a base that is a fork, an author
  with no standing here, or an answer that cannot be read) passes no `acceptedResiduals`, so its body's lines waive nothing
  and anchor nothing. While any pass record holds such a waiver above `low`, as `ruled` or `carried`, on any head,
  `aidrian pr auto-merge` refuses, naming the residual, and the merge waits for the Human.
  - It names one when the residual's text opens with the finding's exact title, a colon, and a reason: `<title>: <why>`,
    the shape the [body template](../plugins/aidrian/skills/pr-write/references/body-template.md) gives a residual line,
    the title copied as the finding gives it. A title alone, or a near copy (another case, markup around the title,
    other punctuation), names nothing and stays at `low`. The longest matching title wins. A line that opens with two titles
    names neither: each takes its own line. A title raised in two files is named only in the files whose path the line
    holds, and in none when it holds no path, so a second file raised later ends a line that names no path. A finding only
    the body mentions is not raised.
  - The input offers each as a `priorFindings` entry with its `residual`: `state` accepted, the raised finding's title,
    file, and severity. A repeat sets `already_ruled` to that title or to the residual's text; `ruled` records the title
    either way. Once anchored, the residual's text settles nothing in another file, even a `low` repeat.
  - A waived repeat leaves the pass's `list`, so the pass record keeps every offered anchor as `carried`, `from` residual,
    whether or not the pass repeated it. A raised finding is one a pass lists now, or, when no pass lists that title in
    that file, one any pass record keeps in `carried` or any round entry holds, so a slice record that a repack deleted
    loses nothing. The anchor holds across a head with no repeat.
  - A body edit takes effect on the next head a pass runs: a pass that already has a result on this head does not run
    again for it. The anchor ends then when the body no longer names the finding. A fix or a blocking listing ends the
    anchor while that listing stands: any pass listing that title in that file with a `state` that is fixed or blocks. Only
    a `state` that is fixed or blocks can end it, and a reviewer cannot print one, so its own finding is the anchor, not a
    reopening of itself. A listing that neither is fixed nor blocks governs at its own severity.
- A project's own exec reviewer runs from a temporary checkout of the base, like the plan command, and reads the head
  through git: a pull request that edits its script cannot run its own version, and the edit triggers
  `harness-config`. The checkout's installed dependency folders (`node_modules`, `vendor`, `.venv`) are linked in, so
  the base code runs with this machine's packages. A reviewer the pull request adds runs once it is merged.
  `codex-local` reads the checkout at the head.
- `agent`: the command cannot start an agent, so it returns `dispatch` and the skill runs it and records the result with
  `aidrian pr attest <PR> --pass <id> --head <sha> --reviewer <who> --findings <n> --fixed <n> --verdicts -`, the
  agent's final JSON on stdin: either the bare verdicts array or the whole `{ findings, verdicts, contracts, cross_notes }`
  object. `--verdicts FILE` reads a file instead; `--findings-file` takes a file only.

### The engine

`review.engine` in `.aidrian.local.json` picks this machine's reviewer: `auto` (default), `codex-local`, `pr-bot`,
`self`, or a reviewer of `review.reviewers`. `auto` takes `codex-local` when Codex is installed and logged in, else the
review bot, else `self`, and the result says which and why. It is a machine setting because the same project runs on
machines with and without Codex.

A project that wants one engine everywhere sets `review.engine` in config.json, with the same values. It is policy:
it wins over every machine's local setting, the result's reason says it came from the project config, and like the
rest of the review config it is the base branch's. Unset, each machine picks its own.

## Rounds

A round is one run of the plan on one head. Right after a push, GitHub can still report the commit the push built
on. When the checkout's branch tracks the pull request's branch, its pushed commit, which that report is an ancestor
of, is the head the step reviews, so the first step after a push opens a new round instead of re-serving the last one.
A local commit past that head returns `incomplete`, with `local_head` and `retry_recommended: true`: push, then run
the step again. A checkout on any other branch reviews the head GitHub reports. The cap is `github.maxReviewRounds` as the base branch commits it, so an
edit to the working copy's config cannot raise it. At the cap, [extra rounds](#extra-rounds) may grant one more;
raising the cap itself needs `AIDRIAN_ALLOW_EXTRA_ROUNDS=1` in the Human's own shell. The `review-rounds` rule ([hooks.md](hooks.md#bash-rules)) refuses an
agent command that sets it, and a bot request posted any way but through `aidrian pr`. The last round runs the final stage first, so a pull request
always gets its independent review before the cap, then lets the earlier stages finish on the same head; it passes
when nothing is left to fix, and stops at the cap when a fix would need another head. A reviewer that fails or hits
its quota gives the round back. After a fix, each pass re-reviews only what changed since its last review; a pass
the change does not touch carries forward.

**A quiet push.** A push whose change since the round's head is quiet opens no round: the round keeps its number,
cap, and last-round flag, moves to the new head, and records the head it moved from in its `quiet` list. That holds in
the last round too, so a quiet fix there is reviewed without reaching `round_limit`. A change is quiet when every file
in it is one of:

- prose or ignored, by `review.nonBehaviour` and `review.ignore`;
- a test, by `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, a `test/`, `tests/`, `__tests__/`, or `spec/` folder, or a
  flow's `tests`, that only gained lines, none of which focuses or skips tests (`.only`, `.skip`, `fit`, `xit`, ...);
- a code file whose every added and removed line is blank or a comment by its extension's syntax, with each hunk's
  block comments opened and closed in order, and no comment a tool reads: a lint, type, or coverage switch, a build
  constraint such as `//go:build`, a compiler reference, or an interpreter line.

Never quiet: a deleted file, prose included; a code file with no changed lines (a binary or a mode change) or with an
extension the table in `lib/review/diff.mjs` does not know; a test that lost a line; a merge from the base branch
after a `received` outcome, whose clean form carries the review and dispatches no reviewer, and whose own changes open
a round; and any change to a file that decides how the project is reviewed (the config, or a file the plan command, a visual hook,
or a reviewer command names), to a flow's invariants doc or a doc an invariant cites, or that selects a flow by itself:
a changed file in its `files` that is not prose or ignored (a doc there selects no flow), an added line, prose
included, that matches its `added`, or a file its `content` selects. Any other merge, such as one from the base after
`fix_required` or one from another branch, is judged by its change like a push: one that brings only docs is quiet.

A quiet push is still reviewed: every pass it touches, a pass of all files included, re-reviews the change in `delta`
context, as after any push. Quiet decides only whether the push counts against the round cap; it never decides whether
a pass runs.

The comment and test rules decide only whether a push counts against the round cap. They read lines without their
context, so a line inside a string that looks like a comment, or a C-style line that starts with a `*` operator, reads
as a comment; a miss like that costs one round of cap and never a review. The syntax table grows when a project asks
for a language; it is not kept complete.

`--with-bot` adds the review bot as a last stage after this machine's engine. The bot is asked only once every
earlier pass has a result, with the review gate's marker, under the plan's round cap; an answer for a commit other
than the one under review counts for nothing. A flow's required checks are read for that commit too.

**Merge from the base branch.** A head is a clean merge from the base branch when all four hold: it is a two-parent
merge commit; its first parent is the head of the last `received` outcome; its other parent is an ancestor of the
base branch tip; and git's own merge of the two parents (`git merge-tree --write-tree`) has no conflict and gives the
merge commit's tree exactly. A clean merge dispatches no reviewer and opens no round: the step records `received` on
the merge head, with `carried_from` naming the head whose review it carries and `carried_base` the base commit it
merged in, and publishes the record, so the [merge guard](hooks.md#merge-guard) and `aidrian pr auto-merge` read a
finished review on that head. The summary comment shows it under **Carried review**: the merge head, the base commit,
and the head reviewed. It answers no owed review: a gate review or a bot review owed for the merge head still stops the
merge until it is recorded.

Any other merge from the base branch onto that head reviews only the changes the merge commit itself made: its
conflict resolutions and any other edit, `git show --remerge-diff`. The round's changed files and lines are that diff's,
plus every path git's merge conflicts on, with no lines when the resolution shows none (a binary file, or the kept side
of a modify/delete). A pass of every changed file reads only those files, the pass input carries `remerge` with the
head, and the reviewer is told to review that diff alone; a pass the merge does not touch carries forward, and one that
dropped what the base brought, as `git merge -s ours` does, is touched. It counts as a round. Later steps on the same
merge head keep that scope, through the `remerge` entry of the record.

Neither the carry nor the resolution-only round applies when the base branch, from the merge base of the reviewed head
and the merge's base parent to the base branch's current tip, changes how the project is reviewed: a rule that lands on
the base after the merged commit counts too, on every later step for the merge head. That covers the config's `review`
group (a flow, a rule, a reviewer, the plan command), a file the plan command, a visual hook, or a reviewer command
names, or a flow's invariants doc or a doc an invariant cites. The reviewed head was never judged against those rules, so the merge head is reviewed as before, and
the plan's reasons name what changed. A change elsewhere in the config, outside `review`, does not count.

An octopus merge, the merge of a side branch, a merge with no `received` review before it, and every head that is not a
merge review as before. So does a merge git cannot read this way, such as under a git older than 2.38, which has no
`git merge-tree --write-tree`: the step reviews the whole change and says why in the plan's reasons. The limit: two
sides that each passed review can still break together with no textual conflict, and no reviewer sees that; CI still
runs on the merge head.

### Late rounds

The late phase starts at review round N, `lateRoundFrom` in the
[disposition table](../plugins/aidrian/lib/finding-disposition.json), 5 today. The round of a finding is the review
round it arrived in, `round` of `aidrian pr review`, or the bot's own review count for its comments, and
`aidrian pr disposition` takes it as `--round` with `--source bot`. From round N, a low finding is `accepted_residual`
whatever its cost or citation (`lateRound` in the table), and so is a medium, plausible finding for users or operators,
unless its fix is trivial: a trivial-cost medium is `fix_now` in every round.
The step records an exec reviewer's late low findings that way itself: each is `accepted`, blocks nothing, and is
listed in `residuals` (`pass`, `title`, `file`, `line`, `severity`) on every result for a head its pass counts for,
which the session writes into the body's Accepted residuals. A low finding recorded with
`--findings-file` keeps its own state: the session classifies it with `aidrian pr disposition`, writes the residual
into the body, and attests it `accepted`. Attestation decides from the finding's axes with no round, so a late medium
the command calls a residual still reads `fix_now` there and blocks until it is fixed. A code comment the residual needs is a [quiet push](#rounds), so neither opens a round.

### Product feedback in the rounds

[Product feedback](config.md#product-feedback) is no stage of the plan: its walk needs the session's browser tool and a
running app, and it returns feedback, never a verdict. In a project that turns it on, the flows that open a draft,
`pr-review-loop`, `orchestration`, and `autopilot`, run `aidrian pr product-feedback status` once after the draft opens and
before the first bot round, and the `pr-product-feedback` skill when it says `not_run`. After that run, or when `status`
says `unanswered` because an earlier run left items unanswered, the flow answers each unanswered item with the command
`status` prints, each defect `fix-now` and each minor `defer` with a reason or a question to the Human, and routes the
`fix-now` items, so its fixes go through these rounds like any other change. Any other owed reason waits for the
ready step, which owns the re-check, so nothing is re-checked mid-round.
The loop skips the feedback comment the gh user wrote, by its `aidrian-product-feedback` marker: its items are answered
through `aidrian pr product-feedback answer`, never in the triage table, and a later run's edit of it is no new review item.
Before marking the draft ready, each flow, `pr-merge-when-green` included, runs `status` again; when only fixes not re-checked are
owed, the skill's re-check run, then `status` once more. On any other exit the draft stays a draft. The
[ready hold](hooks.md#ready-hold) refuses marking it ready while `status` says owed, and the steps are in the skill's
`references/in-a-flow.md`.

### Accepted residuals against decisions

A `## Accepted residuals` item, or an item of the section config.json `github.pullRequest.residuals.section` names, is a defect
the branch ships on purpose. Before the body ships, `pr-write` sets each one against the decisions on record:
`aidrian decisions residuals --body <file>` lists each item beside every decision marker in the indexed docs (id, status, wording,
doc and line), a marker whose class no list holds included and a `rejected` one left out, since it is no rule, and the
`## Consequences` lines of each ADR in `docs/adr/`, or the folder `--adr` names, an ADR whose Status starts `Superseded` skipped
with a note; no `docs/adr/` is an empty list, an `--adr` that is no folder fails, and with no project folder the record is the ADR
lines alone. An ADR, or an ADR folder, that is there but does not read is a problem of the record, never an empty list.
It reads the branch's working copy, so a marker or wording the branch changes must already show in the body's
Decisions. That part is deterministic. When the list holds no decision and no ADR line, it ends
`nothing on record: no judgment owed` and exits 0, `--judged` or not, unless part of the record did not read (an index problem, a
doc or an ADR that does not read, a failed git scan): then it prints those problems and exits 1, and `--json` gives them as
`problems`, each `{ doc, line, problem }` with a null `line`. With lines on record, each problem is a note.
Otherwise whether a residual contradicts a decision is a judgment, so `product-manager` returns one row per residual, `{ residual, contradicts, evidence }`, with
`contradicts` a decision id or ADR `path:line` from that list, or null, and `evidence` the wording it contradicts.
`--judged <file>` validates the rows: a residual with no row or two, an item the body holds twice, a `contradicts` that names
nothing listed or an id two markers hold, or one with no evidence is invalid. The command prints each contradiction as
`residual -> id, doc:line`, or `residual -> path:line` for an ADR line, and exits 1 on any contradiction or invalid row; 0 when
every row is null, or when the body has no such section or an empty one. The skill fixes or drops each contradiction and ships
only on 0. Dropping means the residual leaves the body because the defect no longer ships, or because it is shown to be no defect,
with one line of why left in the body; deleting the bullet while the defect still ships is never a fix. A decision found out of
date is revised only through its own route, never reworded on the branch to let a residual pass.
The decisions check changes no round or verdict. The review step reads the same items as settled residuals: for an exec
reviewer's repeat, one waives a `low` repeat, or, when it names a finding of `medium` severity or lower raised on the review
record, a repeat up to that finding's severity, in that finding's file ([Reviewers](#reviewers)). A pull request from outside
gives the review step no residuals.

### Out of quota

When a reviewer runs out of quota, `codex-local` on this machine or the review bot's usage-limit notice, the step
returns `blocked_quota` and records the stop on that head in the record's `quotaStops`: the stage, the reviewer, every
pass of that reviewer in the stage (the slices and cross pass of a split too), and the reason. There is one stop per
head, stage, and reviewer, so a second reviewer out of quota in the same stage keeps the first one's stop and choice.
The stages before it have already run. The result asks the Human one `question`, with three `options`, the recommended one first, each with
the command it `run`s:

| Option | `run` | What replaces the stopped passes |
| --- | --- | --- |
| Run a critic agent | `aidrian pr review <PR> --quota-fallback agent:critic` | one pass of the read-only `critic` agent on the whole change, `fallback:<stage>:<reviewer>:critic`, returned as `dispatch` and recorded with `aidrian pr attest` |
| The Human reviews it | `aidrian pr review <PR> --quota-fallback human` | the Human's review: `human_required` with `aidrian pr signoff <PR> --stage <stage> --head <sha>`, which the Human runs in their own shell |
| Wait for quota | none | nothing: the review stays stopped, and a later push runs the reviewer again |

A pass of the stopped reviewer that finished before the stop, such as the slices of a split that answered, stays in
its stage under either choice: its open findings still block, and the fallback pass reads them as `priorFindings`, each
with the `pass` it came from. Such a pass meets no `independent-model` requirement, having reviewed only part of the
change. One `aidrian pr signoff --stage` signs every reviewer of the stage the Human chose to replace on that head.

`--quota-fallback` takes `agent:<name>` for any agent, or `human`. Nothing picks a fallback without it: with no flag,
a stop stays `blocked_quota`. The flag answers a stop on the current head only, and fails when that head has none;
the choice holds for that head, so the next push runs the reviewer again. The
`review-fallback` rule ([hooks.md](hooks.md#bash-rules)) refuses the flag from an agent unless the Human picked that
option in the session, and the `review-signoff` rule keeps the stage sign-off the Human's, as a flow's is.
`aidrian pr signoff --stage` signs only a stage the Human chose to review after its reviewer ran out of quota on that
head, so it never skips a reviewer that has its quota.

Neither fallback is an independent review. The critic runs on the session's own model, so its pass never meets
`independent-model`, whatever its reviewer is named, and the Human's sign-off does not either. A plan that requires
`independent-model` gets no options: its `blocked_quota` carries `fallback_refused` instead, and the flag returns
`unsatisfied` with the same reason. Every result on a head a fallback replaced carries `quota_fallback`, and the
summary comment, or the local record under `review.record: "local"`, says in a line per stop which stage ran on a
fallback, or on the Human's review, because the reviewer was out of quota.

For the [merge guard](hooks.md#merge-guard), a quota stop is an open review: the head's outcome is `blocked_quota`, and
a merge is refused. A fallback counts as review done only once the step after it returns `received` on that head: the
critic's pass recorded, or the Human's stage sign-off read by the next `aidrian pr review`, as a flow's sign-off is.

### Extra rounds

At the cap, more review is sometimes worth it: a real finding is left, and the rounds are shrinking. Often it is not:
the same findings come back, the fixes grow the change, or the review wanders into other files. `github.extraRounds`
decides, as the base branch commits it, with `github.maxExtraRounds` (2) as the ceiling ([config.md](config.md#keys)).
It applies to `aidrian pr review` and to `aidrian pr await-review --request`, which count their own rounds.

1. `"off"`, or the ceiling reached: `round_limit`, as before.
2. **Signals.** The command reads the round history and computes four signals. A red flag is no dead end: it goes to
   the judge as evidence, in `extension.red_flags`, and an extra round over it always needs the Human, under `"auto"`
   too:
   - **converging**: the last round left fewer open findings than the round before. Equal or more is a red flag.
   - **looping**: a finding comes back after a fix, in the same file within 3 lines, or under the same title (its words of
     four letters or more, without markup, in any order).
   - **drifting**: a finding after round 1 sits in a file the pull request did not change at its first round.
   - **bloating**: the fixes since round 1 added more than 50% of the lines of code (outside `review.nonBehaviour` files) the pull request first added, and more
     than 40 lines. A fix is how the pull request's own diff (each head against its merge base with the base branch)
     changed between rounds, line by line per file, without `review.ignore` files. Lines the base branch gained are in
     neither diff, so merging or rebasing on the base is no bloat, even in a file the pull request changes too. Only
     code counts as fix growth: lines added to `review.nonBehaviour` files, such as Markdown and `docs/**`, are no
     bloat, since rewording a doc across rounds is normal review work. A docs-only pull request never bloats.

   Drifting and bloating measure a round from the head it first reviewed, so what a [quiet push](#rounds) added is that
   round's fix, and a file it added is not one the pull request first changed. The history's `fix` is measured the same
   way; only `unreviewed_head.fix` starts from the head the last round moved to.

   A signal the history cannot read, such as looping when the reviewers recorded counts and no findings, is unknown,
   not red. A history with no readable signal is a red flag.
3. **Judge.** The status is `extension_check` (exit 10). It carries `extension`: each round's open findings,
   with their files, lines, and titles, each fix's size, the pull request's files, its title and body, and the signals.
   `dispatch` names a read-only `code-reviewer`, which answers whether the fixes deviate from the goal, loop, or
   over-engineer, and whether the open findings are valid and at least medium, with evidence, and answers each red
   flag as real or a false alarm. It records its word:

   ```sh
   aidrian pr extend <PR> --verdict extend|stop --reason "<evidence>" [--head <sha>]
   ```

4. **Grant.** `stop` is `round_limit`. `extend` grants the round under `"auto"` when no red flag stands. Under
   `"ask"`, or over a red flag, the status is `extension_ask` (exit 11), with a `question` and `options` for the Human,
   and the session records the answer. The question names the red flags, by name only:

   ```sh
   aidrian pr extend <PR> --human approve|deny
   ```

**A fix no round reviewed.** The cap often meets a fix pushed after the last round: `aidrian pr review` cannot open a
round for it, and `aidrian pr await-review --request` reaches its cap only on a head the bot has not reviewed. Against
the new code, the last round's findings read as fixed, so the question changes. When the last round of the history
is on another head, `extension.unreviewed_head` carries `{ head, from, fix }`: the head, the last round's head, and
the fix between them, that push's own size even after a quiet push moved the round. The judge then decides whether the last round's findings were valid and at least medium, read at
`from`, and the fix is small and answers them; `extend` means "review this fix". The red flags and
`github.maxExtraRounds` still bound it, and nothing grants a round by itself. Under `"ask"` the `question` names the
fix head, and keeps `#<PR>` and `round <N>` as the only pull request and round it names. When the cap still stands,
`round_limit` carries `unreviewed_head: true`, and the summary comment's **Extra rounds** list says the fix head is
reviewed by no pass, so the Human sees it before merging. A stop made earlier stands after a push too, and says the
same of the new head. The ceiling reads no history: it compares the head with the last round's head alone, from the
record's rounds or the bot's last review, and says the same. `"off"` reads nothing and does not say it. Once a later
`aidrian pr review` round reviews that head, the line goes away; a bot round's line stays until the next check at the
bot's cap.

A grant is exactly one round: the cap rises by one, and the next cap runs the check again. It adds to the cap in
force, the base branch's or an explicit `--max-rounds`, in both commands; a `--max-rounds` above the base branch's cap
still needs `AIDRIAN_ALLOW_EXTRA_ROUNDS=1`, grant or not.

Every open decision is bound to the head its signals were read on: a check waiting for the judge or the Human, and a
grant whose round has not opened yet. When the pull request moves, the next step reads the signals again on the new
head. A new red flag sends it back to the judge, a grant or a Human's approval included, so a push after the verdict
cannot carry a bloated fix into the extra round unseen. Without one, a check waiting for the Human goes back to the
judge, who has not seen the push, and a grant stands. `aidrian pr extend --human approve` and `--verdict` are refused once the pull request's head is not the one the
check was for. A bot request on an extra round goes out only for the head its grant was read on: when the
pull request moves between the reads, or during the wait, the command reads the grant again on the head it would ask
about, and posts nothing when a red flag sends the grant back to the judge. A bot request records the raised cap in its comment, as a Human's `--max-rounds` does, but a later
run counts that record only under `AIDRIAN_ALLOW_EXTRA_ROUNDS=1`: otherwise the cap is the base branch's plus the
grants still valid, so a revoked grant stays revoked. Each decision is an entry
in [the record](#the-record), listed under **Extra rounds** in the summary comment, which `aidrian pr extend` and
`aidrian pr await-review` write too, so another machine continues from the same checks and grants (with `review.record:
"local"`, the state folder only). It is also a `review_extension` row in the
[dispatch log](dispatch-log.md#review_extension-when-a-check-at-the-round-cap-decides), which `aidrian report reviews` counts.

**Trust.** The `review-extend` rule ([hooks.md](hooks.md#bash-rules)) lets an agent's `--human approve` run only when
the session's transcript holds the Human's answer to an AskUserQuestion that names the pull request (`#<PR>`) and the
round it grants (`round <N>`), given after the judge's verdict, with the option that starts with "Approve". Claude Code
writes that answer, not the agent. A host without such a transcript, such as Codex, leaves the approval to the Human,
who runs the command in their own shell. `--human deny` always runs. With no check waiting for the Human, as after a
judge's stop, the deny names the Human's route to one more round: `AIDRIAN_ALLOW_EXTRA_ROUNDS=1` and `--max-rounds`.
The rest is the record's trust: the judge's verdict, like an attest, is the session's word, and an agent with a shell could write the state file directly. So the
signals and the ceiling are computed by the command at every cap, a verdict over a red flag reaches the Human, never
a grant by itself, and under `"auto"` the most a false verdict buys is `github.maxExtraRounds` rounds, every one
listed on the pull request.

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
reads it from the comment, and only from a comment whose `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`:
a stranger's comment supplies no record, and is never edited. It is the reviewers' word, not proof, and it is all visible on the pull request.
A step run by a non-member edits the summary comment that `gh` user wrote, which still supplies no record.
With no comment of that user's, or when the user cannot be read, it attempts the last member's summary comment, and posts a new one when there is none
or GitHub refuses the edit with a 403; it never edits a non-member's.

The comment carries the record brotli-compressed, in base64, in one `<!-- aidrian-review-state-br:... -->` marker.
The older plain `<!-- aidrian-review-state:... -->` marker is still read. A reader takes the newer of the record
markers on the lines that end the comment, each a line of its own, compressed or plain, and a write by this release
leaves exactly one there: an older release's write keeps the compressed marker and appends a plain one, so a comment it
touched can end with both until the next write here. A marker anywhere else is not read, and free text the summary
shows, such as a waiver's reason, has `<!--` and `-->` escaped, so no text can carry a record of its own.

- **Size.** GitHub refuses a comment past 65,536 characters. Each split review step keeps only the slice results of
  the head's own [split](#split) packing: for each reviewer with slice results in the record, the slices `review.split`
  and the record's halved slices make from the head's diff. A slice result of a packing an earlier fix replaced can
  never count again, so it leaves the record; the live packing's results, its halves, cross passes, and every other
  pass stay, and each round keeps its open findings for the [check at the cap](#extra-rounds). A pass of the current
  plan always stays, whatever its id. Free text the visible summary shows, such as a capture's failure reason, a plan reason, or
  an override, is cut at 300 characters, and the summary lists at most 25 plan reasons.
- **Held.** When a summary with its record would still pass 60,000 characters, the comment keeps the visible summary
  and holds the record back: the line "Record kept locally; too large for a comment" and a
  `<!-- aidrian-review-state-held:<revision> -->` marker with the record's revision. This is the one case where the
  comment carries no record on purpose. On a machine whose record is missing or older than that revision,
  `aidrian pr review` returns `incomplete` with `retry_recommended: false`; `aidrian pr extend`, `aidrian pr attest
  --pass`, `aidrian pr signoff`, and, when `github.extraRounds` is not off, `aidrian pr await-review --request` fail
  with the same reason. None of them starts a new record over the held one. The machine that wrote it goes on, and
  its next write that fits puts the record back in the comment, without the held line. If that machine is gone, the
  Human deletes the review summary comment: the review then restarts from the record of the machine that runs it next,
  or from round 1 when it has none.
- **Minimum version.** Every machine that runs `aidrian pr review`, `pr extend`, or `pr await-review` on a pull
  request whose summary carries the compressed or held marker needs an aidrian release after 0.22.1. An older one
  cannot read either marker: it reads no record from the comment and goes on from its own, as under `review.record:
  "local"`. Its `aidrian pr review` rewrites the comment with that record alone, in the plain marker; its
  `aidrian pr extend` and `aidrian pr await-review` keep the compressed marker and append a plain one, and a reader
  here then takes the newer of the two.

- **Outcome.** Every return of the step writes its status to this machine's record as `outcome`: `{ status, head, at,
  reason, carried_from, carried_base }`, where `carried_from` and `carried_base` are set only on a `received` that a
  [clean merge from the base branch](#rounds) carried, and name the head that was reviewed and the base commit merged
  in. The summary comment shows that outcome under **Carried review**, rewritten from the record on every write. The early returns, `none_needed`, `unsatisfied`,
  and `too_large`, write it to the state folder only and post nothing; a `held` return writes nothing. Before any
  reviewer, the plan command, or the bot runs, the step writes `running` for its head, so a merge during the first step
  is refused too. A step that throws after that, such as a plan command that fails, writes `error`, which is not
  finished. A carried `received` runs none of them and writes no `running`: it posts the record, and answers no owed
  review. A merge git cannot read is no error: the step reviews it as before. The
  [merge guard](hooks.md#merge-guard) reads the outcome.
- **Quiet pushes.** A round's `quiet` list holds the heads it moved from on [quiet pushes](#rounds), each `{ from, at }`
  with the time the round was opened on that head. A round without the list never moved.
- **Owed reviews.** `pending` lists the reviews asked for, each `{ id, kind, head, repo, at, by, sent, answered }`;
  one is owed until it is `answered`, and only an answer for its own `repo` counts. `aidrian pr request <PR>` records a
  bot review the Human asked for, the moment they ask, before any review the project requires first. It reads the head
  and the pull request's repository from gh, whose default is the upstream in a fork checkout, unless `--head` and
  `--repo OWNER/NAME` name them; a gate review (`--kind review`) is recorded the same way. `aidrian pr await-review` marks it `sent` when it posts the request, and
  `answered` when the bot's answer arrives (`received`) or is already there (`already_present`), as
  `aidrian pr review --with-bot` does whenever its bot stage holds an answer, a reused one included. A request sent
  is still owed. An answer counts for a request made for its own head, or for an earlier head it descends from
  (`git merge-base --is-ancestor`); time plays no part, so a late answer for an older head never answers a newer head's
  request. When git cannot tell, as for a commit this checkout lacks, only the exact head counts. An `await-review` for
  another repository, through `--repo` or a URL, leaves this repository's record alone. A gate review is
  answered the same way: by an attest of its pull request's repository, or a step on that repository that finishes.
  `aidrian pr request <PR> --kind review` records a review-gate review as dispatched; `aidrian pr attest <PR>`, or a
  step that returns `received` or `none_needed`, answers it. Without `--head <sha>`, `request` reads the head with gh.
  An entry is only ever marked, never removed, and the review step merges in the entries and marks on disk before it
  writes, so a request recorded while a reviewer ran survives the step's write. Both live in the state folder: another
  machine does not see them.
- **Waivers.** `waivers` lists the judge verdicts `aidrian pr waive` recorded, each `{ head, kind, verdict, reason, judge, at }`,
  where `kind` is `round_cap` and `verdict` is `waive` or `refuse`. Each binds to one head and one kind.
  The summary comment shows them under **Merge guard waivers**, each marked an audit entry, not proof.
  A record without the list has none. The [merge guard](hooks.md#merge-guard) reads them only while the team's
  `github.unattendedWaiver.allow` and this machine's switch are both on: [Unattended waiver](config.md#unattended-waiver).

With `review.record: "local"` in config.json, the record is written to the state folder only: nothing is posted or
edited on the pull request, the visual captures comment included, and the record is read back from the state folder alone. Another machine then cannot
see it or resume the review; it starts a record of its own.
