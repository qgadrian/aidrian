// A project run: the record a driver session keeps while it works through a tracker project, one issue at a time, and
// the order it takes the issues in. The driver reads the tracker through its own tools and writes the snapshot input;
// this file validates it, keeps the run's state, and orders the issues. It starts no session. lib/project-run-cli.mjs is
// the `aidrian project` command, and lib/rules/project-init.mjs keeps a subagent from running its init.
//
// A run lives in `<state>/runs/<run>/`, where `<state>` is the project's state folder, as runPlace resolves it:
//   snapshot.json  each issue's key, branch, status type, blockedBy keys, and priority, and the status type of each
//                  blocker outside the project. No title, body, or other tracker text, ever: validateSnapshot copies only
//                  these fields, each checked, and drops every other one. The branch is the one tracker-derived text kept.
//   ledger.jsonl   append-only, each row written under the file's lock (lib/jsonl.mjs withLocks). Its first row, `init`,
//                  pins the repository, records the driver's session id, and ties the run to snapshot.json by its
//                  sha256 and issue count; later rows record what happened to an issue, and the rows of the start gate
//                  (lib/project-run-gate.mjs): each start, result, end, and move of the driver's custody. It holds no
//                  projectRun value.
//   results/       each issue's result as its session recorded it (lib/project-run-gate.mjs).
//   summary.md     what `aidrian project summary` writes from the ledger.
// One run per project is active at a time: one whose order is not done.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { baseBranchTip, stateDirProblem } from './config.mjs';
import { foldCase, isObject, isWithin, resolvedPath } from './fs.mjs';
import { repoIdentity } from './forges/index.mjs';
import { runGit } from './git.mjs';
import { baseBranchConfig } from './handoff-continue.mjs';
import { RUNS_FOLDER, startedUnattended } from './handoff-guard.mjs';
import { looseFolder, openStore, SESSION_ID } from './handoff-markers.mjs';
import { appendRow, withLocks } from './jsonl.mjs';
import { committedConfigFile, defaultStateDir, stateDir, stateRoot } from './project.mjs';
import { issueTextsOf, TEXT_BYTES, writeIssueTexts } from './project-issue-text.mjs';
import { MARK_FOLDER, markDriver, readUnattendedMark } from './unattended-mark.mjs';

// A run id: lower-case letters, digits, and dashes, starting with a letter or digit.
export const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
// An issue key: a team key and a number, such as ENG-12, or a number alone.
export const ISSUE_KEY = /^(?:[A-Z][A-Z0-9]{0,15}-)?[1-9][0-9]{0,8}$/u;
// A decision a parked issue waits on, as an id: the ledger keeps no text of it.
export const DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
// The status types an issue may have, as the tracker groups its statuses.
export const STATUS_TYPES = Object.freeze(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']);
// The status types a run may start an issue from. `triage` is not accepted yet, and `started` is someone's work already.
const STARTABLE = new Set(['backlog', 'unstarted']);
// What the ledger records of an issue, the latest row per key deciding. `open` is an issue back to be started again, as
// after an attempt that failed (lib/project-run-gate.mjs).
export const ISSUE_STATES = Object.freeze(['running', 'done', 'parked', 'open']);
// The largest snapshot input read, and the most issues, blockers of one issue, and outside blockers it may hold.
export const INPUT_CAP = 1024 * 1024;
export const MAX_ISSUES = 500;
export const MAX_BLOCKERS = 50;
export const MAX_OUTSIDE = 1000;
export const BRANCH_CAP = 120;
// The largest texts input read (`init --texts`): every issue's text at its caps.
export const TEXTS_CAP = MAX_ISSUES * TEXT_BYTES;
// The largest snapshot.json and ledger.jsonl a run reads. snapshot.json keeps a subset of an input under INPUT_CAP.
const SNAPSHOT_CAP = 2 * INPUT_CAP;
const LEDGER_CAP = 8 * 1024 * 1024;
// A part of a repository's host, owner, or name.
const PLAIN = /^[\w.-]{1,100}$/u;
const plainPart = (part) => typeof part === 'string' && PLAIN.test(part) && part !== '.' && part !== '..';
// The fields of an issue and of an outside blocker the snapshot keeps. Every other field is dropped.
const ISSUE_FIELDS = new Set(['key', 'branch', 'status', 'blockedBy', 'priority']);
const OUTSIDE_FIELDS = new Set(['key', 'status']);
const TOP_FIELDS = new Set(['issues', 'outside']);
// Opens without following a final symlink and without waiting on a FIFO, whose fstat then shows it is no regular file.
const NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
// A timestamp as Date#toISOString writes it.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

// The folder that holds every run of the project whose state folder is `state`, and the folder of run `run`.
export const runsFolder = (state) => path.join(state, RUNS_FOLDER);
export const runFolder = (state, run) => path.join(runsFolder(state), run);
const ledgerFile = (state, run) => path.join(runFolder(state, run), 'ledger.jsonl');
const snapshotFile = (state, run) => path.join(runFolder(state, run), 'snapshot.json');
// The file whose lock init holds while it checks for an active run and makes its own folder.
const runsLock = (state) => path.join(runsFolder(state), '.runs');

// Why `branch` cannot be an issue's branch, or null. It mirrors `git check-ref-format --branch` for the characters it
// allows: letters, digits, `.`, `_`, `-`, and `/`, at most BRANCH_CAP, with no leading dash, no part that starts with a
// dot or ends with `.lock`, no `..`, no empty part, and no trailing dot. It also refuses a name git would read as another
// ref: one under `refs/`, a default branch (`defaultBranches`), one whose first part names a remote (`remotes`), and a
// part that is a HEAD name, such as HEAD or FETCH_HEAD, or 40 or 64 hex digits, as a commit id is. The names compare in
// any case, since a disk that folds case holds `Main` and `main` as one ref file.
export function branchProblem(branch, { defaultBranches = [], remotes = [] } = {}) {
  if (typeof branch !== 'string' || branch === '') return 'is not a branch name';
  if (branch.length > BRANCH_CAP) return `is longer than ${BRANCH_CAP} characters`;
  if (!/^[A-Za-z0-9._/-]+$/u.test(branch)) return 'holds a character other than letters, digits, ".", "_", "-", and "/"';
  if (branch.startsWith('-')) return 'starts with a dash';
  if (branch.includes('..')) return 'holds ".."';
  if (branch.endsWith('.')) return 'ends with a dot';
  const parts = branch.split('/');
  if (parts.some((part) => part === '')) return 'has an empty part: a leading, trailing, or double slash';
  if (parts.some((part) => part.startsWith('.'))) return 'has a part that starts with a dot';
  if (parts.some((part) => part.endsWith('.lock'))) return 'has a part that ends with ".lock"';
  const same = (one, other) => one.toLowerCase() === other.toLowerCase();
  if (same(parts[0], 'refs')) return 'starts with refs/';
  if (defaultBranches.some((name) => same(name, branch))) return 'is the default branch';
  if (remotes.some((name) => same(name, parts[0]))) return `starts with ${parts[0]}, the name of a remote`;
  if (parts.some((part) => /^(?:[A-Z]+_)*HEAD$/u.test(part.toUpperCase()))) return 'has a part that is a HEAD name';
  if (parts.some((part) => /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u.test(part))) return 'has a part that reads as a commit id';
  return null;
}

// A value as a short JSON quote for a problem line: the terminal sees it, the state never does.
const quote = (value) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
};

