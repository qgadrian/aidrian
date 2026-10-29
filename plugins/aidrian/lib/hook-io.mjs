// Input and exit helpers for hook scripts. Claude Code and Codex send one JSON object on stdin and read the exit code:
// 0 lets the action run, 2 blocks it and shows stderr to the agent.

import { readFileSync, writeSync } from 'node:fs';

// The hook payload, or {} when stdin is empty or not a JSON object.
export function readHookInput() {
  try {
    const value = JSON.parse(readFileSync(0, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function allow() {
  process.exit(0);
}

// Exit 2 with `reason` on stderr: a PreToolUse hook blocks the action; a PostToolUse hook hands the agent feedback.
// writeSync: a buffered stderr write can be lost when the process exits right after it.
export function deny(reason) {
  writeSync(2, `${reason}\n`);
  process.exit(2);
}

// Runs a hook body with the payload. An error lets the action run and prints nothing: a broken hook, or a payload
// shape this hook does not know, must never stop a session.
export async function runHook(body) {
  try {
    await body(readHookInput());
  } catch {
    process.exit(0);
  }
}
