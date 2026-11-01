import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { citationProblem, flowState, invariantsOf } from '../plugins/aidrian/lib/review/flows.mjs';
import { cleanOutput, resolveEngine, runExec } from '../plugins/aidrian/lib/review/reviewers.mjs';
import { EXIT, recordPass, recordSignoff, reviewInForce, reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { stateFromComment } from '../plugins/aidrian/lib/review/state.mjs';

// A repository with `main` (carrying `baseConfig`) and a `feat` branch made by `change(dir)`. Returns the helpers a
// review step needs, with GitHub faked in memory.
function repo(t, { baseConfig = { version: 1 }, change, headConfig, baseFiles = {} } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-review-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Tester');
  write('.aidrian/config.json', JSON.stringify(baseConfig));
  write('src/app.js', 'export const app = 1;\n');
  for (const [file, text] of Object.entries(baseFiles)) write(file, text);
  write('docs/flows/booking.md', '# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat');
  change(write, dir);
  if (headConfig) write('.aidrian/config.json', JSON.stringify(headConfig));
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const comments = [];
  const gh = {
    pr: () => ({ number: 7, headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main', url: 'https://github.com/o/r/pull/7' }),
    repo: () => 'o/r',
    comments: () => comments,
    post: (_repo, _n, body) => comments.push({ id: comments.length + 1, body }),
    edit: (_repo, id, body) => (comments.find((c) => c.id === id).body = body),
  };
  const project = projectAt(dir);
  // A fresh project per step, so a local settings file written mid-test is read.
  const step = (deps = {}, opts = {}) => {
    const current = projectAt(dir);
    return reviewStep({ pr: '7', ...opts }, { project: current, config: loadConfig(current).config, gh, codex: () => ({ ok: true }), ...deps });
  };
  return { dir, git, write, gh, comments, project, step, commit: (msg = 'next') => (git('add', '-A'), git('commit', '-q', '-m', msg), git('rev-parse', 'HEAD')) };
}

const clean = async () => ({ status: 'done', findings: [], verdicts: [], dropped: [] });
const finding = { file: 'src/app.js', line: 1, title: 'off by one', body: 'x', severity: 'high' };

test('a docs-only change needs no review and posts nothing', async (t) => {
  const r = repo(t, { change: (write) => write('docs/guide.md', 'hello\n') });
  const result = await r.step({ exec: clean });
  assert.equal(result.status, 'none_needed');
  assert.equal(r.comments.length, 0);
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
  assert.deepEqual(uncited.flows, [{ flow: 'booking', violated: [], unverified: ['no-double-booking'] }], 'a citation to a line that is not there does not count');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head, reviewer: 'product-manager', findings: 0, fixed: 0, verdictsText: verdicts('src/booking/book.js:2') });
  const done = await r.step({ exec: async (_reviewer, input) => {
    assert.deepEqual(input.flows[0].earlierVerdicts.map((each) => each.verdict), ['holds', 'not_affected'], 'the independent reviewer sees the local verdicts to challenge');
    return exec();
  } });
  assert.equal(done.status, 'received');
  assert.equal(ran, 1);
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

test('reviewInForce: rules add up, flows and ignore lists come from the base, and every change is named', () => {
  const base = { rules: [{ depth: 'split', when: { lines: { over: 1 } } }], ignore: ['a'], nonBehaviour: [], flows: { f: { files: ['x'] } }, planCommand: 'base', reviewers: {} };
  const head = { rules: [], ignore: ['a', 'src/**'], nonBehaviour: [], flows: {}, planCommand: null, reviewers: {} };
  const { review, changed } = reviewInForce(base, head);
  assert.deepEqual([review.rules, review.ignore, review.flows, review.planCommand], [base.rules, ['a'], base.flows, 'base']);
  assert.deepEqual(changed, ['rules', 'ignore', 'flows', 'planCommand']);
});

test('the round cap: the last round goes to the final stage, and a round past the cap posts nothing new', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2 }, review: { flows } }, change: (write) => write('src/booking/a.js', '1\n') });
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
  r.write('src/booking/a.js', '3\n');
  r.commit();
  assert.equal((await r.step({ exec: clean })).status, 'round_limit');
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
  assert.deepEqual(state, { signed: false, open: ['b'], unverified: ['c'] });
});

