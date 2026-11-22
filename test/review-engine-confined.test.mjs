import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { confinePlan, resolveEngine, reviewerMap } from '../plugins/aidrian/lib/review/reviewers.mjs';
import { recordPass } from '../plugins/aidrian/lib/review/run.mjs';
import { confinedSession } from '../plugins/aidrian/lib/review/step.mjs';
import { markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { holdsAll, repo } from './review-run-fixture.mjs';

// A project run's confined issue session cannot start codex-local: Codex sets up a sandbox of its own and needs the
// network, which the host's sandbox denies. There every codex-local pass of the final plan runs as the agent reviewer
// self, in the same stage with the same flows, and the step says why; anywhere else the plan is as before.

const PINNED = { version: 1, review: { engine: 'codex-local' } };
const noExec = async () => assert.fail('codex-local must not run in a confined session');
const never = () => assert.fail('codex is not asked in a confined session');
const WHY = "codex-local cannot run inside the host's sandbox of the confined session of project run run-a, issue 12, so the agent reviewer self runs its passes";

// The environment of an issue session whose own unattended mark names run-a and issue 12, with its main checkout `root`.
function confinedEnv(root) {
  const session = randomUUID();
  const env = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session };
  assert.ok(markUnattended(session, { root, env, tags: { project: 'run-a', issue: '12' } }));
  return env;
}

const stageOf = (plan, name) => plan.stages.find((stage) => stage.name === name)?.passes;

test('in a confined session, a pinned codex-local engine`s pass runs as self in its own stage, and the step says why', async (t) => {
  const r = repo(t, { baseConfig: PINNED, change: (write) => write('src/app.js', 'c\n') });
  const result = await r.step({ exec: noExec, codex: never, env: confinedEnv(r.dir) });
  assert.deepEqual(result.engine, { name: 'self', reason: `review.engine: codex-local (set by the project config), but ${WHY}` });
  assert.equal(result.status, 'dispatch');
  assert.deepEqual(result.dispatch.map((each) => [each.pass, each.agent]), [['engine:self', 'code-reviewer']]);
});

test('a path shaped like an attempt clone, in a session with no mark, still runs codex-local', async (t) => {
  const r = repo(t, { baseConfig: PINNED, attempt: 'run-a/12.1', change: (write) => write('src/app.js', 'c\n') });
  let ran = 0;
  const result = await r.step({ exec: async () => ((ran += 1), { status: 'done', findings: [], verdicts: [], dropped: [] }) });
  assert.deepEqual([result.engine.name, result.engine.reason, ran], ['codex-local', 'review.engine: codex-local (set by the project config)', 1]);
});

test('in a confined session, a codex-local pass a plan command adds runs as self too, with the reason', async (t) => {
  const planner = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:'single',stages:[{name:'independent',passes:[{id:'extra:check',reviewer:'codex-local',kind:'exec',files:null}]}]})))";
  const r = repo(t, { baseConfig: { version: 1, review: { engine: 'self', planCommand: 'node scripts/plan.mjs' } }, baseFiles: { 'scripts/plan.mjs': planner }, change: (write) => write('src/app.js', 'p\n') });
  const result = await r.step({ exec: noExec, codex: never, env: confinedEnv(r.dir) });
  assert.deepEqual(stageOf(result.plan, 'independent'), ['extra:check:self']);
  assert.ok(result.plan.reasons.includes(WHY), result.plan.reasons.join('\n'));
  assert.equal(result.engine.reason, 'review.engine: self (set by the project config)', 'the engine was self already');
  const outside = repo(t, { baseConfig: { version: 1, review: { engine: 'self', planCommand: 'node scripts/plan.mjs' } }, baseFiles: { 'scripts/plan.mjs': planner }, change: (write) => write('src/app.js', 'p\n') });
  let ran = 0;
  await outside.step({ exec: async () => ((ran += 1), { status: 'done', findings: [], verdicts: [], dropped: [] }) });
  assert.equal(ran, 1, 'outside a confined session the plan command`s codex-local pass runs as written');
});

