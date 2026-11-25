// The check-run record (docs/hooks.md#check-runs): the test runs a session's shell calls finished, and what each showed.
// scripts/hook-bash-post.mjs appends one row a test command a call ran to its end, to `checks.jsonl` in the session folder
// (lib/session-folder.mjs); a run started in the background, moved there at its timeout, or stopped leaves no row, since
// no hook sees it end. The pull request body rule (lib/rules/github/pr-body.mjs) and the subagent stop hook read it back:
// a line of a report that says a test command passed needs a row of that command that passed (unsupportedClaims).
// The push-first rule (lib/rules/push-first.mjs) reads `isFullSuite` from here too.
//
// A row is `{ at, agentId, command, tree, trackedTree, status, pass, fail }`: `command` the test invocation's words with
// wrappers and redirects dropped (commandKey); `tree` the git tree of the folder's files as they are when the run ends,
// untracked files git does not ignore included, and `trackedTree` the same of the tracked files alone (workingTree), each
// null when git cannot say; and `status` `passed`, `failed`, or `unjudged`. On a host whose PostToolUse comes only for a
// call that exited 0, as Claude Code's, a run whose status is the line's own (only `&&` before and after it) passed unless
// its counts show a failure. Any other run, and every run on a host that sends the hook failed calls too, as Codex, is
// judged by its counts alone: passed with a pass count above 0 and a fail count of 0, failed with a fail count above 0,
// and `unjudged` when it printed no count, since its exit status is unknown. A call whose output the host kept in a file,
// as Claude Code does with one too long for the payload, is read from the tail of that file (outputText).

import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, fstatSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runGit } from './git.mjs';
import { closes, fencedLines, fenceOf, sectionLines, unfencedLines } from './markdown-sections.mjs';
import { appendSessionFile, readSessionTail, writeSessionFile } from './session-folder.mjs';
import { aidrianArgs, lexPipeline, readInvocation, walkCommands } from './shell-lex.mjs';

// The record's name in the session folder (lib/session-folder.mjs APPENDED_FILES), and the most it grows: a write that
// would pass it keeps the newest rows within half of it.
export const CHECK_RUNS = 'checks.jsonl';
export const CHECK_RUNS_MAX_BYTES = 64 * 1024;
// How much of a call's output is read, from its end, for the counts: of its text, or of the file the host kept it in.
const OUTPUT_TAIL = 64 * 1024;
const READ_FILE = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);
const COMMAND_MAX = 300;

// Programs that run a command given after them: `npx vitest`, `pnpm exec jest`, `python -m pytest`, `bundle exec rspec`.
const RUNNER_WRAPPERS = new Map([['npx', 0], ['bunx', 0], ['pnpx', 0], ['pnpm', 'exec'], ['yarn', 'exec'], ['bundle', 'exec'], ['python', '-m'], ['python3', '-m']]);
// Word lists that start a test run, after RUNNER_WRAPPERS are peeled.
const TEST_PREFIXES = [
  ['npm', 'test'], ['npm', 't'], ['npm', 'run', 'test'], ['pnpm', 'test'], ['pnpm', 'run', 'test'],
  ['yarn', 'test'], ['yarn', 'run', 'test'], ['bun', 'run', 'test'], ['vitest'], ['jest'], ['pytest'], ['go', 'test'],
  ['cargo', 'test'], ['mix', 'test'], ['rspec'], ['make', 'test'], ['make', 'check'], ['playwright', 'test'],
].map((words) => words.join(' '));

const CHANGES_DIRECTORY = new Set(['cd', 'pushd', 'popd']);
// A test file, as the review's quiet test patterns name one: `*.test.*`, `*.spec.*`, `*_test.*`, or one in a test
// folder; and a code file, by its extension. `aidrian test changed` and the untracked-file rule read both.
export const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[^/]+$|_test\.[^/]+$/u;
export const CODE_FILE = /\.(?:[cm]?[jt]sx?|json|py|go|rs|rb|ex|exs|php|java|kt|swift|cs)$/u;
// Programs that run no test suite, so a line of only these needs no config read (mayRunTests).
const NEVER_TESTS = new Set([
  'git', 'ls', 'cat', 'echo', 'printf', 'grep', 'egrep', 'rg', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr',
  'find', 'xargs', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'chmod', 'ln', 'pwd', 'which', 'test', '[', 'true', 'false', 'sleep', 'date',
  'diff', 'jq', 'curl', 'tee', 'stat', 'file', 'basename', 'dirname', 'realpath', 'export', 'set', 'unset', 'source', '.', 'aidrian-knowledge',
  'cd', 'pushd', 'popd',
]);

