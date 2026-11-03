import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { lastReply, replyWords } from '../plugins/aidrian/lib/names.mjs';

process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
const PROJECT = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-prompt-')));
mkdirSync(path.join(PROJECT, '.aidrian'));
writeFileSync(path.join(PROJECT, '.aidrian/config.json'), JSON.stringify({ version: 1, names: { human: 'the owner' } }));
after(() => {
  for (const dir of [process.env.XDG_STATE_HOME, PROJECT]) rmSync(dir, { recursive: true, force: true });
});

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-prompt.mjs');
const prompt = (content, extra = {}) => ({ type: 'user', isSidechain: false, message: { role: 'user', content }, ...extra });
const reply = (...blocks) => ({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: blocks } });
const text = (t) => ({ type: 'text', text: t });
const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

function run(transcript, fields = {}) {
  const file = path.join(PROJECT, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, transcript);
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', transcript_path: file, cwd: PROJECT, prompt: 'next', ...fields }),
    encoding: 'utf8',
  });
}

test('lastReply reads the text of the last turn only, before or after the new prompt is written', () => {
  const t = jsonl(
    prompt('first'), reply(text('Old turn: I did it.')),
    prompt('second'), reply({ type: 'thinking', thinking: 'I think' }), reply({ type: 'tool_use', name: 'Bash', input: {} }),
    prompt([{ type: 'tool_result', content: 'you' }]), prompt('reminder you', { isMeta: true }),
    reply(text('Claude ran it.')), { type: 'assistant', isSidechain: true, message: { content: [text('I am a subagent')] } },
    reply(text('Done.')),
  );
  assert.equal(lastReply(t), 'Claude ran it.\n\nDone.');
  assert.equal(lastReply(t + jsonl(prompt('third'))), 'Claude ran it.\n\nDone.');
  assert.equal(lastReply(''), '');
  assert.equal(lastReply('not json\n'), '');
});

test('replyWords skips fenced code and quoted lines', () => {
  assert.deepEqual(replyWords('Here is how:\n```sh\necho I told you\n```\n> How should I finish?\nI ran it for you.'), ['I', 'you']);
  assert.deepEqual(replyWords('~~~\nyour\n~~~\nClaude ran it.'), []);
});

test('a reply that says I or you starts the next turn with one reminder line; a named reply adds nothing', () => {
  const r = run(jsonl(prompt('go'), reply(text('I ran the tests, and your branch is green.'))));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'Names: the last reply said "I", "your". In this reply, call the human "the owner" and yourself "Claude"; ' +
    'a word that quotes someone goes in quotes or backticks.\n');
  assert.equal(run(jsonl(prompt('go'), reply(text('Claude ran the tests; the branch of the owner is green.')))).stdout, '');
  assert.equal(run(jsonl(prompt('go'), reply(text('I ran it.'))), { agent_id: 'a1' }).stdout, '');
  assert.equal(run(jsonl(prompt('go'), reply(text('I ran it.'))), { cwd: '/' }).stdout, '');
  assert.equal(run('', { transcript_path: '/nope.jsonl' }).stdout, '');
});
