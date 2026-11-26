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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noteStarted } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { cleanText, mergeRelease, RESULT_CAP, validateResult, WAIT_MARGIN, waitRun } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { DROP_FILE, ingestDrops } from '../plugins/aidrian/lib/project-result.mjs';
import { rereadResult } from '../plugins/aidrian/lib/project-report.mjs';
import { stderrTail } from '../plugins/aidrian/lib/review/base-worktree.mjs';
import { appendRowsAtOnce } from '../plugins/aidrian/lib/jsonl.mjs';
import { detectHost } from '../plugins/aidrian/lib/hosts/index.mjs';
import { LINGER_GRACE, releaseAttempts } from '../plugins/aidrian/lib/project-linger.mjs';
import { appendToRun, HOST_DENIED_MERGE, readRun, runFolder, summaryText } from '../plugins/aidrian/lib/project-run.mjs';
import { CAUSE_CHECKS, ENVIRONMENT_CAUSES, NO_TRUST_RECORD, recheckHalt } from '../plugins/aidrian/lib/project-recheck.mjs';
import { DROP_FILE as GUARD_DROP_FILE, resultHoldReason, spentAttempts } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { decidedFixture, DRIVER, ISSUES, OTHER, runFixture, STARTED } from './project-start-fixture.mjs';

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

// Writes a drop of the running ENG-1 of `fx` as its session could by hand, its stopCause the JSON text `stopCause`.
function dropWith(fx, stopCause) {
  const { drop, attempt } = fx.rows().findLast((row) => row.event === 'start' && row.key === 'ENG-1');
  writeFileSync(path.join(drop, DROP_FILE), `{"run":"launch","key":"ENG-1","attempt":${attempt},"status":"pr_open","pr":12,"stop":"x","stopCause":${stopCause}}`);
}
// The step of `wait` that takes drops in, alone: its lines.
const takeIn = (fx) => ingestDrops({ state: fx.state, run: 'launch', found: fx.run(), forge: fx.forge, now: Date.now() });

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
  // One of the two says the host denied the merge, which its row, its result file, and the summary keep, and no other's do.
  for (const [later, cause] of [[() => 'c'.repeat(40), { stopCause: HOST_DENIED_MERGE }], [() => {
    throw new Error('gh: HTTP 502');
  }, {}]]) {
    const open = started(t);
    const own = open.forge.change;
    open.forge.change = (ref, fields, options) => (ref === '12' ? { state: 'OPEN', headRefName: 'feat/eng-1-export', headRefOid: head, url: 'https://github.com/acme/widgets/pull/12', isCrossRepository: false } : own(ref, fields, options));
    let reads = 0;
    open.forge.branchHead = (repo, branch, options) => {
      if (branch !== 'feat/eng-1-export') return null;
      reads += 1;
      return reads === 1 ? head : later();
    };
    assert.deepEqual(open.recorded({ status: 'pr_open', pr: 12, stop: 'review', ...cause }).out, ['result ENG-1 pr_open -> parked pr-open']);
    const row = open.rows().find((each) => each.event === 'result');
    assert.equal(row.head, head);
    assert.deepEqual([row.status, row.verified, row.stopCause], ['pr_open', false, cause.stopCause]);
    assert.equal(JSON.parse(readFileSync(path.join(runFolder(open.state, 'launch'), 'results', 'ENG-1.json'), 'utf8')).stopCause, cause.stopCause);
    assert.equal(open.rows().some((each) => each.event === 'halt' || each.halt), false, 'the run goes on');
    const denied = /\n## Merges the host denied\n\n[^\n]+#auto-merge-and-ci\)\.\n\n- ENG-1: pull request #12\n/u.test(summaryText('launch', open.run()));
    assert.equal(denied, cause.stopCause !== undefined);
    assert.equal(reads, 1, 'the branch is read once');
  }
  // A closed pull request still parks the issue as pr-open, but keeps no head, so no later run goes on from its branch.
  const closed = started(t);
  const theirs = closed.forge.change;
  closed.forge.change = (ref, fields, options) => (ref === '12' ? { state: 'CLOSED', headRefName: 'feat/eng-1-export', headRefOid: head, url: 'https://github.com/acme/widgets/pull/12', isCrossRepository: false } : theirs(ref, fields, options));
  closed.forge.branchHead = () => head;
  // It waits for no merge either, so a merge the host denied on it keeps its cause in the row alone, out of the summary.
  assert.deepEqual(closed.recorded({ status: 'pr_open', pr: 12, stop: 'review', stopCause: HOST_DENIED_MERGE }).out, ['result ENG-1 pr_open -> parked pr-open']);
  const closedRow = closed.rows().find((row) => row.event === 'result');
  assert.deepEqual([closedRow.head, closedRow.stopCause], [null, HOST_DENIED_MERGE]);
  assert.doesNotMatch(summaryText('launch', closed.run()), /the host denied/u);
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
  // That the host denied the session's merge lifts none of these checks, and a merged result keeps no word of it.
  for (const [view, line, why] of [cases[0], cases[3], cases[6]]) {
    const fx = started(t);
    fx.forge.change = () => view;
    fx.forge.branchHead = () => {
      throw new Error('gh: HTTP 404: Branch not found');
    };
    assert.deepEqual(fx.recorded({ status: 'pr_open', pr: 12, stop: 'review', stopCause: HOST_DENIED_MERGE }).out, [line], JSON.stringify(view));
    if (why) {
      assert.equal(fx.rows().find((row) => row.event === 'ended').why, why, JSON.stringify(view));
      continue;
    }
    const result = fx.rows().find((row) => row.event === 'result');
    assert.deepEqual([result.status, result.verified, Object.hasOwn(result, 'head')], ['merged', true, false]);
    const kept = JSON.parse(readFileSync(path.join(runFolder(fx.state, 'launch'), 'results', 'ENG-1.json'), 'utf8'));
    assert.deepEqual([kept.status, kept.reported], ['merged', 'pr_open']);
    assert.deepEqual([Object.hasOwn(result, 'stopCause'), Object.hasOwn(kept, 'stopCause')], [false, false]);
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
  // A drop the session wrote by itself, with a token as its stopCause, ends the attempt, and no part of it is kept.
  const token = `ghp_${'a1B2'.repeat(9)}`;
  dropWith(flaky, JSON.stringify(token));
  assert.deepEqual(takeIn(flaky), ['ended ENG-1 bad_result -> open']);
  assert.equal(flaky.rows().find((row) => row.event === 'ended').why, STOP_CAUSE_REFUSED);
  assert.equal(JSON.stringify(flaky.rows()).includes(token), false);
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

const STOP_CAUSE_REFUSED = '"stopCause" is not "host_denied_merge"; leave it out for any other stop';

test('a stopCause on another status, or of another value, is refused', () => {
  const named = { decisions: [{ question: 'Which?', options: ['a', 'b'], recommended: 0, class: 'other' }], stop: 'x', pr: 12 };
  for (const status of ['merged', 'parked', 'blocked', 'failed', 'environment']) {
    const { result, problems } = validateResult({ ...named, status, ...(status === 'environment' ? { cause: 'other' } : {}), stopCause: 'host_denied_merge' });
    assert.deepEqual([result, problems], [null, ['"stopCause" is for a pr_open result alone']], status);
  }
  for (const stopCause of ['HOST_DENIED_MERGE', 'guard', '', null, true, 1, ['host_denied_merge'], {}]) {
    const { result, problems } = validateResult({ status: 'pr_open', pr: 12, stop: 'x', stopCause });
    assert.equal(result, null, JSON.stringify(stopCause));
    assert.equal(problems.length, 1);
    assert.equal(problems[0], STOP_CAUSE_REFUSED);
  }
  assert.deepEqual(validateResult({ status: 'pr_open', pr: 12, stop: 'x' }).result, { status: 'pr_open', pr: 12, decisions: [], stop: 'x' });
});

test('an environment result names its cause from the closed list, and no other status carries one', () => {
  const list = 'commit, host, sign_in, push, network, sandbox_refused, other';
  assert.equal(ENVIRONMENT_CAUSES.join(', '), list);
  assert.deepEqual(validateResult({ status: 'environment', stop: 'git push: HTTP 403' }), { result: null, problems: [`an environment result names its "cause", one of ${list}`] });
  for (const cause of ['wifi', 'SIGN_IN', '', null, 7, ['push'], {}]) {
    const { result, problems } = validateResult({ status: 'environment', stop: 'x', cause });
    assert.equal(result, null, JSON.stringify(cause));
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`^"cause" .* is not one of ${list}$`, 'u'));
  }
  for (const cause of ENVIRONMENT_CAUSES) assert.deepEqual(validateResult({ status: 'environment', stop: 'x', cause }), { result: { status: 'environment', pr: null, decisions: [], stop: 'x', cause }, problems: [] }, cause);
  const named = { decisions: [{ question: 'Which?', options: ['a', 'b'], recommended: 0, class: 'other' }], stop: 'x', pr: 12 };
  for (const status of ['merged', 'pr_open', 'parked', 'blocked', 'failed']) assert.deepEqual(validateResult({ ...named, status, cause: 'network' }), { result: null, problems: ['"cause" is for an environment result alone'] }, status);
});

