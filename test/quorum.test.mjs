import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { CASE_SCHEMA, CODEX_TIMEOUT_SEC, CROSS_SCHEMA, DECIDE_LEDGER_SCHEMA, DECIDE_REBUTTAL_SCHEMA, GROUNDS, LEDGER_SCHEMA, LEDGER_SCHEMAS, MAX_MODE_OBJECTIONS, MAX_OBJECTIONS, OBJECTIONS_SCHEMA, REBUTTALS_SCHEMA, codexAnswer, commands, governingWinner, inferenceProblems, isClearCall, modeOf, rebuttalProblems, routeAfterRuling, routeFor, schemaProblems } from '../plugins/aidrian/lib/quorum.mjs';
import { isDecisionId, parseDecisions } from '../plugins/aidrian/lib/decisions.mjs';
import { slug } from '../plugins/aidrian/lib/review/flows.mjs';
import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { FINDINGS_SCHEMA, runCodex, runExec } from '../plugins/aidrian/lib/review/reviewers.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');

const temp = (t, prefix) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const write = (root, file, text) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};

// A temporary repository with a knowledge doc, a decision record, code, and a needle only in an ignored file and an
// untracked file; the plan and the ledger live in a state folder outside it.
function project(t) {
  const root = temp(t, 'aidrian-quorum-');
  const state = temp(t, 'aidrian-quorum-state-');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  git('init', '-q', '-b', 'main');
  write(root, 'docs/rules.md', '# Rules\n\n## No `Double` Booking\nTwo bookings never\n    hold one slot.\n\n## Refunds\nA refund never exceeds the charge.\n\n## Deploy\nRun it:\n\n```bash\n# build first\nnpm run build\n## Fake heading\n```\n\nThen ship the build.\n');
  write(root, 'docs/decisions/0001-store.md', '# 1. Store\n\n## Decision\nWe keep one ledger per plan.\n');
  write(root, 'src/app.js', `export const app = 1;\nexport function book(slot) {\n  return slot;\n}\n// ${'q'.repeat(200)}\n`);
  write(root, '.gitignore', 'secret.txt\n');
  git('add', '-A');
  write(root, 'src/secret.txt', 'NEEDLE_9 lives here\n');
  write(root, 'src/untracked.js', 'NEEDLE_9 too\n');
  const plan = path.join(state, 'plans/my-plan.md');
  write(state, 'plans/my-plan.md', '# Plan\n\n## Approach\nStore the ledger\nunder the state folder.\n\n## Risks\nNone listed.\n');
  const ledgerFile = path.join(state, 'quorum/my-plan-abc.json');
  const check = (ledger, { env = process.env, against = plan } = {}) => {
    write(state, 'quorum/my-plan-abc.json', JSON.stringify(ledger));
    const r = spawnSync(CLI, ['quorum', 'check', ledgerFile, '--plan', against], { cwd: path.join(root, 'src'), encoding: 'utf8', env, timeout: 30_000 });
    assert.equal(r.error, undefined, 'check finished');
    return { ...r, ledger: JSON.parse(readFileSync(ledgerFile, 'utf8')), lines: r.stdout.trim().split('\n') };
  };
  return { root, state, plan, check, git };
}

const cite = (kind, ref, quote) => ({ kind, ref, quote });
const objection = (id, citations, extra = {}) => ({ id, by: 'A', severity: 'important', claim: `claim ${id}`, citations, status: 'pending', ruling: null, rebuttal: null, ...extra });
const ledger = (objections) => ({ mode: 'plan', status: 'open', plan: 'my-plan.md', plan_hash: 'abc', same_model: false, same_model_reason: null, trigger: 'critical flow gate', objections, human_answers: [] });
// A ledger written before `mode`: complete, as every reused one is, since an open ledger without `mode` exits 1.
const legacy = (objections, extra = {}) => {
  const { mode, ...rest } = ledger(objections);
  return { ...rest, status: 'complete', ...extra };
};
// Ids as the ledger writes them, at most 5 per adversary: A1 to A5, then B1 on.
const spread = (citations) => citations.map((citation, i) => (i < 5 ? objection(`A${i + 1}`, [citation]) : objection(`B${i - 4}`, [citation], { by: 'B' })));

const PASSING = {
  docBySlug: cite('doc', 'docs/rules.md#no-double-booking', 'Two bookings never hold one slot.'),
  docByText: cite('doc', 'docs/rules.md#No `Double` Booking', 'never   hold\none slot'),
  adr: cite('adr', 'docs/decisions/0001-store.md#decision', 'one ledger per plan'),
  code: cite('code', 'src/app.js:99', 'export function book(slot) {'),
  plan: cite('plan', '#Approach', 'Store the ledger under the state folder.'),
  absence: cite('absence', 'src', 'NEEDLE_9'),
  // The quote follows a fenced block whose `# build first` and `## Fake heading` lines are code, not headings.
  fenced: cite('doc', 'docs/rules.md#deploy', 'Then ship the build.'),
  exact: cite('code', 'src/app.js:5', 'q'.repeat(200)),
  wholeRepo: cite('absence', '.', 'NEEDLE_9'),
};

// A ledger written under the plan-mode briefs, and rulings that pass every rule a ledger with a mode adds, for an entry
// with one citation: a `Covers:` first line, `Cost:` and `Removes:` on an accept, a ground on a reject, a passing plan
// citation, and a verdict on the ruled entry's citation.
const planLedger = (objections, extra = {}) => ({ ...ledger(objections), mode: 'plan', ...extra });
const verdicts = (count, supports = true) => Array.from({ length: count }, (_, citation) => ({ citation, supports, reason: supports ? 'it says so' : 'it does not' }));
const ACCEPT_TEXT = 'Covers: nothing\nAdd the rule to the approach.\nCost: one sentence in #approach.\nRemoves: the double booking the objection cites.';
const REJECT_TEXT = 'Covers: #approach "Store the ledger under the state folder."\nThe plan already states it.';
const accepts = (over = {}) => ({ decision: 'accept', change_or_reason: ACCEPT_TEXT, citations: [PASSING.plan], tested: verdicts(1), inferences: [], ...over });
const rejects = (over = {}) => ({ decision: 'reject', change_or_reason: REJECT_TEXT, citations: [PASSING.plan], ground: 'covered', tested: verdicts(1), inferences: [], ...over });
const concede = (citations) => ({ verdict: 'concede', claim: 'the ruling stands', citations, ruling: null });

test('schemas: a full ledger and an objections answer pass; a missing field, an extra field, a bad enum, or too many fail', () => {
  const good = ledger([objection('A1', [PASSING.code], {
    status: 'rejected',
    ruling: { decision: 'reject', change_or_reason: 'r', citations: [PASSING.adr] },
    rebuttal: { verdict: 'rebut', claim: 'c', citations: [PASSING.plan], ruling: null },
  })]);
  good.human_answers.push({ objection_id: 'A1', answer: 'keep it' });
  assert.deepEqual(schemaProblems(good, LEDGER_SCHEMA), []);
  const answer = { objections: [{ severity: 'blocking', claim: 'x', citations: [PASSING.docBySlug] }] };
  assert.deepEqual(schemaProblems(answer, OBJECTIONS_SCHEMA), []);

  const extra = structuredClone(good);
  extra.objections[0].citations[0].line = 3;
  assert.deepEqual(schemaProblems(extra, LEDGER_SCHEMA), ['$.objections[0].citations[0].line is not a known field']);
  const missing = structuredClone(good);
  delete missing.objections[0].citations[0].quote;
  delete missing.trigger;
  assert.deepEqual(schemaProblems(missing, LEDGER_SCHEMA), ['$.trigger is missing', '$.objections[0].citations[0].quote is missing']);
  const badEnum = structuredClone(good);
  badEnum.objections[0].severity = 'nit';
  badEnum.objections[0].rebuttal.verdict = 'maybe';
  assert.equal(schemaProblems(badEnum, LEDGER_SCHEMA).length, 2);
  assert.match(schemaProblems({ objections: Array(8).fill(answer.objections[0]) }, OBJECTIONS_SCHEMA)[0], /has 8 items, more than 7/u);
  assert.deepEqual(schemaProblems({ objections: Array(7).fill(answer.objections[0]) }, OBJECTIONS_SCHEMA), [], 'exactly 7 objections pass');

  // Codex holds its answer strictly: every property required and none other, as FINDINGS_SCHEMA does.
  const strict = (schema) => {
    if (schema.properties) {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(strict);
    }
    if (schema.items) strict(schema.items);
  };
  strict(OBJECTIONS_SCHEMA);
  strict(REBUTTALS_SCHEMA);
  strict(FINDINGS_SCHEMA);
  assert.deepEqual(OBJECTIONS_SCHEMA.properties.objections.items.properties.severity.enum, ['blocking', 'important', 'improvement']);

  // The ledger is no Codex answer: every field is required except those a ledger written before `mode`, or before
  // `runners`, lacks, and only those.
  const optional = [];
  const walk = (node, at) => {
    if (node.items) walk(node.items, `${at}[]`);
    if (!node.properties) return;
    assert.equal(node.additionalProperties, false, at);
    for (const key of node.required) assert.ok(Object.hasOwn(node.properties, key), `${at || '$'} requires ${key}, which it does not define`);
    for (const [key, child] of Object.entries(node.properties)) {
      const field = at ? `${at}.${key}` : key;
      if (!node.required.includes(key)) optional.push(field);
      walk(child, field);
    }
  };
  walk(LEDGER_SCHEMA, '');
  assert.deepEqual(optional.sort(), [
    'mode', 'notes', 'objections[].merged_into',
    'objections[].rebuttal.ruling.ground', 'objections[].rebuttal.ruling.inferences', 'objections[].rebuttal.ruling.tested',
    'objections[].ruling.ground', 'objections[].ruling.inferences', 'objections[].ruling.tested', 'proportionality',
    'proportionality.failed', 'runners',
  ]);
});

test('schemas: a ledger with every plan-mode field passes; a bad ground, a non-integer citation index, or too many notes fail', () => {
  const full = planLedger([
    objection('A1', [PASSING.code], { status: 'accepted', ruling: accepts({ inferences: [{ statement: 's', holds: true, reason: 'r', citations: [PASSING.adr] }] }), merged_into: null }),
    objection('B1', [PASSING.code], { by: 'B', status: 'merged', merged_into: 'A1' }),
    objection('A2', [PASSING.code], { status: 'escalated', ruling: rejects(), rebuttal: { verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling: rejects({ ground: 'speculative' }) } }),
  ], { notes: [{ by: 'B', claim: 'no better alternative', citations: [PASSING.plan] }], proportionality: { flagged: [{ objection_id: 'A1', reason: 'r', smaller_change: '' }] } });
  assert.deepEqual(schemaProblems(full, LEDGER_SCHEMA), []);
  assert.deepEqual(schemaProblems({ ...full, proportionality: null }, LEDGER_SCHEMA), []);
  assert.deepEqual(schemaProblems({ ...full, proportionality: { flagged: [], failed: true } }, LEDGER_SCHEMA), []);
  // `failed` says the pass failed, or is absent: false would say nothing a missing field does not.
  assert.deepEqual(schemaProblems({ ...full, proportionality: { flagged: [], failed: false } }, LEDGER_SCHEMA), ['$.proportionality.failed must be one of true']);
  const bad = structuredClone(full);
  bad.objections[0].ruling.ground = 'tangent';
  bad.objections[0].ruling.tested[0].citation = '0';
  bad.notes = Array(11).fill(full.notes[0]);
  bad.mode = 'debate';
  assert.deepEqual(schemaProblems(bad, LEDGER_SCHEMA).sort(), [
    '$.mode must be one of plan',
    '$.notes has 11 items, more than 10',
    '$.objections[0].ruling.ground must be one of covered, implementation, settled, off-goal, disproportionate, speculative',
    '$.objections[0].ruling.tested[0].citation must be integer',
  ]);
});

test('slug is exported from flows.mjs unchanged', () => {
  assert.equal(slug('No `Double` Booking'), 'no-double-booking');
  assert.equal(slug('no-double-booking'), 'no-double-booking');
});

test('slug drops punctuation as GitHub does, so an anchor copied from GitHub matches its heading', () => {
  assert.equal(slug("The plugin's tools for this work"), 'the-plugins-tools-for-this-work');
  assert.equal(slug('The plugin\u2019s tools'), 'the-plugins-tools');
  assert.equal(slug('Read config.json first'), 'read-configjson-first');
  assert.equal(slug('Node.js and npm'), 'nodejs-and-npm');
  assert.equal(slug('Why (and when)'), 'why-and-when');
  assert.equal(slug('Caf\u00e9 rules'), 'caf\u00e9-rules');
  assert.equal(slug('`hook_deny`: when a rule blocks'), 'hookdeny-when-a-rule-blocks');
});

test('check: every citation kind passes; anchors by heading text and by slug; quotes compare with whitespace collapsed; plan and ledger outside the root', (t) => {
  const p = project(t);
  const objections = spread(Object.values(PASSING));
  const result = p.check(ledger(objections));
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  assert.deepEqual(result.lines, [`checked: mode plan, ${objections.length} objections, 0 opinion, 0 problems`]);
  assert.deepEqual(result.ledger.objections.map((each) => each.status), Array(objections.length).fill('pending'));
});

