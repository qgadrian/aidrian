import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import {
  BRIEF_CALLS, handoffCost, handoffReason, handoffStatus, nextRatio, planApprovedContext, readMarker, RESUME_TOKENS, sessionUsage, stopReminder, tokenCeiling,
} from '../plugins/aidrian/lib/session-length.mjs';
import { CACHE_READ_MULT, CACHE_WRITE_1H_MULT, CACHE_WRITE_5M_MULT, priceFor } from '../plugins/aidrian/lib/model-prices.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-stop.mjs');
const PLAN_HOOK = path.join(path.dirname(HOOK), 'hook-plan-exit.mjs');
const OPUS = 'claude-opus-5-5';

// One transcript line: an assistant API request whose context is `context` tokens, written to 1-hour cache unless
// `fiveMinute`, or (no id) a plain entry with a timestamp.
let minute = 0;
const call = (id, context, { model = OPUS, fiveMinute = false } = {}) => {
  const write = Math.min(500, context - 1);
  const created = fiveMinute ? { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 } : { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write };
  const usage = { input_tokens: 1, cache_read_input_tokens: context - 1 - write, cache_creation_input_tokens: write, cache_creation: created, output_tokens: 50 };
  minute += 1;
  return JSON.stringify({ timestamp: new Date(Date.UTC(2026, 10, 3, 9, minute)).toISOString(), message: { id, model, usage } });
};
const COMPACTION = JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 210_000 } });

// Two sessions of the same day, by their first and last call: their baselines W and the context C at which the old
// fixed limit reminded them. Both ran on claude-opus-5-5 with 1-hour cache.
const REVIEW_LOOP = { first: 58_676, last: 155_018 };
const DASHBOARD = { first: 59_754, last: 162_185 };
const usageOf = ({ first, last }, extra = {}) => ({ calls: 2, first, last, model: OPUS, oneHourCache: true, compactions: 0, ...extra });

// N as docs/handoff.md writes it, from priceFor and the transcript multiples, with H = `briefCalls`.
function expectedBreakEven({ first, last }, { model = OPUS, write = CACHE_WRITE_1H_MULT, briefCalls = BRIEF_CALLS } = {}) {
  const read = priceFor(model)?.cacheRead ?? CACHE_READ_MULT;
  const fresh = first + RESUME_TOKENS;
  return (write * fresh + 5 * 3000 + briefCalls * read * last) / (read * (last - fresh));
}

test('the cost model reads the first and last call, the last model, 1-hour cache, and the compactions', () => {
  const text = [call('a', 5000), call('a', 5000), 'not json', COMPACTION, call('b', 7000, { model: 'claude-fable-5-1', fiveMinute: true })].join('\n');
  assert.deepEqual(sessionUsage(text), { calls: 2, first: 5000, last: 7000, model: 'claude-fable-5-1', oneHourCache: true, compactions: 1 });
  assert.deepEqual(sessionUsage(''), { calls: 0, first: 0, last: 0, model: null, oneHourCache: false, compactions: 0 });
  assert.equal(sessionUsage(call('a', 5000, { fiveMinute: true })).oneHourCache, false);
});

test('the two sessions the old limit reminded are under the default ratio, and reach it at twice their fresh cost', () => {
  for (const [session, ratio] of [[REVIEW_LOOP, 1.51], [DASHBOARD, 1.56]]) {
    const cost = handoffCost(usageOf(session));
    assert.equal(Number(cost.ratio.toFixed(2)), ratio);
    assert.ok(Math.abs(cost.breakEven - expectedBreakEven(session)) < 1e-9);
    assert.equal(stopReminder([call('w', session.first), call('c', session.last)].join('\n'), DEFAULTS.session.handoff, null), null);
    const due = { ...session, last: 2 * (session.first + RESUME_TOKENS) };
    assert.equal(handoffCost(usageOf(due)).ratio, 2);
    const reminder = stopReminder([call('w', due.first), call('c', due.last)].join('\n'), DEFAULTS.session.handoff, null);
    assert.match(reminder.reason, new RegExp(`each call costs 2\\.0 times .* about ${Math.round(expectedBreakEven(due))} more model calls`));
  }
});

test('the break-even uses the model cache-read multiple, 0.1 for an unknown model, and the 5-minute write multiple', () => {
  assert.equal(priceFor('claude-fable-5-1').cacheRead, 0.025);
  const fable = usageOf(REVIEW_LOOP, { model: 'claude-fable-5-1' });
  assert.ok(Math.abs(handoffCost(fable).breakEven - expectedBreakEven(REVIEW_LOOP, { model: 'claude-fable-5-1' })) < 1e-9);
  const unknown = handoffCost(usageOf(REVIEW_LOOP, { model: 'some-other-model' })).breakEven;
  const fresh = REVIEW_LOOP.first + RESUME_TOKENS;
  assert.ok(Math.abs(unknown - (2 * fresh + 15_000 + 8 * 0.1 * REVIEW_LOOP.last) / (0.1 * (REVIEW_LOOP.last - fresh))) < 1e-9);
  const fiveMinute = handoffCost(usageOf(REVIEW_LOOP, { oneHourCache: false })).breakEven;
  assert.ok(Math.abs(fiveMinute - expectedBreakEven(REVIEW_LOOP, { write: CACHE_WRITE_5M_MULT })) < 1e-9);
  assert.ok(fiveMinute < handoffCost(usageOf(REVIEW_LOOP)).breakEven, 'a 5-minute cache is cheaper to rebuild');
});

