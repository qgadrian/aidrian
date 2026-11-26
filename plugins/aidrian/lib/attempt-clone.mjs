// The clone a confined host's session works in for one attempt of a project run's issue (lib/project-start.mjs
// prepareAttempt), told apart from the state side alone: a checkout counts as an attempt clone when its real root is
// `<state>/runs/<run>/attempts/<issue>.<attempt>/work` and the run's ledger there holds a start row for that issue and
// attempt naming that folder. Nothing inside the clone is read for it, since the session writes there. The ledger's
// init row names the run's main checkout, which then stands as the clone's main checkout (lib/git.mjs checkoutRoots):
// the machine's switches and decisions come from that checkout's local file, never the clone's own, and the clone is no
// shared main checkout for the main-checkout rule. A clone whose link cannot be read reads every switch off.
// It also reads the clone's own git config, from its git folder beside it, for a key that makes git run a program
// (cloneConfigProblem): a hook refuses a call there while one is set, before any git call of its own runs there.
// The link is anchored on the unattended mark of the session that reads it: a session could build a ledger and a main
// checkout of its own in a folder it may write, so the link holds only for a session whose mark names the clone's run and
// issue, and the ledger's main checkout as its root, and only while the clone's state folder is one the project at that
// main checkout names. A folder a sandbox may write, such as the temporary folder or a state work folder, is never one
// unless that project's own config names it. A hook names the session by its payload's id (anchorClones); a command
// reads it from its host's environment. The readers of the mark and of the project's state folders are given in
// (anchorReaders, which lib/project.mjs calls on load), so this file imports node built-ins only, as lib/git.mjs, which
// loads it, does; with none given, no clone links.
// It also refuses a call in a clone whose `.git` pointer names another git folder than the attempt's own, or whose git
// folder holds a `commondir` or a `config.worktree` other than the gate's placeholder (GIT_PLACEHOLDERS), through which
// git would read another config; lib/git.mjs runGit asks it before every git call of the plugin in a clone
// (cloneGitProblem), and so does every other git call of the plugin there (lib/config-committed.mjs).
// A confined session's sandbox denies it the main checkout, so from inside it the link cannot be read and the clone reads
// every switch off. Its auto-merge switch alone comes from the start row then: the switch the driver read in the main
// checkout when it started the attempt, outside the sandbox (project-run-gate.mjs launchStart), which the clone carries
// as `machine` (confinedMachine) only while this process is denied the main checkout and the session's own mark, which
// the gate filed, names the run, the issue, that main checkout, and this very work folder as the one it started in. A
// hook, which runs outside the sandbox, reads the link and the main checkout's own file as before.

import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

// A path inside an attempt's folder: the state folder, the run, the issue, the attempt, and the part after it.
const ATTEMPT = /^(.+)\/runs\/([a-z0-9][a-z0-9-]{0,63})\/attempts\/((?:[A-Z][A-Z0-9]{0,15}-)?[1-9][0-9]{0,8})\.([1-9][0-9]{0,2})(\/.*)?$/u;
// The folders of an attempt a confined session writes beside its clone, its drop and cache folders, and the empty
// file each holds from the start, whose write the host's sandbox denies where it can (lib/hosts/claude-code-sandbox.mjs),
// so the folder can be neither emptied nor removed, and a link put in its place.
export const KEPT_FOLDERS = Object.freeze(['drop', 'cache']);
export const ATTEMPT_KEEP = '.keep-attempt';
// The largest ledger read for a clone's link.
const LEDGER_CAP = 16 * 1024 * 1024;

// The real path of `file` as the system resolves it, where git and the kernel land, or null: realpathSync.native, since
// the plain one folds a `..` as text before it follows the link ahead of it, so `<x>/link/..` reads as `<x>`, not as
// the folder above the link's target. On a disk that folds case, it answers in the disk's own case.
export const systemReal = (file) => {
  try {
    return realpathSync.native(file);
  } catch {
    return null;
  }
};
const real = systemReal;

// The attempt whose folder holds the path `file`, by its real path: { state, run, key, attempt, folder, work, git,
// drop, cache }, or null.
export function attemptOf(file) {
  const resolved = real(file) ?? path.resolve(file);
  const match = ATTEMPT.exec(resolved.split(path.sep).join('/'));
  if (!match) return null;
  const [, state, run, key, attempt] = match;
  const folder = path.join(state, 'runs', run, 'attempts', `${key}.${attempt}`);
  return { state, run, key, attempt: Number(attempt), folder, work: path.join(folder, 'work'), git: path.join(folder, 'git'), drop: path.join(folder, 'drop'), cache: path.join(folder, 'cache') };
}

