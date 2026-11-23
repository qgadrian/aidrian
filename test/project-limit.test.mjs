// A usage or rate limit an issue's session of a project run meets (lib/project-limit.mjs, lib/project-run-gate.mjs):
// each host adapter reads it from its own error record alone (lib/hosts/claude-code-limit.mjs, the Claude Code
// transcript's API error entry; lib/hosts/codex-exec.mjs logLimit, Codex's `turn.failed` in the run log), never from a
// tool's output or the model's text, and reads its reset time against the record's own time. `wait` pauses the run
// until the reset, clamped to 1 minute .. 6 hours, or a 15, 30, then 60 minute backoff when none is named; a limit met
// while a pause lasts joins it. A Claude Code session the host still lists running keeps running, as the host continues
// it at the reset; one that ended, or one of a host that does not continue, is stopped and its attempt ends on the
// limit, which counts toward no cap of the issue. `start` of any issue refuses while the pause lasts, and afterwards
// starts the same issue again as a new attempt on its branch; past 24 pauses a run halts instead. The record texts are
// fixtures from the hosts' issue reports, binary, and source, never seen live, so both adapters' reads stay unverified.
// The fixture is test/project-start-fixture.mjs.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noteStarted } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { entryLimit, resetOf, transcriptLimit } from '../plugins/aidrian/lib/hosts/claude-code-limit.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { logLimit } from '../plugins/aidrian/lib/hosts/codex-exec.mjs';
import { clockTime, durationTime, FAR } from '../plugins/aidrian/lib/hosts/limit-time.mjs';
import { BACKOFF, checkedLimit, LIMIT_WAITS, limitEndRows, PAUSE_CEILING, PAUSE_FLOOR, pauseEnd, pauseOf, pausedTime, pauseRow, recordedPauseRuns, RESUME_CEILING, RESUME_GRACE } from '../plugins/aidrian/lib/project-limit.mjs';
import { appendToRun } from '../plugins/aidrian/lib/project-run.mjs';
import { waitRun } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { DRIVER, OTHER, runFixture, STARTED } from './project-start-fixture.mjs';

const CHILD = STARTED[0].session;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 18, 10, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

