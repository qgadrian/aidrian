import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commands } from '../plugins/aidrian/lib/pr.mjs';
import { computeVerdict } from '../plugins/aidrian/lib/pr-checks.mjs';
import { pathsProblem, reviewProblem, runAutoMerge } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { emptyState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const OLD = '1234567890abcdef1234567890abcdef12345678';
const TEAM = { allow: true, strategy: 'squash', deleteBranch: true, deleteWorktree: false };
const URL7 = 'https://github.com/acme/notes/pull/7';
const CHECKS = { requiredChecks: ['e2e'], conditionalChecks: ['docs'], ignoreCancelledChecks: ['preview'] };
const STATE = { dir: '../state' };
const configText = (autoMerge, lists = CHECKS, state = STATE) => JSON.stringify({ version: 1, state, github: { ...lists, autoMerge } });

// A temporary git repository (never a real one, and no GIT_DIR) whose working copy commits `working` as the team's
// github.autoMerge, with origin at `origin`, and a `.aidrian.local.json` that sets the machine's switch to `local`.
// The project's state folder is beside it.
function repo(t, { working = { ...TEAM, allow: true }, lists = CHECKS, local = 'on', origin = 'git@github.com:acme/notes.git' } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-auto-merge-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', origin);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: STATE, github: { ...lists, autoMerge: working } }));
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

const VIEW_FIELDS = 'number,headRefOid,baseRefName,author,url,files,changedFiles,reviewDecision,latestReviews';

// The forge facade seam, with each call kept as [method, ...arguments, host]. `files` maps `<repo>@<branch>:<path>` to a
// file's text on GitHub; any other contents read is a 404, and a read whose ref is not `refs/heads/<branch>` is no call
// the command makes. `view` overrides fields of the pull request `change` gives; `defaultBranch` is every repository's
// default branch, or a function standing in for `repository`; `user` is the login, or a function standing in for
// `viewer`; `comments` holds the pull request's lists, `issues` (conversationComments), `reviews`, and `pulls` (reviewComments),
// each a list or a function standing in for the call. `restFiles` is the paged file list `changeFiles` gives, or a
// function standing in for it (by default a 404); `pullHead` is the head `pull` gives, or a function standing in for it.
// What gh prints and how each call reads it is the adapter's (test/forge-github.test.mjs).
const notStubbed = () => {
  throw Object.assign(new Error('Command failed: gh api'), { stderr: 'gh: Not Found (HTTP 404)\n' });
};
function fakeForge({ files = { 'acme/notes@main:.aidrian/config.json': configText(TEAM) }, view = {}, user = 'Adrian', defaultBranch = 'main', comments = {}, restFiles = notStubbed, pullHead = HEAD } = {}) {
  const calls = [];
  const list = (method, key) => (repo, n, { host } = {}) => {
    calls.push([method, repo, n, host]);
    const value = comments[key] ?? [];
    return typeof value === 'function' ? value() : value;
  };
  const forge = {
    change: (target, fields) => {
      calls.push(['change', target, fields]);
      return { number: 7, headRefOid: HEAD, baseRefName: 'main', author: { login: 'adrian' }, url: URL7, files: [{ path: 'src/app.js', changeType: 'MODIFIED' }], changedFiles: 1, reviewDecision: '', latestReviews: [], ...view };
    },
    repository: (repo, { host } = {}) => {
      calls.push(['repository', repo, host]);
      return typeof defaultBranch === 'function' ? defaultBranch() : { default_branch: defaultBranch };
    },
    contents: (repo, file, ref, { host } = {}) => {
      calls.push(['contents', repo, file, ref, host]);
      assert.match(ref, /^refs\/heads\/./u, 'a branch, never a tag of the same name');
      const key = `${repo}@${ref.slice('refs/heads/'.length)}:${file}`;
      if (!Object.hasOwn(files, key)) throw Object.assign(new Error(`Command failed: gh api ${repo} ${file}\ngh: Not Found (HTTP 404)`), { stderr: 'gh: Not Found (HTTP 404)\n' });
      return { type: 'file', encoding: 'base64', content: Buffer.from(files[key]).toString('base64') };
    },
    viewer: ({ host } = {}) => {
      calls.push(['viewer', host]);
      return typeof user === 'function' ? user() : user;
    },
    changeFiles: (repo, n, { host } = {}) => {
      calls.push(['changeFiles', repo, n, host]);
      return typeof restFiles === 'function' ? restFiles() : restFiles;
    },
    pull: (repo, n, { host } = {}) => {
      calls.push(['pull', repo, n, host]);
      return typeof pullHead === 'function' ? pullHead() : { head: { sha: pullHead } };
    },
    conversationComments: list('conversationComments', 'issues'),
    reviews: list('reviews', 'reviews'),
    reviewComments: list('reviewComments', 'pulls'),
  };
  return { forge, calls };
}

// Runs the command and returns { code, out, err, calls }.
function run(t, r, argv, ghOptions) {
  const out = [];
  const err = [];
  t.mock.method(console, 'log', (line) => out.push(line));
  t.mock.method(console, 'error', (line) => err.push(line));
  const { forge, calls } = fakeForge(ghOptions);
  const code = runAutoMerge(argv, r.project, { forge });
  t.mock.restoreAll();
  return { code, out, err, calls };
}

const json = (result) => JSON.parse(result.out.join('\n'));
const reasonOf = (t, r, ghOptions, argv = ['7', '--json']) => {
  const result = run(t, r, argv, ghOptions);
  return [result.code, json(result).reason];
};
const userCalls = (calls) => calls.filter((call) => call[0] === 'viewer');
const contentsReads = (calls) => calls.filter((call) => call[0] === 'contents');

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
    ['change', '7', VIEW_FIELDS],
    ['repository', 'acme/notes', 'github.com'],
    ['contents', 'acme/notes', '.aidrian.json', 'refs/heads/main', 'github.com'],
    ['contents', 'acme/notes', '.aidrian/config.json', 'refs/heads/main', 'github.com'],
    ['viewer', 'github.com'],
    ['conversationComments', 'acme/notes', 7, 'github.com'],
    ['reviews', 'acme/notes', 7, 'github.com'],
    ['reviewComments', 'acme/notes', 7, 'github.com'],
  ], 'the base is the default branch: its config is read once');
  const human = run(t, r, ['7']);
  assert.equal(human.code, 0);
  assert.equal(human.out.length, 1);
  assert.match(human.out[0], /^auto-merge on for #7 at abcdef1: squash, delete the branch, keep the worktree$/);
});