// The rows of the ledger file `file`, read without following a link from a regular file with one link, or null.
function ledgerRows(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > LEDGER_CAP) return null;
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, read).toString('utf8').split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The readers the link is anchored with, { sessionOf, readMark, namedStates }, from anchorReaders: `sessionOf(env)`, the
// session the host names in an environment; `readMark(session, { env, home })`, the session's unattended mark
// (lib/unattended-mark.mjs readUnattendedMark); and `namedStates(main, { env, home })`, the state folders the project at
// the main checkout `main` names. Null until given: then no clone links.
let readers = null;
// The session a clone's link is checked against, { session, env, home }: what anchorClones set, or the session the host
// names in this process's environment.
let anchor = null;
// Each root's answer, for the anchor it was read under: a hook asks several times a call.
const answers = new Map();

// Sets the readers every clone link is anchored with (lib/project.mjs gives them on load).
export function anchorReaders(given) {
  readers = given ?? null;
  answers.clear();
}

// Sets the session whose unattended mark anchors every clone link this process reads: a hook passes its payload's
// session id, and a test its own `env` and `home` (unattended-mark.mjs markFolders). Null goes back to the host's
// environment.
export function anchorClones(given) {
  anchor = given ?? null;
  answers.clear();
}

const anchorOf = () => anchor ?? { session: readers?.sessionOf?.(process.env) ?? null, env: process.env };

// What the checkout root `root` is as an attempt clone: null when its real path is no attempt's work folder; else the
// attempt (attemptOf) with `main`, the run's main checkout the ledger's init row names, when the ledger holds a start
// row for that issue and attempt naming this folder, that main checkout is a git checkout outside the state folder, the
// attempt's git folder holds no file that sends git elsewhere (gitExtraProblem), the anchored session's mark names the
// run, the issue, and that main checkout (anchoredBy), and the state folder is one the project there names
// (namedState); or with `unlinked: true` when any of that does not hold or cannot be read.
export function attemptClone(root) {
  const at = attemptOf(root);
  if (!at || real(root) !== at.work) return null;
  if (!answers.has(at.work)) answers.set(at.work, linkOf(at));
  return answers.get(at.work);
}

function linkOf(at) {
  const rows = ledgerRows(path.join(at.state, 'runs', at.run, 'ledger.jsonl'));
  const [init] = rows ?? [];
  const named = (row) => [row.drop && real(row.drop) === at.drop, row.cwd && real(row.cwd) === at.work].some(Boolean);
  const started = (rows ?? []).some((row) => row?.event === 'start' && row.key === at.key && row.attempt === at.attempt && named(row));
  const main = init?.event === 'init' && init.run === at.run && typeof init.main === 'string' && path.isAbsolute(init.main) ? real(init.main) : null;
  const linked = started && main !== null && main !== at.work && !(`${main}/`.startsWith(`${at.state}/`)) && real(path.join(main, '.git')) !== null
    && gitExtraProblem(at) === null && anchoredBy(at, main) && namedState(at, main);
  if (linked) return { ...at, main };
  const machine = confinedMachine(at, rows, init);
  return { ...at, unlinked: true, ...(machine ? { machine } : {}) };
}

// The machine facts the start row of the attempt `at` recorded, { autoMerge, feedbackAuto? }, for a session the sandbox denies the main
// checkout the ledger's `init` row names, or null: the start row names this work folder, the main checkout is denied
// to this process (a read refused, never one that is gone), the attempt's git folder sends git nowhere else
// (gitExtraProblem), and the anchored session's mark, not pending, names the run, the issue, that main checkout as its
// root, and this work folder as the folder the gate started it in. `autoMerge` is "on", "off", or "unset" for a local
// file that sets none and that git tracks not, which may follow a team default of "on".
function confinedMachine(at, rows, init) {
  const main = init?.event === 'init' && init.run === at.run && typeof init.main === 'string' && path.isAbsolute(init.main) ? init.main : null;
  if (main === null || !denied(main) || gitExtraProblem(at) !== null) return null;
  const start = (rows ?? []).findLast((row) => row?.event === 'start' && row.key === at.key && row.attempt === at.attempt && typeof row.cwd === 'string' && real(row.cwd) === at.work);
  const autoMerge = start?.machine?.autoMerge;
  if (!['on', 'off', 'unset'].includes(autoMerge)) return null;
  const { session, env, home } = anchorOf();
  if (typeof session !== 'string' || typeof readers?.readMark !== 'function') return null;
  let mark;
  try {
    mark = readers.readMark(session, { env: env ?? process.env, ...(home ? { home } : {}) });
  } catch {
    return null;
  }
  const own = mark && !mark.pending && mark.root === main && mark.project === at.run && mark.issue === at.key && typeof mark.cwd === 'string' && real(mark.cwd) === at.work;
  const feedbackAuto = start.machine.feedbackAuto;
  return own ? { autoMerge, ...(typeof feedbackAuto === 'boolean' ? { feedbackAuto } : {}) } : null;
}

