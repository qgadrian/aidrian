import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectAt, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { blocksOf, citationProblem, flowState, invariantsOf, sectionOf } from '../plugins/aidrian/lib/review/flows.mjs';
import { cleanOutput, resolveEngine, runExec } from '../plugins/aidrian/lib/review/reviewers.mjs';
import { harnessSignoff } from '../plugins/aidrian/lib/review/step.mjs';
import { EXIT, recordAccept, recordOverrule, recordPass, recordSignoff, remoteState, reviewInForce } from '../plugins/aidrian/lib/review/run.mjs';
import { runAutoMerge } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { emptyState, heldRevision, readLocalState, stateFromComment, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { capProblem } from '../plugins/aidrian/lib/review/waiver.mjs';
import { loadTable } from '../plugins/aidrian/lib/finding-disposition.mjs';
import { offerLand, runExtend } from '../plugins/aidrian/lib/review/extension.mjs';
import { logPath } from '../plugins/aidrian/lib/dispatch-log.mjs';
import { repo, clean, OPEN, unnamed, unverifiedNext, finding, scripted, found, holdsAll, holdComment, APPROVED_FLOWS } from './review-run-fixture.mjs';

test('a docs-only change needs no review and posts nothing', async (t) => {
  const r = repo(t, { change: (write) => write('docs/guide.md', 'hello\n') });
  const result = await r.step({ exec: clean });
  assert.equal(result.status, 'none_needed');
  assert.equal(r.comments.length, 0);
});

test('the review step of a non-member edits their own summary comment, and it supplies no record', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  r.forge.postComment = (_repo, _n, body) => r.comments.push({ id: r.comments.length + 1, body, user: { login: 'fork' }, author_association: 'CONTRIBUTOR' });
  r.forge.viewer = () => 'fork';
  let ran = 0;
  const exec = async () => (ran += 1, { status: 'done', findings: [finding], verdicts: [], dropped: [] });
  await r.step({ exec });
  rmSync(stateDir(r.project), { recursive: true, force: true });
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit();
  await r.step({ exec });
  assert.equal(r.comments.length, 1, 'the second step edits the first step\'s comment');
  assert.equal(stateFromComment(r.comments[0].body, 7).rounds.length, 1, 'with this machine\'s record gone, the comment supplied none: a new first round');
});

test('a stranger\'s summary comment supplies no record: the reviewer still runs, and auto-merge stays off', async (t) => {
  const team = { version: 1, state: { dir: '../state' }, github: { requiredChecks: ['test'], autoMerge: { allow: true, strategy: 'squash' } } };
  const r = repo(t, { baseConfig: team, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  r.git('remote', 'add', 'origin', 'git@github.com:o/r.git');
  r.write('.aidrian.local.json', JSON.stringify({ github: { autoMerge: 'on' } }));
  const head = r.git('rev-parse', 'HEAD');
  const forged = { ...emptyState(7, 'o/r'), revision: 1000000, rounds: [{ head, at: '2026-11-04T00:00:00.000Z' }], passes: { 'engine:codex-local': { head, reviewer: 'codex-local', files: null, findings: 0, open: 0, verdicts: [] } } };
  r.comments.push({ id: 100, body: summaryBody(forged, null, 'x'), user: { login: 'mallory' }, author_association: 'NONE' });
  let ran = 0;
  const step = await r.step({ exec: async () => (ran += 1, { status: 'done', findings: [finding], verdicts: [], dropped: [] }) });
  assert.deepEqual([step.status, ran], ['fix_required', 1], 'the reviewer ran, and its finding stands');
  assert.equal(r.comments.find((comment) => comment.id === 100).body, summaryBody(forged, null, 'x'), 'the stranger\'s comment is not edited');
  assert.equal(r.comments.length, 2, 'the review posts its own summary comment');

  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  // The comment lists come back empty, so this reads the review record alone, not the outsider reason.
  const none = () => [];
  const exit = runAutoMerge(['--json'], projectAt(r.dir), { forge: {
    change: () => ({ number: 7, headRefOid: head, baseRefName: 'main', author: { login: 'a' }, url: 'https://github.com/o/r/pull/7', files: [{ path: 'src/app.js', changeType: 'MODIFIED' }], changedFiles: 1, reviewDecision: '', latestReviews: [] }),
    viewer: () => 'a',
    repository: (repo) => (repo === 'o/r' ? { default_branch: 'main' } : assert.fail(repo)),
    contents: (_repo, file) => {
      if (file === '.aidrian/config.json') return { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(team)).toString('base64') };
      throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
    },
    conversationComments: none,
    reviews: none,
    reviewComments: none,
  } });
  t.mock.restoreAll();
  assert.deepEqual([exit, JSON.parse(lines[0]).reason], [1, 'review']);
});

test('zero config: codex-local reviews once; a finding is fix_required until a new head comes back clean', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const seen = [];
  const exec = async (reviewer, input) => (seen.push([reviewer.name, input.context]), seen.length === 1 ? { status: 'done', findings: [finding], verdicts: [], dropped: [] } : clean());
  const first = await r.step({ exec });
  assert.equal(first.status, 'fix_required');
  assert.deepEqual(first.open.map((each) => [each.pass, each.open]), [['engine:codex-local', 1]]);
  assert.equal((await r.step({ exec })).status, 'fix_required', 'calling again on the same head re-runs nothing');
  assert.equal(seen.length, 1);
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit();
  const second = await r.step({ exec });
  assert.equal(second.status, 'received');
  assert.deepEqual(seen, [['codex-local', 'full'], ['codex-local', 'delta']]);
  assert.equal(second.round, 2);
  assert.equal(r.comments.length, 1, 'one summary comment, edited in place');
  assert.equal(stateFromComment(r.comments[0].body, 7).rounds.length, 2);
});

test('a comment-, doc-, or test-only push keeps its round, and the passes it touches re-review it in delta context', async (t) => {
  for (const [what, push] of [
    ['comment', (r) => r.write('src/app.js', '// note: the app number\nexport const app = 2;\n')],
    ['doc', (r) => r.write('docs/guide.md', 'hello\n')],
    ['test', (r) => r.write('test/app.test.js', 'test("app", () => {\n  assert.ok(app);\n});\n')],
  ]) {
    const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
    const seen = scripted();
    const first = await r.step({ exec: seen.exec });
    assert.deepEqual([first.status, first.round], ['received', 1], what);
    push(r);
    const pushed = r.commit();
    const second = await r.step({ exec: seen.exec });
    assert.deepEqual([second.status, second.round, seen.inputs.length], ['received', 1, 2], `a ${what}-only push is reviewed, and opens no round`);
    assert.deepEqual([seen.inputs[1].context, seen.inputs[1].base, seen.inputs[1].head], ['delta', first.head, pushed], `${what}: only the change since the round's head`);
    assert.match(second.plan.reasons.join('\n'), /a comment, doc, or test-only change since [0-9a-f]{7}: the round stays open; the passes it touches re-review it/u, what);
    assert.deepEqual([second.round_kept.from, second.round_kept.reason], [first.head, second.plan.reasons.at(-1)], `${what}: the output names the kept round, beside its number`);
    const state = readLocalState(r.project, 7);
    assert.equal(state.passes['engine:codex-local'].head, pushed, `${what}: the result is the new head's`);
    assert.deepEqual([state.rounds.length, state.rounds[0].head, state.rounds[0].quiet.map((each) => each.from)], [1, pushed, [first.head]], `${what}: the round moved to the new head`);
  }
});

// A file a project's review.nonBehaviour calls prose can still hold behaviour (a pinned dependency): quiet keeps the
// round, but the pass it touches reviews it. The built-in list names no .txt file, so the project lists it here.
test('a fix push to a file review.nonBehaviour calls prose is re-reviewed on the new head in the same round', async (t) => {
  const baseConfig = { version: 1, review: { nonBehaviour: ['**/*.md', '**/*.txt'] } };
  const r = repo(t, { baseConfig, change: (write) => (write('src/app.js', 'export const app = 2;\n'), write('requirements.txt', 'requests==2.31.0\n')) });
  const seen = scripted();
  const first = await r.step({ exec: seen.exec });
  assert.deepEqual([first.status, first.round], ['received', 1]);
  r.write('requirements.txt', 'requests==2.32.0\n');
  const pushed = r.commit();
  const second = await r.step({ exec: seen.exec });
  assert.deepEqual([second.status, second.round, seen.inputs.length], ['received', 1, 2], 'the pinned dependency is reviewed, and no round opens');
  assert.deepEqual([seen.inputs[1].context, seen.inputs[1].base, seen.inputs[1].head], ['delta', first.head, pushed]);
  assert.equal(readLocalState(r.project, 7).passes['engine:codex-local'].head, pushed, 'the result is the new head\'s');
});

test('a quiet push with open findings re-reviews the delta; a test that lost a line opens a round', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const seen = scripted(found(finding));
  const first = await r.step({ exec: seen.exec });
  assert.deepEqual([first.status, first.round], ['fix_required', 1]);
  r.write('src/app.js', '// note: the app number\nexport const app = 2;\n');
  r.write('test/app.test.js', 'test("app", () => {\n  assert.ok(app);\n  assert.equal(app, 2);\n});\n');
  r.commit();
  const second = await r.step({ exec: seen.exec });
  assert.deepEqual([second.status, second.round, seen.inputs.map((input) => input.context)], ['received', 1, ['full', 'delta']], 'only a reviewer says a finding is fixed');
  r.write('test/app.test.js', 'test("app", () => {\n  assert.equal(app, 2);\n});\n');
  r.commit();
  const third = await r.step({ exec: seen.exec });
  assert.deepEqual([third.round, seen.inputs.length], [2, 3], 'a test that lost a line is loud: a new round reviews it');
});

test('in the last round a quiet fix is reviewed without reaching round_limit', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 1, extraRounds: 'off' } }, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const seen = scripted(found(finding));
  assert.deepEqual([(await r.step({ exec: seen.exec })).status, readLocalState(r.project, 7).rounds[0].final], ['round_limit', true], 'a fix would need another round');
  r.write('src/app.js', '// why the app is two\nexport const app = 2;\n');
  r.commit();
  const fixed = await r.step({ exec: seen.exec });
  assert.deepEqual([fixed.status, fixed.round, seen.inputs.length], ['received', 1, 2]);
  assert.equal(readLocalState(r.project, 7).rounds[0].final, true, 'the round keeps its last-round flag');
});

test('a quiet push whose review fails gives the round back as it was: its head, its time, and its quiet list', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  await r.step({ exec: clean });
  const before = readLocalState(r.project, 7).rounds;
  r.write('src/app.js', '// one\nexport const app = 2;\n');
  r.commit();
  const failed = await r.step({ exec: async () => ({ status: 'failed', reason: 'crashed' }) });
  assert.equal(failed.status, 'incomplete');
  assert.deepEqual(readLocalState(r.project, 7).rounds, before, 'no quiet list, the old head and time');
  await r.step({ exec: clean });
  const moved = readLocalState(r.project, 7).rounds;
  assert.equal(moved[0].quiet.length, 1);
  r.write('src/app.js', '// one\n// two\nexport const app = 2;\n');
  r.commit();
  await r.step({ exec: async () => ({ status: 'failed', reason: 'crashed' }) });
  assert.deepEqual(readLocalState(r.project, 7).rounds, moved, 'a quiet list it had stays as it was');
});

