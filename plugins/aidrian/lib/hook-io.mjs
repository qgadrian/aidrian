// Input and exit helpers for hook scripts. Claude Code and Codex send one JSON object on stdin and read the exit code:
// 0 lets the action run, 2 blocks it and shows stderr to the agent.

import { readFileSync, realpathSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizeHookInput } from './hosts/index.mjs';

// The hook payload, or {} when stdin is empty or not a JSON object.
export function readHookInput() {
  try {
    const value = JSON.parse(readFileSync(0, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// A hook a test calls in its own process (callHook) ends by throwing this, where a hook run by a host exits.
export class HookExit extends Error {
  constructor(code) {
    super(`hook exit ${code}`);
    this.code = code;
  }
}

// The stderr text of the hook callHook runs, or null when the hook runs as its own process.
let called = null;

function end(code) {
  if (called) throw new HookExit(code);
  process.exit(code);
}

function writeErr(text) {
  if (called) called.stderr += text;
  else writeSync(2, text);
}

// Prints `text` and a newline on stdout, where a hook hands the host its JSON or context; callHook keeps it instead.
export function print(text) {
  if (called) called.stdout += `${text}\n`;
  else writeSync(1, `${text}\n`);
}

// Whether the module at `url` is the script node was started with, so a hook script runs its body only then, and a
// test can import its `handle` instead. A path it cannot resolve counts as the script: a gate that cannot tell runs.
export function isMain(url) {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return true;
  }
}

export function allow() {
  end(0);
}

// Exit 2 with `reason` on stderr: a PreToolUse hook blocks the action; a PostToolUse hook hands the agent feedback.
// writeSync: a buffered stderr write can be lost when the process exits right after it.
export function deny(reason) {
  writeErr(`${reason}\n`);
  end(2);
}

// deny(reason), with lib/hook-deny.mjs recording the block of `rule` on the call in `input`; `options` go to its
// recordBlock. The reason is written first and the recording comes after, so nothing the recording does delays the
// denial's text; the recording never waits on a lock either, so the exit stays well inside the host's hook timeout.
// A recorder that fails to load or to record still blocks.
export async function block(input, rule, reason, options) {
  writeErr(`${reason}\n`);
  try {
    (await import('./hook-deny.mjs')).recordBlock(input, rule, reason, options);
  } catch {
    // Not recorded; the call is still blocked.
  }
  end(2);
}

// Runs a hook body with the payload, in the standard names (lib/hosts/). An error lets the action run and prints nothing: a broken hook, or a payload
// shape this hook does not know, must never stop a session.
export async function runHook(body) {
  try {
    await body(normalizeHookInput(readHookInput()));
  } catch {
    process.exit(0);
  }
}

// Runs the hook `handle` in this process, as the host runs its script, for the payload `payload` from the folder `cwd`
// with the environment `env`: { status, stderr, stdout }, the exit code and text its script would give. `handle(input, { start })`
// gets `start`, performance.now() at the call, which a script's run takes as 0, its process's start. Only for tests:
// it swaps the process's folder and environment for the call, so calls run one at a time, never in parallel.
export async function callHook(handle, payload, { cwd = process.cwd(), env = process.env } = {}) {
  if (called) throw new Error('callHook runs one hook at a time');
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  const capture = { stderr: '', stdout: '' };
  called = capture;
  let status = 0;
  try {
    process.chdir(cwd);
    replaceEnv(env);
    await handle(normalizeHookInput(payload ?? {}), { start: performance.now() });
  } catch (error) {
    // Any other error lets the action run, as runHook does.
    if (error instanceof HookExit) status = error.code;
    else if (error?.syscall === 'chdir') throw error;
  } finally {
    called = null;
    process.chdir(saved.cwd);
    replaceEnv(saved.env);
  }
  return { status, stderr: capture.stderr, stdout: capture.stdout };
}

// Makes process.env hold exactly `env`, in place, so code that kept a reference to process.env sees the change.
// Only for tests, as callHook and test/cli-call.mjs swap a call's environment in and back out.
export function replaceEnv(env) {
  // A value of undefined leaves the variable out, as spawnSync does.
  const next = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
  for (const name of Object.keys(process.env)) if (!Object.hasOwn(next, name)) delete process.env[name];
  Object.assign(process.env, next);
}
