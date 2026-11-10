// PreToolUse hook for the GitHub MCP tools that post a comment or merge: the review gate (lib/review-gate.mjs), as the Bash rule
// lib/rules/github/review-request.mjs holds it for gh. Off unless config.json `github.reviewGate.enabled` is true.
// It also holds the review-round rule (lib/rules/github/review-rounds.mjs): with a review bot set, a request goes
// through `aidrian pr`, which counts rounds first, never through a comment tool.
// It also holds the merge guard (lib/rules/github/merge-review.mjs) for `mcp__github__merge_pull_request`, which refuses
// a merge whose head it cannot read rather than let it run unchecked.
// It also holds the ready hold (lib/rules/github/ready-hold.mjs) for `mcp__github__update_pull_request` and
// `mcp__github__update_pull_request_draft_state` with a `draft` that is not true: no draft is marked ready while its
// product feedback is owed; then the ready checks hold (lib/rules/github/ready-checks.mjs): none while a check on its head
// has not finished, or one its last edit re-queues has not shown.
// A host's own GitHub connector reaches this hook too: `githubCall` gives its call in the terms of the tool it stands for,
// so this file reads one shape. Anything else this hook cannot read lets the call run.

import { loadConfig } from '../lib/config.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { githubCall } from '../lib/hosts/index.mjs';
import { findProject } from '../lib/project.mjs';
import { asksForReview, judgeRequests, markersIn } from '../lib/review-gate.mjs';
import { checkMcp } from '../lib/rules/github/merge-review.mjs';
import { checkMcp as checkChecks } from '../lib/rules/github/ready-checks.mjs';
import { checkMcp as checkReady } from '../lib/rules/github/ready-hold.mjs';
import { botNamed, REQUEST_REASON } from '../lib/rules/github/review-rounds.mjs';

// Each tool, and the field that names the pull request.
const PR_FIELD = {
  mcp__github__add_issue_comment: 'issue_number',
  mcp__github__add_reply_to_pull_request_comment: 'pullNumber',
  mcp__github__pull_request_review_write: 'pullNumber',
};

// The GitHub MCP server's tools that can mark a draft ready, through their `draft` input.
const READY_TOOLS = new Set(['mcp__github__update_pull_request', 'mcp__github__update_pull_request_draft_state']);

await runHook(async (input) => {
  const { tool, given: toolInput } = githubCall(input.tool_name, input.tool_input ?? {});
  if (tool === 'mcp__github__merge_pull_request') {
    // `startedAt`: the merge guard bounds the unattended waiver's reads by the hook's own time.
    const reason = checkMcp(toolInput, { cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), input, startedAt: performance.timeOrigin });
    if (reason) await block(input, 'merge-review', reason);
    return;
  }
  if (READY_TOOLS.has(tool)) {
    const context = { cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), startedAt: performance.timeOrigin };
    const reason = checkReady(toolInput, context);
    if (reason) return block(input, 'ready-hold', reason);
    const pending = checkChecks(toolInput, context);
    if (pending) await block(input, 'ready-checks', pending);
    return;
  }
  const field = PR_FIELD[tool];
  if (!field || !asksForReview(toolInput.body)) return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const pr = Number(toolInput[field]);
  const repo = typeof toolInput.owner === 'string' && typeof toolInput.repo === 'string' ? `${toolInput.owner}/${toolInput.repo}` : null;
  const request = { pr: Number.isInteger(pr) && pr > 0 ? pr : null, repo, markers: markersIn(toolInput.body) };
  const { config } = loadConfig(project);
  if (botNamed(config.github.reviewer)) return block(input, 'review-rounds', REQUEST_REASON);
  const reason = judgeRequests([request], { project, config });
  if (reason) await block(input, 'review-gate', reason);
});
