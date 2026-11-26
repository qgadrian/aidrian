// What an issue's session of a project run records of its work, and how the run takes it in (lib/project-run-gate.mjs):
// the result's checks and the text it keeps (validateResult, cleanText), the forge's word on a merge (mergeProblem), and
// the ledger rows each status leads to. A session of a confined host (lib/project-start.mjs) hands its result over in
// its attempt's drop folder (writeDrop), which it may write, and the driver's `wait` takes it in (ingestDrops): the
// file is read as untrusted, without following a link, and every field is checked again; a merged or open pull request
// must be the issue's own on the forge. Anything else ends the attempt `bad_result`. The drop's `tree`, the word the
// session's `result` read of its clone (lib/project-tree.mjs), goes into the result row alone, for the sweep.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { cleanText, maskSecrets } from './clean-text.mjs';
import { changeNotFound } from './forges/index.mjs';
import { appendToRun, HOST_DENIED_MERGE, issueBranch, runFolder, SHA } from './project-run.mjs';
import { ATTEMPT_CEILING, ISSUE_ATTEMPTS, latestStart, spentAttempts } from './project-run-guard.mjs';
import { ENVIRONMENT_CAUSES } from './project-recheck.mjs';
import { defaultBranch } from './pr-auto-merge.mjs';
import { hostOf, repoName } from './remotes.mjs';
import { isObject } from './fs.mjs';
import { safely } from './session-start-gate.mjs';
import { TREE_WORDS } from './project-tree.mjs';

// What a session records of its issue, and how each decision it parks on is classed. `environment` says the session's
// own environment kept it from the work, such as its sandbox, its forge sign-in, or its host: the run halts on its stop
// (its result row's `halt`, project-run.mjs haltOf), and the issue goes on as after `failed`. It names its `cause`, one of
// ENVIRONMENT_CAUSES, which alone decides the checks the driver's re-check runs (project-recheck.mjs).
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
// A value a problem names, as one short scalar: a string masked (maskSecrets) and only then cut at 40, so no part of a
// token comes back, a number or a boolean as it is, null as `null`, and anything else as a fixed word. No value is
// serialized whole: a session's file may nest one too deep for JSON.stringify, which would throw on every read of it.
const QUOTE_WORDS = Object.freeze({ object: 'an object', undefined: 'nothing' });
const quote = (value) => {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) return 'a list';
  if (typeof value !== 'string') return QUOTE_WORDS[typeof value] ?? 'a value';
  const text = JSON.stringify(maskSecrets(value));
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
};
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

// What an issue becomes after its attempt number `attempt` ended without a result it may be merged on, with `spent` the
// attempts of it that count (project-run-guard.mjs spentAttempts), that one included: open again while attempts remain
// and the next attempt's number stays within ATTEMPT_CEILING, else parked on the decision `attempts`. Attempts a limit
// ended take numbers that count toward no cap, so the numbers can run out first; parking then reports the issue, where
// open would leave it waiting on a start the gate refuses.
export const afterFailure = (key, spent, attempt) => (spent < ISSUE_ATTEMPTS && attempt < ATTEMPT_CEILING ? { event: 'issue', key, state: 'open' } : { event: 'issue', key, state: 'parked', decision: 'attempts' });

// cleanText lives in lib/clean-text.mjs, which the tracker hook loads with no forge import; it is re-exported here.
export { cleanText };