test('every forge call after the view names the host of the pull request\'s URL', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const result = run(t, r, ['7', '--json'], {
    view: { url: 'https://ghe.acme.io/acme/notes/pull/7' },
    files: { 'acme/notes@main:.aidrian/config.json': configText(TEAM) },
  });
  assert.equal(result.code, 0);
  const api = result.calls.filter((call) => call[0] !== 'change');
  assert.equal(api.length, 7);
  for (const call of api) assert.equal(call.at(-1), 'ghe.acme.io', call[0]);
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
  assert.deepEqual(result.calls[0], ['change', null, VIEW_FIELDS], 'no argument: the current branch');
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
  assert.ok(result.calls.filter((call) => !['change', 'viewer'].includes(call[0])).every((call) => call[1] === 'acme/notes'));
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
  assert.ok(contentsReads(result.calls).some((call) => call[2] === 'harness/config.json' && call[3] === 'refs/heads/main'));
  const escaping = { ...files, 'acme/notes@main:.aidrian.json': JSON.stringify({ dir: '../out' }) };
  assert.deepEqual(reasonOf(t, r, { files: escaping }), [1, 'team'], 'an override that escapes keeps the default folder');
});

test('a team default of "on": a machine with no setting follows it unless its local file is tracked or opts out', (t) => {
  const working = { ...TEAM, default: 'on' };
  const gh = { files: { 'acme/notes@main:.aidrian/config.json': configText(working) } };
  const none = repo(t, { working, local: null });
  none.record((state) => finished(state));
  assert.deepEqual(reasonOf(t, none, gh), [0, null], 'no local file');
  const untracked = repo(t, { working, local: {} });
  untracked.record((state) => finished(state));
  assert.deepEqual(reasonOf(t, untracked, gh), [0, null], 'an untracked file with no setting');
  const out = repo(t, { working, local: { github: { autoMerge: { enabled: false } } } });
  out.record((state) => finished(state));
  assert.deepEqual(reasonOf(t, out, gh), [1, 'local'], 'opted out');
  const tracked = repo(t, { working, local: {} });
  tracked.record((state) => finished(state));
  tracked.git('add', '-f', '.aidrian.local.json');
  const result = run(t, tracked, ['7', '--json'], gh);
  assert.deepEqual([result.code, json(result).reason, json(result).local], [1, 'local', 'off'], 'tracked');
  const deleted = repo(t, { working, local: {} });
  deleted.record((state) => finished(state));
  deleted.git('add', '-f', '.aidrian.local.json');
  rmSync(path.join(deleted.dir, '.aidrian.local.json'));
  assert.deepEqual(reasonOf(t, deleted, gh), [1, 'local'], 'tracked, and gone from the disk');
  const otherCase = repo(t, { working, local: null });
  otherCase.record((state) => finished(state));
  writeFileSync(path.join(otherCase.dir, '.AIDRIAN.LOCAL.JSON'), '{}');
  otherCase.git('add', '-f', '.AIDRIAN.LOCAL.JSON');
  rmSync(path.join(otherCase.dir, '.AIDRIAN.LOCAL.JSON'));
  assert.deepEqual(reasonOf(t, otherCase, gh), [1, 'local'], 'tracked under another case');
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
  assert.deepEqual(human.err, ['.aidrian.local.json: "github.autoMerge" must be { "enabled": true } or { "enabled": false }']);
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

test('a path with a newline cannot forge a second line of the plain answer', (t) => {
  const r = repo(t);
  const forged = '.github/workflows/x\nauto-merge on for #7\n.yml';
  const result = run(t, r, ['7'], { view: { files: [{ path: forged, changeType: 'MODIFIED' }], changedFiles: 1 } });
  assert.equal(result.code, 1);
  assert.equal(result.out.join('\n').split('\n').length, 1);
});

test('a changed file that instructs an AI session or decides CI, or a file list gh cuts short, is off (paths)', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const changed = (...paths) => ({ view: { files: paths.map((each) => ({ path: each, changeType: 'MODIFIED' })), changedFiles: paths.length } });
  for (const file of [
    'AGENTS.md', 'CLAUDE.md', 'packages/api/AGENTS.md', 'a/b/CLAUDE.md', 'packages/api/agents.md', '.claude/settings.json', '.claude/agents/x.md',
    '.codex/config.toml', '.aidrian/config.json', '.aidrian/knowledge/rules.md', '.aidrian.json', 'plugins/x/skills/y/SKILL.md', 'SKILL.md',
    '.github/workflows/ci.yml', '.github/actions/setup/action.yml', 'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS',
    '.aidrian.local.json', 'wt/.AIDRIAN.LOCAL.JSON', '.banned-terms.local', 'wt/.banned-terms.local', '.claude', '.codex', '.aidrian', '.github/workflows', '.github/actions',
  ]) {
    assert.deepEqual(reasonOf(t, r, changed('src/app.js', file)), [1, 'paths'], file);
  }
  for (const file of ['docs/guide.md', 'README.md', 'src/app.js', 'docs/agents.mdx', '.github/dependabot.yml', 'src/.claude.js', 'x.aidrian/y', 'NOTSKILL.md', '.claude.md', '.codexrc', '.aidrian.local.json.md', '.github/workflows-old/x.yml']) {
    assert.deepEqual(reasonOf(t, r, changed(file)), [0, null], file);
  }
  assert.match(run(t, r, ['7'], changed('docs/guide.md', '.github/workflows/ci.yml')).out[0], /it changes "\.github\/workflows\/ci\.yml"/u);
  assert.match(JSON.parse(run(t, r, ['7', '--json'], changed('.github/workflows/ci.yml')).out[0]).why, /it changes "\.github\/workflows\/ci\.yml"/u, 'the JSON says why too');
  assert.equal(JSON.parse(run(t, r, ['7', '--json'], changed('docs/guide.md')).out[0]).why, null, 'and nothing when on');
  for (const changeType of ['ADDED', 'CHANGED', 'COPIED', 'DELETED', 'MODIFIED']) {
    assert.deepEqual(reasonOf(t, r, { view: { files: [{ path: 'docs/guide.md', changeType }] } }), [0, null], changeType);
  }
  for (const changeType of ['RENAMED', '', null, undefined]) {
    assert.deepEqual(reasonOf(t, r, { view: { files: [{ path: 'docs/guide.md', changeType }] } }), [1, 'paths'], String(changeType));
  }
  assert.match(run(t, r, ['7'], { view: { files: [{ path: 'notes.md', changeType: 'RENAMED' }] } }).out[0], /gh lists "notes\.md" as RENAMED/u);
  const cut = { view: { files: [{ path: 'src/app.js', changeType: 'MODIFIED' }], changedFiles: 101 } };
  assert.deepEqual(reasonOf(t, r, cut), [1, 'paths'], 'a shorter list hides files, and no full list could be read');
  assert.match(run(t, r, ['7'], cut).out[0], /could not read the 101 changed files of #7 with gh \(gh: Not Found \(HTTP 404\)\)/u);
  const over = { view: { files: [{ path: 'src/app.js', changeType: 'MODIFIED' }, { path: 'src/b.js', changeType: 'MODIFIED' }], changedFiles: 1 } };
  assert.match(run(t, r, ['7'], over).out[0], /gh listed 2 of its 1 changed files/u, 'a longer list than the count is off too');
});

// github.autoMerge.includeGuardedPaths: the plain line of today's guarded-path refusal, and a view whose base is a
// feature branch, so the default branch and the base are two configs.
const GUARDED_LINE = /it changes "\.github\/workflows\/ci\.yml", which instructs AI sessions, or decides CI's verdict or auto-merge/u;
const onStack = (files, ...changes) => ({
  files,
  view: { baseRefName: 'feat/stack', files: changes.map((each) => (typeof each === 'string' ? { path: each, changeType: 'MODIFIED' } : each)), changedFiles: changes.length },
});
const branches = (main, base) => {
  const files = {};
  if (main !== undefined) files['acme/notes@main:.aidrian/config.json'] = configText(main);
  if (base !== undefined) files['acme/notes@feat/stack:.aidrian/config.json'] = configText(base);
  return files;
};
const LIFTED = { ...TEAM, includeGuardedPaths: true };

test('includeGuardedPaths true on the default branch and the base lets a guarded path through, but never a policy file, and every other refusal stays', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const both = branches(LIFTED, LIFTED);
  for (const file of ['.github/workflows/ci.yml', 'AGENTS.md', 'plugins/aidrian/lib/pr-auto-merge.mjs']) {
    const result = run(t, r, ['7', '--json'], onStack(both, 'src/app.js', file));
    assert.deepEqual([result.code, json(result).reason, json(result).why], [0, null, null], file);
  }
  const one = { 'acme/notes@main:.aidrian/config.json': configText(LIFTED) };
  assert.deepEqual(reasonOf(t, r, { files: one, view: { files: [{ path: '.github/workflows/ci.yml', changeType: 'MODIFIED' }] } }), [0, null], 'the base is the default branch: its one config');

  // A policy file of aidrian stays off, at any depth and in any case, beside guarded files the key lets through.
  const policyLine = (file) => `auto-merge off for #7: it changes ${JSON.stringify(file)}, a policy file of aidrian, which includeGuardedPaths never lets through`;
  for (const file of ['.aidrian/config.json', '.aidrian.json', 'apps/web/.aidrian/config.json', '.aidrian.local.json', 'wt/.AIDRIAN.LOCAL.JSON', 'apps/web/.aidrian.json', '.aidrian']) {
    const result = run(t, r, ['7'], onStack(both, 'AGENTS.md', '.github/workflows/ci.yml', file));
    assert.deepEqual([result.code, result.out[0]], [1, policyLine(file)], file);
    assert.deepEqual(reasonOf(t, r, onStack(both, file)), [1, 'paths'], file);
  }
  for (const file of ['.aidrian/knowledge/rules.md', 'docs/aidrian.json', '.aidrian/config.json.md']) {
    assert.deepEqual(reasonOf(t, r, onStack(both, file)), [0, null], `${file} is no policy file`);
  }
  assert.match(pathsProblem({ files: [{ path: 'apps/web/.aidrian/config.json', changeType: 'MODIFIED' }], changedFiles: 1 }, 'apps/web/', { includeGuardedPaths: true }) ?? '', /a policy file of aidrian/u);

  // Every other refusal of the paths check stays.
  const renamed = run(t, r, ['7'], onStack(both, { path: 'notes.md', changeType: 'RENAMED' }));
  assert.deepEqual([renamed.code, renamed.out[0]], [1, 'auto-merge off for #7: gh lists "notes.md" as RENAMED, which may hide the path it replaced']);
  assert.deepEqual(reasonOf(t, r, onStack(both, { path: '.github/workflows/ci.yml', changeType: 'RENAMED' })), [1, 'paths'], 'a guarded rename');
  const typeless = run(t, r, ['7'], onStack(both, { path: 'notes.md', changeType: '' }));
  assert.deepEqual([typeless.code, typeless.out[0]], [1, 'auto-merge off for #7: gh lists "notes.md" as no change type, which may hide the path it replaced']);
  const cut = { files: both, view: { baseRefName: 'feat/stack', files: [{ path: 'src/app.js', changeType: 'MODIFIED' }], changedFiles: 101 } };
  assert.deepEqual(reasonOf(t, r, cut), [1, 'paths'], 'a view of 1 of 101 files whose paged list is a 404');
  assert.match(run(t, r, ['7'], cut).out[0], /could not read the 101 changed files of #7 with gh \(gh: Not Found \(HTTP 404\)\)/u);
  assert.match(pathsProblem({ files: [{ path: 'notes.md', changeType: 'RENAMED' }], changedFiles: 1 }, '', { includeGuardedPaths: true }) ?? '', /RENAMED/u);
  assert.match(pathsProblem({ files: [{ path: 'src/a.js', changeType: 'MODIFIED' }], changedFiles: 2 }, '', { includeGuardedPaths: true }) ?? '', /gh listed 1 of its 2 changed files/u);
  assert.match(pathsProblem({ files: [], changedFiles: 0 }, null, { includeGuardedPaths: true }) ?? '', /git could not give/u);
  assert.equal(pathsProblem({ files: [{ path: 'AGENTS.md', changeType: 'MODIFIED' }], changedFiles: 1 }, '', { includeGuardedPaths: true }), null);
  assert.match(pathsProblem({ files: [{ path: 'AGENTS.md', changeType: 'MODIFIED' }], changedFiles: 1 }) ?? '', /instructs AI sessions/u, 'off by default');
});

test('includeGuardedPaths false, missing, or true on only one branch keeps a guarded path off (paths), with today\'s message', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const off = { ...TEAM, includeGuardedPaths: false };
  for (const [name, files] of [
    ['false on both', branches(off, off)],
    ['missing on both', branches(TEAM, TEAM)],
    ['true on the default branch only', branches(LIFTED, off)],
    ['missing on the base only', branches(LIFTED, TEAM)],
    ['true on the base only', branches(off, LIFTED)],
    ['missing on the default branch, true on the base', branches(TEAM, LIFTED)],
  ]) {
    assert.deepEqual(reasonOf(t, r, onStack(files, 'src/app.js', '.github/workflows/ci.yml')), [1, 'paths'], name);
    const human = run(t, r, ['7'], onStack(files, 'src/app.js', '.github/workflows/ci.yml'));
    assert.match(human.out[0], GUARDED_LINE, name);
  }
  const single = { 'acme/notes@main:.aidrian/config.json': configText(off) };
  assert.match(run(t, r, ['7'], { files: single, view: { files: [{ path: '.github/workflows/ci.yml', changeType: 'MODIFIED' }] } }).out[0], GUARDED_LINE, 'false on a default branch that is the base');
});

test('includeGuardedPaths is read from GitHub, never the working copy', (t) => {
  const raised = repo(t, { working: LIFTED });
  raised.record((state) => finished(state));
  const unset = { 'acme/notes@main:.aidrian/config.json': configText(TEAM) };
  const ci = (files) => ({ files, view: { files: [{ path: '.github/workflows/ci.yml', changeType: 'MODIFIED' }] } });
  assert.deepEqual(reasonOf(t, raised, ci(unset)), [1, 'paths'], 'a committed working copy cannot raise it');
  assert.match(run(t, raised, ['7'], ci(unset)).out[0], GUARDED_LINE);
  const uncommitted = repo(t);
  uncommitted.record((state) => finished(state));
  writeFileSync(path.join(uncommitted.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: STATE, github: { ...CHECKS, autoMerge: LIFTED } }));
  assert.deepEqual(reasonOf(t, uncommitted, ci(unset)), [1, 'paths'], 'nor an uncommitted one');

  const lowered = repo(t, { working: { ...TEAM, includeGuardedPaths: false } });
  lowered.record((state) => finished(state));
  const both = branches(LIFTED, LIFTED);
  assert.deepEqual(reasonOf(t, lowered, onStack(both, '.github/workflows/ci.yml')), [0, null], 'a working copy that sets it false does not lower it');
});

