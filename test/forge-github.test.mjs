import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runGh } from '../plugins/aidrian/lib/forges/github-cli.mjs';
import { createGithubForge, GITHUB_JSON, isTrustedCommenter, REVIEWS_PAGE, UPLOAD_TIMEOUT_MS } from '../plugins/aidrian/lib/forges/github.mjs';
import { repoIdentity } from '../plugins/aidrian/lib/forges/identity.mjs';
import * as facade from '../plugins/aidrian/lib/forges/index.mjs';
import { forgeFor } from '../plugins/aidrian/lib/forges/index.mjs';
import { computeVerdict } from '../plugins/aidrian/lib/pr-checks.mjs';
import * as reviewState from '../plugins/aidrian/lib/review/state.mjs';
import { listForge, openPrBodies } from '../plugins/aidrian/lib/rules/github/pr-body.mjs';
import { viewForge, viewPrAt } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';

// Every name the facade gives its callers.
const FACADE = [
  'id', 'cwd', 'isTrustedCommenter',
  'change', 'mergedChanges', 'openChanges', 'checks', 'repo', 'repository', 'contents', 'tree', 'visibility', 'viewer',
  'conversationComments', 'comment', 'postComment', 'editComment', 'deleteComment', 'reactions',
  'pull', 'diff', 'nodeChange', 'changeEdits', 'changeFiles', 'reviews', 'reviewComments', 'changeEvidence', 'reviewsWithComments', 'reviewThreads',
  'postReview', 'reviewComment', 'deleteReviewComment', 'reviewThread', 'replyToReviewComment', 'resolveThread',
  'commit', 'checkRuns', 'compare', 'compareUrl', 'deployments', 'deploymentStatuses', 'uploadImages',
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
  assert.deepEqual(forge.conversationComments('o/r', 7), [{ id: 1 }, { id: 2 }]);
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
  assert.deepEqual([empty.conversationComments('o/r', 7), empty.checkRuns('o/r', 'abc')], [[], []]);
});

test('await-review`s calls: GitHub`s JSON media type on every REST call, and an empty answer is null', () => {
  const A = ['--header', 'Accept: application/vnd.github+json'];
  assert.equal(GITHUB_JSON, 'application/vnd.github+json');
  const { forge, args } = recorded((call) => (call.includes('--slurp') ? '[[{"id":1}],[{"id":2}]]' : '{"id":9,"login":"me"}'), { mediaType: GITHUB_JSON });
  for (const read of [forge.reviews, forge.reviewComments, forge.conversationComments, forge.reactions]) assert.deepEqual(read('acme/notes', 42), [{ id: 1 }, { id: 2 }]);
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
  assert.deepEqual([empty.reviews('acme/notes', 42), empty.conversationComments('acme/notes', 42), empty.pull('acme/notes', 42)], [null, null, null]);
});

test('forgeFor`s strictJson is the adapter`s GitHub JSON media type, the one await-review asks for', () => {
  const sent = (options, answer) => {
    const calls = [];
    const forge = forgeFor('/repo', { ...options, run: (args) => (calls.push(args), answer) });
    return { result: forge.pull('acme/notes', 42), args: calls[0] };
  };
  assert.deepEqual(sent({ strictJson: true }, ''), { result: null, args: ['api', 'repos/acme/notes/pulls/42', '--header', 'Accept: application/vnd.github+json'] });
  assert.deepEqual(sent({}, '{}').args, ['api', 'repos/acme/notes/pulls/42'], 'no media type by default');
  assert.deepEqual(sent({ mediaType: 'text/plain' }, '{}').args, ['api', 'repos/acme/notes/pulls/42'], 'only strictJson sets the media type');
  const source = readFileSync(new URL('../plugins/aidrian/lib/pr-await-review.mjs', import.meta.url), 'utf8');
  assert.match(source, /forgeFor\(undefined, \{ strictJson: true \}\)/u, 'await-review keeps the media type it has always sent');
});