// A built-in plan that reviews anything holds a pass of all files, which any push touches: only a plan of a plan
// command's file-list passes alone can miss a quiet push.
test('a quiet push no pass touches runs no review, and still moves the round to its head', async (t) => {
  const planner = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:'single',stages:[{name:'independent',passes:[{id:'extra:lint',reviewer:'lint',kind:'exec',files:['docs/guide.md']}]}]})))";
  const r = repo(t, {
    baseConfig: { version: 1, review: { planCommand: 'node scripts/plan.mjs', reviewers: { lint: { kind: 'exec', command: ['node', 'scripts/lint.mjs'], stage: 'independent' } } } },
    baseFiles: { 'scripts/plan.mjs': planner, 'scripts/lint.mjs': '\n' },
    change: (write) => write('docs/guide.md', 'hello\n'),
  });
  const seen = scripted();
  const first = await r.step({ exec: seen.exec });
  assert.deepEqual([first.status, first.round, seen.inputs.length], ['received', 1, 1]);
  r.write('docs/other.md', 'outside the pass\'s files\n');
  const pushed = r.commit();
  const second = await r.step({ exec: seen.exec });
  assert.deepEqual([second.status, second.round, seen.inputs.length], ['received', 1, 1], 'the pass carries: no new run, no new round');
  const state = readLocalState(r.project, 7);
  assert.equal(state.passes['extra:lint'].head, first.head, 'the pass\'s result is still the first head\'s');
  assert.deepEqual([state.rounds.length, state.rounds[0].head, state.rounds[0].quiet.map((each) => each.from)], [1, pushed, [first.head]], 'the round moved to the new head');
});

// A step on `change`, then one on a doc push `push` makes, with an engine that finds nothing: the second result, and
// how many times the engine ran.
async function afterDocPush(t, { baseConfig, push, baseFiles }) {
  const r = repo(t, { baseConfig, baseFiles, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const seen = scripted();
  const first = await r.step({ exec: seen.exec });
  assert.equal(first.round, 1);
  push(r);
  r.commit();
  return { r, first, second: await r.step({ exec: seen.exec }), runs: seen.inputs };
}

test('a doc push opens a round when it changes how the project is reviewed: a harness file or a cited doc', async (t) => {
  const harness = await afterDocPush(t, {
    baseConfig: { version: 1, review: { nonBehaviour: ['**/*.md', '.aidrian/**'] } },
    push: (r) => r.write('.aidrian/config.json', `${JSON.stringify({ version: 1, review: { nonBehaviour: ['**/*.md', '.aidrian/**'] } }, null, 2)}\n`),
  });
  assert.deepEqual([harness.second.round, harness.runs.length, harness.runs[1]?.context], [2, 2, 'delta'], 'the config file decides how the project is reviewed');
  const cited = await afterDocPush(t, {
    baseConfig: { version: 1, review: { flows: { booking: { files: ['src/booking/**'], invariants: 'docs/flows/booking.md' } } } },
    push: (r) => r.write('docs/flows/booking.md', '# Booking\n\n## No double booking\nTwo bookings may share a slot.\n'),
  });
  assert.equal(cited.second.round, 2, 'a flow\'s invariants doc is part of the review');
  assert.ok(cited.second.plan.flows.includes('harness-config'));
});

test('a quiet push that selects a flow by an added line or by its content opens a round', async (t) => {
  const added = await afterDocPush(t, {
    baseConfig: { version: 1, review: { flows: { pay: { files: ['src/pay/**'], added: ['refund\\('] } } } },
    push: (r) => r.write('docs/guide.md', 'Call refund(order) to pay back.\n'),
  });
  assert.equal(added.second.round, 2, 'a doc line the flow\'s pattern matches');
  assert.ok(added.second.plan.flows.includes('pay'));
  const content = await afterDocPush(t, {
    baseConfig: { version: 1, review: { flows: { pay: { files: ['src/pay/**'], content: { roots: ['src'], probes: ['chargeCard'] } } } } },
    baseFiles: { 'src/billing.js': 'export const pay = () => chargeCard();\n' },
    push: (r) => r.write('src/billing.js', '// pays the order\nexport const pay = () => chargeCard();\n'),
  });
  assert.equal(content.second.round, 2, 'a comment-only change to a file whose content is the flow\'s');
  assert.ok(content.second.plan.flows.includes('pay'));
});

test('a doc push a rule reviews keeps its round, but a pass with nothing open re-reviews it', async (t) => {
  for (const rule of [{ depth: 'single', when: { anyFiles: ['docs/**'] } }, { require: ['independent-model'], when: { anyFiles: ['docs/**'] } }]) {
    const { second, runs } = await afterDocPush(t, { baseConfig: { version: 1, review: { rules: [rule] } }, push: (r) => r.write('docs/guide.md', 'hello\n') });
    assert.deepEqual([second.status, second.round, runs.length, runs[1]?.context], ['received', 1, 2, 'delta'], JSON.stringify(rule));
  }
});

test('from round N, an exec reviewer\'s low finding is an accepted residual the step lists, and the step passes', async (t) => {
  const N = loadTable().lateRoundFrom;
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 8, extraRounds: 'off' } }, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  let calls = 0;
  const exec = async () => (calls += 1, { status: 'done', findings: [calls <= N - 2 ? finding : { ...finding, severity: 'low' }], verdicts: [], dropped: [] });
  for (let round = 1; round < N - 1; round += 1) {
    assert.deepEqual([(await r.step({ exec })).status, calls], ['fix_required', round]);
    r.write('src/app.js', `export const app = ${100 + round};\n`);
    r.commit();
  }
  const early = await r.step({ exec });
  assert.deepEqual([early.status, early.round, early.open[0].open], ['fix_required', N - 1, 1], 'before N a low finding still blocks');
  assert.equal(early.residuals, undefined);
  r.write('src/app.js', `export const app = ${100 + N};\n`);
  r.commit();
  const late = await r.step({ exec });
  assert.deepEqual([late.status, late.round], ['received', N]);
  assert.deepEqual(late.residuals.map(unnamed), [{ pass: 'engine:codex-local', title: 'off by one', file: 'src/app.js', line: 1, severity: 'low' }]);
  assert.match(late.residuals[0].id, /^R\d+-\d+$/u, 'the row names its finding by id');
  const pass = readLocalState(r.project, 7).passes['engine:codex-local'];
  assert.deepEqual([pass.open, pass.findings, pass.list[0].state, pass.list[0].disposition], [0, 1, 'accepted', 'accepted_residual']);
});

test('a late-round residual records the disposition the table gives it', async (t) => {
  const table = { ...loadTable(), lateRoundFrom: 1, lateRound: { severities: ['low'], disposition: 'acceptable_as_is' } };
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const result = await r.step({ exec: async () => found({ ...finding, severity: 'low' }), dispositionTable: table });
  assert.deepEqual([result.status, result.residuals?.length], ['received', 1]);
  const [kept] = readLocalState(r.project, 7).passes['engine:codex-local'].list;
  assert.deepEqual([kept.disposition, kept.state, kept.accepted_by], ['acceptable_as_is', 'accepted', 'late-round']);
});

test('a finding a project exec reviewer prints is judged by the table, never by the state, disposition, or acceptance it prints', async (t) => {
  for (const printed of [{ state: 'fixed' }, { disposition: 'acceptable_as_is' }, { accepted_by: 'late-round' }, { state: 'accepted', disposition: 'acceptable_as_is', accepted_by: 'late-round' }]) {
    const output = JSON.stringify({ findings: [{ ...finding, ...printed }], verdicts: [] });
    const r = repo(t, {
      baseConfig: { version: 1, review: { reviewers: { scan: { kind: 'exec', command: ['node', 'scripts/scan.mjs'], timeoutSec: 30 } } } },
      baseFiles: { 'scripts/scan.mjs': `console.log(${JSON.stringify(output)});\n`, '.aidrian.local.json': JSON.stringify({ review: { engine: 'scan' } }) },
      change: (write) => write('src/app.js', 'export const app = 2;\n'),
    });
    const result = await r.step();
    const name = JSON.stringify(printed);
    assert.deepEqual([result.status, result.open?.[0]?.open], ['fix_required', 1], name);
    assert.equal(result.residuals, undefined, name);
    const [kept] = readLocalState(r.project, 7).passes['engine:scan'].list;
    assert.deepEqual([kept.title, kept.state, kept.disposition, kept.accepted_by], [finding.title, undefined, undefined, undefined], name);
  }
});

test('a flow adds a local agent pass that must cite evidence for every invariant before the engine runs', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], invariants: 'docs/flows/booking.md', require: ['agent:product-manager'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/booking/book.js', 'export function book() {\n  return lock();\n}\n') });
  let ran = 0;
  const exec = async () => (ran += 1, clean());
  const first = await r.step({ exec });
  assert.equal(first.status, 'dispatch');
  assert.equal(ran, 0, 'the independent stage waits for the local one');
  const [pass] = first.dispatch;
  assert.equal(pass.agent, 'product-manager');
  assert.deepEqual(pass.flows[0].invariants.map((each) => each.id), ['no-double-booking', 'refund-cap']);
  const head = first.head;
  const verdicts = (evidence) => JSON.stringify([
    { flow: 'booking', invariant: 'no-double-booking', verdict: 'holds', evidence },
    { flow: 'booking', invariant: 'refund-cap', verdict: 'not_affected', evidence: 'src/booking/book.js:1' },
  ]);
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head, reviewer: 'product-manager', findings: 0, fixed: 0, verdictsText: verdicts('src/booking/book.js:99') });
  const uncited = await r.step({ exec });
  assert.equal(uncited.status, 'fix_required');
  assert.deepEqual(uncited.flows, [{ flow: 'booking', violated: [], unverified: ['no-double-booking'], next: [unverifiedNext('booking', 'no-double-booking', head, ['product-manager answered holds, but its evidence does not count (src/booking/book.js has no line 99): dispatch that reviewer again to cite path:line, test:<name>, or capture:<key>, which closes this with no sign-off'])] }], 'a citation to a line that is not there does not count');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head, reviewer: 'product-manager', findings: 0, fixed: 0, verdictsText: verdicts('src/booking/book.js:2') });
  const done = await r.step({ exec: async (_reviewer, input) => {
    assert.deepEqual(input.flows[0].earlierVerdicts.map((each) => each.verdict), ['holds', 'not_affected'], 'the independent reviewer sees the local verdicts to challenge');
    return exec();
  } });
  assert.equal(done.status, 'received');
  assert.equal(ran, 1);
});

test('a later round reviews the delta for bugs, but judges flow invariants from the merge base', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], invariants: 'docs/flows/booking.md', require: ['agent:product-manager'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/booking/book.js', 'export const book = 1;\n') });
  const base = r.git('merge-base', 'main', 'HEAD');
  const first = await r.step({ exec: clean });
  const [pass] = first.dispatch;
  assert.deepEqual([pass.context, pass.flowBase], ['full', undefined], 'the first round is already the whole change');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'product-manager', findings: 1, fixed: 0, verdictsText: '[]' });
  r.write('src/booking/book.js', 'export const book = 2;\n');
  r.commit();
  const second = await r.step({ exec: clean });
  const again = second.dispatch.find((each) => each.pass === pass.pass);
  assert.deepEqual([again.context, again.base, again.flowBase], ['delta', first.head, base]);
  assert.match(again.brief, new RegExp(`judge every flow invariant on the whole change, \`git diff ${base} ${again.head}\``, 'u'));
  assert.match(again.brief, /holds means the change keeps the rule/u, 'the verdict means the rule, whatever the question\'s wording');
});

test('a pull request cannot weaken the review it is under: a removed flow still runs, and the config change needs the Human', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, headConfig: { version: 1 }, change: (write) => write('src/booking/book.js', 'x\n') });
  const first = await r.step({ exec: clean });
  assert.deepEqual(first.plan.flows, ['booking', 'harness-config']);
  for (const pass of first.dispatch) {
    const ids = pass.flows.flatMap((flow) => flow.invariants.map((each) => [flow.id, each.id]));
    recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0,
      verdictsText: JSON.stringify(ids.map(([flow, invariant]) => ({ flow, invariant, verdict: 'holds', evidence: 'src/booking/book.js:1' }))) });
  }
  const human = await r.step({ exec: clean });
  assert.equal(human.status, 'human_required');
  assert.equal(EXIT.human_required, 9);
  assert.deepEqual(human.flows, ['harness-config']);
  recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'harness-config', head: first.head, by: 'Tester' });
  assert.equal((await r.step({ exec: clean })).status, 'received');
});

