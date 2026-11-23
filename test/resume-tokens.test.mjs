import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { backgroundPrompt, continuationContext } from '../plugins/aidrian/lib/handoff-continue.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import { findProject, stateDir } from '../plugins/aidrian/lib/project.mjs';
import {
  KEPT_SAMPLES, MIN_SAMPLES, readSamples, recordResume, RESUME_FILE, RESUME_TOKENS, resolvedHandoff, resumeTokens, SAMPLE_DAYS,
} from '../plugins/aidrian/lib/resume-tokens.mjs';
import { handoffCost, handoffStatus, planApprovedContext, sessionUsage, stopReminder } from '../plugins/aidrian/lib/session-length.mjs';
import { CONTINUATION_LEAD, resumeRead } from '../plugins/aidrian/lib/transcript.mjs';

import { hookCall } from './hook-call.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-stop.mjs');
const PLAN_HOOK = path.join(path.dirname(HOOK), 'hook-plan-exit.mjs');
const OPUS = 'claude-opus-5-5';
const WORK = claudeCode.capabilities.workTools;
const NOW = Date.UTC(2026, 10, 23, 12);
const DAY = 24 * 60 * 60 * 1000;

// One assistant request of `context` tokens, with the tool calls `tools` names, as Claude Code writes it.
let request = 0;
const turn = (context, tools = []) => {
  request += 1;
  const content = tools.map((tool, index) => ({ type: 'tool_use', id: `t${request}-${index}`, ...(typeof tool === 'string' ? { name: tool, input: {} } : tool) }));
  const usage = { input_tokens: 2, cache_read_input_tokens: context - 502, cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 500 }, output_tokens: 40 };
  return JSON.stringify({ type: 'assistant', message: { id: `m${request}`, model: OPUS, usage, content } });
};
const user = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
const skillCall = (skill) => ({ name: 'Skill', input: { skill } });
const startContext = (text) => JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['Project knowledge: 1 bucket.', text] } });
const lines = (...each) => each.join('\n');

test('a session that ran the session-continue skill read, before its first edit or dispatch, its context then less its first call`s', () => {
  const resumed = lines(user('resume'), turn(30_000, [skillCall('aidrian:session-continue')]), turn(50_000, ['Read']), turn(71_000, ['Bash', 'Edit']), turn(200_000, ['Agent']));
  assert.equal(resumeRead(resumed, WORK), 41_000);
  assert.equal(resumeRead(lines(user('go'), turn(30_000, [skillCall('session-continue')]), turn(60_000, ['Agent'])), WORK), 30_000, 'a dispatch ends it too, and a bare skill name counts');
  const typed = user('<command-message>aidrian:session-continue</command-message>\n<command-name>/aidrian:session-continue</command-name>\n<command-args>tbl</command-args>');
  assert.equal(resumeRead(lines(typed, turn(25_000), turn(52_000, ['Write'])), WORK), 27_000, 'a typed resume counts');
  assert.equal(resumeRead(lines(user('fix it'), turn(30_000), turn(60_000, ['Edit'])), WORK), null, 'no resume: no sample');
  assert.equal(resumeRead(lines(user('resume'), turn(30_000, [skillCall('aidrian:session-continue')]), turn(50_000, ['Read'])), WORK), null, 'no edit or dispatch yet');
  assert.equal(resumeRead(lines(user('fix it'), turn(30_000, ['Edit']), turn(40_000, [skillCall('aidrian:session-continue')])), WORK), null, 'a resume after the first edit is none');
});

test('a continuation block counts as a resume in the first message of a background start and in a clear`s start context, never in a tool result', () => {
  const marker = { brief: '/state/handoffs/2026-11-23-task.md', slug: 'task', chain: 0 };
  const background = backgroundPrompt({ marker, kept: '/state/handoffs/.continue/continued-x.md', sha256: 'a'.repeat(64), maxChain: 3 });
  const clear = continuationContext({ marker, maxChain: 3, source: 'clear' });
  for (const text of [background, clear]) assert.ok(text.startsWith(CONTINUATION_LEAD), 'the lead the transcript reader looks for');
  assert.equal(resumeRead(lines(user(background), turn(20_000, ['Bash']), turn(55_000, ['Agent'])), WORK), 35_000);
  assert.equal(resumeRead(lines(user([{ type: 'text', text: background }]), turn(20_000), turn(45_000, ['Edit'])), WORK), 25_000, 'as text blocks');
  assert.equal(resumeRead(lines(startContext(clear), user('go on'), turn(20_000), turn(64_000, ['Edit'])), WORK), 44_000);
  const quoted = user([{ type: 'tool_result', tool_use_id: 'x', content: `grep found: ${CONTINUATION_LEAD} this session` }]);
  assert.equal(resumeRead(lines(user('look'), turn(20_000, ['Bash']), quoted, turn(64_000, ['Edit'])), WORK), null, 'a command output that quotes the block');
});

