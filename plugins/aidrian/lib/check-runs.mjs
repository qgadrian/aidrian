// The check-run record (docs/hooks.md#check-runs): the test runs a session's shell calls finished, and what each showed.
// scripts/hook-bash-post.mjs appends one row a test command a call ran to its end, to `checks.jsonl` in the session folder
// (lib/session-folder.mjs); a run started in the background, moved there at its timeout, or stopped leaves no row, since
// no hook sees it end. The pull request body rule (lib/rules/github/pr-body.mjs) and the subagent stop hook read it back:
// a line of a report that says a test command passed needs a row of that command that passed (unsupportedClaims).
// The push-first rule (lib/rules/push-first.mjs) reads `isFullSuite` from here too.
//
// A row is `{ at, agentId, command, tree, status, pass, fail }`: `command` the test invocation's words with wrappers
// and redirects dropped (commandKey), `tree` the git tree of the folder's files as they were when it ran, uncommitted
// changes included (workingTree), and `status` `passed` or `failed`. On a host whose PostToolUse comes only for a call
// that exited 0, as Claude Code's, a run whose status reaches the call's own (the last command of the line, or joined to
// the end by `&&`) passed unless its counts show a failure. Any other run, and every run on a host that sends the hook
// failed calls too, as Codex, is judged by its counts alone: passed only with a pass count above 0 and a fail count of 0.

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
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
// How much of a call's output is read, from its end, for the counts.
const OUTPUT_TAIL = 64 * 1024;
const COMMAND_MAX = 300;

// Programs that run a command given after them: `npx vitest`, `pnpm exec jest`, `python -m pytest`, `bundle exec rspec`.
const RUNNER_WRAPPERS = new Map([['npx', 0], ['bunx', 0], ['pnpx', 0], ['pnpm', 'exec'], ['yarn', 'exec'], ['bundle', 'exec'], ['python', '-m'], ['python3', '-m']]);
// Word lists that start a test run, after RUNNER_WRAPPERS are peeled.
const TEST_PREFIXES = [
  ['npm', 'test'], ['npm', 't'], ['npm', 'run', 'test'], ['npm', 'run', 'check'], ['pnpm', 'test'], ['pnpm', 'run', 'test'],
  ['yarn', 'test'], ['yarn', 'run', 'test'], ['bun', 'run', 'test'], ['vitest'], ['jest'], ['pytest'], ['go', 'test'],
  ['cargo', 'test'], ['mix', 'test'], ['rspec'], ['make', 'test'], ['make', 'check'], ['playwright', 'test'],
].map((words) => words.join(' '));

const CHANGES_DIRECTORY = new Set(['cd', 'pushd', 'popd']);

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
// walkCommands), and `carries` whether the line's own exit status is the run's: no separator after it but `&&`.
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
    const carries = separators.slice(index).every((separator) => separator === '&&' || separator === null || separator === undefined);
    runs.push({ key: commandKey(invocation), folder: entry?.folder ?? null, carries });
  });
  return runs;
}