test('a base that commits github.autoMerge.includePolicyFiles with includeGuardedPaths still reviews a config-only change under harness-config, and its reviewer signs it in place of the Human', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const lifted = { autoMerge: { includeGuardedPaths: true, includePolicyFiles: true } };
  // The config sorts as no behaviour, and no other file changes: the harness-config flow alone keeps the review.
  const review = { flows, nonBehaviour: ['.aidrian/**'] };
  const r = repo(t, { baseConfig: { version: 1, github: lifted, review }, headConfig: { version: 1, github: lifted, review: { nonBehaviour: ['.aidrian/**'] } }, change: () => {} });
  const first = await r.step({ exec: clean });
  assert.deepEqual([first.plan.flows, first.plan.depth === 'none'], [['harness-config'], false], 'reviewed, never none_needed');
  assert.ok(first.dispatch.length > 0, 'a pass reviews it');
  for (const pass of first.dispatch) {
    const ids = pass.flows.flatMap((flow) => flow.invariants.map((each) => [flow.id, each.id]));
    recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0,
      verdictsText: JSON.stringify(ids.map(([flow, invariant]) => ({ flow, invariant, verdict: 'holds', evidence: '.aidrian/config.json:1' }))) });
  }
  assert.equal((await r.step({ exec: clean })).status, 'received', 'no sign-off of the Human');
  assert.deepEqual(readLocalState(r.project, 7, 'o/r').signoffable.flows, [], 'nothing for the Human to sign off');
});

test('harnessSignoff asks merge trust\'s floor who signs the harness-config flow: the reviewer only where the floor asks the Human nothing', () => {
  const lifted = { autoMerge: { includeGuardedPaths: true, includePolicyFiles: true } };
  const config = '.aidrian/config.json';
  const ask = (committed, changes = [{ file: config, status: 'M' }]) => harnessSignoff({ changes, committed, config });
  const flows = { booking: { files: ['src/booking/**'], invariants: 'docs/flows/booking.md' } };
  assert.equal(ask({ github: lifted, review: { flows } }), 'reviewer', 'lifted on the base');
  assert.equal(ask({ github: { autoMerge: { includeGuardedPaths: true } }, review: { flows } }), 'human', 'not lifted');
  assert.equal(ask({ github: { autoMerge: { includePolicyFiles: true } }, review: { flows } }), 'human', 'without includeGuardedPaths');
  // The config cited by a flow's invariants, and a review command the project configures, keep the Human, as the floor does.
  const cited = { booking: { files: ['src/booking/**'], invariants: [{ id: 'c1', text: 'rounds stay', cite: `${config}#review` }] } };
  assert.equal(ask({ github: lifted, review: { flows: cited } }), 'human', 'a cited config');
  assert.equal(ask({ github: lifted, review: { flows, planCommand: 'node plan.mjs' } }), 'human', 'a plan command');
  assert.equal(ask({ github: lifted, review: { flows, reviewers: { lint: { command: ['node', 'lint.mjs'] } } } }), 'human', 'an exec reviewer');
  assert.equal(ask({ github: lifted, review: { flows, visual: { login: 'node login.mjs' } } }), 'human', 'a visual login');
  assert.equal(ask({ github: lifted, review: { flows } }, [{ file: config, status: 'M' }, { file: 'docs/flows/booking.md', status: 'M' }]), 'human', 'a flow\'s invariants doc');
  assert.equal(ask({ github: lifted, review: { flows } }, [{ file: config, status: 'X' }]), 'human', 'a change type the floor cannot read');
  // Without the keys it stays the Human's, as on main, even for a change the floor asks nothing of, such as a source file.
  for (const github of [{}, { autoMerge: { includeGuardedPaths: true } }]) {
    assert.equal(ask({ github, review: { flows } }, [{ file: 'src/app.js', status: 'M' }]), 'human', JSON.stringify(github));
  }
  assert.equal(ask({ review: { flows } }, [{ file: 'src/app.js', status: 'M' }]), 'human', 'no github group');
});

test('reviewInForce: rules add up, flows and ignore lists come from the base, and every change is named', () => {
  const base = { rules: [{ depth: 'split', when: { lines: { over: 1 } } }], ignore: ['a'], nonBehaviour: [], flows: { f: { files: ['x'] } }, planCommand: 'base', reviewers: {} };
  const head = { rules: [], ignore: ['a', 'src/**'], nonBehaviour: [], flows: {}, planCommand: null, reviewers: {} };
  const { review, changed } = reviewInForce(base, head);
  assert.deepEqual([review.rules, review.ignore, review.flows, review.planCommand], [base.rules, ['a'], base.flows, 'base']);
  assert.deepEqual(changed, ['rules', 'ignore', 'flows', 'planCommand']);
  const engine = reviewInForce({ ...base, engine: 'pr-bot' }, { ...base, engine: 'self' });
  assert.deepEqual([engine.review.engine, engine.changed], ['pr-bot', ['engine']], 'the base`s engine is in force; the head`s pick is a change to the review');
  assert.equal(reviewInForce(null, { ...head, engine: 'self' }).review.engine, null, 'an engine the pull request adds runs once merged');
});

test('the round cap with extraRounds off: the last round goes to the final stage, and a round past the cap posts nothing new', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2, extraRounds: 'off' }, review: { flows } }, change: (write) => write('src/booking/a.js', '1\n') });
  const first = await r.step({ exec: clean });
  assert.equal(first.status, 'dispatch');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 2, fixed: 0 });
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  r.write('src/booking/a.js', '2\n');
  r.commit();
  let independent = 0;
  const last = await r.step({ exec: async () => (independent += 1, clean()) });
  assert.equal(independent, 1, 'round 2 of 2 ran the independent stage first, before the local stage was done');
  assert.equal(last.status, 'dispatch', 'the local stage can still finish within the last round');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: last.dispatch[0].pass, head: last.head, reviewer: 'code-reviewer', findings: 1, fixed: 0 });
  const capped = await r.step({ exec: clean });
  assert.deepEqual([capped.status, capped.open[0].open], ['round_limit', 1], 'a fix needs a new head, and there is no round left');
  // The outcome keeps what stopped it, for a judge's waiver: the flow left unsigned, and one open finding counted and not
  // listed, so none may stand.
  const cause = readLocalState(r.project, 7).outcome.cap;
  assert.deepEqual([cause.head, cause.reviewed, cause.counted, cause.itemized, cause.flows, cause.unrun, cause.bot], [capped.head, capped.head, 1, false, ['booking'], [], false]);
  assert.match(capProblem(readLocalState(r.project, 7), capped.head) ?? '', /flow booking has an invariant violated, unverified, or unsigned/u);
  assert.equal(stateFromComment(r.comments[0].body, 7).outcome.cap, undefined, 'the posted copy keeps no cause');
  // The CLI's JSON at the cap carries the unattended waiver's gate, so no gate command is typed: here, off, with no
  // judge dispatched for landing, since this machine never opted in.
  const printed = await r.cli({ exec: clean });
  assert.deepEqual([printed.code, printed.out.status, printed.out.waiver.may, printed.out.dispatch], [4, 'round_limit', false, undefined]);
  assert.match(printed.out.waiver.why, /this machine has not opted in/u);
  r.write('src/booking/a.js', '3\n');
  const pushed = r.commit();
  assert.equal((await r.step({ exec: clean })).status, 'round_limit');
  // A fix no round reviewed: the cause is the last round's, on the head before.
  const unreviewed = readLocalState(r.project, 7).outcome.cap;
  assert.deepEqual([unreviewed.head, unreviewed.reviewed, unreviewed.counted, unreviewed.itemized, unreviewed.unsigned], [pushed, capped.head, 1, false, ['booking']]);
  assert.match(capProblem(readLocalState(r.project, 7), pushed) ?? '', /flow booking has an invariant violated/u);
});

// A pull request at its round cap on head `capped`, one open finding on its agent pass, its flow unsigned.
// `extraRounds` is the base branch's github.extraRounds: under "ask" the cap's check waits for its judge. `baseFiles`
// seeds the base branch, and `change` writes the pull request's own change.
async function atCapRepo(t, extraRounds = 'off', { baseFiles = {}, change = (write) => write('src/booking/a.js', '1\n') } = {}) {
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 1, extraRounds }, review: { flows: { booking: { files: ['src/booking/**'] } } } }, baseFiles, change });
  const first = await r.step({ exec: clean });
  assert.equal(first.status, 'dispatch');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 1, fixed: 0 });
  const capped = await r.step({ exec: clean });
  assert.equal(capped.status, extraRounds === 'off' ? 'round_limit' : 'extension_check');
  // The base branch moves on with a change of its own, outside the pull request's files.
  r.git('switch', '-q', 'main');
  r.write('docs/notes.md', 'base notes\n');
  r.commit('base docs');
  r.git('switch', '-q', 'feat');
  return { r, capped };
}

test('a head at the cap that only merged the base carries the cap: no round, no extra-round check, the last round\'s cause', async (t) => {
  // The cap's check waits for its judge on the reviewed head; the merge needs no judge and no Human.
  const { r, capped } = await atCapRepo(t, 'ask');
  r.git('merge', '-q', '--no-edit', 'main');
  const merged = r.git('rev-parse', 'HEAD');
  let ran = 0;
  const step = await r.step({ exec: async () => (ran += 1, clean()) });
  assert.deepEqual([step.status, step.head, step.carried_from, ran], ['round_limit', merged, capped.head, 0], 'no reviewer runs');
  assert.equal(step.extension, undefined, 'no extra-round check');
  assert.match(step.raise ?? '', /^AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 7 --max-rounds 2 --repo o\/r$/u, 'the Human may still raise the cap');
  assert.deepEqual([step.question, step.options], [undefined, undefined], 'and is asked nothing');
  const state = readLocalState(r.project, 7);
  assert.deepEqual([state.rounds.length, state.outcome.carried_from, state.outcome.cap.head, state.outcome.cap.reviewed, state.outcome.cap.unsigned], [1, capped.head, merged, capped.head, ['booking']]);
});

test('a merge at the cap that changes the pull request\'s own diff gets no carry: the head is reviewed as today', async (t) => {
  const { r, capped } = await atCapRepo(t);
  // The merge also edits the pull request's own file.
  r.git('merge', '-q', '--no-commit', 'main');
  r.write('src/booking/a.js', '2\n');
  r.commit('merge main, and change app');
  const step = await r.step({ exec: clean });
  assert.equal(step.carried_from, undefined, 'nothing carries');
  assert.notEqual(readLocalState(r.project, 7).outcome.carried_from, capped.head);
});

// A merge from the base whose resolution also writes `file` as `resolve` gives it: the pull request's own diff differs.
async function mergeResolving(r, file, text) {
  r.git('merge', '-q', '--no-commit', 'main');
  r.write(file, text);
  r.commit('merge main');
}

test('a clean merge at the cap gets no carry when the pull request changes a binary file, even one the merge leaves alone', async (t) => {
  const { r, capped } = await atCapRepo(t, 'off', { baseFiles: { 'src/booking/logo.bin': '\0base\0' }, change: (write) => write('src/booking/logo.bin', '\0reviewed\0') });
  // The base changed only an unrelated file: the pull request's own diff is the very one the last round reviewed.
  r.git('merge', '-q', '--no-edit', 'main');
  const step = await r.step({ exec: clean });
  assert.equal(step.carried_from, undefined, 'git prints no contents for a binary file, so its patch is no proof the change is the same');
  assert.notEqual(readLocalState(r.project, 7).outcome.carried_from, capped.head);
});

test('a merge at the cap that moves the pull request\'s edit to another occurrence of the same line gets no carry', async (t) => {
  const twice = (first, second) => `export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n\nexport function c() {\n  ok(${first});\n}\n\nexport function d() {\n  ok(${second});\n}\n`;
  const { r, capped } = await atCapRepo(t, 'off', { baseFiles: { 'src/booking/a.js': twice('x', 'x') }, change: (write) => write('src/booking/a.js', twice('y', 'x')) });
  // The reviewed edit is undone in c and made in d: with no context and no hunk positions the two diffs read the same.
  await mergeResolving(r, 'src/booking/a.js', twice('x', 'y'));
  const step = await r.step({ exec: clean });
  assert.equal(step.carried_from, undefined, 'the lines around each edit tell the two occurrences apart');
  assert.notEqual(readLocalState(r.project, 7).outcome.carried_from, capped.head);
});

