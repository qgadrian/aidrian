import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectAt, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { blocksOf, citationProblem, flowState, invariantsOf, sectionOf } from '../plugins/aidrian/lib/review/flows.mjs';
import { cleanOutput, resolveEngine, reviewerMap, runExec, satisfies } from '../plugins/aidrian/lib/review/reviewers.mjs';
import { parseChoice } from '../plugins/aidrian/lib/review/quota.mjs';
import { EXIT, recordAccept, recordOverrule, recordPass, recordSignoff, recordStageSignoff, remoteState, reviewInForce, reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { runAutoMerge } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { emptyState, HELD_LINE, heldRevision, readLocalState, stateFromComment, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { runExtend } from '../plugins/aidrian/lib/review/extension.mjs';
import { judgeMerge } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';
import { runSignoff } from '../plugins/aidrian/lib/review-gate.mjs';

// A repository with `main` (carrying `baseConfig`) and a `feat` branch made by `change(dir)`. Returns the helpers a
// review step needs, with GitHub faked in memory.
function repo(t, { baseConfig = { version: 1 }, change, headConfig, baseFiles = {} } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-review-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
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
  const forge = {
    change: () => ({ number: 7, headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main', url: 'https://github.com/o/r/pull/7' }),
    repo: () => 'o/r',
    conversationComments: () => comments,
    postComment: (_repo, _n, body) => comments.push({ id: comments.length + 1, body, author_association: 'MEMBER' }),
    editComment: (_repo, id, body) => (comments.find((c) => c.id === id).body = body),
  };
  const project = projectAt(dir);
  // A fresh project per step, so a local settings file written mid-test is read.
  const step = (deps = {}, opts = {}) => {
    const current = projectAt(dir);
    return reviewStep({ pr: '7', ...opts }, { project: current, config: loadConfig(current).config, forge, codex: () => ({ ok: true }), ...deps });
  };
  return { dir, git, write, forge, comments, project, step, commit: (msg = 'next') => (git('add', '-A'), git('commit', '-q', '-m', msg), git('rev-parse', 'HEAD')) };
}

const clean = async () => ({ status: 'done', findings: [], verdicts: [], dropped: [] });
const finding = { file: 'src/app.js', line: 1, title: 'off by one', body: 'x', severity: 'high' };

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
  const team = { version: 1, state: { dir: 'state' }, github: { requiredChecks: ['test'], autoMerge: { allow: true, strategy: 'squash' } } };
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
  // The code reviewer answered holds with evidence, so the reviewers disagree: still blocked, with the Human's way out named.
  assert.deepEqual([result.status, result.stage, result.flows], ['fix_required', 'independent', [{
    flow: 'booking', violated: ['unspecified'], unverified: [], disputed: ['unspecified'],
    overrule: [`aidrian pr signoff 7 --flow booking --overrule unspecified --head ${first.head} --reason "<why>"`],
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
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: 'mine', head: 'h', reviewer: 'r', findings: 0, fixed: 0, remote: [{ id: 1, body: summaryBody(remote, null, 'x'), author_association: 'MEMBER' }] });
  const { readLocalState } = await import('../plugins/aidrian/lib/review/state.mjs');
  const state = readLocalState(r.project, 7);
  assert.deepEqual([state.revision, Object.keys(state.passes).sort(), state.passes.other.open], [10, ['mine', 'other'], 2]);
});

// The summary comment as the machine that wrote it leaves it when its record is too large: the held marker in place
// of the record.
const holdComment = (body, revision) => body.replace(/<!-- aidrian-review-state-br:[^>]*-->/u, `${HELD_LINE}\n<!-- aidrian-review-state-held:${revision} -->`);

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

test('a sign-off is refused for a flow the head does not ask the Human to sign, and before any review of the head', async (t) => {
  const flows = {
    pay: { files: ['src/pay/**'], invariants: [{ id: 'cap', text: 'A refund never exceeds the charge.' }], require: ['agent:security-engineer'], signoff: 'human' },
    book: { files: ['src/book/**'], invariants: [{ id: 'one', text: 'One booking per slot.' }], require: ['agent:security-engineer'] },
  };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => (write('src/pay/a.js', 'export const refund = (x) => x;\n'), write('src/book/a.js', 'export const book = 1;\n')) });
  const head = r.git('rev-parse', 'HEAD');
  assert.throws(() => recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'pay', head, by: 'Tester' }), /no review of o\/r#7 ran on/u);
  await r.step({ exec: clean });
  assert.throws(() => recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'book', head, by: 'Tester' }), /flow book takes no Human sign-off .*only pay can be signed off/u);
  assert.equal(recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'pay', head, by: 'Tester' }).by, 'Tester');
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
  r.forge.visibility = () => 'PRIVATE';
  // Every step of this pull request uploads through the step's forge, as the gh-image extension would: no `image` is given.
  r.forge.uploadImages = (_repo, files) => (uploads.push(files.length), files.map((file) => `![${path.basename(file, '.png')}](https://github.com/user-attachments/assets/u-${path.basename(file, '.png')})`).join('\n'));
  const step = (deps = {}) => r.step(deps);
  const first = await step({ exec: clean, captureSpawn });
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
  assert.equal((await step({ exec: clean, captureSpawn: () => assert.fail('captured twice') })).status, 'dispatch', 'one capture per head');

  const findings = JSON.stringify([{ title: 'Label clipped at 360px', severity: 'medium', likelihood: 'routine', affects: 'users', state: 'open' }]);
  const verdict = (evidence) => JSON.stringify([{ flow: 'ui', invariant: 'fit', verdict: 'holds', evidence }]);
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'designer', findingsText: findings, verdictsText: verdict('capture:dashboard-89347b--360--default--default') });
  const blocked = await step({ exec: clean });
  assert.equal(blocked.status, 'fix_required');
  assert.equal(blocked.open[0].findings[0].title, 'Label clipped at 360px');
  assert.deepEqual(blocked.flows, [], 'a capture of this head is evidence');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'designer', findingsText: '[]', verdictsText: verdict('capture:dashboard-89347b--768--default--default') });
  const unknown = await step({ exec: clean });
  assert.deepEqual(unknown.flows, [{ flow: 'ui', violated: [], unverified: ['fit'] }], 'a capture key the manifest does not have is no evidence');
  assert.match(r.comments.find((c) => c.body.startsWith('<!-- aidrian-review-summary -->')).body, /visual capture of `[0-9a-f]{7}`: captured \(2 of 2\); attach \*\*auto\*\*, private repository/u);

  // A clean pass whose verdict cites a capture carries forward over a push that touches nothing of it, and still
  // counts on a machine without the images: the record holds the captured keys.
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'designer', findingsText: '[]', verdictsText: verdict('capture:dashboard-89347b--360--default--default') });
  assert.equal((await step({ exec: clean })).status, 'received');
  r.write('docs/notes.md', 'notes\n');
  r.commit('docs only');
  const { captureDir } = await import('../plugins/aidrian/lib/review/visual.mjs');
  rmSync(captureDir(r.project, 7, first.head), { recursive: true, force: true });
  const carried = await step({ exec: clean });
  assert.equal(carried.status, 'received', 'the earlier head\'s capture evidence still holds');
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