// The API error entry Claude Code writes in a transcript when a call fails for good, with `text` its own message.
const apiError = (text, more = {}) => ({ type: 'assistant', isApiErrorMessage: true, sessionId: CHILD, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] }, ...more });
const said = (text) => ({ type: 'assistant', sessionId: CHILD, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolOutput = (text) => ({ type: 'user', sessionId: CHILD, message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
const limitOnly = (answer) => answer && { kind: answer.kind, until: answer.until };

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
  writeFileSync(path.join(folder, `${session}.jsonl`), `${entries.map((entry) => JSON.stringify({ ...entry, sessionId: session })).join('\n')}\n`);
}

test('Claude Code: only the host\'s own API error entry, as the last assistant entry, reports a limit, with its reset time', (t) => {
  const epoch = Math.floor(NOW / 1000) + 3600;
  const read = (entry) => limitOnly(entryLimit(entry, NOW));
  assert.deepEqual(read(apiError(`Claude AI usage limit reached|${epoch}`)), { kind: 'usage', until: epoch * 1000 });
  assert.deepEqual(read(apiError('5-hour limit reached ∙ resets 5pm (UTC)')), { kind: 'usage', until: Date.UTC(2026, 10, 18, 17, 0, 0) });
  assert.deepEqual(read(apiError('You\'ve hit your limit · resets 9am (UTC)')), { kind: 'usage', until: Date.UTC(2026, 10, 19, 9, 0, 0) }, 'a time already past today is tomorrow\'s');
  assert.deepEqual(read(apiError('Claude usage limit reached. Your limit will reset at 11:30am (Asia/Tokyo).')), { kind: 'usage', until: Date.UTC(2026, 10, 19, 2, 30, 0) }, 'a named zone');
  assert.deepEqual(read(apiError('Weekly limit reached ∙ resets Nov 21, 5pm')), { kind: 'usage', until: FAR }, 'another day is past any pause');
  assert.deepEqual(read(apiError('You\'ve hit your limit · resets in 2 hours')), { kind: 'usage', until: NOW + 2 * HOUR }, 'a span after resets');
  for (const label of ['weekly', '5-hour', 'Opus']) {
    assert.deepEqual(read(apiError(`You've hit your ${label} limit · resets 5pm (UTC)`)), { kind: 'usage', until: Date.UTC(2026, 10, 18, 17, 0, 0) }, label);
  }
  assert.deepEqual(read(apiError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}')), { kind: 'rate', until: null });
  assert.deepEqual(read(apiError('Request rejected', { error: 'rate_limit' })), { kind: 'rate', until: null }, 'the structured class alone');
  assert.deepEqual(read(apiError('5-hour limit reached ∙ resets 5pm (UTC)', { error: 'rate_limit' })), { kind: 'usage', until: Date.UTC(2026, 10, 18, 17, 0, 0) });
  assert.equal(read(apiError('Claude AI usage limit reached|1763481600', { error: 'billing_error' })), null, 'a structured class that is no limit wins over the text');
  assert.equal(read(apiError('API Error: 400 {"error":{"message":"messages.429: text content blocks must be non-empty"}}')), null, 'a 429 that is no status');
  assert.equal(read(apiError('API Error: 529 Overloaded')), null, 'an error that is no limit');
  assert.equal(read(apiError('The tool said: usage limit reached')), null, 'limit words that do not start the text');
  assert.equal(read(said('Claude AI usage limit reached|1763481600')), null, 'the model\'s own text');

  const written = Date.UTC(2026, 10, 18, 15, 0, 0);
  const stamped = entryLimit(apiError('5-hour limit reached ∙ resets 3:04pm (UTC)', { timestamp: iso(written) }), written + 5 * MINUTE);
  assert.deepEqual(stamped, { kind: 'usage', until: written + 4 * MINUTE, at: written }, 'read against the entry\'s own time, not the read\'s');
  assert.equal(resetOf('limit reached|99', NOW), null, 'an epoch out of range names no time');

  const config = scratch(t);
  const cwd = '/work/runs/launch/attempts/ENG-1.1/work';
  const readFile = () => limitOnly(transcriptLimit({ session: CHILD, cwd, env: { CLAUDE_CONFIG_DIR: config }, now: NOW }));
  writeTranscript(config, cwd, [said('working'), toolOutput('Claude AI usage limit reached|1763481600'), apiError(`Claude AI usage limit reached|${epoch}`)]);
  assert.deepEqual(readFile(), { kind: 'usage', until: epoch * 1000 });
  writeTranscript(config, cwd, [said('working'), toolOutput('Claude AI usage limit reached|1763481600')]);
  assert.equal(readFile(), null, 'a tool\'s output names no limit');
  writeTranscript(config, cwd, [apiError('Claude AI usage limit reached|1763481600'), said('back at work')]);
  assert.equal(readFile(), null, 'a limit the session got past');
  writeTranscript(config, '/elsewhere', [apiError(`Claude AI usage limit reached|${epoch}`)]);
  rmSync(path.join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/gu, '-')), { recursive: true });
  assert.deepEqual(readFile(), { kind: 'usage', until: epoch * 1000 }, 'the transcript in another project folder, as the host may name a long folder');
  const home = scratch(t);
  writeTranscript(path.join(home, '.claude'), cwd, [apiError('API Error: 429 rate limited')]);
  assert.deepEqual(limitOnly(transcriptLimit({ session: CHILD, cwd, env: {}, home, now: NOW })), { kind: 'rate', until: null }, 'the config folder in the home folder given');
  const cap = claudeCode.capabilities.projectStart;
  assert.deepEqual([typeof cap.limitOf, cap.continuesAtLimit], ['function', true]);
});

test('Codex: only a turn.failed that ends the log reports a limit, with its reset time read against the log\'s last write', (t) => {
  const dir = scratch(t);
  const log = path.join(dir, 'ENG-1.1.jsonl');
  const written = Date.UTC(2026, 10, 18, 15, 0, 0);
  const read = (events, now = written) => {
    writeFileSync(log, `codex: reading the prompt\n${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    utimesSync(log, written / 1000, written / 1000);
    return logLimit({ log, now });
  };
  const failed = (message) => ({ type: 'turn.failed', error: { message } });
  assert.deepEqual(read([{ type: 'thread.started', thread_id: 't1' }, failed('You\'ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 hours 5 minutes.')]), { kind: 'usage', until: written + 2 * HOUR + 5 * MINUTE, at: written });
  // Codex prints the reset on this machine's clock: four minutes after the record, as this machine shows it.
  const shown = new Date(written + 4 * MINUTE);
  const clock = `${shown.getHours() % 12 || 12}:${String(shown.getMinutes()).padStart(2, '0')} ${shown.getHours() < 12 ? 'AM' : 'PM'}`;
  const later = read([failed(`You've hit your usage limit. Try again at ${clock}.`)], written + 5 * MINUTE);
  assert.equal(later.until, written + 4 * MINUTE, 'the clock time the record named, read when it was written: already past when read');
  assert.deepEqual(limitOnly(read([failed('You\'ve hit your usage limit. Try again at Nov 21st, 2026 3:04 PM.')])), { kind: 'usage', until: FAR });
  assert.deepEqual(limitOnly(read([failed('exceeded retry limit, last status: 429 Too Many Requests')])), { kind: 'rate', until: null });
  assert.equal(read([failed('unexpected status 400: messages.429 is invalid, rate limit unknown')]), null, 'a 429 that is no last status');
  assert.equal(read([{ type: 'error', message: 'You\'ve hit your usage limit. Try again in 5 minutes.' }]), null, 'a top-level error event, which Codex prints for a retry too');
  assert.equal(read([{ type: 'item.completed', item: { type: 'agent_message', text: 'You\'ve hit your usage limit.' } }]), null, 'the model\'s text');
  assert.equal(read([{ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'last status: 429' } }]), null, 'a tool\'s output');
  assert.equal(read([failed('You\'ve hit your usage limit.'), { type: 'turn.completed' }]), null, 'a later turn that completed');
  assert.equal(read([failed('stream disconnected before completion')]), null, 'a failure that is no limit');
  assert.equal(logLimit({ log: path.join(dir, 'none.jsonl'), now: NOW }), null);
  const cap = codex.capabilities.projectStart;
  assert.deepEqual([typeof cap.limitOf, cap.continuesAtLimit], ['function', undefined], 'no setting known continues a Codex session at the reset');
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

test('a pause lasts from 1 minute to 6 hours, backs off 15, 30, then 60 minutes, and a limit met during one joins it', () => {
  assert.equal(pauseEnd({ kind: 'usage', until: NOW + 10 * HOUR }, 0, NOW), NOW + PAUSE_CEILING);
  assert.equal(pauseEnd({ kind: 'usage', until: FAR }, 0, NOW), NOW + PAUSE_CEILING);
  assert.equal(pauseEnd({ kind: 'usage', until: NOW - HOUR }, 0, NOW), NOW + PAUSE_FLOOR);
  assert.equal(pauseEnd({ kind: 'usage', until: NOW + 2 * HOUR }, 5, NOW), NOW + 2 * HOUR, 'a named time wins over the backoff');
  assert.deepEqual([0, 1, 2, 3, 9].map((streak) => pauseEnd({ kind: 'rate', until: null }, streak, NOW) - NOW), [BACKOFF[0], BACKOFF[1], BACKOFF[2], BACKOFF[2], BACKOFF[2]]);
  assert.deepEqual(BACKOFF, [15 * MINUTE, 30 * MINUTE, 60 * MINUTE]);
  assert.deepEqual([PAUSE_CEILING, LIMIT_WAITS], [6 * HOUR, 24]);
  assert.equal(checkedLimit({ kind: 'billing', until: null }), null, 'a kind the run does not know');
  assert.deepEqual(checkedLimit({ kind: 'rate', until: 'soon', at: 'then' }), { kind: 'rate', until: null, at: null, after: null });

  const row = (wait, from, to, more = {}) => ({ event: 'limit', key: 'ENG-1', attempt: 1, kind: 'rate', wait, at: iso(NOW + from * MINUTE), until: iso(NOW + to * MINUTE), ...more });
  const rate = { kind: 'rate', until: null, at: null };
  const streak = pauseRow({ found: { rows: [row(1, -90, -80), { event: 'result' }, row(2, -60, -50), row(3, -40, -30)] }, key: 'ENG-1', attempt: 2, limit: rate, now: NOW });
  assert.equal(streak.until, NOW + BACKOFF[2], 'two pauses since the last result: the third step');
  assert.equal(streak.row.wait, 4);
  const joined = pauseRow({ found: { rows: [row(1, -10, 30)] }, key: 'ENG-4', attempt: 1, limit: rate, now: NOW });
  assert.deepEqual([joined.row.wait, joined.row.joined, joined.until], [1, true, NOW + 30 * MINUTE], 'joins the lasting pause, no backoff step');
  const longer = pauseRow({ found: { rows: [row(1, -10, 30)] }, key: 'ENG-4', attempt: 1, limit: { kind: 'usage', until: NOW + 2 * HOUR, at: null }, now: NOW });
  assert.deepEqual([longer.row.wait, longer.until], [1, NOW + 2 * HOUR], 'a named later reset moves the pause\'s end');
  assert.deepEqual(pauseOf({ rows: [row(1, -10, 30), row(1, -5, 90, { key: 'ENG-4' }), row(2, -100, -1)] }, NOW), { until: iso(NOW + 90 * MINUTE), key: 'ENG-4', kind: 'rate', wait: 1 }, 'the longest pause');
  assert.equal(pauseOf({ rows: [row(1, -10, -1)] }, NOW), null);
  assert.equal(pausedTime({ rows: [row(1, -60, -30), row(2, -40, -20), row(3, 10, 20)] }, NOW - 50 * MINUTE, NOW), 30 * MINUTE, 'overlapping pauses count once, and only within the span');
  const capped = limitEndRows({ found: { rows: Array.from({ length: LIMIT_WAITS }, (_, i) => row(i + 1, -100, -99)) }, key: 'ENG-1', attempt: 2, limit: rate, now: NOW });
  assert.equal(capped.until, null);
  assert.deepEqual(capped.rows.map((each) => each.event), ['ended', 'halt', 'issue']);
  const many = limitEndRows({ found: { rows: Array.from({ length: LIMIT_WAITS }, () => row(1, -100, -99)) }, key: 'ENG-1', attempt: 2, limit: rate, now: NOW });
  assert.deepEqual(many.rows.map((each) => each.event), ['ended', 'limit', 'issue'], 'rows of one pause count once');
  const again = limitEndRows({ found: { rows: [row(1, -10, 30)] }, key: 'ENG-1', attempt: 1, limit: rate, now: NOW });
  assert.deepEqual(again.rows.map((each) => each.event), ['ended', 'issue'], 'a record already paused on writes no second pause');
});

// A run whose ENG-1 started; `limit(entries, row)` writes the transcript of the session `row` started.
function started(t, options) {
  const fx = runFixture(t, options);
  const start = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(start.exitCode, 0, start.err.join('\n'));
  const latest = () => fx.rows().filter((each) => each.event === 'start' && each.outcome === 'started').at(-1);
  const limit = (entries, row = latest()) => writeTranscript(fx.env.CLAUDE_CONFIG_DIR, row.cwd, entries, row.child);
  return { ...fx, start: latest(), latest, limit };
}

// The fixture's Claude Code as a host that does not continue a session at the reset, for the test `t`.
function noContinue(t) {
  const cap = claudeCode.capabilities.projectStart;
  const kept = cap.continuesAtLimit;
  cap.continuesAtLimit = false;
  t.after(() => {
    cap.continuesAtLimit = kept;
  });
}

test('a running session the host continues keeps running through the pause, which refuses every start; once it ended, the same issue starts again', (t) => {
  const fx = started(t);
  // The limit was met three hours ago, and its pause lasted two: the clock of each command says where in it it runs.
  const met = Date.now() - 3 * HOUR;
  const during = met + HOUR;
  const reset = Math.floor(met / 1000) + 2 * 3600;
  const until = iso(reset * 1000);
  fx.limit([said('working'), apiError(`Claude AI usage limit reached|${reset}`, { timestamp: iso(met) })]);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: met }).out, [`paused ENG-1 usage until ${until}: its session goes on once the limit resets`, 'running ENG-1', `paused until ${until}`]);
  assert.deepEqual(fx.claude.calls.filter((call) => call.args[0] === 'stop'), [], 'the session is not stopped');
  assert.equal(fx.run().states.get('ENG-1').state, 'running');
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: during }).out, ['running ENG-1', `paused until ${until}`], 'the same record writes nothing again');
  const paused = fx.rows().filter((row) => row.event === 'limit');
  assert.deepEqual(paused.map((row) => [row.until, row.named, row.wait]), [[until, true, 1]]);

  fx.claude.states[CHILD] = 'done';
  const refused = fx.cmd(['start', 'launch', 'ENG-4'], { now: during });
  assert.equal(refused.exitCode, 1);
  assert.deepEqual(refused.out, [`paused until ${until}`]);
  assert.match(refused.err[0], /the run waits out a usage limit the session of ENG-1 met, until .*aidrian project wait launch/u, 'another issue waits too');
  assert.equal(fx.cmd(['next', 'launch'], { now: during }).out[0], `paused until ${until}`);
  assert.deepEqual(JSON.parse(fx.cmd(['next', 'launch', '--json'], { now: during }).out[0]).pause, { until, key: 'ENG-1', kind: 'usage', wait: 1 });

  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: during }).out, [`limit ENG-1 usage until ${until} -> open`, `paused until ${until}`, 'idle'], 'a session that ended on the limit ends its attempt');
  assert.equal(fx.rows().filter((row) => row.event === 'limit').length, 1, 'its pause is the one written');
  assert.equal(fx.claude.starts().length, 1, 'no session started while paused');

  assert.equal(fx.cmd(['next', 'launch']).out[0], 'next ENG-1 feat/eng-1-export', 'over once the reset time passed');
  const again = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(again.exitCode, 0, again.err.join('\n'));
  assert.ok(again.out.includes('started ENG-1 attempt 2 session c0ffee02'), again.out.join('\n'));
  const second = fx.latest();
  assert.deepEqual([second.attempt, second.branch], [2, 'feat/eng-1-export'], 'the same issue and branch');
  assert.notEqual(second.cwd, fx.start.cwd, 'in a fresh clone');
  // Attempt 1 pushed nothing, so the forge has no branch to go on from: the retry is cut from the base tip, and its
  // task claims no pushed work.
  assert.doesNotMatch(fx.claude.starts().at(-1).args.at(-1), /usage or rate limit/u, 'no branch on the forge holds pushed work');
  assert.doesNotMatch(fx.claude.starts()[0].args.at(-1), /usage or rate limit/u, 'a first attempt says nothing of a limit');
});

