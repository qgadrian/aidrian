import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { addCosts, GROUPS, readCheckout, readRecords, reportLines, reviewerRuns, sortReruns, totals } from '../scripts/report-flow-reruns.mjs';

const PASS = 'agent:product-manager:booking';
const WIDER = `${PASS}+sign-in`;
const FILES = ['src/booking/a.mjs', 'src/booking/b.mjs'];
// A checkout whose heads differ by `changes`, with a merge commit in each range of `merged`, and none a rewrite but `rewritten`.
const checkout = (changes = {}, merged = [], rewritten = []) => ({
  isAncestor: (from, to) => !rewritten.includes(`${from}..${to}`),
  changed: (from, to) => changes[`${from}..${to}`] ?? [],
  merges: (from, to) => (merged.includes(`${from}..${to}`) ? 1 : 0),
});
const finding = (id = 'R1-1', pass = PASS) => ({ id, pass, title: 'A finding', severity: 'medium' });
const round = (head, findings = [], at = `2026-11-0${head.at(-1)}T10:00:00.000Z`) => ({ head, at, open: findings.length, findings });
// A record whose last round, at `h2`, the pass answered with nothing listed to it, after a finding it raised at `h1`.
const record = (over = {}) => ({
  pr: 7, repo: 'o/r', updatedAt: '2026-11-09T10:00:00.000Z', rounds: [round('h1', [finding()]), round('h2')],
  passes: { [PASS]: { head: 'h2', reviewer: 'product-manager', files: FILES } }, ...listing([]), ...over,
});
const listing = (listed) => ({ dispatched: { [PASS]: { head: 'h2', files: FILES, base: 'h1', listed } } });
const none = { dispatched: {} };
// The flow's earlier run at `h1`, as another pass over `files`.
const regrouped = (files, over) => record({ rounds: [round('h1'), round('h2')], passes: { ...record().passes, [WIDER]: { head: 'h1', files } }, ...over });
const only = (rec, co = checkout()) => {
  const { reruns } = sortReruns(rec, co);
  assert.equal(reruns.length, 1);
  return reruns[0];
};

test('a round of each kind goes to its own group, the first that holds', () => {
  const cases = [
    ['open finding', record(listing(['R1-1'])), checkout({ 'h1..h2': [FILES[0]] }, ['h1..h2'])],
    ['open finding', record(none), checkout({ 'h1..h2': [FILES[0]] })],
    ['files touched', record(), checkout({ 'h1..h2': [FILES[0]] })],
    ['file list changed', regrouped([FILES[0]]), checkout({ 'h1..h2': ['docs/x.md'] })],
    // A merge may touch a file of the pass by the base's edits alone, or none, as a resolution that keeps the branch's side.
    ['base merged', record(), checkout({ 'h1..h2': [FILES[0]] }, ['h1..h2'])],
    ['base merged', regrouped([FILES[0]]), checkout({}, ['h1..h2'])],
    ['none of these', regrouped(FILES), checkout({ 'h1..h2': ['docs/x.md'] })],
  ];
  for (const [group, rec, co] of cases) assert.equal(only(rec, co).group, group);
  assert.deepEqual(new Set(cases.map(([group]) => group)), new Set(GROUPS));
  const reruns = cases.map(([, rec, co]) => only(rec, co));
  assert.deepEqual(totals(reruns).map(({ group, count, share }) => [group, count, share]),
    [['open finding', 2, 2 / 5], ['files touched', 1, 1 / 5], ['file list changed', 1, 1 / 5], ['base merged', 2, null], ['none of these', 1, 1 / 5]],
    'a share is of the sorted re-runs, and the uncertain group has none');
});

test('what the dispatch listed settles the open finding, and with no list the reviewer\'s own findings on the flow do', () => {
  const opened = (pass, over) => only(regrouped(FILES, { rounds: [round('h1', [finding('R1-1', pass)]), round('h2')], ...over })).group;
  assert.equal(opened(WIDER), 'none of these', 'an empty list: no finding was owed this pass');
  assert.equal(opened(WIDER, none), 'open finding', 'with no list, a pass of the reviewer that shares a flow');
  for (const other of ['agent:code-reviewer', 'agent:security-engineer:booking', null]) assert.equal(opened(other, none), 'none of these', other);
});

