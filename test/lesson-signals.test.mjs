import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { inboxPath, lessons, pluginInboxPath } from '../plugins/aidrian/lib/lesson-inbox.mjs';
import { deliverySignal, denialSignal, forgetDenials, noteDenial, recordSignal, REPEATED_DENIALS, roundLimitSignal } from '../plugins/aidrian/lib/lesson-signals.mjs';
import { projectAt, projectId } from '../plugins/aidrian/lib/project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPTS = path.join(ROOT, 'plugins/aidrian/scripts');

// A copy of the example consumer in a git repository, with its own state and temporary folders. The variables are set
// for this process too, so library calls and hook processes share the state folder.
function project(t, config = { version: 1 }) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-signals-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  for (const entry of ['docs', '.gitignore']) cpSync(path.join(ROOT, 'examples/consumer', entry), path.join(dir, entry), { recursive: true });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  const temp = path.join(base, 'tmp');
  mkdirSync(temp);
  const env = { ...process.env, XDG_STATE_HOME: path.join(base, 'state'), TMPDIR: temp };
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
  t.after(() => (saved === undefined ? delete process.env.XDG_STATE_HOME : (process.env.XDG_STATE_HOME = saved)));
  const proj = projectAt(dir);
  // The project's own inbox, and the plugin's, where a signal for the plugin lands.
  const all = () => lessons(inboxPath(proj));
  const plugin = () => lessons(pluginInboxPath());
  const hook = (script, input) => spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify({ cwd: dir, ...input }), encoding: 'utf8', env });
  return { dir, temp, proj, all, plugin, hook };
}