test('a clean merge at the cap gets no carry when the pull request changes bytes that are not UTF-8, even ones the merge leaves alone', async (t) => {
  // Latin-1 bytes, no NUL: git prints the patch as text, and each byte reads back as U+FFFD.
  const latin = (char) => Buffer.from(`export const name = 'caf${char}';\n`, 'latin1');
  const { r, capped } = await atCapRepo(t, 'off', { baseFiles: { 'src/booking/name.js': latin('\xe9') }, change: (write) => write('src/booking/name.js', latin('\xe8')) });
  // The base changed only an unrelated file: the pull request's own diff is the very one the last round reviewed.
  r.git('merge', '-q', '--no-edit', 'main');
  const step = await r.step({ exec: clean });
  assert.equal(step.carried_from, undefined, 'each byte reads back as U+FFFD, so the patch is no proof the change is the same');
  assert.notEqual(readLocalState(r.project, 7).outcome.carried_from, capped.head);
});

test('a base rename of the declaration above the pull request\'s edit, outside its context, still carries the cap', async (t) => {
  const body = (name, last) => `export function ${name}() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = ${last};\n  return a + e;\n}\n`;
  const { r, capped } = await atCapRepo(t, 'off', { baseFiles: { 'src/booking/sum.js': body('alpha', 5) }, change: (write) => write('src/booking/sum.js', body('alpha', 6)) });
  // The base renames the function, four lines above the edit: git's hunk header names it, the context does not.
  r.git('switch', '-q', 'main');
  r.write('src/booking/sum.js', body('beta', 5));
  r.commit('rename alpha');
  r.git('switch', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');
  const step = await r.step({ exec: clean });
  assert.deepEqual([step.status, step.carried_from], ['round_limit', capped.head], 'a hunk header\'s label is no part of the comparison');
});

test('a catch-up at a check waiting for its judge retires the check, and the verdict the step offers for the new head records', async (t) => {
  const { r, capped } = await atCapRepo(t, 'ask');
  assert.equal(readLocalState(r.project, 7).extensions[0].status, 'judging');
  r.git('merge', '-q', '--no-edit', 'main');
  const merged = r.git('rev-parse', 'HEAD');
  const step = await r.step({ exec: clean });
  assert.deepEqual([step.status, step.head, step.carried_from], ['round_limit', merged, capped.head]);
  const check = readLocalState(r.project, 7).extensions[0];
  assert.deepEqual([check.status, check.by, check.superseded_by], ['stopped', 'catch_up', merged], 'retired in the same write');
  // The judge the step offers when the waiver gate says one may rule: its record line, for the new head.
  const [judge] = offerLand({ ...step, pr: 7 }, { may: true, why: null }).dispatch;
  assert.equal(judge.record, `aidrian pr extend 7 --verdict land|stop --reason "<evidence>" --head ${merged} --judge <agent id>`);
  // That judge, dispatched in its session, records `stop` as the line says.
  const session = 'sess-judge';
  const project = projectAt(r.dir);
  const config = loadConfig(project).config;
  const log = logPath(project, config);
  mkdirSync(path.dirname(log), { recursive: true });
  writeFileSync(log, `${JSON.stringify({ event: 'dispatch', ts: new Date().toISOString(), session_id: session, dispatcher: 'main', agent_id: 'judge-1', agent_type: 'aidrian:code-reviewer' })}\n`);
  const printed = [];
  t.mock.method(console, 'log', (line) => printed.push(line));
  const code = await runExtend(['7', '--verdict', 'stop', '--reason', 'R1-1 is open', '--head', merged, '--judge', 'judge-1'], project, config, { forge: r.forge, repo: 'o/r', env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session } });
  t.mock.restoreAll();
  assert.equal(code, 0);
  const out = JSON.parse(printed.at(-1));
  assert.deepEqual([out.status, out.extension, out.waiver.head, out.waiver.verdict], ['recorded', null, merged, 'refuse'], 'no check of the old step waits to refuse it');
});

test('a cap record whose round kept no cause, from an older plugin, gets it from the round\'s results by the same code', async (t) => {
  const { r, capped } = await atCapRepo(t);
  const old = readLocalState(r.project, 7);
  delete old.rounds.at(-1).cap;
  delete old.outcome.cap;
  writeLocalState(r.project, old);
  r.git('merge', '-q', '--no-edit', 'main');
  const step = await r.step({ exec: clean });
  assert.equal(step.carried_from, capped.head);
  const state = readLocalState(r.project, 7);
  assert.deepEqual([state.outcome.cap.reviewed, state.outcome.cap.counted, state.outcome.cap.unrun, state.outcome.cap.unsigned], [capped.head, 1, [], ['booking']], 'a cause, not "cannot be told"');
  assert.equal(state.rounds.at(-1).cap.head, capped.head, 'kept on the round');
  assert.deepEqual([state.outcome.cap.reconstructed, state.rounds.at(-1).cap.reconstructed], [true, true], 'marked rebuilt, on the outcome and the round');
  assert.match(capProblem(state, step.head) ?? '', /rebuilt from an older plugin's record/u, 'its flow checks and the bot\'s limit are unknown: no waiver');
});

test('a round whose kept cause is a head past the cap is never rebuilt: the waiver stays refused', async (t) => {
  const { r } = await atCapRepo(t);
  const record = readLocalState(r.project, 7);
  // An attestation past the cap replaced the round's cause with that head's `past_cap` one; the passes still hold
  // their results on the round's head.
  const pastCap = { ...record.rounds.at(-1).cap, head: '0'.repeat(40), reviewed: '0'.repeat(40), past_cap: true, unsigned: null };
  record.rounds.at(-1).cap = pastCap;
  writeLocalState(r.project, record);
  r.git('merge', '-q', '--no-edit', 'main');
  const step = await r.step({ exec: clean });
  const state = readLocalState(r.project, 7);
  assert.deepEqual(state.rounds.at(-1).cap, pastCap, 'the round keeps the cause past the cap');
  assert.deepEqual([state.outcome.cap.unsigned, state.outcome.cap.reconstructed], [null, undefined], 'no cause is rebuilt');
  assert.match(capProblem(state, step.head) ?? '', /names no flows it left unsigned/u);
});

test('a failing reviewer is incomplete, then stuck after three attempts; a quota is not a failure', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'y\n') });
  const failing = async () => ({ status: 'failed', reason: 'boom' });
  assert.deepEqual([(await r.step({ exec: failing })).status, (await r.step({ exec: failing })).status, (await r.step({ exec: failing })).status], ['incomplete', 'incomplete', 'stuck']);
  const other = repo(t, { change: (write) => write('src/app.js', 'z\n') });
  assert.equal((await other.step({ exec: async () => ({ status: 'quota', reason: 'usage limit' }) })).status, 'blocked_quota');
});

