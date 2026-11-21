import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordTrust, TRUST_STAGE, trustFile, trustProblem } from '../plugins/aidrian/lib/hosts/claude-code-trust.mjs';
import { CREDENTIAL_PATHS } from '../plugins/aidrian/lib/hosts/claude-code-sandbox.mjs';

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

test('an entry an earlier start left for the clone never stands in for the runs folder\'s consent, which is read again each start', (t) => {
  const fx = layout(t);
  fx.write({ [fx.runs]: { hasTrustDialogAccepted: true } });
  assert.equal(recordTrust({ work: fx.work, env: fx.env }), null);
  // The launch was refused, the Human revoked the runs folder's trust, and a retry makes the clone at the same path.
  const record = fx.read();
  record.projects[fx.runs].hasTrustDialogAccepted = false;
  writeFileSync(fx.file, JSON.stringify(record));
  assert.match(recordTrust({ work: fx.work, env: fx.env }).problem, /trusts no folder above the attempt's clone/u);
  // With the consent back, a clone trusted already is not rewritten, and an entry of its own keeps its other fields.
  fx.write({ [fx.runs]: { hasTrustDialogAccepted: true }, [fx.work]: { hasTrustDialogAccepted: true, lastCost: 1 } });
  const before = readFileSync(fx.file, 'utf8');
  assert.equal(recordTrust({ work: fx.work, env: fx.env }), null);
  assert.equal(readFileSync(fx.file, 'utf8'), before, 'not rewritten');
  fx.write({ [fx.runs]: { hasTrustDialogAccepted: true }, [fx.work]: { hasTrustDialogAccepted: false, lastCost: 2 } });
  assert.equal(recordTrust({ work: fx.work, env: fx.env }), null);
  assert.deepEqual(fx.read().projects[fx.work], { hasTrustDialogAccepted: true, lastCost: 2 });
});

test('the new record is staged under a sandbox read barrier and removed, and the staging folder is one of the barriers', (t) => {
  const fx = layout(t);
  fx.write({ [fx.runs]: { hasTrustDialogAccepted: true } });
  assert.equal(recordTrust({ work: fx.work, env: fx.env }), null);
  assert.deepEqual(readdirSync(path.join(fx.config, TRUST_STAGE)), [], 'no copy left behind');
  assert.ok(CREDENTIAL_PATHS.includes(TRUST_STAGE), 'beside a record in the home folder');
  assert.ok(CREDENTIAL_PATHS.includes('.claude.json'));
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

test('preflight finds trust recorded on the real path when the runs folder does not exist yet and a folder above the state folder is a link', (t) => {
  const fx = layout(t);
  const parent = path.dirname(path.dirname(fx.runs));
  const link = `${parent}-linked`;
  symlinkSync(parent, link);
  fx.write({ [path.dirname(fx.runs)]: { hasTrustDialogAccepted: true } });
  const runs = path.join(link, path.basename(path.dirname(fx.runs)), 'runs-not-made-yet');
  assert.equal(trustProblem({ folder: runs, env: fx.env }), null);
  fx.write({});
  assert.ok(trustProblem({ folder: runs, env: fx.env }).problem.includes(`create it with \`mkdir -p ${runs}\` if it does not exist yet`));
});
