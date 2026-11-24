import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { reviewLoopOwed } from '../plugins/aidrian/lib/stop-review-loop.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-stop.mjs');

// A Claude Code transcript: the Human's prompt, a tool call and its result, and the turn's last message.
const human = (content) => ({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content } });
const call = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const jsonl = (...entries) => `${entries.flat().map((each) => JSON.stringify(each)).join('\n')}\n`;

const DRAFT = [call('d1', 'Bash', { command: 'gh pr create --draft --title t --body-file b.md' }), result('d1', 'https://github.com/acme/notes/pull/40')];
const skillRun = (id, skill) => [call(id, 'Skill', { skill }), result(id, `Launching skill: ${skill}`)];
const REVIEW_COMMAND = [call('r1', 'Bash', { command: 'aidrian pr review 40 --with-bot' }), result('r1', JSON.stringify({ status: 'dispatch', pr: 40 }, null, 2))];
const DONE = said('Draft pull request #40 is open with every check green.');

function setup(t, config = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-stop-review-loop-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, names: { human: 'Adrian', ai: 'HAL9K' }, ...config }));
  const temp = path.join(base, 'tmp');
  mkdirSync(temp);
  const env = { ...process.env, TMPDIR: temp };
  delete env.AIDRIAN_SHELL_PID;
  let count = 0;
  // Runs the hook on a transcript of `entries`; `fields` replace the payload's.
  const stop = (entries, fields = {}) => {
    count += 1;
    const transcript = path.join(base, `session-${count}.jsonl`);
    writeFileSync(transcript, jsonl(...entries));
    const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc-123', transcript_path: transcript, cwd: dir, stop_hook_active: false, ...fields });
    const { status, stderr } = spawnSync(process.execPath, [HOOK], { input, cwd: dir, encoding: 'utf8', env });
    return { status, stderr };
  };
  return { stop, dir, base };
}

const QUIET = { status: 0, stderr: '' };

