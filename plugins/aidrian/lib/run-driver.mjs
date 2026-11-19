// Which project run a session drives, from its driver mark alone (unattended-mark.mjs markDriver), for the hooks: the agent
// gate hook holds a run's driver as a session no Human attends for writes to the runs folder, the marks, and the
// sign-off store; the review-signoff rule refuses it a sign-off; and the merge guard and `aidrian pr auto-merge` count it
// as unattended. Kept apart, with only file and path imports, so a hook rule that asks loads nothing that runs gh.
//
// It is a HOLD predicate: it says a session must be held, never that it may write a run's ledger. A driver's write rights
// need the ledger's current driver too (project-run-guard.mjs currentDriver).

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import { findProject } from './project.mjs';
import { readDriverMark } from './unattended-mark.mjs';

// The folder of a state folder that holds the runs, as project-run.mjs runsFolder names it.
const RUNS = 'runs';
// The largest ledger read, as project-run.mjs reads one.
const LEDGER_CAP = 8 * 1024 * 1024;
const NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// The rows of the ledger file `file`, read bounded without following a link, or null when it cannot be read whole.
function ledgerRows(file) {
  let fd;
  try {
    fd = openSync(file, NO_FOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LEDGER_CAP) return null;
    const buffer = Buffer.alloc(stat.size);
    const text = buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)).toString('utf8');
    return text.split('\n').filter((line) => line.trim() !== '').map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const SESSION = /^[\w-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const isSession = (value) => typeof value === 'string' && SESSION.test(value);
// The time of a row's `at`, or NaN when it is not a timestamp as toISOString writes it.
const timeOf = (row) => (typeof row?.at === 'string' && ISO.test(row.at) ? Date.parse(row.at) : Number.NaN);

// Whether `row` moves custody from `driver`, { session, since }: a `driver` row that names a session, moves it from
// the driver, carries the sha256 of the handed-over brief, and is dated no earlier than the row that made the driver.
const movesCustody = (row, driver) => row?.event === 'driver' && isSession(row.session) && row.from === driver.session && SHA256.test(row.sha256 ?? '')
  && Number.isFinite(timeOf(row)) && timeOf(row) >= driver.since;

// The driver of a run, read through its ledger: { session, since }, the session the init row `init` names, then each
// one a `driver` row of `rows`, the ledger's rows after init, moved custody to, with when the row that made it driver
// was written. project-run-guard.mjs driverOf reads custody through it.
export function driverAfter(init, rows) {
  let driver = { session: init?.session, since: Date.parse(init?.at) };
  for (const row of rows) if (movesCustody(row, driver)) driver = { session: row.session, since: timeOf(row) };
  return driver;
}

// Whether the run `found`, { init, rows } with `rows` the ledger's rows after its init row, has ended: an `end` row
// `aidrian project end` wrote, naming the session that was the run's driver, by custody, when the row was written. An
// end row any other session wrote, as one a confined session planted, ends nothing.
export function endedIn({ init, rows }) {
  let driver = { session: init?.session, since: Date.parse(init?.at) };
  for (const row of rows) {
    if (movesCustody(row, driver)) driver = { session: row.session, since: timeOf(row) };
    else if (row?.event === 'end' && isSession(row.session) && row.session === driver.session) return true;
  }
  return false;
}

// The project run `session` drives, as { run, project, root, state }, or null: from its driver mark alone, never from
// the folder a call runs in, so a nested git folder or a folder outside the project changes nothing. `root` is the run's
// main checkout and `project` its project, null when it does not resolve; `state` is the state folder the mark names,
// whose ledger alone is read. The session is held until that ledger records the run's end (endedIn): a run whose every
// issue is done or parked still owes the Human's sign-offs. A mark it cannot read whole, a missing state folder, and a
// ledger it cannot read hold the session, with `run`, `project`, `root`, or `state` null for what is unknown: a caller
// authorizes nothing on such an answer. `home` is a test's, as in unattended-mark.mjs markFolders.
export function runDriver(session, { env = process.env, home } = {}) {
  const mark = readDriverMark(session, { env, home });
  if (!mark) return null;
  const project = mark.root ? findProject(mark.root) : null;
  const held = { run: mark.run, project, root: mark.root, state: mark.state };
  if (!mark.run || !mark.state) return held;
  const rows = ledgerRows(path.join(mark.state, RUNS, mark.run, 'ledger.jsonl'));
  if (rows !== null && rows[0]?.event === 'init' && endedIn({ init: rows[0], rows: rows.slice(1) })) return null;
  return held;
}

// Whether `session` is held as a project run's driver (runDriver).
export const drivesRun = (session, options = {}) => runDriver(session, options) !== null;

// The unattended mark a driver stands for, for a reader that takes one (the merge guard, `aidrian pr auto-merge`):
// { root, cwd: null } with the run's main checkout, `root` null when it is unknown, which such a reader refuses on; or
// null when `session` drives no run.
export function driverHold(session, options = {}) {
  const driver = runDriver(session, options);
  return driver ? { root: driver.project ? driver.root : null, cwd: null } : null;
}