test('citationProblem: a path:line must exist at the head, a test:<name> must appear in a file', (t) => {
  const r = repo(t, { change: (write) => write('src/app.test.js', "test('books a slot', () => {});\n") });
  const head = r.git('rev-parse', 'HEAD');
  assert.equal(citationProblem('src/app.js:1', { root: r.dir, head }), null);
  assert.match(citationProblem('src/app.js:9', { root: r.dir, head }), /no line 9/u);
  assert.equal(citationProblem('test:books a slot', { root: r.dir, head }), null);
  assert.match(citationProblem('test:missing', { root: r.dir, head }), /names the test/u);
  assert.match(citationProblem('trust me', { root: r.dir, head }), /not path:line/u);
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
  let rows = [{ name: 'E2E booking (shard 1)', state: 'PENDING' }];
  r.gh.checks = () => rows;
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
  rows = [{ name: 'E2E booking (shard 1)', state: 'SKIPPED' }];
  assert.equal((await r.step({ exec: clean })).status, 'fix_required', 'a skipped required check is not a pass');
  rows = [{ name: 'E2E booking (shard 1)', state: 'SUCCESS' }];
  assert.equal((await r.step({ exec: clean })).status, 'received');
});

test('the review bot as the engine: a thumbs-up passes, a review with comments is open', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'b\n') });
  const off = () => ({ ok: false, reason: 'the codex CLI is not installed' });
  const comments = await r.step({ codex: off, awaitBot: async () => ({ status: 'received', signal: { kind: 'review', line_comments: 2 } }) });
  assert.deepEqual([comments.status, comments.open[0].open], ['fix_required', 2]);
  r.write('src/app.js', 'c\n');
  r.commit();
  assert.equal((await r.step({ codex: off, awaitBot: async () => ({ status: 'received', signal: { kind: 'thumbs_up' } }) })).status, 'received');
});

const holdsAll = (pass, evidence) => JSON.stringify(pass.flows.flatMap((flow) => flow.invariants.map((each) => ({ flow: flow.id, invariant: each.id, verdict: 'holds', evidence }))));

test('an independent reviewer`s violated verdict blocks the flow even with no findings', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { flows: { booking: { files: ['src/booking/**'] } } } }, change: (write) => write('src/booking/a.js', '1\n') });
  const first = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: holdsAll(first.dispatch[0], 'src/booking/a.js:1') });
  const violated = async () => ({ status: 'done', findings: [], verdicts: [{ flow: 'booking', invariant: 'unspecified', verdict: 'violated', evidence: 'src/booking/a.js:1' }], dropped: [] });
  const result = await r.step({ exec: violated });
  assert.deepEqual([result.status, result.stage, result.flows], ['fix_required', 'independent', [{ flow: 'booking', violated: ['unspecified'], unverified: [] }]]);
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
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, baseFiles: { 'test/booking.snap': 'x\n' }, change: (write, dir) => rmSync(path.join(dir, 'test/booking.snap')) });
  const result = await r.step({ exec: clean });
  assert.deepEqual([result.status, result.tests_removed?.[0]?.deleted], ['fix_required', ['test/booking.snap']]);
  recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'booking', head: result.head, by: 'Tester' });
  assert.equal((await r.step({ exec: clean })).status, 'received');
});

test('a pass recorded on a stale local copy builds on the pull request`s newer record', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'q\n') });
  const remote = { version: 1, revision: 9, updatedAt: '2026-10-31T00:00:00.000Z', pr: 7, repo: 'o/r', rounds: [{ head: 'x' }], passes: { other: { head: 'x', open: 2 } }, signoffs: {}, overrides: [], failures: {} };
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: 'mine', head: 'h', reviewer: 'r', findings: 0, fixed: 0, remote });
  const { readLocalState } = await import('../plugins/aidrian/lib/review/state.mjs');
  const state = readLocalState(r.project, 7);
  assert.deepEqual([state.revision, Object.keys(state.passes).sort(), state.passes.other.open], [10, ['mine', 'other'], 2]);
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
});

test('the head`s review config comes from the head commit, even when the checkout is on another branch', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], invariants: [{ id: 'cap', text: 'refund cap' }], signoff: 'human' } };
  const r = repo(t, { headConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const head = r.git('rev-parse', 'HEAD');
  r.git('switch', '-q', 'main');
  r.gh.pr = () => ({ number: 7, headRefOid: head, baseRefName: 'main', url: 'u' });
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

test('the round cap is the base branch\'s: an uncommitted edit to the working copy cannot raise it', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2 } }, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  r.write('.aidrian/config.json', JSON.stringify({ version: 1, github: { maxReviewRounds: 9 } }));
  await assert.rejects(r.step({ exec: clean, env: {} }, { maxRounds: 5 }), /--max-rounds 5 goes past config\.json github\.maxReviewRounds \(2\)/u);
  const result = await r.step({ exec: clean, env: {} });
  assert.equal(result.max_rounds, 2);
});

