// Independent issues of a project run in parallel (lib/project-run-gate.mjs, lib/project-run-cli.mjs): the base
// branch's projectRun.maxParallel, read through the forge as `start` reads it, held to PROJECT_PARALLEL, sets how many
// issues `next` names and `start` runs at once. The driver's starts stay one at a time, each held by its claim and its
// one pending mark, and the last check of the order and the cap runs under the ledger's lock with the write-ahead row.
// A dependent starts only once its blocker's result is a merge the forge confirmed. A usage pause one issue's session
// holds is joined by a rate limit another meets in the same wait. The fixture is test/project-start-fixture.mjs: no real
// session, forge, or home.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { chainOf, checkBrief } from '../plugins/aidrian/lib/handoff-brief.mjs';
import { continueBrief } from '../plugins/aidrian/lib/handoff-continue.mjs';
import { readStarted } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { stopLine as claudeStopLine } from '../plugins/aidrian/lib/hosts/claude-code-background.mjs';
import { stopLine as codexStopLine } from '../plugins/aidrian/lib/hosts/codex-exec.mjs';
import { LINGER_GRACE, notStopped } from '../plugins/aidrian/lib/project-linger.mjs';
import { appendToRun } from '../plugins/aidrian/lib/project-run.mjs';
import { check as processKill } from '../plugins/aidrian/lib/rules/process-kill.mjs';
import { markDriver } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { PROJECT_PARALLEL } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { drivenRunStart, recordsStart } from '../plugins/aidrian/lib/run-driver.mjs';
import { DRIVER, keptFiles, OTHER, runFixture, STARTED } from './project-start-fixture.mjs';

const MINUTE = 60_000;
const iso = (ms) => new Date(ms).toISOString();
// Four issues: ENG-1, ENG-3, and ENG-4 stand alone, and ENG-2 waits on ENG-1.
const ISSUES = [
  { key: 'ENG-1', branch: 'feat/eng-1-export', status: 'unstarted', priority: 1 },
  { key: 'ENG-2', branch: 'feat/eng-2-import', status: 'unstarted', blockedBy: ['ENG-1'] },
  { key: 'ENG-3', branch: 'feat/eng-3-filter', status: 'unstarted', priority: 2 },
  { key: 'ENG-4', branch: 'fix/eng-4-typo', status: 'unstarted', priority: 3 },
];
const parallel = (maxParallel, more = {}) => ({ projectRun: { allow: true, unverifiedHosts: true, maxParallel }, issues: ISSUES, ...more });
const started = (fx) => fx.rows().filter((row) => row.event === 'start' && row.outcome === 'started');

test('with maxParallel 2 two independent issues run, and the third waits until one settles', (t) => {
  const fx = runFixture(t, parallel(2));
  assert.deepEqual(fx.cmd(['next', 'launch']).out.slice(0, 2), ['next ENG-1 feat/eng-1-export', 'next ENG-3 feat/eng-3-filter']);
  assert.equal(JSON.parse(fx.cmd(['next', 'launch', '--json']).out[0]).maxParallel, 2);
  for (const [key, n] of [['ENG-1', 0], ['ENG-3', 1]]) {
    const start = fx.cmd(['start', 'launch', key]);
    assert.equal(start.exitCode, 0, start.err.join('\n'));
    assert.ok(start.out.includes(`started ${key} attempt 1 session ${STARTED[n].id}`), start.out.join('\n'));
  }
  // The first issue's session still runs, as the host lists it: the second start went on beside it.
  assert.deepEqual(started(fx).map((row) => row.key), ['ENG-1', 'ENG-3']);
  assert.equal(fx.cmd(['next', 'launch']).out[0], 'wait 2 running');
  const third = fx.cmd(['start', 'launch', 'ENG-4']);
  assert.equal(third.exitCode, 1);
  assert.match(third.err[0], /^aidrian project start: 2 issues run already, and a run runs at most 2 at once$/u);
  assert.equal(fx.claude.starts().length, 2, 'no third session');

  // ENG-3's session ends with no result: its slot is free, and the next start takes it.
  fx.claude.states[STARTED[1].session] = 'done';
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['ended ENG-3 no_result -> open', keptFiles(fx, 'ENG-3'), 'running ENG-1']);
  assert.deepEqual(fx.cmd(['next', 'launch']).out[0], 'next ENG-3 feat/eng-3-filter');
  const fourth = fx.cmd(['start', 'launch', 'ENG-3']);
  assert.equal(fourth.exitCode, 0, fourth.err.join('\n'));
});

