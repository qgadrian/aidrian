// `aidrian pr product-feedback diff` on a pull request whose diff the forge refuses as too large: the local fallback
// (lib/pr-diff.mjs) diffs the two commits the forge names in the checkout, fetching a missing one first, and any other
// forge failure still fails.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGithubForge } from '../plugins/aidrian/lib/forges/github.mjs';
import { remoteOf } from '../plugins/aidrian/lib/pr-diff.mjs';
import { runProductFeedback } from '../plugins/aidrian/lib/pr-product-feedback.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';

const URL7 = 'https://github.com/acme/notes/pull/7';
const ORIGIN = 'git@github.com:acme/notes.git';
// What gh prints when GitHub refuses a pull request's diff past its size limit.
const TOO_LARGE = 'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000). (https://api.github.com/repos/acme/notes/pulls/7)\nPullRequest.diff too_large\n';
const ghFailed = (stderr) => Object.assign(new Error(`Command failed: gh pr diff 7\n${stderr}`), { stderr });

// A temporary repository (never a real one, and no GIT_DIR) with origin named as GitHub's acme/notes, a base commit on
// main, and a head commit on a branch: { dir, git, base, head, state }.
function repo(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-pr-diff-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', ORIGIN);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  writeFileSync(path.join(dir, '.gitignore'), 'state/\n');
  writeFileSync(path.join(dir, 'page.js'), 'export const title = "Bookings";\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'feature');
  writeFileSync(path.join(dir, 'page.js'), 'export const title = "Reservations";\n');
  git('commit', '-qam', 'head');
  const head = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  return { dir, git, base, head, state: path.join(dir, 'state') };
}

// The gh seam: the pull request view, with `ends` its base and head commits, and the diff, which `diff` throws or prints.
function fakeGh({ base, head }, diff) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ number: 7, headRefOid: head, baseRefOid: base, baseRefName: 'main', author: { login: 'adrian' }, url: URL7, files: [], changedFiles: 0, reviewDecision: '', latestReviews: [], isCrossRepository: false });
    }
    if (args[0] === 'pr' && args[1] === 'diff') return diff();
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

// Runs `diff 7` with the gh seam: { code, out, err, calls }.
function run(t, r, fake) {
  const out = [];
  const err = [];
  t.mock.method(console, 'log', (line) => out.push(line));
  t.mock.method(console, 'error', (line) => err.push(line));
  const forge = createGithubForge({ cwd: r.dir, run: (args) => fake.gh(args) });
  const code = runProductFeedback(['diff', URL7], projectAt(r.dir), { forge, remotes: () => ['github.com/acme/notes'], access: () => [] });
  t.mock.restoreAll();
  return { code, out, err, calls: fake.calls };
}

const patchOf = (r) => path.join(r.state, 'product-feedback/acme/notes/pr-7/diff.patch');
const viewsOfEnds = (calls) => calls.filter((args) => args[1] === 'view' && args.includes('baseRefOid,headRefOid'));

test('a diff gh refuses as too large comes from the local fallback, git diff of its two commits, and says so', (t) => {
  const r = repo(t);
  const result = run(t, r, fakeGh(r, () => { throw ghFailed(TOO_LARGE); }));
  assert.equal(result.code, 0, result.err.join('\n'));
  assert.deepEqual(result.out, [patchOf(r)], 'stdout is the path alone, as before');
  const written = readFileSync(patchOf(r), 'utf8');
  assert.equal(written, `${r.git('diff', '--no-color', `${r.base}...${r.head}`)}\n`);
  assert.match(written, /^\+export const title = "Reservations";$/mu);
  assert.deepEqual(viewsOfEnds(result.calls), [['pr', 'view', '7', '--json', 'baseRefOid,headRefOid', '--repo', 'github.com/acme/notes']]);
  assert.equal(result.err.length, 1);
  assert.match(result.err[0], new RegExp(`as too large, so it came from the local fallback: git diff ${r.base}\\.\\.\\.${r.head} in this checkout$`, 'u'));
});

test('any other gh failure still exits 3, writes nothing, and reads no commits for a local diff', (t) => {
  const others = [
    'gh: Server Error (HTTP 502)\n',
    'could not find pull request diff: HTTP 406: Sorry, this diff is unavailable. (https://api.github.com/repos/acme/notes/pulls/7)\nPullRequest.diff not_available\n',
    'error: the diff mentions PullRequest.diff too_large in passing\n',
  ];
  for (const stderr of others) {
    const r = repo(t);
    const result = run(t, r, fakeGh(r, () => { throw ghFailed(stderr); }));
    assert.equal(result.code, 3, stderr);
    assert.match(result.err.join('\n'), /could not read the diff of #7 with gh/u);
    assert.deepEqual(viewsOfEnds(result.calls), [], 'no fallback for another failure');
    assert.ok(!existsSync(patchOf(r)), 'nothing was written');
  }
});

test('a commit the checkout lacks is fetched from the pull request\'s remote first', (t) => {
  const upstream = repo(t);
  const r = repo(t);
  // The pull request's head lives only upstream: a commit on top of upstream's head the checkout has never seen.
  upstream.git('switch', '-q', 'feature');
  writeFileSync(path.join(upstream.dir, 'page.js'), 'export const title = "Tables";\n');
  upstream.git('commit', '-qam', 'later');
  const head = upstream.git('rev-parse', 'HEAD');
  // origin keeps GitHub's URL, so the remote that names acme/notes is found; git reads the URL as the upstream folder.
  r.git('config', `url.${upstream.dir}.insteadOf`, ORIGIN);
  r.git('remote', 'add', 'fork', 'git@github.com:someone/notes.git');
  assert.equal(remoteOf(r.dir, { host: 'github.com', repo: 'acme/notes' }), 'origin');
  assert.notEqual(spawnSync('git', ['cat-file', '-e', `${head}^{commit}`], { cwd: r.dir }).status, 0, 'the checkout lacks the head');
  const result = run(t, r, fakeGh({ base: upstream.base, head }, () => { throw ghFailed(TOO_LARGE); }));
  assert.equal(result.code, 0, result.err.join('\n'));
  r.git('cat-file', '-e', `${head}^{commit}`);
  assert.match(readFileSync(patchOf(r), 'utf8'), /^\+export const title = "Tables";$/mu);
  assert.match(result.err[0], new RegExp(`, after fetching (?:[0-9a-f]{40} )?${head}$`, 'u'));
  // A commit no remote has fails, naming the fetch, and writes nothing.
  const lost = repo(t);
  lost.git('config', `url.${upstream.dir}.insteadOf`, ORIGIN);
  const missing = run(t, lost, fakeGh({ base: lost.base, head: 'f'.repeat(40) }, () => { throw ghFailed(TOO_LARGE); }));
  assert.equal(missing.code, 3);
  assert.match(missing.err.join('\n'), /as too large, and the local diff failed: git fetch origin f{40} failed/u);
  assert.ok(!existsSync(patchOf(lost)), 'nothing was written');
});

test('remoteOf picks the remote that names the repository on its host, else origin', (t) => {
  const r = repo(t);
  r.git('remote', 'set-url', 'origin', 'git@github.com:someone/notes.git');
  r.git('remote', 'add', 'upstream', 'https://github.com/Acme/Notes.git');
  assert.equal(remoteOf(r.dir, { host: 'github.com', repo: 'acme/notes' }), 'upstream');
  assert.equal(remoteOf(r.dir, { host: 'ghe.acme.io', repo: 'acme/notes' }), 'origin', 'another host is another repository');
});
