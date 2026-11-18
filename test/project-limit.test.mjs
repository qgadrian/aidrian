// A usage or rate limit an issue's session of a project run meets (lib/project-limit.mjs, lib/project-run-gate.mjs):
// each host adapter reads it from its own error record alone (lib/hosts/claude-code-limit.mjs, the Claude Code
// transcript's API error entry; lib/hosts/codex-exec.mjs logLimit, Codex's `turn.failed` in the run log), never from a
// tool's output or the model's text; `wait` stops the session, ends the attempt on the limit, and pauses the run until
// the reset time, clamped to 1 minute .. 6 hours, or a 15, 30, then 60 minute backoff when none is named; `start`
// refuses while the pause lasts, and afterwards starts the same issue again as a new attempt on its branch; past 24
// pauses a run halts instead. The record texts are fixtures from the hosts' issue reports and source, never seen live,
// so both adapters' reads stay unverified. The fixture is test/project-start-fixture.mjs.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { entryLimit, transcriptLimit } from '../plugins/aidrian/lib/hosts/claude-code-limit.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { logLimit } from '../plugins/aidrian/lib/hosts/codex-exec.mjs';
import { clockTime, durationTime, FAR } from '../plugins/aidrian/lib/hosts/limit-time.mjs';
import { BACKOFF, LIMIT_WAITS, limitEndRows, PAUSE_CEILING, PAUSE_FLOOR, pauseEnd, pauseOf } from '../plugins/aidrian/lib/project-limit.mjs';
import { appendToRun } from '../plugins/aidrian/lib/project-run.mjs';
import { waitRun } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { DRIVER, runFixture, STARTED } from './project-start-fixture.mjs';

const CHILD = STARTED[0].session;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 18, 10, 0, 0);