// The forge's files for a branch whose pointer file names `dir`, with that folder's config.json.
const pointing = (branch, dir, autoMerge, root = '') => ({
  [`acme/notes@${branch}:${root}.aidrian.json`]: JSON.stringify({ dir }),
  [`acme/notes@${branch}:${root}${dir}/config.json`]: configText(autoMerge),
});
const readLine = (file) => `auto-merge off for #7: it changes ${JSON.stringify(file)}, a file the gate reads its policy from`;

test('a folder the pointer file names holds policy too: a change to the config.json the gate read is off (paths), with the key on or off', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const changing = (files, ...changes) => ({ files, view: { files: changes.map((each) => (typeof each === 'string' ? { path: each, changeType: 'MODIFIED' } : each)), changedFiles: changes.length } });
  for (const [name, autoMerge] of [['key off', TEAM], ['key on', LIFTED]]) {
    const files = pointing('main', 'tools/policy', autoMerge);
    assert.deepEqual(reasonOf(t, r, changing(files, 'src/app.js')), [0, null], `${name}: the folder's config is the policy`);
    const edit = run(t, r, ['7'], changing(files, 'src/app.js', 'tools/policy/config.json'));
    assert.deepEqual([edit.code, edit.out[0]], [1, readLine('tools/policy/config.json')], `${name}: an edit`);
    const swap = run(t, r, ['7'], changing(files, { path: 'tools/policy', changeType: 'ADDED' }, { path: 'tools/policy/config.json', changeType: 'DELETED' }));
    assert.deepEqual([swap.code, swap.out[0]], [1, readLine('tools/policy/config.json')], `${name}: the folder replaced by a file`);
    assert.deepEqual(reasonOf(t, r, changing(files, 'Tools/Policy/CONFIG.json')), [1, 'paths'], `${name}: in any case`);
    assert.deepEqual(reasonOf(t, r, changing(files, 'tools/policy/notes.md')), [0, null], `${name}: a file beside it is no policy`);
  }
  const lifted = run(t, r, ['7'], changing(pointing('main', 'tools/policy', LIFTED), '.aidrian.json'));
  assert.match(lifted.out[0], /a policy file of aidrian/u, 'the pointer file, with the key on');
  const off = run(t, r, ['7'], changing(pointing('main', 'tools/policy', TEAM), '.aidrian.json'));
  assert.match(off.out[0], /which instructs AI sessions, or decides CI's verdict or auto-merge/u, 'the pointer file keeps today\'s message with the key off');

  // A feature base names its own folder, and both branches' reads count.
  const stacked = { ...pointing('main', 'tools/policy', TEAM), ...pointing('feat/stack', 'ci/policy', TEAM) };
  for (const file of ['tools/policy/config.json', 'ci/policy/config.json']) {
    const result = run(t, r, ['7'], onStack(stacked, file));
    assert.deepEqual([result.code, result.out[0]], [1, readLine(file)], file);
  }
  assert.equal(pathsProblem({ files: [{ path: 'Tools/Policy/config.json', changeType: 'MODIFIED' }], changedFiles: 1 }, '', { policyFiles: ['tools/policy/config.json'] }), 'it changes "Tools/Policy/config.json", a file the gate reads its policy from');
});

