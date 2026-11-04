import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commands } from '../plugins/aidrian/lib/pr.mjs';
import { computeVerdict } from '../plugins/aidrian/lib/pr-checks.mjs';
import { runAutoMerge } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { emptyState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const OLD = '1234567890abcdef1234567890abcdef12345678';
const TEAM = { allow: true, strategy: 'squash', deleteBranch: true, deleteWorktree: false };
const URL7 = 'https://github.com/acme/notes/pull/7';
const CHECKS = { requiredChecks: ['e2e'], conditionalChecks: ['docs'], ignoreCancelledChecks: ['preview'] };
const STATE = { dir: 'state' };
const configText = (autoMerge, lists = CHECKS, state = STATE) => JSON.stringify({ version: 1, state, github: { ...lists, autoMerge } });

// A temporary git repository (never a real one, and no GIT_DIR) whose working copy commits `working` as the team's
// github.autoMerge, with origin at `origin`, and a `.aidrian.local.json` that sets the machine's switch to `local`.
// The project's state folder is inside it.
function repo(t, { working = { ...TEAM, allow: true }, lists = CHECKS, local = 'on', origin = 'git@github.com:acme/notes.git' } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-auto-merge-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', origin);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' }, github: { ...lists, autoMerge: working } }));
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
// standing in for the call; `comments` holds the pull request's lists by the last part of their route, `issues`, `reviews`,
// and `pulls`, each a list or a function standing in for the call.
function fakeGh({ files = { 'acme/notes@main:.aidrian/config.json': configText(TEAM) }, view = {}, user = 'Adrian', defaultBranch = 'main', comments = {} } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ number: 7, headRefOid: HEAD, baseRefName: 'main', author: { login: 'adrian' }, url: URL7, files: [{ path: 'src/app.js', changeType: 'MODIFIED' }], changedFiles: 1, reviewDecision: '', latestReviews: [], ...view });
    }
    if (args[0] === 'api' && args[3] === 'user') {
      if (typeof user === 'function') return user();
      return JSON.stringify({ login: user });
    }
    if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/u.test(args[3] ?? '')) {
      if (typeof defaultBranch === 'function') return defaultBranch();
      return JSON.stringify({ default_branch: defaultBranch });
    }
    const list = args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/(?:issues\/7\/comments|pulls\/7\/reviews|pulls\/7\/comments)$/u.exec(args[3] ?? '');
    if (list) {
      assert.deepEqual(args.slice(4), ['--paginate', '--slurp'], 'every page');
      const [, kind, name] = /\/(issues|pulls)\/7\/(comments|reviews)$/u.exec(args[3]);
      const key = name === 'reviews' ? 'reviews' : kind;
      const value = comments[key] ?? [];
      if (typeof value === 'function') return value();
      return JSON.stringify([value]);
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
    effective: true, reason: null, why: null, allow: true, local: 'on', strategy: 'squash', deleteBranch: true, deleteWorktree: false,
    pr: 7, head: HEAD, repo: 'acme/notes', base: 'main',
  });
  assert.deepEqual(result.calls, [
    ['pr', 'view', '7', '--json', 'number,headRefOid,baseRefName,author,url,files,changedFiles,reviewDecision,latestReviews'],
    ['api', '--hostname', 'github.com', 'repos/acme/notes'],
    ['api', '--hostname', 'github.com', 'repos/acme/notes/contents/.aidrian.json?ref=refs%2Fheads%2Fmain'],
    ['api', '--hostname', 'github.com', 'repos/acme/notes/contents/.aidrian/config.json?ref=refs%2Fheads%2Fmain'],
    ['api', '--hostname', 'github.com', 'user'],
    ['api', '--hostname', 'github.com', 'repos/acme/notes/issues/7/comments', '--paginate', '--slurp'],
    ['api', '--hostname', 'github.com', 'repos/acme/notes/pulls/7/reviews', '--paginate', '--slurp'],
    ['api', '--hostname', 'github.com', 'repos/acme/notes/pulls/7/comments', '--paginate', '--slurp'],
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
  assert.equal(api.length, 7);
  for (const args of api) assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'ghe.acme.io']);
});