test('each signal names its key, tier, and target; a plugin agent is the plugin\'s to fix', () => {
  const plugin = deliverySignal({ agentType: 'aidrian:planning-agent', agentId: 'a1', session: 's1', missing: ['plans/x.md'] });
  assert.deepEqual(
    { ...plugin, title: undefined },
    {
      key: 'delivery-check:aidrian:planning-agent', tier: 'P2', kind: 'bug', target: 'plugin', title: undefined,
      note: 'aidrian:planning-agent presented plans/x.md as written, and it did not exist.', evidence: ['dispatch log: agent a1'], session: 's1', agent: 'aidrian:planning-agent',
    },
  );
  assert.equal(deliverySignal({ agentType: 'Explore', missing: ['a.md', 'b.json'] }).target, 'project');
  assert.match(deliverySignal({ agentType: 'Explore', missing: ['a.md', 'b.json'] }).note, /a\.md, b\.json as written, and they did not exist/);
  assert.deepEqual([denialSignal({ rule: 'git-amend', session: 's1' }).key, denialSignal({ rule: 'git-amend' }).target], ['hook-deny:git-amend', 'plugin']);
  assert.deepEqual([denialSignal({ rule: 'agent-gates' }).target, denialSignal({ rule: 'config-guard' }).target], ['project', 'plugin'], 'the project writes the gates');
  const rounds = roundLimitSignal({ repo: 'acme/notes', pr: 42, maxRounds: 10, rounds: 11 });
  assert.deepEqual([rounds.key, rounds.once, rounds.target, rounds.evidence], ['review-rounds', 'acme/notes#42@11', 'project', ['https://github.com/acme/notes/pull/42']]);
  assert.match(rounds.note, /^Pull request #42 in acme\/notes reached 10 bot review rounds\./);
});

test('a signal dedupes by its key, reopens a fix it recurs after, and stays off when the project turns signals off', (t) => {
  const { proj, plugin: all } = project(t);
  const signal = denialSignal({ rule: 'git-amend', session: 's1' });
  const first = recordSignal(proj, signal, { now: new Date(Date.now() - 60_000) });
  assert.equal(first.source, 'auto');
  recordSignal(proj, { ...signal, session: 's2' });
  const [only] = all();
  assert.deepEqual([only.id, only.key, only.seen, only.source, only.title], [first.id, 'hook-deny:git-amend', 2, 'auto', `The git-amend rule blocked one session ${REPEATED_DENIALS} times`]);
  spawnSync(path.join(ROOT, 'plugins/aidrian/bin/aidrian'), ['lesson', 'resolve', first.id, '--outcome', 'mechanism', '--link', 'abc1234'], { cwd: proj.root, encoding: 'utf8' });
  assert.equal(all()[0].status, 'resolved');
  recordSignal(proj, { ...signal, session: 's3' }, { now: new Date(Date.now() + 60_000) });
  assert.deepEqual([all()[0].status, all()[0].reopened, all()[0].seen], ['open', 1, 3]);

  const off = { ...DEFAULTS, lessons: { ...DEFAULTS.lessons, auto: false } };
  assert.equal(recordSignal(proj, deliverySignal({ agentType: 'Explore', missing: ['x.md'] }), { config: off }), null);
  assert.equal(all().length, 1);
});

test('noteDenial records a lesson on the third block of one rule in one session, once', (t) => {
  const { dir, temp, plugin: all } = project(t);
  const input = (session) => ({ session_id: session, cwd: dir, agent_type: 'aidrian:explorer' });
  const results = Array.from({ length: REPEATED_DENIALS + 1 }, () => noteDenial(input('s1'), 'git-amend', { dir: temp }));
  assert.deepEqual(results.map(Boolean), [false, false, true, false]);
  assert.equal(results[2].agent, 'aidrian:explorer');
  noteDenial(input('s1'), 'process-kill', { dir: temp });
  noteDenial(input('s2'), 'git-amend', { dir: temp });
  const count = (session, rule) => readFileSync(path.join(temp, `aidrian-denials-${session}`, rule), 'utf8').length;
  assert.deepEqual([count('s1', 'git-amend'), count('s1', 'process-kill'), count('s2', 'git-amend')], [4, 1, 1]);
  assert.equal(noteDenial(input('s1'), '../x', { dir: temp }), null, 'a rule name that is not a file name part counts nothing');
  assert.deepEqual(all().map((lesson) => [lesson.key, lesson.seen]), [['hook-deny:git-amend', 1]]);
  for (const session of [undefined, '../x', 'a b']) assert.equal(noteDenial({ session_id: session, cwd: dir }, 'git-amend', { dir: temp }), null);
  const outside = mkdtempSync(path.join(temp, 'outside-'));
  for (let i = 0; i < REPEATED_DENIALS; i += 1) assert.equal(noteDenial({ session_id: 's9', cwd: outside }, 'git-amend', { dir: temp }), null);
});

test('blocks that land at the same time all count, and exactly one of them records the lesson', async (t) => {
  const { dir, temp, plugin: all } = project(t);
  const blocks = 12;
  const script = `import { noteDenial } from ${JSON.stringify(path.join(ROOT, 'plugins/aidrian/lib/lesson-signals.mjs'))};\n`
    + `noteDenial({ session_id: 'race', cwd: ${JSON.stringify(dir)}, agent_type: 'aidrian:explorer' }, 'git-amend', { dir: ${JSON.stringify(temp)} });\n`;
  const exits = await Promise.all(Array.from({ length: blocks }, () => new Promise((resolve) => {
    spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' }).on('exit', resolve);
  })));
  assert.deepEqual(exits, Array(blocks).fill(0));
  assert.equal(readFileSync(path.join(temp, 'aidrian-denials-race', 'git-amend'), 'utf8').length, blocks);
  assert.deepEqual(all().map((lesson) => [lesson.key, lesson.seen]), [['hook-deny:git-amend', 1]]);
});

test('the session-end hook deletes the session`s block counts and no other session`s', (t) => {
  const { dir, temp, hook } = project(t);
  for (let i = 0; i < REPEATED_DENIALS; i += 1) noteDenial({ session_id: 'ending', cwd: dir }, 'git-amend', { dir: temp });
  noteDenial({ session_id: 'ending', cwd: dir }, 'process-kill', { dir: temp });
  noteDenial({ session_id: 'ending-2', cwd: dir }, 'git-amend', { dir: temp });
  const left = () => readdirSync(temp).filter((name) => name.startsWith('aidrian-denials-'))
    .flatMap((folder) => readdirSync(path.join(temp, folder)).map((name) => `${folder}/${name}`)).sort();
  assert.deepEqual(left(), ['aidrian-denials-ending-2/git-amend', 'aidrian-denials-ending/git-amend', 'aidrian-denials-ending/git-amend.recorded', 'aidrian-denials-ending/process-kill']);
  assert.equal(hook('hook-session-end.mjs', { session_id: 'ending' }).status, 0);
  assert.deepEqual(left(), ['aidrian-denials-ending-2/git-amend']);
});

test('forgetDenials deletes a session`s block counts without listing the temporary folder', { skip: process.platform === 'win32' }, (t) => {
  const { dir, temp } = project(t);
  const block = () => noteDenial({ session_id: 'ending', cwd: dir }, 'git-amend', { dir: temp });
  for (let i = 1; i < REPEATED_DENIALS; i += 1) assert.equal(block(), null);
  // A temporary folder that cannot be listed: the session's end must find its counts by path, since a listing of a
  // real temporary folder with a hundred thousand entries eats the session-end hook's time budget.
  chmodSync(temp, 0o300);
  try {
    forgetDenials('ending', { dir: temp });
  } finally {
    chmodSync(temp, 0o700);
  }
  // The count starts again: no block records a lesson before the REPEATED_DENIALS-th after the reset.
  for (let i = 1; i < REPEATED_DENIALS; i += 1) assert.equal(block(), null);
});

test('the Bash hook still blocks every time, and the third block of a rule in a session becomes a lesson in the plugin\'s inbox', (t) => {
  const { proj, all, plugin, hook } = project(t);
  const amend = { tool_name: 'Bash', tool_input: { command: 'git commit --amend' }, session_id: 'bash-1' };
  const statuses = Array.from({ length: REPEATED_DENIALS }, () => hook('hook-bash.mjs', amend).status);
  assert.deepEqual(statuses, Array(REPEATED_DENIALS).fill(2));
  assert.deepEqual(plugin().map((lesson) => [lesson.key, lesson.target, lesson.session, lesson.project]), [['hook-deny:git-amend', 'plugin', 'bash-1', projectId(proj)]]);
  assert.deepEqual(all(), [], 'a plugin lesson never lands in the project\'s own inbox');
  assert.equal(hook('hook-bash.mjs', { ...amend, tool_input: { command: 'git status' } }).status, 0);
});

// Holds `file`'s lock for this test's process, alive while a hook or call runs: the lock's next generation
// (jsonl.mjs withLocks), naming this pid on this host. Returns a function that releases it.
function holdLock(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const numbers = readdirSync(path.dirname(file)).map((name) => name.startsWith(`${path.basename(file)}.lock.`) && /\.lock\.(\d+)$/u.exec(name)?.[1]).filter(Boolean).map(Number);
  const name = `${file}.lock.${Math.max(0, ...numbers) + 1}`;
  writeFileSync(name, `${JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'test' })}\n`);
  return () => writeFileSync(`${name}.released`, '');
}

test('a signal never waits for a held inbox lock: it returns at once and records nothing', (t) => {
  const { proj, all } = project(t);
  holdLock(inboxPath(proj));
  const started = Date.now();
  assert.equal(recordSignal(proj, deliverySignal({ agentType: 'Explore', missing: ['x.md'] })), null);
  assert.ok(Date.now() - started < 1000, `it returned after ${Date.now() - started} ms`);
  assert.deepEqual(all(), []);
});

test('a hook blocks at once while the inbox lock is held, and the next block records the lesson it skipped', (t) => {
  const { plugin, hook } = project(t);
  const amend = { tool_name: 'Bash', tool_input: { command: 'git commit --amend' }, session_id: 'locked-1' };
  for (let i = 1; i < REPEATED_DENIALS; i += 1) assert.equal(hook('hook-bash.mjs', amend).status, 2);
  const release = holdLock(pluginInboxPath());
  const started = Date.now();
  const third = hook('hook-bash.mjs', amend);
  const took = Date.now() - started;
  assert.deepEqual([third.status, third.stderr.startsWith('Blocked: ')], [2, true]);
  assert.ok(took < 1500, `the third block took ${took} ms, inside the host's 5-second hook timeout`);
  assert.deepEqual(plugin(), [], 'the lesson is not recorded while the lock is held');
  release();
  assert.equal(hook('hook-bash.mjs', amend).status, 2);
  assert.deepEqual(plugin().map((lesson) => [lesson.key, lesson.session]), [['hook-deny:git-amend', 'locked-1']], 'the next block records it');
});

test('the write hook counts its main-checkout blocks the same way', (t) => {
  const { dir, plugin: all, hook } = project(t, { version: 1, git: { mainCheckout: { guard: true } } });
  writeFileSync(path.join(dir, 'app.js'), '');
  spawnSync('git', ['-C', dir, 'add', 'app.js']);
  const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'app.js') }, session_id: 'write-1' };
  assert.deepEqual(Array.from({ length: REPEATED_DENIALS }, () => hook('hook-write.mjs', edit).status), Array(REPEATED_DENIALS).fill(2));
  assert.deepEqual(all().map((lesson) => lesson.key), ['hook-deny:main-checkout']);
});