// Whether `command` runs any program that could run tests, so a rule reads the project's config for it: false for a line
// of only NEVER_TESTS programs, `aidrian` commands other than `test changed`, and nothing.
export function mayRunTests(command, cwd = null) {
  try {
    return walkCommands(command, cwd).some(({ invocation }) => {
      if (invocation.dynamic) return false;
      const own = aidrianArgs(invocation);
      if (own) return own[0]?.text === 'test';
      return typeof invocation.program === 'string' && invocation.program !== '' && !NEVER_TESTS.has(invocation.program);
    });
  } catch {
    return false;
  }
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const startsWith = (key, prefix) => key === prefix || key.startsWith(`${prefix} `);

// A key past COMMAND_MAX keeps its head and a digest of the whole, so two runs of different long file lists stay two keys.
// Only the stored key is capped: a configured command is matched as a prefix of the whole command (isTestRun).
const capped = (key) => (key.length <= COMMAND_MAX ? key : `${key.slice(0, COMMAND_MAX)} #${createHash('sha256').update(key).digest('hex').slice(0, 12)}`);

// The key a run and a claim are matched by: the whole key (fullKey), capped.
export const commandKey = (invocation) => capped(fullKey(invocation));

// The words of a readInvocation result, wrappers that run a test runner peeled, joined by spaces, uncapped.
// `rtk npm run check 2>&1` and `npm run check` are one key.
function fullKey(invocation) {
  const own = aidrianArgs(invocation);
  if (own) return ['aidrian', ...own.map((token) => token.text)].join(' ');
  let words = [invocation.program, ...invocation.args.map((token) => token.text)].filter((word) => typeof word === 'string' && word !== '');
  for (let peeled = 0; peeled < 3 && RUNNER_WRAPPERS.has(words[0]); peeled += 1) {
    const after = RUNNER_WRAPPERS.get(words[0]);
    if (after === 0) words = words.slice(1);
    else if (words[1] === after) words = words.slice(2);
    else break;
  }
  if (words[0] !== undefined) words[0] = path.basename(words[0]);
  return words.join(' ');
}

// Whether the readInvocation result runs tests: a word list of TEST_PREFIXES, a configured full suite or changed-files
// command, `node --test`, or `aidrian test changed`.
export function isTestRun(invocation, testing = {}) {
  if (invocation.dynamic) return false;
  const words = aidrianArgs(invocation)?.map((token) => token.text);
  if (words) return words[0] === 'test' && words[1] === 'changed';
  const key = fullKey(invocation);
  if (key.startsWith('node ') && key.split(' ').includes('--test')) return true;
  const configured = [...(testing.fullSuite ?? []), ...(testing.changedCommand ? [testing.changedCommand] : [])].map(keyOfText);
  return [...TEST_PREFIXES, ...configured].some((prefix) => prefix && startsWith(key, prefix));
}

// The whole key of a command written as text, such as a config entry: its first command's (fullKey).
function keyOfText(text) {
  const [segment] = lexPipeline(String(text)).segments;
  return segment ? fullKey(readInvocation(segment)) : '';
}

// Whether the readInvocation result runs one of `testing.fullSuite` as written, with no more arguments: `npm test -- f`
// runs one file, and is no full suite.
export const isFullSuite = (invocation, testing = {}) => !invocation.dynamic && (testing.fullSuite ?? []).map(keyOfText).includes(fullKey(invocation));

// The test runs on the top level of `command`, as { key, folder, carries }: `folder` the folder it runs in (shell-lex
// walkCommands), and `carries` whether the line's exit status of 0 says the run exited 0: no separator before or after it
// but `&&`. After `;` or `||` the run may not have run at all, or another command's status is the line's.
// A run the lexer marks `uncertain`, which the shell may never run, as behind `repeat 0`, is no run.
// A run inside a substitution or a nested shell is not read.
export function testRuns(command, cwd, testing = {}) {
  const { segments, separators } = lexPipeline(command);
  const entries = walkCommands(command, cwd).filter((entry) => entry.line === command);
  const runs = [];
  let next = 0;
  segments.forEach((segment, index) => {
    const invocation = readInvocation(segment);
    // walkCommands leaves the directory changes out, and keeps every other segment, in order.
    if (CHANGES_DIRECTORY.has(invocation.program)) return;
    const entry = entries[next];
    next += 1;
    if (segment.length === 0 || invocation.uncertain || !isTestRun(invocation, testing)) return;
    const carries = separators.every((separator) => separator === '&&' || separator === null || separator === undefined);
    runs.push({ key: commandKey(invocation), folder: entry?.folder ?? null, carries });
  });
  return runs;
}

// The pass and fail counts a run printed, or null for each it never printed, from one family of summary lines, summed
// over every line of that family and never added to another family's: a script around a runner, or a monorepo tool that
// runs one per package, prints one summary each. The first family the output's tail holds counts:
// 1. node's test runner: `ℹ pass 12`, TAP `# fail 0`;
// 2. `Tests` lines, as vitest (`Tests  1 failed | 11 passed (12)`) and jest (`Tests:  1 failed, 11 passed, 12 total`)
//    print them, also behind a task prefix such as turbo's `web:test: `;
// 3. cargo's `test result: ok. 12 passed; 0 failed; ...`, one a test binary and the doc-tests;
// 4. go test's (goCounts): with `-v`, the `--- PASS: TestX` and `--- FAIL: TestX` lines at the start of a line, one a
//    top-level test, subtests left out; else, since go test prints no pass count, the `ok  <package>  0.01s` and
//    `FAIL  <package>  0.01s` lines, one a package;
// 5. any other line with "N passed" or "N failed", as pytest's `=== 12 passed in 0.5s ===` and Playwright's own lines;
// 6. rspec's and mix's `12 examples, 0 failures`.
// A family that names passes and no failure counts 0 failures. Unless node's runner counted, whose fail count stands, a
// line that is only "N failed" above 0, ANSI colours stripped, as Playwright's standalone `  1 failed` line, makes the
// fail count at least N. A test's name, such as `✔ lists 2 failed payments`, is never such a line.
const NODE_COUNTS = { pass: /^\s*(?:ℹ|#)\s*pass\s+(\d+)\s*$/gmu, fail: /^\s*(?:ℹ|#)\s*fail\s+(\d+)\s*$/gmu };
const TASK_PREFIX = String.raw`(?:[\w@./-]+:\s*)*`;
const TESTS_LINE = new RegExp(String.raw`^\s*${TASK_PREFIX}Tests:?\s+\d`, 'u');
const CARGO_LINE = /\btest result:\s+\w+\.\s+\d+\s+passed;/u;
const WORDS_LINE = /\b\d+\s+(?:passed|failed)\b/u;
const EXAMPLES_LINE = /\b(\d+)\s+(?:examples?|tests?),\s+(\d+)\s+failures?\b/u;
// go test's lines (runCounts family 4): a `-v` run's, a top-level test's result, and a package's.
const GO_VERBOSE = /^(?:=== RUN\s|--- (?:PASS|FAIL|SKIP): \S)/u;
const GO_TEST = { pass: /^--- PASS: \S/u, fail: /^--- FAIL: \S/u };
const GO_PACKAGE = {
  any: /^(?:(?:ok|FAIL)\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\)|\[(?:build|setup) failed\])|\?\s+\S+\s+\[no test files\])/u,
  pass: /^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))(?!.*\[no tests to run\])/u,
  fail: /^FAIL\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\)|\[(?:build|setup) failed\])/u,
};
const BARE_FAILED = /^\s*([1-9]\d*)\s+failed\s*$/gmu;
// An ANSI colour code, which a runner wraps its summary in.
const ANSI = /\u001b\[[0-9;]*m/gu;
const lineSum = (lines, pattern) => lines.reduce((total, line) => {
  const found = pattern.exec(line);
  return found ? (total ?? 0) + Number(found[1]) : total;
}, null);
export function runCounts(output) {
  const text = typeof output === 'string' ? output.slice(-OUTPUT_TAIL) : '';
  const sum = (pattern) => {
    let total = null;
    for (const match of text.matchAll(pattern)) total = (total ?? 0) + Number(match[1]);
    return total;
  };
  const node = { pass: sum(NODE_COUNTS.pass), fail: sum(NODE_COUNTS.fail) };
  if (node.pass !== null || node.fail !== null) return node;
  const counts = familyCounts(text.split(/\r?\n/u));
  const failed = Math.max(0, ...[...text.replace(ANSI, '').matchAll(BARE_FAILED)].map((match) => Number(match[1])));
  return failed > (counts.fail ?? 0) ? { pass: counts.pass, fail: failed } : counts;
}

// The counts of the first family of summary lines in `lines` (runCounts, families 2 to 6).
function familyCounts(lines) {
  for (const family of [TESTS_LINE, CARGO_LINE, 'go', WORDS_LINE]) {
    if (family === 'go') {
      const go = goCounts(lines);
      if (go) return go;
      continue;
    }
    const held = lines.filter((line) => family.test(line));
    if (!held.length) continue;
    const pass = lineSum(held, /\b(\d+)\s+passed\b/u);
    const fail = lineSum(held, /\b(\d+)\s+failed\b/u);
    // A family with passes and no failure count has none.
    return { pass, fail: fail ?? (pass === null ? null : 0) };
  }
  const examples = lines.map((line) => EXAMPLES_LINE.exec(line)).filter(Boolean);
  // go test lines that counted nothing, and no other family: a run of no tests, which passes nothing.
  if (!examples.length) return lines.some((line) => GO_PACKAGE.any.test(line) || GO_VERBOSE.test(line)) ? { pass: 0, fail: 0 } : { pass: null, fail: null };
  const fail = examples.reduce((total, found) => total + Number(found[2]), 0);
  return { pass: examples.reduce((total, found) => total + Number(found[1]), 0) - fail, fail };
}

// go test's counts, or null when `lines` hold none of its lines. A `-v` run counts its top-level tests, and fails at
// least once a package of it failed, so a package that did not build, a test binary that timed out and panicked, or a
// TestMain that exited 1 after its tests passed fails the run. Any other run counts its packages: a package whose tests
// all were skipped or filtered out (`[no tests to run]`), or that has none, counts no pass. Either run that counts
// nothing, as one whose tests were all skipped, leaves the counts to a later family, as a script that runs go test and
// then pytest prints.
function goCounts(lines) {
  const count = (pattern) => lines.filter((line) => pattern.test(line)).length;
  const packagesFailed = count(GO_PACKAGE.fail);
  const verbose = lines.some((line) => GO_VERBOSE.test(line));
  const pass = count(verbose ? GO_TEST.pass : GO_PACKAGE.pass);
  const fail = verbose ? Math.max(count(GO_TEST.fail), packagesFailed) : packagesFailed;
  return pass + fail > 0 ? { pass, fail } : null;
}

// A run's status from its counts and whether the host saw its exit status as 0 (`exitZero`, true only when the line's
// status is the run's on a host that hooks only calls that exited 0): `unjudged` when neither says.
// SHORTCUT: a counts-only status reads the runner's summary, not the command's exit. A composite command, such as a script
// that runs the tests and then a lint that fails, reads as passed when its exit status is hidden (a pipe, or Codex).
// Its claim still names that command, so the gap is a step after the tests; an exit status from the host closes it.
export function runStatus({ pass, fail }, exitZero) {
  if (fail !== null && fail > 0) return 'failed';
  if (exitZero) return 'passed';
  if (pass === null && fail === null) return 'unjudged';
  return pass !== null && pass > 0 && fail === 0 ? 'passed' : 'failed';
}

// The most untracked code and test files a row names.
const UNTRACKED_MAX = 20;

// The trees of the checkout's files at `cwd` as they are now, as { tree, trackedTree, untrackedCode }, each tree null
// when git cannot say: `tree` with the untracked files git does not ignore, `trackedTree` with the tracked files alone, so
// a run made beside an untracked scratch file still matches the commit that leaves it out, and `untrackedCode` the
// untracked code and test files (CODE_FILE, TEST_FILE), UNTRACKED_MAX at most, which a run may have loaded: a match of
// `trackedTree` alone does not count while it names any (supports). Each tree is a copy of the index, the files added
// to it (`git add -A`, or `-u`), written as a tree; the checkout's own index is not touched.
export function workingTree(cwd, read = runGit) {
  const index = read(['rev-parse', '--path-format=absolute', '--git-path', 'index'], cwd);
  if (index.status !== 0) return { tree: null, trackedTree: null, untrackedCode: [] };
  const folder = mkdtempSync(path.join(tmpdir(), 'aidrian-tree-'));
  const write = (mode) => {
    const copy = path.join(folder, `index${mode}`);
    try {
      copyFileSync(index.stdout.trim(), copy);
    } catch {
      // No index yet: git starts an empty one.
    }
    const env = { ...process.env, GIT_INDEX_FILE: copy };
    if (read(['add', mode], cwd, { env }).status !== 0) return null;
    const tree = read(['write-tree'], cwd, { env });
    return tree.status === 0 ? tree.stdout.trim() : null;
  };
  const others = read(['ls-files', '--others', '--exclude-standard', '--full-name', ':/'], cwd);
  const untrackedCode = others.status === 0
    ? others.stdout.split('\n').filter((file) => file && (CODE_FILE.test(file) || TEST_FILE.test(file))).slice(0, UNTRACKED_MAX)
    : [];
  try {
    return { tree: write('-A'), trackedTree: write('-u'), untrackedCode };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// The last `maxBytes` of the file at `file`, an absolute path, as text, or null when it is no regular file this process
// can read. It is opened no-follow, so a symlink is never read.
export function fileTail(file, maxBytes = OUTPUT_TAIL) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  let fd;
  try {
    fd = openSync(file, READ_FILE);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const bytes = Buffer.alloc(Math.min(stat.size, maxBytes));
    const start = stat.size - bytes.length;
    let read = 0;
    for (let n = 1; n > 0 && read < bytes.length; read += n) n = readSync(fd, bytes, read, bytes.length - read, start + read);
    return bytes.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The text a call's counts are read from: `output`, or, when the host kept the call's whole output in a file,
// `persisted` as `{ file, after }`, the last OUTPUT_TAIL bytes of that file and then `after`, the text the host shows
// after it, such as stderr. A file it cannot read leaves `output`, which then holds only the head the host kept.
export function outputText(output, persisted = null) {
  const tail = persisted ? fileTail(persisted.file) : null;
  if (tail === null) return output;
  return typeof persisted.after === 'string' && persisted.after !== '' ? `${tail}\n${persisted.after}` : tail;
}

// The rows a finished shell call adds, one a test run on its top level: `exitZero` as runStatus takes it, before the
// line's own reach, and `persisted` as outputText takes it. `tree` reads a folder's trees (workingTree), once a folder;
// a row whose trees git cannot give keeps them null, so a claim it cannot support names why. `keep` picks the runs by the
// folder each runs in, as the PostToolUse hook files each run with the project it runs in; `lineRuns`, how many runs
// the whole line holds when other projects' configs read some of them, so the line's one count goes to a lone run only.
export function checkRows({
  command, cwd, output, persisted = null, exitZero, testing = {}, agentId = null, at = new Date().toISOString(), tree = workingTree, keep = () => true, lineRuns = null,
}) {
  const runs = testRuns(command, cwd, testing);
  if (!runs.length) return [];
  const counts = runCounts(outputText(output, persisted));
  const trees = new Map();
  return runs.flatMap(({ key, folder, carries }) => {
    const where = folder ?? cwd;
    if (!keep(where)) return [];
    if (!trees.has(where)) trees.set(where, tree(where) ?? {});
    const { tree: full = null, trackedTree = null, untrackedCode = [] } = trees.get(where);
    // One count for the line: with two runs on it, only the one whose status the line carries is judged by its exit.
    const own = (lineRuns ?? runs.length) === 1 ? counts : { pass: null, fail: null };
    const status = runStatus(own, exitZero && carries);
    return [{ at, agentId, command: key, tree: full, trackedTree, untrackedCode, status, pass: own.pass, fail: own.fail }];
  });
}

// Appends `rows` to the record in `folder`, which sessionFolder gave; past CHECK_RUNS_MAX_BYTES, rewrites it with the
// newest rows within half of it, then these. Returns whether it wrote. Never throws.
export function appendCheckRuns(folder, rows, options = {}) {
  if (typeof folder !== 'string' || !Array.isArray(rows) || rows.length === 0) return false;
  const read = readSessionTail(folder, CHECK_RUNS, { ...options, maxBytes: CHECK_RUNS_MAX_BYTES });
  if (read === null) return false;
  const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  if (!read.cut && Buffer.byteLength(read.text) + Buffer.byteLength(text) <= CHECK_RUNS_MAX_BYTES) {
    return appendSessionFile(folder, CHECK_RUNS, text, { ...options, maxBytes: CHECK_RUNS_MAX_BYTES });
  }
  // SHORTCUT: two hooks of one session writing together can lose a row in this rewrite, as the ledger's can. The lost
  // row is a run the next claim asks for again: the deny says to run it, and the rerun writes it.
  const lines = read.text.split('\n').slice(read.cut ? 1 : 0, -1);
  const kept = [];
  let bytes = 0;
  for (const line of lines.reverse()) {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > CHECK_RUNS_MAX_BYTES / 2) break;
    kept.unshift(`${line}\n`);
  }
  return writeSessionFile(folder, CHECK_RUNS, kept.join('') + text, options) !== null;
}

// The record's rows in `folder`, oldest first, or null when it cannot be read as the session folder's rules allow.
export function readCheckRuns(folder, options = {}) {
  if (typeof folder !== 'string') return null;
  const read = readSessionTail(folder, CHECK_RUNS, { ...options, maxBytes: CHECK_RUNS_MAX_BYTES });
  if (read === null) return null;
  return read.text.split('\n').slice(read.cut ? 1 : 0, -1).flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return row && typeof row === 'object' && typeof row.command === 'string' && typeof row.status === 'string' ? [row] : [];
    } catch {
      return [];
    }
  });
}

