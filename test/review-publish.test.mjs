import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { refusalContext } from '../plugins/aidrian/lib/pr-product-feedback.mjs';
import { projectAt, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { postContext, readReading } from '../plugins/aidrian/lib/review/dispatch.mjs';
import { recordFindings } from '../plugins/aidrian/lib/review/findings.mjs';
import { isJudgeRuling, JUDGE_PREFIX } from '../plugins/aidrian/lib/review/approvals.mjs';
import { escapeLines, fillWithheld, findingsTable, gitPaths, isPrivate, JUDGE_RULING, MAX_ROWS, patternsOf, postedCopy, quotedLines, residualRows, tableCell, textChecker, untextedBlocking, WITHHELD } from '../plugins/aidrian/lib/review/publish.mjs';
import { lateResiduals } from '../plugins/aidrian/lib/review/run.mjs';
import { attributionLine, engineLists, fillThreads, fitBody, leadingMarkers, markerLine, MAX_LISTED, MAX_THREADS, postInline, raiseFloor, readMarked } from '../plugins/aidrian/lib/review/inline.mjs';
import { deleteOwn, handledKeys, mergeDeletes } from '../plugins/aidrian/lib/review/delete.mjs';
import { answerThreads } from '../plugins/aidrian/lib/review/replies.mjs';
import { MAX_BODY } from '../plugins/aidrian/lib/forges/index.mjs';
import { BODY_LIMIT, CHECK_HELD_LINE, emptyState, HELD_LINE, heldMessage, heldRevision, heldWhy, readLocalState, readRecord, refreshSummary, restartFrom, stateFromComment, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';

const NO_TERMS = { hosts: [], accounts: [], variables: [] };
// The always-on check's context with nothing named but this machine's home.
const CONTEXT = { home: homedir(), state: '', roots: [], terms: NO_TERMS, env: {} };
const PRIVATE = { visibility: 'PRIVATE', inside: true };
const TOKEN = 'ghp_SENTINELabcdefghijklmnop0123';

// A checkout with a private-words copy holding `words`, or a folder in its place, which no read can take as a file.
function checkout(t, words) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-publish-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (words === null) mkdirSync(path.join(dir, '.banned-terms.local'));
  else if (words) writeFileSync(path.join(dir, '.banned-terms.local'), `${words.join('\n')}\n`);
  return dir;
}

test('the always-on check withholds token-shaped strings and local paths, on every string, with no list', () => {
  const checker = textChecker({ context: CONTEXT, words: [] });
  for (const text of [`a token ${TOKEN}`, `see ${['', 'Users', 'someone', 'notes.txt'].join('/')}`, `in ${homedir()}/x`, 'under ~/projects', 'the key sk-live_0123456789abcdef']) {
    assert.equal(checker.allows(text), false, text);
  }
  assert.equal(checker.allows('Null check missing in the refund total'), true);
  assert.equal(checker.allows(`the token ${TOKEN.replace('_', '&#95;')}`), false, 'a decoded copy of the text is checked too');
});

test('a dropped search counts as a hit, and a spent budget withholds what it has not checked', () => {
  const broken = textChecker({ context: CONTEXT, words: [], patterns: ['('] });
  assert.equal(broken.allows('anything at all'), false, 'a pattern that does not compile');
  const spent = textChecker({ context: CONTEXT, words: [], patterns: ['zzz'], budget: () => 0 });
  assert.equal(spent.allows('nothing matches here'), false, 'the budget is spent');
  const words = textChecker({ context: CONTEXT, words: ['zzz'], budget: () => 0 });
  assert.equal(words.allows('nothing matches here'), false, 'a private-words search out of budget');
});

test('the patterns are the base branch`s committed ones joined with the checkout`s', () => {
  const base = { github: { publicText: { patterns: ['codename-alpha'] } } };
  const checkoutConfig = { github: { publicText: { patterns: ['codename-beta'] } } };
  const patterns = patternsOf([base, checkoutConfig]);
  assert.deepEqual(patterns, ['codename-alpha', 'codename-beta']);
  const checker = textChecker({ context: CONTEXT, words: [], patterns });
  assert.equal(checker.allows('the Codename-Alpha launch'), false, 'the base branch`s pattern, in any case');
  assert.equal(checker.allows('the codename-beta launch'), false, 'the checkout`s pattern');
  assert.equal(checker.allows('a wrapped\ncodename-\nalpha'), true);
  assert.equal(checker.allows('a wrapped codename-alpha\nline'), false, 'whitespace runs collapse');
});

test('a pattern and a private word that match only the decoded copy withhold', (t) => {
  const pattern = textChecker({ context: CONTEXT, words: [], patterns: ['codename'] });
  assert.equal(pattern.allows('the cod&#101;name ships'), false);
  const root = checkout(t, ['bluebird']);
  const words = textChecker({ context: CONTEXT, root });
  assert.equal(words.allows('the blue%62ird release'), false, 'a private word, read from the checkout`s copy');
  assert.equal(words.allows('a plain sentence'), true);
});

test('a private-words copy that cannot be read withholds every string the private-words search would read', (t) => {
  const checker = textChecker({ context: CONTEXT, root: checkout(t, null) });
  assert.equal(checker.allows('a plain sentence'), false);
  // On a private repository, a verdict's evidence is one such string; the record's own key names are no data and stay.
  const state = { ...emptyState(7, 'o/r'), revision: 6, passes: { p: { head: 'a'.repeat(40), verdicts: [{ flow: 'f', invariant: 'i', verdict: 'holds', evidence: 'src/a.js:3' }] } } };
  const { copy } = postedCopy(state, { reading: PRIVATE, checker });
  assert.deepEqual([copy.version, copy.revision, copy.pr, Array.isArray(copy.rounds), copy.passes], [1, 6, 7, true, {}], 'the pass id, a data-bearing key, is withheld with every string');
  assert.equal(checker.failed, true, 'the check could not run');
  const body = summaryBody(state, null, 'x', { reading: PRIVATE, checker: textChecker({ context: CONTEXT, root: checkout(t, null) }) });
  assert.equal(heldRevision(body), 6, 'so the write holds the record rather than post one that lost its data');
});

test('the always-on check runs in the context the product feedback post builds: a product-access variable`s value withholds', (t) => {
  const root = checkout(t, []);
  writeFileSync(path.join(root, '.aidrian.json'), JSON.stringify({}));
  mkdirSync(path.join(root, '.aidrian'), { recursive: true });
  writeFileSync(path.join(root, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const project = projectAt(root);
  const doc = '# Product access\n\n## Accounts\n\n- `tester` signs in with `APP_PASSWORD`\n';
  const context = refusalContext(project, { state: stateDir(project), env: { APP_PASSWORD: 'hunter2-secret' }, access: () => [doc] });
  const checker = textChecker({ context, words: [] });
  assert.equal(checker.allows('the login uses hunter2-secret today'), false);
  assert.equal(checker.allows('the login works'), true);
});

test('a knowledge index that cannot be read withholds every string, and fails nothing', (t) => {
  const root = checkout(t, []);
  mkdirSync(path.join(root, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(root, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  writeFileSync(path.join(root, '.aidrian/knowledge/10-x.json'), '{bad');
  const project = projectAt(root);
  const post = postContext({ forge: { visibility: () => 'PRIVATE', change: () => ({ isCrossRepository: false }), pull: () => ({ author_association: 'MEMBER', base: { repo: { fork: false } } }) }, repo: 'o/r', n: 7, project, configs: [] });
  assert.deepEqual(post.reading, PRIVATE);
  assert.equal(post.checker.allows('a plain sentence'), false);
  const body = summaryBody({ ...emptyState(7, 'o/r'), revision: 1 }, null, 'x', post);
  assert.ok(body.startsWith('<!-- aidrian-review-summary -->'), 'the comment is still written');
});

test('private means the forge read PRIVATE for a pull request from inside the team, and nothing else', () => {
  const forge = (visibility, inside = true) => ({
    visibility: () => (visibility instanceof Error ? (() => { throw visibility; })() : visibility),
    change: () => ({ isCrossRepository: !inside }),
    pull: () => ({ author_association: 'MEMBER', base: { repo: { fork: false } } }),
  });
  assert.equal(isPrivate(readReading(forge('PRIVATE'), 'o/r', 7)), true);
  for (const each of [forge('PUBLIC'), forge('INTERNAL'), forge('private'), forge(new Error('HTTP 502')), forge('PRIVATE', false), { visibility: () => 'PRIVATE' }]) {
    assert.equal(isPrivate(readReading(each, 'o/r', 7)), false);
  }
  assert.equal(isPrivate(undefined), false, 'no reading');
});

test('a pull request from outside the team gets the copy a repository that is not private gets, and rows by id', () => {
  const head = 'a'.repeat(40);
  const state = { ...emptyState(7, 'o/r'), planNote: { head, passes: { p: { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: [] }, passes: { p: { head, reviewer: 'codex-local', findings: 1, open: 1, list: [{ id: 'R1-1', mint: '0123abcd', title: 'Null check missing', body: 'b', severity: 'medium' }] } } };
  const { copy } = postedCopy(state, { reading: { visibility: 'PRIVATE', inside: false }, checker: textChecker({ context: CONTEXT, words: [] }) });
  assert.deepEqual(copy.passes.p.list, [{ id: 'R1-1', mint: '0123abcd', severity: 'medium' }]);
  const rows = residualRows([{ pass: 'p', id: 'R1-1', title: 'Null check missing', file: 'src/a.js', line: 2, severity: 'medium' }], state, { reading: { visibility: 'PRIVATE', inside: false }, checker: textChecker({ context: CONTEXT, words: [] }) });
  assert.deepEqual(rows, { rows: [{ pass: 'p', id: 'R1-1', severity: 'medium', text: WITHHELD }], withheld: 1 });
});

test('what reports a withholding names no matched word, no pattern, no text around it, and no list', (t) => {
  const root = checkout(t, ['bluebird']);
  const checker = textChecker({ context: CONTEXT, root, patterns: ['codename-\\w+'] });
  const head = 'a'.repeat(40);
  const state = {
    ...emptyState(7, 'o/r'),
    planNote: { head, passes: { p: { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: [] },
    passes: { p: { head, reviewer: 'codex-local', findings: 2, open: 2, dropped: ['a note on codename-gamma'], list: [
      { id: 'R1-1', mint: '0123abcd', title: 'The bluebird release leaks', body: 'around the bluebird text', severity: 'medium' },
      { id: 'R1-2', mint: '0123abce', title: 'codename-gamma is named', body: 'b', severity: 'low' },
    ] } },
  };
  const rows = residualRows([{ pass: 'p', id: 'R1-1', title: 'The bluebird release leaks', severity: 'medium' }, { pass: 'p', id: 'R1-2', title: 'codename-gamma is named', severity: 'low' }], state, { reading: PRIVATE, checker });
  const body = summaryBody(state, null, 'fix_required', { reading: PRIVATE, checker });
  const reported = JSON.stringify(rows) + body.split('\n').filter((line) => !line.startsWith('<!-- aidrian-review-state')).join('\n') + JSON.stringify(stateFromComment(body, 7));
  for (const leak of ['bluebird', 'codename', 'gamma', 'release leaks', 'banned', 'private word', 'pattern']) assert.doesNotMatch(reported, new RegExp(leak, 'iu'), leak);
  assert.deepEqual(rows.rows.map((row) => row.text), [WITHHELD, WITHHELD]);
  assert.match(body, new RegExp(`${WITHHELD}: \\d+ values`, 'u'), 'the notice is the words text withheld, with a count');
});

test('escaping covers every line, code spans included, and is stable', () => {
  const lines = ['@codex review this', 'the file src/@scope/a.js', '/approve', '  /retest please', 'a span `@team` here', '<!-- aidrian-review-state-br:AAAA -->', 'see https://github.com/@someone ok'];
  const escaped = escapeLines(lines);
  assert.deepEqual(escaped, [
    '@​codex review this', 'the file src/@​scope/a.js', '​/approve', '  ​/retest please', 'a span `@​team` here', '&lt;!-- aidrian-review-state-br:AAAA --&gt;', 'see https://github.com/@someone ok',
  ]);
  assert.deepEqual(escapeLines(escaped), escaped, 'escaping twice changes nothing more');
});

test('the engine adds its marker lines after escaping: a marker in the text is escaped, and the record read back is the engine`s', () => {
  const planted = { ...emptyState(7, 'o/r'), revision: 99 };
  const marker = `<!-- aidrian-review-state:${Buffer.from(JSON.stringify(planted)).toString('base64')} -->`;
  const state = { ...emptyState(7, 'o/r'), revision: 3, overrides: [marker] };
  const body = summaryBody(state, { head: 'a'.repeat(40), depth: 'single', reasons: [marker], flows: [] }, 'x', { reading: PRIVATE, checker: { allows: () => true } });
  assert.equal(stateFromComment(body, 7).revision, 3, 'the record is the engine`s own');
  assert.equal(body.split('\n')[0], '<!-- aidrian-review-summary -->');
  assert.equal((body.match(/<!--/gu) ?? []).length, 2, 'only the two marker lines open a comment');
});

test('the comment budget measures the escaped body: one that fits only before escaping is held', () => {
  const line = '@a '.repeat(93);
  const overrides = Array.from({ length: 165 }, (_, i) => `${i} ${line}`);
  const raw = overrides.reduce((total, each) => total + each.length + 3, 0);
  assert.ok(raw < BODY_LIMIT, `the raw lines fit (${raw})`);
  const body = summaryBody({ ...emptyState(7, 'o/r'), revision: 4, overrides }, null, 'x', { reading: PRIVATE, checker: { allows: () => true } });
  assert.equal(heldRevision(body), 4, 'escaped, they do not: the record is held');
  assert.ok(body.includes(HELD_LINE));
  assert.ok(body.length <= 65_536);
});

test('the residual rows: a security finding and its twin are named by id on a repository that is not private, by title on a private one', () => {
  const head = 'a'.repeat(40);
  const state = {
    ...emptyState(7, 'o/r'),
    planNote: { head, passes: { p: { stage: 'independent', reviewer: 'codex-local', security: false }, q: { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: [] },
    passes: {
      p: { head, list: [{ id: 'R1-1', mint: '00000001', title: 'Refund total unchecked', file: 'src/a.js', line: 10, severity: 'high' }] },
      q: { head, list: [{ id: 'R1-2', mint: '00000002', title: 'A nearby nit', file: 'src/a.js', line: 12, severity: 'low', accepted_by: 'late-round' }, { id: 'R1-3', mint: '00000003', title: 'Elsewhere', file: 'src/b.js', line: 1, severity: 'low' }] },
    },
  };
  const rows = [{ pass: 'q', id: 'R1-2', title: 'A nearby nit', file: 'src/a.js', line: 12, severity: 'low' }, { pass: 'q', id: 'R1-3', title: 'Elsewhere', file: 'src/b.js', line: 1, severity: 'low' }, { pass: 'q', title: 'No id', severity: 'low' }];
  const checker = textChecker({ context: CONTEXT, words: [] });
  const open = residualRows(rows, state, { reading: { visibility: 'PUBLIC', inside: true }, checker });
  assert.deepEqual(open.rows.map((row) => [row.id ?? null, row.title ?? null, row.file ?? null]), [['R1-2', null, null], ['R1-3', 'Elsewhere', 'src/b.js'], [null, null, null]], 'the twin and a row with no id anchor nothing');
  const closed = residualRows(rows, state, { reading: PRIVATE, checker });
  assert.deepEqual(closed.rows.map((row) => row.title ?? null), ['A nearby nit', 'Elsewhere', 'No id']);
});

test('a check that cannot run holds the record at its revision: a budget spent part-way, an unreadable words copy, no context', (t) => {
  const head = 'a'.repeat(40);
  const state = { ...emptyState(7, 'o/r'), revision: 8, rounds: [{ head, at: '2026-11-11T00:00:00.000Z' }], passes: { 'engine:codex-local': { head, findings: 0, open: 0, list: [] } } };
  let calls = 0;
  const partWay = () => (calls += 1) > 3 ? 0 : 200;
  for (const [label, checker] of [
    ['a budget spent part-way', textChecker({ context: CONTEXT, words: ['zzz'], budget: partWay })],
    ['an unreadable words copy', textChecker({ context: CONTEXT, root: checkout(t, null) })],
    ['no context', textChecker({ context: null, words: [] })],
  ]) {
    const body = summaryBody(state, null, 'x', { reading: PRIVATE, checker });
    assert.equal(heldRevision(body), 8, label);
    assert.equal(stateFromComment(body, 7), null, `${label}: no copy is posted`);
  }
  const fine = summaryBody(state, null, 'x', { reading: PRIVATE, checker: textChecker({ context: CONTEXT, words: [] }) });
  assert.equal(stateFromComment(fine, 7).revision, 8, 'with every check run, the copy posts');
});

test('a reworded, unflagged ruling of a security finding is its twin by the id it names: no place posted, and its row by id', (t) => {
  const root = checkout(t, []);
  writeFileSync(path.join(root, 'a.js'), Array.from({ length: 30 }, (_, i) => `${i}\n`).join(''));
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: root });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: root });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const paths = gitPaths(root).at(head);
  const state = { ...emptyState(7, 'o/r'), floored: true, rounds: [{ head, at: '2026-11-11T00:00:00.000Z' }],
    planNote: { head, passes: { 'engine:codex-local': { stage: 'independent', reviewer: 'codex-local', security: false }, 'agent:code-reviewer': { stage: 'local', reviewer: 'code-reviewer', security: false } }, pairs: [] } };
  recordFindings(state, 'agent:code-reviewer', { head, list: [{ title: 'Refund total trusts the client', file: 'a.js', line: 10, severity: 'low', security: true, state: 'accepted', disposition: 'accepted_residual', accepted_by: 'late-round' }] }, { mint: true, paths });
  recordFindings(state, 'engine:codex-local', { head, list: [], ruled: [{ title: 'Amount from request body', file: 'a.js', line: 20, severity: 'low', already_ruled: 'Refund total trusts the client', from: 'prior', settled_severity: 'low', accepted_by: 'late-round' }] }, { mint: true, paths });
  const [ruling] = state.passes['engine:codex-local'].ruled;
  assert.deepEqual([ruling.ruled_id, ruling.security], [state.passes['agent:code-reviewer'].list[0].id, true], 'the stored mark');
  const checker = textChecker({ context: CONTEXT, words: [] });
  const { copy } = postedCopy(state, { reading: { visibility: 'PUBLIC', inside: true }, checker, root, names: [] });
  assert.deepEqual([copy.passes['engine:codex-local'].ruled[0].file, copy.passes['engine:codex-local'].ruled[0].line], [undefined, undefined]);
  const rows = residualRows([{ pass: 'engine:codex-local', id: ruling.ruled_id, title: 'Refund total trusts the client', file: 'a.js', line: 20, severity: 'low' }], state, { reading: { visibility: 'PUBLIC', inside: true }, checker });
  assert.equal(rows.rows[0].text, WITHHELD);
});

test('a line break inside one element starts no body line with a slash command', () => {
  const head = 'a'.repeat(40);
  const state = { ...emptyState(7, 'o/r'), revision: 3, passes: { 'agent:x\n/approve': { head, reviewer: 'x', findings: 0, open: 0 } } };
  const body = summaryBody(state, null, 'received', { reading: PRIVATE, checker: { allows: () => true } });
  assert.deepEqual(body.split('\n').filter((line) => /^\s*\//u.test(line)), []);
});

test('a hold because a check could not run says so, and a size hold says the size; neither names a word, pattern, or list', (t) => {
  const head = 'a'.repeat(40);
  const state = { ...emptyState(7, 'o/r'), revision: 5, rounds: [{ head, at: '2026-11-11T00:00:00.000Z' }] };
  const checkHeld = summaryBody(state, null, 'x', { reading: PRIVATE, checker: textChecker({ context: CONTEXT, root: checkout(t, null) }) });
  assert.equal(heldRevision(checkHeld), 5);
  assert.ok(checkHeld.includes(CHECK_HELD_LINE) && !checkHeld.includes(HELD_LINE));
  assert.equal(heldWhy(checkHeld), 'check');
  const checkMessage = heldMessage(7, 5, 'check');
  assert.match(checkMessage, /because a text check could not run there/u);
  assert.doesNotMatch(checkMessage + CHECK_HELD_LINE, /too large|banned|private word|pattern/iu);
  const big = { ...state, overrides: Array.from({ length: 165 }, (_, i) => `${i} ${'@a '.repeat(93)}`) };
  const sizeHeld = summaryBody(big, null, 'x', { reading: PRIVATE, checker: { allows: () => true } });
  assert.ok(sizeHeld.includes(HELD_LINE));
  assert.equal(heldWhy(sizeHeld), 'size');
  assert.match(heldMessage(7, 5, 'size'), /too large for the pull request's comment/u);
});

test('a check that fails for a residual row holds no record: on a public repository the summary still posts', () => {
  const head = 'a'.repeat(40);
  const state = { ...emptyState(7, 'o/r'), revision: 5, rounds: [{ head, at: '2026-11-11T00:00:00.000Z' }] };
  // A checker whose check cannot run for the row's title alone.
  const checker = { failed: false, allows(text) {
    if (text !== 'A late nit') return true;
    this.failed = true;
    return false;
  } };
  const rows = residualRows([{ pass: 'p', id: 'R1-1', title: 'A late nit', severity: 'low' }], state, { reading: { visibility: 'PUBLIC', inside: true }, checker });
  assert.equal(rows.rows[0].text, WITHHELD, 'the row`s title could not be checked, so it is withheld');
  const body = summaryBody(state, null, 'x', { reading: { visibility: 'PUBLIC', inside: true }, checker });
  assert.equal(heldRevision(body), null);
  assert.equal(stateFromComment(body, 7).revision, 5);
});

test('a private copy never posts this machine`s adopted mark', () => {
  const head = 'a'.repeat(40);
  const state = { ...emptyState(7, 'o/r'), revision: 2, passes: { p: { head, list: [{ id: 'R1-1', mint: '0000000a', title: 'x', adopted: true }] } } };
  const { copy } = postedCopy(state, { reading: PRIVATE, checker: { allows: () => true } });
  assert.deepEqual(copy.passes.p.list[0], { id: 'R1-1', mint: '0000000a', title: 'x' });
});

test('on a public repository every posted string meets the configured patterns and private words: a reason, a path, and a name', (t) => {
  const root = checkout(t, ['bluebird']);
  mkdirSync(path.join(root, 'src'));
  for (const file of ['src/confidential.js', 'src/a.js']) writeFileSync(path.join(root, file), '1\n2\n3\n');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  git('add', '-A');
  git('commit', '-qm', 'base');
  const head = git('rev-parse', 'HEAD');
  const checker = textChecker({ context: CONTEXT, root, patterns: ['CONFIDENTIAL'] });
  const reviewer = 'bluebird-reviewer';
  const state = {
    ...emptyState(7, 'o/r'), revision: 2,
    planNote: { head, passes: { 'engine:codex-local': { stage: 'independent', reviewer, security: false } }, pairs: [] },
    passes: { 'engine:codex-local': { head, reviewer, findings: 2, open: 2, files: ['src/confidential.js', 'src/a.js'], list: [
      { id: 'R1-1', mint: '0000000a', title: 't', file: 'src/confidential.js', line: 1, severity: 'medium' },
      { id: 'R1-2', mint: '0000000b', title: 't', file: 'src/a.js', line: 2, severity: 'medium' },
    ] } },
  };
  const plan = { head, depth: 'single', reasons: ['CONFIDENTIAL project reason', 'rule 1: single'], engine: { name: 'codex-local', reason: 'auto' }, flows: [] };
  const body = summaryBody(state, plan, 'fix_required', { reading: { visibility: 'PUBLIC', inside: true }, checker, root, names: [] });
  const visible = body.split('\n').filter((line) => !line.startsWith('<!-- aidrian-review-state')).join('\n');
  assert.doesNotMatch(visible, /CONFIDENTIAL|bluebird/iu, 'the visible reason and name');
  assert.match(visible, /- rule 1: single/u, 'a clean reason stays');
  const record = JSON.stringify(stateFromComment(body, 7));
  assert.doesNotMatch(record, /confidential|bluebird/iu, 'the path and the name in the posted record');
  assert.match(record, /src\/a\.js/u, 'a clean path stays');
});

test('a judge`s ruling stays a judge`s on every copy: an unnamed judge posts the prefix alone, and a Human`s posts no name', (t) => {
  assert.equal(JUDGE_RULING, JUDGE_PREFIX, 'the prefix the evidence step reads');
  const head = 'a'.repeat(40);
  const pair = { flow: 'booking', invariant: 'cap', head, at: '2026-11-11T00:00:00.000Z' };
  const state = {
    ...emptyState(7, 'o/r'), revision: 3,
    planNote: { head, passes: {}, pairs: [{ flow: 'booking', invariant: 'cap' }] },
    acceptances: [{ ...pair, by: 'judge:architect', reason: 'r', kind: 'comment', evidence: 'https://github.com/o/r/pull/7#issuecomment-1' }, { ...pair, by: 'Jane Person', reason: 'r' }],
    overrulings: [{ ...pair, by: 'judge:architect', reason: 'r' }],
  };
  const root = checkout(t, []);
  for (const [label, post] of [
    ['public', { reading: { visibility: 'PUBLIC', inside: true }, checker: textChecker({ context: CONTEXT, words: [] }), names: [] }],
    ['private, the name withheld', { reading: PRIVATE, checker: textChecker({ context: CONTEXT, words: [], patterns: ['architect'], root }) }],
  ]) {
    const { copy } = postedCopy(state, post);
    assert.deepEqual([isJudgeRuling(copy.acceptances[0]), isJudgeRuling(copy.overrulings[0])], [true, true], label);
    assert.ok(!JSON.stringify(copy).includes('architect'), `${label}: the name is not posted`);
    assert.equal(isJudgeRuling(copy.acceptances[1]), false, `${label}: the Human's stays the Human's`);
    if (label === 'public') assert.ok(!JSON.stringify(copy).includes('Jane Person'), 'a person`s name is not posted publicly');
  }
});

test('a public copy posts no verdict evidence: prose under test:, an unknown capture, a violated citation, or a security finding`s place', (t) => {
  const root = checkout(t, []);
  writeFileSync(path.join(root, 'a.js'), '1\n2\n3\n');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  git('add', '-A');
  git('commit', '-qm', 'base');
  const head = git('rev-parse', 'HEAD');
  const cited = [['holds', 'test:the refund total trusts the request body, see the handler'], ['holds', 'capture:no-such-key'], ['violated', 'a.js:2'], ['holds', 'a.js:3']];
  const verdicts = cited.map(([verdict, evidence], i) => ({ flow: 'booking', invariant: `i${i}`, verdict, evidence }));
  const state = { ...emptyState(7, 'o/r'), revision: 2, planNote: { head, passes: { p: { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: verdicts.map(({ flow, invariant }) => ({ flow, invariant })) },
    passes: { p: { head, verdicts, list: [{ id: 'R1-1', mint: '0000000a', title: 'Token logged', file: 'a.js', line: 3, severity: 'high' }] } } };
  const { copy } = postedCopy(state, { reading: { visibility: 'PUBLIC', inside: true }, checker: textChecker({ context: CONTEXT, words: [] }), root, names: [] });
  assert.deepEqual(copy.passes.p.verdicts.map((each) => [each.verdict, each.evidence ?? null]), [['holds', null], ['holds', null], ['violated', null], ['holds', null]]);
  assert.doesNotMatch(JSON.stringify(copy), /a\.js:|refund|no-such-key/u);
});

test('every string a residual row keeps meets the checks: a file matching a configured pattern withholds the row, a pass or severity that fails is left out', () => {
  const checker = textChecker({ context: CONTEXT, words: [], patterns: ['secretproject'] });
  const state = { ...emptyState(7, 'o/r'), planNote: { head: 'a'.repeat(40), passes: { p: { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: [] }, passes: { p: { head: 'a'.repeat(40), list: [{ id: 'R1-1', mint: '0000000a', title: 'A nit', severity: 'low' }] } } };
  const reading = { visibility: 'PRIVATE', inside: true };
  const { rows } = residualRows([{ pass: 'p', id: 'R1-1', title: 'A nit', file: 'src/secretproject.js', line: 1, severity: 'low' }], state, { reading, checker });
  assert.deepEqual(rows, [{ pass: 'p', id: 'R1-1', severity: 'low', text: WITHHELD }]);
  const named = residualRows([{ pass: 'slice:secretproject', id: 'R1-1', title: 'A nit', severity: 'low' }], state, { reading, checker });
  assert.deepEqual(named.rows, [{ id: 'R1-1', severity: 'low', text: WITHHELD }]);
});

test('a security finding accepted late, then repeated as already ruled, keeps its residual row by id once its listing is gone', (t) => {
  const root = checkout(t, []);
  writeFileSync(path.join(root, 'a.js'), Array.from({ length: 30 }, (_, i) => `${i}\n`).join(''));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  git('add', '-A');
  git('commit', '-qm', 'base');
  const head = git('rev-parse', 'HEAD');
  const paths = gitPaths(root).at(head);
  const pass = 'engine:codex-local';
  const state = { ...emptyState(7, 'o/r'), floored: true, rounds: [{ head, at: '2026-11-11T00:00:00.000Z' }],
    planNote: { head, passes: { [pass]: { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: [] } };
  // A low finding its reviewer flagged as security, accepted by the late-round rule.
  recordFindings(state, pass, { head, list: [{ title: 'Token in the log', file: 'a.js', line: 10, severity: 'low', security: true, state: 'accepted', disposition: 'accepted_residual', accepted_by: 'late-round' }] }, { mint: true, paths });
  const original = state.passes[pass].list[0].id;
  // The next head: the reviewer repeats it as already ruled, and the listing leaves the pass.
  state.rounds.push({ head, at: '2026-11-11T01:00:00.000Z' });
  recordFindings(state, pass, { head, list: [], ruled: [{ title: 'Token still in the log', file: 'a.js', line: 10, severity: 'low', already_ruled: 'Token in the log', from: 'prior', settled_severity: 'low', accepted_by: 'late-round' }] }, { mint: true, paths });
  assert.equal(state.passes[pass].ruled[0].ruled_id, original);
  const rows = lateResiduals([{ id: pass }], () => state.passes[pass]);
  assert.equal(rows[0].id, original, 'the row is keyed by the finding the ruling names');
  const out = residualRows(rows, state, { reading: { visibility: 'PUBLIC', inside: true }, checker: textChecker({ context: CONTEXT, words: [] }) });
  assert.deepEqual([out.rows[0].text, out.rows[0].title, out.rows[0].file, out.withheld], [WITHHELD, undefined, undefined, 1]);
});

test('a slice result built on from a private copy takes this machine`s own same-head report, and no mark of its own', () => {
  const head = 'a'.repeat(40);
  const slice = 'slice:code-reviewer:0123456789';
  const remote = { ...emptyState(7, 'o/r'), revision: 9, passes: { [slice]: { head, reviewer: 'code-reviewer', findings: 0, open: 0 } } };
  fillWithheld(remote, emptyState(7, 'o/r'));
  assert.deepEqual(Object.keys(remote.passes[slice]).sort(), ['findings', 'head', 'open', 'reviewer'], 'nothing added to a slice this machine never ran');
  const again = { ...emptyState(7, 'o/r'), revision: 9, passes: { [slice]: { head, reviewer: 'code-reviewer', findings: 0, open: 0 } } };
  fillWithheld(again, { ...emptyState(7, 'o/r'), passes: { [slice]: { head, contracts: ['a()'], cross_notes: [] } } });
  assert.deepEqual([again.passes[slice].contracts, again.passes[slice].cross_notes], [['a()'], []]);
});

// ---- A second machine and a copy that is not private (#276) ----

const AT = '2026-11-01T10:00:00.000Z';
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const ENGINE = 'engine:codex-local';
const FLOW_PASS = 'agent:code-reviewer:booking';
// A project with a state folder and no record yet: the second machine.
function machine(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-machine-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  return projectAt(dir);
}
// The first machine's record: `rounds` rounds, the last on HEAD, its passes' findings, and the id counter they spent.
function firstMachine({ rounds = 2, list = [], flowList = null, revision = 12 } = {}) {
  const note = { head: HEAD, current: [ENGINE], passes: { [ENGINE]: { stage: 'independent', reviewer: 'codex-local', security: false }, [FLOW_PASS]: { stage: 'local', reviewer: 'code-reviewer', security: false } }, pairs: [] };
  const passes = { [ENGINE]: { head: HEAD, reviewer: 'codex-local', files: null, findings: list.length, open: list.length, list } };
  if (flowList) passes[FLOW_PASS] = { head: HEAD, reviewer: 'code-reviewer', files: ['src/booking/a.js'], findings: flowList.length, open: flowList.length, list: flowList };
  const heads = Array.from({ length: rounds }, (_, i) => (i === rounds - 1 ? HEAD : `${String(i + 1)}`.repeat(40)));
  return {
    ...emptyState(7, 'o/r'), revision, idCounter: 9, planNote: note, passes,
    rounds: heads.map((head, i) => ({ head, at: AT, open: 1, findings: [{ id: `R${i + 1}-1`, mint: '0000000f', severity: 'low', state: 'fixed', disposition: 'fix_now' }], ...(i === rounds - 1 ? { final: true } : {}) })),
    outcome: { status: 'fix_required', head: HEAD, at: AT },
  };
}
const posted = (state, reading = PUBLIC) => [{ id: 1, body: summaryBody(state, null, 'x', { reading, checker: { allows: () => true }, names: [] }), author_association: 'MEMBER' }];
const blocking = (id, mint) => ({ id, mint, title: `${id} title`, body: `${id} body`, severity: 'high', state: 'open', disposition: 'fix_now' });
const closed = (id, mint) => ({ id, mint, title: `${id} title`, severity: 'medium', state: 'fixed', disposition: 'fix_now' });

test('a second machine with no record and a public copy restarts: the copy`s round count and id counter as floors, nothing else taken', (t) => {
  const project = machine(t);
  const theirs = firstMachine({ rounds: 3, list: [closed('R3-2', '00000002')] });
  let reads = 0;
  const record = readRecord(project, 7, posted(theirs), 'o/r', () => (reads += 1, PUBLIC));
  assert.equal(reads, 1, 'the reading is read once, as the copy is the newer record');
  const { state } = record;
  assert.equal(record.held, undefined);
  assert.deepEqual(state.passes, {}, 'no pass result of the copy: every pass runs again here');
  assert.equal(state.index, undefined, 'no index entry of the copy');
  assert.equal(state.outcome, null, 'no outcome of the copy, so the merge guard waits for this machine`s review');
  assert.deepEqual(state.rounds, theirs.rounds.map((round) => ({ head: round.head, at: round.at, ...(round.final ? { final: true } : {}) })), 'each round by its head and time alone');
  assert.equal(state.idCounter, 9, 'no id is minted twice');
  assert.equal(state.revision, theirs.revision);
  assert.doesNotMatch(JSON.stringify(state), /adopted/u, 'nothing is marked adopted, as nothing is');
  writeLocalState(project, state);
  assert.equal(readRecord(project, 7, posted(theirs), 'o/r', () => assert.fail('the local record is newer: no reading')).state.revision, theirs.revision + 1, 'its first write is the newer record');
  // The same copy on a private reading is built on, exactly as with no reading.
  const fresh = machine(t);
  const built = readRecord(fresh, 7, posted(theirs, PRIVATE), 'o/r', PRIVATE).state;
  assert.deepEqual(built, readRecord(fresh, 7, posted(theirs, PRIVATE), 'o/r').state);
  assert.equal(built.passes[ENGINE].list[0].title, 'R3-2 title');
});

test('a second machine holds on a public copy with an open, blocking finding of its plan that it holds no text for, and names it', (t) => {
  const project = machine(t);
  const theirs = firstMachine({ list: [blocking('R2-1', '00000001')] });
  const record = readRecord(project, 7, posted(theirs), 'o/r', PUBLIC);
  assert.deepEqual([record.held, record.why, record.finding, record.state], [theirs.revision, 'findings', 'R2-1', undefined]);
  assert.match(heldMessage(7, record.held, record.why, record.finding), /^the review record of #7 is at revision 12 on the machine that wrote it, and holds the open finding R2-1, whose text is on the machine that recorded it: continue the review on that machine/u);
  // A failed read of the visibility is not private, and holds the same.
  assert.equal(readRecord(project, 7, posted(theirs), 'o/r', { visibility: null, inside: false }).finding, 'R2-1');
  // A blocking finding of a pass the copy's own plan no longer names, such as a flow pass whose files left the diff, holds nothing.
  const obsolete = firstMachine({ list: [closed('R2-1', '00000001')], flowList: [blocking('R1-3', '00000003')] });
  assert.equal(untextedBlocking(stateFromComment(posted(obsolete)[0].body, 7), null), 'R1-3', 'every stored pass, as the private stop reads it');
  const restarted = readRecord(project, 7, posted(obsolete), 'o/r', PUBLIC);
  assert.equal(restarted.held, undefined);
  assert.deepEqual(restarted.state.passes, {});
});

test('a second machine with its own record on the same head keeps it on a public copy: its own text, the copy`s floors, and the copy`s security marks', (t) => {
  const project = machine(t);
  // This machine reviewed the head in round 2 and recorded R2-1, which the first machine later marked security.
  const own = { ...emptyState(7, 'o/r'), idCounter: 4, planNote: firstMachine().planNote, rounds: firstMachine().rounds.map(({ head, at }) => ({ head, at })),
    passes: { [ENGINE]: { head: HEAD, reviewer: 'codex-local', files: null, findings: 1, open: 1, list: [{ ...blocking('R2-1', '00000001'), file: 'src/a.js', line: 1 }] } } };
  writeLocalState(project, own);
  const mine = readLocalState(project, 7);
  const theirs = firstMachine({ revision: mine.revision + 4, list: [{ ...blocking('R2-1', '00000001'), security: true }, closed('R2-5', '00000005')] });
  const { state, held } = readRecord(project, 7, posted(theirs), 'o/r', PUBLIC);
  assert.equal(held, undefined, 'its own blocking finding, held by id and mint mark, holds nothing');
  assert.deepEqual(state.passes[ENGINE].list.map((each) => [each.id, each.title, each.file, each.security]), [['R2-1', 'R2-1 title', 'src/a.js', true]], 'its own finding, with the copy`s mark; none of the copy`s');
  assert.equal(state.index['R2-1'].security, true, 'in the index too, so the delete of its comment reads it');
  assert.equal(state.index['R2-5'], undefined);
  assert.deepEqual([state.revision, state.idCounter, state.rounds.length], [theirs.revision, 9, 2]);
  assert.equal(readLocalState(project, 7).revision, mine.revision, 'the read writes nothing');
  // Another machine's finding of the same id and another mint mark is not its own.
  const other = firstMachine({ revision: mine.revision + 5, list: [blocking('R2-1', '0000000e')] });
  assert.equal(readRecord(project, 7, posted(other), 'o/r', PUBLIC).finding, 'R2-1');
});

test('a public copy with more rounds than this machine`s record raises its round count to the copy`s, and a record with more keeps its own', (t) => {
  const project = machine(t);
  const own = { ...emptyState(7, 'o/r'), rounds: [{ head: OLD_HEAD, at: AT, open: 2, findings: [{ ...blocking('R1-1', '00000001'), state: 'fixed' }] }] };
  writeLocalState(project, own);
  const theirs = firstMachine({ rounds: 4, revision: 30 });
  theirs.rounds[1].quiet = [{ from: 'c'.repeat(40), at: AT }];
  const { state } = readRecord(project, 7, posted(theirs), 'o/r', PUBLIC);
  assert.equal(state.rounds.length, 4, 'the copy`s count: a restart cannot open more rounds than the cap the copy spent allows');
  assert.equal(state.rounds[0].head, OLD_HEAD, 'its own first round, as it recorded it');
  assert.equal(state.rounds[0].findings[0].title, 'R1-1 title');
  assert.deepEqual(state.rounds.slice(1), theirs.rounds.slice(1).map((round) => ({ head: round.head, at: round.at, ...(round.final ? { final: true } : {}), ...(round.quiet ? { quiet: round.quiet } : {}) })));
  const longer = { ...emptyState(7, 'o/r'), rounds: Array.from({ length: 5 }, () => ({ head: OLD_HEAD, at: AT })) };
  assert.equal(restartFrom(longer, theirs).rounds.length, 5);
});

test('a private copy built on fills an index entry from this machine`s own entry: its reviewer back, and no body or evidence on a closed one', (t) => {
  const project = machine(t);
  const own = { ...emptyState(7, 'o/r'), planNote: firstMachine().planNote, passes: { [ENGINE]: { head: HEAD, reviewer: 'codex-local', files: null, findings: 1, open: 1, list: [{ ...blocking('R2-1', '00000001'), evidence: 'R2-1 evidence' }] } } };
  writeLocalState(project, own);
  const mine = readLocalState(project, 7);
  assert.equal(mine.index['R2-1'].reviewer, 'codex-local');
  // The first machine closed the finding as fixed; its private copy posts no reviewer and no title for the closed entry.
  const theirs = structuredClone(mine);
  theirs.revision += 3;
  theirs.passes[ENGINE] = { head: HEAD, reviewer: 'codex-local', files: null, findings: 1, open: 0, list: [{ ...blocking('R2-1', '00000001'), state: 'fixed' }] };
  theirs.index['R2-1'].state = 'fixed';
  const { state } = readRecord(project, 7, posted(theirs, PRIVATE), 'o/r', PRIVATE);
  const entry = state.index['R2-1'];
  assert.deepEqual([entry.state, entry.reviewer, entry.title, entry.body, entry.evidence, entry.adopted], ['fixed', 'codex-local', 'R2-1 title', undefined, undefined, undefined]);
});

test('an index entry adopted from a copy is this machine`s own once it records a fresh report of it; a write of the adopted finding keeps the mark', () => {
  const at = (state) => state.index['R1-1'];
  const state = { ...emptyState(7, 'o/r'), rounds: [{ head: HEAD, at: AT }], passes: { p: { head: HEAD, list: [{ ...blocking('R1-1', '00000001'), title: undefined, adopted: true }] } }, index: { 'R1-1': { id: 'R1-1', mint: '00000001', severity: 'high', state: 'open', disposition: 'fix_now', pass: 'p', adopted: true } } };
  recordFindings(state, 'p', { head: HEAD, list: [{ ...blocking('R1-1', '00000001'), adopted: true }] });
  assert.equal(at(state).adopted, true, 'the adopted finding written again');
  recordFindings(state, 'p', { head: HEAD, list: [blocking('R1-1', '00000001')] });
  assert.equal(at(state).adopted, undefined, 'a fresh report: closeOmitted reads it again');
  assert.equal(at(state).title, 'R1-1 title');
});

test('every command that reads the review record passes the forge`s reading, so a copy that is not private is never built on', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const lib = path.join(import.meta.dirname, '../plugins/aidrian/lib');
  const target = path.join(lib, 'review/state.mjs');
  const calls = [];
  for (const file of readdirSync(lib, { recursive: true }).filter((each) => each.endsWith('.mjs'))) {
    const text = readFileSync(path.join(lib, file), 'utf8');
    // The names this file binds review/state.mjs's readRecord to, by a static or a dynamic import.
    const names = [...text.matchAll(/\{([^}]*)\}\s*(?:from\s*|=\s*await\s+import\()\s*'([^']+)'/gu)]
      .filter(([, , from]) => path.resolve(path.dirname(path.join(lib, file)), from) === target)
      .flatMap(([, list]) => list.split(',').map((each) => each.trim()).filter((each) => /^readRecord\b/u.test(each)).map((each) => each.split(/\s+as\s+/u).at(-1)));
    for (const name of new Set(names)) {
      for (const match of text.matchAll(new RegExp(`\\b${name}\\(`, 'gu'))) {
        // The call's arguments, to its closing parenthesis.
        let depth = 0;
        const args = [''];
        for (let at = match.index + match[0].length; at < text.length; at += 1) {
          const char = text[at];
          if (char === ')' && depth === 0) break;
          if ('([{'.includes(char)) depth += 1;
          if (')]}'.includes(char)) depth -= 1;
          if (char === ',' && depth === 0) args.push('');
          else args[args.length - 1] += char;
        }
        calls.push({ file, args: args.map((each) => each.trim()).filter(Boolean) });
      }
    }
  }
  assert.ok(calls.length >= 6, JSON.stringify(calls));
  for (const call of calls) assert.equal(call.args.length, 5, `${call.file}: readRecord(${call.args.join(', ')})`);
});

// ---- The findings table (review.publish.summary "findings") ----

// A checkout whose head tracks src/a.js and src/b.js, 40 lines each.
function tracked(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-table-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, 'src'));
  for (const file of ['src/a.js', 'src/b.js']) writeFileSync(path.join(dir, file), Array.from({ length: 40 }, (_, i) => `${i}\n`).join(''));
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { root: dir, head: git('rev-parse', 'HEAD') };
}
const SEEN = '5'.repeat(40);
const entry = (n, over = {}) => ({ id: `R1-${n}`, mint: n.toString(16).padStart(8, '0'), title: `SENTINEL${n} problem`, file: 'src/a.js', line: n % 40 + 1, severity: 'medium', state: 'open', disposition: 'fix_now', pass: 'engine:codex-local', stage: 'independent', reviewer: 'codex-local', ...over });
const withIndex = (head, entries) => ({
  ...emptyState(7, 'o/r'), revision: 2, idCounter: entries.length,
  planNote: { head, passes: { 'engine:codex-local': { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: [] },
  passes: { 'engine:codex-local': { head, reviewer: 'codex-local', findings: 0, open: 0, list: [] } },
  index: Object.fromEntries(entries.map((each) => [each.id, { seen: head, ...each }])),
});
const tablePost = (root, over = {}) => ({ reading: { visibility: 'PUBLIC', inside: true }, checker: textChecker({ context: CONTEXT, words: [] }), root, names: [], publish: { summary: 'findings', publicSecurity: 'counts' }, compareUrl: (from, to) => `https://github.com/o/r/compare/${from}...${to}`, ...over });
const rowsOf = (body) => body.split('\n').filter((line) => /^\| R\d+-\d+ \|/u.test(line));

test('the findings table: at most 40 rows, blocking findings first, then by severity, the rest counted in one line, and no finding text', (t) => {
  const { root, head } = tracked(t);
  const entries = [
    ...Array.from({ length: 30 }, (_, i) => entry(i + 1, { severity: 'low', state: 'accepted', disposition: 'acceptable_as_is' })),
    ...Array.from({ length: 15 }, (_, i) => entry(i + 31, { severity: i % 2 ? 'medium' : 'critical', disposition: 'fix_now', security: false })),
  ];
  const body = summaryBody(withIndex(head, entries), null, 'x', tablePost(root, { reading: PRIVATE }));
  const rows = rowsOf(body);
  assert.equal(rows.length, MAX_ROWS);
  assert.ok(rows.slice(0, 15).every((row) => / \| open \|$/u.test(row)), 'the blocking ones first');
  assert.ok(rows.slice(0, 8).every((row) => row.includes('| critical |')), 'then the most severe');
  assert.match(body, /^- 5 more findings, not listed: the table holds 40\.$/mu);
  assert.doesNotMatch(body.split('\n').filter((line) => !line.startsWith('<!--')).join('\n'), /SENTINEL/u, 'no finding text, even on a private repository');
  assert.equal(summaryBody(withIndex(head, entries), null, 'x', { ...tablePost(root), publish: { summary: 'counts' } }).includes('**Findings:**'), false, 'summary "counts" adds nothing');
});

test('the findings table`s outcomes: open, fixed in and not reported again in a compare link or the short SHAs, accepted as its disposition', (t) => {
  const { root, head } = tracked(t);
  const from = 'a'.repeat(40);
  const entries = [
    entry(1),
    entry(2, { state: 'fixed', closed_in: { from, to: head } }),
    entry(3, { state: 'not_reported', closed_in: { from, to: head } }),
    entry(4, { state: 'accepted', disposition: 'accepted_residual', severity: 'low' }),
    entry(5, { state: 'fixed', closed_in: { from, to: head } }),
  ];
  const linked = rowsOf(summaryBody(withIndex(head, entries), null, 'x', tablePost(root, { compareUrl: (a, b) => (a === from && b === head ? `https://github.com/o/r/compare/${a}...${b}` : null) })));
  const range = `${from.slice(0, 7)}...${head.slice(0, 7)}`;
  assert.deepEqual(linked, [
    '| R1-1 | src/a.js:2 | medium | fix\\_now | open |',
    `| R1-2 | src/a.js:3 | medium | fix\\_now | fixed in [${range}](https://github.com/o/r/compare/${from}...${head}) |`,
    `| R1-3 | src/a.js:4 | medium | fix\\_now | not reported again in [${range}](https://github.com/o/r/compare/${from}...${head}) |`,
    `| R1-5 | src/a.js:6 | medium | fix\\_now | fixed in [${range}](https://github.com/o/r/compare/${from}...${head}) |`,
    '| R1-4 | src/a.js:5 | low | accepted\\_residual | accepted as accepted\\_residual |',
  ]);
  const plain = rowsOf(summaryBody(withIndex(head, entries), null, 'x', tablePost(root, { compareUrl: () => null })));
  assert.equal(plain[1], `| R1-2 | src/a.js:3 | medium | fix\\_now | fixed in ${range} |`, 'no link from the forge: the short SHAs as text');
});

test('tableCell: one line, table and HTML metacharacters escaped, autolinks and owner/repo#n references neutralized, and only a plain https link', () => {
  assert.equal(tableCell('a\nb | c'), 'a b \\| c');
  assert.equal(tableCell('<img src=x> & *b* _i_ `c` [l](u)'), '&lt;img src=x&gt; &amp; \\*b\\* \\_i\\_ \\`c\\` \\[l\\](u)');
  assert.equal(tableCell('see https://evil.example and www.evil.example'), 'see https:​//evil.example and www​.evil.example');
  assert.equal(tableCell('closes o/r#12 and #7'), 'closes o/r#​12 and #​7');
  assert.equal(tableCell('src/GH-12.md and gh-3'), 'src/GH-\u200b12.md and gh-\u200b3', 'GitHub`s GH-<n> reference too');
  assert.equal(escapeLines([tableCell('docs/GH-12.md')])[0], 'docs/GH-\u200b12.md', 'and the post`s escaping keeps it neutral');
  assert.equal(tableCell('fixed in', { label: 'a...b', href: 'https://github.com/o/r/compare/a...b' }), 'fixed in [a...b](https://github.com/o/r/compare/a...b)');
  for (const href of ['javascript:alert(1)', 'https://x/ y', 'https://x/(y)', 'http://x', null]) assert.equal(tableCell('fixed in', { label: 'a...b', href }), 'fixed in a...b', String(href));
});

test('the findings table prints a location only from a file git tracks at the entry`s head and a line within it, on every reading', (t) => {
  const { root, head } = tracked(t);
  const entries = [entry(1, { file: 'src/gone.js' }), entry(2, { line: 999 }), entry(3, { file: '/etc/passwd' }), entry(4, { file: 'src/b.js', line: 7 })];
  for (const reading of [PRIVATE, { visibility: 'PUBLIC', inside: true }]) {
    const rows = rowsOf(summaryBody(withIndex(head, entries), null, 'x', tablePost(root, { reading })));
    assert.deepEqual(rows.map((row) => row.split(' | ')[1]), ['', 'src/a.js', '', 'src/b.js:7'], JSON.stringify(reading));
  }
});

test('a security finding and its twin on a repository that is not private: counted while open; once closed, a row of id, severity, outcome, and range alone; INTERNAL and a failed read are not private', (t) => {
  const { root, head } = tracked(t);
  const from = 'a'.repeat(40);
  const entries = [
    entry(1, { severity: 'high', security: true, line: 10 }),
    entry(2, { severity: 'medium', line: 11 }),
    entry(3, { severity: 'high', state: 'fixed', closed_in: { from, to: head }, line: 30 }),
    entry(4, { severity: 'low', file: 'src/b.js', line: 2 }),
  ];
  for (const reading of [{ visibility: 'PUBLIC', inside: true }, { visibility: 'INTERNAL', inside: true }, { visibility: null, inside: false }, { visibility: 'PRIVATE', inside: false }]) {
    const body = summaryBody(withIndex(head, entries), null, 'x', tablePost(root, { reading }));
    const rows = rowsOf(body);
    assert.match(body, /^- 2 open security findings, counted and not listed/mu, `${JSON.stringify(reading)}: the open one and its twin at its place`);
    assert.deepEqual(rows.map((row) => row.split(' | ')[0]), ['| R1-4', '| R1-3']);
    assert.ok(rows[1].startsWith('| R1-3 |  | high |  | fixed in ['), `${JSON.stringify(reading)}: ${rows[1]}`);
    const copy = stateFromComment(body, 7);
    for (const id of ['R1-1', 'R1-2', 'R1-3']) assert.deepEqual([copy.index[id].file, copy.index[id].line, copy.index[id].title], [undefined, undefined, undefined], id);
  }
  const shown = rowsOf(summaryBody(withIndex(head, entries), null, 'x', tablePost(root, { reading: PRIVATE })));
  assert.equal(shown.length, 4, 'on a private repository every finding is a row');
  const full = summaryBody(withIndex(head, entries), null, 'x', tablePost(root, { publish: { summary: 'findings', publicSecurity: 'full' } }));
  assert.equal(rowsOf(full).length, 4, 'publicSecurity "full": a security finding is a row like any other');
  assert.ok(rowsOf(full).includes('| R1-1 | src/a.js:10 | high | fix\\_now | open |'));
  assert.deepEqual([stateFromComment(full, 7).index['R1-1'].file, stateFromComment(full, 7).index['R1-1'].line], ['src/a.js', 10], 'and the posted copy holds its place');
  assert.doesNotMatch(full, /SENTINEL/u, 'never its text on a repository that is not private');
  const posted = JSON.stringify(stateFromComment(full, 7));
  assert.doesNotMatch(posted, /SENTINEL/u, 'nor in the posted copy of the record: no title, body, evidence, or reason');
});

test('publicSecurity "full": a security finding`s residual row keeps its place, never its text, on a repository that is not private', () => {
  const state = { ...emptyState(7, 'o/r'), passes: { p: { head: 'h', list: [{ id: 'R1-1', mint: '00000001', title: 'Leak', file: 'a.js', severity: 'high', security: true }] } } };
  const row = { pass: 'p', id: 'R1-1', title: 'Leak', file: 'a.js', line: 1, severity: 'high' };
  const checker = textChecker({ context: CONTEXT, words: [] });
  for (const reading of [{ visibility: 'PUBLIC', inside: true }, { visibility: 'INTERNAL', inside: true }, { visibility: null, inside: true }]) {
    assert.deepEqual(residualRows([row], state, { reading, checker }).rows, [{ pass: 'p', id: 'R1-1', severity: 'high', text: WITHHELD }], `${reading.visibility}: counts`);
    const full = residualRows([row], state, { reading, checker, publish: { publicSecurity: 'full' } });
    assert.deepEqual(full.rows, [{ pass: 'p', id: 'R1-1', file: 'a.js', line: 1, severity: 'high', text: WITHHELD }], `${reading.visibility}: full lifts the place alone`);
    assert.equal(full.withheld, 1);
  }
  assert.deepEqual(residualRows([row], state, { reading: PRIVATE, checker, publish: { publicSecurity: 'full' } }).rows, [row], 'on a private repository the row is whole');
  assert.deepEqual(residualRows([{ ...row, file: TOKEN }], state, { reading: { visibility: 'PUBLIC', inside: true }, checker, publish: { publicSecurity: 'full' } }).rows, [{ pass: 'p', id: 'R1-1', severity: 'high', text: WITHHELD }], 'a file the checks withhold is left out, and its line goes with it');
});

test('a finding first recorded as accepted keeps its recording head: the table keeps its file and line, also on a later refresh with no diff paths', (t) => {
  const { root, head } = tracked(t);
  const state = { ...emptyState(7, 'o/r'), revision: 2, floored: true, rounds: [{ head }], planNote: { head, passes: { 'engine:codex-local': { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: [] } };
  const late = { title: 'A late nit', file: 'src/a.js', line: 5, severity: 'low', state: 'accepted', disposition: 'accepted_residual', accepted_by: 'late-round' };
  const ruled = { title: 'A repeat', file: 'src/b.js', line: 7, severity: 'low', already_ruled: 'Settled one', from: 'prior' };
  recordFindings(state, 'engine:codex-local', { head, reviewer: 'codex-local', findings: 2, open: 0, list: [late], ruled: [ruled] }, { mint: true, paths: gitPaths(root).at(head), stage: 'independent' });
  const ids = [...state.passes['engine:codex-local'].list, ...state.passes['engine:codex-local'].ruled].map((each) => each.id);
  for (const id of ids) assert.equal(state.index[id].seen, head, `${id}: its recording head`);
  const post = (over = {}) => tablePost(root, { names: [], ...over });
  const where = (body) => rowsOf(body).map((row) => row.split(' | ').slice(0, 2).join(' | '));
  const first = summaryBody(state, null, 'x', post({ diffPaths: new Set() }));
  assert.deepEqual(where(first), [`| ${ids[0]} | src/a.js:5`, `| ${ids[1]} | src/b.js:7`]);
  // Later the pass moves to a head this checkout does not hold, and an edit refreshes the comment with no diff paths.
  state.passes['engine:codex-local'] = { head: '9'.repeat(40), reviewer: 'codex-local', findings: 0, open: 0, list: [] };
  state.revision += 1;
  const later = refreshSummary(first, state, post());
  assert.deepEqual(where(later), [`| ${ids[0]} | src/a.js:5`, `| ${ids[1]} | src/b.js:7`], 'still both');
});

test('a finding closed as fixed at a moved location keeps that location, checked at the head that recorded it, in the table and the posted index', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-moved-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const lines = (n) => Array.from({ length: n }, (_, i) => `${i}\n`).join('');
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/a.js'), lines(10));
  writeFileSync(path.join(dir, 'src/b.js'), lines(10));
  git('add', '-A');
  git('commit', '-qm', 'one');
  const h1 = git('rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'src/a.js'), lines(40));
  git('mv', 'src/b.js', 'src/d.js');
  writeFileSync(path.join(dir, 'src/d.js'), lines(40));
  git('add', '-A');
  git('commit', '-qm', 'two');
  const h2 = git('rev-parse', 'HEAD');
  const paths = gitPaths(dir);
  const note = { head: h2, passes: { 'engine:codex-local': { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: [] };
  const state = { ...emptyState(7, 'o/r'), revision: 2, floored: true, rounds: [{ head: h1 }], planNote: note };
  const open = (title, file) => ({ title, file, line: 5, severity: 'medium', likelihood: 'plausible', affects: 'users', state: 'open', disposition: 'fix_now' });
  const range = (seen, to) => ({ from: seen, to });
  recordFindings(state, 'engine:codex-local', { head: h1, reviewer: 'codex-local', list: [open('In a', 'src/a.js'), open('In b', 'src/b.js')] }, { mint: true, paths: paths.at(h1), stage: 'independent', range });
  const [a, b] = state.passes['engine:codex-local'].list.map((each) => each.id);
  state.rounds.push({ head: h2 });
  const fixed = (title, file, id) => ({ ...open(title, file), line: 30, state: 'fixed', returned_id: id });
  recordFindings(state, 'engine:codex-local', { head: h2, reviewer: 'codex-local', list: [fixed('In a', 'src/a.js', a), fixed('In b', 'src/d.js', b)] }, { mint: true, paths: paths.at(h2), listed: [a, b], stage: 'independent', range });
  assert.deepEqual([a, b].map((id) => [state.index[id].state, state.index[id].file, state.index[id].line, state.index[id].closed_in]), [['fixed', 'src/a.js', 30, { from: h1, to: h2 }], ['fixed', 'src/d.js', 30, { from: h1, to: h2 }]], 'closed on h2, its range still starting where it was last open');
  for (const diffPaths of [new Set(['src/a.js', 'src/d.js']), new Set()]) {
    const body = summaryBody(state, null, 'x', tablePost(dir, { diffPaths }));
    const rows = rowsOf(body).map((row) => row.split(' | ').slice(0, 2).join(' | '));
    assert.deepEqual(rows, [`| ${a} | src/a.js:30`, `| ${b} | src/d.js:30`], `diff paths: ${[...diffPaths].join(', ') || 'none'}`);
    const index = stateFromComment(body, 7).index;
    assert.deepEqual([a, b].map((id) => [index[id].file, index[id].line]), [['src/a.js', 30], ['src/d.js', 30]], 'the posted index keeps them too');
  }
});

// ---- Inline reviews (lib/review/inline.mjs) ----

const PASS = 'engine:codex-local';
const PUBLIC = { visibility: 'PUBLIC', inside: true };
const MINT = 'abcd0123';

// A repository whose head adds `added` lines to src/a.js after its first line, and the files `extra` names: { root, base,
// head }.
function inlineRepo(t, { added = 3, extra = {}, base: baseFiles = {}, remove = [] } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-inline-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  git('init', '-q', '-b', 'main');
  write('src/a.js', 'line 1\n');
  write('src/old.js', 'kept\nkept\nkept\n');
  for (const [file, text] of Object.entries(baseFiles)) write(file, text);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  write('src/a.js', `line 1\n${Array.from({ length: added }, (_, i) => `added ${i + 2}`).join('\n')}\n`);
  for (const [file, text] of Object.entries(extra)) write(file, text);
  for (const file of remove) rmSync(path.join(root, file));
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  return { root, base, head: git('rev-parse', 'HEAD') };
}

const listed = (id, extra = {}) => ({ id, mint: MINT, title: `finding ${id}`, body: 'what is wrong', file: 'src/a.js', line: 2, severity: 'medium', likelihood: 'likely', affects: 'users', disposition: 'fix_now', state: 'open', ...extra });
// A record whose one pass lists `findings`, each with its open index entry.
function inlineState(head, findings, { note = { stage: 'local', reviewer: 'codex-local', security: false } } = {}) {
  const list = findings.map((finding) => ({ ...finding }));
  const index = Object.fromEntries(findings.map((finding) => {
    const { body: _body, ...entry } = finding;
    return [finding.id, { ...entry, pass: PASS, stage: 'local', placed: head, seen: head }];
  }));
  const counter = Math.max(0, ...findings.map((finding) => Number(finding.id.split('-')[1])));
  return { ...emptyState(7, 'o/r'), idCounter: counter, floored: true, rounds: [{ head, at: '2026-11-12T00:00:00.000Z' }], passes: { [PASS]: { head, reviewer: 'codex-local', files: null, findings: list.length, open: list.length, list } }, planNote: { head, passes: { [PASS]: note } }, index };
}
const openOf = (state) => [{ pass: PASS, findings: state.passes[PASS].list }];
// A forge that records every call: postReview answers each inline comment with an id from 1001, unless `refuse`.
function inlineForge(overrides = {}) {
  const calls = [];
  const forge = {
    postReview: (repo, n, review) => (calls.push(['postReview', review]), { refused: false, id: 900, comments: review.comments.map((comment, i) => ({ id: 1001 + i, body: comment.body })) }),
    postComment: (repo, n, body) => (calls.push(['postComment', body]), { id: 77 }),
    ...overrides,
  };
  return { forge, calls };
}
const allow = () => ({ allows: () => true, failed: false });
function inlineStep({ root, base, head }, state, forge, { reading = PRIVATE, publish = { inline: true, publicSecurity: 'counts' }, checker = allow(), items = [] } = {}) {
  return { forge, repo: 'o/r', n: 7, head, base, root, state, paths: gitPaths(root), marked: { items }, post: () => ({ reading, checker, publish }) };
}
const reviewOf = (calls) => calls.find(([name]) => name === 'postReview')?.[1];

test('inline: a blocking finding on an added line gets a thread; one on an unchanged line, or in a file the check refuses, goes in the body', (t) => {
  const r = inlineRepo(t);
  const state = inlineState(r.head, [listed('R1-1'), listed('R1-2', { line: 1 }), listed('R1-3', { file: 'src/gone.js', line: 2 }), listed('R1-4', { file: 'src/old.js', line: 3 })]);
  const { forge, calls } = inlineForge();
  const result = postInline(inlineStep(r, state, forge), openOf(state));
  assert.deepEqual([result.posted, result.threads, result.in_body], [true, ['R1-1'], ['R1-2', 'R1-3', 'R1-4']]);
  const review = reviewOf(calls);
  assert.equal(review.commitId, r.head);
  assert.deepEqual(review.comments.map(({ path: file, line, side }) => [file, line, side]), [['src/a.js', 2, 'RIGHT']]);
  assert.ok(review.comments[0].body.startsWith(`${markerLine('R1-1')}\n${attributionLine('R1-1')}\n`));
  assert.deepEqual(leadingMarkers(review.body), ['R1-1', 'R1-2', 'R1-3', 'R1-4'], 'the body names every finding it holds, in the fixed layout');
  assert.match(review.body, /src\/a\.js:1/u);
  assert.match(review.body, /src\/old\.js:3/u);
  assert.ok(!review.body.includes('src/gone.js'), 'a file that is no tracked path is printed in no review body');
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001 });
  assert.deepEqual(['R1-2', 'R1-3', 'R1-4'].map((id) => state.index[id].thread), [{ reviewId: 900 }, { reviewId: 900 }, { reviewId: 900 }]);
  // The posted copy keeps the forge's ids, numbers alone, and still no finding text.
  const { copy } = postedCopy(state, { reading: PUBLIC, root: r.root, names: [] });
  assert.deepEqual(copy.index['R1-1'].thread, { reviewId: 900, commentId: 1001 });
  assert.ok(!JSON.stringify(copy).includes('finding R1-1') && !JSON.stringify(copy).includes('what is wrong'));
});

test('inline: one post per id, a finding listed twice posts once, and a later step posts nothing again', (t) => {
  const r = inlineRepo(t);
  const state = inlineState(r.head, [listed('R1-1')]);
  const { forge, calls } = inlineForge();
  const step = inlineStep(r, state, forge);
  postInline(step, [...openOf(state), { pass: 'slice:x', findings: [{ ...state.passes[PASS].list[0] }] }]);
  assert.equal(reviewOf(calls).comments.length, 1, 'one comment for one id, though two passes list it');
  assert.equal(postInline(step, openOf(state)), null, 'a finding with a thread is never posted again');
  state.index['R1-1'].thread = { fallbackId: 5 };
  assert.equal(postInline(step, openOf(state)), null, 'nor one a fallback comment holds');
  state.index['R1-1'].thread = { reviewId: 3 };
  assert.equal(postInline(step, openOf(state)), null, 'nor one a review body holds');
  assert.equal(calls.length, 1);
});

test('inline: a review holds at most 25 threads, the most severe first; the rest are listed in its body by id', (t) => {
  const r = inlineRepo(t, { added: 27 });
  const findings = Array.from({ length: 27 }, (_, i) => listed(`R1-${i + 1}`, { line: i + 2, severity: i === 26 ? 'critical' : 'medium' }));
  const state = inlineState(r.head, findings);
  const { forge, calls } = inlineForge();
  const result = postInline(inlineStep(r, state, forge), openOf(state));
  const review = reviewOf(calls);
  assert.equal(review.comments.length, MAX_THREADS);
  assert.equal(result.threads[0], 'R1-27', 'the critical finding first');
  assert.deepEqual(result.listed, ['R1-25', 'R1-26']);
  assert.match(review.body, /2 more findings on the diff, posted by a later step: R1-25, R1-26$/mu, 'listed by id alone');
  assert.ok(!leadingMarkers(review.body).includes('R1-25'), 'a listed finding is not posted');
  assert.equal(state.index['R1-25'].thread, undefined, 'and gets its thread from a later review');
  const next = inlineForge();
  postInline(inlineStep(r, state, next.forge), openOf(state));
  assert.deepEqual(reviewOf(next.calls).comments.map((comment) => comment.line), [26, 27]);
});

test('inline: a security finding and its twin get no thread and no line on a repository that is not private, under "counts"', (t) => {
  const r = inlineRepo(t);
  const findings = [listed('R1-1', { severity: 'high' }), listed('R1-2', { line: 3, title: 'another wording' }), listed('R1-3', { file: 'src/old.js', line: 1, title: 'elsewhere' })];
  for (const reading of [PUBLIC, { visibility: 'INTERNAL', inside: true }, { visibility: null, inside: true }]) {
    const state = inlineState(r.head, findings);
    const { forge, calls } = inlineForge();
    const result = postInline(inlineStep(r, state, forge, { reading }), openOf(state));
    assert.deepEqual([result.threads, result.in_body], [[], ['R1-3']], reading.visibility);
    const review = reviewOf(calls);
    assert.ok(!/R1-1|R1-2/u.test(review.body), 'neither the security finding nor its twin is named');
  }
  const state = inlineState(r.head, findings);
  const { forge } = inlineForge();
  assert.deepEqual(postInline(inlineStep(r, state, forge, { reading: PRIVATE }), openOf(state)).threads, ['R1-1', 'R1-2'], 'a private repository posts them');
  for (const reading of [PUBLIC, { visibility: 'INTERNAL', inside: true }, { visibility: null, inside: true }]) {
    const full = inlineState(r.head, findings);
    const posts = inlineForge();
    assert.deepEqual(postInline(inlineStep(r, full, posts.forge, { reading, publish: { inline: true, publicSecurity: 'full' } }), openOf(full)).threads, ['R1-1', 'R1-2'], '"full" gives them their threads');
    for (const comment of reviewOf(posts.calls).comments) {
      assert.ok(!comment.body.split('\n').some((line) => line.startsWith('>')) && !comment.body.includes('what is wrong') && !comment.body.includes('another wording'), `${reading.visibility}: "full" posts no title and no body`);
      assert.match(comment.body, new RegExp(`\\*\\*(high|medium)\\*\\*\\n${WITHHELD}$`, 'u'), 'only the id, the severity, its place by its anchor, and text withheld');
    }
    assert.match(reviewOf(posts.calls).body, /on the diff at `src\/a\.js:2`/u, 'the place shows under "full"');
  }
  // A finding on a pass the plan flags as requiring the security reviewer reads as security too.
  const flagged = inlineState(r.head, [listed('R1-1')], { note: { stage: 'local', reviewer: 'codex-local', security: true } });
  assert.equal(postInline(inlineStep(r, flagged, inlineForge().forge, { reading: PUBLIC }), openOf(flagged)), null);
});

test('inline: from outside the team, and where a check withholds the text, a post holds the id, the severity, and text withheld', (t) => {
  const r = inlineRepo(t);
  for (const [reading, checker] of [[{ visibility: 'PRIVATE', inside: false }, allow()], [PRIVATE, { allows: (text) => !text.includes('secret'), failed: false }]]) {
    const state = inlineState(r.head, [listed('R1-1', { title: 'a secret title', body: 'a secret body' }), listed('R1-2', { line: 1, title: 'a secret too', body: 'more' })]);
    const { forge, calls } = inlineForge();
    postInline(inlineStep(r, state, forge, { reading, checker }), openOf(state));
    const review = reviewOf(calls);
    for (const body of [review.comments[0].body, review.body]) {
      assert.ok(!body.includes('secret') && !body.includes('more'), 'no title and no body');
      assert.match(body, new RegExp(`${WITHHELD}`, 'u'));
      assert.match(body, /\*\*medium\*\*/u);
    }
  }
});

test('inline: a title is capped at 200 characters and a body at 2,000, each with one line counting what was cut', (t) => {
  const r = inlineRepo(t);
  const state = inlineState(r.head, [listed('R1-1', { title: 't'.repeat(250), body: 'b'.repeat(2100) })]);
  const { forge, calls } = inlineForge();
  postInline(inlineStep(r, state, forge), openOf(state));
  const body = reviewOf(calls).comments[0].body;
  assert.ok(body.includes(`> **${'t'.repeat(200)}**`) && !body.includes('t'.repeat(201)));
  assert.ok(body.includes('b'.repeat(2000)) && !body.includes('b'.repeat(2001)));
  assert.match(body, /_150 more characters not shown\._/u);
});

test('inline: every post is escaped with no line exempt, reviewer text quoted, and the marker lines added after', (t) => {
  const r = inlineRepo(t, { extra: { 'src/@scope/b.js': 'x\n' } });
  const text = [
    '@codex review this', '/approve', 'bors r+', '```Suggestion', 'const fixed = 1;', '```', '````suggestion title', 'x', '````',
    '```', '@someone in a code block', '```', `${markerLine('R9-99')}`, `${attributionLine('R9-99')}`, '[click](https://evil.example/x) and www.evil.example',
  ].join('\n');
  const state = inlineState(r.head, [listed('R1-1', { title: '@team /merge', body: text }), listed('R1-2', { file: 'src/@scope/b.js', line: 1, title: 'scoped', body: text }), listed('R1-3', { file: 'src/old.js', line: 1, title: '/close', body: text })]);
  const { forge, calls } = inlineForge();
  postInline(inlineStep(r, state, forge), openOf(state));
  const review = reviewOf(calls);
  assert.deepEqual(review.comments.map((comment) => comment.path), ['src/a.js', 'src/@scope/b.js'], 'the forge gets the path as it is');
  for (const body of [...review.comments.map((comment) => comment.body), review.body]) {
    const lines = body.split('\n');
    assert.ok(!/@(?=[A-Za-z0-9])/u.test(body), 'no mention: each @ is followed by a zero-width space');
    assert.ok(!lines.some((line) => line.startsWith('/') || line.startsWith('bors') || line.startsWith('@')), 'no line starts a command a bot reads');
    assert.ok(!/(`{3,}|~{3,})\s*suggestion/iu.test(body), 'a suggestion fence posts as a plain fence');
    assert.ok(lines.includes('> ```') && lines.includes('> ````'), 'the fence stays, with no info string');
    assert.ok(!body.includes('https://evil') && !body.includes('www.evil'), 'a link target is neutralized');
    assert.ok(lines.filter((line) => line.includes('R9-99')).every((line) => line.startsWith('> ')), 'the reviewer`s marker line is quoted text');
    assert.ok(!body.includes('<!-- aidrian-review-finding:R9-99'), 'and escaped');
  }
  assert.deepEqual(leadingMarkers(review.comments[0].body), ['R1-1']);
  assert.match(review.body, /src\/@​scope\/b\.js:1/u, 'a path that holds @ is escaped too');
  // The escaped marker in the text raises no counter.
  const items = [{ kind: 'review', id: 900, login: 'me', member: true, markers: leadingMarkers(review.body), starts: true }];
  assert.equal(raiseFloor({ idCounter: 3 }, items), 3, 'R9-99 is not read');
});

test('inline: a body that passes the forge`s limit only once escaped posts what fits and lists the rest by id', (t) => {
  const r = inlineRepo(t);
  const findings = Array.from({ length: 25 }, (_, i) => listed(`R1-${i + 1}`, { line: 1, body: '-->'.repeat(666) }));
  const state = inlineState(r.head, findings);
  const { forge, calls } = inlineForge();
  const result = postInline(inlineStep(r, state, forge), openOf(state));
  const review = reviewOf(calls);
  const raw = 25 * 2000;
  assert.ok(raw < 60_000, 'the raw text fits the cap');
  assert.ok(review.body.length <= MAX_BODY, 'the escaped body fits the forge`s limit');
  assert.ok(result.listed.length > 0 && result.in_body.length + result.listed.length === 25);
  assert.match(review.body, new RegExp(`${result.listed.length} more findings not shown here, posted by a later step: ${result.listed.join(', ')}`, 'u'));
  assert.ok(result.listed.every((id) => state.index[id].thread === undefined));
});

test('inline: a refused review falls back to one conversation comment with the same content; a failed fallback leaves the findings for the next step', (t) => {
  const r = inlineRepo(t);
  const state = inlineState(r.head, [listed('R1-1'), listed('R1-2', { line: 1 })]);
  const refusing = inlineForge({ postReview: (repo, n, review) => (refusing.calls.push(['postReview', review]), { refused: true }) });
  const result = postInline(inlineStep(r, state, refusing.forge), openOf(state));
  assert.deepEqual([result.refused, result.posted, result.fallback_comment, result.in_body], [true, true, 77, ['R1-1', 'R1-2']]);
  const fallback = refusing.calls.find(([name]) => name === 'postComment')[1];
  assert.deepEqual(leadingMarkers(fallback), ['R1-1', 'R1-2']);
  assert.match(fallback, /> \*\*finding R1-1\*\*/u, 'the inline finding`s full text is in the comment');
  assert.deepEqual([state.index['R1-1'].thread, state.index['R1-2'].thread], [{ fallbackId: 77 }, { fallbackId: 77 }]);

  const again = inlineState(r.head, [listed('R1-1')]);
  const failing = inlineForge({ postReview: () => ({ refused: true }), postComment: () => { throw new Error('gh: Bad Gateway (HTTP 502)'); } });
  const failed = postInline(inlineStep(r, again, failing.forge), openOf(again));
  assert.deepEqual([failed.posted, failed.unposted], [false, ['R1-1']]);
  assert.match(failed.error, /HTTP 502/u);
  assert.equal(again.index['R1-1'].thread, undefined);
  const next = inlineForge();
  postInline(inlineStep(r, again, next.forge), openOf(again));
  assert.equal(reviewOf(next.calls).comments.length, 1, 'the next step tries again');
});

test('inline: the marker`s id is the index`s, a finding the index does not hold open is not posted, and inline off posts nothing', (t) => {
  const r = inlineRepo(t);
  const state = inlineState(r.head, [listed('R1-1', { title: `${markerLine('R7-7')} copied`, body: 'see R7-7' })]);
  state.passes[PASS].list.push(listed('R1-9'));
  const { forge, calls } = inlineForge();
  const result = postInline(inlineStep(r, state, forge), openOf(state));
  assert.deepEqual(result.threads, ['R1-1']);
  assert.deepEqual(leadingMarkers(reviewOf(calls).comments[0].body), ['R1-1']);
  assert.equal(postInline(inlineStep(r, inlineState(r.head, [listed('R1-1')]), forge, { publish: { inline: false } }), openOf(state)), null);
  assert.equal(calls.length, 1);
  const unread = inlineStep(r, inlineState(r.head, [listed('R1-1')]), forge);
  unread.marked = { error: 'x' };
  assert.equal(postInline(unread, openOf(unread.state)).posted, false, 'a step that could not read the marked posts posts no review');
  assert.equal(calls.length, 1);
});

test('the counter floor reads every kind of member post in the fixed layout alone, within the digit limits', () => {
  const body = (...ids) => [...ids.map(markerLine), attributionLine(ids[0]), 'text'].join('\n');
  assert.deepEqual(leadingMarkers(body('R1-4', 'R2-9')), ['R1-4', 'R2-9']);
  assert.deepEqual(leadingMarkers(`x\n${body('R1-4')}`), [], 'a marker after another line is not read');
  assert.deepEqual(leadingMarkers(`${markerLine('R1-4')}\nsomething else`), [], 'nor one with no attribution line after it');
  assert.deepEqual(leadingMarkers(body('R1000-4')), [], 'a round past three digits is ignored');
  assert.deepEqual(leadingMarkers(body('R1-1234567')), [], 'an <n> past six digits is ignored');
  assert.deepEqual(leadingMarkers(`<!--  aidrian-review-finding:R1-4 -->\n${attributionLine('R1-4')}`), [], 'only the exact format');
  const item = (kind, ids, member = true) => ({ kind, id: 1, login: 'x', member, markers: ids, starts: true });
  for (const kind of ['comment', 'review', 'review_comment']) assert.equal(raiseFloor({ idCounter: 1 }, [item(kind, ['R3-40'])]), 40, kind);
  const state = { idCounter: 50 };
  raiseFloor(state, [item('comment', ['R3-40'])]);
  assert.equal(state.idCounter, 50, 'the floor only raises');
  const none = { idCounter: 1 };
  raiseFloor(none, [item('comment', ['R1-90'], false)]);
  assert.equal(none.idCounter, 1, 'a marker by someone who is no member raises nothing');
});

test('readMarked: each kind with its markers, a reply apart; a failed or partial read is an error', () => {
  const marked = (id) => [markerLine(id), attributionLine(id), 'x'].join('\n');
  const forge = {
    reviews: () => [{ id: 2, body: marked('R1-2'), user: { login: 'me' }, author_association: 'OWNER' }],
    reviewComments: () => [{ id: 3, body: marked('R1-3'), user: { login: 'me' }, author_association: 'MEMBER' }, { id: 4, body: 'thanks', in_reply_to_id: 3, user: { login: 'pat' }, author_association: 'COLLABORATOR' }],
  };
  const { items } = readMarked(forge, 'o/r', 7, [{ id: 1, body: marked('R1-1'), user: { login: 'eve' }, author_association: 'NONE' }]);
  assert.deepEqual(items.map(({ kind, id, member, markers, starts }) => [kind, id, member, markers, starts]), [
    ['comment', 1, false, ['R1-1'], true], ['review', 2, true, ['R1-2'], true], ['review_comment', 3, true, ['R1-3'], true], ['review_comment', 4, true, [], false],
  ]);
  assert.ok(readMarked({ ...forge, reviews: () => { throw new Error('down'); } }, 'o/r', 7, []).error);
  assert.ok(readMarked({ ...forge, reviewComments: () => [{ body: 'no id' }] }, 'o/r', 7, []).error, 'a partial read');
  assert.ok(readMarked(forge, 'o/r', 7, null).error, 'an unread conversation');
});

test('inline: an id with no thread whose marker a member`s post carries takes a fresh id, keeping every engine key and listing the old one as its alias', (t) => {
  const r = inlineRepo(t);
  const state = inlineState(r.head, [listed('R1-1')]);
  state.idCounter = 5;
  const items = [{ kind: 'review_comment', id: 44, login: 'pat', member: true, markers: ['R1-1'], starts: true }];
  const { forge, calls } = inlineForge();
  const result = postInline(inlineStep(r, state, forge, { items }), openOf(state));
  assert.deepEqual(result.threads, ['R1-6']);
  assert.deepEqual(leadingMarkers(reviewOf(calls).comments[0].body), ['R1-6'], 'no second comment under the old id');
  assert.equal(state.index['R1-1'], undefined);
  const entry = state.index['R1-6'];
  assert.deepEqual([entry.aliases, entry.pass, entry.stage, entry.state, entry.severity, entry.placed], [['R1-1'], PASS, 'local', 'open', 'medium', r.head]);
  assert.notEqual(entry.mint, MINT, 'with a mint mark of its own');
  assert.equal(state.passes[PASS].list[0].id, 'R1-6');
});

test('engine_comments and engine_comments_unmapped: mapped by the index, unmapped otherwise; a reply and a non-member`s post on neither', () => {
  const state = { index: {
    'R1-1': { id: 'R1-1', thread: { reviewId: 900, commentId: 61 } },
    'R1-2': { id: 'R1-2', thread: { reviewId: 900 } },
    'R1-3': { id: 'R1-3', aliases: ['R1-0'], thread: { fallbackId: 70 } },
  } };
  const item = (kind, id, markers, { member = true, starts = true, login = 'me' } = {}) => ({ kind, id, login, member, markers, starts });
  const items = [
    item('review_comment', 61, ['R1-1']),
    item('review', 900, ['R1-1', 'R1-2']),
    item('comment', 70, ['R1-0']),
    item('review_comment', 62, ['R1-1'], { login: 'pat' }),
    item('review_comment', 63, ['R1-5'], { login: 'pat' }),
    item('review_comment', 64, [], { starts: false }),
    item('comment', 71, ['R1-1'], { member: false, login: 'eve' }),
  ];
  const lists = engineLists(items, state);
  assert.deepEqual(lists.engine_comments.map((each) => each.id), [61, 900, 70]);
  assert.deepEqual(lists.engine_comments_unmapped.map((each) => each.id), [62, 63], 'another member`s marked comment, mapped or not by its id, is unmapped');
  assert.deepEqual(lists.engine_comments[0], { kind: 'review_comment', id: 61, findings: ['R1-1'], login: 'me' });
  assert.deepEqual(engineLists(items, null).engine_comments_unmapped.map((each) => each.id), [61, 900, 70, 62, 63], 'with no record, every marked post is unmapped');
});

// ---- The delete of the engine's own comment for a security finding ----

const VIEWER = 'me';
const ownBody = (...ids) => [...ids.map(markerLine), attributionLine(ids[0]), 'text'].join('\n');
// A forge for the delete: `comments` by id, each { kind, body, login, pr, member }; the visibility; every call recorded.
function deleteForge({ comments = {}, visibility = 'PUBLIC', failDelete = false, failRead = false } = {}) {
  const calls = [];
  const read = (kind) => (repo, nOrId, maybeId, options) => {
    const id = kind === 'review_comment' ? maybeId : nOrId;
    const pr = kind === 'review_comment' ? nOrId : maybeId?.pr;
    calls.push([`read ${kind}`, id]);
    if (failRead) throw new Error('gh: Bad Gateway (HTTP 502)');
    const comment = comments[id];
    if (!comment || comment.kind !== kind || comment.pr !== pr) return null;
    return { id, body: comment.body, user: { login: comment.login ?? VIEWER }, author_association: comment.member === false ? 'NONE' : 'MEMBER' };
  };
  const forge = {
    visibility: () => (calls.push(['visibility']), visibility),
    viewer: () => (calls.push(['viewer']), VIEWER),
    reviewComment: read('review_comment'),
    comment: read('comment'),
    deleteReviewComment: (repo, id) => (calls.push(['delete review_comment', id]), failDelete ? (() => { throw new Error('gh: (HTTP 502)'); })() : null),
    deleteComment: (repo, id) => (calls.push(['delete comment', id]), failDelete ? (() => { throw new Error('gh: (HTTP 502)'); })() : null),
  };
  return { forge, calls };
}
const securityState = (entries, note = { stage: 'local', reviewer: 'codex-local', security: false }) => ({
  ...emptyState(7, 'o/r'), planNote: { passes: { [PASS]: note } },
  index: Object.fromEntries(entries.map((entry) => [entry.id, { mint: MINT, state: 'open', pass: PASS, severity: 'medium', ...entry }])),
});
const sweep = (forge, state, extra = {}) => deleteOwn({ forge, repo: 'o/r', n: 7, state, items: null, mode: 'local', publicSecurity: 'counts', ...extra });

test('the delete: a finding rated high after its inline post, one on a head that requires the security reviewer, and a twin of a high finding lose their comment', () => {
  const cases = [
    ['rated high after its post', securityState([{ id: 'R1-1', severity: 'high', thread: { reviewId: 900, commentId: 61 } }])],
    ['carried onto a head whose plan requires the security reviewer', securityState([{ id: 'R1-1', thread: { reviewId: 900, commentId: 61 } }], { stage: 'local', reviewer: 'codex-local', security: true })],
    ['a medium finding whose twin is recorded as high', securityState([{ id: 'R1-1', file: 'src/a.js', line: 2, thread: { reviewId: 900, commentId: 61 } }, { id: 'R1-2', file: 'src/a.js', line: 3, severity: 'high' }])],
  ];
  for (const [name, state] of cases) {
    const { forge, calls } = deleteForge({ comments: { 61: { kind: 'review_comment', body: ownBody('R1-1'), pr: 7 } } });
    const out = sweep(forge, state);
    assert.deepEqual(out.deleted, [{ finding: 'R1-1', kind: 'review_comment', id: 61 }], name);
    assert.deepEqual(calls, [['visibility'], ['viewer'], ['read review_comment', 61], ['delete review_comment', 61]], name);
    assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900 }, `${name}: the delete takes the comment's id out of the thread`);
    const again = deleteForge();
    assert.equal(sweep(again.forge, state), null, `${name}: a later step reads no comment for it`);
    assert.deepEqual(again.calls, []);
  }
});

test('the delete leaves another member`s comment, listed as waiting, and deletes nothing for an unmarked, wrongly marked, gone, or foreign comment, or a failed read', () => {
  const state = () => securityState([
    { id: 'R1-1', severity: 'high', thread: { commentId: 61 } },
    { id: 'R1-2', severity: 'high', thread: { commentId: 62 } },
    { id: 'R1-3', severity: 'high', thread: { commentId: 63 } },
    { id: 'R1-4', severity: 'high', thread: { commentId: 64 } },
    { id: 'R1-5', severity: 'high', thread: { fallbackId: 65 } },
  ]);
  const comments = {
    61: { kind: 'review_comment', body: ownBody('R1-1'), pr: 7, login: 'pat' },
    62: { kind: 'review_comment', body: 'my own words, no marker', pr: 7 },
    63: { kind: 'review_comment', body: ownBody('R1-9'), pr: 7 },
    64: { kind: 'review_comment', body: ownBody('R1-4'), pr: 8 },
    65: { kind: 'comment', body: ownBody('R1-5'), pr: 7, login: 'eve', member: false },
  };
  const held = state();
  const { forge, calls } = deleteForge({ comments });
  const out = sweep(forge, held);
  assert.deepEqual(out.deleted, []);
  assert.deepEqual(out.waiting, [{ finding: 'R1-1', kind: 'review_comment', id: 61, login: 'pat' }]);
  assert.deepEqual(out.left.map((each) => each.id), [62, 63, 65]);
  // A comment the forge does not find on this pull request, deleted by hand or another pull request's, is gone: the
  // record maps it no more, so no later step reads it again.
  assert.deepEqual(out.gone, [{ finding: 'R1-4', kind: 'review_comment', id: 64 }]);
  assert.ok(!calls.some(([name]) => name.startsWith('delete')));
  assert.deepEqual(Object.values(held.index).map((entry) => entry.thread), Object.values(state().index).map((entry) => (entry.id === 'R1-4' ? undefined : entry.thread)), 'every other thread unchanged');
  const failing = deleteForge({ comments, failRead: true });
  assert.deepEqual(sweep(failing.forge, state()).left.length, 5, 'a read that fails deletes nothing');
});

test('the delete: a failed delete is named and tried again; a deleted fallback comment`s other findings are posted again', (t) => {
  const state = securityState([{ id: 'R1-1', severity: 'high', thread: { fallbackId: 70 } }]);
  const comments = { 70: { kind: 'comment', body: ownBody('R1-1', 'R1-2'), pr: 7 } };
  const failing = deleteForge({ comments, failDelete: true });
  assert.deepEqual(sweep(failing.forge, state).failed, [{ finding: 'R1-1', kind: 'comment', id: 70 }]);
  assert.deepEqual(state.index['R1-1'].thread, { fallbackId: 70 });
  const { forge, calls } = deleteForge({ comments });
  assert.deepEqual(sweep(forge, state).deleted, [{ finding: 'R1-1', kind: 'comment', id: 70 }], 'the next step tries again');
  assert.ok(calls.some(([name, id]) => name === 'delete comment' && id === 70));

  const r = inlineRepo(t);
  const posted = inlineState(r.head, [listed('R1-1', { severity: 'high' }), listed('R1-2', { file: 'src/old.js', line: 1, title: 'elsewhere' })]);
  posted.index['R1-1'].thread = { fallbackId: 70 };
  posted.index['R1-2'].thread = { fallbackId: 70 };
  sweep(deleteForge({ comments }).forge, posted);
  assert.equal(posted.index['R1-2'].thread, undefined, 'the other finding the comment listed reads as unposted');
  const next = inlineForge();
  assert.deepEqual(postInline(inlineStep(r, posted, next.forge, { reading: PUBLIC }), openOf(posted)).in_body, ['R1-2'], 'and a later step posts it again');
});

test('the delete: no candidate makes no forge call, and a private repository keeps the comment', () => {
  const quiet = new Proxy({}, { get: (_, name) => () => assert.fail(`no forge call: ${String(name)}`) });
  assert.equal(sweep(quiet, securityState([{ id: 'R1-1', thread: { commentId: 61 } }])), null, 'no security finding');
  assert.equal(sweep(quiet, securityState([{ id: 'R1-1', severity: 'high' }])), null, 'a security finding with no comment');
  const { forge, calls } = deleteForge({ visibility: 'PRIVATE', comments: { 61: { kind: 'review_comment', body: ownBody('R1-1'), pr: 7 } } });
  sweep(forge, securityState([{ id: 'R1-1', severity: 'high', thread: { commentId: 61 } }]));
  assert.deepEqual(calls, [['visibility']], 'a repository that reads PRIVATE keeps the comment');
});

test('the delete runs under publicSecurity "full" too: a post that holds the finding`s text goes, one that holds none is spared', () => {
  const posted = (...ids) => [...ids.map(markerLine), ...ids.flatMap((id) => [attributionLine(id), '**medium**', `> **${id} described**`, '> how to exploit it'])].join('\n');
  const textless = (id) => [markerLine(id), attributionLine(id), '**high**', WITHHELD].join('\n');
  const state = () => securityState([
    { id: 'R1-1', severity: 'high', thread: { commentId: 61 } },
    { id: 'R1-2', severity: 'high', thread: { commentId: 62 } },
    { id: 'R1-3', severity: 'high', thread: { fallbackId: 70 } },
  ]);
  const comments = {
    61: { kind: 'review_comment', body: posted('R1-1'), pr: 7 },
    62: { kind: 'review_comment', body: textless('R1-2'), pr: 7 },
    // A fallback comment whose section of R1-3 holds no text, beside another finding's that does: it is spared.
    70: { kind: 'comment', body: [markerLine('R1-3'), markerLine('R1-4'), attributionLine('R1-3'), '**high**', WITHHELD, '', attributionLine('R1-4'), '**low**', '> other text'].join('\n'), pr: 7 },
  };
  const full = deleteForge({ comments });
  const out = sweep(full.forge, state(), { publicSecurity: 'full' });
  assert.deepEqual(out.deleted.map((each) => each.id), [61], 'the comment posted with its text before the mark');
  assert.deepEqual(out.textless.map((each) => each.id), [62, 70]);
  const counts = deleteForge({ comments });
  assert.deepEqual(sweep(counts.forge, state()).deleted.map((each) => each.id), [61, 62, 70], 'under "counts" even a text-less post goes: its place shows');
});

test('the delete reaches a marked comment no record maps, of a security id or its alias; it leaves one of another id, another member`s, and every unmapped one under a local record', () => {
  const state = () => securityState([{ id: 'R1-1', severity: 'high', aliases: ['R1-0'] }, { id: 'R1-2' }]);
  const item = (kind, id, markers, login = VIEWER) => ({ kind, id, login, member: true, markers, starts: true });
  const items = [item('review_comment', 81, ['R1-1']), item('comment', 82, ['R1-0']), item('review_comment', 83, ['R1-2']), item('review_comment', 84, ['R1-1'], 'pat'), item('review', 85, ['R1-1'])];
  const comments = { 81: { kind: 'review_comment', body: ownBody('R1-1'), pr: 7 }, 82: { kind: 'comment', body: ownBody('R1-0'), pr: 7 } };
  const { forge, calls } = deleteForge({ comments });
  const out = sweep(forge, state(), { items, mode: 'posted' });
  assert.deepEqual(out.deleted.map((each) => each.id), [81, 82]);
  assert.deepEqual(out.waiting, [{ finding: 'R1-1', kind: 'review_comment', id: 84, login: 'pat' }]);
  assert.ok(!calls.some(([, id]) => id === 83 || id === 85), 'one of an id that is not security-marked, and a review body, get no call');
  const unread = deleteForge({ comments: { 61: { kind: 'review_comment', body: ownBody('R1-1'), pr: 7 } } });
  const partial = sweep(unread.forge, securityState([{ id: 'R1-1', severity: 'high', thread: { commentId: 61 } }]), { items: null, mode: 'posted' });
  assert.deepEqual([partial.deleted.map((each) => each.id), partial.unmapped_unread], [[61], true], 'a failed read of the marked comments deletes what the record maps and says it looked for no other');
  const local = deleteForge({ comments });
  assert.equal(sweep(local.forge, state(), { items, mode: 'local' }), null, 'under a local record an unmapped comment is left');
  assert.deepEqual(local.calls, []);
});

test('the delete on a held record changes no record, and a mapped comment a whole read no longer holds gets no call', () => {
  const state = securityState([{ id: 'R1-1', severity: 'high', thread: { commentId: 61 } }]);
  const before = JSON.stringify(state);
  const { forge } = deleteForge({ comments: { 61: { kind: 'review_comment', body: ownBody('R1-1'), pr: 7 } } });
  const items = [{ kind: 'review_comment', id: 61, login: VIEWER, member: true, markers: ['R1-1'], starts: true }];
  assert.deepEqual(sweep(forge, state, { items, mode: 'held' }).deleted.map((each) => each.id), [61]);
  assert.equal(JSON.stringify(state), before, 'a held record is not changed');
  const after = deleteForge();
  const out = sweep(after.forge, state, { items: [], mode: 'posted' });
  assert.deepEqual([out.gone, after.calls], [[{ finding: 'R1-1', kind: 'review_comment', id: 61 }], []], 'the step after it makes no call for that comment');
  assert.equal(state.index['R1-1'].thread, undefined, 'and its write takes the id out of the thread');
});

test('inline: a review body is capped at 60,000 characters before escaping, the findings past it listed by id for a later step', (t) => {
  const r = inlineRepo(t);
  const findings = Array.from({ length: 32 }, (_, i) => listed(`R1-${i + 1}`, { line: 1, body: 'x'.repeat(2000) }));
  const state = inlineState(r.head, findings);
  const { forge, calls } = inlineForge();
  const result = postInline(inlineStep(r, state, forge), openOf(state));
  const review = reviewOf(calls);
  assert.ok(result.listed.length > 0, 'some findings are past the cap');
  const shown = review.body.split('\n').filter((line) => !line.startsWith('<!-- ') && !line.includes('not shown here')).join('\n');
  assert.ok(shown.length <= 60_000, `the raw sections fit the cap: ${shown.length}`);
  assert.equal(result.in_body.length + result.listed.length, 32);
  assert.ok(result.listed.every((id) => state.index[id].thread === undefined));
});

test('inline: every link form in reviewer text is inert, an at-sign in a link target included, and every fence opener drops a suggestion info string', (t) => {
  const r = inlineRepo(t);
  const text = [
    '[profile](https://github.com/@octocat)', 'see https://github.com/@team for it', '[b](//evil.example/x)', '[c](https:/evil.example)',
    '[d](https:\\evil.example)', '[e]: https://evil.example', 'and [e] again', '<a href="https://evil.example">click</a>', '<https://evil.example>',
    '> ```suggestion', 'x', '> ```', '```&#115;uggestion', 'y', '```', '```&#x73;uggestion', '```', '- ~~~~SUGGESTION', '~~~~',
  ].join('\n');
  const state = inlineState(r.head, [listed('R1-1', { body: text }), listed('R1-2', { file: 'src/old.js', line: 1, body: text })]);
  const { forge, calls } = inlineForge();
  postInline(inlineStep(r, state, forge), openOf(state));
  const review = reviewOf(calls);
  for (const body of [review.comments[0].body, review.body]) {
    assert.ok(!/@(?=[A-Za-z0-9])/u.test(body), 'no at-sign before a login character, inside a link or not');
    assert.ok(!/\]\(|\]:|<a\b|<https?:|[a-z]:\/|[a-z]:\\/iu.test(body), 'no link, reference definition, HTML anchor, or autolink stays whole');
    assert.ok(!/(?:`{3,}|~{3,}).*(?:uggestion|&#)/iu.test(body), 'no fence opener keeps a suggestion info string, however spelled');
    assert.ok(body.split('\n').includes('> > ```'), 'a quoted fence stays a fence, with no info string');
  }
});

test('fitBody: the not-shown-here notice counts in the fit, so a body that fits only without it leaves one more finding out', () => {
  const part = (id, size) => ({ id, lines: [{ text: attributionLine(id) }, { text: '-->'.repeat(size) }] });
  // The largest second part that fits beside the first when nothing is left: the body is then at the forge's limit.
  let size = 1;
  while (fitBody([part('R1-1', 1000), part('R1-2', size + 1)]).left.length === 0) size += 1;
  assert.ok(fitBody([part('R1-1', 1000), part('R1-2', size)]).body.length > MAX_BODY - 30, 'the pair fills the body to within a few characters of the limit');
  const result = fitBody([part('R1-1', 1000), part('R1-2', size), part('R1-3', 30_000)]);
  assert.ok(result.body.length <= MAX_BODY, `the body with its notice fits: ${result.body.length}`);
  assert.deepEqual(result.left, ['R1-2', 'R1-3'], 'the part that fit only without the notice is left out too');
  assert.match(result.body, /2 more findings not shown here, posted by a later step: R1-2, R1-3$/u);
});

test('inline: a path the text checks refuse is printed nowhere and anchors nothing; the finding goes in the body with no location', (t) => {
  const r = inlineRepo(t, { extra: { 'clients/acme/billing.js': 'x\n' } });
  const state = inlineState(r.head, [listed('R1-1', { file: 'clients/acme/billing.js', line: 1, title: 'bill' })]);
  const { forge, calls } = inlineForge();
  const checker = { allows: (text) => !text.includes('acme'), failed: false };
  const result = postInline(inlineStep(r, state, forge, { checker }), openOf(state));
  assert.deepEqual([result.threads, result.in_body], [[], ['R1-1']]);
  const review = reviewOf(calls);
  assert.deepEqual(review.comments, []);
  assert.ok(!review.body.includes('acme'), 'the path is in no post');
  assert.match(review.body, /aidrian review, finding R1-1\n\*\*medium\*\*\n/u);
});

test('inline: an unchanged line of a renamed file is no added line: it goes in the body, and the edited line gets its thread', (t) => {
  const lines = Array.from({ length: 10 }, (_, i) => `const line${i + 1} = ${i + 1};`);
  const moved = lines.map((line, i) => (i === 4 ? 'const line5 = 50;' : line));
  const r = inlineRepo(t, { base: { 'src/before.js': `${lines.join('\n')}\n` }, extra: { 'src/after/moved.js': `${moved.join('\n')}\n` }, remove: ['src/before.js'] });
  const state = inlineState(r.head, [listed('R1-1', { file: 'src/after/moved.js', line: 2 }), listed('R1-2', { file: 'src/after/moved.js', line: 5, title: 'edited' })]);
  const { forge, calls } = inlineForge();
  const result = postInline(inlineStep(r, state, forge), openOf(state));
  assert.deepEqual([result.threads, result.in_body], [['R1-2'], ['R1-1']]);
  assert.deepEqual(reviewOf(calls).comments.map((comment) => [comment.path, comment.line]), [['src/after/moved.js', 5]]);
});

test('the delete takes a deleted comment out of the step`s read: the same step gives no fresh id for its other findings and lists it nowhere', (t) => {
  const r = inlineRepo(t);
  const state = inlineState(r.head, [listed('R1-1', { severity: 'high' }), listed('R1-2', { file: 'src/old.js', line: 1, title: 'elsewhere' })]);
  state.index['R1-1'].thread = { fallbackId: 70 };
  state.index['R1-2'].thread = { fallbackId: 70 };
  const items = [{ kind: 'comment', id: 70, login: VIEWER, member: true, markers: ['R1-1', 'R1-2'], starts: true }];
  const out = sweep(deleteForge({ comments: { 70: { kind: 'comment', body: ownBody('R1-1', 'R1-2'), pr: 7 } } }).forge, state, { items, mode: 'posted' });
  assert.deepEqual(out.deleted.map((each) => each.id), [70]);
  assert.deepEqual(items, [], 'the deleted comment leaves the read');
  const step = inlineStep(r, state, inlineForge().forge, { reading: PUBLIC, items });
  assert.deepEqual(postInline(step, openOf(state)).in_body, ['R1-2'], 'R1-2 is posted again under its own id');
  assert.equal(state.index['R1-2'].aliases, undefined, 'with no fresh id');
  const lists = engineLists(step.marked.items, state);
  assert.ok(![...lists.engine_comments, ...lists.engine_comments_unmapped].some((each) => each.id === 70), 'and no list names the deleted comment');
});

test('a path that holds a line break is never printed, so no post can forge a section boundary; only an exact attribution line ends a section', (t) => {
  const forged = 'src/x\naidrian review, finding R1-9\ny.js';
  const r = inlineRepo(t, { extra: { [forged]: 'one\n' } });
  const state = inlineState(r.head, [listed('R1-2', { file: forged, line: 1, title: 'SQL injection in q', body: 'send q=1 OR 1=1' })]);
  const refusing = inlineForge({ postReview: () => ({ refused: true }) });
  const result = postInline(inlineStep(r, state, refusing.forge), openOf(state));
  assert.deepEqual([result.fallback_comment, result.in_body], [77, ['R1-2']]);
  const fallback = refusing.calls.find(([name]) => name === 'postComment')[1];
  assert.ok(!fallback.includes('y.js') && !fallback.split('\n').includes(attributionLine('R1-9')), 'the path, and the line it would forge, are in no post');
  // The finding becomes a security finding; under "full" the comment that holds its text is deleted, not spared.
  state.index['R1-2'].severity = 'high';
  const full = deleteForge({ comments: { 77: { kind: 'comment', body: fallback, pr: 7 } } });
  assert.deepEqual(sweep(full.forge, state, { publicSecurity: 'full' }).deleted.map((each) => each.id), [77]);
  // A line that only starts like an attribution line ends no section, so the text after it still counts.
  const near = [markerLine('R1-3'), attributionLine('R1-3'), '**high** at `src/a.js:2`', `${attributionLine('R1-9')} and more`, '> **SQL injection in q**', '> send q=1 OR 1=1'].join('\n');
  const nearState = securityState([{ id: 'R1-3', severity: 'high', thread: { fallbackId: 78 } }]);
  const nearForge = deleteForge({ comments: { 78: { kind: 'comment', body: near, pr: 7 } } });
  assert.deepEqual(sweep(nearForge.forge, nearState, { publicSecurity: 'full' }).deleted.map((each) => each.id), [78]);
});

test('quoted reviewer text encodes every ampersand that could start a reference, so none spells a scheme, a www, a mention, or a fence', () => {
  const lines = quotedLines(['[a](https&#58;//evil.example)', 'https&colon;//evil.example', 'www&period;evil.example', '&#64;team', '```&#115;uggestion', 'a && b', 'x &amp y', '&lt;a href&gt;'].join('\n'));
  assert.deepEqual(lines, [
    '> [a]​(https&amp;#58;//evil.example)', '> https&amp;colon;//evil.example', '> www&amp;period;evil.example', '> &amp;#64;team', '> ```',
    '> a && b', '> x &amp;amp y', '> &amp;lt;a href&amp;gt;',
  ]);
  assert.ok(lines.every((line) => !/&(?!amp;)(?=[#A-Za-z])/u.test(line)), 'no ampersand that could start a reference reaches the renderer');
});

test('inline: the lines that list leftover findings are bounded, so 200 findings on a long path full of @ still post a review that fits', (t) => {
  // The bot's probe: a 293-character path whose every @ escapes to two characters, and 175 findings past the 25 threads.
  const dir = `src/${'@a-'.repeat(80)}`;
  const file = `${dir}/${'x'.repeat(293 - dir.length - 4)}.js`;
  assert.equal(file.length, 293);
  const r = inlineRepo(t, { extra: { [file]: `${Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join('\n')}\n` } });
  const findings = Array.from({ length: 200 }, (_, i) => listed(`R1-${i + 1}`, { file, line: i + 1 }));
  const state = inlineState(r.head, findings);
  const { forge, calls } = inlineForge();
  const result = postInline(inlineStep(r, state, forge), openOf(state));
  const review = reviewOf(calls);
  assert.ok(review, 'a review is posted');
  assert.equal(review.comments.length, MAX_THREADS);
  assert.ok(review.body.length <= MAX_BODY, `the body fits the forge's limit: ${review.body.length}`);
  assert.deepEqual(result.in_body, [], 'no finding sat outside the diff');
  assert.equal(result.listed.length, 175);
  const ids = Array.from({ length: MAX_LISTED }, (_, i) => `R1-${i + 26}`).join(', ');
  assert.match(review.body, new RegExp(`175 more findings on the diff, posted by a later step: ${ids}, and ${175 - MAX_LISTED} more$`, 'mu'));
  // The fit's own notice is bounded the same way: a section still fits beside a thousand leftover findings.
  const part = (id, size) => ({ id, lines: [{ text: attributionLine(id) }, { text: '-->'.repeat(size) }] });
  const fitted = fitBody([part('R1-1', 666), ...Array.from({ length: 1000 }, (_, i) => part(`R2-${i + 1}`, 30_000))]);
  assert.deepEqual(fitted.ids, ['R1-1']);
  assert.ok(fitted.body.length <= MAX_BODY);
  assert.match(fitted.body, new RegExp(`1000 more findings not shown here, posted by a later step: R2-1, .*R2-${MAX_LISTED}, and ${1000 - MAX_LISTED} more$`, 'u'));
});

// ---- Replies (lib/review/inline.mjs answerThreads) ----

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
const COMPARE = `https://github.com/o/r/compare/${FROM}...${TO}`;
// A closed index entry posted as an inline thread: the review 900, its root comment 1000 + the id's number.
const closedEntry = (id, extra = {}) => ({ id, mint: MINT, file: 'src/a.js', line: 2, severity: 'medium', disposition: 'fix_now', state: 'fixed', pass: PASS, stage: 'local', closed_in: { from: FROM, to: TO }, thread: { reviewId: 900, commentId: 1000 + Number(id.split('-')[1]) }, ...extra });
const repliesState = (...entries) => ({ ...emptyState(7, 'o/r'), idCounter: 9, floored: true, planNote: { head: TO, passes: { [PASS]: { stage: 'local', reviewer: 'codex-local', security: false } } }, index: Object.fromEntries(entries.map((entry) => [entry.id, entry])) });
const rootOf = (id, extra = {}) => ({ id: 1000 + Number(id.split('-')[1]), body: [markerLine(id), attributionLine(id), '> what is wrong'].join('\n'), user: { login: VIEWER }, author_association: 'OWNER', ...extra });
// A forge whose threads are `threads` (root comment id -> { resolved, comments }), recording every call; a reply joins its
// thread with an id from 2001.
function replyForge(threads = {}, { failReply = false, failResolve = false, failRead = false, failUnresolve = false, firstId = 2001 } = {}) {
  const calls = [];
  let next = firstId;
  const forge = {
    viewer: () => (calls.push(['viewer']), VIEWER),
    // Every thread at once, as the adapter reads them: each keyed by its root here, the root its first comment.
    findingThreads: () => {
      calls.push(['findingThreads']);
      if (failRead) throw new Error('gh: (HTTP 502)');
      return Object.values(threads).map((thread) => ({ resolved: false, complete: true, ...thread, comments: [...thread.comments] }));
    },
    unresolveThread: (repo, n, id) => {
      calls.push(['unresolve', id]);
      if (failUnresolve) throw new Error('gh: (HTTP 502)');
      threads[id].resolved = false;
      return { resolved: false };
    },
    replyToReviewComment: (repo, n, id, body) => {
      calls.push(['reply', id, body]);
      if (failReply) throw new Error('gh: (HTTP 502)');
      const reply = { id: next++, body, user: { login: VIEWER }, author_association: 'OWNER' };
      threads[id].comments.push(reply);
      return reply;
    },
    // As the adapter does: the thread read again, and nothing resolved when it holds a comment outside `only`.
    resolveThread: (repo, n, id, { only } = {}) => {
      calls.push(['resolve', id, only]);
      if (failResolve) throw new Error('gh: (HTTP 502)');
      if (Array.isArray(only) && threads[id].comments.some((comment) => !only.includes(comment.id))) return { resolved: false, others: true };
      threads[id].resolved = true;
      return { resolved: true };
    },
  };
  return { forge, calls, threads };
}
const threadOf = (id, rest = []) => ({ [1000 + Number(id.split('-')[1])]: { comments: [rootOf(id), ...rest] } });
function replyStep(state, forge, { reading = PUBLIC, publish = { inline: true, replies: true, publicSecurity: 'counts' }, checker = allow(), compareUrl = () => COMPARE, deletes = null, items = [] } = {}) {
  return { forge, repo: 'o/r', n: 7, state, deletes, marked: { items }, post: () => ({ reading, checker, publish, compareUrl }) };
}
const replies = (calls) => calls.filter(([name]) => name === 'reply');

test('replies: fixed, not reported again, and accepted each get one reply, the marker and attribution lines, then the outcome, and no reviewer text', () => {
  const state = repliesState(closedEntry('R1-1', { title: 'the secret title' }), closedEntry('R1-2', { state: 'not_reported' }), closedEntry('R1-3', { state: 'accepted', disposition: 'acceptable_as_is', closed_in: undefined }));
  const { forge, calls } = replyForge({ ...threadOf('R1-1'), ...threadOf('R1-2'), ...threadOf('R1-3') });
  const result = answerThreads(replyStep(state, forge));
  assert.deepEqual([result.replied, result.resolved, result.unanswered], [['R1-1', 'R1-2', 'R1-3'], ['R1-1', 'R1-2', 'R1-3'], []]);
  const bodies = Object.fromEntries(replies(calls).map(([, id, body]) => [id, body]));
  assert.equal(bodies[1001], [markerLine('R1-1'), attributionLine('R1-1'), `Fixed in [aaaaaaa...bbbbbbb](${COMPARE}).`].join('\n'));
  assert.equal(bodies[1002], [markerLine('R1-2'), attributionLine('R1-2'), `Not reported again in [aaaaaaa...bbbbbbb](${COMPARE}).`].join('\n'));
  assert.equal(bodies[1003], [markerLine('R1-3'), attributionLine('R1-3'), 'Accepted as acceptable_as_is.'].join('\n'));
  assert.ok(!Object.values(bodies).some((body) => body.includes('secret') || body.includes('what is wrong')), 'a reply holds no reviewer text');
  for (const body of Object.values(bodies)) assert.equal(leadingMarkers(body).length, 1, 'each reply starts with its finding`s marker in the fixed layout');
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, replied: true, replyId: 2001, resolved: true });
  // The posted copy keeps the marks and the reply's id, numbers and booleans alone.
  const { copy } = postedCopy(state, { reading: PUBLIC, names: [] });
  assert.deepEqual(copy.index['R1-1'].thread, { reviewId: 900, commentId: 1001, replied: true, replyId: 2001, resolved: true });
});

test('replies: escaping runs on the final raw body; a link the forge does not build, or the checks refuse, falls back to the short SHAs', () => {
  const state = repliesState(closedEntry('R1-1'));
  const tagged = replyForge(threadOf('R1-1'));
  answerThreads(replyStep(state, tagged.forge, { compareUrl: () => `${COMPARE}?x=@bot` }));
  const [, , body] = replies(tagged.calls)[0];
  assert.ok(body.includes('x=@​bot') && !/(?<![\w/])@bot/u.test(body.replaceAll('@​', '')), 'a mention in the link is neutralized');
  for (const options of [{ compareUrl: () => null }, { compareUrl: () => 'javascript:alert(1)' }, { checker: { allows: (text) => !text.includes('https://'), failed: false } }]) {
    const fresh = repliesState(closedEntry('R1-1'));
    const posts = replyForge(threadOf('R1-1'));
    answerThreads(replyStep(fresh, posts.forge, options));
    assert.equal(replies(posts.calls)[0][2].split('\n').at(-1), 'Fixed in aaaaaaa...bbbbbbb.');
  }
  const refused = repliesState(closedEntry('R1-1'));
  const checker = { allows: () => false, failed: false };
  const none = replyForge(threadOf('R1-1'));
  const result = answerThreads(replyStep(refused, none.forge, { checker }));
  assert.deepEqual([replies(none.calls), result.unanswered, refused.index['R1-1'].thread.replied], [[], ['R1-1'], undefined], 'a reply every candidate of which the checks refuse is not posted, and the next step tries again');
});

test('replies: once; the reply posts and the resolve fails, then the next step only resolves', () => {
  const state = repliesState(closedEntry('R1-1'));
  const posts = replyForge(threadOf('R1-1'), { failResolve: true });
  const first = answerThreads(replyStep(state, posts.forge));
  assert.deepEqual([first.replied, first.resolved, first.unanswered], [['R1-1'], [], ['R1-1']]);
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, replied: true, replyId: 2001 }, 'replied is set, resolved is not');
  const next = replyForge(posts.threads);
  const second = answerThreads(replyStep(state, next.forge));
  assert.deepEqual([replies(next.calls), second.resolved, second.unanswered], [[], ['R1-1'], []], 'the next step only resolves');
  assert.equal(state.index['R1-1'].thread.resolved, true);
  const third = replyForge(posts.threads);
  assert.equal(answerThreads(replyStep(state, third.forge)), null, 'a thread with both marks is done');
  assert.deepEqual(third.calls, [], 'and gets no call');
  const failing = repliesState(closedEntry('R1-1'));
  const broken = replyForge(threadOf('R1-1'), { failReply: true });
  assert.deepEqual(answerThreads(replyStep(failing, broken.forge)).unanswered, ['R1-1']);
  assert.equal(failing.index['R1-1'].thread.replied, undefined, 'a failed reply sets no mark');
  assert.ok(!broken.calls.some(([name]) => name === 'resolve'), 'and nothing is resolved before the reply');
});

test('replies: an earlier marked reply of the current user found on the thread counts as replied, so a lost mark posts no second', () => {
  const state = repliesState(closedEntry('R1-1'));
  const earlier = { id: 1500, body: [markerLine('R1-1'), attributionLine('R1-1'), 'Fixed.'].join('\n'), user: { login: 'ME' }, author_association: 'OWNER' };
  const posts = replyForge(threadOf('R1-1', [earlier]));
  const result = answerThreads(replyStep(state, posts.forge));
  assert.deepEqual([replies(posts.calls), result.resolved], [[], ['R1-1']], 'no second reply, and the thread is the engine`s alone, so it is resolved');
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, replied: true, replyId: 1500, resolved: true });
  const lists = engineLists([{ kind: 'review_comment', id: 1500, login: 'ME', member: true, markers: ['R1-1'], starts: false }], state);
  assert.deepEqual(lists.engine_comments.map((each) => each.id), [1500], 'engine_comments lists the reply the index maps');
});

test('replies: a root that carries another id, an unmarked root, and a gone thread get no reply and are not unanswered', () => {
  const state = repliesState(closedEntry('R1-1'), closedEntry('R1-2'), closedEntry('R1-3'));
  const threads = { 1001: { comments: [rootOf('R1-9', { id: 1001 })] }, 1002: { comments: [rootOf('R1-2', { body: 'plain text' })] } };
  const posts = replyForge(threads);
  const result = answerThreads(replyStep(state, posts.forge));
  assert.deepEqual([replies(posts.calls), result.left, result.unanswered], [[], ['R1-1', 'R1-2', 'R1-3'], []]);
  assert.ok(!posts.calls.some(([name]) => name === 'resolve'));
});

test('replies: a thread someone else replied in gets the reply and stays open, which counts as done', () => {
  for (const other of [{ user: { login: 'someone' }, author_association: 'NONE' }, { user: { login: VIEWER }, author_association: 'OWNER' }]) {
    const state = repliesState(closedEntry('R1-1'));
    const posts = replyForge(threadOf('R1-1', [{ id: 1400, body: 'I disagree', ...other }]));
    const result = answerThreads(replyStep(state, posts.forge));
    assert.deepEqual([result.replied, result.resolved, result.open, result.unanswered], [['R1-1'], [], ['R1-1'], []], `a reply by ${other.user.login} without the marker`);
    assert.ok(!posts.calls.some(([name]) => name === 'resolve'), 'never resolved');
    assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, replied: true, replyId: 2001 });
  }
});

test('replies: a thread another member`s login started waits for that machine, with its login, and is not unanswered', () => {
  const state = repliesState(closedEntry('R1-1'), closedEntry('R1-2'));
  const threads = { ...threadOf('R1-1'), ...threadOf('R1-2') };
  threads[1001].comments[0] = rootOf('R1-1', { user: { login: 'teammate' }, author_association: 'MEMBER' });
  threads[1002].comments[0] = rootOf('R1-2', { user: { login: 'outsider' }, author_association: 'NONE' });
  const posts = replyForge(threads);
  const result = answerThreads(replyStep(state, posts.forge));
  assert.deepEqual([result.waiting, result.left, result.unanswered, replies(posts.calls)], [[{ finding: 'R1-1', login: 'teammate' }], ['R1-2'], [], []]);
  assert.ok(!JSON.stringify(state).includes('teammate'), 'the record stores no login');
});

test('replies: a security finding the reading does not show, and one the delete named, get no reply; an open finding and one with no thread get none', () => {
  const security = repliesState(closedEntry('R1-1', { severity: 'high' }));
  const posts = replyForge(threadOf('R1-1'));
  assert.equal(answerThreads(replyStep(security, posts.forge)), null);
  assert.deepEqual(posts.calls, []);
  const shown = replyForge(threadOf('R1-1'));
  assert.deepEqual(answerThreads(replyStep(repliesState(closedEntry('R1-1', { severity: 'high' })), shown.forge, { reading: PRIVATE })).replied, ['R1-1'], 'a private repository answers it');
  for (const key of ['deleted', 'waiting', 'left', 'failed']) {
    const named = replyForge(threadOf('R1-1'));
    assert.equal(answerThreads(replyStep(repliesState(closedEntry('R1-1')), named.forge, { deletes: { [key]: [{ finding: 'R1-1', kind: 'review_comment', id: 1001 }] } })), null, key);
  }
  const others = repliesState(closedEntry('R1-1', { state: 'open' }), closedEntry('R1-2', { thread: { reviewId: 900 } }), closedEntry('R1-3', { thread: { fallbackId: 77 } }));
  assert.equal(answerThreads(replyStep(others, replyForge().forge)), null, 'an open finding, a review body`s, and a fallback comment`s have no thread to answer');
});

test('replies: replies false, inline off, and a failed thread read or viewer read post nothing and leave the ids unanswered', () => {
  for (const publish of [{ inline: true, replies: false }, { inline: false, replies: true }]) {
    const posts = replyForge(threadOf('R1-1'));
    assert.equal(answerThreads(replyStep(repliesState(closedEntry('R1-1')), posts.forge, { publish })), null, JSON.stringify(publish));
    assert.deepEqual(posts.calls, []);
  }
  const unread = replyForge(threadOf('R1-1'), { failRead: true });
  assert.deepEqual(answerThreads(replyStep(repliesState(closedEntry('R1-1')), unread.forge)).unanswered, ['R1-1']);
  const partial = replyForge({ 1001: { complete: false, comments: [rootOf('R1-1')] } });
  assert.deepEqual(answerThreads(replyStep(repliesState(closedEntry('R1-1')), partial.forge)).unanswered, ['R1-1'], 'a thread read only in part is answered later');
  const anonymous = replyForge(threadOf('R1-1'));
  anonymous.forge.viewer = () => { throw new Error('down'); };
  const result = answerThreads(replyStep(repliesState(closedEntry('R1-1')), anonymous.forge));
  assert.deepEqual([result.unanswered, replies(anonymous.calls)], [['R1-1'], []]);
  assert.deepEqual(result.reasons, { 'R1-1': 'the forge\'s current user could not be read' }, 'each unanswered id has its reason, as the result promises');
  assert.equal(result.error, 'the forge\'s current user could not be read');
});

test('replies: after a repack, the finding no pass repeats closes as not reported again and its thread is answered', () => {
  const state = { ...emptyState(7, 'o/r'), idCounter: 1, floored: true, rounds: [{ head: FROM, at: '2026-11-12T00:00:00.000Z' }], passes: {}, planNote: { head: TO, passes: Object.fromEntries(['slice:a', 'slice:b'].map((pass) => [pass, { stage: 'local', reviewer: 'code-reviewer', security: false }])) } };
  const finding = { title: 'the slice finding', file: 'src/a.js', line: 2, severity: 'medium', likelihood: 'likely', affects: 'users', state: 'open' };
  recordFindings(state, 'slice:a', { head: FROM, reviewer: 'code-reviewer', files: ['src/a.js'], list: [finding] }, { mint: true, kept: true });
  const id = Object.keys(state.index)[0];
  state.index[id].thread = { reviewId: 900, commentId: 1001 };
  // The fix repacks the slices: slice:b covers the file now, and its result on the new head leaves the finding out.
  const plan = [{ id: 'slice:b', reviewer: 'code-reviewer', stage: 'local', files: ['src/a.js', 'src/b.js'] }];
  state.passes['slice:b'] = { head: TO, reviewer: 'code-reviewer', files: ['src/a.js', 'src/b.js'], list: [] };
  recordFindings(state, null, null, { plan, complete: new Set([plan[0].stage]), head: TO, range: (seen, to) => ({ from: seen, to }) });
  assert.equal(state.index[id].state, 'not_reported');
  const threads = { 1001: { comments: [rootOf(id, { id: 1001 })] } };
  const posts = replyForge(threads);
  const result = answerThreads(replyStep(state, posts.forge));
  assert.deepEqual(result.replied, [id]);
  assert.match(replies(posts.calls)[0][2], /^Not reported again in \[aaaaaaa\.\.\.bbbbbbb\]/mu);
});

test('fillThreads: an inline comment whose review was not read back gets its comment id from the marked posts; a review body`s finding keeps the review`s alone', () => {
  const state = repliesState(closedEntry('R1-1', { thread: { reviewId: 900 } }), closedEntry('R1-2', { thread: { reviewId: 900 } }), closedEntry('R1-3', { thread: { reviewId: 901 } }));
  const items = [
    { kind: 'review', id: 900, login: VIEWER, member: true, markers: ['R1-1', 'R1-2'], starts: true },
    { kind: 'review_comment', id: 1001, login: VIEWER, member: true, markers: ['R1-1'], starts: true, review: 900 },
    { kind: 'review_comment', id: 1003, login: VIEWER, member: true, markers: ['R1-3'], starts: true, review: 900 },
    { kind: 'review_comment', id: 1004, login: 'x', member: false, markers: ['R1-3'], starts: true, review: 901 },
  ];
  assert.deepEqual(fillThreads(state, items), ['R1-1']);
  assert.deepEqual(['R1-1', 'R1-2', 'R1-3'].map((id) => state.index[id].thread), [{ reviewId: 900, commentId: 1001 }, { reviewId: 900 }, { reviewId: 901 }], 'a comment of another review, and one no member wrote, map nothing');
  assert.deepEqual(fillThreads(state, null), []);
  // readMarked keeps each review comment's review.
  const read = readMarked({ reviews: () => [], reviewComments: () => [{ id: 5, body: ownBody('R1-1'), pull_request_review_id: 900, author_association: 'OWNER', user: { login: VIEWER } }] }, 'o/r', 7, []);
  assert.equal(read.items[0].review, 900);
});

// ---- Fix pass 1: the delete reaches the engine's reply; a hand-resolved thread; a reply with no id ----

const replyBody = (id, line = 'Fixed in aaaaaaa...bbbbbbb.') => [markerLine(id), attributionLine(id), line].join('\n');

test('the delete reaches the engine`s reply: a closed finding marked security after its reply loses the reply, then its root, each checked first', () => {
  const answered = () => securityState([{ id: 'R1-1', severity: 'high', state: 'fixed', thread: { reviewId: 900, commentId: 61, replied: true, replyId: 62, resolved: true } }]);
  const comments = { 61: { kind: 'review_comment', body: ownBody('R1-1'), pr: 7 }, 62: { kind: 'review_comment', body: replyBody('R1-1'), pr: 7 } };
  const state = answered();
  const { forge, calls } = deleteForge({ comments });
  const out = sweep(forge, state);
  assert.deepEqual(out.deleted.map((each) => each.id), [62, 61], 'the reply first, then the root');
  assert.deepEqual(calls.filter(([name]) => name !== 'visibility' && name !== 'viewer'), [['read review_comment', 62], ['delete review_comment', 62], ['read review_comment', 61], ['delete review_comment', 61]], 'each read at the point of action before its delete');
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, replied: true, resolved: true }, 'both ids leave the thread; the marks stay, so no reply is posted again');
  // Under "full" the reply holds no text of the finding, so it is spared, as a textless root is.
  const full = answered();
  const spared = deleteForge({ comments: { ...comments, 61: { kind: 'review_comment', body: [markerLine('R1-1'), attributionLine('R1-1'), '> what is wrong'].join('\n'), pr: 7 } } });
  const kept = sweep(spared.forge, full, { publicSecurity: 'full' });
  assert.deepEqual([kept.textless.map((each) => each.id), kept.deleted.map((each) => each.id)], [[62], [61]], 'the reply is spared, the root holding text goes');
  assert.equal(full.index['R1-1'].thread.replyId, 62);
  // A private repository keeps both.
  const quiet = deleteForge({ comments, visibility: 'PRIVATE' });
  assert.equal(sweep(quiet.forge, answered()), null);
  assert.ok(!quiet.calls.some(([name]) => name.startsWith('delete') || name.startsWith('read')));
  // A reply another member's login wrote waits for that machine; one with another id is left.
  const other = deleteForge({ comments: { ...comments, 62: { kind: 'review_comment', body: replyBody('R1-1'), pr: 7, login: 'pat' } } });
  const waiting = sweep(other.forge, answered());
  assert.deepEqual([waiting.waiting.map((each) => [each.id, each.login]), waiting.deleted.map((each) => each.id)], [[[62, 'pat']], [61]]);
});

test('the delete reaches a marked reply of the current user that no record maps, as when a stale write lost its mark; another member`s waits', () => {
  const state = securityState([{ id: 'R1-1', severity: 'high', state: 'fixed', thread: { reviewId: 900, commentId: 61 } }]);
  const reply = (id, login = VIEWER) => ({ kind: 'review_comment', id, login, member: true, markers: ['R1-1'], starts: false, review: null });
  const items = [{ kind: 'review_comment', id: 61, login: VIEWER, member: true, markers: ['R1-1'], starts: true, review: 900 }, reply(62), reply(63, 'pat')];
  const comments = { 61: { kind: 'review_comment', body: ownBody('R1-1'), pr: 7 }, 62: { kind: 'review_comment', body: replyBody('R1-1'), pr: 7 } };
  const { forge } = deleteForge({ comments });
  const out = sweep(forge, state, { items, mode: 'posted' });
  assert.deepEqual(out.deleted.map((each) => each.id).sort(), [61, 62]);
  assert.deepEqual(out.waiting, [{ finding: 'R1-1', kind: 'review_comment', id: 63, login: 'pat' }]);
});

test('replies: a thread someone resolved by hand gets its reply, the resolved mark from the read, and no resolve call', () => {
  const state = repliesState(closedEntry('R1-1'));
  const posts = replyForge({ 1001: { resolved: true, comments: [rootOf('R1-1')] } });
  const result = answerThreads(replyStep(state, posts.forge));
  assert.deepEqual([result.replied, result.resolved, result.unanswered, result.open], [['R1-1'], [], [], []], 'not listed as resolved by this step, nor unanswered');
  assert.ok(!posts.calls.some(([name]) => name === 'resolve'), 'no resolve call');
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, replied: true, replyId: 2001, resolved: true });
  // One a person resolved after replying in it: the reply still posts, and the read's resolved state is kept.
  const other = repliesState(closedEntry('R1-1'));
  const answered = replyForge({ 1001: { resolved: true, comments: [rootOf('R1-1'), { id: 1400, body: 'done', user: { login: 'someone' }, author_association: 'NONE' }] } });
  const out = answerThreads(replyStep(other, answered.forge));
  assert.deepEqual([out.replied, out.resolved, out.open, out.unanswered], [['R1-1'], [], [], []]);
  assert.equal(other.index['R1-1'].thread.resolved, true);
  assert.ok(!answered.calls.some(([name]) => name === 'resolve'));
});

test('replies: a reply the forge answers with no id is not marked; the next step finds it on the thread with its id and posts none', () => {
  const state = repliesState(closedEntry('R1-1'));
  const posts = replyForge(threadOf('R1-1'));
  const post = posts.forge.replyToReviewComment;
  posts.forge.replyToReviewComment = (...args) => {
    post(...args);
    return {};
  };
  const first = answerThreads(replyStep(state, posts.forge));
  assert.deepEqual([first.replied, first.unanswered], [[], ['R1-1']]);
  assert.equal(state.index['R1-1'].thread.replied, undefined);
  assert.ok(!posts.calls.some(([name]) => name === 'resolve'));
  const next = replyForge(posts.threads);
  const second = answerThreads(replyStep(state, next.forge));
  assert.deepEqual([replies(next.calls), second.resolved, second.unanswered], [[], ['R1-1'], []]);
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, replied: true, replyId: 2001, resolved: true });
});

test('replies: a thread the lookup misses while the step`s read still holds its root is unanswered with a reason; a root that read no longer holds is left', () => {
  const root = { kind: 'review_comment', id: 1001, login: VIEWER, member: true, markers: ['R1-1'], starts: true, review: 900 };
  const missed = replyForge({});
  const result = answerThreads(replyStep(repliesState(closedEntry('R1-1')), missed.forge, { items: [root] }));
  assert.deepEqual([result.unanswered, result.left], [['R1-1'], []]);
  assert.match(result.reasons['R1-1'], /no thread was found/u);
  const unread = answerThreads({ ...replyStep(repliesState(closedEntry('R1-1')), replyForge({}).forge), marked: { error: 'down' } });
  assert.deepEqual([unread.unanswered, unread.left], [['R1-1'], []], 'with no read of the review comments, the step cannot tell it is gone, and tries again');
  const gone = answerThreads(replyStep(repliesState(closedEntry('R1-1')), replyForge({}).forge, { items: [] }));
  assert.deepEqual([gone.unanswered, gone.left, gone.reasons], [[], ['R1-1'], undefined], 'a root the read no longer holds is gone');
  const failing = replyForge(threadOf('R1-1'), { failResolve: true });
  assert.deepEqual(answerThreads(replyStep(repliesState(closedEntry('R1-1')), failing.forge)).reasons, { 'R1-1': 'the resolve failed' }, 'every unanswered id has its reason');
});

test('replies: a person who replies between the step`s read and the resolve keeps the thread open: replied is set, resolved is not', () => {
  const state = repliesState(closedEntry('R1-1'));
  const posts = replyForge(threadOf('R1-1'));
  const post = posts.forge.replyToReviewComment;
  posts.forge.replyToReviewComment = (...args) => {
    const reply = post(...args);
    posts.threads[1001].comments.push({ id: 1450, body: 'wait, not fixed', user: { login: 'someone' }, author_association: 'NONE' });
    return reply;
  };
  const result = answerThreads(replyStep(state, posts.forge));
  assert.deepEqual([result.replied, result.resolved, result.open, result.unanswered], [['R1-1'], [], ['R1-1'], []]);
  assert.deepEqual(posts.calls.find(([name]) => name === 'resolve'), ['resolve', 1001, [1001, 2001]], 'the resolve allows the root and the engine`s own reply alone');
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, replied: true, replyId: 2001 });
  assert.notEqual(posts.threads[1001].resolved, true, 'the thread is not resolved');
});

// ---- The second sweep of a step rechecks a comment the first spared as textless ----

// One fallback comment holding two findings' sections: R1-1's without its text, R1-2's quoted, or without it too.
const twoSections = (secondText) => [markerLine('R1-1'), markerLine('R1-2'), attributionLine('R1-1'), '**high** at `src/a.js:2`', WITHHELD, '',
  attributionLine('R1-2'), '**medium** at `src/a.js:3`', secondText ? '> what is wrong' : WITHHELD].join('\n');

test('the second sweep rechecks a comment the first spared as textless: another of its findings marked security in the step deletes it then', () => {
  const state = securityState([{ id: 'R1-1', severity: 'high', thread: { fallbackId: 77 } }, { id: 'R1-2', thread: { fallbackId: 77 } }]);
  const { forge, calls } = deleteForge({ comments: { 77: { kind: 'comment', body: twoSections(true), pr: 7 } } });
  const first = sweep(forge, state, { publicSecurity: 'full' });
  assert.deepEqual([first.textless.map((each) => [each.finding, each.id]), first.deleted], [[['R1-1', 77]], []], 'the first sweep spares it for R1-1, whose section holds no text');
  assert.ok(!handledKeys(first).has('comment:77'), 'a textless comment is not settled for the step');
  // The step then marks R1-2 as security, as its own reviewers or plan can.
  state.index['R1-2'].severity = 'high';
  calls.length = 0;
  const second = sweep(forge, state, { publicSecurity: 'full', done: handledKeys(first) });
  assert.deepEqual(second.deleted.map((each) => [each.finding, each.id]), [['R1-2', 77]], 'the second sweep deletes it in that same step');
  assert.ok(calls.some(([name, id]) => name === 'delete comment' && id === 77));
  const merged = mergeDeletes(first, second);
  assert.deepEqual([merged.deleted.map((each) => each.id), merged.textless], [[77], []], 'the merged result lists it as deleted alone');
});

test('the second sweep reads a textless comment again for a finding newly security, not for one it was spared for, and deletes nothing', () => {
  const state = securityState([{ id: 'R1-1', severity: 'high', thread: { fallbackId: 77 } }, { id: 'R1-2', thread: { fallbackId: 77 } }]);
  const { forge, calls } = deleteForge({ comments: { 77: { kind: 'comment', body: twoSections(false), pr: 7 } } });
  const first = sweep(forge, state, { publicSecurity: 'full' });
  state.index['R1-2'].severity = 'high';
  calls.length = 0;
  const second = sweep(forge, state, { publicSecurity: 'full', done: handledKeys(first) });
  assert.deepEqual(calls.filter(([name]) => name === 'read comment'), [['read comment', 77]], 'read again once, for R1-2 alone');
  assert.ok(!calls.some(([name]) => name.startsWith('delete')), 'and not deleted');
  assert.deepEqual(second.textless.map((each) => each.finding), ['R1-2'], 'R1-1 was spared already: its thread says so');
  const merged = mergeDeletes(first, second);
  assert.deepEqual(merged.textless.map((each) => [each.finding, each.id]).sort(), [['R1-1', 77], ['R1-2', 77]], 'once for each finding');
  // A comment the first sweep deleted, or whose delete failed, or another member's, is settled: the second reads none.
  for (const key of ['deleted', 'failed', 'waiting', 'gone']) assert.ok(handledKeys({ [key]: [{ finding: 'R1-1', kind: 'comment', id: 77 }] }).has('comment:77'), key);
  for (const key of ['textless', 'left']) assert.ok(!handledKeys({ [key]: [{ finding: 'R1-1', kind: 'comment', id: 77 }] }).has('comment:77'), key);
});

// ---- The delete: a viewer that cannot be read, a comment gone by hand, and a textless comment's mark (#284, #288) ----

test('the delete with no current user lists this user`s own comments as left, never as waiting, and the next sweep reads them again', () => {
  const state = securityState([{ id: 'R1-1', severity: 'high', thread: { reviewId: 900, commentId: 61 } }]);
  const items = [
    { kind: 'review_comment', id: 61, login: VIEWER, member: true, markers: ['R1-1'], starts: true, review: 900 },
    { kind: 'review_comment', id: 62, login: VIEWER, member: true, markers: ['R1-1'], starts: false, review: null },
  ];
  const comments = { 61: { kind: 'review_comment', body: ownBody('R1-1'), pr: 7 }, 62: { kind: 'review_comment', body: replyBody('R1-1'), pr: 7 } };
  const { forge, calls } = deleteForge({ comments });
  const first = sweep(forge, state, { items, mode: 'posted', viewer: () => { throw new Error('gh: (HTTP 502)'); } });
  assert.deepEqual([first.waiting, first.left.map((each) => each.id).sort(), first.deleted], [[], [61, 62], []], 'no comment is known to be another member`s');
  assert.ok(!calls.some(([name]) => name.startsWith('delete')));
  assert.ok(!handledKeys(first).has('review_comment:61') && !handledKeys(first).has('review_comment:62'), 'left is not settled');
  const second = sweep(forge, state, { items, mode: 'posted', done: handledKeys(first) });
  assert.deepEqual(second.deleted.map((each) => each.id).sort(), [61, 62], 'the second sweep, with the user read, deletes both');
});

test('the delete under a local record: a mapped comment deleted by hand reads as gone, leaves the record, and the next sweep reads nothing', () => {
  const state = securityState([{ id: 'R1-1', severity: 'high', thread: { reviewId: 900, commentId: 61 } }]);
  const { forge, calls } = deleteForge();
  const out = sweep(forge, state);
  assert.deepEqual([out.gone, out.left], [[{ finding: 'R1-1', kind: 'review_comment', id: 61 }], []]);
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900 }, 'the record maps it no more');
  assert.ok(!calls.some(([name]) => name.startsWith('delete')));
  const next = deleteForge();
  assert.equal(sweep(next.forge, state), null, 'a later step has no candidate');
  assert.deepEqual(next.calls, [], 'and makes no call');
});

test('the delete under "full": a textless comment is marked on its thread, so a later step reads it no more; under "counts" it goes', () => {
  const comments = { 77: { kind: 'comment', body: twoSections(false), pr: 7 } };
  const state = securityState([{ id: 'R1-1', severity: 'high', thread: { fallbackId: 77 } }]);
  const first = deleteForge({ comments });
  assert.deepEqual(sweep(first.forge, state, { publicSecurity: 'full' }).textless.map((each) => each.id), [77]);
  assert.deepEqual(state.index['R1-1'].thread, { fallbackId: 77, textless: ['fallbackId'] });
  const { copy } = postedCopy(state, { reading: PUBLIC, names: [] });
  assert.deepEqual(copy.index['R1-1'].thread, { fallbackId: 77, textless: ['fallbackId'] }, 'the posted copy keeps the mark, by key alone');
  const later = deleteForge({ comments });
  assert.equal(sweep(later.forge, state, { publicSecurity: 'full' }), null, 'a later step under "full" has no candidate');
  assert.deepEqual(later.calls, [], 'and reads neither the visibility, the user, nor the comment');
  const counts = deleteForge({ comments });
  assert.deepEqual(sweep(counts.forge, state).deleted.map((each) => each.id), [77], 'under "counts" the mark counts for nothing');
  assert.equal(state.index['R1-1'].thread, undefined, 'and the deleted comment takes its mark with it');
});

// ---- The inline review: the login of its posts, a repack, a partial read (#284, #285) ----

test('inline: the step`s lists name the new posts with the login the forge answered the post with', (t) => {
  const r = inlineRepo(t);
  const state = inlineState(r.head, [listed('R1-1'), listed('R1-2', { line: 1 })]);
  const items = [];
  const { forge } = inlineForge({ postReview: (repo, n, review) => ({ refused: false, id: 900, login: VIEWER, comments: review.comments.map((comment, i) => ({ id: 1001 + i, body: comment.body })) }) });
  postInline({ ...inlineStep(r, state, forge), marked: { items } }, openOf(state));
  const lists = engineLists(items, state);
  assert.deepEqual(lists.engine_comments.map((each) => [each.kind, each.id, each.login]), [['review_comment', 1001, VIEWER], ['review', 900, VIEWER]]);
  const refused = inlineState(r.head, [listed('R1-1')]);
  const fallen = [];
  const answer = inlineForge({ postReview: () => ({ refused: true }), postComment: () => ({ id: 77, user: { login: VIEWER } }) });
  postInline({ ...inlineStep(r, refused, answer.forge), marked: { items: fallen } }, openOf(refused));
  assert.deepEqual(engineLists(fallen, refused).engine_comments.map((each) => [each.id, each.login]), [[77, VIEWER]], 'the fallback comment too');
});

test('inline: a finding repeated after a repack keeps its id and its thread, and the step posts it no second time', (t) => {
  const r = inlineRepo(t);
  const state = { ...emptyState(7, 'o/r'), idCounter: 0, floored: true, rounds: [{ head: r.base, at: '2026-11-12T00:00:00.000Z' }], passes: {}, planNote: { head: r.head, passes: Object.fromEntries(['slice:a', 'slice:b'].map((pass) => [pass, { stage: 'local', reviewer: 'code-reviewer', security: false }])) } };
  const finding = { title: 'the slice finding', body: 'what is wrong', file: 'src/a.js', line: 2, severity: 'medium', likelihood: 'likely', affects: 'users', disposition: 'fix_now', state: 'open' };
  recordFindings(state, 'slice:a', { head: r.head, reviewer: 'code-reviewer', files: ['src/a.js'], list: [finding] }, { mint: true, kept: true });
  const { forge, calls } = inlineForge();
  const first = postInline(inlineStep(r, state, forge), [{ pass: 'slice:a', findings: state.passes['slice:a'].list }]);
  const id = Object.keys(state.index)[0];
  assert.deepEqual(first.threads, [id]);
  // The fix repacks the slices: slice:b covers the file now, and reports the same finding again with the id it was listed.
  const plan = [{ id: 'slice:b', reviewer: 'code-reviewer', stage: 'local', files: ['src/a.js', 'src/b.js'] }];
  recordFindings(state, 'slice:b', { head: r.head, reviewer: 'code-reviewer', files: plan[0].files, list: [{ ...finding, returned_id: id }] }, { mint: true, kept: true, listed: [id], plan, stage: 'local', reviewer: 'code-reviewer' });
  assert.equal(state.passes['slice:b'].list[0].id, id, 'the repeat keeps its id');
  calls.length = 0;
  const items = [{ kind: 'review_comment', id: 1001, login: VIEWER, member: true, markers: [id], starts: true, review: 900 }];
  const second = postInline({ ...inlineStep(r, state, forge), marked: { items } }, [{ pass: 'slice:b', findings: state.passes['slice:b'].list }]);
  assert.equal(second, null, 'nothing new to post');
  assert.deepEqual(calls, []);
  assert.deepEqual(state.index[id].thread, { reviewId: 900, commentId: 1001 });
});

test('inline: a marked read that came back only in part posts no review, and says so', (t) => {
  const r = inlineRepo(t);
  const state = inlineState(r.head, [listed('R1-1')]);
  const partial = readMarked({ reviews: () => [{ id: 900, body: 'x' }], reviewComments: () => [{ body: 'no id' }] }, 'o/r', 7, []);
  assert.match(partial.error, /read only in part/u);
  const { forge, calls } = inlineForge();
  const result = postInline({ ...inlineStep(r, state, forge), marked: partial }, openOf(state));
  assert.deepEqual([result.posted, calls], [false, []]);
  assert.match(result.reason, /could not be read/u);
  assert.equal(state.index['R1-1'].thread, undefined, 'and maps nothing');
});

// ---- Replies: one thread read a step, and a finding that opens again (#287, #288) ----

test('replies: the pull request`s threads are read once a step, however many findings are due', () => {
  const state = repliesState(closedEntry('R1-1'), closedEntry('R1-2'), closedEntry('R1-3', { state: 'accepted', disposition: 'acceptable_as_is' }));
  const { forge, calls } = replyForge({ ...threadOf('R1-1'), ...threadOf('R1-2'), ...threadOf('R1-3') });
  const result = answerThreads(replyStep(state, forge));
  assert.deepEqual(result.replied, ['R1-1', 'R1-2', 'R1-3']);
  assert.deepEqual(calls.filter(([name]) => name === 'findingThreads' || name === 'viewer'), [['viewer'], ['findingThreads']], 'one read of the user, one of every thread');
  const unread = replyForge(threadOf('R1-1'), { failRead: true });
  const failed = answerThreads(replyStep(repliesState(closedEntry('R1-1'), closedEntry('R1-2')), unread.forge));
  assert.deepEqual([failed.unanswered, failed.error], [['R1-1', 'R1-2'], 'the pull request\'s review threads could not be read']);
  assert.deepEqual(unread.calls.filter(([name]) => name === 'findingThreads').length, 1, 'a failed read is not repeated for each finding');
});

test('replies: a finding that opens again after "Accepted as" has its thread unresolved, and its next closing gets one new reply', () => {
  const state = repliesState(closedEntry('R1-1', { state: 'accepted', disposition: 'acceptable_as_is', closed_in: undefined }));
  const posts = replyForge(threadOf('R1-1'));
  answerThreads(replyStep(state, posts.forge));
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, replied: true, replyId: 2001, resolved: true });
  // A later round reports it again as blocking: it is open.
  state.index['R1-1'].state = 'open';
  const reopen = replyForge(posts.threads);
  const opened = answerThreads(replyStep(state, reopen.forge));
  assert.deepEqual([opened.reopened, opened.unanswered, replies(reopen.calls)], [['R1-1'], [], []]);
  assert.deepEqual(reopen.calls.filter(([name]) => name === 'unresolve'), [['unresolve', 1001]], 'one unresolve, through the forge');
  assert.equal(posts.threads[1001].resolved, false);
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, earlier: [2001] }, 'the reply belongs to the closing before; neither mark is left');
  const quiet = replyForge(posts.threads);
  assert.equal(answerThreads(replyStep(state, quiet.forge)), null, 'an open thread of an open finding is done');
  assert.deepEqual(quiet.calls, []);
  // It closes again, as fixed: one new reply with the new outcome, though the thread holds the earlier reply.
  Object.assign(state.index['R1-1'], { state: 'fixed', closed_in: { from: FROM, to: TO } });
  const again = replyForge(posts.threads, { firstId: 2002 });
  const closed = answerThreads(replyStep(state, again.forge));
  assert.deepEqual([closed.replied, closed.resolved], [['R1-1'], ['R1-1']]);
  assert.deepEqual(replies(again.calls).map(([, , body]) => body.split('\n').at(-1)), [`Fixed in [aaaaaaa...bbbbbbb](${COMPARE}).`]);
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, earlier: [2001], replied: true, replyId: 2002, resolved: true });
  const done = replyForge(posts.threads);
  assert.equal(answerThreads(replyStep(state, done.forge)), null, 'and only one per closing');
  // The posted copy keeps the earlier replies' ids, so another machine never takes one for the new closing's.
  assert.deepEqual(postedCopy(state, { reading: PUBLIC, names: [] }).copy.index['R1-1'].thread.earlier, [2001]);
});