test('a delivery-check send-back becomes a lesson for that agent type; the second stop adds nothing', (t) => {
  const { all, plugin, hook } = project(t);
  const stop = (agentType, active) =>
    hook('hook-subagent-stop.mjs', { session_id: 's1', agent_id: 'a1', agent_type: agentType, last_assistant_message: 'Wrote out/handoff.json.', stop_hook_active: active });
  assert.equal(stop('planner', false).status, 2);
  assert.equal(stop('planner', true).status, 0);
  assert.equal(stop('planner', false).status, 2);
  assert.equal(stop('aidrian:planning-agent', false).status, 2);
  assert.deepEqual(
    [...all(), ...plugin()].map((lesson) => [lesson.key, lesson.target, lesson.seen, lesson.evidence, lesson.project !== null]),
    [
      ['delivery-check:planner', 'project', 2, ['dispatch log: agent a1'], false],
      ['delivery-check:aidrian:planning-agent', 'plugin', 1, ['dispatch log: agent a1'], true],
    ],
  );
  assert.deepEqual(plugin().map((lesson) => lesson.key), ['delivery-check:aidrian:planning-agent'], 'the plugin agent\'s lesson is in the plugin\'s inbox');
});

// A subagent transcript in Claude Code's shape: a background push and a resumed reviewer, each with the text result and the
// structured `toolUseResult` that names its id, as the stalled fix agents' transcripts held them.
function childTranscript(dir) {
  const call = (id, toolId, name, input) =>
    JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: toolId, name, input }] } });
  const result = (toolId, text, toolUseResult) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text }] }] }, toolUseResult });
  const file = path.join(dir, 'agent-a1.jsonl');
  writeFileSync(file, [
    call('m1', 't1', 'Bash', { command: 'git push -u origin fix/x', run_in_background: true }),
    result('t1', 'Command running in background with ID: bmnjbq03x. Output is being written to: /tmp/tasks/bmnjbq03x.output', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bmnjbq03x' }),
    call('m2', 't2', 'SendMessage', { to: 'a51c8e798c62f1139', message: 'Review the delta, please.' }),
    result('t2', '{"success":true,"message":"Resuming agent a51c8e7","resumedAgentId":"a51c8e798c62f1139"}', { success: true, message: 'Resuming agent a51c8e7', resumedAgentId: 'a51c8e798c62f1139' }),
  ].join('\n'));
  return file;
}