test('the issue session\'s instructions name the cause for the host\'s own denial alone, and ask for no second attempt', () => {
  const skill = path.resolve(import.meta.dirname, '../plugins/aidrian/skills/autopilot/references');
  const phases = readFileSync(path.join(skill, 'phases.md'), 'utf8').replace(/\s+/gu, ' ');
  assert.ok(phases.includes(`"stopCause": "${HOST_DENIED_MERGE}"`));
  assert.match(phases, /host's own permission check denies the merge command, make no second attempt/u);
  assert.match(phases, /Set `stopCause` for that denial alone: not for a guard hook's refusal, the forge's answer, or a stop of `aidrian pr auto-merge`/u);
  assert.ok(readFileSync(path.join(skill, 'entry-task.md'), 'utf8').includes(`| \`stopCause\` | \`"${HOST_DENIED_MERGE}"\` on a \`pr_open\``));
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
  // A value a problem names is one masked scalar: a token is masked before the cut, so none of it comes back, and a
  // value nested too deep for JSON.stringify is a fixed word, never thrown on.
  const token = `ghp_${'a1B2'.repeat(9)}`;
  const [masked] = validateResult({ status: token }).problems;
  assert.match(masked, /^"status" "\[redacted\]" is not one of /u);
  assert.equal(masked.includes('ghp_') || masked.includes('a1B2'), false, masked);
  const deep = JSON.parse(`${'['.repeat(20_000)}${']'.repeat(20_000)}`);
  const decision = { question: 'Which?', options: ['a', 'b'], recommended: 0 };
  assert.match(validateResult({ status: deep }).problems[0], /^"status" a list is not one of /u);
  assert.deepEqual(validateResult({ status: 'failed', pr: deep }).problems, ['"pr" a list is not a pull request number or null']);
  assert.match(validateResult({ status: 'parked', decisions: [{ ...decision, class: deep }] }).problems[0], /^decisions\[0\]\.class a list is not one of /u);
  assert.deepEqual(['nothing', 'an object', '7', 'true', 'null'].map((word, i) => validateResult({ status: [undefined, {}, 7, true, null][i] }).problems[0].split(' is not')[0]),
    ['"status" nothing', '"status" an object', '"status" 7', '"status" true', '"status" null']);
  assert.match(fx.result(`{"status":"failed","pad":"${'x'.repeat(RESULT_CAP)}"}`).err[0], /over the 65536 it may hold/u);
  assert.match(fx.result('{ nope').err[0], /is not JSON/u);
  const real = fx.file({ status: 'failed' });
  const link = path.join(fx.root, 'link.json');
  symlinkSync(real, link);
  assert.match(fx.cmd(['result', 'launch', 'ENG-1', '--file', link], { session: CHILD }).err[0], /is a symlink/u);
  assert.equal(fx.run().states.get('ENG-1').state, 'running', 'nothing recorded');
  // A stopCause nested too deep for JSON.stringify, in a drop the session wrote by itself: refused, and the wait goes on.
  dropWith(fx, '['.repeat(20_000) + ']'.repeat(20_000));
  const waited = fx.cmd(['wait', 'launch', '--max-wait', '0']);
  assert.deepEqual([waited.exitCode, waited.out[0]], [0, 'ended ENG-1 bad_result -> open'], waited.err.join('\n'));
  assert.equal(fx.rows().find((row) => row.event === 'ended').why, STOP_CAUSE_REFUSED);
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

test('wait stops and records an issue past issueHours, and names one it cannot stop with the host\'s own command', (t) => {
  const late = started(t, { projectRun: { allow: true, unverifiedHosts: true, issueHours: 2 } });
  const later = Date.now() + 3 * 60 * 60 * 1000;
  // One past issueHours that cannot be stopped is named with the host's own command that stops it by hand.
  const failing = (command, args, options) => (args[0] === 'stop' ? { status: 1, stdout: '', stderr: 'no' } : late.claude.run(command, args, options));
  assert.deepEqual(late.cmd(['wait', 'launch', '--max-wait', '0'], { now: later, spawn: failing }).out, [`overdue ENG-1 attempt 1: a session of it, ${STARTED[0].id}, could not be stopped; \`claude stop ${STARTED[0].id}\` stops it`, 'running ENG-1']);
  assert.deepEqual(late.cmd(['wait', 'launch', '--max-wait', '0'], { now: later }).out, ['ended ENG-1 timeout -> open', 'idle']);
  assert.deepEqual(stops(late), [STARTED[0].id]);
});

// The sessions the run `fx` asked its host to stop, in order, those a test's own spawn answered aside.
const stops = (fx) => fx.claude.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args[1]);

// The release `wait` and `end` run on each read (project-linger.mjs releaseAttempts), alone, on the run `fx` as its
// ledger holds it: a wait's own reads of git and the forge prove nothing more about it.
const release = (fx, spawn) => releaseRead(fx, spawn).lines;
function releaseRead(fx, spawn = fx.claude.run) {
  const host = detectHost({ env: fx.as(DRIVER) });
  return releaseAttempts({ found: fx.run(), store: fx.store, cap: host.capabilities.projectStart, host, env: fx.as(DRIVER), spawn, now: Date.now() });
}

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
  settled.claude.held.add(CHILD);
  markUnattended(NEXT.session, { root: settled.dir, env: settled.env, tags: { project: 'launch', issue: 'ENG-1' } });
  assert.equal(settled.result({ status: 'failed', stop: 'gave up' }, NEXT.session).exitCode, 0);
  assert.deepEqual(settled.cmd(['wait', 'launch', '--max-wait', '0']).out, ['result ENG-1 failed -> open', 'lingering ENG-1 attempt 1']);
  const past = Date.now() + LINGER_GRACE + 60_000;
  assert.deepEqual(settled.cmd(['wait', 'launch', '--max-wait', '0'], { now: past, spawn: failing(settled) }).out, [`lingered ENG-1 attempt 1: a session of it, ${NEXT.id}, ran on after its issue settled and could not be stopped; \`claude stop ${NEXT.id}\` stops it`, 'lingering ENG-1 attempt 1']);
  assert.deepEqual(stops(settled), [], 'a lingering session the host holds is the linger path\'s alone: no release stops it');

  // Once the chain ended, a host that still holds both members is asked to stop each, in the pass that records it gone.
  settled.claude.states[NEXT.session] = 'done';
  settled.claude.held.add(NEXT.session);
  assert.deepEqual(settled.cmd(['wait', 'launch', '--max-wait', '0'], { now: past }).out, ['lingered ENG-1 attempt 1 ended', 'released ENG-1 attempt 1', 'idle']);
  assert.deepEqual(stops(settled), [STARTED[0].id, NEXT.id]);
  // One member done and held, the other working again: the done one is stopped, and no `released` line says the host
  // let the attempt go while it still holds a session of it.
  settled.claude.states[CHILD] = 'done';
  settled.claude.states[NEXT.session] = 'working';
  settled.claude.held.add(CHILD);
  assert.deepEqual(release(settled), []);
  assert.deepEqual(stops(settled), [STARTED[0].id, NEXT.id, STARTED[0].id]);
  settled.claude.states[NEXT.session] = 'done';
  settled.claude.held.add(NEXT.session);
  assert.deepEqual(release(settled), ['released ENG-1 attempt 1']);
  assert.deepEqual(stops(settled), [STARTED[0].id, NEXT.id, STARTED[0].id, NEXT.id]);
  // Both done and held, and a person starts a turn in the second while the first one's stop runs: each is read right
  // before its own stop, so the second is left alone.
  settled.claude.states[CHILD] = 'done';
  settled.claude.states[NEXT.session] = 'done';
  settled.claude.held.add(CHILD).add(NEXT.session);
  const turning = (command, args, options) => {
    if (args[0] === 'stop' && args[1] === STARTED[0].id) settled.claude.states[NEXT.session] = 'working';
    return settled.claude.run(command, args, options);
  };
  assert.deepEqual(releaseRead(settled, turning), { lines: [], unread: [] }, 'a working member was read, so its attempt is not unread');
  assert.deepEqual(stops(settled).slice(4), [STARTED[0].id], 'a session whose turn began before its own read is not stopped');
  // One that did not stop, and another the host cannot say ended: the attempt's own new line stands for it, with the note.
  settled.claude.states[NEXT.session] = 'done';
  settled.claude.held.add(CHILD);
  let down = false;
  const half = (command, args, options) => {
    if (down && args.includes('--all')) return { status: 1, stdout: '', stderr: 'down' };
    down ||= args[0] === 'stop';
    return failing(settled)(command, args, options);
  };
  const mixed = releaseRead(settled, half);
  assert.deepEqual([mixed.lines.map((line) => line.slice(0, 26)), mixed.unread], [['not released ENG-1 attempt', 'note sessions: Claude Code'], []]);
});