test('the brief-writing calls add H × C / (C − W − B) calls to the break-even', () => {
  const usage = usageOf(DASHBOARD);
  const without = handoffCost(usage, { briefCalls: 0 }).breakEven;
  const fresh = DASHBOARD.first + RESUME_TOKENS;
  assert.ok(Math.abs(handoffCost(usage).breakEven - without - (BRIEF_CALLS * DASHBOARD.last) / (DASHBOARD.last - fresh)) < 1e-9);
  assert.ok(Math.abs(without - expectedBreakEven(DASHBOARD, { briefCalls: 0 })) < 1e-9);
});

test('no usage, or a context no bigger than a fresh session, never fires the cost trigger', () => {
  assert.deepEqual(handoffCost(usageOf(REVIEW_LOOP, { calls: 0 })), { ratio: 0, breakEven: null });
  const small = usageOf({ first: 50_000, last: 94_000 });
  assert.equal(handoffCost(small).breakEven, null);
  const anyRatio = { mode: 'ask', costRatio: 0.5, maxTokens: 0 };
  assert.equal(stopReminder([call('w', 50_000), call('c', 94_000)].join('\n'), anyRatio, null), null);
  assert.equal(stopReminder('', anyRatio, null), null);
});

test('the cost trigger fires first at costRatio, then at twice its last ratio in ask or a step above it in auto; the ceiling doubles', () => {
  assert.deepEqual([0, 2, 2.5].map((last) => nextRatio(2, last)), [2, 4, 5]);
  assert.deepEqual([0, 1.51].map((last) => nextRatio(1.5, last)), [1.5, 3.02]);
  assert.equal(nextRatio(3, 1.2), 3, 'a costRatio raised above twice the last firing holds');
  assert.deepEqual([0, 2, 4.15].map((last) => nextRatio(2, last, 'auto')), [2, 3, 5.15], 'auto comes back in steps');
  assert.equal(nextRatio(3, 2.5, 'auto'), 4.5, 'the step is costRatio − 1');
  assert.equal(nextRatio(1.1, 1.2, 'auto'), 2.2, 'a step of at least one fresh session');
  assert.equal(nextRatio(1.5, 1.6, 'auto'), 2.6, 'a step of at least one fresh session');
  assert.deepEqual([0, 2].map((fired) => tokenCeiling(150_000, fired)), [150_000, 600_000]);
  assert.equal(tokenCeiling(0, 3), 0);
});

test('a marker holds the last cost ratio and the ceiling count; one an older version wrote counts as one firing of each', () => {
  assert.deepEqual(readMarker(null, 2, 2), { lastRatio: 0, tokens: 0, compactions: 0 });
  assert.deepEqual(readMarker('{"lastRatio": 2.5, "tokens": 1, "compactions": 1}\n', 3, 2), { lastRatio: 2.5, tokens: 1, compactions: 1 });
  assert.deepEqual(readMarker('{"ratio": 2, "tokens": 1, "compactions": 1}\n', 3, 2), { lastRatio: 2, tokens: 1, compactions: 1 }, 'a count from v0.28.0 to v0.47.0: a firing at costRatio');
  assert.deepEqual(readMarker('{"ratio": 0, "tokens": 0, "compactions": 0}\n', 0, 2), { lastRatio: 0, tokens: 0, compactions: 0 }, 'a marker from v0.28.0 to v0.47.0 with no cost firing');
  for (const old of ['ask\n', 'remind\n', '1\n', '3\n']) assert.deepEqual(readMarker(old, 2, 2), { lastRatio: 2, tokens: 1, compactions: 2 }, old);
});

test('both modes let the agent judge the handoff not worth it and say nothing; ask asks, auto writes the brief', () => {
  const cost = handoffCost(usageOf({ first: 58_676, last: 215_620 }));
  for (const mode of ['ask', 'auto']) {
    const reason = handoffReason(mode, { cost, next: ['each call costs 3 times what a fresh session\'s would'] });
    assert.match(reason, /^This session is long: each call costs 2\.1 times what it would in a fresh session started from a handoff brief, and a handoff pays back after about 54 more model calls, an estimate\./);
    assert.match(reason, /Judge first whether a handoff is worth it\. It is not when the task is done or nearly done/);
    assert.match(reason, /the work left takes fewer model calls than the handoff needs to pay back/);
    assert.match(reason, /subagent or background job is still running/);
    assert.match(reason, /the user already said to finish here or that they are not watching/);
    assert.match(reason, /end this turn without mentioning this reminder, which comes back once each call costs 3 times what a fresh session's would\./);
  }
  const ask = handoffReason('ask', { cost, next: ['x'] });
  assert.match(ask, /hand off now, or keep going\?/);
  assert.match(ask, /session-handoff skill/);
  const auto = handoffReason('auto', { cost, next: ['x'] });
  assert.match(auto, /run the session-handoff skill now/);
  assert.match(auto, /session-continue skill/);
  assert.doesNotMatch(auto, /keep going/);
});

test('the default is ask, at a cost ratio of 2, with no token ceiling, no continue route, a chain of 3, and measured resume tokens', () => {
  assert.deepEqual(DEFAULTS.session, { handoff: { mode: 'ask', costRatio: 2, maxTokens: 0, continue: 'none', maxChain: 3, resumeTokens: null } });
});

function setup(t, session) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-session-length-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, ...(session && { session }) }));
  const transcript = path.join(base, 'session.jsonl');
  // The session's first call, its fresh-start baseline: W + B is 102,676.
  writeFileSync(transcript, call('w', REVIEW_LOOP.first));
  let calls = 0;
  const reach = (...contexts) => appendFileSync(transcript, `\n${contexts.map((each) => (each === COMPACTION ? each : call(`c${(calls += 1)}`, each))).join('\n')}`);
  const temp = path.join(base, 'tmp');
  mkdirSync(temp);
  // The stop hook keeps its marker in the hooks' counts folder of its state root, never the temporary folder.
  const state = path.join(base, 'state');
  const counts = path.join(state, 'aidrian', 'hook-counts');
  const marker = path.join(counts, 'aidrian-session-length-abc-123');
  const markers = () => {
    try {
      return readdirSync(counts).filter((name) => name.startsWith('aidrian-session-length-'));
    } catch {
      return [];
    }
  };
  const stop = (fields, env = {}) => {
    const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc-123', transcript_path: transcript, cwd: dir, stop_hook_active: false, ...fields });
    const { status, stderr } = spawnSync(process.execPath, [HOOK], { input, cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: temp, XDG_STATE_HOME: state, ...env } });
    return { status, stderr };
  };
  const plan = (fields = {}, env = {}) => {
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', transcript_path: transcript, cwd: dir, ...fields });
    const { status, stdout } = spawnSync(process.execPath, [PLAN_HOOK], { input, cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(status, 0);
    return stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext : '';
  };
  // A temporary repository driven with `git -C`: no test sets GIT_DIR.
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { encoding: 'utf8' });
  return { stop, plan, reach, temp, marker, markers, counts: () => JSON.parse(readFileSync(marker, 'utf8')), transcript, dir, git };
}

