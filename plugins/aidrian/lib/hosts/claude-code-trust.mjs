// Claude Code's workspace trust for a project run. A background start in a folder the host has not trusted exits 1 with
// `Workspace not trusted` and starts nothing (docs/providers/claude-code.md). The host's record is `.claude.json` in
// CLAUDE_CONFIG_DIR when set, else in the home folder, whose `projects` map a folder to `hasTrustDialogAccepted`. Trust
// in a folder covers a plain folder below it, but inside a git repository the host looks trust up at the repository's
// own root alone (2.1.330, checked live), so an attempt's clone, a repository of its own, never inherits the runs
// folder's trust. The Human trusts the runs folder once, which `aidrian project preflight` checks (trustProblem), and
// each start records that trust for its own clone (recordTrust). The file is the host's own and undocumented, so a
// file that is missing or cannot be read leaves the preflight check unknown, never a blocker.

import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolvedPath } from '../fs.mjs';

// The host's record of trusted folders, for `env` and `home`.
export const trustFile = (env, home) => path.join(env.CLAUDE_CONFIG_DIR || home || env.HOME || homedir(), '.claude.json');

// { problem } when the record says no folder from `folder` up is trusted, { note } when the record cannot be read, or
// null when `folder` or a folder above it is trusted.
export function trustProblem({ folder, env = process.env, home }) {
  const file = trustFile(env, home);
  let projects;
  try {
    projects = JSON.parse(readFileSync(file, 'utf8'))?.projects;
  } catch (error) {
    return { note: `the host's trust record ${file} cannot be read (${error.code ?? 'not JSON'}), so whether it trusts ${folder} is unknown; a start there refuses with "Workspace not trusted" if it does not` };
  }
  const trusted = (dir) => projects?.[dir]?.hasTrustDialogAccepted === true;
  for (const start of new Set([path.resolve(folder), resolvedPath(folder) ?? path.resolve(folder)])) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (trusted(dir)) return null;
      if (path.dirname(dir) === dir) break;
    }
  }
  return { problem: `the host does not trust ${folder} or a folder above it, so every start there exits with "Workspace not trusted"; run \`claude\` in ${folder} once and accept its trust question, which covers every attempt's clone below it` };
}

// Records the host's trust for `work`, an attempt's clone, when the record trusts a folder above it, as the Human's
// trust in the runs folder does: { problem } when it cannot, null when it did or `work` was trusted already. The record
// is written whole to a temporary file beside it and renamed over it, as the host writes it, keeping its file mode.
export function recordTrust({ work, env = process.env, home }) {
  const file = trustFile(env, home);
  let record;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { problem: `the host's trust record ${file} cannot be read (${error.code ?? 'not JSON'}), so the attempt's clone cannot be trusted` };
  }
  const projects = record?.projects && typeof record.projects === 'object' ? record.projects : {};
  if (projects[work]?.hasTrustDialogAccepted === true) return null;
  const above = trustProblem({ folder: path.dirname(work), env, home });
  if (above) return { problem: above.note ?? `the host trusts no folder above the attempt's clone ${work}, which, a repository of its own, inherits no trust` };
  record.projects = { ...projects, [work]: { ...(projects[work] ?? {}), hasTrustDialogAccepted: true } };
  const temp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, statSync(file).mode & 0o777);
    renameSync(temp, file);
  } catch (error) {
    return { problem: `the host's trust record ${file} could not be written (${error.code ?? 'no code'}), so the attempt's clone is not trusted` };
  }
  return null;
}
