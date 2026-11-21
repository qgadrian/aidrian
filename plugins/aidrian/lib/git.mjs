// Small git helpers for hooks and commands. Each returns null when git cannot answer, so the caller decides whether to
// fail open or closed.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { attemptClone, cloneGitProblem } from './attempt-clone.mjs';
import { isDirectory, isEntry, isFile } from './fs.mjs';

// The clone check every git call of the plugin asks first, for the modules that spawn git themselves.
export { cloneGitProblem };

// How long one git call may take. Hooks run git on every tool call, inside the host's hook timeout; a git that hangs, on
// a stalled file system or an fsmonitor, is stopped and counts as git not answering. Once one call is stopped, the later
// ones in the same process do not wait again, so a hook pays the timeout once. `options.timeout` overrides it, and 0
// waits as long as git takes.
export const GIT_TIMEOUT_MS = 2000;
let stalled = null;

// Forgets a stopped call, as a new process starts: a test that runs hooks in its own process calls it before each call.
export function resetGitStall() {
  stalled = null;
}
// The signal a git past its limit gets when the call names none: git's own SIGTERM, which lets it remove a lock it holds,
// or SIGKILL inside killingGit.
let killSignal;

// `read()`, with every git call it makes that names no signal killed outright at its limit: spawnSync waits for a child
// that ignores SIGTERM. Only for reads that hold no lock, such as `aidrian session snapshot`'s.
export function killingGit(read) {
  const before = killSignal;
  killSignal = 'SIGKILL';
  try {
    return read();
  } finally {
    killSignal = before;
  }
}

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
// runs hardened (hardenedArgs), with GIT_NO_REPLACE_OBJECTS=1. A call in a project run's attempt clone whose git folder
// holds a `commondir`, or whose own config sets a key that runs a program (attempt-clone.mjs cloneGitProblem), runs no
// git: it answers `status` null with the reason on stderr and an `error` whose code is EREFUSED, as git not answering.
// The -c settings override core.fsmonitor and core.hooksPath, but not a config a commondir leads git to.
export function runGit(args, cwd, options = {}) {
  if (stalled && options.timeout === undefined) return stalled;
  const refused = cloneGitProblem(cwd ?? process.cwd());
  if (refused) return { status: null, signal: null, stdout: '', stderr: refused, error: Object.assign(new Error(refused), { code: 'EREFUSED' }) };
  const result = spawnSync('git', hardenedArgs(args), { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, ...(killSignal ? { killSignal } : {}), ...options, env: { ...(options.env ?? process.env), GIT_NO_REPLACE_OBJECTS: '1' } });
  if (result.error?.code === 'ETIMEDOUT' && options.timeout === undefined) stalled = { status: null, stdout: '', stderr: '', error: result.error };
  return result;
}

