// The review-fallback rule: an agent passes `aidrian pr review --quota-fallback` only after the Human picked that option.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { question } from '../plugins/aidrian/lib/review/quota.mjs';
import { emptyState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { check, chosen } from '../plugins/aidrian/lib/rules/review-fallback.mjs';
import { check as signoffRule } from '../plugins/aidrian/lib/rules/review-signoff.mjs';

const STOP = { head: 'a'.repeat(40), stage: 'independent', reviewer: 'codex-local', passes: ['engine:codex-local'], reason: 'usage limit', at: '2026-11-01T10:00:00.000Z', choice: null };

// A project whose review record of #12 holds a quota stop (or none), and a transcript file for the hook payload.
function guarded(t, { stopped = true } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-fallback-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const state = emptyState(12, 'o/r');
  if (stopped) state.quotaStops = [STOP];
  writeLocalState(projectAt(dir), state);
  const transcript = path.join(dir, 'transcript.jsonl');
  const answer = (text, label, timestamp = '2026-11-01T10:05:00.000Z') => JSON.stringify({ type: 'user', timestamp, toolUseResult: { questions: [{ question: text }], answers: { [text]: label } } });
  const write = (...lines) => writeFileSync(transcript, `${lines.join('\n')}\n`);
  return { dir, transcript, answer, write, run: (command) => check(command, { cwd: dir, input: { transcript_path: transcript } }) };
}

const asked = question({ pr: 12, stop: STOP });
const [agent, human, wait] = asked.options.map((each) => each.label);

test('the review-fallback rule: an agent runs the Human`s pick only, after the stop', (t) => {
  const g = guarded(t);
  g.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: asked.question }] } }));
  assert.match(g.run('aidrian pr review 12 --quota-fallback agent:critic') ?? '', /holds no such choice by the Human.*#12/su, 'no answer, no fallback');
  assert.equal(g.run('aidrian pr review 12'), null, 'a step without the flag always runs');
  g.write(g.answer(asked.question, wait));
  assert.ok(g.run('aidrian pr review 12 --quota-fallback agent:critic'), 'the Human said wait');
  g.write(g.answer(asked.question, human));
  assert.ok(g.run('aidrian pr review 12 --quota-fallback agent:critic'), 'the Human picked their own review, not the agent');
  assert.equal(g.run('aidrian pr review 12 --quota-fallback human'), null);
  g.write(g.answer(asked.question.replace('#12', '#123'), agent));
  assert.ok(g.run('aidrian pr review 12 --quota-fallback agent:critic'), 'an answer about another pull request');
  g.write(g.answer(asked.question, agent, '2026-11-01T09:00:00.000Z'));
  assert.ok(g.run('aidrian pr review 12 --quota-fallback agent:critic'), 'an answer older than the stop');
  g.write(g.answer(asked.question, agent));
  for (const command of ['aidrian pr review 12 --quota-fallback agent:critic', 'aidrian pr review #12 --with-bot --quota-fallback=agent:critic', 'node plugins/aidrian/lib/cli.mjs pr review 12 --max-rounds 3 --quota-fallback agent:critic']) {
    assert.equal(g.run(command), null, command);
  }
  assert.ok(g.run('aidrian pr review 12 --quota-fallback human'), 'the agent pick is not the Human`s review');
  assert.ok(check('aidrian pr review 12 --quota-fallback agent:critic', { cwd: g.dir, input: {} }), 'no transcript: the Human runs it in their own shell');
  assert.ok(g.run('aidrian pr review "$PR" --quota-fallback agent:critic'), 'a pull request the rule cannot read');
  assert.ok(g.run('aidrian pr review 12 --quota-fallback "$CHOICE"'), 'a choice the rule cannot read');
  assert.ok(g.run('aidrian pr review --quota-fallback agent:critic'), 'no pull request named');
});

