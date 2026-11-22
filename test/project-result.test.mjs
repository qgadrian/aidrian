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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noteStarted } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { cleanText, RESULT_CAP, validateResult } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { DROP_FILE } from '../plugins/aidrian/lib/project-result.mjs';
import { stderrTail } from '../plugins/aidrian/lib/review/base-worktree.mjs';
import { appendRowsAtOnce } from '../plugins/aidrian/lib/jsonl.mjs';
import { LINGER_GRACE } from '../plugins/aidrian/lib/project-linger.mjs';
import { appendToRun, readRun, runFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { DROP_FILE as GUARD_DROP_FILE, resultHoldReason, spentAttempts } from '../plugins/aidrian/lib/project-run-guard.mjs';
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
  assert.deepEqual(late.claude.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args[1]), [STARTED[0].id]);
  // One past issueHours that cannot be stopped is named with the host's own command that stops it by hand.
  const stuck = started(t, { projectRun: { allow: true, unverifiedHosts: true, issueHours: 2 } });
  const failing = (command, args, options) => (args[0] === 'stop' ? { status: 1, stdout: '', stderr: 'no' } : stuck.claude.run(command, args, options));
  assert.deepEqual(stuck.cmd(['wait', 'launch', '--max-wait', '0'], { now: later, spawn: failing }).out, [`overdue ENG-1 attempt 1: a session of it, ${STARTED[0].id}, could not be stopped; \`claude stop ${STARTED[0].id}\` stops it`, 'running ENG-1']);

  const settled = started(t);
  settled.result({ status: 'blocked', stop: 'no token' });
  assert.deepEqual(settled.cmd(['wait', 'launch', '--max-wait', '0']).out, ['result ENG-1 blocked -> parked blocked', 'lingering ENG-1 attempt 1']);
  assert.match(settled.cmd(['wait', 'launch', '--max-wait', '9999']).err.at(-1), /takes --max-wait as whole seconds from 0 to 540/u);
});

// The second session of ENG-1's chain: a continuation of the session the run started, with the start record its
// handoff wrote, which the fixture's host lists working while it lists the first one ended.
const NEXT = { id: 'beef0001', session: 'beef0001-0000-4000-8000-00000000be01' };
function chainOn(fx) {
  const brief = path.join(fx.state, 'handoffs', '2026-11-17-eng-1.md');
  mkdirSync(path.dirname(brief), { recursive: true, mode: 0o700 });
  writeFileSync(brief, '# Handoff\n');
  noteStarted(fx.store, CHILD, { sha256: 'a'.repeat(64), slug: 'eng-1', brief, chain: 1, id: NEXT.id, session: NEXT.session, name: null, cwd: fx.dir });
  fx.claude.sessions.push({ id: NEXT.id, sessionId: NEXT.session, name: 'eng-1', kind: 'background', cwd: fx.dir });
  fx.claude.states[CHILD] = 'done';
}

