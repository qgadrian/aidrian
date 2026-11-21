// The fixture of the quorum tests (quorum, quorum-decide, quorum-route, quorum-provisional): `cli`, which runs an
// `aidrian` command in the test's process, a temporary repository whose `check` runs `quorum check` on a ledger, the
// ledger and ruling builders of each mode, the citations that pass, the stand-in for Codex, and the repositories
// `quorum route` reads its base branch's settings from.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { commands } from '../plugins/aidrian/lib/quorum.mjs';
import { cliCall } from './cli-call.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');

// An `aidrian` command run from `cwd`: in the test's process (cliCall), or, with `asProcess`, as a process of bin/aidrian,
// which a test asks for only where a process shows what a call cannot (docs/test-processes.md#commands-in-the-tests-process).
export async function cli(args, { cwd, env = process.env, asProcess = false }) {
  if (asProcess) return spawnSync(CLI, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  return cliCall(args, { cwd, env });
}

export const temp = (t, prefix) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const write = (root, file, text) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};

// A temporary repository with a knowledge doc, a decision record, code, and a needle only in an ignored file and an
// untracked file; the plan and the ledger live in a state folder outside it.
export function project(t) {
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
  const check = async (ledger, { env = process.env, against = plan, asProcess = false } = {}) => {
    write(state, 'quorum/my-plan-abc.json', JSON.stringify(ledger));
    const r = await cli(['quorum', 'check', ledgerFile, '--plan', against], { cwd: path.join(root, 'src'), env, asProcess });
    assert.equal(r.error, undefined, 'check finished');
    return { ...r, ledger: JSON.parse(readFileSync(ledgerFile, 'utf8')), lines: r.stdout.trim().split('\n') };
  };
  return { root, state, plan, check, git };
}

export const cite = (kind, ref, quote) => ({ kind, ref, quote });
export const objection = (id, citations, extra = {}) => ({ id, by: 'A', severity: 'important', claim: `claim ${id}`, citations, status: 'pending', ruling: null, rebuttal: null, ...extra });
export const ledger = (objections) => ({ mode: 'plan', status: 'open', plan: 'my-plan.md', plan_hash: 'abc', same_model: false, same_model_reason: null, trigger: 'critical flow gate', objections, human_answers: [] });
// A ledger written before `mode`: complete, as every reused one is, since an open ledger without `mode` exits 1.
export const legacy = (objections, extra = {}) => {
  const { mode, ...rest } = ledger(objections);
  return { ...rest, status: 'complete', ...extra };
};

