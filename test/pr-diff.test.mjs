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
import { pullRequestDiff, remoteOf } from '../plugins/aidrian/lib/pr-diff.mjs';
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
  // A project in a subfolder, with `diff.relative` on: the diff still holds every file, outside the project too, by its
  // path from the repository's top.
  const nested = repo(t);
  const app = path.join(nested.dir, 'app');
  mkdirSync(path.join(app, '.aidrian'), { recursive: true });
  writeFileSync(path.join(app, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  writeFileSync(path.join(app, 'inner.js'), 'export const inner = 1;\n');
  nested.git('add', '.');
  nested.git('commit', '-qm', 'nested project');
  const nestedBase = nested.git('rev-parse', 'HEAD');
  nested.git('switch', '-qc', 'nested-change');
  writeFileSync(path.join(app, 'inner.js'), 'export const inner = 2;\n');
  writeFileSync(path.join(nested.dir, 'page.js'), 'export const title = "Outside";\n');
  nested.git('commit', '-qam', 'change inside and outside');
  const nestedHead = nested.git('rev-parse', 'HEAD');
  nested.git('config', 'diff.relative', 'true');
  // state.dir is relative to the repository root, so the record lands in the top's ignored state folder.
  const inApp = { dir: app, state: nested.state };
  const fromApp = run(t, inApp, fakeGh({ base: nestedBase, head: nestedHead }, () => { throw ghFailed(TOO_LARGE); }));
  assert.equal(fromApp.code, 0, fromApp.err.join('\n'));
  const files = [...readFileSync(patchOf(inApp), 'utf8').matchAll(/^diff --git a\/(\S+) /gmu)].map((match) => match[1]);
  assert.deepEqual(files, ['app/inner.js', 'page.js']);
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
  // origin's URL reads as GitHub's acme/notes, and git fetches it from the upstream folder: no remote's URL, as git uses
  // it, names acme/notes, so the fetch goes to origin.
  r.git('config', `url.${upstream.dir}.insteadOf`, ORIGIN);
  r.git('remote', 'add', 'fork', 'git@github.com:someone/notes.git');
  assert.equal(remoteOf(r.dir, { host: 'github.com', repo: 'acme/notes' }), 'origin');
  assert.notEqual(spawnSync('git', ['cat-file', '-e', `${head}^{commit}`], { cwd: r.dir }).status, 0, 'the checkout lacks the head');
  // A remote-tracking branch upstream does not have, and a prune setting that would remove it on a default fetch.
  r.git('update-ref', 'refs/remotes/origin/unrelated', r.base);
  r.git('config', 'fetch.prune', 'true');
  // A configured refspec that would map the fetched commit to a remote-tracking ref.
  r.git('config', '--add', 'remote.origin.fetch', `${head}:refs/remotes/origin/pinned`);
  const result = run(t, r, fakeGh({ base: upstream.base, head }, () => { throw ghFailed(TOO_LARGE); }));
  assert.equal(result.code, 0, result.err.join('\n'));
  r.git('cat-file', '-e', `${head}^{commit}`);
  assert.match(readFileSync(patchOf(r), 'utf8'), /^\+export const title = "Tables";$/mu);
  assert.match(result.err[0], new RegExp(`, after fetching (?:[0-9a-f]{40} )?${head}$`, 'u'));
  assert.throws(() => r.git('rev-parse', '-q', '--verify', 'FETCH_HEAD'), 'the fetch leaves FETCH_HEAD as it was');
  assert.equal(r.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'), `refs/remotes/origin/unrelated ${r.base}`, 'no remote-tracking ref is written or pruned');
  // A commit no remote has fails, naming the fetch, and writes nothing.
  const lost = repo(t);
  lost.git('config', `url.${upstream.dir}.insteadOf`, ORIGIN);
  const missing = run(t, lost, fakeGh({ base: lost.base, head: 'f'.repeat(40) }, () => { throw ghFailed(TOO_LARGE); }));
  assert.equal(missing.code, 3);
  assert.match(missing.err.join('\n'), /as too large, and the local diff failed: git fetch --no-tags --no-prune --quiet --no-write-fetch-head --refmap= origin f{40} failed/u);
  assert.ok(!existsSync(patchOf(lost)), 'nothing was written');
});

test('remoteOf picks the remote whose URL, as git uses it, names the repository on its host, else origin', (t) => {
  const r = repo(t);
  r.git('remote', 'set-url', 'origin', 'git@github.com:someone/notes.git');
  r.git('remote', 'add', 'upstream', 'https://github.com/Acme/Notes.git');
  assert.equal(remoteOf(r.dir, { host: 'github.com', repo: 'acme/notes' }), 'upstream');
  assert.equal(remoteOf(r.dir, { host: 'ghe.acme.io', repo: 'acme/notes' }), 'origin', 'another host is another repository');
  // The URL after `url.*.insteadOf`, as `git remote -v` shows it, not the one in the config: a mirror git reads as
  // GitHub's acme/notes is it, and a GitHub URL git reads as a folder is not.
  const rewritten = repo(t);
  rewritten.git('remote', 'set-url', 'origin', 'https://github.com/acme/notes.git');
  rewritten.git('config', `url.${rewritten.dir}/elsewhere.insteadOf`, 'https://github.com/acme/notes.git');
  rewritten.git('remote', 'add', 'mirror', 'https://mirror.example/acme/notes.git');
  rewritten.git('config', 'url.https://github.com/.insteadOf', 'https://mirror.example/');
  assert.equal(remoteOf(rewritten.dir, { host: 'github.com', repo: 'acme/notes' }), 'mirror');
  // A remote set only in the command's own config scope, as `git remote -v` lists it to the remotes check.
  const scoped = repo(t);
  scoped.git('remote', 'set-url', 'origin', 'git@github.com:someone/notes.git');
  const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const before = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => (before[i] === undefined ? delete process.env[key] : (process.env[key] = before[i]))));
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.scoped.url', GIT_CONFIG_VALUE_0: 'https://github.com/acme/notes.git' });
  assert.equal(remoteOf(scoped.dir, { host: 'github.com', repo: 'acme/notes' }), 'scoped');
});

