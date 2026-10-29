import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { fold, formatStats, lessonStats, nudge, parseCapture, similarLessons, triageOrder } from '../plugins/aidrian/lib/lesson-inbox.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-29T12:00:00Z');
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

// A git repository with an `origin`, and an empty state folder for it.
function setup(t) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-lessons-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@example.test:acme/notes.git']);
  const env = { ...process.env, XDG_STATE_HOME: path.join(base, 'state'), CLAUDE_CODE_AGENT: 'planner', CLAUDE_CODE_SESSION_ID: 'session-1' };
  const run = (args, input = '') => spawnSync(CLI, ['lesson', ...args], { cwd: repo, input, encoding: 'utf8', env });
  const inbox = () => path.join(spawnSync(CLI, ['state'], { cwd: repo, encoding: 'utf8', env }).stdout.trim(), 'lessons/inbox.jsonl');
  const rows = () => readFileSync(inbox(), 'utf8').trim().split('\n').filter((line) => line.startsWith('{"')).map((line) => JSON.parse(line));
  const json = (args) => JSON.parse(run([...args, '--json']).stdout);
  const add = (note, args = []) => run(['add', ...args], note).stdout.split('\n')[0];
  return { base, repo, env, run, inbox, rows, json, add };
}

const lesson = (id, daysAgo, extra = {}) => ({ event: 'add', id, at: at(daysAgo), tier: 'P2', note: `lesson ${id}`, ...extra });
const config = (lessons = {}) => ({ ...DEFAULTS, lessons: { ...DEFAULTS.lessons, ...lessons } });

test('parseCapture takes leading evidence lines, blank lines between them, then the note verbatim', () => {
  assert.deepEqual(parseCapture('evidence: a.mjs\n\nevidence:   https://x.test/?a=1&b=2  \nthe note\n  line two\n'), {
    note: 'the note\n  line two',
    evidence: ['a.mjs', 'https://x.test/?a=1&b=2'],
  });
  assert.deepEqual(parseCapture('\nevidence: not evidence after a blank first line'), { note: 'evidence: not evidence after a blank first line', evidence: [] });
});

test('add appends one add row with tier, kind, target, and where it was captured, and prints its id', (t) => {
  const { run, rows } = setup(t);
  const note = 'ran `git rev-parse` and $(false) with "$HOME" & saw: Error: ENOENT\nmore detail';
  const added = run(['add', '--tier', 'P1', '--kind', 'bug', '--target', 'plugin'], `evidence: scripts/it's.mjs\n${note}\n`);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /^[0-9a-f]{8}\n$/);
  assert.equal(run(['add'], 'second').status, 0);
  const [first, second] = rows();
  assert.deepEqual(
    { ...first, at: undefined, worktree: undefined },
    {
      event: 'add', id: added.stdout.trim(), at: undefined, tier: 'P1', kind: 'bug', target: 'plugin', key: null, source: 'manual',
      note, evidence: ["scripts/it's.mjs"], session: 'session-1', agent: 'planner', branch: 'main', worktree: undefined,
    },
  );
  assert.match(first.at, /^\d{4}-\d\d-\d\dT/);
  assert.match(first.worktree, /repo$/);
  assert.deepEqual([second.tier, second.kind, second.target], ['P2', null, null], 'P2 is the default tier; kind and target stay open');
});

test('add refuses an empty note and a bad tier, kind, or target, and writes nothing', (t) => {
  const { run } = setup(t);
  assert.deepEqual([run(['add'], 'evidence: x\n\n').status, run(['add'], 'evidence: x\n').stderr], [1, 'the lesson needs a note on stdin, after any "evidence: <ref>" lines\n']);
  assert.equal(run(['add', '--tier', 'P0'], 'note').stderr, '--tier must be one of P1, P2, P3\n');
  assert.equal(run(['add', '--kind', 'harness'], 'note').stderr, '--kind must be one of bug, gap, improvement, rule\n');
  assert.equal(run(['add', '--target', 'other'], 'note').stderr, '--target must be one of plugin, project\n');
  assert.equal(run(['add', 'extra'], 'note').stderr, 'unexpected argument: extra\n');
  assert.equal(run(['list']).stdout.startsWith('no open lessons in '), true);
});

