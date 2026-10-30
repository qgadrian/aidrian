// PreToolUse hook for Edit, Write, NotebookEdit, and Codex's apply_patch: the main-checkout rule for file writes.
// lib/rules/main-checkout.mjs decides; anything this hook cannot read lets the write run. A block is counted as the Bash
// hook counts its blocks.

import { deny, runHook } from '../lib/hook-io.mjs';
import { noteDenial } from '../lib/lesson-signals.mjs';
import { checkTool } from '../lib/rules/main-checkout.mjs';

await runHook((input) => {
  const reason = checkTool(input);
  if (reason) {
    noteDenial(input, 'main-checkout');
    deny(reason);
  }
});
