import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { announcedWork, announceReason, lastParagraph, QUESTION_TOOL } from '../plugins/aidrian/lib/stop-announce.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-stop.mjs');
const NAMES = { ai: 'HAL9K', human: 'Adrian' };
// The message that ended a main-session turn with nothing blocking it, and the Human waiting on the work it announced.
const STALLED = 'The decisions are settled.\n\n⏭️ Next, HAL9K writes the plan file and reviews it with Adrian, one decision at a time, ' +
  'before anything is built. Starting now unless Adrian says otherwise.';

const fires = (message, extra = {}) => announceReason({ message, ...NAMES, ...extra }) !== null;

test('the stalled message is sent back, quoting the phrase, naming the Human and the question tool', () => {
  const reason = announceReason({ message: STALLED, ...NAMES });
  assert.match(reason, /^The last message announces work and ends the turn without doing it \("Next, HAL9K writes"\)\./);
  assert.match(reason, /Nothing wakes this session until Adrian writes again/);
  assert.match(reason, /Do it now\./);
  assert.match(reason, new RegExp(`ask with the question tool \\(${QUESTION_TOOL}\\)`));
  assert.match(reason, /end the turn again\.$/);
});

test('each announce phrase fires, in any case, in the last paragraph', () => {
  for (const message of [
    'Starting now unless Adrian says otherwise.',
    'HAL9K takes the next slice unless told otherwise.',
    'The branch goes up unless the Human objects.',
    'starting now.',
    'Proceeding now.',
    'Starting on it now.',
    'HAL9K will now open the pull request.',
    'HAL9K’ll now run the suite.',
    "I'll start with the tests.",
    'HAL9K will proceed with the migration.',
    "We're going to begin with the parser.",
    'Next, HAL9K will push the branch.',
    'Next up: HAL9K drafts the issue.',
    'Done with the first part.\n\nNEXT, HAL9K IMPLEMENTS THE SECOND.',
  ]) assert.ok(fires(message), message);
});

test('a question, a wait on the Human, another actor, or an earlier paragraph does not fire', () => {
  for (const message of [
    'Done. All 812 tests pass.',
    'Should HAL9K start now?',
    'Starting now unless Adrian says otherwise, or should HAL9K wait for the review?',
    'Next, HAL9K opens the pull request once Adrian approves the plan.',
    'HAL9K will start once Adrian confirms.',
    'HAL9K will start when the user says go.',
    "Next, HAL9K pushes after Adrian's review.",
    'HAL9K will now wait for Adrian to pick an option.',
    'Next, Adrian reviews the plan.',
    'Next step: Adrian merges it.',
    'The Stop hook will now send the agent back once.',
    'The AI will now behave.',
    'Starting now unless Adrian says otherwise.\n\nDone: the plan is written and reviewed.',
    '',
  ]) assert.ok(!fires(message), message);
});

test('a background task still running holds the send-back', () => {
  assert.ok(!fires(STALLED, { running: true }));
  assert.ok(fires(STALLED, { running: false }));
});

test('the AI and the Human are named by config, and the defaults hold without them', () => {
  assert.ok(announceReason({ message: 'Claude will now run it.', ai: 'Claude' }));
  assert.ok(!announceReason({ message: 'HAL9K will now run it.', ai: 'Claude' }));
  assert.ok(!announceReason({ message: 'I will start once the Human approves.' }));
  assert.match(announceReason({ message: 'Proceeding now.' }), /until the Human writes again/);
  assert.ok(announceReason({ message: 'A.I. will now run it.', ai: 'A.I.' }), 'a name with regex characters is matched as written');
});

test('lastParagraph takes the text after the last blank line', () => {
  assert.equal(lastParagraph('one\n\ntwo\nthree\n \n  four  \n'), 'four');
  assert.equal(lastParagraph('only'), 'only');
});

const prompt = (content) => ({ type: 'user', message: { role: 'user', content } });
const reply = (...blocks) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const text = (t) => ({ type: 'text', text: t });
const tool = (name) => ({ type: 'tool_use', id: `t-${name}`, name, input: {} });
const jsonl = (...entries) => `${entries.map((each) => JSON.stringify(each)).join('\n')}\n`;

// A turn that asked with the question tool, got the Human's answer, and then announced the work and stopped. The tool
// waits for the answer, so a question tool call is never what a turn stops on: the announcement after it stalls the same.
const ANSWERED = jsonl(
  prompt('first'), reply(tool('Read')),
  prompt('second'), reply(text('Checking.'), tool('Bash')), prompt([{ type: 'tool_result', tool_use_id: 't-Bash', content: 'ok' }]),
  reply(tool(QUESTION_TOOL)), prompt([{ type: 'tool_result', tool_use_id: `t-${QUESTION_TOOL}`, content: 'Plan first' }]),
  reply(text(STALLED)),
);

test('an announcement after an answered question is sent back, from the payload or the transcript', () => {
  assert.ok(announcedWork({ last_assistant_message: STALLED }, ANSWERED, NAMES), 'the payload message');
  assert.ok(announcedWork({}, ANSWERED, NAMES), 'the transcript message');
  const after = jsonl(prompt('go'), reply(tool(QUESTION_TOOL)), prompt([{ type: 'tool_result', tool_use_id: `t-${QUESTION_TOOL}`, content: 'Go' }]), reply(text('Starting now.')));
  assert.ok(announcedWork({}, after, NAMES), 'a short announcement right after the answer');
});

