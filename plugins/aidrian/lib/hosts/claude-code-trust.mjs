// Claude Code's workspace trust for a project run. A background start in a folder the host has not trusted exits 1 with
// `Workspace not trusted` and starts nothing (docs/providers/claude-code.md). The host's record is `.claude.json` in
// CLAUDE_CONFIG_DIR when set, else in the home folder, whose `projects` map a folder to `hasTrustDialogAccepted`. Trust
// in a folder covers a plain folder below it, but inside a git repository the host looks trust up at the repository's
// own root alone (2.1.330, checked live), so an attempt's clone, a repository of its own, never inherits the runs
// folder's trust. The Human trusts the runs folder once, which `aidrian project preflight` checks (trustProblem), and
// each start records that trust for its own clone (recordTrust), from the record's current consent every time. The
// file is the host's own and undocumented, so a file that is missing or cannot be read leaves the preflight check
// unknown, never a blocker.

import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { pauseSync, resolvedPath } from '../fs.mjs';

// The folder beside the record where a new record is staged before it is renamed over the old one. It is one of the
// sandbox's read barriers (claude-code-sandbox.mjs CREDENTIAL_PATHS, CONFIG_CREDENTIALS), as the record is, so a
// confined session started with these settings does not read the copy; one started before the barrier existed could.
export const TRUST_STAGE = '.claude-trust-stage';
// How many times a record that changed while it was being updated is read again.
const TRIES = 3;
// The file in TRUST_STAGE that one start holds while it updates the record, so two starts never undo each other's
// update. It holds the holder's process id and a token, and only its holder removes it. A start waits up to LOCK_WAIT
// for it; it is never taken over, since a holder keeps it for milliseconds and two waiters taking over at once could
// both enter, so one a dead process left is named for the Human to remove.
const LOCK = 'lock';
const LOCK_WAIT = 10_000;

// The host's record of trusted folders, for `env` and `home`.
export const trustFile = (env, home) => path.join(env.CLAUDE_CONFIG_DIR || home || env.HOME || homedir(), '.claude.json');

// How to give the consent: the runs folder may not exist before the run's init makes it.
const quoted = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const consentStep = (folder) => `create it with \`mkdir -p ${quoted(folder)}\` if it does not exist yet, then run \`claude\` in it once and accept its trust question, which covers every attempt's clone below it`;

// Whether the record's `projects` trust `folder` or a folder above it, by its plain path and by its real one.
function consented(projects, folder) {
  const trusted = (dir) => projects?.[dir]?.hasTrustDialogAccepted === true;
  for (const start of new Set([path.resolve(folder), resolvedPath(folder) ?? path.resolve(folder)])) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (trusted(dir)) return true;
      if (path.dirname(dir) === dir) break;
    }
  }
  return false;
}

// { record, text } read from `file`, or { problem } naming why it cannot be.
function readRecord(file) {
  try {
    const text = readFileSync(file, 'utf8');
    const record = JSON.parse(text);
    return record && typeof record === 'object' && !Array.isArray(record) ? { record, text } : { problem: 'not an object' };
  } catch (error) {
    return { problem: error.code ?? 'not JSON' };
  }
}

// { problem } when the record says no folder from `folder` up is trusted, { note } when the record cannot be read, or
// null when `folder` or a folder above it is trusted.
export function trustProblem({ folder, env = process.env, home }) {
  const file = trustFile(env, home);
  const read = readRecord(file);
  if (read.problem) return { note: `the host's trust record ${file} cannot be read (${read.problem}), so whether it trusts ${folder} is unknown; a start there refuses with "Workspace not trusted" if it does not` };
  if (consented(read.record.projects, folder)) return null;
  return { problem: `the host does not trust ${folder} or a folder above it, so every start there exits with "Workspace not trusted"; ${consentStep(folder)}` };
}

// Records the host's trust for `work`, an attempt's clone, when the record trusts `runs`, the runs folder, or a folder
// above it, as preflight checks it: { problem } when it cannot, else null. The consent is read again on every start, so
// an entry an earlier start left for the same path never stands in for it. The consent and the update come from one
// read of the record; the new record is staged in TRUST_STAGE and renamed over the old one only when the file still
// holds what was read, which narrows, but cannot close, the race with a host session that saves the record in the
// instant between that check and the rename: the host takes no lock a writer outside it could share. A record seen to
// change is read again, up to TRIES times.
export function recordTrust({ work, runs, env = process.env, home, lockWait = LOCK_WAIT }) {
  const file = trustFile(env, home);
  const unheld = updateRecord({ file, work, runs, dryRun: true });
  if (unheld !== 'write') return unheld;
  const stage = path.join(path.dirname(file), TRUST_STAGE);
  const updateFailed = (why) => ({ problem: `the host's trust record ${file} could not be updated (${why}), so the attempt's clone is not trusted` });
  const held = holdStage(stage, lockWait);
  if (held.problem) return updateFailed(held.problem);
  const answer = updateRecord({ file, stage, work, runs });
  const released = held.release();
  return released && (answer === null) ? updateFailed(released) : answer;
}