test('the team keys come from the base on GitHub, never the working copy: a branch allowing it over a base that does not is off (team)', (t) => {
  const r = repo(t, { working: { ...TEAM, allow: true, strategy: 'merge' } });
  r.record((state) => finished(state));
  const result = run(t, r, ['--json'], { files: { 'acme/notes@main:.aidrian/config.json': configText({ ...TEAM, allow: false, strategy: 'rebase' }) } });
  assert.equal(result.code, 1);
  assert.deepEqual(json(result), {
    effective: false, reason: 'team', why: 'the team does not allow it (github.autoMerge.allow on acme/notes main)', allow: false, local: 'on', strategy: 'rebase', deleteBranch: true, deleteWorktree: false,
    pr: 7, head: HEAD, repo: 'acme/notes', base: 'main',
  });
  assert.deepEqual(result.calls[0], ['pr', 'view', '--json', 'number,headRefOid,baseRefName,author,url,files,changedFiles,reviewDecision,latestReviews'], 'no argument: the current branch');
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
  assert.deepEqual(reasonOf(t, r, { view: { files: [{ path: 'docs/guide.md', changeType: 'MODIFIED' }] } }), [1, 'review'], 'a docs-only pull request that needed no review waits for the Human');
});

test('review: a record for another repository with the same number is not this pull request\'s', (t) => {
  const r = repo(t);
  r.record((state) => finished(state), 'upstream/notes');
  assert.deepEqual(reasonOf(t, r), [1, 'review']);
});

test('the first failing reason wins, in the order team, checks, paths, local, author, outsider, review', (t) => {
  const r = repo(t, { local: 'off' });
  const stranger = { user: { login: 'mallory' }, author_association: 'NONE' };
  const everything = {
    view: { author: { login: 'someone-else' }, files: [{ path: 'AGENTS.md', changeType: 'MODIFIED' }], latestReviews: [{ author: { login: 'lead' }, state: 'CHANGES_REQUESTED' }] },
    comments: { issues: [stranger] },
  };
  const named = (files) => ({ ...everything, files: { 'acme/notes@main:.aidrian/config.json': files } });
  assert.equal(reasonOf(t, r, named(configText({ ...TEAM, allow: false })))[1], 'team');
  assert.equal(reasonOf(t, r, named(configText(TEAM, {})))[1], 'checks');
  assert.equal(reasonOf(t, r, everything)[1], 'paths');
  const noPaths = { ...everything, view: { ...everything.view, files: [{ path: 'src/app.js', changeType: 'MODIFIED' }] } };
  assert.equal(reasonOf(t, r, noPaths)[1], 'local');
  const on = repo(t);
  assert.equal(reasonOf(t, on, noPaths)[1], 'author');
  const own = { ...noPaths, view: { ...noPaths.view, author: { login: 'adrian' } } };
  assert.equal(reasonOf(t, on, own)[1], 'outsider');
  assert.equal(reasonOf(t, on, { ...own, comments: {} })[1], 'review');
});