test('add --same records the lesson again; --key does the same for a row that names a known key', (t) => {
  const { run, rows, json, add } = setup(t);
  const id = add('the push hung', ['--key', 'push-hang']);
  const again = run(['add', '--same', id], 'evidence: log.txt\nhung again\n');
  assert.deepEqual([again.status, again.stdout], [0, `${id}\nSeen 2 times.\n`]);
  assert.equal(run(['add', '--same', id], '').status, 0, 'a recurrence needs no note');
  assert.equal(rows().at(-1).event, 'seen');
  const keyed = run(['add', '--key', 'push-hang', '--tier', 'P1'], 'third time');
  assert.equal(keyed.stdout, `${id}\nSeen 4 times.\n`, 'the row lands on the lesson that holds the key');
  const [only] = json(['list']);
  assert.deepEqual([only.id, only.seen, only.tier, only.occurrences.map((item) => item.note)], [id, 4, 'P2', ['hung again', null, 'third time']]);
  assert.deepEqual(only.occurrences[0].evidence, ['log.txt']);
  assert.equal(run(['add', '--same', 'ffffffff'], 'x').stderr, 'no lesson with id ffffffff\n');
  assert.match(run(['add', '--same', id, '--tier', 'P1'], 'x').stderr, /^--same records the lesson again and takes no --tier/);
});

test('add names similar lessons and the command that merges into one; an unrelated note gets no hint', (t) => {
  const { run, add } = setup(t);
  const push = add('git push exited 141 after the pre-push hook passed, and the remote branch did not move');
  add('the markdown line-length hook reported a table row');
  const similar = run(['add'], 'git push exits 141 once the pre-push hook passes; the remote branch is not updated');
  const [id, hint, candidate, rest] = similar.stdout.split('\n');
  assert.equal(hint, `Similar lessons. If one is the same problem, merge this one into it: aidrian lesson resolve ${id} --outcome merged --link <id>`);
  assert.match(candidate, new RegExp(`^  ${push}  \\d{4}-\\d\\d-\\d\\d  \\[P2 open\\]  git push exited 141`));
  assert.equal(rest, '');
  assert.equal(run(['add'], 'session handoff brief lost its worktree path').stdout.split('\n').length, 2, 'only the id, then the final newline');
});

test('list shows open lessons by tier then age, filters them, and shows one in full by id', (t) => {
  const { run, inbox, json, add } = setup(t);
  const old = add('old polish', ['--tier', 'P3', '--target', 'project', '--kind', 'improvement']);
  const mid = add('costly retry', ['--target', 'plugin']);
  const urgent = add('lost a commit', ['--tier', 'P1', '--kind', 'bug']);
  appendFileSync(inbox(), '{"torn": \n{"no":"id"}\n');
  assert.deepEqual(json(['list']).map((row) => row.id), [urgent, mid, old]);
  assert.deepEqual(json(['list', '--tier', 'P3']).map((row) => row.id), [old]);
  assert.deepEqual(json(['list', '--target', 'plugin']).map((row) => row.id), [mid]);
  assert.deepEqual(json(['list', '--kind', 'bug']).map((row) => row.id), [urgent]);
  assert.deepEqual(json(['list', '--source', 'auto']), []);
  assert.deepEqual(json(['list', '--limit', '2']).map((row) => row.id), [urgent, mid]);
  run(['resolve', urgent, '--outcome', 'mechanism', '--link', 'abc1234']);
  assert.deepEqual(json(['list', '--status', 'resolved']).map((row) => row.id), [urgent]);
  assert.deepEqual(json(['list', '--all']).map((row) => row.id), [mid, old, urgent], 'open first');
  assert.match(run(['list']).stdout, new RegExp(`^${mid}  \\d{4}-\\d\\d-\\d\\d  \\[P2 open plugin/-\\]  costly retry\\n${old}  .*\\[P3 open project/improvement\\]  old polish\\n$`));
  const full = run(['list', urgent]).stdout;
  assert.match(full, new RegExp(`^${urgent}  .*\\[P1 resolved: mechanism -/bug\\]  lost a commit\\n {10}planner @ main, session session-1\\n {10}lost a commit\\n {10}mechanism \\d{4}-\\d\\d-\\d\\d: abc1234\\n$`));
  assert.equal(run(['list', 'ffffffff']).stderr, 'no lesson with id ffffffff\n');
  assert.equal(run(['list', '--status', 'done']).stderr, '--status must be open, resolved, or all\n');
  assert.equal(run(['list', '--limit', '0']).stderr, '--limit takes a whole number above 0\n');
});

