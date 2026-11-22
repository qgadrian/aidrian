// The parts of a project run's start (lib/project-run-gate.mjs startIssue) that say whether a host may start a
// session now, and where it starts it.
//   - hostStartProblem, accessProblem: a host whose start is unverified where the team has not allowed that, one whose
//     hooks are not trusted, a user the forge does not let push, or a session that could not push, reach the forge, or
//     would be let write a folder the gate guards. Each is a halt of the start, which records nothing.
//   - A halt: `start` exits 1 and its first line is `halt <cause>` (haltAnswer). A start whose proof failed also writes a
//     `halt` row (lib/project-run-gate.mjs), which only an attended `aidrian project resume` lifts.
//   - linkTripwire: a ledger, snapshot, continuation store file, unattended mark, or the repository's git config with a
//     second hard link, which a session could change through, halts the start.
//   - Every host's project start is confined (`capabilities.projectStart.confined`, as Codex and Claude Code declare it),
//     each to its own sandbox, and a host that is not halts the start (lib/project-run-gate.mjs). Its session works in a
//     fresh clone made for each attempt, never in a linked worktree: `runs/<run>/attempts/<issue>.<attempt>/` holds
//     `work/`, the clone, `git/`, its separate git folder, which borrows the main checkout's objects read-only through
//     alternates, `drop/`, where the session hands its result over (lib/project-result.mjs), and `cache/`, where its
//     package managers keep their caches (lib/project-registries.mjs). The branch comes from
//     the forge: the first attempt cuts it from the base tip, a later one fetches it. The main repository never fetches from the clone, the gate never runs git
//     in a clone a session had, and the driver removes an attempt's folder once its session ended (sweepAttempts).
//     The session may also write the state work folders, plans, reviews, tmp, and dispatch, each a plain folder of the
//     user directly in the state folder that holds no guarded folder and lies in none.
//   - Each attempt's clone commits unsigned (UNSIGNED, in its own config alone): the sandbox hides the user's signing
//     keys, so a commit the user's own config signs would fail after the work is done. commitProblem is the preflight's
//     probe that a commit works in a clone made so.
// Every git call goes through gateGit (lib/git.mjs).

import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ATTEMPT_KEEP, attemptOf, GIT_PLACEHOLDERS, KEPT_FOLDERS, systemReal } from './attempt-clone.mjs';
import { isWithin, readSmallJson, resolvedPath } from './fs.mjs';
import { gateGit } from './git.mjs';
import { claimedSource, forgeToken, gitCredentialVars, sessionToken, tokenDigest, tokenVars } from './project-token.mjs';
import { loadConfig } from './config.mjs';
import { findProject, stateRoot } from './project.mjs';
import { NPM_CONFIGS, SHELL_VAR_NAMES, varsProblem } from './project-registries.mjs';
import { DROP_FILE, plainFolderProblem } from './project-result.mjs';
import { pinnedRepository, runFolder, runsFolder } from './project-run.mjs';
import { latestStart, ownAttemptFolder, startRows } from './project-run-guard.mjs';
import { signoffFolders } from './review/signoff-store.mjs';
import { archiveStops } from './stop-history.mjs';
import { safely } from './session-start-gate.mjs';
import { markFolders, readUnattendedMark } from './unattended-mark.mjs';
import { WORK_FOLDERS } from './unattended-write.mjs';

// The folders of the state folder a confined session may write besides its attempt's: the plans, reviews, and dispatch
// records an issue's work leaves, and its temporary files (unattended-write.mjs, which keeps the list).
export { WORK_FOLDERS };
// The verified values a start no live run has checked is not.
const CHECKED = new Set(['fixtures', 'live']);

// Whether the host's start `cap` is one no live run has checked: any `verified` but fixtures or live.
export const isUnverified = (cap) => !CHECKED.has(cap?.verified);

// The `unverified:` line an unverified host's every start prints, or none.
export const unverifiedNote = (cap) => (isUnverified(cap)
  ? [`unverified: this host's project start is checked on fixtures only (${cap.evidence ?? 'no live run'}); the team allows it through projectRun.unverifiedHosts`]
  : []);

// The answer of a start that halts: exit 1, `halt <cause>` first, then `note` and `lines`, and the cause on stderr with
// what lifts it. Nothing is recorded: a halt row is the caller's, for a failed proof.
export const haltAnswer = (cause, { note = [], lines = [], lift = 'fix it, then start again' } = {}) => ({
  exitCode: 1, out: [`halt ${cause}`, ...note, ...lines], err: [`aidrian project start: halt: ${cause}; ${lift}`],
});

