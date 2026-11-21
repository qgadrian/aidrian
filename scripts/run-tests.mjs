#!/usr/bin/env node
// Runs the test suite, `node --test --import ./scripts/test-state.mjs` with this script's arguments after it, and then
// prints on stderr the ten test files that took the most time, each with its git calls and other child processes, and a
// line of totals summed over every file, so a change to the suite's time is measured the same way every run.
//
//   node scripts/run-tests.mjs [node --test arguments and files]
//
// The runner's output passes through. Each test file's preload (scripts/test-state.mjs) appends its row to the file
// AIDRIAN_TEST_LOG names, in a temporary folder this script removes. The exit status is the runner's, or 1 when a signal
// ended it or the budget below fails the run, even when the table or the cleanup fails. A file run alone, `node --test test/<name>.test.mjs`, still works, with no table.
//
// Budget: each test file that ran may start at most its budget of child processes, its git calls and its others
// together, as test/child-process-budget.json under the folder the run starts in sets it:
// { "default": 300, "files": { "<name>.test.mjs": <count> } }, a file with no entry held to the default, and every
// file to 300 when the budget file is missing. A run whose runner passed exits 1 when a file that ran is over its
// budget, naming each such file and the two ways out on stderr, or when the budget file cannot be read.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SETUP = pathToFileURL(path.join(import.meta.dirname, 'test-state.mjs')).href;
const SHOWN = 10;
const BUDGET_FILE = path.join('test', 'child-process-budget.json');
const DEFAULT_BUDGET = 300;

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

// The budget file's { default, files }, read from the folder the run starts in. Missing, every file has the default;
// unreadable or of the wrong shape, it throws.
function readBudget() {
  let text;
  try {
    text = readFileSync(BUDGET_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { default: DEFAULT_BUDGET, files: {} };
    throw error;
  }
  const budget = JSON.parse(text);
  const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const counts = plain(budget) && plain(budget.files) ? [budget.default, ...Object.values(budget.files)] : [];
  if (!counts.length || !counts.every((count) => Number.isInteger(count) && count >= 0)) {
    throw new Error('it is not { "default": <count>, "files": { "<name>.test.mjs": <count> } }');
  }
  return budget;
}

// A row the preload wrote: a file's name and its two counts. The table names any other line it cannot render.
const isRow = (row) => typeof row?.file === 'string' && Number.isInteger(row.git) && Number.isInteger(row.other);

// The lines that name each file over its budget, and the two ways out, or none when every file is within it.
function overBudget(rows, budget) {
  const over = rows.filter(isRow).flatMap((row) => {
    const name = path.basename(row.file);
    const allowed = budget.files[name] ?? budget.default;
    const count = row.git + row.other;
    return count > allowed ? [`${row.file} started ${count} child processes (${row.git} git, ${row.other} other), over its budget of ${allowed} in ${BUDGET_FILE}.`] : [];
  });
  if (!over.length) return [];
  return [
    '',
    ...over,
    "Run its commands and hooks in the test's process (docs/test-processes.md, Commands in the test's process, and docs/contributing.md, Hooks in the test's process),",
    `or add or raise its entry in ${BUDGET_FILE}, by the rule in docs/test-processes.md, Child-process budget, in the same pull request, and say why in the pull request's description.`,
    '',
  ];
}

const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-test-log-'));
const log = path.join(dir, 'files.jsonl');
const runner = spawn(process.execPath, ['--test', '--import', SETUP, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, AIDRIAN_TEST_LOG: log },
});
// Ctrl-C reaches the runner too: this script waits for it to end, then cleans up.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => runner.kill(signal));
// The table and the cleanup are each best effort: the one that fails is named on stderr when stderr takes it, the other
// still runs, and the status stays the runner's whatever fails.
function attempt(what, step) {
  try {
    step();
  } catch (error) {
    try {
      process.stderr.write(`Could not ${what}: ${error.message}\n`);
    } catch {
      // Stderr is gone too: nothing is left to tell.
    }
  }
}

// The budget, judged only when the runner passed: a file over it, or a budget that cannot be read, fails the run.
function judge(rows) {
  let lines;
  try {
    lines = overBudget(rows, readBudget());
  } catch (error) {
    attempt('name the budget it could not read', () => process.stderr.write(`Could not read the child-process budget ${BUDGET_FILE}: ${error.message}\n`));
    return 1;
  }
  if (!lines.length) return 0;
  attempt('name the files over their budget', () => process.stderr.write(lines.join('\n')));
  return 1;
}

runner.on('exit', (code) => {
  let status = code ?? 1;
  try {
    const rows = readRows(log);
    attempt('print the table of test files', () => process.stderr.write(formatTable(rows)));
    if (status === 0) status = judge(rows);
    attempt(`remove the test log folder ${dir}`, () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  } finally {
    process.exit(status);
  }
});