// The snapshot `input` holds, as { snapshot, problems, dropped }: `snapshot` is { issues, outside } with only the kept
// fields, or null when `problems` lists any; `dropped` counts the fields left out, such as a title or a description.
// An issue is { key, branch, status, blockedBy, priority }: `blockedBy` defaults to [], and `priority` to 0, no priority;
// 1 is the most urgent and 4 the least. An outside blocker is { key, status }. `names` are branchProblem's.
export function validateSnapshot(input, names = {}) {
  const problems = [];
  let dropped = 0;
  if (!isObject(input)) return { snapshot: null, problems: ['the snapshot input is not a JSON object'], dropped };
  dropped += Object.keys(input).filter((field) => !TOP_FIELDS.has(field)).length;
  const issues = [];
  const outside = [];
  if (!Array.isArray(input.issues) || input.issues.length === 0) problems.push('"issues" is not a non-empty list');
  else if (input.issues.length > MAX_ISSUES) problems.push(`"issues" holds ${input.issues.length} issues, over ${MAX_ISSUES}`);
  else {
    input.issues.forEach((issue, i) => {
      const where = `issues[${i}]`;
      if (!isObject(issue)) return problems.push(`${where} is not an object`);
      dropped += Object.keys(issue).filter((field) => !ISSUE_FIELDS.has(field)).length;
      const kept = issueOf(issue, where, problems, names);
      if (kept) issues.push(kept);
      return null;
    });
  }
  if (input.outside !== undefined) {
    if (!Array.isArray(input.outside) || input.outside.length > MAX_OUTSIDE) problems.push(`"outside" is not a list of at most ${MAX_OUTSIDE} blockers`);
    else {
      input.outside.forEach((blocker, i) => {
        const where = `outside[${i}]`;
        if (!isObject(blocker)) return problems.push(`${where} is not an object`);
        dropped += Object.keys(blocker).filter((field) => !OUTSIDE_FIELDS.has(field)).length;
        if (!keyOk(blocker.key)) problems.push(`${where}.key ${quote(blocker.key)} is not an issue key such as ENG-12`);
        else if (!STATUS_TYPES.includes(blocker.status)) problems.push(`${where}.status ${quote(blocker.status)} is not one of ${STATUS_TYPES.join(', ')}`);
        else outside.push({ key: blocker.key, status: blocker.status });
        return null;
      });
    }
  }
  repeated(issues.map((issue) => issue.key), 'issue key', problems);
  repeated(issues.map((issue) => issue.branch), 'branch', problems);
  repeated(outside.map((blocker) => blocker.key), 'outside blocker key', problems);
  const inside = new Set(issues.map((issue) => issue.key));
  for (const blocker of outside) if (inside.has(blocker.key)) problems.push(`${blocker.key} is both an issue and an outside blocker`);
  return { snapshot: problems.length ? null : { issues, outside }, problems, dropped };
}

const keyOk = (key) => typeof key === 'string' && ISSUE_KEY.test(key);

// One issue's kept fields, or null after adding its problems.
function issueOf(issue, where, problems, names) {
  const before = problems.length;
  if (!keyOk(issue.key)) problems.push(`${where}.key ${quote(issue.key)} is not an issue key such as ENG-12`);
  const branch = branchProblem(issue.branch, names);
  if (branch) problems.push(`${where}.branch ${quote(issue.branch)} ${branch}`);
  if (!STATUS_TYPES.includes(issue.status)) problems.push(`${where}.status ${quote(issue.status)} is not one of ${STATUS_TYPES.join(', ')}`);
  const blockedBy = issue.blockedBy ?? [];
  if (!Array.isArray(blockedBy) || blockedBy.length > MAX_BLOCKERS || !blockedBy.every(keyOk)) {
    problems.push(`${where}.blockedBy is not a list of at most ${MAX_BLOCKERS} issue keys`);
  }
  const priority = issue.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) problems.push(`${where}.priority ${quote(issue.priority)} is not a whole number from 0 to 4`);
  if (problems.length > before) return null;
  return { key: issue.key, branch: issue.branch, status: issue.status, blockedBy: [...new Set(blockedBy)], priority };
}