test('resolve appends the resolution, needs a link, reads it from stdin, and records what a fix should move', (t) => {
  const { run, inbox, rows, json, add } = setup(t);
  const first = add('first');
  const second = add('second');
  appendFileSync(inbox(), 'not json\n');
  const before = readFileSync(inbox(), 'utf8');
  assert.equal(run(['resolve', second, '--outcome', 'rule']).stderr, 'resolve needs --link: the commit, pull request, issue, lesson id, or reason it ends in\n');
  const resolved = run(['resolve', second, '--outcome', 'rule', '--link', '-', '--expect', 'report: planner re-dispatched under 10%'], "the reason's $(here)\n");
  assert.deepEqual([resolved.status, resolved.stdout], [0, `${second} -> rule\n`]);
  assert.ok(readFileSync(inbox(), 'utf8').startsWith(before), 'every earlier line is byte for byte the same: the file is only appended to');
  assert.deepEqual({ ...rows().at(-1), at: undefined }, { event: 'resolve', id: second, at: undefined, outcome: 'rule', link: "the reason's $(here)", expect: 'report: planner re-dispatched under 10%' });
  const listed = json(['list', '--all']);
  assert.deepEqual(listed.map((row) => [row.id, row.status, row.outcome, row.expect]), [[first, 'open', null, null], [second, 'resolved', 'rule', 'report: planner re-dispatched under 10%']]);
  assert.equal(run(['resolve', second, '--outcome', 'rule', '--link', 'x']).stderr, `no open lesson with id ${second}\n`);
  assert.equal(run(['resolve', first, '--outcome', 'dropped', '--link', 'x']).stderr, 'resolve needs --outcome mechanism|rule|issue|merged|rejected\n');
  assert.equal(run(['resolve', first, '--outcome', 'merged', '--link', 'ffffffff']).stderr, 'merged needs --link to name a lesson; no lesson with id ffffffff\n');
  assert.equal(run(['resolve', first, '--outcome', 'merged', '--link', first]).stderr, 'a lesson cannot be merged into itself\n');
});

test('merged moves a lesson\'s occurrences to the lesson it names, and later rows for it follow', (t) => {
  const { run, json, add } = setup(t);
  const keep = add('the push hung');
  const copy = add('the push hung again', ['--key', 'push-hang']);
  run(['add', '--same', copy], 'and again');
  assert.equal(run(['resolve', copy, '--outcome', 'merged', '--link', keep]).status, 0);
  run(['add', '--same', copy], 'after the merge');
  run(['add', '--key', 'push-hang'], 'by key');
  const [kept] = json(['list']);
  assert.deepEqual([kept.id, kept.seen, kept.merged], [keep, 5, [copy]]);
  assert.deepEqual(kept.occurrences.map((item) => item.note), ['the push hung again', 'and again', 'after the merge', 'by key']);
  assert.deepEqual(json(['list', copy]).map((row) => row.id), [keep], 'a merged id shows the lesson it went to');
});