// The view of a pull request of 110 files, as gh gives it: the first 100, and the count.
const NAMES = Array.from({ length: 110 }, (_, i) => `src/file-${String(i).padStart(3, '0')}.js`);
const VIEW_110 = { files: NAMES.slice(0, 100).map((path) => ({ path, changeType: 'MODIFIED' })), changedFiles: 110 };
const restEntries = (paths = NAMES, status = 'modified') => paths.map((filename) => ({ filename, status, additions: 1, patch: '@@' }));

test('past gh pr view`s 100 files, the paged list is read whole at the head the view gave, and every file is judged', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const whole = run(t, r, ['7', '--json'], { view: VIEW_110, restFiles: restEntries() });
  assert.deepEqual([whole.code, json(whole).reason], [0, null], 'a 110-file pull request whose files all pass is on');
  const reads = whole.calls.map((call) => call[0]);
  assert.deepEqual(whole.calls.filter((call) => call[0] === 'changeFiles' || call[0] === 'pull'), [['changeFiles', 'acme/notes', 7, 'github.com'], ['pull', 'acme/notes', 7, 'github.com']]);
  assert.ok(reads.indexOf('changeFiles') < reads.indexOf('pull') && reads.indexOf('pull') < reads.indexOf('viewer'), 'the list, then the head again, then the login');
  const ghe = run(t, r, ['7', '--json'], { view: { ...VIEW_110, url: 'https://ghe.acme.io/acme/notes/pull/7' }, restFiles: restEntries() });
  assert.equal(ghe.code, 0);
  for (const call of ghe.calls.filter((each) => each[0] !== 'change')) assert.equal(call.at(-1), 'ghe.acme.io', call[0]);

  for (const status of ['added', 'removed', 'modified', 'copied', 'changed', 'unchanged']) {
    assert.deepEqual(reasonOf(t, r, { view: VIEW_110, restFiles: restEntries(NAMES, status) }), [0, null], status);
  }
  const renamed = run(t, r, ['7'], { view: VIEW_110, restFiles: [...restEntries(NAMES.slice(0, 109)), { filename: NAMES[109], status: 'renamed', previous_filename: 'AGENTS.md' }] });
  assert.deepEqual([renamed.code, renamed.out[0]], [1, `auto-merge off for #7: gh lists "${NAMES[109]}" as RENAMED, which may hide the path it replaced`]);
  const guarded = run(t, r, ['7'], { view: VIEW_110, restFiles: restEntries([...NAMES.slice(0, 109), '.github/workflows/ci.yml']) });
  assert.deepEqual([guarded.code, guarded.out[0]], [1, 'auto-merge off for #7: it changes ".github/workflows/ci.yml", which instructs AI sessions, or decides CI\'s verdict or auto-merge'], 'a guarded file past the first 100');
  assert.equal(run(t, r, ['7'], { view: { changedFiles: 1 }, restFiles: () => assert.fail('no list read') }).code, 0, 'a whole view reads no list');
});

