// PreToolUse hook for the Bash tool: runs every Bash rule in lib/rules/ on the command, in order, in this one process.
// The rules that only read `gh` commands live in lib/rules/github/.
// The first rule that objects blocks the command (exit 2, its reason on stderr), and the block is recorded
// (lib/hook-deny.mjs): a hook_deny row in the dispatch log, and a count toward the lesson for a rule that blocks one
// session again and again. Anything this hook cannot read lets the command run: rules deny only what they positively identify.

import { block, runHook } from '../lib/hook-io.mjs';
import * as attribution from '../lib/rules/attribution.mjs';
import * as decisionsSet from '../lib/rules/decisions-set.mjs';
import * as gitAmend from '../lib/rules/git-amend.mjs';
import * as gitHookBypass from '../lib/rules/git-hook-bypass.mjs';
import * as mergeReview from '../lib/rules/github/merge-review.mjs';
import * as prBody from '../lib/rules/github/pr-body.mjs';
import * as publicText from '../lib/rules/github/public-text.mjs';
import * as productFeedbackAnswer from '../lib/rules/product-feedback-answer.mjs';
import * as productFeedbackPost from '../lib/rules/product-feedback-post.mjs';
import * as readyHold from '../lib/rules/github/ready-hold.mjs';
import * as reviewRequest from '../lib/rules/github/review-request.mjs';
import * as reviewRounds from '../lib/rules/github/review-rounds.mjs';
import * as reviewExtend from '../lib/rules/review-extend.mjs';
import * as reviewFallback from '../lib/rules/review-fallback.mjs';
import * as reviewSignoff from '../lib/rules/review-signoff.mjs';
import * as grepExitChain from '../lib/rules/grep-exit-chain.mjs';
import * as mainCheckout from '../lib/rules/main-checkout.mjs';
import * as processKill from '../lib/rules/process-kill.mjs';

// Which rules start a process. Every rule first reads the command alone, and most stop there. A rule that needs the
// project finds it (findProject), which runs git once inside a project folder. Past that, only these start one, and only
// for a command they matched: attribution, git for a commit's trailers; pr-body, gh for the open pull requests, bounded
// at 3 s; public-text, git for the main checkout, for the private words file, and with any pattern, for the checkout's
// remotes and the deny's body file path; merge-review, git for the hold against the base branch, each read bounded at
// 1 s (lib/review/in-force.mjs baseProblem), one gh pr view, bounded at 3 s, and, only under the unattended waiver's local switch for a merge
// it could waive, one git call and up to six gh calls, none begun 4 s after this process started (each stopped
// at that deadline at the latest; lib/review/waiver.mjs); ready-hold, git for the committed config and then, when the
// project may run product feedback, gh under one deadline for all its calls, which ends 4 s after this process started
// at the latest; and main-checkout, git, which runs last. ready-hold runs after merge-review, so a command that marks a
// pull request ready and merges it leaves the merge guard its own 3 s: the guard refuses a merge it cannot read, and the
// hold lets the command run when its time is gone. A command none of them matched starts nothing beyond findProject.
// Each rule's name keys its rows and its lesson.
const RULES = [
  ['git-hook-bypass', gitHookBypass],
  ['git-amend', gitAmend],
  ['process-kill', processKill],
  ['grep-exit-chain', grepExitChain],
  ['attribution', attribution],
  ['pr-body', prBody],
  ['public-text', publicText],
  ['review-gate', reviewRequest],
  ['review-rounds', reviewRounds],
  ['review-signoff', reviewSignoff],
  ['decisions-set', decisionsSet],
  ['review-extend', reviewExtend],
  ['review-fallback', reviewFallback],
  ['product-feedback-answer', productFeedbackAnswer],
  ['product-feedback-post', productFeedbackPost],
  // Accepted residual: the waiver's reads in merge-review can spend the shared 4 s, so ready-hold in the same command
  // finds no time left and lets `gh pr ready` run. It needs a waivable merge and a ready in one slow command: contrived.
  ['merge-review', mergeReview],
  ['ready-hold', readyHold],
  ['main-checkout', mainCheckout],
];

await runHook(async (input) => {
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string' || command === '') return;
  // `startedAt`: when this process started, for a rule that bounds its network calls by the hook's own time (merge-review's
  // unattended waiver, ready-hold).
  const context = { cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), env: process.env, input, startedAt: performance.timeOrigin };
  for (const [name, rule] of RULES) {
    const reason = rule.check(command, context);
    if (reason) await block(input, name, reason);
  }
});