test('a fix that recurs reopens its lesson; an issue keeps counting; an old duplicate merged in never reopens', () => {
  const { lessons, find } = fold([
    lesson('aaaaaaaa', 20),
    lesson('bbbbbbbb', 19),
    { event: 'resolve', id: 'aaaaaaaa', at: at(10), outcome: 'mechanism', link: 'abc1234' },
    { event: 'resolve', id: 'bbbbbbbb', at: at(10), outcome: 'issue', link: 'https://tracker.test/1' },
    { event: 'seen', id: 'aaaaaaaa', at: at(2) },
    { event: 'seen', id: 'bbbbbbbb', at: at(2) },
    lesson('cccccccc', 15),
    lesson('dddddddd', 18),
    { event: 'resolve', id: 'cccccccc', at: at(5), outcome: 'rule', link: 'docs/x.md' },
    { event: 'resolve', id: 'dddddddd', at: at(1), outcome: 'merged', link: 'cccccccc' },
  ]);
  assert.deepEqual(
    lessons.map((item) => [item.id, item.status, item.reopened, item.seen, item.resolutions.map((r) => r.recurred)]),
    [
      ['aaaaaaaa', 'open', 1, 2, [1]],
      ['bbbbbbbb', 'resolved', 0, 2, [1]],
      ['cccccccc', 'resolved', 0, 2, [0]],
      ['dddddddd', 'resolved', 0, 1, [0]],
    ],
  );
  assert.equal(find('dddddddd').id, 'cccccccc');
  assert.equal(find('aaaaaaaa').outcome, null, 'a reopened lesson carries no outcome');
});

test('rows the first version wrote, and a resolved row rewritten in place, still fold', () => {
  const { lessons } = fold([
    { id: 'aaaaaaaa', at: at(9), note: 'v1 lesson', kind: 'harness', evidence: ['x'], agent: 'planner', status: 'open' },
    { id: 'aaaaaaaa', status: 'resolved', resolvedAt: at(8), outcome: 'duplicate', link: 'bbbbbbbb' },
    { id: 'bbbbbbbb', at: at(7), note: 'rewritten', kind: 'process', role: 'orchestrator', status: 'resolved', resolvedAt: at(6), outcome: 'dropped', link: 'why' },
    { id: 'cccccccc', at: at(5), note: 'still open', status: 'open' },
    { no: 'id' },
    { id: 42, note: 'not a string id' },
  ]);
  assert.deepEqual(
    lessons.map((item) => [item.id, item.status, item.outcome, item.tier, item.kind, item.agent]),
    [
      ['aaaaaaaa', 'resolved', 'merged', 'P2', null, 'planner'],
      ['bbbbbbbb', 'resolved', 'rejected', 'P2', null, 'orchestrator'],
      ['cccccccc', 'open', null, 'P2', null, null],
    ],
  );
});

test('update changes a lesson\'s tier, kind, or target and nothing else', (t) => {
  const { run, json, add } = setup(t);
  const id = add('polish', ['--tier', 'P3']);
  assert.match(run(['update', id, '--tier', 'P1', '--target', 'plugin']).stdout, new RegExp(`^${id}  .*\\[P1 open plugin/-\\]  polish\\n$`));
  assert.deepEqual(json(['list']).map((row) => [row.tier, row.kind, row.target, row.seen]), [['P1', null, 'plugin', 1]]);
  assert.equal(run(['update', id]).stderr, 'update needs --tier, --kind, or --target\n');
  assert.equal(run(['update', 'ffffffff', '--tier', 'P1']).stderr, 'no lesson with id ffffffff\n');
  assert.equal(run(['update', id, '--kind', 'idea']).stderr, '--kind must be one of bug, gap, improvement, rule\n');
});

test('similarLessons names the duplicate, not a lesson that only shares common words', () => {
  const { lessons } = fold([
    lesson('aaaaaaaa', 3, { note: 'git push exited 141 after the pre-push hook passed; the ssh connection idled out' }),
    lesson('bbbbbbbb', 2, { note: 'the agent dispatched a reviewer after the hook passed' }),
    lesson('cccccccc', 1, { note: 'push exited 141 (SIGPIPE) once the pre-push hook passed; ssh idled' }),
  ]);
  assert.deepEqual(similarLessons(lessons).get('cccccccc'), ['aaaaaaaa']);
  const pair = fold([lesson('aaaaaaaa', 2, { note: 'worktree bootstrap ran npm ci twice' }), lesson('bbbbbbbb', 1, { note: 'worktree bootstrap ran npm ci twice again' })]);
  assert.deepEqual(similarLessons(pair.lessons).get('bbbbbbbb'), ['aaaaaaaa'], 'two lessons are enough to compare');
});