test('a Human sign-off survives a push that touches nothing of the flow, and not one that does', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], invariants: [{ id: 'cap', text: 'A refund never exceeds the charge.' }], require: ['agent:security-engineer'], signoff: 'human' } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', 'export const refund = (x) => x;\n') });
  const attest = (dispatch, head) => recordPass(r.project, { pr: 7, repo: 'o/r', pass: dispatch.pass, head, reviewer: 'security-engineer', findings: 0, fixed: 0, verdictsText: JSON.stringify([{ flow: 'pay', invariant: 'cap', verdict: 'holds', evidence: 'src/pay/a.js:1' }]) });
  const first = await r.step({ exec: clean });
  attest(first.dispatch[0], first.head);
  const asked = await r.step({ exec: clean });
  assert.equal(asked.status, 'human_required');
  recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'pay', head: first.head, by: 'Tester' });
  assert.equal((await r.step({ exec: clean })).status, 'received');

  r.write('src/other.js', 'export const other = 1;\n');
  r.commit('unrelated');
  const kept = await r.step({ exec: clean });
  assert.equal(kept.status, 'received', 'nothing since the signed head touches the flow');
  assert.match(r.comments.find((c) => c.body.startsWith('<!-- aidrian-review-summary -->')).body, /recorded on `[0-9a-f]{7}` and kept/u);

  r.write('src/pay/a.js', 'export const refund = (x) => Math.min(x, 10);\n');
  const touched = r.commit('touch the flow');
  const again = await r.step({ exec: clean });
  assert.equal(again.status, 'dispatch');
  attest(again.dispatch[0], touched);
  assert.equal((await r.step({ exec: clean })).status, 'human_required', 'a change to the flow asks the Human again');
});

test('the visual capture runs before the visual reviewers, attaches on a private repository, and its captures are flow evidence', async (t) => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const visual = { platform: 'web', targets: [{ files: ['src/components/**'], routes: ['/dashboard'] }], viewports: [360, 1280], checklist: 'docs/fit.md#fit-checks' };
  const flows = { ui: { files: ['src/components/**'], invariants: [{ id: 'fit', text: 'No horizontal overflow at the fit-check widths.' }], require: ['agent:designer'] } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { flows, visual } },
    baseFiles: { 'docs/fit.md': '# Fit\n\n## Fit checks\nNo page scrolls sideways at 360, 768, or 1280 px.\n' },
    change: (write) => write('src/components/Button.tsx', 'export const Button = () => <button className="px-2" />;\n'),
  });
  r.write('.aidrian.local.json', JSON.stringify({ review: { visual: { baseUrl: 'http://localhost:3000' } } }));
  const captureSpawn = (_node, _args, { input }) => {
    const job = JSON.parse(input);
    const results = job.entries.map((entry) => {
      const file = path.join(job.outDir, `${entry.key}.png`);
      writeFileSync(file, Buffer.concat([PNG, Buffer.from(entry.key)]));
      return { key: entry.key, file, facts: { status: 200, overflowX: null, clippedText: [], smallTargets: [] } };
    });
    return { status: 0, stdout: JSON.stringify({ results }), stderr: '' };
  };
  const uploads = [];
  r.gh.visibility = () => 'PRIVATE';
  r.gh.image = (_repo, files) => (uploads.push(files.length), { status: 0, stdout: files.map((file) => `![${path.basename(file, '.png')}](https://github.com/user-attachments/assets/u-${path.basename(file, '.png')})`).join('\n') });
  const first = await r.step({ exec: clean, captureSpawn });
  assert.equal(first.status, 'dispatch');
  const [pass] = first.dispatch;
  assert.equal(pass.agent, 'designer');
  assert.equal(pass.visual.status, 'captured');
  assert.deepEqual(pass.visual.captures.map((capture) => [capture.key, Boolean(capture.url)]), [['dashboard-89347b--360--default--default', true], ['dashboard-89347b--1280--default--default', true]]);
  assert.match(pass.visual.checklist.text, /sideways/u);
  assert.match(pass.record, /--findings-file/u);
  assert.match(pass.brief, /captures in `visual`/u);
  assert.deepEqual(uploads, [2]);
  assert.ok(r.comments.some((c) => c.body.startsWith('<!-- aidrian-visual-captures -->') && /Attach: \*\*auto\*\*, private repository/u.test(c.body)));
  assert.equal((await r.step({ exec: clean, captureSpawn: () => assert.fail('captured twice') })).status, 'dispatch', 'one capture per head');

  const findings = JSON.stringify([{ title: 'Label clipped at 360px', severity: 'medium', likelihood: 'routine', affects: 'users', state: 'open' }]);
  const verdict = (evidence) => JSON.stringify([{ flow: 'ui', invariant: 'fit', verdict: 'holds', evidence }]);
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'designer', findingsText: findings, verdictsText: verdict('capture:dashboard-89347b--360--default--default') });
  const blocked = await r.step({ exec: clean });
  assert.equal(blocked.status, 'fix_required');
  assert.equal(blocked.open[0].findings[0].title, 'Label clipped at 360px');
  assert.deepEqual(blocked.flows, [], 'a capture of this head is evidence');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'designer', findingsText: '[]', verdictsText: verdict('capture:dashboard-89347b--768--default--default') });
  const unknown = await r.step({ exec: clean });
  assert.deepEqual(unknown.flows, [{ flow: 'ui', violated: [], unverified: ['fit'] }], 'a capture key the manifest does not have is no evidence');
  assert.match(r.comments.find((c) => c.body.startsWith('<!-- aidrian-review-summary -->')).body, /visual capture of `[0-9a-f]{7}`: captured \(2 of 2\); attach \*\*auto\*\*, private repository/u);
});

