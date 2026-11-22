// What an issue's session of a project run records of its work, and how the run takes it in (lib/project-run-gate.mjs):
// the result's checks and the text it keeps (validateResult, cleanText), the forge's word on a merge (mergeProblem), and
// the ledger rows each status leads to. A session of a confined host (lib/project-start.mjs) hands its result over in
// its attempt's drop folder (writeDrop), which it may write, and the driver's `wait` takes it in (ingestDrops): the
// file is read as untrusted, without following a link, and every field is checked again; a merged or open pull request
// must be the issue's own on the forge. Anything else ends the attempt `bad_result`.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { cleanText, maskSecrets } from './clean-text.mjs';
import { changeNotFound } from './forges/index.mjs';
import { appendToRun, runFolder } from './project-run.mjs';
import { ISSUE_ATTEMPTS, latestStart, spentAttempts } from './project-run-guard.mjs';
import { defaultBranch } from './pr-auto-merge.mjs';
import { hostOf, repoName } from './remotes.mjs';
import { isObject } from './fs.mjs';
import { safely } from './session-start-gate.mjs';

// What a session records of its issue, and how each decision it parks on is classed. `environment` says the session's
// own environment kept it from the work, such as its sandbox, its forge sign-in, or its host: the run halts on its stop
// (its result row's `halt`, project-run.mjs haltOf), and the issue goes on as after `failed`.
export const RESULT_STATUSES = Object.freeze(['merged', 'pr_open', 'parked', 'blocked', 'failed', 'environment']);
export const DECISION_CLASSES = Object.freeze(['product', 'ux', 'architecture', 'security', 'scope', 'other']);
// The largest result file read, the most decisions and options it keeps, and each text field's length.
export const RESULT_CAP = 64 * 1024;
const MAX_DECISIONS = 10;
const MAX_OPTIONS = 6;
export const CAPS = Object.freeze({ question: 300, option: 120, stop: 300 });
// The file a session hands its result over in, in its attempt's drop folder.
export const DROP_FILE = 'result.json';

const iso = (now) => new Date(now).toISOString();
const quote = (value) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
};
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

// What an issue becomes after an attempt that ended without a result it may be merged on, with `spent` the attempts of it
// that count (project-run-guard.mjs spentAttempts), that one included: open again while attempts remain, else parked on
// the decision `attempts`.
export const afterFailure = (key, spent) => (spent < ISSUE_ATTEMPTS ? { event: 'issue', key, state: 'open' } : { event: 'issue', key, state: 'parked', decision: 'attempts' });

// cleanText lives in lib/clean-text.mjs, which the tracker hook loads with no forge import; it is re-exported here.
export { cleanText };