// A line about a session the run could not stop names that session, the chain's member that still runs, and its
// host's stop command: never the session the start held, which the host lists ended.
test('a chain whose second session cannot be stopped is named by that session, overdue and lingered alike', (t) => {
  const later = Date.now() + 3 * 60 * 60 * 1000;
  const stuck = `a session of it, ${NEXT.id}, could not be stopped; \`claude stop ${NEXT.id}\` stops it`;
  const overdue = started(t, { projectRun: { allow: true, unverifiedHosts: true, issueHours: 2 } });
  chainOn(overdue);
  const failing = (fx) => (command, args, options) => (args[0] === 'stop' ? { status: 1, stdout: '', stderr: 'no' } : fx.claude.run(command, args, options));
  assert.deepEqual(overdue.cmd(['wait', 'launch', '--max-wait', '0'], { now: later, spawn: failing(overdue) }).out, [`overdue ENG-1 attempt 1: ${stuck}`, 'running ENG-1']);

  const settled = started(t);
  chainOn(settled);
  markUnattended(NEXT.session, { root: settled.dir, env: settled.env, tags: { project: 'launch', issue: 'ENG-1' } });
  assert.equal(settled.result({ status: 'failed', stop: 'gave up' }, NEXT.session).exitCode, 0);
  assert.deepEqual(settled.cmd(['wait', 'launch', '--max-wait', '0']).out, ['result ENG-1 failed -> open', 'lingering ENG-1 attempt 1']);
  const past = Date.now() + LINGER_GRACE + 60_000;
  assert.deepEqual(settled.cmd(['wait', 'launch', '--max-wait', '0'], { now: past, spawn: failing(settled) }).out, [`lingered ENG-1 attempt 1: a session of it, ${NEXT.id}, ran on after its issue settled and could not be stopped; \`claude stop ${NEXT.id}\` stops it`, 'lingering ENG-1 attempt 1']);
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

// The `resume` and `recheck` rows the driver's re-check wrote (lib/project-recheck.mjs), but their times.
const rechecks = (fx) => fx.rows().filter((row) => row.event === 'recheck' || (row.event === 'resume' && row.via === 'recheck')).map(({ at: _at, ...row }) => row);
const ENV_CHECKS = ['commit', 'host', 'trust', 'access'];
// A read the token may not make, as the GitHub adapter names it, which fails the re-check's `token-reads`.
const NO_ISSUES = [{ read: 'reactions', what: 'read the reactions on a pull request', permission: 'Issues: Read-only', why: 'the forge answered 403' }];

test('an environment result halts the run with its stop, the driver\'s re-check lifts it once its checks pass, and the issue goes on as after failed', (t) => {
  const fx = started(t);
  assert.match(fx.result({ status: 'environment', stop: null }).err.join('\n'), /an environment result names in "stop" what failed/u);
  const stop = 'git push: could not read Username for github.com, token ghp_abcdefghijklmnopqrstuvwxyz0123';
  const cause = 'ENG-1 attempt 1 found its environment broken: git push: could not read Username for `github.com`, token [redacted]';
  assert.deepEqual(fx.recorded({ status: 'environment', stop }).out, ['result ENG-1 environment -> open', `recheck lifted the halt: ${cause}; ok ${ENV_CHECKS.join(', ')}`]);
  assert.deepEqual(fx.rows().filter((row) => row.event === 'result').map((row) => row.halt), [cause]);
  assert.deepEqual(rechecks(fx), [{ event: 'resume', session: DRIVER, kind: 'environment', key: 'ENG-1', attempt: 1, via: 'recheck', checks: ENV_CHECKS }]);
  assert.equal(spentAttempts(readRun(fx.state, 'launch'), 'ENG-1'), 1);
  fx.claude.states[CHILD] = 'done';
  assert.doesNotMatch(fx.cmd(['next', 'launch']).out[0], /^halted/u);
  // The wait sweeps ended attempts, but keeps this one's folder while its issue is open: its clone may hold unpushed work.
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out.filter((line) => line.startsWith('recheck ')), [], 'a halt row is re-checked once');
  assert.ok(existsSync(path.join(runFolder(fx.state, 'launch'), 'attempts', 'ENG-1.1')), 'the environment attempt keeps its folder');
  const next = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(next.exitCode, 0, next.err.join('\n'));
  assert.ok(next.out.includes('started ENG-1 attempt 2 session c0ffee02'), next.out.join('\n'));
});

test('an environment halt whose re-check fails stays for a person, and is re-checked once', (t) => {
  const fx = started(t);
  fx.forge.tokenReads = () => NO_ISSUES;
  const kept = fx.recorded({ status: 'environment', stop: 'gh api repos/acme/widgets/issues/12/reactions: HTTP 403' });
  assert.equal(kept.out[0], 'result ENG-1 environment -> open');
  assert.match(kept.out[1], /^recheck kept the halt: ENG-1 attempt 1 found its environment broken/u);
  assert.match(kept.out[2], /^blocker token-reads: the forge token from the forge CLI's login for github\.com cannot read the reactions on a pull request .*Issues: Read-only/u, kept.out.join('\n'));
  const [row] = rechecks(fx);
  assert.deepEqual([row.event, row.pass, row.kind, row.key, row.checks, row.failed.length], ['recheck', false, 'environment', 'ENG-1', ENV_CHECKS, 1]);
  fx.claude.states[CHILD] = 'done';
  assert.match(fx.cmd(['next', 'launch']).out[0], /^halted ENG-1 attempt 1 found its environment broken/u);
  // Fixed now, but the halt row was re-checked once: neither wait nor start re-checks it again.
  fx.forge.tokenReads = () => [];
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out.filter((line) => line.startsWith('recheck ')), []);
  assert.match(fx.cmd(['start', 'launch', 'ENG-1']).out[0], /^halt the run is halted/u);
  assert.equal(rechecks(fx).length, 1);
  const resumed = fx.cmd(['resume', 'launch'], { session: OTHER });
  assert.equal(resumed.exitCode, 0, resumed.err.join('\n'));
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
});

test('a second environment halt of the same issue after a self-lift stays for a person, and spends its attempts as before', (t) => {
  const fx = started(t);
  for (let n = 0; n < 3; n += 1) {
    const session = STARTED[n].session;
    if (n > 0) {
      assert.equal(fx.cmd(['resume', 'launch'], { session: OTHER }).exitCode, 0);
      const again = fx.cmd(['start', 'launch', 'ENG-1']);
      assert.equal(again.exitCode, 0, again.err.join('\n'));
    }
    const expected = n < 2 ? 'result ENG-1 environment -> open' : 'result ENG-1 environment -> parked attempts';
    const recorded = fx.recorded({ status: 'environment', stop: `no network, try ${n + 1}` }, session).out;
    assert.equal(recorded[0], expected);
    assert.match(recorded[1], n === 0 ? /^recheck lifted the halt: ENG-1 attempt 1 /u : new RegExp(`^recheck kept the halt: ENG-1 attempt ${n + 1} `, 'u'));
    if (n > 0) assert.equal(recorded[2], 'the run lifted a halt of ENG-1 of this kind (environment) by itself once, so this one waits on a person');
    fx.claude.states[session] = 'done';
  }
  assert.deepEqual(rechecks(fx).map((row) => [row.event, row.attempt, row.why ?? null]), [['resume', 1, null], ['recheck', 2, 'lifted once'], ['recheck', 3, 'lifted once']]);
  assert.equal(fx.rows().filter((row) => row.event === 'result' && row.halt).length, 3);
  assert.match(fx.cmd(['next', 'launch']).out[0], /^halted ENG-1 attempt 3 found its environment broken: no network, try 3/u);
  // The attempt folder of each environment attempt stays.
  fx.cmd(['wait', 'launch', '--max-wait', '0']);
  for (const n of [1, 2, 3]) assert.ok(existsSync(path.join(runFolder(fx.state, 'launch'), 'attempts', `ENG-1.${n}`)), `ENG-1.${n} keeps its folder`);
  const report = JSON.parse(fx.cmd(['report', 'launch', '--json']).out[0]);
  const owed = report.owed.find((each) => each.key === 'ENG-1');
  assert.match(owed?.body ?? '', /ENG-1, attempt 3, stopped: its session found its environment broken\./u, JSON.stringify(report).slice(0, 400));
});

test('a halt the preflight cannot check again, as a failed sandbox proof\'s or a usage limit\'s, is never re-checked', (t) => {
  const fx = runFixture(t);
  for (const row of [{ event: 'halt', kind: 'sandbox', cause: 'the start of ENG-1 attempt 1 failed its proof: write /x', key: 'ENG-1', attempt: 1 }, { event: 'halt', cause: 'ENG-1 met a usage limit 25 times', key: 'ENG-1', attempt: 1 }]) {
    appendToRun(fx.state, 'launch', () => ({ rows: [{ ...row, at: new Date().toISOString() }] }));
    assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['idle']);
    assert.match(fx.cmd(['start', 'launch', 'ENG-1']).out[0], /^halt the run is halted/u);
    assert.deepEqual(rechecks(fx), []);
    assert.equal(fx.cmd(['resume', 'launch'], { session: OTHER }).exitCode, 0);
  }
});