test('docs/providers/adding-a-host.md names every method a forge adapter implements', () => {
  const doc = readFileSync(new URL('../docs/providers/adding-a-host.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('## Adding a forge'));
  assert.ok(section.startsWith('## Adding a forge'));
  assert.deepEqual(FACADE.filter((name) => !new RegExp('`' + name + '[`(]', 'u').test(section)), []);
});

test('the facade index gives shared code forgeFor and its helpers, and nothing of GitHub`s by name', () => {
  assert.deepEqual(Object.keys(facade).sort(), ['MAX_BODY', 'REVIEWS_PAGE', 'forgeFor', 'isLogin', 'isTrustedCommenter', 'repoIdentity']);
  assert.deepEqual(['amy', 'amy-d2', 'A'.repeat(39)].filter(facade.isLogin).length, 3);
  assert.deepEqual(['', '-amy', 'amy-', 'a--b', 'amy d', 'A'.repeat(40), null].filter(facade.isLogin), [], 'not a login');
  assert.equal(facade.isTrustedCommenter, isTrustedCommenter);
  assert.equal(facade.repoIdentity, repoIdentity);
  assert.equal(facade.REVIEWS_PAGE, REVIEWS_PAGE);
  assert.equal(facade.MAX_BODY, 65_536, 'the adapter names GitHub\'s longest body, and the facade gives it to shared code');
});

test('changeEvidence: a comment, review, or review comment of the pull request, each read by its id', () => {
  const notFound = () => { throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' }); };
  const { forge, args } = recorded((call) => {
    const route = call[1];
    if (route === 'repos/acme/notes/issues/comments/11') return '{"issue_url":"https://api.github.com/repos/acme/notes/issues/7"}';
    if (route === 'repos/acme/notes/issues/comments/12') return '{"issue_url":"https://api.github.com/repos/acme/notes/issues/8"}';
    if (route === 'repos/acme/notes/issues/comments/13') return notFound();
    if (route === 'repos/acme/notes/pulls/7/reviews/21') return '{"id":21}';
    if (route === 'repos/acme/notes/pulls/7/reviews/22') return notFound();
    if (route === 'repos/acme/notes/pulls/comments/31') return '{"pull_request_url":"https://api.github.com/repos/acme/notes/pulls/7"}';
    if (route === 'repos/acme/notes/pulls/comments/32') return notFound();
    return assert.fail(`no call for ${route}`);
  });
  const pr = 'https://github.com/acme/notes/pull/7';
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#issuecomment-11`), 'comment');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#issuecomment-12`), null, 'a comment of another pull request');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#issuecomment-13`), null, 'GitHub finds no such comment');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#pullrequestreview-21`), 'review');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}/files#pullrequestreview-22`), null, 'GitHub finds no such review');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#discussion_r31`), 'review_comment');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#discussion_r32`), null, 'GitHub finds no such review comment');
  assert.deepEqual(args(), [
    ['api', 'repos/acme/notes/issues/comments/11'],
    ['api', 'repos/acme/notes/issues/comments/12'],
    ['api', 'repos/acme/notes/issues/comments/13'],
    ['api', 'repos/acme/notes/pulls/7/reviews/21'],
    ['api', 'repos/acme/notes/pulls/7/reviews/22'],
    ['api', 'repos/acme/notes/pulls/comments/31'],
    ['api', 'repos/acme/notes/pulls/comments/32'],
  ]);
  const calls = args().length;
  for (const url of [
    'https://github.com/acme/other/pull/7#issuecomment-11',
    'https://github.com/acme/notes/pull/8#issuecomment-11',
    `${pr}#top`,
    pr,
    'http://github.com/acme/notes/pull/7#issuecomment-11',
    'nope',
    'https://github.com/user-attachments/assets/shot-1',
    'https://github.com/user-attachments/files/123/report.txt',
    'https://github.com/acme/notes/assets/1/shot.png',
    'https://user-images.githubusercontent.com/1/shot.png',
    'https://evil.example/acme/notes/pull/7#issuecomment-11',
    'https://gist.github.com/acme/notes/pull/7#issuecomment-11',
  ]) assert.equal(forge.changeEvidence('acme/notes', 7, url), null, url);
  assert.equal(args().length, calls, 'an upload, another repository, pull request, host, or kind is refused without asking GitHub');
  // A pull request on a GitHub Enterprise host: its links count there, with that host named to gh, and github.com's do not.
  const enterprise = recorded((call) => (call.includes('repos/acme/notes/issues/comments/11') ? '{"issue_url":"https://ghe.example/api/v3/repos/acme/notes/issues/7"}' : assert.fail(call.join(' '))));
  assert.equal(enterprise.forge.changeEvidence('acme/notes', 7, 'https://ghe.example/acme/notes/pull/7#issuecomment-11', { host: 'ghe.example' }), 'comment');
  assert.equal(enterprise.forge.changeEvidence('acme/notes', 7, `${pr}#issuecomment-11`, { host: 'ghe.example' }), null, 'github.com is another host there');
  assert.deepEqual(enterprise.args(), [['api', '--hostname', 'ghe.example', 'repos/acme/notes/issues/comments/11']]);
});

test('changeEvidence: a comment or review comment counts only when its API URL names this pull request exactly', () => {
  const { forge } = recorded((call) => ({
    'repos/acme/notes/issues/comments/1': '{"issue_url":"https://api.github.com/repos/acme/notes/issues/17"}',
    'repos/acme/notes/issues/comments/2': '{"issue_url":"https://api.github.com/repos/acme/other/issues/7"}',
    'repos/acme/notes/pulls/comments/3': '{"pull_request_url":"https://api.github.com/repos/acme/notes/issues/7"}',
    'repos/acme/notes/pulls/comments/4': '{"pull_request_url":"https://api.github.com/repos/ACME/notes/pulls/7"}',
  })[call[1]] ?? '{}');
  const pr = 'https://github.com/acme/notes/pull/7';
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#issuecomment-1`), null, 'another number that ends the same way');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#issuecomment-2`), null, 'another repository');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#discussion_r3`), null, 'an issue, not the pull request');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#discussion_r4`), 'review_comment', 'the repository compares in any case');
});

test('changeEvidence: a gh failure other than not found throws', () => {
  const pr = 'https://github.com/acme/notes/pull/7';
  const broken = recorded(() => { throw new Error('gh: Bad Gateway (HTTP 502)'); }).forge;
  assert.throws(() => broken.changeEvidence('acme/notes', 7, `${pr}#issuecomment-11`), /HTTP 502/u, 'any other failure throws');
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
  for (const call of [() => failing.change(5, 'url'), () => failing.conversationComments('o/r', 5), () => failing.postComment('o/r', 5, 'x'), () => failing.repo()]) {
    assert.throws(call, /HTTP 404/u);
  }
});

test('checks: gh pr checks as aidrian pr checks ran it, and the rows gh prints while it exits 8 for a pending check', () => {
  const printed = [
    { name: 'e2e', state: 'SUCCESS', workflow: 'CI', event: 'pull_request', link: 'https://github.com/acme/notes/actions/runs/42854262636/job/129962858764' },
    { name: 'Vercel', state: 'SUCCESS', workflow: '', event: '', link: 'https://vercel.com/acme/notes/abc' },
  ];
  const { forge, args } = recorded(() => JSON.stringify(printed));
  assert.deepEqual(forge.checks('7', { repo: 'github.com/acme/notes' }), [
    { name: 'e2e', state: 'SUCCESS', workflow: 'CI', event: 'pull_request', run: 42854262636, host: 'github.com', repo: 'acme/notes', workflowId: null },
    { name: 'Vercel', state: 'SUCCESS', workflow: null, event: null, run: null, host: null, repo: null, workflowId: null },
  ], 'the run is the workflow run in the link; an app status has none; one run per name needs no workflow file read');
  forge.checks('7', { repo: null });
  forge.checks(null);
  const fields = 'name,state,workflow,event,link';
  assert.deepEqual(args(), [
    ['pr', 'checks', '7', '--repo', 'github.com/acme/notes', '--json', fields],
    ['pr', 'checks', '7', '--json', fields],
    ['pr', 'checks', '--json', fields],
  ]);
  // A name with several runs: one paginated list of the head's runs, on the link's own host, gives every run's workflow
  // file, however many groups there are, and the verdict over them drops every superseded skip.
  const SHA = 'a'.repeat(40);
  const link = (id) => `https://ghe.example/acme/notes/actions/runs/${id}/job/1`;
  const many = Array.from({ length: 14 }, (_, i) => ({ name: `gate ${i % 7}`, state: i < 7 ? 'SKIPPED' : 'SUCCESS', workflow: `W${i % 7}`, event: 'pull_request', link: link(100 + i) }));
  const reads = recorded((given) => {
    if (given[0] === 'pr' && given[1] === 'checks') return JSON.stringify(many);
    if (given[0] === 'pr') return JSON.stringify({ headRefOid: SHA });
    const runs = Array.from({ length: 14 }, (_, i) => ({ id: 100 + i, workflow_id: 10 + (i % 7) }));
    return JSON.stringify([{ workflow_runs: runs.slice(0, 8) }, { workflow_runs: runs.slice(8) }]);
  });
  const rows = reads.forge.checks('7', { repo: 'ghe.example/acme/notes' });
  assert.deepEqual(rows.map((row) => row.workflowId), Array.from({ length: 14 }, (_, i) => 10 + (i % 7)));
  assert.deepEqual(computeVerdict(rows, { conditionalChecks: ['docs'] }).verdict, 'ready', 'seven workflows, each with a superseded skip');
  assert.deepEqual(reads.args().slice(1), [
    ['pr', 'view', '7', '--repo', 'ghe.example/acme/notes', '--json', 'headRefOid'],
    ['api', '--hostname', 'ghe.example', `repos/acme/notes/actions/runs?head_sha=${SHA}&per_page=100`, '--paginate', '--slurp'],
  ]);
  const once = recorded((given) => (given[1] === 'checks' ? JSON.stringify(many.slice(0, 2)) : assert.fail('one run per name reads nothing more')));
  assert.deepEqual(once.forge.checks('7').map((row) => row.workflowId), [null, null]);
  const failed = recorded((given) => {
    if (given[1] === 'checks') return JSON.stringify(many);
    throw new Error('HTTP 502');
  });
  assert.deepEqual(new Set(failed.forge.checks('7').map((row) => row.workflowId)), new Set([null]), 'a list that fails leaves every run unread');
  // Review round 4: the lists follow the repositories of the workflow rows' runs, once each, never the first row's alone.
  const at = (repo, id) => `https://github.com/${repo}/actions/runs/${id}/job/1`;
  const mixed = [
    { name: 'Vercel', state: 'SUCCESS', workflow: '', event: '', link: at('acme/app-status', 900) },
    { name: 'gate', state: 'SKIPPED', workflow: 'CI', event: 'pull_request', link: at('acme/notes', 100) },
    { name: 'gate', state: 'SUCCESS', workflow: 'CI', event: 'pull_request', link: at('acme/notes', 200) },
    { name: 'lint', state: 'SUCCESS', workflow: 'Lint', event: 'pull_request', link: at('acme/other', 300) },
    { name: 'lint', state: 'SUCCESS', workflow: 'Lint', event: 'pull_request', link: at('acme/broken', 400) },
  ];
  const lists = { 'acme/notes': [{ id: 100, workflow_id: 1 }, { id: 200, workflow_id: 1 }], 'acme/other': [{ id: 300, workflow_id: 3 }, { id: 400, workflow_id: 3 }] };
  const listed = recorded((given) => {
    if (given[1] === 'checks') return JSON.stringify(mixed);
    if (given[0] === 'pr') return JSON.stringify({ headRefOid: SHA });
    const repo = /repos\/([^/]+\/[^/]+)\/actions/u.exec(given.find((arg) => arg.startsWith('repos/')))[1];
    if (!lists[repo]) throw new Error('HTTP 404');
    return JSON.stringify([{ workflow_runs: lists[repo] }]);
  });
  const mixedRows = listed.forge.checks('7');
  assert.deepEqual(mixedRows.map((row) => row.workflowId), [null, 1, 1, 3, null], 'a run of another repository is not read from this one\'s list, and an unread one keeps null');
  assert.deepEqual(listed.args().filter((each) => each[0] === 'api').map((each) => /repos\/([^/]+\/[^/]+)\//u.exec(each.find((arg) => arg.startsWith('repos/')))[1]),
    ['acme/notes', 'acme/other', 'acme/broken'], 'the leading app status chooses no repository');
  assert.equal(computeVerdict(mixedRows, { conditionalChecks: ['docs'] }).verdict, 'ready', 'the superseded skip goes although an app status leads');
  const pending = [{ name: 'e2e', state: 'PENDING' }];
  const exit8 = createGithubForge({ run: () => { throw Object.assign(new Error('exit 8'), { status: 8, stdout: JSON.stringify(pending) }); } });
  assert.deepEqual(exit8.checks('7'), [{ name: 'e2e', state: 'PENDING', workflow: null, event: null, run: null, host: null, repo: null, workflowId: null }], 'exit 8 with the rows on stdout is an answer');
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
  for (const read of [forge.conversationComments, forge.reviews, forge.reviewComments]) assert.deepEqual(read('acme/notes', 7, { host: 'ghe.acme.io' }), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(forge.changeFiles('acme/notes', 7, { host: 'ghe.acme.io' }), [{ id: 1 }, { id: 2 }], 'every page of the file list, joined');
  assert.equal(forge.pull('acme/notes', 7, { host: 'ghe.acme.io' }).login, 'me');
  forge.tree('acme/notes', 'abcdef1234567890abcdef1234567890abcdef12', { host: 'ghe.acme.io' });
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
    // Past gh pr view's 100 files: the whole list, 100 a page, then the head again.
    ['api', ...H, 'repos/acme/notes/pulls/7/files?per_page=100', '--paginate', '--slurp'],
    ['api', ...H, 'repos/acme/notes/pulls/7'],
    // The docs-only route: one folder of the head's tree at a time, never recursive.
    ['api', ...H, 'repos/acme/notes/git/trees/abcdef1234567890abcdef1234567890abcdef12'],
  ]);
  const empty = recorded(() => '').forge;
  assert.deepEqual(empty.reviews('acme/notes', 7, { host: 'ghe.acme.io' }), [], 'an empty answer is no entries');
  assert.deepEqual(empty.changeFiles('acme/notes', 7, { host: 'ghe.acme.io' }), [], 'an empty file list is no entries, which the gate counts as short');
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
    ['pr', 'view', '--json', 'number,headRefOid,baseRefName,url'],
    ['pr', 'view', '5', '--json', 'number,headRefOid,baseRefName,url', '--repo', 'acme/notes'],
    ['pr', 'view', 'feat/x', '--json', 'number,headRefOid,baseRefName,url'],
    ['pr', 'view', '', '--json', 'number,headRefOid,baseRefName,url', '--repo', 'acme/notes'],
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

test('the product feedback commands` calls: the pull request, its comment, the post or edit, and the diff, each on its host', () => {
  const H = ['--hostname', 'ghe.acme.io'];
  const { forge, calls } = recorded((call) => (call[1] === 'diff' ? 'diff --git a/x b/x\n' : '{"id":9}'));
  const fields = 'number,headRefOid,baseRefName,author,url,files,changedFiles,reviewDecision,latestReviews,isCrossRepository';
  forge.change('7', fields, { repo: 'ghe.acme.io/acme/notes' });
  assert.deepEqual(forge.pull('acme/notes', 7, { host: 'ghe.acme.io' }), { id: 9 });
  forge.pull('acme/notes', 7);
  assert.deepEqual(forge.comment('acme/notes', 41, { host: 'ghe.acme.io' }), { id: 9 });
  assert.deepEqual(forge.postComment('acme/notes', 7, '<!-- m -->\nbody', { host: 'ghe.acme.io' }), { id: 9 });
  forge.editComment('acme/notes', 41, '<!-- m -->\nbody', { host: 'ghe.acme.io' });
  forge.postComment('acme/notes', 7, 'b');
  assert.equal(forge.diff(7, { repo: 'ghe.acme.io/acme/notes' }), 'diff --git a/x b/x\n', 'the diff is text, not JSON');
  forge.diff('7');
  assert.deepEqual(calls.map((call) => call.args), [
    ['pr', 'view', '7', '--json', fields, '--repo', 'ghe.acme.io/acme/notes'],
    ['api', ...H, 'repos/acme/notes/pulls/7'],
    ['api', 'repos/acme/notes/pulls/7'],
    ['api', ...H, 'repos/acme/notes/issues/comments/41'],
    ['api', ...H, 'repos/acme/notes/issues/7/comments', '--method', 'POST', '-f', 'body=<!-- m -->\nbody'],
    ['api', ...H, 'repos/acme/notes/issues/comments/41', '--method', 'PATCH', '-f', 'body=<!-- m -->\nbody'],
    ['api', 'repos/acme/notes/issues/7/comments', '--method', 'POST', '-f', 'body=b'],
    ['pr', 'diff', '7', '--repo', 'ghe.acme.io/acme/notes'],
    ['pr', 'diff', '7'],
  ]);
});

test('aidrian pr resolve`s deployment reads: the head`s deployments and one deployment`s statuses, a first page each, on the host', () => {
  const { forge, args } = recorded(() => '[{"id":3}]');
  const sha = 'a'.repeat(40);
  assert.deepEqual(forge.deployments('acme/notes', sha, { host: 'github.com' }), [{ id: 3 }]);
  assert.deepEqual(forge.deploymentStatuses('acme/notes', 3, { host: 'github.com' }), [{ id: 3 }]);
  assert.deepEqual(args(), [
    ['api', '--hostname', 'github.com', `repos/acme/notes/deployments?sha=${sha}`],
    ['api', '--hostname', 'github.com', 'repos/acme/notes/deployments/3/statuses'],
  ]);
});

test('the ready hold`s calls: a node id`s pull request through GraphQL, and SIGKILL at each call`s bound', () => {
  const { forge, calls } = recorded(() => '{"data":{"node":{"url":"https://github.com/acme/notes/pull/7"}}}', { timeoutMs: 1200, killSignal: 'SIGKILL' });
  assert.equal(forge.nodeChange('PR_kwDOabc123').data.node.url, 'https://github.com/acme/notes/pull/7');
  forge.change(null, 'url', { repo: 'acme/notes' });
  assert.deepEqual(calls, [
    { args: ['api', 'graphql', '-f', 'query=query($id:ID!){node(id:$id){... on PullRequest{url}}}', '-f', 'id=PR_kwDOabc123'], options: { cwd: '/repo', timeoutMs: 1200, killSignal: 'SIGKILL' } },
    { args: ['pr', 'view', '--json', 'url', '--repo', 'acme/notes'], options: { cwd: '/repo', timeoutMs: 1200, killSignal: 'SIGKILL' } },
  ]);
  // The signal reaches gh's process through the runner, and no signal is named when none is asked for.
  const given = [];
  const exec = (_file, _args, options) => (given.push(options), '{}');
  runGh(['api', 'user'], { exec, timeoutMs: 1200, killSignal: 'SIGKILL' });
  runGh(['api', 'user'], { exec });
  assert.deepEqual([given[0].killSignal, given[0].timeout], ['SIGKILL', 1200]);
  assert.ok(!('killSignal' in given[1]), 'gh`s runner keeps execFileSync`s default signal');
  assert.ok(!('killSignal' in recorded().calls), 'no option, no signal');
  const plain = recorded(() => '{}');
  plain.forge.pull('acme/notes', 7);
  assert.deepEqual(plain.calls[0].options, { cwd: '/repo' });
});

test('the ready checks hold`s edit times: one GraphQL call, naming a host only when it is not github.com', () => {
  const { forge, args } = recorded(() => '{"data":{"repository":{"pullRequest":{"lastEditedAt":"2026-11-10T23:45:16Z","timelineItems":{"nodes":[]}}}}}');
  assert.equal(forge.changeEdits('acme/notes', 12).data.repository.pullRequest.lastEditedAt, '2026-11-10T23:45:16Z');
  forge.changeEdits('acme/notes', 12, { host: 'ghe.example.com' });
  const query = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){lastEditedAt timelineItems(last:1,itemTypes:[RENAMED_TITLE_EVENT]){nodes{... on RenamedTitleEvent{createdAt}}}}}}';
  const tail = ['-f', `query=${query}`, '-F', 'o=acme', '-F', 'r=notes', '-F', 'n=12'];
  assert.deepEqual(args(), [['api', 'graphql', ...tail], ['api', 'graphql', '--hostname', 'ghe.example.com', ...tail]]);
});

test('compareUrl: a link from two full-hex SHAs on the forge`s own address of the repository, read once, and none from anything else', () => {
  const [a, b] = ['a'.repeat(40), '0123456789abcdef0123456789abcdef01234567'];
  const home = (url) => recorded((args) => (args.includes('repos/o/r') ? JSON.stringify({ html_url: url }) : '{}'));
  const { forge, calls } = home('https://github.com/o/r');
  assert.equal(forge.compareUrl('o/r', a, b), `https://github.com/o/r/compare/${a}...${b}`);
  assert.equal(forge.compareUrl('O/R', b, a), `https://github.com/o/r/compare/${b}...${a}`, 'GitHub`s own spelling of the repository');
  assert.equal(calls.length, 1, 'the repository is read once');
  assert.deepEqual(calls[0].args.slice(0, 2), ['api', 'repos/o/r']);
  const enterprise = home('https://ghe.example.com/o/r');
  assert.equal(enterprise.forge.compareUrl('o/r', a, b), `https://ghe.example.com/o/r/compare/${a}...${b}`, 'a GitHub Enterprise repository links to its own host');
  for (const url of ['http://github.com/o/r', 'https://github.com/o/other', 'https://github.com/o/r?x=1', 'https://github.com:8443/o/r', 'javascript:alert(1)', '']) {
    assert.equal(home(url).forge.compareUrl('o/r', a, b), null, `the forge answered ${url}`);
  }
  const failing = recorded(() => { throw new Error('gh: Not Found (HTTP 404)'); });
  assert.equal(failing.forge.compareUrl('o/r', a, b), null, 'a read that fails gives no link');
  const none = home('https://github.com/o/r');
  for (const [repo, from, to] of [
    ['o/r', a.slice(0, 7), b], ['o/r', a, b.slice(0, 39)], ['o/r', a.toUpperCase(), b], ['o/r', `${a}x`, b], ['o/r', null, b], ['o/r', a, 'HEAD'],
    ['o/r/x', a, b], ['o', a, b], ['-o/r', a, b], ['o/..', a, b], ['o/r?x=1', a, b], ['o/r#7', a, b], [null, a, b],
  ]) assert.equal(none.forge.compareUrl(repo, from, to), null, `${repo} ${from} ${to}`);
  assert.equal(none.calls.length, 0, 'no call for SHAs or a name that fail');
});

// ---- The inline review's writes and reads (lib/review/inline.mjs) ----

const SHA40 = 'a'.repeat(40);
const httpError = (status) => Object.assign(new Error(`Command failed: gh api\ngh: Something (HTTP ${status})`), { stderr: `gh: Something (HTTP ${status})` });

test('postReview: one POST of the review as JSON on stdin, the event always COMMENT, then its inline comments read back', () => {
  const { forge, calls } = recorded((call) => (call.includes('--method') ? '{"id":501}' : '[[{"id":61,"body":"b1","path":"src/a.js","line":3,"extra":1}]]'));
  const answer = forge.postReview('o/r', 7, { commitId: SHA40, body: '<!-- m -->\nbody', comments: [{ path: 'src/a.js', line: 3, side: 'RIGHT', body: 'b1' }], event: 'APPROVE' });
  assert.deepEqual(answer, { refused: false, id: 501, comments: [{ id: 61, body: 'b1', path: 'src/a.js', line: 3 }] });
  assert.deepEqual(calls.map((call) => call.args), [
    ['api', 'repos/o/r/pulls/7/reviews', '--method', 'POST', '--input', '-'],
    ['api', 'repos/o/r/pulls/7/reviews/501/comments', '--paginate', '--slurp'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.input), {
    commit_id: SHA40, body: '<!-- m -->\nbody', event: 'COMMENT', comments: [{ path: 'src/a.js', line: 3, side: 'RIGHT', body: 'b1' }],
  }, 'an event passed in changes nothing: the adapter sets COMMENT, and takes no event');
  assert.ok(!calls[0].args.includes('-F') && !calls[0].args.includes('-f'), 'no field flag carries pull request text');
});

test('postReview: a path and a body that start with @, and a body "true", reach GitHub as literal strings', () => {
  const { forge, calls } = recorded((call) => (call.includes('--method') ? '{"id":5}' : '[]'));
  forge.postReview('o/r', 7, { commitId: SHA40, body: 'true', comments: [{ path: '@etc/passwd', line: 1, side: 'RIGHT', body: '@/etc/hosts' }] });
  const sent = JSON.parse(calls[0].options.input);
  assert.deepEqual([sent.body, sent.comments[0].path, sent.comments[0].body], ['true', '@etc/passwd', '@/etc/hosts']);
  assert.equal(typeof sent.body, 'string');
  // The conversation writes send their body as a raw -f field, which gh never reads as a file or a boolean.
  const plain = recorded(() => '{"id":9}');
  plain.forge.postComment('o/r', 7, '@/etc/passwd');
  plain.forge.editComment('o/r', 9, 'true');
  assert.deepEqual(plain.args(), [
    ['api', 'repos/o/r/issues/7/comments', '--method', 'POST', '-f', 'body=@/etc/passwd'],
    ['api', 'repos/o/r/issues/comments/9', '--method', 'PATCH', '-f', 'body=true'],
  ]);
});

test('postReview: any 4xx answer is a refusal in the result, any other failure throws, and a failed read of its comments keeps the review', () => {
  for (const status of [400, 403, 404, 422]) {
    const { forge } = recorded(() => { throw httpError(status); });
    assert.deepEqual(forge.postReview('o/r', 7, { commitId: SHA40, body: 'b', comments: [] }), { refused: true }, String(status));
  }
  for (const status of [500, 502]) {
    const { forge } = recorded(() => { throw httpError(status); });
    assert.throws(() => forge.postReview('o/r', 7, { commitId: SHA40, body: 'b', comments: [] }), new RegExp(`HTTP ${status}`, 'u'));
  }
  const network = recorded(() => { throw new Error('gh api did not finish in 60 s and was stopped'); });
  assert.throws(() => network.forge.postReview('o/r', 7, { commitId: SHA40, body: 'b', comments: [] }), /did not finish/u);
  const unread = recorded((call) => (call.includes('--method') ? '{"id":8}' : (() => { throw httpError(502); })()));
  assert.deepEqual(unread.forge.postReview('o/r', 7, { commitId: SHA40, body: 'b', comments: [] }), { refused: false, id: 8, comments: null });
  assert.throws(() => recorded().forge.postReview('o/r', 7, { commitId: 'abc', body: 'b' }), /full SHA/u);
});

test('every write route and every read of one comment is built from a safe positive integer alone', () => {
  const { forge, args } = recorded(() => '{"id":9}');
  for (const bad of ['1/../../x', '12abc', '@1', 1.5, -3, 0, '', null, undefined, Number.MAX_SAFE_INTEGER + 1, '9'.repeat(17)]) {
    assert.throws(() => forge.deleteComment('o/r', bad), /must be a positive whole number/u, String(bad));
    assert.throws(() => forge.deleteReviewComment('o/r', bad), /must be a positive whole number/u, String(bad));
    assert.throws(() => forge.reviewComment('o/r', 7, bad), /must be a positive whole number/u, String(bad));
    assert.throws(() => forge.comment('o/r', bad), /must be a positive whole number/u, String(bad));
    assert.throws(() => forge.editComment('o/r', bad, 'b'), /must be a positive whole number/u, String(bad));
    assert.throws(() => forge.postComment('o/r', bad, 'b'), /must be a positive whole number/u, String(bad));
    assert.throws(() => forge.postReview('o/r', bad, { commitId: SHA40, body: 'b' }), /must be a positive whole number/u, String(bad));
    assert.throws(() => forge.postReview('o/r', 7, { commitId: SHA40, body: 'b', comments: [{ path: 'a', line: bad, body: 'b' }] }), /must be a positive whole number/u, String(bad));
    assert.throws(() => forge.replyToReviewComment('o/r', 7, bad, 'b'), /must be a positive whole number/u, String(bad));
    assert.throws(() => forge.replyToReviewComment('o/r', bad, 61, 'b'), /must be a positive whole number/u, String(bad));
    assert.throws(() => forge.reviewThread('o/r', 7, bad), /must be a positive whole number/u, String(bad));
    assert.throws(() => forge.resolveThread('o/r', bad, 61), /must be a positive whole number/u, String(bad));
  }
  assert.deepEqual(args(), [], 'no call is made for any of them');
});

test('the two deletes: DELETE of one review comment and of one conversation comment, an empty answer read as null', () => {
  const { forge, args } = recorded(() => '');
  assert.equal(forge.deleteReviewComment('o/r', 61), null);
  assert.equal(forge.deleteComment('o/r', '62'), null);
  assert.deepEqual(args(), [
    ['api', 'repos/o/r/pulls/comments/61', '--method', 'DELETE'],
    ['api', 'repos/o/r/issues/comments/62', '--method', 'DELETE'],
  ]);
  const broken = recorded(() => { throw httpError(403); }).forge;
  assert.throws(() => broken.deleteComment('o/r', 62), /HTTP 403/u, 'a failed delete throws, so the step names it and tries again');
});

// One page of GraphQL review threads: each [id, isResolved, root comment id, more comments], with `next` the cursor; each
// comment's id is its fullDatabaseId, a string, as GitHub answers it.
const threadsPage = (threads, next = null) => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  nodes: threads.map(([id, resolved, root, extra = []]) => ({ id, isResolved: resolved, comments: { totalCount: 1 + extra.length, nodes: [
    { fullDatabaseId: String(root), body: `<!-- root ${root} -->`, authorAssociation: 'OWNER', author: { login: 'me' } },
    ...extra.map((each) => ({ fullDatabaseId: String(each), body: 'reply', authorAssociation: 'NONE', author: { login: 'someone' } })),
  ] } })),
} } } } });

