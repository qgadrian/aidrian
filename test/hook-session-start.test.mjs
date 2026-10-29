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

function hook({ input = '{}', args = [], cwd = ROOT, PATH = WITHOUT_BIN, XDG_STATE_HOME = XDG } = {}) {
  return spawnSync(process.execPath, [HOOK, ...args], { input, cwd, encoding: 'utf8', env: { ...process.env, PATH, XDG_STATE_HOME } });
}

test('at session start, one plain line names the always docs and the commands, by full path when bin/ is not on PATH', () => {
  const { status, stdout, stderr } = hook({ input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: EXAMPLE }) });
  assert.deepEqual([status, stdout, stderr], [0, `${LINE(path.join(BIN, 'aidrian-knowledge'))}\n`, '']);
});

test('the bare command name is used when bin/ is on PATH, and the project is found from the process folder without a cwd', () => {
  const { status, stdout } = hook({ input: 'not json', cwd: path.join(EXAMPLE, 'src'), PATH: `${BIN}${path.delimiter}${WITHOUT_BIN}` });
  assert.equal(status, 0);
  assert.equal(stdout, `${LINE('aidrian-knowledge')}\n`);
});

test('at subagent start, the same line comes as SubagentStart additional context', () => {
  const { status, stdout } = hook({ args: ['--subagent'], input: JSON.stringify({ cwd: EXAMPLE, agent_type: 'Explore' }) });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: LINE(path.join(BIN, 'aidrian-knowledge')) },
  });
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
  assert.match(stdout, /^Project knowledge: 0 buckets, 0 docs\. For more, run .* for a topic\. The project folder has 2 problems; run `\S+\/aidrian check`\.\n$/);
});

test('the main session also hears about open lessons, with the command to list them; a subagent does not', (t) => {
  const xdg = mkdtempSync(path.join(tmpdir(), 'aidrian-start-state-'));
  t.after(() => rmSync(xdg, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: xdg, PATH: WITHOUT_BIN };
  const add = (note) => spawnSync(path.join(BIN, 'aidrian'), ['lesson', 'add'], { cwd: EXAMPLE, input: note, encoding: 'utf8', env });
  assert.equal(add('the first lesson').status, 0);
  assert.equal(add('the second lesson').status, 0);

  const input = JSON.stringify({ cwd: EXAMPLE });
  const [knowledge, lessons, rest] = hook({ input, XDG_STATE_HOME: xdg }).stdout.split('\n');
  assert.equal(knowledge, LINE(path.join(BIN, 'aidrian-knowledge')));
  assert.match(lessons, /^Lesson inbox: 2 open lessons \(oldest \d{4}-\d\d-\d\d\)\. Run the lesson-triage skill in a session opened for it; `\S+\/bin\/aidrian lesson list` shows them\.$/);
  assert.equal(rest, '');
  assert.doesNotMatch(hook({ input, args: ['--subagent'], XDG_STATE_HOME: xdg }).stdout, /Lesson inbox/);
});