test('an invariant that cites a doc section carries that section as its source, read from the base, and a change to the doc needs the Human', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], invariants: [{ id: 'no-double', cite: 'docs/flows/booking.md#no-double-booking' }], require: ['agent:product-manager'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => {
    write('src/booking/book.js', 'export const book = () => 1;\n');
    write('docs/flows/booking.md', '# Booking\n\n## No double booking\nRewritten by the pull request.\n');
  } });
  const first = await r.step({ exec: clean });
  const invariant = first.dispatch.find((each) => each.agent === 'product-manager').flows.find((flow) => flow.id === 'booking').invariants[0];
  assert.equal(invariant.text, 'Does the change keep "No double booking" as the cited section defines it?');
  assert.match(invariant.source, /^No double booking\n\nTwo bookings never hold one slot\.$/u, 'the base branch\'s section, not the pull request\'s');
  assert.ok(first.plan.flows.includes('harness-config'), 'the cited doc changed');
});

test('a sign-off of harness-config does not survive a push that changes a project reviewer\'s script', async (t) => {
  const reviewers = { lint: { kind: 'exec', command: ['scripts/review-lint.sh'], stage: 'local' } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { reviewers } },
    baseFiles: { 'scripts/review-lint.sh': '#!/bin/sh\necho \'{"findings":[]}\'\n' },
    change: (write) => write('scripts/review-lint.sh', '#!/bin/sh\necho \'{"findings":[]}\' # v2\n'),
  });
  const verdicts = JSON.stringify([{ flow: 'harness-config', invariant: 'review-not-weakened', verdict: 'holds', evidence: 'scripts/review-lint.sh:1' }]);
  const exec = async () => ({ status: 'done', findings: [], verdicts: [{ flow: 'harness-config', invariant: 'review-not-weakened', verdict: 'holds', evidence: 'scripts/review-lint.sh:1' }], dropped: [] });
  // Runs steps, recording every dispatched agent pass as clean, until the review stops for something else.
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      const result = await r.step({ exec });
      if (result.status !== 'dispatch') return result;
      for (const each of result.dispatch) recordPass(r.project, { pr: 7, repo: 'o/r', pass: each.pass, head: result.head, reviewer: each.agent, findings: 0, fixed: 0, verdictsText: verdicts });
    }
    throw new Error('the review did not settle');
  };
  const asked = await settle();
  assert.equal(asked.status, 'human_required');
  assert.deepEqual(asked.flows, ['harness-config']);
  recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'harness-config', head: asked.head, by: 'Tester' });
  assert.equal((await settle()).status, 'received');
  r.write('src/other.js', 'export const other = 1;\n');
  r.commit('unrelated');
  assert.equal((await settle()).status, 'received', 'an unrelated push keeps the sign-off');
  r.write('scripts/review-lint.sh', '#!/bin/sh\necho \'{"findings":[]}\' # v3\n');
  r.commit('change the reviewer again');
  assert.equal((await settle()).status, 'human_required', 'the reviewer script changed since the sign-off');
});
