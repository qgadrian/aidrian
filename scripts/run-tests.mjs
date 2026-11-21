#!/usr/bin/env node
// Runs the test suite, `node --test --import ./scripts/test-state.mjs` with this script's arguments after it, and then
// prints on stderr the ten test files that took the most time, each with its git calls and other child processes, and a
// line of totals summed over every file, so a change to the suite's time is measured the same way every run.
//
//   node scripts/run-tests.mjs [node --test arguments and files]
//
// The runner's output passes through. Each test file's preload (scripts/test-state.mjs) appends its row to the file
// AIDRIAN_TEST_LOG names, in a temporary folder this script removes. The exit status is the runner's, 1 when a signal
// ended it, even when the table or the cleanup fails. A file run alone, `node --test test/<name>.test.mjs`, still works, with no table.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SETUP = pathToFileURL(path.join(import.meta.dirname, 'test-state.mjs')).href;
const SHOWN = 10;

// The rows the test files wrote, { file, ms, git, other }, skipping a line a killed process left half written.
function readRows(log) {
  let text = '';
  try {
    text = readFileSync(log, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

const seconds = (ms) => (ms / 1000).toFixed(1);

// The table: the slowest files first, then the totals over every file.
function formatTable(rows) {
  if (!rows.length) return '';
  const slowest = [...rows].sort((a, b) => b.ms - a.ms).slice(0, SHOWN);
  const lines = slowest.map((row) => `${seconds(row.ms).padStart(7)}  ${String(row.git).padStart(5)}  ${String(row.other).padStart(5)}  ${row.file}`);
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  const files = rows.length === 1 ? '1 test file' : `${rows.length} test files`;
  const totals = `Summed over ${files}: ${seconds(sum('ms'))} s, ${sum('git')} git calls, ${sum('other')} other child processes`;
  return [
    '',
    `The test files that took the most time, at most ${SHOWN}:`,
    `${'seconds'.padStart(7)}  ${'git'.padStart(5)}  ${'other'.padStart(5)}  file`,
    ...lines,
    totals,
    '',
  ].join('\n');
}

const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-test-log-'));
const log = path.join(dir, 'files.jsonl');
const runner = spawn(process.execPath, ['--test', '--import', SETUP, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, AIDRIAN_TEST_LOG: log },
});
// Ctrl-C reaches the runner too: this script waits for it to end, then cleans up.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => runner.kill(signal));
// The table and the cleanup are best effort: a folder that cannot be removed is named on stderr, and the status stays the runner's.
runner.on('exit', (code) => {
  try {
    process.stderr.write(formatTable(readRows(log)));
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    process.stderr.write(`Could not remove the test log folder ${dir}: ${error.message}\n`);
  } finally {
    process.exit(code ?? 1);
  }
});