test('check: each citation kind that fails is named with its reason, and an objection with none passing becomes opinion', (t) => {
  const p = project(t);
  const failing = [
    objection('A1', [cite('doc', 'docs/rules.md#refunds', 'Two bookings never hold one slot.')]),
    objection('A2', [cite('doc', 'docs/nope.md#x', 'y')]),
    objection('A3', [cite('adr', 'docs/decisions/0001-store.md#context', 'one ledger per plan')]),
    objection('A4', [cite('code', 'src/app.js:1', 'export const app = 2;')]),
    objection('A5', [cite('code', 'src/app.js', 'export const app = 1;')]),
    objection('B1', [cite('plan', '#risks', 'Store the ledger')], { by: 'B' }),
    objection('B2', [cite('absence', 'src', 'export function book')], { by: 'B' }),
    objection('B3', [cite('code', 'src/app.js:1', 'x'.repeat(201))], { by: 'B' }),
    objection('B4', [cite('code', 'src/app.js:1', 'nope'), PASSING.code], { by: 'B' }),
  ];
  const result = p.check(ledger(failing));
  assert.equal(result.status, 0, result.stderr);
  const statuses = Object.fromEntries(result.ledger.objections.map((each) => [each.id, each.status]));
  assert.deepEqual(statuses, { A1: 'opinion', A2: 'opinion', A3: 'opinion', A4: 'opinion', A5: 'opinion', B1: 'opinion', B2: 'opinion', B3: 'opinion', B4: 'pending' });
  const has = (pattern) => assert.ok(result.lines.some((line) => pattern.test(line)), `${pattern}\n${result.stdout}`);
  has(/^objection A1\.citations\[0\] \(doc docs\/rules\.md#refunds\): docs\/rules\.md#refunds does not contain the quote$/u);
  has(/^objection A1: relabeled opinion \(was pending\): no citation passes$/u);
  has(/^objection A2\.citations\[0\] .*: docs\/nope\.md is missing$/u);
  has(/^objection A3\.citations\[0\] .*: docs\/decisions\/0001-store\.md has no heading #context$/u);
  has(/^objection A4\.citations\[0\] .*: src\/app\.js does not contain the quote$/u);
  has(/^objection A5\.citations\[0\] .*: "src\/app\.js" is not path:line$/u);
  has(/^objection B1\.citations\[0\] .*: the plan#risks does not contain the quote$/u);
  has(/^objection B2\.citations\[0\] .*: src\/app\.js contains the quote$/u);
  has(/^objection B3\.citations\[0\] .*: the quote is 201 characters, more than 200$/u);
  assert.ok(!result.lines.some((line) => line.startsWith('objection B4:')), 'one passing citation keeps the objection');
  assert.equal(result.lines.at(-1), `checked: mode plan, 9 objections, 8 opinion, ${result.lines.length - 1} problems`);
});

test('check: an objection already ruled on keeps its status when its citations stop passing, and is named', (t) => {
  const p = project(t);
  // A complete ledger at this hash is reused when check exits 0: the cited code changed since, and an accepted objection,
  // one the Human answered, must not drop to an opinion and out of the report.
  const stale = [cite('code', 'src/app.js:1', 'export const app = 2;')];
  const ruled = (decision) => ({ decision, change_or_reason: 'r', citations: [PASSING.adr] });
  const before = legacy([
    objection('A1', stale, { status: 'accepted', ruling: ruled('accept') }),
    objection('A2', stale, { status: 'rejected', ruling: ruled('reject'), rebuttal: { verdict: 'concede', claim: 'ok', citations: [], ruling: null } }),
    objection('A3', stale, { status: 'escalated', ruling: ruled('escalate') }),
  ], { human_answers: [{ objection_id: 'A1', answer: 'yes, change it' }] });
  const result = p.check(before);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ledger.objections.map((each) => each.status), ['accepted', 'rejected', 'escalated']);
  for (const [id, status] of [['A1', 'accepted'], ['A2', 'rejected'], ['A3', 'escalated']]) {
    assert.ok(result.lines.includes(`objection ${id}: no citation passes; kept ${status}, since it was ruled on`), result.stdout);
  }
  assert.ok(!result.lines.some((line) => line.includes('relabeled')), result.stdout);
  assert.equal(result.lines.at(-1), 'checked: mode plan, 3 objections, 0 opinion, 6 problems');
});

test('check: a ruling, or a rebuttal that rebuts, with no passing citation is invalid; in a ledger with no mode, a concession needs none', (t) => {
  const p = project(t);
  const noProof = [cite('code', 'src/app.js:1', 'not there')];
  const result = p.check(legacy([
    objection('A1', [PASSING.code], { status: 'escalated', ruling: { decision: 'reject', change_or_reason: 'r', citations: noProof }, rebuttal: { verdict: 'rebut', claim: 'c', citations: [], ruling: { decision: 'reject', change_or_reason: 'r', citations: [PASSING.adr] } } }),
    objection('A2', [PASSING.code], { status: 'rejected', ruling: { decision: 'reject', change_or_reason: 'r', citations: [PASSING.plan] }, rebuttal: { verdict: 'concede', claim: 'ok', citations: [], ruling: null } }),
  ]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection A1 ruling: invalid: the ruling has no passing citation'), result.stdout);
  assert.ok(result.lines.includes('objection A1 rebuttal: invalid: the rebuttal has no passing citation'), result.stdout);
  assert.ok(!result.lines.some((line) => line.startsWith('objection A2')), result.stdout);
  assert.deepEqual(result.ledger.objections.map((each) => each.status), ['escalated', 'rejected']);
});

test('check: a schema error exits 1 and leaves the ledger as it was', (t) => {
  const p = project(t);
  const bad = ledger([objection('A1', [{ ...PASSING.code, line: 3 }])]);
  const schema = p.check(bad);
  assert.equal(schema.status, 1);
  assert.match(schema.stderr, /\$\.objections\[0\]\.citations\[0\]\.line is not a known field/u);
  assert.deepEqual(schema.ledger, bad, 'not written back');
});

test('check: a ref path that leaves the root is one failed citation: a warning on stderr, the ledger written, exit 0', (t) => {
  const p = project(t);
  write(p.state, 'outside.md', '# Out\n\n## A\nsecret\n');
  symlinkSync(path.join(p.state, 'outside.md'), path.join(p.root, 'docs/link.md'));
  const escapes = [cite('doc', '../outside.md#a', 'secret'), cite('code', `${p.state}/outside.md:1`, 'secret'), cite('absence', '../', 'x'), cite('doc', 'docs/link.md#a', 'secret')];
  // Each escape beside a passing citation: the objection stands on the other one, and only the escape fails.
  const result = p.check(ledger([...escapes.map((escape, i) => objection(`A${i + 1}`, [escape])), objection('A5', [escapes[0], PASSING.code])]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ledger.objections.map((each) => each.status), ['opinion', 'opinion', 'opinion', 'opinion', 'pending'], 'written back');
  for (const [i, escape] of escapes.entries()) {
    assert.ok(result.lines.some((line) => line.startsWith(`objection A${i + 1}.citations[0] (${escape.kind} ${escape.ref}): `) && line.endsWith('is outside the repository root')), `${escape.ref}\n${result.stdout}`);
    assert.match(result.stderr, new RegExp(`warning: objection A${i + 1}\\.citations\\[0\\]: .* is outside the repository root, not read`, 'u'), escape.ref);
  }
  assert.ok(result.lines.includes('objection A5.citations[0] (doc ../outside.md#a): ../outside.md is outside the repository root'), result.stdout);
  assert.ok(!result.lines.some((line) => line.startsWith('objection A5:')), 'the passing citation keeps A5');
});

test('check: a citation through a symlinked folder that points outside the root fails as an escape, for code, doc, and absence', (t) => {
  const p = project(t);
  // A symlinked shared folder, as a linked node_modules or config: its text never counts, for or against a claim.
  write(p.state, 'shared/lib.js', 'export const SHARED_NEEDLE = 1;\n');
  write(p.state, 'shared/notes.md', '# Notes\n\n## A\nSHARED_NEEDLE\n');
  symlinkSync(path.join(p.state, 'shared'), path.join(p.root, 'vendor'));
  p.git('add', 'vendor');
  const refs = [cite('code', 'vendor/lib.js:1', 'SHARED_NEEDLE'), cite('doc', 'vendor/notes.md#a', 'SHARED_NEEDLE'), cite('absence', 'vendor', 'NOT_THERE'), cite('absence', 'vendor/lib.js', 'NOT_THERE')];
  const result = p.check(ledger(refs.map((citation, i) => objection(`A${i + 1}`, [citation]))));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ledger.objections.map((each) => each.status), Array(refs.length).fill('opinion'));
  for (const [i, citation] of refs.entries()) {
    assert.ok(result.lines.includes(`objection A${i + 1}.citations[0] (${citation.kind} ${citation.ref}): ${citation.ref.replace(/[:#].*$/u, '')} is outside the repository root`), `${citation.ref}\n${result.stdout}`);
  }
  assert.equal(result.stderr.trim().split('\n').length, refs.length, result.stderr);
});

test('check: an escape in a ruling or a rebuttal fails that citation and warns: the ruling or rebuttal is invalid, exit 0', (t) => {
  const p = project(t);
  write(p.state, 'outside.md', '# Out\n\n## A\nsecret\n');
  symlinkSync(p.state, path.join(p.root, 'state-link'));
  const out = cite('doc', 'state-link/outside.md#a', 'secret');
  const result = p.check(ledger([
    objection('A1', [PASSING.code], { status: 'rejected', ruling: { decision: 'reject', change_or_reason: 'r', citations: [out] } }),
    objection('A2', [PASSING.code], { status: 'rejected', ruling: { decision: 'reject', change_or_reason: 'r', citations: [PASSING.adr] }, rebuttal: { verdict: 'rebut', claim: 'c', citations: [cite('code', '../x.js:1', 'x')], ruling: { decision: 'reject', change_or_reason: 'r', citations: [out] } } }),
  ]));
  assert.equal(result.status, 0, result.stderr);
  for (const line of [
    'objection A1 ruling.citations[0] (doc state-link/outside.md#a): state-link/outside.md is outside the repository root',
    'objection A1 ruling: invalid: the ruling has no passing citation',
    'objection A2 rebuttal.citations[0] (code ../x.js:1): ../x.js is outside the repository root',
    'objection A2 rebuttal: invalid: the rebuttal has no passing citation',
    'objection A2 rebuttal ruling: invalid: the ruling has no passing citation',
  ]) assert.ok(result.lines.includes(line), `${line}\n${result.stdout}`);
  assert.equal(result.stderr.trim().split('\n').length, 3, result.stderr);
  assert.deepEqual(result.ledger.objections.map((each) => each.status), ['rejected', 'rejected']);
});

test('check: GIT_DIR and GIT_WORK_TREE pointing at another repository do not redirect absence: it lists the root`s files', (t) => {
  const p = project(t);
  // Another temporary repository, whose tracked files do not hold the quote that the root's src/app.js holds.
  const other = temp(t, 'aidrian-quorum-other-');
  spawnSync('git', ['init', '-q', other]);
  write(other, 'src/other.js', 'nothing here\n');
  spawnSync('git', ['add', '-A'], { cwd: other });
  const env = { ...process.env, GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other };
  const result = p.check(ledger([objection('A1', [cite('absence', 'src', 'export function book')])]), { env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection A1.citations[0] (absence src): src/app.js contains the quote'), result.stdout);
});

test('check: when git ls-files fails, the absence problem names git`s exit code and its last stderr line', (t) => {
  const p = project(t);
  // A git on PATH that fails `ls-files` as a sandboxed git does, and runs the real git for every other call.
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = temp(t, 'aidrian-quorum-bin-');
  write(bin, 'git', `#!/bin/sh\ncase " $* " in *" ls-files "*) echo "warning: first line" >&2; echo "fatal: cannot write cache" >&2; exit 128;; esac\nexec '${real}' "$@"\n`);
  spawnSync('chmod', ['+x', path.join(bin, 'git')]);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const result = p.check(ledger([objection('A1', [cite('absence', 'src', 'NEEDLE_9')]), objection('A2', [PASSING.code])]), { env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection A1.citations[0] (absence src): git ls-files failed on src (exit 128: fatal: cannot write cache)'), result.stdout);
});

test('check: absence never counts an ignored or untracked file: naming one is a path git tracks no file under', (t) => {
  const p = project(t);
  const result = p.check(ledger([
    objection('A1', [cite('absence', 'src/secret.txt', 'other')]),
    objection('A2', [cite('absence', 'src/untracked.js', 'other')]),
    objection('A3', [PASSING.absence]),
  ]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection A1.citations[0] (absence src/secret.txt): git tracks no file under src/secret.txt'), result.stdout);
  assert.ok(result.lines.includes('objection A2.citations[0] (absence src/untracked.js): git tracks no file under src/untracked.js'), result.stdout);
  assert.ok(!result.lines.some((line) => line.startsWith('objection A3')), 'the needle only in ignored and untracked files is absent');
});

test('check: a ref with a NUL or another control character is not a relative path, and check does not crash', (t) => {
  const p = project(t);
  const refs = [cite('absence', 'src\u0000x', 'x'), cite('code', 'src/app.js\u0000:1', 'x'), cite('doc', 'docs/rules.md\n#refunds', 'x'), cite('absence', 'src\u007f', 'x')];
  const result = p.check(ledger(refs.map((citation, i) => objection(`A${i + 1}`, [citation]))));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('\u0000'), 'no NUL reaches the output');
  for (const [i, shown] of ['src\\u0000x', 'src/app.js\\u0000:1', 'docs/rules.md\\u000a#refunds', 'src\\u007f'].entries()) {
    assert.ok(result.lines.some((line) => line.startsWith(`objection A${i + 1}.citations[0] (${refs[i].kind} ${shown}): "`) && line.endsWith('" is not a relative path')), `${shown}\n${result.stdout}`);
  }
  assert.deepEqual(result.ledger.objections.map((each) => each.status), Array(refs.length).fill('opinion'));
  // A ref malformed for its kind fails before the path check, and is printed escaped too.
  const malformed = p.check(ledger([
    objection('A1', [cite('code', 'src\u0000x', 'x')]),
    objection('A2', [cite('doc', 'docs/a.md\u001b[31mRED', 'x')]),
    objection('A3', [cite('plan', 'Appr\u0000oach', 'x')]),
  ]));
  assert.equal(malformed.status, 0, malformed.stderr);
  // No raw control character, other than the line breaks between lines.
  assert.doesNotMatch(malformed.stdout.replaceAll('\n', ''), /[\u0000-\u001f\u007f]/u, 'no raw control character on stdout');
  assert.ok(malformed.lines.includes('objection A1.citations[0] (code src\\u0000x): "src\\u0000x" is not path:line'), malformed.stdout);
  assert.ok(malformed.lines.includes('objection A2.citations[0] (doc docs/a.md\\u001b[31mRED): "docs/a.md\\u001b[31mRED" is not path#anchor'), malformed.stdout);
  assert.ok(malformed.lines.includes('objection A3.citations[0] (plan Appr\\u0000oach): "Appr\\u0000oach" is not #anchor'), malformed.stdout);
});

test('check: a code or doc citation to a FIFO fails as missing instead of hanging', { skip: process.platform === 'win32' }, (t) => {
  const p = project(t);
  for (const name of ['src/pipe.js', 'docs/pipe.md']) assert.equal(spawnSync('mkfifo', [path.join(p.root, name)]).status, 0);
  const result = p.check(ledger([objection('A1', [cite('code', 'src/pipe.js:1', 'x')]), objection('A2', [cite('doc', 'docs/pipe.md#a', 'x')])]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection A1.citations[0] (code src/pipe.js:1): src/pipe.js is missing'), result.stdout);
  assert.ok(result.lines.includes('objection A2.citations[0] (doc docs/pipe.md#a): docs/pipe.md is missing'), result.stdout);
});

// A stand-in for `codex exec`: it records how it was started, writes `answer` where -o points, then exits with `code`
// after printing `stderr`. With `hang`, it never answers.
function fakeCodex({ code = 0, stderr = '', answer, hang = false } = {}) {
  const calls = [];
  const spawnImpl = (command, argv, options) => {
    const child = new EventEmitter();
    child.signals = [];
    child.kill = (signal) => child.signals.push(signal);
    child.unref = () => {};
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = '';
    child.stdin.on('data', (chunk) => (input += chunk));
    child.stdin.on('end', () => {
      const at = (flag) => argv[argv.indexOf(flag) + 1];
      calls.push({ command, argv, options, input, schema: JSON.parse(readFileSync(at('--output-schema'), 'utf8')), child });
      if (hang) return;
      if (answer !== undefined) writeFileSync(at('-o'), typeof answer === 'string' ? answer : JSON.stringify(answer));
      child.stderr.end(stderr);
      child.stdout.end();
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return { spawnImpl, calls };
}

function codexRun(t, fake, { codex = () => ({ ok: true }) } = {}) {
  const dir = temp(t, 'aidrian-quorum-codex-');
  // A repository of its own as the folder the command runs in, so the test reads nothing of this checkout.
  spawnSync('git', ['init', '-q', dir]);
  write(dir, 'brief.md', 'You are adversary B.\n\n');
  write(dir, 'plan.md', '# Plan\n\nDo it.\n');
  const printed = [];
  const out = path.join(dir, 'state/objections.json');
  // A ledger outside the repository, as one in the state folder is: B1 rejected, B2 accepted (perhaps in part), B3
  // escalated, B4 pending, and A1 rejected.
  const ledgerFile = path.join(temp(t, 'aidrian-quorum-ledger-'), 'quorum/plan-abc.json');
  write(path.dirname(ledgerFile), path.basename(ledgerFile), JSON.stringify(RULED));
  const rebut = ['--mode', 'rebut', '--ledger', ledgerFile];
  const run = (extra = {}, brief = path.join(dir, 'brief.md'), flags = []) => commands.quorum.run(['codex', '--plan', path.join(dir, 'plan.md'), '--brief', brief, '--out', out, ...flags], { spawnImpl: fake.spawnImpl, codex, print: (line) => printed.push(line), cwd: dir, ...extra });
  return { dir, out, printed, run, ledgerFile, rebut };
}

const ruling = (decision) => ({ decision, change_or_reason: 'r', citations: [PASSING.adr] });
const RULED = legacy([
  objection('B1', [PASSING.code], { by: 'B', status: 'rejected', ruling: ruling('reject') }),
  objection('B2', [PASSING.code], { by: 'B', status: 'accepted', ruling: ruling('accept') }),
  objection('B3', [PASSING.code], { by: 'B', status: 'escalated', ruling: ruling('escalate') }),
  objection('B4', [PASSING.code], { by: 'B' }),
  objection('A1', [PASSING.code], { status: 'rejected', ruling: ruling('reject') }),
]);

const ANSWER = { objections: [{ severity: 'blocking', claim: 'breaks the rule', citations: [PASSING.adr] }] };

// The statuses `aidrian quorum codex` prints, and the exit code of each: the codex tests and the SKILL.md test below read them here.
const CODEX_EXITS = { done: 0, unavailable: 3, timed_out: 1, quota: 1, failed: 1 };

test('quorum codex: done writes the objections, prints one line, and exits 0; Codex runs read-only, isolated, on the brief then the plan', async (t) => {
  const fake = fakeCodex({ answer: ANSWER });
  const r = codexRun(t, fake);
  process.env.CLAUDE_CODE_SESSION_ID = 'quorum-test';
  t.after(() => delete process.env.CLAUDE_CODE_SESSION_ID);
  assert.equal(await r.run(), CODEX_EXITS.done);
  assert.deepEqual(r.printed.map((line) => Object.keys(JSON.parse(line))), [['status', 'reason']]);
  assert.equal(JSON.parse(r.printed[0]).status, 'done');
  assert.deepEqual(JSON.parse(readFileSync(r.out, 'utf8')), ANSWER);
  const [call] = fake.calls;
  assert.equal(call.command, 'codex');
  assert.deepEqual(call.argv.slice(0, 4), ['exec', '--sandbox', 'read-only', '--ephemeral']);
  assert.deepEqual(call.schema, OBJECTIONS_SCHEMA);
  assert.equal(call.input, 'You are adversary B.\n\n# Plan\n\nDo it.\n');
  assert.equal(call.options.detached, true);
  assert.equal(call.options.env.CLAUDE_CODE_SESSION_ID, undefined, 'the env is isolated');
});

test('quorum codex: unavailable exits 3 without starting Codex', async (t) => {
  const fake = fakeCodex();
  const r = codexRun(t, fake, { codex: () => ({ ok: false, reason: 'the codex CLI is not installed' }) });
  assert.equal(await r.run(), CODEX_EXITS.unavailable);
  assert.deepEqual(r.printed.map((line) => JSON.parse(line)), [{ status: 'unavailable', reason: 'the codex CLI is not installed' }]);
  assert.equal(fake.calls.length, 0);
});

test('quorum codex: quota and failed exit 1, and an answer off the schema is failed', async (t) => {
  for (const [fake, status, reason] of [
    [fakeCodex({ code: 1, stderr: 'working\nYou hit your usage limit\n' }), 'quota', /usage limit/u],
    [fakeCodex({ code: 2, stderr: 'boom\n' }), 'failed', /^exit 2: boom$/u],
    [fakeCodex({ answer: 'not json' }), 'failed', /did not print JSON/u],
    [fakeCodex({ answer: { objections: [{ severity: 'nit', claim: 'x', citations: [] }] } }), 'failed', /does not follow the schema/u],
  ]) {
    const r = codexRun(t, fake);
    assert.equal(await r.run(), CODEX_EXITS[status], status);
    const line = JSON.parse(r.printed[0]);
    assert.equal(r.printed.length, 1);
    assert.equal(line.status, status);
    assert.match(line.reason, reason);
  }
});

test('quorum codex: timed_out after 780 s, with SIGTERM then SIGKILL, exits 1', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeCodex({ hang: true });
  const r = codexRun(t, fake);
  const exit = r.run();
  await new Promise((resolve) => setImmediate(resolve));
  const child = fake.calls[0].child;
  t.mock.timers.tick(CODEX_TIMEOUT_SEC * 1000 - 1);
  assert.deepEqual(child.signals, []);
  t.mock.timers.tick(1);
  assert.deepEqual(child.signals, ['SIGTERM']);
  t.mock.timers.tick(5000);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  t.mock.timers.tick(2000);
  assert.equal(await exit, CODEX_EXITS.timed_out);
  assert.deepEqual(r.printed.map((line) => JSON.parse(line)), [{ status: 'timed_out', reason: 'no answer in 780 s' }]);
});

test('runCodex removes its folder, and runExec`s codex branch runs through it with the findings schema', async (t) => {
  const fake = fakeCodex({ answer: { findings: [], verdicts: [], contracts: [], cross_notes: [] } });
  const dir = temp(t, 'aidrian-quorum-exec-');
  const result = await runExec({ name: 'codex-local', kind: 'exec', builtIn: 'codex', timeoutSec: 780 }, { base: 'a', head: 'b', flows: [], files: null }, { root: dir, env: {}, spawnImpl: fake.spawnImpl });
  assert.equal(result.status, 'done');
  assert.deepEqual(fake.calls[0].schema, FINDINGS_SCHEMA);
  const schemaFile = fake.calls[0].argv[fake.calls[0].argv.indexOf('--output-schema') + 1];
  assert.throws(() => readFileSync(schemaFile), /ENOENT/u, 'the temporary folder is gone');
  const raw = await runCodex({ root: dir, env: {}, schema: OBJECTIONS_SCHEMA, prompt: 'p', timeoutSec: 5, spawnImpl: fakeCodex({ answer: ANSWER }).spawnImpl });
  assert.deepEqual(raw, { status: 'done', raw: ANSWER });
});

test('check: a CRLF plan keeps a quote that follows a fenced `# comment` in its section', (t) => {
  const p = project(t);
  writeFileSync(p.plan, ['# Plan', '', '## Approach', 'Run:', '', '```bash', '# build first', '```', '', 'Then store the ledger.', '', '## Risks', 'None.', ''].join('\r\n'));
  const result = p.check(ledger([objection('A1', [cite('plan', '#approach', 'Then store the ledger.')])]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: mode plan, 1 objections, 0 opinion, 0 problems']);
});

test('check: a heading inside a fenced block is no anchor', (t) => {
  const p = project(t);
  const result = p.check(ledger([objection('A1', [cite('doc', 'docs/rules.md#fake-heading', 'npm run build')])]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection A1.citations[0] (doc docs/rules.md#fake-heading): docs/rules.md has no heading #fake-heading'), result.stdout);
});

test('check: a rebuttal that re-cites the ledger cites nothing new; one with a new passing citation is valid', (t) => {
  const p = project(t);
  const rebut = (citations) => ({ verdict: 'rebut', claim: 'c', citations, ruling: null });
  const ruled = rejects({ citations: [PASSING.adr] });
  const result = p.check(ledger([
    // The same code citation at another line, spaced differently: the line and the spacing are not part of its identity.
    objection('A1', [PASSING.code], { status: 'rejected', ruling: ruled, rebuttal: rebut([cite('code', './src/app.js:2', 'export  function book(slot)\n{')]) }),
    objection('A2', [PASSING.code], { status: 'rejected', ruling: ruled, rebuttal: rebut([cite('adr', 'docs/decisions/0001-store.md#Decision', 'one ledger per plan')]) }),
    objection('A3', [PASSING.code], { status: 'rejected', ruling: ruled, rebuttal: rebut([PASSING.adr, PASSING.plan]) }),
  ]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection A1 rebuttal: invalid: the rebuttal cites nothing new'), result.stdout);
  assert.ok(result.lines.includes('objection A2 rebuttal: invalid: the rebuttal cites nothing new'), 'a ruling`s citation, by heading text');
  assert.ok(!result.lines.some((line) => line.startsWith('objection A3')), result.stdout);
});

test('check: two rebuttals that bring the same new evidence are both valid', (t) => {
  const p = project(t);
  const ruled = rejects({ citations: [PASSING.adr] });
  const rebuttal = { verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling: null };
  const result = p.check(ledger([
    objection('A1', [PASSING.code], { status: 'rejected', ruling: ruled, rebuttal: structuredClone(rebuttal) }),
    objection('A2', [PASSING.plan], { by: 'B', status: 'rejected', ruling: ruled, rebuttal: structuredClone(rebuttal) }),
  ]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: mode plan, 2 objections, 0 opinion, 0 problems']);
});

test('check: a complete ledger with an objection pending, or ruled on with no ruling, exits 1 and is not written', (t) => {
  const p = project(t);
  const ruled = { decision: 'accept', change_or_reason: 'c', citations: [PASSING.adr] };
  for (const [objections, message] of [
    [[objection('A1', [PASSING.code])], /objection A1 is pending in a complete ledger/u],
    [[objection('A2', [PASSING.code], { status: 'accepted' })], /objection A2 is accepted with no ruling in a complete ledger/u],
  ]) {
    const before = legacy(objections);
    const result = p.check(before);
    assert.equal(result.status, 1, message.source);
    assert.match(result.stderr, message);
    assert.deepEqual(result.ledger, before);
  }
  const done = p.check(legacy([objection('A3', [PASSING.code], { status: 'accepted', ruling: ruled }), objection('A4', [cite('code', 'src/app.js:1', 'nope')], { status: 'opinion' })]));
  assert.equal(done.status, 0, done.stderr);
});

test('check: a ledger whose same_model and same_model_reason disagree exits 1 and is not written', (t) => {
  const p = project(t);
  for (const [same_model, same_model_reason, message] of [
    [true, null, /same_model is true, so same_model_reason must say why B ran as an agent/u],
    [true, '  ', /same_model is true, so same_model_reason must say why B ran as an agent/u],
    [false, 'failed: exit 2', /same_model is false, so same_model_reason must be null/u],
  ]) {
    const before = { ...ledger([objection('A1', [PASSING.code])]), same_model, same_model_reason };
    const result = p.check(before);
    assert.equal(result.status, 1, `${same_model} ${same_model_reason}`);
    assert.match(result.stderr, message);
    assert.deepEqual(result.ledger, before, 'not written back');
  }
  for (const [same_model, same_model_reason] of [[true, 'unavailable: the codex CLI is not installed'], [false, null]]) {
    const result = p.check({ ...ledger([objection('A1', [PASSING.code])]), same_model, same_model_reason });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('check: a Human answer for an objection the ledger does not hold, or a second answer for one, exits 1 and is not written', (t) => {
  const p = project(t);
  const ruled = { decision: 'escalate', change_or_reason: 'both', citations: [PASSING.adr] };
  const objections = [objection('A1', [PASSING.code], { status: 'accepted', ruling: ruled }), objection('A2', [PASSING.code], { status: 'rejected', ruling: ruled })];
  const answer = (objection_id) => ({ objection_id, answer: 'do it' });
  for (const [answers, messages] of [
    [[answer('A1'), answer('A9')], [/human_answers names A9, not an objection in this ledger/u]],
    [[answer('A1'), answer('A2'), answer('A1')], [/human_answers answers A1 more than once/u]],
    [[answer('X'), answer('X')], [/human_answers names X, not an objection/u, /human_answers answers X more than once/u]],
  ]) {
    for (const status of ['open', 'complete']) {
      const before = { ...ledger(objections), status, human_answers: answers };
      const result = p.check(before);
      assert.equal(result.status, 1, `${status} ${answers.map((each) => each.objection_id)}`);
      for (const message of messages) assert.match(result.stderr, message);
      assert.deepEqual(result.ledger, before, 'not written back');
    }
  }
  const good = p.check({ ...ledger(objections), status: 'complete', human_answers: [answer('A1'), answer('A2')] });
  assert.equal(good.status, 0, good.stderr);
});

test('check: an objection id other than A1 to A7 or B1 to B7 exits 1, is printed escaped, and the ledger is not written', (t) => {
  const p = project(t);
  for (const id of ['A0', 'A8', 'C1', 'a1', 'A10', '', 'A1\nchecked: 0 objections, 0 opinion, 0 problems']) {
    const before = ledger([objection(id, [PASSING.code])]);
    const result = p.check(before);
    assert.equal(result.status, 1, JSON.stringify(id));
    assert.match(result.stderr, /: objection id ".*" is not A1 to A7 or B1 to B7$/mu, JSON.stringify(id));
    assert.equal(result.stderr.trim().split('\n').length, 1, 'a newline in an id forges no line');
    assert.deepEqual(result.ledger, before, 'not written back');
  }
  const good = p.check(ledger([objection('A7', [PASSING.code]), objection('B1', [PASSING.code], { by: 'B' })]));
  assert.equal(good.status, 0, good.stderr);
  // Two objections under one id: one Human answer would settle both, so the ledger stops before answers are read.
  const ruled = { decision: 'reject', change_or_reason: 'r', citations: [cite('code', 'src/app.js:1', 'gone')] };
  for (const status of ['open', 'complete']) {
    const twice = { ...ledger([
      objection('A1', [PASSING.code], { status: 'accepted', ruling: { ...ruled, decision: 'accept', citations: [PASSING.adr] } }),
      objection('A1', [PASSING.code], { status: 'accepted', ruling: ruled }),
    ]), status, human_answers: [{ objection_id: 'A1', answer: 'yes' }] };
    const result = p.check(twice);
    assert.equal(result.status, 1, status);
    assert.match(result.stderr, /: objection id A1 is used more than once$/mu, status);
    assert.deepEqual(result.ledger, twice, 'not written back');
  }
});

test('check: a complete ledger whose ruling lost its evidence exits 1 and is not written; the same ledger open exits 0 and flags it', (t) => {
  const p = project(t);
  // The ruling cites code; then the code changes and the plan does not, so a reused ledger would treat a stale ruling as settled.
  const evidence = cite('code', 'src/app.js:2', 'export function book(slot) {');
  const ruled = (decision, citations = [evidence]) => ({ decision, change_or_reason: 'r', citations });
  const objections = () => [objection('A1', [PASSING.adr], { status: 'accepted', ruling: ruled('accept') })];
  const before = p.check(legacy(objections()));
  assert.equal(before.status, 0, before.stderr);
  write(p.root, 'src/app.js', 'export const app = 1;\nexport function reserve(slot) {\n  return slot;\n}\n');

  const complete = legacy(objections());
  const refused = p.check(complete);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /objection A1 ruling: invalid: the ruling has no passing citation in a complete ledger$/mu);
  assert.deepEqual(refused.ledger, complete, 'not written back');

  const open = p.check(ledger(objections()));
  assert.equal(open.status, 0, open.stderr);
  assert.ok(open.lines.includes('objection A1 ruling: invalid: the ruling has no passing citation'), open.stdout);

  // An invalid rebuttal, or an invalid final ruling on one, is stale the same way.
  // A rebuttal the architect accepted at the final ruling: the objection is accepted.
  const rebutted = (rebuttal) => legacy([objection('B1', [PASSING.adr], { by: 'B', status: 'accepted', ruling: ruled('reject', [PASSING.plan]), rebuttal })]);
  for (const [entry, line] of [
    [{ verdict: 'rebut', claim: 'c', citations: [evidence], ruling: ruled('accept', [PASSING.fenced]) }, /objection B1 rebuttal: invalid: the rebuttal has no passing citation in a complete ledger$/mu],
    [{ verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling: ruled('accept') }, /objection B1 rebuttal ruling: invalid: the ruling has no passing citation in a complete ledger$/mu],
  ]) {
    const result = p.check(rebutted(entry));
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, line);
  }

  // The Human settled these: an escalated objection keeps its invalid ruling, and an answered one stands on the answer.
  const settled = p.check(legacy([
    objection('A1', [PASSING.adr], { status: 'escalated', ruling: ruled('reject') }),
    objection('A2', [PASSING.adr], { status: 'accepted', ruling: ruled('escalate') }),
  ], { human_answers: [{ objection_id: 'A2', answer: 'accept it' }] }));
  assert.equal(settled.status, 0, settled.stderr);
  assert.ok(settled.lines.includes('objection A1 ruling: invalid: the ruling has no passing citation'), settled.stdout);

  // A valid partial accept escalated on its rejected part: the accepted part still stands, so its stale first ruling
  // is refused even though the objection is escalated. An accept escalated whole (no rebuttal) is the Human's.
  const partial = p.check(legacy([
    objection('B1', [PASSING.adr], { by: 'B', status: 'escalated', ruling: ruled('accept'), rebuttal: { verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling: ruled('reject', [PASSING.plan]) } }),
  ]));
  assert.equal(partial.status, 1, partial.stdout);
  assert.match(partial.stderr, /objection B1 ruling: invalid: the ruling has no passing citation in a complete ledger$/mu);
  const whole = p.check(legacy([objection('B1', [PASSING.adr], { by: 'B', status: 'escalated', ruling: ruled('accept') })]));
  assert.equal(whole.status, 0, whole.stderr);

  // A flagged partial accept: the flag escalated its accepted part too, so its stale first ruling is the Human's,
  // answered or deferred. The invalid line is still printed.
  const flaggedPartial = (status, human_answers) => p.check(legacy([
    objection('B1', [PASSING.adr], { by: 'B', status, ruling: ruled('accept'), rebuttal: { verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling: ruled('reject', [PASSING.plan]) } }),
  ], { human_answers, proportionality: { flagged: [{ objection_id: 'B1', reason: 'too much', smaller_change: '' }] } }));
  const answeredFlag = flaggedPartial('rejected', [{ objection_id: 'B1', answer: 'none' }]);
  assert.equal(answeredFlag.status, 0, answeredFlag.stderr);
  assert.ok(answeredFlag.lines.includes('objection B1 ruling: invalid: the ruling has no passing citation'), answeredFlag.stdout);
  const deferredFlag = flaggedPartial('escalated', []);
  assert.equal(deferredFlag.status, 0, deferredFlag.stderr);
  assert.ok(deferredFlag.lines.includes('objection B1 ruling: invalid: the ruling has no passing citation'), deferredFlag.stdout);
});

test('check: a complete ledger with a rebuttal left unruled, a final ruling other than accept, or a status its decision does not give exits 1', (t) => {
  const p = project(t);
  const ruled = (decision) => ({ decision, change_or_reason: 'r', citations: [PASSING.adr] });
  const rebut = (final) => ({ verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling: final });
  const concede = { verdict: 'concede', claim: 'ok', citations: [], ruling: null };
  for (const [fields, message] of [
    [{ status: 'rejected', ruling: ruled('reject'), rebuttal: rebut(null) }, /objection B1 has a rebuttal with no final ruling in a complete ledger/u],
    [{ status: 'rejected', ruling: ruled('reject'), rebuttal: rebut(ruled('reject')) }, /objection B1 has a final ruling of reject but is rejected, not escalated, in a complete ledger/u],
    [{ status: 'accepted', ruling: ruled('reject'), rebuttal: rebut(ruled('escalate')) }, /objection B1 has a final ruling of escalate but is accepted, not escalated/u],
    [{ status: 'rejected', ruling: ruled('reject'), rebuttal: rebut(ruled('accept')) }, /objection B1 is rejected, but its final decision makes it accepted, in a complete ledger/u],
    [{ status: 'accepted', ruling: ruled('reject') }, /objection B1 is accepted, but its final decision makes it rejected/u],
    [{ status: 'rejected', ruling: ruled('escalate') }, /objection B1 is rejected, but its final decision makes it escalated/u],
    [{ status: 'accepted', ruling: ruled('reject'), rebuttal: concede }, /objection B1 is accepted, but its final decision makes it rejected/u],
    // A rejection never answered: the rebuttal round was skipped, so it should have escalated.
    [{ status: 'rejected', ruling: ruled('reject') }, /objection B1 is rejected with no rebuttal or concession in a complete ledger/u],
  ]) {
    const before = legacy([objection('B1', [PASSING.code], { by: 'B', ...fields })]);
    const result = p.check(before);
    assert.equal(result.status, 1, message.source);
    assert.match(result.stderr, message);
    assert.deepEqual(result.ledger, before, 'not written back');
    // The same ledger still open is mid-run, and so carries `mode`: no complete-ledger problem.
    assert.equal(p.check({ ...before, mode: 'plan', status: 'open' }).status, 0, message.source);
  }
  // Finished ledgers pass: a rebuttal accepted at the final ruling, a concession that keeps the first ruling, an
  // escalated rebuttal, and an unruled rebuttal or a mismatched status that the Human's answer settled.
  const good = p.check(legacy([
    objection('B1', [PASSING.code], { by: 'B', status: 'accepted', ruling: ruled('reject'), rebuttal: rebut(ruled('accept')) }),
    objection('B2', [PASSING.code], { by: 'B', status: 'rejected', ruling: ruled('reject'), rebuttal: concede }),
    objection('B3', [PASSING.code], { by: 'B', status: 'escalated', ruling: ruled('reject'), rebuttal: rebut(ruled('reject')) }),
    objection('B4', [PASSING.code], { by: 'B', status: 'escalated', ruling: ruled('reject'), rebuttal: rebut(null) }),
    objection('B5', [PASSING.code], { by: 'B', status: 'rejected', ruling: ruled('reject'), rebuttal: rebut(ruled('reject')) }),
    objection('A1', [PASSING.code], { status: 'accepted', ruling: ruled('escalate') }),
  ], { human_answers: [{ objection_id: 'B5', answer: 'keep it out' }, { objection_id: 'A1', answer: 'do it' }] }));
  assert.equal(good.status, 0, good.stderr);
});

test('check: a ref that is not a relative path is a failed citation, not an escape', (t) => {
  const p = project(t);
  const refs = [cite('doc', 'docs\\rules.md#refunds', 'refund'), cite('doc', 'docs//rules.md#refunds', 'refund'), cite('doc', '#refunds', 'refund'), cite('code', ':3', 'x'), cite('absence', '', 'x'), cite('code', '.:1', 'x')];
  const objections = spread(refs);
  const result = p.check(ledger(objections));
  assert.equal(result.status, 0, result.stderr);
  for (const [i, citation] of refs.entries()) {
    assert.ok(result.lines.includes(`objection ${objections[i].id}.citations[0] (${citation.kind} ${citation.ref}): "${citation.ref}" is not a relative path`), `${citation.ref}\n${result.stdout}`);
  }
});

test('check: absence reads only regular tracked files: a tracked symlink to an outside file with the needle passes', (t) => {
  const p = project(t);
  write(p.state, 'outside.txt', 'NEEDLE_OUT\n');
  write(p.root, 'lib/real.js', 'export {};\n');
  symlinkSync(path.join(p.state, 'outside.txt'), path.join(p.root, 'lib/link.txt'));
  p.git('add', 'lib');
  const result = p.check(ledger([objection('A1', [cite('absence', 'lib', 'NEEDLE_OUT')])]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: mode plan, 1 objections, 0 opinion, 0 problems']);
});

test('check: an absence path is a literal pathspec, a set GIT_ICASE_PATHSPECS does not break it, and a path with no tracked file fails', (t) => {
  const p = project(t);
  const result = p.check(ledger([
    objection('A1', [cite('absence', ':(exclude)docs', 'export function book')]),
    objection('A2', [cite('absence', 'nowhere', 'NEEDLE_9')]),
    objection('A3', [cite('code', 'src/app.js:1', '')]),
    objection('A4', [cite('code', 'src/app.js:1', '  \n\t ')]),
  ]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection A1.citations[0] (absence :(exclude)docs): git tracks no file under :(exclude)docs'), result.stdout);
  assert.ok(result.lines.includes('objection A2.citations[0] (absence nowhere): git tracks no file under nowhere'), result.stdout);
  assert.ok(result.lines.some((line) => line.startsWith('objection A3.citations[0]') && line.endsWith(': the quote is empty')), result.stdout);
  assert.ok(result.lines.some((line) => line.startsWith('objection A4.citations[0]') && line.endsWith(': the quote is empty')), result.stdout);
  const icase = p.check(ledger([objection('A1', [PASSING.absence])]), { env: { ...process.env, GIT_ICASE_PATHSPECS: '1' } });
  assert.equal(icase.status, 0, icase.stderr);
  assert.deepEqual(icase.lines, ['checked: mode plan, 1 objections, 0 opinion, 0 problems']);
});

test('quorum codex: a brief that cannot be read is failed, with one line and exit 1', async (t) => {
  const fake = fakeCodex({ answer: ANSWER });
  const r = codexRun(t, fake);
  assert.equal(await r.run({}, path.join(r.dir, 'missing.md')), 1);
  assert.equal(r.printed.length, 1);
  const line = JSON.parse(r.printed[0]);
  assert.equal(line.status, 'failed');
  assert.match(line.reason, /ENOENT/u);
  assert.equal(fake.calls.length, 0);
});

const REBUTTALS = { rebuttals: [
  { objection_id: 'B1', verdict: 'rebut', claim: 'the ruling misreads the rule', citations: [PASSING.docBySlug] },
  { objection_id: 'B2', verdict: 'concede', claim: 'the ruling holds', citations: [] },
] };

test('REBUTTALS_SCHEMA: Codex-strict, a concession may cite nothing, and each entry fills a ledger rebuttal without loss', () => {
  const entry = REBUTTALS_SCHEMA.properties.rebuttals.items;
  assert.equal(REBUTTALS_SCHEMA.additionalProperties, false);
  assert.deepEqual(REBUTTALS_SCHEMA.required, ['rebuttals']);
  assert.equal(entry.additionalProperties, false);
  assert.deepEqual([...entry.required].sort(), ['citations', 'claim', 'objection_id', 'verdict']);
  assert.deepEqual(entry.properties.verdict.enum, ['rebut', 'concede']);
  assert.deepEqual(entry.properties.citations.items.required, ['kind', 'ref', 'quote']);
  assert.equal(entry.properties.citations.items.additionalProperties, false);
  assert.deepEqual(schemaProblems(REBUTTALS, REBUTTALS_SCHEMA), []);
  assert.deepEqual(schemaProblems({ rebuttals: [{ ...REBUTTALS.rebuttals[0], ruling: null }] }, REBUTTALS_SCHEMA), ['$.rebuttals[0].ruling is not a known field']);

  // The ledger rebuttal is the entry without objection_id (which names the objection it goes on), plus a ruling.
  const ledgerRebuttal = LEDGER_SCHEMA.properties.objections.items.properties.rebuttal;
  const { objection_id: id, ...fields } = entry.properties;
  const { ruling, ...ledgerFields } = ledgerRebuttal.properties;
  assert.deepEqual(id, { type: 'string' });
  assert.deepEqual(ledgerFields, fields, 'every field the entry carries, with the same schema');
  assert.ok(ruling);
  const objections = REBUTTALS.rebuttals.map(({ objection_id, ...rest }) => objection(objection_id, [PASSING.code], {
    by: 'B',
    status: 'rejected',
    ruling: { decision: 'reject', change_or_reason: 'r', citations: [PASSING.adr] },
    rebuttal: { ...rest, ruling: null },
  }));
  assert.deepEqual(schemaProblems(ledger(objections), LEDGER_SCHEMA), []);
});

test('quorum codex --mode rebut: a schema-valid answer is held to REBUTTALS_SCHEMA, written, and exits 0 with one line', async (t) => {
  const fake = fakeCodex({ answer: REBUTTALS });
  const r = codexRun(t, fake);
  assert.equal(await r.run({}, undefined, r.rebut), 0);
  assert.deepEqual(r.printed.map((line) => JSON.parse(line)), [{ status: 'done', reason: `2 rebuttals written to ${r.out}` }]);
  assert.deepEqual(JSON.parse(readFileSync(r.out, 'utf8')), REBUTTALS);
  assert.deepEqual(fake.calls[0].schema, REBUTTALS_SCHEMA);
  assert.deepEqual(fake.calls[0].argv.slice(0, 4), ['exec', '--sandbox', 'read-only', '--ephemeral']);
});

test('quorum codex --mode rebut: an answer with no verdict, no objection_id, or in the objection shape is failed and not written', async (t) => {
  const [rebut] = REBUTTALS.rebuttals;
  const { verdict, ...noVerdict } = rebut;
  const { objection_id, ...noId } = rebut;
  for (const [answer, reason] of [
    [{ rebuttals: [noVerdict] }, /\$\.rebuttals\[0\]\.verdict is missing/u],
    [{ rebuttals: [noId] }, /\$\.rebuttals\[0\]\.objection_id is missing/u],
    [ANSWER, /\$\.rebuttals is missing/u],
  ]) {
    const r = codexRun(t, fakeCodex({ answer }));
    assert.equal(await r.run({}, undefined, r.rebut), 1);
    assert.equal(r.printed.length, 1);
    const line = JSON.parse(r.printed[0]);
    assert.equal(line.status, 'failed');
    assert.match(line.reason, /does not follow the schema/u);
    assert.match(line.reason, reason);
    assert.throws(() => readFileSync(r.out), /ENOENT/u, 'nothing written');
  }
});

test('quorum codex --mode object is the default: the same schema, answer, and line as no --mode; a rebuttals answer fails it', async (t) => {
  const results = [];
  for (const flags of [[], ['--mode', 'object']]) {
    const fake = fakeCodex({ answer: ANSWER });
    const r = codexRun(t, fake);
    assert.equal(await r.run({}, undefined, flags), 0);
    assert.deepEqual(fake.calls[0].schema, OBJECTIONS_SCHEMA);
    results.push({ line: JSON.parse(r.printed[0]), written: JSON.parse(readFileSync(r.out, 'utf8')), out: r.out });
  }
  for (const each of results) {
    assert.deepEqual(each.line, { status: 'done', reason: `1 objections written to ${each.out}` });
    assert.deepEqual(each.written, ANSWER);
  }
  const r = codexRun(t, fakeCodex({ answer: REBUTTALS }));
  assert.equal(await r.run(), 1);
  assert.match(JSON.parse(r.printed[0]).reason, /\$\.objections is missing/u);
});

test('quorum codex: an unknown --mode is a usage error: exit 1, no status line, and Codex never starts', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  for (const mode of ['rebuttal', 'OBJECT', '']) {
    const fake = fakeCodex({ answer: ANSWER });
    let checked = 0;
    const r = codexRun(t, fake, { codex: () => (checked++, { ok: true }) });
    assert.equal(await r.run({}, undefined, ['--mode', mode]), 1, mode);
    assert.deepEqual(r.printed, [], mode);
    assert.equal(fake.calls.length, 0, mode);
    assert.equal(checked, 0, 'stops before it looks for Codex');
  }
  assert.equal(errors.mock.callCount(), 3);
  assert.match(errors.mock.calls[0].arguments[0], /^aidrian quorum: codex --mode is object, rebut, case, or cross, not "rebuttal"$/u);
});

test('quorum codex: --mode with no value is a parse error, as any bad flag is', async (t) => {
  const r = codexRun(t, fakeCodex({ answer: ANSWER }));
  await assert.rejects(r.run({}, undefined, ['--mode']), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' });
  await assert.rejects(r.run({}, undefined, ['--nope']), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
});

test('quorum codex --mode rebut: an answer that does not fit the ledger is failed, names the ids, and is not written', async (t) => {
  const entry = (objection_id, verdict = 'concede') => ({ objection_id, verdict, claim: 'c', citations: [] });
  for (const [entries, reason] of [
    [[entry('B1'), entry('B1', 'rebut')], /^the answer does not fit the ledger: the answer names B1 more than once$/u],
    [[entry('B1'), entry('B9')], /: the answer names B9, not B's objection ruled reject or accept, and not escalated, in the ledger$/u],
    [[entry('B1'), entry('A1')], /: the answer names A1, not B's objection ruled reject or accept, and not escalated, in the ledger$/u],
    [[entry('B1'), entry('B3'), entry('B4')], /: the answer names B3, B4, not B's objection ruled reject or accept, and not escalated/u],
    [[entry('B2')], /: the answer has no entry for B1, B's objection rejected in the ledger$/u],
    [[], /: the answer has no entry for B1/u],
    [[entry('B1'), entry('B1'), entry('A1')], /names B1 more than once; the answer names A1, not/u],
    [Array.from({ length: 8 }, (_, i) => entry(`B${i}`)), /^the answer does not follow the schema: \$\.rebuttals has 8 items, more than 7$/u],
  ]) {
    const r = codexRun(t, fakeCodex({ answer: { rebuttals: entries } }));
    assert.equal(await r.run({}, undefined, r.rebut), 1, reason.source);
    assert.equal(r.printed.length, 1);
    const line = JSON.parse(r.printed[0]);
    assert.equal(line.status, 'failed');
    assert.match(line.reason, reason);
    assert.throws(() => readFileSync(r.out), /ENOENT/u, 'nothing written');
  }
  // Only B1 is required: a partial accept (B2) may be answered or not.
  const r = codexRun(t, fakeCodex({ answer: { rebuttals: [entry('B1', 'rebut')] } }));
  assert.equal(await r.run({}, undefined, r.rebut), 0, r.printed[0]);
});

test('rebuttalProblems: an escalated B objection gets no rebuttal, even when its ruling is reject; only a rejected one needs an entry', () => {
  const entry = (objection_id) => ({ objection_id, verdict: 'concede', claim: 'c', citations: [] });
  // B5 was ruled reject, but its ruling was invalid twice, so it escalated: it goes to the Human, not to a rebuttal.
  const escalated = legacy([
    objection('B1', [PASSING.code], { by: 'B', status: 'rejected', ruling: ruling('reject') }),
    objection('B2', [PASSING.code], { by: 'B', status: 'accepted', ruling: ruling('accept') }),
    objection('B5', [PASSING.code], { by: 'B', status: 'escalated', ruling: ruling('reject') }),
    objection('B6', [PASSING.code], { by: 'B', status: 'escalated', ruling: ruling('accept') }),
  ]);
  assert.deepEqual(rebuttalProblems({ rebuttals: [entry('B1')] }, escalated), []);
  assert.deepEqual(rebuttalProblems({ rebuttals: [entry('B1'), entry('B2')] }, escalated), []);
  assert.deepEqual(rebuttalProblems({ rebuttals: [entry('B1'), entry('B5'), entry('B6')] }, escalated), [
    "the answer names B5, B6, not B's objection ruled reject or accept, and not escalated, in the ledger",
  ]);
  assert.deepEqual(rebuttalProblems({ rebuttals: [] }, escalated), ["the answer has no entry for B1, B's objection rejected in the ledger"]);
});

test('quorum codex --mode rebut: a ledger that cannot be read or is off the schema is failed before Codex starts', async (t) => {
  for (const [text, reason] of [[null, /ENOENT/u], ['not json', /JSON/u], [JSON.stringify({ ...RULED, trigger: undefined, extra: 1 }), /^the ledger does not follow the schema: \$\.trigger is missing$/u]]) {
    const fake = fakeCodex({ answer: REBUTTALS });
    const r = codexRun(t, fake);
    if (text === null) rmSync(r.ledgerFile);
    else writeFileSync(r.ledgerFile, text);
    assert.equal(await r.run({}, undefined, r.rebut), 1);
    const line = JSON.parse(r.printed[0]);
    assert.equal(line.status, 'failed');
    assert.match(line.reason, reason);
    assert.equal(fake.calls.length, 0);
  }
});

test('quorum codex: --mode rebut or cross without --ledger, or --ledger without either, is a usage error and Codex never starts', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  for (const [flags, message] of [
    [['--mode', 'rebut'], 'aidrian quorum: codex --mode rebut needs --ledger'],
    [['--mode', 'rebut', '--ledger', ''], 'aidrian quorum: codex --mode rebut needs --ledger'],
    [['--mode', 'cross'], 'aidrian quorum: codex --mode cross needs --ledger'],
    [['--ledger', 'x.json'], 'aidrian quorum: codex --ledger is only for --mode rebut or cross'],
    [['--mode', 'object', '--ledger', 'x.json'], 'aidrian quorum: codex --ledger is only for --mode rebut or cross'],
    [['--mode', 'case', '--ledger', 'x.json'], 'aidrian quorum: codex --ledger is only for --mode rebut or cross'],
  ]) {
    const fake = fakeCodex({ answer: REBUTTALS });
    const r = codexRun(t, fake);
    assert.equal(await r.run({}, undefined, flags), 1, flags.join(' '));
    assert.deepEqual(r.printed, []);
    assert.equal(fake.calls.length, 0);
    assert.equal(errors.mock.calls.at(-1).arguments[0], message);
  }
});

test('codexAnswer: an unknown mode, or rebut or cross with no ledger, is failed, not thrown, and Codex is never looked for', async (t) => {
  const dir = temp(t, 'aidrian-quorum-guard-');
  const deps = { spawnImpl: fakeCodex().spawnImpl, codex: () => assert.fail('looked for Codex') };
  const args = { plan: 'p', brief: 'b', out: path.join(dir, 'o.json'), root: dir };
  assert.deepEqual(await codexAnswer({ ...args, mode: 'nope' }, deps), { status: 'failed', reason: '"nope" is not a mode: object, rebut, case, or cross' });
  assert.deepEqual(await codexAnswer({ ...args, mode: 'toString' }, deps), { status: 'failed', reason: '"toString" is not a mode: object, rebut, case, or cross' });
  assert.deepEqual(await codexAnswer({ ...args, mode: 'rebut' }, deps), { status: 'failed', reason: '--mode rebut needs a ledger' });
  assert.deepEqual(await codexAnswer({ ...args, mode: 'cross' }, deps), { status: 'failed', reason: '--mode cross needs a ledger' });
});

const SKILL = path.resolve(import.meta.dirname, '../plugins/aidrian/skills/quorum');
const PLAN_REVIEW = path.resolve(import.meta.dirname, '../plugins/aidrian/skills/plan-review/SKILL.md');

// The field paths of `schema`, as the ledger reference writes them: `a.b` for a property, `a[]` for an array's items.
// A schema node used in several places, such as the citation or the ruling, is listed at each place and expanded only
// at its first, so the reference describes each shape once and points to it after.
function fieldPaths(schema) {
  const seen = new Set();
  const paths = [];
  const expand = (node, at) => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node.items) expand(node.items, `${at}[]`);
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const field = at ? `${at}.${key}` : key;
      paths.push({ field, node: child });
      expand(child, field);
    }
  };
  expand(schema, '');
  return paths;
}

// The section of ledger.md that lists each mode's ledger fields. A mode added to LEDGER_SCHEMAS needs its own section.
const FIELD_SECTIONS = { plan: 'Fields', decide: 'Decide-mode fields', product: 'Product-mode fields' };

// A fields section of ledger.md: each bullet starts with a field path in backticks; its text runs to the next bullet.
function documentedFields(heading = 'Fields') {
  const text = readFileSync(path.join(SKILL, 'references/ledger.md'), 'utf8');
  const section = text.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0];
  assert.ok(section, `ledger.md has § ${heading}`);
  const bullets = new Map();
  let current = null;
  for (const line of section.split('\n')) {
    const bullet = /^\s*- `([^`]+)`/u.exec(line);
    if (bullet) {
      current = bullet[1];
      assert.ok(!bullets.has(current), `ledger.md § ${heading} names ${current} twice`);
      bullets.set(current, line);
    } else if (current && line.trim()) bullets.set(current, `${bullets.get(current)} ${line}`);
  }
  return { text, bullets };
}

// One section's bullets against one schema: every field and no other, its enum values both ways, and null where the
// schema allows it.
function assertFieldParity(schema, heading) {
  const { bullets } = documentedFields(heading);
  const fields = fieldPaths(schema);
  assert.deepEqual([...bullets.keys()].sort(), fields.map((each) => each.field).sort(), `ledger.md § ${heading}`);
  for (const { field, node } of fields) {
    const bullet = bullets.get(field);
    const enumValues = node.enum ?? node.items?.enum;
    const nullable = [node.type].flat().includes('null');
    if (enumValues) {
      for (const value of enumValues) assert.ok(bullet.includes(`\`${value}\``), `ledger.md: ${field} does not name ${value}`);
      // After the field path, every backticked word in an enum field's bullet is one of its values, or null where the
      // schema allows it.
      const named = [...bullet.matchAll(/`([^`]+)`/gu)].slice(1).map((match) => match[1]);
      // A backticked word is text, so a boolean enum, such as `true`, matches by its text.
      const allowed = [...enumValues.map(String), ...(nullable ? ['null'] : [])];
      for (const value of named) assert.ok(allowed.includes(value), `ledger.md: ${field} names ${value}, not in its enum`);
    }
    assert.equal(bullet.includes('`null`'), nullable, `ledger.md: ${field} ${nullable ? 'does not say' : 'says'} \`null\``);
  }
}

test('ledger.md names every field of LEDGER_SCHEMA and no other, its enum values both ways, null where the schema allows it, and keeps no schema copy', () => {
  const { text } = documentedFields();
  // The plan-mode fields are in the schema, so the parity check holds ledger.md to them too.
  const fields = new Map(fieldPaths(LEDGER_SCHEMA).map(({ field, node }) => [field, node]));
  for (const field of ['mode', 'notes', 'objections[].merged_into', 'objections[].ruling.tested', 'objections[].ruling.inferences', 'objections[].ruling.ground', 'proportionality']) assert.ok(fields.has(field), `LEDGER_SCHEMA has ${field}`);
  assert.deepEqual(fields.get('objections[].ruling.ground').enum, ['covered', 'implementation', 'settled', 'off-goal', 'disproportionate', 'speculative']);
  assert.ok(fields.get('objections[].status').enum.includes('merged'));
  assertFieldParity(LEDGER_SCHEMA, FIELD_SECTIONS.plan);
  for (const name of ['LEDGER_SCHEMA', 'OBJECTIONS_SCHEMA', 'REBUTTALS_SCHEMA']) assert.ok(text.includes(`\`${name}\``), `ledger.md names ${name}`);
  assert.doesNotMatch(text, /```json/u, 'ledger.md keeps no JSON copy of a schema');
});

test('ledger.md has a fields section per mode in LEDGER_SCHEMAS, each listing its own schema\'s fields and no other', () => {
  assert.deepEqual(Object.keys(FIELD_SECTIONS).sort(), Object.keys(LEDGER_SCHEMAS).sort(), 'every mode has a fields section');
  for (const [mode, schema] of Object.entries(LEDGER_SCHEMAS)) assertFieldParity(schema, FIELD_SECTIONS[mode]);
  const { text } = documentedFields();
  for (const name of ['DECIDE_LEDGER_SCHEMA', 'CASE_SCHEMA', 'CROSS_SCHEMA', 'DECIDE_REBUTTAL_SCHEMA']) assert.ok(text.includes(`\`${name}\``), `ledger.md names ${name}`);
});

// Every file of the quorum skill: SKILL.md, each references/ file, and each modes/ file, by its path in the skill.
function skillTexts() {
  const files = ['SKILL.md', ...['references', 'modes'].flatMap((dir) => readdirSync(path.join(SKILL, dir)).map((file) => `${dir}/${file}`))];
  return Object.fromEntries(files.map((file) => [file, readFileSync(path.join(SKILL, file), 'utf8')]));
}

test('the quorum skill names exactly the flags `aidrian quorum` takes, real --mode values, and every codex status with its exit code', async () => {
  const flags = (text) => new Set([...text.matchAll(/(?<![\w-])--[a-z][a-z-]*/gu)].map((match) => match[0]));
  const texts = skillTexts();
  const all = Object.values(texts).join('\n');
  const usage = flags(commands.quorum.usage);
  // A line that runs `aidrian quorum` names exactly the flags it takes.
  const onCommand = flags(all.split('\n').filter((line) => line.includes('aidrian quorum')).join('\n'));
  assert.deepEqual([...onCommand].sort(), [...usage].sort());
  // Any other flag is one of the command's, or one the calling plan-review skill lists in its Inputs.
  const callerInputs = flags(readFileSync(PLAN_REVIEW, 'utf8').split('\n## Inputs\n')[1].split('\n## ')[0]);
  for (const flag of flags(all)) assert.ok(usage.has(flag) || callerInputs.has(flag), `the quorum skill names ${flag}, which neither aidrian quorum nor plan-review's Inputs takes`);
  // Each --mode value the skill names is one the command takes: an unknown mode fails before Codex is looked for.
  const modes = new Set([...Object.values(texts).join('\n').matchAll(/--mode ([a-z]+)/gu)].map((match) => match[1]));
  assert.ok(modes.size, 'the skill names a --mode');
  for (const mode of modes) {
    const result = await codexAnswer({ plan: 'p', brief: 'b', out: 'o', root: '.', mode, ledger: 'l' }, { codex: () => ({ ok: false, reason: 'stub' }) });
    assert.equal(result.status, 'unavailable', `--mode ${mode}: ${result.reason}`);
  }
  const skill = texts['SKILL.md'];
  for (const [status, code] of Object.entries(CODEX_EXITS)) {
    assert.ok(skill.includes(`\`${status}\``), `SKILL.md names the status ${status}`);
    const exits = new RegExp(`\\b${code} on (?:\`\\w+\`(?:, | or |, or ))*\`${status}\``, 'u');
    assert.match(skill.replace(/\s+/gu, ' '), exits, `SKILL.md: ${status} exits ${code}`);
  }
});

test('the quorum skill says what check does to an objection with no passing citation: only a pending one becomes an opinion', () => {
  const skill = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8').replace(/\s+/gu, ' ');
  assert.match(skill, /A `pending` objection with no passing citation becomes `opinion`/u);
  assert.doesNotMatch(skill, /- An objection with no passing citation becomes `opinion`/u, 'no unconditional relabel rule');
  // A reused complete ledger reports every line check printed, so an accepted objection whose evidence or ruling no
  // longer passes is not handed on silently as authoritative.
  assert.match(skill, /is reused: skip the rounds, and report from it, with every line `check` printed in the Ledger item/u);
});

// The coordinator reads this run's roles, fallbacks, judge, and caps from `aidrian quorum roles`, never from config.json,
// and a Codex role's fallback is sticky: the trigger, the run it covers, and the same brief.
test('the quorum skill runs `aidrian quorum roles` before round 1, and keeps the fallback trigger rule in § Roles', () => {
  const raw = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const roles = raw.split('\n## Roles\n')[1].split('\n## ')[0].replace(/\s+/gu, ' ');
  assert.ok(roles.includes("Before round 1, run `aidrian quorum roles <mode>`; use the roles, fallbacks, judge, and caps it prints; the mode file's named values are the defaults."), 'the roles line');
  assert.ok(roles.includes('A Codex role runs through `aidrian quorum codex`. On the Codex host, or once a `codex` call exits non-zero, that run and every later run of the role go to the fallback agent `roles` names, with the same brief.'), 'the fallback trigger rule');
  assert.ok(raw.replace(/\s+/gu, ' ').includes('`roles` prints the dispatch cap. Every agent dispatch and Codex run counts, retries and fallbacks included.'), 'the cap comes from roles');
  assert.doesNotMatch(raw, /`architect`/u, 'SKILL.md names no judge agent: roles names it');
});

// Eight complete plan ledgers showed an architect that accepted 56 of A's 56 objections at first ruling, and 19
// concessions that cited nothing: the plan-mode briefs give the judge a reject path and hold it to its verdicts.
test('the plan mode file holds the judge\'s reject path, its verdicts, the moderation lines, and the proportionality pass', () => {
  const raw = skillTexts()['modes/plan.md'];
  const plan = raw.replace(/\s+/gu, ' ');
  assert.match(plan, /`Covers: #<anchor> "<quote>"` or `Covers: nothing`/u, 'the Covers line');
  assert.match(plan, /accept: [^.]*cite the `plan` section it changes, on the first ruling and on the final one/u, 'an accept cites the plan section on both rulings');
  assert.match(plan, /`tested`: one entry per citation/u, 'the tested line');
  assert.match(plan, /`inferences`: one entry per `inference:` line/u, 'the inferences line');
  for (const ground of GROUNDS) assert.match(plan, new RegExp(`\`${ground}\` \\(`, 'u'), `the ground ${ground}, with its meaning`);
  assert.match(plan, /`Cost: /u, 'the Cost line');
  assert.match(plan, /`Removes: /u, 'the Removes line');
  assert.match(plan, /prefer the smallest change that removes the cited risk/iu, 'the smallest-change rule');
  assert.match(plan, /moderation governs scope and proportion, never which side wins/iu, 'the neutrality sentence');
  assert.match(plan, /accepted 56 of A's 56 objections at first ruling/u, 'the eight-run line');
  assert.match(plan, /## Proportionality pass/u, 'the proportionality brief');
  assert.match(plan, /\*\*Proportionality pass\*\*/u, 'the proportionality round');
  assert.match(plan, /\*\*Merge\*\*/u, 'the merge round');
  assert.ok(plan.includes(`The cap is the \`maxDispatches\` that \`roles\` prints, ${DEFAULTS.quorum.plan.maxDispatches} by default: one is reserved for the proportionality pass, and no other dispatch may spend it.`), 'the cap');
  // The ruling brief carries this run's cap, and each brief this run's objection count, as placeholders the
  // coordinator fills from `roles`.
  assert.ok(plan.includes('fill `<max_objections>` with this run\'s `maxObjections` and `<cap>` with its `maxDispatches`, both from `roles`.'), 'the placeholders');
  assert.ok(plan.includes('The run is capped at <cap> dispatches, so a ruling may get no second chance.'), 'the ruling brief\'s cap');
  assert.doesNotMatch(plan, /capped at \d+ dispatches/u, 'no hard-coded cap in a brief');
  assert.equal(plan.match(/Return at most <max_objections> entries, one per objection id/gu)?.length, 2, 'both rebuttal briefs take the configured count');
  assert.doesNotMatch(plan, /Return at most \d+ (?:objections|entries)/u, 'no hard-coded objection count in a brief');
  assert.ok(plan.includes('- **Runners**: write `runners` with the ledger. `A` is `agent`; `B` is `codex` while every run of B went to Codex, and `agent` once one did not, since the fallback sticks. After the rounds it holds each adversary\'s final runner, and `same_model` matches it'), 'the runners line');
  assert.match(plan, /When the pass returns no usable answer, write `proportionality: \{flagged: \[\], failed: true\}`, with no retry, and the report says the pass failed/u, 'a failed pass');
  assert.match(plan, /appends its citations to the survivor's `citations`, so the architect's `tested` covers them/u, 'a merge moves its evidence to the survivor');
  assert.doesNotMatch(plan, /also cited by/u, 'no separate merged-citation line');
  assert.equal(DEFAULTS.quorum.plan.maxObjections, MAX_MODE_OBJECTIONS, 'the default is the ceiling');
  assert.ok(plan.includes(`at most \`maxObjections\` objections (default ${DEFAULTS.quorum.plan.maxObjections}), each \`blocking\` or \`important\``), 'each adversary returns at most maxObjections objections');
  assert.ok(plan.includes('the first `maxObjections` objections per adversary'), 'the coordinator keeps the configured count');
  // Codex's objections answer is held to OBJECTIONS_SCHEMA, MAX_OBJECTIONS entries, improvements included.
  for (const brief of ['A: it will break', 'B: the wrong thing, or too much']) {
    const text = raw.split(`\n## ${brief}\n`)[1].split('\n## ')[0].replace(/\s+/gu, ' ');
    assert.ok(text.includes('Return at most <max_objections> objections, each blocking or important'), `${brief}: the objection cap`);
    assert.ok(text.includes(`At most ${MAX_OBJECTIONS} entries in all.`), `${brief}: the entry cap`);
    // ledger.md § Agent answers reads low as improvement, so the brief says it too.
    assert.ok(text.includes('(critical and high are read as blocking, medium as important, low as improvement)'), `${brief}: the severity words`);
  }
  // A flagged change the Human has not answered is not reported as accepted, and one answer settles a flagged partial accept.
  assert.match(plan, /A flagged objection the Human has not answered is left out: it shows under Escalated and Proportionality\. For an answered one, the change is the one the answer chose\./u, 'the Accepted item and a flag');
  assert.match(plan, /When a flagged partial accept also has its rejected part escalated, one answer settles both parts\./u, 'one answer for both parts');
  assert.match(plan, /or `pass failed`, with what it returned when this run dispatched it/u, 'the report names a failed pass');
  assert.match(plan, /\*\*Rejected\*\*: each id with its `ground` and counter-evidence, or, when the Human rejected it, the Human's answer\./u, 'the Rejected item');
  // A flag says the change over-complicates the plan; with no smaller form, the flag's own reason argues for dropping it.
  assert.match(plan, /when `smaller_change` is empty, the recommended answer is none, dropping the change, with the flag's reason as the deciding reason/u, 'no smaller change: recommend none');
  assert.match(plan, /the strongest alternative plan that meets the same goal/u, 'B1 is the strongest alternative');
  assert.match(plan, /\*\*Merged\*\*/u, 'the report lists merges');
  assert.match(plan, /\*\*Proportionality\*\*/u, 'the report has the Proportionality item');
  assert.match(plan, /\*\*Notes\*\*/u, 'the report has the notes footnote');
  const rebuttal = /verdict "concede": the ruling stands; cite the ruling's evidence you accept\./gu;
  assert.equal(plan.match(rebuttal)?.length, 2, 'both rebuttal briefs say a concession cites what it accepts');
});

// Decide mode: advocates argue one position each, the architect rules on which wins, and the losers rebut once.
test('the decide mode file holds the runners, the swap, the cap, every Codex mode it runs, its briefs, and its report', () => {
  const texts = skillTexts();
  const raw = texts['modes/decide.md'];
  assert.ok(raw, 'the skill has modes/decide.md');
  const decide = raw.replace(/\s+/gu, ' ');
  for (const mode of ['case', 'cross', 'rebut']) assert.match(decide, new RegExp(`aidrian quorum codex --mode ${mode}\\b`, 'u'), `decide runs --mode ${mode}`);
  // One fallback per position that starts on Codex: B, and D with four positions, or A after the claim swap.
  assert.match(decide, /The cap is `3N \+ 2 \+ C` dispatches for N positions, where C counts the positions whose `runner` starts as `codex`\./u, 'the cap formula');
  assert.ok(decide.includes('With the default runners that is 9 for two, 12 for three, and 16 for four.'), 'the cap numbers');
  assert.match(decide, /starts with an odd hex digit[^.]*, the runners swap/u, 'the claim swap');
  assert.ok(decide.includes('- **The swap**: only when `swap` is `true`.'), 'the swap follows the config');
  assert.ok(decide.includes("`aidrian quorum roles decide` prints this run's roles, fallbacks, judge, swap, and caps: `odd` holds `A` and `C`, and `even` holds `B` and `D`. The values below are the defaults."), 'the roles line');
  assert.ok(decide.includes("This run's cap is the `caps` entry `roles` prints for its position count."), 'this run\'s cap');
  assert.ok(decide.includes("`<cap>` with this run's cap, from `roles`."), 'the cap placeholder');
  assert.match(decide, /`same_model` is `true` exactly when two positions share a runner/u, 'same_model in decide mode');
  // The briefs: argue one side, cite or label, beat the losing citation, test everything, concede with evidence.
  assert.match(decide, /Argue your position only/u, 'the case brief');
  assert.match(decide, /Never concede, and never weigh the other side/u, 'no conceding before the rebuttal');
  assert.match(decide, /name the losing case's strongest cited claim and the citation that defeats it/u, 'the judge beats the losing citation');
  assert.match(decide, /it never decides which position wins/u, 'moderation never decides the winner');
  assert.match(decide, /name what would settle it/u, 'an escalation names what would settle it');
  assert.match(decide, /verdict "concede": the ruling stands; cite the ruling's evidence you accept\./u, 'a concession cites the ruling');
  // A first ruling invalid twice, and a rebuttal round that ends short, escalate in a ruling the coordinator writes.
  assert.match(decide, /`\{decision: escalate, winner: null,/u, 'the coordinator-written final ruling');
  assert.ok(decide.includes('Then the coordinator writes `final_ruling` itself, a coordinator-written ruling:'), 'round 5 is one coordinator-written ruling of two');
  assert.doesNotMatch(decide, /the one ruling it ever writes/u);
  assert.ok(decide.includes("Name a ruling the coordinator wrote, after two invalid rulings or when rounds 5 and 6 end short, as coordinator-written."), 'the report names it');
  // A deferred escalation in a reused ledger is asked again, so a rerun of the same question can settle it.
  assert.ok(decide.includes("When the core reuses a complete ledger whose last ruling (`final_ruling`, else `ruling`) is `escalate` and whose `human_answer` is `null`, ask the one question before reporting, write the answer (`null` again when deferred), and run `quorum check`."), 'a reused deferral is asked again');
  assert.ok(decide.includes("The governing winner is the final ruling's winner when the final ruling is `rule`; otherwise it is the first ruling's."), 'the governing winner');
  // Each way rounds 5 and 6 end short, and the two blocked stops, as whole sentences.
  for (const sentence of [
    'Rounds 5 and 6 end short when:',
    '- `quorum check` names a rebuttal or a concession invalid. Neither gets a retry.',
    '- `quorum check` names the final ruling invalid, after its retry or with no dispatch left for one.',
    '- The final ruling is missing, after its retry or with no dispatch left for one.',
    '- A losing position never answered, because Codex and its fallback both failed, or the cap ran out.',
    '- A position rebutted, and the cap leaves no dispatch for the final ruling.',
    "A position still without a case (after its fallback, on Codex) stops the run with `blocked` before round 3, naming the position and the Codex status line, or the agent's failure.",
    'An advocate with no cross answer (after its fallback, on Codex) raises no points; the report names it.',
    'A ruling `quorum check` names invalid, or a missing one, goes back once, with the line it printed, if any. Missing again, stop with `blocked`. Invalid again, replace `ruling` with',
    "`{decision: escalate, winner: null, change_or_reason: <the line `quorum check` printed, then the architect's last decision and winner>, citations: <its citations>, tested: [], inferences: []}`, run `quorum check`, skip rounds 5 and 6, and ask the Human, with the architect's last ruling as the recommended answer.",
    "When any ruling escalates, first or final, the Human's answer decides the question, and the governing winner is only the evidence's side of it.",
    "When any ruling escalates, `escalated` with the Human's answer, or `deferred` with the recommended answer.",
    "Question text becomes a file by one rule: the Human's text goes word for word into `## Context`. A yes/no question becomes a `## Claim`. Named alternatives become the options, `### A:` to `### D:`. With none named and no yes/no question, ask the Human for the options or the claim before writing the file.",
    "the judge (its agent, `architect` by default, on the host's model)",
    'Such a position cannot win, on the first ruling or the final one: rule for another position, or escalate.',
    '`<settled>` is always `none` in decide mode',
  ]) assert.ok(decide.includes(sentence), `decide.md: ${sentence}`);
  assert.doesNotMatch(decide, /no dispatch left for the retry, stop/u, 'a first ruling with no retry left is not a separate stop');
  // The question-file name, as decide.md spells it out. No code computes it: the coordinator follows these steps. The
  // first four are the slug flows.mjs computes; the 60-character cut and the `question` fallback are decide.md's own.
  assert.ok(decide.includes("`<slug>` comes from the question's first line, without its `# `, in these steps: lowercase it; drop backticks, `*`, and `_`; turn each run of other characters outside a-z and 0-9 into one `-`; leave no `-` at either end; cut it to 60 characters, with no `-` left at the end; use `question` when nothing is left."), 'the slug steps');
  const words = (line) => line.toLowerCase().replace(/[`*_]/gu, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  const steps = (line) => words(line).slice(0, 60).replace(/-+$/u, '') || 'question';
  for (const line of ['Keep one ledger or split it?', '**Bold** _x_ `code`', '--x--', 'A_B*C']) assert.equal(steps(line), slug(line), line);
  // A cut that lands just after a word leaves its `-` behind, and the steps drop it: 59 characters, then `-`.
  const long = `${'a'.repeat(59)} ${'b'.repeat(10)}?`;
  assert.equal(words(long).length, 70);
  assert.equal(steps(long), 'a'.repeat(59));
  assert.equal(steps(`${'word '.repeat(20)}`), 'word-'.repeat(12).slice(0, 59));
  // Nothing left: no letter or digit a-z or 0-9, so the name falls back.
  for (const line of ['日本語', '???', '`*_`', '']) assert.equal(steps(line), 'question', JSON.stringify(line));
  assert.match(decide, /flip/u, 'the flip');
  assert.match(decide, /\*\*Dropped citations\*\*/u, 'the Dropped citations footnote');
  // A skill ends at its own output: the caller, not the report, names who continues.
  assert.ok(decide.includes('Next: the caller acts on the ruling.'), 'the Next line');
  for (const name of readdirSync(path.resolve(import.meta.dirname, '../plugins/aidrian/skills'))) {
    assert.ok(!decide.includes(`\`${name}\` skill`), `decide.md names no skill that continues: ${name}`);
  }
  // The core names the mode file, the question-file name, and that an edited question starts fresh.
  const skill = texts['SKILL.md'].replace(/\s+/gu, ' ');
  assert.match(skill, /\[modes\/decide\.md\]\(modes\/decide\.md\)/u, 'SKILL.md names modes/decide.md');
  assert.ok(skill.includes('<slug>-<h7>.md'), 'SKILL.md names the question-file name');
  assert.match(skill, /An edited question file is a new question, and inherits no earlier answer\./u, 'an edited question inherits nothing');
  assert.match(skill, /`<state>\/quorum\/questions\/`/u, 'SKILL.md names the questions folder');
});

// The lines `quorum check` prints for a decide ledger, as the docs quote them: each is in lib/quorum.mjs word for word.
test('docs/project-folder.md quotes the decide check lines exactly as lib/quorum.mjs prints them', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '../plugins/aidrian/lib/quorum.mjs'), 'utf8');
  const doc = readFileSync(path.resolve(import.meta.dirname, '../docs/project-folder.md'), 'utf8').replace(/\s+/gu, ' ');
  const lines = [
    'relabeled opinion (was pending): no citation passes',
    'no citation passes; kept backed',
    'the ruling has no passing citation',
    "a rule rests on no supporting citation of the winner's case",
    "a flip rests on no supporting citation of the winner's rebuttal",
    'the rebuttal has no passing citation',
    'the rebuttal cites nothing new',
    'the concession has no passing citation',
    "the governing winner's case has no passing citation",
    'has no case in a complete ledger',
    'lost the ruling and has no rebuttal in a complete ledger',
    'rebuts with no final ruling in a complete ledger',
    'rebuttals and a final ruling follow a first ruling of rule only',
    'final ruling rules, but no position rebutted',
    'ruling is null in a complete ledger',
    // Printed from a template on the case's position.
    { doc: 'case X: no citation passes', source: ['`case ${each.position}: no citation passes`'] },
    'human_answer: set but nothing escalated',
    '--mode cross answers a decide ledger, and this ledger is in plan mode',
    "the winner's case has no passing citation",
    'is by X, not a position in this ledger',
    'tested names X, which the ruling does not rule on',
    // Printed from a template whose last part the ledger's mode picks.
    { doc: 'same_model is true, so same_model_reason must say why two positions share a runner', source: ['same_model is true, so same_model_reason must say ', "'why two positions share a runner'"] },
    'same_model is false, so same_model_reason must be null',
  ];
  for (const entry of lines) {
    // X stands for an id the line prints; each literal part is in the source.
    const line = entry.doc ?? entry;
    for (const part of entry.source ?? line.split('X').filter(Boolean)) assert.ok(source.includes(part), `lib/quorum.mjs prints "${line}"`);
    assert.ok(doc.includes(`\`${line}\``), `docs/project-folder.md quotes "${line}"`);
  }
  assert.ok(doc.includes('`checked: mode decide, N cases, N cross points, N opinion, N problems`'), 'the decide summary line');
  // decide.md quotes the case line the architect gets: it is the line the source prints, with X for the position.
  const decide = skillTexts()['modes/decide.md'].replace(/\s+/gu, ' ');
  const quoted = [...decide.matchAll(/`(case X[^`]*)`/gu)].map(([, line]) => line);
  assert.ok(quoted.length >= 3, 'decide.md quotes the case line in its rounds and its ruling brief');
  for (const line of quoted) assert.ok(source.includes(`\`${line.replace('X', '${each.position}')}\``), `decide.md quotes "${line}" as lib/quorum.mjs prints it`);
  // Each usage form, as the command prints it: the doc lists every --mode value the command takes.
  for (const form of commands.quorum.usage.split(' | ')) assert.ok(doc.includes(`\`aidrian quorum ${form}\``), `docs/project-folder.md: aidrian quorum ${form}`);
});

// A proportionality flag escalates a partial accept's accepted part too, so every sentence that says the accepted part
// stands, or that a partial accept stays accepted, scopes itself to an unflagged one.
test('the quorum skill scopes the partial-accept rule to unflagged objections in every file', () => {
  const texts = skillTexts();
  const ledgerText = texts['references/ledger.md'].replace(/\s+/gu, ' ');
  assert.match(ledgerText, /Unless the proportionality pass flags it, its accepted part always stands, and `escalated` on it means its rejected part is escalated; a flag escalates its accepted part too\./u, 'ledger.md § Fields: the flag exception');
  assert.match(ledgerText, /On a flagged objection, the answer settles both parts, and none makes it `rejected`\./u, 'ledger.md § Filling it: one answer for a flagged objection');
  const unscoped = [];
  for (const [file, text] of Object.entries(texts)) {
    for (const [sentence] of text.replace(/\s+/gu, ' ').matchAll(/[^.]*(?:accepted part (?:always )?stands|partial accept stays `accepted`)[^.]*\./gu)) {
      if (!/unflagged|Unless the proportionality pass flags it/u.test(sentence)) unscoped.push(`${file}: ${sentence.trim()}`);
    }
  }
  assert.deepEqual(unscoped, []);
});

test('the quorum core names the six grounds in its Moderator paragraph, and the Evidence block asks for inference lines and doc or adr citations', () => {
  const texts = skillTexts();
  const skill = texts['SKILL.md'];
  const moderator = skill.split('\n## Moderator\n')[1]?.split('\n## ')[0];
  assert.ok(moderator, 'SKILL.md has § Moderator');
  for (const ground of GROUNDS) assert.ok(moderator.includes(`\`${ground}\``), `the Moderator paragraph names ${ground}`);
  assert.match(moderator.replace(/\s+/gu, ' '), /never which side wins/u);
  assert.match(skill, /Read `modes\/<mode>\.md` once the mode is selected, and only that one\./u);
  const evidence = texts['references/briefs.md'].split('\n### Evidence block\n')[1].split('\n### ')[0];
  assert.ok(evidence.includes('inference: <statement>'), 'the Evidence block names the inference line');
  assert.match(evidence.replace(/\s+/gu, ' '), /prefer a `doc` or `adr` citation/u, 'the Evidence block prefers doc and adr');
  assert.match(evidence.replace(/\s+/gu, ' '), /A concession cites the evidence of the ruling it accepts/u);
  for (const [file, text] of Object.entries(texts)) {
    assert.doesNotMatch(text.replace(/\s+/gu, ' '), /concession needs no citation|may be empty for a concession/iu, `${file} says a concession needs no citation`);
  }
  // The Evidence block serves both modes: a decide `plan` citation anchors on the question file, and a point is an entry.
  const block = evidence.replace(/\s+/gu, ' ');
  assert.ok(block.includes('every entry (objection or point, case, ruling, and rebuttal) carries at least one citation'), 'the Evidence block names every entry');
  assert.ok(block.includes('- plan: ref is #anchor of a heading of the plan, or of the question file in decide mode;'), 'the plan kind in decide mode');
  assert.ok(block.includes('an objection or point with no passing citation is dropped as opinion'), 'a point becomes an opinion too');
  assert.doesNotMatch(block, /the plan under review/u);
  // What only plan mode does is scoped to it in the core, and decide mode's moderation points to its own line.
  const core = skill.replace(/\s+/gu, ' ');
  for (const sentence of [
    'Every objection, case, cross point, ruling, and rebuttal cites',
    'A second invalid ruling follows ledger.md § Filling it in plan mode, and the mode file\'s rounds in decide mode.',
    'In plan mode, a rejection names its ground:',
    "Decide mode moderates by the Moderation line of decide.md's ruling brief.",
    'In plan mode, every other `complete` plan ledger whose `plan` is this input\'s absolute path',
    'in plan mode, the plan cannot be `status: ready` while it is open.',
    "3. **Open questions**: each deferred escalation; in plan mode, for the plan's `Open questions`.",
  ]) assert.ok(core.includes(sentence), `SKILL.md: ${sentence}`);
  assert.match(texts['modes/decide.md'], /^Moderation: a cross point or rebuttal/mu, 'decide.md has the Moderation line SKILL.md names');
});

test('plan-review runs the quorum skill at step 3b, lists its flags in Inputs, and ledger.md says how it runs there', () => {
  // A plan-review that forgets the step, or a ledger.md that drops its section, leaves the quorum's plan use undescribed.
  const review = readFileSync(PLAN_REVIEW, 'utf8');
  const inputs = review.split('\n## Inputs\n')[1].split('\n## ')[0];
  for (const flag of ['--quorum', '--no-quorum']) assert.match(inputs, new RegExp(`\`${flag}\``, 'u'), `plan-review's Inputs lists ${flag}`);
  const step = review.split('\n## 3b. Quorum\n')[1]?.split('\n## ')[0];
  assert.ok(step, 'plan-review has a step 3b');
  assert.ok(review.indexOf('\n## 3. Gates\n') < review.indexOf('\n## 3b. Quorum\n') && review.indexOf('\n## 3b. Quorum\n') < review.indexOf('\n## 4. Critique\n'), 'step 3b sits between the gates and the critique');
  assert.match(step, /the `quorum` skill/u, 'step 3b names the quorum skill');
  // A session that paraphrased the quorum ran it from memory and wrote no ledger: 3b loads the skill and follows it, and
  // points to the section that defines its triggers and its blocked stop.
  assert.match(step.replace(/\s+/gu, ' '), /load the `quorum` skill and follow it/u, 'step 3b loads the quorum skill');
  assert.match(step.replace(/\s+/gu, ' '), /`references\/ledger\.md` § Under plan-review/u, 'step 3b points to ledger.md § Under plan-review');
  assert.match(step, /`blocked on quorum`/u, 'step 3b names the blocked stop');
  // Settled answers hold across runs only when the applied plan's revision history records them: the quorum's Report
  // hands its revision-history line to the critique brief, and planning-agent's entry carries it word for word.
  const flat = (text) => text.replace(/\s+/gu, ' ');
  assert.match(flat(step), /revision-history line go into step 4's brief/u, 'step 3b passes the Report`s revision-history line to the critique');
  assert.match(flat(readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8')), /\*\*Revision-history line\*\*: the objection ids to apply and each Human answer/u, 'the quorum Report has the line');
  const lens = readFileSync(path.join(path.dirname(PLAN_REVIEW), 'references/review-lens.md'), 'utf8');
  const entry = flat(lens.split('- `revision_history_entry`:')[1].split('\n- `')[0]);
  assert.match(entry, /the quorum Report's revision-history line, the entry includes it: its objection ids, and each Human answer word for word/u, 'planning-agent`s revision_history_entry carries the quorum line');
  const ledger = readFileSync(path.join(SKILL, 'references/ledger.md'), 'utf8');
  assert.match(ledger, /\n## Under plan-review\n/u, 'ledger.md has § Under plan-review');
  assert.match(ledger, /\[Under plan-review\]\(#under-plan-review\)/u, 'ledger.md links its plan-review section');
});

test('plan-review gate briefs carry the plan, the trigger, and the knowledge, and none of the coordinator`s own findings', () => {
  // A coordinator that wrote its suspected findings into each gate's brief anchored the gates on them, so they did not
  // review the plan on their own (the 2026-11-02 quorum eval traces). Step 3 says what a gate brief holds and must not.
  const flat = (text) => text.replace(/\s+/gu, ' ');
  const review = readFileSync(PLAN_REVIEW, 'utf8');
  const gates = flat(review.split('\n## 3. Gates\n')[1].split('\n## ')[0]);
  assert.match(gates, /their verdicts go into its brief as authoritative/u, 'gate verdicts still bind the critique');
  assert.match(gates, /A gate's brief carries the plan path, the trigger \(the plan lines and the flow or surface they touch\), and the knowledge docs to check against\./u, 'step 3 says what a gate brief carries');
  assert.match(gates, /It carries nothing of your own: no suspected findings, risks, or hints\./u, 'step 3 keeps the coordinator`s findings out of gate briefs');
  const never = flat(review.split('\n## Do not\n')[1]);
  assert.match(never, /Critique, rewrite, or restyle the plan yourself, in a report or in any brief/u, 'Do not covers every brief');
  // Step 5's items moved to steps/apply.md to keep SKILL.md under its size limit: the re-hash before an apply stays.
  const apply = flat(review.split('\n## 5. Apply\n')[1].split('\n## ')[0]);
  assert.match(apply, /read \[steps\/apply\.md\]\(steps\/apply\.md\) and follow its steps 5\.1 to 5\.4/u, 'step 5 points to its items');
  const items = flat(readFileSync(path.join(path.dirname(PLAN_REVIEW), 'steps/apply.md'), 'utf8'));
  assert.match(items, /1\. Hash the plan again\. When it changed since step 2, say so and start again at step 2/u, 'apply re-hashes first');
  assert.match(items, /4\. Read the plan again/u, 'apply keeps step 5.4');
  // The quorum's briefs are its mode files' text, filled, with nothing the coordinator suspects added.
  const briefs = flat(readFileSync(path.join(SKILL, 'references/briefs.md'), 'utf8'));
  assert.match(briefs, /A brief is its mode file's text with these filled, and nothing more: none of your own suspected objections, findings, or hints/u, 'quorum briefs carry no coordinator findings');
});

// Plan mode: a ledger that carries `mode` is held to the plan-mode briefs' rules; one without it keeps the rules it was
// written under, and `check` never adds the field.

test('LEDGER_SCHEMAS holds the plan schema, modeOf reads a ledger with no mode as plan, and check refuses a mode with no schema', (t) => {
  assert.equal(LEDGER_SCHEMAS.plan, LEDGER_SCHEMA);
  assert.equal(modeOf(ledger([])), 'plan');
  assert.equal(modeOf(planLedger([])), 'plan');
  assert.deepEqual(GROUNDS, ['covered', 'implementation', 'settled', 'off-goal', 'disproportionate', 'speculative']);
  const p = project(t);
  const odd = { ...ledger([objection('A1', [PASSING.code])]), mode: 'debate' };
  const result = p.check(odd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /: \$\.mode must be one of plan$/mu);
  assert.deepEqual(result.ledger, odd, 'not written back');
});

test('check: a ledger with no mode keeps the old rules: 7 objections, an improvement, a plan-less accept, an uncited concession, no verdicts, and is written back without mode; open, it exits 1', (t) => {
  const p = project(t);
  const old = (decision, citations) => ({ decision, change_or_reason: 'r', citations });
  const before = legacy([
    objection('A1', [PASSING.code], { claim: 'It breaks.\ninference: the slot is shared', status: 'accepted', ruling: old('accept', [PASSING.code]) }),
    objection('A2', [PASSING.code], { status: 'rejected', ruling: old('reject', [PASSING.adr]), rebuttal: concede([]) }),
    ...[3, 4, 5, 6, 7].map((n) => objection(`A${n}`, [PASSING.code], { severity: n === 7 ? 'improvement' : 'important', status: 'accepted', ruling: old('accept', [PASSING.adr]) })),
  ]);
  // The same ledger open is mid-run, which a ledger with no mode never is: exit 1, unwritten.
  const open = { ...before, status: 'open' };
  const refused = p.check(open);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /: mode: missing in an open plan ledger$/mu);
  assert.deepEqual(refused.ledger, open, 'not written back');
  const result = p.check(before);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: mode plan, 7 objections, 0 opinion, 0 problems']);
  assert.equal(Object.hasOwn(result.ledger, 'mode'), false, 'check adds no mode');
  assert.deepEqual(result.ledger, before);
});

test('check with mode: more than 5 objections by one adversary, or an improvement, exits 1 and is not written; 5 each pass', (t) => {
  const p = project(t);
  for (const [before, message] of [
    [planLedger(Array.from({ length: 6 }, (_, i) => objection(`A${i + 1}`, [PASSING.code]))), /: A raised 6 objections, more than the 5 quorum\.plan\.maxObjections allows in a ledger with a mode$/mu],
    [planLedger([objection('B1', [PASSING.code], { by: 'B', severity: 'improvement' })]), /: objection B1 is an improvement, which goes to notes in a ledger with a mode$/mu],
  ]) {
    const result = p.check(before);
    assert.equal(result.status, 1, message.source);
    assert.match(result.stderr, message);
    assert.deepEqual(result.ledger, before, 'not written back');
  }
  const five = planLedger([1, 2, 3, 4, 5].flatMap((n) => [objection(`A${n}`, [PASSING.code]), objection(`B${n}`, [PASSING.code], { by: 'B', severity: 'blocking' })]));
  const result = p.check(five);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: mode plan, 10 objections, 0 opinion, 0 problems']);
  assert.equal(result.ledger.mode, 'plan');
});

test('check with mode: an accept, first or final, with no passing plan citation is invalid, and stale in a complete ledger', (t) => {
  const p = project(t);
  const failingPlan = cite('plan', '#risks', 'Store the ledger');
  const first = (ruling) => objection('A1', [PASSING.code], { status: 'accepted', ruling });
  const final = (ruling) => objection('A1', [PASSING.code], { status: 'accepted', ruling: rejects(), rebuttal: { verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling } });
  for (const [build, where] of [[first, 'objection A1 ruling'], [final, 'objection A1 rebuttal ruling']]) {
    const line = `${where}: invalid: an accept cites no plan section`;
    for (const citations of [[PASSING.adr], [PASSING.adr, failingPlan]]) {
      const open = p.check(planLedger([build(accepts({ citations }))]));
      assert.equal(open.status, 0, open.stderr);
      assert.ok(open.lines.includes(line), `${line}\n${open.stdout}`);
      const complete = planLedger([build(accepts({ citations }))], { status: 'complete', proportionality: { flagged: [] } });
      const refused = p.check(complete);
      assert.equal(refused.status, 1, refused.stdout);
      assert.ok(refused.stderr.includes(`${line} in a complete ledger`), refused.stderr);
      assert.deepEqual(refused.ledger, complete, 'not written back');
    }
    const good = p.check(planLedger([build(accepts())], { status: 'complete', proportionality: { flagged: [] } }));
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(good.lines, ['checked: mode plan, 1 objections, 0 opinion, 0 problems']);
  }
});

test('check: a merged objection with no ruling, folded into the other adversary`s live objection that holds its citations, passes and is skipped by completeness; any other shape exits 1', (t) => {
  const p = project(t);
  const merged = (extra = {}) => objection('B1', [PASSING.adr], { by: 'B', status: 'merged', merged_into: 'A1', ...extra });
  // The survivor holds the merged citation as the coordinator appended it: kind, ref, and quote, spacing aside.
  const held = [PASSING.code, { ...PASSING.adr, quote: 'one  ledger\nper plan' }];
  const result = p.check(planLedger([objection('A1', held), merged()]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: mode plan, 2 objections, 0 opinion, 0 problems']);
  assert.deepEqual(result.ledger.objections.map((each) => each.status), ['pending', 'merged']);
  const complete = p.check(planLedger([objection('A1', held, { status: 'accepted', ruling: accepts({ tested: verdicts(2) }) }), merged()], { status: 'complete', proportionality: { flagged: [] } }));
  assert.equal(complete.status, 0, complete.stderr);
  const unnamed = merged();
  delete unnamed.merged_into;
  for (const [objections, message] of [
    [[objection('A1', held), merged({ ruling: rejects() })], /: objection B1 is merged but has a ruling$/mu],
    [[objection('A1', held), merged({ rebuttal: concede([PASSING.adr]) })], /: objection B1 is merged but has a rebuttal$/mu],
    [[objection('A1', held), merged({ merged_into: null })], /: objection B1 is merged into no objection$/mu],
    [[objection('A1', held), unnamed], /: objection B1 is merged into no objection$/mu],
    [[objection('A1', held), merged({ merged_into: 'A9' })], /: objection B1 is merged into A9, not an objection in this ledger$/mu],
    [[objection('B2', held, { by: 'B' }), merged({ merged_into: 'B2' })], /: objection B1 is merged into B2, an objection of the same adversary$/mu],
    [[objection('A1', held, { status: 'merged', merged_into: 'B2' }), merged(), objection('B2', [PASSING.code, PASSING.adr], { by: 'B' })], /: objection B1 is merged into A1, which is merged$/mu],
    [[objection('A1', [cite('code', 'src/app.js:1', 'nope'), PASSING.adr], { status: 'opinion' }), merged()], /: objection B1 is merged into A1, which is opinion$/mu],
    [[objection('A1', [PASSING.code], { merged_into: 'B1' }), objection('B1', [PASSING.code], { by: 'B' })], /: objection A1 names merged_into B1 but is pending, not merged$/mu],
    // The merge left B1's citation out of A1: the architect's `tested` would never cover it.
    [[objection('A1', [PASSING.code]), merged()], /: objection B1 is merged into A1, which lacks its citation 0$/mu],
    [[objection('A1', [PASSING.code, { ...PASSING.adr, ref: 'docs/decisions/0001-store.md#Decision' }]), merged()], /: objection B1 is merged into A1, which lacks its citation 0$/mu],
  ]) {
    for (const before of [planLedger(objections), legacy(objections)]) {
      const result = p.check(before);
      assert.equal(result.status, 1, message.source);
      assert.match(result.stderr, message);
      assert.deepEqual(result.ledger, before, 'not written back');
    }
  }
});

test('check: a note with no passing citation is removed and named; one with a passing citation is kept', (t) => {
  const p = project(t);
  const notes = [{ by: 'A', claim: 'add a log line', citations: [PASSING.code] }, { by: 'B', claim: 'no better alternative', citations: [cite('plan', '#risks', 'nope')] }];
  const result = p.check(planLedger([objection('A1', [PASSING.code])], { notes }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ledger.notes, [notes[0]]);
  assert.deepEqual(result.lines, [
    'notes[1].citations[0] (plan #risks): the plan#risks does not contain the quote',
    'notes[1] (by B): removed: no citation passes',
    'checked: mode plan, 1 objections, 0 opinion, 2 problems',
  ]);
});

test('check with mode: tested names each citation of the ruled entry once, an accept rests on a supporting one, and every inference line is tested', (t) => {
  const p = project(t);
  const claim = 'It breaks.\ninference: the slot is shared\n  Inference:   two writers race on it, and nothing in the plan or the code orders their writes';
  const tested = [{ statement: 'the slot is shared', holds: true, reason: 'r', citations: [PASSING.code] }, { statement: 'two  writers race on it', holds: false, reason: 'r', citations: [] }];
  const first = (over) => objection('A1', [PASSING.code, PASSING.adr], { claim, status: 'accepted', ruling: accepts({ tested: verdicts(2), inferences: tested, ...over }) });
  const final = (over) => objection('A1', [PASSING.code], { status: 'accepted', ruling: rejects(), rebuttal: { verdict: 'rebut', claim, citations: [PASSING.fenced, PASSING.docBySlug], ruling: accepts({ tested: verdicts(2), inferences: tested, ...over }) } });
  for (const [build, where] of [[first, 'objection A1 ruling'], [final, 'objection A1 rebuttal ruling']]) {
    for (const [over, lines] of [
      [{ tested: verdicts(1) }, ['tested names 1 of 2 citations']],
      [{ tested: [] }, ['tested names 0 of 2 citations', 'an accept rests on no supporting citation']],
      [{ tested: undefined }, ['tested names 0 of 2 citations', 'an accept rests on no supporting citation']],
      [{ tested: [...verdicts(2), { citation: 1, supports: false, reason: 'r' }] }, ['tested names 1 of 2 citations; 1 more than once']],
      [{ tested: [...verdicts(2), { citation: 2, supports: true, reason: 'r' }, { citation: -1, supports: true, reason: 'r' }] }, ['tested names 2 of 2 citations; 2, -1 out of range']],
      [{ tested: verdicts(2, false) }, ['an accept rests on no supporting citation']],
      [{ inferences: tested.slice(0, 1) }, ['inference untested: "two writers race on it, and nothing in the plan or the code "']],
      [{ inferences: [{ ...tested[0], statement: '  ' }, tested[1]] }, ['inference untested: "the slot is shared"']],
      [{ inferences: undefined }, ['inference untested: "the slot is shared"', 'inference untested: "two writers race on it, and nothing in the plan or the code "']],
      // One entry settles one line: a statement two lines hold answers only the first.
      [{ inferences: [{ ...tested[0], statement: 'the slot' }] }, ['inference untested: "two writers race on it, and nothing in the plan or the code "']],
      [{ inferences: [{ ...tested[0], statement: 'race' }] }, ['inference untested: "the slot is shared"']],
    ]) {
      const result = p.check(planLedger([build(over)]));
      assert.equal(result.status, 0, result.stderr);
      const named = result.lines.filter((line) => line.startsWith(`${where}: `));
      assert.deepEqual(named, lines.map((line) => `${where}: invalid: ${line}`), JSON.stringify(over));
    }
    const good = p.check(planLedger([build({})]));
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(good.lines, ['checked: mode plan, 1 objections, 0 opinion, 0 problems']);
  }
});

// The judge's inference verdicts carry citations too, and each goes through the same check as every other: a failing
// one is named, and an inference that holds on none that passes leaves its ruling invalid, so a complete ledger that
// holds one is stale. One that does not hold may cite nothing.
test('check: every citation of an inference verdict is checked, plan and decide, first and final, and one that holds needs one that passes', (t) => {
  const p = project(t);
  const d = decideProject(t);
  const made = cite('code', 'missing.js:1', 'export const made = 1;');
  const verdict = (statement, holds, citations) => [{ statement, holds, reason: 'r', citations }];
  const claim = 'It breaks.\ninference: the slot is shared';
  const planCases = [
    ['objection A1 ruling', (inferences) => objection('A1', [PASSING.code], { claim, status: 'accepted', ruling: accepts({ inferences }) })],
    ['objection A1 rebuttal ruling', (inferences) => objection('A1', [PASSING.code], { status: 'accepted', ruling: rejects(), rebuttal: { verdict: 'rebut', claim, citations: [PASSING.fenced], ruling: accepts({ inferences }) } })],
  ];
  for (const [where, build] of planCases) {
    const named = `${where}.inferences[0].citations[0] (code missing.js:1): missing.js is missing`;
    const holdsOnNone = `${where}: invalid: inference "the slot is shared" holds on no passing citation`;
    for (const [inferences, lines] of [
      [verdict('the slot is shared', true, [made]), [named, holdsOnNone]],
      [verdict('the slot is shared', true, []), [holdsOnNone]],
      [verdict('the slot is shared', true, [made, PASSING.code]), [named]],
      [verdict('the slot is shared', false, [made]), [named]],
      [verdict('the slot is shared', false, []), []],
    ]) {
      const open = p.check(planLedger([build(inferences)]));
      assert.equal(open.status, 0, open.stderr);
      assert.deepEqual(open.lines.slice(0, -1), lines, JSON.stringify(inferences));
      const complete = planLedger([build(inferences)], { status: 'complete', proportionality: { flagged: [] } });
      const result = p.check(complete);
      if (lines.includes(holdsOnNone)) {
        assert.equal(result.status, 1, result.stdout);
        assert.ok(result.stderr.includes(`: ${holdsOnNone} in a complete ledger\n`), result.stderr);
        assert.deepEqual(result.ledger, complete, 'not written back');
      } else assert.equal(result.status, 0, result.stderr);
    }
  }
  const inferred = 'Split files read faster.\ninference: readers open one round at a time';
  const decideCases = [
    ['ruling', (inferences) => ({ cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [ASKED.b], inferred)], ruling: decision({ inferences }) })],
    ['final ruling', (inferences) => ({ rebuttals: [answer('B', 'rebut', [PASSING.fenced], inferred)], final_ruling: decision({ citations: [PASSING.fenced], tested: tested({ B: 1 }), inferences }) })],
  ];
  for (const [where, build] of decideCases) {
    const named = `${where}.inferences[0].citations[0] (code missing.js:1): missing.js is missing`;
    const holdsOnNone = `${where}: invalid: inference "readers open one round at a time" holds on no passing citation`;
    for (const [inferences, lines] of [
      [verdict('readers open one round at a time', true, [made]), [named, holdsOnNone]],
      [verdict('readers open one round at a time', true, [made, PASSING.code]), [named]],
      [verdict('readers open one round at a time', false, [made]), [named]],
      [verdict('readers open one round at a time', false, []), []],
    ]) {
      const open = d.check(decideLedger({ status: 'open', ...build(inferences) }));
      assert.equal(open.status, 0, open.stderr);
      assert.deepEqual(open.lines.slice(0, -1), lines, JSON.stringify(inferences));
      const complete = decideLedger(build(inferences));
      const result = d.check(complete);
      if (lines.includes(holdsOnNone)) {
        assert.equal(result.status, 1, result.stdout);
        assert.ok(result.stderr.includes(`: ${holdsOnNone} in a complete ledger\n`), result.stderr);
        assert.deepEqual(result.ledger, complete, 'not written back');
      } else assert.equal(result.status, 0, result.stderr);
    }
  }
});

test('check with mode: inference lines are matched to distinct entries on their own line, and a bare inference: takes no next line', (t) => {
  const p = project(t);
  const run = (claim, inferences) => {
    const result = p.check(planLedger([objection('A1', [PASSING.code], { claim, status: 'accepted', ruling: accepts({ inferences: inferences.map((statement) => ({ statement, holds: true, reason: 'r', citations: [PASSING.code] })) }) })]));
    assert.equal(result.status, 0, result.stderr);
    return result.lines.filter((line) => line.startsWith('objection A1 ruling: '));
  };
  // A bare label is no inference, and the line after it is a plain statement, not one for the judge to test.
  assert.deepEqual(run('It breaks.\ninference:\nThe plan stores the ledger.', []), []);
  assert.deepEqual(run('It breaks.\r\ninference:  \r\nThe plan stores the ledger.', []), []);
  // Two lines that one entry would fit both: the second goes untested.
  assert.deepEqual(run('inference: the slot is shared\ninference: the slot is shared by two writers', ['the slot is shared']), ['objection A1 ruling: invalid: inference untested: "the slot is shared by two writers"']);
  // Matching is not by order: the broad statement goes to the line only it fits.
  assert.deepEqual(run('inference: the slot is shared by two writers\ninference: the slot is shared', ['the slot is shared', 'shared by two']), []);
});

test('check: objections merged into one that becomes an opinion are unmerged and become opinions with it, and the next check passes', (t) => {
  const p = project(t);
  // The survivor holds every merged citation, so when none of its own passes, none of theirs does either.
  const gone = cite('code', 'src/app.js:1', 'nope');
  const missing = cite('doc', 'docs/nope.md#x', 'y');
  const first = p.check(planLedger([
    objection('A1', [gone, missing]),
    objection('B1', [gone], { by: 'B', status: 'merged', merged_into: 'A1' }),
    objection('B2', [missing], { by: 'B', status: 'merged', merged_into: 'A1' }),
  ]));
  assert.equal(first.status, 0, first.stderr);
  for (const line of ['objection A1: relabeled opinion (was pending): no citation passes', 'objection B1: unmerged: A1 became an opinion', 'objection B1: relabeled opinion (was pending): no citation passes', 'objection B2: unmerged: A1 became an opinion', 'objection B2: relabeled opinion (was pending): no citation passes']) {
    assert.ok(first.lines.includes(line), `${line}\n${first.stdout}`);
  }
  assert.deepEqual(first.ledger.objections.map(({ status, merged_into }) => [status, merged_into]), [['opinion', undefined], ['opinion', null], ['opinion', null]]);
  const second = p.check(first.ledger);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(!second.lines.some((line) => line.includes('unmerged')), second.stdout);
});

test('check with mode: a concession needs a passing citation, the ruling`s own included; without one it is invalid and escalates', (t) => {
  const p = project(t);
  const line = 'objection A1 rebuttal: invalid: the concession has no passing citation';
  const conceded = (citations, status = 'rejected') => objection('A1', [PASSING.code], { status, ruling: rejects(), rebuttal: concede(citations) });
  for (const citations of [[], [cite('code', 'src/app.js:1', 'nope')]]) {
    const open = p.check(planLedger([conceded(citations)]));
    assert.equal(open.status, 0, open.stderr);
    assert.ok(open.lines.includes(line), open.stdout);
    const refused = p.check(planLedger([conceded(citations)], { status: 'complete' }));
    assert.equal(refused.status, 1, refused.stdout);
    assert.ok(refused.stderr.includes(`${line} in a complete ledger`), refused.stderr);
    // The coordinator escalated it, so the Human holds it.
    const escalated = p.check(planLedger([conceded(citations, 'escalated')], { status: 'complete' }));
    assert.equal(escalated.status, 0, escalated.stderr);
    assert.ok(escalated.lines.includes(line), escalated.stdout);
  }
  // Nothing-new is for a rebuttal: a concession cites the evidence of the ruling it accepts.
  const good = p.check(planLedger([conceded([PASSING.plan])], { status: 'complete' }));
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(good.lines, ['checked: mode plan, 1 objections, 0 opinion, 0 problems']);
});

test('rebuttalProblems: a concession with no citation fits a ledger with no mode, and not one with a mode', () => {
  const entry = (citations) => ({ objection_id: 'B1', verdict: 'concede', claim: 'c', citations });
  const withMode = { ...RULED, mode: 'plan' };
  assert.deepEqual(rebuttalProblems({ rebuttals: [entry([])] }, RULED), []);
  assert.deepEqual(rebuttalProblems({ rebuttals: [entry([])] }, withMode), ['the answer concedes B1 with no citation, which a ledger with a mode needs']);
  assert.deepEqual(rebuttalProblems({ rebuttals: [entry([PASSING.adr])] }, withMode), []);
});

test('quorum codex --mode rebut on a ledger with a mode: a concession with no citation is failed and not written', async (t) => {
  const r = codexRun(t, fakeCodex({ answer: { rebuttals: [{ objection_id: 'B1', verdict: 'concede', claim: 'c', citations: [] }] } }));
  writeFileSync(r.ledgerFile, JSON.stringify({ ...RULED, mode: 'plan' }));
  assert.equal(await r.run({}, undefined, r.rebut), 1);
  assert.deepEqual(r.printed.map((line) => JSON.parse(line)), [{ status: 'failed', reason: 'the answer does not fit the ledger: the answer concedes B1 with no citation, which a ledger with a mode needs' }]);
  assert.throws(() => readFileSync(r.out), /ENOENT/u, 'nothing written');
});

test('check with mode: a reject names its ground, only a reject has one, every ruling opens with Covers, and an accept states its cost and removed risk', (t) => {
  const p = project(t);
  const first = (ruling, status = 'accepted') => objection('A1', [PASSING.code], { status, ruling });
  const final = (ruling, status = 'accepted') => objection('A1', [PASSING.code], { status, ruling: rejects(), rebuttal: { verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling } });
  for (const [build, where] of [[first, 'objection A1 ruling'], [final, 'objection A1 rebuttal ruling']]) {
    for (const [ruling, line] of [
      [rejects({ ground: undefined }), 'a reject names no ground'],
      [accepts({ ground: 'covered' }), 'ground on an accept'],
      [{ ...rejects({ decision: 'escalate' }) }, 'ground on an escalate'],
      [accepts({ change_or_reason: 'Nothing covers it.\nCost: one line.\nRemoves: the race.' }), 'no Covers line'],
      [accepts({ change_or_reason: 'Change it.\nCovers: nothing\nCost: one line.\nRemoves: the race.' }), 'no Covers line'],
      [accepts({ change_or_reason: 'Covers: nothing\nRemoves: the race.' }), 'an accept states no cost or removed risk'],
      [accepts({ change_or_reason: 'Covers: nothing\nCost: one line.' }), 'an accept states no cost or removed risk'],
      [accepts({ change_or_reason: 'Covers: nothing\nCost: \nRemoves: the race.' }), 'an accept states no cost or removed risk'],
    ]) {
      const result = p.check(planLedger([build(ruling)]));
      assert.equal(result.status, 0, result.stderr);
      const named = result.lines.filter((each) => each.startsWith(`${where}: `));
      assert.deepEqual(named, [`${where}: invalid: ${line}`], `${where}: ${line}`);
    }
  }
  // Stale in a complete ledger, as any invalid ruling.
  const stale = p.check(planLedger([first(rejects({ ground: undefined }), 'rejected')].map((each) => ({ ...each, rebuttal: concede([PASSING.plan]) })), { status: 'complete' }));
  assert.equal(stale.status, 1, stale.stdout);
  assert.ok(stale.stderr.includes('objection A1 ruling: invalid: a reject names no ground in a complete ledger'), stale.stderr);
  // Valid: a reject on the ground the change costs more than the risk it removes, conceded; an accept with all three lines.
  const good = p.check(planLedger([
    objection('A1', [PASSING.code], { status: 'rejected', ruling: rejects({ ground: 'disproportionate', change_or_reason: 'Covers: nothing\nThe change adds a service for a risk no citation shows.' }), rebuttal: concede([PASSING.plan]) }),
    objection('B1', [PASSING.code], { by: 'B', status: 'accepted', ruling: accepts() }),
  ], { status: 'complete', proportionality: { flagged: [] } }));
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(good.lines, ['checked: mode plan, 2 objections, 0 opinion, 0 problems']);
});

test('check with mode: proportionality is required in a complete ledger with an accept, and each flagged objection is an accept the Human holds', (t) => {
  const p = project(t);
  const accepted = (extra = {}) => objection('A1', [PASSING.code], { status: 'accepted', ruling: accepts(), ...extra });
  const finalAccept = objection('A2', [PASSING.code], { status: 'accepted', ruling: rejects(), rebuttal: { verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling: accepts() } });
  const conceded = objection('A3', [PASSING.code], { status: 'rejected', ruling: rejects(), rebuttal: concede([PASSING.plan]) });
  const flag = (objection_id) => ({ objection_id, reason: 'with A2 it adds two services', smaller_change: 'one service' });
  // `undefined` leaves the field out, as a ledger written before the pass.
  const done = (objections, proportionality, extra = {}) => JSON.parse(JSON.stringify(planLedger(objections, { status: 'complete', proportionality, ...extra })));
  for (const [before, message] of [
    [done([accepted()], null), /: proportionality: missing in a complete ledger with accepted changes$/mu],
    [done([accepted()], undefined), /: proportionality: missing in a complete ledger with accepted changes$/mu],
    [done([finalAccept, conceded], null), /: proportionality: missing in a complete ledger with accepted changes$/mu],
    [done([accepted(), conceded], { flagged: [flag('A3')] }), /: proportionality: flagged A3 is not an objection with an accept ruling$/mu],
    [done([accepted()], { flagged: [flag('A9')] }), /: proportionality: flagged A9 is not an objection with an accept ruling$/mu],
    [done([accepted()], { flagged: [flag('A1')] }), /: proportionality: flagged A1 is accepted, neither escalated nor answered in human_answers$/mu],
    [planLedger([accepted()], { proportionality: { flagged: [flag('A1')] } }), /: proportionality: flagged A1 is accepted, neither escalated nor answered in human_answers$/mu],
    // A failed pass flags nothing: one that names flags is no failure record, with or without `mode`.
    [done([accepted({ status: 'escalated' })], { flagged: [flag('A1')], failed: true }), /: proportionality: failed, yet flags 1 objections$/mu],
    [JSON.parse(JSON.stringify({ ...ledger([objection('A1', [PASSING.code])]), proportionality: { flagged: [flag('A1')], failed: true } })), /: proportionality: failed, yet flags 1 objections$/mu],
  ]) {
    const result = p.check(before);
    assert.equal(result.status, 1, message.source);
    assert.match(result.stderr, message);
    assert.deepEqual(result.ledger, before, 'not written back');
  }
  for (const before of [
    done([accepted({ status: 'escalated' }), finalAccept], { flagged: [flag('A1')] }),
    done([accepted(), finalAccept], { flagged: [flag('A1'), flag('A2')] }, { human_answers: [{ objection_id: 'A1', answer: 'the smaller change' }, { objection_id: 'A2', answer: 'as accepted' }] }),
    done([accepted(), finalAccept], { flagged: [] }),
    // The pass returned no usable answer: the record of the failure stands in for the review, and is kept on reuse.
    done([accepted(), finalAccept], { flagged: [], failed: true }),
    done([conceded], null),
    done([conceded], { flagged: [] }),
    done([conceded], undefined),
    planLedger([accepted()], { proportionality: null }),
  ]) {
    const result = p.check(before);
    assert.equal(result.status, 0, `${JSON.stringify(before.proportionality)}\n${result.stderr}`);
  }
});

// Decide mode: a question file with options A to C, checked as the plan, and a complete ledger in which A wins, every
// case and backed cross point is tested, and B concedes with the ruling's own evidence.
const QUESTION = '# Keep one ledger or split it?\n\n## Context\nThe ledger grows with every round.\n\n## Options\n### A: Keep one ledger\nOne file per plan\nholds every round.\n### B: Split it\nEach round writes its own file.\n### C: Drop it\nNothing is kept between runs.\n';
const ASKED = {
  a: cite('plan', '#a-keep-one-ledger', 'One file per plan holds every round.'),
  b: cite('plan', '#B: Split it', 'Each round writes its own file.'),
  c: cite('plan', '#c-drop-it', 'Nothing is kept between runs.'),
  context: cite('plan', '#context', 'The ledger grows with every round.'),
};
const FAILS = cite('code', 'src/app.js:1', 'not in the file');
const position = (id, runner) => ({ id, label: `option ${id}`, runner });
const stand = (id, citations, claim = `the case for ${id}`) => ({ position: id, claim, citations });
const point = (id, against, citations, extra = {}) => ({ id, by: id[0], against, claim: `point ${id}`, citations, status: 'backed', ...extra });
const answer = (id, verdict, citations, claim = 'the ruling misreads the record') => ({ position: id, verdict, claim, citations });
// One verdict per citation index of each entry `counts` names, supporting unless `against` names the entry.
const tested = (counts, against = []) => Object.entries(counts).flatMap(([of, count]) => Array.from({ length: count }, (_, citation) => ({ of, citation, supports: !against.includes(of), reason: 'r' })));
const FIRST = { A: 2, B: 1, A1: 1, B1: 1 };
const decision = (over = {}) => ({ decision: 'rule', winner: 'A', change_or_reason: 'B`s strongest claim is its read speed; the decision record defeats it.', citations: [PASSING.adr], tested: tested(FIRST, ['B']), inferences: [], ...over });
const escalated = { decision: 'escalate', winner: null, change_or_reason: 'cap reached, 8 of 8 dispatches', citations: [PASSING.adr], tested: [], inferences: [] };
const decideLedger = (over = {}) => ({
  mode: 'decide', status: 'complete', plan: 'questions/keep-one-ledger-abc1234.md', plan_hash: 'abc', same_model: false, same_model_reason: null, trigger: 'the Human asked',
  positions: [position('A', 'agent'), position('B', 'codex')],
  cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [ASKED.b])],
  cross: [point('A1', 'B', [PASSING.code]), point('B1', 'A', [PASSING.docBySlug])],
  ruling: decision(),
  rebuttals: [answer('B', 'concede', [PASSING.adr], 'the ruling holds')],
  final_ruling: null,
  human_answer: null,
  ...over,
});
// The same ledger before the ruling: open, with no ruling or rebuttal.
const opened = (over = {}) => decideLedger({ status: 'open', ruling: null, rebuttals: [], ...over });

function decideProject(t) {
  const p = project(t);
  const question = path.join(p.state, 'quorum/questions/keep-one-ledger-abc1234.md');
  write(p.state, 'quorum/questions/keep-one-ledger-abc1234.md', QUESTION);
  return { ...p, question, check: (value, against = question) => p.check(value, { against }) };
}

test('decide schemas: every node Codex-strict, a full ledger and each answer pass, and LEDGER_SCHEMAS holds the decide schema', () => {
  const strict = (node, where) => {
    if ([node.type].flat().includes('object')) {
      assert.equal(node.additionalProperties, false, where);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), where);
      for (const [key, child] of Object.entries(node.properties)) strict(child, `${where}.${key}`);
    }
    if (node.items) strict(node.items, `${where}[]`);
  };
  for (const [name, schema] of Object.entries({ DECIDE_LEDGER_SCHEMA, CASE_SCHEMA, CROSS_SCHEMA, DECIDE_REBUTTAL_SCHEMA })) strict(schema, name);
  assert.equal(LEDGER_SCHEMAS.decide, DECIDE_LEDGER_SCHEMA);
  assert.equal(modeOf(decideLedger()), 'decide');
  assert.deepEqual(schemaProblems(decideLedger(), DECIDE_LEDGER_SCHEMA), []);
  assert.deepEqual(schemaProblems(decideLedger({ final_ruling: escalated, human_answer: 'keep A' }), DECIDE_LEDGER_SCHEMA), []);
  const { human_answer: _, ...unanswered } = decideLedger();
  for (const [value, problem] of [
    [unanswered, '$.human_answer is missing'],
    [decideLedger({ ruling: { ...decision(), tested: undefined } }), '$.ruling.tested must be array'],
    [decideLedger({ ruling: decision({ tested: [{ citation: 0, supports: true, reason: 'r' }] }) }), '$.ruling.tested[0].of is missing'],
    [decideLedger({ ruling: decision({ winner: 'E' }) }), '$.ruling.winner must be one of A, B, C, D'],
    [decideLedger({ cross: [point('A1', 'B', [PASSING.code], { status: 'accepted' })] }), '$.cross[0].status must be one of pending, opinion, backed'],
    [decideLedger({ objections: [] }), '$.objections is not a known field'],
  ]) assert.deepEqual(schemaProblems(value, DECIDE_LEDGER_SCHEMA), [problem]);
  assert.deepEqual(schemaProblems({ case: { claim: 'c', citations: [PASSING.adr] } }, CASE_SCHEMA), []);
  assert.deepEqual(schemaProblems({ case: { claim: 'c' } }, CASE_SCHEMA), ['$.case.citations is missing']);
  const points = (count) => ({ cross: Array.from({ length: count }, () => ({ against: 'B', claim: 'c', citations: [] })) });
  assert.deepEqual(schemaProblems(points(5), CROSS_SCHEMA), []);
  assert.deepEqual(schemaProblems(points(6), CROSS_SCHEMA), ['$.cross has 6 items, more than 5']);
  assert.deepEqual(schemaProblems({ rebuttal: { verdict: 'concede', claim: 'c', citations: [PASSING.adr] } }, DECIDE_REBUTTAL_SCHEMA), []);
  assert.deepEqual(schemaProblems({ rebuttal: { verdict: 'yield', claim: 'c', citations: [] } }, DECIDE_REBUTTAL_SCHEMA), ['$.rebuttal.verdict must be one of rebut, concede']);
});

test('check decide: a full ledger passes unchanged, its plan citations anchored on the question file`s option and context headings', (t) => {
  const p = decideProject(t);
  const full = decideLedger();
  const result = p.check(full);
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  assert.deepEqual(result.lines, ['checked: mode decide, 2 cases, 2 cross points, 0 opinion, 0 problems']);
  assert.deepEqual(result.ledger, full);
  // An anchor by heading text, by slug, and on Context pass; a quote from another option's section does not.
  const anchors = p.check(opened({ cases: [stand('A', [ASKED.context, ASKED.c]), stand('B', [cite('plan', '#a-keep-one-ledger', 'Each round writes its own file.')])] }));
  assert.equal(anchors.status, 0, anchors.stderr);
  assert.deepEqual(anchors.lines, [
    'case B.citations[0] (plan #a-keep-one-ledger): the plan#a-keep-one-ledger does not contain the quote',
    'case B: no citation passes',
    'checked: mode decide, 2 cases, 2 cross points, 0 opinion, 2 problems',
  ]);
  // A claim's question file anchors on `## Claim`.
  const claim = path.join(p.state, 'quorum/questions/one-ledger-is-enough-abc1234.md');
  write(p.state, 'quorum/questions/one-ledger-is-enough-abc1234.md', '# One ledger is enough\n\n## Claim\nOne ledger holds\nevery round.\n');
  const onClaim = p.check(opened({ cases: [stand('A', [cite('plan', '#claim', 'One ledger holds every round.')]), stand('B', [cite('plan', '#Claim', 'every round')])], cross: [] }), claim);
  assert.equal(onClaim.status, 0, onClaim.stderr);
  assert.deepEqual(onClaim.lines, ['checked: mode decide, 2 cases, 0 cross points, 0 opinion, 0 problems']);
});

test('check decide: a pending cross point becomes backed or opinion by its citations; only a pending one is relabeled', (t) => {
  const p = decideProject(t);
  const result = p.check(opened({ cross: [point('A1', 'B', [FAILS, PASSING.code], { status: 'pending' }), point('B1', 'A', [FAILS], { status: 'pending' }), point('B2', 'A', [FAILS])] }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ledger.cross.map((each) => each.status), ['backed', 'opinion', 'backed']);
  assert.deepEqual(result.lines.filter((line) => !line.includes('.citations[')), [
    'cross B1: relabeled opinion (was pending): no citation passes',
    'cross B2: no citation passes; kept backed',
    'checked: mode decide, 2 cases, 3 cross points, 1 opinion, 5 problems',
  ]);
});

test('check decide: each invalid ruling, final ruling, rebuttal, and concession is named, with its reason', (t) => {
  const p = decideProject(t);
  const inferred = 'Split files read faster.\ninference: readers open one round at a time';
  const rebutted = (citations, claim) => [answer('B', 'rebut', citations, claim)];
  const finalOn = (over) => decision({ citations: [PASSING.fenced], tested: tested({ B: 1 }), ...over });
  for (const [over, lines] of [
    [{ ruling: decision({ citations: [FAILS] }) }, ['ruling: invalid: the ruling has no passing citation']],
    [{ ruling: decision({ tested: tested({ A: 1, B: 1, A1: 1, B1: 1 }) }) }, ['ruling: invalid: tested names 1 of 2 citations of case A']],
    [{ ruling: decision({ tested: [...tested(FIRST), { of: 'B1', citation: 0, supports: true, reason: 'r' }] }) }, ['ruling: invalid: tested names 0 of 1 citations of cross B1; 0 more than once']],
    [{ ruling: decision({ tested: [...tested(FIRST), { of: 'A1', citation: 3, supports: true, reason: 'r' }] }) }, ['ruling: invalid: tested names 1 of 1 citations of cross A1; 3 out of range']],
    [{ ruling: decision({ tested: [...tested(FIRST), { of: 'C', citation: 0, supports: true, reason: 'r' }] }) }, ['ruling: invalid: tested names C, which the ruling does not rule on']],
    // An opinion is not ruled on: a verdict on it is stray, and none is needed.
    [{ cross: [point('A1', 'B', [PASSING.code]), point('B1', 'A', [FAILS], { status: 'opinion' })] }, ['ruling: invalid: tested names B1, which the ruling does not rule on']],
    [{ ruling: decision({ tested: tested(FIRST, ['A', 'B']) }) }, ["ruling: invalid: a rule rests on no supporting citation of the winner's case"]],
    // A position wins on evidence or not at all: a rule for one whose case has no passing citation goes back.
    // Its one verdict, `supports: true`, is on a citation that does not pass, so it supports nothing either.
    [{ cases: [stand('A', [FAILS]), stand('B', [ASKED.b])], ruling: decision({ tested: tested({ A: 1, B: 1, A1: 1, B1: 1 }, ['B']) }) }, ["ruling: invalid: the winner's case has no passing citation", "ruling: invalid: a rule rests on no supporting citation of the winner's case"]],
    [{ ruling: decision({ tested: [...tested(FIRST, ['B']).filter((each) => each.of !== 'A'), { of: 'A', citation: 2, supports: true, reason: 'r' }] }) }, ['ruling: invalid: tested names 0 of 2 citations of case A; 2 out of range', "ruling: invalid: a rule rests on no supporting citation of the winner's case"]],
    [{ cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [ASKED.b], inferred)] }, ['ruling: invalid: inference untested: "readers open one round at a time"']],
    [{ cross: [point('A1', 'B', [PASSING.code], { claim: 'B is slow.\ninference: the disk is the bottleneck' }), point('B1', 'A', [PASSING.docBySlug])] }, ['ruling: invalid: inference untested: "the disk is the bottleneck"']],
    [{ rebuttals: rebutted([FAILS]) }, ['rebuttal B: invalid: the rebuttal has no passing citation']],
    [{ rebuttals: rebutted([ASKED.b]) }, ['rebuttal B: invalid: the rebuttal cites nothing new']],
    [{ rebuttals: rebutted([PASSING.code]) }, ['rebuttal B: invalid: the rebuttal cites nothing new']],
    [{ rebuttals: rebutted([PASSING.adr]) }, ['rebuttal B: invalid: the rebuttal cites nothing new']],
    [{ rebuttals: [answer('B', 'concede', [])] }, ['rebuttal B: invalid: the concession has no passing citation']],
    [{ rebuttals: [answer('B', 'concede', [FAILS])] }, ['rebuttal B: invalid: the concession has no passing citation']],
    [{ rebuttals: rebutted([PASSING.fenced]), final_ruling: finalOn({ citations: [FAILS] }) }, ['final ruling: invalid: the ruling has no passing citation']],
    [{ rebuttals: rebutted([PASSING.fenced, PASSING.exact]), final_ruling: finalOn() }, ['final ruling: invalid: tested names 1 of 2 citations of rebuttal B']],
    [{ rebuttals: rebutted([PASSING.fenced], 'It is faster.\ninference: rounds are read alone'), final_ruling: finalOn() }, ['final ruling: invalid: inference untested: "rounds are read alone"']],
    [{ rebuttals: rebutted([PASSING.fenced]), final_ruling: finalOn({ winner: 'B', tested: tested({ B: 1 }, ['B']) }) }, ["final ruling: invalid: a flip rests on no supporting citation of the winner's rebuttal"]],
    [{ cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [FAILS])], rebuttals: rebutted([PASSING.fenced]), final_ruling: finalOn({ winner: 'B' }) }, ["final ruling: invalid: the winner's case has no passing citation"]],
  ]) {
    const result = p.check(decideLedger({ status: 'open', ...over }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines.filter((line) => line.includes(': invalid: ')), lines, JSON.stringify(over));
  }
  // Every inference line tested, a concession citing the ruling's own evidence, and a valid final rule pass clean.
  const inferences = [{ statement: 'readers open one round at a time', holds: false, reason: 'r', citations: [] }];
  const clean = p.check(decideLedger({ cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [ASKED.b], inferred)], ruling: decision({ inferences }) }));
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(clean.lines, ['checked: mode decide, 2 cases, 2 cross points, 0 opinion, 0 problems']);
});

// A citation that stopped passing supports nothing: `supports: true` on it, beside `supports: false` on one that passes,
// leaves an accept, a rule, or a flip with no supporting citation. The same verdicts swapped are valid.
test('check: only a verdict on a citation that passes now supports a plan accept, a decide rule, or a flip', (t) => {
  const pair = (of, first, second) => [{ ...of, citation: 0, supports: first, reason: 'r' }, { ...of, citation: 1, supports: second, reason: 'r' }];
  const p = project(t);
  for (const [build, where] of [
    [(tested) => objection('A1', [FAILS, PASSING.code], { status: 'accepted', ruling: accepts({ tested }) }), 'objection A1 ruling'],
    [(tested) => objection('A1', [PASSING.code], { status: 'accepted', ruling: rejects(), rebuttal: { verdict: 'rebut', claim: 'c', citations: [FAILS, PASSING.fenced], ruling: accepts({ tested }) } }), 'objection A1 rebuttal ruling'],
  ]) {
    for (const [tested, lines] of [[pair({}, true, false), [`${where}: invalid: an accept rests on no supporting citation`]], [pair({}, false, true), []]]) {
      const result = p.check(planLedger([build(tested)]));
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.lines.filter((line) => line.startsWith(`${where}: invalid: `)), lines, JSON.stringify(tested));
    }
  }
  const d = decideProject(t);
  const rule = (onA) => ({ cases: [stand('A', [FAILS, ASKED.a]), stand('B', [ASKED.b])], ruling: decision({ tested: [...onA, ...tested({ B: 1, A1: 1, B1: 1 }, ['B'])] }) });
  const flip = (onB) => ({ rebuttals: [answer('B', 'rebut', [FAILS, PASSING.fenced])], final_ruling: decision({ winner: 'B', citations: [PASSING.fenced], tested: onB }) });
  for (const [build, of, line] of [
    [rule, 'A', "ruling: invalid: a rule rests on no supporting citation of the winner's case"],
    [flip, 'B', "final ruling: invalid: a flip rests on no supporting citation of the winner's rebuttal"],
  ]) {
    for (const [verdictsOn, lines] of [[pair({ of }, true, false), [line]], [pair({ of }, false, true), []]]) {
      const result = d.check(decideLedger({ status: 'open', ...build(verdictsOn) }));
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.lines.filter((each) => each.includes(': invalid: ')), lines, JSON.stringify(verdictsOn));
    }
  }
});

test('check decide: a complete ledger with no ruling, an unanswered loser, an unruled rebut, a governing winner with no evidence, or a stale ruling exits 1 unwritten', (t) => {
  const p = decideProject(t);
  const flip = { rebuttals: [answer('B', 'rebut', [PASSING.fenced])], final_ruling: decision({ winner: 'B', citations: [PASSING.fenced], tested: tested({ B: 1 }) }) };
  for (const [over, line] of [
    [{ ruling: null, rebuttals: [] }, 'ruling is null in a complete ledger'],
    [{ rebuttals: [] }, 'position B lost the ruling and has no rebuttal in a complete ledger'],
    [{ rebuttals: [answer('B', 'rebut', [PASSING.fenced])] }, 'rebuttal B rebuts with no final ruling in a complete ledger'],
    // Settled by the Human, the governing winner still needs its evidence.
    [{ cases: [stand('A', [FAILS]), stand('B', [ASKED.b])], ruling: decision({ tested: tested({ A: 1, B: 1, A1: 1, B1: 1 }, ['B']) }), rebuttals: [], final_ruling: escalated, human_answer: 'keep A' }, "case A: the governing winner's case has no passing citation in a complete ledger"],
    [{ cases: [stand('A', [ASKED.a, PASSING.adr])] }, 'position B has no case in a complete ledger'],
    [{ rebuttals: [answer('B', 'rebut', [PASSING.fenced])], final_ruling: decision({ citations: [FAILS], tested: tested({ B: 1 }) }) }, 'final ruling: invalid: the ruling has no passing citation in a complete ledger'],
    [{ rebuttals: [answer('B', 'rebut', [FAILS])], final_ruling: decision({ citations: [PASSING.fenced], tested: tested({ B: 1 }) }) }, 'rebuttal B: invalid: the rebuttal has no passing citation in a complete ledger'],
    [{ ...flip, cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [FAILS])] }, "case B: the governing winner's case has no passing citation in a complete ledger"],
    [{ ruling: decision({ citations: [FAILS] }) }, 'ruling: invalid: the ruling has no passing citation in a complete ledger'],
    [{ rebuttals: [answer('B', 'concede', [FAILS])] }, 'rebuttal B: invalid: the concession has no passing citation in a complete ledger'],
  ]) {
    const value = decideLedger(over);
    const result = p.check(value);
    assert.equal(result.status, 1, line);
    assert.ok(result.stderr.includes(`: ${line}\n`), `${line}\n${result.stderr}`);
    assert.deepEqual(result.ledger, value, 'not written');
  }
  // An escalation settles an invalid ruling, answered or deferred, as an escalated objection is settled in plan mode.
  for (const human_answer of ['keep A', null]) {
    const settled = p.check(decideLedger({ ruling: decision({ decision: 'escalate', winner: null, citations: [FAILS] }), rebuttals: [], human_answer }));
    assert.equal(settled.status, 0, settled.stderr);
    assert.deepEqual(settled.lines, ['ruling.citations[0] (code src/app.js:1): src/app.js does not contain the quote', 'ruling: invalid: the ruling has no passing citation', 'checked: mode decide, 2 cases, 2 cross points, 0 opinion, 2 problems']);
  }
  // A flip that stands on the winner's evidence passes, and governs.
  const flipped = p.check(decideLedger(flip));
  assert.equal(flipped.status, 0, flipped.stderr);
  assert.deepEqual(flipped.lines, ['checked: mode decide, 2 cases, 2 cross points, 0 opinion, 0 problems']);
  assert.equal(governingWinner(decideLedger(flip)), 'B');
  assert.equal(governingWinner(decideLedger()), 'A');
  assert.equal(governingWinner(decideLedger({ final_ruling: escalated })), 'A');
  assert.equal(governingWinner(decideLedger({ ruling: decision({ decision: 'escalate', winner: null }) })), null);
});

test('check decide: each way the rebuttal round ends short escalates in the final ruling, and passes with the Human`s answer set or deferred', (t) => {
  const p = decideProject(t);
  for (const [rebuttals, lines] of [
    // (a) an invalid rebuttal, (b) a loser that never answered, (c) a rebut the cap left without an architect's ruling.
    [[answer('B', 'rebut', [PASSING.adr])], ['rebuttal B: invalid: the rebuttal cites nothing new']],
    [[], []],
    [[answer('B', 'rebut', [PASSING.fenced])], []],
  ]) {
    for (const human_answer of ['keep A', null]) {
      const result = p.check(decideLedger({ rebuttals, final_ruling: escalated, human_answer }));
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.lines, [...lines, `checked: mode decide, 2 cases, 2 cross points, 0 opinion, ${lines.length} problems`]);
    }
  }
  // A first ruling that escalates has no loser to rebut; deferred, it is complete.
  const deferred = p.check(decideLedger({ ruling: decision({ decision: 'escalate', winner: null }), rebuttals: [] }));
  assert.equal(deferred.status, 0, deferred.stderr);
  assert.deepEqual(deferred.lines, ['checked: mode decide, 2 cases, 2 cross points, 0 opinion, 0 problems']);
});

// modes/decide.md round 4: a first ruling invalid again is replaced by the coordinator's escalate, with the architect's
// last decision and winner after check's line, its citations, and no verdicts.
test('check decide: a coordinator-written first escalate after two invalid rulings passes deferred and answered, its tested lines printed and never stale', (t) => {
  const p = decideProject(t);
  const last = decision({ tested: tested({ A: 2, B: 1, A1: 1 }, ['B']) });
  const written = { decision: 'escalate', winner: null, change_or_reason: 'ruling: invalid: tested names 0 of 1 citations of cross B1\nThe architect ruled rule, for A.', citations: last.citations, tested: [], inferences: [] };
  const lines = ['case A', 'case B', 'cross A1', 'cross B1'].map((entry) => `ruling: invalid: tested names 0 of ${entry === 'case A' ? 2 : 1} citations of ${entry}`);
  for (const human_answer of [null, 'keep A']) {
    const before = decideLedger({ ruling: written, rebuttals: [], human_answer });
    const result = p.check(before);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'no line is stale');
    assert.deepEqual(result.lines, [...lines, 'checked: mode decide, 2 cases, 2 cross points, 0 opinion, 4 problems']);
    assert.deepEqual(result.ledger, before, 'written back as it was');
  }
  // The architect's last ruling kept as the ruling instead: its invalid line is stale, so the run would be lost.
  const kept = p.check(decideLedger({ ruling: last }));
  assert.equal(kept.status, 1, kept.stdout);
  assert.ok(kept.stderr.includes(': ruling: invalid: tested names 0 of 1 citations of cross B1 in a complete ledger\n'), kept.stderr);
});

test('check decide: ids, positions, winners, rebuttals, and same_model that do not fit exit 1 unwritten, one line each', (t) => {
  const p = decideProject(t);
  const three = { positions: [position('A', 'agent'), position('B', 'codex'), position('C', 'agent')], same_model: true, same_model_reason: 'A and C run as agents', cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [ASKED.b]), stand('C', [ASKED.c])] };
  const threeRuled = { ...three, ruling: decision({ tested: tested({ ...FIRST, C: 1 }, ['B', 'C']) }), rebuttals: [answer('B', 'rebut', [PASSING.fenced]), answer('C', 'concede', [PASSING.adr])] };
  const finalTo = (winner) => decision({ winner, citations: [PASSING.fenced], tested: tested({ B: 1, C: 1 }) });
  for (const [over, line] of [
    [{ positions: [position('B', 'agent'), position('A', 'codex')] }, 'positions are B, A, not 2 to 4 from A to D in order'],
    [{ positions: [position('A', 'agent'), position('C', 'codex')], cases: [stand('A', [ASKED.a])], cross: [], ruling: null, rebuttals: [], status: 'open' }, 'positions are A, C, not 2 to 4 from A to D in order'],
    [{ positions: [position('A', 'agent')], cases: [stand('A', [ASKED.a])], cross: [], ruling: null, rebuttals: [], status: 'open' }, 'positions are A, not 2 to 4 from A to D in order'],
    [{ cases: [...decideLedger().cases, stand('C', [ASKED.c])] }, 'case C is not a position in this ledger'],
    [{ cases: [...decideLedger().cases, stand('A', [ASKED.a])] }, 'position A has more than one case'],
    [{ cross: [point('A6', 'B', [PASSING.code])] }, 'cross id "A6" is not A1 to D5'],
    [{ cross: [point('A1\nchecked: ok', 'B', [PASSING.code])] }, 'cross id "A1\\u000achecked: ok" is not A1 to D5'],
    [{ cross: [point('A1', 'B', [PASSING.code]), point('A1', 'B', [PASSING.adr])] }, 'cross id A1 is used more than once'],
    [{ cross: [point('A2', 'A', [PASSING.code], { by: 'B' })] }, 'cross A2 is by B, not A'],
    [{ cross: [point('C1', 'A', [PASSING.code])] }, 'cross C1 is by C, not a position in this ledger'],
    [{ cross: [point('A1', 'C', [PASSING.code])] }, 'cross A1 is against C, not a position in this ledger'],
    [{ cross: [point('A1', 'A', [PASSING.code])] }, 'cross A1 is against its own position'],
    [{ rebuttals: [answer('C', 'concede', [PASSING.adr])] }, 'rebuttal C is not a position in this ledger'],
    [{ rebuttals: [answer('A', 'concede', [PASSING.adr]), answer('B', 'concede', [PASSING.adr])] }, "rebuttal A is by the first ruling's winner"],
    [{ rebuttals: [answer('B', 'concede', [PASSING.adr]), answer('B', 'concede', [PASSING.adr])] }, 'position B has more than one rebuttal'],
    [{ ruling: decision({ winner: null }) }, 'ruling rules with no winner'],
    [{ ruling: decision({ decision: 'escalate' }), rebuttals: [] }, 'ruling escalates but names the winner A'],
    [{ ruling: decision({ winner: 'C' }) }, 'ruling names the winner C, not a position in this ledger'],
    [{ rebuttals: [answer('B', 'rebut', [PASSING.fenced])], final_ruling: { ...escalated, winner: 'B' } }, 'final ruling escalates but names the winner B'],
    [{ ...threeRuled, final_ruling: finalTo('C') }, "final ruling names the winner C, neither the first ruling's winner nor a position that rebutted"],
    [{ ruling: decision({ decision: 'escalate', winner: null }) }, 'rebuttals and a final ruling follow a first ruling of rule only'],
    [{ ruling: decision({ decision: 'escalate', winner: null }), rebuttals: [], final_ruling: escalated }, 'rebuttals and a final ruling follow a first ruling of rule only'],
    [{ final_ruling: decision({ citations: [PASSING.fenced], tested: tested({ B: 1 }) }) }, 'final ruling rules, but no position rebutted'],
    [{ human_answer: 'keep A' }, 'human_answer: set but nothing escalated'],
    [{ rebuttals: [answer('B', 'rebut', [PASSING.fenced])], final_ruling: finalTo('A'), human_answer: 'keep A' }, 'human_answer: set but nothing escalated'],
    [{ positions: [position('A', 'agent'), position('B', 'agent')] }, 'same_model is false, but two positions share a runner'],
    [{ same_model: true, same_model_reason: 'shared' }, 'same_model is true, but no two positions share a runner'],
    [{ ...threeRuled, final_ruling: finalTo('B'), same_model_reason: null }, 'same_model is true, so same_model_reason must say why two positions share a runner'],
  ]) {
    const value = decideLedger(over);
    const result = p.check(value);
    assert.equal(result.status, 1, line);
    assert.deepEqual(result.stderr.trim().split('\n').map((each) => each.replace(/^.*?\.json: /u, '')), [line]);
    assert.deepEqual(result.ledger, value, 'not written');
  }
  // Three positions: a final ruling for the first winner or for a position that rebutted passes.
  for (const winner of ['A', 'B']) {
    const result = p.check(decideLedger({ ...threeRuled, final_ruling: finalTo(winner) }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, ['checked: mode decide, 3 cases, 2 cross points, 0 opinion, 0 problems']);
  }
});

test('quorum codex --mode case, cross, and rebut on a decide ledger: each held to its schema and the ledger, written, one line', async (t) => {
  const run = async (mode, answered, { ledgerValue = decideLedger(), withLedger = mode !== 'case' } = {}) => {
    const fake = fakeCodex({ answer: answered });
    const r = codexRun(t, fake);
    if (ledgerValue) writeFileSync(r.ledgerFile, JSON.stringify(ledgerValue));
    const code = await r.run({}, undefined, ['--mode', mode, ...(withLedger ? ['--ledger', r.ledgerFile] : [])]);
    assert.equal(r.printed.length, 1);
    const line = JSON.parse(r.printed[0]);
    const written = line.status === 'done' ? JSON.parse(readFileSync(r.out, 'utf8')) : (assert.throws(() => readFileSync(r.out), /ENOENT/u, 'nothing written'), null);
    return { code, line, written, fake, out: r.out };
  };
  const theCase = { case: { claim: 'one file is enough', citations: [PASSING.adr] } };
  const done = await run('case', theCase);
  assert.equal(done.code, 0);
  assert.deepEqual(done.line, { status: 'done', reason: `1 case written to ${done.out}` });
  assert.deepEqual(done.written, theCase);
  assert.deepEqual(done.fake.calls[0].schema, CASE_SCHEMA);
  assert.match((await run('case', ANSWER)).line.reason, /^the answer does not follow the schema: \$\.case is missing$/u);

  const points = { cross: [{ against: 'B', claim: 'B cites no reader', citations: [PASSING.code] }, { against: 'A', claim: 'own', citations: [] }] };
  const crossed = await run('cross', points);
  assert.equal(crossed.code, 0, crossed.line.reason);
  assert.deepEqual(crossed.line, { status: 'done', reason: `2 cross points written to ${crossed.out}` });
  assert.deepEqual(crossed.fake.calls[0].schema, CROSS_SCHEMA);
  const unknown = await run('cross', { cross: [{ against: 'C', claim: 'c', citations: [] }, { against: 'D', claim: 'd', citations: [] }] });
  assert.equal(unknown.code, 1);
  assert.equal(unknown.line.reason, 'the answer does not fit the ledger: the answer cross-examines C, D, not a position in the ledger');
  const onPlan = await run('cross', points, { ledgerValue: null });
  assert.equal(onPlan.code, 1);
  assert.equal(onPlan.line.reason, '--mode cross answers a decide ledger, and this ledger is in plan mode');
  assert.equal(onPlan.fake.calls.length, 0, 'Codex never starts');

  const rebutted = { rebuttal: { verdict: 'rebut', claim: 'the record is old', citations: [PASSING.fenced] } };
  const rebut = await run('rebut', rebutted);
  assert.equal(rebut.code, 0, rebut.line.reason);
  assert.deepEqual(rebut.line, { status: 'done', reason: `1 rebuttal written to ${rebut.out}` });
  assert.deepEqual(rebut.fake.calls[0].schema, DECIDE_REBUTTAL_SCHEMA);
  const bare = await run('rebut', { rebuttal: { verdict: 'concede', claim: 'it holds', citations: [] } });
  assert.equal(bare.code, 1);
  assert.equal(bare.line.reason, 'the answer does not fit the ledger: the answer concedes with no citation, which a decide ledger needs');
  assert.equal((await run('rebut', { rebuttal: { verdict: 'concede', claim: 'it holds', citations: [PASSING.adr] } })).code, 0);
  assert.match((await run('rebut', REBUTTALS)).line.reason, /^the answer does not follow the schema: \$\.rebuttal is missing$/u);
});

// config.json in `root`, with the folder version and the `quorum` group given.
const writeQuorum = (root, quorum) => write(root, '.aidrian/config.json', JSON.stringify({ version: 1, quorum }));

// `aidrian quorum roles` as a coordinator runs it, from `cwd`: exit code, stderr, and the one JSON line, parsed.
function roles(cwd, ...args) {
  const r = spawnSync(CLI, ['quorum', 'roles', ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.error, undefined, 'roles finished');
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  return { status: r.status, stderr: r.stderr, lines, out: r.status === 0 ? JSON.parse(lines[0]) : null };
}

test('quorum roles: with no quorum config, each mode prints today\'s roles, judge, and caps as one JSON line', (t) => {
  const dir = temp(t, 'aidrian-quorum-roles-');
  const plan = roles(dir, 'plan');
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.lines.length, 1, 'one line');
  assert.deepEqual(plan.out, {
    mode: 'plan',
    roles: {
      A: { provider: 'agent', agent: 'code-reviewer', fallback: null },
      B: { provider: 'codex', agent: null, fallback: 'product-manager' },
    },
    judge: { agent: 'architect' },
    caps: { maxObjections: 5, maxDispatches: 8 },
  });
  const decide = roles(dir, 'decide');
  assert.equal(decide.status, 0, decide.stderr);
  assert.equal(decide.lines.length, 1, 'one line');
  assert.deepEqual(decide.out, {
    mode: 'decide',
    roles: {
      odd: { positions: ['A', 'C'], provider: 'agent', agent: 'code-reviewer', fallback: null },
      even: { positions: ['B', 'D'], provider: 'codex', agent: null, fallback: 'code-reviewer' },
    },
    swap: true,
    judge: { agent: 'architect' },
    caps: { 2: 9, 3: 12, 4: 16 },
  });
});

// The mode files name today's values as the defaults: each is what `roles` prints with no quorum config, so the text
// and DEFAULTS.quorum cannot drift apart.
test('quorum roles: the defaults the mode files name are the values roles prints with no quorum config', (t) => {
  const dir = temp(t, 'aidrian-quorum-roles-');
  const texts = skillTexts();
  const flat = (file) => texts[file].replace(/\s+/gu, ' ');
  const plan = roles(dir, 'plan').out;
  const planText = flat('modes/plan.md');
  assert.equal(plan.roles.A.provider, 'agent');
  assert.equal(plan.roles.B.provider, 'codex');
  for (const sentence of [
    `- **A, "it will break"**: \`${plan.roles.A.agent}\`. A always runs as a host agent.`,
    `Codex, through \`aidrian quorum codex\`; its agent fallback is \`${plan.roles.B.fallback}\`.`,
    `- **Architect**: \`${plan.judge.agent}\`.`,
    `at most \`maxObjections\` objections (default ${plan.caps.maxObjections})`,
    `${plan.caps.maxDispatches} by default`,
  ]) assert.ok(planText.includes(sentence), `plan.md: ${sentence}`);
  const decide = roles(dir, 'decide').out;
  const decideText = flat('modes/decide.md');
  assert.equal(decide.roles.odd.provider, 'agent');
  assert.equal(decide.roles.even.provider, 'codex');
  assert.equal(decide.swap, true);
  const words = { 2: 'two', 3: 'three', 4: 'four' };
  for (const sentence of [
    `\`A\` and \`C\` run as \`${decide.roles.odd.agent}\`.`,
    `\`B\` and \`D\` run on Codex through \`aidrian quorum codex\`; their fallback agent is \`${decide.roles.even.fallback}\`.`,
    `- **Judge**: \`${decide.judge.agent}\`.`,
    `the judge (its agent, \`${decide.judge.agent}\` by default, on the host's model)`,
    // The swap gives A even's role and B odd's: with the defaults, A on Codex with even's fallback, B as odd's agent.
    `\`A\` takes \`even\`'s provider, agent, and fallback, and \`B\` takes \`odd\`'s; by default, \`A\` runs on Codex, with \`${decide.roles.even.fallback}\` as its fallback, and \`B\` runs as \`${decide.roles.odd.agent}\`.`,
    `With the default runners that is ${decide.caps[2]} for ${words[2]}, ${decide.caps[3]} for ${words[3]}, and ${decide.caps[4]} for ${words[4]}.`,
  ]) assert.ok(decideText.includes(sentence), `decide.md: ${sentence}`);
});

test('quorum roles: a config sets the roles, judge, swap, and caps it prints; A stays a host agent; a bad mode exits 1', (t) => {
  const dir = temp(t, 'aidrian-quorum-roles-');
  writeQuorum(dir, {
    judge: { agent: 'staff-architect' },
    plan: { a: { agent: 'security-reviewer' }, b: { provider: 'agent' }, maxObjections: 3, maxDispatches: 6 },
    decide: { odd: { provider: 'codex' }, even: { provider: 'agent', agent: 'product-manager' }, swap: false },
  });
  // A folder below the project reads the project's config, as every aidrian command does.
  mkdirSync(path.join(dir, 'src'));
  const plan = roles(path.join(dir, 'src'), 'plan');
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(plan.out, {
    mode: 'plan',
    roles: {
      A: { provider: 'agent', agent: 'security-reviewer', fallback: null },
      B: { provider: 'agent', agent: 'product-manager', fallback: null },
    },
    judge: { agent: 'staff-architect' },
    caps: { maxObjections: 3, maxDispatches: 6 },
  });
  const decide = roles(dir, 'decide');
  assert.equal(decide.status, 0, decide.stderr);
  // Odd on Codex puts A and C there: three positions hold two Codex runners, so 3 * 3 + 2 + 2 = 13.
  assert.deepEqual(decide.out, {
    mode: 'decide',
    roles: {
      odd: { positions: ['A', 'C'], provider: 'codex', agent: null, fallback: 'code-reviewer' },
      even: { positions: ['B', 'D'], provider: 'agent', agent: 'product-manager', fallback: null },
    },
    swap: false,
    judge: { agent: 'staff-architect' },
    caps: { 2: 9, 3: 13, 4: 16 },
  });
  writeQuorum(dir, { decide: { odd: { provider: 'agent' }, even: { provider: 'agent' } } });
  assert.deepEqual(roles(dir, 'decide').out.caps, { 2: 8, 3: 11, 4: 14 }, 'no Codex runner, no fallback');
  for (const args of [['debate'], [], ['plan', 'decide'], ['PLAN']]) {
    const bad = roles(dir, ...args);
    assert.equal(bad.status, 1, args.join(' '));
    assert.deepEqual(bad.lines, [], 'no JSON line');
    assert.match(bad.stderr, /^aidrian quorum: roles takes one mode, plan, decide, or product/u);
  }
});

test('quorum roles: an invalid quorum config exits 1 naming each key, and prints no roles', (t) => {
  const dir = temp(t, 'aidrian-quorum-roles-');
  for (const [quorum, key] of [
    [{ plan: { b: { provider: 'Codex' } } }, /"quorum\.plan\.b\.provider" must be "agent" or "codex"/u],
    [{ plan: { maxDispatches: 4 } }, /"quorum\.plan\.maxDispatches" must be a whole number, 5 or more/u],
    [{ plan: { a: { provider: 'codex' } } }, /unknown key "quorum\.plan\.a\.provider"/u],
  ]) {
    writeQuorum(dir, quorum);
    for (const mode of ['plan', 'decide']) {
      const result = roles(dir, mode);
      assert.equal(result.status, 1, `${mode}: ${JSON.stringify(quorum)}`);
      assert.match(result.stderr, key);
      assert.deepEqual(result.lines, [], 'no defaults printed');
    }
  }
});

test('check: a plan ledger with runners holds same_model to whether A and B share a runner; one without keeps the old rule', (t) => {
  const p = project(t);
  const base = (extra) => ({ ...ledger([objection('A1', [PASSING.code])]), ...extra });
  // B fell back to an agent: both ran as agents, so the models match and the reason says why.
  const fellBack = base({ runners: { A: 'agent', B: 'agent' }, same_model: true, same_model_reason: 'failed: codex exited 1' });
  for (const passes of [fellBack, base({ runners: { A: 'agent', B: 'codex' }, same_model: false, same_model_reason: null })]) {
    const result = p.check(passes);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.ledger.runners, passes.runners, 'runners kept');
  }
  for (const [before, message] of [
    [{ ...fellBack, same_model: false, same_model_reason: null }, /: same_model is false, but the runners match: A agent, B agent$/mu],
    [base({ runners: { A: 'agent', B: 'codex' }, same_model: true, same_model_reason: 'Codex host' }), /: same_model is true, but the runners differ: A agent, B codex$/mu],
    [{ ...fellBack, same_model_reason: ' ' }, /: same_model is true, so same_model_reason must say why A and B share a runner$/mu],
    [{ ...fellBack, runners: { A: 'agent', B: 'claude' } }, /: \$\.runners\.B must be one of agent, codex$/mu],
    // Plan adversary A has no Codex path, so a ledger never records it there.
    [{ ...fellBack, runners: { A: 'codex', B: 'codex' } }, /: \$\.runners\.A must be one of agent$/mu],
    [{ ...fellBack, runners: { A: 'agent' } }, /: \$\.runners\.B is missing$/mu],
  ]) {
    const result = p.check(before);
    assert.equal(result.status, 1, message.source);
    assert.match(result.stderr, message);
    assert.deepEqual(result.ledger, before, 'not written back');
  }
  // Without runners, same_model true needs only a reason, as before runners existed: the ledger cannot show the runs.
  const old = p.check(base({ same_model: true, same_model_reason: 'unavailable: the codex CLI is not installed' }));
  assert.equal(old.status, 0, old.stderr);
  assert.equal(Object.hasOwn(old.ledger, 'runners'), false, 'check adds no runners');
});

test('check with mode: an open ledger\'s cap per adversary is config.json quorum.plan.maxObjections; a complete one, or one with no mode, never reads it', (t) => {
  const p = project(t);
  writeQuorum(p.root, { plan: { maxObjections: 3 } });
  const four = planLedger([1, 2, 3, 4].map((n) => objection(`A${n}`, [PASSING.code])));
  const refused = p.check(four);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /: A raised 4 objections, more than the 3 quorum\.plan\.maxObjections allows in a ledger with a mode$/mu);
  assert.deepEqual(refused.ledger, four, 'not written back');
  const three = planLedger([1, 2, 3].flatMap((n) => [objection(`A${n}`, [PASSING.code]), objection(`B${n}`, [PASSING.code], { by: 'B' })]));
  const result = p.check(three);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: mode plan, 6 objections, 0 opinion, 0 problems']);
  // A ledger with no mode keeps its old cap of 7, whatever the config says, and so does a broken config.
  const old = legacy([1, 2, 3, 4].map((n) => objection(`A${n}`, [PASSING.code], { status: 'accepted', ruling: { decision: 'accept', change_or_reason: 'r', citations: [PASSING.code] } })));
  for (const quorum of [{ plan: { maxObjections: 3 } }, { plan: { maxObjections: 9 } }]) {
    writeQuorum(p.root, quorum);
    const kept = p.check(old);
    assert.equal(kept.status, 0, kept.stderr);
    assert.deepEqual(kept.lines, ['checked: mode plan, 4 objections, 0 opinion, 0 problems']);
  }
  // With mode, open, a broken config stops the check, naming the key, before it writes anything.
  const broken = p.check(three);
  assert.equal(broken.status, 1, broken.stdout);
  assert.match(broken.stderr, /"quorum\.plan\.maxObjections" must be a whole number from 1 to 5/u);
  assert.deepEqual(broken.ledger, three, 'not written back');
  // A complete ledger keeps the ceiling of 5: a cap lowered after the run finished never voids it or the Human's answers.
  const finished = planLedger([1, 2, 3, 4].map((n) => objection(`A${n}`, [PASSING.code], { status: 'rejected', ruling: rejects(), rebuttal: concede([PASSING.plan]) })), { status: 'complete' });
  for (const quorum of [{ plan: { maxObjections: 3 } }, { plan: { maxObjections: 9 } }]) {
    writeQuorum(p.root, quorum);
    const done = p.check(finished);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(done.lines, ['checked: mode plan, 4 objections, 0 opinion, 0 problems']);
  }
  writeQuorum(p.root, { plan: { maxObjections: 3 } });
  const reopened = p.check({ ...finished, status: 'open' });
  assert.equal(reopened.status, 1, 'the same ledger open is held to the configured cap');
  assert.match(reopened.stderr, /: A raised 4 objections, more than the 3 quorum\.plan\.maxObjections allows in a ledger with a mode$/mu);
  const six = planLedger(Array.from({ length: 6 }, (_, i) => objection(`A${i + 1}`, [PASSING.code], { status: 'rejected', ruling: rejects(), rebuttal: concede([PASSING.plan]) })), { status: 'complete' });
  assert.match(p.check(six).stderr, /: A raised 6 objections, more than the 5 quorum\.plan\.maxObjections allows in a ledger with a mode$/mu, 'complete: the ceiling holds');
});

test('check on a decide ledger never reads config.json: a broken quorum config leaves it passing', (t) => {
  const p = decideProject(t);
  writeQuorum(p.root, { plan: { maxObjections: 9 } });
  for (const value of [opened(), decideLedger()]) {
    const result = p.check(value);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.lines.at(-1), /^checked: mode decide, /u);
  }
});

test('quorum docs name the readers of the quorum config: check for maxObjections, roles for the rest', () => {
  const ledgerText = skillTexts()['references/ledger.md'].replace(/\s+/gu, ' ');
  assert.match(ledgerText, /- `objections\[\]\.id`:[^-]*`quorum\.plan\.maxObjections`/u, 'ledger.md: the id bullet names the configured cap');
  const config = readFileSync(path.resolve(import.meta.dirname, '../docs/config.md'), 'utf8').split('\n## Quorum\n')[1].split('\n## ')[0].replace(/\s+/gu, ' ');
  assert.match(config, /`aidrian quorum check` reads `quorum\.plan\.maxObjections`/u);
  assert.match(config, /`aidrian quorum roles plan` and `aidrian quorum roles decide` read the whole group/u);
  assert.match(ledgerText, /- `runners\.A`: always `agent`/u, 'ledger.md: A has no Codex path');
});

test('the objection cap is never hard-coded where the coordinator keeps objections', () => {
  for (const file of ['modes/plan.md', 'references/ledger.md']) {
    const text = readFileSync(path.join(SKILL, file), 'utf8').replace(/\s+/gu, ' ');
    assert.doesNotMatch(text, /first \d+ objections/u, `${file} keeps a fixed number of objections`);
  }
  const ledger = readFileSync(path.join(SKILL, 'references/ledger.md'), 'utf8').replace(/\s+/gu, ' ');
  assert.match(ledger, /the first `maxObjections` objections, as `aidrian quorum roles plan` prints it/u);
});

// Product mode: a recommendation the Human settles, with no rebuttal round and a persona no ruling may rest on alone.
const PERSONA_REF = 'docs/waiter.md#Who';
const productLedger = (over = {}) => {
  const { positions, cases, ruling: first, human_answer, status, plan, plan_hash, same_model, same_model_reason, trigger } = decideLedger({ cases: [stand('A', [PASSING.adr]), stand('B', [PASSING.code])], cross: [], ruling: decision({ tested: tested({ A: 1, B: 1 }, ['B']) }) });
  return { mode: 'product', status, plan, plan_hash, same_model, same_model_reason, trigger, premise: { summary: 'open', citations: [PASSING.adr] }, trace: 't', persona_docs: [], draft: null, loops: [], positions, witness: null, cases, cross: [], ruling: first, outcome: { conditions: [], flips_if: [{ fact: 'f', how_to_settle: 'ask' }], disputes: [] }, human_answer, ...over };
};

test('product ledger: a complete rule passes with no rebuttal, and unanswered it stays deferred', (t) => {
  const d = decideProject(t);
  const result = d.check(productLedger());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /checked: mode product, 2 cases, 0 cross points/u);
});

test('product ledger: the shape rules stop the check', (t) => {
  const d = decideProject(t);
  for (const [over, message] of [
    [{ outcome: null }, /outcome is null under a rule/u],
    [{ cross: [{ id: 'A1', by: 'U', against: 'A', claim: 'c', citations: [], status: 'pending' }] }, /not U1 to U5 or E1 to E5/u],
    [{ ruling: null, outcome: null }, /ruling is null/u],
    [{ draft: { winner: 'C', reason: 'r', walkthrough: 'w' } }, /draft names C/u],
    [{ loops: [{ back_to: 'interview', reason: 'r' }] }, /no end user took part/u],
    [{ positions: ['A', 'B', 'C', 'D'].map((id) => position(id, 'agent')), same_model: true, same_model_reason: 'all agents' }, /at most 3 positions/u],
  ]) {
    const result = d.check(productLedger(over));
    assert.equal(result.status, 1, JSON.stringify(over));
    assert.match(result.stderr, message);
  }
});

test('product ledger: a Human answer is allowed on a rule, which a decide ledger refuses', (t) => {
  const d = decideProject(t);
  assert.equal(d.check(productLedger({ human_answer: 'approved' })).status, 0);
  assert.equal(d.check(decideLedger({ human_answer: 'approved' })).status, 1);
});

test('product ledger: a winner resting only on the persona doc does not stand, and a premise needs a passing citation', (t) => {
  const d = decideProject(t);
  const persona = { persona: PASSING.adr.ref.split('#')[0], interview: [], walkthrough: null };
  const rests = d.check(productLedger({ witness: persona }));
  assert.equal(rests.status, 1, 'the only supporting citation is the persona doc');
  assert.match(rests.stderr, /rests only on the persona doc/u);
  const other = d.check(productLedger({ witness: { persona: PERSONA_REF.split('#')[0], interview: [{ question: 'q', answer: 'a' }], walkthrough: 'w' } }));
  assert.equal(other.status, 0, other.stderr);
  const premise = d.check(productLedger({ premise: { summary: 'open', citations: [cite('doc', 'docs/missing.md#x', 'nope')] } }));
  assert.equal(premise.status, 1);
  assert.match(premise.stderr, /premise: invalid/u);
});

test('quorum roles product: the end user, the grillers, and a fixed cap', (t) => {
  const { out } = roles(temp(t, 'aidrian-quorum-roles-'), 'product');
  assert.equal(out.judge.agent, 'product-manager');
  assert.equal(out.roles.witness.agent, 'ux-researcher');
  assert.equal(out.roles.engineer.agent, 'architect');
  assert.deepEqual(out.caps, { maxLoops: 2, maxDispatches: 22 });
});

const xPoint = (id, citations, status = 'pending') => ({ id, by: id[0], against: 'B', claim: `point ${id}`, citations, status });

test('product ledger: pending examiner points are relabeled on disk, and a ruling must test a backed one', (t) => {
  const d = decideProject(t);
  const open = { status: 'open', ruling: null, outcome: null, cross: [xPoint('U1', [PASSING.code]), xPoint('E2', [cite('doc', 'docs/missing.md#x', 'nope')])] };
  const result = d.check(productLedger(open));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ledger.cross.map(({ status }) => status), ['backed', 'opinion']);
  assert.ok(!Object.hasOwn(result.ledger, 'rebuttals'), 'the decide view stays out of the file');
  const missed = d.check(productLedger({ status: 'open', cross: [xPoint('U1', [PASSING.code], 'backed')] }));
  assert.match(missed.stdout, /ruling: invalid: .*U1/u);
});

test('product ledger: a coordinator-written escalate passes, answered or deferred, and an outcome on it does not', (t) => {
  const d = decideProject(t);
  const escalate = { decision: 'escalate', winner: null, change_or_reason: 'invalid twice', citations: [PASSING.adr], tested: [], inferences: [] };
  assert.equal(d.check(productLedger({ ruling: escalate, outcome: null })).status, 0);
  assert.equal(d.check(productLedger({ ruling: escalate, outcome: null, human_answer: 'A' })).status, 0);
  assert.match(d.check(productLedger({ ruling: escalate })).stderr, /outcome: set but no ruling rules/u);
});

test('product ledger: an open rule with no outcome goes back, and repeats stop the check', (t) => {
  const d = decideProject(t);
  const open = d.check(productLedger({ status: 'open', outcome: null }));
  assert.match(open.stdout, /ruling: invalid: a rule has no outcome/u);
  const repeated = d.check(productLedger({ status: 'open', cross: [xPoint('U1', [PASSING.code]), xPoint('U1', [PASSING.code])] }));
  assert.match(repeated.stderr, /U1 is used more than once/u);
  assert.match(d.check(productLedger({ witness: { persona: '/abs/waiter.md', interview: [], walkthrough: null } })).stderr, /not a path inside the repository/u);
  assert.match(d.check(productLedger({ ruling: null, outcome: null, status: 'open', human_answer: 'A' })).stderr, /nothing was ruled/u);
});

test('product ledger: the persona guard holds for a code citation, and an answer survives a lost citation', (t) => {
  const d = decideProject(t);
  const persona = PASSING.code.ref.split(':')[0];
  const cases = [stand('A', [PASSING.code]), stand('B', [PASSING.adr])];
  const rests = d.check(productLedger({ cases, witness: { persona, interview: [], walkthrough: null } }));
  assert.match(rests.stderr, /rests only on the persona doc/u);
  const lost = [stand('A', [cite('doc', 'docs/missing.md#x', 'nope')]), stand('B', [PASSING.code])];
  assert.equal(d.check(productLedger({ cases: lost })).status, 1, 'unanswered, it is stale');
  assert.equal(d.check(productLedger({ cases: lost, human_answer: 'approved' })).status, 0, 'answered, it stands');
});

test('quorum premise: only an open: false answer with passing citations ends a run', (t) => {
  const p = project(t);
  const run = (answer) => {
    const file = path.join(p.state, 'premise.json');
    writeFileSync(file, JSON.stringify(answer));
    return spawnSync(CLI, ['quorum', 'premise', file], { cwd: p.root, encoding: 'utf8', timeout: 30_000 });
  };
  const premise = (citations) => ({ summary: 's', citations });
  assert.equal(run({ open: false, premise: premise([PASSING.adr]) }).status, 0);
  const open = run({ open: true, premise: premise([PASSING.adr]) });
  assert.equal(open.status, 1);
  assert.match(open.stdout, /only an answer with open: false/u);
  assert.equal(run({ open: false, premise: premise([cite('doc', 'docs/missing.md#x', 'nope')]) }).status, 1);
  const shapeless = run({ open: false });
  assert.equal(shapeless.status, 1);
  assert.match(shapeless.stdout, /premise/u);
});

test('product ledger: the guard covers every persona doc with no witness, and a premise never cites the question file', (t) => {
  const d = decideProject(t);
  const persona = PASSING.adr.ref.split('#')[0];
  assert.match(d.check(productLedger({ persona_docs: [persona] })).stderr, /rests only on the persona doc/u);
  assert.match(d.check(productLedger({ premise: { summary: 's', citations: [cite('plan', '#context', 'x')] } })).stderr, /cites the question file/u);
});

test('product ledger: an open run may loop up to the cap, and a complete one keeps the ceiling', (t) => {
  const d = decideProject(t);
  const loops = (n) => Array.from({ length: n }, () => ({ back_to: 'grill', reason: 'r' }));
  assert.equal(d.check(productLedger({ status: 'open', loops: loops(2) })).status, 0);
  assert.match(d.check(productLedger({ status: 'open', loops: loops(3) })).stderr, /loops: 3, more than the 2 allowed/u);
  assert.equal(d.check(productLedger({ loops: loops(3) })).status, 0);
});

test('product ledger: a deferred question on dead evidence goes stale, under an escalation too', (t) => {
  const d = decideProject(t);
  const dead = cite('doc', 'docs/missing.md#x', 'nope');
  const escalate = { decision: 'escalate', winner: null, change_or_reason: 'r', citations: [PASSING.adr], tested: [], inferences: [] };
  const cases = [stand('A', [dead]), stand('B', [PASSING.code])];
  assert.equal(d.check(productLedger({ ruling: escalate, outcome: null, cases })).status, 1);
  assert.equal(d.check(productLedger({ ruling: escalate, outcome: null, cases, human_answer: 'A' })).status, 0);
});

test('product ledger: an unanswered escalation with an invalid ruling is not reused, and an answered one stands', (t) => {
  const d = decideProject(t);
  const escalate = { decision: 'escalate', winner: null, change_or_reason: 'r', citations: [PASSING.adr], tested: [], inferences: [] };
  const noCitation = { ...escalate, citations: [] };
  assert.match(d.check(productLedger({ ruling: noCitation, outcome: null })).stderr, /the ruling has no passing citation/u);
  const partial = { ...escalate, tested: tested({ A: 1 }) };
  assert.match(d.check(productLedger({ ruling: partial, outcome: null })).stderr, /ruling: invalid: tested names/u);
  assert.equal(d.check(productLedger({ ruling: escalate, outcome: null })).status, 0, 'a coordinator-written escalate has no verdicts');
  assert.equal(d.check(productLedger({ ruling: partial, outcome: null, human_answer: 'A' })).status, 0);
});

test('product ledger: a no-verdict escalation keeps only its coverage exemption', (t) => {
  const d = decideProject(t);
  const inferences = [{ statement: 's', holds: true, reason: 'r', citations: [] }];
  const result = d.check(productLedger({ ruling: { decision: 'escalate', winner: null, change_or_reason: 'r', citations: [PASSING.adr], tested: [], inferences }, outcome: null }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /holds on no passing citation/u);
});

test('product ledger: an inference quoting the exempt words does not slip past the coverage exemption', (t) => {
  const d = decideProject(t);
  for (const statement of ['tested names are reliable', 'inference untested is harmless']) {
    const inferences = [{ statement, holds: true, reason: 'r', citations: [] }];
    const result = d.check(productLedger({ ruling: { decision: 'escalate', winner: null, change_or_reason: 'r', citations: [PASSING.adr], tested: [], inferences }, outcome: null }));
    assert.equal(result.status, 1, statement);
  }
});

test('product ledger: a malformed citation beside a passing one does not void a complete ruling', (t) => {
  const d = decideProject(t);
  const bad = cite('doc', 'docs/waiter.md', 'no anchor');
  const cross = [{ id: 'U1', by: 'U', against: 'B', claim: 'point', citations: [PASSING.code, bad], status: 'backed' }];
  const ruling = decision({ tested: [...tested({ A: 1, B: 1 }, ['B']), { of: 'U1', citation: 0, supports: true, reason: 'r' }, { of: 'U1', citation: 1, supports: false, reason: 'r' }] });
  const result = d.check(productLedger({ cross, ruling }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cross U1\.citations\[1\]/u, 'the bad citation is still named');
  const dead = d.check(productLedger({ cross: [{ ...cross[0], citations: [bad] }], ruling: decision({ tested: [...tested({ A: 1, B: 1 }, ['B']), { of: 'U1', citation: 0, supports: false, reason: 'r' }] }) }));
  assert.equal(dead.status, 1, 'a point left with no passing citation still goes stale');
});

// `aidrian quorum route`. `route --ledger` reads a ledger as JSON, so `routeLedger` holds only what it reads, and none of them
// goes through `quorum check`, whose schema requires the rest: `carrying` below is the whole ledger that does.
const OPEN_DECISIONS = { maxMode: 'decide-reversible', mode: 'decide-reversible' };
const CLEAR = 'no,no,no,no,no';
const HARD = 'no,yes,no,no,no';

// A repository whose base branch, `main`, commits `config` in config.json, and `route` run in it.
function routeRepo(t, config) {
  const root = temp(t, 'aidrian-route-');
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const setConfig = (value) => write(root, '.aidrian/config.json', JSON.stringify({ version: 1, ...value }));
  git('init', '-q', '-b', 'main');
  setConfig(config);
  git('add', '.');
  git('commit', '-q', '-m', 'config');
  const raw = (...args) => spawnSync(CLI, ['quorum', 'route', ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const route = (...args) => {
    const r = raw(...args);
    assert.deepEqual([r.status, r.stderr], [0, ''], args.join(' '));
    assert.equal(r.stdout.trim().split('\n').length, 1, 'one JSON line');
    return JSON.parse(r.stdout);
  };
  return { root, git, setConfig, raw, route };
}

const productConfig = (product, decisions = OPEN_DECISIONS) => ({ decisions, quorum: { product } });
const routeCall = (hard, ...more) => ['--domain', 'product', '--class', 'copy', '--reversible', 'no,no,no,no', '--hard', hard, ...more];
const pickRoute = ({ route, wait }) => [route, wait];

test('quorum route: with autoStart off, any call follows resolve as today', (t) => {
  for (const approval of ['first', 'review-later']) {
    const open = routeRepo(t, productConfig({ autoStart: false, approval }));
    for (const hard of [CLEAR, HARD]) assert.deepEqual(pickRoute(open.route(...routeCall(hard))), ['as-today', false], `decide, ${approval}, ${hard}`);
    const asks = routeRepo(t, productConfig({ autoStart: false, approval }, {}));
    for (const hard of [CLEAR, HARD]) assert.deepEqual(pickRoute(asks.route(...routeCall(hard))), ['as-today', true], `ask, ${approval}, ${hard}`);
  }
  const unset = routeRepo(t, { decisions: OPEN_DECISIONS }).route(...routeCall(HARD));
  assert.equal(unset.route, 'as-today', 'off is the default');
});

test('quorum route: a small, clear call is the agent\'s under decide, and the Human\'s with no quorum under ask, whatever approval says', (t) => {
  for (const approval of ['first', 'review-later']) {
    const open = routeRepo(t, productConfig({ autoStart: true, approval })).route(...routeCall(CLEAR));
    assert.deepEqual(pickRoute(open), ['agent', false], `decide, ${approval}`);
    assert.equal(open.resolve.authority, 'decide');
    const asks = routeRepo(t, productConfig({ autoStart: true, approval }, {})).route(...routeCall(CLEAR));
    assert.deepEqual(pickRoute(asks), ['human', true], `ask, ${approval}`);
    assert.equal(asks.resolve.unattended, 'safe-default', 'a small, clear call follows unattended as today');
  }
});

test('quorum route: a hard call runs the quorum: review later continues only under decide, first and ask wait', (t) => {
  assert.deepEqual(pickRoute(routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' })).route(...routeCall(HARD))), ['quorum', false]);
  assert.deepEqual(pickRoute(routeRepo(t, productConfig({ autoStart: true, approval: 'first' })).route(...routeCall(HARD))), ['quorum', true]);
  assert.deepEqual(pickRoute(routeRepo(t, productConfig({ autoStart: true })).route(...routeCall(HARD))), ['quorum', true], 'first is the default');
  for (const approval of ['first', 'review-later']) {
    const asks = routeRepo(t, productConfig({ autoStart: true, approval }, {})).route(...routeCall(HARD));
    assert.deepEqual(pickRoute(asks), ['quorum', true], `ask, ${approval}`);
    assert.equal(asks.resolve.unattended, 'safe-default', 'the stricter quorum replaces the safe-default shortcut');
  }
  for (const [name, args] of [
    ['a floor class', ['--domain', 'product', '--class', 'money', '--reversible', 'no,no,no,no', '--hard', HARD]],
    ['hard to undo', ['--domain', 'product', '--class', 'copy', '--reversible', 'yes,no,no,no', '--hard', HARD]],
    ['no reversible answers', ['--domain', 'product', '--class', 'copy', '--hard', HARD]],
  ]) {
    const out = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' })).route(...args);
    assert.deepEqual([...pickRoute(out), out.resolve.authority], ['quorum', true, 'ask'], name);
  }
});

test('quorum route: a hard call at maxAutoRuns waits for the Human with no quorum, under either answer', (t) => {
  const open = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later', maxAutoRuns: 2 }));
  assert.deepEqual(pickRoute(open.route(...routeCall(HARD, '--runs', '1'))), ['quorum', false], 'below the cap');
  assert.deepEqual(pickRoute(open.route(...routeCall(HARD, '--runs', '2'))), ['human', true], 'at the cap');
  assert.deepEqual(pickRoute(open.route(...routeCall(HARD, '--runs', '3'))), ['human', true], 'past it');
  assert.deepEqual(pickRoute(open.route(...routeCall(CLEAR, '--runs', '9'))), ['agent', false], 'the cap counts quorums, and a small call runs none');
  const asks = routeRepo(t, productConfig({ autoStart: true, maxAutoRuns: 1 }, {}));
  assert.deepEqual(pickRoute(asks.route(...routeCall(HARD, '--runs', '1'))), ['human', true], 'under ask');
  const byDefault = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  assert.deepEqual(pickRoute(byDefault.route(...routeCall(HARD, '--runs', '2'))), ['quorum', false]);
  assert.deepEqual(pickRoute(byDefault.route(...routeCall(HARD, '--runs', '3'))), ['human', true], 'the default cap is 3');
});

test('quorum route: a missing or unknown hardness answer counts as hard', (t) => {
  const { route } = routeRepo(t, productConfig({ autoStart: true, approval: 'first' }));
  const copy = ['--domain', 'product', '--class', 'copy', '--reversible', 'no,no,no,no'];
  assert.equal(route(...copy, '--hard', CLEAR).route, 'agent', 'all no is small and clear');
  assert.equal(route(...copy, '--hard', ' NO, no,no ,No,no').route, 'agent', 'spelled as --reversible may be');
  for (const hard of [HARD, 'no,no,no,no', 'no,no,maybe,no,no', 'no,no,,no,no', 'no,no,no,no,no,no', '']) {
    assert.equal(route(...copy, '--hard', hard).route, 'quorum', JSON.stringify(hard));
  }
  assert.equal(route(...copy).route, 'quorum', 'no --hard at all');
  assert.equal(isClearCall(undefined), false);
});

test('quorum route: no combination routes a resolve answer of ask to the agent or to provisional work', () => {
  const rules = ['floor-class', 'unknown-class', 'escalate', 'escalate-doc', 'doc-outside-project', 'reversibility', 'domain-paused', 'maxMode', 'mode', 'no-base', 'unknown-domain'];
  const answers = [...rules.map((rule) => ({ authority: 'ask', rule })), { rule: 'no authority at all' }];
  for (const answer of answers) {
    for (const autoStart of [false, true]) {
      for (const approval of ['first', 'review-later', 'something else']) {
        for (const hard of [false, true]) {
          for (const runs of [0, 3, 9]) {
            const { route, wait } = routeFor({ autoStart, approval, maxAutoRuns: 3 }, { hard, runs, domain: 'product' }, answer);
            const named = JSON.stringify({ answer, autoStart, approval, hard, runs });
            assert.notEqual(route, 'agent', named);
            assert.equal(wait, true, named);
          }
        }
      }
    }
  }
  const decide = { authority: 'decide', rule: 'mode' };
  assert.equal(routeFor({ autoStart: true, approval: 'something else', maxAutoRuns: 3 }, { hard: true, runs: 0, domain: 'ux' }, decide).wait, true, 'only review-later continues');
});

test('quorum route: a bad argument exits 3 with nothing on stdout, and an invalid config exits 1', (t) => {
  const { raw, setConfig } = routeRepo(t, productConfig({ autoStart: true }));
  const copy = ['--domain', 'product', '--class', 'copy'];
  for (const [args, problem] of [
    [[], /needs --domain and --class/u],
    [['--domain', 'product'], /needs --domain and --class/u],
    [['--class', 'copy'], /needs --domain and --class/u],
    [[...copy, '--reversible', 'no,maybe'], /--reversible takes up to 4 answers/u],
    [[...copy, '--reversible', 'no,no,no,no,no'], /--reversible takes up to 4 answers/u],
    [[...copy, '--runs', 'two'], /--runs takes a whole number/u],
    [[...copy, '--runs', '1.5'], /--runs takes a whole number/u],
    [[...copy, '--runs', '-1'], /--runs/u],
    [[...copy, '--bogus'], /Unknown option '--bogus'/u],
    [[...copy, 'stray'], /Unexpected argument 'stray'/u],
    [[...copy, '--ledger', 'x.json'], /--ledger takes no --class/u],
    [['--ledger', 'x.json', '--hard', CLEAR], /--ledger takes no --hard/u],
    [['--ledger', 'x.json', '--runs', '1'], /--ledger takes no --runs/u],
    [['--ledger', 'x.json'], /--ledger needs --domain/u],
    [['--ledger', 'missing.json', '--domain', 'product'], /missing\.json/u],
  ]) {
    const r = raw(...args);
    assert.deepEqual([r.status, r.stdout], [3, ''], args.join(' '));
    assert.match(r.stderr, problem, args.join(' '));
    assert.match(r.stderr, /^usage: aidrian quorum route --domain D --class C /mu, 'the bad argument names the forms');
  }
  setConfig({ quorum: { product: { approval: 'later' } } });
  const state = temp(t, 'aidrian-route-state-');
  write(state, 'asks.json', JSON.stringify(routeLedger()));
  write(state, 'silent.json', JSON.stringify(routeLedger([], { ruling: { decision: 'rule', winner: 'A' } })));
  for (const args of [
    routeCall(HARD),
    ['--ledger', path.join(state, 'asks.json'), '--domain', 'product'],
    ['--ledger', path.join(state, 'silent.json'), '--domain', 'product'],
    ['--ledger', path.join(state, 'missing.json'), '--domain', 'product'],
    ['--domain', 'product'],
  ]) {
    const invalid = raw(...args);
    assert.deepEqual([invalid.status, invalid.stdout], [1, ''], args.join(' '));
    assert.match(invalid.stderr, /"quorum\.product\.approval" must be "first" or "review-later"/u, args.join(' '));
  }
});

test('quorum route: a branch raising autoStart or approval over its base reads the base\'s values', (t) => {
  const off = routeRepo(t, productConfig({ autoStart: false }));
  off.git('checkout', '-q', '-b', 'feature');
  off.setConfig(productConfig({ autoStart: true, approval: 'review-later' }));
  assert.deepEqual(pickRoute(off.route(...routeCall(HARD))), ['as-today', false], 'an uncommitted raise of autoStart');
  off.git('commit', '-q', '-am', 'raise');
  assert.deepEqual(pickRoute(off.route(...routeCall(HARD))), ['as-today', false], 'a committed raise of autoStart');

  const first = routeRepo(t, productConfig({ autoStart: true, approval: 'first', maxAutoRuns: 1 }));
  first.git('checkout', '-q', '-b', 'feature');
  first.setConfig(productConfig({ autoStart: true, approval: 'review-later', maxAutoRuns: 10 }));
  first.git('commit', '-q', '-am', 'raise');
  assert.deepEqual(pickRoute(first.route(...routeCall(HARD))), ['quorum', true], 'a committed raise of approval');
  assert.deepEqual(pickRoute(first.route(...routeCall(HARD, '--runs', '1'))), ['human', true], 'a committed raise of maxAutoRuns');

  const late = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  assert.deepEqual(pickRoute(late.route(...routeCall(HARD))), ['quorum', false]);
  late.git('checkout', '-q', '-b', 'feature');
  late.setConfig(productConfig({ autoStart: false }));
  late.git('commit', '-q', '-am', 'lower');
  assert.deepEqual(pickRoute(late.route(...routeCall(HARD))), ['quorum', false], 'the base decides, in both directions');
});

test('quorum route: no readable base counts as off', (t) => {
  // Outside git the working copy is resolve's rule, and no base is route's: resolve decides, and route stays off.
  const plain = temp(t, 'aidrian-route-plain-');
  write(plain, '.aidrian/config.json', JSON.stringify({ version: 1, ...productConfig({ autoStart: true, approval: 'review-later' }) }));
  const outside = JSON.parse(spawnSync(CLI, ['quorum', 'route', ...routeCall(HARD)], { cwd: plain, encoding: 'utf8', timeout: 30_000 }).stdout);
  assert.deepEqual([outside.route, outside.resolve.authority, outside.resolve.base], ['as-today', 'decide', null]);

  // A remote of another name, with no origin: no base at all, whatever the working copy says.
  const remote = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  remote.git('remote', 'add', 'upstream', 'https://example.com/none.git');
  const noBase = remote.route(...routeCall(HARD));
  assert.deepEqual([noBase.route, noBase.wait, noBase.resolve.rule, noBase.resolve.base], ['as-today', true, 'no-base', null]);

  // A base whose product block has an error is one no one can read as the team meant it.
  const bad = routeRepo(t, productConfig({ autoStart: true, approval: 'later' }));
  bad.setConfig(productConfig({ autoStart: true, approval: 'review-later' }));
  assert.equal(bad.route(...routeCall(HARD)).route, 'as-today');
});

test('quorum route prints resolve\'s own answer, pause and doc rules included', (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const asked = ['--domain', 'product', '--class', 'copy', '--reversible', 'no,no,no,no'];
  const resolveAnswer = (...more) => JSON.parse(spawnSync(CLI, ['decisions', 'resolve', ...asked, ...more], { cwd: repo.root, encoding: 'utf8', timeout: 30_000 }).stdout);
  assert.deepEqual(repo.route(...asked, '--hard', HARD).resolve, resolveAnswer());
  const out = repo.route(...asked, '--hard', HARD);
  assert.deepEqual(Object.keys(out), ['route', 'wait', 'reason', 'resolve']);
  assert.equal(typeof out.reason, 'string');

  const docs = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, escalateDocs: ['docs/terms.md'] }));
  const held = docs.route(...asked, '--hard', HARD, '--doc', 'docs/terms.md');
  assert.deepEqual([...pickRoute(held), held.resolve.rule], ['quorum', true, 'escalate-doc']);

  const marker = '<!-- aidrian:decision id=a status=unconfirmed class=copy domain=product date=2020-01-01 pr=none -->';
  const paused = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, unreviewed: { pauseDomainAt: { pending: 1, oldestDays: 1 } } }));
  write(paused.root, 'docs/a.md', `Rule.\n${marker}\n<!-- aidrian:decision-new id=a text="Rule." -->\n`);
  paused.git('add', '.');
  paused.git('commit', '-q', '-m', 'marker');
  const stopped = paused.route(...asked, '--hard', HARD);
  assert.deepEqual([...pickRoute(stopped), stopped.resolve.rule], ['quorum', true, 'domain-paused'], 'the pending markers count');
});

const flip = (fact, settles_from_repo, could_harden_undo) => ({ fact, how_to_settle: `check ${fact}`, ...(settles_from_repo === undefined ? {} : { settles_from_repo }), ...(could_harden_undo === undefined ? {} : { could_harden_undo }) });
const ruled = (over = {}) => ({ decision: 'rule', winner: 'A', class: 'copy', reversible: 'no,no,no,no', docs: [], domain: 'product', severity: 'low', reverts_by: 'revert the commit', ...over });
const ROUTE_DECIDE = "the route, with resolve's decide";
const routeLedger = (flips = [], { ruling = ruled(), ...over } = {}) => ({ mode: 'product', status: 'complete', trigger: ROUTE_DECIDE, ruling, outcome: { conditions: [], flips_if: flips, disputes: [] }, human_answer: null, ...over });

// `route --ledger` on `ledger`, written to a file outside the repository, which the command must leave as it found it.
function ledgerRoute(t, repo, ledger, ...more) {
  const state = temp(t, 'aidrian-route-state-');
  const text = `${JSON.stringify(ledger)}\n`;
  write(state, 'ledger.json', text);
  const out = repo.route('--ledger', path.join(state, 'ledger.json'), ...(more.length ? more : ['--domain', 'product']));
  assert.equal(readFileSync(path.join(state, 'ledger.json'), 'utf8'), text, 'route writes nothing');
  return out;
}

test('quorum route --ledger: under review later, each flipping fact decides whether work continues', (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const of = (entry) => ({ fact: entry.fact, how_to_settle: entry.how_to_settle });
  const user = flip('real users want it', false, false);
  const repoFact = flip('the code allows it', true, false);
  const harder = flip('it stores data', false, true);

  const none = ledgerRoute(t, repo, routeLedger());
  assert.deepEqual([...pickRoute(none), none.settle, none.listed], ['quorum', false, [], []], 'no flipping fact continues');
  assert.equal(none.resolve.authority, 'decide');

  const listed = ledgerRoute(t, repo, routeLedger([user]));
  assert.deepEqual([...pickRoute(listed), listed.settle, listed.listed], ['quorum', false, [], [of(user)]], 'a real-user fact continues and is listed');

  const settle = ledgerRoute(t, repo, routeLedger([user, repoFact]));
  assert.deepEqual([...pickRoute(settle), settle.settle, settle.listed], ['quorum', true, [of(repoFact)], [of(user)]], 'a fact the repository can settle waits until it is settled');

  const harden = ledgerRoute(t, repo, routeLedger([user, repoFact, harder]));
  assert.deepEqual([...pickRoute(harden), harden.settle], ['human', true, []], 'a fact that could make the decision harder to undo waits');
  assert.deepEqual(harden.listed, [of(user), of(repoFact), of(harder)]);
  assert.deepEqual(pickRoute(ledgerRoute(t, repo, routeLedger([flip('both', true, true)]))), ['human', true], 'settling cannot lift a fact that could harden the undo');

  const escalates = ledgerRoute(t, repo, routeLedger([], { ruling: ruled({ decision: 'escalate', winner: null }) }));
  assert.deepEqual([...pickRoute(escalates), escalates.resolve.authority], ['human', true, 'decide'], 'an escalate waits');
  const escalatesWithWinner = ledgerRoute(t, repo, routeLedger([], { ruling: ruled({ decision: 'escalate' }) }));
  assert.deepEqual(pickRoute(escalatesWithWinner), ['human', true], 'an escalate waits on its own rule, with a winner named');
  assert.match(escalatesWithWinner.reason, /the ruling escalates/u);

  const mixed = ledgerRoute(t, repo, routeLedger([user, harder]));
  assert.deepEqual([...pickRoute(mixed), mixed.listed], ['human', true, [of(user), of(harder)]], 'one fact that could harden the undo holds the whole list');

  const unknown = ledgerRoute(t, repo, routeLedger([], { ruling: ruled({ decision: 'accept' }) }));
  assert.deepEqual(pickRoute(unknown), ['human', true], 'a decision of no known kind waits');
  assert.match(unknown.reason, /neither rules nor escalates/u);

  const noHow = ledgerRoute(t, repo, routeLedger([{ fact: 'users', settles_from_repo: false, could_harden_undo: false }]));
  assert.deepEqual(pickRoute(noHow), ['human', true], 'a fact with no how_to_settle waits');
  assert.match(noHow.reason, /lacks its fact or how_to_settle/u);
});

test('quorum route --ledger: a ledger that lost human_answer routes to human, and never says the Human answered', (t) => {
  const missing = routeLedger();
  delete missing.human_answer;
  for (const approval of ['first', 'review-later']) {
    const out = ledgerRoute(t, routeRepo(t, productConfig({ autoStart: true, approval })), missing);
    assert.deepEqual(pickRoute(out), ['human', true], approval);
    assert.match(out.reason, /the ledger lacks human_answer/u);
    assert.doesNotMatch(out.reason, /answered|governs/u);
  }
  const off = ledgerRoute(t, routeRepo(t, productConfig({ autoStart: false })), missing);
  assert.deepEqual(pickRoute(off), ['human', true], 'under autoStart off too');
  const unanswered = ledgerRoute(t, routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' })), routeLedger());
  assert.deepEqual(pickRoute(unanswered), ['quorum', false], 'null is the field saying no one has answered yet');
});

test('quorum route --ledger: a flips_if entry missing either boolean waits, and no entry shape reads as false', (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  for (const [name, entry] of [
    ['neither', flip('x')],
    ['no settles_from_repo', { fact: 'x', how_to_settle: 'y', could_harden_undo: false }],
    ['no could_harden_undo', { fact: 'x', how_to_settle: 'y', settles_from_repo: false }],
    ['a string for false', flip('x', 'false', false)],
    ['null for false', flip('x', false, null)],
    ['not an object', 'x'],
  ]) {
    const out = ledgerRoute(t, repo, routeLedger([flip('fine', false, false), entry]));
    assert.deepEqual(pickRoute(out), ['human', true], name);
  }
});

test('quorum route --ledger: a ledger without the Ruling\'s class, reversible, docs, severity, or reverts_by, or without a usable outcome, routes to human', (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const without = (key) => {
    const ruling = ruled();
    delete ruling[key];
    return routeLedger([], { ruling });
  };
  for (const [name, ledger] of [
    ['no class', without('class')],
    ['no reversible', without('reversible')],
    ['no docs', without('docs')],
    ['no severity', without('severity')],
    ['no reverts_by', without('reverts_by')],
    ['an empty severity', routeLedger([], { ruling: ruled({ severity: ' ' }) })],
    ['an empty reverts_by', routeLedger([], { ruling: ruled({ reverts_by: '' }) })],
    ['an empty class', routeLedger([], { ruling: ruled({ class: '' }) })],
    ['a reversible word that is no answer', routeLedger([], { ruling: ruled({ reversible: 'no,maybe,no,no' }) })],
    ['docs that are not a list of paths', routeLedger([], { ruling: ruled({ docs: 'docs/a.md' }) })],
    ['a doc that is not a path', routeLedger([], { ruling: ruled({ docs: [3] }) })],
    ['no ruling', routeLedger([], { ruling: null })],
    ['a ledger of another mode', routeLedger([], { mode: 'decide' })],
    ['no outcome', routeLedger([], { outcome: null })],
    ['no flips_if', routeLedger([], { outcome: { conditions: [], disputes: [] } })],
    ['not an object', ['a list']],
    ['a ruling of no known decision', routeLedger([], { ruling: ruled({ decision: 'accept' }) })],
  ]) {
    const out = ledgerRoute(t, repo, ledger);
    assert.deepEqual(pickRoute(out), ['human', true], name);
  }
  assert.equal(ledgerRoute(t, repo, without('class')).resolve, null, 'with no question to ask, nothing was resolved');
  const off = routeRepo(t, productConfig({ autoStart: false }));
  assert.deepEqual(pickRoute(ledgerRoute(t, off, without('docs'))), ['human', true], 'under autoStart off too');
  assert.deepEqual(pickRoute(ledgerRoute(t, off, routeLedger([flip('x')]))), ['human', true], 'and for a flips_if entry');
});

test('quorum route --ledger: only review later under decide continues; first, ask, and off wait with every fact listed', (t) => {
  const facts = [flip('users', false, false), flip('code', true, false), flip('undo', false, true)];
  const all = facts.map(({ fact, how_to_settle }) => ({ fact, how_to_settle }));
  const first = ledgerRoute(t, routeRepo(t, productConfig({ autoStart: true, approval: 'first' })), routeLedger(facts));
  assert.deepEqual([...pickRoute(first), first.settle, first.listed], ['quorum', true, [], all], 'under first the Human sees them all');
  const firstClear = ledgerRoute(t, routeRepo(t, productConfig({ autoStart: true, approval: 'first' })), routeLedger([flip('users', false, false)]));
  assert.deepEqual(pickRoute(firstClear), ['quorum', true], 'a real-user fact does not lift first');

  const asks = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, {}));
  const underAsk = ledgerRoute(t, asks, routeLedger([flip('users', false, false)]));
  assert.deepEqual([...pickRoute(underAsk), underAsk.resolve.authority], ['quorum', true, 'ask'], 'ask under review later waits');

  const open = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  for (const [name, ruling] of [
    ['hard to undo', ruled({ reversible: 'no,yes,no,no' })],
    ['too few answers', ruled({ reversible: 'no,no' })],
    ['a floor class', ruled({ class: 'security' })],
  ]) {
    const out = ledgerRoute(t, open, routeLedger([], { ruling }));
    assert.deepEqual([...pickRoute(out), out.resolve.authority], ['quorum', true, 'ask'], name);
  }
  assert.deepEqual(pickRoute(ledgerRoute(t, open, routeLedger([], { ruling: ruled({ reversible: ['no', 'no', 'no', 'no'] }) }))), ['quorum', false], 'answers as a list');

  const doc = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, escalateDocs: ['docs/terms.md'] }));
  const held = ledgerRoute(t, doc, routeLedger([], { ruling: ruled({ docs: ['docs/terms.md'] }) }));
  assert.deepEqual([...pickRoute(held), held.resolve.rule], ['quorum', true, 'escalate-doc'], 'the Ruling\'s docs reach resolve');

  const off = ledgerRoute(t, routeRepo(t, productConfig({ autoStart: false, approval: 'review-later' })), routeLedger([flip('users', false, false)]));
  assert.deepEqual(pickRoute(off), ['as-today', true], 'a product ruling is the Human\'s today, under decide too');

  const uxBlock = { ...OPEN_DECISIONS, domains: { product: 'ask' } };
  const domains = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, uxBlock));
  assert.deepEqual(pickRoute(ledgerRoute(t, domains, routeLedger())), ['quorum', true], 'the product domain');
  assert.deepEqual(pickRoute(ledgerRoute(t, domains, routeLedger([], { ruling: ruled({ domain: 'ux' }) }), '--domain', 'ux')), ['quorum', false], 'or the one named, each read on its own');
});