test('a session the host continued is held until its first new answer: its own entry after the reset, and a grace after it', (t) => {
  const fx = started(t);
  const met = Date.now() - 3 * HOUR;
  const reset = Math.floor(met / 1000) + 3600;
  const resetAt = reset * 1000;
  const limited = apiError(`Claude AI usage limit reached|${reset}`, { timestamp: iso(met) });
  // The host's own entry when it continues the session at the reset; the model has not answered yet.
  const goOn = (at) => ({ type: 'user', sessionId: CHILD, timestamp: iso(at), message: { role: 'user', content: 'Continue from where you left off.' } });
  fx.limit([said('working'), limited]);
  assert.match(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: met }).out[0], /^paused ENG-1 usage until /u);
  fx.limit([said('working'), limited, goOn(resetAt + 10_000)]);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: resetAt + 2 * MINUTE }).out, ['running ENG-1'], 'read two minutes after the reset: held');
  assert.equal(fx.claude.states[CHILD], undefined, 'not stopped');
  // Its entry four minutes after the reset holds it five more, past the pause's own grace.
  fx.limit([said('working'), limited, goOn(resetAt + 4 * MINUTE)]);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: resetAt + 8 * MINUTE }).out, ['running ENG-1'], 'five minutes after its newest entry: held');
  assert.equal(RESUME_GRACE, 5 * MINUTE);
  const ended = fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: resetAt + 10 * MINUTE }).out;
  assert.match(ended[0], /^limit ENG-1 usage until \S+ -> open$/u, 'no answer five minutes after the newest entry: stopped');
  assert.equal(fx.claude.states[CHILD], 'stopped');

  // With no entry after the record, the grace runs from the pause's end alone.
  const quiet = started(t);
  quiet.limit([limited]);
  quiet.cmd(['wait', 'launch', '--max-wait', '0'], { now: met });
  assert.deepEqual(quiet.cmd(['wait', 'launch', '--max-wait', '0'], { now: resetAt + 2 * MINUTE }).out, ['running ENG-1']);
  assert.match(quiet.cmd(['wait', 'launch', '--max-wait', '0'], { now: resetAt + 6 * MINUTE }).out[0], /^limit ENG-1 usage until \S+ -> open$/u);

  // The reader names the newest dated entry after the limit record, and only one of the session's.
  const config = scratch(t);
  writeTranscript(config, '/w', [limited, goOn(resetAt + 10_000), { type: 'system' }]);
  const file = path.join(config, 'projects', '-w', `${CHILD}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: 'user', sessionId: 'other', timestamp: iso(resetAt + HOUR) })}\n`, { flag: 'a' });
  const read = resetAt + 2 * MINUTE;
  assert.equal(transcriptLimit({ session: CHILD, cwd: '/w', env: { CLAUDE_CONFIG_DIR: config }, now: read }).after, resetAt + 10_000);
  writeTranscript(config, '/w', [limited]);
  assert.equal(transcriptLimit({ session: CHILD, cwd: '/w', env: { CLAUDE_CONFIG_DIR: config }, now: read }).after, null);
  assert.deepEqual(checkedLimit({ kind: 'usage', until: null, at: 5, after: 'later' }), { kind: 'usage', until: null, at: 5, after: null });
});

