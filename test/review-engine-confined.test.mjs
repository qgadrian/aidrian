import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { resolveEngine } from '../plugins/aidrian/lib/review/reviewers.mjs';
import { confinedSession } from '../plugins/aidrian/lib/review/step.mjs';
import { markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { repo } from './review-run-fixture.mjs';

// A project run's confined issue session cannot start codex-local: Codex sets up a sandbox of its own and needs the
// network, which the host's sandbox denies. There the review takes the agent reviewer, self, and says why; anywhere
// else the engine is chosen as before.

const PINNED = { version: 1, review: { engine: 'codex-local' } };
const ready = () => ({ ok: true });
const noExec = async () => assert.fail('codex-local must not run in a confined session');

test('in a confined attempt clone, a project that pins codex-local reviews with the agent reviewer, and says why', async (t) => {
  const r = repo(t, { baseConfig: PINNED, attempt: 'run-a/12.1', change: (write) => write('src/app.js', 'c\n') });
  const result = await r.step({ exec: noExec, codex: () => assert.fail('codex is not asked in a confined session') });
  assert.equal(result.engine.name, 'self');
  assert.equal(result.engine.reason, "review.engine: codex-local, but codex-local cannot run inside the host's sandbox of the confined session of project run run-a, issue 12, whose attempt clone this is, so the agent reviewer self (set by the project config)");
  assert.equal(result.status, 'dispatch');
  assert.deepEqual(result.dispatch.map((each) => each.pass), ['agent:code-reviewer']);
});

test('outside a confined session, the same pin runs codex-local as before', async (t) => {
  const r = repo(t, { baseConfig: PINNED, change: (write) => write('src/app.js', 'c\n') });
  let ran = 0;
  const result = await r.step({ exec: async () => ((ran += 1), { status: 'done', findings: [], verdicts: [], dropped: [] }) });
  assert.deepEqual([result.engine.name, result.engine.reason, ran], ['codex-local', 'review.engine: codex-local (set by the project config)', 1]);
});

test('resolveEngine: in a confined session, auto passes codex-local over and a pinned one takes self; the plan rules stay', () => {
  const base = loadConfig({ root: '/nowhere', paths: { config: 'none.json', local: 'none' } }).config;
  const confined = 'the confined session of project run run-a, issue 12';
  const withBot = base;
  const noBot = { ...base, github: { ...base.github, reviewer: null } };
  const never = () => assert.fail('codex is not asked in a confined session');
  assert.equal(resolveEngine({ ...withBot, reviewEngine: 'auto' }, { codex: never, confined }).reviewer.name, 'pr-bot');
  assert.equal(resolveEngine({ ...noBot, reviewEngine: 'auto' }, { codex: never, confined }).reviewer.name, 'self');
  const pinned = resolveEngine({ ...noBot, reviewEngine: 'codex-local' }, { codex: never, confined });
  assert.equal(pinned.reviewer.name, 'self');
  assert.equal(pinned.reviewer.independent, false, 'self stays the non-independent reviewer: a require of independent-model still needs another');
  assert.equal(resolveEngine({ ...noBot, reviewEngine: 'self' }, { codex: never, confined }).reason, 'review.engine: self');
  assert.equal(resolveEngine({ ...noBot, reviewEngine: 'codex-local' }, { codex: ready }).reviewer.name, 'codex-local', 'not confined: unchanged');
  assert.equal(resolveEngine({ ...noBot, reviewEngine: 'auto' }, { codex: ready, confined: null }).reviewer.name, 'codex-local');
});

test('confinedSession: the session`s unattended mark naming a run and an issue, or an attempt`s folder, is a confined session', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'aidrian-confined-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const session = randomUUID();
  const env = { XDG_STATE_HOME: path.join(root, 'xdg'), CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session };
  const checkout = path.join(root, 'checkout');
  assert.equal(confinedSession(checkout, env, { home }), null, 'no mark, no attempt folder');
  assert.ok(markUnattended(session, { root: checkout, env }), 'a background session with no run tags');
  assert.equal(confinedSession(checkout, env, { home }), null, 'an unattended session that works no issue of a run is not confined');
  assert.ok(markUnattended(session, { root: checkout, env, tags: { project: 'run-b', issue: 'ENG-4' } }));
  assert.equal(confinedSession(checkout, env, { home }), 'the confined session of project run run-b, issue ENG-4');
  const work = path.join(root, 'state', 'runs', 'run-c', 'attempts', '7.2', 'work');
  assert.equal(confinedSession(work, {}, { home }), 'the confined session of project run run-c, issue 7, whose attempt clone this is');
});