test('one at a time by default, the lower of the forge\'s and the local value, and one at a time when the forge cannot answer', (t) => {
  const serial = runFixture(t, { issues: ISSUES });
  assert.deepEqual(serial.cmd(['next', 'launch']).out.filter((line) => line.startsWith('next ')), ['next ENG-1 feat/eng-1-export']);
  assert.equal(serial.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const refused = serial.cmd(['start', 'launch', 'ENG-3']);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.err[0], /1 issues run already, and a run runs at most 1 at once/u);
  assert.equal(serial.cmd(['next', 'launch']).out[0], 'wait 1 running');

  // The forge's copy of the config is the one read: a working copy, or a local ref alone, widens nothing.
  const forgeLow = runFixture(t, { ...parallel(3), forgeConfig: { version: 1, projectRun: { allow: true, unverifiedHosts: true, maxParallel: 1 } } });
  assert.equal(forgeLow.cmd(['next', 'launch']).out.filter((line) => line.startsWith('next ')).length, 1);
  assert.equal(JSON.parse(forgeLow.cmd(['next', 'launch', '--json']).out[0]).maxParallel, 1);

  // A forge that cannot answer names one at a time.
  const down = runFixture(t, parallel(3));
  down.forge.contents = () => {
    throw new Error('gh: HTTP 502');
  };
  assert.equal(down.cmd(['next', 'launch']).out.filter((line) => line.startsWith('next ')).length, 1);
  assert.equal(PROJECT_PARALLEL, 4);
});

test('a start that loses its slot to another under the ledger\'s lock is refused, starts nothing, and halts nothing', (t) => {
  const fx = runFixture(t, parallel(2));
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  // While the start of ENG-3 lists the host's sessions, before its write-ahead row, another start of the driver's
  // takes the last slot: the row the start writes under the lock asks the cap again.
  let raced = false;
  const racing = (command, args, options) => {
    if (args[0] === 'agents' && !raced && fx.claude.starts().length === 1) {
      raced = true;
      const at = iso(Date.now());
      appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'start', key: 'ENG-4', attempt: 1, session: DRIVER, name: 'launch · ENG-4 · 1', cwd: path.join(fx.root, 'eng-4'), branch: 'fix/eng-4-typo', drop: path.join(fx.root, 'drop'), at, outcome: 'uncertain', pending: true }, { event: 'issue', key: 'ENG-4', state: 'running', at }] }));
    }
    return fx.claude.run(command, args, options);
  };
  const lost = fx.cmd(['start', 'launch', 'ENG-3'], { spawn: racing });
  assert.ok(raced, 'the race ran');
  assert.equal(lost.exitCode, 1);
  assert.match(lost.err[0], /^aidrian project start: 2 issues run already, and a run runs at most 2 at once$/u);
  assert.ok(!lost.out.some((line) => line.startsWith('halt ')), lost.out.join('\n'));
  assert.equal(fx.claude.starts().length, 1, 'no session started');
  assert.equal(fx.rows().some((row) => row.event === 'start' && row.key === 'ENG-3'), false, 'no row of ENG-3');
  assert.equal(fx.rows().some((row) => row.event === 'halt'), false);
});