function repeated(values, what, problems) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) problems.push(`the ${what} ${value} is there twice`);
    seen.add(value);
  }
}

// The bytes of the regular file `file`, at most `cap`, read without following a symlink and without waiting on a FIFO:
// { bytes } or { problem, code }, where `code` is the error code of a file that could not be opened, such as ENOENT.
// It reads at most one byte past the cap, so a file that grows after the stat is still refused.
export function readCapped(file, cap) {
  let fd;
  try {
    if (lstatSync(file).isSymbolicLink()) return { problem: `${file} is a symlink` };
    fd = openSync(file, NO_FOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: `${file} is not a regular file` };
    if (stat.size > cap) return { problem: `${file} is ${stat.size} bytes, over the ${cap} it may hold` };
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    let got = -1;
    while (got !== 0 && length < buffer.length) {
      got = readSync(fd, buffer, length, buffer.length - length, null);
      length += got;
    }
    if (length > cap) return { problem: `${file} grew past the ${cap} bytes it may hold` };
    return { bytes: buffer.subarray(0, length) };
  } catch (error) {
    if (error.code === 'ELOOP') return { problem: `${file} is a symlink` };
    return { problem: `${file} cannot be read (${error.code ?? error.message})`, code: error.code };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The texts input at `file` (`init --texts`), read as readCapped reads, at most TEXTS_CAP bytes: { texts } with each
// issue of `keys` it gives a text, or { problem }. No file gives { texts: {} }.
export function readIssueTexts(file, keys) {
  if (!file) return { texts: {} };
  const read = readCapped(file, TEXTS_CAP);
  if (read.problem) return { problem: `the texts input ${read.problem}` };
  try {
    const value = JSON.parse(read.bytes.toString('utf8'));
    if (!isObject(value)) return { problem: 'the texts input is not a JSON object of issue keys to their text' };
    return { texts: issueTextsOf(value, keys) };
  } catch {
    return { problem: 'the texts input is not JSON' };
  }
}

// The snapshot input at `file`, read as readCapped reads, at most INPUT_CAP bytes: validateSnapshot's answer, with
// `names` its, or { snapshot: null, problems: [why] } when it cannot be read as one JSON value.
export function readSnapshotInput(file, names = {}) {
  const read = readCapped(file, INPUT_CAP);
  if (read.problem) return unread(read.problem);
  try {
    return validateSnapshot(JSON.parse(read.bytes.toString('utf8')), names);
  } catch {
    return unread(`${file} is not JSON`);
  }
}

const unread = (problem) => ({ snapshot: null, problems: [problem], dropped: 0 });

// Whether the folders `one` and `other` are one, by their real paths in the case the disk folds to.
function sameFolder(one, other) {
  const [a, b] = [one, other].map((dir) => resolvedPath(dir) ?? dir);
  return foldCase(a) === foldCase(b);
}

// The state folder the runs of `project`, whose working config is `working`, are kept in, as { state } or { problem }.
// It holds as lib/handoff-continue.mjs backgroundGate holds the continuation store: the working copy's state.dir must be
// the base branch's (config.mjs stateDirProblem), and the folder the command resolves with `env` must be the one the
// base branch's config names under the host's own environment (project.mjs defaultStateDir), so an XDG_STATE_HOME or
// HOME set for the command cannot move it. The state folder and the runs folder may not be a symlink, lie inside one of
// the project's checkouts, be another user's, or be writable by every user (handoff-markers.mjs looseFolder). A base
// branch git cannot read refuses, and so does one that does not commit the project's config file, such as a nested
// project folder that only the working copy holds, whose base config would be the defaults. `home` is for a test.
export function runPlace(project, working, { env = process.env, home } = {}) {
  const base = baseBranchConfig(project, 'state.dir');
  if (base.why) return { problem: `${base.why}, so the folder a project run is kept in cannot be checked` };
  if (!committedOnBase(project)) return { problem: 'the base branch does not commit this project\'s config.json, so the folder a project run is kept in cannot be checked; commit the project folder and merge it first' };
  const moved = stateDirProblem(working, base.config, 'the base branch\'s config.json', 'the project run');
  if (moved) return { problem: moved };
  const state = stateDir(project, { config: working, env });
  const own = defaultStateDir(project, { config: base.config, ...(home ? { home } : {}) });
  if (!sameFolder(state, own)) {
    return { problem: `the state folder this command resolves, ${state}, is not ${own}, the one the base branch's config.json names under the host's own environment, as an XDG_STATE_HOME or HOME set for this command would move it` };
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const dir of [state, runsFolder(state)]) {
    const why = folderProblem(dir, project.checkouts, uid);
    if (why) return { problem: `the folder ${dir} ${why}, so no project run is kept there` };
  }
  return { state };
}

// Whether the base branch commits the config file of `project` (project.mjs committedConfigFile). A git that fails is no.
function committedOnBase(project) {
  try {
    const tip = baseBranchTip(project.root);
    const file = tip && committedConfigFile(project, tip);
    return Boolean(file) && runGit(['cat-file', '-e', `${tip}:./${file}`], project.root).status === 0;
  } catch {
    return false;
  }
}

// Why the folder `dir` cannot hold a project run, or null.
function folderProblem(dir, checkouts, uid) {
  try {
    if (lstatSync(dir).isSymbolicLink()) return 'is a symlink';
  } catch {
    // Not made yet: the checks below read where it would be.
  }
  const real = resolvedPath(dir);
  if (real === null) return 'is behind a broken symlink';
  const inside = checkouts.find((each) => {
    const root = resolvedPath(each);
    return root !== null && isWithin(foldCase(root), foldCase(real));
  });
  if (inside) return `is inside the checkout ${inside}; move state.dir out of the repository`;
  return looseFolder(dir, uid);
}

// Why the session that runs init may not start a project run, or null. A run starts only from an attended main session:
// never from a subagent (`input.agent_id`, as a hook's payload names it), a session the host names no id for, one a
// pending start of the background handoff route still holds, one with an unattended mark (lib/unattended-mark.mjs), or one
// whose chain floor says the background route started it (lib/handoff-guard.mjs startedUnattended). The floor fails
// closed: when the continuation store of `state`, the run's state folder, is refused or cannot be read, so is the run.
// A command cannot tell a subagent's shell from the main session's, which carries the same id: the project-init Bash rule
// (lib/rules/project-init.mjs) denies `aidrian project init` to a call that carries an `agent_id`. `home` is for a test.
export function attendedProblem({ input = {}, session, project, config, state, env = process.env, home, now = Date.now() }) {
  if (typeof input.agent_id === 'string' && input.agent_id !== '') return 'a subagent may not start a project run; the attended main session runs init';
  if (typeof session !== 'string' || !SESSION_ID.test(session)) {
    return 'this host tells the command no session id, so the run cannot record its driver; run init from the attended main session';
  }
  let mark;
  try {
    mark = readUnattendedMark(session, { env, now, ...(home ? { home } : {}) });
  } catch {
    mark = { root: null };
  }
  if (mark?.pending) {
    return 'another session\'s handoff gate is starting a background session, and until the host lists its id this session cannot be told apart from it; run init again in a few minutes';
  }
  const unattended = 'the background handoff route started this session, and no Human attends it; a person starts a project run from an attended session';
  if (mark) return unattended;
  const store = storeProblem(project, config, state);
  if (store) return `${store}, so whether the background handoff route started this session cannot be read`;
  if (startedUnattended(project, config, session, home ? { home } : {})) return unattended;
  return null;
}

// Why the continuation store of the state folder `state` cannot be read, or null: it is refused (handoff-markers.mjs
// openStore), or its folder is there and cannot be listed. A store not made yet holds no floor.
function storeProblem(project, config, state) {
  const store = openStore(state, { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain });
  if (store.refused) return store.refused;
  try {
    readdirSync(store.dir);
  } catch (error) {
    if (error.code !== 'ENOENT') return `the continuation store ${store.dir} cannot be read (${error.code})`;
  }
  return null;
}

// The repository `project` is in, as the forge names it from its origin remote: { host, owner, name }, or null.
export function pinnedRepository(project) {
  const { status, stdout } = runGit(['config', '--get', 'remote.origin.url'], project.root);
  const identity = status === 0 ? repoIdentity(stdout.trim()) : null;
  if (!identity) return null;
  const parts = identity.path.split('/');
  const name = parts.pop();
  const owner = parts.join('/');
  if (!plainPart(identity.host) || !plainPart(name) || !parts.every(plainPart)) return null;
  return { host: identity.host, owner, name };
}

// The names branchProblem holds a branch apart from for `project`: its default branch, as the working copy's and the
// base branch's config name it and as origin's HEAD points to it, and its remotes.
export function refNames(project, config) {
  const base = baseBranchConfig(project, 'git.defaultBranch');
  const head = runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], project.root);
  const originHead = head.status === 0 ? head.stdout.trim().replace(/^refs\/remotes\/origin\//u, '') : null;
  const defaultBranches = [config.git.defaultBranch, base.config?.git.defaultBranch, originHead].filter(Boolean);
  const listed = runGit(['remote'], project.root);
  const remotes = listed.status === 0 ? listed.stdout.split('\n').map((name) => name.trim()).filter(Boolean) : [];
  return { defaultBranches, remotes };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Starts run `run` from the snapshot input at `file`, for `project`, whose working config is `config`, in the state
// folder runPlace resolves, and returns { exitCode, out, err }. `session` is the driver's session id and `input` a hook's
// payload when one is known; attendedProblem says who may run it. It refuses a run id or snapshot that fails its checks,
// a state folder runPlace refuses, a project whose origin names no forge repository, a run that exists already, and any
// other run still active. Throws jsonl.mjs's LOCKED when another process holds the runs lock. `home` is for a test.
export function initRun({ project, config, run, file, texts: textsFile = null, session, input = {}, env = process.env, home, now = Date.now() }) {
  if (typeof run !== 'string' || !RUN_ID.test(run)) return refuse(`the run id ${quote(run)} is not lower-case letters, digits, and dashes, up to 64, starting with a letter or digit`);
  const place = runPlace(project, config, { env, home });
  if (place.problem) return refuse(place.problem);
  const { state } = place;
  const attended = attendedProblem({ input, session, project, config, state, env, home, now });
  if (attended) return refuse(attended);
  const read = readSnapshotInput(file, refNames(project, config));
  if (!read.snapshot) return { exitCode: 1, out: [], err: ['aidrian project init: the snapshot input has problems; fix them and run init again', ...read.problems.slice(0, 20).map((problem) => `  ${problem}`)] };
  const repository = pinnedRepository(project);
  if (!repository) return refuse('the origin remote names no forge repository, so the run cannot pin one');
  const texts = readIssueTexts(textsFile, new Set(read.snapshot.issues.map((issue) => issue.key)));
  if (texts.problem) return refuse(texts.problem);

  mkdirSync(runsFolder(state), { recursive: true, mode: 0o700 });
  return withLocks([runsLock(state)], () => {
    if (entryAt(runFolder(state, run))) return refuse(`the run ${run} exists already in ${runFolder(state, run)}; pick another run id`);
    const active = activeRuns(state, { except: run });
    if (active.length && active[0].run === null) return refuse(`the folder of the project runs, ${runsFolder(state)}, cannot be read, so whether a run is still active cannot be told`);
    if (active.length) return refuse(`the run ${active[0].run} is still active in ${runFolder(state, active[0].run)}; finish it, or remove its folder, before another starts`);
    // `main`: the run's main checkout, by its real path, which an attempt clone of a confined host stands for
    // (lib/attempt-clone.mjs): its machine switches and decisions are read there.
    const main = resolvedPath(project.checkouts.at(-1)) ?? project.checkouts.at(-1);
    // From here the session drives the run, and the hooks hold it as one no Human attends for the runs folder, the
    // marks, and the sign-off store (run-driver.mjs): its driver mark is filed first, or the run does not start.
    if (!markDriver(session, { run, root: main, state: resolvedPath(state) ?? state, env, now })) {
      return refuse(`this session's driver mark cannot be filed in ${path.join(stateRoot(env), MARK_FOLDER)}, so the hooks could not hold the run's driver`);
    }
    mkdirSync(runFolder(state, run), { mode: 0o700 });
    const text = `${JSON.stringify({ run, at: new Date(now).toISOString(), ...read.snapshot })}\n`;
    writeFileSync(snapshotFile(state, run), text, { mode: 0o600, flag: 'wx' });
    // Each issue's text, kept apart from snapshot.json, for its session to read from a file (lib/project-issue-text.mjs).
    const kept = writeIssueTexts(runFolder(state, run), texts.texts);
    const row = { event: 'init', run, at: new Date(now).toISOString(), session, repository, main, issues: read.snapshot.issues.length, sha256: sha256(Buffer.from(text)) };
    // The runs lock covers this first row: no other writer appends to a run whose ledger has no init row (recordIssue).
    appendRow(ledgerFile(state, run), row);
    return {
      exitCode: 0,
      out: [
        `run: ${run}`,
        `issues: ${read.snapshot.issues.length}`,
        `repository: ${repository.host}/${repository.owner}/${repository.name}`,
        ...(kept ? [`issue text: ${kept} of ${read.snapshot.issues.length} kept for the issues' sessions to read`] : []),
        ...(read.dropped ? [`dropped: ${read.dropped} fields the snapshot never keeps, such as titles and bodies`] : []),
        `folder: ${runFolder(state, run)}`,
      ],
      err: [],
    };
  });
}

const refuse = (reason) => ({ exitCode: 1, out: [], err: [`aidrian project init: ${reason}`] });

// The lstat of `file`, or null when there is nothing there.
function entryAt(file) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

// The JSON objects of the ledger's lines; a line that is not one is left out.
function ledgerRows(bytes) {
  return bytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return isObject(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

// Run `run` as its files hold it: { init, snapshot, states, rows } or { problem }. `states` maps an issue key to the
// latest ledger row of it, { state, decision }; a row that is not one of the shapes this file writes is left out. `rows`
// are every JSON object of the ledger after the init row, in order, for lib/project-run-gate.mjs to read by its own
// checks. Both files are read as readCapped reads, and snapshot.json must have the sha256 and issue count the init row
// recorded.
export function readRun(state, run) {
  if (typeof run !== 'string' || !RUN_ID.test(run)) return { problem: `the run id ${quote(run)} is not a run id` };
  const folder = entryAt(runFolder(state, run));
  if (!folder) return { problem: `no run ${run} in ${runsFolder(state)}` };
  if (!folder.isDirectory()) return { problem: `${runFolder(state, run)} is not a folder` };
  const ledger = readCapped(ledgerFile(state, run), LEDGER_CAP);
  if (ledger.problem) return { problem: `the ledger of run ${run}: ${ledger.problem}` };
  const rows = ledgerRows(ledger.bytes);
  const [init] = rows;
  if (!isInit(init, run)) return { problem: `the ledger of run ${run} does not start with its init row` };
  const read = readCapped(snapshotFile(state, run), SNAPSHOT_CAP);
  if (read.problem) return { problem: `the snapshot of run ${run}: ${read.problem}` };
  if (sha256(read.bytes) !== init.sha256) return { problem: `the snapshot of run ${run} is not the one its init row recorded` };
  let snapshot;
  try {
    snapshot = JSON.parse(read.bytes.toString('utf8'));
  } catch {
    return { problem: `the snapshot of run ${run} is not JSON` };
  }
  const checked = validateSnapshot({ issues: snapshot?.issues, outside: snapshot?.outside });
  if (!checked.snapshot || checked.snapshot.issues.length !== init.issues) return { problem: `the snapshot of run ${run} does not pass its checks` };
  const keys = new Set(checked.snapshot.issues.map((issue) => issue.key));
  const states = new Map();
  for (const row of rows.slice(1)) {
    if (row.event !== 'issue' || !keys.has(row.key) || !ISSUE_STATES.includes(row.state)) continue;
    states.set(row.key, { state: row.state, decision: typeof row.decision === 'string' && DECISION_ID.test(row.decision) ? row.decision : null });
  }
  return { init, snapshot: checked.snapshot, states, rows: rows.slice(1) };
}

// Whether `row` is the init row initRun writes for `run`.
const isInit = (row, run) => isObject(row) && row.event === 'init' && row.run === run
  && typeof row.at === 'string' && ISO.test(row.at) && Number.isFinite(Date.parse(row.at)) && new Date(row.at).toISOString() === row.at
  && typeof row.session === 'string' && SESSION_ID.test(row.session)
  && isObject(row.repository) && plainPart(row.repository.host) && plainPart(row.repository.name)
  && typeof row.repository.owner === 'string' && row.repository.owner.split('/').every(plainPart)
  && Number.isInteger(row.issues) && row.issues > 0 && typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(row.sha256);

// Why the run `found` (readRun) is halted, or null: the cause of its latest `halt` row, unless a `resume` row an attended
// session wrote with `aidrian project resume` comes after it. A start whose proof failed writes the halt row
// (lib/project-run-gate.mjs); nothing lifts it but a resume.
export function haltOf(found) {
  let halt = null;
  for (const row of found.rows) {
    if (row.event === 'halt') halt = typeof row.cause === 'string' && row.cause !== '' ? row.cause.slice(0, 300) : 'a start failed its proof';
    else if (row.event === 'resume') halt = null;
  }
  return halt;
}

// Records in the ledger of run `run` that issue `key` is now `issueState`, one of ISSUE_STATES, with `decision`, the id
// of the decision a parked issue waits on. Before it takes the ledger's lock, the run's folder must be a folder holding
// snapshot.json, so a missing run gets no folder or lock file; under the lock it reads the run whole and appends. It throws
// on a key the snapshot does not hold or a value of a wrong shape.
export function recordIssue(state, run, { key, state: issueState, decision = null }, { now = Date.now() } = {}) {
  if (typeof run !== 'string' || !RUN_ID.test(run)) throw new Error(`${quote(run)} is not a run id`);
  if (!ISSUE_STATES.includes(issueState)) throw new Error(`${quote(issueState)} is not one of ${ISSUE_STATES.join(', ')}`);
  if (decision !== null && (typeof decision !== 'string' || !DECISION_ID.test(decision))) throw new Error(`${quote(decision)} is not a decision id`);
  if (!entryAt(runFolder(state, run))?.isDirectory() || !entryAt(snapshotFile(state, run))?.isFile()) throw new Error(`no run ${run} in ${runsFolder(state)}`);
  const file = ledgerFile(state, run);
  return withLocks([file], () => {
    const found = readRun(state, run);
    if (found.problem) throw new Error(found.problem);
    if (!found.snapshot.issues.some((issue) => issue.key === key)) throw new Error(`run ${run} holds no issue ${quote(key)}`);
    const row = { event: 'issue', key, state: issueState, ...(decision ? { decision } : {}), at: new Date(now).toISOString() };
    appendRow(file, row);
    return row;
  });
}

// Appends to the ledger of run `run`, under its lock, the rows `build(found)` returns for the run as readRun reads it under
// that lock: { rows } appended in order, or { problem } appending none, which is what it returns. The run's folder must
// hold snapshot.json before the lock is taken, as recordIssue's. Throws jsonl.mjs's LOCKED when another holds the lock.
export function appendToRun(state, run, build) {
  if (typeof run !== 'string' || !RUN_ID.test(run)) return { problem: `${quote(run)} is not a run id` };
  if (!entryAt(runFolder(state, run))?.isDirectory() || !entryAt(snapshotFile(state, run))?.isFile()) return { problem: `no run ${run} in ${runsFolder(state)}` };
  const file = ledgerFile(state, run);
  return withLocks([file], () => {
    const found = readRun(state, run);
    if (found.problem) return { problem: found.problem };
    const built = build(found);
    if (built.problem) return built;
    for (const row of built.rows) appendRow(file, row);
    return built;
  });
}

// The runs in `state` other than `except` that are still active, as [{ run }]: a run whose files cannot be read counts,
// and a folder of runs that is there and cannot be listed gives [{ run: null }], a run whose driver cannot be told.
export function activeRuns(state, { except } = {}) {
  let names;
  try {
    names = readdirSync(runsFolder(state));
  } catch (error) {
    return error.code === 'ENOENT' ? [] : [{ run: null }];
  }
  return names.filter((name) => RUN_ID.test(name) && name !== except).filter((name) => {
    const found = readRun(state, name);
    if (found.problem) return true;
    // A run whose ledger records its end (`aidrian project end`) is over, whatever its issues.
    if (found.rows.some((row) => row?.event === 'end')) return false;
    return planRun(found.snapshot, found.states).verdict !== 'done';
  }).map((run) => ({ run }));
}

// The rank of a priority: 1 first, 4 last, and 0, no priority, after them.
const rank = (priority) => (priority >= 1 && priority <= 4 ? priority : 5);
// Keys in their natural order: by team key, then by number, so ENG-9 comes before ENG-10.
function byKey(a, b) {
  const [ta, na] = splitKey(a);
  const [tb, nb] = splitKey(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return na - nb;
}
const splitKey = (key) => {
  const at = key.lastIndexOf('-');
  return [at < 0 ? '' : key.slice(0, at), Number(key.slice(at + 1))];
};
// SHORTCUT: how many issues `next` names at once until a later slice reads projectRun.maxParallel from the base branch
// through the forge, failing closed. One at a time only ever refuses more than any config allows; that read replaces it.
export const SERIAL = 1;
// The state of an issue the ledger has no row for, from its tracker status type.
const TRACKER_STATE = { completed: 'done', canceled: 'canceled' };

// The plan for `snapshot`, with `states` the ledger's latest state of each issue and `maxParallel` the most issues that
// run at once:
//   order     every issue no cycle holds, in topological order by blockedBy, ties broken by priority, then key;
//   next      the issues to start now, [{ key, branch }], in that order, at most maxParallel less those running;
//   running, done, canceled   keys; parked [{ key, decision }];
//   skipped   [{ key, skipped_blocked_by }]: an issue that waits on a parked or canceled one through issues not done,
//             which it names;
//   blocked   [{ key, reason, on }]: `cycle`, with the keys of its cycle; `waiting`, with the blockers not done, an
//             outside blocker that is not completed or not listed included; or `status`, with its status type, for an
//             issue in triage or started outside the run;
//   ready     the keys that could start, next among them;
//   verdict   `next` when next holds an issue, `wait` when none may start and some run, else `done`.
// A completed issue, or one the ledger records done, is done. A blocker counts as done only then: a canceled one is not.
// Throws when maxParallel is not a whole number above 0.
export function planRun(snapshot, states = new Map(), { maxParallel = SERIAL } = {}) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error(`maxParallel ${quote(maxParallel)} is not a whole number above 0`);
  const byId = new Map(snapshot.issues.map((issue) => [issue.key, issue]));
  const status = new Map(snapshot.issues.map((issue) => [issue.key, states.get(issue.key)?.state ?? TRACKER_STATE[issue.status] ?? 'open']));
  const isDone = (key) => status.get(key) === 'done';
  const cycles = cycleMembers(snapshot.issues, byId, isDone);
  const order = topological(snapshot.issues, byId, cycles, isDone);
  const { ready, blocked, skipped } = sortOpen({ snapshot, byId, status, isDone, cycles, order });
  const keysIn = (wanted) => snapshot.issues.map((issue) => issue.key).filter((key) => status.get(key) === wanted).sort(byKey);
  const running = keysIn('running');
  const slots = Math.max(0, maxParallel - running.length);
  const next = ready.slice(0, slots).map((key) => ({ key, branch: byId.get(key).branch }));
  let verdict = 'done';
  if (running.length) verdict = 'wait';
  if (next.length) verdict = 'next';
  return {
    order,
    next,
    ready,
    running,
    done: keysIn('done'),
    canceled: keysIn('canceled'),
    parked: keysIn('parked').map((key) => ({ key, decision: states.get(key)?.decision ?? null })),
    skipped,
    blocked,
    verdict,
  };
}

// The open issues, those neither done, running, parked, nor canceled, sorted into { ready, blocked, skipped }, each in
// `order`, with an issue no order holds after, by key. The first that fits decides: skipped below a parked or canceled
// issue, in a cycle, in a status the run does not start, waiting on a blocker not done, or else ready.
function sortOpen({ snapshot, byId, status, isDone, cycles, order }) {
  const outside = new Map(snapshot.outside.map((blocker) => [blocker.key, blocker.status]));
  const skippedBy = skippedRoots(snapshot.issues, byId, status);
  const ordered = new Set(order);
  const rest = snapshot.issues.map((issue) => issue.key).filter((key) => !ordered.has(key)).sort(byKey);
  const sorted = { ready: [], blocked: [], skipped: [] };
  for (const key of [...order, ...rest]) {
    if (status.get(key) !== 'open') continue;
    const issue = byId.get(key);
    const waiting = issue.blockedBy.filter((blocker) => (byId.has(blocker) ? !isDone(blocker) : outside.get(blocker) !== 'completed')).sort(byKey);
    if (skippedBy.has(key)) sorted.skipped.push({ key, skipped_blocked_by: [...skippedBy.get(key)].sort(byKey) });
    else if (cycles.has(key)) sorted.blocked.push({ key, reason: 'cycle', on: cycles.get(key) });
    else if (!STARTABLE.has(issue.status)) sorted.blocked.push({ key, reason: 'status', on: [issue.status] });
    else if (waiting.length) sorted.blocked.push({ key, reason: 'waiting', on: waiting });
    else sorted.ready.push(key);
  }
  return sorted;
}

// Each open issue that waits on a parked or canceled one through issues not done, which waits on work this run will not
// do, mapped to the set of those roots. The walk stops at a done issue.
function skippedRoots(issues, byId, status) {
  const dependents = new Map(issues.map((issue) => [issue.key, []]));
  for (const issue of issues) for (const blocker of issue.blockedBy) if (byId.has(blocker)) dependents.get(blocker).push(issue.key);
  const skippedBy = new Map();
  for (const root of issues.map((issue) => issue.key).filter((key) => ['parked', 'canceled'].includes(status.get(key)))) {
    const queue = [...dependents.get(root)];
    const seen = new Set([root]);
    while (queue.length) {
      const key = queue.shift();
      if (seen.has(key)) continue;
      seen.add(key);
      // A done issue's work is there: what waits on it waits on nothing the root holds back.
      if (status.get(key) === 'done') continue;
      if (status.get(key) === 'open') skippedBy.set(key, (skippedBy.get(key) ?? new Set()).add(root));
      queue.push(...dependents.get(key));
    }
  }
  return skippedBy;
}

// The issues each cycle of blockedBy holds: a map from each such key to the sorted keys of its cycle. An issue that
// blocks itself is a cycle of one. Tarjan's strongly connected components, over the edges inside the snapshot between
// issues not done: a done issue waits on nothing, and nothing waits on it.
function cycleMembers(issues, byId, isDone) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const members = new Map();
  let counter = 0;
  const visit = (key) => {
    index.set(key, counter);
    low.set(key, counter);
    counter += 1;
    stack.push(key);
    onStack.add(key);
    for (const blocker of isDone(key) ? [] : byId.get(key).blockedBy) {
      if (!byId.has(blocker) || isDone(blocker)) continue;
      if (!index.has(blocker)) {
        visit(blocker);
        low.set(key, Math.min(low.get(key), low.get(blocker)));
      } else if (onStack.has(blocker)) low.set(key, Math.min(low.get(key), index.get(blocker)));
    }
    if (low.get(key) !== index.get(key)) return;
    const component = [];
    let top;
    do {
      top = stack.pop();
      onStack.delete(top);
      component.push(top);
    } while (top !== key);
    if (component.length > 1 || (!isDone(key) && byId.get(key).blockedBy.includes(key))) {
      const sorted = component.sort(byKey);
      for (const member of component) members.set(member, sorted);
    }
  };
  for (const issue of issues) if (!index.has(issue.key)) visit(issue.key);
  return members;
}

// The keys no cycle holds, in topological order by blockedBy: an issue comes after every blocker in the snapshot that is
// not done, and among the issues free to come next, the higher priority, then the lower key, comes first. An issue that
// waits on a cycle never comes free and is left out.
function topological(issues, byId, cycles, isDone) {
  const pending = new Map();
  const after = new Map(issues.map((issue) => [issue.key, []]));
  for (const issue of issues) {
    if (cycles.has(issue.key)) continue;
    const blockers = isDone(issue.key) ? [] : issue.blockedBy.filter((blocker) => byId.has(blocker) && !isDone(blocker));
    pending.set(issue.key, blockers.length);
    for (const blocker of blockers) after.get(blocker).push(issue.key);
  }
  const free = [...pending].filter(([, count]) => count === 0).map(([key]) => key);
  const order = [];
  const better = (a, b) => rank(byId.get(a).priority) - rank(byId.get(b).priority) || byKey(a, b);
  while (free.length) {
    free.sort(better);
    const key = free.shift();
    order.push(key);
    for (const next of after.get(key)) {
      if (!pending.has(next)) continue;
      pending.set(next, pending.get(next) - 1);
      if (pending.get(next) === 0) free.push(next);
    }
  }
  return order;
}

// The lines `aidrian project next` prints for `plan`: one `next KEY BRANCH` line for each issue to start, or `wait N
// running`, or `done`; then a line for each issue that runs, waits, or is skipped. A halted run's cause comes first, and
// then the end of a pause on a usage or rate limit (lib/project-limit.mjs pauseOf), until which no start runs.
export function nextLines(plan, { halt = null, pause = null } = {}) {
  return [
    ...(halt ? [`halted ${halt}`] : []),
    ...(pause ? [`paused until ${pause.until}`] : []),
    ...verdictLines(plan),
    ...plan.running.map((key) => `running ${key}`),
    ...plan.blocked.map(({ key, reason, on }) => `blocked ${key} ${reason} ${on.join(',')}`),
    ...plan.skipped.map(({ key, skipped_blocked_by: by }) => `skipped ${key} blocked_by ${by.join(',')}`),
  ];
}

function verdictLines(plan) {
  if (plan.verdict === 'next') return plan.next.map(({ key, branch }) => `next ${key} ${branch}`);
  if (plan.verdict === 'wait') return [`wait ${plan.running.length} running`];
  return ['done'];
}

// What summary.md notes of a blocked issue, by its reason, and of a parked one.
const BLOCKED_NOTE = {
  cycle: (on) => `cycle: ${on.join(', ')}`,
  status: (on) => `status ${on[0]}`,
  waiting: (on) => `waiting on ${on.join(', ')}`,
};
const decisionNote = (decision) => (decision ? `decision \`${decision}\`` : 'no decision recorded');
const orNone = (lines) => (lines.length ? lines : ['None.']);

// Each issue's [status, note] in `plan`, as summary.md shows it.
function statusNotes(plan) {
  const notes = new Map();
  for (const key of plan.done) notes.set(key, ['done', '']);
  for (const key of plan.running) notes.set(key, ['running', '']);
  for (const key of plan.canceled) notes.set(key, ['canceled', '']);
  for (const { key, decision } of plan.parked) notes.set(key, ['parked', decisionNote(decision)]);
  for (const { key, skipped_blocked_by: by } of plan.skipped) notes.set(key, ['skipped', `blocked by ${by.join(', ')}`]);
  for (const { key, reason, on } of plan.blocked) notes.set(key, ['blocked', BLOCKED_NOTE[reason](on)]);
  for (const key of plan.ready) notes.set(key, ['ready', '']);
  return notes;
}

// The text of summary.md for run `run` as `found` (readRun) holds it: the repository and driver, then each issue's
// status in plan order, the parked decisions, and the skipped issues. It holds keys, branches, statuses, and decision ids
// alone.
export function summaryText(run, found) {
  const plan = planRun(found.snapshot, found.states);
  const notes = statusNotes(plan);
  const position = new Map(plan.order.map((key, i) => [key, i]));
  const keys = found.snapshot.issues.map((issue) => issue.key)
    .sort((a, b) => (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity) || byKey(a, b));
  const branchOf = new Map(found.snapshot.issues.map((issue) => [issue.key, issue.branch]));
  const counts = ['done', 'running', 'parked', 'skipped', 'blocked', 'canceled', 'ready']
    .map((word) => [word, keys.filter((key) => notes.get(key)[0] === word).length])
    .filter(([, count]) => count).map(([word, count]) => `${count} ${word}`);
  const upNext = plan.verdict === 'next' ? plan.next.map(({ key }) => key).join(', ') : plan.verdict;
  const { repository: repo } = found.init;
  return [
    `# Project run ${run}`,
    '',
    `- Repository: ${repo.host}/${repo.owner}/${repo.name}`,
    `- Driver session: ${found.init.session}`,
    `- Started: ${found.init.at}`,
    `- Issues: ${keys.length}, ${counts.join(', ')}`,
    `- Next: ${upNext}`,
    '',
    '| Issue | Branch | Status | Note |',
    '| --- | --- | --- | --- |',
    ...keys.map((key) => `| ${key} | \`${branchOf.get(key)}\` | ${notes.get(key)[0]} | ${notes.get(key)[1]} |`),
    '',
    '## Parked decisions',
    '',
    ...orNone(plan.parked.map(({ key, decision }) => `- ${key}: ${decisionNote(decision)}`)),
    '',
    '## Skipped',
    '',
    ...orNone(plan.skipped.map(({ key, skipped_blocked_by: by }) => `- ${key}: blocked by ${by.join(', ')}`)),
    '',
  ].join('\n');
}

// Writes summary.md of run `run` from its ledger, through a temporary file, and returns { text, file } or { problem }.
export function writeSummary(state, run) {
  const found = readRun(state, run);
  if (found.problem) return { problem: found.problem };
  const text = summaryText(run, found);
  const file = path.join(runFolder(state, run), 'summary.md');
  const temporary = path.join(runFolder(state, run), `.summary.md.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  return { text, file };
}