// Claude Code's `background_tasks`: the whole session's in-flight tasks, the subagent's own and others'.
const SESSION_TASKS = [
  { id: 'bmnjbq03x', type: 'shell', status: 'running', description: 'Push the branch', command: 'git push -u origin fix/x' },
  { id: 'a51c8e798c62f1139', type: 'subagent', status: 'running', description: 'Delta review', agent_type: 'general-purpose' },
  { id: 'bother0001', type: 'shell', status: 'running', description: 'Another agent\'s dev server', command: 'npm run dev' },
  { id: 'afix-1475', type: 'teammate', status: 'running', description: 'A peer teammate' },
];

test('a subagent that stops with a background task it started still running is sent back once to wait; ending anyway is a plugin lesson', (t) => {
  const { dir, all, plugin, hook } = project(t);
  const transcript = childTranscript(dir);
  const stop = (active, tasks = SESSION_TASKS) => hook('hook-subagent-stop.mjs', {
    session_id: 's1', agent_id: 'a1', agent_type: 'fix-1027', agent_transcript_path: transcript, last_assistant_message: 'Waiting for the push.',
    stop_hook_active: active, background_tasks: tasks,
  });
  const sent = stop(false);
  assert.equal(sent.status, 2);
  assert.match(sent.stderr, /^You started background work that is still running: `bmnjbq03x` \(shell: Push the branch\), `a51c8e798c62f1139` \(subagent: Delta review\)\. /);
  assert.match(sent.stderr, /Wait for it in the foreground before you end the turn/);
  assert.doesNotMatch(sent.stderr, /bother0001|afix-1475/, 'a task another agent started, and a peer teammate, are not its children');
  assert.deepEqual([...all(), ...plugin()], [], 'the send-back is the check working, not a lesson');

  assert.equal(stop(true).status, 0, 'the second stop always ends');
  assert.deepEqual(
    plugin().map((lesson) => [lesson.key, lesson.target, lesson.seen, lesson.evidence]),
    [['idle-with-children:fix-1027', 'plugin', 1, ['background task bmnjbq03x', 'background task a51c8e798c62f1139', 'dispatch log: agent a1']]],
  );
  assert.deepEqual(all(), [], 'the lesson is the plugin\'s, in the plugin\'s inbox');

  assert.equal(stop(false, SESSION_TASKS.slice(2)).status, 0, 'only others\' tasks still run');
  assert.equal(stop(false, [{ ...SESSION_TASKS[0], status: 'completed' }]).status, 0, 'its task ended');
  assert.equal(stop(false, []).status, 0);
  assert.equal(stop(true, []).status, 0);
  assert.equal(hook('hook-subagent-stop.mjs', { agent_id: 'a1', agent_type: 'fix-1027', agent_transcript_path: transcript, background_tasks: SESSION_TASKS }).status, 0, 'no stop_hook_active field: never sent back');
  assert.equal(hook('hook-subagent-stop.mjs', { agent_id: 'a1', agent_type: 'fix-1027', stop_hook_active: false, background_tasks: SESSION_TASKS }).status, 0, 'no transcript: no task is its own');
  assert.equal(plugin()[0].seen, 1, 'a stop with nothing of its own running adds no occurrence');
});

