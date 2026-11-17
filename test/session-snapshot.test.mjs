import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { arm, noteFrom, noteStarted, openStore } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { stopMarkerPath } from '../plugins/aidrian/lib/session-length.mjs';
import { cachedValue } from '../plugins/aidrian/lib/session-cached-value.mjs';
import { DISPLAY_CAPS, displayText, MERGED_HEADS, snapshotLine } from '../plugins/aidrian/lib/session-snapshot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/lib/cli.mjs');
const HOOK = path.join(ROOT, 'plugins/aidrian/scripts/hook-stop.mjs');
const LIB = path.join(ROOT, 'plugins/aidrian/lib');
const FIXTURES = path.join(ROOT, 'test/fixtures/transcripts');
const POSIX = process.platform !== 'win32';
const ID = 'snap-1';
const SECTIONS = ['handoff', 'prs', 'lessons', 'worktrees', 'decisions', 'audits', 'ticket'];
// What a terminal must never receive: C0 but the line feed, DEL, and C1.
const CLEAN = /^[^\u0000-\u0009\u000b-\u001f\u007f-\u009f]*\n?$/u;

const scratch = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-snapshot-')));
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

// A fake gh that logs each call's arguments to `log`, waits `delay` ms, then prints `answer`. With `trap`, it ignores
// SIGTERM, as a gh stuck in its own cleanup may.
function fakeGh(bin, { log, delay = 0, answer = '[]', trap = false }) {
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'gh');
  writeFileSync(file, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
    `${trap ? "process.on('SIGTERM', () => {});\n" : ''}setTimeout(() => process.stdout.write(${JSON.stringify(answer)}), ${delay});\n`);
  chmodSync(file, 0o755);
}
const ghCalls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

// A project in a git repository of its own, on `branch`, with its own state root, temporary folder, and fake gh.
function setup(t, { config = {}, origin = null, branch = 'main', name = 'project', gh = {} } = {}) {
  const base = scratch();
  const dir = path.join(base, name);
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, ...config }));
  git(dir, 'init', '-q', '-b', branch);
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'start');
  const state = path.join(base, 'state');
  const temp = path.join(base, 'tmp');
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(temp);
  const log = path.join(base, 'gh.log');
  fakeGh(path.join(base, 'bin'), { log, ...gh });
  const env = { ...process.env, XDG_STATE_HOME: state, TMPDIR: temp, PATH: `${path.join(base, 'bin')}${path.delimiter}${process.env.PATH}` };
  const run = (args = [], { cwd = dir, extraEnv = {} } = {}) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [CLI, 'session', 'snapshot', ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
    return { ...result, ms: Date.now() - started, json: args.includes('--line') || result.status !== 0 ? null : JSON.parse(result.stdout) };
  };
  const projectState = () => spawnSync(process.execPath, [CLI, 'state'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
  return { base, dir, state, temp, env, run, log, projectState };
}

// Each turn of a handoff fixture: its text up to the turn's assistant call.
function turnsOf(name) {
  const lines = readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8').trimEnd().split('\n');
  return lines.flatMap((line, index) => (JSON.parse(line).type === 'assistant' ? [`${lines.slice(0, index + 1).join('\n')}\n`] : []));
}

const stopHook = ({ dir, env }, transcript) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ hook_event_name: 'Stop', session_id: ID, transcript_path: transcript, cwd: dir, stop_hook_active: false }), cwd: dir, env, encoding: 'utf8',
});

