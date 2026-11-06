import assert from 'node:assert/strict';
import test from 'node:test';

import { runGh } from '../plugins/aidrian/lib/forges/github-cli.mjs';
import { createGithubForge, GITHUB_JSON, isTrustedCommenter, repoIdentity, UPLOAD_TIMEOUT_MS } from '../plugins/aidrian/lib/forges/github.mjs';
import { forgeFor } from '../plugins/aidrian/lib/forges/index.mjs';
import * as reviewState from '../plugins/aidrian/lib/review/state.mjs';
import { listForge, openPrBodies } from '../plugins/aidrian/lib/rules/github/pr-body.mjs';
import { viewForge, viewPrAt } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';

// Every name the facade gives its callers.
const FACADE = [
  'id', 'cwd', 'isTrustedCommenter', 'repoIdentity',
  'change', 'mergedChanges', 'openChanges', 'checks', 'repo', 'repository', 'contents', 'visibility', 'viewer',
  'issueComments', 'postComment', 'editComment', 'reactions',
  'pull', 'reviews', 'reviewComments', 'reviewsWithComments', 'reviewThreads', 'commit', 'checkRuns', 'compare', 'uploadImages',
];

// The adapter over a recording gh: `answer(args)` is what gh prints for one call. Each call is kept with its options.
function recorded(answer = () => '{}', adapter = {}) {
  const calls = [];
  const forge = createGithubForge({ ...adapter, cwd: '/repo', run: (args, options) => (calls.push({ args, options }), answer(args)) });
  return { forge, calls, args: () => calls.map((call) => call.args) };
}

test('forgeFor gives the GitHub adapter for a checkout, and no caller gets the raw gh it runs', () => {
  const forge = forgeFor('/repo');
  assert.equal(forge.id, 'github');
  assert.equal(forge.cwd, '/repo');
  assert.equal(forge.isTrustedCommenter, isTrustedCommenter);
  assert.equal(forge.repoIdentity, repoIdentity);
  assert.ok(Object.isFrozen(forge));
  const run = () => '';
  for (const each of [forge, createGithubForge({ cwd: '/x', run })]) {
    assert.deepEqual(Object.keys(each).sort(), [...FACADE].sort(), 'the facade\'s own names only');
    assert.ok(!Object.values(each).includes(runGh) && !Object.values(each).includes(run), 'gh stays in the closure, a seam, not a method');
  }
});

test('isTrustedCommenter: only the people GitHub says belong to the repository', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(isTrustedCommenter({ author_association: association }), true, association);
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE', 'owner', '', undefined]) {
    assert.equal(isTrustedCommenter({ author_association: association }), false, String(association));
  }
  for (const comment of [null, undefined, {}, 'OWNER']) assert.equal(isTrustedCommenter(comment), false, String(comment));
  assert.ok(!('MEMBER_ASSOCIATIONS' in reviewState), 'review/state.mjs asks isTrustedCommenter, and hands out no set of its own');
});

test('repoIdentity reads every form of a repository to its host and full path', () => {
  const cases = [
    ['acme/notes', 'github.com', 'acme/notes'],
    ['Acme/Notes', 'github.com', 'acme/notes'],
    ['github.com/Acme/notes', 'github.com', 'acme/notes'],
    ['ghe.example.com/acme/notes', 'ghe.example.com', 'acme/notes'],
    // Longer than gh's host/owner/repo: a namespaced forge's path, accepted here though gh itself refuses it.
    ['gitlab.com/a/sub/project', 'gitlab.com', 'a/sub/project'],
    ['https://github.com/acme/notes.git', 'github.com', 'acme/notes'],
    ['https://GitHub.com/Acme/notes/', 'github.com', 'acme/notes'],
    ['https://user:token@ghe.example.com:8443/acme/notes.git/', 'ghe.example.com', 'acme/notes'],
    ['http://gitlab.com/a/sub/project', 'gitlab.com', 'a/sub/project'],
    ['ssh://git@github.com/acme/notes/', 'github.com', 'acme/notes'],
    ['ssh://git@github.com:22/acme/notes.git', 'github.com', 'acme/notes'],
    ['git+ssh://git@gitlab.com/a/sub/project.git', 'gitlab.com', 'a/sub/project'],
    ['git@github.com:acme/notes.git', 'github.com', 'acme/notes'],
    ['git@GitLab.com:A/Sub/Project.git', 'gitlab.com', 'a/sub/project'],
    ['github.com:acme/notes', 'github.com', 'acme/notes'],
    ['  acme/notes\n', 'github.com', 'acme/notes'],
  ];
  for (const [value, host, repoPath] of cases) assert.deepEqual(repoIdentity(value), { host, path: repoPath, fork: null }, value);
});

