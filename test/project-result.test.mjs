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
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noteStarted } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { cleanText, RESULT_CAP, validateResult, WAIT_MARGIN } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { DROP_FILE } from '../plugins/aidrian/lib/project-result.mjs';
import { stderrTail } from '../plugins/aidrian/lib/review/base-worktree.mjs';
import { appendRowsAtOnce } from '../plugins/aidrian/lib/jsonl.mjs';
import { LINGER_GRACE } from '../plugins/aidrian/lib/project-linger.mjs';
import { appendToRun, readRun, runFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { recheckHalt } from '../plugins/aidrian/lib/project-recheck.mjs';
import { DROP_FILE as GUARD_DROP_FILE, resultHoldReason, spentAttempts } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { decidedFixture, DRIVER, OTHER, runFixture, STARTED } from './project-start-fixture.mjs';

const CHILD = STARTED[0].session;

// A run whose ENG-1 started, with a result file writer; `make` makes the run, runFixture by default.
function started(t, options, make = runFixture) {
  const fx = make(t, options);
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
  // `wait` is the wait's --max-wait, 0 s by default.
  const recorded = (value, session = CHILD, wait = '0') => {
    const handed = result(value, session);
    if (handed.exitCode !== 0) return handed;
    const waited = fx.cmd(['wait', 'launch', '--max-wait', wait]);
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

test('a result that parks the issue records the head the forge shows its branch at, which a later run resumes from; one that opens it again records none', (t) => {
  const head = 'b'.repeat(40);
  const parked = started(t);
  const own = parked.forge.branchHead;
  parked.forge.branchHead = (repo, branch, options) => (branch === 'feat/eng-1-export' ? head : own(repo, branch, options));
  assert.deepEqual(parked.recorded({ status: 'blocked', stop: 'no access' }).out, ['result ENG-1 blocked -> parked blocked']);
  assert.equal(parked.rows().find((row) => row.event === 'result').head, head);
  // A forge that shows no such branch, or cannot answer, records no head, and the result is taken in all the same.
  const unpushed = started(t);
  unpushed.forge.branchHead = () => {
    throw new Error('gh: HTTP 502');
  };
  assert.deepEqual(unpushed.recorded({ status: 'blocked', stop: 'no access' }).out, ['result ENG-1 blocked -> parked blocked']);
  assert.equal(unpushed.rows().find((row) => row.event === 'result').head, null, 'a null head: no later run falls back to a pull request');
  // An open pull request's result records the head its check read: a second read that differs, or fails, changes nothing.
  for (const later of [() => 'c'.repeat(40), () => {
    throw new Error('gh: HTTP 502');
  }]) {
    const open = started(t);
    const own = open.forge.change;
    open.forge.change = (ref, fields, options) => (ref === '12' ? { state: 'OPEN', headRefName: 'feat/eng-1-export', headRefOid: head, url: 'https://github.com/acme/widgets/pull/12', isCrossRepository: false } : own(ref, fields, options));
    let reads = 0;
    open.forge.branchHead = (repo, branch, options) => {
      if (branch !== 'feat/eng-1-export') return null;
      reads += 1;
      return reads === 1 ? head : later();
    };
    assert.deepEqual(open.recorded({ status: 'pr_open', pr: 12, stop: 'review' }).out, ['result ENG-1 pr_open -> parked pr-open']);
    assert.equal(open.rows().find((row) => row.event === 'result').head, head);
    assert.equal(reads, 1, 'the branch is read once');
  }
  // A closed pull request still parks the issue as pr-open, but keeps no head, so no later run goes on from its branch.
  const closed = started(t);
  const theirs = closed.forge.change;
  closed.forge.change = (ref, fields, options) => (ref === '12' ? { state: 'CLOSED', headRefName: 'feat/eng-1-export', headRefOid: head, url: 'https://github.com/acme/widgets/pull/12', isCrossRepository: false } : theirs(ref, fields, options));
  closed.forge.branchHead = () => head;
  assert.deepEqual(closed.recorded({ status: 'pr_open', pr: 12, stop: 'review' }).out, ['result ENG-1 pr_open -> parked pr-open']);
  assert.equal(closed.rows().find((row) => row.event === 'result').head, null);
  const failed = started(t);
  failed.forge.branchHead = () => head;
  assert.deepEqual(failed.recorded({ status: 'failed', pr: null, stop: 'flaky' }).out, ['result ENG-1 failed -> open']);
  assert.equal(Object.hasOwn(failed.rows().find((row) => row.event === 'result'), 'head'), false);
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
  // A pr_open result whose pull request merged before the driver took it in is checked as merged is: the issue is done,
  // and the branch, which a merge may have deleted, is never read. One merged elsewhere, or before the attempt, is refused.
  for (const [view, line, why] of [cases[0], cases[3], cases[6]]) {
    const fx = started(t);
    fx.forge.change = () => view;
    fx.forge.branchHead = () => {
      throw new Error('gh: HTTP 404: Branch not found');
    };
    assert.deepEqual(fx.recorded({ status: 'pr_open', pr: 12, stop: 'review' }).out, [line], JSON.stringify(view));
    if (why) {
      assert.equal(fx.rows().find((row) => row.event === 'ended').why, why, JSON.stringify(view));
      continue;
    }
    const result = fx.rows().find((row) => row.event === 'result');
    assert.deepEqual([result.status, result.verified, Object.hasOwn(result, 'head')], ['merged', true, false]);
    const kept = JSON.parse(readFileSync(path.join(runFolder(fx.state, 'launch'), 'results', 'ENG-1.json'), 'utf8'));
    assert.deepEqual([kept.status, kept.reported], ['merged', 'pr_open']);
  }
  // One that merges between the first read, which shows it open, and the park is taken as merged too.
  const racing = started(t);
  const head = 'b'.repeat(40);
  let reads = 0;
  racing.forge.change = () => {
    reads += 1;
    return reads === 1 ? merged({ state: 'OPEN', mergedAt: null, headRefOid: head }) : merged({ headRefOid: head });
  };
  racing.forge.branchHead = () => head;
  assert.deepEqual(racing.recorded({ status: 'pr_open', pr: 12, stop: 'review' }).out, ['result ENG-1 merged -> done']);
  // One that closes in that moment parks with no head, and a second read that fails takes nothing in yet.
  const closing = started(t);
  let seen = 0;
  closing.forge.change = () => {
    seen += 1;
    return merged(seen === 1 ? { state: 'OPEN', mergedAt: null, headRefOid: head } : { state: 'CLOSED', mergedAt: null, headRefOid: head });
  };
  closing.forge.branchHead = () => head;
  assert.deepEqual(closing.recorded({ status: 'pr_open', pr: 12, stop: 'review' }).out, ['result ENG-1 pr_open -> parked pr-open']);
  assert.equal(closing.rows().find((row) => row.event === 'result').head, null);
  const flaky = started(t);
  let tries = 0;
  flaky.forge.change = () => {
    tries += 1;
    if (tries === 1) return merged({ state: 'OPEN', mergedAt: null, headRefOid: head });
    throw new Error('gh: HTTP 502');
  };
  flaky.forge.branchHead = () => head;
  assert.deepEqual(flaky.recorded({ status: 'pr_open', pr: 12, stop: 'review' }).out, ['running ENG-1']);
  assert.equal(flaky.rows().filter((row) => row.event === 'result').length, 0, 'read again on a later wait');
  // A second read the forge answers with no such pull request ends the attempt at once, as the first read's would.
  const gone = started(t);
  const fixture = gone.forge.change;
  let asked = 0;
  gone.forge.change = (ref, fields, options) => {
    asked += 1;
    return asked === 1 ? merged({ state: 'OPEN', mergedAt: null, headRefOid: head }) : fixture(ref, fields, options);
  };
  gone.forge.branchHead = () => head;
  assert.deepEqual(gone.recorded({ status: 'pr_open', pr: 12, stop: 'review' }).out, ['ended ENG-1 bad_result -> open']);
  assert.equal(gone.rows().find((row) => row.event === 'ended').why, 'the forge has no pull request #12 in github.com/acme/widgets');
  // So does the merge check's own read, when the first read showed it merged.
  const vanished = started(t);
  const own = vanished.forge.change;
  let calls = 0;
  vanished.forge.change = (ref, fields, options) => {
    calls += 1;
    return calls === 1 ? merged() : own(ref, fields, options);
  };
  assert.deepEqual(vanished.recorded({ status: 'merged', pr: 12 }).out, ['ended ENG-1 bad_result -> open']);
  assert.equal(vanished.rows().find((row) => row.event === 'ended').why, 'the forge has no pull request #12 in github.com/acme/widgets');
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

test('a result on an issue with a recorded decision that still carries a decision parks as on any other, security included', (t) => {
  const fx = started(t, {}, decidedFixture);
  assert.ok(fx.claude.starts()[0].args.at(-1).includes('a decision the Human recorded on this issue'), 'the grant stood');
  const out = fx.recorded({ status: 'parked', pr: null, decisions: [{ question: 'Hand over identification now?', options: ['hand it over', 'synthetic fixtures'], recommended: 0, class: 'security' }], stop: 'a security decision' });
  assert.deepEqual(out.out, ['result ENG-1 parked -> parked decision-1']);
  assert.equal(fx.run().states.get('ENG-1').state, 'parked');
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

test('wait holds --max-wait as a hard bound under slow reads, and still returns at once on a settle', (t) => {
  const fx = started(t);
  // A clock that moves only when the wait pauses or the host's listing answers, which takes 20 seconds a call.
  const start = Date.now();
  let clock = start;
  const slow = (...args) => {
    clock += 20_000;
    return fx.claude.run(...args);
  };
  // Each read's cost: the time from the end of the last pause, or the start, to the next pause.
  const pauses = [];
  const reads = [];
  let resumed = start;
  const pause = (ms) => {
    pauses.push(ms);
    reads.push(clock - resumed);
    clock += ms;
    resumed = clock;
  };
  const waited = fx.cmd(['wait', 'launch', '--max-wait', '150'], { now: start, clock: () => clock, spawn: slow, pause });
  assert.deepEqual(waited.out, ['running ENG-1']);
  assert.ok(clock - start <= 150_000, `it returned within its budget, at ${(clock - start) / 1000} s`);
  assert.ok(pauses.length > 1, 'it read more than once');
  // It returned, with no read after its last pause, only once the slowest read and the margin no longer fit.
  const slowest = Math.max(...reads);
  assert.ok(slowest >= 20_000, `the reads were slow: ${reads}`);
  assert.equal(clock, resumed, 'no read after the last pause');
  assert.ok(clock - start >= 150_000 - slowest - WAIT_MARGIN, `it used its budget, at ${(clock - start) / 1000} s, reads of ${reads}`);
  // A wait that sees the issue settle returns after its first read, as before.
  fx.result({ status: 'failed', stop: 'x' });
  const from = clock;
  pauses.length = 0;
  const settled = fx.cmd(['wait', 'launch', '--max-wait', '150'], { now: from, clock: () => clock, spawn: slow, pause });
  assert.deepEqual(settled.out.filter((line) => !line.startsWith('lingering ')), ['result ENG-1 failed -> open']);
  assert.deepEqual(pauses, [], 'no pause: it returned on its first read');
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

// The `resume` rows the driver's re-check wrote (lib/project-recheck.mjs), but their times, and any `recheck` row, which
// the re-check never writes.
const rechecks = (fx) => fx.rows().filter((row) => row.event === 'recheck' || (row.event === 'resume' && row.via === 'recheck')).map(({ at: _at, ...row }) => row);
// The checks an environment halt's re-check runs, as their `ok` lines name them, in the fixture, whose forge has no reads.
const ENV_CHECKS = ['repository', 'state', 'commit', 'policy', 'host', 'trust', 'access'];
// The token reads of the GitHub adapter: none refused, one refused, which fails the re-check's `token-reads`, and one
// the forge could not answer.
const READS_OK = { missing: [], unverified: [], unanswered: [] };
const NO_ISSUES = { ...READS_OK, missing: [{ read: 'reactions', what: 'read the reactions on a pull request', permission: 'Issues: Read-only', why: 'the forge answered 403' }] };
const NO_ANSWER = { ...READS_OK, unanswered: ['pulls'] };

test('an environment result halts the run with its stop; wait never re-checks it, and the driver\'s next start of the issue lifts it once its checks pass', (t) => {
  const fx = started(t);
  assert.match(fx.result({ status: 'environment', stop: null }).err.join('\n'), /an environment result names in "stop" what failed/u);
  const stop = 'git push: could not read Username for github.com, token ghp_abcdefghijklmnopqrstuvwxyz0123';
  const cause = 'ENG-1 attempt 1 found its environment broken: git push: could not read Username for `github.com`, token [redacted]';
  assert.deepEqual(fx.recorded({ status: 'environment', stop }, CHILD, '150').out, ['result ENG-1 environment -> open'], 'no wait re-checks a halt');
  assert.deepEqual(fx.rows().filter((row) => row.event === 'result').map((row) => row.halt), [cause]);
  assert.deepEqual(rechecks(fx), []);
  assert.equal(spentAttempts(readRun(fx.state, 'launch'), 'ENG-1'), 1);
  fx.claude.states[CHILD] = 'done';
  assert.match(fx.cmd(['next', 'launch']).out[0], /^halted/u);
  // A start of another issue does not re-check ENG-1's halt.
  assert.match(fx.cmd(['start', 'launch', 'ENG-4']).out[0], /^halt the run is halted/u);
  assert.deepEqual(rechecks(fx), []);
  // The start that lifts the halt launches nothing; the next one starts the issue afresh.
  const starts = fx.claude.starts().length;
  const lifting = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.deepEqual([lifting.exitCode, lifting.out], [0, [`recheck lifted the halt: ${cause}; ok ${ENV_CHECKS.join(', ')}`, 'lifted the environment halt of ENG-1; start it again']]);
  assert.equal(fx.claude.starts().length, starts, 'no session started');
  assert.deepEqual(rechecks(fx), [{ event: 'resume', session: DRIVER, kind: 'environment', key: 'ENG-1', attempt: 1, via: 'recheck', checks: ENV_CHECKS }]);
  const next = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(next.exitCode, 0, next.err.join('\n'));
  assert.ok(next.out.includes('started ENG-1 attempt 2 session c0ffee02'), next.out.join('\n'));
  assert.ok(existsSync(path.join(runFolder(fx.state, 'launch'), 'attempts', 'ENG-1.1')), 'the environment attempt keeps its folder');
});

test('an environment halt whose re-check does not pass, a refused read and a read the forge could not answer alike, stays and writes nothing; the next start lifts it once its checks pass', (t) => {
  const fx = started(t);
  fx.forge.tokenReads = () => NO_ISSUES;
  assert.equal(fx.recorded({ status: 'environment', stop: 'gh api repos/acme/widgets/issues/12/reactions: HTTP 403' }).out[0], 'result ENG-1 environment -> open');
  fx.claude.states[CHILD] = 'done';
  const kept = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.match(kept.out[0], /^halt the run is halted: ENG-1 attempt 1 found its environment broken/u);
  assert.ok(kept.out.some((line) => line.startsWith('recheck kept the halt: ENG-1 attempt 1 ')), kept.out.join('\n'));
  assert.ok(kept.out.some((line) => /^blocker token-reads: the forge token from the forge CLI's login for github\.com cannot read the reactions on a pull request .*Issues: Read-only/u.test(line)), kept.out.join('\n'));
  assert.deepEqual(rechecks(fx), [], 'no row');
  // A forge that could not answer a read keeps the halt the same way, and says so in one line naming no permission.
  fx.forge.tokenReads = () => NO_ANSWER;
  const unanswered = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.match(unanswered.out[0], /^halt the run is halted/u);
  assert.deepEqual(unanswered.out.filter((line) => line.includes('token-reads')), ['retry token-reads: the forge could not answer the pulls read of github.com/acme/widgets with the forge token from the forge CLI\'s login for github.com; start again'], unanswered.out.join('\n'));
  // A refused read beside an unanswered one is still the refusal.
  fx.forge.tokenReads = () => ({ ...NO_ISSUES, unanswered: ['actions'] });
  assert.ok(fx.cmd(['start', 'launch', 'ENG-1']).out.some((line) => line.startsWith('blocker token-reads: ')));
  assert.deepEqual(rechecks(fx), []);
  // Fixed now: the next start re-checks, lifts the halt, and starts the issue.
  fx.forge.tokenReads = () => READS_OK;
  const lifted = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(lifted.exitCode, 0, lifted.out.join('\n'));
  assert.ok(lifted.out.some((line) => line.startsWith('recheck lifted the halt: ENG-1 attempt 1 ')), lifted.out.join('\n'));
  assert.deepEqual(rechecks(fx).map((row) => [row.event, row.via]), [['resume', 'recheck']]);
});

test('the re-check probes the repository the run pinned: an origin moved off it refuses the lift before any probe', (t) => {
  const fx = started(t);
  let reads = 0;
  fx.forge.tokenReads = () => ((reads += 1), READS_OK);
  fx.recorded({ status: 'environment', stop: 'gh pr checks 12: HTTP 403' });
  fx.claude.states[CHILD] = 'done';
  fx.git('remote', 'set-url', 'origin', 'https://github.com/other/widgets.git');
  const before = fx.forge.calls.length;
  const kept = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.ok(kept.out.some((line) => /^blocker repository: .*github\.com\/acme\/widgets/u.test(line)), kept.out.join('\n'));
  assert.equal(reads, 0, 'no token read');
  assert.deepEqual(fx.forge.calls.slice(before).filter(([name]) => ['authToken', 'tokenCanPush'].includes(name)), [], 'no token read, no push probe');
  assert.deepEqual(rechecks(fx), [], 'no row');
});

test('a forge that could not answer a read: a start with no halt exits 75 to be tried again, and a refused read beside it halts', (t) => {
  const fx = runFixture(t);
  fx.forge.tokenReads = () => NO_ANSWER;
  const limited = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(limited.exitCode, 75, limited.out.join('\n'));
  fx.forge.tokenReads = () => ({ ...NO_ISSUES, unanswered: ['pulls'] });
  const denied = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(denied.exitCode, 1);
  assert.match(denied.out[0], /^halt the forge token from the forge CLI's login for github\.com cannot read the reactions on a pull request/u);
  assert.deepEqual(fx.claude.starts(), []);
});

test('under the ledger lock, a self-lift is written only while the run is live and custody rests where the caller read it, and says when it is not', (t) => {
  const fx = runFixture(t);
  appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'result', key: 'ENG-1', attempt: 1, status: 'environment', halt: 'ENG-1 attempt 1 found its environment broken: no network', at: new Date().toISOString() }] }));
  const lift = (custodian) => recheckHalt({ state: fx.state, run: 'launch', found: readRun(fx.state, 'launch'), session: DRIVER, key: 'ENG-1', custodian, recheck: () => ['ok host', 'ok access'] });
  const changed = ['the checks passed, but the run changed meanwhile: its halt was lifted, it ended, or custody moved'];
  assert.deepEqual(lift(OTHER), { lifted: false, lines: changed }, 'custody rests with another session');
  appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'end', session: DRIVER, at: new Date().toISOString() }] }));
  assert.deepEqual(lift(DRIVER), { lifted: false, lines: changed }, 'the run ended');
  assert.deepEqual(rechecks(fx), []);
});

test('a resume row the re-check cannot write is its own line, and a ledger another process holds exits 75 to be tried again', (t) => {
  const fx = started(t);
  fx.recorded({ status: 'environment', stop: 'no network' });
  fx.claude.states[CHILD] = 'done';
  const folder = runFolder(fx.state, 'launch');
  // Another process takes the ledger's lock while the re-check probes the forge.
  fx.forge.tokenReads = () => (writeFileSync(path.join(folder, 'ledger.jsonl.lock.99'), JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'other' })), READS_OK);
  const locked = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(locked.exitCode, 75, locked.out.join('\n'));
  assert.match(locked.out[0], /^retry: .*locked by another process/u);
  writeFileSync(path.join(folder, 'ledger.jsonl.lock.99.released'), '');
  assert.deepEqual(rechecks(fx), []);
  // A run whose files go away under the re-check: the checks passed, and the row could not be written.
  const found = readRun(fx.state, 'launch');
  const gone = recheckHalt({ state: fx.state, run: 'launch', found, session: DRIVER, key: 'ENG-1', recheck: () => (rmSync(path.join(folder, 'snapshot.json')), ['ok host']) });
  assert.equal(gone.lifted, false);
  assert.match(gone.lines.at(-1), /^the checks passed, but the resume row could not be written: no run launch in /u);
});