test('the JSON object and the line at each handoff level, with the Stop hook`s own marker giving reminded', (t) => {
  const cost = setup(t);
  const transcript = path.join(cost.base, 'session.jsonl');
  const at = (env, turn, fixture = 'handoff-cost') => {
    writeFileSync(transcript, turnsOf(fixture)[turn]);
    return [env.run(['--session', ID, '--transcript', transcript, '--json']), env.run(['--session', ID, '--transcript', transcript, '--line'])];
  };
  const [quiet, quietLine] = at(cost, 0);
  assert.deepEqual(Object.keys(quiet.json), ['session', ...SECTIONS, 'errors']);
  assert.deepEqual(quiet.json.session, { id: ID, transcript, cwd: cost.dir });
  assert.deepEqual(Object.keys(quiet.json.handoff), ['ratio', 'breakEven', 'level', 'nextRatio', 'context', 'ceiling', 'chain', 'maxChain', 'continueArmed', 'lastBrief']);
  assert.equal(quiet.json.handoff.level, 'quiet');
  assert.equal(quiet.json.prs, null);
  assert.deepEqual(quiet.json.errors, [], 'no origin a forge serves: no merged count, and no failure');
  assert.deepEqual(quiet.json.worktrees, { owned: 0, mergedNotCleaned: null });
  assert.match(quietLine.stdout, /^\d\.\dx\n$/u);
  const [offer, offerLine] = at(cost, 3);
  assert.equal(offer.json.handoff.level, 'offer');
  assert.equal(offerLine.stdout, `${offer.json.handoff.ratio.toFixed(1)}x · handoff pays back in ~${Math.round(offer.json.handoff.breakEven)} calls\n`);
  const [due, dueLine] = at(cost, 4);
  assert.equal(due.json.handoff.level, 'due');
  const dueWords = `${due.json.handoff.ratio.toFixed(1)}x · handoff due, pays back in ~${Math.round(due.json.handoff.breakEven)} calls\n`;
  assert.equal(dueLine.stdout, dueWords);
  assert.equal(stopHook(cost, transcript).status, 2, 'the Stop hook reminds on this turn and writes its marker');
  const [reminded, remindedLine] = at(cost, 4);
  assert.equal(reminded.json.handoff.level, 'reminded', 'read from the marker at the hook`s own path');
  assert.equal(remindedLine.stdout, dueWords);
  const ceiling = setup(t, { config: { session: { handoff: { maxTokens: 120_000 } } } });
  const [top, topLine] = at(ceiling, 3, 'handoff-ceiling');
  assert.equal(top.json.handoff.level, 'ceiling');
  assert.equal(top.json.handoff.ceiling, 120_000);
  assert.equal(topLine.stdout, 'handoff now\n');
  for (const each of [quietLine, offerLine, dueLine, remindedLine, topLine]) assert.match(each.stdout, CLEAN);
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`);
  const fresh = cost.run(['--session', 'fresh-1', '--transcript', transcript]);
  assert.equal(fresh.json.handoff.ratio, 0);
  assert.equal(cost.run(['--session', 'fresh-1', '--transcript', transcript, '--line']).stdout, '\n', 'no model call yet: no handoff segment');
});

test('an armed continuation adds its chain to the line; the store is read and left as it was', (t) => {
  const env = setup(t);
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[0]);
  env.run(['--session', ID, '--transcript', transcript]);
  const handoffs = path.join(env.projectState(), 'handoffs');
  mkdirSync(handoffs, { recursive: true });
  const brief = path.join(handoffs, '2026-11-17-snapshot-task.md');
  writeFileSync(brief, '# brief\n');
  writeFileSync(path.join(handoffs, '2026-11-16-older-task.md'), '# older\n');
  utimesSync(path.join(handoffs, '2026-11-16-older-task.md'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  writeFileSync(path.join(handoffs, 'notes.md'), 'no brief name\n');
  const later = new Date(Date.now() + 60_000);
  symlinkSync(brief, path.join(handoffs, '2026-11-18-linked-task.md'));
  lutimesSync(path.join(handoffs, '2026-11-18-linked-task.md'), later, later);
  mkdirSync(path.join(handoffs, '2026-11-18-folder-task.md'));
  utimesSync(path.join(handoffs, '2026-11-18-folder-task.md'), later, later);
  const store = openStore(env.projectState(), { checkouts: [], maxChain: 3 });
  assert.ok(arm(store, { route: 'clear', session: ID, brief, slug: 'snapshot-task', chain: 1, sha256: 'a'.repeat(64) }));
  // What a sweep would delete: an armed marker past its day, and a temporary file left behind.
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  writeFileSync(path.join(store.dir, 'armed-gone-1.json'), '{}');
  utimesSync(path.join(store.dir, 'armed-gone-1.json'), old, old);
  writeFileSync(path.join(store.dir, '.armed-gone-2.json.123.0123456789ab.tmp'), '{}');
  utimesSync(path.join(store.dir, '.armed-gone-2.json.123.0123456789ab.tmp'), old, old);
  const listing = () => [handoffs, store.dir].flatMap((dir) => readdirSync(dir).map((name) => `${name} ${lstatSync(path.join(dir, name)).mtimeMs}`)).sort();
  const before = listing();
  const { json } = env.run(['--session', ID, '--transcript', transcript]);
  assert.deepEqual([json.handoff.chain, json.handoff.maxChain, json.handoff.continueArmed, json.handoff.lastBrief], [1, 3, true, 'snapshot-task'],
    'a newer symlink and a newer folder named like a brief are no brief');
  assert.match(env.run(['--session', ID, '--transcript', transcript, '--line']).stdout, /^\d\.\dx · armed 1\/3\n$/u);
  assert.deepEqual(listing(), before, 'no store file is added, removed, or touched');
  const other = env.run(['--session', 'another', '--transcript', transcript]).json.handoff;
  assert.deepEqual([other.chain, other.continueArmed, other.lastBrief], [0, false, 'snapshot-task'], 'the latest brief is any session`s');
});

test('a session the background route started shows the floor filed under its short id, above the working copy`s maxChain', (t) => {
  const env = setup(t);
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[0]);
  const store = openStore(env.projectState(), { checkouts: [], maxChain: 3 });
  const brief = path.join(store.handoffs, '2026-11-17-snapshot-task.md');
  // The base branch allows up to 5, so a background start may give a floor the working copy's maxChain of 3 is below.
  assert.ok(noteFrom(store, 'bg12', { slug: 'snapshot-task', chain: 4, brief, route: 'background' }));
  const { json } = env.run(['--session', 'bg12-started-session', '--transcript', transcript]);
  assert.deepEqual([json.handoff.chain, json.handoff.maxChain, json.handoff.continueArmed], [4, 3, false]);
  assert.doesNotMatch(env.run(['--session', 'bg12-started-session', '--transcript', transcript, '--line']).stdout, /armed/u);
});