test('repoIdentity is null for what names no repository, a local remote included', () => {
  const local = ['/srv/git/acme/notes.git', './acme/notes', '../notes', '~/repos/acme/notes', 'C:/repos/acme/notes', 'c:\\repos\\acme\\notes', 'file:///srv/git/acme/notes.git'];
  for (const value of [...local, '', 'notes', '/', 'acme//notes', 'https://github.com/', 'https://github.com/notes', 'git@github.com:notes.git', 'ssh://[bad', null, undefined, 42, {}]) {
    assert.equal(repoIdentity(value), null, String(value));
  }
});

test('repoIdentity keeps the namespace that the last-two-parts key threw away', () => {
  const values = ['https://gitlab.com/a/sub/project.git', 'git@other.host:b/sub/project.git', 'ssh://git@third.host/c/sub/project'];
  const identities = values.map(repoIdentity);
  assert.deepEqual(identities, [
    { host: 'gitlab.com', path: 'a/sub/project', fork: null },
    { host: 'other.host', path: 'b/sub/project', fork: null },
    { host: 'third.host', path: 'c/sub/project', fork: null },
  ]);
  assert.equal(new Set(identities.map(({ host, path }) => `${host}/${path}`)).size, 3, 'three repositories, three identities');
});

// Each test below holds the gh commands of one caller as that caller ran them before the facade, argument for argument.
test('change: gh pr view as each caller ran it, in the adapter`s folder', () => {
  const { forge, calls } = recorded(() => '{"number":7,"url":"u"}');
  assert.deepEqual(forge.change(7, 'number,url'), { number: 7, url: 'u' });
  forge.change('7', 'number,headRefOid,baseRefName,url,title,body');
  for (const none of [undefined, null, '']) forge.change(none, 'number,headRefOid,baseRefName,url,title,body');
  forge.change(null, 'number,headRepository,headRepositoryOwner,url');
  forge.change(5, 'headRefOid,url');
  forge.change(5, 'url');
  forge.change(0, 'url');
  forge.change('', 'number,headRefOid', { repo: 'acme/notes' });
  assert.deepEqual(calls.map((call) => call.args), [
    ['pr', 'view', '7', '--json', 'number,url'],
    // The review step and extend.
    ['pr', 'view', '7', '--json', 'number,headRefOid,baseRefName,url,title,body'],
    ...Array.from({ length: 3 }, () => ['pr', 'view', '--json', 'number,headRefOid,baseRefName,url,title,body']),
    // await-review, with no pull request given.
    ['pr', 'view', '--json', 'number,headRepository,headRepositoryOwner,url'],
    // aidrian pr request, and attest's and signoff's repository.
    ['pr', 'view', '5', '--json', 'headRefOid,url'],
    ['pr', 'view', '5', '--json', 'url'],
    ['pr', 'view', '0', '--json', 'url'],
    // The merge guard's view with a repository: an empty target still goes to gh.
    ['pr', 'view', '', '--json', 'number,headRefOid', '--repo', 'acme/notes'],
  ]);
  assert.ok(calls.every((call) => call.options.cwd === '/repo'), 'gh reads the repository at the adapter`s folder');
  const options = [];
  createGithubForge({ run: (_args, given) => (options.push(given), '{}') }).change(null, 'url');
  assert.deepEqual(options, [{ cwd: undefined }], 'no folder: gh runs where the command runs, as before');
});