test('the hold of a session the host continued has a ceiling: an entry dated ahead, or one with no session id, holds nothing, and entries that keep coming hold it at most 30 minutes past the pause', (t) => {
  const met = NOW - 10 * MINUTE;
  const end = NOW + HOUR;
  const found = { rows: [{ event: 'limit', key: 'ENG-1', attempt: 1, kind: 'usage', record: iso(met), named: true, at: iso(NOW - 9 * MINUTE), until: iso(end), wait: 1 }] };
  const held = (after, now) => recordedPauseRuns(found, 'ENG-1', 1, checkedLimit({ kind: 'usage', until: end, at: met, after }), now);
  assert.equal(RESUME_CEILING, 30 * MINUTE);
  assert.equal(held(end, end + 2 * MINUTE), true, 'the host\'s own entry at the reset: held');
  assert.equal(held(null, end + 6 * MINUTE), false, 'no entry: the grace past the pause alone');
  assert.equal(held(Date.parse('2099-01-01T00:00:00.000Z'), NOW + 30 * 24 * HOUR), false, 'an entry dated 2099, read 30 days later');
  assert.equal(held(Date.parse('2099-01-01T00:00:00.000Z'), end + 10 * MINUTE), true, 'dated ahead counts as the read time, within the ceiling');
  assert.equal(held(end + 28 * MINUTE, end + 29 * MINUTE), true, 'entries still coming, within the ceiling');
  assert.equal(held(end + 30 * MINUTE, end + 31 * MINUTE), false, 'entries still coming: released at the ceiling');
  assert.equal(held(NOW + 72 * HOUR - MINUTE, NOW + 72 * HOUR), false, 'entries every few minutes, three days on');

  // The reader keeps no entry dated ahead, nor one with no session id.
  const config = scratch(t);
  const limited = apiError(`Claude AI usage limit reached|${Math.floor(end / 1000)}`, { timestamp: iso(met) });
  writeTranscript(config, '/w', [limited, { type: 'system', subtype: 'informational', timestamp: '2099-01-01T00:00:00.000Z', sessionId: CHILD }]);
  assert.equal(transcriptLimit({ session: CHILD, cwd: '/w', env: { CLAUDE_CONFIG_DIR: config }, now: NOW }).after, null, 'dated ahead');
  writeFileSync(path.join(config, 'projects', '-w', `${CHILD}.jsonl`), `${[{ ...limited, sessionId: CHILD }, { type: 'system', subtype: 'informational', timestamp: iso(NOW - MINUTE) }].map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  assert.equal(transcriptLimit({ session: CHILD, cwd: '/w', env: { CLAUDE_CONFIG_DIR: config }, now: NOW }).after, null, 'no session id');
});

test('a held session whose entries keep coming is stopped at the ceiling, and issueHours applies to it again', (t) => {
  const fx = started(t, { projectRun: { allow: true, unverifiedHosts: true, issueHours: 2 } });
  const met = Date.now();
  const reset = Math.floor(met / 1000) + 3600;
  const resetAt = reset * 1000;
  const limited = apiError(`Claude AI usage limit reached|${reset}`, { timestamp: iso(met) });
  const entry = (at) => ({ type: 'user', sessionId: CHILD, timestamp: iso(at), message: { role: 'user', content: 'tick' } });
  fx.limit([said('working'), limited]);
  assert.match(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: met }).out[0], /^paused ENG-1 usage until /u);
  fx.limit([said('working'), limited, entry(resetAt + 25 * MINUTE)]);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: resetAt + 27 * MINUTE }).out, ['running ENG-1'], 'held within the ceiling');
  fx.limit([said('working'), limited, entry(resetAt + 31 * MINUTE)]);
  const out = fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: resetAt + 32 * MINUTE }).out;
  assert.match(out[0], /^limit ENG-1 usage until \S+ -> open$/u, 'released at the ceiling, and its attempt ends');
  assert.equal(fx.claude.states[CHILD], 'stopped');
});

test('time paused counts toward no issue\'s hours', (t) => {
  const fx = started(t, { projectRun: { allow: true, unverifiedHosts: true, issueHours: 2 } });
  const begun = Date.parse(fx.start.at);
  fx.limit([apiError('Claude AI usage limit reached', { timestamp: iso(begun) })]);
  fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: begun + MINUTE });
  fx.limit([said('back at work after the reset')]);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: begun + 2 * HOUR + 5 * MINUTE }).out, ['running ENG-1'], 'two hours and five minutes, fifteen of them paused');
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: begun + 2 * HOUR + 20 * MINUTE }).out, ['ended ENG-1 timeout -> open', 'idle']);
});

test('a reset already past when wait reads it waits the 1-minute floor', (t) => {
  const fx = started(t);
  fx.claude.states[CHILD] = 'done';
  const written = Date.now() - 10 * MINUTE;
  const clock = new Date(written + 4 * MINUTE).toISOString().slice(11, 16);
  fx.limit([apiError(`5-hour limit reached ∙ resets ${clock} (UTC)`, { timestamp: iso(written) })]);
  const read = written + 9 * MINUTE;
  fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: read });
  const row = fx.rows().find((each) => each.event === 'limit');
  assert.equal(Date.parse(row.until) - read, PAUSE_FLOOR);
});

test('a host that does not continue has its limited session stopped; one that cannot be stopped writes nothing', (t) => {
  noContinue(t);
  const fx = started(t);
  fx.limit([apiError('Claude AI usage limit reached|1763481600')]);
  const failing = (command, args, options) => (args[0] === 'stop' ? { status: 1, stdout: '', stderr: 'no' } : fx.claude.run(command, args, options));
  const before = fx.rows().length;
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { spawn: failing }).out, [`limited ENG-1 attempt 1: a session of it, ${STARTED[0].id}, could not be stopped; \`claude stop ${STARTED[0].id}\` stops it`, 'running ENG-1']);
  assert.equal(fx.rows().length, before, 'nothing written');
  const out = fx.cmd(['wait', 'launch', '--max-wait', '0']).out;
  assert.match(out[0], /^limit ENG-1 usage until \S+ -> open$/u);
  assert.deepEqual(fx.claude.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args[1]), [STARTED[0].id], 'stopped once the stop works');
});