// A clause that says a run passed: a pass word, a check mark, or "N/N".
const PASS_WORD = /\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|all\s+\d+\s+tests?)\b|[✓✔]|\b\d+\s*\/\s*\d+\b/iu;
// A clause that reports a failure or an unfinished run, which claims no pass: a fail word with no count or a count above 0.
const FAIL_WORD = /\bnot\s+finished\b|\b(?:failed|failing|red|timed\s+out|stopped|interrupted)\b|\b[1-9]\d*\s+(?:fail(?:s|ed|ures?)?)\b|\bfail(?:s|ures?)?\s*:?\s*[1-9]/iu;
// A clause about CI, which the record cannot see: its results are quoted from the forge.
const CI_WORD = /\bCI\b|\bpipeline\b|\bworkflow\b/u;
// An outside source a report may quote: another agent, a pull request, an issue, a review. The writer's own words are
// none: a report, handoff, or review after "this", "my", or "our", with at most one word between, as "my final report";
// "this agent" and "this subagent"; "the test report"; and "the test output" or "my run", which name no source here.
// "My subagent" is another agent.
const SELF = String.raw`(?<!\b(?:this|my|our)\s+(?:[A-Za-z-]+\s+)?)`;
const SOURCE = String.raw`(?:pull\s+request|PR|body|description|reviewer|${SELF}review|(?<!\bthis\s)subagent|(?<!\bthis\s)agent|dispatcher|issue|ticket|comment|thread|${SELF}handoff|${SELF}(?<!\btest\s)report|brief|author|commit\s+message|bot)`;
const SAYS = String.raw`(?:says?|said|claim(?:s|ed)?|states?|stated|reports?|reported|writes|wrote|lists?|listed|quotes?|quoted|asserts?|asserted)`;
// A clause an outside source governs: one that opens with "according to" it, or a part of it, split at a coordinating
// "and", in which a source and a verb of saying come right before the command (saidBefore, built with the suites).
const ACCORDING = new RegExp(String.raw`^\W*according\s+to\s+(?:\S+\s+){0,2}?${SOURCE}\b`, 'iu');
const commandWords = (suites) => ['`[^`\\n]*`', ...suites.map((suite) => `(?<![\\w-])${escape(suite)}\\b`)];
const saidBefore = (suites) => {
  const command = ['`', ...suites.map((suite) => `${escape(suite)}\\b`)].join('|');
  return new RegExp(String.raw`\b${SOURCE}(?:'s)?\s+(?:\S+\s+){0,2}?${SAYS}(?:\s+that)?\s*:?\s+["“]?(?=${command})`, 'iu');
};
// A part that ends at its list of commands, with no predicate after them, as "the PR body says `npm test`" before
// "and `vitest run` passed": what the source says of them follows.
const endsAtCommand = (suites) => new RegExp(`(?:${commandWords(suites).join('|')})[\\s,.;:]*$`, 'u');

