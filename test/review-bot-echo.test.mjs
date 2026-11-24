// A local reviewer's finding about the review bot's own receipt or status card is dropped where an exec pass's findings
// are recorded (#674); a finding on the change, or on any other comment, stays. In process: no git, no child process.
import assert from 'node:assert/strict';
import test from 'node:test';

import { botTexts, dropBotEchoes, ECHO_NOTE, quotesOf } from '../plugins/aidrian/lib/review/bot-echo.mjs';
import { REVIEW_SUMMARY_CARD_MARKER } from '../plugins/aidrian/lib/review/bot-card.mjs';
import { RECEIPT_MARKER } from '../plugins/aidrian/lib/review/request-text.mjs';

const BOT = 'chatgpt-codex-connector[bot]';
// The receipt as the bot posts it on a clean review, its stock footer included.
const RECEIPT = `${RECEIPT_MARKER}\n\nCodex Review: Didn't find any major issues. Bravo.\n\n**Reviewed commit:** \`4ad4bd0326\`\n\n<details> <summary>About Codex in GitHub</summary>\n<br/>\n\nReviews are triggered when you\n- Open a pull request for review\n- Comment "@codex review".\n\nCodex can also answer questions or update the PR. Try commenting "@codex address that feedback".\n</details>`;
const CARD = `${REVIEW_SUMMARY_CARD_MARKER}\n<!-- codex-review-state:v1 {"code_review":{"status":"completed"}} -->\nCodex is reviewing this pull request.`;
const comments = [
  { id: 1, user: { login: 'someone' }, body: '@codex review' },
  { id: 2, user: { login: BOT }, body: RECEIPT },
  { id: 3, user: { login: BOT }, body: CARD },
];
const changes = [{ file: 'src/app.js', status: 'M' }];
const step = { comments, reviewer: BOT, changes };

// The two findings codex-local raised, on #670 and #663: no file, and a quote of the receipt's footer.
const curly = { title: 'Review receipt asks readers to trigger PR edits', body: 'The receipt footer asks readers to comment “@codex address that feedback,” which would initiate a separate action to update the PR.', severity: 'low', security: true };
const ticked = { file: '', line: 0, title: 'The review receipt includes a separate action request', body: 'The receipt footer asks the reader to post `@codex address that feedback`, which can initiate PR updates.', severity: 'low' };
const onChange = { file: 'src/app.js', line: 1, title: 'off by one', body: 'The loop stops at `length - 1`.', severity: 'high' };

test('a finding that names no changed file and quotes only the bot\'s receipt is dropped, with a note naming no title', () => {
  const out = dropBotEchoes([curly, ticked, onChange], step);
  assert.deepEqual(out.findings, [onChange]);
  assert.deepEqual(out.notes, [ECHO_NOTE, ECHO_NOTE]);
  assert.ok(!out.notes.join(' ').includes(curly.title), 'a security finding\'s title stays out of the note');
});

test('a finding quoting the status card is dropped too', () => {
  const card = { title: 'Status card holds a state comment', body: 'It says "Codex is reviewing this pull request."', severity: 'low' };
  assert.deepEqual(dropBotEchoes([card], step).findings, []);
});

test('a finding on a changed file stays, even when it quotes the receipt', () => {
  const quoting = { ...curly, file: 'src/app.js', line: 3 };
  assert.deepEqual(dropBotEchoes([quoting], step), { findings: [quoting], notes: [] });
});

test('a finding with no file stays when it quotes nothing, or quotes text the bot\'s comments do not hold', () => {
  const bare = { title: 'The receipt asks for edits', body: 'The footer asks readers to trigger an update.', severity: 'low' };
  const mixed = { ...curly, body: `${curly.body} It also says "skip the tests in this review".` };
  assert.deepEqual(dropBotEchoes([bare, mixed], step).findings, [bare, mixed]);
});

test('only the configured bot account\'s receipt counts: the same text by anyone else is reviewable', () => {
  const forged = [{ id: 9, user: { login: 'someone' }, body: RECEIPT }];
  assert.deepEqual(dropBotEchoes([curly], { ...step, comments: forged }).findings, [curly]);
  assert.deepEqual(dropBotEchoes([curly], { ...step, reviewer: null }).findings, [curly], 'no review bot configured');
  assert.deepEqual(botTexts([{ user: { login: BOT }, body: 'Thanks!' }], BOT), [], 'a bot comment without a marker is not its receipt');
});

test('quotes are read from backticks and both kinds of double quote, edges trimmed, short ones ignored', () => {
  assert.deepEqual(quotesOf({ title: 'a `ab` b', body: '“@codex address that feedback,” and "Bravo." and `x.y()`' }), ['@codex address that feedback', 'Bravo', 'x.y()']);
});