test('a subagent that reads, waits on, messages, or quotes the launch of another agent\'s running task is not sent back for it', (t) => {
  const { dir, all, plugin, hook } = project(t);
  const call = (id, toolId, name, input) =>
    JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: toolId, name, input }] } });
  const result = (toolId, text, toolUseResult) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text }] }, toolUseResult });
  const transcript = path.join(dir, 'agent-a2.jsonl');
  writeFileSync(transcript, [
    call('m1', 't1', 'Bash', { command: 'tail -5 /tmp/tasks/bother0001.output' }),
    result('t1', 'listening on :3000'),
    call('m2', 't2', 'Bash', { command: 'until ! pgrep -f "git push"; do sleep 5; done', timeout: 600000 }),
    result('t2', 'push of bmnjbq03x done'),
    call('m3', 't3', 'SendMessage', { to: 'a51c8e798c62f1139', message: 'Is the review done?' }),
    result('t3', '{"success":true,"message":"Message sent to a51c8e798c62f1139\'s inbox"}', { success: true, message: 'Message sent to a51c8e798c62f1139\'s inbox' }),
    // A foreground command whose output is a saved launch line, and a foreground agent whose report quotes an agentId line.
    call('m4', 't4', 'Bash', { command: 'cat saved-result.txt' }),
    result('t4', 'Command running in background with ID: bmnjbq03x. Output is being written to: /tmp/tasks/bmnjbq03x.output', { stdout: 'Command running in background with ID: bmnjbq03x.', stderr: '', interrupted: false }),
    call('m5', 't5', 'Agent', { description: 'Summarize the stall', prompt: 'Summarize it.' }),
    result('t5', 'The reviewer was launched as:\nagentId: a51c8e798c62f1139\nand never handed back.\n\nagentId: asum00001 (use SendMessage to continue this agent)', { status: 'completed', agentId: 'asum00001', content: [] }),
  ].join('\n'));
  for (const active of [false, true]) {
    const stop = hook('hook-subagent-stop.mjs', {
      session_id: 's1', agent_id: 'a2', agent_type: 'checker', agent_transcript_path: transcript, last_assistant_message: 'Checked the others.',
      stop_hook_active: active, background_tasks: SESSION_TASKS,
    });
    assert.deepEqual([stop.status, stop.stderr], [0, ''], `stop_hook_active ${active}`);
  }
  assert.deepEqual([...all(), ...plugin()], [], 'no false lesson');
});

