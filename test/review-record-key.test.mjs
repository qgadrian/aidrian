// #305: this machine's review record is keyed by repository and number, so one checkout whose remotes name several
// repositories keeps a/b#12 and c/d#12 apart. Origin's record keeps the old file name, so a record written before the
// key changed is still read for origin, and another repository's old-name record is read once and moved.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { recordPending } from '../plugins/aidrian/lib/review/pending.mjs';
import { emptyState, readLocalState, recordFile, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';

let seed = 0;
function setup(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-record-key-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  // The state folder is keyed by the origin, so each test gets its own owner.
  const owner = `a${process.pid}x${(seed += 1)}`;
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${owner}/b.git`], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'other', 'https://github.com/c/d.git'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  return { project: projectAt(dir), origin: `${owner}/b` };
}

const withRounds = (pr, repo, n) => ({ ...emptyState(pr, repo), rounds: Array.from({ length: n }, (_, i) => ({ head: String(i).repeat(40) })) });

test('one checkout keeps a separate record for each repository`s pull request of one number', (t) => {
  const { project, origin } = setup(t);
  writeLocalState(project, withRounds(12, origin, 1));
  writeLocalState(project, withRounds(12, 'c/d', 2));
  assert.equal(readLocalState(project, 12, origin).rounds.length, 1, 'origin`s own');
  assert.equal(readLocalState(project, 12, 'C/D').rounds.length, 2, 'the other repository`s own, in any letter case');
  assert.notEqual(recordFile(project, 12, origin), recordFile(project, 12, 'c/d'));
  recordPending(project, { pr: 12, repo: 'c/d', kind: 'request', head: 'e'.repeat(40), by: 'H' });
  assert.deepEqual([readLocalState(project, 12, origin).pending.length, readLocalState(project, 12, 'c/d').pending.length], [0, 1], 'an owed entry lands in its repository`s record');
});

test('a record under the old file name is still read for origin, and another repository`s is read once and moved', (t) => {
  const { project, origin } = setup(t);
  const plain = recordFile(project, 12);
  mkdirSync(path.dirname(plain), { recursive: true });
  writeFileSync(plain, JSON.stringify({ ...withRounds(12, origin, 3), revision: 4 }));
  assert.equal(plain, recordFile(project, 12, origin), 'origin keeps the old name');
  assert.equal(readLocalState(project, 12, origin).rounds.length, 3);
  writeFileSync(plain, JSON.stringify({ ...withRounds(12, 'c/d', 2), revision: 4 }));
  const moved = readLocalState(project, 12, 'c/d');
  assert.equal(moved.rounds.length, 2, 'read under the old name');
  writeLocalState(project, moved);
  assert.ok(existsSync(recordFile(project, 12, 'c/d')), 'the next write moves it to its own file');
  assert.equal(existsSync(plain), false, 'and leaves no copy under the old name');
  assert.equal(readLocalState(project, 12, 'c/d').revision, 5);
});