test('only a run the record shows is one: a carried finding, a range start, and a round with no result are not', () => {
  const carried = record({ rounds: [round('h1', [finding()]), round('h2', [finding()]), round('h3', [finding(), finding('R3-2')])], passes: {}, ...none });
  assert.deepEqual(sortReruns(carried, checkout()).reruns.map((each) => [each.round, each.group ?? each.unread]), [
    [3, 'open finding'], [2, 'only an open finding, which may be carried'],
  ]);
  assert.equal(sortReruns(carried, checkout()).first, 1);
  // The dispatch names h1 as the start of its range: no run is recorded there.
  assert.match(only(record({ rounds: [round('h1'), round('h2')] })).unread, /may be a first run/u);
  assert.deepEqual(sortReruns(record({ rounds: [round('h1')], passes: { [PASS]: { head: 'h1', files: FILES } }, ...none }), checkout()), { reruns: [], first: 1 });
  // A finding of a round a quiet push moved says not at which of its heads the pass ran.
  const quiet = record({ rounds: [{ ...round('h3', [finding()]), quiet: [{ from: 'h1' }] }, round('h2')] });
  assert.deepEqual(sortReruns(quiet, checkout()).reruns.map(({ unread }) => Boolean(unread)), [true, true]);
});

test('what the record or git cannot say is sorted in no group', () => {
  const unread = (rec, co) => only(rec, co).unread;
  const apart = record({ rounds: [round('h1', [finding()]), round('h2'), round('h3')], passes: { [PASS]: { head: 'h3', files: FILES } }, ...none });
  assert.match(unread(apart, checkout({ 'h1..h3': [FILES[0]] })), /may lie between/u);
  const { findings, ...bare } = round('h1');
  assert.match(unread(regrouped(FILES, { rounds: [bare, round('h2')], ...none })), /keeps no findings/u);
  assert.match(unread(record({ passes: { [PASS]: { head: 'h2' } } })), /keeps no file list/u);
  assert.match(unread(record(), checkout({ 'h1..h2': ['docs/x.md'] })), /which files the pass covered before/u);
  const broken = { ...checkout(), changed: () => { throw new Error('bad object'); } };
  assert.match(unread(record(), broken), /git cannot read/u);
  const nowhere = readCheckout(path.join(tmpdir(), 'no-such-folder'));
  assert.throws(() => nowhere.merges('a', 'b'), /git cannot count the merges/u);
  assert.throws(() => nowhere.isAncestor('a', 'b'), /git cannot tell whether/u, 'a git that cannot say is no rewritten branch');
});

test('a re-run on a rewritten branch is not sorted, whatever the two heads\' diff, merges, or findings say', () => {
  const rewritten = (rec, changes, merged) => only(rec, checkout(changes, merged, ['h1..h2']));
  const cases = [
    ['a file of the pass', record(), { 'h1..h2': [FILES[0]] }],
    ['a merge in the range', record(), {}, ['h1..h2']],
    ['the same file list', regrouped(FILES)],
    ['another file list', regrouped([FILES[0]])],
    ['an open finding', record(listing(['R1-1']))],
  ];
  for (const [what, ...args] of cases) {
    const { group, unread } = rewritten(...args);
    assert.deepEqual([group, unread], [undefined, 'the branch was rewritten: the earlier head is no ancestor of this one'], what);
  }
});

// Writes a git object into the repository `dir`, and gives its id.
function gitObject(dir, type, text) {
  const bytes = Buffer.from(`${type} ${Buffer.byteLength(text)}\0${text}`);
  const id = createHash('sha1').update(bytes).digest('hex');
  const folder = path.join(dir, '.git/objects', id.slice(0, 2));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, id.slice(2)), deflateSync(bytes));
  return id;
}