test('unsatisfied: a flow that requires an independent model on a machine whose engine is self', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], require: ['independent-model'] } };
  const r = repo(t, { baseConfig: { version: 1, github: { reviewer: 'none' }, review: { flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const result = await r.step({ exec: clean, codex: () => ({ ok: false, reason: 'the codex CLI is not installed' }) });
  assert.equal(result.status, 'unsatisfied');
  assert.match(result.reason, /requires independent-model, and the engine here is self/u);
});

test('resolveEngine: auto takes codex, then the bot, then self; an explicit engine that cannot run is a problem', () => {
  const base = loadConfig({ root: '/nowhere', paths: { config: 'none.json', local: 'none' } }).config;
  const no = () => ({ ok: false, reason: 'codex is not logged in (`codex login`)' });
  assert.equal(resolveEngine(base, { codex: () => ({ ok: true }) }).reviewer.name, 'codex-local');
  assert.equal(resolveEngine(base, { codex: no }).reviewer.name, 'pr-bot');
  assert.equal(resolveEngine({ ...base, github: { ...base.github, reviewer: null } }, { codex: no }).reviewer.name, 'self');
  assert.match(resolveEngine({ ...base, reviewEngine: 'codex-local' }, { codex: no }).problem, /not logged in/u);
  assert.match(resolveEngine({ ...base, reviewEngine: 'mine' }).problem, /not a built-in engine/u);
});

test('resolveEngine: the project`s engine is policy and wins over the machine`s, and says where it came from', () => {
  const base = loadConfig({ root: '/nowhere', paths: { config: 'none.json', local: 'none' } }).config;
  const pinned = (engine, local) => ({ ...base, review: { ...base.review, engine }, reviewEngine: local });
  const ready = () => ({ ok: true });
  const bot = resolveEngine(pinned('pr-bot', 'codex-local'), { codex: ready });
  assert.equal(bot.reviewer.name, 'pr-bot', 'codex is ready and the machine asks for it, but the project decides');
  assert.equal(bot.reason, 'review.engine: pr-bot (set by the project config)');
  assert.equal(resolveEngine(pinned('auto', 'self'), { codex: ready }).reason, 'auto: codex is installed and logged in (set by the project config)');
  assert.match(resolveEngine(pinned('mine', 'self')).problem, /^config\.json review\.engine "mine" is not a built-in engine/u);
  assert.match(resolveEngine({ ...pinned('pr-bot', 'self'), github: { ...base.github, reviewer: null } }).problem, /^config\.json review\.engine is "pr-bot"/u);
  assert.equal(resolveEngine(pinned(null, 'self')).reason, 'review.engine: self', 'unset: the machine`s engine, as before');
});

test('runExec: a project reviewer reads its input on stdin and prints findings; bad output is a failure, never a pass', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-exec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = (body) => {
    const file = path.join(dir, `r${Math.random()}.mjs`);
    writeFileSync(file, body);
    return { name: 'mine', kind: 'exec', command: [process.execPath, file], timeoutSec: 5 };
  };
  const echo = script("let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const i=JSON.parse(s);console.log(JSON.stringify({findings:[{file:i.files[0],line:1,title:'t',body:'b',severity:'low'},{bad:1}],verdicts:[]}))})");
  const done = await runExec(echo, { files: ['a.js'] }, { root: dir, env: process.env });
  assert.deepEqual([done.status, done.findings.length, done.dropped], ['done', 1, ['findings[1] is malformed']]);
  assert.equal((await runExec(script('console.log("not json")'), {}, { root: dir, env: process.env })).status, 'failed');
  assert.equal((await runExec(script('process.exit(3)'), {}, { root: dir, env: process.env })).status, 'failed');
  const chatty = script("console.error('tokens used, quota left: 83,769');console.log(JSON.stringify({findings:[],verdicts:[]}))");
  assert.equal((await runExec(chatty, {}, { root: dir, env: process.env })).status, 'done', 'a successful run that logs the word quota is not a quota stop');
  assert.equal((await runExec(script("console.error('You hit your usage limit');process.exit(1)"), {}, { root: dir, env: process.env })).status, 'quota');
  assert.equal((await runExec({ ...script('setTimeout(()=>{}, 10000)'), timeoutSec: 1 }, {}, { root: dir, env: process.env })).status, 'timed_out');
  assert.equal(cleanOutput({ verdicts: [] }).valid, false);
});

test('sectionOf: a heading or a shell comment inside a fenced block is code, not a heading', () => {
  const doc = '# Doc\n\n## Deploy\nRun:\n\n```bash\n# build first\n## Fake\n```\n\nThen ship.\n\n## Next\nOther.\n';
  assert.equal(sectionOf(doc, 'fake'), null);
  const body = 'Run:\n\n```bash\n# build first\n## Fake\n```\n\nThen ship.';
  assert.deepEqual(sectionOf(doc, 'deploy'), { heading: 'Deploy', body, raw: body }, '`raw` keeps the fenced lines too');
});

test('sectionOf and invariantsOf: a fence opened after a list marker closes at its bare fence, and a heading after it is a heading', () => {
  const doc = '# T\n\n## A\nSteps:\n\n- ```bash\n  # build\n  npm run build\n  ```\n\n## B\nOther.\n\n- ```md\n  ## Fake\n\n## C\nLast.\n';
  assert.deepEqual(sectionOf(doc, 'a').raw, 'Steps:\n\n- ```bash\n  # build\n  npm run build\n  ```');
  assert.deepEqual(sectionOf(doc, 'b').body, 'Other.\n\n- ```md\n  ## Fake', 'an unclosed fence in a list item ends where the item ends');
  assert.equal(sectionOf(doc, 'fake'), null);
  assert.deepEqual(invariantsOf({ invariants: 'x.md' }, () => doc).invariants.map((each) => each.id), ['a', 'b', 'c']);
});

test('sectionOf, invariantsOf, and blocksOf read a CRLF doc: a heading or a comment in a fence is still code', () => {
  const doc = ['# T', '', '## A', 'Run:', '', '```bash', '# comment', '## Fake', '```', '', 'Then ship.', '', '## B', '', 'Other.', ''].join('\r\n');
  const body = 'Run:\n\n```bash\n# comment\n## Fake\n```\n\nThen ship.';
  assert.deepEqual(sectionOf(doc, 'a'), { heading: 'A', body, raw: body });
  assert.equal(sectionOf(doc, 'fake'), null);
  assert.equal(sectionOf(doc, 'b').raw, 'Other.', 'no CRLF blank line kept at the start of raw');
  assert.deepEqual(invariantsOf({ invariants: 'x.md' }, () => doc).invariants.map((each) => each.id), ['a', 'b']);
  assert.deepEqual(blocksOf(['Run:', '', '```bash', '# comment', '```', '', 'Then ship.'].join('\r\n')), ['Run:', '```bash\n# comment\n```', 'Then ship.']);
});

test('sectionOf, invariantsOf, and blocksOf: a fence counts at any indentation, in or outside a list', () => {
  for (const eol of ['\n', '\r\n']) {
    for (const pad of ['', '   ', '    ', '        ']) {
      const doc = ['# T', '', '## A', 'Example:', '', pad + '```md', pad + '## Fake', pad + '```', '', '## B', 'Rule b.', ''].join(eol);
      assert.equal(sectionOf(doc, 'fake'), null, `${pad.length} ${JSON.stringify(eol)}`);
      assert.equal(sectionOf(doc, 'b')?.body, 'Rule b.', `${pad.length} ${JSON.stringify(eol)}`);
      assert.deepEqual(invariantsOf({ invariants: 'x.md' }, () => doc).invariants.map((each) => each.id), ['a', 'b']);
    }
    // A marker-only list line, then a fence four spaces in that closes two spaces in: the shared detector once missed it.
    const bare = ['# T', '', '## A', '-', '    ```bash', '  ## Fake', '  ```', '', '## B', 'Rule b.', ''].join(eol);
    assert.equal(sectionOf(bare, 'fake'), null, JSON.stringify(eol));
    assert.equal(sectionOf(bare, 'b')?.body, 'Rule b.', JSON.stringify(eol));
    // Four columns in starts no top-level block, so the fence stays with the paragraph above it, and still closes.
    assert.deepEqual(blocksOf(['Example:', '', '    ```js', '    x', '    ```', '', 'After.'].join(eol)), ['Example:\n\n    ```js\n    x\n    ```', 'After.']);
  }
  // A thematic break is a block of its own in blocksOf, between the paragraphs around it.
  assert.deepEqual(blocksOf('Rule 1: foo\n- - -\nRule 2: bar'), ['Rule 1: foo', '- - -', 'Rule 2: bar']);
  assert.deepEqual(blocksOf('Rule 1: foo\r\n* * *\r\nRule 2: bar'), ['Rule 1: foo', '* * *', 'Rule 2: bar']);
});

test('sectionOf, invariantsOf, and blocksOf: a fence indented to its list item`s content column is still a fence', () => {
  for (const eol of ['\n', '\r\n']) {
    // A fence under a list item, at any indentation, is a fence: its `##` line is code.
    const doc = ['# T', '', '## A', '- Build:', '', '    ```bash', '    ## Fake', '    ```', '  - Nested:', '', '      ```md', '      ## Fake two', '      ```', '', '## B', 'Other.', ''].join(eol);
    assert.equal(sectionOf(doc, 'fake'), null, JSON.stringify(eol));
    assert.equal(sectionOf(doc, 'fake-two'), null, JSON.stringify(eol));
    assert.deepEqual(invariantsOf({ invariants: 'x.md' }, () => doc).invariants.map((each) => each.id), ['a', 'b'], JSON.stringify(eol));
    assert.deepEqual(blocksOf(['- Build:', '', '    ```bash', '    # build', '    ```', '', 'After.'].join(eol)), ['- Build:\n\n    ```bash\n    # build\n    ```', 'After.'], JSON.stringify(eol));
    // A fence under an item still pairs with its closer, so the heading after it is a heading and blocksOf keeps it in the item.
    assert.equal(sectionOf(['## A', '- step', '', '    ```', '    code', '  ```', '## Real', 'r'].join(eol), 'real')?.body, 'r', JSON.stringify(eol));
    assert.deepEqual(blocksOf(['- step', '     ```', '     x', '     ```', 'Next.'].join(eol)), ['- step\n     ```\n     x\n     ```', 'Next.'], JSON.stringify(eol));
  }
});

test('invariantsOf: a heading inside a fenced block is not an invariant', () => {
  const read = () => '# T\n\n## Keep bookings\nA booking stays.\n\n```md\n## Fake\nnot a rule\n```\n';
  assert.deepEqual(invariantsOf({ invariants: 'inv.md' }, read).invariants.map((each) => each.id), ['keep-bookings']);
});

test('invariantsOf and flowState: a doc gives one invariant per heading; a flow with none is unspecified', () => {
  const read = (file) => (file === 'inv.md' ? '# T\n\n## Never lose a booking\nA booking stays.\n' : null);
  assert.deepEqual(invariantsOf({ invariants: 'inv.md' }, read).invariants, [{ id: 'never-lose-a-booking', text: 'Never lose a booking: A booking stays.', cite: 'inv.md#never-lose-a-booking' }]);
  assert.equal(invariantsOf({}, read).unspecified, true);
  assert.equal(invariantsOf({ invariants: 'gone.md' }, read).problem, 'gone.md is missing');
  const state = flowState([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [
    { invariant: 'a', verdict: 'holds', evidence: 'ok' },
    { invariant: 'b', verdict: 'violated', evidence: 'ok' },
    { invariant: 'c', verdict: 'holds', evidence: 'bad' },
  ], (evidence) => (evidence === 'ok' ? null : 'missing'));
  assert.deepEqual(state, { signed: false, open: ['b'], unverified: ['c'], disputed: [] });
});

test('flowState: a dispute needs a holds from a reviewer that gave no violated verdict of its own', () => {
  const ok = () => null;
  const one = flowState([{ id: 'a' }], [{ invariant: 'a', verdict: 'violated', evidence: 'x', reviewer: 'codex' }, { invariant: 'a', verdict: 'holds', evidence: 'x', reviewer: 'codex' }], ok, new Set(['a']));
  assert.deepEqual(one, { signed: false, open: ['a'], unverified: [], disputed: [] }, 'one reviewer contradicting itself is no dispute, and an overrule does nothing');
  const two = flowState([{ id: 'a' }], [{ invariant: 'a', verdict: 'violated', evidence: 'x', reviewer: 'codex' }, { invariant: 'a', verdict: 'holds', evidence: 'x', reviewer: 'security-engineer' }], ok, new Set(['a']));
  assert.deepEqual(two, { signed: true, open: [], unverified: [], disputed: ['a'] });
});

test('citationProblem: a path:line must exist at the head, a test:<name> must appear in a file', (t) => {
  const r = repo(t, { change: (write) => write('src/app.test.js', "test('books a slot', () => {});\n") });
  const head = r.git('rev-parse', 'HEAD');
  assert.equal(citationProblem('src/app.js:1', { root: r.dir, head }), null);
  assert.match(citationProblem('src/app.js:9', { root: r.dir, head }), /no line 9/u);
  assert.equal(citationProblem('test:books a slot', { root: r.dir, head }), null);
  assert.match(citationProblem('test:missing', { root: r.dir, head }), /names the test/u);
  assert.match(citationProblem('trust me', { root: r.dir, head }), /not path:line/u);
  assert.match(citationProblem('/src/app.js:1', { root: r.dir, head }), /is not in/u, 'a leading slash names no file of the commit');
  assert.equal(citationProblem('./src/app.js:1', { root: r.dir, head }), null);
  for (const folder of ['src:1', './src:1', './:1', '.:1', '..:1', '/:1']) assert.notEqual(citationProblem(folder, { root: r.dir, head }), null, folder);
  assert.match(citationProblem('src:1', { root: r.dir, head }), /is a folder/u);
});

test('flow evidence: a deleted flow test needs the Human, and the flow`s checks must pass on the head', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], tests: ['test/booking*'], checks: ['E2E booking'] } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { flows } },
    baseFiles: { 'test/booking.test.js': "test('books', () => {});\n" },
    change: (write, dir) => {
      write('src/booking/a.js', '1\n');
      rmSync(path.join(dir, 'test/booking.test.js'));
    },
  });
  const head = r.git('rev-parse', 'HEAD');
  // GitHub's check runs of the head: one in progress, then done with each conclusion.
  let runs = [{ name: 'E2E booking (shard 1)', status: 'in_progress', conclusion: null }];
  r.forge.checkRuns = (_repo, sha) => (sha === head ? runs : []);
  const first = await r.step({ exec: clean });
  for (const pass of first.dispatch) {
    recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head, reviewer: 'code-reviewer', findings: 0, fixed: 0,
      verdictsText: JSON.stringify([{ flow: 'booking', invariant: 'unspecified', verdict: 'holds', evidence: 'src/booking/a.js:1' }]) });
  }
  const removed = await r.step({ exec: clean });
  assert.equal(removed.status, 'fix_required');
  assert.deepEqual(removed.tests_removed.map((each) => each.deleted), [['test/booking.test.js']]);
  recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'booking', head, by: 'Tester' });
  assert.equal((await r.step({ exec: clean })).status, 'checks_pending');
  runs = [{ name: 'E2E booking (shard 1)', status: 'completed', conclusion: 'skipped' }];
  assert.equal((await r.step({ exec: clean })).status, 'fix_required', 'a skipped required check is not a pass');
  runs = [{ name: 'E2E booking (shard 1)', status: 'completed', conclusion: 'success' }];
  assert.equal((await r.step({ exec: clean })).status, 'received');
});

test('the review bot as the engine: a thumbs-up passes, a review with comments is open', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'b\n') });
  const off = () => ({ ok: false, reason: 'the codex CLI is not installed' });
  const comments = await r.step({ codex: off, awaitBot: async () => ({ status: 'received', signal: { kind: 'review', line_comments: 2 } }) });
  assert.deepEqual([comments.status, comments.open[0].open], ['fix_required', 2]);
  assert.equal(readLocalState(r.project, 7).rounds.at(-1).floor, undefined, 'two inline comments are a count');
  r.write('src/app.js', 'b2\n');
  r.commit();
  const bare = await r.step({ codex: off, awaitBot: async () => ({ status: 'received', signal: { kind: 'review', line_comments: 0 } }) });
  assert.deepEqual([bare.status, bare.open[0].open, bare.open[0].floor], ['fix_required', 1, true]);
  assert.equal(readLocalState(r.project, 7).rounds.at(-1).floor, true, 'an answer with no inline comment holds at least one');
  r.write('src/app.js', 'c\n');
  r.commit();
  const approval = await r.step({ codex: off, awaitBot: async () => ({ status: 'received', signal: { kind: 'review', state: 'APPROVED', line_comments: 0 } }) });
  // latestBotSignal counts no thread reply (test/pr-await-review.test.mjs), so an approval with only replies reads as this one.
  assert.equal(approval.status, 'received', 'an approval with no inline comment is clean, as the bot history reads it');
  assert.ok(Object.values(readLocalState(r.project, 7).passes).some((pass) => pass.bot && pass.open === 0 && pass.floor === undefined));
});