test('an edit to a cited doc outside the cited section needs no Human; inside it, or renaming its heading, does', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], invariants: [{ id: 'no-double', cite: 'docs/flows/booking.md#no-double-booking' }], require: ['agent:product-manager'] } };
  const plan = async (doc) => {
    const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => {
      write('src/booking/book.js', 'export const book = () => 1;\n');
      write('docs/flows/booking.md', doc);
    } });
    return (await r.step({ exec: clean })).plan.flows;
  };
  const outside = await plan('# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge, ever.\n');
  assert.ok(!outside.includes('harness-config'), 'only the refund section changed');
  const appended = await plan('# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge.\n\n## Alerts\nNew.\n');
  assert.ok(!appended.includes('harness-config'), 'a section added after the cited one');
  const inside = await plan('# Booking\n\n## No double booking\nTwo bookings may share a slot.\n\n## Refund cap\nA refund never exceeds the charge.\n');
  assert.ok(inside.includes('harness-config'), 'the cited section changed');
  const renamed = await plan('# Booking\n\n## No overlapping booking\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge.\n');
  assert.ok(renamed.includes('harness-config'), 'the cited heading is gone');
  const split = await plan('# Booking\n\n## No double booking\n\n## Split\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge.\n');
  assert.ok(split.includes('harness-config'), 'a heading inserted inside the cited section moves its text out, though no line of it changed');
  const tail = await plan('# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\n## Split\n\n## Refund cap\nA refund never exceeds the charge.\n');
  assert.ok(!tail.includes('harness-config'), 'a heading added after all of its text leaves the cited text as it was');
  const merged = await plan('# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\nA refund never exceeds the charge.\n');
  assert.ok(merged.includes('harness-config'), 'the next heading removed: the cited section now runs on');
});

test('a flow whose invariants doc is cited whole still needs the Human for any edit to it', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], invariants: 'docs/flows/booking.md', require: ['agent:product-manager'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => {
    write('src/booking/book.js', 'export const book = () => 1;\n');
    write('docs/flows/booking.md', '# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge, ever.\n');
  } });
  assert.ok((await r.step({ exec: clean })).plan.flows.includes('harness-config'));
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

// Two rounds to the cap of 2 on a booking flow: round 1 leaves `first` findings open, round 2 leaves `second`. Returns
// the repository and the step at the cap. With `fixFirst`, a fix is pushed after round 2 and before the step, so the
// cap meets a head no round reviewed.
async function toTheCap(t, github, { first = 2, second = 1, fixFirst = false } = {}) {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2, ...github }, review: { flows } }, change: (write) => write('src/booking/a.js', '1\n') });
  const one = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: one.dispatch[0].pass, head: one.head, reviewer: 'code-reviewer', findings: first, fixed: 0 });
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  r.write('src/booking/a.js', '2\n');
  r.commit();
  const two = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: two.dispatch[0].pass, head: two.head, reviewer: 'code-reviewer', findings: second, fixed: 0 });
  if (fixFirst) {
    r.write('src/booking/a.js', '3\n');
    r.commit('the fix of round 2');
  }
  return { r, capped: await r.step({ exec: clean }), pass: two.dispatch[0].pass, last: two.head };
}

// `aidrian pr extend` as the CLI runs it, its printed JSON returned.
async function extend(t, r, args) {
  const log = t.mock.method(console, 'log', () => {});
  try {
    const code = await runExtend(['7', ...args], r.project, loadConfig(r.project).config, { repo: 'o/r', forge: r.forge, env: {} });
    return { code, out: JSON.parse(log.mock.calls.at(-1).arguments[0]) };
  } finally {
    log.mock.restore();
  }
}

test('extra rounds "ask": a converging review at the cap dispatches the judge, then asks the Human, and a grant is one round', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  assert.equal(capped.status, 'extension_check');
  assert.equal(EXIT.extension_check, 10);
  assert.deepEqual(capped.dispatch.map((each) => [each.pass, each.agent]), [['extension-judge', 'code-reviewer']]);
  assert.match(capped.dispatch[0].record, new RegExp(`aidrian pr extend 7 --verdict extend\\|stop --reason "<evidence>" --head ${capped.head}`));
  assert.deepEqual(capped.extension.history.map((round) => [round.round, round.open]), [[1, 2], [2, 1]], 'each round keeps its open findings');
  assert.deepEqual([capped.extension.signals.converging, capped.extension.mode, capped.extension.max_extra], [true, 'ask', 2]);
  assert.deepEqual(capped.extension.files, ['src/booking/a.js']);
  assert.equal(capped.open[0].open, 1, 'the work left is still named');

  const verdict = await extend(t, r, ['--verdict', 'extend', '--reason', 'src/booking/a.js:1 is a real high-severity bug', '--head', capped.head]);
  assert.deepEqual([verdict.code, verdict.out.extension.status], [0, 'asking']);
  const ask = await r.step({ exec: clean });
  assert.equal(ask.status, 'extension_ask');
  assert.equal(EXIT.extension_ask, 11);
  assert.equal(ask.question, 'Pull request #7 reached its review-round cap. Grant one extra review round, round 3?');
  assert.deepEqual(ask.options, ['Approve round 3', 'Deny']);
  assert.equal(ask.max_rounds, 2, 'asking grants nothing yet');

  await extend(t, r, ['--human', 'approve']);
  const granted = await r.step({ exec: clean });
  assert.deepEqual([granted.status, granted.max_rounds], ['fix_required', 3], 'the granted round lets a fix take a new head');
  r.write('src/booking/a.js', '3\n');
  r.commit();
  const three = await r.step({ exec: clean });
  assert.deepEqual([three.status, three.round, three.max_rounds], ['dispatch', 3, 3]);
  const state = readLocalState(r.project, 7);
  assert.deepEqual(state.extensions.map((entry) => [entry.round, entry.status, entry.by, entry.human?.by]), [[2, 'granted', 'human', 'Tester']]);
  assert.match(r.comments[0].body, /\*\*Extra rounds:\*\*\n- round 2 on `[0-9a-f]{7}`: granted by the Human \(Tester; an audit entry, not proof\)/u);
});

test('extra rounds: a fix pushed past the cap reaches the judge as unreviewed, and a stop says so on the pull request', async (t) => {
  const { r, capped, last } = await toTheCap(t, {}, { fixFirst: true });
  assert.equal(capped.status, 'extension_check', JSON.stringify(capped.extension?.reasons));
  assert.deepEqual(capped.extension.unreviewed_head, { head: capped.head, from: last, fix: { added: 1, removed: 1, files: ['src/booking/a.js'], code_added: 1 } });
  assert.deepEqual(readLocalState(r.project, 7).extensions[0].unreviewed, { head: capped.head, from: last });
  await extend(t, r, ['--verdict', 'stop', '--reason', 'the finding was low severity']);
  const stopped = await r.step({ exec: clean });
  assert.deepEqual([stopped.status, stopped.unreviewed_head], ['round_limit', true]);
  assert.match(r.comments[0].body, new RegExp(`- fix head \`${capped.head.slice(0, 7)}\`, pushed after round 2 on \`${last.slice(0, 7)}\`, is reviewed by no pass`, 'u'));
});

test('extra rounds: a fix pushed after the judge`s stop keeps the stop, and the result names the fix as unreviewed', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  await extend(t, r, ['--verdict', 'stop', '--reason', 'the finding is a nit']);
  const before = await r.step({ exec: clean });
  assert.deepEqual([before.status, 'unreviewed_head' in before], ['round_limit', false], 'round 2 reviewed the head the stop was for');
  r.write('src/booking/a.js', '3\n');
  const pushed = r.commit('a fix after the stop');
  const after = await r.step({ exec: clean });
  assert.deepEqual([after.status, after.extension.by, after.unreviewed_head], ['round_limit', 'judge', true]);
  assert.match(r.comments[0].body, new RegExp(`- round 2 on \`${capped.head.slice(0, 7)}\`: stopped by the judge: the finding is a nit\\n- fix head \`${pushed.slice(0, 7)}\`, pushed after round 2 on \`${capped.head.slice(0, 7)}\`, is reviewed by no pass`, 'u'));
});