// recordTrust's update, with the stage held: null, or { problem }. With `dryRun`, it writes nothing and answers 'write'
// where it would write, so a clone trusted already needs no stage.
function updateRecord({ file, stage, work, runs, dryRun = false }) {
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const read = readRecord(file);
    if (read.problem) return { problem: `the host's trust record ${file} cannot be read (${read.problem}), so the attempt's clone cannot be trusted` };
    const projects = read.record.projects && typeof read.record.projects === 'object' ? read.record.projects : {};
    if (!consented(projects, runs)) return { problem: `the host trusts neither the runs folder ${runs} nor a folder above it, and the attempt's clone, a repository of its own, inherits no trust` };
    if (projects[work]?.hasTrustDialogAccepted === true) return null;
    if (dryRun) return 'write';
    const next = { ...read.record, projects: { ...projects, [work]: { ...(projects[work] ?? {}), hasTrustDialogAccepted: true } } };
    const written = replaceIfUnchanged(file, stage, read.text, `${JSON.stringify(next, null, 2)}\n`);
    if (written !== 'changed') return written;
  }
  return { problem: `the host's trust record ${file} kept changing while the start updated it, so the attempt's clone is not trusted` };
}

// The stage, made a real folder, held through its LOCK file: { release } or { problem }. A stage that is a link or a
// file is refused, so the copy never lands outside the read barrier. `release()` removes the lock only while it still
// holds this start's token, and answers null or why it could not.
function holdStage(stage, wait) {
  try {
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    if (!lstatSync(stage).isDirectory()) return { problem: `${stage} is not a folder` };
  } catch (error) {
    return { problem: error.code ?? 'no code' };
  }
  const lock = path.join(stage, LOCK);
  const token = `${process.pid} ${Date.now()} ${Math.random()}`;
  for (const end = Date.now() + wait; ;) {
    try {
      writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
      return { release: () => releaseLock(lock, token) };
    } catch (error) {
      if (error.code !== 'EEXIST') return { problem: error.code ?? 'no code' };
    }
    if (Date.now() > end) return { problem: lockProblem(lock, wait) };
    pauseSync(50);
  }
}

function releaseLock(lock, token) {
  try {
    if (readFileSync(lock, 'utf8') === token) rmSync(lock);
    return null;
  } catch (error) {
    return `its lock ${lock} could not be removed (${error.code ?? 'no code'})`;
  }
}

// Why the lock stayed held: a live start's, or one a dead process left.
function lockProblem(lock, wait) {
  let pid = null;
  try {
    pid = Number.parseInt(readFileSync(lock, 'utf8'), 10);
  } catch {
    // Released between the last try and this read: the next start takes it.
  }
  let alive = false;
  try {
    alive = Number.isInteger(pid) && pid > 0 && process.kill(pid, 0);
  } catch (error) {
    alive = error.code === 'EPERM';
  }
  return alive ? `another start held ${lock} for over ${wait / 1000} seconds` : `${lock} was left by a start that ended while it held it; remove that file, then start again`;
}

// Writes `text` over `file` when it still holds `before`: null when written, 'changed' when it no longer holds it, or
// { problem }. The copy is opened only by this call (`wx`), owner-only, and checked to lie in the real stage folder
// once made; only a copy this call opened is removed, and a failed removal never hides the answer.
function replaceIfUnchanged(file, stage, before, text) {
  const temp = path.join(stage, `record-${process.pid}-${Date.now()}.json`);
  const failed = (code) => ({ problem: `the host's trust record ${file} could not be written (${code}), so the attempt's clone is not trusted` });
  const made = { open: false };
  let answer;
  try {
    answer = stageAndRename({ file, stage, temp, before, text, made });
  } catch (error) {
    answer = failed(error.code ?? 'no code');
  }
  if (made.open) {
    try {
      rmSync(temp, { force: true });
    } catch (error) {
      if (answer === null || answer === 'changed') answer = failed(`its staged copy ${temp} could not be removed (${error.code ?? 'no code'})`);
    }
  }
  return typeof answer === 'string' && answer !== 'changed' ? failed(answer) : answer;
}

// The steps of replaceIfUnchanged that may throw: null, 'changed', or a reason. `made.open` says the copy is this call's.
function stageAndRename({ file, stage, temp, before, text, made }) {
  const fd = openSync(temp, 'wx', 0o600);
  made.open = true;
  try {
    const bytes = Buffer.from(text, 'utf8');
    for (let done = 0; done < bytes.length;) done += writeSync(fd, bytes, done, bytes.length - done);
  } finally {
    closeSync(fd);
  }
  if (path.dirname(realpathSync(temp)) !== path.join(realpathSync(path.dirname(file)), TRUST_STAGE)) return `${temp} does not lie in ${stage}`;
  chmodSync(temp, statSync(file).mode & 0o777);
  if (readFileSync(file, 'utf8') !== before) return 'changed';
  renameSync(temp, file);
  made.open = false;
  return null;
}
