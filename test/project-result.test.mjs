// `aidrian project result` and `wait` (lib/project-run-gate.mjs), and the Stop hook's result hold
// (lib/project-run-guard.mjs resultHoldReason): only the session the run started for an issue, or a continuation of it,
// hands the issue's result over, in its attempt's drop folder, since every start is confined, and the driver's `wait`
// takes it in; `merged` is kept only when the forge shows the pull request merged from the issue's branch into the
// default branch of the pinned repository after the attempt started, and any other merge ends the attempt bad_result;
// the result's text is cleaned and capped; an issue's session that stops with no result is sent back once; and `wait`
// records a session that ended with no result or ran past projectRun.issueHours. The fixture is
// test/project-start-fixture.mjs.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { noteStarted } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { cleanText, RESULT_CAP, validateResult } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { DROP_FILE } from '../plugins/aidrian/lib/project-result.mjs';
import { appendToRun, runFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { DROP_FILE as GUARD_DROP_FILE, resultHoldReason } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { DRIVER, OTHER, runFixture, STARTED } from './project-start-fixture.mjs';

const CHILD = STARTED[0].session;

// A run whose ENG-1 started, with a result file writer.
function started(t, options) {
  const fx = runFixture(t, options);
  const start = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(start.exitCode, 0, start.err.join('\n'));
  const results = path.join(fx.root, 'results');
  mkdirSync(results);
  let n = 0;
  const file = (value) => {
    n += 1;
    const target = path.join(results, `r${n}.json`);
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
    return target;
  };
  const result = (value, session = CHILD, more) => fx.cmd(['result', 'launch', 'ENG-1', '--file', file(value)], { session, ...more });
  // A result handed over, then the driver's wait that takes it in: the wait's lines but `idle`, and but the `lingering`
  // line of the session the fixture's host still lists working after it handed its result over (project-linger.mjs).
  const recorded = (value, session = CHILD) => {
    const handed = result(value, session);
    if (handed.exitCode !== 0) return handed;
    const waited = fx.cmd(['wait', 'launch', '--max-wait', '0']);
    return { ...waited, out: waited.out.filter((line) => line !== 'idle' && !line.startsWith('lingering ')) };
  };
  return { ...fx, file, result, recorded };
}

const merged = (more = {}) => ({ state: 'MERGED', mergedAt: new Date(Date.now() + 60_000).toISOString(), headRefName: 'feat/eng-1-export', baseRefName: 'main', url: 'https://github.com/acme/widgets/pull/12', isCrossRepository: false, ...more });

test('only the session the run started for the issue records its result, and only while it runs', (t) => {
  const fx = started(t);
  const failed = { status: 'failed', pr: null, stop: 'the tests cannot run here' };
  assert.match(fx.result(failed, DRIVER).err[0], /only the session the run started for the issue ENG-1, c0ffee01-0000-4000-8000-00000000c001, or a continuation of it, records its result/u);
  assert.match(fx.result(failed, OTHER).err[0], /only the session the run started/u);
  const ok = fx.recorded(failed);
  assert.deepEqual(ok, { exitCode: 0, out: ['result ENG-1 failed -> open'], err: [] });
  // The last rows of the result, before the `linger` row of its session, which the host still lists working.
  const [result, issue, linger] = fx.rows().slice(-3);
  assert.deepEqual([result.event, result.status, result.session, result.attempt, result.via, issue.state, linger.event], ['result', 'failed', CHILD, 1, 'drop', 'open', 'linger']);
  assert.match(fx.result(failed).err[0], /the issue ENG-1 is not running in the run launch, so it has no result to record/u, 'a second result');
});

test('a start row with no drop folder takes no result: every start is confined, so no gate wrote it', (t) => {
  const fx = started(t);
  const start = fx.rows().find((row) => row.event === 'start' && row.outcome === 'started');
  const { drop: _drop, ...bare } = start;
  appendToRun(fx.state, 'launch', () => ({ rows: [{ ...bare, at: new Date().toISOString() }] }));
  const refused = fx.result({ status: 'failed', pr: null, stop: 'x' });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.err[0], /the start of ENG-1 names no drop folder to hand the result over to, and every start of a project run is confined/u);
  assert.equal(fx.rows().filter((row) => row.event === 'result').length, 0, 'nothing recorded in the ledger');
  assert.ok(!existsSync(path.join(runFolder(fx.state, 'launch'), 'results', 'ENG-1.json')), 'no results file');
});