test('extra rounds "ask" on an unreviewed fix: the question names the fix, aidrian pr extend prints the same, and a grant reviews it', async (t) => {
  const { r, capped } = await toTheCap(t, {}, { fixFirst: true });
  const verdict = await extend(t, r, ['--verdict', 'extend', '--reason', 'src/booking/a.js:1 was a valid high finding; the fix is one line', '--head', capped.head]);
  const ask = await r.step({ exec: clean });
  assert.equal(ask.status, 'extension_ask');
  assert.equal(ask.question, `Pull request #7 reached its review-round cap, and its fix head ${capped.head.slice(0, 7)} is reviewed by no pass. Grant one extra review round, round 3, to review that fix?`);
  assert.ok(verdict.out.next.includes(`"${ask.question}"`), 'the verdict`s next step asks the same question');
  assert.doesNotMatch(r.comments[0].body, /is reviewed by no pass/u, 'a check waiting for the Human is no stop');
  await extend(t, r, ['--human', 'approve']);
  const three = await r.step({ exec: clean });
  assert.deepEqual([three.status, three.round, three.max_rounds, three.head], ['dispatch', 3, 3, capped.head], 'round 3 reviews the fix');
  assert.doesNotMatch(r.comments[0].body, /is reviewed by no pass/u, 'a granted round is no stop');
});

test('extra rounds: at the ceiling, a fix pushed after the last round is named as unreviewed', async (t) => {
  const { r } = await toTheCap(t, { extraRounds: 'auto', maxExtraRounds: 1 });
  await extend(t, r, ['--verdict', 'extend', '--reason', 'valid high finding']);
  r.write('src/booking/a.js', '3\n');
  r.commit();
  const three = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: three.dispatch[0].pass, head: three.head, reviewer: 'code-reviewer', findings: 1, fixed: 0 });
  const ceiling = await r.step({ exec: clean });
  assert.deepEqual([ceiling.status, ceiling.extension.by, 'unreviewed_head' in ceiling], ['round_limit', 'ceiling', false], 'round 3 reviewed this head');
  r.write('src/booking/a.js', '4\n');
  const pushed = r.commit('a fix past the ceiling');
  const after = await r.step({ exec: clean });
  assert.deepEqual([after.status, after.extension.by, after.unreviewed_head], ['round_limit', 'ceiling', true]);
  assert.match(r.comments[0].body, new RegExp(`- round 3 on \`${three.head.slice(0, 7)}\`: stopped by the ceiling[^\\n]*\\n- fix head \`${pushed.slice(0, 7)}\`, pushed after round 3 on \`${three.head.slice(0, 7)}\`, is reviewed by no pass`, 'u'));
});

test('extra rounds: a last round that opens on a new head and reaches the cap in the same run is no unreviewed head', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2 } }, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const item = (line, title) => ({ file: 'src/app.js', line, title, body: 'x', severity: 'high' });
  const found = [[item(1, 'Null refund total'), item(40, 'Missing lock on save')], [item(80, 'Wrong currency rounding')]];
  let call = 0;
  const exec = async () => ({ status: 'done', findings: found[call++], verdicts: [], dropped: [] });
  assert.equal((await r.step({ exec })).status, 'fix_required');
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit();
  const capped = await r.step({ exec });
  assert.deepEqual([call, capped.round], [2, 2], 'round 2 opened and ran its reviewer in this run');
  assert.equal(capped.status, 'extension_check', JSON.stringify(capped.extension?.reasons));
  assert.ok(!('unreviewed_head' in capped.extension), 'round 2 reviewed this head');
  assert.equal(readLocalState(r.project, 7).extensions[0].unreviewed, undefined);
});

test('extra rounds "auto": the judge`s extend grants the round without the Human', async (t) => {
  const { r, capped } = await toTheCap(t, { extraRounds: 'auto' });
  assert.equal(capped.status, 'extension_check');
  const verdict = await extend(t, r, ['--verdict', 'extend', '--reason', 'valid medium finding at src/booking/a.js:1']);
  assert.equal(verdict.out.extension.status, 'granted');
  assert.match(verdict.out.next, /round 3 is granted: run aidrian pr review 7/u);
  assert.deepEqual([(await r.step({ exec: clean })).status], ['fix_required']);
});

test('extra rounds: the judge`s stop and "off" leave round_limit; a red flag goes to the judge, then the Human', async (t) => {
  const judged = await toTheCap(t, {});
  await extend(t, judged.r, ['--verdict', 'stop', '--reason', 'the fixes over-engineer the refund path']);
  const stopped = await judged.r.step({ exec: clean });
  assert.deepEqual([stopped.status, stopped.extension.status, stopped.extension.by, stopped.extension.reasons], ['round_limit', 'stopped', 'judge', ['the fixes over-engineer the refund path']]);

  const flat = await toTheCap(t, { extraRounds: 'auto' }, { first: 1, second: 1 });
  assert.equal(flat.capped.status, 'extension_check', 'not converging is no dead end: the judge reads it');
  assert.deepEqual([flat.capped.extension.by, flat.capped.extension.signals.converging], [null, false]);
  assert.match(flat.capped.extension.red_flags[0], /^not converging: round 2 left 1 open finding, round 1 left 1/u);
  assert.match(flat.capped.dispatch[0].brief, /extension\.red_flags/u);
  await extend(t, flat.r, ['--verdict', 'extend', '--reason', 'the open finding is a valid high']);
  const ask = await flat.r.step({ exec: clean });
  assert.equal(ask.status, 'extension_ask', 'under "auto", an extend over a red flag still needs the Human');
  assert.match(ask.question, /red flags \(not converging\)[\s\S]*round 3\?$/u);
  assert.doesNotMatch(ask.question, /round [12]\b/u, 'the question names no round but the one it grants');
  await extend(t, flat.r, ['--human', 'approve']);
  assert.equal((await flat.r.step({ exec: clean })).max_rounds, 3, 'the Human`s approval opens the round');
  flat.r.write('src/booking/a.js', '3\n');
  flat.r.commit('the fix the round was granted for');
  const three = await flat.r.step({ exec: clean });
  assert.deepEqual([three.round, three.max_rounds, three.dispatch?.length > 0], [3, 3, true], 'the push the round was granted for keeps the grant: the flag is not new');

  const off = await toTheCap(t, { extraRounds: 'off' });
  assert.deepEqual([off.capped.status, off.capped.extension], ['round_limit', { status: 'off', mode: 'off' }]);
});

test('extra rounds: the policy is the base branch`s, so a working-copy edit cannot turn it on or raise the ceiling', async (t) => {
  const { r, capped } = await toTheCap(t, { extraRounds: 'off' });
  assert.equal(capped.status, 'round_limit');
  r.write('.aidrian/config.json', JSON.stringify({ version: 1, github: { maxReviewRounds: 2, extraRounds: 'auto', maxExtraRounds: 9 } }));
  const again = await r.step({ exec: clean });
  assert.deepEqual([again.status, again.extension.status], ['round_limit', 'off']);
});