test('the release lines one wait prints: a not released line stays only while the latest pass that could read its attempt repeats it', () => {
  const stuck = (id, attempt = 'ENG-1 attempt 1') => `not released ${attempt}: a session of it, ${id}, stayed`;
  const note = 'note sessions: Claude Code: it did not answer';
  // Each pass is its lines, or { lines, unread } where it could not read every attempt.
  const passes = (...each) => each.map((pass) => (Array.isArray(pass) ? { lines: pass, unread: [] } : pass)).reduce(mergeRelease, []);
  const blind = (lines, ...unread) => ({ lines: [...lines, note], unread });
  assert.deepEqual(passes([stuck('a')], [stuck('a')]), [stuck('a')]);
  assert.deepEqual(passes([stuck('a')], []), [], 'stopped while another member works, or nothing held');
  assert.deepEqual(passes([stuck('a')], [stuck('b')]), [stuck('b')], 'two stuck members of one attempt leave one line');
  assert.deepEqual(passes([stuck('a')], ['released ENG-1 attempt 1']), ['released ENG-1 attempt 1']);
  assert.deepEqual(passes(['released ENG-1 attempt 1'], []), ['released ENG-1 attempt 1'], 'a released line stays');
  assert.deepEqual(passes([stuck('a')], blind([], 'ENG-1 attempt 1')), [stuck('a'), note], 'a pass that could not read its attempt keeps it');
  assert.deepEqual(passes([stuck('a')], blind([], 'ENG-1 attempt 1'), []), [], 'until a later pass could, whose line it is: the earlier note goes too');
  assert.deepEqual(passes(blind([]), blind([])), [note], 'a note the latest pass repeats is printed once');
  const other = stuck('c', 'ENG-1 attempt 10');
  assert.deepEqual(passes([stuck('a'), other], blind([], 'ENG-1 attempt 1', 'ENG-1 attempt 10')), [stuck('a'), other, note], 'every one when the host listed nothing');
  assert.deepEqual(passes([stuck('a'), other], blind([], 'ENG-1 attempt 10')), [other, note], 'only the attempt that was unreadable: the other one\'s stop was confirmed');
  assert.deepEqual(passes([stuck('a'), other], blind([], 'ENG-1 attempt 1')), [stuck('a'), note], 'attempt 1 is not attempt 10');
  assert.deepEqual(passes([stuck('a'), other], blind([stuck('b')])), [stuck('b'), note], 'one line for each attempt');
});