test('reviewThread: the thread a review comment starts, read page by page through GraphQL, in the facade`s comment shape', () => {
  const { forge, calls } = recorded((call) => (call.some((arg) => arg === 'after=c1') ? threadsPage([['T2', true, 62, [63]]]) : threadsPage([['T1', false, 61]], 'c1')));
  assert.deepEqual(forge.reviewThread('o/r', 7, 62), {
    resolved: true,
    complete: true,
    comments: [
      { id: 62, body: '<!-- root 62 -->', user: { login: 'me' }, author_association: 'OWNER' },
      { id: 63, body: 'reply', user: { login: 'someone' }, author_association: 'NONE' },
    ],
  });
  assert.equal(calls.length, 2, 'every page until the thread is found');
  const [first, second] = calls.map((call) => call.args);
  assert.deepEqual(first.slice(0, 2), ['api', 'graphql']);
  assert.ok(first.includes('o=o') && first.includes('r=r') && first.includes('n=7'));
  assert.equal(first[first.indexOf('n=7') - 1], '-F', 'only the pull request number, a checked integer, goes as a typed field');
  assert.equal(first[first.indexOf('o=o') - 1], '-f');
  assert.ok(second.includes('after=c1'));
  assert.equal(recorded(() => threadsPage([['T1', false, 61]])).forge.reviewThread('o/r', 7, 62), null, 'no thread starts at that comment');
  const long = recorded(() => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'T', isResolved: false, comments: { totalCount: 101, nodes: [{ fullDatabaseId: '5', body: 'x', author: { login: 'me' } }] } }] } } } } }));
  assert.equal(long.forge.reviewThread('o/r', 7, 5).complete, false, 'a thread past the 100 comments read is read only in part');
  assert.throws(() => recorded(() => '{"data":null}').forge.reviewThread('o/r', 7, 5), /no list/u);
  // Review comment ids are past 32 bits: the query asks for fullDatabaseId, never the deprecated databaseId.
  const big = 4552514677;
  const wide = recorded(() => threadsPage([['T9', false, big, [big + 1]]]));
  assert.deepEqual(wide.forge.reviewThread('o/r', 7, big).comments.map((each) => each.id), [big, big + 1]);
  const query = wide.calls[0].args.find((arg) => arg.startsWith('query='));
  assert.ok(query.includes('fullDatabaseId') && !/[{\s]databaseId\b/u.test(query), 'fullDatabaseId alone');
  // An id of any other shape names no comment, and matches no root.
  const odd = (value) => recorded(() => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'T', isResolved: false, comments: { totalCount: 1, nodes: [{ fullDatabaseId: value, body: 'x', author: { login: 'me' } }] } }] } } } } }));
  for (const value of ['5x', '-5', '5.0', '05', '99999999999999999', null, { n: 5 }]) assert.equal(odd(value).forge.reviewThread('o/r', 7, 5), null, JSON.stringify(value));
  assert.equal(odd(5).forge.reviewThread('o/r', 7, 5).comments[0].id, 5, 'a number answer reads as the same id');
});

