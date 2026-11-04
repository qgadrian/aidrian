import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commands } from '../plugins/aidrian/lib/pr.mjs';
import { runAutoMerge } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { emptyState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const OLD = '1234567890abcdef1234567890abcdef12345678';
const TEAM = { allow: true, strategy: 'squash', deleteBranch: true, deleteWorktree: false };
const URL7 = 'https://github.com/acme/notes/pull/7';
const configText = (autoMerge) => JSON.stringify({ version: 1, github: { autoMerge } });

// A temporary git repository (never a real one, and no GIT_DIR) whose working copy commits `working` as the team's
// github.autoMerge, with origin at `origin`, and a `.aidrian.local.json` that sets the machine's switch to `local`.
// The project's state folder is inside it.
function repo(t, { working = { ...TEAM, allow: true }, local = 'on', origin = 'git@github.com:acme/notes.git' } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-auto-merge-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', origin);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' }, github: { autoMerge: working } }));
  git('add', '.aidrian/config.json');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'config');
  if (local !== null) writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(typeof local === 'string' ? { github: { autoMerge: local } } : local));
  const project = projectAt(dir);
  const record = (edit, repoName = 'acme/notes') => {
    const state = emptyState(7, repoName);
    edit(state);
    writeLocalState(project, state);
  };
  return { dir, git, project, record };
}

const finished = (state, head = HEAD, status = 'received') => (state.outcome = { status, head, at: '2026-11-03T14:00:00.000Z' });

// The gh seam. `files` maps `<repo>@<branch>:<path>` to a file's text on GitHub; any other contents read is a 404, and
// a read whose ref is not `refs/heads/<branch>` is no call the command makes. `view` overrides fields of the
// `gh pr view` answer; `defaultBranch` is every repository's default branch; `user` is the login, or a function
// standing in for the call.
function fakeGh({ files = { 'acme/notes@main:.aidrian/config.json': configText(TEAM) }, view = {}, user = 'Adrian', defaultBranch = 'main' } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ number: 7, headRefOid: HEAD, baseRefName: 'main', author: { login: 'adrian' }, url: URL7, ...view });
    }
    if (args[0] === 'api' && args[3] === 'user') {
      if (typeof user === 'function') return user();
      return JSON.stringify({ login: user });
    }
    if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/u.test(args[3] ?? '')) {
      if (typeof defaultBranch === 'function') return defaultBranch();
      return JSON.stringify({ default_branch: defaultBranch });
    }
    const match = args[0] === 'api' && /^repos\/([^/]+\/[^/]+)\/contents\/(.+)\?ref=refs%2Fheads%2F([^&]+)$/u.exec(args[3] ?? '');
    if (match) {
      const key = `${match[1]}@${decodeURIComponent(match[3])}:${match[2].split('/').map(decodeURIComponent).join('/')}`;
      if (!Object.hasOwn(files, key)) throw Object.assign(new Error(`Command failed: gh ${args.join(' ')}\ngh: Not Found (HTTP 404)`), { stderr: 'gh: Not Found (HTTP 404)\n' });
      return JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(files[key]).toString('base64') });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

// Runs the command and returns { code, out, err, calls }.
function run(t, r, argv, ghOptions) {
  const out = [];
  const err = [];
  t.mock.method(console, 'log', (line) => out.push(line));
  t.mock.method(console, 'error', (line) => err.push(line));
  const { gh, calls } = fakeGh(ghOptions);
  const code = runAutoMerge(argv, r.project, { gh });
  t.mock.restoreAll();
  return { code, out, err, calls };
}

const json = (result) => JSON.parse(result.out.join('\n'));
const reasonOf = (t, r, ghOptions, argv = ['7', '--json']) => {
  const result = run(t, r, argv, ghOptions);
  return [result.code, json(result).reason];
};
const userCalls = (calls) => calls.filter((args) => args[0] === 'api' && args[3] === 'user');

