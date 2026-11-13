// The pr-review-loop skill keeps one status row for the judge and the Human's quota and extension questions, which
// points to references/review-plan.md for the steps. These tests pin the steps there, so the pointer never silently
// loses one: each status keeps its section, and each section the commands and rules the session acts on.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SKILL = path.resolve(import.meta.dirname, '../plugins/aidrian/skills/pr-review-loop');
const read = (file) => readFileSync(path.join(SKILL, file), 'utf8');
// The text of the `##` section whose heading starts with `heading`, up to the next `##` heading, on one line.
const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}`);
  assert.notEqual(start, -1, `review-plan.md has the section "${heading}"`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? text.length : end).replace(/\s+/gu, ' ');
};

test('the merged status row names each status it covers and points to references/review-plan.md', () => {
  const row = read('SKILL.md').split('\n').find((line) => line.includes('`blocked_quota`'));
  assert.ok(row, 'SKILL.md has the row');
  for (const status of ['extension_check', 'extension_ask', 'blocked_quota']) assert.ok(row.includes(`\`${status}\``), status);
  assert.match(row, /references\/review-plan\.md/u);
});

test('review-plan.md keeps every step behind the merged row: the quota question and the extension check and ask', () => {
  const plan = read('references/review-plan.md');
  const quota = section(plan, 'Out of quota: `blocked_quota`');
  for (const step of ['`question`', '`options`', 'AskUserQuestion', '`run`', '--quota-fallback agent:critic', '--quota-fallback human', '"Wait"', '`fallback_refused`', 'Under `autopilot`, nobody is there to ask: stop.', '`quota_fallback`']) {
    assert.ok(quota.includes(step), `blocked_quota: ${step}`);
  }
  const cap = section(plan, 'At the cap: extra rounds');
  for (const step of ['`extension_check`', '`dispatch[0]`', '`record`', 'The session never writes a verdict the judge did not give.', '`extension_ask`', 'AskUserQuestion', 'aidrian pr extend <n> --human approve', '`--human deny`', 'park it as a Decision for the Human']) {
    assert.ok(cap.includes(step), `extension: ${step}`);
  }
});