test('a limited chain whose second session cannot be stopped is named by that session, not the one the start held', (t) => {
  noContinue(t);
  const fx = started(t);
  fx.limit([apiError('Claude AI usage limit reached|1763481600')]);
  // A continuation of the session the run started, which the host lists working while it lists the first one ended.
  const next = { id: 'beef0001', session: 'beef0001-0000-4000-8000-00000000be01' };
  const brief = path.join(fx.state, 'handoffs', '2026-11-17-eng-1.md');
  mkdirSync(path.dirname(brief), { recursive: true, mode: 0o700 });
  writeFileSync(brief, '# Handoff\n');
  noteStarted(fx.store, CHILD, { sha256: 'a'.repeat(64), slug: 'eng-1', brief, chain: 1, id: next.id, session: next.session, name: null, cwd: fx.dir });
  fx.claude.sessions.push({ id: next.id, sessionId: next.session, name: 'eng-1', kind: 'background', cwd: fx.dir });
  fx.claude.states[CHILD] = 'done';
  const failing = (command, args, options) => (args[0] === 'stop' ? { status: 1, stdout: '', stderr: 'no' } : fx.claude.run(command, args, options));
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { spawn: failing }).out, [`limited ENG-1 attempt 1: a session of it, ${next.id}, could not be stopped; \`claude stop ${next.id}\` stops it`, 'running ENG-1']);
});