test('the review bot`s clean comment on a draft records no open finding, and the step is received; another comment holds one', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'b\n') });
  const off = () => ({ ok: false, reason: 'the codex CLI is not installed' });
  const { latestBotSignal, DEFAULT_REVIEWER } = await import('../plugins/aidrian/lib/pr-await-review.mjs');
  const answer = (body) => async ({ head }) => ({ status: 'received', head_sha: head, signal: latestBotSignal({
    reviews: [], reviewComments: [], reactions: [], reviewer: DEFAULT_REVIEWER, since: '2026-11-12T12:00:00Z',
    issueComments: [{ id: 1, user: { login: DEFAULT_REVIEWER }, created_at: '2026-11-12T12:30:19Z', body: body(head) }],
  }) });
  const named = await r.step({ codex: off, awaitBot: answer((head) => `Codex Review: one finding.\n\n**Reviewed commit:** \`${head.slice(0, 10)}\``) });
  assert.deepEqual([named.status, named.open[0].open], ['fix_required', 1], 'a comment that is no clean receipt still holds a finding');
  r.write('src/app.js', 'c\n');
  r.commit();
  const received = await r.step({ codex: off, awaitBot: answer((head) => `<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues. Breezy!\n\n**Reviewed commit:** \`${head.slice(0, 10)}\``) });
  assert.equal(received.status, 'received');
  const bot = Object.values(readLocalState(r.project, 7).passes).find((result) => result.head === received.head && result.bot);
  assert.deepEqual([bot.open, bot.findings, bot.bot.kind], [0, 0, 'comment']);
});

test('a failed review bot run records no finding: the next step asks the bot again in the same round, and a second failure is stuck', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'b\n') });
  const off = () => ({ ok: false, reason: 'the codex CLI is not installed' });
  // The wait as pr-await-review.mjs ends it on the bot's failure notice: a timeout marked bot_failed, never received.
  let calls = [];
  const awaitBot = async ({ head, request, timeoutSec, countedFailures }) => {
    calls.push({ request, timeoutSec, countedFailures });
    const asked = request ? { requested: true, requested_head: head } : { requested: false };
    if (timeoutSec === 0) return { status: 'timed_out', head_sha: head, signal: null, ...asked };
    return { status: 'timed_out', bot_failed: true, retry_recommended: true, head_sha: head, signal: { kind: 'failed', review_id: null, line_comments: 0, failure_id: `comment:${calls.length}` }, ...asked };
  };
  const first = await r.step({ codex: off, awaitBot });
  assert.deepEqual([first.status, first.retry_recommended, first.attempts], ['incomplete', true, 1], first.reason);
  const state = () => readLocalState(r.project, 7);
  const botPasses = () => Object.values(state().passes ?? {}).filter((pass) => pass.bot);
  assert.deepEqual(botPasses(), [], 'a failed run is no answer and holds no finding');
  assert.equal(state().rounds.at(-1).floor, undefined, 'the round history reads no open finding');
  const rounds = state().rounds.length;
  const firstRun = state().failedRuns;
  assert.equal(firstRun.length, 1, 'the counted run is on record');
  calls = [];
  const second = await r.step({ codex: off, awaitBot });
  assert.ok(calls.some((call) => call.request === true), `the step after a failure asks the bot again: ${JSON.stringify(calls)}`);
  assert.ok(calls.every((call) => call.countedFailures.includes(firstRun[0])), 'every wait is told which run was counted');
  assert.deepEqual([second.status, second.retry_recommended, second.attempts], ['stuck', false, 2], second.reason);
  assert.match(second.reason, /aidrian pr await-review 7 --request/);
  assert.deepEqual(botPasses(), [], 'a second failure records the pass as failed, never as open findings');
  assert.equal(state().rounds.length, rounds, 'the retry runs in the round it was asked in');
  assert.equal(state().rounds.at(-1).floor, undefined);
});

test('a failed review bot run of a newer head counts nothing on this head, and keeps the request recorded for the newer one', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'b\n') });
  const off = () => ({ ok: false, reason: 'the codex CLI is not installed' });
  const newer = 'e'.repeat(40);
  const awaitBot = async ({ head, timeoutSec }) => (timeoutSec === 0
    ? { status: 'timed_out', head_sha: head, requested: true, requested_head: head, signal: null }
    : { status: 'timed_out', bot_failed: true, retry_recommended: true, head_sha: newer, requested: true, requested_head: newer, signal: { kind: 'failed', commit_id: newer } });
  const moved = await r.step({ codex: off, awaitBot });
  assert.deepEqual([moved.status, moved.retry_recommended], ['incomplete', true], moved.reason);
  assert.match(moved.reason, /moved to eeeeeee/);
  const state = readLocalState(r.project, 7);
  assert.deepEqual(state.failures, {}, 'no failure is charged to the head the step reviewed');
  assert.equal(state.failedRuns, undefined, 'and no run of the newer head is counted');
  assert.equal(state.botRequest?.head, newer, 'the request for the newer head stays on record');
});

test('the review bot`s clean receipt beside its status card of the head that still holds a finding is open work, never a pass', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'b\n') });
  const off = () => ({ ok: false, reason: 'the codex CLI is not installed' });
  const { latestBotSignal, DEFAULT_REVIEWER } = await import('../plugins/aidrian/lib/pr-await-review.mjs');
  const user = { login: DEFAULT_REVIEWER };
  const card = (head, flag) => ({ id: 2, user, created_at: '2026-11-12T12:01:00Z', updated_at: '2026-11-12T12:31:00Z', body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${head}","has_any_findings":${flag},"has_unresolved_findings":${flag},"status":"completed"}} -->` });
  const answer = (flag) => async ({ head }) => ({ status: 'received', head_sha: head, signal: latestBotSignal({
    reviews: [], reviewComments: [], reactions: [], reviewer: DEFAULT_REVIEWER, since: '2026-11-12T12:00:00Z',
    issueComments: [card(head, flag), { id: 1, user, created_at: '2026-11-12T12:30:19Z', body: `<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues. Breezy!\n\n**Reviewed commit:** \`${head.slice(0, 10)}\`` }],
  }) });
  const held = await r.step({ codex: off, awaitBot: answer(true) });
  assert.deepEqual([held.status, held.open[0].open, held.open[0].holds_finding], ['fix_required', 1, true]);
  r.write('src/app.js', 'c\n');
  r.commit();
  const cleared = await r.step({ codex: off, awaitBot: answer(false) });
  assert.equal(cleared.status, 'received', 'the bot cleared its card on a later run');
});

test('an independent reviewer`s violated verdict blocks the flow even with no findings', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { flows: { booking: { files: ['src/booking/**'] } } } }, change: (write) => write('src/booking/a.js', '1\n') });
  const first = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: holdsAll(first.dispatch[0], 'src/booking/a.js:1') });
  const violated = async () => ({ status: 'done', findings: [], verdicts: [{ flow: 'booking', invariant: 'unspecified', verdict: 'violated', evidence: 'src/booking/a.js:1' }], dropped: [] });
  const result = await r.step({ exec: violated });
  // The code reviewer answered holds with evidence, so the reviewers disagree: still blocked, with the Human's way out named.
  assert.deepEqual([result.status, result.stage, result.flows], ['fix_required', 'independent', [{
    flow: 'booking', violated: ['unspecified'], unverified: [], disputed: ['unspecified'],
    overrule: [`aidrian pr signoff 7 --flow booking --overrule unspecified --head ${first.head} --reason "<why>"`],
    next: [{ invariant: 'unspecified', state: 'disputed', commands: [`aidrian pr signoff 7 --flow booking --overrule unspecified --head ${first.head} --reason "<why>"`], notes: [] }],
  }]]);
});

test('the Human overrules a disputed violated verdict on one head; an undisputed one, or one with no reason, is refused', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] }, pay: { files: ['src/pay/**'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => (write('src/booking/a.js', '1\n'), write('src/pay/a.js', '1\n')) });
  const first = await r.step({ exec: clean });
  const pass = first.dispatch[0];
  const verdicts = [{ flow: 'booking', invariant: 'unspecified', verdict: 'holds', evidence: 'src/booking/a.js:1' }];
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([...verdicts, { flow: 'pay', invariant: 'unspecified', verdict: 'holds', evidence: 'src/pay/a.js:1' }]) });
  // The independent model says both flows are violated; only pay's reviewer agrees with it, so only booking is disputed.
  const exec = async () => ({ status: 'done', findings: [], verdicts: [
    { flow: 'booking', invariant: 'unspecified', verdict: 'violated', evidence: 'src/booking/a.js:1' },
    { flow: 'pay', invariant: 'unspecified', verdict: 'violated', evidence: 'src/pay/a.js:1' },
  ], dropped: [] });
  const blocked = await r.step({ exec });
  assert.equal(blocked.status, 'fix_required');
  const overrule = (flow, reason = 'the security reviewer showed the base already behaves this way') => recordOverrule(r.project, { pr: 7, repo: 'o/r', flow, invariant: 'unspecified', head: first.head, by: 'Tester', reason });
  assert.throws(() => overrule('booking', ' '), /needs --reason/u);
  assert.throws(() => recordOverrule(r.project, { pr: 7, repo: 'o/r', flow: 'booking', invariant: 'nope', head: first.head, by: 'Tester', reason: 'x' }), /is not disputed/u);
  overrule('booking');
  const after = await r.step({ exec });
  assert.deepEqual(after.flows?.map((flow) => flow.flow), ['pay'], 'booking passes on the reviewer evidence; pay stays violated');
  assert.ok(readLocalState(r.project, 7).overrides.some((line) => /Tester overruled the violated verdict on booking\/unspecified/u.test(line)), 'listed with the overrides');
  r.write('src/booking/a.js', '2\n');
  const next = r.commit();
  assert.throws(() => recordOverrule(r.project, { pr: 7, repo: 'o/r', flow: 'booking', invariant: 'unspecified', head: next, by: 'Tester', reason: 'x' }), /no review of o\/r#7 ran on/u, 'a ruling is for one head');
});

test('--overrule on an unverified invariant names both routes, the ingest and cite, and the Human`s --accept; on an undisputed violated one, neither', async (t) => {
  const flows = { ...APPROVED_FLOWS, pay: { files: ['src/ui/**'], invariants: [{ id: 'cap', text: 'Does a refund stay under the charge?' }] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  const first = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([
    { flow: 'look', invariant: 'matches-design', verdict: 'cannot_verify', evidence: 'no app runs' },
    { flow: 'look', invariant: 'keeps-copy', verdict: 'holds', evidence: 'src/ui/a.js:1' },
    { flow: 'pay', invariant: 'cap', verdict: 'violated', evidence: 'src/ui/a.js:1' },
  ]) });
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  const overrule = (flow, invariant) => () => recordOverrule(r.project, { pr: 7, repo: 'o/r', flow, invariant, head: first.head, by: 'Tester', reason: 'x' });
  assert.throws(overrule('look', 'matches-design'), (error) => {
    assert.match(error.message, /is not disputed on .*: it is unverified/u);
    assert.match(error.message, /aidrian pr ingest \d+ --head /u);
    assert.match(error.message, /--accept matches-design /u);
    return true;
  });
  assert.throws(overrule('pay', 'cap'), (error) => {
    assert.match(error.message, /is not disputed on .*Fix the code, or have a reviewer record its verdict with evidence first$/u);
    assert.doesNotMatch(error.message, /aidrian pr ingest|--accept/u, 'no route closes a violated invariant');
    return true;
  });
  assert.throws(() => recordAccept(r.project, { pr: 7, repo: 'o/r', flow: 'pay', invariant: 'cap', head: first.head, by: 'Tester', reason: 'x', evidence: 'https://github.com/o/r/pull/7#issuecomment-1', checkEvidence: () => 'comment' }), /never clears a violated invariant/u);
});

test('a flow only the independent model reviews is signed by its verdicts', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], require: ['independent-model'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const holds = async () => ({ status: 'done', findings: [], verdicts: [{ flow: 'pay', invariant: 'unspecified', verdict: 'holds', evidence: 'src/pay/a.js:1' }], dropped: [] });
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  r.write('src/pay/a.js', '2\n');
  r.commit();
  assert.equal((await r.step({ exec: holds })).status, 'received');
});