// The pass and fail counts a run printed, summed over every summary in the output's tail, or null for each it never
// printed: node's test runner (`ℹ pass 12`, TAP `# fail 0`), else the "12 passed, 1 failed" of vitest, jest, and pytest.
// Node's summary, when there is one, is the only one read: a script around the runner may print other "passed" lines.
const NODE_COUNTS = { pass: /^\s*(?:ℹ|#)\s*pass\s+(\d+)\s*$/gmu, fail: /^\s*(?:ℹ|#)\s*fail\s+(\d+)\s*$/gmu };
const WORD_COUNTS = { pass: /\b(\d+)\s+passed\b/gu, fail: /\b(\d+)\s+failed\b/gu };
export function runCounts(output) {
  const text = typeof output === 'string' ? output.slice(-OUTPUT_TAIL) : '';
  const sum = (pattern) => {
    let total = null;
    for (const match of text.matchAll(pattern)) total = (total ?? 0) + Number(match[1]);
    return total;
  };
  const node = { pass: sum(NODE_COUNTS.pass), fail: sum(NODE_COUNTS.fail) };
  if (node.pass !== null || node.fail !== null) return node;
  return { pass: sum(WORD_COUNTS.pass), fail: sum(WORD_COUNTS.fail) };
}

// A run's status from its counts and whether the host saw its exit status as 0 (`exitZero`, true only when the line's
// status is the run's on a host that hooks only calls that exited 0).
export function runStatus({ pass, fail }, exitZero) {
  if (fail !== null && fail > 0) return 'failed';
  if (exitZero) return 'passed';
  return pass !== null && pass > 0 && fail === 0 ? 'passed' : 'failed';
}

// The tree of the checkout's files at `cwd` as they are now, untracked files git does not ignore included, or null when
// git cannot say: a copy of the index, the files added to it, written as a tree. The checkout's own index is not touched.
export function workingTree(cwd, read = runGit) {
  const index = read(['rev-parse', '--path-format=absolute', '--git-path', 'index'], cwd);
  if (index.status !== 0) return null;
  const folder = mkdtempSync(path.join(tmpdir(), 'aidrian-tree-'));
  try {
    const copy = path.join(folder, 'index');
    try {
      copyFileSync(index.stdout.trim(), copy);
    } catch {
      // No index yet: git starts an empty one.
    }
    const env = { ...process.env, GIT_INDEX_FILE: copy };
    if (read(['add', '-A'], cwd, { env }).status !== 0) return null;
    const tree = read(['write-tree'], cwd, { env });
    return tree.status === 0 ? tree.stdout.trim() : null;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// The rows a finished shell call adds, one a test run on its top level: `exitZero` as runStatus takes it, before the
// line's own reach. `tree` reads a folder's tree (workingTree), once a folder.
export function checkRows({ command, cwd, output, exitZero, testing = {}, agentId = null, at = new Date().toISOString(), tree = workingTree }) {
  const runs = testRuns(command, cwd, testing);
  if (!runs.length) return [];
  const counts = runCounts(output);
  const trees = new Map();
  return runs.flatMap(({ key, folder, carries }) => {
    const where = folder ?? cwd;
    if (!trees.has(where)) trees.set(where, tree(where));
    const sha = trees.get(where);
    if (!sha) return [];
    // One count for the line: with two runs on it, only the one whose status the line carries is judged by its exit.
    const own = runs.length === 1 ? counts : { pass: null, fail: null };
    return [{ at, agentId, command: key, tree: sha, status: runStatus(own, exitZero && carries), pass: own.pass, fail: own.fail }];
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
const CI_WORD = /\bCI\b|\bGitHub Actions\b|\bworkflow\b|\bgh pr checks\b/u;
// The pass counts a clause states: "4071/4071", "12 pass", "pass 12", "12 tests passed".
const PASS_COUNT = /\b(\d+)\s*\/\s*\d+\b|\b(\d+)\s+(?:tests?\s+)?pass(?:es|ed|ing)?\b|\bpass(?:es|ed)?\s*:?\s+(\d+)\b/giu;

// The claims of a passing test run in the `## <section>` section of `body`, or in the whole of it when `section` is null,
// outside fenced code: one a clause, split at `;` and sentence ends, that names a test command and a pass, and neither a
// failure nor CI. A command is named in backticks, or, for a `testing.fullSuite` command, also as plain words.
// Each is { clause, key, counts }: `key` the command's (commandKey), `counts` the pass counts it states.
export function passClaims(body, { section = 'Tests run', testing = {} } = {}) {
  const lines = section === null ? [...unfencedLines(body)] : sectionLines(body, section);
  const suites = (testing.fullSuite ?? []).map(keyOfText).filter(Boolean);
  const claims = [];
  for (const line of lines ?? []) {
    for (const clause of line.split(/;\s+|\.\s+(?=[A-Z`])/u)) {
      if (!PASS_WORD.test(clause) || FAIL_WORD.test(clause) || CI_WORD.test(clause)) continue;
      const keys = [...clause.matchAll(/`([^`\n]+)`/gu)].flatMap(([, code]) => {
        const [segment] = lexPipeline(code).segments.filter((each) => !CHANGES_DIRECTORY.has(readInvocation(each).program));
        const invocation = segment ? readInvocation(segment) : null;
        return invocation && isTestRun(invocation, testing) ? [commandKey(invocation)] : [];
      });
      const bare = clause.replace(/`[^`\n]*`/gu, ' ');
      for (const suite of suites) if (new RegExp(`(?:^|[\\s(])${escape(suite)}(?=$|[\\s:,.)])`, 'u').test(bare)) keys.push(suite);
      const counts = [...clause.matchAll(PASS_COUNT)].map((match) => Number(match[1] ?? match[2] ?? match[3]));
      for (const key of new Set(keys)) claims.push({ clause: clause.trim(), key, counts });
    }
  }
  return claims;
}

// The claims no row of `runs` supports: a row of the same command that passed, of `tree` when one is given, whose pass
// count, when it printed one, is each count the claim states.
export function unsupportedClaims(claims, runs, { tree = null } = {}) {
  return claims.filter(({ key, counts }) => !runs.some((run) => run.command === key && run.status === 'passed'
    && (tree === null || run.tree === tree)
    && (run.pass === null || run.pass === undefined || counts.every((count) => count === run.pass))));
}

// What a report is told about `missing` claims: what was looked for and what the record holds.
export function claimProblem(missing, runs, { where }) {
  const named = [...new Set(missing.map(({ key }) => `\`${key}\``))].join(', ');
  const held = runs.filter((run) => missing.some(({ key }) => run.command === key));
  const counted = (run) => (run.pass === null ? '' : ` (pass ${run.pass}, fail ${run.fail ?? 0})`);
  const shown = held.slice(-3).map((run) => `${run.status}${counted(run)} at tree ${String(run.tree).slice(0, 12)}`);
  const record = held.length ? `The record holds ${shown.join('; ')}.` : 'The record holds no finished run of it.';
  const stated = missing.some((each) => each.counts.length) ? 'with the count it states, ' : '';
  return `${where} says ${named} passed, but no run of it that a shell call finished with a pass, ${stated}` +
    `is on this session's record. ${record} Quote only output a tool returned in this session; a run stopped or still running ` +
    'is "not finished", never a result, and a CI result is quoted from `gh pr checks`. ' +
    'To get a result, run the command in the foreground to its end, or `aidrian test changed` for the test files this change touches.';
}