// Whether this process is refused a read of the folder `folder`, as a confined session's sandbox refuses the main
// checkout; false when it reads it, or the folder is gone.
function denied(folder) {
  try {
    readdirSync(folder);
    return false;
  } catch (error) {
    return error?.code === 'EPERM' || error?.code === 'EACCES';
  }
}

// Whether the anchored session's own mark names the clone's run and issue, and `main` as its root; or, before the gate
// has filed that mark, the gate's pending mark that holds it names `main` as its root and this work folder as the folder
// it starts the session in, as a confined start's first tool call may come first.
function anchoredBy(at, main) {
  const { session, env, home } = anchorOf();
  if (typeof session !== 'string' || typeof readers?.readMark !== 'function') return false;
  let mark;
  try {
    mark = readers.readMark(session, { env: env ?? process.env, ...(home ? { home } : {}) });
  } catch {
    return false;
  }
  if (!mark || typeof mark.root !== 'string' || real(mark.root) !== main) return false;
  if (mark.pending) return typeof mark.cwd === 'string' && real(mark.cwd) === at.work;
  return mark.project === at.run && mark.issue === at.key;
}

// Whether the clone's state folder is one the project at `main` names (readers.namedStates): its state.dir, as the
// environment and as the user's own home resolve it. A folder a session made, such as one in the temporary folder, is
// none of them.
function namedState(at, main) {
  const { env, home } = anchorOf();
  if (typeof readers?.namedStates !== 'function') return false;
  const state = real(at.state);
  try {
    return readers.namedStates(main, { env: env ?? process.env, ...(home ? { home } : {}) })
      .some((folder) => typeof folder === 'string' && state !== null && real(folder) === state);
  } catch {
    return false;
  }
}

// The keys that make git run a program, or send where it should not, in a clone's own config, as patterns over the
// lower-case key, each with the values that refuse (any, by default): the repository check's (lib/project-trust.mjs
// REFUSED_KEYS, all of which a clone's own config may not set) and the signature programs git runs to show a signature.
export const PROGRAM_KEYS = Object.freeze([
  [/^core\.(?:sshcommand|gitproxy|askpass|alternaterefscommand|worktree|hookspath|editor|pager)$/u],
  [/^core\.fsmonitor$/u, (value) => !/^(?:true|false|yes|no|on|off|1|0)$/iu.test(value)],
  [/^credential\.(?:.+\.)?helper$/u],
  [/^remote\..+\.(?:uploadpack|receivepack|vcs|proxy)$/u],
  [/^http\.(?:.+\.)?proxy$/u],
  [/^(?:include\.path|includeif\..+)$/u],
  [/^filter\..+\.(?:clean|smudge|process)$/u],
  [/^diff\..+\.(?:command|textconv)$/u],
  [/^(?:diff|merge)\.external$|^merge\..+\.driver$/u],
  [/^protocol\.(?:.+\.)?allow$/u],
  [/^gpg\.(?:.+\.)?program$/u],
  [/^(?:log\.showsignature|commit\.gpgsign|tag\.gpgsign|push\.gpgsign)$/u, (value) => /^(?:true|yes|on|1|if-asked)$/iu.test(value)],
  [/^(?:sequence\.editor|pager\..+|alias\..+)$/u],
]);

// The longest `.git` pointer file read.
const POINTER_CAP = 4096;

// Why the work folder's `.git` of the attempt `at` does not point at the attempt's own git folder, or null: it must be
// a regular file, read without following a link, whose `gitdir:` line names that folder, by its real path, from the work
// folder when relative. A folder, a link, a missing file, or a pointer elsewhere refuses: git would read another config.
function pointerProblem(at) {
  const file = path.join(at.work, '.git');
  let fd;
  let text;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > POINTER_CAP) return `the attempt clone's ${file} is not a pointer file to its own git folder, ${at.git}`;
    const buffer = Buffer.alloc(stat.size);
    text = buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)).toString('utf8');
  } catch {
    return `the attempt clone's ${file} is not a pointer file to its own git folder, ${at.git}`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const named = /^gitdir: (.+?)\r?\n?$/u.exec(text)?.[1];
  // Joined as text, not by path.resolve, which folds a `..` before the link git follows ahead of it.
  const spelled = named && !path.isAbsolute(named) ? `${at.work}/${named}` : named;
  const target = spelled ? real(spelled) : null;
  return target !== null && target === real(at.git) ? null : `the attempt clone's ${file} points at another git folder than its own, ${at.git}, so no call runs there until it is restored`;
}