test('a comment, review, or inline comment by anyone outside the repository is off (outsider), except the review bot', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const mallory = { user: { login: 'mallory' }, author_association: 'NONE' };
  for (const key of ['issues', 'reviews', 'pulls']) {
    assert.deepEqual(reasonOf(t, r, { comments: { [key]: [mallory] } }), [1, 'outsider'], key);
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', undefined]) {
      assert.deepEqual(reasonOf(t, r, { comments: { [key]: [{ user: { login: 'mallory' }, author_association: association }] } }), [1, 'outsider'], `${key} ${association}`);
    }
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      assert.deepEqual(reasonOf(t, r, { comments: { [key]: [{ user: { login: 'lead' }, author_association: association }] } }), [0, null], `${key} ${association}`);
    }
  }
  assert.match(run(t, r, ['7'], { comments: { pulls: [mallory] } }).out[0], /^auto-merge off for #7: mallory commented, and is no member of the repository$/u);
  assert.deepEqual(reasonOf(t, r, { comments: { issues: [{ user: null, author_association: 'NONE' }] } }), [1, 'outsider'], 'a deleted account');

  // The bot the default branch names is the one exception, in any case; the working copy cannot name another.
  const named = (reviewer) => ({ 'acme/notes@main:.aidrian/config.json': JSON.stringify({ version: 1, state: STATE, github: { ...CHECKS, autoMerge: TEAM, reviewer } }) });
  const bot = { user: { login: 'Review-Bot[bot]' }, author_association: 'NONE' };
  assert.deepEqual(reasonOf(t, r, { files: named('review-bot[bot]'), comments: { reviews: [bot] } }), [0, null], 'the configured bot');
  assert.deepEqual(reasonOf(t, r, { files: named('other[bot]'), comments: { reviews: [bot] } }), [1, 'outsider'], 'any other bot');
  assert.deepEqual(reasonOf(t, r, { files: named(null), comments: { issues: [{ user: null, author_association: 'NONE' }] } }), [1, 'outsider'], 'no bot and no login match nothing');

  const failing = run(t, r, ['7', '--json'], { comments: { reviews: () => { throw Object.assign(new Error('failed'), { stderr: 'gh: Forbidden (HTTP 403)\n' }); } } });
  assert.deepEqual([failing.code, failing.out], [3, []]);
  assert.match(failing.err.join('\n'), /could not read repos\/acme\/notes\/pulls\/7\/reviews with gh \(gh: Forbidden \(HTTP 403\)\)/u);
});

test('a changed file that instructs an AI session or decides CI, or a file list gh cuts short, is off (paths)', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const changed = (...paths) => ({ view: { files: paths.map((each) => ({ path: each, changeType: 'MODIFIED' })), changedFiles: paths.length } });
  for (const file of [
    'AGENTS.md', 'CLAUDE.md', 'packages/api/AGENTS.md', 'a/b/CLAUDE.md', 'packages/api/agents.md', '.claude/settings.json', '.claude/agents/x.md',
    '.codex/config.toml', '.aidrian/config.json', '.aidrian/knowledge/rules.md', '.aidrian.json', 'plugins/x/skills/y/SKILL.md', 'SKILL.md',
    '.github/workflows/ci.yml', '.github/actions/setup/action.yml', 'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS',
    '.aidrian.local.json', 'wt/.AIDRIAN.LOCAL.JSON', '.claude', '.codex', '.aidrian', '.github/workflows', '.github/actions',
  ]) {
    assert.deepEqual(reasonOf(t, r, changed('src/app.js', file)), [1, 'paths'], file);
  }
  for (const file of ['docs/guide.md', 'README.md', 'src/app.js', 'docs/agents.mdx', '.github/dependabot.yml', 'src/.claude.js', 'x.aidrian/y', 'NOTSKILL.md', '.claude.md', '.codexrc', '.aidrian.local.json.md', '.github/workflows-old/x.yml']) {
    assert.deepEqual(reasonOf(t, r, changed(file)), [0, null], file);
  }
  assert.match(run(t, r, ['7'], changed('docs/guide.md', '.github/workflows/ci.yml')).out[0], /it changes \.github\/workflows\/ci\.yml/u);
  assert.match(JSON.parse(run(t, r, ['7', '--json'], changed('.github/workflows/ci.yml')).out[0]).why, /it changes \.github\/workflows\/ci\.yml/u, 'the JSON says why too');
  assert.equal(JSON.parse(run(t, r, ['7', '--json'], changed('docs/guide.md')).out[0]).why, null, 'and nothing when on');
  for (const changeType of ['ADDED', 'CHANGED', 'COPIED', 'DELETED', 'MODIFIED']) {
    assert.deepEqual(reasonOf(t, r, { view: { files: [{ path: 'docs/guide.md', changeType }] } }), [0, null], changeType);
  }
  for (const changeType of ['RENAMED', '', null, undefined]) {
    assert.deepEqual(reasonOf(t, r, { view: { files: [{ path: 'docs/guide.md', changeType }] } }), [1, 'paths'], String(changeType));
  }
  assert.match(run(t, r, ['7'], { view: { files: [{ path: 'notes.md', changeType: 'RENAMED' }] } }).out[0], /gh lists notes\.md as RENAMED/u);
  const cut = { view: { files: [{ path: 'src/app.js', changeType: 'MODIFIED' }], changedFiles: 101 } };
  assert.deepEqual(reasonOf(t, r, cut), [1, 'paths'], 'a shorter list hides files');
  assert.match(run(t, r, ['7'], cut).out[0], /gh listed 1 of its 101 changed files/u);
});