// One run through the release of sessions the host still holds (project-linger.mjs releaseAttempts): a session the host
// lists as done while its plain listing still holds it, as the ledger and the listing of Claude Code 2.1.331 showed. Its
// `gone` row says it ended, so the linger path never stopped it.
test('wait records an issue whose sessions all ended with no result, and stops each session the host still holds after its attempt ended', (t) => {
  const fx = started(t);
  const stopped = [];
  // The number of stops that fail before one goes through.
  let fails = Infinity;
  const failing = (command, args, options) => {
    if (args[0] === 'stop') {
      stopped.push(args[1]);
      if (fails > 0) {
        fails -= 1;
        return { status: 1, stdout: '', stderr: 'no' };
      }
    }
    return fx.claude.run(command, args, options);
  };
  const stuck = `not released ENG-1 attempt 1: a session of it, ${STARTED[0].id}, stayed with the host after its work ended and could not be stopped; \`claude stop ${STARTED[0].id}\` stops it`;
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['running ENG-1']);
  fx.claude.states[CHILD] = 'done';
  fx.claude.held.add(CHILD);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { spawn: failing }).out, ['ended ENG-1 no_result -> open', stuck, 'idle'], 'the line keeps no wait from idle');
  assert.deepEqual(fx.rows().filter((row) => row.event === 'gone').map((row) => [row.key, row.attempt, row.how]), [['ENG-1', 1, 'ended']]);
  assert.match(fx.cmd(['wait', 'launch'], { session: OTHER }).err[0], /this session is not the driver/u);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  // A clock that moves when the wait pauses and on each call to the host, a second each, so every read costs time.
  const now = Date.now();
  let elapsed = 0;
  let passes = 0;
  // Each read's cost: the time from the end of the last pause, or the start, to the next pause.
  const reads = [];
  let resumed = 0;
  const pause = (ms) => {
    passes += 1;
    reads.push(elapsed - resumed);
    elapsed += ms;
    resumed = elapsed;
  };
  const slow = (...args) => {
    elapsed += 1_000;
    return failing(...args);
  };
  const waited = fx.cmd(['wait', 'launch', '--max-wait', '120'], { spawn: slow, now, clock: () => now + elapsed, pause });
  assert.deepEqual(waited.out, [stuck, 'running ENG-1']);
  // It ran its time out, best effort: it stops only where the slowest read and WAIT_MARGIN no longer fit.
  const slowest = Math.max(...reads, elapsed - resumed);
  assert.ok(passes >= 4 && elapsed <= 120_000 && elapsed >= 120_000 - slowest - WAIT_MARGIN, `the wait ran its time out (${passes} pauses, ${elapsed} ms, reads of ${reads})`);
  assert.ok(stopped.length > 0 && stopped.every((id) => id === STARTED[0].id), 'the session of the attempt that runs is never stopped');
  // A stop that fails on the first pass of a wait and goes through on a later one: `released` alone, so no session
  // already stopped is left for the Human to stop by hand.
  fails = 1;
  stopped.length = 0;
  const from = now + elapsed;
  const again = fx.cmd(['wait', 'launch', '--max-wait', '60'], { spawn: slow, now: from, clock: () => now + elapsed, pause });
  assert.deepEqual(again.out, ['released ENG-1 attempt 1', 'running ENG-1']);
  assert.deepEqual(stopped, [STARTED[0].id, STARTED[0].id], 'it failed once, then went through');
  assert.equal(fx.claude.held.has(CHILD), false, 'the host holds it no more');

  // A stop that fails on the first pass, and a session the host holds no more by the next one, as once the Human ran the
  // printed command: no line names it. When that next pass cannot read the ledger, so it asks no host, the line stays.
  const snapshot = path.join(runFolder(fx.state, 'launch'), 'snapshot.json');
  const twoPasses = (between) => {
    fails = 1;
    fx.claude.held.add(CHILD);
    const step = (ms) => {
      between();
      pause(ms);
    };
    return fx.cmd(['wait', 'launch', '--max-wait', '60'], { spawn: slow, now: now + elapsed, clock: () => now + elapsed, pause: step });
  };
  assert.deepEqual(twoPasses(() => fx.claude.held.delete(CHILD)).out, ['running ENG-1']);
  const unread = twoPasses(() => renameSync(snapshot, `${snapshot}.away`));
  renameSync(`${snapshot}.away`, snapshot);
  assert.deepEqual([unread.exitCode, unread.out], [1, [stuck]]);
  fx.claude.held.delete(CHILD);

  // A session that lingers after its result, with no `gone` row yet, is the linger path's alone: no release stops it.
  stopped.length = 0;
  assert.equal(fx.result({ status: 'blocked', stop: 'no token' }, STARTED[1].session).exitCode, 0);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { spawn: failing }).out, ['result ENG-1 blocked -> parked blocked', 'lingering ENG-1 attempt 2']);
  assert.match(fx.cmd(['wait', 'launch', '--max-wait', '9999']).err.at(-1), /takes --max-wait as whole seconds from 0 to 540/u);
  assert.deepEqual(stopped, []);
  // Attempt 2 ends held: of the two gone attempts, only the one whose session the host still holds is stopped. The
  // ledger fails right after that pass, and the refusal still prints the release line.
  fx.claude.states[STARTED[1].session] = 'done';
  fx.claude.held.add(STARTED[1].session);
  const breaking = (command, args, options) => {
    if (args[0] === 'stop') renameSync(snapshot, `${snapshot}.away`);
    return failing(command, args, options);
  };
  const refused = fx.cmd(['wait', 'launch', '--max-wait', '0'], { spawn: breaking });
  assert.deepEqual(stopped, [STARTED[1].id]);
  renameSync(`${snapshot}.away`, snapshot);
  assert.deepEqual([refused.exitCode, refused.out], [1, ['released ENG-1 attempt 2']]);
  assert.match(refused.err.join('\n'), /^aidrian project wait: the snapshot of run launch/u);
  assert.deepEqual(fx.rows().filter((row) => row.event === 'gone').map((row) => row.attempt), [1, 2]);

  stopped.length = 0;
  assert.deepEqual(release(fx, failing), [], 'nothing is released twice');
  // One the host lists as working again, as after a person typed into it, is never stopped.
  fx.claude.states[CHILD] = 'working';
  assert.deepEqual(release(fx, failing), []);
  assert.deepEqual(stopped, [], 'a working session is not released');
  // One it holds but cannot say ended, its full listing down, is left alone with a note, and released once it can say.
  fx.claude.states[CHILD] = 'done';
  fx.claude.held.add(CHILD);
  const blind = (command, args, options) => (args[0] === 'agents' && args.includes('--all') ? { status: 1, stdout: '', stderr: 'down' } : failing(command, args, options));
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { spawn: blind }).out, ['note sessions: Claude Code: it holds a session of a settled attempt and cannot say now whether that session ended, so it was left alone', 'idle']);
  assert.deepEqual(releaseRead(fx, blind).unread, ['ENG-1 attempt 1'], 'attempt 2 was read: the host holds no session of it');
  const unlisted = (command, args, options) => (args[0] === 'agents' && !args.includes('--all') ? { status: 1, stdout: '', stderr: 'down' } : failing(command, args, options));
  assert.deepEqual(releaseRead(fx, unlisted).unread, ['ENG-1 attempt 1', 'ENG-1 attempt 2'], 'every one when the host cannot say which it holds');
  assert.deepEqual(stopped, [], 'nothing stopped while the host cannot say');
  assert.deepEqual(releaseRead(fx, failing), { lines: ['released ENG-1 attempt 1'], unread: [] });
  assert.deepEqual(stopped, [STARTED[0].id]);
});