test('replies: an unresolve that fails is named, and the next step tries it again; another member`s thread waits for that machine', () => {
  const state = repliesState(closedEntry('R1-1', { state: 'open', thread: { reviewId: 900, commentId: 1001, replied: true, replyId: 2001, resolved: true } }));
  const threads = threadOf('R1-1', [{ id: 2001, body: replyBody('R1-1', 'Accepted as acceptable_as_is.'), user: { login: VIEWER }, author_association: 'OWNER' }]);
  threads[1001].resolved = true;
  const failing = replyForge(threads, { failUnresolve: true });
  const first = answerThreads(replyStep(state, failing.forge));
  assert.deepEqual([first.reopened, first.unanswered, first.reasons], [[], ['R1-1'], { 'R1-1': 'the unresolve failed' }]);
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, earlier: [2001], resolved: true }, 'the reopen is noted at once; resolved stays until the forge opens the thread');
  const next = replyForge(threads);
  assert.deepEqual(answerThreads(replyStep(state, next.forge)).reopened, ['R1-1'], 'the next step tries again');
  assert.equal(state.index['R1-1'].thread.resolved, undefined);
  // A thread another member's machine posted waits for that machine; a thread opened by hand needs no call.
  const theirs = repliesState(closedEntry('R1-1', { state: 'open', thread: { reviewId: 900, commentId: 1001, resolved: true } }));
  const owned = threadOf('R1-1');
  owned[1001].comments[0] = rootOf('R1-1', { user: { login: 'pat' }, author_association: 'MEMBER' });
  owned[1001].resolved = true;
  const waiting = replyForge(owned);
  assert.deepEqual(answerThreads(replyStep(theirs, waiting.forge)).waiting, [{ finding: 'R1-1', login: 'pat' }]);
  assert.ok(!waiting.calls.some(([name]) => name === 'unresolve'));
  const byHand = repliesState(closedEntry('R1-1', { state: 'open', thread: { reviewId: 900, commentId: 1001, resolved: true } }));
  const open = replyForge(threadOf('R1-1'));
  assert.deepEqual(answerThreads(replyStep(byHand, open.forge)).reopened, ['R1-1']);
  assert.ok(!open.calls.some(([name]) => name === 'unresolve'), 'a thread already open gets no call');
});

test('replies: a security finding the reading does not show gets no unresolve when it opens again', () => {
  const state = repliesState(closedEntry('R1-1', { severity: 'high', state: 'open', thread: { reviewId: 900, commentId: 1001, replied: true, replyId: 2001, resolved: true } }));
  const posts = replyForge(threadOf('R1-1'));
  assert.equal(answerThreads(replyStep(state, posts.forge)), null);
  assert.deepEqual(posts.calls, []);
  assert.deepEqual(state.index['R1-1'].thread, { reviewId: 900, commentId: 1001, earlier: [2001], resolved: true }, 'the reopen is still noted');
});