test('the review step`s calls: gh`s default media type, pages joined, an empty list answer an empty list', () => {
  // gh prints one JSON array per page; only --slurp wraps them into one document.
  const answers = {
    'repos/o/r/issues/7/comments': '[[{"id":1}],[{"id":2}]]',
    'repos/o/r/commits/abc/check-runs': '[{"total_count":2,"check_runs":[{"name":"a"}]},{"total_count":2,"check_runs":[{"name":"b"}]},{"total_count":2}]',
    user: '{"login":"me"}',
  };
  const answer = (call) => {
    if (call[0] === 'repo') return '{"nameWithOwner":"o/r","visibility":"PRIVATE"}';
    return call.includes('--method') ? '{"id":9}' : answers[call[1]];
  };
  const { forge, args } = recorded(answer);
  assert.equal(forge.repo(), 'o/r');
  assert.deepEqual(forge.issueComments('o/r', 7), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(forge.postComment('o/r', 7, 'body=with = signs\nand lines'), { id: 9 });
  assert.deepEqual(forge.editComment('o/r', 9, 'new'), { id: 9 });
  assert.equal(forge.viewer(), 'me');
  assert.equal(forge.visibility('o/r'), 'PRIVATE');
  assert.deepEqual(forge.checkRuns('o/r', 'abc'), [{ name: 'a' }, { name: 'b' }]);
  assert.deepEqual(args(), [
    ['repo', 'view', '--json', 'nameWithOwner'],
    ['api', 'repos/o/r/issues/7/comments', '--paginate', '--slurp'],
    ['api', 'repos/o/r/issues/7/comments', '--method', 'POST', '-f', 'body=body=with = signs\nand lines'],
    ['api', 'repos/o/r/issues/comments/9', '--method', 'PATCH', '-f', 'body=new'],
    ['api', 'user'],
    ['repo', 'view', 'o/r', '--json', 'visibility'],
    ['api', 'repos/o/r/commits/abc/check-runs', '--paginate', '--slurp'],
  ]);
  const empty = recorded(() => '').forge;
  assert.deepEqual([empty.issueComments('o/r', 7), empty.checkRuns('o/r', 'abc')], [[], []]);
});

test('await-review`s calls: GitHub`s JSON media type on every REST call, and an empty answer is null', () => {
  const A = ['--header', 'Accept: application/vnd.github+json'];
  assert.equal(GITHUB_JSON, 'application/vnd.github+json');
  const { forge, args } = recorded((call) => (call.includes('--slurp') ? '[[{"id":1}],[{"id":2}]]' : '{"id":9,"login":"me"}'), { mediaType: GITHUB_JSON });
  for (const read of [forge.reviews, forge.reviewComments, forge.issueComments, forge.reactions]) assert.deepEqual(read('acme/notes', 42), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(forge.pull('acme/notes', 42), { id: 9, login: 'me' });
  forge.commit('acme/notes', 'abc');
  forge.postComment('acme/notes', 42, '@codex review');
  forge.editComment('acme/notes', 9, 'record');
  assert.equal(forge.viewer(), 'me');
  forge.repo();
  forge.change(null, 'number,headRepository,headRepositoryOwner,url');
  assert.deepEqual(args(), [
    ['api', 'repos/acme/notes/pulls/42/reviews', ...A, '--paginate', '--slurp'],
    ['api', 'repos/acme/notes/pulls/42/comments', ...A, '--paginate', '--slurp'],
    ['api', 'repos/acme/notes/issues/42/comments', ...A, '--paginate', '--slurp'],
    ['api', 'repos/acme/notes/issues/42/reactions', ...A, '--paginate', '--slurp'],
    ['api', 'repos/acme/notes/pulls/42', ...A],
    ['api', 'repos/acme/notes/commits/abc', ...A],
    ['api', 'repos/acme/notes/issues/42/comments', ...A, '--method', 'POST', '-f', 'body=@codex review'],
    ['api', 'repos/acme/notes/issues/comments/9', ...A, '--method', 'PATCH', '-f', 'body=record'],
    ['api', 'user', ...A],
    ['repo', 'view', '--json', 'nameWithOwner'],
    ['pr', 'view', '--json', 'number,headRepository,headRepositoryOwner,url'],
  ]);
  const empty = recorded(() => '', { mediaType: GITHUB_JSON }).forge;
  assert.deepEqual([empty.reviews('acme/notes', 42), empty.issueComments('acme/notes', 42), empty.pull('acme/notes', 42)], [null, null, null]);
});

test('the reviews report`s calls: the merged list and its search string, +1 reactions with the paging flags first, and the compare', () => {
  // The reactions come one page of one each, which only --slurp wraps into one document.
  const { forge, args } = recorded((call) => (call[0] === 'pr' ? '[{"number":5,"reviews":[]}]' : call[1] === '--paginate' ? '[[{"content":"+1"}],[{"content":"+1"}]]' : '{"status":"ahead"}'));
  assert.deepEqual(forge.mergedChanges(20), [{ number: 5, reviews: [] }]);
  forge.mergedChanges(2, { sinceMs: Date.parse('2026-10-22T12:00:00.500Z') });
  assert.deepEqual(forge.reactions('acme/notes', 2, '+1'), [{ content: '+1' }, { content: '+1' }]);
  assert.deepEqual(forge.compare('acme/notes', 'c1', 'c2'), { status: 'ahead' });
  assert.deepEqual(args(), [
    ['pr', 'list', '--state', 'merged', '--limit', '20', '--json', 'number,reviews'],
    ['pr', 'list', '--state', 'merged', '--limit', '2', '--search', 'merged:>=2026-10-22T12:00:00+00:00', '--json', 'number,reviews'],
    ['api', '--paginate', '--slurp', 'repos/acme/notes/issues/2/reactions?content=%2B1'],
    ['api', 'repos/acme/notes/compare/c1...c2'],
  ]);
});

test('reviewsWithComments: the reviews report`s GraphQL call, query and variables as it sent them', () => {
  const query = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100) {
        totalCount
        nodes {
          author { login }
          commit { oid }
          comments(first: 100) { totalCount nodes { path originalLine diffHunk replyTo { id } originalCommit { oid } } }
        }
      }
    }
  }
}`;
  const answer = { data: { repository: { pullRequest: { reviews: { totalCount: 0, nodes: [] } } } } };
  const { forge, args } = recorded(() => JSON.stringify(answer));
  assert.deepEqual(forge.reviewsWithComments('acme/notes', 7), answer);
  assert.deepEqual(args(), [['api', 'graphql', '-f', `query=${query}`, '-f', 'owner=acme', '-f', 'name=notes', '-F', 'number=7']]);
});

test('a gh failure reaches the caller as gh threw it', () => {
  const failing = createGithubForge({ run: () => { throw new Error('gh: Not Found (HTTP 404)'); } });
  for (const call of [() => failing.change(5, 'url'), () => failing.issueComments('o/r', 5), () => failing.postComment('o/r', 5, 'x'), () => failing.repo()]) {
    assert.throws(call, /HTTP 404/u);
  }
});

test('checks: gh pr checks as aidrian pr checks ran it, and the rows gh prints while it exits 8 for a pending check', () => {
  const { forge, args } = recorded(() => '[{"name":"e2e","state":"SUCCESS"}]');
  assert.deepEqual(forge.checks('7', { repo: 'github.com/acme/notes' }), [{ name: 'e2e', state: 'SUCCESS' }]);
  forge.checks('7', { repo: null });
  forge.checks(null);
  assert.deepEqual(args(), [
    ['pr', 'checks', '7', '--repo', 'github.com/acme/notes', '--json', 'name,state'],
    ['pr', 'checks', '7', '--json', 'name,state'],
    ['pr', 'checks', '--json', 'name,state'],
  ]);
  const pending = [{ name: 'e2e', state: 'PENDING' }];
  const exit8 = createGithubForge({ run: () => { throw Object.assign(new Error('exit 8'), { status: 8, stdout: JSON.stringify(pending) }); } });
  assert.deepEqual(exit8.checks('7'), pending, 'exit 8 with the rows on stdout is an answer');
  const missing = createGithubForge({ run: () => { throw new Error('gh: not found'); } });
  assert.throws(() => missing.checks('7'), /gh: not found/u, 'no rows on stdout: gh\'s own error');
  assert.throws(() => recorded(() => 'not json').forge.checks('7'), SyntaxError, 'a success that prints no JSON throws');
});

test('aidrian pr auto-merge`s calls: --hostname on every REST call, the contents route encoded, and every page of the lists', () => {
  const H = ['--hostname', 'ghe.acme.io'];
  const { forge, args } = recorded((call) => (call.includes('--slurp') ? '[[{"id":1}],[{"id":2}]]' : '{"login":"me","default_branch":"main"}'));
  forge.change('7', 'number,headRefOid,baseRefName,author,url,files,changedFiles,reviewDecision,latestReviews');
  forge.change(null, 'number,headRefOid,baseRefName,author,url,files,changedFiles,reviewDecision,latestReviews');
  assert.equal(forge.repository('acme/notes', { host: 'ghe.acme.io' }).default_branch, 'main');
  forge.contents('acme/notes', '.aidrian.json', 'refs/heads/main', { host: 'ghe.acme.io' });
  forge.contents('acme/notes', 'sub dir/.aidrian/config.json', 'refs/heads/feat/stack', { host: 'ghe.acme.io' });
  assert.equal(forge.viewer({ host: 'ghe.acme.io' }), 'me');
  for (const read of [forge.issueComments, forge.reviews, forge.reviewComments]) assert.deepEqual(read('acme/notes', 7, { host: 'ghe.acme.io' }), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(args(), [
    ['pr', 'view', '7', '--json', 'number,headRefOid,baseRefName,author,url,files,changedFiles,reviewDecision,latestReviews'],
    ['pr', 'view', '--json', 'number,headRefOid,baseRefName,author,url,files,changedFiles,reviewDecision,latestReviews'],
    ['api', ...H, 'repos/acme/notes'],
    ['api', ...H, 'repos/acme/notes/contents/.aidrian.json?ref=refs%2Fheads%2Fmain'],
    ['api', ...H, 'repos/acme/notes/contents/sub%20dir/.aidrian/config.json?ref=refs%2Fheads%2Ffeat%2Fstack'],
    ['api', ...H, 'user'],
    ['api', ...H, 'repos/acme/notes/issues/7/comments', '--paginate', '--slurp'],
    ['api', ...H, 'repos/acme/notes/pulls/7/reviews', '--paginate', '--slurp'],
    ['api', ...H, 'repos/acme/notes/pulls/7/comments', '--paginate', '--slurp'],
  ]);
  const empty = recorded(() => '').forge;
  assert.deepEqual(empty.reviews('acme/notes', 7, { host: 'ghe.acme.io' }), [], 'an empty answer is no entries');
  assert.throws(() => recorded(() => 'not json').forge.viewer({ host: 'github.com' }), SyntaxError, 'an answer that is no JSON throws');
});