test('wait holds --max-wait as best effort under slow reads: it starts no read the slowest so far would not fit, and returns at once on a settle', (t) => {
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

test('wait counts its setup against --max-wait: the command\'s own, a slow policy read, and a start given in the past', (t) => {
  const fx = started(t);
  // Each call to the host's listing takes 20 seconds; with 130 seconds of setup counted, a 150-second wait has room for
  // its first read only.
  const start = Date.now();
  let clock = start;
  const order = [];
  const slow = (...args) => {
    clock += 20_000;
    order.push('listing');
    return fx.claude.run(...args);
  };
  const pauses = [];
  const pause = (ms) => {
    pauses.push(ms);
    clock += ms;
  };
  // The command's setup before waitRun takes 130 seconds: every clock read inside waitRun is that much later than one
  // outside it, such as the command's own at its start.
  const late = () => clock + (/\bat waitRun \(/u.test(new Error().stack) ? 130_000 : 0);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '150'], { now: start, clock: late, spawn: slow, pause }).out, ['running ENG-1']);
  assert.deepEqual(pauses, [], 'no pause and no second read: the 130 s before waitRun count');
  // The forge's policy read, waitRun's own setup before its first read, takes 130 seconds.
  order.length = 0;
  const forge = {
    ...fx.forge,
    contents: (...args) => {
      if (!order.includes('policy')) clock += 130_000;
      order.push('policy');
      return fx.forge.contents(...args);
    },
  };
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '150'], { now: clock, clock: () => clock, spawn: slow, forge, pause }).out, ['running ENG-1']);
  assert.equal(order[0], 'policy', 'the policy read is the setup, before any listing');
  assert.deepEqual(pauses, [], 'no pause and no second read: the 130 s of the policy read count');
  // waitRun called with a start in the past counts from it.
  const given = { project: fx.project, config: fx.config, run: 'launch', maxWait: 150, env: fx.as(DRIVER), home: fx.home, forge: fx.forge, spawn: slow, pause, clock: () => clock };
  assert.deepEqual(waitRun({ ...given, now: clock, started: clock - 130_000 }).out, ['running ENG-1']);
  assert.deepEqual(pauses, [], 'a start in the past leaves no room for a second read');
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
// The checks a sign_in environment halt's re-check runs, as their `ok` lines name them, in the fixture, whose forge has no reads.
const SIGN_IN_CHECKS = ['repository', 'state', 'policy', 'access'];
// The token reads of the GitHub adapter: none refused, one refused, which fails the re-check's `token-reads`, and one
// the forge could not answer.
const READS_OK = { missing: [], unverified: [], unanswered: [] };
const NO_ISSUES = { ...READS_OK, missing: [{ read: 'reactions', what: 'read the reactions on a pull request', permission: 'Issues: Read-only', why: 'the forge answered 403' }] };
const NO_ANSWER = { ...READS_OK, unanswered: ['pulls'] };

