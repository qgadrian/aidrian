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

import { closeSync, constants, copyFileSync, fstatSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runGit } from './git.mjs';
import { sectionLines, unfencedLines } from './markdown-sections.mjs';
import { appendSessionFile, readSessionTail, writeSessionFile } from './session-folder.mjs';
import { aidrianArgs, lexPipeline, readInvocation, walkCommands } from './shell-lex.mjs';

// The record's name in the session folder (lib/session-folder.mjs APPENDED_FILES), and the most it grows: a write that
// would pass it keeps the newest rows within half of it.
export const CHECK_RUNS = 'checks.jsonl';
export const CHECK_RUNS_MAX_BYTES = 64 * 1024;
// How much of a call's output is read, from its end, for the counts: of its text, or of the file the host kept it in.
const OUTPUT_TAIL = 64 * 1024;
const READ_FILE = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
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

// The words of a readInvocation result, wrappers that run a test runner peeled, joined by spaces: the key a run and a
// claim are matched by. `rtk npm run check 2>&1` and `npm run check` are one key.
export function commandKey(invocation) {
  const own = aidrianArgs(invocation);
  if (own) return ['aidrian', ...own.map((token) => token.text)].join(' ').slice(0, COMMAND_MAX);
  let words = [invocation.program, ...invocation.args.map((token) => token.text)].filter((word) => typeof word === 'string' && word !== '');
  for (let peeled = 0; peeled < 3 && RUNNER_WRAPPERS.has(words[0]); peeled += 1) {
    const after = RUNNER_WRAPPERS.get(words[0]);
    if (after === 0) words = words.slice(1);
    else if (words[1] === after) words = words.slice(2);
    else break;
  }
  if (words[0] !== undefined) words[0] = path.basename(words[0]);
  return words.join(' ').slice(0, COMMAND_MAX);
}

// Whether the readInvocation result runs tests: a word list of TEST_PREFIXES, a configured full suite or changed-files
// command, `node --test`, or `aidrian test changed`.
export function isTestRun(invocation, testing = {}) {
  if (invocation.dynamic) return false;
  const words = aidrianArgs(invocation)?.map((token) => token.text);
  if (words) return words[0] === 'test' && words[1] === 'changed';
  const key = commandKey(invocation);
  if (key.startsWith('node ') && key.split(' ').includes('--test')) return true;
  const configured = [...(testing.fullSuite ?? []), ...(testing.changedCommand ? [testing.changedCommand] : [])].map(keyOfText);
  return [...TEST_PREFIXES, ...configured].some((prefix) => prefix && startsWith(key, prefix));
}

// The key of a command written as text, such as a config entry: its first command's.
function keyOfText(text) {
  const [segment] = lexPipeline(String(text)).segments;
  return segment ? commandKey(readInvocation(segment)) : '';
}

// Whether the readInvocation result runs one of `testing.fullSuite` as written, with no more arguments: `npm test -- f`
// runs one file, and is no full suite.
export const isFullSuite = (invocation, testing = {}) => !invocation.dynamic && (testing.fullSuite ?? []).map(keyOfText).includes(commandKey(invocation));