test('a background start arms nothing: the session that handed off keeps continueArmed false and its level', (t) => {
  const env = setup(t);
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  const store = openStore(env.projectState(), { checkouts: [], maxChain: 3 });
  const brief = path.join(store.handoffs, '2026-11-17-snapshot-task.md');
  const started = { sha256: 'b'.repeat(64), slug: 'snapshot-task', brief, chain: 1, id: 'bg12', session: null, name: null, cwd: env.dir };
  assert.ok(noteStarted(store, ID, started));
  const { json } = env.run(['--session', ID, '--transcript', transcript]);
  assert.deepEqual([json.handoff.level, json.handoff.chain, json.handoff.continueArmed], ['due', 0, false]);
  assert.doesNotMatch(env.run(['--session', ID, '--transcript', transcript, '--line']).stdout, /armed/u);
});

test('a refused continuation store leaves chain, continueArmed, and lastBrief null; the snapshot calls no store writer', (t) => {
  const env = setup(t);
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  const handoffs = path.join(env.projectState(), 'handoffs');
  mkdirSync(handoffs, { recursive: true });
  writeFileSync(path.join(handoffs, '2026-11-17-snapshot-task.md'), '# brief\n');
  mkdirSync(path.join(env.base, 'elsewhere'));
  symlinkSync(path.join(env.base, 'elsewhere'), path.join(handoffs, '.continue'));
  const { json } = env.run(['--session', ID, '--transcript', transcript]);
  assert.equal(json.handoff.level, 'due', 'the numbers stay');
  assert.deepEqual([json.handoff.chain, json.handoff.maxChain, json.handoff.continueArmed, json.handoff.lastBrief], [null, 3, null, null]);
  const imports = readFileSync(path.join(LIB, 'session-snapshot.mjs'), 'utf8').match(/^import [^;]+;$/gmu).join('\n');
  for (const writer of ['arm', 'cancelArmed', 'promote', 'takeReady', 'takeCleared', 'deliverCleared', 'noteFrom', 'sweep', 'stampChecked']) {
    assert.doesNotMatch(imports, new RegExp(`\\b${writer}\\b`, 'u'), writer);
  }
});

test('with nothing to show, the line is empty; with no project every section is null, and nothing is written', (t) => {
  const env = setup(t);
  const outside = path.join(env.base, 'plain');
  mkdirSync(outside);
  const before = [readdirSync(env.state), readdirSync(env.temp)];
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  const { json, status } = env.run(['--session', ID, '--transcript', transcript], { cwd: outside });
  assert.equal(status, 0);
  assert.deepEqual(json, { session: { id: ID, transcript, cwd: outside }, ...Object.fromEntries(SECTIONS.map((name) => [name, null])), errors: [] });
  assert.deepEqual(env.run(['--line'], { cwd: outside }).stdout, '\n');
  assert.deepEqual([readdirSync(env.state), readdirSync(env.temp)], before);
  assert.equal(snapshotLine({ handoff: null, lessons: { open: 2, byTier: { P1: 0, P2: 2, P3: 0 } }, decisions: { provisional: 0 }, worktrees: null, audits: { untriaged: 0 } }), '');
});

