import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { handoffReason, overLimits, sessionLength } from '../plugins/aidrian/lib/session-length.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-stop.mjs');

// One transcript line: an assistant API request with its usage, or (no id) a plain entry with a timestamp.
const line = (minute, id, usage) =>
  JSON.stringify({ timestamp: new Date(Date.UTC(2026, 9, 29, 9, minute)).toISOString(), ...(id && { message: { id, model: 'claude-opus-5-5', usage } }) });
const usage = (input, cacheRead, cacheWrite) => ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 50 });

test('a session is the context of its last request, its requests counted once, and its hours with long pauses cut to one', () => {
  const text = [
    line(0),
    line(1, 'a', usage(10, 0, 5000)),
    line(2, 'a', usage(10, 0, 5000)),
    line(30, 'b', usage(20, 5000, 1000)),
    'not json',
    line(300, 'c', usage(30, 6000, 400)),
  ].join('\n');
  assert.deepEqual(sessionLength(text), { tokens: 6430, calls: 3, hours: 1.5 });
  assert.deepEqual(sessionLength(''), { tokens: 0, calls: 0, hours: 0 });
  // A line dated earlier than the one before it, as a resumed or merged transcript has, counts no stretch twice.
  assert.equal(sessionLength([line(0), line(30), line(10), line(30)].join('\n')).hours, 0.5);
});

test('each limit trips on its own, 0 turns a limit off, and a transcript with no requests trips nothing', () => {
  const limits = { maxTokens: 150000, maxCalls: 250, maxHours: 4 };
  assert.deepEqual(overLimits({ tokens: 212_400, calls: 3, hours: 0.5 }, limits), ['212k tokens of context']);
  assert.deepEqual(overLimits({ tokens: 1000, calls: 250, hours: 4.25 }, limits), ['250 model calls', '4.3 hours of work']);
  assert.deepEqual(overLimits({ tokens: 900_000, calls: 900, hours: 9 }, { maxTokens: 0, maxCalls: 0, maxHours: 0 }), []);
  assert.deepEqual(overLimits({ tokens: 0, calls: 0, hours: 9 }, limits), []);
});

test('ask mode asks one question and promises not to ask again; auto mode writes the brief', () => {
  const ask = handoffReason('ask', ['250 model calls']);
  assert.match(ask, /^This session is long: 250 model calls\./);
  assert.match(ask, /hand off now, or keep going\?/);
  assert.match(ask, /session-handoff skill/);
  assert.match(ask, /does not come back in this session/);
  const auto = handoffReason('auto', ['250 model calls']);
  assert.match(auto, /Run the session-handoff skill now/);
  assert.match(auto, /session-continue skill/);
  assert.doesNotMatch(auto, /keep going/);
});

test('the default is ask, at 150k tokens, 250 calls, or 4 hours', () => {
  assert.deepEqual(DEFAULTS.session, { handoff: 'ask', maxTokens: 150000, maxCalls: 250, maxHours: 4 });
});

function setup(t, session) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-session-length-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, ...(session && { session }) }));
  const transcript = path.join(base, 'session.jsonl');
  writeFileSync(transcript, [line(0, 'a', usage(10, 0, 5000)), line(1, 'b', usage(10, 5000, 500)), line(2, 'c', usage(10, 5500, 500))].join('\n'));
  const temp = path.join(base, 'tmp');
  mkdirSync(temp);
  const stop = (fields) => {
    const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc-123', transcript_path: transcript, cwd: dir, stop_hook_active: false, ...fields });
    const { status, stderr } = spawnSync(process.execPath, [HOOK], { input, cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: temp } });
    return { status, stderr };
  };
  return { stop, temp, transcript };
}

test('ask mode sends the agent back once with the question, then never again in that session', (t) => {
  const { stop, temp } = setup(t, { maxCalls: 3 });
  const first = stop();
  assert.equal(first.status, 2);
  assert.match(first.stderr, /^This session is long: 3 model calls\..*hand off now, or keep going\?/s);
  assert.deepEqual(readdirSync(temp), ['aidrian-session-length-abc-123']);
  assert.deepEqual(stop(), { status: 0, stderr: '' }, 'a later turn of the same session');
  assert.equal(stop({ session_id: 'other' }).status, 2, 'another session asks once too');
});

test('auto mode sends the agent back to write the brief', (t) => {
  const { stop } = setup(t, { handoff: 'auto', maxTokens: 6000 });
  const { status, stderr } = stop();
  assert.equal(status, 2);
  assert.match(stderr, /^This session is long: 6k tokens of context\..*Run the session-handoff skill now/s);
});

test('nothing happens when off, within limits, on the stop it caused, on another host, or outside a project', (t) => {
  const quiet = { status: 0, stderr: '' };
  assert.deepEqual(setup(t, { handoff: 'off', maxCalls: 1 }).stop(), quiet, 'off');
  assert.deepEqual(setup(t).stop(), quiet, 'within the default limits');
  const { stop, temp, transcript } = setup(t, { maxCalls: 1 });
  assert.deepEqual(stop({ stop_hook_active: true }), quiet, 'the stop this hook caused');
  assert.deepEqual(stop({ stop_hook_active: undefined }), quiet, 'a payload without stop_hook_active');
  assert.deepEqual(stop({ session_id: '../escape' }), quiet, 'a session id that is not a plain name');
  assert.deepEqual(stop({ cwd: temp }), quiet, 'outside a project');
  writeFileSync(transcript, `${line(0)}\n${line(600)}\n`);
  assert.deepEqual(stop(), quiet, 'a transcript with no Claude Code usage');
  assert.deepEqual(readdirSync(temp), []);
});

test('SessionEnd deletes the reminder marker the Stop hook wrote for the session', (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'aidrian-end-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const session = 'end-marker-1';
  writeFileSync(path.join(temp, `aidrian-session-length-${session}`), 'remind\n');
  writeFileSync(path.join(temp, 'aidrian-session-length-other'), 'remind\n');
  const end = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-session-end.mjs');
  const env = { ...process.env, TMPDIR: temp, XDG_STATE_HOME: temp };
  spawnSync(process.execPath, [end], { input: JSON.stringify({ session_id: session, cwd: temp }), cwd: temp, env, encoding: 'utf8' });
  assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith('aidrian-session-length-')), ['aidrian-session-length-other']);
});

test('an approved plan in a long session offers a handoff before the build; a short session or a subagent gets nothing', (t) => {
  const { transcript } = setup(t, null);
  const planHook = path.join(path.dirname(HOOK), 'hook-plan-exit.mjs');
  const run = (session, fields = {}) => {
    const dir = path.join(path.dirname(transcript), `p-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, session }));
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', transcript_path: transcript, cwd: dir, ...fields });
    const { status, stdout } = spawnSync(process.execPath, [planHook], { input, cwd: dir, encoding: 'utf8' });
    assert.equal(status, 0);
    return stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext : '';
  };
  // Three calls and 6k tokens: half of maxCalls 6 is reached, the full limit is not.
  assert.match(run({ maxCalls: 6 }), /^The plan is approved, and this session already carries 3 model calls\..*hand off now, or build here\?/s);
  assert.match(run({ handoff: 'auto', maxTokens: 12000 }), /6k tokens of context.*run the session-handoff skill/s);
  assert.equal(run({ maxCalls: 8, maxTokens: 0, maxHours: 0 }), '', 'under half of every limit');
  assert.equal(run({ handoff: 'off', maxCalls: 1 }), '');
  assert.equal(run({ maxCalls: 1 }, { agent_id: 'sub' }), '', 'a subagent');
});