test('announcedWork reads the payload message first, else the transcript', () => {
  const plain = jsonl(prompt('go'), reply(tool('Bash')), reply(text(STALLED)));
  assert.ok(announcedWork({}, plain, NAMES), 'the transcript message');
  assert.ok(!announcedWork({ last_assistant_message: 'Done.' }, plain, NAMES), 'the payload message wins');
  assert.ok(announcedWork({ last_assistant_message: STALLED }, null, NAMES), 'no transcript');
  const asked = jsonl(prompt('go'), reply(tool(QUESTION_TOOL)), prompt([{ type: 'tool_result', tool_use_id: `t-${QUESTION_TOOL}`, content: 'Go' }]));
  assert.ok(announcedWork({ last_assistant_message: STALLED }, asked, NAMES), 'a question tool call earlier in the turn exempts nothing');
  assert.ok(!announcedWork({ last_assistant_message: STALLED, background_tasks: [{ id: 'b1', status: 'running' }] }, plain, NAMES));
  assert.ok(announcedWork({ last_assistant_message: STALLED, background_tasks: [{ id: 'b1', status: 'completed' }] }, plain, NAMES));
});

function setup(t, config = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-stop-announce-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, names: { human: 'Adrian', ai: 'HAL9K' }, ...config }));
  const transcript = path.join(base, 'session.jsonl');
  writeFileSync(transcript, jsonl(prompt('plan it'), reply(text(STALLED))));
  const temp = path.join(base, 'tmp');
  mkdirSync(temp);
  const stop = (fields = {}) => {
    const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc-123', transcript_path: transcript, cwd: dir, stop_hook_active: false, ...fields });
    const { status, stderr } = spawnSync(process.execPath, [HOOK], { input, cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: temp } });
    return { status, stderr };
  };
  return { stop, temp, dir, base };
}

const QUIET = { status: 0, stderr: '' };

test('the Stop hook sends the stalled turn back once, whether session handoff is on or off', (t) => {
  for (const session of [undefined, { handoff: { mode: 'off' } }]) {
    const { stop, temp } = setup(t, session ? { session } : {});
    const first = stop({ last_assistant_message: STALLED });
    assert.equal(first.status, 2);
    assert.match(first.stderr, /^The last message announces work and ends the turn without doing it/);
    assert.match(first.stderr, /until Adrian writes again/);
    assert.equal(stop({ last_assistant_message: undefined }).status, 2, 'the message read from the transcript');
    assert.deepEqual(stop({ stop_hook_active: true }), QUIET, 'the stop this hook caused');
    assert.deepEqual(readdirSync(temp), [], 'the session-length marker is untouched');
  }
});

test('the Stop hook does nothing on another host, outside a project, on a finished turn, or on bad input', (t) => {
  const { stop, base } = setup(t);
  assert.deepEqual(stop({ stop_hook_active: undefined }), QUIET, 'a payload without stop_hook_active');
  assert.deepEqual(stop({ cwd: base }), QUIET, 'outside a project');
  assert.deepEqual(stop({ last_assistant_message: 'Done: the plan is written.' }), QUIET, 'a finished turn');
  assert.deepEqual(stop({ last_assistant_message: 'Should HAL9K start now?' }), QUIET, 'a question to the Human');
  assert.deepEqual(stop({ transcript_path: path.join(base, 'missing.jsonl'), last_assistant_message: 'Done.' }), QUIET, 'no transcript');
  const broken = spawnSync(process.execPath, [HOOK], { input: 'not json', cwd: base, encoding: 'utf8' });
  assert.deepEqual({ status: broken.status, stderr: broken.stderr }, QUIET, 'a payload that is not JSON');
});

// Codex's Stop input, with every field its stop.command.input schema requires (the schema the 0.167.0 binary embeds):
// it sends `stop_hook_active` and `last_assistant_message`, and `turn_id` tells the adapter it is Codex.
const codexStop = (transcript, fields = {}) => ({
  hook_event_name: 'Stop', session_id: '019a-codex', turn_id: 'turn-7', model: 'gpt-5.5', permission_mode: 'default',
  transcript_path: transcript, stop_hook_active: false, last_assistant_message: STALLED, ...fields,
});

test('on Codex the Stop hook sends the stalled turn back once, naming the question tool as its model calls it', (t) => {
  const { dir, base } = setup(t);
  const rollout = path.join(base, 'rollout.jsonl');
  writeFileSync(rollout, jsonl({ type: 'session_meta', payload: {} }, reply(text('Done.'))));
  const run = (fields) => {
    const input = JSON.stringify({ cwd: dir, ...codexStop(rollout, fields) });
    const { status, stderr } = spawnSync(process.execPath, [HOOK], { input, cwd: dir, encoding: 'utf8' });
    return { status, stderr };
  };
  const first = run();
  assert.equal(first.status, 2, 'Codex reads exit 2 with stderr as the continuation prompt');
  assert.match(first.stderr, /ask with the question tool \(request_user_input\)/);
  assert.doesNotMatch(first.stderr, new RegExp(QUESTION_TOOL));
  assert.deepEqual(run({ stop_hook_active: true }), QUIET, 'the stop this hook caused');
  assert.deepEqual(run({ last_assistant_message: null }), QUIET, 'a Codex rollout is never read for the message');
  assert.deepEqual(run({ last_assistant_message: 'Done: the plan is written.' }), QUIET, 'a finished turn');
});