test('a second environment halt of the same issue after a self-lift stays for a person, and spends its attempts as before', (t) => {
  const fx = started(t);
  for (let n = 0; n < 3; n += 1) {
    const session = STARTED[n].session;
    if (n === 2) assert.equal(fx.cmd(['resume', 'launch'], { session: OTHER }).exitCode, 0);
    if (n > 0) {
      if (n === 1) assert.ok(fx.cmd(['start', 'launch', 'ENG-1']).out[0].startsWith('recheck lifted the halt: ENG-1 attempt 1 '));
      const again = fx.cmd(['start', 'launch', 'ENG-1']);
      assert.equal(again.exitCode, 0, again.err.join('\n'));
    }
    const expected = n < 2 ? 'result ENG-1 environment -> open' : 'result ENG-1 environment -> parked attempts';
    assert.deepEqual(fx.recorded({ status: 'environment', stop: `no network, try ${n + 1}` }, session).out, [expected]);
    fx.claude.states[session] = 'done';
    if (n === 1) {
      const kept = fx.cmd(['start', 'launch', 'ENG-1']);
      assert.match(kept.out[0], /^halt the run is halted: ENG-1 attempt 2 /u);
      assert.ok(kept.out.includes('the run lifted a halt of ENG-1 of this kind (environment) by itself once, so this one waits on a person'), kept.out.join('\n'));
    }
  }
  assert.deepEqual(rechecks(fx).map((row) => [row.event, row.attempt]), [['resume', 1]], 'one lift, and no row for the halt it kept');
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
