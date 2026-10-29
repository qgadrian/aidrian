// JSON Lines files for project state, such as the lesson inbox and the dispatch log: one JSON object per line.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Appends one row. A single write in append mode: rows from concurrent processes never interleave.
export function appendRow(file, row) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

// Returns { rows, skipped }: every line that holds a JSON object, and how many lines did not. A missing file has none.
export function readRows(file) {
  const rows = [];
  let skipped = 0;
  for (const { row } of readLines(file)) {
    if (row) rows.push(row);
    else skipped += 1;
  }
  return { rows, skipped };
}

// Rewrites the file with `change(row)` applied to every row: return a row to keep, or null to drop it. Lines that hold
// no JSON object are kept as they are. Writes a temporary file and renames it, so a reader never sees half a file.
export function rewriteRows(file, change) {
  const lines = [];
  for (const { text, row } of readLines(file)) {
    if (!row) {
      lines.push(text);
      continue;
    }
    const next = change(row);
    if (next) lines.push(JSON.stringify(next));
  }
  const temp = `${file}.${process.pid}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(temp, lines.map((line) => `${line}\n`).join(''));
  renameSync(temp, file);
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
    .map((line) => ({ text: line, row: parseObject(line) }));
}

function parseObject(line) {
  try {
    const value = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
