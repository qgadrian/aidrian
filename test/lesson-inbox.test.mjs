import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS, pluginRepository } from '../plugins/aidrian/lib/config.mjs';
import { appendRow } from '../plugins/aidrian/lib/jsonl.mjs';
import { formatStats } from '../plugins/aidrian/lib/lesson-cli.mjs';
import { fold, lessonStats, moveLessons, nudge, parseCapture, similarLessons, triageOrder } from '../plugins/aidrian/lib/lesson-inbox.mjs';
import { pluginProjectId } from '../plugins/aidrian/lib/project.mjs';

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

// Another checkout in the same state folder: `remote` is its origin, such as the plugin's own repository. Commands run in it
// as in `setup`, and `inbox` is its own inbox.
function checkout({ base, env }, name, remote) {
  const repo = path.join(base, name);
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  const run = (args, input = '') => spawnSync(CLI, ['lesson', ...args], { cwd: repo, input, encoding: 'utf8', env });
  const json = (args) => JSON.parse(run([...args, '--json']).stdout);
  const add = (note, args = []) => run(['add', ...args], note).stdout.split('\n')[0];
  const inbox = () => path.join(spawnSync(CLI, ['state'], { cwd: repo, encoding: 'utf8', env }).stdout.trim(), 'lessons/inbox.jsonl');
  const id = path.basename(path.dirname(path.dirname(inbox())));
  return { repo, run, json, add, inbox, id };
}

const readRowsOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

const lesson = (id, daysAgo, extra = {}) => ({ event: 'add', id, at: at(daysAgo), tier: 'P2', note: `lesson ${id}`, ...extra });
const config = (lessons = {}) => ({ ...DEFAULTS, lessons: { ...DEFAULTS.lessons, ...lessons } });

test('parseCapture takes leading evidence lines, blank lines between them, then the note verbatim', () => {
  assert.deepEqual(parseCapture('evidence: a.mjs\n\nevidence:   https://x.test/?a=1&b=2  \nthe note\n  line two\n'), {
    note: 'the note\n  line two',
    evidence: ['a.mjs', 'https://x.test/?a=1&b=2'],
  });
  assert.deepEqual(parseCapture('\nevidence: not evidence after a blank first line'), { note: 'evidence: not evidence after a blank first line', evidence: [] });
  assert.deepEqual(parseCapture('title: the short title\nevidence: a.mjs\n\nthe note\ntitle: kept in the note\n'), {
    note: 'the note\ntitle: kept in the note', evidence: ['a.mjs'], title: 'the short title',
  }, 'a leading title line is the title, in any order with the evidence lines');
});

test('add takes a leading title line as the title, never as part of the note', (t) => {
  const { json, add } = setup(t);
  add('title: plugin lessons never reach the plugin triage\nevidence: x.jsonl\nThe longer story.');
  assert.deepEqual(json(['list']).map((row) => [row.title, row.note, row.evidence]), [['plugin lessons never reach the plugin triage', 'The longer story.', ['x.jsonl']]]);
});