// A runGit with `options` that runs each command once, by its arguments and folder, and gives its result again: for the
// readers of one process that share a read, such as a snapshot's remotes and its origin (lib/session-links.mjs).
export function memoGit(options = {}) {
  const results = new Map();
  return (args, cwd) => {
    const key = JSON.stringify([args, cwd]);
    if (!results.has(key)) results.set(key, runGit(args, cwd, options));
    return results.get(key);
  };
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

// The tree of the commit HEAD names in the checkout that `cwd` is in, or of the branch `branch` when given, or null:
// git cannot say, or `branch` is no branch name by git's own rules, such as one that reads as a revision.
export function treeOf(cwd, branch = null) {
  // Git's own answer with only its line end cut: a name may end in a character trim() would drop, such as a no-break space.
  const checked = branch === null ? null : runGit(['check-ref-format', '--branch', branch], cwd);
  if (checked && (checked.status !== 0 || checked.stdout.replace(/\n$/u, '') !== branch)) return null;
  const ref = branch === null ? 'HEAD' : `refs/heads/${branch}`;
  return firstLine(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], cwd);
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

// The git folders of the checkout `cwd` is in, as absolute paths: { common, gitDir, top }, the folder every worktree
// shares, this checkout's own, and its top folder; null when git cannot answer. `options` are runGit's.
export function gitFolders(cwd, options) {
  const lines = firstLine(['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel'], cwd, options)?.split('\n');
  if (lines?.length !== 3) return null;
  const [common, gitDir, top] = lines;
  return { common, gitDir, top };
}

// The config files git reads beside a repository's own, as git itself resolves them under `env`: the user's
// (`git var GIT_CONFIG_GLOBAL`, one a line) and the system's (`git var GIT_CONFIG_SYSTEM`, wherever git was built to
// keep it, such as a package manager's prefix), each an absolute path. Neither is read. None of a kind git cannot name,
// as with GIT_CONFIG_NOSYSTEM set. `options` are runGit's.
export function gitConfigFiles({ env = process.env, ...options } = {}) {
  const named = (name) => {
    const { status, stdout } = runGit(['var', name], path.parse(process.cwd()).root, { ...options, env });
    return status === 0 ? stdout.split('\n').map((line) => line.trim()).filter((line) => path.isAbsolute(line)) : [];
  };
  return { user: named('GIT_CONFIG_GLOBAL'), system: named('GIT_CONFIG_SYSTEM') };
}

// The top folder of every checkout of the repository `cwd` is in: the checkout `cwd` is in, then each one `git worktree
// list` names that holds a work tree, so a bare entry, as a git folder kept apart lists itself, and a worktree whose
// folder is gone are dropped. Each listed path is exactly as git prints it. [] only when `cwd` is outside any repository:
// no folder at or above it holds a `.git`. Inside a repository every failure is null, a git missing from PATH, a stopped
// git, and a non-zero exit included: the list always names the main checkout, so a failed one leaves the
// checkouts unknown, and a caller that keeps files out of every checkout refuses. So is a git kept from the repository by
// GIT_CEILING_DIRECTORIES: the disk still shows a `.git` at or above `cwd`, so the list fails closed. An environment that
// sets GIT_DIR, GIT_WORK_TREE, or GIT_COMMON_DIR points git at a repository other than the one at `cwd`, or at another
// work tree of it, so its list would be wrong, not unknown: null too. `read` gives each git call's options, and its
// `env`, when given, is the environment that counts.
export function repositoryCheckouts(cwd, read = () => undefined) {
  const env = read()?.env ?? process.env;
  if (REDIRECTS.some((name) => env[name] !== undefined)) return null;
  const listed = runGit(['worktree', 'list', '--porcelain'], cwd, read());
  if (listed.status !== 0) return underGit(cwd) ? null : [];
  const roots = checkoutRoots(cwd, read());
  if (!roots) return null;
  const entries = listed.stdout.split('\n\n').filter((entry) => !entry.split('\n').includes('bare'));
  // Each path is the rest of its line, whatever that line holds.
  const paths = entries.map((entry) => entry.split('\n').find((line) => line.startsWith('worktree '))?.slice('worktree '.length));
  return [...new Set([roots.current, ...paths.filter((dir) => dir && holdsCheckout(dir))])];
}

// The variables that point git away from the repository its folder holds.
const REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];

// Whether git keeps a work tree at `dir`: a `.git` file or folder is there.
export const holdsCheckout = (dir) => isFile(path.join(dir, '.git')) || isDirectory(path.join(dir, '.git'));

// Whether `dir` or a folder above it holds a `.git` entry, where git looks for a repository. It reads the disk alone, so
// it answers when git does not.
function underGit(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (isEntry(path.join(current, '.git'))) return true;
    if (path.dirname(current) === current) return false;
  }
}

// Whether git ignores `file` (absolute, or relative to `root`).
export function isIgnored(root, file) {
  const { status } = runGit(['check-ignore', '-q', '--', file], root);
  return status === 0 ? true : status === 1 ? false : null;
}

// The longest branch name isRefName takes, in UTF-8 bytes: a ledger row stays a fixed size (lib/session-prs.mjs).
export const REF_NAME_MAX_BYTES = 255;
// A control character, a space, or one of ~ ^ : ? * [ \, which git refuses anywhere in a ref name.
const REF_NAME_CHARACTER = /[\u0000- \u007f~^:?*[\\]/u;

// Whether `name` is a branch name git takes, by `git check-ref-format --branch`'s rules, within REF_NAME_MAX_BYTES:
// none of REF_NAME_CHARACTER; no `..`, `@{`, or `//`; no leading `-` or `/`; no trailing `/` or `.`; no part that starts
// with `.` or ends with `.lock`; and not `@`. Pure JS: it starts no process, so a value from a command or a ledger row
// never reaches git as an argument.
export function isRefName(name) {
  if (typeof name !== 'string' || name === '' || name === '@' || Buffer.byteLength(name) > REF_NAME_MAX_BYTES) return false;
  if (REF_NAME_CHARACTER.test(name) || name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}