test('a dependent starts only after its blocker\'s merge the forge confirmed: an unconfirmed merged result leaves it waiting', (t) => {
  const fx = runFixture(t, parallel(2));
  const dependent = () => fx.cmd(['next', 'launch']).out.find((line) => line.includes('ENG-2'));
  assert.equal(dependent(), 'blocked ENG-2 waiting ENG-1');
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-3']).exitCode, 0);
  const early = fx.cmd(['start', 'launch', 'ENG-2']);
  assert.equal(early.exitCode, 1);
  assert.match(early.err[0], /does not list ENG-2 to start now/u);

  const results = path.join(fx.root, 'results');
  mkdirSync(results);
  const hand = (session, value, name) => {
    const file = path.join(results, name);
    writeFileSync(file, JSON.stringify(value));
    const handed = fx.cmd(['result', 'launch', 'ENG-1', '--file', file], { session });
    assert.equal(handed.exitCode, 0, handed.err.join('\n'));
  };
  const view = (state) => ({ state, mergedAt: iso(Date.now() + MINUTE), headRefName: 'feat/eng-1-export', baseRefName: 'main', url: 'https://github.com/acme/widgets/pull/12', isCrossRepository: false, headRefOid: fx.git('rev-parse', 'HEAD').trim() });
  // The session says merged, and ends; the forge says the pull request is still open: no merge, so ENG-2 stays blocked.
  fx.forge.change = () => view('OPEN');
  hand(STARTED[0].session, { status: 'merged', pr: 12 }, 'first.json');
  fx.claude.states[STARTED[0].session] = 'done';
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['ended ENG-1 bad_result -> open', keptFiles(fx, 'ENG-1'), 'running ENG-3']);
  assert.equal(dependent(), 'blocked ENG-2 waiting ENG-1');
  // A forge that cannot answer leaves the result to the next wait, and ENG-2 still waits.
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  fx.forge.change = () => {
    throw new Error('gh: HTTP 502');
  };
  hand(STARTED[2].session, { status: 'merged', pr: 12 }, 'second.json');
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['running ENG-1', 'running ENG-3']);
  assert.equal(dependent(), 'blocked ENG-2 waiting ENG-1');
  // The forge confirms the merge: ENG-1 is done, and ENG-2 is next.
  fx.forge.change = () => view('MERGED');
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['result ENG-1 merged -> done', 'running ENG-3', 'lingering ENG-1 attempt 2']);
  const plan = JSON.parse(fx.cmd(['next', 'launch', '--json']).out[0]);
  assert.deepEqual([plan.done, plan.ready, plan.blocked], [['ENG-1'], ['ENG-4', 'ENG-2'], []], 'ENG-2 is ready, after ENG-4 by priority');
  // ENG-1's second session settled while it runs on: the next start waits for the host to list it ended (a wait, exit
  // 75, never a refusal). Once it ends, ENG-4 takes the free slot; once ENG-3 settles too, ENG-2 is next.
  const waiting = fx.cmd(['start', 'launch', 'ENG-4']);
  assert.equal(waiting.exitCode, 75, waiting.err.join('\n'));
  assert.match(waiting.err[0] ?? '', /the session of ENG-1 attempt 2 runs on after its issue settled/u);
  fx.claude.states[STARTED[2].session] = 'done';
  const fourth = fx.cmd(['start', 'launch', 'ENG-4']);
  assert.equal(fourth.exitCode, 0, fourth.err.join('\n'));
  fx.claude.states[STARTED[1].session] = 'done';
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['ended ENG-3 no_result -> open', keptFiles(fx, 'ENG-3'), 'running ENG-4']);
  assert.equal(JSON.parse(fx.cmd(['next', 'launch', '--json']).out[0]).ready.includes('ENG-2'), true);
});

// The API error entry Claude Code writes in a transcript when a call fails for good, with `text` its own message.
const apiError = (text, session, more = {}) => ({ type: 'assistant', isApiErrorMessage: true, sessionId: session, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] }, ...more });