test('readCheckout tells a rewritten head from an ancestor as git does', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-reruns-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.git/refs'), { recursive: true });
  mkdirSync(path.join(dir, '.git/objects'));
  writeFileSync(path.join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');
  const tree = gitObject(dir, 'tree', '');
  const who = 'T <t@example.invalid> 1700000000 +0000';
  const commit = (subject, parent) => gitObject(dir, 'commit', `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${who}\ncommitter ${who}\n\n${subject}\n`);
  const base = commit('base');
  const [before, after] = [commit('before', base), commit('after', base)];
  const { isAncestor, merges } = readCheckout(dir);
  assert.deepEqual([isAncestor(base, after), isAncestor(before, after)], [true, false]);
  assert.equal(merges(before, after), 0, 'no merge tells the two heads apart');
  assert.throws(() => isAncestor('f'.repeat(40), after), /git cannot tell whether/u, 'a commit this checkout does not hold');
});

test('a re-run whose earlier overlapping runs point to other groups is not sorted, in any order, and one they agree on is', () => {
  const [SIGN_IN, OTHER] = ['agent:product-manager:sign-in', 'flow:booking:product-manager'];
  const rounds = (count) => Array.from({ length: count }, (_, index) => round(`h${index + 1}`));
  const passes = (earlier, id = WIDER, head = 'h2') => Object.fromEntries([[id, { head, files: FILES }], ...earlier.map(([pass, at, files]) => [pass, { head: at, files }])]);
  const sort = (earlier, { id, head, count = 2, ...over } = {}) => {
    const rec = record({ rounds: rounds(count), passes: passes(earlier, id, head), ...none, ...over });
    return sortReruns(rec, checkout()).reruns.find((each) => each.to === (head ?? 'h2'));
  };
  const disagree = 'the earlier runs of its flows do not point to one group';
  const split = [[PASS, 'h1', FILES], [SIGN_IN, 'h1', ['src/sign-in.mjs']]];
  for (const earlier of [split, split.toReversed()]) assert.equal(sort(earlier).unread, disagree, 'one earlier list is the pass\'s, and one is not');
  for (const [files, group] of [[FILES, 'none of these'], [['src/x.mjs'], 'file list changed']]) {
    assert.equal(sort([[PASS, 'h1', files], [SIGN_IN, 'h1', files]]).group, group, 'they agree');
  }
  for (const earlier of [[[OTHER, 'h1', FILES], [WIDER, 'h1', ['src/x.mjs']]], [[WIDER, 'h1', ['src/x.mjs']], [OTHER, 'h1', FILES]]]) {
    assert.equal(sort(earlier, { id: PASS }).unread, disagree, 'two earlier passes of one flow');
  }
  // Sign-in last ran two rounds before, so a run the record no longer holds may lie between, in either order of the two.
  for (const earlier of [[[PASS, 'h2', FILES], [SIGN_IN, 'h1', FILES]], [[SIGN_IN, 'h1', FILES], [PASS, 'h2', FILES]]]) {
    assert.equal(sort(earlier, { head: 'h3', count: 3 }).unread, disagree);
  }
  // Booking ran again since the wider pass: the later run alone came before this one.
  assert.equal(sort([[OTHER, 'h2', FILES], [WIDER, 'h1', ['src/x.mjs']]], { id: PASS, head: 'h3', count: 3 }).group, 'none of these');
});

test('the report says what is a floor and what is an estimate, beside its counts', () => {
  const reruns = [only(regrouped(FILES)), only(record(), checkout({}, ['h1..h2'])), only(record({ rounds: [round('h1'), round('h2')] }))];
  const lines = reportLines({ reviewer: 'product-manager', records: 3, withPass: 2, reruns, first: 1, groups: totals(reruns) });
  assert.match(lines[0], /1 re-runs sorted, 1 uncertain, 1 not sorted, and 1 runs in a first round, on 2 of 3 review records/u);
  assert.match(lines[1], /^a floor: /u);
  assert.match(lines[2], /^estimates: /u);
  assert.ok(lines.includes('  1\tno earlier run is on record, so it may be a first run'));
  assert.ok(lines.includes('base merged (uncertain: a merge resolution may have touched the pass\'s files)\t1\t-\t$0.00 over 0\t-'));
  assert.ok(lines.includes('none of these\t1\t100%\t$0.00 over 0\t-'));
  assert.ok(lines.includes(`none of these\t#7\tround 2\t${PASS}\th1..h2`));
});