test('the command reads no stdin and no host variable: the caller passes the session', async (t) => {
  const env = setup(t);
  const child = spawn(process.execPath, [CLI, 'session', 'snapshot'], { cwd: env.dir, env: { ...env.env, CLAUDE_SESSION_ID: ID, CODEX_SESSION_ID: ID }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  child.stdin.destroy();
  assert.equal(code, 0, 'it ends with its stdin still open');
  const json = JSON.parse(stdout);
  assert.equal(json.session.id, null);
  assert.deepEqual([json.handoff, json.prs, json.worktrees.mergedNotCleaned, json.errors], [null, null, null, []], 'without --session nothing is cached and nothing is an error');
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  const noTranscript = env.run(['--session', ID]).json;
  assert.equal(noTranscript.handoff, null);
  assert.ok(!noTranscript.errors.includes('handoff'), 'without --transcript the handoff is not asked for');
  assert.equal(env.run(['--transcript', transcript]).json.handoff, null);
});

test('a session id that fails SESSION_ID writes nothing, and names handoff and prs in errors', (t) => {
  const env = setup(t);
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  for (const id of ['../x', 'a/b', 'x'.repeat(129)]) {
    const { json, status } = env.run(['--session', id, '--transcript', transcript]);
    assert.equal(status, 0);
    assert.equal(json.session.id, null);
    assert.deepEqual([json.handoff, json.prs], [null, null]);
    assert.ok(['handoff', 'prs'].every((name) => json.errors.includes(name)), id);
  }
  assert.equal(existsSync(path.join(env.projectState(), 'sessions')), false, 'no session folder');
  assert.equal(existsSync(path.join(env.projectState(), 'x')), false);
  assert.equal(existsSync(path.join(env.base, 'x')), false);
  assert.deepEqual(readdirSync(env.temp), []);
});

test('a state folder inside the checkout gives no session folder, and no handoff, lessons, or audits section', { skip: !POSIX }, (t) => {
  const env = setup(t, { config: { state: { dir: '.state' } } });
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  mkdirSync(path.join(env.dir, '.state', 'lessons'), { recursive: true });
  spawnSync('mkfifo', [path.join(env.base, 'pipe')]);
  symlinkSync(path.join(env.base, 'pipe'), path.join(env.dir, '.state', 'lessons', 'inbox.jsonl'));
  const { json, status, ms } = env.run(['--session', ID, '--transcript', transcript]);
  assert.equal(status, 0);
  assert.ok(ms < 10_000, `${ms} ms`);
  assert.deepEqual([json.handoff, json.lessons, json.audits], [null, null, null]);
  assert.deepEqual(json.errors, ['handoff', 'prs', 'lessons', 'worktrees', 'audits']);
  assert.equal(existsSync(path.join(env.dir, '.state', 'sessions')), false, 'no cache is written inside the checkout');
});

test('under mode off the level is quiet and the numbers stay', (t) => {
  const env = setup(t, { config: { session: { handoff: { mode: 'off' } } } });
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  const { handoff } = env.run(['--session', ID, '--transcript', transcript]).json;
  assert.equal(handoff.level, 'quiet');
  assert.ok(handoff.ratio >= 2 && handoff.breakEven > 0, 'at the threshold');
});

test('a named pipe at the marker path or as the transcript leaves handoff null, in errors, without waiting', { skip: !POSIX }, (t) => {
  const env = setup(t);
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  const pipe = path.join(env.base, 'pipe');
  spawnSync('mkfifo', [pipe]);
  const viaPipe = env.run(['--session', ID, '--transcript', pipe]);
  assert.equal(viaPipe.json.handoff, null);
  assert.ok(viaPipe.json.errors.includes('handoff'));
  spawnSync('mkfifo', [path.join(env.temp, `aidrian-session-length-${ID}`)]);
  const viaMarker = env.run(['--session', ID, '--transcript', transcript]);
  assert.equal(viaMarker.json.handoff, null);
  assert.ok(viaMarker.json.errors.includes('handoff'));
  assert.ok(viaPipe.ms < 10_000 && viaMarker.ms < 10_000);
});

test('stopMarkerPath is the one marker path; the hook keeps no id pattern and renames over a symlink', { skip: !POSIX }, (t) => {
  assert.equal(stopMarkerPath('abc-1'), path.join(tmpdir(), 'aidrian-session-length-abc-1'));
  for (const id of ['../x', 'a b', '', null, 'x'.repeat(129)]) assert.equal(stopMarkerPath(id), null);
  for (const file of [path.join(ROOT, 'plugins/aidrian/scripts/hook-stop.mjs'), path.join(LIB, 'gate-snapshot.mjs')]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\[\\w-\]/u, `${path.basename(file)} keeps no session id pattern of its own`);
  }
  assert.match(readFileSync(path.join(LIB, 'gate-snapshot.mjs'), 'utf8'), /import \{ SESSION_ID \} from '\.\/handoff-markers\.mjs';/u);
  const env = setup(t);
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  const target = path.join(env.base, 'target');
  writeFileSync(target, 'keep\n');
  const marker = path.join(env.temp, `aidrian-session-length-${ID}`);
  symlinkSync(target, marker);
  assert.equal(stopHook(env, transcript).status, 2);
  assert.equal(readFileSync(target, 'utf8'), 'keep\n');
  assert.equal(lstatSync(marker).isFile(), true);
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(env.temp), [path.basename(marker)], 'no temporary file is left');
});

test('lessons, decisions, and audits count what their readers give; a marker outside the indexes counts no decision', (t) => {
  for (const enabled of [true, false]) {
    const env = setup(t, { config: { telemetry: { enabled } } });
    const docs = path.join(env.dir, 'docs');
    mkdirSync(docs);
    mkdirSync(path.join(env.dir, '.aidrian/knowledge'));
    writeFileSync(path.join(env.dir, '.aidrian/knowledge/10-docs.json'), JSON.stringify({ dir: 'docs', always: [], docs: { 'rules.md': { summary: 'Rules.', tags: [] } } }));
    writeFileSync(path.join(docs, 'rules.md'), '# Rules\n\n- One.\n  <!-- aidrian:decision id=one status=unconfirmed class=copy domain=ux date=2026-11-01 pr=none -->\n' +
      '- Two.\n  <!-- aidrian:decision id=two status=confirmed class=copy domain=ux date=2026-11-01 pr=none -->\n');
    writeFileSync(path.join(env.dir, 'stray.md'), '<!-- aidrian:decision id=three status=unconfirmed class=copy domain=ux date=2026-11-01 pr=none -->\n');
    git(env.dir, 'add', '.');
    git(env.dir, 'commit', '-q', '-m', 'docs');
    const add = (tier, title) => spawnSync(process.execPath, [CLI, 'lesson', 'add', '--tier', tier], { cwd: env.dir, env: env.env, input: `title: ${title}\nA note.\n`, encoding: 'utf8' });
    assert.equal(add('P1', 'first').status, 0);
    assert.equal(add('P2', 'second').status, 0);
    const audits = path.join(env.projectState(), 'audits');
    mkdirSync(audits, { recursive: true });
    writeFileSync(path.join(audits, 'front-desk-2026-06-01.md'), '## Findings\n\n### F1. polish: x\n\n### F2. polish: y\n');
    const before = existsSync(path.join(env.projectState(), 'dispatch-log.jsonl')) ? readFileSync(path.join(env.projectState(), 'dispatch-log.jsonl'), 'utf8') : null;
    const { json } = env.run();
    assert.deepEqual(json.lessons, { open: 2, byTier: { P1: 1, P2: 1, P3: 0 } });
    assert.deepEqual(json.decisions, { provisional: 1 }, `telemetry ${enabled}`);
    assert.deepEqual(json.audits, { untriaged: 2 });
    const after = existsSync(path.join(env.projectState(), 'dispatch-log.jsonl')) ? readFileSync(path.join(env.projectState(), 'dispatch-log.jsonl'), 'utf8') : null;
    assert.equal(after, before, 'no dispatch-log row is read for it or written');
    assert.equal(env.run(['--line']).stdout, '📥 1 P1 · ⚖️ 1 decision · 🔎 2 findings\n');
  }
});