test('extra rounds: github.maxExtraRounds is a hard ceiling, and the check repeats at each new cap', async (t) => {
  const { r, capped } = await toTheCap(t, { extraRounds: 'auto', maxExtraRounds: 1 });
  assert.equal(capped.status, 'extension_check');
  await extend(t, r, ['--verdict', 'extend', '--reason', 'valid high finding']);
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  r.write('src/booking/a.js', '3\n');
  r.commit();
  const three = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: three.dispatch[0].pass, head: three.head, reviewer: 'code-reviewer', findings: 0, fixed: 0 });
  const again = await r.step({ exec: clean });
  assert.equal(again.round, 3);
  assert.deepEqual([again.status, again.extension.by, again.extension.round], ['round_limit', 'ceiling', 3]);
  assert.match(again.extension.reasons[0], /1 extra round granted already, and github\.maxExtraRounds is 1/u);
});

// A fix that grows the change past the bloat limit: 60 new lines, against the one line the pull request first added.
const bloat = (r) => {
  r.write('src/booking/a.js', `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\n`);
  return r.commit('a large fix');
};

test('extra rounds: a push after the judge`s extend is read again; a new red flag goes back to the judge, and a stale approval is refused', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  await extend(t, r, ['--verdict', 'extend', '--reason', 'valid', '--head', capped.head]);
  assert.equal((await r.step({ exec: clean })).status, 'extension_ask');
  const pushed = bloat(r);
  await assert.rejects(extend(t, r, ['--human', 'approve']), new RegExp(`the check was for ${capped.head.slice(0, 7)}, and the pull request is at ${pushed.slice(0, 7)} now`, 'u'));
  const stopped = await r.step({ exec: clean });
  assert.deepEqual([stopped.status, stopped.extension.status, stopped.extension.by, stopped.extension.signals.bloating], ['extension_check', 'judging', null, true]);
  assert.match(stopped.extension.reasons.at(-1), new RegExp(`read again on ${pushed.slice(0, 7)}, pushed after the decision on ${capped.head.slice(0, 7)}`, 'u'));

  const clean2 = await toTheCap(t, {});
  await extend(t, clean2.r, ['--verdict', 'extend', '--reason', 'valid']);
  clean2.r.write('src/booking/a.js', '3\n');
  const small = clean2.r.commit('a small fix');
  const back = await clean2.r.step({ exec: clean });
  assert.deepEqual([back.status, back.extension.status], ['extension_check', 'judging'], 'the judge has not seen the push');
  assert.match(back.dispatch[0].record, new RegExp(`--head ${small}$`, 'u'));
});

test('extra rounds: a grant whose round has not opened goes back to the judge when the next head raises a red flag', async (t) => {
  const { r } = await toTheCap(t, { extraRounds: 'auto' });
  await extend(t, r, ['--verdict', 'extend', '--reason', 'valid']);
  assert.equal((await r.step({ exec: clean })).max_rounds, 3, 'granted');
  bloat(r);
  const revoked = await r.step({ exec: clean });
  assert.deepEqual([revoked.status, revoked.max_rounds, revoked.round, revoked.extension.by], ['extension_check', 2, 2, null], 'round 3 does not open on the judge`s old word');
});

test('extra rounds: aidrian pr extend writes the summary comment, so another machine continues from it', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  assert.equal(capped.status, 'extension_check');
  const local = path.join(stateDir(r.project), 'reviews', 'pr-7-review.json');
  rmSync(local);
  await extend(t, r, ['--verdict', 'extend', '--reason', 'valid', '--head', capped.head]);
  assert.equal(r.comments.length, 1, 'the one summary comment, edited in place');
  assert.equal(stateFromComment(r.comments[0].body, 7).extensions[0].status, 'asking');
  assert.match(r.comments[0].body, /### Review: extension_check[\s\S]*- round 2 on `[0-9a-f]{7}`: asking by the judge: valid/u, 'the review step`s text stays; the list follows the record');
  rmSync(local);
  assert.equal((await r.step({ exec: clean })).status, 'extension_ask', 'the verdict came back from the pull request');
  rmSync(local);
  await extend(t, r, ['--human', 'approve']);
  rmSync(local);
  assert.deepEqual([(await r.step({ exec: clean })).max_rounds], [3], 'so did the approval');
});

test('--with-bot: the bot is held to the plan`s cap; a cap an earlier request recorded counts only under the Human`s override', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', '9\n') });
  const seen = [];
  const awaitBot = async (opts) => (seen.push([opts.maxRounds, opts.keepRecordedCap]), { status: 'received', requested: true, signal: { kind: 'thumbs_up' } });
  await r.step({ exec: clean, awaitBot, env: {} }, { withBot: true });
  const other = repo(t, { change: (write) => write('src/app.js', '8\n') });
  await other.step({ exec: clean, awaitBot, env: { AIDRIAN_ALLOW_EXTRA_ROUNDS: '1' } }, { withBot: true });
  assert.deepEqual(seen, [[3, false], [3, true]]);
});

test('extra rounds: a finding attested as fixed is not an open finding of its round, so it never reads as a loop', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2 }, review: { flows } }, change: (write) => write('src/booking/a.js', '1\n') });
  const item = (title, line, state) => ({ title, file: 'src/booking/a.js', line, severity: 'high', likelihood: 'routine', affects: 'users', state });
  const one = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: one.dispatch[0].pass, head: one.head, reviewer: 'code-reviewer', findingsText: JSON.stringify([item('Null refund total', 10, 'open'), item('Missing lock on save', 60, 'open')]) });
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  r.write('src/booking/a.js', '2\n');
  r.commit();
  const two = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: two.dispatch[0].pass, head: two.head, reviewer: 'code-reviewer', findingsText: JSON.stringify([item('Null refund total', 10, 'fixed'), item('Wrong currency rounding', 120, 'open')]) });
  const capped = await r.step({ exec: clean });
  assert.equal(capped.status, 'extension_check', JSON.stringify(capped.extension?.reasons));
  assert.deepEqual(capped.extension.history.map((round) => [round.open, round.findings.map((each) => each.title)]), [[2, ['Null refund total', 'Missing lock on save']], [1, ['Wrong currency rounding']]]);
  assert.deepEqual([capped.extension.signals.converging, capped.extension.signals.looping], [true, false]);
});

test('extra rounds: merging the base branch in between rounds is no fix, even in a file the pull request changes', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const lines = (first) => `${[first, ...Array.from({ length: 9 }, (_, i) => `keep ${i}`)].join('\n')}\n`;
  const r = repo(t, {
    baseConfig: { version: 1, github: { maxReviewRounds: 2 }, review: { flows } },
    baseFiles: { 'src/booking/a.js': lines('start') },
    change: (write) => write('src/booking/a.js', lines('changed')),
  });
  const one = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: one.dispatch[0].pass, head: one.head, reviewer: 'code-reviewer', findings: 2, fixed: 0 });
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  // The base gains 100 lines at the end of the same file, and the branch merges it in.
  r.git('switch', '-q', 'main');
  r.write('src/booking/a.js', `${lines('start')}${Array.from({ length: 100 }, (_, i) => `base ${i}`).join('\n')}\n`);
  r.commit('base grows');
  r.git('switch', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');
  const two = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: two.dispatch[0].pass, head: two.head, reviewer: 'code-reviewer', findings: 1, fixed: 0 });
  const capped = await r.step({ exec: clean });
  assert.equal(capped.status, 'extension_check', JSON.stringify(capped.extension?.reasons));
  assert.deepEqual(capped.extension.history.map((round) => round.fix?.added), [0, 0], 'the merge added nothing of the pull request`s own');
  assert.equal(capped.extension.signals.bloating, false);
});