// The result a session wrote, `value`: { result, problems }, where `result` is { status, pr, decisions, stop } with only
// those fields, `cause` on an `environment` one, which must carry one of ENVIRONMENT_CAUSES, and `stopCause` on a
// `pr_open` one that carries it, each checked and its text cleaned (cleanText), or null when `problems` lists any.
// `stopCause` is for the run's report alone: it lifts no check of the result. With `causeless`, an environment result
// with no `cause` passes, as one an older plugin wrote does when a run that spans an upgrade reads it again (the driver's
// take-in and the report); its halt then names no cause, so it waits on a person (project-recheck.mjs). An unlisted
// cause, or one on another status, is refused either way.
export function validateResult(value, { causeless = false } = {}) {
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
  // The message quotes nothing of the value: a token in it would reach the ended row, and a deeply nested one overflows
  // JSON.stringify, which would stop every later wait on the same drop.
  const { cause, stopCause } = value;
  if (value.status === 'environment' && cause === undefined) {
    if (!causeless) problems.push(`an environment result names its "cause", one of ${ENVIRONMENT_CAUSES.join(', ')}`);
  } else if (value.status === 'environment' && !ENVIRONMENT_CAUSES.includes(cause)) problems.push(`"cause" ${quote(cause)} is not one of ${ENVIRONMENT_CAUSES.join(', ')}`);
  else if (value.status !== 'environment' && cause !== undefined) problems.push('"cause" is for an environment result alone');
  if (stopCause !== undefined && stopCause !== HOST_DENIED_MERGE) problems.push(`"stopCause" is not "${HOST_DENIED_MERGE}"; leave it out for any other stop`);
  else if (stopCause !== undefined && value.status !== 'pr_open') problems.push('"stopCause" is for a pr_open result alone');
  if (problems.length) return { result: null, problems };
  return { result: { status: value.status, pr, decisions, stop, ...(cause === undefined ? {} : { cause }), ...(stopCause === undefined ? {} : { stopCause }) }, problems };
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
    // A forge that answers it has no such pull request has answered: that is final, never a retry.
    if (view === undefined && changeNotFound(error)) return `the forge has no pull request #${pr} in ${repository.host}/${named}`;
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

// Whether pull request `pr`, which an earlier run's attempt left open on the issue's `branch` (a `pr_open` result), has
// merged since as that attempt's work, for init to take in (project-run.mjs resumedIssues): null while the forge shows it
// open or closed, or has no such pull request, { merged: true } once it merged and passes mergeProblem, as `wait`
// checks a pr_open result that merged (droppedPullProblem), against the attempt's start `since`; or { problem } when it
// merged and fails that check, or the forge cannot answer now, since the issue may then be neither resumed on that
// branch nor counted done.
export function landedPull({ forge, repository, pr, branch, since }) {
  const named = `${repository.owner}/${repository.name}`;
  let view;
  try {
    view = forge.change(String(pr), 'state', { repo: `${repository.host}/${named}` });
  } catch (error) {
    return changeNotFound(error) ? null : { problem: `the forge could not say whether pull request #${pr} merged (${String(error.message).split('\n')[0]}); check again` };
  }
  if (view?.state !== 'MERGED') return null;
  const problem = mergeProblem({ forge, repository, pr, branch, since });
  if (problem === null) return { merged: true };
  return { problem: typeof problem === 'string' ? problem : `${problem.why}; check again` };
}

// What the ledger records of issue `key` after attempt `attempt` ended with `status`: merged is done; parked, pr_open,
// and blocked park it on a decision named for the status; failed opens it again while attempts remain, of the `spent`
// that count (afterFailure); environment does the same, with the run halted by its result row (haltCause).
export function afterResult(key, attempt, status, spent = attempt) {
  if (status === 'merged') return { event: 'issue', key, state: 'done' };
  if (status === 'failed' || status === 'environment') return afterFailure(key, spent, attempt);
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
// An open one's head, once checked, goes in `verified.head`, the commit the result row records (dropRows). A pr_open
// result whose pull request the forge shows merged by now is checked as a merged one is, and passing sets
// `verified.merged`: the work landed before the driver took the result in.
function droppedPullProblem({ forge, repository, result, branch, since, verified = {} }) {
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
  const merged = () => {
    const problem = mergeProblem({ forge, repository, pr: result.pr, branch, since });
    if (!problem) verified.merged = true;
    return problem;
  };
  if (view.state === 'MERGED') return merged();
  // A closed pull request still parks the issue (project-stops.mjs), but no later run goes on from its branch.
  if (view.state === 'CLOSED') {
    verified.head = null;
    return null;
  }
  let head;
  try {
    head = forge.branchHead(named, branch, { host: repository.host });
  } catch {
    return { retry: true };
  }
  if (typeof view.headRefOid !== 'string' || view.headRefOid !== head) return `pull request #${result.pr}'s head is not the head of ${branch} on the forge`;
  // Read the state once more before the issue parks: a pull request that merged since the first read is taken as merged,
  // one that closed keeps no head, as above, and a forge that cannot answer now is read again later. A merge after this
  // read still parks the issue as pr-open.
  let again;
  try {
    again = forge.change(String(result.pr), 'state', { repo: `${repository.host}/${named}` });
  } catch (error) {
    return changeNotFound(error) ? `the forge has no pull request #${result.pr} in ${repository.host}/${named}` : { retry: true };
  }
  if (again?.state === 'MERGED') return merged();
  verified.head = again?.state === 'CLOSED' ? null : head;
  return null;
}

// The commit the forge shows the branch `branch` of the pinned `repository` at, or null when it names none or cannot answer.
function forgeHead({ forge, repository, branch }) {
  try {
    const sha = forge.branchHead(`${repository.owner}/${repository.name}`, branch, { host: repository.host });
    return typeof sha === 'string' && SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// The head commit of pull request `pr` when the forge shows it open, in the pinned `repository`, from its own `branch`,
// else null, as when it is closed, from another branch, or the forge cannot answer: the head a run resumes an issue from
// when the earlier run that parked it ran before result rows recorded one (project-run.mjs resumedIssues). It trusts the
// pull request's head as the forge shows it now.
export function openPullHead({ forge, repository, pr, branch }) {
  if (!Number.isInteger(pr) || pr < 1) return null;
  const named = `${repository.owner}/${repository.name}`;
  let view;
  try {
    view = forge.change(String(pr), 'state,headRefName,headRefOid,url,isCrossRepository', { repo: `${repository.host}/${named}` });
  } catch {
    return null;
  }
  const inRepository = repoName(view?.url) === named.toLowerCase() && hostOf(view.url)?.toLowerCase() === repository.host.toLowerCase();
  const ok = inRepository && view.state === 'OPEN' && view.isCrossRepository === false && view.headRefName === branch && typeof view.headRefOid === 'string' && SHA.test(view.headRefOid);
  return ok ? view.headRefOid : null;
}

// What the drop of the running issue `key`'s latest start holds: { rows, line } to record, or null while there is none,
// or the forge cannot answer. A result that parks the issue records `head`: for pr_open, the head its pull request's
// check found the branch at; else the commit the forge shows the branch at then, or null when it shows none. It is the
// work this run leaves there, which a later run that resumes the issue checks the branch against (project-run.mjs
// resumedIssues, project-start.mjs prepareAttempt).
function dropRows({ run, key, start, spent, branch, forge, repository, now }) {
  const read = readDrop(start.drop);
  if (read.missing) return null;
  const at = iso(now);
  const bad = (why) => ({ rows: [{ event: 'ended', key, attempt: start.attempt, reason: 'bad_result', why: cleanText(why, CAPS.stop, { domains: false }), at }, { ...afterFailure(key, spent, start.attempt), at }], line: 'bad_result' });
  if (read.problem) return bad(read.problem);
  const { value } = read;
  if (value?.run !== run || value?.key !== key || value?.attempt !== start.attempt) return bad('the drop\'s result names another run, issue, or attempt');
  // A session of an older plugin hands over no cause: its halt then waits on a person.
  const checked = validateResult(value, { causeless: true });
  if (!checked.result) return bad(checked.problems[0]);
  const verified = {};
  const pull = droppedPullProblem({ forge, repository, result: checked.result, branch, since: Date.parse(start.at), verified });
  if (pull?.retry) return null;
  if (pull) return bad(pull);
  // A pr_open result whose pull request merged in the meantime is taken as merged, with the status the session reported,
  // and without its stopCause: nothing is left to merge.
  const { stopCause: _moot, ...fields } = checked.result;
  const result = verified.merged ? { ...fields, status: 'merged', reported: fields.status } : checked.result;
  const stopped = result.stopCause === undefined ? {} : { stopCause: result.stopCause };
  const next = afterResult(key, start.attempt, result.status, spent);
  // The head the pull request's check read, when one did, never a second read that could differ or fail.
  const head = next.state === 'parked' ? { head: Object.hasOwn(verified, 'head') ? verified.head : forgeHead({ forge, repository, branch }) } : {};
  // The tree the session's `result` read (project-tree.mjs treeOf), only as one of its words: the sweep alone reads it.
  const tree = TREE_WORDS.includes(value.tree) ? { tree: value.tree } : {};
  return {
    rows: [{
      event: 'result', key, attempt: start.attempt, session: start.child, via: 'drop', status: result.status, pr: result.pr, verified: result.status === 'merged', ...stopped, ...head, ...tree,
      ...(result.status === 'environment' ? { cause: result.cause, halt: haltCause({ key, attempt: start.attempt, stop: result.stop }) } : {}), at,
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
    const branch = issueBranch(found, key);
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