test('triageOrder puts open lessons first, then by tier, then oldest first', () => {
  const rows = [lesson('aaaaaaaa', 1, { tier: 'P3' }), lesson('bbbbbbbb', 5), lesson('cccccccc', 2, { tier: 'P1' }), lesson('dddddddd', 9)];
  assert.deepEqual(fold(rows).lessons.sort(triageOrder).map((item) => item.id), ['cccccccc', 'dddddddd', 'bbbbbbbb', 'aaaaaaaa']);
});

test('the nudge is silent with nothing open, calm under the limits, and escalates naming every reason', (t) => {
  const { inbox } = setup(t);
  const file = inbox();
  const write = (rows) => {
    rmSync(file, { force: true });
    for (const row of rows) appendFileSync(file, `${JSON.stringify(row)}\n`, { flag: 'a' });
  };
  const line = (lessonsConfig) => nudge(file, { config: config(lessonsConfig), now: NOW });
  assert.equal(line(), '');
  mkdirSync(path.dirname(file), { recursive: true });
  write([lesson('aaaaaaaa', 3), lesson('bbbbbbbb', 1, { tier: 'P3' })]);
  assert.equal(line(), 'Lesson inbox: 2 open (P2 1, P3 1), the oldest 3 days old. The lesson-triage skill drains it in a session opened for it.');
  write([lesson('aaaaaaaa', 0)]);
  assert.match(line(), /^Lesson inbox: 1 open \(P2 1\), the oldest from today\./);
  write([lesson('aaaaaaaa', 30), lesson('bbbbbbbb', 1, { tier: 'P1' }), lesson('cccccccc', 1), { event: 'resolve', id: 'cccccccc', at: at(0), outcome: 'rejected', link: 'x' }]);
  assert.equal(
    line({ maxOpen: 1 }),
    'Lesson inbox needs triage: 1 P1 open; 2 open, over 1; the oldest is 30 days old, over 14. Tell the Human once, then go on with the task: ' +
      'the lesson-triage skill drains it in a session opened for it, and `aidrian lesson list` shows the order.',
  );
  write([lesson('aaaaaaaa', 30), lesson('bbbbbbbb', 1)]);
  assert.match(line({ maxOpen: 0, maxAgeDays: 0 }), /^Lesson inbox: 2 open/, '0 turns a limit off');
  assert.match(nudge(file, { config: { ...config(), names: { human: 'Sam', ai: null } }, now: NOW, command: '/x/aidrian' }), /Tell Sam once.*`\/x\/aidrian lesson list`/);
});