test('an environment result halts the run with its stop; wait never re-checks it, and the driver\'s next start of the issue lifts it once its checks pass', (t) => {
  const fx = started(t);
  assert.match(fx.result({ status: 'environment', stop: null, cause: 'sign_in' }).err.join('\n'), /an environment result names in "stop" what failed/u);
  const stop = 'git push: could not read Username for github.com, token ghp_abcdefghijklmnopqrstuvwxyz0123';
  const cause = 'ENG-1 attempt 1 found its environment broken: git push: could not read Username for `github.com`, token [redacted]';
  assert.deepEqual(fx.recorded({ status: 'environment', stop, cause: 'sign_in' }, CHILD, '150').out, ['result ENG-1 environment -> open'], 'no wait re-checks a halt');
  assert.deepEqual(fx.rows().filter((row) => row.event === 'result').map((row) => [row.halt, row.cause]), [[cause, 'sign_in']]);
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
  assert.deepEqual([lifting.exitCode, lifting.out], [0, [`recheck lifted the halt: ${cause}; ok ${SIGN_IN_CHECKS.join(', ')}`, 'lifted the environment halt of ENG-1; run `next` again']]);
  assert.equal(fx.claude.starts().length, starts, 'no session started');
  assert.deepEqual(rechecks(fx), [{ event: 'resume', session: DRIVER, kind: 'environment', key: 'ENG-1', attempt: 1, via: 'recheck', checks: SIGN_IN_CHECKS, cause: 'sign_in' }]);
  const next = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(next.exitCode, 0, next.err.join('\n'));
  assert.ok(next.out.includes('started ENG-1 attempt 2 session c0ffee02'), next.out.join('\n'));
  assert.ok(existsSync(path.join(runFolder(fx.state, 'launch'), 'attempts', 'ENG-1.1')), 'the environment attempt keeps its folder');
});