test('a limit with no reset time backs off, and a far reset is held to 6 hours', (t) => {
  const fx = started(t);
  fx.claude.states[CHILD] = 'done';
  fx.limit([apiError('API Error: 429 rate limited')]);
  const out = fx.cmd(['wait', 'launch', '--max-wait', '0']).out;
  const row = fx.rows().find((each) => each.event === 'limit');
  assert.equal(Date.parse(row.until) - Date.parse(row.at), 15 * MINUTE);
  assert.equal(row.named, false);
  assert.deepEqual(out, [`limit ENG-1 rate until ${row.until} -> open`, `paused until ${row.until}`, 'idle']);
  assert.equal(fx.claude.calls.filter((call) => call.args[0] === 'stop').length, 0, 'a session that ended is not stopped again');

  const far = started(t);
  far.limit([apiError('Weekly limit reached ∙ resets Dec 1, 5pm')]);
  far.cmd(['wait', 'launch', '--max-wait', '0']);
  const held = far.rows().find((each) => each.event === 'limit');
  assert.equal(Date.parse(held.until) - Date.parse(held.at), 6 * HOUR);
});

test('limited attempts spend none of the issue\'s three: three limits, or one ended with no result and two limits, leave it open', (t) => {
  for (const firstLimited of [true, false]) {
    const fx = runFixture(t);
    // Each limit is met in the past, seven hours apart, so every pause is over before the next start.
    const T0 = Date.now() - 30 * HOUR;
    for (let n = 1; n <= 3; n += 1) {
      const start = fx.cmd(['start', 'launch', 'ENG-1']);
      assert.equal(start.exitCode, 0, start.err.join('\n'));
      const row = fx.rows().filter((each) => each.event === 'start' && each.outcome === 'started').at(-1);
      const limited = firstLimited || n > 1;
      writeTranscript(fx.env.CLAUDE_CONFIG_DIR, row.cwd, [limited ? apiError('Weekly limit reached ∙ resets Dec 1, 5pm') : said('gave up')], row.child);
      fx.claude.states[row.child] = 'done';
      const line = fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: T0 + (n - 1) * 7 * HOUR }).out[0];
      assert.match(line, limited ? /^limit ENG-1 usage until \S+ -> open$/u : /^ended ENG-1 no_result -> open$/u, line);
    }
    assert.equal(fx.run().states.get('ENG-1').state, 'open');
    const fourth = fx.cmd(['start', 'launch', 'ENG-1']);
    assert.equal(fourth.exitCode, 0, fourth.err.join('\n'));
    assert.ok(fourth.out.includes(`started ENG-1 attempt 4 session ${STARTED[3].id}`), fourth.out.join('\n'));
  }
});

