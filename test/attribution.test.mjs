import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  agentName, branchCommits, carriedTrailers, currentAuthor, prAgents, prLines, prMissing, readTail, runEnv,
} from '../plugins/aidrian/lib/attribution.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { check, OVERRIDE } from '../plugins/aidrian/lib/rules/attribution.mjs';

const request = (id, model, effort) => JSON.stringify({ message: { id, model, usage: { input_tokens: 1, output_tokens: 1 } }, ...(effort ? { effort } : {}) });

// A project with `attribution`, a main transcript, a subagent transcript, and a dispatch log in its own state folder.
function setup(t, attribution = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-attr-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  mkdirSync(path.join(dir, 'state'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' }, attribution }));
  const transcript = path.join(dir, 's1.jsonl');
  writeFileSync(transcript, `${request('a', 'claude-sonnet-5-5')}\n${request('b', 'claude-opus-5-5', 'high')}\n`);
  mkdirSync(path.join(dir, 's1/subagents'), { recursive: true });
  writeFileSync(path.join(dir, 's1/subagents/agent-x1.jsonl'), `${request('c', 'claude-haiku-5-5')}\n`);
  const rows = [
    { event: 'dispatch', session_id: 's1', agent_type: 'aidrian:backend-developer' },
    { event: 'stop', session_id: 's1', agent_type: 'aidrian:backend-developer', models: ['claude-sonnet-5-5'] },
    { event: 'dispatch', session_id: 's1', agent_type: 'aidrian:explorer' },
    { event: 'dispatch', session_id: 's1', agent_type: 'aidrian:code-reviewer' },
    { event: 'dispatch', session_id: 'other', agent_type: 'aidrian:designer' },
  ];
  writeFileSync(path.join(dir, 'state/dispatch-log.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const input = { session_id: 's1', transcript_path: transcript };
  const run = (command, { env = {}, payload = input, commits = () => [] } = {}) => check(command, { cwd: dir, env, input: payload, commits });
  return { dir, input, run };
}

test('agentName drops the plugin prefix each host adds', () => {
  assert.equal(agentName('aidrian:backend-developer'), 'backend-developer');
  assert.equal(agentName('aidrian-backend-developer'), 'backend-developer');
  assert.equal(agentName('Explore'), 'Explore');
  assert.equal(agentName(''), null);
});

test('runEnv tells a cloud session, a CI runner, and a local one apart', () => {
  assert.equal(runEnv({ CLAUDE_CODE_REMOTE: 'true', CI: 'true' }), 'cloud');
  assert.equal(runEnv({ GITHUB_ACTIONS: 'true' }), 'ci');
  assert.equal(runEnv({ CI: '1' }), 'ci');
  assert.equal(runEnv({ CI: 'false' }), 'local');
  assert.equal(runEnv({}), 'local');
});

test('currentAuthor reads the last request; a subagent reads its own transcript and never the session env', (t) => {
  const { input } = setup(t);
  assert.deepEqual(currentAuthor(input, { CLAUDE_EFFORT: 'max' }),
    { agent: 'main', model: 'claude-opus-5-5', effort: 'high', tool: 'Claude Code', env: 'local' });
  const sub = currentAuthor({ ...input, agent_id: 'x1', agent_type: 'aidrian:backend-developer' }, { CLAUDE_EFFORT: 'max', CLAUDE_CODE_AGENT: 'orchestrator' });
  assert.deepEqual(sub, { agent: 'backend-developer', model: 'claude-haiku-5-5', effort: null, tool: 'Claude Code', env: 'local' });
  assert.equal(currentAuthor({ ...input, agent_id: 'nope' }, {}).model, null, 'a missing subagent transcript is unknown, not the parent model');
  assert.equal(currentAuthor(input, { CLAUDE_CODE_AGENT: 'aidrian:orchestrator' }).agent, 'orchestrator');
  assert.equal(currentAuthor(input, { CODEX_THREAD_ID: 't' }).tool, 'Codex');
});

test('readTail starts at a whole line', (t) => {
  const { dir } = setup(t);
  const file = path.join(dir, 'long.jsonl');
  writeFileSync(file, 'first line\nsecond line\n');
  assert.equal(readTail(file, 15), 'second line\n');
  assert.equal(readTail(path.join(dir, 'missing'), 15), null);
});

test('carriedTrailers counts the last paragraph and --trailer values, not a one-paragraph message', () => {
  assert.deepEqual([...carriedTrailers(['fix: x', 'Agent: main\nAgent-Model: m'], [])], ['Agent: main', 'Agent-Model: m']);
  assert.deepEqual([...carriedTrailers(['fix: x Agent: main'], ['Agent=main'])], ['Agent: main']);
  assert.equal(carriedTrailers(['fix: x\n\nAgent: main\n\nmore prose'], []).has('Agent: main'), false, 'not the last paragraph');
});

test('the commit rule asks for each configured trailer, and passes once the commit carries them', (t) => {
  const { dir, run } = setup(t, { commit: ['agent', 'model', 'effort'] });
  const trailers = "--trailer 'Agent: main' --trailer 'Agent-Model: claude-opus-5-5' --trailer 'Agent-Effort: high'";
  assert.match(run('git commit -m "fix: x"') ?? '', /--trailer 'Agent: main' --trailer 'Agent-Model: claude-opus-5-5' --trailer 'Agent-Effort: high'/);
  assert.equal(run(`git commit -m "fix: x" ${trailers}`), null);
  assert.equal(run(`rtk git -C . commit -am "fix: x" ${trailers}`), null, 'through rtk, -C, and a short cluster');
  assert.equal(run(`git commit -m "$(cat <<'EOF'\nfix: x\n\nAgent: main\nAgent-Model: claude-opus-5-5\nAgent-Effort: high\nEOF\n)"`), null, 'a heredoc');
  assert.equal(run('git commit -m "fix: x" -m "Agent: main\nAgent-Model: claude-opus-5-5\nAgent-Effort: high"'), null, 'a second -m');
  writeFileSync(path.join(dir, 'msg.txt'), 'fix: x\n\nAgent: main\nAgent-Model: claude-opus-5-5\nAgent-Effort: high\n');
  assert.equal(run('git commit -F msg.txt'), null);
  assert.match(run('git commit -m "fix: x Agent: main Agent-Model: claude-opus-5-5 Agent-Effort: high"') ?? '', /Blocked/, 'in the subject');
  assert.match(run('git commit -m "fix: x" -m "Agent: maintainer"') ?? '', /`Agent: main`/, 'a near value');
  assert.match(run('git commit -F - <<<"x"') ?? '', /Blocked/, 'stdin counts only --trailer');
  assert.match(run(`git commit -m a ${trailers} && git commit -m b`) ?? '', /Blocked/, 'each commit on its own');
  assert.equal(run('git status && git log --grep commit'), null, 'not a commit');
});

test('the rule is off by default, outside a transcript, and under its override', (t) => {
  assert.equal(setup(t).run('git commit -m "fix: x"'), null);
  const { run } = setup(t, { commit: ['agent'] });
  assert.equal(run('git commit -m "fix: x"', { payload: {} }), null);
  assert.equal(run('git commit -m "fix: x"', { env: { [OVERRIDE]: '1' } }), null);
  assert.match(run('git commit -m "fix: x"', { payload: { session_id: 's1', transcript_path: '/missing.jsonl' } }) ?? '', /Agent: main/,
    'an unreadable transcript still knows the agent');
});

test('prAgents joins the branch commits and the session dispatches, without main or the excluded', () => {
  const rows = [
    { event: 'dispatch', session_id: 's1', agent_type: 'aidrian:code-reviewer' },
    { event: 'stop', session_id: 's1', agent_type: 'aidrian:code-reviewer', models: ['claude-opus-5-5'] },
    { event: 'dispatch', session_id: 's1', agent_type: 'Explore' },
    { event: 'dispatch', session_id: 's2', agent_type: 'designer' },
  ];
  const commits = [{ agent: 'backend-developer', model: 'claude-sonnet-5-5' }, { agent: 'main', model: 'claude-opus-5-5' }];
  assert.deepEqual(prAgents({ commits, rows, sessionId: 's1', exclude: ['Explore'] }), [
    { name: 'backend-developer', models: ['claude-sonnet-5-5'] },
    { name: 'code-reviewer', models: ['claude-opus-5-5'] },
  ]);
});

test('branchCommits reads the Agent trailers of the commits past the base', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-attr-git-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'chore: base');
  git('checkout', '-q', '-b', 'topic');
  git('commit', '-q', '--allow-empty', '-m', 'feat: x', '--trailer', 'Agent: backend-developer', '--trailer', 'Agent-Model: m1');
  git('commit', '-q', '--allow-empty', '-m', 'fix: y');
  assert.deepEqual(branchCommits(dir, 'main'), [{ agent: 'backend-developer', model: 'm1' }]);
  assert.deepEqual(branchCommits(dir, 'no-such-branch'), []);
});

test('prLines and prMissing: the configured parts, agents in any order', () => {
  const author = { agent: 'main', model: 'claude-opus-5-5', effort: 'high', tool: 'Claude Code', env: 'cloud' };
  const agents = [{ name: 'backend-developer', models: ['m1'] }, { name: 'code-reviewer', models: [] }];
  const lines = prLines(['tool', 'model', 'effort', 'env', 'agents'], author, agents);
  assert.deepEqual(lines, ['Authored-with: Claude Code — claude-opus-5-5 (high effort, cloud)', 'Assisted-by: backend-developer (m1)', 'Assisted-by: code-reviewer']);
  assert.deepEqual(prLines(['model'], author, agents), ['Authored-with: claude-opus-5-5']);
  const body = 'x\n\nAuthored-with: Claude Code — claude-opus-5-5 (high effort, cloud)\nAssisted-by: code-reviewer (m2)\nAssisted-by: backend-developer\n';
  assert.deepEqual(prMissing(body, lines), []);
  assert.deepEqual(prMissing('x\nAssisted-by: code-reviewer\n', lines), [lines[0], lines[1]]);
});

test('the PR rule checks gh pr create, never gh pr edit, and names the session agents', (t) => {
  const { run } = setup(t, { pullRequest: ['tool', 'model', 'agents'] });
  const commits = () => [{ agent: 'frontend-developer', model: 'm9' }];
  const body = '## Summary\nx\n';
  const reason = run(`gh pr create --title x --body '${body}'`, { commits }) ?? '';
  assert.match(reason, /Authored-with: Claude Code — claude-opus-5-5\nAssisted-by: frontend-developer \(m9\)\nAssisted-by: backend-developer \(claude-sonnet-5-5\)\nAssisted-by: code-reviewer\n/);
  assert.doesNotMatch(reason, /explorer|designer/, 'excluded by default, and another session');
  const signed = `${body}\nAuthored-with: Claude Code — claude-opus-5-5\nAssisted-by: code-reviewer\nAssisted-by: backend-developer\nAssisted-by: frontend-developer\n`;
  assert.equal(run(`gh pr create --title x --body '${signed}'`, { commits }), null);
  assert.equal(run(`gh pr edit 3 --body '${body}'`, { commits }), null);
  assert.equal(run('gh pr create --web', { commits }), null);
});

test('config rejects an unknown attribution field and keeps the default', (t) => {
  const { dir } = setup(t, { commit: ['agent', 'host'] });
  const { config, errors } = loadConfig(findProject(dir));
  assert.deepEqual(config.attribution.commit, []);
  assert.match(errors.join('\n'), /attribution\.commit/);
  assert.ok(config.attribution.exclude.includes('explorer'));
});