function writeTranscript(config, cwd, entries, session) {
  const folder = path.join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/gu, '-'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${session}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

test('end to end: a rate limit whose session is stopped joins the usage pause another running session holds, in the same wait', (t) => {
  const fx = runFixture(t, parallel(2));
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-3']).exitCode, 0);
  const [one, three] = started(fx);
  const reset = Math.floor(Date.now() / 1000) + 2 * 3600;
  writeTranscript(fx.env.CLAUDE_CONFIG_DIR, one.cwd, [apiError(`Claude AI usage limit reached|${reset}`, one.child, { timestamp: iso(Date.now()) })], one.child);
  writeTranscript(fx.env.CLAUDE_CONFIG_DIR, three.cwd, [apiError('API Error: 429 rate limited', three.child, { timestamp: iso(Date.now()) })], three.child);
  const out = fx.cmd(['wait', 'launch', '--max-wait', '0']).out;
  const until = iso(reset * 1000);
  assert.deepEqual(out, [`paused ENG-1 usage until ${until}: its session goes on once the limit resets`, `limit ENG-3 rate until ${until} -> open`, keptFiles(fx, 'ENG-3'), 'running ENG-1', `paused until ${until}`]);
  const rows = fx.rows().filter((row) => row.event === 'limit');
  assert.deepEqual(rows.map((row) => [row.key, row.kind, row.wait, row.joined ?? false, row.until]), [['ENG-1', 'usage', 1, false, until], ['ENG-3', 'rate', 1, true, until]]);
  assert.equal(fx.claude.states[one.child], undefined, 'the usage-limited session is held, not stopped');
  assert.equal(fx.claude.states[three.child], 'stopped', 'the rate-limited one is stopped');
  assert.deepEqual(fx.rows().filter((row) => row.event === 'ended').map((row) => [row.key, row.reason, row.kind]), [['ENG-3', 'limit', 'rate']]);
  // Both wait out the one pause: no start runs until it ends.
  const refused = fx.cmd(['start', 'launch', 'ENG-4']);
  assert.deepEqual([refused.exitCode, refused.out], [1, [`paused until ${until}`]]);
});

// A run's issue session hands its result over, and its session goes on working, as the host lists it.
function handOver(fx, key, session, value = { status: 'failed', pr: null, decisions: [], stop: 'x' }) {
  const results = path.join(fx.root, 'results');
  mkdirSync(results, { recursive: true });
  const file = path.join(results, `${key}-${session.slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify(value));
  const handed = fx.cmd(['result', 'launch', key, '--file', file], { session });
  assert.equal(handed.exitCode, 0, handed.err.join('\n'));
}
// The sessions the host lists as working.
const live = (fx) => fx.claude.sessions.filter((each) => (fx.claude.states[each.sessionId] ?? 'working') === 'working').map((each) => each.id);

test('a session that runs on after its issue settled counts toward maxParallel: no start passes beside it, and wait stops it past the grace', (t) => {
  const fx = runFixture(t, parallel(2));
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-3']).exitCode, 0);
  // ENG-1's session hands over a failed result and keeps working.
  handOver(fx, 'ENG-1', STARTED[0].session);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['result ENG-1 failed -> open', 'running ENG-3', 'lingering ENG-1 attempt 1']);
  assert.deepEqual(fx.cmd(['next', 'launch']).out.slice(0, 3), ['wait 2 running', 'running ENG-3', 'lingering ENG-1 attempt 1']);
  assert.deepEqual(JSON.parse(fx.cmd(['next', 'launch', '--json']).out[0]).lingering, [{ key: 'ENG-1', attempt: 1 }]);
  // The driver's last start record is ENG-3's, which runs: still, no third session starts while ENG-1's runs on.
  for (const key of ['ENG-1', 'ENG-4']) {
    const held = fx.cmd(['start', 'launch', key]);
    assert.equal(held.exitCode, 75, `${key}: a wait, not a refusal: ${held.err.join('\n')}`);
    assert.ok(held.out.some((line) => line === `retry: ${held.err[0].replace('aidrian project start: ', '')}`), held.out.join('\n'));
    assert.match(held.err[0], /the session of ENG-1 attempt 1 runs on after its issue settled/u);
  }
  assert.equal(fx.claude.starts().length, 2, 'no third session');
  // Within the grace, wait waits on it; past the grace, it stops it and records it.
  const early = fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: Date.now() + LINGER_GRACE / 2 });
  assert.deepEqual(early.out, ['running ENG-3', 'lingering ENG-1 attempt 1']);
  assert.equal(fx.claude.states[STARTED[0].session], undefined, 'not stopped within the grace');
  const later = fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: Date.now() + LINGER_GRACE + 60_000 });
  assert.deepEqual(later.out, ['lingered ENG-1 attempt 1 stopped', 'running ENG-3']);
  assert.equal(fx.claude.states[STARTED[0].session], 'stopped');
  assert.deepEqual(fx.rows().filter((row) => ['linger', 'gone'].includes(row.event)).map((row) => [row.event, row.key, row.attempt, row.how ?? null]), [['linger', 'ENG-1', 1, null], ['gone', 'ENG-1', 1, 'stopped']]);
  // Its slot is free: the next start runs, and two sessions live at most.
  const again = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(again.exitCode, 0, again.err.join('\n'));
  assert.deepEqual(live(fx), [STARTED[1].id, STARTED[2].id]);
});

test('a session that runs on past the grace and cannot be stopped is named with the host\'s command that stops it, each wait', (t) => {
  const fx = runFixture(t, parallel(2));
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  handOver(fx, 'ENG-1', STARTED[0].session);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['result ENG-1 failed -> open', 'lingering ENG-1 attempt 1']);
  const failing = (command, args, options) => (args[0] === 'stop' ? { status: 1, stdout: '', stderr: 'no' } : fx.claude.run(command, args, options));
  const line = `lingered ENG-1 attempt 1: a session of it, ${STARTED[0].id}, ran on after its issue settled and could not be stopped; \`claude stop ${STARTED[0].id}\` stops it`;
  for (const late of [1, 2]) {
    const waited = fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: Date.now() + LINGER_GRACE + late * 60_000, spawn: failing });
    assert.deepEqual(waited.out, [line, 'lingering ENG-1 attempt 1'], `wait ${late}`);
  }
  assert.equal(fx.rows().filter((row) => row.event === 'gone').length, 0, 'no gone row for a session that runs on');
});