test('quorum route --ledger: a base raised on the branch does not count, and a ledger that does not parse is a bad argument', (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'first' }));
  repo.git('checkout', '-q', '-b', 'feature');
  repo.setConfig(productConfig({ autoStart: true, approval: 'review-later' }));
  repo.git('commit', '-q', '-am', 'raise');
  assert.deepEqual(pickRoute(ledgerRoute(t, repo, routeLedger())), ['quorum', true]);
  const state = temp(t, 'aidrian-route-state-');
  write(state, 'broken.json', '{ not json');
  const broken = repo.raw('--ledger', path.join(state, 'broken.json'), '--domain', 'product');
  assert.deepEqual([broken.status, broken.stdout], [3, '']);
});

test('quorum route: a domain other than product or ux follows resolve as today, in both forms, whatever the settings say', (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const asked = ['--class', 'copy', '--reversible', 'no,no,no,no'];
  for (const [domain, wait, rule] of [['architecture', false, 'mode'], ['backlog', false, 'mode'], ['nonsense', true, 'unknown-domain']]) {
    for (const hard of [HARD, CLEAR, undefined]) {
      const out = repo.route('--domain', domain, ...asked, ...(hard ? ['--hard', hard] : []));
      assert.deepEqual([...pickRoute(out), out.resolve.rule], ['as-today', wait, rule], `${domain}, ${hard}`);
    }
    const after = ledgerRoute(t, repo, routeLedger([flip('users', false, false)], { ruling: ruled({ domain }) }), '--domain', domain);
    assert.deepEqual([...pickRoute(after), after.resolve.rule], ['as-today', true, rule], `${domain} after a ruling`);
    const mismatch = ledgerRoute(t, repo, routeLedger([flip('users', false, false)]), '--domain', domain);
    assert.deepEqual([...pickRoute(mismatch), mismatch.resolve], ['as-today', true, null], `${domain} after a product ruling asks resolve nothing`);
    assert.match(mismatch.reason, /is not a domain a quorum routes$/u, 'with no answer, it names none');
    assert.match(after.reason, /resolve's answer stands/u);
    assert.deepEqual(pickRoute(ledgerRoute(t, repo, routeLedger([], { status: 'open', human_answer: 'x' }), '--domain', domain)), ['as-today', true], `${domain} before any ledger rule`);
  }
  assert.equal(repo.route('--domain', 'ux', ...asked, '--hard', HARD).route, 'quorum', 'ux runs the quorum');
  assert.equal(repo.route('--domain', 'ux', ...asked, '--hard', CLEAR).route, 'agent', 'and a small ux call is the agent\'s');
  assert.deepEqual(pickRoute(ledgerRoute(t, repo, routeLedger([], { ruling: ruled({ domain: 'ux' }) }), '--domain', 'ux')), ['quorum', false]);
});

test('quorum route --ledger: --domain is required, so a ux ruling never resolves under product\'s laxer answer', (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, domains: { ux: 'ask' } }));
  const state = temp(t, 'aidrian-route-state-');
  write(state, 'ledger.json', JSON.stringify(routeLedger()));
  const none = repo.raw('--ledger', path.join(state, 'ledger.json'));
  assert.deepEqual([none.status, none.stdout], [3, '']);
  assert.match(none.stderr, /--ledger needs --domain/u);
  const ux = ledgerRoute(t, repo, routeLedger([], { ruling: ruled({ domain: 'ux' }) }), '--domain', 'ux');
  assert.deepEqual([...pickRoute(ux), ux.resolve.authority], ['quorum', true, 'ask']);
  assert.deepEqual(pickRoute(ledgerRoute(t, repo, routeLedger(), '--domain', 'product')), ['quorum', false]);
});