test('a paged file list that is short, fails, holds a malformed entry, or was read after the head moved is off (paths)', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  const off = (options) => {
    const result = run(t, r, ['7', '--json'], { view: VIEW_110, ...options });
    assert.deepEqual([result.code, json(result).reason, json(result).effective], [1, 'paths', false]);
    assert.equal(userCalls(result.calls).length, 0, 'off before the login is read');
    return json(result).why;
  };
  assert.equal(off({ restFiles: restEntries(NAMES.slice(0, 105)) }), 'gh listed 105 of its 110 changed files, and GitHub lists at most 3000');
  const failed = () => {
    throw Object.assign(new Error('Command failed: gh api'), { stderr: 'some detail\ngh: Bad Gateway (HTTP 502)\n' });
  };
  assert.equal(off({ restFiles: failed }), 'could not read the 110 changed files of #7 with gh (gh: Bad Gateway (HTTP 502))');
  assert.equal(off({ restFiles: null }), 'gh returned no list of the changed files of #7');
  assert.equal(off({ restFiles: { filename: 'x' } }), 'gh returned no list of the changed files of #7');
  for (const [entry, status] of [[null, 'null'], [{}, 'null'], [{ filename: '', status: 'modified' }, '"modified"'], [{ filename: 'x.js' }, 'null'], [{ filename: 5, status: 'added' }, '"added"'],
    [{ filename: 'x.js', status: 'gone' }, '"gone"'], [{ filename: 'x.js', status: 'constructor' }, '"constructor"'], [{ filename: 'x.js', status: 'MODIFIED' }, '"MODIFIED"']]) {
    assert.equal(off({ restFiles: [...restEntries(NAMES.slice(0, 109)), entry] }), `gh listed changed file 110 of #7 with no path or no known status (${status})`, JSON.stringify(entry));
  }
  assert.equal(off({ restFiles: restEntries([...NAMES.slice(0, 109), NAMES[3]]) }), 'gh listed a changed file of #7 twice');
  assert.equal(off({ restFiles: restEntries([...NAMES.slice(1), 'src/extra.js']) }), 'the paged file list leaves out "src/file-000.js", which the view lists');
  assert.equal(off({ restFiles: restEntries(), pullHead: OLD }), 'the head moved from abcdef1 to 1234567 while gh listed its files');
  assert.equal(off({ restFiles: restEntries(), pullHead: () => ({}) }), 'the head moved from abcdef1 to none while gh listed its files');
  const headFailed = () => {
    throw Object.assign(new Error('Command failed: gh api'), { stderr: 'gh: Not Found (HTTP 404)\n' });
  };
  assert.equal(off({ restFiles: restEntries(), pullHead: headFailed }), 'could not read the head of #7 again with gh (gh: Not Found (HTTP 404))');
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
  assert.ok(run(t, r, ['7'], { files: elsewhere }).out[0].includes("the working copy's state.dir differs from acme/notes main, and the review record is read from it"));
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
  // A login gh cannot give: a failure, an answer with no login, an answer that is no JSON, and an empty login.
  for (const user of [() => { throw new Error('gh: HTTP 401'); }, () => undefined, () => { throw new SyntaxError('Unexpected token \'o\', "not json" is not valid JSON'); }, '']) {
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
  // The fake forge with `methods` in place of its own.
  const call = (methods) => {
    const err = [];
    t.mock.method(console, 'error', (line) => err.push(line));
    const code = runAutoMerge(['7'], r.project, { forge: { ...fakeForge().forge, ...methods } });
    t.mock.restoreAll();
    return [code, err.join('\n')];
  };
  const [viewCode, viewErr] = call({ change: () => { throw new Error('gh: no pull requests found'); } });
  assert.equal(viewCode, 3);
  assert.match(viewErr, /no pull requests found/);
  const { forge } = fakeForge();
  const [contentsCode, contentsErr] = call({
    contents: () => { throw Object.assign(new Error('Command failed: gh api ...\nfirst stderr line'), { stderr: 'first stderr line\ngh: Bad credentials (HTTP 401)\n\n' }); },
  });
  assert.equal(contentsCode, 3);
  assert.match(contentsErr, /could not read \.aidrian\.json on acme\/notes main with gh \(gh: Bad credentials \(HTTP 401\)\)$/u, 'gh\'s last stderr line');
  const [plainCode, plainErr] = call({ change: () => { throw new Error('spawn gh ENOENT\nmore'); } });
  assert.deepEqual([plainCode, plainErr], [3, 'aidrian pr auto-merge: could not read the pull request with gh (spawn gh ENOENT)'], 'no stderr: the message\'s first line');
  const [dirCode] = call({ contents: (repo, file, ...rest) => (file === '.aidrian/config.json' ? [] : forge.contents(repo, file, ...rest)) });
  assert.equal(dirCode, 3, 'a folder where config.json should be is no file');
});