test('a plugin lesson lands in the plugin\'s inbox, names its project, and the plugin\'s checkout lists it', (t) => {
  const consumer = setup(t);
  const plugin = checkout(consumer, 'plugin', pluginRepository());
  const other = checkout(consumer, 'other', 'git@example.test:acme/other.git');
  const notes = path.basename(path.dirname(path.dirname(consumer.inbox())));
  assert.equal(plugin.id, pluginProjectId(), 'the plugin\'s checkout has the id its manifest gives, so every project finds its inbox');
  const id = consumer.add('the worktree hook blocked a branch switch in a linked worktree', ['--target', 'plugin', '--kind', 'bug']);
  const local = consumer.add('our docs miss the deploy step', ['--target', 'project']);
  assert.deepEqual(consumer.rows().map((row) => row.id), [local], 'only the project lesson is in the project\'s inbox');
  assert.deepEqual(readRowsOf(plugin.inbox()).map((row) => [row.id, row.target, row.project]), [[id, 'plugin', notes]]);
  assert.deepEqual(consumer.json(['list']).map((row) => row.id), [local]);
  assert.deepEqual(plugin.json(['list']).map((row) => [row.id, row.project]), [[id, notes]], 'the plugin\'s triage reads it');
  assert.match(plugin.run(['list']).stdout, new RegExp(`^${id}  .*\\[P2 open plugin/bug from ${notes}\\]  the worktree hook`));
  assert.match(plugin.run(['list', id]).stdout, new RegExp(`\\n {10}project: ${notes}\\n`));
  assert.deepEqual(consumer.json(['list', '--target', 'plugin']).map((row) => row.id), [id], '--target plugin reads the plugin\'s inbox from any project');
  // --same, the similar names, and a key all match against the plugin's inbox, where the lesson is.
  assert.equal(consumer.run(['add', '--same', id], 'evidence: log.txt\nagain\n').stdout, `${id}\nSeen 2 times.\n`);
  assert.deepEqual(readRowsOf(plugin.inbox()).at(-1).project, notes);
  const similar = other.run(['add', '--target', 'plugin'], 'the worktree hook blocked a branch switch inside a linked worktree again').stdout;
  assert.match(similar, new RegExp(`Similar lessons\\. .*\\n  ${id}  `), 'a lesson from another project is compared with the plugin\'s inbox');
  const keyed = consumer.add('first', ['--target', 'plugin', '--key', 'hook-deny:x']);
  assert.equal(other.run(['add', '--target', 'plugin', '--key', 'hook-deny:x'], 'second').stdout, `${keyed}\nSeen 2 times.\n`, 'one key is one lesson across projects');
  assert.equal(consumer.run(['resolve', id, '--outcome', 'mechanism', '--link', 'abc1234']).stdout, `${id} -> mechanism\n`, 'an id resolves in the inbox that holds it');
  assert.deepEqual(plugin.json(['list', id]).map((row) => [row.status, row.seen]), [['resolved', 2]]);
  assert.equal(existsSync(other.inbox()), false, 'a project that only captured plugin lessons has no inbox of its own');
});

test('update moves a lesson whose target changes: into the plugin\'s inbox, and back to the project it came from', (t) => {
  const consumer = setup(t);
  const plugin = checkout(consumer, 'plugin', pluginRepository());
  const notes = path.basename(path.dirname(path.dirname(consumer.inbox())));
  const id = consumer.add('evidence: a.txt\nthe review agent missed a finding', ['--tier', 'P3']);
  consumer.run(['add', '--same', id], 'again');
  const moved = consumer.run(['update', id, '--target', 'plugin']);
  assert.match(moved.stdout, new RegExp(`^${id}  .*\\[P3 open x2 plugin/- from ${notes}\\]  the review agent missed a finding\\nMoved to ${plugin.inbox()}\\n$`));
  assert.deepEqual(consumer.json(['list']), []);
  assert.deepEqual(plugin.json(['list']).map((row) => [row.id, row.seen, row.evidence, row.project, row.target]), [[id, 2, ['a.txt'], notes, 'plugin']]);
  const back = plugin.run(['update', id, '--target', 'project']);
  assert.match(back.stdout, new RegExp(`\\nMoved to ${consumer.inbox()}\\n$`));
  assert.deepEqual(plugin.json(['list']), []);
  assert.deepEqual(consumer.json(['list']).map((row) => [row.id, row.seen, row.target]), [[id, 2, 'project']]);
  assert.doesNotMatch(consumer.run(['list']).stdout, / from /, 'back in its own project, it names no project of origin');
  assert.match(consumer.run(['update', id, '--target', 'plugin']).stdout, /\nMoved to /, 'and into the plugin\'s inbox again');
  assert.deepEqual(plugin.json(['list']).map((row) => [row.id, row.seen]), [[id, 2]]);
});