test('quorum route --ledger: the Human\'s answer governs, under either approval', (t) => {
  for (const approval of ['first', 'review-later']) {
    const repo = routeRepo(t, productConfig({ autoStart: true, approval }));
    for (const human_answer of ['No: take option B', 'Yes', '']) {
      const out = ledgerRoute(t, repo, routeLedger([flip('users', false, false)], { human_answer }));
      assert.deepEqual(pickRoute(out), ['human', true], `${approval}: ${human_answer}`);
      assert.match(out.reason, /the Human's answer governs/u);
    }
  }
  const off = routeRepo(t, productConfig({ autoStart: false }));
  assert.match(ledgerRoute(t, off, routeLedger([], { human_answer: 'Yes' })).reason, /the Human's answer governs/u, 'off too');
});

test('quorum route --ledger: a ledger that is not complete routes to human', (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const noStatus = routeLedger();
  delete noStatus.status;
  for (const [name, ledger] of [['open', routeLedger([], { status: 'open' })], ['missing', noStatus], ['another word', routeLedger([], { status: 'done' })]]) {
    assert.deepEqual(pickRoute(ledgerRoute(t, repo, ledger)), ['human', true], name);
  }
  assert.deepEqual(pickRoute(ledgerRoute(t, repo, routeLedger())), ['quorum', false], 'complete continues');
});

test('quorum route --ledger: a rule with no named winner, or a flips_if entry with no fact or how to settle it, routes to human', (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const noWinner = ruled();
  delete noWinner.winner;
  for (const [name, ruling] of [['missing', noWinner], ['null', ruled({ winner: null })], ['empty', ruled({ winner: '' })], ['blank', ruled({ winner: '  ' })], ['a number', ruled({ winner: 1 })]]) {
    assert.deepEqual(pickRoute(ledgerRoute(t, repo, routeLedger([], { ruling }))), ['human', true], `winner ${name}`);
  }
  const marks = { settles_from_repo: false, could_harden_undo: false };
  for (const [name, entry] of [
    ['no fact', { how_to_settle: 'ask', ...marks }],
    ['no how_to_settle', { fact: 'users', ...marks }],
    ['an empty fact', { fact: '', how_to_settle: 'ask', ...marks }],
    ['an empty how_to_settle', { fact: 'users', how_to_settle: ' ', ...marks }],
    ['an object for a fact', { fact: { a: 1 }, how_to_settle: 'ask', ...marks }],
    ['a number for how_to_settle', { fact: 'users', how_to_settle: 5, ...marks }],
  ]) {
    assert.deepEqual(pickRoute(ledgerRoute(t, repo, routeLedger([flip('fine', false, false), entry]))), ['human', true], name);
  }
});

test('routeAfterRuling: no combination with a resolve answer of ask, or a wait case, prints wait false', () => {
  const decide = { authority: 'decide', rule: 'mode', reason: 'r' };
  const asks = ['floor-class', 'unknown-class', 'escalate', 'escalate-doc', 'doc-outside-project', 'reversibility', 'domain-paused', 'maxMode', 'mode', 'no-base', 'unknown-domain'].map((rule) => ({ authority: 'ask', rule, reason: 'r' }));
  const noStatus = routeLedger();
  delete noStatus.status;
  const noAnswer = routeLedger();
  delete noAnswer.human_answer;
  const noWinner = ruled();
  delete noWinner.winner;
  const clean = [routeLedger(), routeLedger([flip('users', false, false)])];
  // Each ledger in the domain asked about, so it waits on its own rule and not on a domain that differs.
  const inDomain = (ledger, domain) => (ledger?.ruling ? { ...ledger, ruling: { ...ledger.ruling, domain } } : ledger);
  const waiting = [
    routeLedger([flip('code', true, false)]),
    routeLedger([flip('undo', false, true)]),
    routeLedger([flip('both', true, true)]),
    routeLedger([flip('unmarked')]),
    routeLedger([flip('half', false)]),
    routeLedger([{ settles_from_repo: false, could_harden_undo: false }]),
    routeLedger([{ fact: 'users', settles_from_repo: false, could_harden_undo: false }]),
    routeLedger([flip('users', false, false), flip('undo', false, true)]),
    routeLedger([], { human_answer: 'Yes' }),
    routeLedger([], { human_answer: '' }),
    noAnswer,
    routeLedger([], { status: 'open' }),
    noStatus,
    routeLedger([], { ruling: null }),
    routeLedger([], { ruling: ruled({ decision: 'escalate', winner: null }) }),
    routeLedger([], { ruling: ruled({ decision: 'escalate' }) }),
    routeLedger([], { ruling: ruled({ decision: 'accept' }) }),
    routeLedger([], { ruling: noWinner }),
    routeLedger([], { outcome: null }),
    routeLedger([], { mode: 'decide' }),
    routeLedger([], { trigger: 'the Human asked' }),
    routeLedger([], { trigger: "the route, with resolve's ask" }),
    routeLedger([], { trigger: undefined }),
    null,
    [],
    'a word',
  ];
  const settingsList = [false, true].flatMap((autoStart) => ['first', 'review-later', 'something else'].map((approval) => ({ autoStart, approval, maxAutoRuns: 3 })));
  for (const settings of settingsList) {
    for (const domain of ['product', 'ux', 'architecture', 'nonsense']) {
      const named = (ledger, answer) => JSON.stringify({ settings, domain, ledger, answer });
      for (const each of [...clean, ...waiting]) {
        const ledger = inDomain(each, domain);
        for (const answer of [...asks, { rule: 'no authority at all' }, null]) {
          assert.equal(routeAfterRuling(settings, ledger, answer, domain).wait, true, named(ledger, answer));
        }
      }
      for (const each of waiting) {
        const ledger = inDomain(each, domain);
        assert.equal(routeAfterRuling(settings, ledger, decide, domain).wait, true, named(ledger, decide));
      }
      for (const each of clean) {
        const ledger = inDomain(each, domain);
        const continues = settings.autoStart && settings.approval === 'review-later' && ['product', 'ux'].includes(domain);
        assert.equal(routeAfterRuling(settings, ledger, decide, domain).wait, !continues, named(ledger, decide));
        for (const other of [undefined, null, '', 'elsewhere', domain.toUpperCase()]) {
          const off = inDomain(each, other);
          assert.equal(routeAfterRuling(settings, off, decide, domain).wait, true, named(off, decide));
        }
      }
    }
  }
});

// A whole product ledger that `quorum check` reads, with every optional field a product ruling may leave behind.
const MARKED = { provisional: { marker: 'keep-one-ledger' } };
const carrying = (over = {}) => {
  const { ruling, outcome } = productLedger();
  return productLedger({
    trigger: ROUTE_DECIDE,
    ruling: { ...ruling, class: 'copy', reversible: 'no,no,no,no', docs: ['docs/rules.md'], domain: 'product', severity: 'low', reverts_by: 'revert the commit' },
    outcome: { ...outcome, flips_if: [{ fact: 'real users want it', how_to_settle: 'ask them', settles_from_repo: false, could_harden_undo: false }] },
    ...MARKED,
    ...over,
  });
};

test('product ledger: with none of the optional fields it passes, carrying all of them it passes, and check keeps them on disk', (t) => {
  const d = decideProject(t);
  const plain = productLedger();
  for (const field of ['class', 'reversible', 'docs', 'domain', 'severity', 'reverts_by']) assert.ok(!Object.hasOwn(plain.ruling, field), field);
  assert.deepEqual(Object.keys(plain.outcome.flips_if[0]), ['fact', 'how_to_settle']);
  assert.ok(!Object.hasOwn(plain, 'provisional'));
  assert.equal(d.check(plain).status, 0);
  const full = carrying();
  const result = d.check(full);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([result.ledger.ruling.domain, result.ledger.ruling.docs, result.ledger.ruling.reverts_by], ['product', ['docs/rules.md'], 'revert the commit']);
  assert.deepEqual(result.ledger.outcome.flips_if, full.outcome.flips_if);
  assert.deepEqual(result.ledger.provisional, MARKED.provisional);
  assert.equal(d.check(carrying({ ruling: { ...full.ruling, reversible: ['no', 'no', 'no', 'no'] } })).status, 0, 'reversible as a list, as route reads it');
});

test('product ledger: a new field off its shape stops the check, and a decide ledger admits none of them', (t) => {
  const d = decideProject(t);
  const full = carrying();
  const inRuling = (over) => ({ ruling: { ...full.ruling, ...over } });
  const inFlip = (over) => ({ outcome: { ...full.outcome, flips_if: [{ ...full.outcome.flips_if[0], ...over }] } });
  for (const [over, message] of [
    [inRuling({ class: 3 }), /\$\.ruling\.class must be string/u],
    [inRuling({ reversible: 3 }), /\$\.ruling\.reversible must be string or array/u],
    [inRuling({ reversible: [1] }), /\$\.ruling\.reversible\[0\] must be string/u],
    [inRuling({ docs: 'docs/rules.md' }), /\$\.ruling\.docs must be array/u],
    [inRuling({ docs: [1] }), /\$\.ruling\.docs\[0\] must be string/u],
    [inRuling({ domain: null }), /\$\.ruling\.domain must be string/u],
    [inRuling({ severity: 1 }), /\$\.ruling\.severity must be string/u],
    [inRuling({ reverts_by: 1 }), /\$\.ruling\.reverts_by must be string/u],
    [inRuling({ unknown: 'x' }), /\$\.ruling\.unknown is not a known field/u],
    [inFlip({ settles_from_repo: 'false' }), /settles_from_repo must be boolean/u],
    [inFlip({ could_harden_undo: null }), /could_harden_undo must be boolean/u],
    [{ provisional: 'keep-one-ledger' }, /\$\.provisional must be object/u],
    [{ provisional: null }, /\$\.provisional must be object/u],
    [{ provisional: {} }, /\$\.provisional\.marker is missing/u],
    [{ provisional: { marker: 1 } }, /\$\.provisional\.marker must be string/u],
    [{ provisional: { marker: 'a', why: 'b' } }, /\$\.provisional\.why is not a known field/u],
    [{ second_look: 'approved' }, /\$\.second_look must be object/u],
    [{ second_look: { agent: 'critic', sign_off: 'approved' } }, /\$\.second_look\.reason is missing/u],
    [{ second_look: { agent: 'critic', sign_off: 1, reason: 'r' } }, /\$\.second_look\.sign_off must be string/u],
    [{ second_look: { agent: 'critic', sign_off: 'approved', reason: 'r', by: 'x' } }, /\$\.second_look\.by is not a known field/u],
  ]) {
    const result = d.check(carrying(over));
    assert.equal(result.status, 1, JSON.stringify(over));
    assert.match(result.stderr, message);
  }
  assert.match(d.check(decideLedger({ ruling: decision({ domain: 'product' }) })).stderr, /\$\.ruling\.domain is not a known field/u);
  assert.match(d.check(decideLedger(MARKED)).stderr, /\$\.provisional is not a known field/u);
});

test('product ledger: a provisional ledger stays valid after a cited file changes, and an unmarked one does not', (t) => {
  const d = markedProject(t);
  assert.equal(d.check(productLedger()).status, 0);
  assert.equal(d.check(carrying()).status, 0);
  // The one file behind the winner's case, the ruling, and the premise, so each stale rule has a line to name.
  write(d.root, 'docs/decisions/0001-store.md', '# 1. Store\n\n## Decision\nImplementing it changed this.\n');
  const unmarked = d.check(productLedger());
  assert.equal(unmarked.status, 1, 'with no provisional and no answer, it is stale');
  for (const line of [/case A: the governing winner's case has no passing citation/u, /ruling: invalid: the ruling has no passing citation/u, /premise: invalid: no citation passes/u]) assert.match(unmarked.stderr, line);
  const marked = d.check(carrying());
  assert.equal(marked.status, 0, marked.stderr);
  assert.match(marked.stdout, /premise: invalid: no citation passes/u, 'what stopped passing is still named');
  assert.equal(d.check(carrying({ human_answer: 'approved' })).status, 0, 'and with the Human\'s answer too');
});

test('product ledger: the stale exemption stays for an unconfirmed or confirmed marker, and ends when it is rejected or not on record', (t) => {
  const { marker } = MARKED.provisional;
  const dead = /premise: invalid: no citation passes in a complete ledger/u;
  const changeCitation = (d) => write(d.root, 'docs/decisions/0001-store.md', '# 1. Store\n\n## Decision\nImplementing it changed this.\n');
  for (const [name, verb, holds, reason] of [
    ['unconfirmed', null, true, null],
    ['confirmed', 'confirmed', true, /the Human settled its marker/u],
    ['changed', 'changed', true, /the Human settled its marker/u],
    ['rejected', 'rejected', false, /was rejected/u],
    ['undone', 'undo', false, /is not on record/u],
  ]) {
    const d = markedProject(t);
    assert.equal(d.check(carrying()).status, 0, `${name}: before the change`);
    changeCitation(d);
    assert.equal(d.check(carrying()).status, 0, `${name}: the code changed, with the marker unconfirmed`);
    if (verb) {
      const moved = verb === 'undo' ? d.decisions('undo', marker) : d.decisions('set', marker, verb);
      assert.equal(moved.status, 0, moved.stderr);
    }
    const after = d.check(carrying());
    assert.equal(after.status, holds ? 0 : 1, `${name}: ${after.stderr}`);
    if (!holds) assert.match(after.stderr, dead, name);
    assert.match(readFileSync(d.file, 'utf8'), /"provisional"/u, 'a refused ledger stays on disk as it was');
    if (reason) {
      const routed = d.route();
      assert.deepEqual(pickRoute(routed), ['human', true], name);
      assert.match(routed.reason, reason, name);
    }
    assert.equal(d.check(carrying({ human_answer: 'approved' })).status, 0, `${name}: the Human's answer lifts it all`);
  }

  // The window the continue path uses: the writer has run, and its marker does not exist yet.
  const d = markedProject(t);
  const written = provisionalOn(d, bare(), '--plan', d.question, '--marker', 'not-written-yet');
  assert.equal(written.status, 0, written.stderr);
  assert.equal(d.check(written.ledger).status, 0, 'with its citations holding, a ledger with no marker yet still passes');
  assert.deepEqual(pickRoute(d.route()), ['human', true], 'and the route waits');
  changeCitation(d);
  const early = d.check(written.ledger);
  assert.equal(early.status, 1, 'a citation changed before the marker is on record');
  assert.match(early.stderr, dead);
});

test('product ledger: under provisional alone, a ruling no code change could break still stops the check, and an answer lifts even that', (t) => {
  const d = decideProject(t);
  const { ruling } = carrying();
  for (const [name, over, message] of [
    ['no verdicts at all', { ruling: { ...ruling, tested: [] } }, /ruling: invalid: .*of case A/u],
    ['a verdict on nothing it rules on', { ruling: { ...ruling, tested: [...ruling.tested, { of: 'Z9', citation: 0, supports: true, reason: 'r' }] } }, /ruling: invalid: tested names Z9/u],
    ['an inference it never ruled on', { cases: [stand('A', [PASSING.adr], 'the case\ninference: users want it'), stand('B', [PASSING.code])] }, /ruling: invalid: .*users want it/u],
    ['no verdict supports the winner', { ruling: { ...ruling, tested: tested({ A: 1, B: 1 }, ['A', 'B']) } }, /ruling: invalid: no verdict on the winner's case supports it/u],
  ]) {
    const first = d.check(carrying(over));
    assert.equal(first.status, 1, `${name}: ${first.stdout}`);
    assert.match(first.stderr, message, name);
    const answered = d.check(carrying({ ...over, human_answer: 'approved' }));
    assert.equal(answered.status, 0, `${name}, answered: ${answered.stderr}`);
  }
});

test('product ledger: provisional holds only on a ledger route could continue on, and beside a Human answer the answer governs', (t) => {
  const d = decideProject(t);
  const full = carrying();
  const withoutField = (key) => {
    const ruling = { ...full.ruling };
    delete ruling[key];
    return { ruling };
  };
  const escalate = { ...full.ruling, decision: 'escalate', winner: null, tested: [] };
  const flips = (entry) => ({ outcome: { ...full.outcome, flips_if: [{ ...full.outcome.flips_if[0], ...entry }] } });
  const unmarked = { ...full.outcome.flips_if[0] };
  delete unmarked.could_harden_undo;
  for (const [over, message] of [
    [{ ruling: escalate, outcome: null }, /provisional: the ruling escalates/u],
    [{ ruling: escalate, outcome: null, human_answer: 'A' }, /provisional: the ruling escalates/u],
    [{ status: 'open', ruling: null, outcome: null }, /provisional: the ledger is not complete/u],
    [{ status: 'open' }, /provisional: the ledger is not complete/u],
    [withoutField('class'), /provisional: the ledger lacks the Ruling's class, reversible, or docs/u],
    [withoutField('reversible'), /provisional: the ledger lacks the Ruling's class, reversible, or docs/u],
    [withoutField('docs'), /provisional: the ledger lacks the Ruling's class, reversible, or docs/u],
    [{ ruling: { ...full.ruling, reversible: 'no,maybe' } }, /provisional: the ledger lacks the Ruling's class, reversible, or docs/u],
    [withoutField('domain'), /provisional: the ruling names no domain/u],
    [{ ruling: { ...full.ruling, domain: ' ' } }, /provisional: the ruling names no domain/u],
    [withoutField('severity'), /provisional: the ledger lacks the Ruling's severity or reverts_by/u],
    [withoutField('reverts_by'), /provisional: the ledger lacks the Ruling's severity or reverts_by/u],
    [{ outcome: { ...full.outcome, flips_if: [unmarked] } }, /provisional: a flips_if entry lacks settles_from_repo or could_harden_undo/u],
    [flips({ could_harden_undo: true }), /provisional: a flipping fact could make the decision harder to undo/u],
  ]) {
    const result = d.check(carrying(over));
    assert.equal(result.status, 1, JSON.stringify(over));
    assert.match(result.stderr, message);
  }
  assert.equal(d.check(carrying(flips({ settles_from_repo: true }))).status, 0, 'a fact the repository can settle may still go on');
  const both = d.check(carrying({ human_answer: 'No: take option B' }));
  assert.equal(both.status, 0, both.stderr);
  assert.deepEqual([both.ledger.human_answer, both.ledger.provisional], ['No: take option B', MARKED.provisional], 'both stay on record');
  const settings = { autoStart: true, approval: 'review-later', maxAutoRuns: 3 };
  const { route, wait, reason } = routeAfterRuling(settings, both.ledger, { authority: 'decide', rule: 'mode', reason: 'r' }, 'product', 'unconfirmed');
  assert.deepEqual([route, wait], ['human', true]);
  assert.match(reason, /the Human's answer governs/u);
});

test('product ledger: provisional.marker holds an id a decision marker could hold, by the one predicate the marker parser uses', (t) => {
  const d = decideProject(t);
  const refused = ['', '  ', ' padded ', 'Not A Slug!', 'UPPER', '-lead', 'a\nb', 'a.b', 'x'.repeat(33)];
  for (const marker of refused) {
    assert.equal(isDecisionId(marker), false, JSON.stringify(marker));
    const result = d.check(carrying({ provisional: { marker } }));
    assert.equal(result.status, 1, JSON.stringify(marker));
    assert.match(result.stderr, /provisional: marker .* is no decision marker's id/u);
  }
  for (const marker of ['a', 'a-1', '1a', 'x'.repeat(32)]) {
    assert.equal(isDecisionId(marker), true, marker);
    assert.equal(d.check(carrying({ provisional: { marker } })).status, 0, marker);
  }
  const parsed = (id) => parseDecisions(`Rule.\n<!-- aidrian:decision id=${id} status=unconfirmed class=copy domain=product date=2026-11-01 pr=none -->\n`).decisions.length === 1;
  for (const id of ['UPPER', '-lead', 'a.b', 'x'.repeat(33), 'a', 'a-1', 'x'.repeat(32)]) assert.equal(parsed(id), isDecisionId(id), id);
});

// `aidrian quorum provisional` on `ledger`, written first, with what it left in the file.
function provisionalOn(d, ledger, ...flags) {
  const file = path.join(d.state, 'quorum/my-plan-abc.json');
  const text = JSON.stringify(ledger);
  writeFileSync(file, text);
  const r = spawnSync(CLI, ['quorum', 'provisional', file, ...(flags.length ? flags : ['--plan', d.question, '--marker', MARKED.provisional.marker])], { cwd: d.root, encoding: 'utf8', timeout: 30_000 });
  const after = readFileSync(file, 'utf8');
  return { ...r, untouched: after === text, ledger: JSON.parse(after) };
}
const bare = (over = {}) => {
  const { provisional, ...rest } = carrying(over);
  return rest;
};

test('quorum provisional writes the field only on a ledger that passes the check with no exemption, and check then holds it', (t) => {
  const d = markedProject(t);
  const done = provisionalOn(d, bare());
  assert.deepEqual([done.status, done.stderr], [0, '']);
  assert.deepEqual(done.ledger.provisional, MARKED.provisional);
  assert.match(done.stdout, /provisional: marker keep-one-ledger/u);
  assert.equal(d.check(done.ledger).status, 0, 'check reads what it wrote');
  const again = provisionalOn(d, carrying());
  assert.equal(again.status, 0, 'the same marker again changes nothing');
  assert.deepEqual(again.ledger.provisional, MARKED.provisional);
  const settle = bare({ outcome: { conditions: [], disputes: [], flips_if: [{ fact: 'f', how_to_settle: 'read it', settles_from_repo: true, could_harden_undo: false }] } });
  assert.equal(provisionalOn(d, settle).status, 0, 'a fact the repository can settle may still go on');
});

test('quorum provisional refuses an invalid ledger and leaves it as it found it', (t) => {
  const d = markedProject(t);
  const { ruling, outcome } = carrying();
  const dead = cite('doc', 'docs/missing.md#x', 'nope');
  for (const [name, ledger, message] of [
    ['a dead premise', bare({ premise: { summary: 'open', citations: [dead] } }), /premise: invalid: no citation passes/u],
    ['a dead ruling citation', bare({ ruling: { ...ruling, citations: [dead] } }), /ruling: invalid: the ruling has no passing citation/u],
    ['a winner whose case has no evidence', bare({ cases: [stand('A', [dead]), stand('B', [PASSING.code])] }), /governing winner's case has no passing citation/u],
    ['a persona-only winner', bare({ witness: { persona: PASSING.adr.ref.split('#')[0], interview: [], walkthrough: null } }), /rests only on the persona doc/u],
    ['no verdicts', bare({ ruling: { ...ruling, tested: [] } }), /ruling: invalid: /u],
    ['the same faults, already marked', carrying({ premise: { summary: 'open', citations: [dead] } }), /premise: invalid: no citation passes/u],
    ['an open ledger', bare({ status: 'open' }), /provisional: the ledger is not complete/u],
    ['an escalate', bare({ ruling: { ...ruling, decision: 'escalate', winner: null, tested: [] }, outcome: null }), /provisional: the ruling escalates/u],
    ['no class', bare({ ruling: { ...ruling, class: undefined } }), /provisional: the ledger lacks the Ruling's class/u],
    ['a fact that could harden the undo', bare({ outcome: { ...outcome, flips_if: [{ ...outcome.flips_if[0], could_harden_undo: true }] } }), /provisional: a flipping fact could make the decision harder to undo/u],
    ['an answered ledger', bare({ human_answer: 'approved' }), /the Human has answered/u],
    ['another marker on record', carrying({ provisional: { marker: 'another-one' } }), /already records another-one/u],
    ['off the schema', bare({ ruling: { ...ruling, class: 3 } }), /\$\.ruling\.class must be string/u],
    ['a decide ledger', decideLedger(), /only a product ledger/u],
  ]) {
    const result = provisionalOn(d, ledger);
    assert.equal(result.status, 1, `${name}: ${result.stdout}`);
    assert.match(result.stderr, message, name);
    assert.ok(result.untouched, `${name}: nothing written`);
  }
  write(d.root, 'docs/decisions/0001-store.md', '# 1. Store\n\n## Decision\nImplementing it changed this.\n');
  const stale = provisionalOn(d, bare());
  assert.deepEqual([stale.status, stale.untouched], [1, true], 'a cited file that changed before the record');
});

test('quorum provisional: a bad marker or argument exits 1, writes nothing, and names the form', (t) => {
  const d = markedProject(t);
  const file = path.join(d.state, 'quorum/my-plan-abc.json');
  for (const marker of ['', ' ', 'Not A Slug!', 'x'.repeat(33)]) {
    const result = provisionalOn(d, bare(), '--plan', d.question, '--marker', marker);
    assert.deepEqual([result.status, result.untouched], [1, true], JSON.stringify(marker));
  }
  for (const flags of [['--plan', d.question], ['--marker', 'a'], ['--plan', d.question, '--marker', 'a', '--bogus']]) {
    const result = provisionalOn(d, bare(), ...flags);
    assert.deepEqual([result.status, result.untouched], [1, true], flags.join(' '));
    assert.match(result.stderr, /usage: aidrian quorum provisional LEDGER --plan PLAN --marker ID/u, flags.join(' '));
  }
  const none = spawnSync(CLI, ['quorum', 'provisional', '--plan', d.question, '--marker', 'a'], { cwd: d.root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(none.status, 1);
  const unread = spawnSync(CLI, ['quorum', 'provisional', `${file}.missing`, '--plan', d.question, '--marker', 'a'], { cwd: d.root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(unread.status, 1);
});

test('quorum provisional reads the base branch\'s settings: it writes only where route continues or settles first', (t) => {
  const { ruling } = carrying();
  const review = productConfig({ autoStart: true, approval: 'review-later' });
  const uxRuling = { ruling: { ...ruling, domain: 'ux' } };
  for (const [name, config, over, message] of [
    ['approval first', productConfig({ autoStart: true, approval: 'first' }), {}, /route is quorum.*approval is first/u],
    ['first by default', productConfig({ autoStart: true }), {}, /approval is first/u],
    ['autoStart off', productConfig({ autoStart: false, approval: 'review-later' }), {}, /route is as-today.*autoStart is off/u],
    ['resolve says ask', productConfig({ autoStart: true, approval: 'review-later' }, {}), {}, /route is quorum.*resolve says ask/u],
    ['a floor class', review, { ruling: { ...ruling, class: 'money' } }, /route is quorum.*resolve says ask/u],
    ['hard to undo', review, { ruling: { ...ruling, reversible: 'yes,no,no,no' } }, /route is quorum.*resolve says ask/u],
    ['an unrouted domain', review, { ruling: { ...ruling, domain: 'architecture' } }, /route is as-today.*not a domain a quorum routes/u],
    ['its own domain asks', productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, domains: { ux: 'ask' } }), uxRuling, /route is quorum.*resolve says ask/u],
  ]) {
    const refused = provisionalOn(markedProject(t, config), bare(over));
    assert.equal(refused.status, 1, `${name}: ${refused.stdout}`);
    assert.match(refused.stderr, message, name);
    assert.ok(refused.untouched, `${name}: nothing written`);
  }
  assert.equal(provisionalOn(markedProject(t), bare(uxRuling)).status, 0, 'a ux ruling resolves under ux, not under the product default');

  const raised = markedProject(t, productConfig({ autoStart: true, approval: 'first' }));
  write(raised.root, '.aidrian/config.json', JSON.stringify({ version: 1, ...review }));
  raised.git('add', '.aidrian');
  raised.git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'raise');
  const stillFirst = provisionalOn(raised, bare());
  assert.deepEqual([stillFirst.status, stillFirst.untouched], [1, true], 'a branch raising approval over its base reads the base');

  const invalid = markedProject(t);
  write(invalid.root, '.aidrian/config.json', JSON.stringify({ version: 1, quorum: { product: { approval: 'later' } } }));
  const stopped = provisionalOn(invalid, bare());
  assert.deepEqual([stopped.status, stopped.untouched], [1, true], 'an invalid config.json stops it');
  assert.match(stopped.stderr, /"quorum\.product\.approval" must be/u);
});

// Every value of `trigger` but the one, for a run the Human started, one whose route asked, and near misses.
const OTHER_TRIGGERS = ['the Human asked', "the route, with resolve's ask", 'the route, with resolve\u2019s decide', "The route, with resolve's decide", `${ROUTE_DECIDE} `, 'the route', ''];

test('only a run the route started under decide continues: check on a provisional ledger, route --ledger, and the writer agree on each other trigger', (t) => {
  const d = markedProject(t);
  for (const trigger of OTHER_TRIGGERS) {
    const held = d.check(carrying({ trigger }));
    assert.equal(held.status, 1, `check: ${trigger}`);
    assert.match(held.stderr, /provisional: only a run the route started under resolve's decide continues/u, trigger);
    writeFileSync(d.file, JSON.stringify(bare({ trigger })));
    const routed = d.route();
    assert.deepEqual([...pickRoute(routed), routed.resolve.authority], ['human', true, 'decide'], `route: ${trigger}`);
    assert.match(routed.reason, /only a run the route started under resolve's decide continues/u, trigger);
    const written = provisionalOn(d, bare({ trigger }));
    assert.deepEqual([written.status, written.untouched], [1, true], `writer: ${trigger}`);
    assert.match(written.stderr, /only a run the route started under resolve's decide continues/u, trigger);
    assert.equal(d.check(bare({ trigger })).status, 0, `with no provisional, a ledger stays valid: ${trigger}`);
  }
  const { trigger: _, ...noTrigger } = bare();
  writeFileSync(d.file, JSON.stringify(noTrigger));
  assert.deepEqual(pickRoute(d.route()), ['human', true], 'read as JSON, no trigger at all continues nothing');
  assert.equal(d.check(carrying()).status, 0, 'the one value continues');
  assert.deepEqual(pickRoute(d.route()), ['quorum', false]);
});

test('a ledger of another trigger waits under every setting, and a hard-to-undo seed keeps resolve\'s own answer', (t) => {
  const decide = { authority: 'decide', rule: 'mode', reason: 'r' };
  for (const trigger of OTHER_TRIGGERS) {
    const ledger = routeLedger([flip('users', false, false)], { trigger });
    for (const autoStart of [false, true]) {
      for (const approval of ['first', 'review-later']) {
        assert.equal(routeAfterRuling({ autoStart, approval, maxAutoRuns: 3 }, ledger, decide, 'product').wait, true, `${trigger}, ${autoStart}, ${approval}`);
      }
    }
  }
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const asks = ledgerRoute(t, repo, routeLedger([], { trigger: "the route, with resolve's ask", ruling: ruled({ reversible: 'yes,no,no,no' }) }));
  assert.deepEqual([...pickRoute(asks), asks.resolve.authority], ['quorum', true, 'ask']);
});

test('quorum provisional refuses a ruling at or above the second look with no approved sign-off, and an unknown severity counts as above', (t) => {
  const approved = { agent: 'critic', sign_off: 'approved', reason: 'it holds' };
  const at = (severity, second_look) => {
    const { ruling } = carrying();
    return bare({ ruling: { ...ruling, severity }, ...(second_look ? { second_look } : {}) });
  };
  const d = markedProject(t);
  for (const severity of ['high', 'critical', 'major', 'blocker', 'dire']) {
    const refused = provisionalOn(d, at(severity));
    assert.deepEqual([refused.status, refused.untouched], [1, true], severity);
    assert.match(refused.stderr, /second look: critic must approve/u, severity);
    assert.equal(provisionalOn(d, at(severity, approved)).status, 0, `${severity}, approved`);
  }
  for (const sign_off of ['rejected', 'Approved', '']) {
    const refused = provisionalOn(d, at('high', { ...approved, sign_off }));
    assert.deepEqual([refused.status, refused.untouched], [1, true], sign_off);
    assert.match(refused.stderr, /second look: critic must approve/u, sign_off);
  }
  for (const severity of ['medium', 'low', 'nit']) assert.equal(provisionalOn(d, at(severity)).status, 0, `${severity} is below high`);
  const review = { autoStart: true, approval: 'review-later' };
  assert.equal(provisionalOn(markedProject(t, productConfig(review, { ...OPEN_DECISIONS, secondLook: null })), at('critical')).status, 0, 'null turns it off');
  const stricter = markedProject(t, productConfig(review, { ...OPEN_DECISIONS, secondLook: { agent: 'architect', minSeverity: 'medium' } }));
  const named = provisionalOn(stricter, at('medium'));
  assert.equal(named.status, 1);
  assert.match(named.stderr, /second look: architect must approve/u, 'the agent and the level come from the base branch');
  assert.equal(provisionalOn(stricter, at('low')).status, 0);
});

test('the writer and route --ledger share one route: the writer refuses a marker the Human settled or rejected, and takes one not yet on record', (t) => {
  for (const [answer, message] of [['confirmed', /the Human settled its marker keep-one-ledger/u], ['changed', /the Human settled its marker keep-one-ledger/u], ['rejected', /marker keep-one-ledger was rejected/u]]) {
    const d = markedProject(t);
    assert.equal(d.decisions('set', MARKED.provisional.marker, answer).status, 0, answer);
    for (const [name, ledger] of [['first write', bare()], ['already held', carrying()]]) {
      const refused = provisionalOn(d, ledger);
      assert.deepEqual([refused.status, refused.untouched], [1, true], `${answer}, ${name}`);
      assert.match(refused.stderr, message, `${answer}, ${name}`);
    }
  }
  const d = markedProject(t);
  const first = provisionalOn(d, bare(), '--plan', d.question, '--marker', 'not-written-yet');
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(pickRoute(d.route()), ['human', true], 'and route waits until that marker exists');
});

test('quorum provisional logs resolve\'s row with resolve\'s key, and a ledger the check refuses logs none', (t) => {
  const d = markedProject(t);
  const state = temp(t, 'aidrian-provisional-log-');
  const env = { ...process.env, XDG_STATE_HOME: state, CLAUDE_CODE_SESSION_ID: 'session-1' };
  const quorum = (...args) => spawnSync(CLI, ['quorum', ...args], { cwd: d.root, env, encoding: 'utf8', timeout: 30_000 });
  const rows = () => {
    const dir = spawnSync(CLI, ['state'], { cwd: d.root, env, encoding: 'utf8' }).stdout.trim();
    let text = '';
    try {
      text = readFileSync(path.join(dir, 'dispatch-log.jsonl'), 'utf8');
    } catch (error) {
      assert.equal(error.code, 'ENOENT');
    }
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter(({ event }) => event?.startsWith('decision_'));
  };
  const ledger = bare({ premise: { summary: 'open', citations: [cite('doc', 'docs/missing.md#x', 'nope')] } });
  writeFileSync(d.file, JSON.stringify(ledger));
  assert.equal(quorum('provisional', d.file, '--plan', d.question, '--marker', MARKED.provisional.marker).status, 1);
  assert.deepEqual(rows(), [], 'refused by the check, it asks resolve nothing');
  writeFileSync(d.file, JSON.stringify(bare()));
  assert.equal(quorum('route', '--ledger', d.file, '--domain', 'product').status, 0);
  const written = quorum('provisional', d.file, '--plan', d.question, '--marker', MARKED.provisional.marker);
  assert.equal(written.status, 0, written.stderr);
  const [routed, recorded, ...rest] = rows();
  assert.deepEqual(rest, []);
  assert.deepEqual([recorded.event, recorded.rule, recorded.domain, recorded.class, recorded.key], ['decision_made', 'mode', 'product', 'copy', routed.key]);
});

// A committed project `quorum check`, `quorum provisional`, and `route --ledger` all read, with one decision marker on record.
function markedProject(t, config = productConfig({ autoStart: true, approval: 'review-later' })) {
  const d = decideProject(t);
  const { marker } = MARKED.provisional;
  write(d.root, '.aidrian/config.json', JSON.stringify({ version: 1, ...config }));
  write(d.root, '.aidrian/knowledge/10-docs.json', JSON.stringify({ dir: 'docs', description: 'The rules.', docs: { 'decided.md': { summary: 'decided rules', tags: [] } } }));
  write(d.root, 'docs/decided.md', `# Decided\n\nOne ledger holds it.\n<!-- aidrian:decision id=${marker} status=unconfirmed class=copy domain=product date=2026-11-01 pr=none -->\n<!-- aidrian:decision-new id=${marker} text="One ledger holds it." -->\n`);
  d.git('add', '.aidrian', 'docs');
  d.git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'project');
  d.git('checkout', '-q', '-b', 'feature');
  const file = path.join(d.state, 'quorum/my-plan-abc.json');
  const route = (domain = 'product') => {
    const r = spawnSync(CLI, ['quorum', 'route', '--ledger', file, '--domain', domain], { cwd: d.root, encoding: 'utf8', timeout: 30_000 });
    assert.deepEqual([r.status, r.stderr], [0, '']);
    return JSON.parse(r.stdout);
  };
  const decisions = (...args) => spawnSync(CLI, ['decisions', ...args], { cwd: d.root, encoding: 'utf8', timeout: 30_000 });
  return { ...d, file, route, decisions };
}

test('quorum check, then quorum route --ledger on the same file: the ledger check passes is the one route continues on', (t) => {
  const d = markedProject(t);
  const checked = d.check(carrying());
  assert.equal(checked.status, 0, checked.stderr);
  const out = d.route();
  assert.deepEqual([...pickRoute(out), out.resolve.authority], ['quorum', false, 'decide'], out.reason);
  assert.deepEqual(out.listed, [{ fact: 'real users want it', how_to_settle: 'ask them' }]);

  // The one writer, then both readers, on one file, with a fact the repository settles first.
  const flips = [{ fact: 'the code allows it', how_to_settle: 'read it', settles_from_repo: true, could_harden_undo: false }];
  const written = provisionalOn(d, bare({ outcome: { conditions: [], disputes: [], flips_if: flips } }));
  assert.equal(written.status, 0, written.stderr);
  assert.equal(d.check(written.ledger).status, 0);
  const settling = d.route();
  assert.deepEqual([...pickRoute(settling), settling.settle], ['quorum', true, [{ fact: 'the code allows it', how_to_settle: 'read it' }]]);
});

test('quorum route --ledger: a provisional ledger continues only while its marker is unconfirmed', (t) => {
  for (const answer of ['confirmed', 'changed']) {
    const settled = markedProject(t);
    assert.equal(settled.check(carrying()).status, 0);
    assert.deepEqual(pickRoute(settled.route()), ['quorum', false], 'unconfirmed continues');
    const set = settled.decisions('set', MARKED.provisional.marker, answer);
    assert.equal(set.status, 0, set.stderr);
    const out = settled.route();
    assert.deepEqual(pickRoute(out), ['human', true], answer);
    assert.match(out.reason, /the Human settled its marker keep-one-ledger, so read the rule in its doc/u, answer);
  }

  // Any copy the Human settled counts, whichever the scan reads first.
  const twice = markedProject(t);
  write(twice.root, '.aidrian/knowledge/10-docs.json', JSON.stringify({ dir: 'docs', description: 'The rules.', docs: { 'decided.md': { summary: 'decided rules', tags: [] }, 'other.md': { summary: 'other rules', tags: [] } } }));
  write(twice.root, 'docs/other.md', `# Other\n\nAnother line.\n<!-- aidrian:decision id=${MARKED.provisional.marker} status=confirmed class=copy domain=product date=2026-11-01 pr=none -->\n<!-- aidrian:decision-new id=${MARKED.provisional.marker} text="Another line." -->\n`);
  assert.equal(twice.check(carrying()).status, 0);
  assert.deepEqual(pickRoute(twice.route()), ['human', true], 'one settled copy');

  const rejected = markedProject(t);
  assert.equal(rejected.check(carrying()).status, 0);
  const set = rejected.decisions('set', MARKED.provisional.marker, 'rejected');
  assert.equal(set.status, 0, set.stderr);
  const afterReject = rejected.route();
  assert.deepEqual(pickRoute(afterReject), ['human', true]);
  assert.match(afterReject.reason, /marker keep-one-ledger was rejected/u);

  const undone = markedProject(t);
  assert.equal(undone.check(carrying()).status, 0);
  const undo = undone.decisions('undo', MARKED.provisional.marker);
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(undone.check(carrying()).status, 0, 'the record stays valid');
  const afterUndo = undone.route();
  assert.deepEqual(pickRoute(afterUndo), ['human', true]);
  assert.match(afterUndo.reason, /marker keep-one-ledger is not on record/u);

  const never = markedProject(t);
  assert.equal(never.check(carrying({ provisional: { marker: 'never-written' } })).status, 0);
  assert.deepEqual(pickRoute(never.route()), ['human', true], 'a marker no doc holds');

  // Read as JSON, a field off its shape reads as no marker at all, and the Human's answer still comes first.
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  for (const provisional of [null, 'x', {}, { marker: '' }, { marker: 3 }]) assert.deepEqual(pickRoute(ledgerRoute(t, repo, routeLedger([], { provisional }))), ['human', true], JSON.stringify(provisional));
  assert.match(ledgerRoute(t, repo, routeLedger([], { provisional: { marker: 'gone' }, human_answer: 'Yes' })).reason, /the Human's answer governs/u);
  assert.deepEqual(pickRoute(ledgerRoute(t, repo, routeLedger())), ['quorum', false], 'no provisional, nothing to look up');
});

test('quorum route --ledger: a ledger that passed check continues under review later, so the two read the same fields', (t) => {
  const d = decideProject(t);
  const { status, ledger: checked, stderr } = d.check(carrying());
  assert.equal(status, 0, stderr);
  const decide = { authority: 'decide', rule: 'mode', reason: 'r' };
  const { route, wait, listed } = routeAfterRuling({ autoStart: true, approval: 'review-later', maxAutoRuns: 3 }, checked, decide, 'product', 'unconfirmed');
  assert.deepEqual([route, wait, listed], ['quorum', false, [{ fact: 'real users want it', how_to_settle: 'ask them' }]]);
  assert.deepEqual(pickRoute(routeAfterRuling({ autoStart: true, approval: 'review-later', maxAutoRuns: 3 }, checked, decide, 'ux', 'unconfirmed')), ['human', true], 'a product ruling never routes as ux');
  assert.deepEqual(pickRoute(routeAfterRuling({ autoStart: true, approval: 'review-later', maxAutoRuns: 3 }, checked, decide, 'product')), ['human', true], 'and its marker must be on record');
});

test('quorum route --ledger: only a ruling in the domain named continues, and any other asks resolve nothing', (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const inDomain = (domain) => routeLedger([], { ruling: ruled({ domain }) });
  for (const domain of ['product', 'ux']) {
    const same = ledgerRoute(t, repo, inDomain(domain), '--domain', domain);
    assert.deepEqual([...pickRoute(same), same.resolve.authority], ['quorum', false, 'decide'], domain);
  }
  const noDomain = ruled();
  delete noDomain.domain;
  const missing = ledgerRoute(t, repo, routeLedger([], { ruling: noDomain }));
  assert.deepEqual([...pickRoute(missing), missing.resolve], ['human', true, null], 'a ruling with no domain, as on a reused ledger');
  assert.match(missing.reason, /names no domain/u);
  for (const [domain, named] of [['', 'product'], [' ', 'ux'], [null, 'product'], [3, 'ux']]) {
    const blank = ledgerRoute(t, repo, inDomain(domain), '--domain', named);
    assert.deepEqual([...pickRoute(blank), blank.resolve], ['human', true, null], `${domain} routed as ${named}`);
    assert.match(blank.reason, /names no domain/u);
  }
  for (const [domain, named] of [['ux', 'product'], ['product', 'ux'], ['PRODUCT', 'product']]) {
    const differs = ledgerRoute(t, repo, inDomain(domain), '--domain', named);
    assert.deepEqual([...pickRoute(differs), differs.resolve], ['human', true, null], `${domain} routed as ${named}`);
    assert.match(differs.reason, /is in the domain/u);
  }

  // The harm itself: a ux ruling routed as product, where the team keeps ux with the Human.
  const uxAsks = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, domains: { ux: 'ask' } }));
  assert.deepEqual(pickRoute(ledgerRoute(t, uxAsks, inDomain('ux'))), ['human', true], 'a ux ruling routed as product');
  const underUx = ledgerRoute(t, uxAsks, inDomain('ux'), '--domain', 'ux');
  assert.deepEqual([...pickRoute(underUx), underUx.resolve.authority], ['quorum', true, 'ask'], 'and under its own domain it waits on its own answer');

  const off = routeRepo(t, productConfig({ autoStart: false }));
  assert.deepEqual(pickRoute(ledgerRoute(t, off, routeLedger([], { ruling: noDomain }))), ['human', true], 'under autoStart off too');
  assert.deepEqual(pickRoute(ledgerRoute(t, off, inDomain('product'))), ['as-today', true], 'and in its domain, as today');

  // The rules that come first keep their own reason, so a reused ledger the Human answered still reads as answered.
  assert.match(ledgerRoute(t, repo, routeLedger([], { ruling: noDomain, human_answer: 'Yes' })).reason, /the Human's answer governs/u);
  assert.match(ledgerRoute(t, repo, routeLedger([], { ruling: { ...noDomain, decision: 'escalate', winner: null } })).reason, /the ruling escalates/u);
  const elsewhere = ledgerRoute(t, repo, routeLedger([], { ruling: noDomain }), '--domain', 'architecture');
  assert.deepEqual([...pickRoute(elsewhere), elsewhere.resolve], ['as-today', true, null], 'a domain no quorum routes stays as it is, and logs nothing on a mismatch');
  const itsOwn = ledgerRoute(t, repo, inDomain('architecture'), '--domain', 'architecture');
  assert.deepEqual([...pickRoute(itsOwn), itsOwn.resolve.rule], ['as-today', true, 'mode'], 'with the domain matching, resolve answers');
});

test('quorum: the fall-through usage names route, and its flags stay out of USAGE, which holds to the quorum skill\'s flags', (t) => {
  const { root } = routeRepo(t, {});
  const r = spawnSync(CLI, ['quorum', 'nonsense'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: aidrian quorum codex .*\| route --domain D --class C .*\| route --ledger LEDGER --domain D/u);
  assert.doesNotMatch(commands.quorum.usage, /route/u);
  assert.match(r.stderr, /\| provisional LEDGER --plan PLAN --marker ID/u);
  assert.doesNotMatch(commands.quorum.usage, /provisional|--marker/u);
  assert.match(commands.quorum.about, /with provisional/u);
  assert.match(commands.quorum.about, /with route/u);
});

test('the docs state what automatic product quorums cost and what they can ship', () => {
  const config = readFileSync(path.resolve(import.meta.dirname, '../docs/config.md'), 'utf8').replace(/\s+/gu, ' ');
  for (const line of [
    '`autoStart` alone decides nothing while `decisions` resolves to `ask`',
    'a team commits `decide-reversible` for a small, clear decision to be the agent\'s alone',
    'at most 22 dispatches with the default `maxLoops`, plus one read-only `explorer` dispatch for the settle step',
    '`review-later` with auto-merge can ship a choice no person reviewed',
    'Winners have varied between runs',
  ]) assert.ok(config.includes(line), line);
  const folder = readFileSync(path.resolve(import.meta.dirname, '../docs/project-folder.md'), 'utf8').replace(/\s+/gu, ' ');
  assert.ok(folder.includes('`aidrian quorum route --ledger LEDGER --domain D` reads LEDGER as JSON, and never runs `quorum check` on it'));
  assert.ok(folder.includes('Any domain other than `product` or `ux` is `as-today`'));
  assert.ok(folder.includes('the Human\'s answer governs'));
  assert.ok(folder.includes('For `--domain product` or `ux`, the route is `human` when `ruling.domain` is missing or differs from `--domain`'));
  assert.ok(folder.includes('`provisional` is valid on a `rule` and never on an `escalate`'));
  assert.ok(folder.includes('`aidrian quorum provisional LEDGER --plan PLAN --marker ID` is the one writer of `provisional`'));
  assert.ok(folder.includes('when its marker was rejected or is not on record'));
  assert.ok(folder.includes('the route is `human` when its marker is `confirmed`'));
  assert.ok(folder.includes('`check` cannot tell who wrote the field'));
  assert.ok(folder.includes('`check` reads no settings'));
  assert.ok(folder.includes('refuses unless the route is `quorum` with `wait` false or a `settle` list'));
  assert.ok(config.includes('Only a `product` or `ux` call routes'));
  const log = readFileSync(path.resolve(import.meta.dirname, '../docs/dispatch-log.md'), 'utf8').replace(/\s+/gu, ' ');
  assert.ok(log.includes('`aidrian quorum route` and `aidrian quorum provisional` write the same row, with the same `key`'));
  assert.match(readFileSync(path.resolve(import.meta.dirname, '../README.md'), 'utf8'), /\| `aidrian quorum` \|[^|]*one product decision/u);
});

test('an inference line matches past a curly or straight quote, and still fails on a real difference', () => {
  const claim = 'inference: The Human\u2019s \u201Cview\u201D is unclear.';
  assert.deepEqual(inferenceProblems([claim], [{ statement: 'The Human\'s "view" is unclear.' }]), []);
  assert.deepEqual(inferenceProblems(['inference: The Human\'s view is unclear.'], [{ statement: 'The Human\u2019s view is unclear.' }]), []);
  assert.equal(inferenceProblems([claim], [{ statement: 'The Human\'s "view" is clear.' }]).length, 1);
});