test('replyToReviewComment: one POST to the comment`s replies, its body a raw -f field that starts with @ or reads true', () => {
  const { forge, args } = recorded(() => '{"id":88,"body":"b"}');
  assert.deepEqual(forge.replyToReviewComment('o/r', 7, 61, '@/etc/passwd'), { id: 88, body: 'b' });
  forge.replyToReviewComment('o/r', '7', '61', 'true');
  assert.deepEqual(args(), [
    ['api', 'repos/o/r/pulls/7/comments/61/replies', '--method', 'POST', '-f', 'body=@/etc/passwd'],
    ['api', 'repos/o/r/pulls/7/comments/61/replies', '--method', 'POST', '-f', 'body=true'],
  ]);
  assert.ok(!args().flat().includes('-F'), 'no typed field carries the body');
});

test('resolveThread: the thread found by its root comment`s id, then one resolveReviewThread mutation; no node id reaches the caller', () => {
  const { forge, calls } = recorded((call) => (call.some((arg) => arg.startsWith('query=mutation')) ? '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}' : threadsPage([['PRRT_kw1', false, 61]])));
  assert.deepEqual(forge.resolveThread('o/r', 7, 61), { resolved: true });
  const mutation = calls[1].args;
  assert.deepEqual(mutation.slice(0, 2), ['api', 'graphql']);
  assert.match(mutation[3], /^query=mutation\(\$id:ID!\)\{resolveReviewThread\(input:\{threadId:\$id\}\)/u);
  assert.deepEqual(mutation.slice(4), ['-f', 'id=PRRT_kw1']);
  const done = recorded(() => threadsPage([['PRRT_kw1', true, 61]]));
  assert.deepEqual(done.forge.resolveThread('o/r', 7, 61), { resolved: true });
  assert.equal(done.calls.length, 1, 'a thread already resolved needs no mutation');
  assert.throws(() => recorded(() => threadsPage([])).forge.resolveThread('o/r', 7, 61), /no review thread/u);
  const refused = recorded((call) => (call.some((arg) => arg.startsWith('query=mutation')) ? '{"data":{"resolveReviewThread":null}}' : threadsPage([['PRRT_kw1', false, 61]])));
  assert.throws(() => refused.forge.resolveThread('o/r', 7, 61), /did not resolve/u, 'an answer that is not a resolved thread throws, so the step tries again');
  // With `only`, the thread read just now must hold no other comment: one that landed since the caller's read keeps it open.
  const others = recorded(() => threadsPage([['PRRT_kw1', false, 61, [62, 63]]]));
  assert.deepEqual(others.forge.resolveThread('o/r', 7, 61, { only: [61, 62] }), { resolved: false, others: true });
  assert.equal(others.calls.length, 1, 'no mutation is sent');
  const alone = recorded((call) => (call.some((arg) => arg.startsWith('query=mutation')) ? '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}' : threadsPage([['PRRT_kw1', false, 61, [62]]])));
  assert.deepEqual(alone.forge.resolveThread('o/r', 7, 61, { only: [61, 62] }), { resolved: true });
  assert.equal(alone.calls.length, 2, 'a thread of the allowed comments alone is resolved');
  const partial = recorded(() => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'PRRT_kw1', isResolved: false, comments: { totalCount: 101, nodes: [{ fullDatabaseId: '61', body: 'x', author: { login: 'me' } }] } }] } } } } }));
  assert.deepEqual(partial.forge.resolveThread('o/r', 7, 61, { only: [61] }), { resolved: false, others: true }, 'a thread read only in part is not resolved');
  assert.equal(partial.calls.length, 1);
  for (const bad of ['1/../x', -1, 1.5, '@2']) assert.throws(() => recorded().forge.resolveThread('o/r', 7, 61, { only: [61, bad] }), /must be a positive whole number/u, String(bad));
  const odd = recorded(() => threadsPage([['bad id; x', false, 61]]));
  assert.throws(() => odd.forge.resolveThread('o/r', 7, 61), /no id/u);
  assert.equal(odd.calls.length, 1, 'a node id of another shape is never sent back');
});