test('a project with state.dir gets its lesson back in that folder when the move runs from its checkout', (t) => {
  const consumer = setup(t);
  const plugin = checkout(consumer, 'plugin', pluginRepository());
  const own = path.join(consumer.base, 'own-state');
  mkdirSync(path.join(consumer.repo, '.aidrian'));
  writeFileSync(path.join(consumer.repo, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: own } }));
  assert.equal(consumer.inbox(), path.join(own, 'lessons/inbox.jsonl'));
  const id = consumer.add('the planner skipped a step', ['--target', 'plugin']);
  assert.deepEqual(plugin.json(['list']).map((row) => row.id), [id]);
  const back = consumer.run(['update', id, '--target', 'project']);
  assert.match(back.stdout, new RegExp(`\\nMoved to ${consumer.inbox()}\\n$`));
  assert.deepEqual(consumer.json(['list']).map((row) => [row.id, row.target]), [[id, 'project']]);
  assert.deepEqual(plugin.json(['list']), []);
});

test('only a new target moves a lesson; list shows a lesson once for two of its ids; a known key lands where its lesson is', (t) => {
  const consumer = setup(t);
  const plugin = checkout(consumer, 'plugin', pluginRepository());
  // A plugin lesson an earlier version left in the project's own inbox: a new tier leaves it there.
  appendRow(consumer.inbox(), { event: 'add', id: 'cccc0001', at: new Date().toISOString(), tier: 'P2', target: 'plugin', note: 'left behind', evidence: [] });
  assert.doesNotMatch(consumer.run(['update', 'cccc0001', '--tier', 'P1']).stdout, /Moved to/);
  assert.deepEqual(consumer.json(['list']).map((row) => [row.id, row.tier]), [['cccc0001', 'P1']]);
  const kept = consumer.add('kept lesson about the review agent');
  const dup = consumer.add('a duplicate of the review agent lesson');
  consumer.run(['resolve', dup, '--outcome', 'merged', '--link', kept]);
  assert.deepEqual(consumer.json(['list', kept, dup]).map((row) => row.id), [kept], 'a lesson and the one merged into it list once');
  const keyed = plugin.add('blocked', ['--target', 'plugin', '--key', 'hook-deny:y']);
  const before = readFileSync(consumer.inbox(), 'utf8');
  assert.equal(consumer.run(['add', '--key', 'hook-deny:y'], 'blocked again').stdout, `${keyed}\nSeen 2 times.\n`, 'with no --target, the key finds the plugin\'s lesson');
  assert.equal(readFileSync(consumer.inbox(), 'utf8'), before);
});