test('a stop that names a missing file and leaves a task running is sent back once with both reasons', (t) => {
  const { dir, hook } = project(t);
  const sent = hook('hook-subagent-stop.mjs', {
    session_id: 's1', agent_id: 'a1', agent_type: 'planner', agent_transcript_path: childTranscript(dir), last_assistant_message: 'Wrote out/handoff.json.',
    stop_hook_active: false, background_tasks: SESSION_TASKS.slice(0, 1),
  });
  assert.equal(sent.status, 2);
  assert.match(sent.stderr, /^Your report names `out\/handoff\.json`, which does not exist\..*\n\nYou started background work that is still running: `bmnjbq03x`/su);
});

test('with telemetry off, a send-back is still a lesson, and it names no dispatch log row', (t) => {
  const { all, hook } = project(t, { version: 1, telemetry: { enabled: false } });
  assert.equal(hook('hook-subagent-stop.mjs', { session_id: 's1', agent_id: 'a1', agent_type: 'planner', last_assistant_message: 'Wrote out/x.json.', stop_hook_active: false }).status, 2);
  assert.deepEqual(all().map((lesson) => [lesson.key, lesson.evidence]), [['delivery-check:planner', []]]);
});

test('signals write nothing with lessons.auto off, and the hooks still block', (t) => {
  const { proj, all, plugin, hook } = project(t, { version: 1, lessons: { auto: false } });
  for (let i = 0; i < REPEATED_DENIALS; i += 1) assert.equal(hook('hook-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'git commit --amend' }, session_id: 'off' }).status, 2);
  assert.equal(hook('hook-subagent-stop.mjs', { agent_id: 'a1', agent_type: 'planner', last_assistant_message: 'Wrote out/x.json.', stop_hook_active: false }).status, 2);
  assert.deepEqual([all(), plugin()], [[], []]);
  assert.equal(existsSync(inboxPath(proj)), false);
  assert.equal(existsSync(pluginInboxPath()), false);
});