test('a pull request URL or #number is passed to the forge as the target', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  assert.deepEqual(run(t, r, [URL7]).calls[0], ['change', URL7, VIEW_FIELDS]);
  assert.deepEqual(run(t, r, ['#7']).calls[0], ['change', '7', VIEW_FIELDS]);
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
  assert.ok(contentsReads(result.calls).some((call) => call[2] === '.aidrian/config.json' && call[3] === 'refs/heads/feat/stack'), 'the base is read at its own ref');
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
  assert.equal(contentsReads(result.calls).length, 4, 'two branches: each read once');
});

test('a default branch gh cannot name exits 3', (t) => {
  const r = repo(t);
  r.record((state) => finished(state));
  for (const defaultBranch of [() => ({}), () => { throw Object.assign(new Error('Command failed'), { stderr: 'gh: Not Found (HTTP 404)\n' }); }]) {
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
    writeFileSync(path.join(uncommitted.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: STATE, github: { ...CHECKS, [key]: weaker, autoMerge: TEAM } }));
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

test('a project below the root reads its own auto-merge setting, and a file outside its folder or guarded inside it keeps auto-merge off', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-auto-merge-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  const web = path.join(dir, 'apps/web');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:acme/notes.git');
  mkdirSync(path.join(web, '.aidrian'), { recursive: true });
  writeFileSync(path.join(web, '.aidrian/config.json'), JSON.stringify({ version: 1, state: STATE, github: { ...CHECKS, autoMerge: { ...TEAM, allow: true } } }));
  git('add', 'apps/web/.aidrian/config.json');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'config');
  writeFileSync(path.join(web, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: 'on' } }));
  const project = projectAt(web);
  const state = emptyState(7, 'acme/notes');
  finished(state);
  writeLocalState(project, state);
  const r = { project };
  const own = { 'acme/notes@main:apps/web/.aidrian/config.json': configText(TEAM) };
  const changing = (file) => ({ files: own, view: { files: [{ path: file, changeType: 'MODIFIED' }] } });
  assert.deepEqual(reasonOf(t, r, changing('apps/web/src/a.js')), [0, null], 'its own setting, read below the root');
  assert.deepEqual(reasonOf(t, r, { ...changing('apps/web/src/a.js'), files: { 'acme/notes@main:.aidrian/config.json': configText(TEAM) } }), [1, 'team'], 'the root\'s setting is not this project\'s');
  for (const file of ['apps/api/b.js', 'README.md', 'apps/web/.aidrian/config.json', 'apps/web/.claude/settings.json', 'apps/web/.github/workflows/ci.yml', '.github/workflows/ci.yml']) {
    assert.deepEqual(reasonOf(t, r, changing(file)), [1, 'paths'], file);
  }
  const lifted = { 'acme/notes@main:apps/web/.aidrian/config.json': configText(LIFTED) };
  const outside = run(t, r, ['7'], { files: lifted, view: { files: [{ path: 'apps/api/b.js', changeType: 'MODIFIED' }] } });
  assert.deepEqual([outside.code, outside.out[0]], [1, 'auto-merge off for #7: it changes "apps/api/b.js", outside this project\'s folder, which its review does not cover'], 'includeGuardedPaths never lifts the folder');
  assert.deepEqual(reasonOf(t, r, { files: lifted, view: { files: [{ path: 'apps/web/.github/workflows/ci.yml', changeType: 'MODIFIED' }] } }), [0, null], 'its own guarded file, with the key on');
  assert.deepEqual(reasonOf(t, r, { files: lifted, view: { files: [{ path: 'apps/web/.aidrian/config.json', changeType: 'MODIFIED' }] } }), [1, 'paths'], 'never its own policy file');
  const named = pointing('main', 'tools/policy', TEAM, 'apps/web/');
  const below = (...changes) => ({ files: named, view: { files: changes, changedFiles: changes.length } });
  assert.deepEqual(reasonOf(t, r, below({ path: 'apps/web/src/a.js', changeType: 'MODIFIED' })), [0, null], 'the folder its pointer file names holds its policy');
  const edited = run(t, r, ['7'], below({ path: 'apps/web/tools/policy/config.json', changeType: 'MODIFIED' }));
  assert.deepEqual([edited.code, edited.out[0]], [1, readLine('apps/web/tools/policy/config.json')], 'an edit of that config.json');
  const swapped = run(t, r, ['7'], below({ path: 'apps/web/tools/policy', changeType: 'ADDED' }, { path: 'apps/web/tools/policy/config.json', changeType: 'DELETED' }));
  assert.deepEqual([swapped.code, swapped.out[0]], [1, readLine('apps/web/tools/policy/config.json')], 'its folder replaced by a file');
  const rootAllows = { 'acme/notes@main:.aidrian/config.json': configText(TEAM) };
  const lost = { project: { ...project, root: path.join(dir, 'gone') } };
  assert.equal(reasonOf(t, lost, { files: rootAllows, view: changing('apps/api/a.js').view })[0], 1, 'a folder git cannot read is never taken for the root');
  assert.match(pathsProblem({ files: [], changedFiles: 0 }, null), /git could not give/u);
});