test('both layers on, the Human\'s own pull request, and a finished review on its head: on, exit 0', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const result = run(t, r, ['7', '--json']);
  assert.equal(result.code, 0);
  assert.deepEqual(json(result), {
    effective: true, reason: null, allow: true, local: 'on', strategy: 'squash', deleteBranch: true, deleteWorktree: false,
    pr: 7, head: HEAD, repo: 'acme/notes', base: 'main',
  });
  assert.deepEqual(result.calls, [
    ['pr', 'view', '7', '--json', 'number,headRefOid,baseRefName,author,url'],
    ['api', '--hostname', 'github.com', 'repos/acme/notes'],
    ['api', '--hostname', 'github.com', 'repos/acme/notes/contents/.aidrian.json?ref=refs%2Fheads%2Fmain'],
    ['api', '--hostname', 'github.com', 'repos/acme/notes/contents/.aidrian/config.json?ref=refs%2Fheads%2Fmain'],
    ['api', '--hostname', 'github.com', 'user'],
  ], 'the base is the default branch: its config is read once');
  const human = run(t, r, ['7']);
  assert.equal(human.code, 0);
  assert.equal(human.out.length, 1);
  assert.match(human.out[0], /^auto-merge on for #7 at abcdef1: squash, delete the branch, keep the worktree$/);
});

test('every gh api call names the host of the pull request\'s URL', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const result = run(t, r, ['7', '--json'], {
    view: { url: 'https://ghe.acme.io/acme/notes/pull/7' },
    files: { 'acme/notes@main:.aidrian/config.json': configText(TEAM) },
  });
  assert.equal(result.code, 0);
  const api = result.calls.filter((args) => args[0] === 'api');
  assert.equal(api.length, 4);
  for (const args of api) assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'ghe.acme.io']);
});

test('the team keys come from the base on GitHub, never the working copy: a branch allowing it over a base that does not is off (team)', (t) => {
  const r = repo(t, { working: { ...TEAM, allow: true, strategy: 'merge' } });
  r.record((state) => finished(state));
  const result = run(t, r, ['--json'], { files: { 'acme/notes@main:.aidrian/config.json': configText({ ...TEAM, allow: false, strategy: 'rebase' }) } });
  assert.equal(result.code, 1);
  assert.deepEqual(json(result), {
    effective: false, reason: 'team', allow: false, local: 'on', strategy: 'rebase', deleteBranch: true, deleteWorktree: false,
    pr: 7, head: HEAD, repo: 'acme/notes', base: 'main',
  });
  assert.deepEqual(result.calls[0], ['pr', 'view', '--json', 'number,headRefOid,baseRefName,author,url'], 'no argument: the current branch');
  assert.deepEqual(userCalls(result.calls), [], 'team off: no gh api user call');
  const missing = run(t, r, ['7', '--json'], { files: {} });
  assert.deepEqual([missing.code, json(missing).reason, json(missing).allow], [1, 'team', false], 'no config.json on the base: the defaults, off');
});

test('the strategy comes from the base branch', (t) => {
  const r = repo(t, { working: { ...TEAM, strategy: 'merge' } });
  r.record((state) => finished(state));
  const result = run(t, r, ['7', '--json'], { files: { 'acme/notes@main:.aidrian/config.json': configText({ ...TEAM, strategy: 'rebase' }) } });
  assert.deepEqual([result.code, json(result).strategy], [0, 'rebase']);
});