test('the plan command runs from the base: a PR that edits it, or adds one, cannot run its own', async (t) => {
  const planner = (extra) => `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:'single',stages:[{name:'local',passes:[{id:'${extra}',reviewer:'${extra}',kind:'agent',files:null}]}]})))`;
  const r = repo(t, {
    baseConfig: { version: 1, review: { planCommand: 'node scripts/plan.mjs' } },
    baseFiles: { 'scripts/plan.mjs': planner('base-reviewer') },
    change: (write) => write('scripts/plan.mjs', planner('head-reviewer')),
  });
  const result = await r.step({ exec: clean });
  assert.deepEqual(result.dispatch.map((each) => each.agent).sort(), ['base-reviewer', 'code-reviewer']);
  assert.ok(result.plan.flows.includes('harness-config'), 'editing the planner is a change to the review');
  const added = repo(t, { headConfig: { version: 1, review: { planCommand: 'node -e "process.exit(9)"' } }, change: (write) => write('src/app.js', '5\n') });
  const run = await added.step({ exec: clean });
  assert.notEqual(run.status, 'unsatisfied', 'a planner the PR adds does not run');
  assert.ok(run.plan.flows.includes('harness-config'));
});

test('a PR cannot redefine a project reviewer: the base definition runs, and a new name is only added', () => {
  const base = { rules: [], ignore: [], nonBehaviour: [], flows: {}, planCommand: null, reviewers: { lint: { kind: 'exec', command: ['bin/strict'] } } };
  const head = { ...base, reviewers: { lint: { kind: 'exec', command: ['true'] }, extra: { kind: 'agent', agent: 'x' } } };
  assert.deepEqual(reviewInForce(base, head).review.reviewers, { lint: { kind: 'exec', command: ['bin/strict'] }, extra: { kind: 'agent', agent: 'x', pending: true } });
  assert.deepEqual(reviewInForce(base, head).changed, ['reviewers']);
});

test('deleting a flow`s test alone, with the flow`s code untouched, still stops the review', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], tests: ['test/booking*'] } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { flows } },
    baseFiles: { 'test/booking.test.js': 'x\n', 'src/booking/a.js': 'y\n' },
    change: (write, dir) => {
      rmSync(path.join(dir, 'test/booking.test.js'));
      write('src/app.js', '2\n');
    },
  });
  const result = await r.step({ exec: clean });
  assert.equal(result.status, 'fix_required');
  assert.deepEqual(result.tests_removed.map((each) => [each.flow, each.deleted]), [['booking', ['test/booking.test.js']]]);
});

test('a clean last round passes; a failed or quota run gives its round back', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 1 }, review: { flows } }, change: (write) => write('src/booking/a.js', '1\n') });
  assert.equal((await r.step({ exec: async () => ({ status: 'failed', reason: 'x' }) })).status, 'incomplete');
  assert.equal((await r.step({ exec: async () => ({ status: 'quota', reason: 'usage limit' }) })).status, 'blocked_quota');
  const first = await r.step({ exec: clean });
  assert.deepEqual([first.status, first.round], ['dispatch', 1], 'the failed runs used no round, and the final stage ran first');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: holdsAll(first.dispatch[0], 'src/booking/a.js:1') });
  assert.equal((await r.step({ exec: clean })).status, 'received');
});

test('--with-bot adds the review bot as the last stage after this machine`s engine', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', '9\n') });
  let asked = 0;
  const result = await r.step({ exec: clean, awaitBot: async () => (asked += 1, { status: 'received', requested: true, signal: { kind: 'thumbs_up' } }) }, { withBot: true });
  assert.deepEqual([result.status, asked, result.plan.stages.map((stage) => stage.name)], ['received', 1, ['independent', 'remote']]);
});

// A bot that has not answered yet: the request goes out, and the wait ends with nothing for this head.
const botLog = (calls, answer = () => ({ status: 'received', requested: false, signal: { kind: 'thumbs_up' } })) => async (opts) => {
  calls.push(['bot', opts.request, opts.timeoutSec]);
  return opts.timeoutSec === 0 ? { status: 'timed_out', requested: opts.request, signal: null } : answer();
};

test('--with-bot asks the review bot when a head`s round opens, before this machine`s engine runs, and awaits it last', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', '9\n') });
  const calls = [];
  const failing = async () => (calls.push(['exec']), { status: 'failed', reason: 'crashed' });
  const failed = await r.step({ exec: failing, awaitBot: botLog(calls) }, { withBot: true });
  assert.equal(failed.status, 'incomplete');
  assert.deepEqual(calls, [['bot', true, 0], ['exec']], 'the bot is asked first, with no wait, and the engine runs while it reviews');
  assert.equal(failed.round, 1, 'the round the bot was asked on is kept');
  calls.length = 0;
  const result = await r.step({ exec: async () => (calls.push(['exec']), clean()), awaitBot: botLog(calls) }, { withBot: true });
  assert.equal(result.status, 'received');
  assert.deepEqual(calls, [['exec'], ['bot', false, 840]], 'the head was asked about once: the step only waits for the answer');
  assert.equal(result.round, 1);
});

test('--with-bot: the bot is asked in the step that dispatches the agent passes, once per head, and again after a push', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/booking/a.js', '1\n') });
  const off = () => ({ ok: false, reason: 'the codex CLI is not installed' });
  const calls = [];
  const first = await r.step({ codex: off, exec: clean, awaitBot: botLog(calls) }, { withBot: true });
  assert.deepEqual([first.status, calls], ['dispatch', [['bot', true, 0]]], 'the bot reviews while the agents do');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 1, fixed: 0, verdictsText: holdsAll(first.dispatch[0], 'src/booking/a.js:1') });
  assert.equal((await r.step({ codex: off, exec: clean, awaitBot: botLog(calls) }, { withBot: true })).status, 'fix_required');
  assert.deepEqual(calls, [['bot', true, 0]], 'a finding of an earlier stage is reported before the bot is awaited, and the head is not asked again');
  r.write('src/booking/a.js', '2\n');
  r.commit();
  calls.length = 0;
  const next = await r.step({ codex: off, exec: clean, awaitBot: botLog(calls) }, { withBot: true });
  assert.deepEqual([next.status, next.round, calls], ['dispatch', 2, [['bot', true, 0]]], 'a new head is asked about at once');
});

test('--with-bot: a request the final wait posts is remembered too, so the next step on the head only waits', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', '9\n') });
  const calls = [];
  // GitHub lagged at the first look, so the early call posted nothing; the final wait posted the request and timed out.
  const bot = async (opts) => (calls.push(['bot', opts.request, opts.timeoutSec]), { status: 'timed_out', requested: opts.request && opts.timeoutSec > 0, signal: null });
  assert.equal((await r.step({ exec: clean, awaitBot: bot }, { withBot: true })).status, 'timed_out');
  assert.deepEqual(calls, [['bot', true, 0], ['bot', true, 840]]);
  calls.length = 0;
  await r.step({ exec: clean, awaitBot: bot }, { withBot: true });
  assert.deepEqual(calls, [['bot', false, 840]], 'the head was asked about: no second request');
});

test('--with-bot: an early request that went to a newer head ends the step before any reviewer runs, and that head is not asked again', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', '9\n') });
  const newer = 'f'.repeat(40);
  const calls = [];
  const bot = async (opts) => (calls.push(['bot', opts.request, opts.timeoutSec]), { status: 'timed_out', requested: true, requested_head: newer, head_sha: newer, signal: null });
  const moved = await r.step({ exec: async () => (calls.push(['exec']), clean()), awaitBot: bot }, { withBot: true });
  assert.deepEqual([moved.status, moved.retry_recommended, moved.round, calls], ['incomplete', true, 0, [['bot', true, 0]]]);
  assert.match(moved.reason, /moved to fffffff/u);
  assert.equal(readLocalState(r.project, 7).botRequest.head, newer, 'the request is on record for the head it asked about');
});

test('--with-bot: a request the wait posted before a push is on record for its own head, never for the head it then saw', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', '9\n') });
  const head = r.git('rev-parse', 'HEAD');
  const newer = 'f'.repeat(40);
  // The early look saw GitHub lag; the final wait asked about this head, then saw a push it may not ask about.
  const bot = async (opts) => (opts.timeoutSec === 0 ? { status: 'timed_out', requested: false, signal: null } : { status: 'head_moved', requested: true, requested_head: head, head_sha: newer, signal: null });
  assert.equal((await r.step({ exec: clean, awaitBot: bot }, { withBot: true })).status, 'incomplete');
  assert.equal(readLocalState(r.project, 7).botRequest.head, head, 'the newer head is still asked about when its step runs');
});

test('--with-bot under the review gate: the bot is asked as soon as the code-reviewer is on record, while the engine still runs', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { reviewGate: { enabled: true, checklist: null } } }, change: (write) => write('src/app.js', 'q\n') });
  const calls = [];
  const exec = async () => (calls.push(['exec']), clean());
  const first = await r.step({ exec, awaitBot: botLog(calls) }, { withBot: true });
  assert.deepEqual([first.status, first.dispatch[0].agent, calls], ['dispatch', 'code-reviewer', []], 'no request before the gate allows one');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0 });
  const done = await r.step({ exec, awaitBot: botLog(calls) }, { withBot: true });
  assert.deepEqual([done.status, calls], ['received', [['bot', true, 0], ['exec'], ['bot', false, 840]]]);
});

test('runExec: a reviewer that ignores SIGTERM is killed, and the step still answers', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-exec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'stubborn.mjs');
  writeFileSync(file, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const started = Date.now();
  const result = await runExec({ name: 'stubborn', kind: 'exec', command: [process.execPath, file], timeoutSec: 1 }, {}, { root: dir, env: process.env });
  assert.equal(result.status, 'timed_out');
  assert.ok(Date.now() - started < 15000);
});

test('newer: the record with the higher revision wins, whatever its counts', async () => {
  const { newer } = await import('../plugins/aidrian/lib/review/state.mjs');
  const stale = { revision: 3, rounds: [{}, {}], passes: { a: { open: 0 } } };
  const fresh = { revision: 4, rounds: [{}], passes: { a: { open: 2 } } };
  assert.equal(newer(stale, fresh), fresh);
  assert.equal(newer(fresh, stale), fresh);
});

test('deleting only an ignored flow test, with nothing else to review, still stops the review', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], tests: ['test/booking*'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, baseFiles: { 'test/booking.snap': 'x\n' }, change: (_write, dir) => rmSync(path.join(dir, 'test/booking.snap')) });
  const result = await r.step({ exec: clean });
  assert.deepEqual([result.status, result.tests_removed?.[0]?.deleted], ['fix_required', ['test/booking.snap']]);
  recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'booking', head: result.head, by: 'Tester' });
  assert.equal((await r.step({ exec: clean })).status, 'received');
});

test('a pass recorded on a stale local copy builds on the pull request`s newer record', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'q\n') });
  const remote = { version: 1, revision: 9, updatedAt: '2026-10-31T00:00:00.000Z', pr: 7, repo: 'o/r', rounds: [{ head: 'x' }], passes: { other: { head: 'x', open: 2 } }, signoffs: {}, overrides: [], failures: {} };
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: 'mine', head: 'h', reviewer: 'r', findings: 0, fixed: 0, remote: [{ id: 1, body: summaryBody(remote, null, 'x', OPEN), author_association: 'MEMBER' }] });
  const { readLocalState } = await import('../plugins/aidrian/lib/review/state.mjs');
  const state = readLocalState(r.project, 7);
  assert.deepEqual([state.revision, Object.keys(state.passes).sort(), state.passes.other.open], [10, ['mine', 'other'], 2]);
});