// A project with one linked worktree on `feat/x`, whose origin is `origin`, and a fake gh that answers with `heads`.
function withWorktree(t, { origin = 'https://github.com/acme/notes.git', gh = {}, merged = true } = {}) {
  const env = setup(t, { origin, gh });
  const tree = path.join(env.base, 'tree');
  git(env.dir, 'worktree', 'add', '-q', '-b', 'feat/x', tree);
  const head = git(tree, 'rev-parse', 'HEAD');
  const answer = JSON.stringify(merged ? [{ headRefName: 'feat/x', headRefOid: head }, { headRefName: 'other', headRefOid: 'f'.repeat(40) }] : []);
  fakeGh(path.join(env.base, 'bin'), { log: env.log, answer, ...gh });
  return { ...env, tree, head };
}

test('worktrees counts the owned and the merged ones, and reads merged heads once a window', (t) => {
  const env = withWorktree(t);
  const first = env.run(['--session', ID]).json;
  assert.deepEqual(first.worktrees, { owned: 1, mergedNotCleaned: 1 });
  assert.deepEqual(first.errors, []);
  assert.equal(env.run(['--session', ID, '--line']).stdout, '🧹 1 worktree\n');
  env.run(['--session', ID]);
  assert.equal(ghCalls(env.log).length, 1, 'the second snapshot inside the window reads the cache');
  const cache = path.join(env.projectState(), 'sessions', ID, MERGED_HEADS.name);
  if (POSIX) assert.equal(statSync(cache).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(cache, 'utf8'));
  writeFileSync(cache, JSON.stringify({ ...stored, attemptAt: Date.now() - 120_000 }));
  fakeGh(path.join(env.base, 'bin'), { log: env.log, delay: 5000 });
  const late = env.run(['--session', ID, '--deadline-ms', '200']);
  assert.deepEqual(late.json.worktrees, { owned: 1, mergedNotCleaned: 1, stale: true }, 'a refresh past the deadline shows the cached value as stale');
  assert.ok(late.ms < 4000, `${late.ms} ms`);
  assert.equal(ghCalls(env.log).length, 2);
  assert.deepEqual(env.run(['--session', ID]).json.worktrees.stale, true);
  assert.equal(ghCalls(env.log).length, 2, 'after a refresh that hit the deadline, the next snapshot in the window starts no gh call');
});