test('reviewComment and comment with the pull request named: each held to that pull request, and comment without it answers as before', () => {
  const { forge, args } = recorded((call) => ({
    'repos/o/r/pulls/comments/1': '{"id":1,"pull_request_url":"https://api.github.com/repos/o/r/pulls/7"}',
    'repos/o/r/pulls/comments/2': '{"id":2,"pull_request_url":"https://api.github.com/repos/o/r/pulls/8"}',
    'repos/o/r/issues/comments/3': '{"id":3,"issue_url":"https://api.github.com/repos/o/r/issues/7"}',
    'repos/o/r/issues/comments/4': '{"id":4,"issue_url":"https://api.github.com/repos/o/other/issues/7"}',
  })[call[1]] ?? (() => { throw httpError(404); })());
  assert.equal(forge.reviewComment('o/r', 7, 1).id, 1);
  assert.equal(forge.reviewComment('o/r', 7, 2), null, 'a review comment of another pull request');
  assert.equal(forge.reviewComment('o/r', 7, 5), null, 'GitHub finds no such comment');
  assert.equal(forge.comment('o/r', 3, { pr: 7 }).id, 3);
  assert.equal(forge.comment('o/r', 4, { pr: 7 }), null, 'a comment of another repository');
  assert.equal(forge.comment('o/r', 5, { pr: 7 }), null, 'GitHub finds no such comment');
  assert.equal(forge.comment('o/r', 4).id, 4, 'without the option, the comment as GitHub answers it');
  assert.throws(() => forge.comment('o/r', 5), /HTTP 404/u, 'and a 404 throws, as before');
  assert.deepEqual(args().map((call) => call[1]), ['repos/o/r/pulls/comments/1', 'repos/o/r/pulls/comments/2', 'repos/o/r/pulls/comments/5', 'repos/o/r/issues/comments/3', 'repos/o/r/issues/comments/4', 'repos/o/r/issues/comments/5', 'repos/o/r/issues/comments/4', 'repos/o/r/issues/comments/5']);
  const broken = recorded(() => { throw httpError(502); }).forge;
  assert.throws(() => broken.reviewComment('o/r', 7, 1), /HTTP 502/u);
  assert.throws(() => broken.comment('o/r', 1, { pr: 7 }), /HTTP 502/u);
});

