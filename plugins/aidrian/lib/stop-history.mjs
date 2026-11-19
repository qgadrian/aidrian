// The history of the actions `aidrian project stop-action` took for an issue (lib/project-stops.mjs), which its caps
// count. An attempt's rows are kept in `stops.jsonl` in its drop folder, the one folder of the run its confined session
// may write; when the driver's wait sweeps the attempt's folder (lib/project-start.mjs sweepAttempts), its rows are kept
// first in the run's own `stops/<issue>.jsonl` (archiveStops), with a row that marks the attempt archived, so no later
// attempt starts the caps again. Every file is opened without following a link and without waiting on a FIFO, and must
// be a regular file of this user with one link; anything else is a history that cannot be read, which parks.

import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import path from 'node:path';

import { runFolder } from './project-run.mjs';

// The file in a drop folder, the run's folder of archived rows, and the most bytes read of either file.
export const STOPS_FILE = 'stops.jsonl';
const ARCHIVE = 'stops';
const STOPS_CAP = 64 * 1024;
// The actions a row may record.
export const RECORDED = Object.freeze(['wait', 'rerun_checks', 'update_branch', 'merge_base', 'review_round', 'request_bot', 'merge']);
const SHA = /^[0-9a-f]{40}$/u;
const OPEN_FLAGS = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

// Why the open file `fd` is no plain file of this user, or null.
function plainProblem(fd, file) {
  const stat = fstatSync(fd);
  const uid = processUid();
  if (!stat.isFile()) return `${file} is not a regular file`;
  if (stat.nlink !== 1) return `${file} has ${stat.nlink} links`;
  if (Number.isInteger(uid) && stat.uid !== uid) return `${file} belongs to another user`;
  if (stat.size > STOPS_CAP) return `${file} is over ${STOPS_CAP} bytes`;
  return null;
}

// The rows of the history file `file`: { rows } (none when there is no file) or { problem }. A row is an action row
// { action, head, attempt? }, or an archive marker { event: 'archived', attempt }; any other row is a problem.
export function readStops(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | OPEN_FLAGS);
  } catch (error) {
    if (error.code === 'ENOENT') return { rows: [] };
    return { problem: `${file} cannot be opened as a file (${error.code ?? 'no code'})` };
  }
  try {
    const problem = plainProblem(fd, file);
    if (problem) return { problem };
    const buffer = Buffer.alloc(STOPS_CAP + 1);
    let length = 0;
    let got = -1;
    while (got !== 0 && length < buffer.length) {
      got = readSync(fd, buffer, length, buffer.length - length, null);
      length += got;
    }
    if (length > STOPS_CAP) return { problem: `${file} grew past ${STOPS_CAP} bytes` };
    const rows = [];
    for (const line of buffer.subarray(0, length).toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return { problem: `${file} holds a line that is not JSON` };
      }
      const action = RECORDED.includes(row?.action) && SHA.test(row.head ?? '');
      const marker = row?.event === 'archived' && Number.isInteger(row.attempt);
      if (!action && !marker) return { problem: `${file} holds a row the stop command did not write` };
      rows.push(row);
    }
    return { rows };
  } catch (error) {
    return { problem: `${file} cannot be read (${error.code ?? 'no code'})` };
  } finally {
    closeSync(fd);
  }
}

// Appends `rows` to the history file `file`, in one write: null, or why it could not. A file that is not a plain one of
// this user, a FIFO among them, is refused before anything is written.
export function appendStops(file, rows) {
  let fd;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | OPEN_FLAGS, 0o600);
  } catch (error) {
    return `${file} cannot be opened to write (${error.code ?? 'no code'})`;
  }
  try {
    const problem = plainProblem(fd, file);
    if (problem) return problem;
    writeSync(fd, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
    return null;
  } catch (error) {
    return `${file} cannot be written (${error.code ?? 'no code'})`;
  } finally {
    closeSync(fd);
  }
}

// The run's file of archived rows of issue `key`.
export const archiveFile = (state, run, key) => path.join(runFolder(state, run), ARCHIVE, `${key}.jsonl`);

// Keeps the rows of attempt `attempt` of issue `key`, from its drop folder `drop`, in the run's archive, then a marker
// row, before its folder is swept. A drop history that cannot be read is kept as a row no reader takes, so the issue's
// next stop parks rather than start its caps again. Null, or why it could not, which keeps the folder.
export function archiveStops({ state, run, key, attempt, drop }) {
  const read = readStops(path.join(drop, STOPS_FILE));
  const rows = read.problem ? [{ event: 'unreadable', attempt, why: read.problem }] : read.rows.filter((row) => row.action).map((row) => ({ ...row, attempt }));
  const file = archiveFile(state, run, key);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch (error) {
    return `${path.dirname(file)} cannot be made (${error.code ?? 'no code'})`;
  }
  return appendStops(file, [...rows, { event: 'archived', attempt }]);
}

// The recorded actions of issue `key`, from the run's archive, then the drop folder of each start in `starts` (with
// `attempt` and `drop`) the archive has not marked archived: { rows } or { problem }.
export function issueStops({ state, run, key, starts }) {
  const archived = readStops(archiveFile(state, run, key));
  if (archived.problem) return { problem: `the stop history of ${key}: ${archived.problem}` };
  const done = new Set(archived.rows.filter((row) => row.event === 'archived').map((row) => row.attempt));
  const rows = archived.rows.filter((row) => row.action);
  for (const start of starts) {
    if (typeof start.drop !== 'string' || done.has(start.attempt)) continue;
    const read = readStops(path.join(start.drop, STOPS_FILE));
    if (read.problem) return { problem: `the stop history of attempt ${start.attempt}: ${read.problem}` };
    if (read.rows.some((row) => !row.action)) return { problem: `the stop history of attempt ${start.attempt} holds a row the stop command did not write` };
    rows.push(...read.rows);
  }
  return { rows };
}
