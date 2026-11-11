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
import { escapeLines, gitPaths, isPrivate, JUDGE_RULING, patternsOf, postedCopy, residualRows, textChecker, WITHHELD } from '../plugins/aidrian/lib/review/publish.mjs';
import { BODY_LIMIT, CHECK_HELD_LINE, emptyState, HELD_LINE, heldMessage, heldRevision, heldWhy, stateFromComment, summaryBody } from '../plugins/aidrian/lib/review/state.mjs';

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

test('a verdict keeps evidence of a citation`s shape on a public copy, so another machine can check it; prose is left out', (t) => {
  const root = checkout(t, []);
  writeFileSync(path.join(root, 'a.js'), '1\n2\n3\n');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  git('add', '-A');
  git('commit', '-qm', 'base');
  const head = git('rev-parse', 'HEAD');
  const verdicts = ['a.js:3', 'a.js:2-3', 'test:refund cap holds', 'capture:look-360', 'a.js:9', 'gone.js:1', 'because the code checks it'].map((evidence, i) => ({ flow: 'booking', invariant: `i${i}`, verdict: 'holds', evidence }));
  const state = { ...emptyState(7, 'o/r'), revision: 2, planNote: { head, passes: { p: { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: verdicts.map(({ flow, invariant }) => ({ flow, invariant })) }, passes: { p: { head, verdicts } } };
  const { copy } = postedCopy(state, { reading: { visibility: 'PUBLIC', inside: true }, checker: textChecker({ context: CONTEXT, words: [] }), root, names: [] });
  assert.deepEqual(copy.passes.p.verdicts.map((each) => each.evidence ?? null), ['a.js:3', 'a.js:2-3', 'test:refund cap holds', 'capture:look-360', null, null, null]);
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