test('two running issues limited in one wait make one pause', (t) => {
  const fx = started(t);
  const other = { ...fx.start, key: 'ENG-4', branch: 'fix/eng-4-typo', child: STARTED[1].session, id: STARTED[1].id, cwd: path.join(fx.root, 'eng-4'), name: 'launch · ENG-4 · 1', at: iso(Date.now()) };
  appendToRun(fx.state, 'launch', () => ({ rows: [other, { event: 'issue', key: 'ENG-4', state: 'running', at: other.at }] }));
  const reset = Math.floor(Date.now() / 1000) + 2 * 3600;
  fx.limit([apiError(`Claude AI usage limit reached|${reset}`)], fx.start);
  fx.limit([apiError('You\'ve hit your weekly limit')], other);
  const out = fx.cmd(['wait', 'launch', '--max-wait', '0']).out;
  assert.equal(out.filter((line) => line.startsWith('paused ENG-')).length, 2, out.join('\n'));
  const rows = fx.rows().filter((row) => row.event === 'limit');
  assert.deepEqual(rows.map((row) => [row.key, row.wait, row.joined ?? false]), [['ENG-1', 1, false], ['ENG-4', 1, true]]);
  assert.deepEqual(rows.map((row) => row.until), [iso(reset * 1000), iso(reset * 1000)], 'no backoff step for the one that joined');
});