const QUIET = { status: 0, stderr: '' };

test('ask mode fires once at the cost ratio with the question, then again only once the ratio doubles', (t) => {
  const { stop, reach, temp, counts, markers } = setup(t);
  reach(REVIEW_LOOP.last);
  assert.deepEqual(stop(), QUIET, 'r 1.51 is under the default 2');
  reach(205_352);
  const first = stop();
  assert.equal(first.status, 2);
  assert.match(first.stderr, /^This session is long: each call costs 2\.0 times .* about 59 more model calls.*hand off now, or keep going\?/s);
  assert.match(first.stderr, /comes back once each call costs 4 times/);
  assert.deepEqual(markers(), ['aidrian-session-length-abc-123']);
  assert.deepEqual(readdirSync(temp), [], 'never in the temporary folder');
  assert.deepEqual(counts(), { lastRatio: 2, tokens: 0, compactions: 0 });
  assert.deepEqual(stop(), QUIET, 'a later turn of the same session, under double');
  assert.equal(stop({ session_id: 'other' }).status, 2, 'another session counts on its own');
  reach(256_690);
  assert.deepEqual(stop(), QUIET, 'r 2.5 is under twice the last firing');
  reach(308_028);
  assert.deepEqual(stop(), QUIET, 'r 3.0 is under twice the last firing');
  reach(410_000);
  assert.deepEqual(stop(), QUIET, 'r 3.99 is under twice the last firing');
  reach(410_704);
  const again = stop();
  assert.match(again.stderr, /^This session is long: each call costs 4\.0 times/);
  assert.match(again.stderr, /comes back once each call costs 8 times/);
  assert.deepEqual(counts(), { lastRatio: 4, tokens: 0, compactions: 0 });
});

test('a costRatio of 1.5 fires at 1.5 and re-arms at twice the ratio it fired at', (t) => {
  const { stop, reach, counts } = setup(t, { handoff: { costRatio: 1.5 } });
  reach(REVIEW_LOOP.last);
  assert.match(stop().stderr, /each call costs 1\.5 times.*comes back once each call costs 3\.02 times/s);
  assert.deepEqual(counts(), { lastRatio: REVIEW_LOOP.last / 102_676, tokens: 0, compactions: 0 });
  reach(200_000);
  assert.deepEqual(stop(), QUIET, 'r 1.95');
  reach(205_352);
  assert.deepEqual(stop(), QUIET, 'r 2.0 is under twice 1.51');
  reach(2 * REVIEW_LOOP.last);
  assert.equal(stop().status, 2, 'exactly twice the ratio of the last firing');
  assert.deepEqual(counts(), { lastRatio: (2 * REVIEW_LOOP.last) / 102_676, tokens: 0, compactions: 0 });
});

test('the token ceiling fires on its own, with no cost in its message, and leaves the last cost ratio at 0', (t) => {
  const { stop, reach, counts } = setup(t, { handoff: { maxTokens: 100_000 } });
  reach(110_000);
  const { status, stderr } = stop();
  assert.equal(status, 2);
  assert.match(stderr, /^This session is long: 110k tokens of context\. A fresh session started from a handoff brief works from a smaller context\./);
  assert.match(stderr, /comes back once the context reaches 200k tokens\./);
  assert.doesNotMatch(stderr, /times|pays back|fewer model calls/);
  assert.deepEqual(counts(), { lastRatio: 0, tokens: 1, compactions: 0 });
  reach(150_000);
  assert.deepEqual(stop(), QUIET, 'under twice the ceiling');
  reach(205_352);
  assert.match(stop().stderr, /^This session is long: 205k tokens of context, and each call costs 2\.0 times/);
  assert.deepEqual(counts(), { lastRatio: 2, tokens: 2, compactions: 0 });
});

