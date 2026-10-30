import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { inboxPath, lessons } from '../plugins/aidrian/lib/lesson-inbox.mjs';
import { deliverySignal, denialSignal, noteDenial, recordSignal, REPEATED_DENIALS, roundLimitSignal } from '../plugins/aidrian/lib/lesson-signals.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';

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
  const all = () => lessons(inboxPath(proj));
  const hook = (script, input) => spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify({ cwd: dir, ...input }), encoding: 'utf8', env });
  return { dir, temp, proj, all, hook };
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
  const { proj, all } = project(t);
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
  const { dir, temp, all } = project(t);
  const input = (session) => ({ session_id: session, cwd: dir, agent_type: 'aidrian:explorer' });
  const results = Array.from({ length: REPEATED_DENIALS + 1 }, () => noteDenial(input('s1'), 'git-amend', { dir: temp }));
  assert.deepEqual(results.map(Boolean), [false, false, true, false]);
  assert.equal(results[2].agent, 'aidrian:explorer');
  noteDenial(input('s1'), 'process-kill', { dir: temp });
  noteDenial(input('s2'), 'git-amend', { dir: temp });
  assert.deepEqual(JSON.parse(readFileSync(path.join(temp, 'aidrian-denials-s1.json'), 'utf8')), { 'git-amend': 4, 'process-kill': 1 });
  assert.deepEqual(all().map((lesson) => [lesson.key, lesson.seen]), [['hook-deny:git-amend', 1]]);
  for (const session of [undefined, '../x', 'a b']) assert.equal(noteDenial({ session_id: session, cwd: dir }, 'git-amend', { dir: temp }), null);
  const outside = mkdtempSync(path.join(temp, 'outside-'));
  for (let i = 0; i < REPEATED_DENIALS; i += 1) assert.equal(noteDenial({ session_id: 's9', cwd: outside }, 'git-amend', { dir: temp }), null);
});

test('the Bash hook still blocks every time, and the third block of a rule in a session becomes a lesson', (t) => {
  const { all, hook } = project(t);
  const amend = { tool_name: 'Bash', tool_input: { command: 'git commit --amend' }, session_id: 'bash-1' };
  const statuses = Array.from({ length: REPEATED_DENIALS }, () => hook('hook-bash.mjs', amend).status);
  assert.deepEqual(statuses, Array(REPEATED_DENIALS).fill(2));
  assert.deepEqual(all().map((lesson) => [lesson.key, lesson.target, lesson.session]), [['hook-deny:git-amend', 'plugin', 'bash-1']]);
  assert.equal(hook('hook-bash.mjs', { ...amend, tool_input: { command: 'git status' } }).status, 0);
});

test('the write hook counts its main-checkout blocks the same way', (t) => {
  const { dir, all, hook } = project(t, { version: 1, mainCheckout: { guard: true } });
  writeFileSync(path.join(dir, 'app.js'), '');
  spawnSync('git', ['-C', dir, 'add', 'app.js']);
  const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'app.js') }, session_id: 'write-1' };
  assert.deepEqual(Array.from({ length: REPEATED_DENIALS }, () => hook('hook-write.mjs', edit).status), Array(REPEATED_DENIALS).fill(2));
  assert.deepEqual(all().map((lesson) => lesson.key), ['hook-deny:main-checkout']);
});

test('a delivery-check send-back becomes a lesson for that agent type; the second stop adds nothing', (t) => {
  const { all, hook } = project(t);
  const stop = (agentType, active) =>
    hook('hook-subagent-stop.mjs', { session_id: 's1', agent_id: 'a1', agent_type: agentType, last_assistant_message: 'Wrote out/handoff.json.', stop_hook_active: active });
  assert.equal(stop('planner', false).status, 2);
  assert.equal(stop('planner', true).status, 0);
  assert.equal(stop('planner', false).status, 2);
  assert.equal(stop('aidrian:planning-agent', false).status, 2);
  assert.deepEqual(
    all().map((lesson) => [lesson.key, lesson.target, lesson.seen, lesson.evidence]),
    [
      ['delivery-check:planner', 'project', 2, ['dispatch log: agent a1']],
      ['delivery-check:aidrian:planning-agent', 'plugin', 1, ['dispatch log: agent a1']],
    ],
  );
});

test('with telemetry off, a send-back is still a lesson, and it names no dispatch log row', (t) => {
  const { all, hook } = project(t, { version: 1, telemetry: { enabled: false } });
  assert.equal(hook('hook-subagent-stop.mjs', { session_id: 's1', agent_id: 'a1', agent_type: 'planner', last_assistant_message: 'Wrote out/x.json.', stop_hook_active: false }).status, 2);
  assert.deepEqual(all().map((lesson) => [lesson.key, lesson.evidence]), [['delivery-check:planner', []]]);
});

test('signals write nothing with lessons.auto off, and the hooks still block', (t) => {
  const { proj, all, hook } = project(t, { version: 1, lessons: { auto: false } });
  for (let i = 0; i < REPEATED_DENIALS; i += 1) assert.equal(hook('hook-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'git commit --amend' }, session_id: 'off' }).status, 2);
  assert.equal(hook('hook-subagent-stop.mjs', { agent_id: 'a1', agent_type: 'planner', last_assistant_message: 'Wrote out/x.json.', stop_hook_active: false }).status, 2);
  assert.deepEqual(all(), []);
  assert.equal(existsSync(inboxPath(proj)), false);
});