test('a snapshot started while a slow gh still answers an earlier one starts no gh call', async (t) => {
  const env = withWorktree(t, { gh: { delay: 2500 } });
  const slow = spawn(process.execPath, [CLI, 'session', 'snapshot', '--session', ID], { cwd: env.dir, env: env.env, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  slow.stdout.on('data', (chunk) => (out += chunk));
  const done = new Promise((resolve) => slow.on('exit', resolve));
  const until = Date.now() + 10_000;
  while (!ghCalls(env.log).length && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ghCalls(env.log).length, 1);
  const meanwhile = env.run(['--session', ID]).json;
  assert.equal(meanwhile.worktrees.mergedNotCleaned, null);
  assert.ok(meanwhile.errors.includes('worktrees'), 'no value yet');
  assert.equal(await done, 0);
  assert.equal(JSON.parse(out).worktrees.mergedNotCleaned, 1);
  assert.equal(ghCalls(env.log).length, 1);
});

test('the merged-heads read names origin`s repository to gh, and starts no call for an origin the forge does not serve', (t) => {
  const env = withWorktree(t);
  git(env.dir, 'remote', 'add', 'upstream', 'https://gitlab.example.com/acme/notes.git');
  env.run(['--session', ID]);
  assert.deepEqual(ghCalls(env.log), [['pr', 'list', '--state', 'merged', '--limit', '400', '--json', 'headRefName,headRefOid', '--repo', 'github.com/acme/notes']]);
  for (const origin of ['https://gitlab.example.com/acme/notes.git', 'https://github.com/acme%2Fsub/notes.git', 'git@github.com:acme/..', 'git@github.com:acme/.']) {
    const other = withWorktree(t, { origin });
    const { json } = other.run(['--session', ID]);
    assert.deepEqual(ghCalls(other.log), [], origin);
    assert.deepEqual(json.worktrees, { owned: 1, mergedNotCleaned: null });
    assert.deepEqual(json.errors, [], 'a repository the forge does not serve is unsupported, not failed');
  }
  const none = withWorktree(t, { origin: null });
  assert.deepEqual([none.run(['--session', ID]).json.errors, ghCalls(none.log)], [[], []], 'no origin');
});

test('the merged-heads cache is read under the Reads rule: a named pipe, a file past 1 MiB, or a symlink there is no cache', { skip: !POSIX }, (t) => {
  for (const kind of ['pipe', 'large', 'symlink']) {
    const env = withWorktree(t);
    env.run(['--session', 'warm-up']);
    const folder = path.join(env.projectState(), 'sessions', ID);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const cache = path.join(folder, MERGED_HEADS.name);
    const fresh = JSON.stringify({ value: [['feat/x', env.head], ['feat/y', 'e'.repeat(40)]], valueAt: Date.now(), attemptAt: Date.now() });
    const target = path.join(env.base, 'target.json');
    if (kind === 'pipe') spawnSync('mkfifo', [cache]);
    if (kind === 'large') writeFileSync(cache, fresh.replace('"feat/y"', `"${'y'.repeat(MERGED_HEADS.cap)}"`));
    if (kind === 'symlink') {
      writeFileSync(target, fresh);
      symlinkSync(target, cache);
    }
    const calls = ghCalls(env.log).length;
    const { json, ms } = env.run(['--session', ID]);
    assert.ok(ms < 10_000, `${kind}: ${ms} ms`);
    assert.deepEqual(json.worktrees, { owned: 1, mergedNotCleaned: 1 }, kind);
    assert.equal(ghCalls(env.log).length, calls + 1, `${kind}: read as no cache, so the forge is asked`);
    assert.equal(lstatSync(cache).isFile(), true, `${kind}: replaced by the session's own file`);
    if (kind === 'symlink') assert.equal(readFileSync(target, 'utf8'), fresh, 'nothing is written through the symlink');
  }
});

test('a Stop marker past its 64 KiB cap is not read: the handoff section fails', (t) => {
  const env = setup(t);
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  writeFileSync(path.join(env.temp, `aidrian-session-length-${ID}`), `${' '.repeat(64 * 1024)}{"lastRatio":0,"tokens":0,"compactions":0}\n`);
  const { json } = env.run(['--session', ID, '--transcript', transcript]);
  assert.equal(json.handoff, null);
  assert.ok(json.errors.includes('handoff'));
});

test('a gh that ignores SIGTERM is killed at the deadline', (t) => {
  const env = withWorktree(t, { gh: { delay: 6000, trap: true } });
  const { json, ms, status } = env.run(['--session', ID, '--deadline-ms', '1500']);
  assert.equal(status, 0);
  assert.equal(ghCalls(env.log).length, 1, 'gh started, and set its trap long before the deadline');
  assert.ok(ms < 4500, `${ms} ms`);
  assert.equal(json.worktrees.mergedNotCleaned, null);
  assert.ok(json.errors.includes('worktrees'), 'a read that failed with no cache is a failure');
});

test('a git that hangs only on the worktree list is stopped at git`s limit', { skip: !POSIX }, (t) => {
  const env = setup(t);
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(env.base, 'hang');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" worktree list "*) exec sleep 600;; esac\nexec ${real} "$@"\n`);
  chmodSync(path.join(bin, 'git'), 0o755);
  const { status, ms, json } = env.run(['--session', ID], { extraEnv: { PATH: `${bin}${path.delimiter}${env.env.PATH}` } });
  assert.equal(status, 0);
  assert.ok(ms < 10_000, `${ms} ms`);
  assert.equal(json.worktrees, null);
  assert.ok(json.errors.includes('worktrees'));
});

test('the state folder read is killed at git`s limit, even by a git that ignores SIGTERM', { skip: !POSIX }, (t) => {
  const env = setup(t, { origin: 'https://github.com/acme/notes.git' });
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(env.base, 'stubborn');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" --get remote.origin.url "*) trap '' TERM; exec sleep 20;; esac\nexec ${real} "$@"\n`);
  chmodSync(path.join(bin, 'git'), 0o755);
  const { status, ms } = env.run(['--session', ID], { extraEnv: { PATH: `${bin}${path.delimiter}${env.env.PATH}` } });
  assert.equal(status, 0);
  assert.ok(ms < 10_000, `${ms} ms`);
});

test('a config.json with a bad value still gives the decisions count', (t) => {
  const env = setup(t, { config: { lessons: { maxOpen: 'many' } } });
  mkdirSync(path.join(env.dir, 'docs'));
  mkdirSync(path.join(env.dir, '.aidrian/knowledge'));
  writeFileSync(path.join(env.dir, '.aidrian/knowledge/10-docs.json'), JSON.stringify({ dir: 'docs', always: [], docs: { 'rules.md': { summary: 'Rules.', tags: [] } } }));
  writeFileSync(path.join(env.dir, 'docs/rules.md'), '- One.\n  <!-- aidrian:decision id=one status=unconfirmed class=copy domain=ux date=2026-11-01 pr=none -->\n');
  const { json } = env.run();
  assert.deepEqual(json.decisions, { provisional: 1 });
  assert.ok(!json.errors.includes('decisions'));
});

test('session-snapshot.mjs names no forge outside its comments', () => {
  const code = readFileSync(path.join(LIB, 'session-snapshot.mjs'), 'utf8').split('\n')
    .filter((line) => !/^\s*\/\//u.test(line)).map((line) => line.replace(/\s\/\/ .*$/u, '')).join('\n');
  assert.doesNotMatch(code, /github/iu);
  assert.doesNotMatch(code, /['"`]gh['"`]|--hostname|repos\//u);
});