test('a shallow checkout is refused, whether or not its diff would succeed, naming the fetch that fixes it', (t) => {
  const upstream = repo(t);
  // The pull request branches from a commit above the root, and main moves on past it: its merge base is neither tip.
  const commit = (file, text, message) => {
    writeFileSync(path.join(upstream.dir, file), text);
    upstream.git('add', file);
    upstream.git('commit', '-qm', message);
    return upstream.git('rev-parse', 'HEAD');
  };
  upstream.git('branch', '-D', 'feature');
  const fork = commit('fork.js', 'export const fork = 1;\n', 'branch point');
  upstream.git('switch', '-qc', 'topic');
  const head = commit('page.js', 'export const title = "Tables";\n', 'head');
  upstream.git('switch', '-q', 'main');
  const base = commit('other.js', 'export const other = 1;\n', 'main moves on');
  // Depth 1 leaves the merge base out, so the diff would fail; depth 2 keeps it, so the diff would succeed.
  for (const [depth, mergeBase] of [['1', false], ['2', true]]) {
    const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-pr-diff-shallow-')));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    execFileSync('git', ['clone', '-q', '--depth', depth, '--no-single-branch', `file://${upstream.dir}`, 'clone'], { cwd: parent });
    const dir = path.join(parent, 'clone');
    const r = { dir, state: path.join(dir, 'state') };
    // At depth 2 the pull request's remote has a name a shell would read as two commands.
    const remote = depth === '2' ? 'release&review' : 'origin';
    if (depth === '2') execFileSync('git', ['remote', 'add', remote, 'https://github.com/acme/notes.git'], { cwd: dir });
    const has = (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: dir }).status === 0;
    assert.deepEqual([has(base), has(head), has(fork)], [true, true, mergeBase], `depth ${depth}`);
    const result = run(t, r, fakeGh({ base, head }, () => { throw ghFailed(TOO_LARGE); }));
    assert.equal(result.code, 3, `depth ${depth}`);
    assert.ok(result.err.join('\n').includes(`as too large, and the local diff failed: this checkout is shallow, so the local diff of #7 could be wrong or fail; run \`git fetch --unshallow '${remote}'\` here and then the command again, or run the command from a full clone`), result.err.join('\n'));
    assert.deepEqual(viewsOfEnds(result.calls), [], 'refused before any other read');
    assert.ok(!existsSync(patchOf(r)), 'nothing was written');
    assert.equal(execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: dir, encoding: 'utf8' }).trim(), 'true', 'nothing was fetched');
  }
});

test('a shallow probe that does not answer true or false stops with git\'s error, before any read or fetch', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-pr-diff-nogit-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const asked = [];
  const forge = { diff: () => { throw ghFailed(TOO_LARGE); }, changeEnds: (...args) => asked.push(args) };
  assert.throws(() => pullRequestDiff({ forge, pr: { number: 7, host: 'github.com', repo: 'acme/notes' }, root: dir }), /as too large, and the local diff failed: git rev-parse --is-shallow-repository failed \(fatal: not a git repository/u);
  assert.deepEqual(asked, [], 'no commit read, so no fetch');
});
