---
name: pr-review
description: Review a GitHub pull request with the right agents, record each finding and its verdict in a JSON manifest, and post one comment with the result.
---

# pr-review

Review a pull request with the smallest set of agents that covers it.
Every finding gets a verdict from `aidrian pr disposition` and lands in a JSON manifest that the `pr-review-fix` skill reads.
The result goes on the pull request as one comment, which later rounds update.
This skill coordinates; the agents review. It never edits code.

Before you start, follow the `knowledge` skill. Load your `orchestration` docs for the project's agent registry,
`security` docs for the paths that need a security pass, and `product_sensitive` docs for the flows the project declares critical.

## Arguments

```text
[<pull request number or URL>] [--full] [--no-comment]
```

- Without a number, use the current branch's pull request (`gh pr view --json number,url`). When there is none, stop and ask for one.
- `--full`: use the larger review plan, even for a small change.
- `--no-comment`: report in chat only, and post nothing.

## 1. Scope

Build the scope yourself with `gh` and `git`. Never ask an agent to find the pull request or its files.

1. Read the pull request:
   `gh pr view <n> --json number,title,body,url,state,isDraft,author,baseRefName,headRefName,headRefOid,files,changedFiles,additions,deletions`.
   When `files` holds fewer entries than `changedFiles`, read the whole list with `gh api --paginate repos/{owner}/{repo}/pulls/<n>/files`.
2. `git fetch origin <baseRefName> pull/<n>/head`. This fetches a fork's head too.
3. `base_sha` is `git merge-base origin/<baseRefName> <headRefOid>`. On a shallow clone where that fails,
   run `git fetch --unshallow` once and try again. `head_sha` is `headRefOid`: every agent reads that commit, never the working tree.
4. Stop when the pull request has no files or the merge base cannot be found. Ask before going on when it is closed or merged.
5. Print the scope before any dispatch: number, title, and URL; author; draft or ready; base and head with both SHAs;
   the counts; and each changed file with its status, the first 30 when there are more.
   When the title or body promises one thing and the files show another, say so and ask whether to go on.

## 2. Earlier rounds

Read `references/manifest.md`, then the manifest `<state>/reviews/pr-<n>.json`, where `<state>` is the folder `aidrian state` prints.

- No manifest: this is round 1. Review the whole pull request.
- The manifest's `head_sha` is the current head: the last round still applies. Report it, and ask before reviewing again.
- Its `head_sha` is an ancestor of the current head (`git merge-base --is-ancestor`): steps 4 and 5 plan for the files changed
  since then, `git diff --name-only <its head_sha> <head_sha>`, and each agent of an earlier round also gets back its `fix_now`
  findings that are `open` or `fixed`, to confirm.
- Otherwise, after a rebase or a force push, review the whole pull request and match the old findings by file and summary.

## 3. Bot and generated changes

When the author is a bot (a login that ends in `[bot]`, or a dependency-update bot) and every file is generated,
dispatch nobody: summarize the change, flag a major version jump or a known advisory, and say that no line review ran.
Generated files are lock files, snapshots, and the files the project's knowledge marks as generated.
When a bot's pull request also changes other files, review those files the normal way.

## 4. Review plan

Leave lock files, snapshots, binary files, and generated files out of the line review, and list them with the reason.
Count the files and the changed lines that remain:

- 10 files or fewer and 400 lines or fewer, without `--full`: `code-reviewer` alone.
- Larger, or with `--full`: `code-reviewer`, plus the owner the project's `orchestration` registry gives each changed path.
  Without a registry, choose from this plugin's agents by what the files do: `backend-developer` for server code and data,
  `designer` for presentation, `ux-specialist` for user flows, and `architect` when the change spans several modules.
- One owner per area. At most four agents review at the same time.

Print the plan with the reason for each agent before the first dispatch.

## 5. Gates

The gates run in every plan, on top of the agents in step 4.

- `security-engineer` reviews each file that the project's `security` knowledge lists,
  or whose path names authentication, sessions, tokens, permissions, payments, billing, webhooks, or uploads.
- `product-manager` goes first, alone, when a file belongs to a flow the project's `product_sensitive` knowledge declares critical.
  The review cannot end until it returns `sign_off: approved` for each such flow.

## Steps

- `steps/dispatch.md`: read it before the first dispatch. It holds the brief each agent gets and the regression check.
- `steps/reconcile-and-publish.md`: read it when the first agent returns.
  It merges the findings, computes the verdicts, writes the manifest, posts the comment, and closes the review.
- `references/manifest.md`: read it before the first read or write of the manifest.

## Do not

- Edit code, commit, or push. The `pr-review-fix` skill fixes findings.
- Paste the whole diff into a brief, or let an agent read the working tree instead of the pinned head.
- Settle a disagreement between two agents yourself, or close a security finding without `security-engineer`.