test('the gate never approves a change to what decides auto-merge', () => {
  const lib = 'plugins/aidrian/lib';
  const off = (file) => pathsProblem({ files: [{ path: file, changeType: 'MODIFIED' }], changedFiles: 1 });
  for (const file of ['plugins/aidrian/bin/aidrian', `${lib}/cli.mjs`, `${lib}/pr.mjs`, `${lib}/fs.mjs`, `${lib}/pr-auto-merge.mjs`, `${lib}/pr-checks.mjs`, `${lib}/project.mjs`, `${lib}/config.mjs`, `${lib}/git.mjs`, `${lib}/forges/github-cli.mjs`, `${lib}/forges/github.mjs`, `${lib}/forges/index.mjs`, `${lib}/forges/identity.mjs`, `${lib}/review-gate.mjs`, `${lib}/shell-lex.mjs`, `${lib}/rules/github/merge-review.mjs`, `${lib}/rules/main-checkout.mjs`, `${lib}/review/state.mjs`, `${lib}/pr-await-review.mjs`, `${lib}/finding-disposition.json`, `${lib}/hosts/codex.mjs`, `${lib}/trackers/linear.mjs`, 'plugins/aidrian/plugin.json', 'plugins/aidrian/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', `${lib}/usage.mjs`, `${lib}/hook-io.mjs`, 'plugins/aidrian/scripts/session-row.mjs', 'plugins/aidrian/agents/security-engineer.md', 'plugins/aidrian/agents-src/review/security-engineer.md', 'plugins/aidrian/scripts/hook-bash.mjs', 'plugins/aidrian/scripts/hook-mcp-github.mjs', 'plugins/aidrian/hooks/hooks.json']) {
    assert.match(off(file) ?? '', /instructs AI sessions, or decides CI's verdict or auto-merge/u, file);
    assert.ok(existsSync(path.join(import.meta.dirname, '..', file)), `${file} is a real file, so the list has not gone stale`);
  }
  for (const file of [`${lib}/report-health.mjs`, `${lib}/quorum.mjs`, 'docs/config.md', 'test/pr-auto-merge.test.mjs', 'src/lib/review/a.js']) assert.equal(off(file), null, file);
});

test('reviewProblem: a finding above low that an accepted residual waived waits for the Human, on any head and for any entry it cannot weigh', () => {
  const received = (passes) => ({ passes, pending: [], outcome: { status: 'received', head: HEAD } });
  const residual = 'The retry loop has no cap: every caller times out first';
  const anchor = { title: 'The retry loop has no cap', file: 'a.js', severity: 'medium', settled_severity: 'medium', already_ruled: 'The retry loop has no cap', from: 'residual', residual };
  for (const [label, entry, key] of [
    ['a ruled repeat', anchor, 'ruled'],
    ['a carried anchor', anchor, 'carried'],
    ['a low repeat under a medium anchor', { ...anchor, severity: 'low' }, 'ruled'],
    ['an unknown severity', { ...anchor, severity: 'dire', settled_severity: undefined }, 'carried'],
    ['no severity', { title: 't', residual }, 'carried'],
    ['an unknown cap', { ...anchor, severity: 'low', settled_severity: 'dire' }, 'ruled'],
  ]) {
    const problem = reviewProblem(received({ 'slice:codex-local:0123456789': { head: 'an-older-head', [key]: [entry] } }), HEAD);
    assert.match(problem ?? '', /accepted residual "The retry loop has no cap: every caller times out first" waived a finding above low severity, so the merge waits for the Human/u, label);
  }
  for (const [label, passes] of [
    ['no waiver', { p: { head: HEAD, list: [] } }],
    ['a low anchor', { p: { head: HEAD, carried: [{ ...anchor, severity: 'low', settled_severity: 'low' }] } }],
    ['a low bare residual', { p: { head: HEAD, ruled: [{ title: 't', file: 'a.js', severity: 'low', already_ruled: 'x', from: 'residual' }] } }],
    ['a ruling on a prior finding', { p: { head: HEAD, ruled: [{ title: 't', file: 'a.js', severity: 'medium', settled_severity: 'medium', already_ruled: 'x', from: 'prior' }] } }],
  ]) assert.equal(reviewProblem(received(passes), HEAD), null, label);
});

test('reviewProblem: a waiver above low that ended holds until a listing holds its title and file as fixed', () => {
  const received = (passes) => ({ passes, pending: [], outcome: { status: 'received', head: HEAD } });
  const residual = 'The retry loop has no cap: every caller times out first';
  const anchor = { title: 'Repeat', file: 'a.js', severity: 'medium', settled_severity: 'medium', already_ruled: 'The retry loop has no cap', from: 'residual', residual };
  const ended = { ...anchor, ended: true };
  const listing = (title, file, state = 'fixed') => ({ q: { head: HEAD, list: [{ title, file, state }] } });
  const problem = (entry, other) => reviewProblem(received({ p: { head: HEAD, carried: [entry] }, ...other }), HEAD);
  assert.match(problem(ended) ?? '', /waived a finding above low severity and no listing holds it fixed, so the merge waits for the Human/u);
  assert.equal(problem(ended, listing('The retry loop has no cap', 'a.js')), null, 'a fixed listing of the raised title and its file ends it');
  assert.match(problem(ended, listing('Repeat', 'a.js')) ?? '', /no listing holds it fixed/u, 'the repeat\'s wording is not the finding');
  assert.match(problem(ended, listing('The retry loop has no cap', 'b.js')) ?? '', /no listing holds it fixed/u, 'nor is another file');
  assert.match(problem(ended, listing('The retry loop has no cap', 'a.js', 'open')) ?? '', /no listing holds it fixed/u, 'nor is any other state');
  assert.match(problem(anchor, listing('The retry loop has no cap', 'a.js')) ?? '', /waived a finding above low severity, so the merge waits/u, 'a standing waiver holds until a pass re-runs');
  assert.equal(problem({ ...ended, severity: 'low', settled_severity: 'low' }), null, 'one at low holds nothing');
});

test('auto-merge refuses a head whose record holds a residual waiver above low', (t) => {
  const r = repo(t);
  r.record((state) => {
    finished(state);
    state.passes['engine:codex-local'] = { head: HEAD, carried: [{ title: 'T', file: 'a.js', severity: 'medium', settled_severity: 'medium', already_ruled: 'T', from: 'residual', residual: 'T: why' }] };
  });
  const { code, out, err } = run(t, r, ['7']);
  assert.equal(code, 1);
  assert.match([...out, ...err].join('\n'), /accepted residual "T: why" waived a finding above low severity/u);
});
