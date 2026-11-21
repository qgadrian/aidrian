import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordTrust, trustFile, trustProblem } from '../plugins/aidrian/lib/hosts/claude-code-trust.mjs';

// A host config folder and a runs folder with one attempt's clone, by real paths.
function layout(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-trust-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config');
  const runs = path.join(root, 'state', 'runs');
  const work = path.join(runs, 'launch', 'attempts', 'ENG-1.1', 'work');
  mkdirSync(config, { recursive: true });
  mkdirSync(work, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: config };
  const file = trustFile(env);
  const write = (projects, extra = {}) => writeFileSync(file, JSON.stringify({ ...extra, projects }), { mode: 0o600 });
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  return { config, runs, work, env, file, write, read };
}

test('the trust record is .claude.json in CLAUDE_CONFIG_DIR when set, else in the home folder itself', () => {
  assert.equal(trustFile({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), '/c/.claude.json');
  assert.equal(trustFile({}, '/h'), '/h/.claude.json');
  assert.equal(trustFile({ HOME: '/u' }), '/u/.claude.json');
});

test('a start records trust for its clone when the Human trusted a folder above it, and keeps the rest of the record and its mode', (t) => {
  const fx = layout(t);
  fx.write({ [fx.runs]: { hasTrustDialogAccepted: true, allowedTools: [] }, '/other': { hasTrustDialogAccepted: false } }, { numStartups: 7 });
  assert.equal(recordTrust({ work: fx.work, env: fx.env }), null);
  const record = fx.read();
  assert.equal(record.numStartups, 7);
  assert.deepEqual(record.projects['/other'], { hasTrustDialogAccepted: false });
  assert.deepEqual(record.projects[fx.runs], { hasTrustDialogAccepted: true, allowedTools: [] });
  assert.deepEqual(record.projects[fx.work], { hasTrustDialogAccepted: true });
  assert.equal(statSync(fx.file).mode & 0o777, 0o600);
  assert.equal(trustProblem({ folder: fx.runs, env: fx.env }), null);
});

test('a clone trusted already is left as it is, and an entry of its own keeps its other fields', (t) => {
  const fx = layout(t);
  fx.write({ [fx.work]: { hasTrustDialogAccepted: true, lastCost: 1 } });
  const before = readFileSync(fx.file, 'utf8');
  assert.equal(recordTrust({ work: fx.work, env: fx.env }), null);
  assert.equal(readFileSync(fx.file, 'utf8'), before, 'not rewritten');
  fx.write({ [fx.runs]: { hasTrustDialogAccepted: true }, [fx.work]: { hasTrustDialogAccepted: false, lastCost: 2 } });
  assert.equal(recordTrust({ work: fx.work, env: fx.env }), null);
  assert.deepEqual(fx.read().projects[fx.work], { hasTrustDialogAccepted: true, lastCost: 2 });
});

test('no trust above the clone records nothing and says so; an unreadable record records nothing either', (t) => {
  const fx = layout(t);
  fx.write({ [fx.runs]: { hasTrustDialogAccepted: false }, [path.join(fx.runs, 'other')]: { hasTrustDialogAccepted: true } });
  const untrusted = recordTrust({ work: fx.work, env: fx.env });
  assert.equal(untrusted.problem, `the host trusts no folder above the attempt's clone ${fx.work}, which, a repository of its own, inherits no trust`);
  assert.equal(fx.read().projects[fx.work], undefined);
  assert.match(trustProblem({ folder: fx.runs, env: fx.env }).problem, /does not trust .* or a folder above it/u);
  writeFileSync(fx.file, '{ not json');
  assert.match(recordTrust({ work: fx.work, env: fx.env }).problem, /cannot be read \(not JSON\), so the attempt's clone cannot be trusted$/u);
  rmSync(fx.file);
  assert.match(recordTrust({ work: fx.work, env: fx.env }).problem, /cannot be read \(ENOENT\)/u);
  assert.match(trustProblem({ folder: fx.runs, env: fx.env }).note, /cannot be read \(ENOENT\)/u);
});