test('--with-bot: a request on an extra round is for the plan`s head only; for a moved head the step asks to run again', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', '9\n') });
  const seen = [];
  const awaitBot = async (opts) => (seen.push([opts.validHead, opts.grantFloor]), { status: 'head_moved', requested: false, head_sha: 'f'.repeat(40) });
  const moved = await r.step({ exec: clean, awaitBot, env: {} }, { withBot: true });
  assert.deepEqual([moved.status, moved.retry_recommended], ['incomplete', true]);
  assert.match(moved.reason, /moved to fffffff before the request on an extra round/u);
  assert.deepEqual(seen, [[moved.head, 3]], 'the grant floor is the cap without grants');
});

// Out of quota (lib/review/quota.mjs): the Human's choice replaces the stopped passes, for the head it stopped on only.
const outOfQuota = async () => ({ status: 'quota', reason: 'You hit your usage limit' });
const summaryOf = (r) => r.comments.find((c) => c.body.startsWith('<!-- aidrian-review-summary -->')).body;

test('out of quota with no flag: blocked_quota asks one question, and the next call runs the reviewer again', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 5;\n') });
  let ran = 0;
  const exec = async () => (ran += 1, outOfQuota());
  const first = await r.step({ exec });
  assert.deepEqual([first.status, first.pass, EXIT[first.status]], ['blocked_quota', 'engine:codex-local', 3]);
  assert.match(first.question, /^Codex is out of quota, so the independent review of pull request #7 stopped on head [0-9a-f]{7}\..*never as an independent review\.$/u);
  assert.deepEqual(first.options.map((each) => each.label), ['Run a critic agent (Recommended)', 'The Human reviews it', 'Wait for Codex quota']);
  assert.deepEqual(first.options.map((each) => each.run), ['aidrian pr review 7 --quota-fallback agent:critic', 'aidrian pr review 7 --quota-fallback human', null]);
  assert.equal(first.quota_fallback, undefined);
  const again = await r.step({ exec });
  assert.deepEqual([again.status, ran], ['blocked_quota', 2], 'nothing picks a fallback by itself: the reviewer runs again');
  assert.equal(again.dispatch, undefined);
  assert.deepEqual(readLocalState(r.project, 7).quotaStops.map((stop) => [stop.stage, stop.reviewer, stop.choice]), [['independent', 'codex-local', null]], 'one stop per head and stage');
  assert.match(summaryOf(r), /Codex was out of quota on `[0-9a-f]{7}`, and the independent stage stopped: nothing replaced it/u);
  r.write('src/app.js', 'export const app = 6;\n');
  r.commit();
  await assert.rejects(r.step({ exec }, { quotaFallback: 'agent:critic' }), /no quota stop is on record for head [0-9a-f]{7} of #7/u, 'the flag answers a stop on the current head only');
  assert.throws(() => parseChoice('agent:'), /--quota-fallback must be/u);
  assert.throws(() => parseChoice('codex'), /--quota-fallback must be/u);
});

test('out of quota, the critic as the fallback: a dispatch in the stopped pass`s place, recorded as no independent review', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 7;\n') });
  let ran = 0;
  const exec = async () => (ran += 1, outOfQuota());
  assert.equal((await r.step({ exec })).status, 'blocked_quota');
  const fallback = await r.step({ exec }, { quotaFallback: 'agent:critic' });
  assert.deepEqual([fallback.status, fallback.stage, ran], ['dispatch', 'independent', 1], 'Codex is not asked again on this head');
  const [pass] = fallback.dispatch;
  assert.deepEqual([pass.pass, pass.agent, pass.fallback.replaces, pass.context, pass.files], ['fallback:independent:codex-local:critic', 'critic', 'codex-local', 'full', null]);
  assert.match(pass.brief, /Codex is out of quota.*recorded as a fallback, not as an independent review/u);
  assert.match(pass.record, /^aidrian pr attest 7 --pass fallback:independent:codex-local:critic --head [0-9a-f]{40} --reviewer critic /u);
  assert.match(fallback.quota_fallback[0].note, /ran on a fallback the Human chose: the critic agent, on the session's own model\. This is not an independent review\./u);
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: fallback.head, reviewer: 'critic', findings: 1, fixed: 0 });
  const open = await r.step({ exec });
  assert.deepEqual([open.status, open.open.map((each) => each.pass)], ['fix_required', ['fallback:independent:codex-local:critic']], 'its findings block like any pass');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: fallback.head, reviewer: 'critic', findings: 1, fixed: 1 });
  const done = await r.step({ exec });
  assert.deepEqual([done.status, done.quota_fallback[0].choice, ran], ['received', 'agent:critic', 1]);
  assert.match(summaryOf(r), /Codex was out of quota on `[0-9a-f]{7}`, so the independent stage ran on a fallback the Human chose: the critic agent, on the session's own model\. This is not an independent review\./u);
  assert.equal(stateFromComment(summaryOf(r), 7).quotaStops[0].choice, 'agent:critic', 'the record another machine reads holds the choice');

  r.write('src/app.js', 'export const app = 8;\n');
  r.commit();
  const next = await r.step({ exec: async () => (ran += 1, clean()) });
  assert.deepEqual([next.status, ran, next.quota_fallback], ['received', 2, undefined], 'a later push runs Codex again');
});

test('out of quota with --with-bot: the review bot`s usage limit is a stop the critic can stand in for too', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 9;\n') });
  const awaitBot = async () => ({ status: 'blocked_quota', requested: true, reason: 'Codex usage limits reached' });
  const stopped = await r.step({ exec: clean, awaitBot }, { withBot: true });
  assert.deepEqual([stopped.status, stopped.pass, stopped.options[0].run], ['blocked_quota', 'engine:pr-bot', 'aidrian pr review 7 --with-bot --quota-fallback agent:critic']);
  const fallback = await r.step({ exec: clean, awaitBot }, { withBot: true, quotaFallback: 'agent:critic' });
  assert.deepEqual([fallback.status, fallback.stage, fallback.dispatch[0].pass], ['dispatch', 'remote', 'fallback:remote:pr-bot:critic']);
});

test('out of quota, the Human`s review: the stage waits for the Human`s own sign-off, then passes, said as no independent review', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 10;\n') });
  assert.equal((await r.step({ exec: outOfQuota })).status, 'blocked_quota');
  const head = r.git('rev-parse', 'HEAD');
  assert.throws(() => recordStageSignoff(r.project, { pr: 7, repo: 'o/r', stage: 'independent', head, by: 'Tester' }), /no Human review of the independent stage is waiting/u, 'a stage sign-off never skips a reviewer the Human did not replace');
  const asked = await r.step({ exec: outOfQuota }, { quotaFallback: 'human' });
  assert.deepEqual([asked.status, asked.stage, asked.flows, asked.command, EXIT[asked.status]], ['human_required', 'independent', [], [`aidrian pr signoff 7 --stage independent --head ${head}`], 9]);
  assert.match(summaryOf(r), /the Human chose to review the independent stage; their sign-off is needed\. This is not an independent review\./u);
  recordStageSignoff(r.project, { pr: 7, repo: 'o/r', stage: 'independent', head, by: 'Tester' });
  const done = await r.step({ exec: outOfQuota });
  assert.deepEqual([done.status, done.quota_fallback[0].signed_off_by], ['received', 'Tester']);
  assert.match(summaryOf(r), /so the Human reviewed the independent stage instead, signed off by Tester \(an audit entry, not proof\)\. This is not an independent review\./u);
});

