// Small git helpers for hooks and commands. Each returns null when git cannot answer, so the caller decides whether to
// fail open or closed.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { attemptClone } from './attempt-clone.mjs';

// How long one git call may take. Hooks run git on every tool call, inside the host's hook timeout; a git that hangs, on
// a stalled file system or an fsmonitor, is stopped and counts as git not answering. Once one call is stopped, the later
// ones in the same process do not wait again, so a hook pays the timeout once. `options.timeout` overrides it, and 0
// waits as long as git takes.
export const GIT_TIMEOUT_MS = 2000;
let stalled = null;

// The settings every git call of the plugin runs under, a hook's, a command's, and the start gate's alike: no fsmonitor,
// no hooks, no submodule recursion, no look into a submodule's own files (its commit still shows, so a staged gitlink is
// seen), no `ext::` transport, and no signature shown, which would run the gpg or ssh program a config names, whatever
// any config file says. `-c` wins over every scope git reads, and git passes it on to the git it runs for a submodule.
export const HARDENED_PAIRS = Object.freeze([
  ['core.fsmonitor', 'false'], ['core.hooksPath', '/dev/null'], ['submodule.recurse', 'false'],
  ['diff.ignoreSubmodules', 'dirty'], ['protocol.ext.allow', 'never'], ['log.showSignature', 'false'],
]);
export const GATE_CONFIG = Object.freeze(HARDENED_PAIRS.flatMap(([key, value]) => ['-c', `${key}=${value}`]));
// The options each subcommand adds after its name: a diff runs no external diff and no textconv, and a status reads no
// submodule.
const GATE_ARGS = Object.freeze({ diff: ['--no-ext-diff', '--no-textconv'], status: ['--ignore-submodules=dirty'] });
// How long a gate's git call may take unless it says otherwise: a fetch or a clone may take a while.
const GATE_TIMEOUT_MS = 120_000;

// `args` as the plugin runs them: GATE_CONFIG first, and, when the first argument is the subcommand, its GATE_ARGS after
// it. A call that names git's own options first keeps them after GATE_CONFIG.
export function hardenedArgs(args) {
  const [first, ...rest] = args;
  return [...GATE_CONFIG, first, ...(GATE_ARGS[first] ?? []), ...rest];
}

// The environment `env` (this process's by default) for a git the plugin runs with arguments it cannot change, as a test
// replaces its spawn: the HARDENED_PAIRS as GIT_CONFIG_COUNT settings after any the environment has, and
// GIT_NO_REPLACE_OBJECTS=1, so no replace ref stands in for an object it reads.
export function hardenedEnv(env = process.env) {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const base = Number.isInteger(count) && count >= 0 ? count : 0;
  const pairs = Object.fromEntries(HARDENED_PAIRS.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${base + i}`, key], [`GIT_CONFIG_VALUE_${base + i}`, value]]));
  return { ...env, ...pairs, GIT_CONFIG_COUNT: String(base + HARDENED_PAIRS.length), GIT_NO_REPLACE_OBJECTS: '1' };
}

// The raw spawn result: { status, stdout, stderr, error }. Some git commands use exit 1 as an answer, not a failure.
// A git stopped by the timeout, and every later call that does not set its own timeout, has `status` null. Every call
// runs hardened (hardenedArgs), with GIT_NO_REPLACE_OBJECTS=1.
export function runGit(args, cwd, options = {}) {
  if (stalled && options.timeout === undefined) return stalled;
  const result = spawnSync('git', hardenedArgs(args), { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, ...options, env: { ...(options.env ?? process.env), GIT_NO_REPLACE_OBJECTS: '1' } });
  if (result.error?.code === 'ETIMEDOUT' && options.timeout === undefined) stalled = { status: null, stdout: '', stderr: '', error: result.error };
  return result;
}

// runGit for the project run's start gate (lib/project-run-gate.mjs and the modules it uses), with GATE_TIMEOUT_MS by
// default. `options.env` is the environment (this process's by default); the rest are runGit's.
export function gateGit(args, cwd, { env = process.env, ...options } = {}) {
  return runGit(args, cwd, { timeout: GATE_TIMEOUT_MS, ...options, env });
}

function firstLine(args, cwd, options) {
  const result = runGit(args, cwd, options);
  return result.status === 0 ? result.stdout.trim() : null;
}

// The main checkout, which every worktree of the repository shares. `options` are runGit's.
export function mainRoot(cwd, options) {
  return checkoutRoots(cwd, options)?.main ?? null;
}

// The top folder of the checkout that `cwd` is in: the main checkout or one of its worktrees.
export function currentRoot(cwd) {
  return firstLine(['rev-parse', '--show-toplevel'], cwd);
}

// `cwd` from the top of its checkout, with a trailing slash: '' at the top, or when git cannot answer.
export function showPrefix(cwd) {
  return firstLine(['rev-parse', '--show-prefix'], cwd) ?? '';
}

// `cwd` from the top of its checkout, with a trailing slash, or null when git cannot answer, so a reader of policy at a
// path from the top never takes a failed read for the top itself. `options` are runGit's, such as a hook's `timeout`.
export function knownPrefix(cwd, options) {
  return firstLine(['rev-parse', '--show-prefix'], cwd, options);
}

// Both at once, in one git call: { main, current }, or null. They differ inside a linked worktree.
// In the main checkout, its own git folder is the common one, so the main checkout is the current one, wherever
// `git init --separate-git-dir` put that folder. A linked worktree has only the common folder's place to go by: the
// main checkout holds it as `.git`. A separate git folder records no main checkout (`git worktree list` names the
// folder itself), so from a linked worktree of such a repository `main` is that folder's parent.
export function checkoutRoots(cwd, options) {
  const lines = firstLine(['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel'], cwd, options)?.split('\n');
  if (lines?.length !== 3) return null;
  const [commonDir, gitDir, current] = lines;
  // A project run's attempt clone has the run's main checkout as its own, read from the state side (attempt-clone.mjs);
  // one whose link cannot be read keeps itself, `unlinked`, and its project reads every machine switch off.
  const clone = current.includes('/runs/') ? attemptClone(current) : null;
  if (clone?.main) return { main: clone.main, current, attempt: clone };
  if (clone) return { main: current, current, attempt: clone, unlinked: true };
  return { main: gitDir === commonDir ? current : path.dirname(commonDir), current };
}

// Every worktree of the repository `cwd` is in, the main checkout first, from `git worktree list`; none outside git.
export function worktreePaths(cwd) {
  const { status, stdout } = runGit(['worktree', 'list', '--porcelain'], cwd);
  if (status !== 0) return [];
  return stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
}

// Whether git ignores `file` (absolute, or relative to `root`).
export function isIgnored(root, file) {
  const { status } = runGit(['check-ignore', '-q', '--', file], root);
  return status === 0 ? true : status === 1 ? false : null;
}
