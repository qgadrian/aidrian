import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import {
  BRIEF_CALLS, handoffCost, handoffReason, planApprovedContext, ratioStep, readMarker, RESUME_TOKENS, sessionUsage, stopReminder, tokenCeiling,
} from '../plugins/aidrian/lib/session-length.mjs';
import { CACHE_READ_MULT, CACHE_WRITE_1H_MULT, CACHE_WRITE_5M_MULT, priceFor } from '../plugins/aidrian/lib/transcript.mjs';

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

test('the steps add costRatio − 1 each, and the ceiling doubles', () => {
  assert.deepEqual([0, 1, 2].map((fired) => ratioStep(2, fired)), [2, 3, 4]);
  assert.deepEqual([0, 1, 2].map((fired) => ratioStep(1.5, fired)), [1.5, 2, 2.5]);
  assert.deepEqual([0, 2].map((fired) => tokenCeiling(150_000, fired)), [150_000, 600_000]);
  assert.equal(tokenCeiling(0, 3), 0);
});

test('a marker holds both counts; one an older version wrote counts as one firing of each', () => {
  assert.deepEqual(readMarker(null, 2), { ratio: 0, tokens: 0, compactions: 0 });
  assert.deepEqual(readMarker('{"ratio": 2, "tokens": 1, "compactions": 1}\n', 3), { ratio: 2, tokens: 1, compactions: 1 });
  for (const old of ['ask\n', 'remind\n', '1\n', '3\n']) assert.deepEqual(readMarker(old, 2), { ratio: 1, tokens: 1, compactions: 2 }, old);
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

test('the default is ask, at a cost ratio of 2, with no token ceiling', () => {
  assert.deepEqual(DEFAULTS.session, { handoff: { mode: 'ask', costRatio: 2, maxTokens: 0 } });
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
  const marker = path.join(temp, 'aidrian-session-length-abc-123');
  const stop = (fields) => {
    const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc-123', transcript_path: transcript, cwd: dir, stop_hook_active: false, ...fields });
    const { status, stderr } = spawnSync(process.execPath, [HOOK], { input, cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: temp } });
    return { status, stderr };
  };
  const plan = (fields = {}) => {
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', transcript_path: transcript, cwd: dir, ...fields });
    const { status, stdout } = spawnSync(process.execPath, [PLAN_HOOK], { input, cwd: dir, encoding: 'utf8' });
    assert.equal(status, 0);
    return stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext : '';
  };
  const counts = () => JSON.parse(readFileSync(marker, 'utf8'));
  return { stop, plan, reach, temp, marker, counts, transcript };
}

const QUIET = { status: 0, stderr: '' };

test('ask mode fires at the cost ratio with the question, then again only at the next step', (t) => {
  const { stop, reach, temp, counts } = setup(t);
  reach(REVIEW_LOOP.last);
  assert.deepEqual(stop(), QUIET, 'r 1.51 is under the default 2');
  reach(205_352);
  const first = stop();
  assert.equal(first.status, 2);
  assert.match(first.stderr, /^This session is long: each call costs 2\.0 times .* about 59 more model calls.*hand off now, or keep going\?/s);
  assert.match(first.stderr, /comes back once each call costs 3 times/);
  assert.deepEqual(readdirSync(temp), ['aidrian-session-length-abc-123']);
  assert.deepEqual(counts(), { ratio: 1, tokens: 0, compactions: 0 });
  assert.deepEqual(stop(), QUIET, 'a later turn of the same session, under the next step');
  assert.equal(stop({ session_id: 'other' }).status, 2, 'another session counts on its own');
  reach(300_000);
  assert.deepEqual(stop(), QUIET, 'r 2.92 is under the step of 3');
  reach(308_028);
  assert.match(stop().stderr, /^This session is long: each call costs 3\.0 times/);
  assert.deepEqual(counts(), { ratio: 2, tokens: 0, compactions: 0 });
});

test('a costRatio of 1.5 fires at 1.5 and re-arms at 2', (t) => {
  const { stop, reach, counts } = setup(t, { handoff: { costRatio: 1.5 } });
  reach(REVIEW_LOOP.last);
  assert.match(stop().stderr, /each call costs 1\.5 times.*comes back once each call costs 2 times/s);
  reach(200_000);
  assert.deepEqual(stop(), QUIET, 'r 1.95');
  reach(205_352);
  assert.equal(stop().status, 2);
  assert.deepEqual(counts(), { ratio: 2, tokens: 0, compactions: 0 });
});

test('the token ceiling fires on its own, with no cost in its message, and leaves the ratio count at 0', (t) => {
  const { stop, reach, counts } = setup(t, { handoff: { maxTokens: 100_000 } });
  reach(110_000);
  const { status, stderr } = stop();
  assert.equal(status, 2);
  assert.match(stderr, /^This session is long: 110k tokens of context\. A fresh session started from a handoff brief works from a smaller context\./);
  assert.match(stderr, /comes back once the context reaches 200k tokens\./);
  assert.doesNotMatch(stderr, /times|pays back|fewer model calls/);
  assert.deepEqual(counts(), { ratio: 0, tokens: 1, compactions: 0 });
  reach(150_000);
  assert.deepEqual(stop(), QUIET, 'under twice the ceiling');
  reach(205_352);
  assert.match(stop().stderr, /^This session is long: 205k tokens of context, and each call costs 2\.0 times/);
  assert.deepEqual(counts(), { ratio: 1, tokens: 2, compactions: 0 });
});

test('a compaction after a firing resets both counts, so the first step fires again', (t) => {
  const { stop, reach, counts } = setup(t, { handoff: { maxTokens: 200_000 } });
  reach(205_352);
  assert.equal(stop().status, 2);
  assert.deepEqual(counts(), { ratio: 1, tokens: 1, compactions: 0 });
  reach(206_000);
  assert.deepEqual(stop(), QUIET, 'no compaction: the next steps are r 3 and 400k');
  reach(COMPACTION, 206_000);
  assert.equal(stop().status, 2);
  assert.deepEqual(counts(), { ratio: 1, tokens: 1, compactions: 1 });
  assert.deepEqual(stop(), QUIET, 'the same compaction resets nothing again');
});

test('a marker an older version wrote counts as one firing of each trigger', (t) => {
  for (const old of ['ask\n', '2\n']) {
    const { stop, reach, marker, counts } = setup(t, { handoff: { maxTokens: 110_000 } });
    writeFileSync(marker, old);
    reach(205_352);
    assert.deepEqual(stop(), QUIET, `${JSON.stringify(old)}: past the first ratio step and the ceiling, under their second`);
    reach(308_028);
    assert.equal(stop().status, 2);
    assert.deepEqual(counts(), { ratio: 2, tokens: 2, compactions: 0 });
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

test('nothing happens when off, under the step, on the stop it caused, on another host, or outside a project', (t) => {
  for (const handoff of [{ mode: 'off' }, 'off']) {
    const off = setup(t, { handoff });
    off.reach(400_000);
    assert.deepEqual(off.stop(), QUIET, `off as ${JSON.stringify(handoff)}`);
    assert.equal(off.plan(), '', `the plan offer, off as ${JSON.stringify(handoff)}`);
  }
  const { stop, reach, temp, transcript } = setup(t);
  assert.deepEqual(stop(), QUIET, 'under the default step');
  reach(205_352);
  assert.deepEqual(stop({ stop_hook_active: true }), QUIET, 'the stop this hook caused');
  assert.deepEqual(stop({ stop_hook_active: undefined }), QUIET, 'a payload without stop_hook_active');
  assert.deepEqual(stop({ session_id: '../escape' }), QUIET, 'a session id that is not a plain name');
  assert.deepEqual(stop({ cwd: temp }), QUIET, 'outside a project');
  writeFileSync(transcript, `${JSON.stringify({ timestamp: '2026-11-03T09:00:00Z' })}\n`);
  assert.deepEqual(stop(), QUIET, 'a transcript with no Claude Code usage');
  assert.deepEqual(readdirSync(temp), []);
});

test('SessionEnd deletes the reminder marker the Stop hook wrote for the session', (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'aidrian-end-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const session = 'end-marker-1';
  writeFileSync(path.join(temp, `aidrian-session-length-${session}`), '{"ratio":1,"tokens":0,"compactions":0}\n');
  writeFileSync(path.join(temp, 'aidrian-session-length-other'), 'remind\n');
  const end = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-session-end.mjs');
  const env = { ...process.env, TMPDIR: temp, XDG_STATE_HOME: temp };
  spawnSync(process.execPath, [end], { input: JSON.stringify({ session_id: session, cwd: temp }), cwd: temp, env, encoding: 'utf8' });
  assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith('aidrian-session-length-')), ['aidrian-session-length-other']);
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