// The result a session wrote, `value`: { result, problems }, where `result` is { status, pr, decisions, stop } with only
// those fields, each checked and its text cleaned (cleanText), or null when `problems` lists any.
export function validateResult(value) {
  if (!isObject(value)) return { result: null, problems: ['the result is not a JSON object'] };
  const problems = [];
  if (!RESULT_STATUSES.includes(value.status)) problems.push(`"status" ${quote(value.status)} is not one of ${RESULT_STATUSES.join(', ')}`);
  const pr = value.pr ?? null;
  if (pr !== null && (!Number.isInteger(pr) || pr < 1 || pr > 1e9)) problems.push(`"pr" ${quote(value.pr)} is not a pull request number or null`);
  const given = value.decisions ?? [];
  const decisions = [];
  if (!Array.isArray(given) || given.length > MAX_DECISIONS) problems.push(`"decisions" is not a list of at most ${MAX_DECISIONS}`);
  else {
    given.forEach((decision, i) => {
      const where = `decisions[${i}]`;
      if (!isObject(decision)) return problems.push(`${where} is not an object`);
      const question = cleanText(decision.question, CAPS.question);
      const options = Array.isArray(decision.options) && decision.options.length >= 2 && decision.options.length <= MAX_OPTIONS ? decision.options.map((option) => cleanText(option, CAPS.option)) : null;
      if (!question) problems.push(`${where}.question is no text`);
      if (!options || options.some((option) => !option)) problems.push(`${where}.options is not a list of 2 to ${MAX_OPTIONS} texts`);
      if (!Number.isInteger(decision.recommended) || !options || decision.recommended < 0 || decision.recommended >= options.length) problems.push(`${where}.recommended is not the index of one of its options`);
      if (!DECISION_CLASSES.includes(decision.class)) problems.push(`${where}.class ${quote(decision.class)} is not one of ${DECISION_CLASSES.join(', ')}`);
      decisions.push({ question, options, recommended: decision.recommended, class: decision.class });
      return null;
    });
  }
  if (value.status === 'parked' && Array.isArray(given) && given.length === 0) problems.push('a parked result names the decisions it waits on');
  if (value.status === 'environment' && (typeof value.stop !== 'string' || !cleanText(value.stop, CAPS.stop))) problems.push('an environment result names in "stop" what failed');
  const stop = value.stop === undefined || value.stop === null || typeof value.stop !== 'string' ? null : cleanText(maskSecrets(value.stop), CAPS.stop);
  if (value.stop !== undefined && value.stop !== null && typeof value.stop !== 'string') problems.push('"stop" is not text or null');
  return problems.length ? { result: null, problems } : { result: { status: value.status, pr, decisions, stop }, problems };
}

// Why the forge does not show pull request `pr` merged as the run's work on issue `key`, or null: it must be in the
// repository init pinned, from its own branch `branch`, into the default branch, and merged after the attempt's start,
// `since`. Every forge call names the pinned repository. A forge that cannot answer gives { retry: true, why }, which a
// caller reads again later, or takes as a refusal.
export function mergeProblem({ forge, repository, pr, branch, since }) {
  if (!Number.isInteger(pr)) return 'the result names no pull request';
  const named = `${repository.owner}/${repository.name}`;
  let view;
  let main;
  try {
    view = forge.change(String(pr), 'state,mergedAt,headRefName,baseRefName,url,isCrossRepository', { repo: `${repository.host}/${named}` });
    main = defaultBranch(forge, { repo: named, host: repository.host });
  } catch (error) {
    return { retry: true, why: `the forge could not describe pull request #${pr} (${String(error.message).split('\n')[0]})` };
  }
  if (view?.state !== 'MERGED') return `the forge says pull request #${pr} is ${typeof view?.state === 'string' ? view.state.toLowerCase() : 'not merged'}`;
  if (repoName(view.url) !== named.toLowerCase() || hostOf(view.url)?.toLowerCase() !== repository.host.toLowerCase()) return `pull request #${pr} is not in ${repository.host}/${named}`;
  if (view.isCrossRepository !== false) return `pull request #${pr} comes from another repository`;
  if (view.headRefName !== branch) return `pull request #${pr} is from the branch ${quote(view.headRefName)}, not the issue's ${branch}`;
  if (view.baseRefName !== main) return `pull request #${pr} merged into ${quote(view.baseRefName)}, not the default branch ${main}`;
  const merged = typeof view.mergedAt === 'string' ? Date.parse(view.mergedAt) : Number.NaN;
  if (!(merged > since)) return `pull request #${pr} merged before this attempt started`;
  return null;
}

// What the ledger records of issue `key` after attempt `attempt` ended with `status`: merged is done; parked, pr_open,
// and blocked park it on a decision named for the status; failed opens it again while attempts remain, of the `spent`
// that count (afterFailure); environment does the same, with the run halted by its result row (haltCause).
export function afterResult(key, attempt, status, spent = attempt) {
  if (status === 'merged') return { event: 'issue', key, state: 'done' };
  if (status === 'failed' || status === 'environment') return afterFailure(key, spent);
  return { event: 'issue', key, state: 'parked', decision: { parked: `decision-${attempt}`, pr_open: 'pr-open', blocked: 'blocked' }[status] };
}