test('a held summary comment: a machine without that record gets incomplete and edits nothing; the writer goes on', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'held\n') });
  const exec = async () => ({ status: 'done', findings: [finding], verdicts: [], dropped: [] });
  assert.equal((await r.step({ exec })).status, 'fix_required');
  const written = readLocalState(r.project, 7);
  r.comments[0].body = holdComment(r.comments[0].body, written.revision);
  const held = r.comments[0].body;
  rmSync(path.join(stateDir(r.project), 'reviews'), { recursive: true, force: true });

  const other = await r.step({ exec: () => assert.fail('no reviewer runs') });
  assert.deepEqual([other.status, other.retry_recommended, other.held], ['incomplete', false, written.revision]);
  assert.match(other.reason, new RegExp(`at revision ${written.revision} on the machine that wrote it`, 'u'));
  assert.equal(r.comments[0].body, held, 'the comment is not edited');
  assert.equal(readLocalState(r.project, 7), null, 'no record is started over the held one');
  assert.throws(() => recordPass(r.project, { pr: 7, repo: 'o/r', pass: 'engine:codex-local', head: other.head, reviewer: 'codex-local', findings: 0, fixed: 0, remote: remoteState('o/r', 7, r.forge) }), /on the machine that wrote it/u);
  assert.throws(() => recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'f', head: other.head, by: 'T', remote: remoteState('o/r', 7, r.forge) }), /on the machine that wrote it/u);

  // A held marker at revision 0 (no write makes one) is no record to wait for: attest starts this machine's own.
  const zero = [{ id: 1, body: r.comments[0].body.replace(/aidrian-review-state-held:\d+/u, 'aidrian-review-state-held:0'), author_association: 'MEMBER' }];
  assert.equal(recordPass(r.project, { pr: 7, repo: 'o/r', pass: 'p', head: other.head, reviewer: 'r', findings: 0, fixed: 0, remote: zero }).open, 0);
  rmSync(path.join(stateDir(r.project), 'reviews'), { recursive: true, force: true });

  // The writer: its record is the held one, so it goes on, and the record fits the comment again.
  writeLocalState(r.project, { ...written, revision: written.revision - 1 });
  const writer = await r.step({ exec });
  assert.equal(writer.status, 'fix_required');
  assert.equal(heldRevision(r.comments[0].body), null);
  assert.equal(stateFromComment(r.comments[0].body, 7).revision, written.revision + 1);
});

test('a split review step drops the slice results of a packing the head no longer makes', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { rules: [{ when: { lines: { over: 1 } }, depth: 'split' }] } }, change: (write) => (write('src/a/x.js', '1\n'), write('src/b/x.js', '2\n')) });
  const stale = { head: 'old', reviewer: 'codex-local', files: ['src/gone.js'], findings: 4, open: 4, list: [] };
  writeLocalState(r.project, { ...emptyState(7, 'o/r'), passes: { 'slice:codex-local:0123456789': stale, 'engine:codex-local': { head: 'old', files: null, findings: 0, open: 0 } } });
  const result = await r.step({ exec: clean });
  assert.equal(result.status, 'running');
  const passes = Object.keys(stateFromComment(r.comments[0].body, 7).passes);
  assert.ok(!passes.includes('slice:codex-local:0123456789'), 'the stale slice is gone');
  assert.ok(passes.includes('engine:codex-local'), 'a pass that is not a slice stays');
  assert.equal(passes.filter((id) => id.startsWith('slice:codex-local:')).length, 2, 'the live slices are kept');
});

test('runExec: a grandchild in its own process group that holds the pipes does not keep the step waiting', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-exec-'));
  const pidFile = path.join(dir, 'pid');
  t.after(() => {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'escape.mjs');
  writeFileSync(file, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  const started = Date.now();
  const result = await runExec({ name: 'escape', kind: 'exec', command: [process.execPath, file], timeoutSec: 1 }, {}, { root: dir, env: process.env });
  assert.equal(result.status, 'timed_out');
  assert.ok(Date.now() - started < 15000);
});

test('a project exec reviewer runs as the base has it, and editing its script is a change to the review', async (t) => {
  const scan = (title) => `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({findings:${title ? `[{file:'src/app.js',line:1,title:'${title}',body:'b',severity:'low'}]` : '[]'},verdicts:[]})))`;
  const reviewers = { scan: { kind: 'exec', command: ['node', 'scripts/scan.mjs'], timeoutSec: 30 } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { reviewers } },
    baseFiles: { 'scripts/scan.mjs': scan('base found it') },
    change: (write) => {
      write('scripts/scan.mjs', scan(null));
      write('src/app.js', 'z\n');
    },
  });
  r.write('.aidrian.local.json', JSON.stringify({ review: { engine: 'scan' } }));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'local engine');
  const first = await r.step();
  assert.ok(first.plan.flows.includes('harness-config'), 'editing a reviewer`s script is a change to the review');
  for (const pass of first.dispatch) recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: holdsAll(pass, 'src/app.js:1') });
  const result = await r.step();
  assert.equal(result.status, 'fix_required');
  assert.equal(result.open[0].findings[0].title, 'base found it', 'the PR`s emptied scanner did not run');
});

test('a flow only the review bot could review is unsatisfied, never a loop that cannot end', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], require: ['independent-model'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const result = await r.step({ exec: clean, codex: () => ({ ok: false, reason: 'the codex CLI is not installed' }) });
  assert.equal(result.status, 'unsatisfied');
  assert.match(result.reason, /flow pay needs a reviewer that answers its invariants/u);
});

test('a project agent reviewer as the engine keeps its name, stage, and independence', async (t) => {
  const reviewers = { second: { kind: 'agent', agent: 'second-opinion', stage: 'independent', independent: true } };
  const r = repo(t, { baseConfig: { version: 1, review: { reviewers, rules: [{ require: ['independent-model'] }] } }, change: (write) => write('src/app.js', 'p\n') });
  r.write('.aidrian.local.json', JSON.stringify({ review: { engine: 'second' } }));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'engine');
  const result = await r.step({ exec: clean });
  assert.deepEqual([result.status, result.stage, result.dispatch[0].pass, result.dispatch[0].agent], ['dispatch', 'independent', 'engine:second', 'second-opinion']);
});

test('the review gate`s checklist reaches every reviewer', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { reviewGate: { enabled: true, checklist: 'docs/flows/booking.md' } } }, change: (write) => write('src/app.js', 'k\n') });
  const result = await r.step({ exec: clean });
  const [pass] = result.dispatch;
  assert.equal(pass.checklist.path, 'docs/flows/booking.md');
  assert.match(pass.checklist.text, /No double booking/u);
  assert.match(pass.brief, /against the checklist/u);
  assert.ok(!pass.brief.includes('docs/flows/booking.md'), 'the brief points at `checklist` in the input and writes no path');
});

test('the head`s review config comes from the head commit, even when the checkout is on another branch', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], invariants: [{ id: 'cap', text: 'refund cap' }], signoff: 'human' } };
  const r = repo(t, { headConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const head = r.git('rev-parse', 'HEAD');
  r.git('switch', '-q', 'main');
  r.forge.change = () => ({ number: 7, headRefOid: head, baseRefName: 'main', url: 'u' });
  const result = await r.step({ exec: clean });
  assert.deepEqual(result.plan.flows.sort(), ['harness-config', 'pay']);
});

test('the review bot: asked only after earlier passes, with the gate marker and the plan`s cap; an answer for another head counts for nothing', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { reviewGate: { enabled: true, checklist: null } } }, change: (write) => write('src/app.js', 'w\n') });
  const off = () => ({ ok: false, reason: 'the codex CLI is not installed' });
  const calls = [];
  const bot = (answer) => async (opts, deps) => (calls.push([opts.maxRounds, deps.gate().marker]), answer);
  const first = await r.step({ codex: off, awaitBot: bot({}) });
  assert.equal(first.status, 'dispatch');
  assert.equal(calls.length, 0, 'the bot waits for the code-reviewer');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 1, fixed: 1 });
  const moved = await r.step({ codex: off, awaitBot: bot({ status: 'received', head_sha: 'f'.repeat(40), signal: { kind: 'thumbs_up' } }) });
  assert.equal(moved.status, 'incomplete');
  assert.equal(calls[0][0], 3, 'the request carries the plan`s cap, never an unlimited one');
  assert.match(calls[0][1], /aidrian-review: pr=7 repo=o\/r head=[0-9a-f]{40} reviewer=code-reviewer findings=1 fixed=1/u);
  const ok = await r.step({ codex: off, awaitBot: bot({ status: 'received', head_sha: first.head, signal: { kind: 'thumbs_up' } }) });
  assert.equal(ok.status, 'received');
});

test('a reviewer the pull request adds runs once merged; picking it as the engine says so', async (t) => {
  const r = repo(t, { headConfig: { version: 1, review: { reviewers: { fresh: { kind: 'exec', command: ['node', 'scripts/fresh.mjs'] } } } }, change: (write) => write('src/app.js', 'n\n') });
  r.write('.aidrian.local.json', JSON.stringify({ review: { engine: 'fresh' } }));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'engine');
  const result = await r.step({ exec: clean });
  assert.equal(result.status, 'unsatisfied');
  assert.match(result.reason, /a reviewer this pull request adds/u);
});

test('base code that imports an installed dependency runs: the checkout`s dependency folders are linked in', async (t) => {
  const planner = "import dep from 'dep'; let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:dep,stages:[]})))";
  const r = repo(t, { baseConfig: { version: 1, review: { planCommand: 'node scripts/plan.mjs' } }, baseFiles: { 'scripts/plan.mjs': planner, '.gitignore': 'node_modules\n' }, change: (write) => write('src/app.js', 'd\n') });
  r.write('node_modules/dep/package.json', JSON.stringify({ name: 'dep', type: 'module', main: 'index.js' }));
  r.write('node_modules/dep/index.js', "export default 'single';");
  const result = await r.step({ exec: clean });
  assert.equal(result.depth, 'single');
});

test('the gate marker sums the code-reviewer passes that count for the head, a carried-forward one included', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { reviewGate: { enabled: true, checklist: null } } }, baseFiles: { 'src/other.js': '0\n' }, change: (write) => write('src/app.js', 'g\n') });
  const off = () => ({ ok: false, reason: 'the codex CLI is not installed' });
  const markers = [];
  const bot = async (_opts, deps) => (markers.push(deps.gate()), { status: 'received', head_sha: r.git('rev-parse', 'HEAD'), signal: { kind: 'review', line_comments: 1 } });
  const first = await r.step({ codex: off, awaitBot: bot });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 2, fixed: 2 });
  assert.equal((await r.step({ codex: off, awaitBot: bot })).status, 'fix_required');
  assert.match(markers[0].marker, /findings=2 fixed=2/u);
});

test('the project`s engine wins over this machine`s local one, and the bot stage still runs', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { engine: 'pr-bot' } }, change: (write) => write('src/app.js', 'e\n') });
  r.write('.aidrian.local.json', JSON.stringify({ review: { engine: 'codex-local' } }));
  const asked = [];
  const result = await r.step({ exec: async () => assert.fail('codex-local must not run'), awaitBot: async (opts) => (asked.push(opts.request), { status: 'received', head_sha: opts.head, signal: { kind: 'thumbs_up' } }) });
  assert.deepEqual([result.status, result.engine.name, asked], ['received', 'pr-bot', [true]]);
  assert.match(result.engine.reason, /set by the project config/u);
});

test('review.record "local": the record stays in the state folder, and nothing on the pull request is read, posted, or edited', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { record: 'local' } }, change: (write) => write('src/app.js', 'l\n') });
  const touched = [];
  for (const call of ['conversationComments', 'postComment', 'editComment']) r.forge[call] = () => (touched.push(call), assert.fail(`gh ${call} must not run`));
  const first = await r.step({ exec: async () => ({ status: 'done', findings: [finding], verdicts: [], dropped: [] }) });
  assert.equal(first.status, 'fix_required');
  assert.equal(first.summary_error, undefined);
  r.write('src/app.js', 'm\n');
  r.commit();
  assert.equal((await r.step({ exec: clean })).status, 'received');
  assert.deepEqual(touched, []);
  assert.equal(readLocalState(r.project, 7).rounds.length, 2, 'the second step read the first one`s record from the state folder');
  const config = loadConfig(projectAt(r.dir)).config;
  assert.equal(remoteState('o/r', 7, { conversationComments: () => assert.fail('the pull request is not read') }, config), null);
});

test('the round cap is the base branch\'s: an uncommitted edit to the working copy cannot raise it', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2 } }, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  r.write('.aidrian/config.json', JSON.stringify({ version: 1, github: { maxReviewRounds: 9 } }));
  await assert.rejects(r.step({ exec: clean, env: {} }, { maxRounds: 5 }), /--max-rounds 5 goes past config\.json github\.maxReviewRounds \(2\)/u);
  const result = await r.step({ exec: clean, env: {} });
  assert.equal(result.max_rounds, 2);
});