// A state folder of its own, with `samples` in its resume file, each { tokens, ago } with `ago` in days before NOW.
function stateWith(t, samples = []) {
  const state = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-resume-')));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const rows = samples.map(({ tokens, ago = 1 }, index) => ({ session: `s-${index}`, tokens, at: NOW - ago * DAY }));
  if (rows.length) writeFileSync(path.join(state, RESUME_FILE), JSON.stringify({ samples: rows }));
  return state;
}
const many = (count, tokens, ago) => Array.from({ length: count }, (_, index) => ({ tokens: typeof tokens === 'function' ? tokens(index) : tokens, ago }));

test('the config value wins, then the median of 5 or more samples of the last 30 days, then 44,000', (t) => {
  assert.equal(RESUME_TOKENS, 44_000);
  assert.equal(MIN_SAMPLES, 5);
  const four = stateWith(t, many(4, 90_000));
  assert.deepEqual(resumeTokens({}, four, NOW), { tokens: RESUME_TOKENS, source: 'default', samples: 4 }, 'too few samples');
  const five = stateWith(t, many(5, (index) => 60_000 + index * 10_000));
  assert.deepEqual(resumeTokens({ resumeTokens: null }, five, NOW), { tokens: 80_000, source: 'measured', samples: 5 });
  const six = stateWith(t, many(6, (index) => 60_000 + index * 10_000));
  assert.equal(resumeTokens({}, six, NOW).tokens, 85_000, 'an even count takes the mean of the middle two');
  assert.deepEqual(resumeTokens({ resumeTokens: 52_000 }, five, NOW), { tokens: 52_000, source: 'config', samples: null }, 'config wins');
  const old = stateWith(t, [...many(4, 90_000, 1), ...many(3, 90_000, SAMPLE_DAYS + 1)]);
  assert.equal(resumeTokens({}, old, NOW).source, 'default', 'a sample older than 30 days does not count');
  assert.deepEqual(resumeTokens({}, null, NOW), { tokens: RESUME_TOKENS, source: 'default', samples: 0 }, 'no state folder');
  const broken = stateWith(t);
  writeFileSync(path.join(broken, RESUME_FILE), '{"samples": [{"session": "a", "tokens": -1, "at": 1}, "x"]');
  assert.equal(resumeTokens({}, broken, NOW).tokens, RESUME_TOKENS, 'a file that does not parse reads as none');
  assert.equal(resolvedHandoff({ mode: 'ask', costRatio: 2 }, five, NOW).resumeTokens, 80_000);
});

test('a session`s sample is recorded once, and the file keeps the newest 50', (t) => {
  const state = stateWith(t);
  const resumed = lines(user('resume'), turn(30_000, [skillCall('aidrian:session-continue')]), turn(70_000, ['Edit']));
  assert.equal(recordResume(state, 'sess-1', lines(user('resume'), turn(30_000, [skillCall('aidrian:session-continue')])), WORK, NOW), null, 'no edit yet');
  assert.equal(recordResume(state, 'sess-1', resumed, WORK, NOW), 40_000);
  assert.equal(recordResume(state, 'sess-1', lines(resumed, turn(90_000, ['Edit'])), WORK, NOW + 1000), null, 'once');
  assert.equal(recordResume(state, 'sess-2', lines(user('fix'), turn(30_000), turn(70_000, ['Edit'])), WORK, NOW), null, 'no resume');
  assert.equal(recordResume(state, '../x', resumed, WORK, NOW), null, 'a session id that cannot name a file');
  assert.deepEqual(readSamples(state, NOW), [{ session: 'sess-1', tokens: 40_000, at: NOW }]);
  for (let index = 0; index < KEPT_SAMPLES + 5; index += 1) recordResume(state, `many-${index}`, resumed, WORK, NOW + index);
  const kept = JSON.parse(readFileSync(path.join(state, RESUME_FILE), 'utf8')).samples;
  assert.equal(kept.length, KEPT_SAMPLES);
  assert.equal(kept.at(-1).session, `many-${KEPT_SAMPLES + 4}`, 'the newest kept, oldest dropped');
});