test('changeEvidence withBody: the item`s kind and its text, so a sign-off can refuse an engine post', () => {
  const { forge } = recorded((call) => ({
    'repos/o/r/issues/comments/11': '{"issue_url":"https://api.github.com/repos/o/r/issues/7","body":"<!-- aidrian-review-summary -->"}',
    'repos/o/r/pulls/7/reviews/21': '{"id":21,"body":"looks right"}',
    'repos/o/r/pulls/comments/31': '{"pull_request_url":"https://api.github.com/repos/o/r/pulls/7"}',
  })[call[1]] ?? (() => { throw httpError(404); })());
  const pr = 'https://github.com/o/r/pull/7';
  assert.deepEqual(forge.changeEvidence('o/r', 7, `${pr}#issuecomment-11`, { withBody: true }), { kind: 'comment', body: '<!-- aidrian-review-summary -->' });
  assert.deepEqual(forge.changeEvidence('o/r', 7, `${pr}#pullrequestreview-21`, { withBody: true }), { kind: 'review', body: 'looks right' });
  assert.deepEqual(forge.changeEvidence('o/r', 7, `${pr}#discussion_r31`, { withBody: true }), { kind: 'review_comment', body: '' });
  assert.equal(forge.changeEvidence('o/r', 7, `${pr}#discussion_r32`, { withBody: true }), null);
  assert.equal(forge.changeEvidence('o/r', 7, `${pr}#issuecomment-11`), 'comment', 'without it, the kind alone, as before');
});

