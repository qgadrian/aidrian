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
import * as productFeedbackAnswer from '../lib/rules/product-feedback-answer.mjs';
import * as productFeedbackPost from '../lib/rules/product-feedback-post.mjs';
import * as reviewRequest from '../lib/rules/github/review-request.mjs';
import * as reviewRounds from '../lib/rules/github/review-rounds.mjs';
import * as reviewExtend from '../lib/rules/review-extend.mjs';
import * as reviewFallback from '../lib/rules/review-fallback.mjs';
import * as reviewSignoff from '../lib/rules/review-signoff.mjs';
import * as grepExitChain from '../lib/rules/grep-exit-chain.mjs';
import * as mainCheckout from '../lib/rules/main-checkout.mjs';
import * as processKill from '../lib/rules/process-kill.mjs';

// The main-checkout rule runs last: it is the only one that may start git. Each rule's name keys its rows and its lesson.
const RULES = [
  ['git-hook-bypass', gitHookBypass],
  ['git-amend', gitAmend],
  ['process-kill', processKill],
  ['grep-exit-chain', grepExitChain],
  ['attribution', attribution],
  ['pr-body', prBody],
  ['review-gate', reviewRequest],
  ['review-rounds', reviewRounds],
  ['review-signoff', reviewSignoff],
  ['decisions-set', decisionsSet],
  ['review-extend', reviewExtend],
  ['review-fallback', reviewFallback],
  ['product-feedback-answer', productFeedbackAnswer],
  ['product-feedback-post', productFeedbackPost],
  ['merge-review', mergeReview],
  ['main-checkout', mainCheckout],
];

await runHook(async (input) => {
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string' || command === '') return;
  const context = { cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), env: process.env, input };
  for (const [name, rule] of RULES) {
    const reason = rule.check(command, context);
    if (reason) await block(input, name, reason);
  }
});
