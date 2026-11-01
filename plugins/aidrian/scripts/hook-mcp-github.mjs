// PreToolUse hook for the GitHub MCP tools that post a comment: the review gate (lib/review-gate.mjs), as the Bash rule
// lib/rules/github/review-request.mjs holds it for gh. Off unless config.json `github.reviewGate.enabled` is true.
// It also holds the review-round rule (lib/rules/github/review-rounds.mjs): with a review bot set, a request goes
// through `aidrian pr`, which counts rounds first, never through a comment tool.
// Anything this hook cannot read lets the call run.

import { loadConfig } from '../lib/config.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';
import { asksForReview, judgeRequests, markersIn } from '../lib/review-gate.mjs';
import { botNamed, requestReason } from '../lib/rules/github/review-rounds.mjs';

// Each tool, and the field that names the pull request.
const PR_FIELD = {
  mcp__github__add_issue_comment: 'issue_number',
  mcp__github__add_reply_to_pull_request_comment: 'pullNumber',
  mcp__github__pull_request_review_write: 'pullNumber',
};

await runHook(async (input) => {
  const field = PR_FIELD[input.tool_name];
  const toolInput = input.tool_input ?? {};
  if (!field || !asksForReview(toolInput.body)) return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const pr = Number(toolInput[field]);
  const repo = typeof toolInput.owner === 'string' && typeof toolInput.repo === 'string' ? `${toolInput.owner}/${toolInput.repo}` : null;
  const request = { pr: Number.isInteger(pr) && pr > 0 ? pr : null, repo, markers: markersIn(toolInput.body) };
  const { config } = loadConfig(project);
  if (botNamed(config.github.reviewer)) return block(input, 'review-rounds', requestReason(config));
  const reason = judgeRequests([request], { project, config });
  if (reason) await block(input, 'review-gate', reason);
});
