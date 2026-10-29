// PreToolUse hook for the Bash tool: runs every Bash rule in lib/rules/ on the command, in order, in this one process.
// The first rule that objects blocks the command (exit 2, its reason on stderr). Anything this hook cannot read lets
// the command run: rules deny only what they positively identify.

import { deny, runHook } from '../lib/hook-io.mjs';
import * as gitAmend from '../lib/rules/git-amend.mjs';
import * as gitHookBypass from '../lib/rules/git-hook-bypass.mjs';

const RULES = [gitHookBypass, gitAmend];

await runHook((input) => {
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string' || command === '') return;
  const context = { cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), env: process.env };
  for (const rule of RULES) {
    const reason = rule.check(command, context);
    if (reason) deny(reason);
  }
});