// Why the host `cap` (capabilities.projectStart) may not start a session under the team's `policy`, or null: a start
// no live run has checked the base branch has not allowed through projectRun.unverifiedHosts, and a host whose hooks
// wait on a person's trust (`hookTrust`) that does not answer 'trusted', since every hold of an unattended session is a
// hook.
export function hostStartProblem(cap, policy, env) {
  if (isUnverified(cap) && policy.unverifiedHosts !== true) {
    return 'this host\'s project start is not verified on a live host, and the default branch\'s config.json, on the forge and as this checkout holds it, does not set projectRun.unverifiedHosts to true';
  }
  if (typeof cap.hookTrust !== 'function') return null;
  const trust = safely(() => cap.hookTrust(env));
  if (trust === 'trusted') return null;
  return `this host does not run the plugin's hooks unasked (its hook trust reads ${trust ?? 'unknown'}), and every hold of a session no Human attends is a hook: ${cap.trustStep ?? 'trust them in the host'}, then start again`;
}

// What stands between a session started now and pushing its branch: { halt } when the forge, asked through gh, does not
// let this user push to the pinned `repository`, or the host's `access({ env, home, guarded, pushUrl, platform,
// allowed, helpers, localBinding })` says its session could not push, reach the forge, or run as confined as it is meant to, or would
// be let write one of `guarded`; { refuse } when the forge cannot be asked now; null, or { pushUrl } when the host was
// asked. `main` is the main checkout, whose origin URL the attempt's clone takes (prepareAttempt), so it is the URL the
// session pushes to (`pushUrl`, which confinedRoom holds the clone to); `helpers` are the git credential helpers its
// config names; `platform` the operating system, `allowed` the base branch's projectRun.outsideSandbox, and
// `localBinding` its projectRun.localBinding, which lets the host's settings allow local binding too.
// On a host that hands its session the forge token (`forgeTokenEnv`), a start halts too when no source gives a token
// (lib/project-token.mjs: the keychain entry `keychain`, the machine's default entry, or the forge CLI's login), or when
// the forge, asked with that very token, does not let it push to the repository; { pushUrl, token } then names its
// source `id`, its `source` label, and `notes`, never the token, which the session's SessionStart hook reads again from
// that one source.
export function accessProblem({ cap, forge, repository, env, home, guarded, main, platform = process.platform, allowed = [], localBinding = false, keychain = null, exec }) {
  const pushed = pushAccess({ cap, forge, repository, env, home, guarded, main, platform, allowed, localBinding });
  if (!pushed?.pushUrl || cap.forgeTokenEnv !== true) return pushed;
  const read = forgeToken({ forge, repository, keychain, platform, env, ...(exec ? { exec } : {}) });
  if (read.problem) return { halt: read.problem, token: { notes: read.notes } };
  const token = { id: read.id, source: read.source, notes: read.notes, digest: tokenDigest(read.token) };
  const denied = tokenPushProblem({ forge, repository, read });
  return denied ? { halt: denied, token } : { ...pushed, token };
}

// Why the token `read` gave may not push to `repository`, by the forge's push probe with that very token, or null.
function tokenPushProblem({ forge, repository, read }) {
  const named = `${repository.host}/${repository.owner}/${repository.name}`;
  let answer;
  try {
    answer = forge.tokenCanPush(`${repository.owner}/${repository.name}`, { host: repository.host, token: read.token });
  } catch (error) {
    return `whether the forge token from ${read.source} may push to ${named} cannot be told (${String(error?.message ?? error).split('\n')[0].slice(0, 200)}); start again`;
  }
  if (answer?.may === true) return null;
  return `the forge token from ${read.source} may not push to ${named}, as the forge's push probe with it answers (${answer?.why ?? 'no answer'}); give that source a token that may write the repository's contents`;
}