test('the hooks` calls: the merge guard`s view and the pull request body rule`s open list, each bounded at 3 s inside the hook`s 5', () => {
  const calls = [];
  const run = (answer) => (args, options) => (calls.push({ args, options }), answer);
  const view = viewPrAt('/repo', viewForge('/repo', { run: run('{"number":5,"headRefOid":"abc"}') }));
  assert.deepEqual(view(null, null), { number: 5, headRefOid: 'abc' });
  view(5, 'acme/notes');
  view('feat/x', null);
  // `gh pr merge "" -R acme/notes`: the empty target goes to gh, which reads it as the current branch's pull request.
  view('', 'acme/notes');
  const bodies = openPrBodies('/repo', listForge('/repo', { run: run('[{"number":1,"body":"b"}]') }));
  assert.deepEqual(bodies(null), [{ number: 1, body: 'b' }]);
  bodies('acme/notes');
  assert.deepEqual(calls.map((call) => call.args), [
    ['pr', 'view', '--json', 'number,headRefOid'],
    ['pr', 'view', '5', '--json', 'number,headRefOid', '--repo', 'acme/notes'],
    ['pr', 'view', 'feat/x', '--json', 'number,headRefOid'],
    ['pr', 'view', '', '--json', 'number,headRefOid', '--repo', 'acme/notes'],
    ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,body'],
    ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,body', '--repo', 'acme/notes'],
  ]);
  assert.deepEqual(calls.map((call) => call.options), calls.map(() => ({ cwd: '/repo', timeoutMs: 3000 })), 'every call carries the hook`s bound');
  // A hook lets the action run: a gh that fails or times out is no answer, never an error.
  const failing = () => { throw new Error('gh pr view did not finish in 3 s and was stopped.'); };
  assert.equal(viewPrAt('/repo', viewForge('/repo', { run: failing }))(5, null), null);
  assert.equal(openPrBodies('/repo', listForge('/repo', { run: failing }))(null), null);
});