test('a compaction after a firing resets both triggers, so costRatio fires again', (t) => {
  const { stop, reach, counts } = setup(t, { handoff: { maxTokens: 200_000 } });
  reach(205_352);
  assert.equal(stop().status, 2);
  assert.deepEqual(counts(), { lastRatio: 2, tokens: 1, compactions: 0 });
  reach(206_000);
  assert.deepEqual(stop(), QUIET, 'no compaction: the next thresholds are r 4 and 400k');
  reach(COMPACTION, 205_352);
  assert.equal(stop().status, 2);
  assert.deepEqual(counts(), { lastRatio: 2, tokens: 1, compactions: 1 });
  assert.deepEqual(stop(), QUIET, 'the same compaction resets nothing again');
});

test('a marker an older version wrote counts as one firing of each trigger, the cost one at costRatio', (t) => {
  for (const old of ['ask\n', '2\n', '{"ratio":1,"tokens":1,"compactions":0}\n']) {
    const { stop, reach, marker, counts } = setup(t, { handoff: { maxTokens: 110_000 } });
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, old);
    reach(205_352);
    assert.deepEqual(stop(), QUIET, `${JSON.stringify(old)}: r 2.0 is under 4, and 205k under 220k`);
    reach(308_028);
    const ceiling = stop();
    assert.equal(ceiling.status, 2, `${JSON.stringify(old)}: the ceiling at 220k`);
    assert.doesNotMatch(ceiling.stderr, /times/, `${JSON.stringify(old)}: r 3.0 is under 4, so the ceiling fires alone`);
    assert.deepEqual(counts(), { lastRatio: 2, tokens: 2, compactions: 0 });
    reach(410_704);
    assert.match(stop().stderr, /each call costs 4\.0 times/, `${JSON.stringify(old)}: r 4.0`);
    assert.deepEqual(counts(), { lastRatio: 4, tokens: 2, compactions: 0 });
  }
});

test('auto mode, and a legacy "auto" string, send the agent back to write the brief', (t) => {
  for (const handoff of [{ mode: 'auto' }, 'auto']) {
    const { stop, reach } = setup(t, { handoff });
    reach(205_352);
    const { status, stderr } = stop();
    assert.equal(status, 2);
    assert.match(stderr, /^This session is long: each call costs 2\.0 times.*Otherwise run the session-handoff skill now/s);
  }
});

test('auto mode comes back one step above its last firing, 2, 3, 4 by default, not at double', (t) => {
  const { stop, reach, counts } = setup(t, { handoff: { mode: 'auto' } });
  reach(205_352);
  const first = stop();
  assert.equal(first.status, 2);
  assert.match(first.stderr, /comes back once each call costs 3 times/);
  assert.deepEqual(counts(), { lastRatio: 2, tokens: 0, compactions: 0 });
  reach(308_000);
  assert.deepEqual(stop(), QUIET, 'r 2.9997 is under one step above 2');
  reach(308_028);
  const again = stop();
  assert.equal(again.status, 2, 'r 3.0, under twice 2 but one step above it');
  assert.match(again.stderr, /each call costs 3\.0 times.*comes back once each call costs 4 times/s);
  assert.ok(Math.abs(counts().lastRatio - 3) < 1e-9);
});

test('auto mode at a costRatio of 1.1 steps by one fresh session, so a stop shortly after a firing stays quiet', (t) => {
  const { stop, reach, counts } = setup(t, { handoff: { mode: 'auto', costRatio: 1.1 } });
  reach(REVIEW_LOOP.last);
  assert.match(stop().stderr, /each call costs 1\.5 times.*comes back once each call costs 2\.51 times/s);
  assert.equal(counts().lastRatio, REVIEW_LOOP.last / 102_676);
  reach(170_000);
  assert.deepEqual(stop(), QUIET, 'r 1.66 is past a step of 0.1 but under a step of 1');
  reach(250_000);
  assert.deepEqual(stop(), QUIET, 'r 2.43');
  reach(257_700);
  assert.match(stop().stderr, /each call costs 2\.5 times.*comes back once each call costs 3\.51 times/s);
});

test('nothing happens when off, under costRatio, on the stop it caused, on another host, or outside a project', (t) => {
  for (const handoff of [{ mode: 'off' }, 'off']) {
    const off = setup(t, { handoff });
    off.reach(400_000);
    assert.deepEqual(off.stop(), QUIET, `off as ${JSON.stringify(handoff)}`);
    assert.equal(off.plan(), '', `the plan offer, off as ${JSON.stringify(handoff)}`);
  }
  const { stop, reach, temp, transcript, markers } = setup(t);
  assert.deepEqual(stop(), QUIET, 'under the default costRatio');
  reach(205_352);
  assert.deepEqual(stop({ stop_hook_active: true }), QUIET, 'the stop this hook caused');
  assert.deepEqual(stop({ stop_hook_active: undefined }), QUIET, 'a payload without stop_hook_active');
  assert.deepEqual(stop({ session_id: '../escape' }), QUIET, 'a session id that is not a plain name');
  assert.deepEqual(stop({ cwd: temp }), QUIET, 'outside a project');
  writeFileSync(transcript, `${JSON.stringify({ timestamp: '2026-11-03T09:00:00Z' })}\n`);
  assert.deepEqual(stop(), QUIET, 'a transcript with no Claude Code usage');
  assert.deepEqual(markers(), []);
});