test('a fork checkout reads the ceiling of the pull request\'s repository, not origin\'s', (t) => {
  const r = repo(t, { origin: 'git@github.com:me/notes.git' });
  r.record((state) => finished(state));
  const files = {
    'acme/notes@main:.aidrian/config.json': configText(TEAM),
    'me/notes@main:.aidrian/config.json': configText({ ...TEAM, allow: false }),
  };
  const result = run(t, r, [URL7, '--json'], { files });
  assert.deepEqual([result.code, json(result).repo], [0, 'acme/notes']);
  assert.ok(result.calls.filter((args) => args[0] === 'api' && args[3] !== 'user').every((args) => /^repos\/acme\/notes(?:\/|$)/u.test(args[3])));
  const upstreamOff = run(t, r, [URL7, '--json'], { files: { ...files, 'acme/notes@main:.aidrian/config.json': configText({ ...TEAM, allow: false }), 'me/notes@main:.aidrian/config.json': configText(TEAM) } });
  assert.deepEqual([upstreamOff.code, json(upstreamOff).reason], [1, 'team']);
});

test('a local branch or tag named origin/<base>, and a stale fetch, have no effect: GitHub\'s base now decides', (t) => {
  const r = repo(t, { working: { ...TEAM, allow: true } });
  r.record((state) => finished(state));
  // The local refs all commit allow: true; GitHub's main says false.
  r.git('branch', 'origin/main');
  r.git('tag', 'origin/main');
  r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.deepEqual(reasonOf(t, r, { files: { 'acme/notes@main:.aidrian/config.json': configText({ ...TEAM, allow: false }) } }), [1, 'team']);
  // The fetched origin/main says false; GitHub's main has since allowed it: honoured without a fetch.
  const stale = repo(t, { working: { ...TEAM, allow: false } });
  stale.record((state) => finished(state));
  stale.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.deepEqual(reasonOf(t, stale, { files: { 'acme/notes@main:.aidrian/config.json': configText(TEAM) } }), [0, null]);
});

test('the base\'s .aidrian.json folder override is read at the base, never the working copy\'s', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  writeFileSync(path.join(r.dir, '.aidrian.json'), JSON.stringify({ dir: 'elsewhere' }));
  const files = {
    'acme/notes@main:.aidrian.json': JSON.stringify({ dir: 'harness' }),
    'acme/notes@main:harness/config.json': configText({ ...TEAM, strategy: 'merge' }),
    'acme/notes@main:.aidrian/config.json': configText({ ...TEAM, allow: false }),
  };
  const result = run(t, r, ['7', '--json'], { files });
  assert.deepEqual([result.code, json(result).strategy], [0, 'merge']);
  assert.ok(result.calls.some((args) => args[3] === 'repos/acme/notes/contents/harness/config.json?ref=refs%2Fheads%2Fmain'));
  const escaping = { ...files, 'acme/notes@main:.aidrian.json': JSON.stringify({ dir: '../out' }) };
  assert.deepEqual(reasonOf(t, r, { files: escaping }), [1, 'team'], 'an override that escapes keeps the default folder');
});

