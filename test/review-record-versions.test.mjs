// Two plugin versions on one pull request: an older one reads and writes the review record under its old name, a newer
// one the repository's own file. A real pull request lost the Human's sign-off that way: the newer version signed off in
// its own file, the older one kept writing and posting from the old name, and the newer one's next review built on that
// copy and removed the old file. The two records are read and written as their merge, a Human entry is never dropped,
// and each write stamps its plugin version and warns when an older one writes over a newer one's record.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pluginVersion } from '../plugins/aidrian/lib/config-version.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { readRecord as readAttest, writeRecord as writeAttest } from '../plugins/aidrian/lib/review-gate.mjs';
import { postedCopy } from '../plugins/aidrian/lib/review/publish.mjs';
import { emptyState, readLocalState, readRecord, recordFile, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';

const OPEN = { reading: { visibility: 'PRIVATE', inside: true }, checker: { allows: () => true } };
const [H1, H2] = ['1'.repeat(40), '2'.repeat(40)];
const SIGNOFF = { head: H2, by: 'The Human', at: '2026-11-14T18:49:27.000Z' };

let seed = 0;
function setup(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-record-versions-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const owner = `v${process.pid}x${(seed += 1)}`;
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${owner}/b.git`], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const project = projectAt(dir);
  const repo = `${owner}/b`;
  const own = recordFile(project, 12, repo);
  const plain = recordFile(project, 12);
  mkdirSync(path.dirname(own), { recursive: true });
  const put = (file, state) => writeFileSync(file, JSON.stringify(state));
  return { project, repo, own, plain, put };
}

const record = (repo, fields) => ({ ...emptyState(12, repo), ...fields });
const onDisk = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('the old-name record and the repository`s own record of one pull request are read as their merge', (t) => {
  const { project, repo, own, plain, put } = setup(t);
  // The newer version's file: the Human's sign-off, on the second head.
  put(own, record(repo, {
    revision: 5, updatedAt: '2026-11-14T18:49:27.000Z', rounds: [{ head: H1 }, { head: H2 }], idCounter: 4,
    planNote: { head: H2 }, passes: { 'agent:code-reviewer': { head: H2, reviewer: 'code-reviewer' } }, signoffs: { payments: SIGNOFF },
  }));
  // The older version's file, written after: more revisions, an overrule and a pass of its own, and no sign-off.
  const overrule = { flow: 'booking', invariant: 'refunds', head: H2, by: 'The Human', reason: 'held', at: '2026-11-14T18:50:00.000Z' };
  put(plain, record(repo, {
    revision: 8, updatedAt: '2026-11-14T18:51:00.000Z', rounds: [{ head: H1 }, { head: H2 }], idCounter: 2,
    passes: { 'agent:code-reviewer': { head: H1, reviewer: 'code-reviewer' }, 'agent:security-engineer': { head: H2, reviewer: 'security-engineer' } },
    overrulings: [overrule], overrides: [`The Human overruled the violated verdict on booking/refunds at ${H2.slice(0, 7)}: held`],
  }));
  const merged = readLocalState(project, 12, repo);
  assert.deepEqual(merged.signoffs, { payments: SIGNOFF }, 'the Human`s sign-off is kept');
  assert.deepEqual(merged.overrulings, [overrule], 'and the overrule the other file holds');
  assert.equal(merged.overrides.length, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(merged.passes).map(([id, pass]) => [id, pass.head])), { 'agent:code-reviewer': H2, 'agent:security-engineer': H2 },
    'each pass of either, the one on the head last reviewed where they differ');
  assert.deepEqual([merged.revision, merged.idCounter, merged.updatedAt], [8, 4, '2026-11-14T18:51:00.000Z'], 'the newer revision and the higher id counter');

  writeLocalState(project, merged);
  assert.equal(existsSync(plain), false, 'the write moves the merge to the repository`s file');
  assert.deepEqual(onDisk(own).signoffs, { payments: SIGNOFF });
  assert.equal(onDisk(own).revision, 9);
});