test('SessionEnd deletes the reminder marker the Stop hook wrote for the session', (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'aidrian-end-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const session = 'end-marker-1';
  const counts = path.join(temp, 'aidrian', 'hook-counts');
  mkdirSync(counts, { recursive: true });
  writeFileSync(path.join(counts, `aidrian-session-length-${session}`), '{"ratio":1,"tokens":0,"compactions":0}\n');
  writeFileSync(path.join(counts, 'aidrian-session-length-other'), 'remind\n');
  const end = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-session-end.mjs');
  const env = { ...process.env, TMPDIR: temp, XDG_STATE_HOME: temp };
  spawnSync(process.execPath, [end], { input: JSON.stringify({ session_id: session, cwd: temp }), cwd: temp, env, encoding: 'utf8' });
  assert.deepEqual(readdirSync(counts).filter((name) => name.startsWith('aidrian-session-length-')), ['aidrian-session-length-other']);
});

test('an approved plan offers a handoff from a cost ratio of 1.5, not below; a subagent gets nothing', (t) => {
  const { plan, reach } = setup(t);
  reach(154_000);
  assert.equal(plan(), '', 'r 1.4999');
  reach(154_014);
  const offer = plan();
  assert.match(offer, /^The plan is approved, and each call costs 1\.5 times what it would in a fresh session.*hand off now, or build here\?/s);
  assert.match(offer, /Skip the question when the rest takes a few calls, or when the user already said to finish here or that they are not watching\./);
  assert.equal(plan({ agent_id: 'sub' }), '', 'a subagent');
  const auto = setup(t, { handoff: { mode: 'auto', costRatio: 3 } });
  auto.reach(205_352);
  assert.match(auto.plan(), /each call costs 2\.0 times.*run the session-handoff skill.*Build here instead when the rest takes a few calls, or when the user already said to finish here/s);
});

test('with a token ceiling, an approved plan offers a handoff from half of it', (t) => {
  const { plan, reach } = setup(t, { handoff: { maxTokens: 120_000 } });
  reach(59_999);
  assert.equal(plan(), '');
  reach(60_000);
  assert.match(plan(), /^The plan is approved, and this session already carries 60k tokens of context\. /);
  assert.equal(planApprovedContext({ mode: 'ask', costRatio: 2, maxTokens: 0 }, usageOf({ first: 58_676, last: 60_000 })), null, 'no ceiling');
});

test('a firing far past costRatio re-arms at twice its own ratio, so the next turn is not reminded again', () => {
  // A 50k baseline is a 94k fresh session; 300.8k is 3.2 times that, so the cost trigger comes back at 6.4, and it is past three ceilings of 100k.
  const text = [call('w', 50_000), call('c', 300_800)].join('\n');
  const handoff = { ...DEFAULTS.session.handoff, maxTokens: 100_000 };
  const first = stopReminder(text, handoff, null);
  assert.deepEqual(first.marker, { lastRatio: 300_800 / 94_000, tokens: 2, compactions: 0 });
  assert.match(first.reason, /comes back once the context reaches 400k tokens or each call costs 6\.4 times/);
  assert.equal(stopReminder(text, handoff, JSON.stringify(first.marker)), null, 'the next turn at the same size');
});

test('a large jump at the smallest costRatio re-arms at twice the ratio it fired at', () => {
  // A 50k baseline is 94k fresh, and 935.3k is a ratio of 9.95: the cost trigger comes back at 19.9.
  const handoff = { ...DEFAULTS.session.handoff, costRatio: 1.1 };
  const text = [call('w', 50_000), call('c', 935_300)].join('\n');
  const reminder = stopReminder(text, handoff, null);
  assert.equal(reminder.marker.lastRatio, 935_300 / 94_000);
  assert.equal(stopReminder(text, handoff, JSON.stringify(reminder.marker)), null, 'the next turn at the same size');
});

test('a costRatio raised mid-session above twice the last firing holds: no firing below it', () => {
  // A 50k baseline is 94k fresh. The marker's last firing was at 1.2, under an earlier costRatio; costRatio is now 3.
  const handoff = { ...DEFAULTS.session.handoff, costRatio: 3 };
  const marker = JSON.stringify({ lastRatio: 1.2, tokens: 0, compactions: 0 });
  assert.equal(stopReminder([call('w', 50_000), call('c', 235_000)].join('\n'), handoff, marker), null, 'r 2.5 is past twice 1.2 but under 3');
  const fired = stopReminder([call('w', 50_000), call('c', 282_000)].join('\n'), handoff, marker);
  assert.equal(fired.marker.lastRatio, 3);
  assert.match(fired.reason, /comes back once each call costs 6 times/);
});

