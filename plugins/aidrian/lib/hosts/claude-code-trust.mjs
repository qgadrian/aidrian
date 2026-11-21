// Claude Code's workspace trust for a project run. A background start in a folder the host has not trusted exits 1 with
// `Workspace not trusted` and starts nothing (docs/providers/claude-code.md). The host's record is `.claude.json` in
// CLAUDE_CONFIG_DIR when set, else in the home folder, whose `projects` map a folder to `hasTrustDialogAccepted`. Trust
// in a folder covers a plain folder below it, but inside a git repository the host looks trust up at the repository's
// own root alone (2.1.330, checked live), so an attempt's clone, a repository of its own, never inherits the runs
// folder's trust. The Human trusts the runs folder once, which `aidrian project preflight` checks (trustProblem), and
// each start records that trust for its own clone (recordTrust), from the record's current consent every time. The
// file is the host's own and undocumented, so a file that is missing or cannot be read leaves the preflight check
// unknown, never a blocker.

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolvedPath } from '../fs.mjs';

// The folder beside the record where a new record is staged before it is renamed over the old one. It is one of the
// sandbox's read barriers (claude-code-sandbox.mjs CREDENTIAL_PATHS, CONFIG_CREDENTIALS), as the record is, so no
// confined session reads the copy.
export const TRUST_STAGE = '.claude-trust-stage';
// How many times a record that changed while it was being updated is read again.
const TRIES = 3;

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
export function recordTrust({ work, runs, env = process.env, home }) {
  const file = trustFile(env, home);
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const read = readRecord(file);
    if (read.problem) return { problem: `the host's trust record ${file} cannot be read (${read.problem}), so the attempt's clone cannot be trusted` };
    const projects = read.record.projects && typeof read.record.projects === 'object' ? read.record.projects : {};
    if (!consented(projects, runs)) return { problem: `the host trusts neither the runs folder ${runs} nor a folder above it, and the attempt's clone, a repository of its own, inherits no trust` };
    if (projects[work]?.hasTrustDialogAccepted === true) return null;
    const next = { ...read.record, projects: { ...projects, [work]: { ...(projects[work] ?? {}), hasTrustDialogAccepted: true } } };
    const written = replaceIfUnchanged(file, read.text, `${JSON.stringify(next, null, 2)}\n`);
    if (written !== 'changed') return written;
  }
  return { problem: `the host's trust record ${file} kept changing while the start updated it, so the attempt's clone is not trusted` };
}

// Writes `text` over `file` when it still holds `before`: null when written, 'changed' when it no longer holds it, or
// { problem }. The stage must be a real folder, never a link that would move the copy out of the read barrier. The
// staged copy is made only by this call (`wx`), owner-only, and only a copy this call made is removed.
function replaceIfUnchanged(file, before, text) {
  const stage = path.join(path.dirname(file), TRUST_STAGE);
  const temp = path.join(stage, `record-${process.pid}-${Date.now()}.json`);
  const failed = (code) => ({ problem: `the host's trust record ${file} could not be written (${code}), so the attempt's clone is not trusted` });
  let made = false;
  try {
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    if (!lstatSync(stage).isDirectory()) return failed(`${stage} is not a folder`);
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    made = true;
    chmodSync(temp, statSync(file).mode & 0o777);
    if (readFileSync(file, 'utf8') !== before) return 'changed';
    renameSync(temp, file);
    made = false;
    return null;
  } catch (error) {
    return failed(error.code ?? 'no code');
  } finally {
    if (made) rmSync(temp, { force: true });
  }
}