function pushAccess({ cap, forge, repository, env, home, guarded, main, platform, allowed, localBinding }) {
  const named = `${repository.host}/${repository.owner}/${repository.name}`;
  let view;
  try {
    view = forge.repository(`${repository.owner}/${repository.name}`, { host: repository.host });
  } catch (error) {
    return { refuse: `the forge cannot say now whether this user may push to ${named} (${String(error.message).split('\n')[0]}); start again` };
  }
  if (view?.permissions?.push !== true) return { halt: `the forge does not let this user push to ${named}` };
  if (typeof cap.access !== 'function') return null;
  const url = gateGit(['remote', 'get-url', 'origin'], main, { timeout: 30_000 });
  const pushUrl = url.status === 0 ? url.stdout.trim() : null;
  const listed = gateGit(['config', '--get-regexp', '^credential\\..*helper$'], main, { timeout: 30_000 });
  const helpers = listed.status === 0 ? listed.stdout.split('\n').filter(Boolean).map((line) => line.slice(line.indexOf(' ') + 1)) : [];
  // An access check that throws halts: a check the gate cannot run is no check passed.
  let host;
  try {
    host = cap.access({ env, home, guarded, pushUrl, platform, allowed, helpers, localBinding: localBinding === true });
  } catch (error) {
    host = `the host's access check failed (${String(error?.message ?? error).split('\n')[0]})`;
  }
  return host ? { halt: host } : { pushUrl };
}

// The folders no session no Human attends may be let write, as real paths: the main checkout's git folder, the state
// root, the mark folders, the sign-off store's (review/merge-trust.mjs), and the runs folder of `state`.
export function guardedFolders({ main, state, env, home }) {
  const common = gateGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], main, { timeout: 30_000 });
  const folders = [common.status === 0 ? common.stdout.trim() : path.join(main, '.git'), stateRoot(env), ...markFolders({ env, home }), ...signoffFolders({ env, home }), runsFolder(state)];
  return [...new Set(folders.map((each) => resolvedPath(each) ?? path.resolve(each)))];
}

// The run log of issue `key`'s attempt `attempt`: `logs/<issue>.<attempt>.jsonl` in the run's folder.
export const runLogFile = (state, run, key, attempt) => path.join(runFolder(state, run), 'logs', `${key}.${attempt}.jsonl`);

// The run log of issue `key`'s attempt `attempt` (runLogFile), whose folder is made owner-only: { file } or { problem }.
export function runLog(state, run, key, attempt) {
  const file = runLogFile(state, run, key, attempt);
  const folder = path.dirname(file);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { problem: `the run's log folder ${folder} cannot be made (${error.code ?? 'no code'})` };
  }
  const plain = plainFolderProblem(folder);
  return plain ? { problem: plain } : { file };
}

// Why a file a session could change the run's state through has a second hard link, or null: the run's ledger and
// snapshot, each file of the continuation store `store`, each unattended mark, and the main checkout's git config. A
// link made elsewhere would let a write there land here.
export function linkTripwire({ state, run, store, env, home, main }) {
  const files = [path.join(runFolder(state, run), 'ledger.jsonl'), path.join(runFolder(state, run), 'snapshot.json')];
  const listing = (dir) => safely(() => readdirSync(dir).map((name) => path.join(dir, name))) ?? [];
  if (!store.refused) files.push(...listing(store.dir));
  for (const folder of markFolders({ env, home })) files.push(...listing(folder));
  const common = gateGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], main, { timeout: 30_000 });
  if (common.status === 0) files.push(path.join(common.stdout.trim(), 'config'));
  for (const file of files) {
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      continue;
    }
    if (stat.isFile() && stat.nlink > 1) return `${file} has ${stat.nlink} hard links, so a write through another of them would change it; remove the other links, then start again`;
  }
  return null;
}

// The folder of attempt `attempt` of issue `key` of the run `run` in `state`.
export const attemptFolder = (state, run, key, attempt) => path.join(runFolder(state, run), 'attempts', `${key}.${attempt}`);

// The state work folders a confined session may write, each made owner-only when absent: { folders }, their real paths,
// or { problem } when one is not a plain folder of this user directly in the state folder's real path under its own
// name, or holds, or lies in, the runs folder, the handoffs folder, the decisions folder, a mark folder, or a sign-off store folder, as a link
// `tmp -> runs` would.
export function stateWorkFolders(state, { env, home }) {
  const base = resolvedPath(state);
  if (!base) return { problem: `the state folder ${state} cannot be resolved` };
  const guarded = [runsFolder(state), path.join(state, 'handoffs'), path.join(state, 'decisions'), ...markFolders({ env, home }), ...signoffFolders({ env, home })].map((each) => resolvedPath(each) ?? path.resolve(each));
  const folders = [];
  for (const name of WORK_FOLDERS) {
    const dir = path.join(base, name);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') return { problem: `the state work folder ${dir} cannot be made (${error.code ?? 'no code'})` };
    }
    const plain = plainFolderProblem(dir);
    if (plain) return { problem: `the state work folder ${plain}` };
    if (resolvedPath(dir) !== dir) return { problem: `the state work folder ${dir} does not resolve to itself` };
    if (guarded.some((each) => each === dir || isWithin(dir, each) || isWithin(each, dir))) return { problem: `the state work folder ${dir} holds, or lies in, a folder the run guards` };
    folders.push(dir);
  }
  return { folders };
}