test('out of quota where the plan requires an independent model: no fallback is offered, and none meets the rule', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], require: ['independent-model'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const blocked = await r.step({ exec: outOfQuota });
  assert.deepEqual([blocked.status, blocked.question, blocked.options], ['blocked_quota', undefined, undefined]);
  assert.match(blocked.fallback_refused, /requires an independent model.*neither a same-model agent nor the Human's sign-off counts as one/u);
  for (const choice of ['agent:critic', 'human']) {
    const refused = await r.step({ exec: outOfQuota }, { quotaFallback: choice });
    assert.equal(refused.status, 'unsatisfied', choice);
    assert.match(refused.reason, /requires an independent model/u);
  }
  assert.equal(readLocalState(r.project, 7).quotaStops.at(-1).choice, null, 'a refused choice is not recorded');

  // Whatever the fallback's reviewer is named, its pass is not an independent model.
  const map = reviewerMap({ review: { reviewers: { critic: { kind: 'agent', agent: 'critic', independent: true } } } });
  assert.equal(satisfies('independent-model', [{ id: 'fallback:independent:codex-local:critic', reviewer: 'critic', kind: 'agent', fallback: { replaces: 'codex-local' } }], map), false);
  assert.equal(satisfies('independent-model', [{ id: 'engine:critic', reviewer: 'critic', kind: 'agent' }], map), true, 'the same reviewer outside a fallback still counts');
  assert.equal(satisfies('independent-model', [{ id: 'slice:codex-local:0123456789', reviewer: 'codex-local', kind: 'exec', beforeQuota: true }], reviewerMap({ review: { reviewers: {} } })), false, 'a slice that finished before the stop reviewed only part of the change');
});

// A split of two slices where Codex answers one slice with a finding and runs out of quota on the other.
function splitStop(t) {
  const r = repo(t, { baseConfig: { version: 1, review: { rules: [{ when: { lines: { over: 1 } }, depth: 'split' }] } }, change: (write) => (write('src/a/x.js', '1\n'), write('src/b/x.js', '2\n')) });
  const found = { file: 'src/a/x.js', line: 1, title: 'slice a finding', body: 'x', severity: 'high' };
  let ran = 0;
  const exec = async (_reviewer, input) => (ran += 1, input.files?.includes('src/b/x.js') ? outOfQuota() : { status: 'done', findings: [found], verdicts: [], dropped: [] });
  return { r, exec, ran: () => ran };
}

test('out of quota on one slice of a split, the critic as the fallback: the finished slice`s findings still block and reach the critic', async (t) => {
  const { r, exec, ran } = splitStop(t);
  const stopped = await r.step({ exec });
  assert.deepEqual([stopped.status, ran()], ['blocked_quota', 2]);
  const finished = Object.keys(readLocalState(r.project, 7).passes).find((id) => id.startsWith('slice:codex-local:'));
  const fallback = await r.step({ exec }, { quotaFallback: 'agent:critic' });
  assert.deepEqual([fallback.status, ran()], ['dispatch', 2], 'no slice runs again');
  const [pass] = fallback.dispatch;
  assert.equal(pass.pass, 'fallback:independent:codex-local:critic');
  assert.deepEqual(pass.priorFindings.map((each) => [each.title, each.pass]), [['slice a finding', finished]], 'the critic reads what the finished slice found');
  assert.ok(fallback.plan.stages.find((stage) => stage.name === 'independent').passes.includes(finished), 'the finished slice stays in its stage');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: fallback.head, reviewer: 'critic', findings: 0, fixed: 0 });
  const after = await r.step({ exec });
  assert.deepEqual([after.status, after.open.map((each) => each.pass)], ['fix_required', [finished]], 'the finished slice`s finding still blocks');
});

test('out of quota on one slice of a split, the Human`s review: the finished slice`s findings block before the sign-off', async (t) => {
  const { r, exec } = splitStop(t);
  assert.equal((await r.step({ exec })).status, 'blocked_quota');
  const asked = await r.step({ exec }, { quotaFallback: 'human' });
  assert.deepEqual([asked.status, asked.open.map((each) => each.findings[0].title)], ['fix_required', ['slice a finding']]);
});

test('two reviewers out of quota in one stage: each keeps its own stop and choice, and one stage sign-off covers both', async (t) => {
  const planner = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:'single',stages:[{name:'independent',passes:[{id:'extra:lint',reviewer:'lint',kind:'exec',files:null}]}]})))";
  const r = repo(t, {
    baseConfig: { version: 1, review: { planCommand: 'node scripts/plan.mjs', reviewers: { lint: { kind: 'exec', command: ['node', 'scripts/lint.mjs'], stage: 'independent' } } } },
    baseFiles: { 'scripts/plan.mjs': planner, 'scripts/lint.mjs': '\n' },
    change: (write) => write('src/app.js', 'export const app = 11;\n'),
  });
  const calls = { 'codex-local': 0, lint: 0 };
  const exec = async (reviewer) => {
    calls[reviewer.name] += 1;
    if (reviewer.name === 'codex-local') return outOfQuota();
    return calls.lint === 1 ? { status: 'failed', reason: 'boom' } : outOfQuota();
  };
  assert.equal((await r.step({ exec })).pass, 'engine:codex-local');
  const second = await r.step({ exec }, { quotaFallback: 'agent:critic' });
  assert.deepEqual([second.status, second.pass], ['blocked_quota', 'extra:lint']);
  assert.deepEqual(readLocalState(r.project, 7).quotaStops.map((stop) => [stop.reviewer, stop.choice]), [['codex-local', 'agent:critic'], ['lint', null]], 'the second stop leaves the first one`s choice');
  const third = await r.step({ exec }, { quotaFallback: 'human' });
  assert.deepEqual([third.status, third.dispatch.map((each) => each.pass), calls['codex-local']], ['dispatch', ['fallback:independent:codex-local:critic'], 1]);
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: third.dispatch[0].pass, head: third.head, reviewer: 'critic', findings: 0, fixed: 0 });
  const asked = await r.step({ exec });
  assert.deepEqual([asked.status, asked.command], ['human_required', [`aidrian pr signoff 7 --stage independent --head ${third.head}`]]);
  recordStageSignoff(r.project, { pr: 7, repo: 'o/r', stage: 'independent', head: third.head, by: 'Tester' });
  const done = await r.step({ exec });
  assert.deepEqual([done.status, done.quota_fallback.map((each) => [each.replaces, each.choice])], ['received', [['codex-local', 'agent:critic'], ['lint', 'human']]]);
});

test('invariantsOf: a repeated heading is its own invariant, numbered as GitHub numbers its anchor, so one verdict never signs off both', () => {
  const read = () => '# Rules\n\n## Keep\nThe first.\n\n### Examples\nOne.\n\n## Keep\nThe second.\n\n### Examples\nTwo.\n';
  const { invariants, repeated } = invariantsOf({ invariants: 'r.md' }, read);
  assert.deepEqual(invariants.map((each) => [each.id, each.cite, each.text]), [
    ['keep', 'r.md#keep', 'Keep: The first.'], ['examples', 'r.md#examples', 'Examples: One.'],
    ['keep-1', 'r.md#keep-1', 'Keep: The second.'], ['examples-1', 'r.md#examples-1', 'Examples: Two.'],
  ]);
  assert.deepEqual(repeated, [{ heading: 'Keep', ids: ['keep', 'keep-1'] }, { heading: 'Examples', ids: ['examples', 'examples-1'] }]);
  const state = flowState(invariants, [{ invariant: 'keep', verdict: 'holds', evidence: 'ok' }, { invariant: 'examples', verdict: 'holds', evidence: 'ok' }, { invariant: 'examples-1', verdict: 'holds', evidence: 'ok' }], () => null);
  assert.deepEqual(state, { signed: false, open: [], unverified: ['keep-1'], disputed: [] });
});