test('the stop hook spells the drop file as the result module does', () => {
  assert.equal(GUARD_DROP_FILE, DROP_FILE);
});

test('a continuation of the issue\'s session records the result; a session of the chain whose mark names another issue does not', (t) => {
  const fx = started(t);
  const brief = path.join(fx.state, 'handoffs', '2026-11-17-eng-1.md');
  mkdirSync(path.dirname(brief), { recursive: true, mode: 0o700 });
  writeFileSync(brief, '# Handoff\n');
  const CONT = 'beef0001-0000-4000-8000-00000000be01';
  noteStarted(fx.store, CHILD, { sha256: 'a'.repeat(64), slug: 'eng-1', brief, chain: 1, id: 'beef0001', session: CONT, name: null, cwd: fx.dir });
  markUnattended(CONT, { root: fx.dir, env: fx.env, tags: { project: 'launch', issue: 'ENG-4' } });
  assert.match(fx.result({ status: 'blocked', stop: 'no access' }, CONT).err[0], /this session's unattended mark names the issue ENG-4 of the run launch, not the issue ENG-1/u);
  markUnattended(CONT, { root: fx.dir, env: fx.env, tags: { project: 'launch', issue: 'ENG-1' } });
  assert.deepEqual(fx.recorded({ status: 'blocked', stop: 'no access' }, CONT).out, ['result ENG-1 blocked -> parked blocked']);
});

test('merged is kept only when the forge shows the pull request merged from the issue\'s branch into the default branch, after the attempt started', (t) => {
  const ended = 'ended ENG-1 bad_result -> open';
  const cases = [
    [merged(), 'result ENG-1 merged -> done', null],
    [merged({ state: 'OPEN', mergedAt: null }), ended, 'the forge says pull request #12 is open'],
    [merged({ headRefName: 'feat/other' }), ended, 'pull request #12 is not from the issue\'s branch feat/eng-1-export'],
    [merged({ baseRefName: 'release' }), ended, 'pull request #12 merged into "release", not the default branch main'],
    [merged({ isCrossRepository: true }), ended, 'pull request #12 is not from the issue\'s branch feat/eng-1-export'],
    [merged({ url: 'https://github.com/evil/widgets/pull/12' }), ended, 'pull request #12 is not in github.com/acme/widgets'],
    [merged({ mergedAt: '2020-01-01T00:00:00Z' }), ended, 'pull request #12 merged before this attempt started'],
  ];
  for (const [view, line, why] of cases) {
    const fx = started(t);
    fx.forge.change = (ref, fields, options) => {
      fx.forge.calls.push(['change', ref, fields, options]);
      return view;
    };
    assert.deepEqual(fx.recorded({ status: 'merged', pr: 12 }).out, [line], JSON.stringify(view));
    const change = fx.forge.calls.find(([kind]) => kind === 'change');
    assert.deepEqual(change[3], { repo: 'github.com/acme/widgets' }, 'the forge call names the pinned repository');
    if (why) assert.equal(fx.rows().find((row) => row.event === 'ended').why, why, JSON.stringify(view));
    else assert.equal(JSON.parse(readFileSync(path.join(runFolder(fx.state, 'launch'), 'results', 'ENG-1.json'), 'utf8')).status, 'merged');
  }
  const failing = started(t);
  assert.deepEqual(failing.recorded({ status: 'merged', pr: 12 }).out, ['ended ENG-1 bad_result -> open']);
  assert.equal(failing.rows().find((row) => row.event === 'ended').why, 'the forge has no pull request #12 in github.com/acme/widgets');
  const none = started(t);
  assert.deepEqual(none.recorded({ status: 'merged', pr: null }).out, ['ended ENG-1 bad_result -> open']);
  assert.equal(none.rows().find((row) => row.event === 'ended').why, 'the result names no pull request');
});

test('the result\'s text is cleaned of controls, bidirectional and zero-width characters, links, images, HTML, and mentions, and capped', (t) => {
  assert.equal(cleanText('Ship [it](https://evil.example/x) now ![img](https://x/y.png) <b>bold</b> @admin see https://evil.example‮​\u0007 www.x.com', 300), 'Ship it now bold admin see');
  assert.equal(cleanText('x'.repeat(500), 300).length, 300);
  const fx = started(t);
  const out = fx.recorded({
    status: 'parked',
    decisions: [{ question: 'Which format? [docs](https://evil.example) @team', options: ['CSV <script>x</script>', 'JSON'], recommended: 1, class: 'product', extra: 'dropped' }],
    stop: '‮Waiting on a decision',
    title: 'not kept',
  });
  assert.deepEqual(out.out, ['result ENG-1 parked -> parked decision-1']);
  const kept = JSON.parse(readFileSync(path.join(runFolder(fx.state, 'launch'), 'results', 'ENG-1.json'), 'utf8'));
  assert.deepEqual(kept.decisions, [{ question: 'Which format? docs team', options: ['CSV x', 'JSON'], recommended: 1, class: 'product' }]);
  assert.equal(kept.stop, 'Waiting on a decision');
  assert.equal(kept.title, undefined);
  assert.deepEqual([kept.run, kept.key, kept.attempt, kept.session], ['launch', 'ENG-1', 1, CHILD]);
});

test('a result of a wrong shape, too large, not JSON, or behind a symlink is refused, and records nothing', (t) => {
  const fx = started(t);
  assert.deepEqual(validateResult({ status: 'parked', decisions: [] }).problems, ['a parked result names the decisions it waits on']);
  const bad = validateResult({ status: 'done', pr: -1, decisions: [{ question: '', options: ['one'], recommended: 3, class: 'whim' }], stop: 7 });
  assert.equal(bad.result, null);
  assert.equal(bad.problems.length, 7);
  assert.match(fx.result({ status: 'done' }).err.join('\n'), /"status" "done" is not one of merged, pr_open, parked, blocked, failed/u);
  assert.match(fx.result(`{"status":"failed","pad":"${'x'.repeat(RESULT_CAP)}"}`).err[0], /over the 65536 it may hold/u);
  assert.match(fx.result('{ nope').err[0], /is not JSON/u);
  const real = fx.file({ status: 'failed' });
  const link = path.join(fx.root, 'link.json');
  symlinkSync(real, link);
  assert.match(fx.cmd(['result', 'launch', 'ENG-1', '--file', link], { session: CHILD }).err[0], /is a symlink/u);
  assert.equal(fx.run().states.get('ENG-1').state, 'running', 'nothing recorded');
});

test('an issue\'s session that stops with no result is sent back once; after its result, or for another session, nothing holds', (t) => {
  const fx = started(t);
  const stop = (session) => resultHoldReason({ session_id: session, stop_hook_active: false }, { home: fx.home, env: fx.env });
  assert.match(stop(CHILD), /^This session works the issue ENG-1 of the project run launch, and it has not recorded the issue's result.*aidrian project result launch ENG-1 --file/u);
  assert.equal(stop(DRIVER), null);
  assert.equal(stop(OTHER), null);
  markUnattended(OTHER, { root: fx.dir, env: fx.env, tags: { project: 'launch', issue: 'ENG-1' } });
  assert.equal(stop(OTHER), null, 'a mark alone, outside the issue\'s chain, holds nothing');
  fx.result({ status: 'failed', stop: 'gave up' });
  assert.equal(stop(CHILD), null);
});

test('wait records an issue whose sessions all ended with no result, and stops and records one past issueHours', (t) => {
  const ended = started(t);
  assert.deepEqual(ended.cmd(['wait', 'launch', '--max-wait', '0']).out, ['running ENG-1']);
  ended.claude.states[CHILD] = 'done';
  assert.deepEqual(ended.cmd(['wait', 'launch', '--max-wait', '0']).out, ['ended ENG-1 no_result -> open', 'idle']);
  assert.match(ended.cmd(['wait', 'launch'], { session: OTHER }).err[0], /this session is not the driver/u);

  const late = started(t, { projectRun: { allow: true, unverifiedHosts: true, issueHours: 2 } });
  const later = Date.now() + 3 * 60 * 60 * 1000;
  assert.deepEqual(late.cmd(['wait', 'launch', '--max-wait', '0'], { now: later }).out, ['ended ENG-1 timeout -> open', 'idle']);
  assert.deepEqual(late.claude.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args[1]), [CHILD]);
  // One past issueHours that cannot be stopped is named with the host's own command that stops it by hand.
  const stuck = started(t, { projectRun: { allow: true, unverifiedHosts: true, issueHours: 2 } });
  const failing = (command, args, options) => (args[0] === 'stop' ? { status: 1, stdout: '', stderr: 'no' } : stuck.claude.run(command, args, options));
  assert.deepEqual(stuck.cmd(['wait', 'launch', '--max-wait', '0'], { now: later, spawn: failing }).out, [`overdue ENG-1 attempt 1: a session of it could not be stopped; \`claude stop ${STARTED[0].id}\` stops it`, 'running ENG-1']);

  const settled = started(t);
  settled.result({ status: 'blocked', stop: 'no token' });
  assert.deepEqual(settled.cmd(['wait', 'launch', '--max-wait', '0']).out, ['result ENG-1 blocked -> parked blocked', 'lingering ENG-1 attempt 1']);
  assert.match(settled.cmd(['wait', 'launch', '--max-wait', '9999']).err.at(-1), /takes --max-wait as whole seconds from 0 to 540/u);
});

test('wait returns as soon as a result arrives while it waits', (t) => {
  const fx = started(t);
  let reads = 0;
  const pause = () => {
    reads += 1;
    if (reads === 1) fx.result({ status: 'failed', stop: 'x' });
  };
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '120'], { pause }).out, ['result ENG-1 failed -> open', 'lingering ENG-1 attempt 1']);
  assert.equal(reads, 1);
});

