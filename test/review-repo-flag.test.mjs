// `aidrian pr review <PR> --repo OWNER/NAME` reads the pull request from that repository, not the forge's default: a
// checkout whose remotes name several repositories needs it for a raise the Human approved in the session (#251).
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { runReview } from '../plugins/aidrian/lib/review/run.mjs';

function setup(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-review-repo-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const project = projectAt(dir);
  const calls = [];
  // The step stops at its first read: what it asked the forge is all this test reads.
  const forge = {
    change: (...args) => {
      calls.push(['change', ...args]);
      throw new Error('stop here');
    },
    repo: () => (calls.push(['repo']), 'up/r'),
  };
  const run = async (args) => {
    const errors = [];
    const original = console.error;
    console.error = (line) => errors.push(String(line));
    try {
      return { code: await runReview(args, loadConfig(project).config, project, { forge }), errors };
    } finally {
      console.error = original;
    }
  };
  return { calls, run };
}

test('pr review --repo reads the pull request from the repository it names', async (t) => {
  const g = setup(t);
  assert.equal((await g.run(['12', '--repo', 'O/R'])).code, 1);
  assert.deepEqual(g.calls[0].slice(0, 2), ['change', '12']);
  assert.deepEqual(g.calls[0][3], { repo: 'o/r' }, 'the named repository, not the forge default');
  const plain = setup(t);
  await plain.run(['12']);
  assert.equal(plain.calls[0].length, 3, 'with no --repo the step reads the forge default, as before');
});

test('pr review refuses a --repo that is not OWNER/NAME, or one with no pull request', async (t) => {
  const g = setup(t);
  for (const args of [['12', '--repo', 'nothing'], ['12', '--repo'], ['--repo', 'o/r']]) {
    const { code, errors } = await g.run(args);
    assert.equal(code, 1, args.join(' '));
    assert.match(errors.join('\n'), /--repo/u, args.join(' '));
  }
  assert.deepEqual(g.calls, [], 'no forge read on a usage error');
});

test('pr review --repo refuses a pull request URL of another repository before any forge read', async (t) => {
  // #251 security review: the step would read the URL's pull request while the rules and the record take --repo.
  const g = setup(t);
  const { code, errors } = await g.run(['https://github.com/a/b/pull/12', '--repo', 'c/d']);
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /--repo c\/d takes a pull request number, or a URL of a pull request of c\/d/u);
  assert.deepEqual(g.calls, [], 'no forge read');
  const same = setup(t);
  await same.run(['https://github.com/C/D/pull/12', '--repo', 'c/d']);
  assert.deepEqual([same.calls[0][1], same.calls[0][3]], ['12', { repo: 'c/d' }], 'a URL of that repository is its number');
});