test('a could-not-be-stopped line names the session, and falls back to the host\'s own command when the adapter names none it can print', () => {
  const plain = 'a session of it, c0ffee01, could not be stopped; the host\'s own command stops it';
  assert.equal(notStopped({ stopLine: ({ id }) => `\`stop ${id}\` stops it` }, { id: 'c0ffee01' }), 'a session of it, c0ffee01, could not be stopped; `stop c0ffee01` stops it');
  assert.equal(notStopped({ stopLine: ({ id }) => `\`stop ${id}\` stops it` }, { id: 'c0ffee01' }, 'ran on and '), 'a session of it, c0ffee01, ran on and could not be stopped; `stop c0ffee01` stops it', 'what it did first');
  assert.equal(notStopped({}, { id: 'c0ffee01' }), plain, 'no stopLine');
  const full = STARTED[0].session;
  assert.equal(notStopped({ stopLine: claudeStopLine }, { id: full }), `a session of it, ${full}, could not be stopped; the host's own command stops it`, 'a full id, which claude stop refuses');
  assert.equal(notStopped({ stopLine: () => { throw new Error('x'); } }, { id: 'c0ffee01' }), plain, 'a stopLine that throws');
  for (const [why, text] of [
    ['a control character', 'clear\u001b[2J'],
    ['a line separator', '`stop x` stops it\u2028injected'],
    ['a paragraph separator', '`stop x` stops it\u2029injected'],
    ['a right-to-left override', '`stop x` stops it\u202Eti spots'],
    ['a zero-width space', '`st\u200Bop x` stops it'],
    ['a tab', '`stop x`\tstops it'],
    ['an empty line', ''],
    ['spaces only', '   '],
  ]) {
    assert.equal(notStopped({ stopLine: () => text }, { id: 'c0ffee01' }), plain, why);
  }
  // A letter beyond ASCII, as in a folder's name, hides nothing: the line keeps it.
  assert.equal(notStopped({ stopLine: () => '`stop x` in /tmp/café stops it' }, { id: 'c0ffee01' }), 'a session of it, c0ffee01, could not be stopped; `stop x` in /tmp/café stops it');
  // An id of no session's shape is never printed, nor passed to the adapter.
  let asked = 0;
  const counting = { stopLine: ({ id }) => {
    asked += 1;
    return `\`stop ${id}\` stops it`;
  } };
  for (const id of ['c0ffee01\u2028x', 'a b', '', null, 'x'.repeat(129)]) {
    assert.equal(notStopped(counting, { id }), 'a session of it could not be stopped; the host\'s own command stops it', JSON.stringify(id));
  }
  assert.equal(asked, 0, 'the adapter is never asked for an id of no session\'s shape');
});

// Codex knows a session by its process: a name proves nothing of which process holds the pid, and `ps -p` alone prints
// command lines, which the process-kill rule refuses. The line names a listing with no arguments and the start time to
// compare; a start that recorded no process points to its run log, never to a process picked by its name.
test('Codex\'s could-not-be-stopped line names a listing with no arguments and the start time to compare, and no kill by name', () => {
  const recorded = codexStopLine({ id: 'pid-4242-0123456789abcdef' });
  assert.equal(recorded, '`TZ=UTC ps -o pid=,lstart=,ucomm= -p 4242` shows the start time of the process 4242 in UTC, to the second, with no arguments; when it falls within the seconds of this attempt\'s two start rows in the run\'s ledger, from the second of the first through the second of the last, `kill 4242` stops it, and otherwise another process took the pid, so leave it');
  for (const command of [...recorded.matchAll(/`([^`]+)`/gu)].map((match) => match[1])) {
    assert.equal(processKill(command, { env: {} }), null, `${command} passes the process-kill rule`);
  }
  assert.equal(processKill('ps -p 4242', { env: {} }) === null, false, 'the bare listing the line used to name is refused');
  const unknown = codexStopLine({ id: 'not-a-process' });
  assert.equal(unknown, 'the run recorded no process for it: the attempt\'s run log, in the run\'s log folder, holds its events and its session id; stop only the process that writes that log, never one picked by its name');
  assert.doesNotMatch(unknown, /`(?:kill|ps|pkill|killall)\b/u, 'no command to stop a process picked by its name');
  assert.equal(notStopped({ stopLine: codexStopLine }, { id: 'pid-4242-0123456789abcdef' }), `a session of it, pid-4242-0123456789abcdef, could not be stopped; ${recorded}`, 'printable, so the line keeps it');
});

