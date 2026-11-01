import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { CODEX_TIMEOUT_SEC, LEDGER_SCHEMA, OBJECTIONS_SCHEMA, REBUTTALS_SCHEMA, codexAnswer, commands, rebuttalProblems, schemaProblems } from '../plugins/aidrian/lib/quorum.mjs';
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
  const check = (ledger, { env = process.env } = {}) => {
    write(state, 'quorum/my-plan-abc.json', JSON.stringify(ledger));
    const r = spawnSync(CLI, ['quorum', 'check', ledgerFile, '--plan', plan], { cwd: path.join(root, 'src'), encoding: 'utf8', env });
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
  strict(LEDGER_SCHEMA);
  strict(FINDINGS_SCHEMA);
  assert.deepEqual(OBJECTIONS_SCHEMA.properties.objections.items.properties.severity.enum, ['blocking', 'important', 'improvement']);
});

test('slug is exported from flows.mjs unchanged', () => {
  assert.equal(slug('No `Double` Booking'), 'no-double-booking');
  assert.equal(slug('no-double-booking'), 'no-double-booking');
});

test('check: every citation kind passes; anchors by heading text and by slug; quotes compare with whitespace collapsed; plan and ledger outside the root', (t) => {
  const p = project(t);
  const objections = Object.entries(PASSING).map(([id, citation]) => objection(id, [citation]));
  const result = p.check(ledger(objections));
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  assert.deepEqual(result.lines, [`checked: ${objections.length} objections, 0 opinion, 0 problems`]);
  assert.deepEqual(result.ledger.objections.map((each) => each.status), Array(objections.length).fill('pending'));
});

