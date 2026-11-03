import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = path.join(ROOT, 'plugins/aidrian/scripts/hook-ask.mjs');
const OPTIONS = [{ label: 'Yes', description: 'Go ahead.' }, { label: 'No', description: 'Stop.' }];
const ask = (question, options = OPTIONS, fields = {}) =>
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', cwd: ROOT,
      tool_input: { questions: [{ question, header: 'Next', options, multiSelect: false }] }, ...fields }),
    encoding: 'utf8',
  });

test('a question that says I, me, you, or your is blocked and names the words', () => {
  for (const q of ['How should I finish?', 'Should Claude ask you first?', 'This needs your approval. Run it?', "I'm stuck; retry?", 'Ok with me?']) {
    const r = ask(q);
    assert.equal(r.status, 2, q);
    assert.match(r.stderr, /^Blocked: the question says /);
    assert.match(r.stderr, /"the Human"/);
  }
  assert.match(ask('How should I tell you?').stderr, /says "I", "you"\./);
});

test('option labels and descriptions are checked too', () => {
  assert.equal(ask('Which way?', [{ label: 'Ship it', description: 'You review after.' }, OPTIONS[1]]).status, 2);
});

test('named questions, code, quotes, and other tools pass', () => {
  for (const q of [
    'How should Claude finish? The Human decides.',
    'The page promises "your own domain". Keep the claim?',
    "The button reads 'Save your work'. Keep it?",
    'Run `echo I told you`?',
    'Keep i.e. in the docs?',
    "Claude can't reach the API. Retry?",
  ]) assert.equal(ask(q).status, 0, q);
  assert.equal(ask('How should I finish?', OPTIONS, { tool_name: 'Read' }).status, 0);
  assert.equal(ask('How should I finish?', OPTIONS, { cwd: '/' }).status, 0);
});