test('migrate moves every plugin lesson out of each project inbox, whole, and a second run changes nothing', (t) => {
  const consumer = setup(t);
  const plugin = checkout(consumer, 'plugin', pluginRepository());
  const other = checkout(consumer, 'other', 'git@example.test:acme/other.git');
  const notes = path.basename(path.dirname(path.dirname(consumer.inbox())));
  const old = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
  // Rows an earlier version wrote: plugin lessons in the project's own inbox.
  const own = consumer.inbox();
  const write = (row) => appendRow(own, row);
  write({ event: 'add', id: 'aaaa0001', at: old(9), tier: 'P1', kind: 'bug', target: 'plugin', key: null, source: 'manual', note: 'plugin bug', evidence: ['e1'] });
  write({ event: 'seen', id: 'aaaa0001', at: old(8), note: 'again', evidence: ['e2'] });
  write({ event: 'add', id: 'aaaa0002', at: old(8), tier: 'P2', kind: null, target: 'project', key: null, source: 'manual', note: 'a duplicate, merged in', evidence: [] });
  write({ event: 'resolve', id: 'aaaa0002', at: old(7), outcome: 'merged', link: 'aaaa0001' });
  write({ event: 'resolve', id: 'aaaa0001', at: old(6), outcome: 'mechanism', link: 'abc1234', expect: 'no more' });
  write({ event: 'add', id: 'aaaa0003', at: old(5), tier: 'P2', kind: 'gap', target: 'plugin', key: 'hook-deny:pr-body', source: 'auto', note: 'blocked', evidence: [] });
  write({ event: 'add', id: 'aaaa0004', at: old(4), tier: 'P2', kind: 'gap', target: 'plugin', key: 'hook-deny:pr-body', source: 'auto', note: 'blocked', evidence: [] });
  write({ event: 'add', id: 'aaaa0005', at: old(5), tier: 'P3', kind: null, target: 'project', key: null, source: 'manual', note: 'project lesson', evidence: [] });
  write({ event: 'add', id: 'aaaa0006', at: old(5), tier: 'P3', kind: null, target: 'plugin', key: null, source: 'manual', note: 'plugin lesson merged into a project one', evidence: [] });
  write({ event: 'resolve', id: 'aaaa0006', at: old(4), outcome: 'merged', link: 'aaaa0005' });
  write({ event: 'add', id: 'aaaa0007', at: old(3), tier: 'P2', kind: null, target: null, key: null, source: 'manual', note: 'no target', evidence: [] });
  write({ event: 'add', id: 'aaaa0008', at: old(3), tier: 'P2', kind: null, target: 'project', key: null, source: 'manual', note: 'retargeted', evidence: [] });
  write({ event: 'update', id: 'aaaa0008', at: old(2), target: 'plugin' });
  appendRow(other.inbox(), { event: 'add', id: 'bbbb0001', at: old(2), tier: 'P2', target: 'plugin', note: 'from the other project', evidence: [] });
  // The plugin's inbox already holds the key of one of them.
  const holder = plugin.add('blocked here too', ['--target', 'plugin', '--key', 'hook-deny:pr-body']);
  const before = readFileSync(own, 'utf8');

  const dry = consumer.run(['migrate', '--dry-run']);
  assert.equal(dry.stdout.split('\n')[0], `Would move 4 plugin lessons to ${plugin.inbox()}`);
  assert.match(dry.stdout, new RegExp(`\\n  ${notes}: aaaa0001, aaaa0003, aaaa0008\\n    aaaa0003 joins ${holder}, which holds its key there\\n  other-[0-9a-f]{8}: bbbb0001\\n$`));
  assert.equal(readFileSync(own, 'utf8'), before, 'a dry run writes nothing');

  const first = consumer.json(['migrate']);
  assert.deepEqual([first.moved, first.projects.map((item) => [item.project, item.ids])], [4, [[notes, ['aaaa0001', 'aaaa0003', 'aaaa0008']], [other.id, ['bbbb0001']]]]);
  assert.deepEqual(consumer.json(['list', '--all']).map((row) => row.id).sort(), ['aaaa0005', 'aaaa0007'], 'project lessons, and the one merged into one, stay');
  assert.equal(consumer.json(['list', 'aaaa0006'])[0].id, 'aaaa0005');
  const [fixed] = plugin.json(['list', 'aaaa0001']);
  assert.deepEqual(
    [fixed.id, fixed.seen, fixed.evidence, fixed.occurrences.map((item) => item.note), fixed.status, fixed.outcome, fixed.expect, fixed.merged, fixed.project],
    ['aaaa0001', 3, ['e1'], ['again', 'a duplicate, merged in'], 'resolved', 'mechanism', 'no more', ['aaaa0002'], notes],
  );
  assert.equal(plugin.json(['list', 'aaaa0002'])[0].id, 'aaaa0001', 'the duplicate merged into it moved with it');
  const [keyed] = plugin.json(['list', 'aaaa0003']);
  assert.deepEqual([keyed.id, keyed.seen], [holder, 3], 'a key the plugin\'s inbox holds takes the moved lesson as seen again');
  assert.deepEqual(plugin.json(['list', 'aaaa0008']).map((row) => [row.id, row.target, row.project]), [['aaaa0008', 'plugin', notes]]);
  assert.deepEqual(plugin.json(['list', 'bbbb0001']).map((row) => row.project), [other.id]);

  const files = () => [own, other.inbox(), plugin.inbox()].map((file) => readFileSync(file, 'utf8'));
  const after = files();
  assert.equal(consumer.run(['migrate']).stdout, `Moved 0 plugin lessons to ${plugin.inbox()}\n`);
  assert.deepEqual(files(), after, 'a second run writes nothing');

  // A move cut short after its copies and before its move rows copies nothing twice when it runs again.
  // (aaaa0003 is left out: it joined the holder, so its rows there are rewritten as occurrences.)
  const cut = path.join(consumer.base, 'cut.jsonl');
  writeFileSync(cut, before);
  const plugged = readFileSync(plugin.inbox(), 'utf8');
  assert.deepEqual(moveLessons(cut, plugin.inbox(), ['aaaa0001', 'aaaa0003', 'aaaa0008'], { project: notes }), ['aaaa0001', 'aaaa0003', 'aaaa0008']);
  assert.equal(readFileSync(plugin.inbox(), 'utf8'), plugged);
});