test('an issue session that handed off is neither held at its stop nor allowed to record; its continuation is both', (t) => {
  const fx = started(t);
  const brief = path.join(fx.state, 'handoffs', '2026-11-17-eng-1.md');
  mkdirSync(path.dirname(brief), { recursive: true, mode: 0o700 });
  writeFileSync(brief, '# Handoff\n');
  const CONT = 'beef0001-0000-4000-8000-00000000be01';
  noteStarted(fx.store, CHILD, { sha256: 'a'.repeat(64), slug: 'eng-1', brief, chain: 1, id: 'beef0001', session: CONT, name: null, cwd: fx.dir });
  markUnattended(CONT, { root: fx.dir, env: fx.env, tags: { project: 'launch', issue: 'ENG-1' } });
  const stop = (session) => resultHoldReason({ session_id: session, stop_hook_active: false }, { home: fx.home, env: fx.env });
  assert.equal(stop(CHILD), null, 'the session that handed off stops on purpose');
  assert.match(stop(CONT), /This session works the issue ENG-1/u);
  assert.match(fx.result({ status: 'failed', stop: 'x' }, CHILD).err[0], /this session handed the issue's work on to a continuation, which records the issue's result/u);
  assert.equal(fx.run().states.get('ENG-1').state, 'running');
  assert.deepEqual(fx.recorded({ status: 'failed', stop: 'x' }, CONT).out, ['result ENG-1 failed -> open']);
});

