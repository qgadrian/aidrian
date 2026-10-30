// JSON Lines files for project state, such as the lesson inbox and the dispatch log: one JSON object per line.

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
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
