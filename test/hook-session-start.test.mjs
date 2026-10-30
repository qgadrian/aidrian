import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const BIN = path.join(ROOT, 'plugins/aidrian/bin');
const HOOK = path.join(ROOT, 'plugins/aidrian/scripts/hook-session-start.mjs');
// An empty state folder, so a developer's own lesson inbox never reaches these tests.
const XDG = mkdtempSync(path.join(tmpdir(), 'aidrian-start-state-'));
test.after(() => rmSync(XDG, { recursive: true, force: true }));

const WITHOUT_BIN = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== BIN).join(path.delimiter);
const LINE = (command) =>
  'Project knowledge: 2 buckets, 8 docs. Read now: docs/knowledge/engineering/working-agreement.md. ' +
  `For more, run \`${command} route <tag>\` for your tags or \`${command} search <words>\` for a topic.`;
const NAMES = (ai, human = 'the Human') => `Names: call the human "${human}" and yourself "${ai}"; never "you"/"me".`;

// Without CLAUDECODE=1, which Claude Code sets for its hooks, the host is Codex. `CLAUDECODE: '1'` makes it Claude Code.
function hook({ input = '{}', args = [], cwd = ROOT, PATH = WITHOUT_BIN, XDG_STATE_HOME = XDG, CLAUDECODE } = {}) {
  const env = { ...process.env, PATH, XDG_STATE_HOME, CLAUDECODE };
  if (CLAUDECODE === undefined) delete env.CLAUDECODE;
  return spawnSync(process.execPath, [HOOK, ...args], { input, cwd, encoding: 'utf8', env });
}

test('at session start, one plain line names the always docs and the commands, by full path when bin/ is not on PATH', () => {
  const { status, stdout, stderr } = hook({ input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: EXAMPLE }) });
  assert.deepEqual([status, stdout, stderr], [0, `${LINE(path.join(BIN, 'aidrian-knowledge'))}\n${NAMES('Codex')}\n`, '']);
});

test('the bare command name is used when bin/ is on PATH, and the project is found from the process folder without a cwd', () => {
  const { status, stdout } = hook({ input: 'not json', cwd: path.join(EXAMPLE, 'src'), PATH: `${BIN}${path.delimiter}${WITHOUT_BIN}` });
  assert.equal(status, 0);
  assert.equal(stdout, `${LINE('aidrian-knowledge')}\n${NAMES('Codex')}\n`);
});

test('at subagent start, the same lines come as SubagentStart additional context', () => {
  const { status, stdout } = hook({ args: ['--subagent'], input: JSON.stringify({ cwd: EXAMPLE, agent_type: 'Explore' }), CLAUDECODE: '1' });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: `${LINE(path.join(BIN, 'aidrian-knowledge'))}\n${NAMES('Claude')}` },
  });
});

test('the names line calls the AI by its host unless config.json or .aidrian.local.json names it, the local file winning', (t) => {
  const input = JSON.stringify({ cwd: EXAMPLE });
  assert.equal(hook({ input, CLAUDECODE: '1' }).stdout.split('\n')[1], NAMES('Claude'));
  assert.equal(hook({ input }).stdout.split('\n')[1], NAMES('Codex'));

  const project = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify({ version: 1, names: { human: 'the team lead', ai: 'the agent' } }));
  writeFileSync(path.join(project, '.aidrian.local.json'), JSON.stringify({ names: { human: 'the "product" owner' } }));
  const lines = hook({ input: JSON.stringify({ cwd: project }), CLAUDECODE: '1' }).stdout.split('\n');
  assert.equal(lines[1], 'Names: call the human "the \\"product\\" owner" and yourself "the agent"; never "you"/"me".');
});

test('outside a project, and for any stdin, the hook prints nothing and exits 0', (t) => {
  const outside = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  for (const input of ['', 'not json', '[]', JSON.stringify({ cwd: outside }), JSON.stringify({ cwd: 42 })]) {
    for (const args of [[], ['--subagent']]) {
      const { status, stdout, stderr } = hook({ input, args, cwd: outside });
      assert.deepEqual([status, stdout, stderr], [0, '', ''], `${input} ${args}`);
    }
  }
});

test('a project with a broken folder still gets the line, plus how many problems it has and the check to run', (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify({ version: 1, extra: 1 }));
  writeFileSync(path.join(project, '.aidrian/knowledge/kb.json'), JSON.stringify({ dir: 'missing' }));
  const { status, stdout } = hook({ input: JSON.stringify({ cwd: project }) });
  assert.equal(status, 0);
  assert.match(stdout, /^Project knowledge: 0 buckets, 0 docs\. For more, run .* for a topic\. The project folder has 2 problems; run `\S+\/aidrian check`\.\n/);
  assert.equal(stdout.split('\n').slice(1).join('\n'), `${NAMES('Codex')}\n`);
});

test('the main session also hears about open lessons, escalated with the command to list them once a P1 is open; a subagent does not', (t) => {
  const xdg = mkdtempSync(path.join(tmpdir(), 'aidrian-start-state-'));
  t.after(() => rmSync(xdg, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: xdg, PATH: WITHOUT_BIN };
  const add = (note) => spawnSync(path.join(BIN, 'aidrian'), ['lesson', 'add'], { cwd: EXAMPLE, input: note, encoding: 'utf8', env });
  assert.equal(add('the first lesson').status, 0);
  assert.equal(add('the second lesson').status, 0);

  const input = JSON.stringify({ cwd: EXAMPLE });
  const [knowledge, names, lessons, rest] = hook({ input, XDG_STATE_HOME: xdg }).stdout.split('\n');
  assert.equal(knowledge, LINE(path.join(BIN, 'aidrian-knowledge')));
  assert.equal(names, NAMES('Codex'));
  assert.equal(lessons, 'Lesson inbox: 2 open (P2 2), the oldest from today. The lesson-triage skill drains it in a session opened for it.');
  assert.equal(rest, '');
  assert.doesNotMatch(hook({ input, args: ['--subagent'], XDG_STATE_HOME: xdg }).stdout, /Lesson inbox/);

  const urgent = spawnSync(path.join(BIN, 'aidrian'), ['lesson', 'add', '--tier', 'P1'], { cwd: EXAMPLE, input: 'lost a commit', encoding: 'utf8', env });
  assert.equal(urgent.status, 0);
  const escalated = hook({ input, XDG_STATE_HOME: xdg }).stdout.split('\n')[2];
  assert.match(escalated, /^Lesson inbox needs triage: 1 P1 open\. Tell the Human once, then go on with the task: .* `\S+\/bin\/aidrian lesson list` shows the order\.$/);
});