test('a lesson that joins a holder by key brings only its occurrences: the holder keeps its labels and its fix', (t) => {
  const { base } = setup(t);
  const from = path.join(base, 'from.jsonl');
  const to = path.join(base, 'to.jsonl');
  const old = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
  // The holder: added P3, raised to P2, then fixed, all after the moving lesson's own rows.
  appendRow(to, { event: 'add', id: 'dddd0001', at: old(9), tier: 'P3', kind: 'gap', target: 'plugin', key: 'hook-deny:z', source: 'auto', note: 'held', evidence: [] });
  appendRow(to, { event: 'update', id: 'dddd0001', at: old(3), tier: 'P2' });
  appendRow(to, { event: 'resolve', id: 'dddd0001', at: old(2), outcome: 'mechanism', link: 'abc1234' });
  // The moving lesson: P1 by its own update, rejected, with a duplicate merged into it; every row older than the fix.
  appendRow(from, { event: 'add', id: 'eeee0001', at: old(8), tier: 'P3', kind: 'bug', target: 'plugin', key: 'hook-deny:z', source: 'auto', note: 'moving', evidence: ['e1'] });
  appendRow(from, { event: 'seen', id: 'eeee0001', at: old(7), note: 'again', evidence: [] });
  appendRow(from, { event: 'add', id: 'eeee0002', at: old(6), tier: 'P2', target: 'project', note: 'a duplicate', evidence: [] });
  appendRow(from, { event: 'resolve', id: 'eeee0002', at: old(6), outcome: 'merged', link: 'eeee0001' });
  appendRow(from, { event: 'update', id: 'eeee0001', at: old(5), tier: 'P1', kind: 'rule' });
  appendRow(from, { event: 'resolve', id: 'eeee0001', at: old(4), outcome: 'rejected', link: 'noise' });
  assert.deepEqual(moveLessons(from, to, ['eeee0001'], { project: 'notes-1' }), ['eeee0001']);
  const { lessons: all, find } = fold(readRowsOf(to));
  const holder = find('dddd0001');
  assert.deepEqual(
    [holder.tier, holder.kind, holder.status, holder.outcome, holder.reopened, holder.seen],
    ['P2', 'gap', 'resolved', 'mechanism', 0, 4],
    'the holder keeps its tier, kind, and fix, and counts the moved add, seen, and duplicate as occurrences',
  );
  assert.deepEqual([find('eeee0001').id, find('eeee0002').id], ['dddd0001', 'dddd0001'], 'the moved ids find the holder');
  assert.deepEqual(all.map((lesson) => lesson.id), ['dddd0001'], 'no lesson of its own, open or merged, is left in the inbox');
  assert.deepEqual(readRowsOf(to).slice(3).map((row) => [row.event, row.id, row.key]), [
    ['add', 'eeee0001', 'hook-deny:z'], ['seen', 'eeee0001', undefined], ['add', 'eeee0002', 'hook-deny:z'],
  ], 'no update or resolve row is copied');
  assert.deepEqual(moveLessons(from, to, ['eeee0001']), [], 'a second move finds nothing to move');
});


