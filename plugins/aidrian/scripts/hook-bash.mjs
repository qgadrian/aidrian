// PreToolUse hook for the Bash tool: runs every Bash rule in lib/rules/ on the command, in order, in this one process.
// The first rule that objects blocks the command (exit 2, its reason on stderr). Anything this hook cannot read lets
// the command run: rules deny only what they positively identify.

import { deny, runHook } from '../lib/hook-io.mjs';
import * as gitAmend from '../lib/rules/git-amend.mjs';
import * as gitHookBypass from '../lib/rules/git-hook-bypass.mjs';
import * as grepExitChain from '../lib/rules/grep-exit-chain.mjs';
import * as mainCheckout from '../lib/rules/main-checkout.mjs';
import * as prBody from '../lib/rules/pr-body.mjs';
import * as processKill from '../lib/rules/process-kill.mjs';

// The main-checkout rule runs last: it is the only one that may start git.
const RULES = [gitHookBypass, gitAmend, processKill, grepExitChain, prBody, mainCheckout];

await runHook((input) => {
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string' || command === '') return;
  const context = { cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), env: process.env };
  for (const rule of RULES) {
    const reason = rule.check(command, context);
    if (reason) deny(reason);
  }
});
