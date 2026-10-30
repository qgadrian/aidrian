// PreToolUse hook for Edit, Write, NotebookEdit, and Codex's apply_patch: the main-checkout rule for file writes.
// lib/rules/main-checkout.mjs decides; anything this hook cannot read lets the write run. A block is recorded as the Bash
// hook records its blocks (lib/hook-deny.mjs).

import { block, runHook } from '../lib/hook-io.mjs';
import { checkTool } from '../lib/rules/main-checkout.mjs';

await runHook(async (input) => {
  const reason = checkTool(input);
  if (reason) await block(input, 'main-checkout', reason);
});