test('a running session is held only for a usage limit whose pause runs: a rate limit, or a record unchanged after its pause, ends the attempt', (t) => {
  const rate = started(t);
  rate.limit([apiError('API Error: 429 rate limited')]);
  assert.match(rate.cmd(['wait', 'launch', '--max-wait', '0']).out[0], /^limit ENG-1 rate until \S+ -> open$/u);
  assert.deepEqual(rate.claude.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args[1]), [STARTED[0].id], 'a rate limit is no limit the host continues');

  // The host lists each limited session working and never continues it: three such limits leave the issue open.
  const fx = runFixture(t);
  for (let n = 1; n <= 3; n += 1) {
    const start = fx.cmd(['start', 'launch', 'ENG-1']);
    assert.equal(start.exitCode, 0, start.err.join('\n'));
    const row = fx.rows().filter((each) => each.event === 'start' && each.outcome === 'started').at(-1);
    const begun = Date.parse(row.at);
    // Met twenty minutes before the start row's time, with no reset named: a 15-minute pause, over before now.
    writeTranscript(fx.env.CLAUDE_CONFIG_DIR, row.cwd, [apiError('Claude AI usage limit reached', { timestamp: iso(begun - 20 * MINUTE) })], row.child);
    assert.match(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: begun - 19 * MINUTE }).out[0], /^paused ENG-1 usage until /u);
    assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: begun - 4 * MINUTE + 30_000 }).out, ['running ENG-1'], 'held through the grace after the pause');
    const ended = fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: begun + 30 * MINUTE }).out;
    assert.match(ended[0], /^limit ENG-1 usage until \S+ -> open$/u, ended.join('\n'));
    assert.equal(fx.claude.states[row.child], 'stopped');
  }
  assert.equal(fx.rows().filter((row) => row.event === 'limit').length, 3, 'one pause a record, none written again at its end');
  assert.equal(fx.run().states.get('ENG-1').state, 'open');
});

test('a held session past 24 pauses writes one halt and ends its attempt; after an attended resume the next start runs', (t) => {
  const fx = started(t);
  const past = iso(Date.now() - HOUR);
  appendToRun(fx.state, 'launch', () => ({ rows: Array.from({ length: LIMIT_WAITS }, (_, i) => ({ event: 'limit', key: 'ENG-4', attempt: 1, kind: 'usage', until: past, named: false, wait: i + 1, at: past })) }));
  fx.limit([apiError(`Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 7200}`, { timestamp: iso(Date.now()) })]);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['limit ENG-1 usage halt -> open', 'idle']);
  assert.equal(fx.claude.states[CHILD], 'stopped', 'a halted run holds no session');
  for (let n = 0; n < 3; n += 1) assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['idle']);
  assert.equal(fx.rows().filter((row) => row.event === 'halt').length, 1);
  assert.match(fx.cmd(['start', 'launch', 'ENG-4']).out[0], /^halt the run is halted/u);
  const resumed = fx.cmd(['resume', 'launch'], { session: OTHER });
  assert.equal(resumed.exitCode, 0, resumed.err.join('\n'));
  const next = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(next.exitCode, 0, next.err.join('\n'));
  assert.ok(next.out.includes('started ENG-1 attempt 2 session c0ffee02'), next.out.join('\n'));
});

test('an idle wait waits out the pause with the driver and returns once it is over', (t) => {
  const fx = started(t);
  fx.claude.states[CHILD] = 'done';
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

test('a session that handed its result over is not read for a limit, and one with no limit ends as before', (t) => {
  const fx = started(t);
  fx.limit([apiError('Claude AI usage limit reached|1763481600')]);
  const file = path.join(fx.root, 'result.json');
  writeFileSync(file, JSON.stringify({ status: 'failed', pr: null, stop: 'gave up' }));
  assert.equal(fx.cmd(['result', 'launch', 'ENG-1', '--file', file], { session: CHILD }).exitCode, 0);
  // No limit line: its session, which the host still lists working, runs on after the issue settled.
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['result ENG-1 failed -> open', 'lingering ENG-1 attempt 1']);

  const plain = started(t);
  plain.limit([said('done for now')]);
  plain.claude.states[CHILD] = 'done';
  assert.deepEqual(plain.cmd(['wait', 'launch', '--max-wait', '0']).out, ['ended ENG-1 no_result -> open', 'idle']);
});

test('past 24 pauses a run, the next limit halts it until an attended resume', (t) => {
  const fx = started(t);
  fx.claude.states[CHILD] = 'done';
  const past = iso(Date.now() - HOUR);
  appendToRun(fx.state, 'launch', () => ({ rows: Array.from({ length: LIMIT_WAITS }, (_, i) => ({ event: 'limit', key: 'ENG-4', attempt: 1, kind: 'usage', until: past, named: false, wait: i + 1, at: past })) }));
  fx.limit([apiError('Claude AI usage limit reached|1763481600')]);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['limit ENG-1 usage halt -> open', 'idle']);
  const halted = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(halted.exitCode, 1);
  assert.match(halted.out[0], /^halt the run is halted: the run waited out 24 usage or rate limits, the most a run waits, and ENG-1 attempt 1 met another/u);
});