test('the ticket comes from the prefixes the caller passes, else from a numbered branch; a bad prefix list makes it null', (t) => {
  const keyed = setup(t, { branch: 'feat/abc-123-login' });
  assert.deepEqual(keyed.run(['--ticket-prefixes', 'XY|ABC']).json.ticket, { key: 'ABC-123', source: 'branch' });
  assert.equal(keyed.run([]).json.ticket, null, 'no prefixes and no number after the type');
  const numbered = setup(t, { branch: 'fix/42-login-redirect' });
  assert.deepEqual(numbered.run([]).json.ticket, { key: '#42', source: 'branch' });
  assert.deepEqual(numbered.run(['--ticket-prefixes', 'ABC']).json.ticket, { key: '#42', source: 'branch' });
  for (const prefixes of ['1AB', 'A.B', 'A|', 'ABCDEFGHIJKLMNOPQ', 'A(B', Array.from({ length: 33 }, (_, i) => `P${i}`).join('|')]) {
    const { json, status } = numbered.run(['--ticket-prefixes', prefixes]);
    assert.equal(status, 0);
    assert.equal(json.ticket, null, prefixes);
    assert.deepEqual(json.errors, ['worktrees', 'ticket'].filter((name) => json.errors.includes(name)));
    assert.ok(json.errors.includes('ticket'), prefixes);
  }
  assert.deepEqual(numbered.run(['--ticket-prefixes', Array.from({ length: 32 }, (_, i) => `P${i}`).join('|')]).json.ticket, { key: '#42', source: 'branch' });
});

test('bad arguments exit 1 with the usage; every read failure exits 0', (t) => {
  const env = setup(t);
  for (const args of [['--json', '--line'], ['--deadline-ms', '0'], ['--deadline-ms', '5000'], ['--deadline-ms', 'x'], ['extra'], ['--nope']]) {
    const { status, stderr } = env.run(args);
    assert.equal(status, 1, args.join(' '));
    assert.match(stderr, /aidrian session snapshot/u);
  }
  writeFileSync(path.join(env.dir, '.aidrian/config.json'), '{ broken');
  const { status, json } = env.run(['--session', ID]);
  assert.equal(status, 0);
  assert.ok(json.errors.every((name) => SECTIONS.includes(name)), 'section names only');
});

test('displayText removes every hidden character and cuts by code point', () => {
  assert.equal(displayText('a\u001b]52;c;x\u0007b\u001b[2Jc\u202ed\u200fe\u200bf\ufeffg\u{E0041}h\u2028i\u2029j\u007fk\u009bl\ud800m'), 'a]52;c;xb[2Jcdefghijklm');
  assert.equal(displayText('😀'.repeat(150)), '😀'.repeat(DISPLAY_CAPS.name));
  assert.equal(displayText('x'.repeat(2000), DISPLAY_CAPS.path).length, 1024);
});

test('a folder name holding control, bidi, zero-width, and tag characters reaches neither --json nor --line', { skip: !POSIX }, (t) => {
  const name = 'p\u001b]52;c;eA==\u0007\u001b[2J\u202e\u200f\u200b\ufeff\u{E0041}q';
  const env = setup(t, { name });
  const transcript = path.join(env.base, 'tr\u007fan\u009bscript.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  const json = env.run(['--session', ID, '--transcript', transcript]);
  const line = env.run(['--session', ID, '--transcript', transcript, '--line']);
  assert.match(json.stdout, CLEAN);
  assert.match(line.stdout, CLEAN);
  assert.equal(json.json.session.cwd, path.join(env.base, 'p]52;c;eA==[2Jq'));
  assert.equal(json.json.session.transcript, path.join(env.base, 'transcript.jsonl'));
  assert.doesNotMatch(json.stdout, /[\u202e\u200f\u200b\ufeff]|\u{E0041}/u);
  const deep = path.join(env.base, 'd'.repeat(100), 'e'.repeat(100), 'f'.repeat(100));
  mkdirSync(deep, { recursive: true });
  assert.ok(deep.length > 300);
  assert.equal(env.run([], { cwd: deep }).json.session.cwd, deep, 'a path is cut at 1024, not at a name`s 100');
});

test('a warm cache answers a 60 MB transcript fast, and a cold one stops gh at the deadline', (t) => {
  const env = withWorktree(t, { gh: { delay: 10_000 } });
  const transcript = path.join(env.base, 'big.jsonl');
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(30_000) } });
  const lines = [];
  for (let i = 0; i < 2000; i += 1) {
    lines.push(filler);
    lines.push(JSON.stringify({ type: 'assistant', message: { id: `m${i}`, model: 'claude-opus-5-5', usage: { input_tokens: 1, cache_read_input_tokens: 30_000 + i * 50, cache_creation_input_tokens: 100, output_tokens: 10 } } }));
  }
  writeFileSync(transcript, `${lines.join('\n')}\n`);
  assert.ok(statSync(transcript).size >= 60 * 1000 * 1000);
  fakeGh(path.join(env.base, 'bin'), { log: env.log, answer: '[]' });
  const baseline = env.run(['--session', 'baseline-1', '--transcript', transcript, '--deadline-ms', '200']);
  fakeGh(path.join(env.base, 'bin'), { log: env.log, delay: 10_000, trap: true });
  const cold = env.run(['--session', ID, '--transcript', transcript, '--deadline-ms', '200']);
  assert.equal(cold.status, 0);
  assert.ok(cold.ms < baseline.ms + 200 + 1500, `with a cold merged-heads cache gh is stopped at the deadline: ${cold.ms} ms against ${baseline.ms} ms with a fast gh`);
  assert.equal(cold.json.worktrees.mergedNotCleaned, null);
  const cache = path.join(env.projectState(), 'sessions', ID, MERGED_HEADS.name);
  writeFileSync(cache, JSON.stringify({ value: [['feat/x', env.head]], valueAt: Date.now(), attemptAt: Date.now() }));
  const calls = ghCalls(env.log).length;
  const warm = env.run(['--session', ID, '--transcript', transcript]);
  t.diagnostic(`warm snapshot of a 60 MB transcript: ${warm.ms} ms; cold: ${cold.ms} ms; cold with a fast gh: ${baseline.ms} ms`);
  assert.ok(warm.ms < 2000, `${warm.ms} ms`);
  assert.equal(warm.json.handoff.context, 30_000 + 1999 * 50 + 101);
  assert.equal(warm.json.worktrees.mergedNotCleaned, 1);
  assert.equal(ghCalls(env.log).length, calls, 'the warm snapshot started no gh call');
});