test('a result stop has credentials masked', () => {
  const { result } = validateResult({ status: 'failed', stop: 'push to https://bob:hunter2pass@example.test/x failed; Authorization: Bearer abcdefghijklmnop; authorization: Basic eDp5; key AKIAABCDEFGHIJKL' });
  assert.doesNotMatch(result.stop, /hunter2pass|abcdefghijklmnop|eDp5|AKIAABCDEFGHIJKL/u);
  assert.doesNotMatch(stderrTail('fatal: header Authorization: Basic eDp5 refused'), /eDp5/u);
  assert.doesNotMatch(validateResult({ status: 'failed', stop: '{"Authorization": "Basic eDp5"} and Authorization: Digest username="u", response="abc123"' }).result.stop, /eDp5|abc123/u);
  assert.doesNotMatch(stderrTail('{"authorization":"Basic eDp5"}'), /eDp5/u);
  const digest = JSON.stringify({ headers: { Authorization: 'Digest username="u7x", response="r9y"' } });
  assert.doesNotMatch(validateResult({ status: 'failed', stop: digest }).result.stop, /u7x|r9y/u);
  assert.doesNotMatch(stderrTail(digest), /u7x|r9y/u);
  assert.match(stderrTail('Authorization: Basic eDp5\nfatal: the plan failed'), /Authorization: \[redacted\] \| fatal: the plan failed$/u);
  assert.match(result.stop, /\[redacted\]/u);
});

test('a start refuses a halt written after it read the run, under the ledger lock it writes ahead under', (t) => {
  const fx = runFixture(t);
  let halted = false;
  const racing = (command, args, options) => {
    if (!halted) {
      halted = true;
      appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'halt', cause: 'ENG-9 attempt 1 found its environment broken: no network', key: 'ENG-9', attempt: 1, at: new Date().toISOString() }] }));
    }
    return fx.claude.run(command, args, options);
  };
  const start = fx.cmd(['start', 'launch', 'ENG-1'], { spawn: racing });
  assert.ok(halted, 'the host was asked before the write-ahead');
  assert.equal(start.exitCode, 1);
  assert.match(start.out[0], /^halt the run is halted: ENG-9 attempt 1 found its environment broken: no network/u);
  assert.equal(fx.rows().filter((row) => row.event === 'start' || (row.event === 'issue' && row.state === 'running')).length, 0, 'nothing was written ahead');
});

test('appendRowsAtOnce writes every row in one append, after a cut last line', (t) => {
  const folder = mkdtempSync(path.join(tmpdir(), 'rows-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'ledger.jsonl');
  writeFileSync(file, '{"cut":');
  appendRowsAtOnce(file, [{ a: 1 }, { b: 2 }]);
  assert.equal(readFileSync(file, 'utf8'), '{"cut":\n{"a":1}\n{"b":2}\n');
});