// Today's texts, before any continue route: with no route, or route none, both hooks keep them word for word.
const NOT_WORTH = 'Judge first whether a handoff is worth it. It is not when the task is done or nearly done, or the work left takes fewer model calls than the handoff needs to pay back, when a subagent or background job is still running and its result comes back to this session, or when the user already said to finish here or that they are not watching: then end this turn without mentioning this reminder, which comes back once x. ';
const LONG = 'This session is long: each call costs 2.1 times what it would in a fresh session started from a handoff brief, and a handoff pays back after about 54 more model calls, an estimate. ';
const APPROVED = 'The plan is approved, and each call costs 2.1 times what it would in a fresh session started from a handoff brief, and a handoff pays back after about 54 more model calls, an estimate. Building in a fresh session that reads the plan costs less per turn, and now no worktree, branch, or running agent needs a brief. ';
const TODAY = {
  reminder: {
    ask: `${LONG}${NOT_WORTH}Otherwise end this turn with one short question to the user: hand off now, or keep going? If they choose to hand off, run the session-handoff skill; if they keep going, carry on.`,
    auto: `${LONG}${NOT_WORTH}Otherwise run the session-handoff skill now to write the brief, then tell the user in one line that you wrote it, its path, and that the session-continue skill resumes it.`,
  },
  plan: {
    ask: `${APPROVED}Before the first build step, ask the user one short question: hand off now, or build here? Skip the question when the rest takes a few calls, or when the user already said to finish here or that they are not watching.`,
    auto: `${APPROVED}Before the first build step, run the session-handoff skill to write the brief, then tell the user its path and that the session-continue skill resumes it. Build here instead when the rest takes a few calls, or when the user already said to finish here or that they are not watching.`,
  },
};
const LONG_USAGE = usageOf({ first: 58_676, last: 215_620 });
const HOW = 'do the host step, then any message';

test('with no continue route, or route none, the reminder and the plan offer keep their text word for word', () => {
  const cost = handoffCost(LONG_USAGE);
  for (const mode of ['ask', 'auto']) {
    for (const continuation of [undefined, { route: 'none' }, { route: 'none', how: HOW }]) {
      assert.equal(handoffReason(mode, { cost, next: ['x'], ...continuation }), TODAY.reminder[mode], `${mode} ${JSON.stringify(continuation)}`);
      assert.equal(planApprovedContext({ mode, costRatio: 2, maxTokens: 0 }, LONG_USAGE, continuation), TODAY.plan[mode], `${mode} ${JSON.stringify(continuation)}`);
    }
  }
});

test('with the clear route, auto runs the continue step and ends the turn, and ask names what a yes takes', () => {
  const cost = handoffCost(LONG_USAGE);
  const clear = { route: 'clear', how: HOW };
  const auto = handoffReason('auto', { cost, next: ['x'], ...clear });
  assert.ok(auto.startsWith(`${LONG}${NOT_WORTH}`), 'the reasons a handoff is not worth it stay');
  assert.match(auto, /Otherwise run the session-handoff skill now to write the brief and set up the continuation: its continue step prints what to tell the user\. Say that in one line, then end this turn\.$/);
  assert.doesNotMatch(auto, /resumes it|keep going/);
  const ask = handoffReason('ask', { cost, next: ['x'], ...clear });
  assert.ok(ask.startsWith(`${LONG}${NOT_WORTH}`));
  assert.match(ask, /hand off now, or keep going\? Say in it what a handoff takes from them: do the host step, then any message\. If they choose to hand off, run the session-handoff skill; if they keep going, carry on\.$/);

  const offer = planApprovedContext({ mode: 'auto', costRatio: 2, maxTokens: 0 }, LONG_USAGE, clear);
  assert.ok(offer.startsWith(APPROVED));
  assert.match(offer, /Build here when the rest takes a few calls, or when the user already said to finish here or that they are not watching\. Otherwise, before the first build step, run the session-handoff skill to write the brief and set up the continuation: its continue step prints what to tell the user\. Say that in one line, end this turn, and do not start the build here\.$/);
  const question = planApprovedContext({ mode: 'ask', costRatio: 2, maxTokens: 0 }, LONG_USAGE, clear);
  assert.match(question, /hand off now, or build here\? Say in it what a handoff takes from them: do the host step, then any message\. Skip the question when the rest takes a few calls/);
  assert.equal(planApprovedContext({ mode: 'off', costRatio: 2, maxTokens: 0 }, LONG_USAGE, clear), null, 'off is off');
});

test('with the background route, nothing is typed: auto ends the turn for good, and not watching is no reason to stay; ask still asks someone there', () => {
  const cost = handoffCost(LONG_USAGE);
  const how = claudeCode.capabilities.handoffContinue.steps.background;
  assert.match(how, /^nothing to type\b/u);
  const background = { route: 'background', how };
  const watching = NOT_WORTH.replace(' or that they are not watching', '');
  const auto = handoffReason('auto', { cost, next: ['x'], ...background });
  assert.ok(auto.startsWith(`${LONG}${watching}`), 'a session that starts itself needs nobody watching');
  assert.match(auto, /its continue step prints what to tell the user\. Say that in one line, then end this turn: a new session goes on with the work in the background, and this one does nothing more\.$/u);
  const ask = handoffReason('ask', { cost, next: ['x'], ...background });
  assert.match(ask, /hand off now, or keep going\? Say in it what a handoff takes from them: nothing to type, since a new session starts in the background and resumes from the brief by itself\. /u);
  assert.ok(ask.startsWith(`${LONG}${NOT_WORTH}`), 'ask asks the Human, so a Human who is not watching is still a reason to stay');
  assert.doesNotMatch(`${auto}${ask}`, /\/clear/u);
  assert.doesNotMatch(auto, /not watching/u);

  const offer = planApprovedContext({ mode: 'auto', costRatio: 2, maxTokens: 0 }, LONG_USAGE, background);
  assert.match(offer, /or when the user already said to finish here\. Otherwise, before the first build step, run the session-handoff skill to write the brief and set up the continuation: .* end this turn, and do not start the build here: a new session goes on with the work in the background, and this one does nothing more\.$/u);
  const question = planApprovedContext({ mode: 'ask', costRatio: 2, maxTokens: 0 }, LONG_USAGE, background);
  assert.match(question, /Say in it what a handoff takes from them: nothing to type/u);
  assert.match(question, /or when the user already said to finish here or that they are not watching\.$/u, 'the plan question keeps not watching');
});