test('the cost model, the trigger, and the plan offer all price a fresh session with the B they are given', () => {
  const usage = { calls: 2, first: 40_000, last: 200_000, model: OPUS, oneHourCache: true, compactions: 0 };
  assert.equal(handoffCost(usage).ratio, 200_000 / 84_000, '44,000 with none given');
  assert.equal(handoffCost(usage, { resumeTokens: 60_000 }).ratio, 2);
  const handoff = { mode: 'ask', costRatio: 2, maxTokens: 0, resumeTokens: 60_000 };
  assert.equal(handoffStatus(usage, handoff, null).ratio, 2);
  assert.equal(handoffStatus(usage, { ...handoff, resumeTokens: 61_000 }, null).level, 'offer', 'a larger B puts the ratio under costRatio');
  assert.equal(handoffStatus(usage, handoff, null).level, 'due');
  assert.match(planApprovedContext(handoff, usage), /each call costs 2\.0 times/);
  const text = lines(turn(40_000), turn(200_000));
  assert.equal(stopReminder(text, { ...handoff, resumeTokens: 61_000 }, null), null);
  assert.ok(stopReminder(text, handoff, null), 'and the Stop hook`s reminder follows the same B');
  assert.equal(sessionUsage(text).last, 200_000);
});

// A project whose Stop hook and plan hook run in this process on Claude Code, with its own state root.
function project(t, config = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-resume-project-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, ...config }));
  const env = { ...process.env, CLAUDECODE: '1', XDG_STATE_HOME: path.join(base, 'state'), TMPDIR: base };
  const state = stateDir(findProject(dir), { config: loadConfig(findProject(dir)).config, env });
  const transcript = path.join(base, 'session.jsonl');
  const stop = (session, extra = {}) => hookCall(HOOK, {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: session, transcript_path: transcript, cwd: dir, stop_hook_active: false }), cwd: dir, env: { ...env, ...extra },
  });
  const plan = () => hookCall(PLAN_HOOK, { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', transcript_path: transcript, cwd: dir }), cwd: dir, env });
  const plant = (samples) => {
    mkdirSync(state, { recursive: true });
    writeFileSync(path.join(state, RESUME_FILE), JSON.stringify({ samples: samples.map((tokens, index) => ({ session: `p-${index}`, tokens, at: Date.now() - DAY })) }));
  };
  return { state, transcript, stop, plan, plant };
}

test('the Stop hook records a resumed session`s sample once, in any mode, and five of them move its reminder', async (t) => {
  const off = project(t, { session: { handoff: { mode: 'off' } } });
  writeFileSync(off.transcript, lines(user('resume'), turn(30_000, [skillCall('aidrian:session-continue')]), turn(72_000, ['Edit'])));
  assert.equal((await off.stop('resumed-0', { CLAUDECODE: '' })).status, 0);
  assert.deepEqual(readSamples(off.state), [], 'a host with no work tools records none');
  assert.equal((await off.stop('resumed-1')).status, 0);
  assert.equal((await off.stop('resumed-1')).status, 0);
  assert.deepEqual(readSamples(off.state).map(({ session, tokens }) => [session, tokens]), [['resumed-1', 42_000]], 'recorded under mode off');

  // W 40,000 and C 200,000: r is 2.38 with B 44,000, due; with a measured B of 70,000 it is 1.82, an offer at most.
  const on = project(t);
  writeFileSync(on.transcript, lines(turn(40_000), turn(200_000)));
  assert.equal((await on.stop('long-1')).status, 2, 'due with the default B');
  on.plant([70_000, 70_000, 70_000, 70_000, 70_000]);
  assert.equal((await on.stop('long-2')).status, 0, 'quiet with this project`s B');
  const offer = JSON.parse((await on.plan()).stdout).hookSpecificOutput.additionalContext;
  assert.match(offer, /each call costs 1\.8 times what it would in a fresh session/, 'the plan offer prices it the same');
});

test('session.handoff.resumeTokens is a whole number above 0, or null, and wins over the samples in the hooks', async (t) => {
  for (const bad of [0, -5, 1.5, '44000']) {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-resume-config-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, '.aidrian'));
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, session: { handoff: { resumeTokens: bad } } }));
    const { config, errors } = loadConfig(findProject(dir));
    assert.equal(config.session.handoff.resumeTokens, null, `${JSON.stringify(bad)} keeps the default`);
    assert.ok(errors.some((error) => error.includes('session.handoff.resumeTokens')), `${JSON.stringify(bad)} is an error`);
  }
  const set = project(t, { session: { handoff: { resumeTokens: 40_000 } } });
  writeFileSync(set.transcript, lines(turn(40_000), turn(200_000)));
  set.plant([70_000, 70_000, 70_000, 70_000, 70_000]);
  assert.equal((await set.stop('long-3')).status, 2, 'r 2.5 with the config`s B, past the samples');
});