test('a pull request whose files or reviews gh does not describe exits 3', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  for (const view of [{ files: undefined }, { files: [{}] }, { changedFiles: undefined }, { reviewDecision: undefined }, { latestReviews: undefined }]) {
    assert.deepEqual([run(t, r, ['7', '--json'], { view }).code], [3], JSON.stringify(view));
  }
});

test('a working copy whose state.dir differs from the default branch\'s is off (checks): a branch cannot pick the record', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const elsewhere = { 'acme/notes@main:.aidrian/config.json': configText(TEAM, CHECKS, { dir: null }) };
  assert.deepEqual(reasonOf(t, r, { files: elsewhere }), [1, 'checks']);
  assert.match(run(t, r, ['7'], { files: elsewhere }).out[0], /working copy's state\.dir differs from acme\/notes main/u);
});

test('review: requested changes are off, from the decision or from anyone\'s latest review, whatever the record says', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  assert.deepEqual(reasonOf(t, r, { view: { reviewDecision: 'CHANGES_REQUESTED' } }), [1, 'review'], 'the decision');
  const latestReviews = [{ author: { login: 'lead' }, state: 'APPROVED' }, { author: { login: 'second' }, state: 'CHANGES_REQUESTED' }];
  assert.deepEqual(reasonOf(t, r, { view: { reviewDecision: 'APPROVED', latestReviews } }), [1, 'review'], 'one person\'s latest review');
  assert.match(run(t, r, ['7'], { view: { latestReviews } }).out[0], /second requested changes/u);
  for (const reviewDecision of ['', 'APPROVED', 'REVIEW_REQUIRED']) {
    assert.deepEqual(reasonOf(t, r, { view: { reviewDecision, latestReviews: [{ author: { login: 'lead' }, state: 'APPROVED' }, { author: { login: 'second' }, state: 'DISMISSED' }] } }), [0, null], reviewDecision);
  }
});