test('with a git that never answers, the snapshot still exits 0 in time', { skip: !POSIX }, (t) => {
  const env = setup(t);
  const bin = path.join(env.base, 'hang');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 600\n');
  chmodSync(path.join(bin, 'git'), 0o755);
  const { status, ms, json } = env.run(['--session', ID], { extraEnv: { PATH: `${bin}${path.delimiter}${env.env.PATH}` } });
  assert.equal(status, 0);
  assert.ok(ms < 20_000, `${ms} ms`);
  assert.ok(json.errors.every((name) => SECTIONS.includes(name)));
});

test('a value whose text passes the cap is not stored, but its attempt is, so the window holds', () => {
  const folder = scratch();
  chmodSync(folder, 0o700);
  const options = { folder, name: MERGED_HEADS.name, windowMs: 60_000, cap: 200, isValue: Array.isArray };
  assert.deepEqual(cachedValue({ ...options, refresh: () => ['x'.repeat(500)] }), { value: ['x'.repeat(500)], stale: false });
  const stored = JSON.parse(readFileSync(path.join(folder, MERGED_HEADS.name), 'utf8'));
  assert.deepEqual([stored.value, stored.valueAt, typeof stored.attemptAt], [null, null, 'number']);
  assert.equal(cachedValue({ ...options, refresh: () => assert.fail('inside the window') }), null);
});

test('SessionEnd removes the marker only by stopMarkerPath', (t) => {
  const env = setup(t);
  const long = 'x'.repeat(129);
  for (const id of [ID, long]) writeFileSync(path.join(env.temp, `aidrian-session-length-${id}`), '{}\n');
  const end = path.join(ROOT, 'plugins/aidrian/scripts/hook-session-end.mjs');
  for (const id of [ID, long]) spawnSync(process.execPath, [end], { input: JSON.stringify({ session_id: id, cwd: env.base }), cwd: env.base, env: env.env, encoding: 'utf8' });
  assert.deepEqual(readdirSync(env.temp).filter((name) => name.startsWith('aidrian-session-length-')), [`aidrian-session-length-${long}`]);
});

test('SessionEnd goes on to the session row when the marker cannot be removed', async (t) => {
  const env = setup(t);
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, turnsOf('handoff-cost')[4]);
  const marker = path.join(env.temp, `aidrian-session-length-${ID}`);
  mkdirSync(marker);
  writeFileSync(path.join(marker, 'keep'), 'x');
  const end = path.join(ROOT, 'plugins/aidrian/scripts/hook-session-end.mjs');
  const ended = spawnSync(process.execPath, [end], { input: JSON.stringify({ session_id: ID, cwd: env.dir, transcript_path: transcript, reason: 'exit' }), cwd: env.dir, env: env.env, encoding: 'utf8' });
  assert.equal(ended.status, 0);
  const log = path.join(env.projectState(), 'dispatch-log.jsonl');
  const rows = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  for (const until = Date.now() + 15_000; !rows().some((row) => row.event === 'session') && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(rows().some((row) => row.event === 'session'), 'the session row is written');
  assert.equal(existsSync(path.join(marker, 'keep')), true);
});

test('cachedValue records its attempt before the refresh, and with no folder refreshes nothing', (t) => {
  const folder = scratch();
  chmodSync(folder, 0o700);
  const name = MERGED_HEADS.name;
  const options = { folder, name, windowMs: 60_000, cap: 1024, isValue: Array.isArray };
  let calls = 0;
  const refresh = () => {
    calls += 1;
    assert.equal(typeof JSON.parse(readFileSync(path.join(folder, name), 'utf8')).attemptAt, 'number', 'the attempt is on disk first');
    return null;
  };
  assert.equal(cachedValue({ ...options, refresh }), null);
  assert.equal(cachedValue({ ...options, refresh }), null);
  assert.equal(calls, 1);
  assert.equal(cachedValue({ ...options, folder: null, refresh: () => assert.fail('no folder, no call') }), null);
  assert.deepEqual(cachedValue({ ...options, now: Date.now() + 61_000, refresh: () => ['v'] }), { value: ['v'], stale: false });
  assert.deepEqual(cachedValue({ ...options, now: Date.now() + 62_000, refresh: () => assert.fail('inside the window') }), { value: ['v'], stale: false });
});
