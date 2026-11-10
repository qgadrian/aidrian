import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handBackLists, handBackReason } from '../plugins/aidrian/lib/stop-handback.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-stop.mjs');
const HUMAN = 'Adrian';
// The final report that handed the Human work no agent had tried, and left its weight unsaid.
const HANDED_BACK = [
  'The draft pull request is open and every check is green.',
  '',
  '**For Adrian**',
  '- The advisory on the parser dependency.',
  '- The edit history of the plan doc.',
  '- A fix in the sibling project.',
].join('\n');

const fires = (message) => handBackReason({ message, human: HUMAN }) !== null;

test('the report that handed back untried, unrated work is sent back, quoting the label and the first item', () => {
  const reason = handBackReason({ message: HANDED_BACK, human: HUMAN });
  assert.match(reason, /^The last message lists 3 items under "For Adrian" without saying how critical each is \("The advisory on the parser dependency\."\)\./u);
  assert.match(reason, /Try each one first, through its owner/u);
  assert.match(reason, /only Adrian can clear/u);
  assert.match(reason, /blocking, high, medium, or low\. Then end the turn again\.$/u);
});

test('each form of a label addressed to the Human is read, with its items', () => {
  for (const [message, label] of [
    ['## For Adrian\n\n1. Merge order of the two branches.', 'For Adrian'],
    ['For Adrian:\n- Approve the plan.', 'For Adrian'],
    ['**Needs Adrian:**\n* The API key for the sandbox.', 'Needs Adrian'],
    ['Open items for the Human:\n- The schema choice.', 'Open items for the Human'],
    ['__Waiting on the user__\n- A product call.', 'Waiting on the user'],
    ["Adrian's to-do:\n- Rotate the token.", "Adrian's to-do"],
    ['For Adrian: merge it once green.', 'For Adrian'],
    ['### Questions for you\n- Which base?', 'Questions for you'],
  ]) {
    const lists = handBackLists(message, 'Adrian|the Human|the user|you');
    assert.equal(lists[0]?.label, label, message);
    assert.ok(fires(message), message);
  }
});

test('items that say how critical each is, and messages with no list for the Human, pass', () => {
  for (const message of [
    '**For Adrian**\n- Blocking: the deploy key, which no agent can read. Needed: add it to the repository secrets.\n- Low: rename the label.',
    'For Adrian:\n1. The token rotation (high): only Adrian holds the vault login.\n   It expires on Friday.',
    'Done. All 812 tests pass.',
    '## Decided alone\n- The branch name.',
    'Next step: Adrian merges it.',
    'The report for Adrian is in the pull request.',
    '**For Adrian**\n\nNothing: every item was done by its owner.',
    'Here is the sample section the doc asked for:\n\n```md\n## For the Human\n- Rotate the deploy key.\n```\n\nDone.',
    '~~~~\nFor Adrian:\n- Quoted.\n```\n- Still quoted.\n~~~~',
  ]) assert.ok(!fires(message), message);
});

test('a continuation line and a nested entry belong to their item, and the list ends at a heading or a paragraph', () => {
  const message = [
    'For Adrian:',
    '- The deploy key',
    '  - which only Adrian can add; blocking.',
    '- The label rename.',
    '',
    'The rest is done.',
    '- An unrelated entry.',
    '## Verification',
    '- npm run check passed.',
  ].join('\n');
  assert.deepEqual(handBackLists(message, 'Adrian'), [
    { label: 'For Adrian', items: ['The deploy key - which only Adrian can add; blocking.', 'The label rename.'] },
  ]);
  assert.match(handBackReason({ message, human: HUMAN }), /lists an item under "For Adrian" without saying how critical it is \("The label rename\."\)/u);
});

test('the Stop hook sends the report back once, by the names config.json gives, and lets the second stop end', (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-stop-handback-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, names: { human: 'Adrian', ai: 'HAL9K' } }));
  const temp = path.join(base, 'tmp');
  mkdirSync(temp);
  const stop = (fields) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc-123', cwd: dir, stop_hook_active: false, ...fields }),
    cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: temp },
  });
  const sent = stop({ last_assistant_message: HANDED_BACK });
  assert.equal(sent.status, 2);
  assert.match(sent.stderr, /^The last message lists 3 items under "For Adrian"/u);
  assert.equal(stop({ last_assistant_message: HANDED_BACK, stop_hook_active: true }).status, 0, 'the stop this hook caused ends');
  assert.equal(stop({ last_assistant_message: 'Done. All 812 tests pass.' }).status, 0);
});
