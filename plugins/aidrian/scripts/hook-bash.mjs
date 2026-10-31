// PreToolUse hook for the Bash tool: runs every Bash rule in lib/rules/ on the command, in order, in this one process.
// The rules that only read `gh` commands live in lib/rules/github/.
// The first rule that objects blocks the command (exit 2, its reason on stderr), and the block is recorded
// (lib/hook-deny.mjs): a hook_deny row in the dispatch log, and a count toward the lesson for a rule that blocks one
// session again and again. Anything this hook cannot read lets the command run: rules deny only what they positively identify.

import { block, runHook } from '../lib/hook-io.mjs';
import * as gitAmend from '../lib/rules/git-amend.mjs';
import * as gitHookBypass from '../lib/rules/git-hook-bypass.mjs';
import * as prBody from '../lib/rules/github/pr-body.mjs';
import * as reviewRequest from '../lib/rules/github/review-request.mjs';
import * as grepExitChain from '../lib/rules/grep-exit-chain.mjs';
import * as mainCheckout from '../lib/rules/main-checkout.mjs';
import * as processKill from '../lib/rules/process-kill.mjs';

// The main-checkout rule runs last: it is the only one that may start git. Each rule's name keys its rows and its lesson.
const RULES = [
  ['git-hook-bypass', gitHookBypass],
  ['git-amend', gitAmend],
  ['process-kill', processKill],
  ['grep-exit-chain', grepExitChain],
  ['pr-body', prBody],
  ['review-gate', reviewRequest],
  ['main-checkout', mainCheckout],
];

await runHook(async (input) => {
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string' || command === '') return;
  const context = { cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), env: process.env };
  for (const [name, rule] of RULES) {
    const reason = rule.check(command, context);
    if (reason) await block(input, name, reason);
  }
});