test('the machine has not opted in: off (local), with no gh api user call, and a broken local file is named', (t) => {
  const off = repo(t, { local: 'off' });
  off.record((state) => finished(state));
  const result = run(t, off, ['7', '--json']);
  assert.deepEqual([result.code, json(result).reason, userCalls(result.calls)], [1, 'local', []]);
  const broken = repo(t, { local: { github: { autoMerge: 'yes' } } });
  broken.record((state) => finished(state));
  const human = run(t, broken, ['7']);
  assert.equal(human.code, 1);
  assert.match(human.out[0], /^auto-merge off for #7: this machine has not opted in/);
  assert.deepEqual(human.err, ['.aidrian.local.json: "github.autoMerge" must be "on" or "off"']);
});

test('another author\'s pull request is off (author), before the review; the login compares without case', (t) => {
  const r = repo(t);
  assert.deepEqual(reasonOf(t, r, { view: { author: { login: 'someone-else' } } }), [1, 'author'], 'no record: author still comes first');
  r.record((state) => finished(state));
  assert.deepEqual(reasonOf(t, r, { view: { author: { login: 'someone-else' } } }), [1, 'author']);
  assert.deepEqual(reasonOf(t, r, { view: { author: { login: 'ADRIAN' } }, user: 'adrian' }), [0, null]);
});

test('review: no record, an outcome on an older head, an unfinished outcome, or an owed entry is off', (t) => {
  const r = repo(t);
  assert.deepEqual(reasonOf(t, r), [1, 'review'], 'no record');
  r.record((state) => finished(state, OLD));
  assert.deepEqual(reasonOf(t, r), [1, 'review'], 'an outcome on an older head');
  r.record((state) => finished(state, HEAD, 'dispatch'));
  assert.deepEqual(reasonOf(t, r), [1, 'review'], 'an outcome that has not finished');
  r.record((state) => {
    finished(state);
    state.pending.push({ kind: 'request', head: HEAD, at: '2026-11-03T14:10:00.000Z', by: 'the Human' });
  });
  assert.deepEqual(reasonOf(t, r), [1, 'review'], 'an entry still owed');
  r.record((state) => finished(state, HEAD, 'none_needed'));
  assert.deepEqual(reasonOf(t, r), [0, null], 'none_needed is finished');
});

test('review: a record for another repository with the same number is not this pull request\'s', (t) => {
  const r = repo(t);
  r.record((state) => finished(state), 'upstream/notes');
  assert.deepEqual(reasonOf(t, r), [1, 'review']);
});

test('the first failing reason wins, in the order team, local, author, review', (t) => {
  const r = repo(t, { local: 'off' });
  const other = { author: { login: 'someone-else' } };
  assert.equal(reasonOf(t, r, { view: other, files: { 'acme/notes@main:.aidrian/config.json': configText({ ...TEAM, allow: false }) } })[1], 'team');
  assert.equal(reasonOf(t, r, { view: other })[1], 'local');
});

test('gh api user that fails or names no login exits 3', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  for (const user of [() => { throw new Error('gh: HTTP 401'); }, () => '{}', () => 'not json', '']) {
    const result = run(t, r, ['7', '--json'], { user });
    assert.deepEqual([result.code, result.out], [3, []]);
    assert.match(result.err.join('\n'), /gh user|no login/);
  }
});

test('a pull request gh describes only in part exits 3: no number, head, base, author, or URL, or a short head', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const views = [
    { number: undefined }, { headRefOid: undefined }, { baseRefName: undefined }, { baseRefName: '' }, { author: undefined },
    { author: { login: '' } }, { url: undefined }, { url: 'not a url' }, { headRefOid: 'abcdef1' }, { headRefOid: 'main' },
  ];
  for (const view of views) {
    const result = run(t, r, ['7', '--json'], { view });
    assert.deepEqual([result.code, result.out], [3, []], JSON.stringify(view));
    assert.equal(result.calls.length, 1, `${JSON.stringify(view)}: nothing read after the view`);
  }
});

test('a gh read that fails, a contents read other than a 404, or an unknown argument exits 3', (t) => {
  const r = repo(t);
  assert.equal(run(t, r, ['7', '--watch']).code, 3);
  assert.equal(run(t, r, ['7', '8']).code, 3);
  assert.equal(run(t, r, ['main']).code, 3);
  const call = (gh) => {
    const err = [];
    t.mock.method(console, 'error', (line) => err.push(line));
    const code = runAutoMerge(['7'], r.project, { gh });
    t.mock.restoreAll();
    return [code, err.join('\n')];
  };
  const [viewCode, viewErr] = call(() => { throw new Error('gh: no pull requests found'); });
  assert.equal(viewCode, 3);
  assert.match(viewErr, /no pull requests found/);
  const { gh } = fakeGh();
  const [contentsCode, contentsErr] = call((args) => {
    if (args[0] === 'api' && args[3].includes('/contents/')) {
      throw Object.assign(new Error('Command failed: gh api ...\nfirst stderr line'), { stderr: 'first stderr line\ngh: Bad credentials (HTTP 401)\n\n' });
    }
    return gh(args);
  });
  assert.equal(contentsCode, 3);
  assert.match(contentsErr, /could not read \.aidrian\.json on acme\/notes main with gh \(gh: Bad credentials \(HTTP 401\)\)$/u, 'gh\'s last stderr line');
  const [plainCode, plainErr] = call(() => { throw new Error('spawn gh ENOENT\nmore'); });
  assert.deepEqual([plainCode, plainErr], [3, 'aidrian pr auto-merge: could not read the pull request with gh (spawn gh ENOENT)'], 'no stderr: the message\'s first line');
  const [dirCode] = call((args) => (args[0] === 'api' && args[3].includes('contents/.aidrian/config.json') ? '[]' : gh(args)));
  assert.equal(dirCode, 3, 'a folder where config.json should be is no file');
});