test('add appends one add row with tier, kind, target, and where it was captured, and prints its id', (t) => {
  const { run, rows } = setup(t);
  const note = 'ran `git rev-parse` and $(false) with "$HOME" & saw: Error: ENOENT\nmore detail';
  const added = run(['add', '--tier', 'P1', '--kind', 'bug', '--target', 'project'], `evidence: scripts/it's.mjs\n${note}\n`);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /^[0-9a-f]{8}\n$/);
  assert.equal(run(['add'], 'second').status, 0);
  const [first, second] = rows();
  assert.deepEqual(
    { ...first, at: undefined, worktree: undefined },
    {
      event: 'add', id: added.stdout.trim(), at: undefined, tier: 'P1', kind: 'bug', target: 'project', key: null, source: 'manual',
      note, evidence: ["scripts/it's.mjs"], session: 'session-1', agent: 'planner', branch: 'main', worktree: undefined,
    },
  );
  assert.match(first.at, /^\d{4}-\d\d-\d\dT/);
  assert.match(first.worktree, /repo$/);
  assert.deepEqual([second.tier, second.kind, second.target], ['P2', null, null], 'P2 is the default tier; kind and target stay open');
});

test('add refuses an empty note and a bad tier, kind, or target, and writes nothing', (t) => {
  const { run } = setup(t);
  assert.deepEqual([run(['add'], 'evidence: x\n\n').status, run(['add'], 'evidence: x\n').stderr], [1, 'the lesson needs a note on stdin, after any "title:" or "evidence: <ref>" lines\n']);
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
  const mid = add('costly retry', ['--kind', 'gap']);
  const urgent = add('lost a commit', ['--tier', 'P1', '--kind', 'bug']);
  appendFileSync(inbox(), '{"torn": \n{"no":"id"}\n');
  assert.deepEqual(json(['list']).map((row) => row.id), [urgent, mid, old]);
  assert.deepEqual(json(['list', '--tier', 'P3']).map((row) => row.id), [old]);
  assert.deepEqual(json(['list', '--target', 'project']).map((row) => row.id), [old]);
  assert.deepEqual(json(['list', '--kind', 'bug']).map((row) => row.id), [urgent]);
  assert.deepEqual(json(['list', '--source', 'auto']), []);
  assert.deepEqual(json(['list', '--limit', '2']).map((row) => row.id), [urgent, mid]);
  run(['resolve', urgent, '--outcome', 'mechanism', '--link', 'abc1234']);
  assert.deepEqual(json(['list', '--status', 'resolved']).map((row) => row.id), [urgent]);
  assert.deepEqual(json(['list', '--all']).map((row) => row.id), [mid, old, urgent], 'open first');
  assert.match(run(['list']).stdout, new RegExp(`^${mid}  \\d{4}-\\d\\d-\\d\\d  \\[P2 open -/gap\\]  costly retry\\n${old}  .*\\[P3 open project/improvement\\]  old polish\\n$`));
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
  assert.equal(run(['resolve', second, '--outcome', 'rule', '--link', '-'], ' \n').stderr, '--link - read nothing from stdin; pipe the link in or pass --link <ref>\n');
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

test('every occurrence after a fix or a rejection counts against it; only the first reopens the lesson', () => {
  const rows = [
    lesson('aaaaaaaa', 20),
    lesson('bbbbbbbb', 20),
    { event: 'resolve', id: 'aaaaaaaa', at: at(10), outcome: 'mechanism', link: 'abc1234' },
    { event: 'resolve', id: 'bbbbbbbb', at: at(10), outcome: 'rejected', link: 'one session' },
    ...[3, 2, 1].flatMap((daysAgo) => ['aaaaaaaa', 'bbbbbbbb'].map((id) => ({ event: 'seen', id, at: at(daysAgo) }))),
  ];
  const { lessons } = fold(rows);
  assert.deepEqual(
    lessons.map((item) => [item.id, item.status, item.reopened, item.seen, item.resolutions.map((r) => r.recurred)]),
    [
      ['aaaaaaaa', 'open', 1, 4, [3]],
      ['bbbbbbbb', 'open', 1, 4, [3]],
    ],
  );
  const summary = lessonStats(lessons, { sinceMs: NOW - 30 * DAY, now: NOW });
  assert.deepEqual(summary.fixes.map((fix) => [fix.id, fix.recurred]), [['aaaaaaaa', 3]]);
  assert.match(formatStats(summary, { file: 'x', since: '30d' }), /  aaaaaaaa {2}mechanism {2}\S+ {2}recurred 3 times {2}lesson aaaaaaaa$/m);
  const again = fold([...rows, { event: 'resolve', id: 'aaaaaaaa', at: at(0.5), outcome: 'rule', link: 'docs/x.md' }, { event: 'seen', id: 'aaaaaaaa', at: at(0.25) }]);
  const [fixedTwice] = again.lessons;
  assert.deepEqual([fixedTwice.status, fixedTwice.reopened, fixedTwice.resolutions.map((r) => r.recurred)], ['open', 2, [3, 1]], 'a later fix takes the later occurrences');
});

test('merging moves occurrences, so stats count each one once, along a chain of merges too', () => {
  const window = (rows) => lessonStats(fold(rows).lessons, { sinceMs: NOW - 30 * DAY, now: NOW }).window.seen_again;
  const pair = [
    lesson('aaaaaaaa', 9),
    lesson('bbbbbbbb', 8),
    { event: 'seen', id: 'bbbbbbbb', at: at(7) },
    { event: 'seen', id: 'bbbbbbbb', at: at(6) },
    { event: 'resolve', id: 'bbbbbbbb', at: at(5), outcome: 'merged', link: 'aaaaaaaa' },
  ];
  assert.equal(window(pair), 3, 'b itself and its two occurrences, now on a');
  assert.deepEqual(fold(pair).lessons.map((item) => [item.id, item.occurrences.length]), [['aaaaaaaa', 3], ['bbbbbbbb', 0]]);
  const chain = [
    lesson('aaaaaaaa', 9),
    lesson('bbbbbbbb', 8),
    lesson('cccccccc', 7),
    { event: 'seen', id: 'cccccccc', at: at(6) },
    { event: 'resolve', id: 'cccccccc', at: at(5), outcome: 'merged', link: 'bbbbbbbb' },
    { event: 'seen', id: 'bbbbbbbb', at: at(4) },
    { event: 'resolve', id: 'bbbbbbbb', at: at(3), outcome: 'merged', link: 'aaaaaaaa' },
  ];
  assert.equal(window(chain), 4, 'b, c, and one occurrence of each');
  assert.deepEqual(fold(chain).lessons.map((item) => [item.id, item.seen, item.occurrences.length]).at(0), ['aaaaaaaa', 5, 4]);
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
  assert.match(run(['update', id, '--tier', 'P1', '--target', 'project']).stdout, new RegExp(`^${id}  .*\\[P1 open project/-\\]  polish\\n$`));
  assert.deepEqual(json(['list']).map((row) => [row.tier, row.kind, row.target, row.seen]), [['P1', null, 'project', 1]]);
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

test('--project reads another project\'s inbox, and a missing or unknown action prints the usage', (t) => {
  const { repo, env, add } = setup(t);
  const id = add('from the project');
  const elsewhere = spawnSync(CLI, ['lesson', 'list', '--json', '--project', repo], { cwd: tmpdir(), encoding: 'utf8', env });
  assert.deepEqual(JSON.parse(elsewhere.stdout).map((row) => row.id), [id]);
  for (const args of [[], ['show']]) {
    const usage = spawnSync(CLI, ['lesson', ...args], { cwd: repo, encoding: 'utf8', env });
    assert.deepEqual([usage.status, usage.stderr.startsWith('usage: aidrian lesson add [--tier P1|P2|P3]')], [1, true]);
  }
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