test('an environment halt whose re-check does not pass, a refused read and a read the forge could not answer alike, stays and writes nothing; the next start lifts it once its checks pass', (t) => {
  const fx = started(t);
  fx.forge.tokenReads = () => NO_ISSUES;
  assert.equal(fx.recorded({ status: 'environment', stop: 'gh api repos/acme/widgets/issues/12/reactions: HTTP 403', cause: 'sign_in' }).out[0], 'result ENG-1 environment -> open');
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
  fx.recorded({ status: 'environment', stop: 'gh pr checks 12: HTTP 403', cause: 'sign_in' });
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
  appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'result', key: 'ENG-1', attempt: 1, status: 'environment', cause: 'network', halt: 'ENG-1 attempt 1 found its environment broken: no network', at: new Date().toISOString() }] }));
  const lift = (custodian) => recheckHalt({ state: fx.state, run: 'launch', found: readRun(fx.state, 'launch'), session: DRIVER, key: 'ENG-1', custodian, recheck: () => ['ok host', 'ok access'] });
  const changed = ['the checks passed, but the run changed meanwhile: its halt was lifted, it ended, or custody moved'];
  assert.deepEqual(lift(OTHER), { lifted: false, lines: changed }, 'custody rests with another session');
  appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'end', session: DRIVER, at: new Date().toISOString() }] }));
  assert.deepEqual(lift(DRIVER), { lifted: false, lines: changed }, 'the run ended');
  assert.deepEqual(rechecks(fx), []);
});

test('a resume row the re-check cannot write is its own line, and a ledger another process holds exits 75 to be tried again', (t) => {
  const fx = started(t);
  fx.recorded({ status: 'environment', stop: 'no network', cause: 'network' });
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
  const gone = recheckHalt({ state: fx.state, run: 'launch', found, session: DRIVER, key: 'ENG-1', recheck: () => (rmSync(path.join(folder, 'snapshot.json')), ['ok access']) });
  assert.equal(gone.lifted, false);
  assert.match(gone.lines.at(-1), /^the checks passed, but the resume row could not be written: no run launch in /u);
});

// An environment result row of `key`'s attempt 1 that halts run `launch` of `fx`, with `cause` when given.
const environmentHalt = (fx, cause, key = 'ENG-1') => appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'result', key, attempt: 1, status: 'environment', ...(cause === undefined ? {} : { cause }), halt: `${key} attempt 1 found its environment broken: no network`, at: new Date().toISOString() }] }));