test('result text loses format and tag characters by category, and every mention marker, however doubled or prefixed', () => {
  const tags = String.fromCodePoint(0xe0041, 0xe0042, 0xe007f);
  assert.equal(cleanText(`hide${tags}me`, 99), 'hideme');
  assert.equal(cleanText('a\u{fe0f}b\u{e0100}c\u{f0000}d\u{10ffff}e\u{2066}f\u{2029}g\th', 99), 'abcdef g h');
  assert.equal(cleanText('ping @@admin and `@team and @@@ops and @<b></b>lead and @​owner', 99), 'ping admin and team and ops and lead and owner', 'a backtick goes too: only a file or host name is kept in one');
  assert.doesNotMatch(cleanText('x@[a](https://e.x)y @-z', 99), /@/u);
});

test('wait records a failed issue session as ended with no result', (t) => {
  const fx = started(t);
  fx.claude.states[CHILD] = 'failed';
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['ended ENG-1 no_result -> open', 'idle']);
});

test('result text loses character references that spell a mention marker, before the mention pass', () => {
  assert.equal(cleanText('ping &#64;admin, &#x40;team, &#X40;ops, &commat;lead, and &#64&#64;owner', 99), 'ping admin, team, ops, lead, and owner');
  assert.equal(cleanText('Tom&Jerry and R&D stay', 99), 'Tom&Jerry and R&D stay');
});