// The merge guard (lib/rules/github/merge-review.mjs) and the quota fallback: a stop is an open review, a fallback is a
// finished one once the step that follows it says `received`, and the Human's stage sign-off counts the same way.
test('the merge guard refuses a head stopped on quota, and a fallback`s review counts as done once the step finishes', async (t) => {
  const guard = (r, head) => judgeMerge({ project: projectAt(r.dir), pr: 7, head, viewPr: () => null, answers: [] });
  const viaCritic = repo(t, { change: (write) => write('src/app.js', 'export const app = 12;\n') });
  const stopped = await viaCritic.step({ exec: outOfQuota });
  assert.match(guard(viaCritic, stopped.head) ?? '', /the review of head [0-9a-f]{7} is `blocked_quota`/u, 'a quota stop is an open review');
  const dispatched = await viaCritic.step({ exec: outOfQuota }, { quotaFallback: 'agent:critic' });
  assert.match(guard(viaCritic, dispatched.head) ?? '', /is `dispatch`/u, 'the fallback pass is still out');
  recordPass(viaCritic.project, { pr: 7, repo: 'o/r', pass: dispatched.dispatch[0].pass, head: dispatched.head, reviewer: 'critic', findings: 0, fixed: 0 });
  assert.equal((await viaCritic.step({ exec: outOfQuota })).status, 'received');
  assert.equal(guard(viaCritic, dispatched.head), null, 'the critic`s finished pass is review done for the merge guard');

  const viaHuman = repo(t, { change: (write) => write('src/app.js', 'export const app = 13;\n') });
  const first = await viaHuman.step({ exec: outOfQuota });
  assert.equal((await viaHuman.step({ exec: outOfQuota }, { quotaFallback: 'human' })).status, 'human_required');
  assert.match(guard(viaHuman, first.head) ?? '', /is `human_required`/u);
  recordStageSignoff(viaHuman.project, { pr: 7, repo: 'o/r', stage: 'independent', head: first.head, by: 'Tester' });
  assert.match(guard(viaHuman, first.head) ?? '', /is `human_required`/u, 'the sign-off counts once the review step reads it, as a flow sign-off does');
  assert.equal((await viaHuman.step({ exec: outOfQuota })).status, 'received');
  assert.equal(guard(viaHuman, first.head), null, 'the Human`s stage sign-off is review done for the merge guard');

  viaHuman.write('src/app.js', 'export const app = 14;\n');
  const next = viaHuman.commit();
  assert.equal((await viaHuman.step({ exec: outOfQuota })).status, 'blocked_quota');
  assert.match(guard(viaHuman, next) ?? '', /is `blocked_quota`/u, 'the choice was for the earlier head: the new head is stopped again');
});

test('a --quota-fallback refused for an independent-model plan, or given with no stop, leaves the head unfinished for the merge guard', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], require: ['independent-model'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const stopped = await r.step({ exec: outOfQuota });
  assert.equal((await r.step({ exec: outOfQuota }, { quotaFallback: 'agent:critic' })).status, 'unsatisfied');
  assert.match(judgeMerge({ project: projectAt(r.dir), pr: 7, head: stopped.head, viewPr: () => null, answers: [] }) ?? '', /is `unsatisfied`/u);
  r.write('src/pay/a.js', '2\n');
  const next = r.commit();
  await assert.rejects(r.step({ exec: outOfQuota }, { quotaFallback: 'human' }), /no quota stop is on record/u);
  assert.match(judgeMerge({ project: projectAt(r.dir), pr: 7, head: next, viewPr: () => null, answers: [] }) ?? '', /is `error`/u, 'a step that throws leaves `error` on the head');
});

// A flow whose design invariant no reviewer can verify, and whose base config names its approver.
const APPROVED_FLOWS = { look: { files: ['src/ui/**'], invariants: [
  { id: 'matches-design', text: 'Does the screen still match the approved design?', approvers: ['amy-designer'] },
  { id: 'keeps-copy', text: 'Does the copy stay as written?' },
] } };
const approval = (head, more = {}) => ({ id: 41, state: 'APPROVED', commit_id: head, user: { login: 'amy-designer' }, body: 'Checked the screenshots.\naidrian-approve: look/matches-design\n', html_url: 'https://github.com/o/r/pull/7#pullrequestreview-41', ...more });

// The review of that flow on its first head, with the code reviewer's verdicts recorded: the copy holds, and the design
// cannot be verified. The forge's token is `session-bot`, and the approver's review is on the head.
async function unverifiedDesign(t, review = { flows: APPROVED_FLOWS, approvals: { allow: true } }) {
  const r = repo(t, { baseConfig: { version: 1, review }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  const first = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([
    { flow: 'look', invariant: 'matches-design', verdict: 'cannot_verify', evidence: 'no app runs for the visual capture' },
    { flow: 'look', invariant: 'keeps-copy', verdict: 'holds', evidence: 'src/ui/a.js:1' },
  ]) });
  r.forge.viewer = () => 'session-bot';
  r.forge.reviews = () => [approval(first.head)];
  return { r, head: first.head };
}

test('a named approver`s review of the head closes an unverified invariant once both switches are on, and the summary lists it', async (t) => {
  const { r, head } = await unverifiedDesign(t);
  const off = await r.step({ exec: clean });
  assert.deepEqual([off.status, off.flows], ['fix_required', [{ flow: 'look', violated: [], unverified: ['matches-design'] }]], 'the machine switch is off: the approval counts for nothing');
  assert.match(off.approvals.off, /reviewApprovals is not "on" in \.aidrian\.local\.json/u, 'the review says which switch is off');
  r.write('.aidrian.local.json', JSON.stringify({ reviewApprovals: 'on' }));
  const on = await r.step({ exec: clean });
  assert.equal(on.status, 'received');
  assert.deepEqual(on.approvals.closed, [{ flow: 'look', invariant: 'matches-design', login: 'amy-designer', url: 'https://github.com/o/r/pull/7#pullrequestreview-41', at: null }]);
  assert.match(r.comments[0].body, new RegExp(`- look/matches-design: approved by \`@amy-designer\` on \`${head.slice(0, 7)}\`: https://github\\.com/o/r/pull/7#pullrequestreview-41`, 'u'));
});

test('approvals: the team switch is the base branch`s, and a forge read that fails closes nothing while the step still answers', async (t) => {
  const { r } = await unverifiedDesign(t, { flows: APPROVED_FLOWS });
  r.write('.aidrian.local.json', JSON.stringify({ reviewApprovals: 'on' }));
  const team = await r.step({ exec: clean });
  assert.deepEqual([team.status, team.flows[0].unverified], ['fix_required', ['matches-design']]);
  assert.match(team.approvals.off, /review\.approvals\.allow is not true on the base branch/u);

  const { r: failing } = await unverifiedDesign(t);
  failing.write('.aidrian.local.json', JSON.stringify({ reviewApprovals: 'on' }));
  failing.forge.reviews = () => { throw new Error('gh: HTTP 502'); };
  const broken = await failing.step({ exec: clean });
  assert.deepEqual([broken.status, broken.flows[0].unverified, broken.approvals.closed], ['fix_required', ['matches-design'], []]);
  assert.match(broken.approvals.error, /could not be read, so none counts: gh: HTTP 502/u);
});

