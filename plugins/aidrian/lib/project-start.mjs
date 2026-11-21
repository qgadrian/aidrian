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
// Every git call goes through gateGit (lib/git.mjs).

import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ATTEMPT_KEEP, attemptOf, GIT_PLACEHOLDERS, KEPT_FOLDERS } from './attempt-clone.mjs';
import { isWithin, readSmallJson, resolvedPath } from './fs.mjs';
import { gateGit } from './git.mjs';
import { claimedSource, forgeToken, gitCredentialVars, sessionToken, tokenDigest, tokenVars } from './project-token.mjs';
import { loadConfig } from './config.mjs';
import { findProject, stateRoot } from './project.mjs';
import { CACHE_VAR_NAMES, NPM_CONFIGS, varsProblem } from './project-registries.mjs';
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
// the forge, asked with that very token, does not let it push to the repository, or when the token is not of the
// account `checked`, { login } or { why } it cannot be told, names: the one the preflight checked the forge's rules,
// branch protection, tag rules, and environment reviewers, for, which hold a token of any other account to nothing
// (the preflight passes the forge CLI's login it checks as, a start the one a passed preflight recorded,
// lib/project-token.mjs checkedAccount). { pushUrl, token } then names its source `id`, its `source` label, and
// `notes`, never the token, which the session's SessionStart hook reads again from that one source.
export function accessProblem({ cap, forge, repository, env, home, guarded, main, platform = process.platform, allowed = [], localBinding = false, keychain = null, exec, checked = { why: 'no account was named' } }) {
  const pushed = pushAccess({ cap, forge, repository, env, home, guarded, main, platform, allowed, localBinding });
  if (!pushed?.pushUrl || cap.forgeTokenEnv !== true) return pushed;
  const read = forgeToken({ forge, repository, keychain, platform, env, ...(exec ? { exec } : {}) });
  if (read.problem) return { halt: read.problem, token: { notes: read.notes } };
  const token = { id: read.id, source: read.source, notes: read.notes, digest: tokenDigest(read.token) };
  const denied = tokenPushProblem({ forge, repository, read }) ?? tokenOwnerProblem({ forge, repository, read, checked });
  return denied ? { halt: denied, token } : { ...pushed, token };
}

// Why the token `read` gave is not of the account `checked` names, the one the preflight checked the forge's rules
// for, or cannot be told to be, or null. Fails closed: a login the forge does not answer halts as another one does.
const RECHECK = 'run `aidrian project preflight` again, with the forge CLI signed in as the account the token belongs to, so it checks the forge\'s rules for that account';
function tokenOwnerProblem({ forge, repository, read, checked }) {
  if (typeof checked?.login !== 'string' || checked.login === '') return `${checked?.why ?? 'no account was named'}, so whether the forge token from ${read.source} is the account's the forge's rules were checked for cannot be told; ${RECHECK}`;
  let owner;
  try {
    owner = forge.tokenLogin({ host: repository.host, token: read.token });
  } catch (error) {
    return `the forge cannot say which account the forge token from ${read.source} belongs to (${String(error?.message ?? error).split('\n')[0].slice(0, 200)}), so the forge's rules, checked for ${JSON.stringify(checked.login)}, may not hold it; give that source a token of ${JSON.stringify(checked.login)}`;
  }
  if (typeof owner !== 'string' || owner === '') return `the forge names no account the forge token from ${read.source} belongs to, so the forge's rules, checked for ${JSON.stringify(checked.login)}, may not hold it; give that source a token of ${JSON.stringify(checked.login)}`;
  if (owner.toLowerCase() === checked.login.toLowerCase()) return null;
  return `the forge token from ${read.source} belongs to ${JSON.stringify(owner)}, not ${JSON.stringify(checked.login)}, the account the preflight checked branch protection, tag rules, and environment reviewers for, so those checks say nothing of what the token may bypass; ${RECHECK}, or give that source a token of ${JSON.stringify(checked.login)}`;
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
// base tip `tip` on the first attempt, or from the forge on a later one when the forge has it. `env` is the environment
// of its network calls.
export function prepareAttempt({ project, state, run, key, attempt, branch, tip, env }) {
  const folder = attemptFolder(state, run, key, attempt);
  const [work, git, drop, cache] = ['work', 'git', 'drop', 'cache'].map((name) => path.join(folder, name));
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
  const failed = (what, result) => gone(`the attempt's clone could not be made (${what}: ${String(result.stderr ?? '').trim().split('\n').at(-1) || `exit ${result.status}`})`);
  const url = gateGit(['remote', 'get-url', 'origin'], main, { timeout: 30_000 });
  if (url.status !== 0) return failed('origin', url);
  const cloned = gateGit(['clone', '--quiet', '--shared', '--no-checkout', '--separate-git-dir', git, main, work], folder, { env });
  if (cloned.status !== 0) return failed('clone', cloned);
  const origin = gateGit(['remote', 'set-url', 'origin', url.stdout.trim()], work);
  if (origin.status !== 0) return failed('origin', origin);
  let from = tip;
  const listed = gateGit(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], work, { env });
  // A first attempt cuts the branch fresh from the base tip: one the forge has already is someone else's work.
  if (attempt === 1 && listed.status === 0) return gone(`the branch ${branch} is on the forge already, and a first attempt cuts it fresh from the base tip; delete it on the forge, or name the issue another branch, then start again`);
  if (attempt === 1 && listed.status !== 2) return failed('ls-remote', listed);
  if (attempt > 1) {
    if (listed.status === 0) {
      const fetched = gateGit(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], work, { env });
      if (fetched.status !== 0) return failed('fetch', fetched);
      from = `refs/remotes/origin/${branch}`;
    } else if (listed.status !== 2) return failed('ls-remote', listed);
  }
  const checkout = gateGit(['checkout', '--quiet', '-b', branch, from], work);
  if (checkout.status !== 0) return failed('checkout', checkout);
  const plain = plainFolderProblem(drop) ?? plainFolderProblem(cache);
  return plain ? gone(plain) : { folder, work, git, drop, cache };
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
// only the names cacheVars gives. Never throws.
export function confinedShellVars({ session, cwd, env = process.env, home }) {
  try {
    const { attempt } = confinedAttempt({ session, cwd, env, home }) ?? {};
    if (!attempt) return null;
    const read = readSmallJson(path.join(attempt.folder, SHELL_VARS), SHELL_VARS_CAP);
    if (!read || varsProblem(read)) return null;
    const vars = Object.fromEntries(Object.entries(read).filter(([name]) => CACHE_VAR_NAMES.includes(name)));
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
    if (claim.problem) return { problem: claim.problem, folder: null };
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

// The confined attempt `cwd` lies in and the mark of `session`, its session, or null (confinedShellVars).
function confinedAttempt({ session, cwd, env, home }) {
  const attempt = typeof cwd === 'string' && path.isAbsolute(cwd) ? attemptOf(cwd) : null;
  if (!attempt) return null;
  const mark = readUnattendedMark(session, { env, ...(home ? { home } : {}) });
  const real = (file) => {
    try {
      return realpathSync(file);
    } catch {
      return null;
    }
  };
  const starting = mark?.pending === true && typeof mark.cwd === 'string' && real(mark.cwd) === real(attempt.work);
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
  return own !== null && own === real(attempt.folder);
}