// The test runs on the top level of `command`, as { key, folder, carries }: `folder` the folder it runs in (shell-lex
// walkCommands), and `carries` whether the line's exit status of 0 says the run exited 0: no separator before or after it
// but `&&`. After `;` or `||` the run may not have run at all, or another command's status is the line's.
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
    if (segment.length === 0 || !isTestRun(invocation, testing)) return;
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
// 4. go test's: with `-v`, the `--- PASS: TestX` and `--- FAIL: TestX` lines at the start of a line, one a top-level
//    test, subtests left out; else, since go test prints no pass count, the `ok  <package>  0.01s` and
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
const GO_TESTS = { pass: /^--- PASS: \S/u, fail: /^--- FAIL: \S/u };
const GO_PACKAGES = { pass: /^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))/u, fail: /^FAIL\s+\S+\s+(?:\d+(?:\.\d+)?s|\[(?:build|setup) failed\])/u };
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
  for (const family of [TESTS_LINE, CARGO_LINE, GO_TESTS, GO_PACKAGES, WORDS_LINE]) {
    if (!(family instanceof RegExp)) {
      // A go family counts its lines, one a test or a package.
      const pass = lines.filter((line) => family.pass.test(line)).length;
      const fail = lines.filter((line) => family.fail.test(line)).length;
      if (pass + fail > 0) return { pass, fail };
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
  if (!examples.length) return { pass: null, fail: null };
  const fail = examples.reduce((total, found) => total + Number(found[2]), 0);
  return { pass: examples.reduce((total, found) => total + Number(found[1]), 0) - fail, fail };
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
// a row whose trees git cannot give keeps them null, so a claim it cannot support names why.
export function checkRows({ command, cwd, output, persisted = null, exitZero, testing = {}, agentId = null, at = new Date().toISOString(), tree = workingTree }) {
  const runs = testRuns(command, cwd, testing);
  if (!runs.length) return [];
  const counts = runCounts(outputText(output, persisted));
  const trees = new Map();
  return runs.map(({ key, folder, carries }) => {
    const where = folder ?? cwd;
    if (!trees.has(where)) trees.set(where, tree(where) ?? {});
    const { tree: full = null, trackedTree = null, untrackedCode = [] } = trees.get(where);
    // One count for the line: with two runs on it, only the one whose status the line carries is judged by its exit.
    const own = runs.length === 1 ? counts : { pass: null, fail: null };
    const status = runStatus(own, exitZero && carries);
    return { at, agentId, command: key, tree: full, trackedTree, untrackedCode, status, pass: own.pass, fail: own.fail };
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
// A clause that gives the claim to another source, as "the pull request body says `npm test` passed" or "according to
// the reviewer": a source, at most two words, then a verb of saying. "The output says" is the writer's own run.
const SOURCE = String.raw`(?:pull\s+request|PR|body|description|reviewer|review|agent|subagent|dispatcher|issue|ticket|comment|thread|handoff|report|brief|author|commit\s+message|bot)`;
const SAYS = String.raw`(?:says?|said|claim(?:s|ed)?|states?|stated|reports?|reported|writes|wrote|lists?|listed|quotes?|quoted|asserts?|asserted)`;
const ATTRIBUTED = new RegExp(String.raw`\b${SOURCE}(?:'s)?\s+(?:\S+\s+){0,2}?${SAYS}\b|\baccording\s+to\b`, 'iu');
// A span in double quotes, straight or curly: words quoted from another.
const QUOTED_SPAN = /"[^"\n]*"|“[^”\n]*”/gu;
// A Markdown block quote line.
const BLOCK_QUOTE = /^\s{0,3}>/u;
// A commit id a clause names: 7 to 40 hex digits with at least one letter, so no count reads as one.
const COMMIT_ID = /\b(?=[0-9]*[a-f])[0-9a-f]{7,40}\b/gu;
// The pass counts a clause states: "4071/4071", "12 pass", "pass 12", "12 tests passed". A number after a word, as in
// "Node 22 pass", is a name, not a count, but after "all" or "only".
const PASS_COUNT = /(?<!\b(?!all\b|only\b)[A-Za-z]+\s)\b(\d+)\s*\/\s*\d+\b|(?<!\b(?!all\b|only\b)[A-Za-z]+\s)\b(\d+)\s+(?:tests?\s+)?pass(?:es|ed|ing)?\b|\bpass(?:es|ed)?\s*:?\s+(\d+)\b/giu;

// The claims of a passing test run in the `## <section>` section of `body`, or in the whole of it when `section` is null,
// outside fenced code: one a clause of a list item or paragraph, its wrapped lines joined, split at `;` and sentence
// ends, that names a test command and a pass, and neither a failure nor CI. A command is named in backticks, or, for a
// `testing.fullSuite` command, also as plain words.
// Each is { clause, key, counts, commits }: `key` the command's (commandKey), `counts` the pass counts it states, and
// `commits` the commit ids it names, such as "at 056c3c2", which the pull request body rule reads the tree of.
// `ownOnly` leaves out what the text quotes: block quote lines, spans in double quotes, and a clause that gives its
// claim to another source (ATTRIBUTED). A subagent's report quotes other agents and pull request bodies; a pull request
// body's `## Tests run` section is its author's own, so that rule reads every line of it.
export function passClaims(body, { section = 'Tests run', testing = {}, ownOnly = false } = {}) {
  let lines = section === null ? [...unfencedLines(body)] : sectionLines(body, section);
  // A block quote line ends its paragraph, as a blank line does.
  if (ownOnly) lines = lines?.map((line) => (BLOCK_QUOTE.test(line) ? '' : line));
  const suites = (testing.fullSuite ?? []).map(keyOfText).filter(Boolean);
  const claims = [];
  for (const unit of units(lines ?? [])) {
    for (const written of unit.split(/;\s+|\.\s+(?=[A-Z`])/u)) {
      if (ownOnly && ATTRIBUTED.test(written)) continue;
      const clause = ownOnly ? written.replace(QUOTED_SPAN, ' ') : written;
      if (!PASS_WORD.test(clause) || FAIL_WORD.test(clause) || CI_WORD.test(clause)) continue;
      const keys = [...clause.matchAll(/`([^`\n]+)`/gu)].flatMap(([, code]) => {
        const [segment] = lexPipeline(code).segments.filter((each) => !CHANGES_DIRECTORY.has(readInvocation(each).program));
        const invocation = segment ? readInvocation(segment) : null;
        return invocation && isTestRun(invocation, testing) ? [commandKey(invocation)] : [];
      });
      const bare = clause.replace(/`[^`\n]*`/gu, ' ');
      for (const suite of suites) if (new RegExp(`(?:^|[\\s(])${escape(suite)}(?=$|[\\s:,.)])`, 'u').test(bare)) keys.push(suite);
      const counts = [...clause.matchAll(PASS_COUNT)].map((match) => Number(match[1] ?? match[2] ?? match[3]));
      const commits = [...clause.matchAll(COMMIT_ID)].map((match) => match[0]);
      for (const key of new Set(keys)) claims.push({ clause: clause.trim(), key, counts, commits });
    }
  }
  return claims;
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
  const record = held.length ? `The record holds ${shown.join('; ')}.` : 'The record holds no finished run of it.';
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