test('lessonStats counts what is open, what moved in the window, and whether each fix held', () => {
  const { lessons } = fold([
    lesson('aaaaaaaa', 40, { tier: 'P1', target: 'plugin' }),
    lesson('bbbbbbbb', 20, { target: 'project' }),
    lesson('cccccccc', 10, { tier: 'P3', key: 'k', source: 'auto' }),
    lesson('dddddddd', 9),
    lesson('eeeeeeee', 8),
    { event: 'resolve', id: 'bbbbbbbb', at: at(12), outcome: 'mechanism', link: 'abc', expect: 'report: x drops' },
    { event: 'resolve', id: 'dddddddd', at: at(5), outcome: 'rule', link: 'docs/x.md' },
    { event: 'resolve', id: 'eeeeeeee', at: at(4), outcome: 'merged', link: 'cccccccc' },
    { event: 'seen', id: 'dddddddd', at: at(1) },
    { event: 'add', id: 'ffffffff', at: at(1), key: 'k', note: 'again' },
  ]);
  const summary = lessonStats(lessons, { sinceMs: NOW - 30 * DAY, now: NOW });
  assert.deepEqual(summary.open, { count: 3, tiers: { P1: 1, P2: 1, P3: 1 }, targets: { plugin: 1, project: 0, none: 2 }, auto: 1, reopened: 1, oldest_days: 40 });
  assert.deepEqual(summary.window, {
    added: 3,
    seen_again: 3,
    resolved: 3,
    outcomes: { mechanism: 1, rule: 1, issue: 0, merged: 1, rejected: 0 },
    median_days_to_resolve: 4,
  });
  assert.deepEqual(summary.fixes.map((fix) => [fix.id, fix.outcome, fix.recurred, fix.held_days, fix.expect]), [
    ['bbbbbbbb', 'mechanism', 0, 12, 'report: x drops'],
    ['dddddddd', 'rule', 1, null, null],
  ]);
  const text = formatStats(summary, { file: '/s/inbox.jsonl', since: '30d' });
  assert.equal(
    text,
    [
      'Lesson inbox /s/inbox.jsonl',
      'Open: 3 (P1 1, P2 1, P3 1); plugin 1, project 0, no target 2; 1 automatic, 1 reopened; the oldest 40 days old.',
      'Since 30d: 3 added, 3 seen again, 3 resolved (mechanism 1, rule 1, merged 1), median 4 days to resolve.',
      'Fixes since 30d: 2; 1 held, 1 recurred.',
      `  bbbbbbbb  mechanism  ${at(12).slice(0, 10)}  held 12 days  lesson bbbbbbbb`,
      '            expect: report: x drops',
      `  dddddddd  rule  ${at(5).slice(0, 10)}  recurred once  lesson dddddddd`,
    ].join('\n'),
  );
});

test('stats prints the summary, and --json the same numbers', (t) => {
  const { run, add } = setup(t);
  add('one', ['--tier', 'P1']);
  assert.match(run(['stats']).stdout, /^Lesson inbox .*inbox\.jsonl\nOpen: 1 \(P1 1, P2 0, P3 0\); plugin 0, project 0, no target 1; the oldest from today\.\nSince 30d: 1 added, 0 seen again, 0 resolved\.\nFixes since 30d: 0\.\n$/);
  const json = JSON.parse(run(['stats', '--since', '7d', '--json']).stdout);
  assert.deepEqual([json.since, json.open.count, json.window.added], ['7d', 1, 1]);
  assert.equal(run(['stats', '--since', 'soon']).stderr, '--since takes 7d, 24h, 30m, or YYYY-MM-DD, not soon\n');
});

test('a lesson another session writes while a resolve runs is never lost', (t) => {
  // The other session opened the inbox before the resolve and writes after it. A resolve that replaced the file would
  // leave that write in the replaced copy, and the lesson would be gone.
  const { run, inbox, json, add } = setup(t);
  const target = add('to resolve');
  const other = openSync(inbox(), 'a');
  assert.equal(run(['resolve', target, '--outcome', 'rejected', '--link', 'x']).status, 0);
  writeSync(other, `${JSON.stringify({ event: 'add', id: 'feedf00d', at: new Date().toISOString(), note: 'from another session' })}\n`);
  closeSync(other);
  assert.deepEqual(json(['list', '--all']).map((row) => [row.note, row.status]), [['from another session', 'open'], ['to resolve', 'resolved']]);
});

test('every worktree of a repository shares one inbox, and two processes appending at once both land', async (t) => {
  const { repo, env, run, rows } = setup(t);
  spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init']);
  spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'task', path.join(repo, '..', 'task')]);
  const fromWorktree = spawnSync(CLI, ['lesson', 'add'], { cwd: path.join(repo, '..', 'task'), input: 'from the worktree', encoding: 'utf8', env });
  assert.equal(fromWorktree.status, 0);
  const add = (note) => new Promise((resolve) => {
    const child = spawn(CLI, ['lesson', 'add'], { cwd: repo, env });
    child.on('close', resolve);
    child.stdin.end(note);
  });
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, (_, i) => add(`parallel ${i}`))), Array(8).fill(0));
  assert.equal(rows().length, 9);
  assert.equal(rows()[0].branch, 'task');
  assert.match(run(['list']).stdout, /from the worktree/);
});
