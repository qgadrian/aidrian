import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { resolveEngine } from '../plugins/aidrian/lib/review/reviewers.mjs';
import { recordPass } from '../plugins/aidrian/lib/review/run.mjs';
import { confinedSession } from '../plugins/aidrian/lib/review/step.mjs';
import { markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { repo } from './review-run-fixture.mjs';

// A project run's confined issue session cannot start codex-local: Codex sets up a sandbox of its own and needs the
// network, which the host's sandbox denies. There codex-local is not ready, as when Codex is not installed, and the
// step takes the route it takes for that today; a codex-local pass that reaches the stages anyway is refused, never
// launched. Anywhere else nothing changes.

const PINNED = { version: 1, review: { engine: 'codex-local' } };
const noExec = async () => assert.fail('codex-local must not run in a confined session');
const never = () => assert.fail('codex is not asked in a confined session');
const CONFINED = 'the confined session of project run run-a, issue 12';
const CANNOT = `codex-local cannot run inside the host's sandbox of ${CONFINED}`;
const clean = async () => ({ status: 'done', findings: [], verdicts: [], dropped: [] });

// Records the clean answer of the one agent pass the step `result` dispatched.
const recordAgent = (r, result) => recordPass(r.project, { pr: 7, repo: 'o/r', pass: result.dispatch[0].pass, head: result.head, reviewer: result.dispatch[0].agent, findings: 0, fixed: 0 });

// The environment of an issue session whose own unattended mark names run-a and issue 12, with its main checkout `root`.
function confinedEnv(root) {
  const session = randomUUID();
  const env = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session };
  assert.ok(markUnattended(session, { root, env, tags: { project: 'run-a', issue: '12' } }));
  return env;
}

test('in a confined session, a pinned codex-local takes the route of an engine that is not ready, with the confinement reason', async (t) => {
  const r = repo(t, { baseConfig: PINNED, change: (write) => write('src/app.js', 'c\n') });
  const result = await r.step({ exec: noExec, codex: never, env: confinedEnv(r.dir) });
  assert.deepEqual([result.status, result.reason], ['unsatisfied', `config.json review.engine is "codex-local", but ${CANNOT}`]);
  const absent = repo(t, { baseConfig: PINNED, change: (write) => write('src/app.js', 'c\n') });
  const missing = await absent.step({ exec: noExec, codex: () => ({ ok: false, reason: 'the codex CLI is not installed' }) });
  assert.deepEqual([missing.status, missing.reason], ['unsatisfied', 'config.json review.engine is "codex-local", but the codex CLI is not installed'], 'the same route as Codex not installed');
});

test('outside a confined session, the pin runs codex-local as before, a path shaped like an attempt clone included', async (t) => {
  const r = repo(t, { baseConfig: PINNED, attempt: 'run-a/12.1', change: (write) => write('src/app.js', 'c\n') });
  let ran = 0;
  const result = await r.step({ exec: async () => ((ran += 1), clean()) });
  assert.deepEqual([result.status, result.engine.name, result.engine.reason, ran], ['received', 'codex-local', 'review.engine: codex-local (set by the project config)', 1]);
});

test('in a confined session, a codex-local pass a plan command adds is refused before it launches; outside one it runs', async (t) => {
  const planner = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:'single',stages:[{name:'independent',passes:[{id:'extra:check',reviewer:'codex-local',kind:'exec',files:null}]}]})))";
  const config = { version: 1, github: { reviewer: 'none' }, review: { engine: 'self', planCommand: 'node scripts/plan.mjs' } };
  const setup = { baseConfig: config, baseFiles: { 'scripts/plan.mjs': planner }, change: (write) => write('src/app.js', 'p\n') };
  const r = repo(t, setup);
  const env = confinedEnv(r.dir);
  const refused = await r.step({ exec: noExec, codex: never, env });
  assert.deepEqual([refused.status, refused.reason], ['unsatisfied', `pass extra:check is not launched: ${CANNOT}`]);
  assert.equal((await r.step({ exec: noExec, codex: never, env })).status, 'unsatisfied', 'refused again on the next step: no round opened for it');
  const outside = repo(t, setup);
  let ran = 0;
  const first = await outside.step({ exec: async () => ((ran += 1), clean()) });
  assert.equal(first.status, 'dispatch', first.reason);
  recordAgent(outside, first);
  assert.equal((await outside.step({ exec: noExec })).status, 'received');
  assert.equal(ran, 1, 'outside a confined session the plan command`s codex-local pass runs as written');
});

test('in a confined session, auto passes codex-local over as it does a missing Codex, and an unanswered flow`s advice names the session', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], require: ['independent-model'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const result = await r.step({ exec: noExec, codex: never, env: confinedEnv(r.dir) });
  assert.equal(result.status, 'unsatisfied');
  assert.equal(result.reason, `flow pay needs a reviewer that answers its invariants, and the review bot does not: ${CANNOT}, so require an agent for the flow`);
  const outside = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const plain = await outside.step({ exec: noExec, codex: () => ({ ok: false, reason: 'the codex CLI is not installed' }) });
  assert.match(plain.reason, /: run codex-local, or require an agent for the flow$/u, 'outside a confined session the advice is as before');
});

test('resolveEngine: in a confined session codex-local is not ready for auto and for a pinned engine alike', () => {
  const base = loadConfig({ root: '/nowhere', paths: { config: 'none.json', local: 'none' } }).config;
  const noBot = { ...base, github: { ...base.github, reviewer: null } };
  const ready = () => ({ ok: true });
  assert.deepEqual([resolveEngine(base, { codex: never, confined: CONFINED }).reviewer.name, resolveEngine(base, { codex: never, confined: CONFINED }).reason], ['pr-bot', `auto: ${CANNOT}, so the review bot`]);
  assert.equal(resolveEngine(noBot, { codex: never, confined: CONFINED }).reason, `auto: ${CANNOT} and no review bot, so self`);
  assert.equal(resolveEngine({ ...noBot, reviewEngine: 'codex-local' }, { codex: never, confined: CONFINED }).problem, `review.engine is "codex-local", but ${CANNOT}`);
  assert.equal(resolveEngine({ ...noBot, reviewEngine: 'self' }, { codex: never, confined: CONFINED }).reason, 'review.engine: self');
  assert.equal(resolveEngine({ ...noBot, reviewEngine: 'codex-local' }, { codex: ready }).reviewer.name, 'codex-local', 'not confined: unchanged');
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