// The fresh clone of attempt `attempt` of issue `key` for a confined host: { folder, work, git, drop, cache } or
// { problem }, which leaves no attempt folder. `cache` is the owner-only folder its package managers' caches go to
// (project-registries.mjs cacheVars), which holds only npm's empty config files (NPM_CONFIGS) at first; it and `drop`
// each hold a read-only keep file (attempt-clone.mjs ATTEMPT_KEEP). Any folder the attempt had is removed first. The clone borrows the main checkout's objects
// read-only, takes origin's URL from the main checkout, which pushProblem checked, and checks out `branch`: from the
// base tip `tip` on the first attempt, or from the forge on a later one when the forge has it. Its own config turns
// signing off (UNSIGNED); a clone whose commits would still sign (signingProblem) is { halt }. `env` is the environment
// of its network calls.
export function prepareAttempt({ project, state, run, key, attempt, branch, tip, env }) {
  const folder = attemptFolder(state, run, key, attempt);
  const [work, gitFolder, drop, cache] = ['work', 'git', 'drop', 'cache'].map((name) => path.join(folder, name));
  const main = project.checkouts.at(-1);
  try {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    seedFolders(folder);
  } catch (error) {
    return { problem: `the attempt's folder ${folder} cannot be made (${error.code ?? 'no code'})` };
  }
  // A clone that could not be made leaves no folder: no start row names it for the sweep to remove.
  const gone = (problem) => {
    rmSync(folder, { recursive: true, force: true });
    return { problem };
  };
  // Every git call of the attempt runs under `env`, which `aidrian project` cleared of git's location variables once, at
  // its entry (git.mjs clearLocation).
  const git = (args, cwd = work, options = {}) => gateGit(args, cwd, { ...options, env });
  const failed = (what, result) => gone(`the attempt's clone could not be made (${what}: ${String(result.stderr ?? '').trim().split('\n').at(-1) || `exit ${result.status}`})`);
  const url = git(['remote', 'get-url', 'origin'], main, { timeout: 30_000 });
  if (url.status !== 0) return failed('origin', url);
  // No template: a template folder, from GIT_TEMPLATE_DIR or init.templateDir, could put a commondir or hooks in the git
  // folder. The hooks folder is made empty instead, so the sandbox's write denial has a path to hold.
  const cloned = git(['clone', '--quiet', '--template=', '--shared', '--no-checkout', '--separate-git-dir', gitFolder, main, work], folder);
  if (cloned.status !== 0) return failed('clone', cloned);
  try {
    mkdirSync(path.join(gitFolder, 'hooks'), { mode: 0o700 });
  } catch (error) {
    return gone(`the attempt's clone could not be made (hooks: ${error.code ?? 'no code'})`);
  }
  const origin = git(['remote', 'set-url', 'origin', url.stdout.trim()]);
  if (origin.status !== 0) return failed('origin', origin);
  const unsigned = setUnsigned(work, env);
  if (unsigned) return failed('config', unsigned);
  let from = tip;
  const listed = git(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`]);
  // A first attempt cuts the branch fresh from the base tip: one the forge has already is someone else's work.
  if (attempt === 1 && listed.status === 0) return gone(`the branch ${branch} is on the forge already, and a first attempt cuts it fresh from the base tip; delete it on the forge, or name the issue another branch, then start again`);
  if (attempt === 1 && listed.status !== 2) return failed('ls-remote', listed);
  if (attempt > 1) {
    if (listed.status === 0) {
      const fetched = git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      if (fetched.status !== 0) return failed('fetch', fetched);
      from = `refs/remotes/origin/${branch}`;
    } else if (listed.status !== 2) return failed('ls-remote', listed);
  }
  const checkout = git(['checkout', '--quiet', '-b', branch, from]);
  if (checkout.status !== 0) return failed('checkout', checkout);
  // The same check as the preflight's probe: a clone whose commits would still sign halts before any session starts.
  const signing = signingProblem(work, env);
  if (signing) return { halt: gone(`the attempt's clone ${work} is not started: ${signing}`).problem };
  const plain = plainFolderProblem(drop) ?? plainFolderProblem(cache);
  return plain ? gone(plain) : { folder, work, git: gitFolder, drop, cache };
}

// The signing keys each attempt's clone turns off, in its own config and nowhere else, so the user's global and system
// config stay as they are. The sandbox hides the user's signing keys (~/.gnupg and ~/.ssh are credential stores, as
// lib/hosts/claude-code-sandbox.mjs CREDENTIAL_PATHS lists them), so a commit the user's config signs fails there once
// the work is done, and the issue parks with its change staged. The forge asks no signature of a branch commit, and the
// run merges each pull request by squash, so the forge writes the commit the base branch gets. A key the environment sets,
// through GIT_CONFIG_COUNT or GIT_CONFIG_PARAMETERS, still wins over the clone's own: commitProblem names it.
export const UNSIGNED = Object.freeze([['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]);

// Sets UNSIGNED in the own config of the checkout `work`, under `env`: null, or the git call that failed.
export function setUnsigned(work, env = process.env) {
  for (const [key, value] of UNSIGNED) {
    const set = gateGit(['config', '--local', key, value], work, { timeout: 30_000, env });
    if (set.status !== 0) return set;
  }
  return null;
}

// Why a commit in the checkout `cwd`, under `env`, would still sign, or null: a key of UNSIGNED that git reads as true
// there, from every scope it reads and the environment, whose -c settings win over the checkout's own config, or a read
// that fails, which fails closed: only exit 0 (a value) and exit 1 (no value) answer. The start asks it of each
// attempt's clone, and the preflight's probe of its scratch clone.
export function signingProblem(cwd, env = process.env) {
  const signed = [];
  for (const [key] of UNSIGNED) {
    const read = gateGit(['config', '--type=bool', '--get', key], cwd, { env, timeout: 30_000 });
    if (read.status !== 0 && read.status !== 1) return `git cannot read ${key} in a clone made as an attempt's (${gitSaid(read)}), so whether its commits would sign cannot be told: fix that config`;
    if (read.status === 0 && read.stdout.trim() === 'true') signed.push(key);
  }
  if (!signed.length) return null;
  return `git still reads ${signed.join(' and ')} as true in a clone whose own config sets it false, as a GIT_CONFIG_COUNT or GIT_CONFIG_PARAMETERS setting in this environment makes it; the issue session's sandbox hides the signing keys, so its every commit would fail: unset that setting`;
}

// The branch the preflight's probe commits on when no run names one: a name of the default branch format.
export const PROBE_BRANCH = 'fix/aidrian-commit-probe';

// git's own words in the call `result`: its error and fatal lines, or its last line, or its exit status.
const gitSaid = (result) => {
  const lines = String(result.stderr ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const errors = lines.filter((line) => /^(?:error|fatal):/u.test(line));
  return ((errors.length ? errors : lines.slice(-1)).join('; ') || `exit ${result.status}`).slice(0, 400);
};

// Why a commit would fail in a clone made as prepareAttempt makes an attempt's, or null: the preflight's probe. A scratch
// repository in a folder of its own in the runs folder of `state`, where every clone lies, with its git folder apart as
// a clone's is, origin's URL `url` (the main checkout's, which each clone takes), the branch `branch` checked out, and
// UNSIGNED set in its own config, commits an empty probe under `env`: so a config that names a folder, a remote URL, or a
// branch (includeIf) reads it as a clone's. `aidrian project` cleared git's location variables at its entry
// (git.mjs clearLocation), so nothing outside the scratch folder is written. The preflight runs outside the issue
// session's sandbox, where the user's signing keys are in reach, so a commit that would still sign (signingProblem)
// refuses before the commit: in the sandbox it would fail. Otherwise git's own error refuses, as no identity would. The
// scratch folder is removed either way. With the run `run` named, the scratch lies in its attempts folder, as a clone
// does; before a run exists it lies in the runs folder and checks out PROBE_BRANCH. An accepted residual: an includeIf
// on an attempt's gitdir or branch may still read the scratch otherwise than a real clone, since the run's first
// snapshot issue may be done, so no attempt ever takes its branch, and the `.commit-probe-*` folder name misses a gitdir
// pattern on an attempt's `<issue>.<attempt>` name. The start's own signingProblem in each real clone guards signing
// only: an identity that differs, as user.useConfigOnly with an includeIf on the attempt's folder or branch makes it,
// lets the probe pass while the attempt's commit then fails on identity, and that issue parks.
export function commitProblem({ state, env = process.env, url = null, branch = PROBE_BRANCH, run = null }) {
  const runs = run ? path.join(runFolder(state, run), 'attempts') : runsFolder(state);
  let scratch;
  try {
    mkdirSync(runs, { recursive: true, mode: 0o700 });
    scratch = mkdtempSync(path.join(runs, '.commit-probe-'));
  } catch (error) {
    return `no scratch folder for the probe can be made in ${runs} (${error.code ?? 'no code'})`;
  }
  const work = path.join(scratch, 'work');
  const git = (args, cwd = work) => gateGit(args, cwd, { env, timeout: 30_000 });
  try {
    const made = git(['init', '--quiet', '--template=', `--initial-branch=${branch}`, '--separate-git-dir', path.join(scratch, 'git'), work], scratch);
    if (made.status !== 0) return `git cannot make a scratch repository for the probe (${gitSaid(made)})`;
    const origin = url ? git(['remote', 'add', 'origin', url]) : null;
    if (origin && origin.status !== 0) return `git cannot give the probe's scratch repository origin's URL (${gitSaid(origin)})`;
    const set = setUnsigned(work, env);
    if (set) return `git cannot set ${UNSIGNED.map(([key]) => key).join(' and ')} in a clone's own config (${gitSaid(set)})`;
    const signing = signingProblem(work, env);
    if (signing) return signing;
    // No automatic gc or maintenance: git starts it detached after a commit, and it would still write in the scratch
    // folder while the folder is removed below.
    const commit = git(['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'commit', '--quiet', '--allow-empty', '-m', 'aidrian preflight commit probe']);
    return commit.status === 0 ? null : `a commit in a clone made as an attempt's fails (${gitSaid(commit)})`;
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // A folder that will not go never masks the probe's own answer; the next probe makes a fresh one.
    }
  }
}

// Makes the drop and cache folders of the attempt folder `folder`, owner-only, each with its read-only keep file
// (attempt-clone.mjs ATTEMPT_KEEP), and npm's empty config files in the cache (project-registries.mjs NPM_CONFIGS).
function seedFolders(folder) {
  for (const name of KEPT_FOLDERS) {
    mkdirSync(path.join(folder, name), { mode: 0o700 });
    writeFileSync(path.join(folder, name, ATTEMPT_KEEP), '', { flag: 'wx', mode: 0o400 });
  }
  for (const name of Object.values(NPM_CONFIGS)) writeFileSync(path.join(folder, 'cache', name), '', { flag: 'wx', mode: 0o600 });
}

// Puts the host's placeholders in the fresh clone `work` whose git folder is `git`, before its session starts, where
// none is there: the git folder's own (attempt-clone.mjs GIT_PLACEHOLDERS), an empty `config.worktree`, which git reads
// only once extensions.worktreeConfig is set in the config the sandbox denies, and a `commondir` that names the git
// folder itself; and each of the host's `placeholders`, a folder or a file with its text, from the clone's root, each
// file excluded through the git folder's info/exclude so it never shows as a change. A sandbox that denies writes only
// to a path there at launch, as on Linux, then holds each. A placeholder whose path passes a link below the clone, as a
// `.claude` that links elsewhere, is never written through it: { problem }, as when one cannot be made.
export function placeHolders({ work, git, placeholders = [] }) {
  const missing = (file) => {
    try {
      lstatSync(file);
      return false;
    } catch {
      return true;
    }
  };
  try {
    for (const [name, text] of Object.entries(GIT_PLACEHOLDERS)) {
      if (missing(path.join(git, name))) writeFileSync(path.join(git, name), text, { flag: 'wx', mode: 0o600 });
    }
    const excluded = [];
    for (const each of placeholders) {
      const linked = linkedPart(work, each.path);
      if (linked) return { problem: `the attempt's clone holds ${linked}, a link, where its placeholder ${each.path} goes, so a write there would land wherever it leads; replace the link with the folder, then start again` };
      const file = path.join(work, each.path);
      if (!missing(file)) continue;
      if (each.folder) mkdirSync(file, { recursive: true, mode: 0o700 });
      else {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, each.text ?? '', { flag: 'wx', mode: 0o600 });
        excluded.push(`/${each.path}`);
      }
    }
    if (excluded.length) {
      mkdirSync(path.join(git, 'info'), { recursive: true, mode: 0o700 });
      appendFileSync(path.join(git, 'info', 'exclude'), `\n# aidrian: the placeholders of a confined session's protected host files\n${excluded.join('\n')}\n`);
    }
  } catch (error) {
    return { problem: `the placeholders of the attempt's clone could not be made (${error.code ?? 'no code'})` };
  }
  return null;
}

// The first part of the path `relative` below the folder `top`, as a path from `top`, that is a link, read with lstat
// part by part, or null; the parts below one that is not there yet are made as plain folders.
function linkedPart(top, relative) {
  const parts = relative.split('/').filter(Boolean);
  for (let count = 1; count <= parts.length; count += 1) {
    const shown = parts.slice(0, count).join('/');
    try {
      if (lstatSync(path.join(top, ...parts.slice(0, count))).isSymbolicLink()) return shown;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return null;
}

// Removes the folder of each confined attempt of `found` whose session runs no more: an attempt that is not its issue's
// running one, and whose start ran nothing (`void`), or held a session `cap.ended` lists as ended. An attempt whose
// start left it unknown waits for its orphan settling, and one whose drop holds a result no row took in yet stays. Only
// a folder at the path attemptFolder gives is removed, and only once its stop history is archived (stop-history.mjs).
export function sweepAttempts({ state, run, found, cap, env, spawn }) {
  const settled = new Set(found.rows.filter((row) => row.event === 'orphan').map((row) => `${row.key}#${row.attempt}`));
  for (const row of startRows(found).filter((each) => typeof each.drop === 'string')) {
    const folder = attemptFolder(state, run, row.key, row.attempt);
    if (path.dirname(row.drop) !== folder) continue;
    const current = found.states.get(row.key)?.state === 'running' && latestStart(found, row.key)?.attempt === row.attempt;
    if (current) continue;
    // An attempt whose result was `environment` keeps its folder for the run's life: its clone may hold the only copy of
    // work a failed push never sent, for the Human to recover.
    const environment = found.rows.some((each) => each.event === 'result' && each.status === 'environment' && each.key === row.key && each.attempt === row.attempt);
    if (environment) continue;
    // A handed-over result no row took in yet keeps its folder.
    const taken = found.rows.some((each) => ['result', 'ended'].includes(each.event) && each.key === row.key && each.attempt === row.attempt);
    if (!taken && existsSync(path.join(row.drop, DROP_FILE))) continue;
    const done = row.outcome === 'void' || settled.has(`${row.key}#${row.attempt}`)
      || (row.outcome === 'started' && safely(() => cap.ended({ id: row.id, session: row.child, env, run: spawn })) === true);
    // The stop history goes to the run's archive first, so the caps hold across attempts; one that cannot be kept
    // keeps the folder.
    // A folder swept already is archived already.
    if (!done || !existsSync(folder)) continue;
    let kept;
    try {
      kept = archiveStops({ state, run, key: row.key, attempt: row.attempt, drop: row.drop });
    } catch {
      kept = 'not archived';
    }
    if (kept === null) safely(() => rmSync(folder, { recursive: true, force: true }));
  }
}

// The file in an attempt's folder that holds the environment its session's sandboxed commands get
// (project-registries.mjs cacheVars), which the gate writes before the start and a host's SessionStart hook reads
// (confinedShellVars). No confined session writes the attempt's folder itself, only its work, git, drop, and cache.
export const SHELL_VARS = 'shell-env.json';
const SHELL_VARS_CAP = 64 * 1024;

// Writes `vars` to SHELL_VARS in the attempt's folder `folder`, owner-only, a new file: null, or why it could not.
export function writeShellVars(folder, vars) {
  const bad = varsProblem(vars);
  if (bad) return bad;
  try {
    writeFileSync(path.join(folder, SHELL_VARS), `${JSON.stringify(vars)}\n`, { flag: 'wx', mode: 0o600 });
    return null;
  } catch (error) {
    return `the shell environment of the attempt cannot be written (${error.code ?? 'no code'})`;
  }
}

// The environment the sandboxed commands of `session`, whose hook runs in `cwd`, get, or null: only for the session
// of a confined attempt, whose clone holds `cwd`, when that attempt's folder is the one the run's ledger names for the
// session its own mark names (project-run-guard.mjs ownAttemptFolder), or the session is held by a pending mark to
// start in that very clone; a folder shaped like an attempt's inside a clone, which its session may write, is neither.
// Only what the gate wrote there (writeShellVars), read without following a link, from a regular file of one link, and
// only the names cacheVars gives and the attempt's marker (SHELL_VAR_NAMES). Never throws.
export function confinedShellVars({ session, cwd, env = process.env, home }) {
  try {
    const { attempt } = confinedAttempt({ session, cwd, env, home }) ?? {};
    if (!attempt) return null;
    const read = readSmallJson(path.join(attempt.folder, SHELL_VARS), SHELL_VARS_CAP);
    if (!read || varsProblem(read)) return null;
    const vars = Object.fromEntries(Object.entries(read).filter(([name]) => SHELL_VAR_NAMES.includes(name)));
    return Object.keys(vars).length ? vars : null;
  } catch {
    return null;
  }
}

// The forge token the sandboxed commands of `session`, whose hook runs in `cwd` under `env`, get, with `folder` its
// attempt's folder: { vars, folder }, the forge CLI's token variable for the host; { problem, folder }, why it was not
// handed over, `folder` null for a session that does not hold the claim; or null for a session of no confined attempt. Only the session the start launched gets it: one whose
// environment holds the start's claim (project-token.mjs claimedSource), so no other session opened in the clone does,
// while the host has yet to name it or after. The token is read again, outside the sandbox, from the one source the
// start checked, never another (sessionToken), and handed over only when it is the token the start checked, by its
// digest, with the command-scope git config that makes git take it from the forge CLI's helper (gitCredentialVars). `token` is a test's stand-in for that read. Never throws.
export function confinedTokenVars({ session, cwd, env = process.env, home, token = sessionToken }) {
  const found = safely(() => confinedAttempt({ session, cwd, env, home }));
  if (!found) return null;
  const { folder } = found.attempt;
  try {
    // A session without the claim gets no folder: it records no handoff, so it overwrites none.
    const claim = claimedSource(folder, env);
    if (claim.problem) return { problem: claim.problem, folder: null, ...(claim.unclaimed ? { unclaimed: true } : {}) };
    const project = typeof found.mark?.root === 'string' ? findProject(found.mark.root) : null;
    const repository = project ? pinnedRepository(project) : null;
    if (!repository) return { problem: 'the main checkout the session\'s mark names gives no repository', folder };
    const read = token({ root: project.root, repository, keychain: project.localForgeTokenKeychain, env, only: claim.source });
    if (!read.token) return { problem: read.problem, folder };
    if (tokenDigest(read.token) !== claim.token) return { problem: `${read.source} now gives another token than the one the start checked`, folder };
    // git takes the token only through the forge CLI's helper, set in the same handoff, in the command scope.
    const git = gitCredentialVars(env, repository.host);
    if (!git) return { problem: 'the forge CLI is not on an absolute folder of PATH, or the forge has no plain host name, so git could not take the token through it', folder };
    return { vars: { ...tokenVars(read.token, repository.host), ...git }, folder };
  } catch (error) {
    return { problem: `the token could not be read (${String(error?.message ?? error).split('\n')[0].slice(0, 200)})`, folder };
  }
}

// The confined attempt `cwd` lies in and the mark of `session`, its session, or null (confinedShellVars). `cwd` must
// resolve inside the attempt's clone: a folder that is not there, or one beside the clone, as its drop folder, is none.
function confinedAttempt({ session, cwd, env, home }) {
  const attempt = typeof cwd === 'string' && path.isAbsolute(cwd) ? attemptOf(cwd) : null;
  if (!attempt) return null;
  // Every path resolved as attemptOf resolves `cwd`, where the system lands.
  const real = systemReal;
  const [here, work] = [real(cwd), real(attempt.work)];
  if (here === null || work === null || !isWithin(work, here)) return null;
  const mark = readUnattendedMark(session, { env, ...(home ? { home } : {}) });
  const starting = mark?.pending === true && typeof mark.cwd === 'string' && same(real, mark.cwd, attempt.work);
  if (!starting && !recordedAttempt(mark, attempt, real, home)) return null;
  return { attempt, mark };
}

// Whether `attempt` is the attempt folder the run's ledger, in the project at the main checkout the session's own mark
// `mark` names, gives that session for its run and issue (`real` resolves a path).
function recordedAttempt(mark, attempt, real, home) {
  if (!mark || mark.pending || mark.project !== attempt.run || mark.issue !== attempt.key || typeof mark.root !== 'string') return false;
  const project = findProject(mark.root);
  if (!project) return false;
  const own = ownAttemptFolder(project, loadConfig(project).config, mark, home ? { home } : {});
  return own !== null && same(real, own, attempt.folder);
}

// Whether `a` and `b` are one path by `real`, a path that does not resolve matching none, so a missing folder never
// passes for another missing one.
function same(real, a, b) {
  const resolved = real(a);
  return resolved !== null && resolved === real(b);
}