test('the review-fallback rule: with no stop in this machine`s record, the choice is the Human`s to run', (t) => {
  const g = guarded(t, { stopped: false });
  g.write(g.answer(asked.question, agent));
  assert.ok(g.run('aidrian pr review 12 --quota-fallback agent:critic'));
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-fallback-bare-')));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(check('aidrian pr review 12 --quota-fallback agent:critic', { cwd: bare, input: {} }), null, 'outside a project the rule is off');
});

test('the review-fallback rule: the Human`s answer authorizes the exact agent it names, no other', (t) => {
  const g = guarded(t);
  g.write(g.answer(asked.question, agent));
  assert.equal(g.run('aidrian pr review 12 --quota-fallback agent:critic'), null);
  for (const other of ['agent:security-engineer', 'agent:critic-plus', 'agent:crit']) {
    assert.ok(g.run(`aidrian pr review 12 --quota-fallback ${other}`), `the critic answer does not authorize ${other}`);
  }
  g.write(g.answer(asked.question, 'Run a security-engineer agent'));
  assert.equal(g.run('aidrian pr review 12 --quota-fallback agent:security-engineer'), null, 'an answer that names the agent');
  assert.ok(g.run('aidrian pr review 12 --quota-fallback agent:critic'), 'and not the critic');
  g.write(g.answer(asked.question, 'Use agent:security-engineer instead'));
  assert.equal(g.run('aidrian pr review 12 --quota-fallback agent:security-engineer'), null, 'an answer that names the value');
  assert.ok(g.run('aidrian pr review 12 --quota-fallback agent:security'), 'a prefix of the named agent is another agent');
});

test('chosen reads the option labels the question prints, and the stage sign-off stays the Human`s', (t) => {
  assert.equal(chosen([{ question: asked.question, answer: agent, at: null }], { pr: 12, choice: 'agent:critic' }), true);
  assert.equal(chosen([{ question: asked.question, answer: agent, at: null }], { pr: 12, choice: 'other' }), false);
  assert.equal(chosen([{ question: 'Pull request #12: pick one', answer: agent, at: null }], { pr: 12, choice: 'agent:critic' }), false, 'a question not about the quota');
  const g = guarded(t);
  assert.ok(signoffRule(`aidrian pr signoff 12 --stage independent --head ${STOP.head}`, { cwd: g.dir }), 'the review-signoff rule blocks an agent`s stage sign-off');
});

test('aidrian pr signoff takes one of --flow or --stage', () => {
  const cli = new URL('../plugins/aidrian/bin/aidrian', import.meta.url).pathname;
  for (const args of [['12', '--head', 'abc1234'], ['12', '--flow', 'x', '--stage', 'independent', '--head', 'abc1234']]) {
    const run = execFileSync('sh', ['-c', `"${cli}" pr signoff ${args.join(' ')} 2>&1; echo "exit $?"`], { encoding: 'utf8' });
    assert.match(run, /--head and one of --flow or --stage are required\nexit 1/u, args.join(' '));
  }
});

test('the review-fallback rule reads the call inside a shell string, eval, or a heredoc fed to a shell', (t) => {
  const g = guarded(t);
  for (const command of [
    'bash -c "aidrian pr review 12 --quota-fallback agent:critic"',
    "sh -c 'aidrian pr review 12 --quota-fallback human'",
    'eval "aidrian pr review 12 --quota-fallback agent:critic"',
    'eval -- "aidrian pr review 12 --quota-fallback human"',
    "bash <<'EOF'\naidrian pr review 12 --quota-fallback agent:critic\nEOF",
  ]) assert.match(g.run(command) ?? '', /holds no such choice by the Human/u, command);
  assert.match(g.run('echo "aidrian pr review 12 --quota-fallback agent:critic" | bash') ?? '', /a shell fed text the rule cannot read/u);
  assert.equal(g.run("bash -c 'echo hi'"), null, 'an ordinary shell string');
  assert.equal(g.run('bash -c "aidrian pr review 12"'), null, 'a wrapped step without the flag');
  g.write(g.answer(asked.question, agent));
  assert.equal(g.run('bash -c "aidrian pr review 12 --quota-fallback agent:critic"'), null, 'the Human`s pick, wrapped');
});