test('in a confined session, self answers the invariants of a flow only an independent model reviews; the bot still meets independent-model', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], require: ['independent-model'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { engine: 'codex-local', flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const deps = { exec: noExec, codex: never, env: confinedEnv(r.dir), awaitBot: async () => ({ status: 'received', requested: true, signal: { kind: 'thumbs_up' } }) };
  const first = await r.step(deps, { withBot: true });
  assert.equal(first.status, 'dispatch', first.reason);
  assert.deepEqual([stageOf(first.plan, 'independent'), stageOf(first.plan, 'remote')], [['engine:self'], ['engine:pr-bot']], 'the bot stage meets independent-model');
  const [self] = first.dispatch;
  assert.deepEqual([self.pass, self.agent, self.flows.map((flow) => flow.id)], ['engine:self', 'code-reviewer', ['pay']], 'self answers the flow`s invariants');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: self.pass, head: first.head, reviewer: 'self', findings: 0, fixed: 0, verdictsText: holdsAll(self, 'src/pay/a.js:1') });
  assert.equal((await r.step(deps, { withBot: true })).status, 'received', 'self`s answer and the bot`s pass the review');
});

test('in a confined session with no review bot, a flow that requires independent-model is unsatisfied, and the reason names the session', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], require: ['independent-model'] } };
  const r = repo(t, { baseConfig: { version: 1, github: { reviewer: 'none' }, review: { engine: 'codex-local', flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const result = await r.step({ exec: noExec, codex: never, env: confinedEnv(r.dir) });
  assert.equal(result.status, 'unsatisfied');
  assert.match(result.reason, /^the plan requires independent-model, and the engine here is self \(review\.engine: codex-local \(set by the project config\), but codex-local cannot run inside the host's sandbox of the confined session of project run run-a, issue 12/u);
});

test('resolveEngine: in a confined session auto passes codex-local over, and a pinned one is not asked whether it runs', () => {
  const base = loadConfig({ root: '/nowhere', paths: { config: 'none.json', local: 'none' } }).config;
  const confined = 'the confined session of project run run-a, issue 12';
  const noBot = { ...base, github: { ...base.github, reviewer: null } };
  const ready = () => ({ ok: true });
  assert.equal(resolveEngine({ ...base, reviewEngine: 'auto' }, { codex: never, confined }).reviewer.name, 'pr-bot');
  assert.match(resolveEngine({ ...noBot, reviewEngine: 'auto' }, { codex: never, confined }).reason, /^auto: codex-local cannot run inside the host's sandbox of the confined session .* and no review bot, so self$/u);
  assert.equal(resolveEngine({ ...noBot, reviewEngine: 'codex-local' }, { codex: never, confined }).reviewer.name, 'codex-local', 'confinePlan replaces its passes');
  assert.equal(resolveEngine({ ...noBot, reviewEngine: 'auto' }, { codex: ready }).reviewer.name, 'codex-local', 'not confined: unchanged');
});

test('confinePlan: renames each replaced pass and the passes that wait for it, and leaves the rest', () => {
  const map = reviewerMap(loadConfig({ root: '/nowhere', paths: { config: 'none.json', local: 'none' } }).config);
  const plan = { stages: [
    { name: 'local', passes: [{ id: 'agent:code-reviewer', reviewer: 'code-reviewer', kind: 'agent' }] },
    { name: 'independent', passes: [
      { id: 'slice:codex-local:ab', reviewer: 'codex-local', kind: 'exec', role: 'slice' },
      { id: 'cross:codex-local', reviewer: 'codex-local', kind: 'exec', role: 'cross', after: ['slice:codex-local:ab'] },
    ] },
  ] };
  assert.deepEqual(confinePlan(plan, map), ['codex-local']);
  assert.deepEqual(plan.stages[1].passes, [
    { id: 'slice:self:ab', reviewer: 'self', kind: 'agent', role: 'slice' },
    { id: 'cross:self', reviewer: 'self', kind: 'agent', role: 'cross', after: ['slice:self:ab'] },
  ]);
  assert.deepEqual(plan.stages[0].passes, [{ id: 'agent:code-reviewer', reviewer: 'code-reviewer', kind: 'agent' }]);
});

test('confinedSession: only the session`s own unattended mark naming a run and an issue makes a confined session', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'aidrian-confined-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const session = randomUUID();
  const env = { XDG_STATE_HOME: path.join(root, 'xdg'), CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session };
  const checkout = path.join(root, 'checkout');
  assert.equal(confinedSession(env, { home }), null, 'no mark');
  assert.ok(markUnattended(session, { root: checkout, env }), 'a background session with no run tags');
  assert.equal(confinedSession(env, { home }), null, 'an unattended session that works no issue of a run is not confined');
  assert.ok(markUnattended(session, { root: checkout, env, tags: { project: 'run-b', issue: 'ENG-4' } }));
  assert.equal(confinedSession(env, { home }), 'the confined session of project run run-b, issue ENG-4');
});
