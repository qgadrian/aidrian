import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { denyRow } from '../plugins/aidrian/lib/dispatch-rows.mjs';
import { firstSentence } from '../plugins/aidrian/lib/hook-deny.mjs';
import { inboxPath, lessons } from '../plugins/aidrian/lib/lesson-inbox.mjs';
import { REPEATED_DENIALS } from '../plugins/aidrian/lib/lesson-signals.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { REASON as HOOK_BYPASS } from '../plugins/aidrian/lib/rules/git-hook-bypass.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPTS = path.join(ROOT, 'plugins/aidrian/scripts');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');

// A copy of the example consumer in a git repository with a tracked app.js, its own state and temporary folders, and
// `config` as its config.json. The hooks run with no override set.
function project(t, config = { version: 1 }) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-deny-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  for (const entry of ['docs', '.gitignore']) cpSync(path.join(ROOT, 'examples/consumer', entry), path.join(dir, entry), { recursive: true });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  writeFileSync(path.join(dir, 'app.js'), '');
  spawnSync('git', ['-C', dir, 'add', 'app.js']);
  const temp = path.join(base, 'tmp');
  mkdirSync(temp);
  const env = { ...process.env, XDG_STATE_HOME: path.join(base, 'state'), TMPDIR: temp };
  const hook = (script, input) => spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify({ cwd: dir, ...input }), encoding: 'utf8', env });
  const state = () => spawnSync(CLI, ['state'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
  const rows = () => {
    try {
      return readFileSync(path.join(state(), 'dispatch-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const inbox = () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
    try {
      return lessons(inboxPath(projectAt(dir)));
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
    }
  };
  const report = (args) => spawnSync(CLI, ['report', ...args], { cwd: dir, env, encoding: 'utf8' });
  return { dir, hook, rows, inbox, report };
}

const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, session_id: 's1', ...extra });
const withoutTs = (row) => ({ ...row, ts: typeof row.ts });

test('a Bash rule`s block writes one hook_deny row: the rule, the tool, the agent, and the rule`s first sentence, never the command', (t) => {
  const { hook, rows } = project(t);
  const blocked = hook('hook-bash.mjs', bash('git commit --amend -m "SECRET token"', { agent_type: 'aidrian:explorer', agent_id: 'a1' }));
  assert.deepEqual([blocked.status, blocked.stdout], [2, '']);
  assert.match(blocked.stderr, /^Blocked: `git commit --amend` rewrites the branch tip,.*\(agents must never set it on the user's behalf\)\.\n$/s, 'the agent still reads the whole reason');
  assert.equal(hook('hook-bash.mjs', bash('pkill -f node')).status, 2);
  assert.equal(hook('hook-bash.mjs', bash('git status')).status, 0);
  assert.deepEqual(rows().map(withoutTs), [
    {
      event: 'hook_deny', ts: 'string', session_id: 's1', rule: 'git-amend', tool: 'Bash', agent_type: 'aidrian:explorer',
      reason: '`git commit --amend` rewrites the branch tip, and another agent working on this branch may already have built on it.'.slice(0, 120),
    },
    {
      event: 'hook_deny', ts: 'string', session_id: 's1', rule: 'process-kill', tool: 'Bash', agent_type: 'main',
      reason: "stopping processes by name (`pkill`, `killall`, `kill $(pgrep …)`, `… | xargs kill`) also stops other sessions' builds and git hooks that run the same programs.".slice(0, 120),
    },
  ]);
  assert.doesNotMatch(JSON.stringify(rows()), /SECRET|pkill -f node/);
});

test('telemetry.hookDenies false, or telemetry off: no row, the hooks still block, and the third block is still a lesson', (t) => {
  for (const telemetry of [{ hookDenies: false }, { enabled: false }]) {
    const { hook, rows, inbox } = project(t, { version: 1, telemetry });
    const statuses = Array.from({ length: REPEATED_DENIALS }, () => hook('hook-bash.mjs', bash('git commit --amend')).status);
    assert.deepEqual(statuses, Array(REPEATED_DENIALS).fill(2), JSON.stringify(telemetry));
    assert.deepEqual(rows(), [], JSON.stringify(telemetry));
    assert.deepEqual(inbox().map((lesson) => [lesson.key, lesson.target]), [['hook-deny:git-amend', 'plugin']], JSON.stringify(telemetry));
  }
});

test('the write hook, the agent gates, and the config guard record their blocks too; a gate that keeps blocking is the project`s lesson', (t) => {
  const { dir, hook, rows, inbox } = project(t, { version: 1, git: { mainCheckout: { guard: true } }, agents: { explorer: { deny: ['WebFetch'] } } });
  const explorer = { agent_type: 'aidrian:explorer', agent_id: 'a1', session_id: 's2' };
  assert.equal(hook('hook-write.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'app.js') }, session_id: 's2' }).status, 2);
  for (let i = 0; i < REPEATED_DENIALS; i += 1) {
    const gated = hook('hook-agent-gates.mjs', { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/SECRET' }, ...explorer });
    assert.match(gated.stderr, /^aidrian: WebFetch is blocked for the agent "aidrian:explorer" in this project: agents\.explorer\.deny has "WebFetch"/);
  }
  const guarded = hook('hook-agent-gates.mjs', { tool_name: 'Edit', tool_input: { file_path: '.aidrian/config.json' }, ...explorer });
  assert.equal(guarded.status, 2);
  assert.deepEqual(rows().map((row) => [row.rule, row.tool, row.agent_type, row.reason]), [
    ['main-checkout', 'Edit', 'main', "this writes 'app.js', a tracked file in the main checkout."],
    ...Array(REPEATED_DENIALS).fill(['agent-gates', 'WebFetch', 'aidrian:explorer', 'agents.explorer.deny has "WebFetch"']),
    ['config-guard', 'Edit', 'aidrian:explorer', 'changes .aidrian/config.json'],
  ]);
  assert.doesNotMatch(JSON.stringify(rows()), /SECRET/);
  assert.deepEqual(inbox().map((lesson) => [lesson.key, lesson.target, lesson.agent]), [['hook-deny:agent-gates', 'project', 'aidrian:explorer']]);
});

test('aidrian report shows the blocks by rule and agent, and says when hook denies are off', (t) => {
  const { hook, report } = project(t);
  for (let i = 0; i < REPEATED_DENIALS; i += 1) hook('hook-bash.mjs', bash('git commit --amend'));
  hook('hook-bash.mjs', bash('git commit --no-verify', { session_id: 's3', agent_type: 'aidrian:explorer', agent_id: 'a1' }));
  const text = report([]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /\nSessions: 0, \$0\.00 estimated, main conversation and subagents together\nHook denies: 4 in 2 sessions\n/);
  assert.match(text.stdout, /\n {2}git-amend: 3, by main 3; 1 session blocked 3 times or more, an automatic lesson\n {4}most often: `git commit --amend` rewrites/);
  assert.match(text.stdout, /\n {2}git-hook-bypass: 1, by aidrian:explorer 1\n {4}most often: this skips a git hook\.\n$/);
  const json = JSON.parse(report(['--json']).stdout);
  assert.deepEqual([json.hook_denies.count, json.hook_denies.by_rule.map((rule) => rule.rule), json.coverage.hook_denies], [4, ['git-amend', 'git-hook-bypass'], true]);

  const off = project(t, { version: 1, telemetry: { hookDenies: false } });
  assert.match(off.report([]).stdout, /^Dispatch log .*\nHook denies are off \(telemetry\.hookDenies is false\): the hooks still block, and log no hook_deny rows\.\nNo rows yet\.\n$/);
});

test('firstSentence drops the Blocked lead and stops at the first sentence or line; denyRow cuts the reason', () => {
  assert.equal(firstSentence(HOOK_BYPASS), 'this skips a git hook.');
  assert.equal(firstSentence('Blocked: the body has no `## Summary` section. config.json `github.requiredSections` lists them.\nMore.'), 'the body has no `## Summary` section.');
  assert.equal(firstSentence('one line\nanother'), 'one line');
  assert.equal(firstSentence("Blocked: this writes 'a.js', a tracked file in the main checkout (/srv/repo). Work elsewhere."), "this writes 'a.js', a tracked file in the main checkout.");
  const row = denyRow({ session_id: 's', tool_name: 'Bash' }, 'x', 'y'.repeat(200), { env: { CLAUDE_CODE_AGENT: 'orchestrator' }, now: Date.parse('2026-10-29T12:00:00Z') });
  assert.deepEqual({ ...row, reason: row.reason.length }, { event: 'hook_deny', ts: '2026-10-29T12:00:00.000Z', session_id: 's', rule: 'x', tool: 'Bash', agent_type: 'orchestrator', reason: 120 });
});