export const PASSING = {
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
export const planLedger = (objections, extra = {}) => ({ ...ledger(objections), mode: 'plan', ...extra });
export const verdicts = (count, supports = true) => Array.from({ length: count }, (_, citation) => ({ citation, supports, reason: supports ? 'it says so' : 'it does not' }));
export const ACCEPT_TEXT = 'Covers: nothing\nAdd the rule to the approach.\nCost: one sentence in #approach.\nRemoves: the double booking the objection cites.';
export const REJECT_TEXT = 'Covers: #approach "Store the ledger under the state folder."\nThe plan already states it.';
export const accepts = (over = {}) => ({ decision: 'accept', change_or_reason: ACCEPT_TEXT, citations: [PASSING.plan], tested: verdicts(1), inferences: [], ...over });
export const rejects = (over = {}) => ({ decision: 'reject', change_or_reason: REJECT_TEXT, citations: [PASSING.plan], ground: 'covered', tested: verdicts(1), inferences: [], ...over });
export const concede = (citations) => ({ verdict: 'concede', claim: 'the ruling stands', citations, ruling: null });

// A stand-in for `codex exec`: it records how it was started, writes `answer` where -o points, then exits with `code`
// after printing `stderr`. With `hang`, it never answers.
export function fakeCodex({ code = 0, stderr = '', answer, hang = false } = {}) {
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

export function codexRun(t, fake, { codex = () => ({ ok: true }) } = {}) {
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

export const ruling = (decision) => ({ decision, change_or_reason: 'r', citations: [PASSING.adr] });
export const RULED = legacy([
  objection('B1', [PASSING.code], { by: 'B', status: 'rejected', ruling: ruling('reject') }),
  objection('B2', [PASSING.code], { by: 'B', status: 'accepted', ruling: ruling('accept') }),
  objection('B3', [PASSING.code], { by: 'B', status: 'escalated', ruling: ruling('escalate') }),
  objection('B4', [PASSING.code], { by: 'B' }),
  objection('A1', [PASSING.code], { status: 'rejected', ruling: ruling('reject') }),
]);

export const ANSWER = { objections: [{ severity: 'blocking', claim: 'breaks the rule', citations: [PASSING.adr] }] };

export const REBUTTALS = { rebuttals: [
  { objection_id: 'B1', verdict: 'rebut', claim: 'the ruling misreads the rule', citations: [PASSING.docBySlug] },
  { objection_id: 'B2', verdict: 'concede', claim: 'the ruling holds', citations: [] },
] };

export const SKILL = path.resolve(import.meta.dirname, '../plugins/aidrian/skills/quorum');

// Every file of the quorum skill: SKILL.md, each references/ file, and each modes/ file, by its path in the skill.
export function skillTexts() {
  const files = ['SKILL.md', ...['references', 'modes'].flatMap((dir) => readdirSync(path.join(SKILL, dir)).map((file) => `${dir}/${file}`))];
  return Object.fromEntries(files.map((file) => [file, readFileSync(path.join(SKILL, file), 'utf8')]));
}

// Decide mode: a question file with options A to C, checked as the plan, and a complete ledger in which A wins, every
// case and backed cross point is tested, and B concedes with the ruling's own evidence.
export const QUESTION = '# Keep one ledger or split it?\n\n## Context\nThe ledger grows with every round.\n\n## Options\n### A: Keep one ledger\nOne file per plan\nholds every round.\n### B: Split it\nEach round writes its own file.\n### C: Drop it\nNothing is kept between runs.\n';
export const ASKED = {
  a: cite('plan', '#a-keep-one-ledger', 'One file per plan holds every round.'),
  b: cite('plan', '#B: Split it', 'Each round writes its own file.'),
  c: cite('plan', '#c-drop-it', 'Nothing is kept between runs.'),
  context: cite('plan', '#context', 'The ledger grows with every round.'),
};
export const position = (id, runner) => ({ id, label: `option ${id}`, runner });
export const stand = (id, citations, claim = `the case for ${id}`) => ({ position: id, claim, citations });
export const point = (id, against, citations, extra = {}) => ({ id, by: id[0], against, claim: `point ${id}`, citations, status: 'backed', ...extra });
export const answer = (id, verdict, citations, claim = 'the ruling misreads the record') => ({ position: id, verdict, claim, citations });
// One verdict per citation index of each entry `counts` names, supporting unless `against` names the entry.
export const tested = (counts, against = []) => Object.entries(counts).flatMap(([of, count]) => Array.from({ length: count }, (_, citation) => ({ of, citation, supports: !against.includes(of), reason: 'r' })));
export const FIRST = { A: 2, B: 1, A1: 1, B1: 1 };
export const decision = (over = {}) => ({ decision: 'rule', winner: 'A', change_or_reason: 'B`s strongest claim is its read speed; the decision record defeats it.', citations: [PASSING.adr], tested: tested(FIRST, ['B']), inferences: [], ...over });
export const decideLedger = (over = {}) => ({
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

export function decideProject(t) {
  const p = project(t);
  const question = path.join(p.state, 'quorum/questions/keep-one-ledger-abc1234.md');
  write(p.state, 'quorum/questions/keep-one-ledger-abc1234.md', QUESTION);
  return { ...p, question, check: (value, against = question, { asProcess = false } = {}) => p.check(value, { against, asProcess }) };
}
export const productLedger = (over = {}) => {
  const { positions, cases, ruling: first, human_answer, status, plan, plan_hash, same_model, same_model_reason, trigger } = decideLedger({ cases: [stand('A', [PASSING.adr]), stand('B', [PASSING.code])], cross: [], ruling: decision({ tested: tested({ A: 1, B: 1 }, ['B']) }) });
  return { mode: 'product', status, plan, plan_hash, same_model, same_model_reason, trigger, premise: { summary: 'open', citations: [PASSING.adr] }, trace: 't', persona_docs: [], draft: null, loops: [], positions, witness: null, cases, cross: [], ruling: first, outcome: { conditions: [], flips_if: [{ fact: 'f', how_to_settle: 'ask' }], disputes: [] }, human_answer, ...over };
};

// `aidrian quorum route`. `route --ledger` reads a ledger as JSON, so `routeLedger` holds only what it reads, and none of them
// goes through `quorum check`, whose schema requires the rest: `carrying` in quorum-provisional.test.mjs is the whole
// ledger that does.
export const OPEN_DECISIONS = { maxMode: 'decide-reversible', mode: 'decide-reversible' };

// A repository whose base branch, `main`, commits `config` in config.json, and `route` run in it.
export function routeRepo(t, config) {
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
  const raw = (...args) => cli(['quorum', 'route', ...args], { cwd: root });
  const route = async (...args) => {
    const r = await raw(...args);
    assert.deepEqual([r.status, r.stderr], [0, ''], args.join(' '));
    assert.equal(r.stdout.trim().split('\n').length, 1, 'one JSON line');
    return JSON.parse(r.stdout);
  };
  return { root, git, setConfig, raw, route };
}

export const productConfig = (product, decisions = OPEN_DECISIONS) => ({ decisions, quorum: { product } });
export const pickRoute = ({ route, wait }) => [route, wait];

export const flip = (fact, settles_from_repo, could_harden_undo) => ({ fact, how_to_settle: `check ${fact}`, ...(settles_from_repo === undefined ? {} : { settles_from_repo }), ...(could_harden_undo === undefined ? {} : { could_harden_undo }) });
export const ruled = (over = {}) => ({ decision: 'rule', winner: 'A', class: 'copy', reversible: 'no,no,no,no', docs: [], domain: 'product', severity: 'low', reverts_by: 'revert the commit', ...over });
export const ROUTE_DECIDE = "the route, with resolve's decide";
export const routeLedger = (flips = [], { ruling = ruled(), ...over } = {}) => ({ mode: 'product', status: 'complete', trigger: ROUTE_DECIDE, ruling, outcome: { conditions: [], flips_if: flips, disputes: [] }, human_answer: null, ...over });

// `route --ledger` on `ledger`, written to a file outside the repository, which the command must leave as it found it.
export async function ledgerRoute(t, repo, ledger, ...more) {
  const state = temp(t, 'aidrian-route-state-');
  const text = `${JSON.stringify(ledger)}\n`;
  write(state, 'ledger.json', text);
  const out = await repo.route('--ledger', path.join(state, 'ledger.json'), ...(more.length ? more : ['--domain', 'product']));
  assert.equal(readFileSync(path.join(state, 'ledger.json'), 'utf8'), text, 'route writes nothing');
  return out;
}
