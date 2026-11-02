// JSON Lines files for project state, such as the lesson inbox and the dispatch log: one JSON object per line.

import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

import { resolvedPath } from './fs.mjs';

// Appends one row. A single write in append mode: rows from concurrent processes never interleave.
// A write cut short leaves the file without its last newline; the next row then starts on a line of its own, so the
// damage stays on the cut line and the new row still reads back. Two appenders that both see the cut add a blank line.
export function appendRow(file, row) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${endsCut(file) ? '\n' : ''}${JSON.stringify(row)}\n`);
}

function endsCut(file) {
  let fd;
  try {
    const { size } = statSync(file);
    if (size === 0) return false;
    fd = openSync(file, 'r');
    const last = Buffer.alloc(1);
    return readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// How long a writer waits for a lock another process holds, and how often it looks again.
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 10;
// A lock whose holder cannot be checked, held from another host or naming no pid, is abandoned after this long.
// A holder on this host is checked by its pid instead, and keeps its lock however long it lives.
const UNCHECKED_LOCK_MS = 10 * 60_000;
// The code of the error withLocks throws when a lock stays held.
export const LOCKED = 'ELOCKED';
// The files this process holds the lock of, each with its generation, so a holder that locks one again runs at once.
const held = new Map();

// Runs `fn` holding the lock of every file in `files`, then releases them, and returns what `fn` returns. Appending needs
// no lock; a writer whose rows depend on what it read in the file, such as a lesson move, takes it from the read to its
// last append, so no other such writer appends in between. Locks are taken in path order, so two holders of the same
// files never wait on each other. Throws an error with code LOCKED when a lock stays held `waitMs`.
//
// A lock is a numbered generation, `<file>.lock.<n>`: the highest number on disk is the lock's state. Its file holds the
// holder's pid, host, and a nonce; `<file>.lock.<n>.released` marks it released. A process takes the lock by creating
// generation n + 1 with an exclusive create, when generation n is released, missing, or abandoned: its holder is a pid
// on this host that no longer runs, or it cannot be checked and is older than UNCHECKED_LOCK_MS. Of all the processes
// that judged generation n free, only one creates n + 1, so taking over an abandoned lock is as safe as taking a free one,
// and no process ever deletes a lock it did not supersede. A process whose view was out of date may create a lower
// number than one already on disk; it sees the higher one, deletes its own, and looks again. The holder of generation n
// deletes the generations below it, so two files stay once the lock is idle.
//
// Each file is locked by its real path (realFile), so two spellings of one file, such as through a symlinked folder,
// are one lock: taken once, in one place in the order, and held already when one spelling is locked inside the other.
export function withLocks(files, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const mine = [...new Set(files.filter(Boolean).map(realFile))].sort().filter((file) => !held.has(file));
  const taken = [];
  try {
    for (const file of mine) {
      held.set(file, lock(file, waitMs));
      taken.push(file);
    }
    return fn();
  } finally {
    for (const file of taken.reverse()) {
      create(releasedName(file, held.get(file)), '');
      held.delete(file);
    }
  }
}

// `file` as an absolute path with every symlink resolved (fs.mjs resolvedPath): two spellings of one file give one path.
// A path through a broken symlink stays as given.
export const realFile = (file) => resolvedPath(file) ?? path.resolve(file);

// Whether `a` and `b` name one file, however each is spelled.
export const sameFile = (a, b) => realFile(a) === realFile(b);

const lockName = (file, generation) => `${file}.lock.${generation}`;
const releasedName = (file, generation) => `${lockName(file, generation)}.released`;

// Every lock file of `file` on disk, as { name, generation, released }.
function lockFiles(file) {
  const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`^${base}\\.lock\\.(\\d+)(\\.released)?$`, 'u');
  let names;
  try {
    names = readdirSync(path.dirname(file));
  } catch {
    names = [];
  }
  return names.map((name) => [name, pattern.exec(name)]).filter(([, match]) => match).map(([name, match]) => ({ name, generation: Number(match[1]), released: Boolean(match[2]) }));
}

const newest = (file) => Math.max(0, ...lockFiles(file).filter((item) => !item.released).map((item) => item.generation));

function lock(file, waitMs) {
  mkdirSync(path.dirname(file), { recursive: true });
  const token = `${JSON.stringify({ pid: process.pid, host: hostname(), nonce: randomBytes(6).toString('hex') })}\n`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const top = newest(file);
    const holder = top ? holderOf(file, top) : null;
    if (!holder) {
      const generation = top + 1;
      if (create(lockName(file, generation), token)) {
        if (newest(file) === generation) {
          sweep(file, generation);
          return generation;
        }
        // A newer generation exists: this process read an old state. Its own file is not the lock.
        rmSync(lockName(file, generation), { force: true });
      }
      if (Date.now() < deadline) continue;
    }
    if (Date.now() >= deadline) {
      const who = holder ? ` (pid ${holder.pid ?? 'unknown'}${holder.host && holder.host !== hostname() ? ` on ${holder.host}` : ''}, ${lockName(file, top)})` : '';
      throw Object.assign(new Error(`${file} is locked by another process${who}; try again`), { code: LOCKED });
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
  }
}

// The holder of generation `generation`, as { pid, host }, or null when that generation no longer holds the lock:
// released, gone, or abandoned.
function holderOf(file, generation) {
  const name = lockName(file, generation);
  if (existsSync(releasedName(file, generation))) return null;
  const text = readText(name);
  if (text === null) return null;
  let holder = {};
  try {
    holder = JSON.parse(text);
  } catch {
    // Being written, or not a lock this code wrote: only its age can tell.
  }
  const pid = Number.isInteger(holder?.pid) && holder.pid > 0 ? holder.pid : null;
  if (pid && holder.host === hostname()) return alive(pid) ? { pid, host: holder.host } : null;
  try {
    return Date.now() - statSync(name).mtimeMs > UNCHECKED_LOCK_MS ? null : { pid, host: typeof holder?.host === 'string' ? holder.host : null };
  } catch {
    return null;
  }
}

// Deletes the lock files below `generation`, which no process holds any more.
function sweep(file, generation) {
  for (const item of lockFiles(file)) if (item.generation < generation) rmSync(path.join(path.dirname(file), item.name), { force: true });
}

// Creates `name` holding `text`, or returns false when it exists.
function create(name, text) {
  try {
    writeFileSync(name, text, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// The rows of `event` with the last one per `key` value, in first-seen order; a row without the key is kept as it is.
// For a row its writer may repeat, such as a stop row after its agent was sent back, or a session that ended twice.
export const latestRows = (rows, event, key) =>
  [...new Map(rows.filter((row) => row.event === event).map((row) => [row[key] ?? Symbol(event), row])).values()];

// Returns { rows, skipped }: every line that holds a JSON object, and how many lines did not. A missing file has none.
export function readRows(file) {
  const rows = [];
  let skipped = 0;
  for (const row of readLines(file)) {
    if (row) rows.push(row);
    else skipped += 1;
  }
  return { rows, skipped };
}

function readLines(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseObject);
}

function parseObject(line) {
  try {
    const value = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
