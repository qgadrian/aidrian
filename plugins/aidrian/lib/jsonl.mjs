// JSON Lines files for project state, such as the lesson inbox and the dispatch log: one JSON object per line.

import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';

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
// A lock older than this is stale whoever holds it: no holder keeps one for more than a moment.
const STALE_LOCK_MS = 30_000;
// The code of the error withLocks throws when a lock stays held.
export const LOCKED = 'ELOCKED';
// The files this process holds the lock of, so a holder that locks one again runs at once.
const held = new Set();

// Runs `fn` holding the lock of every file in `files`, then releases them, and returns what `fn` returns. Appending needs
// no lock; a writer whose rows depend on what it read in the file, such as a lesson move, takes it from the read to its
// last append, so no other such writer appends in between. The lock is `<file>.lock`, created exclusively, holding the
// holder's pid and a token. Locks are taken in path order, so two holders of the same files never wait on each other.
// A lock whose holder is gone, or older than STALE_LOCK_MS, is removed. Throws when a lock stays held `waitMs`.
export function withLocks(files, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const mine = [...new Set(files.filter(Boolean))].sort().filter((file) => !held.has(file));
  const taken = [];
  try {
    for (const file of mine) taken.push(lock(file, waitMs));
    return fn();
  } finally {
    for (const { file, token } of taken.reverse()) {
      held.delete(file);
      if (readText(`${file}.lock`) === token) rmSync(`${file}.lock`, { force: true });
    }
  }
}

function lock(file, waitMs) {
  const name = `${file}.lock`;
  mkdirSync(path.dirname(name), { recursive: true });
  const token = `${process.pid} ${randomBytes(6).toString('hex')}\n`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(name, 'wx');
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      held.add(file);
      return { file, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = readText(name);
    // The lock went away between the two calls: take it now.
    if (holder === null) continue;
    if (stale(name, holder)) {
      // Removed only while it still holds what was judged stale, so a lock another waiter just took survives.
      if (readText(name) === holder) rmSync(name, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw Object.assign(new Error(`${file} is locked by another process (${name}); try again`), { code: LOCKED });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
  }
}

// A lock whose holder process is gone, or that is older than STALE_LOCK_MS.
function stale(name, holder) {
  const pid = Number.parseInt(holder, 10);
  if (pid > 0 && !alive(pid)) return true;
  try {
    return Date.now() - statSync(name).mtimeMs > STALE_LOCK_MS;
  } catch {
    return true;
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