test('a newer copy on the pull request that never read the Human`s sign-off does not drop it', (t) => {
  const { project, repo, own, plain, put } = setup(t);
  put(own, record(repo, { revision: 5, updatedAt: '2026-11-14T18:49:27.000Z', rounds: [{ head: H1 }, { head: H2 }], signoffs: { payments: SIGNOFF } }));
  // The older version posted from its old-name file, at a higher revision than either file here holds.
  const posted = record(repo, { revision: 21, updatedAt: '2026-11-14T18:51:13.000Z', rounds: [{ head: H1 }, { head: H2 }] });
  const comments = [{ id: 1, body: summaryBody(posted, null, 'x', OPEN), author_association: 'MEMBER' }];
  const { state } = readRecord(project, 12, comments, repo);
  assert.equal(state.revision, 21, 'the newer copy is built on');
  assert.deepEqual(state.signoffs, { payments: SIGNOFF }, 'with the sign-off it never read');

  // The old-name file written after this machine read its record: its write merges it before removing it.
  const acceptance = { flow: 'booking', invariant: 'refunds', head: H2, by: 'The Human', reason: 'ok', evidence: 'x', kind: 'url', at: '2026-11-14T18:52:00.000Z' };
  put(plain, record(repo, { revision: 30, updatedAt: '2026-11-14T18:52:00.000Z', rounds: [{ head: H1 }, { head: H2 }], acceptances: [acceptance] }));
  writeLocalState(project, state);
  assert.equal(existsSync(plain), false);
  assert.deepEqual([onDisk(own).signoffs, onDisk(own).acceptances], [{ payments: SIGNOFF }, [acceptance]]);
  assert.equal(onDisk(own).revision, 31, 'past the old record`s revision, so the merge is the newer record');

  // A review that started over, on another first round, keeps none of the earlier review's entries, as before.
  const restarted = record(repo, { revision: 40, rounds: [{ head: H2, at: '2026-11-15T00:00:00.000Z' }] });
  const fresh = readRecord(project, 12, [{ id: 1, body: summaryBody(restarted, null, 'x', OPEN), author_association: 'MEMBER' }], repo).state;
  assert.deepEqual([fresh.signoffs, fresh.acceptances ?? []], [{}, []]);
});

test('each write stamps its plugin version, warns when an older one writes over a newer one`s record, and never posts it', (t) => {
  const { project, repo, own, put } = setup(t);
  const warnings = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => warnings.push(String(chunk));
  t.after(() => {
    process.stderr.write = write;
  });
  writeLocalState(project, record(repo, {}));
  assert.equal(onDisk(own).pluginVersion, pluginVersion());
  assert.deepEqual(warnings, [], 'a record this version wrote');
  put(own, { ...onDisk(own), pluginVersion: '999.0.0' });
  writeLocalState(project, readLocalState(project, 12, repo));
  process.stderr.write = write;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`aidrian ${pluginVersion().replaceAll('.', '\\.')} is writing the review record of #12, which aidrian 999\\.0\\.0 wrote last`, 'u'));
  assert.equal(onDisk(own).pluginVersion, pluginVersion());
  assert.equal('pluginVersion' in postedCopy(onDisk(own), OPEN).copy, false, 'the version stays on this machine');
});

test('the attest record that counts is the later of the old-name file and the repository`s own', (t) => {
  const { project, repo } = setup(t);
  const folder = path.dirname(recordFile(project, 12, repo));
  const base = { pr: 12, repo, reviewer: 'code-reviewer', findings: 0, fixed: 0, note: null };
  writeAttest(project, { ...base, head: H1 });
  assert.equal(readAttest(project, 12, repo).head, H1);
  // A session on an older version attests the next head under the old name.
  writeFileSync(path.join(folder, 'pr-12.json'), JSON.stringify({ ...base, head: H2, recordedAt: '2999-01-01T00:00:00.000Z' }));
  assert.equal(readAttest(project, 12, repo).head, H2, 'the later attest counts');
  writeAttest(project, { ...base, head: H1 });
  assert.equal(readAttest(project, 12, repo).head, H1, 'and a later write of the own file moves past it');
  assert.equal(existsSync(path.join(folder, 'pr-12.json')), false);
});