// The API error entry Claude Code writes in a transcript when a call fails for good, with `text` its own message.
const apiError = (text, more = {}) => ({ type: 'assistant', isApiErrorMessage: true, sessionId: CHILD, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] }, ...more });
const said = (text) => ({ type: 'assistant', sessionId: CHILD, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolOutput = (text) => ({ type: 'user', sessionId: CHILD, message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-limit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Writes `entries` as the session's transcript, where Claude Code keeps it: its config folder's projects folder, under
// the folder it started in, `cwd`.
function writeTranscript(config, cwd, entries, session = CHILD) {
  const folder = path.join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/gu, '-'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${session}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

test('Claude Code: only the host\'s own API error entry, as the last assistant entry, reports a limit, with its reset time', (t) => {
  const epoch = Math.floor(NOW / 1000) + 3600;
  assert.deepEqual(entryLimit(apiError(`Claude AI usage limit reached|${epoch}`), NOW), { kind: 'usage', until: epoch * 1000 });
  assert.deepEqual(entryLimit(apiError('5-hour limit reached ∙ resets 5pm (UTC)'), NOW), { kind: 'usage', until: Date.UTC(2026, 10, 18, 17, 0, 0) });
  assert.deepEqual(entryLimit(apiError('You\'ve hit your limit · resets 9am (UTC)'), NOW), { kind: 'usage', until: Date.UTC(2026, 10, 19, 9, 0, 0) }, 'a time already past today is tomorrow\'s');
  assert.deepEqual(entryLimit(apiError('Claude usage limit reached. Your limit will reset at 11:30am (Asia/Tokyo).'), NOW), { kind: 'usage', until: Date.UTC(2026, 10, 19, 2, 30, 0) }, 'a named zone');
  assert.deepEqual(entryLimit(apiError('Weekly limit reached ∙ resets Nov 21, 5pm'), NOW), { kind: 'usage', until: FAR }, 'another day is past any pause');
  assert.deepEqual(entryLimit(apiError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}'), NOW), { kind: 'rate', until: null });
  assert.deepEqual(entryLimit(apiError('API Error: Request rejected', { error: 'rate_limit' }), NOW), { kind: 'rate', until: null });
  assert.equal(entryLimit(apiError('API Error: 529 Overloaded'), NOW), null, 'an error that is no limit');
  assert.equal(entryLimit(said('Claude AI usage limit reached|1763481600'), NOW), null, 'the model\'s own text');

  const config = scratch(t);
  const cwd = '/work/runs/launch/attempts/ENG-1.1/work';
  const read = () => transcriptLimit({ session: CHILD, cwd, env: { CLAUDE_CONFIG_DIR: config }, now: NOW });
  writeTranscript(config, cwd, [said('working'), toolOutput('Claude AI usage limit reached|1763481600'), apiError(`Claude AI usage limit reached|${epoch}`)]);
  assert.deepEqual(read(), { kind: 'usage', until: epoch * 1000 });
  writeTranscript(config, cwd, [said('working'), toolOutput('Claude AI usage limit reached|1763481600')]);
  assert.equal(read(), null, 'a tool\'s output names no limit');
  writeTranscript(config, cwd, [apiError('Claude AI usage limit reached|1763481600'), said('back at work')]);
  assert.equal(read(), null, 'a limit the session got past');
  writeTranscript(config, '/elsewhere', [apiError(`Claude AI usage limit reached|${epoch}`)]);
  rmSync(path.join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/gu, '-')), { recursive: true });
  assert.deepEqual(read(), { kind: 'usage', until: epoch * 1000 }, 'the transcript in another project folder, as the host may name a long folder');
  const home = scratch(t);
  writeTranscript(path.join(home, '.claude'), cwd, [apiError('API Error: 429 rate limited')]);
  assert.deepEqual(transcriptLimit({ session: CHILD, cwd, env: {}, home, now: NOW }), { kind: 'rate', until: null }, 'the config folder in the home folder given');
  assert.equal(typeof claudeCode.capabilities.projectStart.limitOf, 'function');
});

test('Codex: only a turn.failed that ends the log reports a limit, with its reset time', (t) => {
  const dir = scratch(t);
  const log = path.join(dir, 'ENG-1.1.jsonl');
  const read = (events) => {
    writeFileSync(log, `codex: reading the prompt\n${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    return logLimit({ log, now: NOW });
  };
  const failed = (message) => ({ type: 'turn.failed', error: { message } });
  assert.deepEqual(read([{ type: 'thread.started', thread_id: 't1' }, failed('You\'ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 hours 5 minutes.')]), { kind: 'usage', until: NOW + 2 * HOUR + 5 * MINUTE });
  const at = read([failed('You\'ve hit your usage limit. Try again at 3:04 PM.')]);
  assert.equal(at.kind, 'usage');
  assert.equal(at.until, clockTime('3:04 PM', NOW), 'a clock time on this machine\'s clock');
  assert.deepEqual(read([failed('You\'ve hit your usage limit. Try again at Nov 21st, 2026 3:04 PM.')]), { kind: 'usage', until: FAR });
  assert.deepEqual(read([failed('exceeded retry limit, last status: 429 Too Many Requests')]), { kind: 'rate', until: null });
  assert.equal(read([{ type: 'error', message: 'You\'ve hit your usage limit. Try again in 5 minutes.' }]), null, 'a top-level error event, which Codex prints for a retry too');
  assert.equal(read([{ type: 'item.completed', item: { type: 'agent_message', text: 'You\'ve hit your usage limit.' } }]), null, 'the model\'s text');
  assert.equal(read([{ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'rate limit 429' } }]), null, 'a tool\'s output');
  assert.equal(read([failed('You\'ve hit your usage limit.'), { type: 'turn.completed' }]), null, 'a later turn that completed');
  assert.equal(read([failed('stream disconnected before completion')]), null, 'a failure that is no limit');
  assert.equal(logLimit({ log: path.join(dir, 'none.jsonl'), now: NOW }), null);
  assert.equal(typeof codex.capabilities.projectStart.limitOf, 'function');
});

test('reset times read in a clock, a span, and another day', () => {
  assert.equal(clockTime('5pm', NOW, 'UTC'), Date.UTC(2026, 10, 18, 17, 0, 0));
  assert.equal(clockTime('12am', NOW, 'UTC'), Date.UTC(2026, 10, 19, 0, 0, 0));
  assert.equal(clockTime('17:30', NOW, 'UTC'), Date.UTC(2026, 10, 18, 17, 30, 0));
  assert.equal(clockTime('13pm', NOW, 'UTC'), null);
  assert.equal(clockTime('Dec 1, 5pm', NOW, 'UTC'), FAR);
  assert.equal(clockTime('5pm', NOW, 'Not/AZone'), clockTime('5pm', NOW), 'an unknown zone reads as this machine\'s');
  assert.equal(durationTime('~37 min', NOW), NOW + 37 * MINUTE);
  assert.equal(durationTime('soon', NOW), null);
});

test('a pause lasts from 1 minute to 6 hours; with no reset time it backs off 15, 30, then 60 minutes', () => {
  assert.equal(pauseEnd({ kind: 'usage', until: NOW + 10 * HOUR }, 0, NOW), NOW + PAUSE_CEILING);
  assert.equal(pauseEnd({ kind: 'usage', until: FAR }, 0, NOW), NOW + PAUSE_CEILING);
  assert.equal(pauseEnd({ kind: 'usage', until: NOW - HOUR }, 0, NOW), NOW + PAUSE_FLOOR);
  assert.equal(pauseEnd({ kind: 'usage', until: NOW + 2 * HOUR }, 5, NOW), NOW + 2 * HOUR, 'a named time wins over the backoff');
  assert.deepEqual([0, 1, 2, 3, 9].map((streak) => pauseEnd({ kind: 'rate', until: null }, streak, NOW) - NOW), [BACKOFF[0], BACKOFF[1], BACKOFF[2], BACKOFF[2], BACKOFF[2]]);
  assert.deepEqual(BACKOFF, [15 * MINUTE, 30 * MINUTE, 60 * MINUTE]);
  assert.equal(PAUSE_CEILING, 6 * HOUR);
  assert.equal(LIMIT_WAITS, 24);

  const row = (minutes, more = {}) => ({ event: 'limit', key: 'ENG-1', attempt: 1, kind: 'rate', until: new Date(NOW + minutes * MINUTE).toISOString(), at: new Date(NOW).toISOString(), ...more });
  const streak = limitEndRows({ found: { rows: [row(-5), { event: 'result' }, row(-3), row(-1)] }, key: 'ENG-1', attempt: 2, limit: { kind: 'rate', until: null }, now: NOW });
  assert.equal(streak.until, NOW + BACKOFF[2], 'two limits since the last result: the third step');
  assert.deepEqual(pauseOf({ rows: [row(30), row(90), row(-1)] }, NOW), { until: new Date(NOW + 90 * MINUTE).toISOString(), key: 'ENG-1', kind: 'rate' }, 'the longest pause');
  assert.equal(pauseOf({ rows: [row(-1)] }, NOW), null);
  const capped = limitEndRows({ found: { rows: Array.from({ length: LIMIT_WAITS }, () => row(-1)) }, key: 'ENG-1', attempt: 1, limit: { kind: 'usage', until: null }, now: NOW });
  assert.equal(capped.until, null);
  assert.deepEqual(capped.rows.map((each) => each.event), ['ended', 'halt', 'issue']);
});

// A run whose ENG-1 started; `limit(entries)` writes its session's transcript.
function started(t, options) {
  const fx = runFixture(t, options);
  const start = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(start.exitCode, 0, start.err.join('\n'));
  const row = fx.rows().find((each) => each.event === 'start' && each.outcome === 'started');
  const limit = (entries) => writeTranscript(fx.env.CLAUDE_CONFIG_DIR, row.cwd, entries);
  return { ...fx, start: row, limit };
}

test('a simulated limit pauses the run, and the same issue starts again as a new attempt once the pause is over', (t) => {
  const fx = started(t);
  // The limit was met three hours ago, and its pause lasted two: the clock of each command says where in it it runs.
  const met = Date.now() - 3 * HOUR;
  const during = met + HOUR;
  const reset = Math.floor(met / 1000) + 2 * 3600;
  const until = new Date(reset * 1000).toISOString();
  fx.limit([said('working'), apiError(`Claude AI usage limit reached|${reset}`)]);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: met }).out, [`limit ENG-1 usage until ${until} -> open`, `paused until ${until}`, 'idle']);
  assert.deepEqual(fx.claude.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args[1]), [CHILD], 'the session, still listed working, is stopped');
  const [ended, paused] = fx.rows().filter((row) => ['ended', 'limit'].includes(row.event));
  assert.deepEqual([ended.reason, ended.kind, ended.attempt], ['limit', 'usage', 1]);
  assert.deepEqual([paused.until, paused.named, paused.wait], [until, true, 1]);

  const refused = fx.cmd(['start', 'launch', 'ENG-1'], { now: during });
  assert.equal(refused.exitCode, 1);
  assert.deepEqual(refused.out, [`paused until ${until}`]);
  assert.match(refused.err[0], /the run waits out a usage limit the session of ENG-1 met, until .*aidrian project wait launch/u);
  assert.equal(fx.claude.starts().length, 1, 'no session started');
  assert.equal(fx.cmd(['next', 'launch'], { now: during }).out[0], `paused until ${until}`);
  assert.deepEqual(JSON.parse(fx.cmd(['next', 'launch', '--json'], { now: during }).out[0]).pause, { until, key: 'ENG-1', kind: 'usage' });

  assert.deepEqual(fx.cmd(['next', 'launch']).out[0], 'next ENG-1 feat/eng-1-export', 'over once the reset time passed');
  const again = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(again.exitCode, 0, again.err.join('\n'));
  assert.ok(again.out.includes('started ENG-1 attempt 2 session c0ffee02'), again.out.join('\n'));
  const second = fx.rows().filter((row) => row.event === 'start' && row.outcome === 'started').at(-1);
  assert.deepEqual([second.attempt, second.branch], [2, 'feat/eng-1-export'], 'the same issue and branch');
  assert.notEqual(second.cwd, fx.start.cwd, 'in a fresh clone');
  const launched = fx.claude.starts().at(-1).args;
  assert.match(launched.at(-1), /Attempt 1 stopped when the host met a usage or rate limit: the branch feat\/eng-1-export on the forge holds the work it pushed/u);
  assert.doesNotMatch(fx.claude.starts()[0].args.at(-1), /usage or rate limit/u, 'a first attempt says nothing of a limit');
});

test('a limit with no reset time backs off, a session that ended is not stopped again, and a far reset is held to 6 hours', (t) => {
  const fx = started(t);
  fx.claude.states[CHILD] = 'done';
  fx.limit([apiError('API Error: 429 rate limited')]);
  const out = fx.cmd(['wait', 'launch', '--max-wait', '0']).out;
  const row = fx.rows().find((each) => each.event === 'limit');
  assert.equal(Date.parse(row.until) - Date.parse(row.at), 15 * MINUTE);
  assert.equal(row.named, false);
  assert.deepEqual(out, [`limit ENG-1 rate until ${row.until} -> open`, `paused until ${row.until}`, 'idle']);
  assert.equal(fx.claude.calls.filter((call) => call.args[0] === 'stop').length, 0);

  const far = started(t);
  far.limit([apiError('Weekly limit reached ∙ resets Dec 1, 5pm')]);
  far.cmd(['wait', 'launch', '--max-wait', '0']);
  const held = far.rows().find((each) => each.event === 'limit');
  assert.equal(Date.parse(held.until) - Date.parse(held.at), 6 * HOUR);
});

test('a session that handed its result over is not read for a limit, and one with no limit ends as before', (t) => {
  const fx = started(t);
  fx.limit([apiError('Claude AI usage limit reached|1763481600')]);
  const file = path.join(fx.root, 'result.json');
  writeFileSync(file, JSON.stringify({ status: 'failed', pr: null, stop: 'gave up' }));
  assert.equal(fx.cmd(['result', 'launch', 'ENG-1', '--file', file], { session: CHILD }).exitCode, 0);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['result ENG-1 failed -> open', 'idle']);

  const plain = started(t);
  plain.limit([said('done for now')]);
  plain.claude.states[CHILD] = 'done';
  assert.deepEqual(plain.cmd(['wait', 'launch', '--max-wait', '0']).out, ['ended ENG-1 no_result -> open', 'idle']);
});

test('an idle wait waits out the pause with the driver and returns once it is over', (t) => {
  const fx = started(t);
  const reset = Math.floor(Date.now() / 1000) + 120;
  fx.limit([apiError(`Claude AI usage limit reached|${reset}`)]);
  fx.cmd(['wait', 'launch', '--max-wait', '0']);
  let clock = Date.now();
  const paused = [];
  const out = waitRun({
    project: fx.project, config: fx.config, run: 'launch', maxWait: 540, env: fx.as(DRIVER), home: fx.home, forge: fx.forge, spawn: fx.claude.run, now: clock,
    clock: () => clock, pause: (ms) => {
      paused.push(ms);
      clock += ms;
    },
  }).out;
  assert.deepEqual(out, ['idle']);
  assert.ok(clock >= reset * 1000 && clock < reset * 1000 + 30_000, 'it returned once the pause was over, not at its deadline');
  assert.ok(paused.every((ms) => ms <= 30_000));
});

test('past 24 pauses a run, the next limit halts it until an attended resume', (t) => {
  const fx = started(t);
  const past = new Date(Date.now() - HOUR).toISOString();
  appendToRun(fx.state, 'launch', () => ({ rows: Array.from({ length: LIMIT_WAITS }, (_, i) => ({ event: 'limit', key: 'ENG-4', attempt: 1, kind: 'usage', until: past, named: false, wait: i + 1, at: past })) }));
  fx.limit([apiError('Claude AI usage limit reached|1763481600')]);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['limit ENG-1 usage halt -> open', 'idle']);
  const halted = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(halted.exitCode, 1);
  assert.match(halted.out[0], /^halt the run is halted: the run waited out 24 usage or rate limits, the most a run waits, and ENG-1 attempt 1 met another/u);
});
