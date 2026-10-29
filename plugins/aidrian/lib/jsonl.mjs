// JSON Lines files for project state, such as the lesson inbox and the dispatch log: one JSON object per line.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
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