// The files of a git folder through which git reads another folder's config, or a worktree's own, each with the one
// text a clone's may hold, the gate's placeholder: `commondir` names the shared git folder, and `config.worktree` adds
// keys on top of the attempt's config once extensions.worktreeConfig is set. The gate puts both in each clone's git
// folder before its session starts (lib/project-start.mjs placeHolders), so a sandbox that denies writes only to a path
// there at launch, as on Linux, holds each by its path: an empty `config.worktree` adds nothing, and a `commondir` of
// `.` and a newline names the git folder itself as the common one, which git reads as no other folder
// (test/unattended-write-allowlist.test.mjs runs git status, commit, fetch, and push in such a clone). An empty
// `commondir`, the host's own placeholder for a denied absent file on Linux, makes git die.
export const GIT_PLACEHOLDERS = Object.freeze({ commondir: '.\n', 'config.worktree': '' });

// Why the attempt `at`'s git folder may send git elsewhere, or null: it holds a `commondir` or a `config.worktree` that
// is not the gate's placeholder (GIT_PLACEHOLDERS), a regular file with one link and exactly that text, read without
// following a link; or one cannot be checked. A missing one adds nothing.
function gitExtraProblem(at) {
  for (const [name, text] of Object.entries(GIT_PLACEHOLDERS)) {
    const file = path.join(at.git, name);
    const held = placeholderHeld(file, text);
    if (held === true || held === 'missing') continue;
    if (held === 'unreadable') return `the attempt clone's ${file} cannot be checked`;
    return `the attempt clone's git folder holds ${file}, through which git reads another config, so no call runs there until it is removed`;
  }
  return null;
}

// Whether the file `file` is the placeholder whose text is `text`: true; 'missing'; 'unreadable' when it cannot be
// checked; or false for a link, a folder, a file with a second link, or any other text.
function placeholderHeld(file, text) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(text)) return false;
    const buffer = Buffer.alloc(stat.size);
    return buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)).toString('utf8') === text;
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    // A link opened with O_NOFOLLOW fails with ELOOP, or EMLINK on some systems; a folder may fail with EISDIR.
    return ['ELOOP', 'EMLINK', 'EISDIR', 'ENOTDIR'].includes(error.code) ? false : 'unreadable';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Why a call in the folder `cwd` may not run because the attempt clone it lies in sets, in its own git config, a key
// that makes git run a program (PROGRAM_KEYS), or null. The config is the file in the attempt's git folder, beside the
// clone, read with `git config --file` and no other git call; a config that cannot be read refuses.
export function cloneConfigProblem(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const at = attemptOf(cwd);
  if (!at) return null;
  const pointer = pointerProblem(at) ?? gitExtraProblem(at);
  if (pointer) return pointer;
  const file = path.join(at.git, 'config');
  try {
    if (!lstatSync(file).isFile()) return `the attempt clone's git config, ${file}, is not a regular file`;
  } catch (error) {
    return error.code === 'ENOENT' ? null : `the attempt clone's git config, ${file}, cannot be read`;
  }
  const read = spawnSync('git', ['config', '--file', file, '--list', '-z'], { encoding: 'utf8', timeout: 2000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (read.error || read.status !== 0) return `the attempt clone's git config, ${file}, cannot be read`;
  for (const pair of read.stdout.split('\0').filter(Boolean)) {
    const at2 = pair.indexOf('\n');
    const key = (at2 < 0 ? pair : pair.slice(0, at2)).toLowerCase();
    const value = at2 < 0 ? '' : pair.slice(at2 + 1);
    const refused = PROGRAM_KEYS.find(([pattern, refuses]) => pattern.test(key) && (!refuses || refuses(value)));
    if (refused) return `the attempt clone's own git config sets ${key}, which makes git run a program or send elsewhere, so no git runs there until it is removed`;
  }
  return null;
}

// Why the plugin may not run git with `cwd` in an attempt clone's work or git folder, or null: cloneConfigProblem for
// that clone. A folder elsewhere, the attempt's own folder, where the gate makes the clone, and its drop folder are no
// clone's, and answer null. lib/git.mjs runGit asks it first, so every hook and command runs git in a clone only while
// its git folder holds no `commondir` and its own config no key that runs a program.
export function cloneGitProblem(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const resolved = real(cwd) ?? path.resolve(cwd);
  if (!resolved.includes('/runs/')) return null;
  const at = attemptOf(resolved);
  if (!at) return null;
  const inside = (folder) => resolved === folder || resolved.startsWith(`${folder}/`);
  if (!inside(at.work) && !inside(at.git)) return null;
  return cloneConfigProblem(at.work);
}