// The halt an environment result of attempt `attempt` of issue `key` carries in its own result row, so one append records
// both: the session's `stop` as the cause.
export const haltCause = ({ key, attempt, stop }) => cleanText(`${key} attempt ${attempt} found its environment broken: ${stop}`, CAPS.stop);

// Writes `value` to `results/<key>.json` in the run's folder, owner-only, through a temporary file.
export function writeResultFile(state, run, key, value) {
  const folder = path.join(runFolder(state, run), 'results');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const target = path.join(folder, `${key}.json`);
  const temporary = path.join(folder, `.${key}.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, target);
}


// Why the folder `dir` is not a plain folder of this user, or null: no link, no other kind of file, no other owner.
export function plainFolderProblem(dir) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    return `${dir} cannot be read (${error.code ?? 'no code'})`;
  }
  const uid = processUid();
  if (stat.isSymbolicLink() || !stat.isDirectory()) return `${dir} is not a plain folder`;
  if (Number.isInteger(uid) && stat.uid !== uid) return `${dir} belongs to another user`;
  return null;
}

// Writes `value`, the checked result of an issue's session, to `result.json` in its attempt's drop folder `drop`,
// owner-only, through a temporary file: null, or why it could not.
export function writeDrop(drop, value) {
  const folder = plainFolderProblem(drop);
  if (folder) return folder;
  const temporary = path.join(drop, `.${DROP_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path.join(drop, DROP_FILE));
    return null;
  } catch (error) {
    return `the drop folder ${drop} cannot be written (${error.code ?? 'no code'})`;
  }
}