// The most JSON values a report's reading parses (reportTexts): past it, a fence stays fenced code and a `{` line text.
const HANDOFF_PARSES = 100;

// The texts of a report, each its writer's own, read in one pass over its lines with fences found as unfencedLines
// finds them. A machine handoff's JSON gives each string value of it as a text: a ```json fence whose content parses,
// or an object that opens on a line starting with `{` outside any fence. Any other fence, a ```jsonc one or a ```json
// one that does not parse, stays fenced code, and the prose around them is text, so a claim after a fence still counts.
function reportTexts(report) {
  const lines = report.split(/\r?\n/u);
  const fenced = fencedLines(report);
  const texts = [];
  let prose = [];
  let parses = 0;
  const handoff = (value) => {
    if (prose.length) texts.push(prose.join('\n'));
    prose = [];
    for (const text of stringsOf(value)) texts.push(text);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fenced[index]) {
      const { end, last } = fenceBlock(lines, fenced, index);
      const json = /^\s*(?:`{3,}|~{3,})\s*json\s*$/iu.test(line) && parses < HANDOFF_PARSES;
      parses += json ? 1 : 0;
      const value = json ? parsed(lines.slice(index + 1, end).join('\n')) : undefined;
      if (value !== null && typeof value === 'object') handoff(value);
      else for (const each of lines.slice(index, last + 1)) prose.push(each);
      index = last;
    } else if (line.startsWith('{') && parses < HANDOFF_PARSES) {
      parses += 1;
      const object = bareObject(lines, index);
      if (!object) {
        prose.push(line);
        continue;
      }
      handoff(object.value);
      if (object.after.trim()) prose.push(object.after);
      index = object.through;
    } else {
      prose.push(line);
    }
  }
  if (prose.length) texts.push(prose.join('\n'));
  return texts;
}

// The fenced block that opens on line `index` of `lines`, `fenced` marking each fenced line (fencedLines), as
// { end, last }: `end` the closing fence's line, or the first line past the block when none closes it, and `last` the
// block's last line.
function fenceBlock(lines, fenced, index) {
  const open = fenceOf(lines[index]);
  let end = index + 1;
  while (end < lines.length && fenced[end] && !(open && closes(fenceOf(lines[end]), open))) end += 1;
  return { end, last: end < lines.length && fenced[end] ? end : end - 1 };
}

// The JSON object that opens on line `index` of `lines`, as { value, through, after }: the line it ends on, and the
// text after it there; or null when it does not close or parse.
function bareObject(lines, index) {
  const rest = lines.slice(index).join('\n');
  const end = jsonEnd(rest, 0);
  const value = end === null ? undefined : parsed(rest.slice(0, end));
  if (value === undefined) return null;
  const text = rest.slice(0, end);
  const through = index + (text.match(/\n/gu)?.length ?? 0);
  return { value, through, after: lines[through].slice(end - text.lastIndexOf('\n') - 1) };
}

// `text` parsed as JSON, or undefined when it does not parse.
function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The index after the JSON value that opens at `start` of `text`, by its brackets outside strings, or null.
function jsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if ((char === '}' || char === ']') && --depth === 0) {
      return index + 1;
    }
  }
  return null;
}

// Every string value in a parsed JSON value, in order.
// Read with a stack, not recursion, so no nesting depth throws.
function stringsOf(value) {
  const strings = [];
  const stack = [value];
  while (stack.length) {
    const next = stack.pop();
    if (typeof next === 'string') strings.push(next);
    else if (next !== null && typeof next === 'object') {
      // One push a value, from the last, so the first is read first; a spread of a large array would throw.
      const values = Object.values(next);
      for (let index = values.length - 1; index >= 0; index -= 1) stack.push(values[index]);
    }
  }
  return strings;
}

// A Markdown block quote line.
const BLOCK_QUOTE = /^\s{0,3}>/u;
// A commit id a clause names: 7 to 40 hex digits with at least one letter, so no count reads as one, or digits alone
// after "at" or "commit", in backticks or not, as about one abbreviated id in 27 is. Digits alone may still be a time
// or a date, so the pull request body rule takes them only when git knows the commit.
const COMMIT_ID = /\b(?:(?=[0-9]*[a-f])[0-9a-f]{7,40}|(?<=\b(?:[Aa]t|[Cc]ommit)\s+`?)[0-9]{7,40})\b/gu;
// The pass counts a clause states: "4071/4071", "12 pass", "pass 12", "12 tests passed". A number after a word, as in
// "Node 22 pass", is a name, not a count, but after "all" or "only".
const PASS_COUNT = /(?<!\b(?!all\b|only\b)[A-Za-z]+\s)\b(\d+)\s*\/\s*\d+\b|(?<!\b(?!all\b|only\b)[A-Za-z]+\s)\b(\d+)\s+(?:tests?\s+)?pass(?:es|ed|ing)?\b|\bpass(?:es|ed)?\s*:?\s+(\d+)\b/giu;

// The claims of a passing test run in the `## <section>` section of `body`, or in the whole of it when `section` is null,
// outside fenced code: one a clause of a list item or paragraph, its wrapped lines joined, split at `;` and sentence
// ends, that names a test command and a pass, and neither a failure nor CI. A command is named in backticks, or, for a
// `testing.fullSuite` command, also as plain words.
// Each is { clause, key, counts, commits }: `key` the command's (commandKey), `counts` the pass counts it states, and
// `commits` the commit ids it names, such as "at 056c3c2", which the pull request body rule reads the tree of.
// `ownOnly` leaves out what the text quotes from another: block quote lines, and what an outside source governs
// (ownClause). Words in double quotes are the writer's, as "reported \"126/126 pass\"" quotes its own run. A whole report
// (`section` null) with a machine handoff's JSON object is read a string value at a time (reportTexts). A subagent's
// report quotes other agents and pull request bodies; a pull request body's `## Tests run` section is its author's own,
// so that rule reads every line.
export function passClaims(body, { section = 'Tests run', testing = {}, ownOnly = false } = {}) {
  const suites = (testing.fullSuite ?? []).map(keyOfText).filter(Boolean);
  const own = { said: saidBefore(suites), ends: endsAtCommand(suites) };
  const texts = ownOnly && section === null ? reportTexts(String(body)) : [body];
  return texts.flatMap((text) => textClaims(text, { section, testing, ownOnly, suites, own }));
}

// The claims of one text, as passClaims reads them.
function textClaims(body, { section, testing, ownOnly, suites, own }) {
  let lines = section === null ? [...unfencedLines(body)] : sectionLines(body, section);
  // A block quote line ends its paragraph, as a blank line does.
  if (ownOnly) lines = lines?.map((line) => (BLOCK_QUOTE.test(line) ? '' : line));
  const claims = [];
  for (const unit of units(lines ?? [])) {
    for (const written of unit.split(/;\s+|\.\s+(?=[A-Z`])/u)) {
      const clause = ownOnly ? ownClause(written, own) : written;
      if (!PASS_WORD.test(clause) || FAIL_WORD.test(clause) || CI_WORD.test(clause)) continue;
      const keys = [...clause.matchAll(/`([^`\n]+)`/gu)].flatMap(([, code]) => {
        const [segment] = lexPipeline(code).segments.filter((each) => !CHANGES_DIRECTORY.has(readInvocation(each).program));
        const invocation = segment ? readInvocation(segment) : null;
        return invocation && isTestRun(invocation, testing) ? [commandKey(invocation)] : [];
      });
      const bare = clause.replace(/`[^`\n]*`/gu, ' ');
      for (const suite of suites) if (new RegExp(`(?:^|[\\s(])${escape(suite)}(?=$|[\\s:,.)])`, 'u').test(bare)) keys.push(capped(suite));
      const counts = [...clause.matchAll(PASS_COUNT)].map((match) => Number(match[1] ?? match[2] ?? match[3]));
      const commits = [...clause.matchAll(COMMIT_ID)].map((match) => match[0]);
      for (const key of new Set(keys)) claims.push({ clause: clause.trim(), key, counts, commits });
    }
  }
  return claims;
}

// The part of `clause` that is the writer's own: '' when it opens with "according to" an outside source, else its parts,
// split at a coordinating "and", but those in which an outside source says the command (`said`). A dropped part that
// ends at its list of commands (`ends`) carries the saying into the next part, whose predicate is the source's:
// "the PR body says `npm test` and `vitest run` passed" is all the body's, while in "the issue says `npm test` hangs,
// and `vitest run` passed 3/3" the second part is the writer's. "Fixed the issue reported in the ticket and `npm test`
// passed" keeps its claim.
function ownClause(clause, { said, ends }) {
  if (ACCORDING.test(clause)) return '';
  const parts = clause.split(/(,?\s+and\s+)/iu);
  const kept = [];
  let carried = false;
  for (let index = 0; index < parts.length; index += 2) {
    const part = parts[index];
    const dropped = carried || said.test(part);
    carried = dropped && ends.test(part);
    // A joining "and" stays before a kept part that follows another kept one.
    if (!dropped) kept.push(kept.length ? parts[index - 1] : '', part);
  }
  return kept.join('');
}

// The list items and paragraphs of `lines`, each one string: a list marker starts one, a blank line or a heading ends it,
// and any other line continues it, as a wrapped line does.
function units(lines) {
  const out = [];
  let open = null;
  for (const line of lines) {
    if (line.trim() === '' || /^\s{0,3}#/u.test(line)) {
      open = null;
    } else if (open === null || /^\s*(?:[-*+]|\d+[.)])\s/u.test(line)) {
      out.push(line.trim());
      open = out.length - 1;
    } else {
      out[open] += ` ${line.trim()}`;
    }
  }
  return out;
}

// Whether a row supports a claim at `tree`: the same command, passed with more than 0 passes when it printed a count
// (a run of no tests proves nothing), at that tree when one is given, and with each count the claim states. The tree is
// the row's full one, or its tracked one only while no untracked code or test file sat beside the run, which it may
// have loaded and the commit lacks.
const atTree = (run, tree) => tree === null || run.tree === tree || (run.trackedTree === tree && !run.untrackedCode?.length);
const supports = (run, { key, counts }, tree) => run.command === key && run.status === 'passed' && run.pass !== 0
  && atTree(run, tree) && (run.pass === null || run.pass === undefined || counts.every((count) => count === run.pass));

// The claims no row of `runs` supports (supports).
export function unsupportedClaims(claims, runs, { tree = null } = {}) {
  return claims.filter((claim) => !runs.some((run) => supports(run, claim, tree)));
}

// What a report is told about `missing` claims: what was looked for and what the record holds.
export function claimProblem(missing, runs, { where }) {
  const named = [...new Set(missing.map(({ key }) => `\`${key}\``))].join(', ');
  const held = runs.filter((run) => missing.some(({ key }) => run.command === key));
  const counted = (run) => (run.pass === null && run.fail === null ? '' : ` (pass ${run.pass ?? 'unknown'}, fail ${run.fail ?? 'unknown'})`);
  const at = (run) => (run.tree ? `at tree ${String(run.tree).slice(0, 12)}` : 'at a tree git could not read');
  const shown = held.slice(-3).map((run) => `${run.status}${counted(run)} ${at(run)}`);
  // A run of the same program with other words, such as other test files, is named, since a claim quotes its run as it ran.
  const runner = (key) => key.split(' ')[0];
  const near = held.length ? [] : [...new Set(runs.filter((run) => missing.some(({ key }) => runner(run.command) === runner(key))).map((run) => run.command))].slice(-3);
  const clip = (command) => (command.length > 120 ? `${command.slice(0, 120)}…` : command);
  const others = near.length ? ` Its runs of \`${runner(missing[0].key)}\` ran other words: ${near.map((command) => `\`${clip(command)}\``).join(', ')}; quote the command as it ran.` : '';
  const record = held.length ? `The record holds ${shown.join('; ')}.` : `The record holds no finished run of it.${others}`;
  const stated = missing.some((each) => each.counts.length) ? 'with the count it states, ' : '';
  const beside = [...new Set(held.flatMap((run) => run.untrackedCode ?? []))];
  const untracked = beside.length
    ? ` Untracked code beside the run, which the commit lacks: ${beside.map((file) => `\`${file}\``).join(', ')}; \`git add\` it, or remove it, and rerun.`
    : '';
  return `${where} says ${named} passed, but no run of it that a shell call finished with a pass, ${stated}` +
    `is on this session's record. ${record}${untracked} Quote only output a tool returned in this session; a run stopped or still running ` +
    'is "not finished", never a result, and a CI result is quoted from the checks the forge shows. ' +
    'To get a result, run the command in the foreground to its end, or `aidrian test changed` for the test files this change touches.';
}

// What clears one claim no run supports at `tree`, as one sentence, cheapest true fix first: the count the run at
// these files printed; a run of the same program with other words, to quote as its shell call ran it; the commit its
// last pass was of, from `commitOf(tree)`, a commit id or null; or the run to make, and why its runs left no pass.
// `named` is the commit the claim's own line names, or null. A record key is not the command as typed: it drops quotes
// and a long one is cut, so a fix never hands one back as a command to run or paste, only as a name for the run.
export function claimFix({ key, counts }, runs, { tree, commitOf = () => null, named = null }) {
  const own = runs.filter((run) => run.command === key);
  const passed = (run) => run.status === 'passed' && run.pass !== 0;
  const passes = (run) => (typeof run.pass === 'number' ? `${run.pass} passes` : 'a pass');
  const keep = named ? `, and keep "at ${named.slice(0, 7)}"` : '';
  const drop = named ? ` and drop "at ${named.slice(0, 7)}" from the line` : '';
  const rerun = `rerun it, the exact command copied from the call that ran it, in the foreground at HEAD${drop}`;
  const here = own.filter((run) => passed(run) && atTree(run, tree)).at(-1);
  if (here) return `its run at these files printed ${passes(here)}, and the line states ${counts.join(', ')}: write the count it printed${keep}.`;
  const runner = key.split(' ')[0];
  const other = runs.filter((run) => run.command !== key && run.command.split(' ')[0] === runner && passed(run) && atTree(run, tree)).at(-1);
  if (other) {
    return `a run of \`${runner}\` with other words, recorded as \`${other.command}\`, passed at these files with ${passes(other)}: ` +
      `quote that command as its shell call ran it, copied from that call${keep}.`;
  }
  const earlier = own.filter(passed).at(-1);
  if (earlier) {
    const commit = commitOf(earlier.tree) ?? (earlier.untrackedCode?.length ? null : commitOf(earlier.trackedTree));
    if (!commit) return `its last pass was of other files, and no commit among HEAD's last 100 holds them, or git could not list them: ${rerun}.`;
    return `its last pass was of commit ${commit.slice(0, 7)}, and the files have changed since: ${rerun}, ` +
      `or say which commit it ran on, with "at ${commit.slice(0, 7)}" in the line${named ? ` in place of "at ${named.slice(0, 7)}"` : ''}.`;
  }
  const last = own.at(-1);
  // A run of no tests is a pass when the line's status was its own, and a failure by its counts behind a pipe (runStatus).
  if (last?.pass === 0 && !last.fail) return `its run finished and ran zero tests: check the test selection, such as its file paths or name pattern, then ${rerun}.`;
  if (last?.status === 'unjudged') {
    return 'its runs printed no test count in the output the call returned, as when a `tail` cuts the summary or a redirect ' +
      `sends it to a file, and a pipe or \`;\` hid their exit status: ${rerun}, with its summary in the output and nothing ` +
      'but `&&` around it.';
  }
  if (last?.status === 'failed') return `its last run failed, and a failed run is no pass: fix what failed, then ${rerun}.`;
  return 'no shell call of this session finished it, and a run in the background, inside `sh -c` or `$( )`, or in another ' +
    `session leaves no row: run the command the line names in the foreground at HEAD, as a call of its own${drop}.`;
}
