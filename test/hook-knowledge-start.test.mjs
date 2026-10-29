import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const BIN = path.join(ROOT, 'plugins/aidrian/bin');
const HOOK = path.join(ROOT, 'plugins/aidrian/scripts/hook-knowledge-start.mjs');

const WITHOUT_BIN = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== BIN).join(path.delimiter);
const LINE = (command) =>
  'Project knowledge: 2 buckets, 8 docs. Read now: docs/knowledge/engineering/working-agreement.md. ' +
  `For more, run \`${command} route <tag>\` for your tags or \`${command} search <words>\` for a topic.`;

function hook({ input = '{}', args = [], cwd = ROOT, PATH = WITHOUT_BIN } = {}) {
  return spawnSync(process.execPath, [HOOK, ...args], { input, cwd, encoding: 'utf8', env: { ...process.env, PATH } });
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

test('a project with broken buckets still gets the line, plus how many problems check reports', (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.aidrian'));
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify({ buckets: ['missing'], extra: 1 }));
  const { status, stdout } = hook({ input: JSON.stringify({ cwd: project }) });
  assert.equal(status, 0);
  assert.match(stdout, /^Project knowledge: 0 buckets, 0 docs\. For more, run .* `\S+ check` reports 2 problems\.\n$/);
});
