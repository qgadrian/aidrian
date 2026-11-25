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

test('at the cap, the waiver takes one route: the step\'s `waiver`, its one judge, and `aidrian pr extend --judge`, never a gate command', () => {
  const waiver = section(read('references/review-plan.md'), 'At the cap: a judge\'s waiver');
  for (const step of ['`waiver`', '`may` false', '`may` true', 'One judge per head', 'aidrian pr extend <n> --verdict', '--judge <agent id>', 'run no review step on this head', '`pr-auto-merge` skill']) {
    assert.ok(waiver.includes(step), `waiver: ${step}`);
  }
  const phases = readFileSync(path.resolve(SKILL, '../autopilot/references/phases.md'), 'utf8');
  for (const [name, text] of [['review-plan.md § At the cap: a judge\'s waiver', waiver], ['autopilot phases.md', phases]]) {
    assert.doesNotMatch(text, /aidrian pr waive/u, `${name} names no separate waiver command`);
  }
});

test('an unverified invariant the session can prove itself is gathered, never a question to the Human of how', () => {
  const plan = read('references/review-plan.md');
  const fix = section(plan, '`fix_required`');
  const gather = fix.indexOf('never ask the Human how');
  const settle = fix.indexOf('An entry has `settle`');
  const ask = fix.indexOf('Ask the Human with AskUserQuestion');
  assert.ok(gather !== -1 && gather < settle && settle < ask, 'the gather route comes before the judge, and both before asking the Human');
  const route = fix.slice(gather, settle);
  for (const step of ['a draft', 'only once it is ready', 'visual reviewer opened the captures and reported an empty, logged-out, or data-less page',
    'measured facts alone never say so', 'Run locally, or against a deploy preview when one exists',
    '`e2e-runner`', '`designer`', '`review.visual.viewports`', '`product-access`', 'as a comment of the pull request', '`aidrian pr ingest`',
    '`capture:<key>`', 'Never post a secret', 'report that gap as a finding, and ask nothing',
    '`signoff: "human"`', '`harness-config`', '`human_required`']) {
    assert.ok(route.includes(step), `gather route: ${step}`);
  }
  // The trust gate: only a successful trust read with `limited: false` gathers; anything else takes the next route,
  // and the agents reach the product under the existing product-access workflow's checks, which the route never restates.
  const resolve = route.indexOf('Gather only when `aidrian pr resolve <PR>` succeeded and printed `limited: false`');
  assert.ok(resolve !== -1 && resolve < route.indexOf('`e2e-runner`'), 'the trust gate comes before any dispatch');
  assert.ok(route.includes('any other result, limited, an error, or a missing field, takes the next route'), 'trust gate: any other result');
  assert.ok(route.includes('under the checks of the product-access workflow the `persona-audit` skill runs'), 'trust gate: the workflow\'s checks');
  // No upload on this route: ingest keeps the images local, and publishing stays with the pr-screenshot skill.
  assert.ok(route.includes('This route never posts them: publishing screenshots stays with the `pr-screenshot` skill and its own confirmation.'), 'never posts');
  assert.doesNotMatch(route, /Attach: \*\*auto\*\*|review\.visual\.attach/u, 'the route reads no attach policy');
  // A local run is no CI check.
  assert.ok(route.includes('A local run never clears a flow\'s `checks`.'), 'a local run never clears a flow\'s checks');
  assert.ok(fix.slice(ask).includes('never how to get the proof'), 'the Human is asked to approve, never how to get the proof');
  assert.doesNotMatch(read('SKILL.md') + plan, /how should the session get/iu, 'no step offers a "how should the session get that proof" question');

  const docs = readFileSync(path.resolve(SKILL, '../../../../docs/review.md'), 'utf8');
  const doc = (heading, level) => {
    const start = docs.indexOf(`\n${level} ${heading}\n`);
    assert.notEqual(start, -1, `docs/review.md has "${heading}"`);
    const next = docs.slice(start + 1).search(new RegExp(`\\n#{1,${level.length}} `, 'u'));
    return docs.slice(start, next === -1 ? docs.length : start + 1 + next).replace(/\s+/gu, ' ');
  };
  assert.match(doc('Answering in the session', '####'), /never how the session should get the proof/u);
  const rulings = doc('Unattended rulings', '####');
  for (const step of ['**Proof the session gathers.**', '`e2e-runner`', '`designer`', '`product-access`', 'aidrian pr settle <PR> --flow <id> --accept',
    'asks nothing', '`signoff: "human"` flow and a change to `harness-config` still ask the Human',
    '(personas.md#a-pull-request-link-alone)', 'printed `limited: false`; any other result', 'takes the next route as before',
    'never posts the screenshots on this route', 'never clears a flow\'s `checks`']) {
    assert.ok(rulings.includes(step), `Unattended rulings: ${step}`);
  }
  assert.match(doc('Visual review', '##'), /\*\*An empty capture\*\*.*`limited: false`.*`designer`.*product-access workflow.*never posts them.*no question to the Human/u);
  assert.doesNotMatch(rulings + doc('Visual review', '##'), /Attach: \*\*auto\*\*/u, 'the docs tie no upload to the attach line');
});