test('check: each citation kind that fails is named with its reason, and an objection with none passing becomes opinion', (t) => {
  const p = project(t);
  const failing = [
    objection('doc', [cite('doc', 'docs/rules.md#refunds', 'Two bookings never hold one slot.')], { status: 'accepted' }),
    objection('docMissing', [cite('doc', 'docs/nope.md#x', 'y')]),
    objection('adr', [cite('adr', 'docs/decisions/0001-store.md#context', 'one ledger per plan')]),
    objection('code', [cite('code', 'src/app.js:1', 'export const app = 2;')]),
    objection('codeRef', [cite('code', 'src/app.js', 'export const app = 1;')]),
    objection('plan', [cite('plan', '#risks', 'Store the ledger')]),
    objection('absence', [cite('absence', 'src', 'export function book')]),
    objection('long', [cite('code', 'src/app.js:1', 'x'.repeat(201))]),
    objection('mixed', [cite('code', 'src/app.js:1', 'nope'), PASSING.code]),
  ];
  const result = p.check(ledger(failing));
  assert.equal(result.status, 0, result.stderr);
  const statuses = Object.fromEntries(result.ledger.objections.map((each) => [each.id, each.status]));
  assert.deepEqual(statuses, { doc: 'opinion', docMissing: 'opinion', adr: 'opinion', code: 'opinion', codeRef: 'opinion', plan: 'opinion', absence: 'opinion', long: 'opinion', mixed: 'pending' });
  const has = (pattern) => assert.ok(result.lines.some((line) => pattern.test(line)), `${pattern}\n${result.stdout}`);
  has(/^objection doc\.citations\[0\] \(doc docs\/rules\.md#refunds\): docs\/rules\.md#refunds does not contain the quote$/u);
  has(/^objection doc: relabeled opinion \(was accepted\): no citation passes$/u);
  has(/^objection docMissing\.citations\[0\] .*: docs\/nope\.md is missing$/u);
  has(/^objection adr\.citations\[0\] .*: docs\/decisions\/0001-store\.md has no heading #context$/u);
  has(/^objection code\.citations\[0\] .*: src\/app\.js does not contain the quote$/u);
  has(/^objection codeRef\.citations\[0\] .*: "src\/app\.js" is not path:line$/u);
  has(/^objection plan\.citations\[0\] .*: the plan#risks does not contain the quote$/u);
  has(/^objection absence\.citations\[0\] .*: src\/app\.js contains the quote$/u);
  has(/^objection long\.citations\[0\] .*: the quote is 201 characters, more than 200$/u);
  assert.ok(!result.lines.some((line) => line.startsWith('objection mixed:')), 'one passing citation keeps the objection');
  assert.equal(result.lines.at(-1), `checked: 9 objections, 8 opinion, ${result.lines.length - 1} problems`);
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

test('check: a schema error, or a ref path that leaves the root, exits 1 and leaves the ledger as it was', (t) => {
  const p = project(t);
  const bad = ledger([objection('A1', [{ ...PASSING.code, line: 3 }])]);
  const schema = p.check(bad);
  assert.equal(schema.status, 1);
  assert.match(schema.stderr, /\$\.objections\[0\]\.citations\[0\]\.line is not a known field/u);
  write(p.state, 'outside.md', '# Out\n\n## A\nsecret\n');
  symlinkSync(path.join(p.state, 'outside.md'), path.join(p.root, 'docs/link.md'));
  for (const escape of [cite('doc', '../outside.md#a', 'secret'), cite('code', `${p.state}/outside.md:1`, 'secret'), cite('absence', '../', 'x'), cite('doc', 'docs/link.md#a', 'secret')]) {
    const before = ledger([objection('A1', [escape])]);
    const result = p.check(before);
    assert.equal(result.status, 1, escape.ref);
    assert.match(result.stderr, /is outside the repository root/u, escape.ref);
    assert.deepEqual(result.ledger, before, 'not written back');
  }
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
  const result = p.check(ledger([objection('L1', [cite('plan', '#approach', 'Then store the ledger.')])]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: 1 objections, 0 opinion, 0 problems']);
});

test('check: a heading inside a fenced block is no anchor', (t) => {
  const p = project(t);
  const result = p.check(ledger([objection('F1', [cite('doc', 'docs/rules.md#fake-heading', 'npm run build')])]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection F1.citations[0] (doc docs/rules.md#fake-heading): docs/rules.md has no heading #fake-heading'), result.stdout);
});

test('check: a rebuttal that re-cites the ledger cites nothing new; one with a new passing citation is valid', (t) => {
  const p = project(t);
  const rebut = (citations) => ({ verdict: 'rebut', claim: 'c', citations, ruling: null });
  const ruled = { decision: 'reject', change_or_reason: 'r', citations: [PASSING.adr] };
  const result = p.check(ledger([
    // The same code citation at another line, spaced differently: the line and the spacing are not part of its identity.
    objection('R1', [PASSING.code], { status: 'rejected', ruling: ruled, rebuttal: rebut([cite('code', './src/app.js:2', 'export  function book(slot)\n{')]) }),
    objection('R2', [PASSING.code], { status: 'rejected', ruling: ruled, rebuttal: rebut([cite('adr', 'docs/decisions/0001-store.md#Decision', 'one ledger per plan')]) }),
    objection('R3', [PASSING.code], { status: 'rejected', ruling: ruled, rebuttal: rebut([PASSING.adr, PASSING.plan]) }),
  ]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection R1 rebuttal: invalid: the rebuttal cites nothing new'), result.stdout);
  assert.ok(result.lines.includes('objection R2 rebuttal: invalid: the rebuttal cites nothing new'), 'a ruling`s citation, by heading text');
  assert.ok(!result.lines.some((line) => line.startsWith('objection R3')), result.stdout);
});

test('check: two rebuttals that bring the same new evidence are both valid', (t) => {
  const p = project(t);
  const ruled = { decision: 'reject', change_or_reason: 'r', citations: [PASSING.adr] };
  const rebuttal = { verdict: 'rebut', claim: 'c', citations: [PASSING.fenced], ruling: null };
  const result = p.check(ledger([
    objection('T1', [PASSING.code], { status: 'rejected', ruling: ruled, rebuttal: structuredClone(rebuttal) }),
    objection('T2', [PASSING.plan], { by: 'B', status: 'rejected', ruling: ruled, rebuttal: structuredClone(rebuttal) }),
  ]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: 2 objections, 0 opinion, 0 problems']);
});

test('check: a complete ledger with an objection pending, or ruled on with no ruling, exits 1 and is not written', (t) => {
  const p = project(t);
  const ruled = { decision: 'accept', change_or_reason: 'c', citations: [PASSING.adr] };
  for (const [objections, message] of [
    [[objection('C1', [PASSING.code])], /objection C1 is pending in a complete ledger/u],
    [[objection('C2', [PASSING.code], { status: 'accepted' })], /objection C2 is accepted with no ruling in a complete ledger/u],
  ]) {
    const before = { ...ledger(objections), status: 'complete' };
    const result = p.check(before);
    assert.equal(result.status, 1, message.source);
    assert.match(result.stderr, message);
    assert.deepEqual(result.ledger, before);
  }
  const done = p.check({ ...ledger([objection('C3', [PASSING.code], { status: 'accepted', ruling: ruled }), objection('C4', [cite('code', 'src/app.js:1', 'nope')], { status: 'opinion' })]), status: 'complete' });
  assert.equal(done.status, 0, done.stderr);
});

test('check: a ref that is not a relative path is a failed citation, not an escape', (t) => {
  const p = project(t);
  const refs = [cite('doc', 'docs\\rules.md#refunds', 'refund'), cite('doc', 'docs//rules.md#refunds', 'refund'), cite('doc', '#refunds', 'refund'), cite('code', ':3', 'x'), cite('absence', '', 'x'), cite('code', '.:1', 'x')];
  const result = p.check(ledger(refs.map((citation, i) => objection(`M${i}`, [citation]))));
  assert.equal(result.status, 0, result.stderr);
  for (const [i, citation] of refs.entries()) {
    assert.ok(result.lines.includes(`objection M${i}.citations[0] (${citation.kind} ${citation.ref}): "${citation.ref}" is not a relative path`), `${citation.ref}\n${result.stdout}`);
  }
});

test('check: absence reads only regular tracked files: a tracked symlink to an outside file with the needle passes', (t) => {
  const p = project(t);
  write(p.state, 'outside.txt', 'NEEDLE_OUT\n');
  write(p.root, 'lib/real.js', 'export {};\n');
  symlinkSync(path.join(p.state, 'outside.txt'), path.join(p.root, 'lib/link.txt'));
  p.git('add', 'lib');
  const result = p.check(ledger([objection('S1', [cite('absence', 'lib', 'NEEDLE_OUT')])]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: 1 objections, 0 opinion, 0 problems']);
});

test('check: an absence path is a literal pathspec, a set GIT_ICASE_PATHSPECS does not break it, and a path with no tracked file fails', (t) => {
  const p = project(t);
  const result = p.check(ledger([
    objection('P1', [cite('absence', ':(exclude)docs', 'export function book')]),
    objection('P2', [cite('absence', 'nowhere', 'NEEDLE_9')]),
    objection('P3', [cite('code', 'src/app.js:1', '')]),
    objection('P4', [cite('code', 'src/app.js:1', '  \n\t ')]),
  ]));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.lines.includes('objection P1.citations[0] (absence :(exclude)docs): git tracks no file under :(exclude)docs'), result.stdout);
  assert.ok(result.lines.includes('objection P2.citations[0] (absence nowhere): git tracks no file under nowhere'), result.stdout);
  assert.ok(result.lines.some((line) => line.startsWith('objection P3.citations[0]') && line.endsWith(': the quote is empty')), result.stdout);
  assert.ok(result.lines.some((line) => line.startsWith('objection P4.citations[0]') && line.endsWith(': the quote is empty')), result.stdout);
  const icase = p.check(ledger([objection('I1', [PASSING.absence])]), { env: { ...process.env, GIT_ICASE_PATHSPECS: '1' } });
  assert.equal(icase.status, 0, icase.stderr);
  assert.deepEqual(icase.lines, ['checked: 1 objections, 0 opinion, 0 problems']);
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
  assert.match(errors.mock.calls[0].arguments[0], /^aidrian quorum: codex --mode is object or rebut, not "rebuttal"$/u);
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

test('quorum codex: --mode rebut without --ledger, or --ledger without it, is a usage error and Codex never starts', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  for (const [flags, message] of [
    [['--mode', 'rebut'], 'aidrian quorum: codex --mode rebut needs --ledger'],
    [['--mode', 'rebut', '--ledger', ''], 'aidrian quorum: codex --mode rebut needs --ledger'],
    [['--ledger', 'x.json'], 'aidrian quorum: codex --ledger is only for --mode rebut'],
    [['--mode', 'object', '--ledger', 'x.json'], 'aidrian quorum: codex --ledger is only for --mode rebut'],
  ]) {
    const fake = fakeCodex({ answer: REBUTTALS });
    const r = codexRun(t, fake);
    assert.equal(await r.run({}, undefined, flags), 1, flags.join(' '));
    assert.deepEqual(r.printed, []);
    assert.equal(fake.calls.length, 0);
    assert.equal(errors.mock.calls.at(-1).arguments[0], message);
  }
});

test('codexAnswer: an unknown mode, or rebut with no ledger, is failed, not thrown, and Codex is never looked for', async (t) => {
  const dir = temp(t, 'aidrian-quorum-guard-');
  const deps = { spawnImpl: fakeCodex().spawnImpl, codex: () => assert.fail('looked for Codex') };
  const args = { plan: 'p', brief: 'b', out: path.join(dir, 'o.json'), root: dir };
  assert.deepEqual(await codexAnswer({ ...args, mode: 'nope' }, deps), { status: 'failed', reason: '"nope" is not a mode: object or rebut' });
  assert.deepEqual(await codexAnswer({ ...args, mode: 'toString' }, deps), { status: 'failed', reason: '"toString" is not a mode: object or rebut' });
  assert.deepEqual(await codexAnswer({ ...args, mode: 'rebut' }, deps), { status: 'failed', reason: '--mode rebut needs a ledger' });
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


test('the quorum skill names exactly the flags `aidrian quorum` takes, real --mode values, and every codex status with its exit code', async () => {
  const flags = (text) => new Set([...text.matchAll(/(?<![\w-])--[a-z][a-z-]*/gu)].map((match) => match[0]));
  const texts = Object.fromEntries(['SKILL.md', 'references/briefs.md', 'references/ledger.md'].map((file) => [file, readFileSync(path.join(SKILL, file), 'utf8')]));
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

test('plan-review runs the quorum skill at step 3b, lists its flags in Inputs, and ledger.md says how it runs there', () => {
  // A plan-review that forgets the step, or a ledger.md that drops its section, leaves the quorum's plan use undescribed.
  const review = readFileSync(PLAN_REVIEW, 'utf8');
  const inputs = review.split('\n## Inputs\n')[1].split('\n## ')[0];
  for (const flag of ['--quorum', '--no-quorum']) assert.match(inputs, new RegExp(`\`${flag}\``, 'u'), `plan-review's Inputs lists ${flag}`);
  const step = review.split('\n## 3b. Quorum\n')[1]?.split('\n## ')[0];
  assert.ok(step, 'plan-review has a step 3b');
  assert.ok(review.indexOf('\n## 3. Gates\n') < review.indexOf('\n## 3b. Quorum\n') && review.indexOf('\n## 3b. Quorum\n') < review.indexOf('\n## 4. Critique\n'), 'step 3b sits between the gates and the critique');
  assert.match(step, /the `quorum` skill/u, 'step 3b names the quorum skill');
  const ledger = readFileSync(path.join(SKILL, 'references/ledger.md'), 'utf8');
  assert.match(ledger, /\n## Under plan-review\n/u, 'ledger.md has § Under plan-review');
  assert.match(ledger, /\[Under plan-review\]\(#under-plan-review\)/u, 'ledger.md links its plan-review section');
});