test('runGh hands a request body to a real gh child on its stdin, and gives a call with none no stdin', (t) => {
  // A fake gh on PATH that logs what it reads on stdin, one line a call: execFileSync drops `input` unless stdin is a
  // pipe. It answers a call that sends a body with a review id, and any other call with an empty list.
  const bin = mkdtempSync(path.join(tmpdir(), 'aidrian-fake-gh-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, 'stdin.log');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$(cat)" >> '${log}'\ncase "$*" in *--input*) printf '{"id":5}' ;; *) printf '[]' ;; esac\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  t.after(() => { process.env.PATH = before; });
  const read = () => readFileSync(log, 'utf8').split('\n').slice(0, -1);
  assert.equal(runGh(['api', 'x', '--input', '-'], { input: '{"a":1}' }), '{"id":5}');
  runGh(['api', 'x']);
  assert.deepEqual(read(), ['{"a":1}', ''], 'the body reaches gh, and a call with no input reads an empty stdin');
  // The adapter's postReview through the same real child: the whole request arrives, its text as written.
  const forge = createGithubForge({ cwd: bin });
  const sha = 'a'.repeat(40);
  assert.deepEqual(forge.postReview('o/r', 7, { commitId: sha, body: '@/etc/passwd', comments: [{ path: '@a.js', line: 2, side: 'RIGHT', body: 'true' }] }), { refused: false, id: 5, comments: [] });
  assert.deepEqual(JSON.parse(read()[2]), { commit_id: sha, body: '@/etc/passwd', event: 'COMMENT', comments: [{ path: '@a.js', line: 2, side: 'RIGHT', body: 'true' }] });
});