test('the Stop hook and the plan hook word the route of the session host, and a host without it gets the none text', (t) => {
  const CLAUDE = { CLAUDECODE: '1' };
  const how = claudeCode.capabilities.handoffContinue.steps.clear;
  for (const mode of ['ask', 'auto']) {
    const { stop, plan, reach } = setup(t, { handoff: { mode, continue: 'clear' } });
    reach(205_352);
    const clear = stop({}, CLAUDE).stderr;
    assert.match(clear, mode === 'ask' ? /Say in it what a handoff takes from them: / : /its continue step prints what to tell the user/, `${mode}: the Stop hook on Claude Code`);
    if (mode === 'ask') assert.ok(clear.includes(how), 'the phrase comes from the adapter');
    const offer = plan({}, CLAUDE);
    assert.match(offer, mode === 'ask' ? /Say in it what a handoff takes from them/ : /do not start the build here\.$/, `${mode}: the plan hook on Claude Code`);
    // No host the adapters know: no route, so today's text.
    const other = setup(t, { handoff: { mode, continue: 'clear' } });
    other.reach(205_352);
    assert.doesNotMatch(other.stop().stderr, /continue step|takes from them/, `${mode}: an unknown host`);
    assert.doesNotMatch(other.plan(), /continue step|takes from them/, `${mode}: the plan offer on an unknown host`);
  }
  // A route this host does not list yet falls back to none.
  const compact = setup(t, { handoff: { mode: 'auto', continue: 'compact' } });
  compact.reach(205_352);
  assert.match(compact.stop({}, CLAUDE).stderr, /then tell the user in one line that you wrote it, its path, and that the session-continue skill resumes it\.\n$/);
  assert.match(compact.plan({}, CLAUDE), /tell the user its path and that the session-continue skill resumes it/);
  // Mode auto with no continue is the background route, but only with this machine's switch on and the base branch
  // agreeing: without the switch the hooks word the clear route the gate falls back to.
  const unswitched = setup(t, { handoff: { mode: 'auto' } });
  unswitched.reach(205_352);
  const fellBack = unswitched.stop({}, CLAUDE).stderr;
  assert.match(fellBack, /its continue step prints what to tell the user\. Say that in one line, then end this turn\.\n$/u);
  assert.match(fellBack, /or that they are not watching/u, 'the clear route still needs someone to type');
  // With no state.dir, the store is under the XDG_STATE_HOME this run sets, which is not the one the host's own
  // environment names, so the route falls back to the clear one; a committed state.dir holds the store in place.
  const moved = setup(t, { handoff: { mode: 'auto' } });
  moved.git('init', '-q', '-b', 'main');
  moved.git('add', '.aidrian/config.json');
  moved.git('commit', '-q', '-m', 'config');
  writeFileSync(path.join(moved.dir, '.aidrian.local.json'), JSON.stringify({ handoff: { background: 'on' } }));
  moved.reach(205_352);
  assert.match(moved.stop({}, CLAUDE).stderr, /its continue step prints what to tell the user\. Say that in one line, then end this turn\.\n$/u);
  const background = setup(t, { handoff: { mode: 'auto' } });
  writeFileSync(path.join(background.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: path.join(path.dirname(background.dir), 'state') }, session: { handoff: { mode: 'auto' } } }));
  background.git('init', '-q', '-b', 'main');
  background.git('add', '.aidrian/config.json');
  background.git('commit', '-q', '-m', 'config');
  writeFileSync(path.join(background.dir, '.aidrian.local.json'), JSON.stringify({ handoff: { background: 'on' } }));
  background.reach(205_352);
  const automatic = background.stop({}, CLAUDE).stderr;
  assert.match(automatic, /then end this turn: a new session goes on with the work in the background, and this one does nothing more\.\n$/u);
  assert.doesNotMatch(automatic, /not watching/u);
});

// The synthetic transcripts in test/fixtures/transcripts/handoff-*.jsonl, each with the config it is walked at and the
// level each turn ends at in ask mode. Every one starts from a 30k baseline, a 74k fresh session, on claude-opus-5-5.
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/transcripts');
const HANDOFF_FIXTURES = {
  'handoff-cost': { handoff: { costRatio: 2 }, levels: ['quiet', 'quiet', 'quiet', 'offer', 'due', 'reminded', 'reminded'] },
  'handoff-doubling': { handoff: { costRatio: 2 }, levels: ['quiet', 'offer', 'due', 'reminded', 'due', 'reminded', 'due'] },
  'handoff-compaction': { handoff: { costRatio: 2 }, levels: ['quiet', 'due', 'reminded', 'quiet', 'offer', 'due'] },
  'handoff-ceiling': { handoff: { costRatio: 2, maxTokens: 120_000 }, levels: ['quiet', 'quiet', 'offer', 'ceiling', 'reminded', 'ceiling', 'due'] },
  // The same transcript at a costRatio of 3: the ceiling fires alone at 150k, so the 160k turn is reminded by the token
  // trigger only, while its ratio of 2.16 is still under costRatio.
  'handoff-ceiling at costRatio 3': {
    file: 'handoff-ceiling', handoff: { costRatio: 3, maxTokens: 120_000 }, levels: ['quiet', 'quiet', 'offer', 'ceiling', 'reminded', 'ceiling', 'reminded'],
  },
};
const fileOf = (name) => HANDOFF_FIXTURES[name].file ?? name;