test('the worktree cleanup`s merged heads, the decisions record`s pull request, and the review bench`s reads', () => {
  const { forge, args } = recorded((call) => (call[0] === 'repo' ? '{"nameWithOwner":"acme/notes"}' : call[0] === 'pr' && call[1] === 'list' ? '[]' : '{"data":{},"base":{"sha":"b"}}'));
  forge.mergedChanges(100, { fields: 'headRefName,headRefOid' });
  forge.change(null, 'number');
  assert.equal(forge.repo(), 'acme/notes');
  forge.change(12, 'headRefOid,baseRefName,mergedAt', { repo: 'acme/notes' });
  assert.equal(forge.pull('acme/notes', 12).base.sha, 'b');
  forge.reviewThreads('acme/notes', 12);
  forge.reviewThreads('acme/notes', 12, 'Y3Vyc29y');
  const query = 'query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{path line originalLine originalCommit{oid} author{login}}}}}}}}';
  const graphql = ['api', 'graphql', '-f', `query=${query}`, '-F', 'o=acme', '-F', 'r=notes', '-F', 'n=12'];
  assert.deepEqual(args(), [
    ['pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'headRefName,headRefOid'],
    ['pr', 'view', '--json', 'number'],
    ['repo', 'view', '--json', 'nameWithOwner'],
    // The bench named the repository as `-R` before `--json`; gh reads `-R` and `--repo` alike, in any place.
    ['pr', 'view', '12', '--json', 'headRefOid,baseRefName,mergedAt', '--repo', 'acme/notes'],
    ['api', 'repos/acme/notes/pulls/12'],
    graphql,
    [...graphql, '-f', 'after=Y3Vyc29y'],
  ]);
});

test('uploadImages: gh image for the captures, with ten minutes to finish, and what it prints', () => {
  const { forge, calls } = recorded(() => '![a](https://github.com/user-attachments/assets/a)');
  assert.equal(UPLOAD_TIMEOUT_MS, 10 * 60_000);
  assert.equal(forge.uploadImages('acme/notes', ['/c/a.png', '/c/b.png']), '![a](https://github.com/user-attachments/assets/a)');
  assert.deepEqual(calls, [{ args: ['image', '--repo', 'acme/notes', '/c/a.png', '/c/b.png'], options: { cwd: '/repo', timeoutMs: UPLOAD_TIMEOUT_MS } }]);
  const bounded = recorded(() => '', { timeoutMs: 3000 });
  bounded.forge.uploadImages('acme/notes', ['/c/a.png']);
  assert.equal(bounded.calls[0].options.timeoutMs, UPLOAD_TIMEOUT_MS, 'the upload`s own limit, over the adapter`s');
});
