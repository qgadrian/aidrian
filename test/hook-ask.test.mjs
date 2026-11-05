import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The hook records its blocks in the state folder; keep those rows out of the real one.
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
const PROJECT = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-ask-')));
mkdirSync(path.join(PROJECT, '.aidrian'));
writeFileSync(path.join(PROJECT, '.aidrian/config.json'), '{ "version": 1 }\n');
const NAMED = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-ask-named-')));
mkdirSync(path.join(NAMED, '.aidrian'));
writeFileSync(path.join(NAMED, '.aidrian/config.json'), JSON.stringify({ version: 1, names: { human: 'the owner', ai: 'the agent' } }));
after(() => {
  for (const dir of [process.env.XDG_STATE_HOME, PROJECT, NAMED]) rmSync(dir, { recursive: true, force: true });
});

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-ask.mjs');
const OPTIONS = [{ label: 'Yes', description: 'Go ahead.' }, { label: 'No', description: 'Stop.' }];
const run = (toolInput, fields = {}) =>
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', cwd: PROJECT, tool_input: toolInput, ...fields }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDECODE: '1' },
  });
const ask = (question, extra = {}, fields = {}) =>
  run({ questions: [{ question, header: 'Next', options: OPTIONS, multiSelect: false, ...extra }] }, fields);

test('a question that says I, me, my, you, or your is blocked and names the words', () => {
  for (const q of ['How should I finish?', 'Should Claude ask you first?', 'This needs your approval. Run it?', "I'm stuck; retry?",
    'I’m stuck; retry?', 'Ok with me?', 'Is my plan fine?', 'You’re sure?']) {
    const r = ask(q);
    assert.equal(r.status, 2, q);
    assert.match(r.stderr, /^Blocked: the question says /);
    assert.match(r.stderr, /call the human "the Human" and yourself "Claude"/);
    assert.match(r.stderr, /goes in backticks or quotes/);
  }
  assert.match(ask('How should I tell you?').stderr, /says "I", "you"\./);
});

test('the title, header, question description, and options are checked; the preview is not', () => {
  assert.equal(ask('Which way?', { header: 'Your call' }).status, 2);
  assert.equal(ask('Which way?', { description: 'Your call.' }).status, 2);
  assert.equal(run({ title: 'Can you pick?', questions: [{ question: 'Which way?', header: 'Next', options: OPTIONS }] }).status, 2);
  assert.equal(ask('Which way?', { options: [{ label: 'Ship it', description: 'You review after.' }, OPTIONS[1]] }).status, 2);
  assert.equal(ask('Which way?', { options: [{ label: 'A', description: 'One.', preview: 'Welcome back, you!' }, OPTIONS[1]] }).status, 0);
});

test('named questions, code, quotes, other languages, and look-alike words pass', () => {
  for (const q of [
    'How should Claude finish? The Human decides.',
    'The page promises "your own domain". Keep the claim?',
    'The page promises “your own domain”. Keep the claim?',
    "The button reads 'Save your work'. Keep it?",
    "The checkbox reads 'Don't show me again'. Keep it?",
    'The toast reads ‘You’re all set’. Keep it?',
    'Run `echo I told you`?',
    'Keep i.e. in the docs?',
    "Claude can't reach the API. Retry?",
    'Le problème vient du système. Relancer le build ?',
    'Ce thème est le même. On garde ?',
    'Uděláme to hned?',
    'Le proble\u0300me ?',
    'Is the bottleneck I/O or CPU?',
    'The I-beam cursor or the arrow?',
    'Rename my-app to web?',
    'Should Claude mine the logs?',
  ]) assert.equal(ask(q).status, 0, q);
  assert.equal(ask('How should I finish?', {}, { tool_name: 'Read' }).status, 0);
  assert.equal(ask('How should I finish?', {}, { cwd: '/' }).status, 0);
});

test('the block names the project\'s own names', () => {
  const r = ask('How should I finish?', {}, { cwd: NAMED });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the owner may see only the dialog, so name both sides: call the human "the owner" and yourself "the agent"/);
});