test('one at a time, a wait that returned on a result before its session ended gives wait and a retry, never a stop; end refuses until it ends', (t) => {
  const fx = runFixture(t, { issues: ISSUES });
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  handOver(fx, 'ENG-1', STARTED[0].session);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['result ENG-1 failed -> open', 'lingering ENG-1 attempt 1']);
  assert.deepEqual(fx.cmd(['next', 'launch']).out.slice(0, 2), ['wait 1 running', 'lingering ENG-1 attempt 1']);
  const start = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(start.exitCode, 75, start.err.join('\n'));
  assert.equal(fx.claude.starts().length, 1);
  const end = fx.cmd(['end', 'launch']);
  assert.equal(end.exitCode, 1);
  assert.match(end.err[0], /the session of ENG-1 attempt 1 runs on after its issue settled/u);
  // wait blocks on it, and returns once the host lists it ended.
  let reads = 0;
  const waited = fx.cmd(['wait', 'launch', '--max-wait', '150'], {
    pause: () => {
      reads += 1;
      fx.claude.states[STARTED[0].session] = 'done';
    },
  });
  assert.deepEqual(waited.out, ['lingered ENG-1 attempt 1 ended', 'idle']);
  assert.equal(reads, 1, 'it waited one step');
  assert.deepEqual(fx.cmd(['next', 'launch']).out[0], 'next ENG-1 feat/eng-1-export');
  const again = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(again.exitCode, 0, again.err.join('\n'));
});

test('end refuses while a settled issue\'s session runs on, and ends the run once the host lists it ended', (t) => {
  const fx = runFixture(t, { issues: [ISSUES[0]] });
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  handOver(fx, 'ENG-1', STARTED[0].session, { status: 'parked', pr: null, decisions: [{ question: 'Which?', options: ['a', 'b'], recommended: 0, class: 'product' }], stop: 'x' });
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out.slice(-1), ['lingering ENG-1 attempt 1']);
  assert.match(fx.cmd(['next', 'launch']).out[0], /^wait 1 running$/u, 'not done while it runs on');
  assert.equal(fx.cmd(['end', 'launch']).exitCode, 1);
  fx.claude.states[STARTED[0].session] = 'done';
  const end = fx.cmd(['end', 'launch']);
  assert.equal(end.exitCode, 0, end.err.join('\n'));
  assert.deepEqual(fx.rows().filter((row) => row.event === 'gone').map((row) => [row.key, row.how]), [['ENG-1', 'ended']]);
});

test('a start whose write-ahead row meets a session that settled meanwhile and runs on waits: exit 75, nothing started', (t) => {
  const fx = runFixture(t, parallel(2));
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  // While the start of ENG-3 lists the host's sessions, ENG-1 settles, as a wait in another process records it.
  let raced = false;
  const racing = (command, args, options) => {
    if (args[0] === 'agents' && !raced && fx.claude.starts().length === 1) {
      raced = true;
      appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'issue', key: 'ENG-1', state: 'open', at: iso(Date.now()) }] }));
    }
    return fx.claude.run(command, args, options);
  };
  const held = fx.cmd(['start', 'launch', 'ENG-3'], { spawn: racing });
  assert.ok(raced, 'the race ran');
  assert.equal(held.exitCode, 75, held.err.join('\n'));
  assert.match(held.err[0], /the session of ENG-1 attempt 1 runs on after its issue settled/u);
  assert.equal(fx.claude.starts().length, 1, 'no session started');
  assert.equal(fx.rows().some((row) => row.event === 'start' && row.key === 'ENG-3'), false);
});

test('init --check plans turn 1 with the maxParallel next reads, so its next lines are next\'s', (t) => {
  for (const [maxParallel, more] of [[2, {}], [3, { forgeConfig: { version: 1, projectRun: { allow: true, unverifiedHosts: true, maxParallel: 1 } } }]]) {
    const fx = runFixture(t, { ...parallel(maxParallel, more), init: false });
    const file = path.join(fx.dir, 'snapshot.input');
    writeFileSync(file, JSON.stringify({ issues: ISSUES }));
    const check = fx.cmd(['init', 'launch', '--file', file, '--check']).out.filter((line) => line.startsWith('next '));
    assert.equal(fx.cmd(['init', 'launch', '--file', file]).exitCode, 0);
    const next = fx.cmd(['next', 'launch']).out.filter((line) => line.startsWith('next '));
    assert.deepEqual(check, next, `maxParallel ${maxParallel}`);
    assert.equal(check.length, more.forgeConfig ? 1 : 2);
  }
});

