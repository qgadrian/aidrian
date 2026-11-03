import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { CASE_SCHEMA, CODEX_TIMEOUT_SEC, CROSS_SCHEMA, DECIDE_LEDGER_SCHEMA, DECIDE_REBUTTAL_SCHEMA, GROUNDS, LEDGER_SCHEMA, LEDGER_SCHEMAS, MAX_MODE_OBJECTIONS, MAX_OBJECTIONS, OBJECTIONS_SCHEMA, REBUTTALS_SCHEMA, codexAnswer, commands, governingWinner, modeOf, rebuttalProblems, schemaProblems } from '../plugins/aidrian/lib/quorum.mjs';
import { slug } from '../plugins/aidrian/lib/review/flows.mjs';
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
const ledger = (objections) => ({ status: 'open', plan: 'my-plan.md', plan_hash: 'abc', same_model: false, same_model_reason: null, trigger: 'critical flow gate', objections, human_answers: [] });

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

  // The ledger is no Codex answer: every field is required except those a ledger written before `mode` lacks, and only those.
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

test('check: every citation kind passes; anchors by heading text and by slug; quotes compare with whitespace collapsed; plan and ledger outside the root', (t) => {
  const p = project(t);
  // Ids as the ledger writes them: A1 to A7, then B1 on.
  const objections = Object.values(PASSING).map((citation, i) => objection(i < 7 ? `A${i + 1}` : `B${i - 6}`, [citation]));
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
    objection('A6', [cite('plan', '#risks', 'Store the ledger')]),
    objection('A7', [cite('absence', 'src', 'export function book')]),
    objection('B1', [cite('code', 'src/app.js:1', 'x'.repeat(201))]),
    objection('B2', [cite('code', 'src/app.js:1', 'nope'), PASSING.code]),
  ];
  const result = p.check(ledger(failing));
  assert.equal(result.status, 0, result.stderr);
  const statuses = Object.fromEntries(result.ledger.objections.map((each) => [each.id, each.status]));
  assert.deepEqual(statuses, { A1: 'opinion', A2: 'opinion', A3: 'opinion', A4: 'opinion', A5: 'opinion', A6: 'opinion', A7: 'opinion', B1: 'opinion', B2: 'pending' });
  const has = (pattern) => assert.ok(result.lines.some((line) => pattern.test(line)), `${pattern}\n${result.stdout}`);
  has(/^objection A1\.citations\[0\] \(doc docs\/rules\.md#refunds\): docs\/rules\.md#refunds does not contain the quote$/u);
  has(/^objection A1: relabeled opinion \(was pending\): no citation passes$/u);
  has(/^objection A2\.citations\[0\] .*: docs\/nope\.md is missing$/u);
  has(/^objection A3\.citations\[0\] .*: docs\/decisions\/0001-store\.md has no heading #context$/u);
  has(/^objection A4\.citations\[0\] .*: src\/app\.js does not contain the quote$/u);
  has(/^objection A5\.citations\[0\] .*: "src\/app\.js" is not path:line$/u);
  has(/^objection A6\.citations\[0\] .*: the plan#risks does not contain the quote$/u);
  has(/^objection A7\.citations\[0\] .*: src\/app\.js contains the quote$/u);
  has(/^objection B1\.citations\[0\] .*: the quote is 201 characters, more than 200$/u);
  assert.ok(!result.lines.some((line) => line.startsWith('objection B2:')), 'one passing citation keeps the objection');
  assert.equal(result.lines.at(-1), `checked: mode plan, 9 objections, 8 opinion, ${result.lines.length - 1} problems`);
});

test('check: an objection already ruled on keeps its status when its citations stop passing, and is named', (t) => {
  const p = project(t);
  // A complete ledger at this hash is reused when check exits 0: the cited code changed since, and an accepted objection,
  // one the Human answered, must not drop to an opinion and out of the report.
  const stale = [cite('code', 'src/app.js:1', 'export const app = 2;')];
  const ruled = (decision) => ({ decision, change_or_reason: 'r', citations: [PASSING.adr] });
  const before = { ...ledger([
    objection('A1', stale, { status: 'accepted', ruling: ruled('accept') }),
    objection('A2', stale, { status: 'rejected', ruling: ruled('reject'), rebuttal: { verdict: 'concede', claim: 'ok', citations: [], ruling: null } }),
    objection('A3', stale, { status: 'escalated', ruling: ruled('escalate') }),
  ]), status: 'complete', human_answers: [{ objection_id: 'A1', answer: 'yes, change it' }] };
  const result = p.check(before);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ledger.objections.map((each) => each.status), ['accepted', 'rejected', 'escalated']);
  for (const [id, status] of [['A1', 'accepted'], ['A2', 'rejected'], ['A3', 'escalated']]) {
    assert.ok(result.lines.includes(`objection ${id}: no citation passes; kept ${status}, since it was ruled on`), result.stdout);
  }
  assert.ok(!result.lines.some((line) => line.includes('relabeled')), result.stdout);
  assert.equal(result.lines.at(-1), 'checked: mode plan, 3 objections, 0 opinion, 6 problems');
});

test('check: a ruling, or a rebuttal that rebuts, with no passing citation is invalid; a concession needs none', (t) => {
  const p = project(t);
  const noProof = [cite('code', 'src/app.js:1', 'not there')];
  const result = p.check(ledger([
    objection('A1', [PASSING.code], { status: 'rejected', ruling: { decision: 'reject', change_or_reason: 'r', citations: noProof }, rebuttal: { verdict: 'rebut', claim: 'c', citations: [], ruling: { decision: 'reject', change_or_reason: 'r', citations: [PASSING.adr] } } }),
    objection('A2', [PASSING.code], { status: 'rejected', ruling: { decision: 'reject', change_or_reason: 'r', citations: [PASSING.plan] }, rebuttal: { verdict: 'concede', claim: 'ok', citations: [], ruling: null } }),
  ]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection A1 ruling: invalid: the ruling has no passing citation'), result.stdout);
  assert.ok(result.lines.includes('objection A1 rebuttal: invalid: the rebuttal has no passing citation'), result.stdout);
  assert.ok(!result.lines.some((line) => line.startsWith('objection A2')), result.stdout);
  assert.deepEqual(result.ledger.objections.map((each) => each.status), ['rejected', 'rejected']);
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
const RULED = ledger([
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
  const ruled = { decision: 'reject', change_or_reason: 'r', citations: [PASSING.adr] };
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
  const ruled = { decision: 'reject', change_or_reason: 'r', citations: [PASSING.adr] };
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
    const before = { ...ledger(objections), status: 'complete' };
    const result = p.check(before);
    assert.equal(result.status, 1, message.source);
    assert.match(result.stderr, message);
    assert.deepEqual(result.ledger, before);
  }
  const done = p.check({ ...ledger([objection('A3', [PASSING.code], { status: 'accepted', ruling: ruled }), objection('A4', [cite('code', 'src/app.js:1', 'nope')], { status: 'opinion' })]), status: 'complete' });
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
  const before = p.check({ ...ledger(objections()), status: 'complete' });
  assert.equal(before.status, 0, before.stderr);
  write(p.root, 'src/app.js', 'export const app = 1;\nexport function reserve(slot) {\n  return slot;\n}\n');

  const complete = { ...ledger(objections()), status: 'complete' };
  const refused = p.check(complete);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /objection A1 ruling: invalid: the ruling has no passing citation in a complete ledger$/mu);
  assert.deepEqual(refused.ledger, complete, 'not written back');

  const open = p.check(ledger(objections()));
  assert.equal(open.status, 0, open.stderr);
  assert.ok(open.lines.includes('objection A1 ruling: invalid: the ruling has no passing citation'), open.stdout);

  // An invalid rebuttal, or an invalid final ruling on one, is stale the same way.
  // A rebuttal the architect accepted at the final ruling: the objection is accepted.
  const rebutted = (rebuttal) => ({ ...ledger([objection('B1', [PASSING.adr], { by: 'B', status: 'accepted', ruling: ruled('reject', [PASSING.plan]), rebuttal })]), status: 'complete' });
  for (const [entry, line] of [
    [{ verdict: 'rebut', claim: 'c', citations: [evidence], ruling: ruled('accept', [PASSING.fenced]) }, /objection B1 rebuttal: invalid: the rebuttal has no passing citation in a complete ledger$/mu],
    [{ verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling: ruled('accept') }, /objection B1 rebuttal ruling: invalid: the ruling has no passing citation in a complete ledger$/mu],
  ]) {
    const result = p.check(rebutted(entry));
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, line);
  }

  // The Human settled these: an escalated objection keeps its invalid ruling, and an answered one stands on the answer.
  const settled = p.check({ ...ledger([
    objection('A1', [PASSING.adr], { status: 'escalated', ruling: ruled('reject') }),
    objection('A2', [PASSING.adr], { status: 'accepted', ruling: ruled('escalate') }),
  ]), status: 'complete', human_answers: [{ objection_id: 'A2', answer: 'accept it' }] });
  assert.equal(settled.status, 0, settled.stderr);
  assert.ok(settled.lines.includes('objection A1 ruling: invalid: the ruling has no passing citation'), settled.stdout);

  // A valid partial accept escalated on its rejected part: the accepted part still stands, so its stale first ruling
  // is refused even though the objection is escalated. An accept escalated whole (no rebuttal) is the Human's.
  const partial = p.check({ ...ledger([
    objection('B1', [PASSING.adr], { by: 'B', status: 'escalated', ruling: ruled('accept'), rebuttal: { verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling: ruled('reject', [PASSING.plan]) } }),
  ]), status: 'complete' });
  assert.equal(partial.status, 1, partial.stdout);
  assert.match(partial.stderr, /objection B1 ruling: invalid: the ruling has no passing citation in a complete ledger$/mu);
  const whole = p.check({ ...ledger([objection('B1', [PASSING.adr], { by: 'B', status: 'escalated', ruling: ruled('accept') })]), status: 'complete' });
  assert.equal(whole.status, 0, whole.stderr);
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
    const before = { ...ledger([objection('B1', [PASSING.code], { by: 'B', ...fields })]), status: 'complete' };
    const result = p.check(before);
    assert.equal(result.status, 1, message.source);
    assert.match(result.stderr, message);
    assert.deepEqual(result.ledger, before, 'not written back');
    // The same ledger still open is mid-run: no complete-ledger problem.
    assert.equal(p.check({ ...before, status: 'open' }).status, 0, message.source);
  }
  // Finished ledgers pass: a rebuttal accepted at the final ruling, a concession that keeps the first ruling, an
  // escalated rebuttal, and an unruled rebuttal or a mismatched status that the Human's answer settled.
  const good = p.check({ ...ledger([
    objection('B1', [PASSING.code], { by: 'B', status: 'accepted', ruling: ruled('reject'), rebuttal: rebut(ruled('accept')) }),
    objection('B2', [PASSING.code], { by: 'B', status: 'rejected', ruling: ruled('reject'), rebuttal: concede }),
    objection('B3', [PASSING.code], { by: 'B', status: 'escalated', ruling: ruled('reject'), rebuttal: rebut(ruled('reject')) }),
    objection('B4', [PASSING.code], { by: 'B', status: 'escalated', ruling: ruled('reject'), rebuttal: rebut(null) }),
    objection('B5', [PASSING.code], { by: 'B', status: 'rejected', ruling: ruled('reject'), rebuttal: rebut(ruled('reject')) }),
    objection('A1', [PASSING.code], { status: 'accepted', ruling: ruled('escalate') }),
  ]), status: 'complete', human_answers: [{ objection_id: 'B5', answer: 'keep it out' }, { objection_id: 'A1', answer: 'do it' }] });
  assert.equal(good.status, 0, good.stderr);
});

test('check: a ref that is not a relative path is a failed citation, not an escape', (t) => {
  const p = project(t);
  const refs = [cite('doc', 'docs\\rules.md#refunds', 'refund'), cite('doc', 'docs//rules.md#refunds', 'refund'), cite('doc', '#refunds', 'refund'), cite('code', ':3', 'x'), cite('absence', '', 'x'), cite('code', '.:1', 'x')];
  const result = p.check(ledger(refs.map((citation, i) => objection(`A${i + 1}`, [citation]))));
  assert.equal(result.status, 0, result.stderr);
  for (const [i, citation] of refs.entries()) {
    assert.ok(result.lines.includes(`objection A${i + 1}.citations[0] (${citation.kind} ${citation.ref}): "${citation.ref}" is not a relative path`), `${citation.ref}\n${result.stdout}`);
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
  const escalated = ledger([
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

// ledger.md § Fields: each bullet starts with a field path in backticks; its text runs to the next bullet.
function documentedFields() {
  const text = readFileSync(path.join(SKILL, 'references/ledger.md'), 'utf8');
  const section = text.split('\n## Fields\n')[1].split('\n## ')[0];
  const bullets = new Map();
  let current = null;
  for (const line of section.split('\n')) {
    const bullet = /^\s*- `([^`]+)`/u.exec(line);
    if (bullet) {
      current = bullet[1];
      assert.ok(!bullets.has(current), `ledger.md names ${current} twice`);
      bullets.set(current, line);
    } else if (current && line.trim()) bullets.set(current, `${bullets.get(current)} ${line}`);
  }
  return { text, bullets };
}

test('ledger.md names every field of LEDGER_SCHEMA and no other, its enum values both ways, null where the schema allows it, and keeps no schema copy', () => {
  const { text, bullets } = documentedFields();
  const schema = fieldPaths(LEDGER_SCHEMA);
  // The plan-mode fields are in the schema, so the list below holds ledger.md to them too.
  const fields = new Map(schema.map(({ field, node }) => [field, node]));
  for (const field of ['mode', 'notes', 'objections[].merged_into', 'objections[].ruling.tested', 'objections[].ruling.inferences', 'objections[].ruling.ground', 'proportionality']) assert.ok(fields.has(field), `LEDGER_SCHEMA has ${field}`);
  assert.deepEqual(fields.get('objections[].ruling.ground').enum, ['covered', 'implementation', 'settled', 'off-goal', 'disproportionate', 'speculative']);
  assert.ok(fields.get('objections[].status').enum.includes('merged'));
  assert.deepEqual([...bullets.keys()].sort(), schema.map((each) => each.field).sort());
  for (const { field, node } of schema) {
    const bullet = bullets.get(field);
    const enumValues = node.enum ?? node.items?.enum;
    if (enumValues) {
      for (const value of enumValues) assert.ok(bullet.includes(`\`${value}\``), `ledger.md: ${field} does not name ${value}`);
      // After the field path, every backticked word in an enum field's bullet is one of its values.
      const named = [...bullet.matchAll(/`([^`]+)`/gu)].slice(1).map((match) => match[1]);
      for (const value of named) assert.ok(enumValues.includes(value), `ledger.md: ${field} names ${value}, not in its enum`);
    }
    const nullable = [node.type].flat().includes('null');
    assert.equal(bullet.includes('`null`'), nullable, `ledger.md: ${field} ${nullable ? 'does not say' : 'says'} \`null\``);
  }
  for (const name of ['LEDGER_SCHEMA', 'OBJECTIONS_SCHEMA', 'REBUTTALS_SCHEMA']) assert.ok(text.includes(`\`${name}\``), `ledger.md names ${name}`);
  assert.doesNotMatch(text, /```json/u, 'ledger.md keeps no JSON copy of a schema');
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
  assert.match(plan, /The cap is 8 dispatches: one is reserved for the proportionality pass, and no other dispatch may spend it/u, 'the cap');
  assert.match(plan, /When the pass returns no usable answer, write `proportionality: \{flagged: \[\]\}` too, with no retry, and the report says the pass failed/u, 'a failed pass');
  assert.match(plan, /appends its citations to the survivor's `citations`, so the architect's `tested` covers them/u, 'a merge moves its evidence to the survivor');
  assert.doesNotMatch(plan, /also cited by/u, 'no separate merged-citation line');
  assert.match(plan, new RegExp(`at most ${MAX_MODE_OBJECTIONS} objections, each \`blocking\` or \`important\``, 'u'), 'each adversary returns at most MAX_MODE_OBJECTIONS objections');
  // Codex's objections answer is held to OBJECTIONS_SCHEMA, MAX_OBJECTIONS entries, improvements included.
  for (const brief of ['A: it will break', 'B: the wrong thing, or too much']) {
    const text = raw.split(`\n## ${brief}\n`)[1].split('\n## ')[0].replace(/\s+/gu, ' ');
    assert.match(text, new RegExp(`Return at most ${MAX_MODE_OBJECTIONS} objections, each blocking or important`, 'u'), `${brief}: the objection cap`);
    assert.ok(text.includes(`At most ${MAX_OBJECTIONS} entries in all.`), `${brief}: the entry cap`);
  }
  // A flagged change the Human has not answered is not reported as accepted, and one answer settles a flagged partial accept.
  assert.match(plan, /A flagged objection the Human has not answered is left out: it shows under Escalated and Proportionality\. For an answered one, the change is the one the answer chose\./u, 'the Accepted item and a flag');
  assert.match(plan, /When a flagged partial accept also has its rejected part escalated, one answer settles both parts\./u, 'one answer for both parts');
  assert.match(plan, /the strongest alternative plan that meets the same goal/u, 'B1 is the strongest alternative');
  assert.match(plan, /\*\*Merged\*\*/u, 'the report lists merges');
  assert.match(plan, /\*\*Proportionality\*\*/u, 'the report has the Proportionality item');
  assert.match(plan, /\*\*Notes\*\*/u, 'the report has the notes footnote');
  const rebuttal = /verdict "concede": the ruling stands; cite the ruling's evidence you accept\./gu;
  assert.equal(plan.match(rebuttal)?.length, 2, 'both rebuttal briefs say a concession cites what it accepts');
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

test('check: a ledger with no mode keeps the old rules: 7 objections, an improvement, a plan-less accept, an uncited concession, no verdicts, and is written back without mode', (t) => {
  const p = project(t);
  const old = (decision, citations) => ({ decision, change_or_reason: 'r', citations });
  const before = { ...ledger([
    objection('A1', [PASSING.code], { claim: 'It breaks.\ninference: the slot is shared', status: 'accepted', ruling: old('accept', [PASSING.code]) }),
    objection('A2', [PASSING.code], { status: 'rejected', ruling: old('reject', [PASSING.adr]), rebuttal: concede([]) }),
    ...[3, 4, 5, 6, 7].map((n) => objection(`A${n}`, [PASSING.code], { severity: n === 7 ? 'improvement' : 'important', status: 'accepted', ruling: old('accept', [PASSING.adr]) })),
  ]), status: 'complete' };
  const result = p.check(before);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: mode plan, 7 objections, 0 opinion, 0 problems']);
  assert.equal(Object.hasOwn(result.ledger, 'mode'), false, 'check adds no mode');
  assert.deepEqual(result.ledger, before);
});

test('check with mode: more than 5 objections by one adversary, or an improvement, exits 1 and is not written; 5 each pass', (t) => {
  const p = project(t);
  for (const [before, message] of [
    [planLedger(Array.from({ length: 6 }, (_, i) => objection(`A${i + 1}`, [PASSING.code]))), /: A raised 6 objections, more than 5 in a ledger with a mode$/mu],
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

test('check: a merged objection with no ruling, folded into the other adversary`s live objection, passes and is skipped by completeness; any other shape exits 1', (t) => {
  const p = project(t);
  const merged = (extra = {}) => objection('B1', [PASSING.adr], { by: 'B', status: 'merged', merged_into: 'A1', ...extra });
  for (const before of [ledger([objection('A1', [PASSING.code]), merged()]), planLedger([objection('A1', [PASSING.code]), merged()])]) {
    const result = p.check(before);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, ['checked: mode plan, 2 objections, 0 opinion, 0 problems']);
    assert.deepEqual(result.ledger.objections.map((each) => each.status), ['pending', 'merged']);
  }
  const complete = p.check(planLedger([objection('A1', [PASSING.code], { status: 'accepted', ruling: accepts() }), merged()], { status: 'complete', proportionality: { flagged: [] } }));
  assert.equal(complete.status, 0, complete.stderr);
  const unnamed = merged();
  delete unnamed.merged_into;
  for (const [objections, message] of [
    [[objection('A1', [PASSING.code]), merged({ ruling: rejects() })], /: objection B1 is merged but has a ruling$/mu],
    [[objection('A1', [PASSING.code]), merged({ rebuttal: concede([PASSING.adr]) })], /: objection B1 is merged but has a rebuttal$/mu],
    [[objection('A1', [PASSING.code]), merged({ merged_into: null })], /: objection B1 is merged into no objection$/mu],
    [[objection('A1', [PASSING.code]), unnamed], /: objection B1 is merged into no objection$/mu],
    [[objection('A1', [PASSING.code]), merged({ merged_into: 'A9' })], /: objection B1 is merged into A9, not an objection in this ledger$/mu],
    [[objection('B2', [PASSING.code], { by: 'B' }), merged({ merged_into: 'B2' })], /: objection B1 is merged into B2, an objection of the same adversary$/mu],
    [[objection('A1', [PASSING.code], { status: 'merged', merged_into: 'B2' }), merged(), objection('B2', [PASSING.code], { by: 'B' })], /: objection B1 is merged into A1, which is merged$/mu],
    [[objection('A1', [cite('code', 'src/app.js:1', 'nope')], { status: 'opinion' }), merged()], /: objection B1 is merged into A1, which is opinion$/mu],
    [[objection('A1', [PASSING.code], { merged_into: 'B1' }), objection('B1', [PASSING.code], { by: 'B' })], /: objection A1 names merged_into B1 but is pending, not merged$/mu],
  ]) {
    for (const before of [planLedger(objections), ledger(objections)]) {
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

test('check with mode: inference lines are matched to distinct entries on their own line, and a bare inference: takes no next line', (t) => {
  const p = project(t);
  const run = (claim, inferences) => {
    const result = p.check(planLedger([objection('A1', [PASSING.code], { claim, status: 'accepted', ruling: accepts({ inferences: inferences.map((statement) => ({ statement, holds: true, reason: 'r', citations: [] })) }) })]));
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

test('check: an objection merged into one that becomes an opinion goes back to pending, unmerged, and the next check passes', (t) => {
  const p = project(t);
  const gone = cite('code', 'src/app.js:1', 'nope');
  for (const before of [ledger, planLedger].map((build) => build([
    objection('A1', [gone]),
    objection('B1', [PASSING.adr], { by: 'B', status: 'merged', merged_into: 'A1' }),
    objection('B2', [gone], { by: 'B', status: 'merged', merged_into: 'A1' }),
  ]))) {
    const first = p.check(before);
    assert.equal(first.status, 0, first.stderr);
    for (const line of ['objection A1: relabeled opinion (was pending): no citation passes', 'objection B1: unmerged: A1 became an opinion', 'objection B2: unmerged: A1 became an opinion', 'objection B2: relabeled opinion (was pending): no citation passes']) {
      assert.ok(first.lines.includes(line), `${line}\n${first.stdout}`);
    }
    assert.deepEqual(first.ledger.objections.map(({ status, merged_into }) => [status, merged_into]), [['opinion', undefined], ['pending', null], ['opinion', null]]);
    const second = p.check(first.ledger);
    assert.equal(second.status, 0, second.stderr);
    assert.ok(!second.lines.some((line) => line.includes('unmerged')), second.stdout);
  }
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
  return { ...p, check: (value, against = question) => p.check(value, { against }) };
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