test('a turn that opened a draft and ran no review is sent back once, and the stop the hook caused ends', (t) => {
  const { stop } = setup(t);
  const first = stop([human('implement #400'), DRAFT, DONE]);
  assert.equal(first.status, 2);
  assert.match(first.stderr, /^This turn opened or updated a draft pull request and ran no review after it\./u);
  assert.match(first.stderr, /`github\.reviewLoop` is "auto"/u);
  assert.match(first.stderr, /run the `pr-review-loop` skill on it now, as the session's own step/u);
  assert.match(first.stderr, /`pr-auto-merge`, which merges only when `aidrian pr auto-merge <n> --check` exits 0/u);
  assert.match(first.stderr, /when Adrian asked the run to stop at the draft/u);
  assert.deepEqual(stop([human('implement #400'), DRAFT, DONE], { stop_hook_active: true }), QUIET, 'the stop this hook caused');
});

// The entry Claude Code writes into the transcript when a Stop hook sends the turn back: the hook's stderr, as a `user`
// entry marked isMeta. The tests build it from the stderr the hook printed, so the hook reads its own reasons.
const sentBack = (stderr, command = 'node "/p/aidrian/scripts/hook-stop.mjs"') =>
  ({ type: 'user', isMeta: true, message: { role: 'user', content: `Stop hook feedback:\n[${command}]: ${stderr.trim()}` } });
const REFUSED = [call('g1', 'Bash', { command: 'aidrian pr auto-merge 40' }),
  result('g1', 'Exit code 1\nauto-merge off for #40: it changes "AGENTS.md", which instructs AI sessions, or decides CI\'s verdict or auto-merge', true)];
const NOT_MERGED = said('The loop signed off and #40 is ready, not merged.');
const MERGE_SENT = /^This turn's `aidrian pr auto-merge` run refused #40 at its path check/u;

test('after the review-loop send-back, the stop that ends the loop still checks its report, once per check', (t) => {
  const { stop, dir } = setup(t);
  const first = [human('implement #400'), skillRun('p1', 'aidrian:pr-write'), DRAFT, DONE];
  const one = stop(first);
  assert.equal(one.status, 2);
  assert.match(one.stderr, /^This turn opened or updated a draft pull request and ran no review after it\./u);
  const ready = [call('y1', 'Bash', { command: 'gh pr ready 40' }), result('y1', 'ok')];
  const loop = [...first, sentBack(one.stderr), skillRun('k1', 'aidrian:pr-review-loop'), ready, skillRun('m1', 'aidrian:pr-auto-merge'), REFUSED];
  const two = stop([...loop, NOT_MERGED], { stop_hook_active: true });
  assert.equal(two.status, 2, 'the continuation leaves the path refusal out of its report');
  assert.match(two.stderr, MERGE_SENT);
  assert.deepEqual(stop([...loop, NOT_MERGED, sentBack(two.stderr), said('Still ready, not merged.')], { stop_hook_active: true }), QUIET,
    'the merge hand-back check sent this turn back already');
  const item = said("**For Adrian**\n- High: needs Adrian's review and merge: #40 touches `AGENTS.md`, which auto-merge never merges.");
  assert.deepEqual(stop([...loop, item], { stop_hook_active: true }), QUIET, 'the report holds the item');
  assert.deepEqual(stop([...first, sentBack(one.stderr), said('Adrian asked the run to stop at the draft.')], { stop_hook_active: true }), QUIET,
    'the review-loop check sent this turn back already');
  assert.deepEqual(stop([...loop, sentBack('Run the linter first.', 'node other-hook.mjs'), NOT_MERGED], { stop_hook_active: true }), QUIET,
    'the last send-back is another hook\'s');
  assert.deepEqual(stop([...first, skillRun('k1', 'aidrian:pr-review-loop'), ready, REFUSED, NOT_MERGED], { stop_hook_active: true }), QUIET,
    'no send-back the transcript shows');
  assert.deepEqual(stop([...loop, NOT_MERGED], { stop_hook_active: undefined }), QUIET, 'a payload without stop_hook_active');
  const codex = { session_id: '019a-codex', turn_id: 'turn-7', model: 'gpt-5.5', permission_mode: 'default', cwd: dir, stop_hook_active: true };
  assert.deepEqual(stop([...loop, NOT_MERGED], codex), QUIET, 'a Codex payload: its rollout is not read');
});

test('after the announce send-back, a continuation that opens a draft and runs no review is sent back', (t) => {
  const { stop } = setup(t);
  const first = [human('implement #400'), said('HAL9K will now implement #400, unless Adrian says otherwise.')];
  const one = stop(first);
  assert.equal(one.status, 2);
  assert.match(one.stderr, /^The last message announces work and ends the turn without doing it/u);
  const draft = [...first, sentBack(one.stderr), skillRun('p1', 'aidrian:pr-write'), DRAFT, DONE];
  const two = stop(draft, { stop_hook_active: true });
  assert.equal(two.status, 2);
  assert.match(two.stderr, /^This turn opened or updated a draft pull request and ran no review after it\./u);
  assert.deepEqual(stop([...draft, sentBack(two.stderr), said('Adrian asked the run to stop at the draft.')], { stop_hook_active: true }), QUIET,
    'each check sent this turn back once');
});

test('the review-loop check passes under "ask", after a review run, and with no pull request opened', (t) => {
  const { stop } = setup(t);
  const { stop: asking } = setup(t, { github: { reviewLoop: 'ask' } });
  assert.deepEqual(asking([human('go'), DRAFT, DONE]), QUIET, 'github.reviewLoop "ask"');
  assert.deepEqual(stop([human('go'), DRAFT, skillRun('k1', 'aidrian:pr-review-loop'), DONE]), QUIET, 'a pr-review-loop run after the draft');
  assert.deepEqual(stop([human('go'), DRAFT, REVIEW_COMMAND, DONE]), QUIET, 'an aidrian pr review call that printed its JSON');
  assert.deepEqual(stop([human('go'), call('b1', 'Bash', { command: 'npm test' }), result('b1', 'ok'), said('Done.')]), QUIET, 'no pull request opened');
});

test('a review before the draft, a pr-write run, and a task notification after the draft still send the turn back', (t) => {
  const { stop } = setup(t);
  assert.equal(stop([human('implement #400'), DRAFT, skillRun('k1', 'aidrian:pr-review'), DONE]).status, 2,
    'the integration review issue-implement runs after the draft is no review loop');
  assert.equal(stop([human('go'), skillRun('k1', 'aidrian:pr-review-loop'), DRAFT, DONE]).status, 2, 'the only review ran before the draft');
  const edit = [call('e1', 'Bash', { command: 'gh pr edit 40 --body-file b.md' }), result('e1', 'https://github.com/acme/notes/pull/40')];
  assert.equal(stop([human('go'), skillRun('p1', 'aidrian:pr-write'), edit, DONE]).status, 2, 'a pr-write run that updated a pull request, with no review after it');
  const notification = { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>done</task-notification>' } };
  assert.equal(stop([human('go'), DRAFT, notification, DONE]).status, 2, 'a task notification is not the Human');
  assert.deepEqual(stop([human('go'), DRAFT, said('Draft #40 is open.'), human('stop at the draft'), said('Stopped.')]), QUIET,
    'the Human wrote after the draft');
});

test('a message the Human typed mid-turn, a pr-write run that published nothing, and a body update after the loop pass', (t) => {
  const { stop } = setup(t);
  const queued = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', humanTurn: true, origin: { kind: 'human' }, prompt: 'stop at the draft' } };
  assert.deepEqual(stop([human('implement #400'), DRAFT, queued, call('x', 'Bash', { command: 'git status' }), result('x', 'clean'), said('Stopped at the draft.')]), QUIET,
    'the Human asked to stop while the agent worked');
  const failedAuth = [call('a', 'Bash', { command: 'gh auth status' }), result('a', 'not logged in', true)];
  assert.deepEqual(stop([human('open the pull request'), skillRun('p1', 'aidrian:pr-write'), failedAuth, said('pr-write stopped: gh auth status fails.')]), QUIET,
    'pr-write drafted a body and published nothing');
  const received = [call('r', 'Bash', { command: 'aidrian pr review 40' }), result('r', '{\n  "status": "received",\n  "pr": 40,\n  "residuals": [1]\n}')];
  const edit = [call('e', 'Bash', { command: 'gh pr edit 40 --body-file b.md' }), result('e', 'https://github.com/acme/notes/pull/40')];
  const ready = [call('g', 'Bash', { command: 'gh pr ready 40' }), result('g', 'ok')];
  assert.deepEqual(stop([human('go'), DRAFT, skillRun('k1', 'aidrian:pr-review-loop'), received, skillRun('p2', 'aidrian:pr-write'), edit, ready, said('Marked ready.')]), QUIET,
    'the loop copied its residuals into the body through pr-write, then marked the draft ready');
  const typedLoop = human('<command-message>aidrian:pr-review-loop</command-message>\n<command-name>/aidrian:pr-review-loop</command-name>\n<command-args>40</command-args>');
  assert.deepEqual(stop([typedLoop, received, skillRun('p2', 'aidrian:pr-write'), edit, ready, said('Marked ready.')]), QUIET,
    'a typed loop on a pull request from an earlier turn, with its residual update');
  assert.deepEqual(stop([human('run the review loop on #40'), skillRun('k1', 'aidrian:pr-review-loop'), received, skillRun('p2', 'aidrian:pr-write'), edit, ready, said('Marked ready.')]),
    QUIET, 'a loop asked for in plain words, with its residual update');
});

test('a new draft opened after the loop ran on another pull request is sent back', (t) => {
  const { stop } = setup(t);
  const received = [call('r', 'Bash', { command: 'aidrian pr review 40' }), result('r', '{\n  "status": "received",\n  "pr": 40\n}')];
  const second = [call('d2', 'Bash', { command: 'gh pr create --draft --title t2 --body-file c.md' }), result('d2', 'https://github.com/acme/notes/pull/41')];
  assert.equal(stop([human('go'), DRAFT, skillRun('k1', 'aidrian:pr-review-loop'), received, second, said('Opened #41.')]).status, 2);
  const publish = [call('e2', 'Bash', { command: 'gh pr edit 41 --body-file c.md' }), result('e2', 'https://github.com/acme/notes/pull/41')];
  assert.equal(stop([human('go'), DRAFT, received, skillRun('p2', 'aidrian:pr-write'), publish, said('Published #41.')]).status, 2,
    'a pr-write update of another pull request after the loop on #40');
  const loop41 = [call('k2', 'Skill', { skill: 'aidrian:pr-review-loop', args: '41' }), result('k2', 'Launching skill: aidrian:pr-review-loop')];
  assert.deepEqual(stop([human('go'), DRAFT, received, skillRun('p2', 'aidrian:pr-write'), publish, loop41, said('Looped #41.')]), QUIET,
    'each draft has its own loop');
  assert.equal(stop([human('go'), DRAFT, second, loop41, said('Looped #41.')]).status, 2, 'two drafts, one loop: #40 is still owed');
  const both = stop([human('go'), DRAFT, second, said('Opened #40 and #41.')]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /^This turn opened or updated a draft pull request and ran no review after it\. The drafts owed a review: #40, #41\./u,
    'one send-back names every draft still owed');
  assert.match(both.stderr, /run the `pr-review-loop` skill on each now/u);
});

test('the review-loop check holds while a background task runs, and is quiet on Codex, outside a project, and without a transcript', (t) => {
  const { stop, dir, base } = setup(t);
  const owed = [human('go'), DRAFT, DONE];
  assert.deepEqual(stop(owed, { background_tasks: [{ id: 'b1', status: 'running' }] }), QUIET, 'a background task still running');
  assert.equal(stop(owed, { background_tasks: [{ id: 'b1', status: 'completed' }] }).status, 2, 'a background task that ended');
  assert.deepEqual(stop(owed, { stop_hook_active: undefined }), QUIET, 'a payload without stop_hook_active');
  assert.deepEqual(stop(owed, { cwd: base }), QUIET, 'outside a project');
  assert.deepEqual(stop(owed, { transcript_path: path.join(base, 'missing.jsonl') }), QUIET, 'no transcript');
  const codex = { session_id: '019a-codex', turn_id: 'turn-7', model: 'gpt-5.5', permission_mode: 'default', last_assistant_message: 'Draft #40 is open.', cwd: dir };
  assert.deepEqual(stop(owed, codex), QUIET, 'a Codex payload: its rollout is not read');
});

test('reviewLoopOwed: a reason only under "auto", with a transcript, and for a draft no review follows', () => {
  const draft = { kind: 'draft' };
  const review = { kind: 'review' };
  const owed = (actions, options = {}, input = {}) => reviewLoopOwed(input, actions, { reviewLoop: 'auto', human: 'Adrian', ...options });
  assert.ok(owed([draft]));
  assert.ok(owed([review, draft]));
  assert.ok(owed([draft, review, draft]), 'a draft counted after the review, such as a second new pull request');
  assert.equal(owed([draft, review]), null);
  assert.equal(owed([]), null);
  assert.equal(owed(null), null, 'no transcript');
  assert.equal(owed([draft], { reviewLoop: 'ask' }), null);
  assert.equal(owed([draft], { reviewLoop: undefined }), null);
  assert.equal(owed([draft], {}, { background_tasks: [{ id: 'b1', status: 'running' }] }), null);
  assert.match(reviewLoopOwed({}, [draft], { reviewLoop: 'auto' }), /when the Human asked the run to stop at the draft/u, 'the default name');
  const of = (kind, pr) => ({ kind, pr });
  assert.ok(owed([of('draft', 40), of('review', 41)]), 'a review of another pull request');
  assert.ok(owed([of('draft', 40), of('draft', 41), of('review', 41)]), 'a second draft reviewed, the first not');
  assert.equal(owed([of('draft', 40), of('review', null)]), null, 'a review of no known pull request may be of any');
  assert.equal(owed([of('draft', null), of('review', 41)]), null, 'a draft of no known pull request, and a review');
  assert.equal(owed([of('draft', 40), of('draft', 41), of('review', 41), of('review', 40)]), null);
  assert.equal(owed([of('draft', 40), of('merge', 40)]), null, 'a merged pull request owes no review');
  assert.equal(owed([of('draft', 40), of('merge', 0)]), null, 'a merge of the current branch may be of any');
  assert.ok(owed([of('draft', 40), of('merge', 41)]), 'a merge of another pull request');
  assert.ok(owed([of('merge', 40), of('draft', 40)]), 'a draft after the merge, such as a new pull request');
  assert.match(owed([of('draft', 40)]), /after it\. The draft owed a review: #40\. .* skill on it now/u, 'one draft');
  assert.match(owed([of('draft', 40), of('review', 40), of('draft', 41), of('draft', 41), of('draft', null)]),
    /The drafts owed a review: #41, a draft with no number shown\. .* skill on each now/u, 'each owed draft once, and one with no number');
  assert.match(owed([of('draft', null), of('draft', null)]), /The drafts owed a review: 2 drafts with no number shown\./u);
  assert.match(owed([draft]), /The draft owed a review: a draft with no number shown\./u, 'a draft action with no pr');
});