// The brief a driver hands its run on with, in the run's handoff folder.
const DRIVER_BRIEF = '# Handoff: continue the run\nWritten: 2026-11-19 | Chain: 0 | Supersedes: none\n' +
  'Advice from Claude, not a spec: check each claim against the docs and code before building on it.\n\n' +
  '## Objective\n- Finish the run.\n\n## Current state\n- Worktree: none yet\n- Branch: main\n\n## Still running\nNone.\n\n' +
  '## Next steps\n1. Wait.\n\n## Open risks and questions\nNone.\n';

for (const maxParallel of [1, 2]) {
  test(`with maxParallel ${maxParallel}, the driver's background handoff starts while its issues run: their starts hold it back no more than they hold the next start`, (t) => {
    const fx = runFixture(t, { ...parallel(maxParallel), config: { session: { handoff: { continue: 'background' } } } });
    const keys = ['ENG-1', 'ENG-3'].slice(0, maxParallel);
    for (const key of keys) assert.equal(fx.cmd(['start', 'launch', key]).exitCode, 0);
    assert.equal(readStarted(fx.store, DRIVER)?.id, STARTED[maxParallel - 1].id, 'the driver\'s last start record is a running issue\'s');
    const brief = path.join(fx.state, 'handoffs', '2026-11-19-project-launch.md');
    mkdirSync(path.dirname(brief), { recursive: true });
    writeFileSync(brief, DRIVER_BRIEF);
    assert.equal(checkBrief(brief, undefined, 0, { store: fx.store }).exitCode, 0);
    assert.equal(fx.cmd(['handoff', 'launch', brief]).exitCode, 0);
    const answer = continueBrief(brief, { chainOf, cwd: fx.dir, env: fx.env, home: fx.home, wait: () => {}, run: fx.claude.run });
    assert.equal(answer.out[0], 'continue: background', answer.out.join('\n'));
    assert.equal(fx.claude.starts().length, maxParallel + 1, 'the continuation started');
    // Any other start record of the driver's still waits for the host: its continuation's, which the ledger does not
    // record, and an issue's once the run ended or custody moved.
    const continuation = readStarted(fx.store, DRIVER);
    assert.equal(continuation?.id, STARTED[maxParallel].id);
    assert.equal(drivenRunStart(DRIVER, continuation, { env: fx.env, home: fx.home }), false);
    assert.equal(drivenRunStart(DRIVER, { ...continuation, id: STARTED[0].id, project: { run: 'launch', issue: 'ENG-1', attempt: 1 } }, { env: fx.env, home: fx.home }), true);
    assert.equal(drivenRunStart(DRIVER, { ...continuation, id: STARTED[0].id, project: { run: 'launch', issue: 'ENG-1', attempt: 2 } }, { env: fx.env, home: fx.home }), false, 'another attempt');
    assert.equal(drivenRunStart(OTHER, { ...continuation, id: STARTED[0].id, project: { run: 'launch', issue: 'ENG-1', attempt: 1 } }, { env: fx.env, home: fx.home }), false, 'a session with no driver mark');
    assert.equal(drivenRunStart(DRIVER, { ...continuation, id: STARTED[3].id, project: { run: 'launch', issue: 'ENG-1', attempt: 1 } }, { env: fx.env, home: fx.home }), false, 'the same run, issue, and attempt under another session id');
  });
}

// A start record passes only when one started row names its session id, issue, and attempt, in its own run: a record
// that copies an issue's run, issue, and attempt under the id of another session still waits for the host.
test('recordsStart matches the started row\'s session id, as well as its run, issue, and attempt', () => {
  const rows = [{ event: 'start', key: 'ENG-1', attempt: 1, outcome: 'started', id: STARTED[0].id }];
  const record = (id, project = { run: 'launch', issue: 'ENG-1', attempt: 1 }) => ({ id, project });
  assert.equal(recordsStart(rows, 'launch', record(STARTED[0].id)), true, 'the row\'s own session');
  assert.equal(recordsStart(rows, 'launch', record(STARTED[1].id)), false, 'the same run, issue, and attempt under another session id');
  assert.equal(recordsStart(rows, 'launch', record(STARTED[0].id, { run: 'other', issue: 'ENG-1', attempt: 1 })), false, 'another run');
  assert.equal(recordsStart(rows, 'other', record(STARTED[0].id)), false, 'a run the record does not name');
  assert.equal(recordsStart([{ ...rows[0], outcome: 'pending' }], 'launch', record(STARTED[0].id)), false, 'a row that did not start it');
  assert.equal(recordsStart(rows, 'launch', record(undefined)), false, 'a record with no id');
});