test('a re-run costs what its run spent since its agent stopped before, and a run answers one re-run', () => {
  const dispatch = (agent_id, description) => ({ event: 'dispatch', agent_id, description, agent_type: 'aidrian:product-manager' });
  const stop = (agent_id, ts, cost_usd, session_id = 's1') => ({ event: 'stop', agent_id, ts, cost_usd, session_id, agent_type: 'aidrian:product-manager' });
  const runs = reviewerRuns([
    dispatch('a', 'Product review of PR 700'), dispatch('b', 'Judge residuals of PR 700'), dispatch('c', 'PR 800 product review'), dispatch('d', 'Re-check the fix'),
    stop('a', '2026-11-01T10:05:00.000Z', 2), stop('b', '2026-11-02T10:01:00.000Z', 9), stop('c', '2026-11-02T10:02:00.000Z', 9), stop('a', '2026-11-02T10:05:00.000Z', 2.5),
    stop('d', '2026-11-03T10:05:00.000Z', 1, 's2'), { ...stop('e', '2026-11-02T10:00:30.000Z', 9), agent_type: 'aidrian:code-reviewer' },
  ], 'product-manager');
  const rec = record({ pr: 700, rounds: [round('h1'), round('h2'), round('h3'), round('h4')] });
  const reruns = [2, 3, 4].map((each) => ({ pr: 700, repo: 'o/r', round: each, group: 'files touched' }));
  addCosts(reruns, [rec], runs, (session, { pr }) => session === 's2' && pr === 700);
  assert.deepEqual(reruns.map(({ cost }) => cost), [0.5, 1, undefined]);
  // A quiet push moved the round's `at` past the run that answered its first head.
  const quiet = record({ pr: 700, rounds: [round('h1'), { ...round('h3'), quiet: [{ from: 'h2', at: round('h2').at }] }] });
  const moved = [{ pr: 700, repo: 'o/r', round: 2, group: 'files touched' }];
  addCosts(moved, [quiet], runs.filter(({ agent }) => agent === 'a'), () => false);
  assert.equal(moved[0].cost, 0.5);
  const firstRound = [{ pr: 700, repo: 'o/r', round: 1, group: 'files touched' }];
  addCosts(firstRound, [quiet], runs.filter(({ agent, cost }) => agent === 'a' && cost === 0.5), () => false);
  assert.equal(firstRound[0].cost, undefined, 'nor does the round before it end at the moved time');
  const [touched] = totals(reruns).filter(({ group }) => group === 'files touched');
  assert.deepEqual([touched.count, touched.costed, touched.cost], [3, 2, 1.5]);
});

test('readRecords reads one record a pull request and repository, the latest written, and skips what is no review record', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-reruns-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'reviews'));
  const write = (name, value) => writeFileSync(path.join(dir, 'reviews', name), typeof value === 'string' ? value : JSON.stringify(value));
  write('pr-7-review.json', record({ updatedAt: '2026-11-01T00:00:00.000Z' }));
  write('pr-7-review-o--r.json', record({ updatedAt: '2026-11-02T00:00:00.000Z' }));
  write('pr-8-review-o--r.json', record({ pr: 8 }));
  write('pr-9.json', { pr: 9, reviewer: 'x', findings: [] });
  write('pr-10-review.json', '{');
  write('other.json', record({ pr: 11 }));
  assert.deepEqual(readRecords(dir).map(({ pr, updatedAt }) => [pr, updatedAt.slice(0, 10)]).sort(), [[7, '2026-11-02'], [8, '2026-11-09']]);
});