// Each turn of a fixture: the transcript up to its assistant call, a turn's end.
function turnsOf(name) {
  const lines = readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8').trimEnd().split('\n');
  return lines.flatMap((line, index) => (JSON.parse(line).type === 'assistant' ? [lines.slice(0, index + 1).join('\n')] : []));
}

// Walks a fixture as the Stop hook would, feeding the marker each firing returns forward: the status and the reminder of
// each turn.
function walk(name, mode) {
  const handoff = { ...DEFAULTS.session.handoff, ...HANDOFF_FIXTURES[name].handoff, mode };
  let markerText = null;
  return turnsOf(fileOf(name)).map((text) => {
    const status = handoffStatus(sessionUsage(text), handoff, markerText);
    const reminder = stopReminder(text, handoff, markerText);
    if (reminder) markerText = JSON.stringify(reminder.marker);
    return { text, status, reminder, handoff };
  });
}

test('the handoff fixtures cover a cost firing, a doubling, a compaction reset, and a token ceiling', () => {
  assert.deepEqual(readdirSync(FIXTURES).filter((name) => name.startsWith('handoff-')).sort(),
    [...new Set(Object.keys(HANDOFF_FIXTURES).map((name) => `${fileOf(name)}.jsonl`))].sort());
  for (const [name, { levels }] of Object.entries(HANDOFF_FIXTURES)) {
    assert.deepEqual(walk(name, 'ask').map(({ status }) => status.level), levels, name);
  }
});

test('handoffStatus is due or ceiling on exactly the turns the Stop hook reminds, in ask and auto mode', () => {
  for (const name of Object.keys(HANDOFF_FIXTURES)) {
    for (const mode of ['ask', 'auto']) {
      walk(name, mode).forEach(({ status, reminder }, turn) => {
        assert.equal(['due', 'ceiling'].includes(status.level), reminder !== null, `${name} ${mode} turn ${turn + 1}: ${status.level}`);
      });
    }
  }
});

test('handoffStatus is quiet on exactly the turns an approved plan in ask mode offers nothing', () => {
  for (const name of Object.keys(HANDOFF_FIXTURES)) {
    for (const mode of ['ask', 'auto']) {
      walk(name, mode).forEach(({ text, status, handoff }, turn) => {
        const offer = planApprovedContext({ ...handoff, mode: 'ask' }, sessionUsage(text));
        assert.equal(status.level === 'quiet', offer === null, `${name} ${mode} turn ${turn + 1}: ${status.level}`);
      });
    }
  }
});

test('when both triggers fire, handoffStatus is ceiling, and says each fires, with the counts after the compaction reset', () => {
  const both = walk('handoff-ceiling', 'ask')[3];
  assert.equal(both.status.level, 'ceiling');
  assert.deepEqual([both.status.byCost, both.status.byTokens], [true, true]);
  assert.deepEqual(both.reminder.marker, { lastRatio: 150_000 / 74_000, tokens: 1, compactions: 0 });
  const { ratio, breakEven, level, nextRatio: next, context, ceiling, counts } = both.status;
  assert.deepEqual({ ratio, level, next, context, ceiling, counts },
    { ratio: 150_000 / 74_000, level: 'ceiling', next: 2, context: 150_000, ceiling: 120_000, counts: { lastRatio: 0, tokens: 0, compactions: 0 } });
  assert.ok(Math.abs(breakEven - handoffCost(sessionUsage(both.text)).breakEven) < 1e-9);
  assert.equal(handoffStatus(sessionUsage(both.text), { ...both.handoff, maxTokens: 0 }, null).ceiling, null, 'no ceiling when off');
  const reset = walk('handoff-compaction', 'ask')[3];
  const fired = JSON.stringify({ lastRatio: 155_000 / 74_000, tokens: 0, compactions: 0 });
  assert.deepEqual(handoffStatus(sessionUsage(reset.text), reset.handoff, fired).counts, { lastRatio: 0, tokens: 0, compactions: 1 });
  assert.equal(handoffStatus(sessionUsage(reset.text), reset.handoff, fired).level, 'quiet', 'a compaction resets the firing');
});

test('right after a firing, the status read with the marker it returned is reminded, not due', () => {
  for (const [name, turn] of [['handoff-cost', 4], ['handoff-ceiling', 3], ['handoff-ceiling', 5], ['handoff-ceiling at costRatio 3', 3]]) {
    const { text, handoff, reminder } = walk(name, 'ask')[turn];
    assert.ok(reminder, `${name} turn ${turn + 1} fires`);
    const status = handoffStatus(sessionUsage(text), handoff, JSON.stringify(reminder.marker));
    assert.equal(status.level, 'reminded', `${name} turn ${turn + 1}`);
    assert.deepEqual([status.byCost, status.byTokens], [false, false]);
  }
  const usage = sessionUsage(turnsOf('handoff-cost')[4]);
  const legacy = handoffStatus(usage, { ...DEFAULTS.session.handoff, maxTokens: 0 }, 'ask\n');
  assert.equal(legacy.level, 'reminded', 'a legacy marker counts as a cost firing at costRatio');
  assert.equal(handoffStatus({ ...usage, last: 120_000 }, { ...DEFAULTS.session.handoff }, 'ask\n').level, 'offer', 'under costRatio again');
});