// Hands the run on from `session` with a brief of its own bytes: `aidrian project handoff`, then the background route.
function handOff(fx, session, name, extra = '') {
  const brief = path.join(fx.state, 'handoffs', `2026-11-19-${name}.md`);
  mkdirSync(path.dirname(brief), { recursive: true });
  writeFileSync(brief, DRIVER_BRIEF.replace('- Finish the run.', `- Finish the run.${extra}`));
  assert.equal(checkBrief(brief, undefined, 0, { store: fx.store }).exitCode, 0);
  assert.equal(fx.cmd(['handoff', 'launch', brief], { session }).exitCode, 0);
  return continueBrief(brief, { chainOf, cwd: fx.dir, env: fx.as(session), home: fx.home, wait: () => {}, run: fx.claude.run });
}

test('only the current driver of a live run passes its issues\' starts: after its handoff, a second handoff and its own next start are held while the continuation runs', (t) => {
  const fx = runFixture(t, { ...parallel(3), config: { session: { handoff: { continue: 'background' } } } });
  for (const key of ['ENG-1', 'ENG-3']) assert.equal(fx.cmd(['start', 'launch', key]).exitCode, 0);
  assert.equal(handOff(fx, DRIVER, 'project-launch').out[0], 'continue: background');
  const continuation = STARTED[2];
  assert.equal(readStarted(fx.store, DRIVER)?.id, continuation.id);
  assert.equal(fx.claude.starts().length, 3);
  const issueStart = { ...readStarted(fx.store, DRIVER), id: STARTED[0].id, project: { run: 'launch', issue: 'ENG-1', attempt: 1 } };
  const passes = (session) => drivenRunStart(session, issueStart, { env: fx.env, home: fx.home });

  // A second handoff, of other bytes, is held by the one start record: its continuation runs.
  const second = handOff(fx, DRIVER, 'project-launch-again', '\n- Again.');
  assert.equal(second.out[0], 'continue: none', second.out.join('\n'));
  // The old driver's start of the issue next lists is held too: exit 1, no session, no forge read of the head.
  assert.equal(fx.cmd(['next', 'launch']).out[0], 'next ENG-4 fix/eng-4-typo');
  const heads = () => fx.forge.calls.filter(([kind]) => kind === 'branchHead').length;
  const before = heads();
  const held = fx.cmd(['start', 'launch', 'ENG-4']);
  assert.equal(held.exitCode, 1, held.err.join('\n'));
  assert.match(held.err[0], new RegExp(`this session's earlier start, ${continuation.id}, has not ended as the host lists it`, 'u'));
  assert.equal(fx.claude.starts().length, 3, 'no session started');
  assert.equal(heads(), before, 'no forge read of the head');

  // The continuation holds the driver mark before custody moves: not the run's driver yet.
  assert.equal(passes(continuation.session), false, 'a continuation before custody');
  // A session with a copy of the driver mark that names the real run: custody names another driver.
  markDriver(OTHER, { run: 'launch', root: fx.dir, state: fx.state, env: fx.env });
  assert.equal(passes(OTHER), false, 'a copied driver mark');
  assert.equal(passes(DRIVER), true, 'the current driver');
  // Custody moves on the continuation's first wait: the former driver passes no more, the new one does.
  assert.equal(fx.cmd(['wait', 'launch', '--max-wait', '0'], { session: continuation.session }).exitCode, 0);
  assert.equal(passes(DRIVER), false, 'a former driver after custody moved');
  assert.equal(passes(continuation.session), true, 'the new driver');
});

test('a run that ended passes no start record of its driver\'s', (t) => {
  const fx = runFixture(t, parallel(1, { issues: [ISSUES[0]] }));
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const record = readStarted(fx.store, DRIVER);
  assert.equal(drivenRunStart(DRIVER, record, { env: fx.env, home: fx.home }), true, 'a live run');
  // The run's end, as the driver's `end` writes it once nothing runs.
  appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'end', session: DRIVER, at: iso(Date.now()) }] }));
  assert.equal(drivenRunStart(DRIVER, record, { env: fx.env, home: fx.home }), false, 'an ended run');
});