// A run `launch` written by hand in a fresh state folder, with ENG-1's attempt 1 running and a drop folder: no git and
// no child process, for the steps that read only the run's files.
function handRun(t) {
  const state = mkdtempSync(path.join(tmpdir(), 'aidrian-hand-run-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const folder = runFolder(state, 'launch');
  const drop = path.join(state, 'drop');
  mkdirSync(folder, { recursive: true });
  mkdirSync(drop, { mode: 0o700 });
  const snapshot = JSON.stringify({ issues: [ISSUES[0]] });
  writeFileSync(path.join(folder, 'snapshot.json'), snapshot);
  const at = new Date(Date.now() - 60_000).toISOString();
  const rows = [
    { event: 'init', run: 'launch', at, session: DRIVER, repository: { host: 'github.com', owner: 'acme', name: 'widgets' }, issues: 1, sha256: createHash('sha256').update(snapshot).digest('hex') },
    { event: 'issue', key: 'ENG-1', state: 'running', at },
    { event: 'start', key: 'ENG-1', attempt: 1, outcome: 'started', session: DRIVER, id: CHILD, child: CHILD, cwd: state, name: 'ENG-1', drop, at },
  ];
  writeFileSync(path.join(folder, 'ledger.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  return { state, drop };
}

test('a result an older plugin\'s session handed over with no cause is taken in, its halt waits on a person, and the report reads its stop text again; an unlisted cause is still refused', (t) => {
  const { state, drop } = handRun(t);
  writeFileSync(path.join(drop, DROP_FILE), JSON.stringify({ run: 'launch', key: 'ENG-1', attempt: 1, status: 'environment', pr: null, decisions: [], stop: 'git push: HTTP 403' }));
  assert.deepEqual(ingestDrops({ state, run: 'launch', found: readRun(state, 'launch'), forge: { branchHead: () => null }, now: Date.now() }), ['result ENG-1 environment -> open']);
  const found = readRun(state, 'launch');
  const row = found.rows.findLast((each) => each.event === 'result');
  assert.equal(Object.hasOwn(row, 'cause'), false);
  let probes = 0;
  const kept = recheckHalt({ state, run: 'launch', found, session: DRIVER, key: 'ENG-1', recheck: () => ((probes += 1), ['ok access']) });
  assert.deepEqual([kept.lifted, kept.lines[1], probes], [false, 'no check covers this cause (none recorded): a person fixes it, then lifts the halt with `aidrian project resume launch` from a session they attend', 0]);
  assert.deepEqual(rereadResult(state, 'launch', 'ENG-1', row), { result: { status: 'environment', pr: null, decisions: [], stop: 'git push: HTTP 403' } });
  // On a re-read, an unlisted cause, or a cause on another status, is refused as before.
  const file = path.join(runFolder(state, 'launch'), 'results', 'ENG-1.json');
  const written = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...written, cause: 'wifi' }));
  assert.deepEqual(rereadResult(state, 'launch', 'ENG-1', row), { problem: 'the session\'s result file fails its checks' });
  assert.deepEqual(validateResult({ status: 'failed', stop: 'x', cause: 'push' }, { causeless: true }).problems, ['"cause" is for an environment result alone']);
  // Where a session records a result, the cause is still required.
  assert.match(validateResult({ status: 'environment', stop: 'x' }).problems[0], /^an environment result names its "cause"/u);
});

// One fixture for both halves, within the file's child-process budget.
test('an environment halt\'s re-check reads its cause: one no check covers, or none, is kept with no probe; a covered one runs only its own checks, lifts, and records the cause', (t) => {
  assert.deepEqual(CAUSE_CHECKS, { commit: ['commit'], host: ['host', 'trust'], sign_in: ['access'], push: ['access'], network: ['access'], sandbox_refused: [], other: [] });
  const fx = runFixture(t);
  const recheck = (key, asked) => recheckHalt({ state: fx.state, run: 'launch', found: readRun(fx.state, 'launch'), session: DRIVER, key, recheck: ({ names }) => (asked.push([...names]), names.map((name) => `ok ${name}`)) });
  for (const [cause, named] of [['sandbox_refused', 'sandbox_refused'], ['other', 'other'], [undefined, 'none recorded'], ['wifi', 'not a known cause']]) {
    environmentHalt(fx, cause);
    const asked = [];
    assert.deepEqual(recheck('ENG-1', asked), { lifted: false, lines: ['recheck kept the halt: ENG-1 attempt 1 found its environment broken: no network', `no check covers this cause (${named}): a person fixes it, then lifts the halt with \`aidrian project resume launch\` from a session they attend`] }, String(cause));
    assert.deepEqual(asked, [], `${cause}: no probe`);
    assert.deepEqual(rechecks(fx), [], String(cause));
    // A person lifts it, so the next halt is the latest.
    appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'resume', session: OTHER, at: new Date().toISOString() }] }));
  }
  // A sign_in halt whose access check never ran, as on a host with no project-start capability, where only the
  // repository, state, and policy lines answer ok: kept, naming the check.
  environmentHalt(fx, 'sign_in');
  const prerequisites = recheckHalt({ state: fx.state, run: 'launch', found: readRun(fx.state, 'launch'), session: DRIVER, key: 'ENG-1', recheck: () => ['ok repository', 'ok state', 'ok policy'] });
  assert.deepEqual(prerequisites, { lifted: false, lines: ['recheck kept the halt: ENG-1 attempt 1 found its environment broken: no network', 'the checks of this halt that did not run or answer ok: access'] });
  assert.deepEqual(rechecks(fx), []);
  appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'resume', session: OTHER, at: new Date().toISOString() }] }));
  // A host halt whose trust record cannot be read: the note answers nothing, so it is kept, and printed.
  const unreadable = 'note trust: the trust record ~/.claude.json cannot be read (ENOENT)';
  environmentHalt(fx, 'host');
  const unread = recheckHalt({ state: fx.state, run: 'launch', found: readRun(fx.state, 'launch'), session: DRIVER, key: 'ENG-1', recheck: () => ['ok repository', 'ok state', 'ok policy', 'ok host', unreadable] });
  assert.deepEqual(unread, { lifted: false, lines: ['recheck kept the halt: ENG-1 attempt 1 found its environment broken: no network', 'the checks of this halt that did not run or answer ok: trust', unreadable] });
  // With a blocker from another check beside it, both are printed: the blocker does not hide the note.
  const blocker = 'blocker host: this host\'s project start is not confined to a fresh clone under its own sandbox';
  const blocked = recheckHalt({ state: fx.state, run: 'launch', found: readRun(fx.state, 'launch'), session: DRIVER, key: 'ENG-1', recheck: () => ['ok repository', 'ok state', 'ok policy', blocker, unreadable] });
  assert.deepEqual(blocked, { lifted: false, lines: ['recheck kept the halt: ENG-1 attempt 1 found its environment broken: no network', blocker, unreadable] });
  assert.deepEqual(rechecks(fx), []);
  appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'resume', session: OTHER, at: new Date().toISOString() }] }));
  const lifts = [];
  // Each on its own issue, since a second self-lift of one issue's environment halt waits on a person. The host halt is
  // re-checked on a host that keeps no trust record: its exact answer counts for trust.
  const noRecord = ({ names }) => names.map((name) => (name === 'trust' ? NO_TRUST_RECORD : `ok ${name}`));
  for (const [cause, checks, key, answer] of [['sign_in', ['access'], 'ENG-1'], ['host', ['host', 'trust'], 'ENG-4', noRecord]]) {
    environmentHalt(fx, cause, key);
    const asked = [];
    const lifted = answer
      ? recheckHalt({ state: fx.state, run: 'launch', found: readRun(fx.state, 'launch'), session: DRIVER, key, recheck: (given) => (asked.push([...given.names]), answer(given)) })
      : recheck(key, asked);
    assert.equal(lifted.lifted, true, lifted.lines.join('\n'));
    assert.deepEqual(asked, [checks], cause);
    lifts.push({ event: 'resume', session: DRIVER, kind: 'environment', key, attempt: 1, via: 'recheck', checks: answer ? ['host'] : checks, cause });
    assert.deepEqual(rechecks(fx), lifts);
  }
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
    assert.deepEqual(fx.recorded({ status: 'environment', stop: `no network, try ${n + 1}`, cause: 'network' }, session).out, [expected]);
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