test('the Human accepts an unverified invariant on outside evidence for one head; a violated one, or one not unverified, is refused', async (t) => {
  const flows = { ...APPROVED_FLOWS, pay: { files: ['src/ui/**'], invariants: [{ id: 'cap', text: 'Does a refund stay under the charge?' }] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  const evidence = 'https://github.com/o/r/pull/7#issuecomment-99';
  const checkEvidence = (url) => (url === evidence ? 'comment' : (() => { throw new Error(`--evidence ${url} is not a comment, review, or attachment of o/r#7 that the forge can find`); })());
  const accept = (more = {}) => recordAccept(r.project, { pr: 7, repo: 'o/r', flow: 'look', invariant: 'matches-design', head: r.git('rev-parse', 'HEAD'), by: 'Tester', reason: 'the designer approved the screenshots', evidence, checkEvidence, ...more });
  assert.throws(() => accept(), /no review of o\/r#7 ran on/u, 'before any review of the head');
  const first = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([
    { flow: 'look', invariant: 'matches-design', verdict: 'cannot_verify', evidence: 'no app runs' },
    { flow: 'look', invariant: 'keeps-copy', verdict: 'holds', evidence: 'src/ui/a.js:1' },
    { flow: 'pay', invariant: 'cap', verdict: 'violated', evidence: 'src/ui/a.js:1' },
  ]) });
  const blocked = await r.step({ exec: clean });
  assert.deepEqual(blocked.flows.map((flow) => [flow.flow, flow.violated, flow.unverified]), [['look', [], ['matches-design']], ['pay', ['cap'], []]]);
  assert.throws(() => accept({ reason: ' ' }), /--accept needs --reason/u);
  assert.throws(() => accept({ flow: 'pay', invariant: 'cap' }), /is violated on .*never clears a violated invariant/u);
  assert.throws(() => accept({ invariant: 'keeps-copy' }), /is not unverified on/u);
  assert.throws(() => accept({ evidence: 'https://github.com/o/r/pull/8#issuecomment-1' }), /is not a comment, review, or attachment of o\/r#7/u);
  assert.throws(() => accept({ evidence: 'not a url' }), /needs --evidence/u);
  assert.equal(accept({ dryRun: true }).kind, 'comment');
  assert.equal(readLocalState(r.project, 7).acceptances, undefined, 'a dry run records nothing');
  assert.equal(accept().by, 'Tester');
  const after = await r.step({ exec: clean });
  assert.deepEqual(after.flows.map((flow) => [flow.flow, flow.violated, flow.unverified]), [['pay', ['cap'], []]], 'the acceptance closes the design invariant; the violated one stays open');
  assert.match(summaryOf(r), new RegExp(`- look/matches-design: accepted by Tester on \`${first.head.slice(0, 7)}\` on outside evidence: ${evidence}: the designer approved the screenshots`, 'u'));
  r.write('src/ui/a.js', 'export const screen = 2;\n');
  const next = r.commit();
  const again = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: again.dispatch[0].pass, head: next, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([
    { flow: 'look', invariant: 'matches-design', verdict: 'cannot_verify', evidence: 'no app runs' },
    { flow: 'look', invariant: 'keeps-copy', verdict: 'holds', evidence: 'src/ui/a.js:1' },
    { flow: 'pay', invariant: 'cap', verdict: 'holds', evidence: 'src/ui/a.js:1' },
  ]) });
  const moved = await r.step({ exec: clean });
  assert.deepEqual(moved.flows.map((flow) => [flow.flow, flow.unverified]), [['look', ['matches-design']]], 'an acceptance holds for its head only');
});

test('aidrian pr signoff --check runs every refusal of --flow, --overrule, --accept, and --stage, and records nothing', async (t) => {
  const flows = { ...APPROVED_FLOWS, pay: { files: ['src/ui/**'], invariants: [{ id: 'cap', text: 'Does a refund stay under the charge?' }], signoff: 'human' } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows, record: 'local' } }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  const first = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([
    { flow: 'look', invariant: 'matches-design', verdict: 'cannot_verify', evidence: 'no app runs' },
    { flow: 'look', invariant: 'keeps-copy', verdict: 'holds', evidence: 'src/ui/a.js:1' },
    { flow: 'pay', invariant: 'cap', verdict: 'holds', evidence: 'src/ui/a.js:1' },
  ]) });
  await r.step({ exec: clean });
  const evidence = 'https://github.com/o/r/pull/7#pullrequestreview-5';
  const forge = { change: () => ({ url: 'https://github.com/o/r/pull/7' }), changeEvidence: (_repo, _n, url) => (url === evidence ? 'review' : null) };
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const signoff = (...args) => runSignoff(['7', ...args, '--head', first.head, '--repo', 'o/r', '--check'], projectAt(r.dir), loadConfig(projectAt(r.dir)).config, { forge });
  const before = readFileSync(path.join(stateDir(r.project), 'reviews', 'pr-7-review.json'), 'utf8');
  assert.equal(await signoff('--flow', 'pay'), 0);
  assert.equal(await signoff('--flow', 'look', '--accept', 'matches-design', '--evidence', evidence, '--reason', 'the designer approved it'), 0);
  await assert.rejects(signoff('--flow', 'look'), /flow look takes no Human sign-off/u);
  await assert.rejects(signoff('--flow', 'look', '--accept', 'matches-design', '--evidence', 'https://github.com/o/r/pull/7#issuecomment-1', '--reason', 'x'), /is not a comment, review, or attachment of o\/r#7 that the forge can find/u);
  await assert.rejects(signoff('--flow', 'look', '--accept', 'keeps-copy', '--evidence', evidence, '--reason', 'x'), /is not unverified on/u);
  await assert.rejects(signoff('--flow', 'look', '--overrule', 'matches-design', '--reason', 'x'), /is not disputed on/u);
  await assert.rejects(signoff('--stage', 'independent'), /no Human review of the independent stage is waiting/u);
  await assert.rejects(signoff('--flow', 'look', '--accept', 'matches-design', '--reason', 'x'), /--accept needs --flow, --evidence, and --reason/u);
  t.mock.restoreAll();
  assert.deepEqual(lines.map((line) => line.split(';')[0]), [
    `ok: the command would record Tester's sign-off of flow pay on ${first.head.slice(0, 7)}`,
    `ok: the command would record Tester's acceptance of invariant matches-design of flow look on ${first.head.slice(0, 7)}`,
  ]);
  assert.equal(readFileSync(path.join(stateDir(r.project), 'reviews', 'pr-7-review.json'), 'utf8'), before, 'the record is as it was');
});

test('approvals: a pull request cannot turn the team switch on for its own review, and turning it on is a change to the review', () => {
  const base = { rules: [], ignore: [], nonBehaviour: [], flows: {}, planCommand: null, reviewers: {}, approvals: { allow: false } };
  const { review, changed } = reviewInForce(base, { ...base, approvals: { allow: true } });
  assert.deepEqual([review.approvals, changed], [{ allow: false }, ['approvals']]);
  assert.deepEqual(reviewInForce(null, { ...base, approvals: { allow: true } }).review.approvals, { allow: false });
});