test('a pull request URL or #number is passed to gh as the target', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  assert.deepEqual(run(t, r, [URL7]).calls[0].slice(0, 3), ['pr', 'view', URL7]);
  assert.deepEqual(run(t, r, ['#7']).calls[0].slice(0, 3), ['pr', 'view', '7']);
});

test('aidrian --help lists the auto-merge action', () => {
  assert.match(commands.pr.usage, /\| auto-merge \[PR\] \[--json\]/);
});

test('the default branch must allow it too: a feature base that allows it under a default branch that does not is off (team)', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const view = { baseRefName: 'feat/stack' };
  const files = {
    'acme/notes@main:.aidrian/config.json': configText({ ...TEAM, allow: false, strategy: 'rebase' }),
    'acme/notes@feat/stack:.aidrian/config.json': configText({ ...TEAM, strategy: 'merge' }),
  };
  const result = run(t, r, ['7', '--json'], { view, files });
  assert.equal(result.code, 1);
  assert.deepEqual(json(result), {
    effective: false, reason: 'team', allow: false, local: 'on', strategy: 'rebase', deleteBranch: true, deleteWorktree: false,
    pr: 7, head: HEAD, repo: 'acme/notes', base: 'feat/stack',
  });
  assert.ok(result.calls.some((args) => args[3] === 'repos/acme/notes/contents/.aidrian/config.json?ref=refs%2Fheads%2Ffeat%2Fstack'), 'the base is read at its own ref');
  const human = run(t, r, ['7'], { view, files });
  assert.match(human.out[0], /not allow it \(github\.autoMerge\.allow on acme\/notes main\)$/u, 'names the branch that refuses');
  const baseOff = { ...files, 'acme/notes@main:.aidrian/config.json': configText(TEAM), 'acme/notes@feat/stack:.aidrian/config.json': configText({ ...TEAM, allow: false }) };
  assert.deepEqual(reasonOf(t, r, { view, files: baseOff }), [1, 'team'], 'a base that refuses, under a default branch that allows');
});

test('both branches allow it: on, with the strategy and cleanup of the default branch', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const files = {
    'acme/notes@trunk:.aidrian/config.json': configText({ allow: true, strategy: 'rebase', deleteBranch: false, deleteWorktree: true }),
    'acme/notes@main:.aidrian/config.json': configText({ allow: true, strategy: 'merge', deleteBranch: true, deleteWorktree: false }),
  };
  const result = run(t, r, ['7', '--json'], { files, defaultBranch: 'trunk' });
  assert.equal(result.code, 0);
  const out = json(result);
  assert.deepEqual([out.allow, out.strategy, out.deleteBranch, out.deleteWorktree, out.base], [true, 'rebase', false, true, 'main']);
  assert.equal(result.calls.filter((args) => args[3]?.includes('/contents/')).length, 4, 'two branches: each read once');
});

test('a default branch gh cannot name exits 3', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  for (const defaultBranch of [() => '{}', () => { throw Object.assign(new Error('Command failed'), { stderr: 'gh: Not Found (HTTP 404)\n' }); }]) {
    const result = run(t, r, ['7', '--json'], { defaultBranch });
    assert.deepEqual([result.code, result.out], [3, []]);
    assert.match(result.err.join('\n'), /default branch/u);
  }
});