test('review: the record must name the exact head: a prefix a branch can grind for is no match', (t) => {
  const r = repo(t);
  r.record((state) => finished(state, HEAD.slice(0, 7)));
  assert.deepEqual(reasonOf(t, r), [1, 'review']);
  r.record((state) => finished(state, HEAD.slice(0, 39)));
  assert.deepEqual(reasonOf(t, r), [1, 'review']);
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
    effective: false, reason: 'team', why: 'the team does not allow it (github.autoMerge.allow on acme/notes main)', allow: false, local: 'on', strategy: 'rebase', deleteBranch: true, deleteWorktree: false,
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

test('no required checks named on the default branch is off (checks): a check that has not registered would read as passed', (t) => {
  const r = repo(t, { lists: {} });
  r.record((state) => finished(state));
  const files = { 'acme/notes@main:.aidrian/config.json': configText(TEAM, {}) };
  const result = run(t, r, ['7', '--json'], { files });
  assert.deepEqual([result.code, json(result).reason, json(result).effective, userCalls(result.calls)], [1, 'checks', false, []]);
  const human = run(t, r, ['7'], { files });
  assert.match(human.out[0], /^auto-merge off for #7: the default branch names no required checks \(github\.requiredChecks on acme\/notes main\)/u);
  // A feature base's list does not count: the default branch's policy judges the merge.
  const onBase = { ...files, 'acme/notes@feat/stack:.aidrian/config.json': configText(TEAM) };
  assert.deepEqual(reasonOf(t, r, { view: { baseRefName: 'feat/stack' }, files: onBase }), [1, 'checks']);
});

test('a working copy that relaxes a check list, committed or uncommitted, is off (checks)', (t) => {
  for (const [key, weaker] of [['requiredChecks', ['unit']], ['conditionalChecks', ['docs', 'e2e']], ['ignoreCancelledChecks', ['preview', 'e2e']]]) {
    const committed = repo(t, { lists: { ...CHECKS, [key]: weaker } });
    committed.record((state) => finished(state));
    assert.deepEqual(reasonOf(t, committed), [1, 'checks'], `committed ${key}`);
    const human = run(t, committed, ['7']);
    assert.match(human.out[0], new RegExp(`working copy's github\\.${key} differ from acme/notes main`, 'u'));

    const uncommitted = repo(t);
    uncommitted.record((state) => finished(state));
    assert.deepEqual(reasonOf(t, uncommitted), [0, null], 'the lists match before the edit');
    writeFileSync(path.join(uncommitted.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' }, github: { ...CHECKS, [key]: weaker, autoMerge: TEAM } }));
    assert.deepEqual(reasonOf(t, uncommitted), [1, 'checks'], `uncommitted ${key}`);
  }
  // A list dropped altogether differs too.
  const dropped = repo(t, { lists: { requiredChecks: ['e2e'] } });
  dropped.record((state) => finished(state));
  assert.deepEqual(reasonOf(t, dropped), [1, 'checks'], 'no conditionalChecks in the working copy');
});

test('matching check lists are on, compared as sets: order and repeats do not matter', (t) => {
  const r = repo(t, { lists: { requiredChecks: ['unit', 'e2e', 'e2e'], conditionalChecks: ['docs'], ignoreCancelledChecks: ['preview'] } });
  r.record((state) => finished(state));
  const files = { 'acme/notes@main:.aidrian/config.json': configText(TEAM, { ...CHECKS, requiredChecks: ['e2e', 'unit'] }) };
  assert.deepEqual(reasonOf(t, r, { files }), [0, null]);
});

test('a working copy config that cannot be read, or has errors, is off (checks), never a crash', (t) => {
  const write = (r, text) => writeFileSync(path.join(r.dir, '.aidrian/config.json'), text);
  for (const [name, text] of [['not JSON', '{'], ['another version', JSON.stringify({ version: 99 })], ['a bad value', JSON.stringify({ version: 1, github: { ...CHECKS, requiredChecks: 'e2e' } })]]) {
    const r = repo(t);
    r.record((state) => finished(state));
    write(r, text);
    assert.deepEqual(reasonOf(t, r), [1, 'checks'], name);
  }
  const gone = repo(t);
  gone.record((state) => finished(state));
  rmSync(path.join(gone.dir, '.aidrian/config.json'));
  assert.deepEqual(reasonOf(t, gone), [1, 'checks'], 'no config file');
  assert.match(run(t, gone, ['7']).out[0], /working copy's config cannot be read/u);
});

test('a required check missing from the rows is pending, so a draft\'s partial set of checks is not ready', () => {
  const rows = [{ name: 'lint', state: 'SUCCESS' }];
  const named = computeVerdict(rows, { requiredChecks: ['e2e'] });
  assert.equal(named.verdict, 'pending');
  assert.deepEqual(named.pending, ['e2e (required, not reported yet)']);
  assert.equal(computeVerdict(rows, { requiredChecks: [] }).verdict, 'ready', 'why auto-merge needs named required checks');
});