// The result in the drop folder `drop`: { missing: true } when there is none yet, { value } when it is a regular file of
// this user with one link, under RESULT_CAP, holding JSON, or { problem }. Opened without following a link, and checked
// on the open file.
export function readDrop(drop) {
  let fd;
  try {
    fd = openSync(path.join(drop, DROP_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return error.code === 'ENOENT' ? { missing: true } : { problem: `the drop's result cannot be opened as a file (${error.code ?? 'no code'})` };
  }
  try {
    const stat = fstatSync(fd);
    const uid = processUid();
    if (!stat.isFile()) return { problem: 'the drop\'s result is not a regular file' };
    if (stat.nlink !== 1) return { problem: `the drop's result has ${stat.nlink} links` };
    if (Number.isInteger(uid) && stat.uid !== uid) return { problem: 'the drop\'s result belongs to another user' };
    if (stat.size > RESULT_CAP) return { problem: `the drop's result is over ${RESULT_CAP} bytes` };
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return { value: JSON.parse(buffer.subarray(0, read).toString('utf8')) };
  } catch {
    return { problem: 'the drop\'s result is not JSON' };
  } finally {
    closeSync(fd);
  }
}

// Why the forge does not show the pull request of a handed-over `result` as the issue's own work, null when it does,
// or { retry } when the forge cannot answer now. Only merged and pr_open name one: it must be in the pinned
// `repository`, from the issue's `branch`; an open one's head must be the branch's head on the forge, and a merged one
// must pass mergeProblem. A forge that answers it has no such pull request (forges/index.mjs changeNotFound) has
// answered: that is final, never a retry.
function droppedPullProblem({ forge, repository, result, branch, since }) {
  if (!['merged', 'pr_open'].includes(result.status)) return null;
  if (!Number.isInteger(result.pr)) return 'the result names no pull request';
  const named = `${repository.owner}/${repository.name}`;
  let view;
  try {
    view = forge.change(String(result.pr), 'state,headRefName,headRefOid,url,isCrossRepository', { repo: `${repository.host}/${named}` });
  } catch (error) {
    return changeNotFound(error) ? `the forge has no pull request #${result.pr} in ${repository.host}/${named}` : { retry: true };
  }
  if (repoName(view?.url) !== named.toLowerCase() || hostOf(view.url)?.toLowerCase() !== repository.host.toLowerCase()) return `pull request #${result.pr} is not in ${repository.host}/${named}`;
  if (view.isCrossRepository !== false || view.headRefName !== branch) return `pull request #${result.pr} is not from the issue's branch ${branch}`;
  if (result.status === 'merged') return mergeProblem({ forge, repository, pr: result.pr, branch, since });
  let head;
  try {
    head = forge.branchHead(named, branch, { host: repository.host });
  } catch {
    return { retry: true };
  }
  return typeof view.headRefOid === 'string' && view.headRefOid === head ? null : `pull request #${result.pr}'s head is not the head of ${branch} on the forge`;
}

// What the drop of the running issue `key`'s latest start holds: { rows, line } to record, or null while there is none,
// or the forge cannot answer.
function dropRows({ run, key, start, spent, branch, forge, repository, now }) {
  const read = readDrop(start.drop);
  if (read.missing) return null;
  const at = iso(now);
  const bad = (why) => ({ rows: [{ event: 'ended', key, attempt: start.attempt, reason: 'bad_result', why: cleanText(why, CAPS.stop, { domains: false }), at }, { ...afterFailure(key, spent), at }], line: 'bad_result' });
  if (read.problem) return bad(read.problem);
  const { value } = read;
  if (value?.run !== run || value?.key !== key || value?.attempt !== start.attempt) return bad('the drop\'s result names another run, issue, or attempt');
  const checked = validateResult(value);
  if (!checked.result) return bad(checked.problems[0]);
  const pull = droppedPullProblem({ forge, repository, result: checked.result, branch, since: Date.parse(start.at) });
  if (pull?.retry) return null;
  if (pull) return bad(pull);
  const { result } = checked;
  const next = afterResult(key, start.attempt, result.status, spent);
  return {
    rows: [{
      event: 'result', key, attempt: start.attempt, session: start.child, via: 'drop', status: result.status, pr: result.pr, verified: result.status === 'merged',
      ...(result.status === 'environment' ? { halt: haltCause({ key, attempt: start.attempt, stop: result.stop }) } : {}), at,
    }, { ...next, at }],
    line: `${result.status} -> ${next.state}${next.decision ? ` ${next.decision}` : ''}`,
    kept: { run, key, attempt: start.attempt, session: start.child, at, via: 'drop', ...result },
  };
}

// Takes in the results the sessions of the running issues of `found` handed over in their drop folders, as the driver's
// `wait` does before it reads how sessions ended: each recorded, with `results/<issue>.json`, while its issue still runs
// that attempt. Returns the lines: `result KEY STATUS -> STATE`, or `ended KEY bad_result -> STATE`.
export function ingestDrops({ state, run, found, forge, now }) {
  const lines = [];
  for (const [key, { state: issueState }] of found.states) {
    if (issueState !== 'running') continue;
    const start = latestStart(found, key);
    if (!start?.drop) continue;
    const { branch } = found.snapshot.issues.find((issue) => issue.key === key);
    const taken = dropRows({ run, key, start, spent: spentAttempts(found, key), branch, forge, repository: found.init.repository, now });
    if (!taken) continue;
    const written = safely(() => appendToRun(state, run, (fresh) => (fresh.states.get(key)?.state === 'running' && latestStart(fresh, key)?.attempt === start.attempt
      ? { rows: taken.rows } : { rows: [] })));
    if (!written?.rows?.length) continue;
    if (taken.kept) safely(() => writeResultFile(state, run, key, taken.kept));
    const after = taken.rows[1];
    const decided = after.decision ? ` ${after.decision}` : '';
    lines.push(taken.kept ? `result ${key} ${taken.line}` : `ended ${key} bad_result -> ${after.state}${decided}`);
  }
  return lines;
}
