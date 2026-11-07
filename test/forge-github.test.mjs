import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runGh } from '../plugins/aidrian/lib/forges/github-cli.mjs';
import { createGithubForge, GITHUB_JSON, isTrustedCommenter, linksIn, REVIEWS_PAGE, UPLOAD_TIMEOUT_MS } from '../plugins/aidrian/lib/forges/github.mjs';
import { repoIdentity } from '../plugins/aidrian/lib/forges/identity.mjs';
import * as facade from '../plugins/aidrian/lib/forges/index.mjs';
import { forgeFor } from '../plugins/aidrian/lib/forges/index.mjs';
import * as reviewState from '../plugins/aidrian/lib/review/state.mjs';
import { listForge, openPrBodies } from '../plugins/aidrian/lib/rules/github/pr-body.mjs';
import { viewForge, viewPrAt } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';

// Every name the facade gives its callers.
const FACADE = [
  'id', 'cwd', 'isTrustedCommenter',
  'change', 'mergedChanges', 'openChanges', 'checks', 'repo', 'repository', 'contents', 'visibility', 'viewer',
  'conversationComments', 'postComment', 'editComment', 'reactions',
  'pull', 'reviews', 'reviewComments', 'changeEvidence', 'reviewsWithComments', 'reviewThreads', 'commit', 'checkRuns', 'compare', 'uploadImages',
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
  assert.deepEqual(Object.keys(facade).sort(), ['REVIEWS_PAGE', 'forgeFor', 'isLogin', 'isTrustedCommenter', 'repoIdentity']);
  assert.deepEqual(['amy', 'amy-d2', 'A'.repeat(39)].filter(facade.isLogin).length, 3);
  assert.deepEqual(['', '-amy', 'amy-', 'a--b', 'amy d', 'A'.repeat(40), null].filter(facade.isLogin), [], 'not a login');
  assert.equal(facade.isTrustedCommenter, isTrustedCommenter);
  assert.equal(facade.repoIdentity, repoIdentity);
  assert.equal(facade.REVIEWS_PAGE, REVIEWS_PAGE);
});

test('changeEvidence: a comment, review, or attachment of the pull request, each read with the call that finds it', () => {
  const notFound = () => { throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' }); };
  const { forge, args } = recorded((call) => {
    const route = call[1];
    if (route === 'repos/acme/notes/issues/comments/11') return '{"issue_url":"https://api.github.com/repos/acme/notes/issues/7"}';
    if (route === 'repos/acme/notes/issues/comments/12') return '{"issue_url":"https://api.github.com/repos/acme/notes/issues/8"}';
    if (route === 'repos/acme/notes/pulls/7/reviews/21') return '{"id":21}';
    if (route === 'repos/acme/notes/pulls/7/reviews/22') return notFound();
    if (route === 'repos/acme/notes/pulls/comments/31') return '{"pull_request_url":"https://api.github.com/repos/acme/notes/pulls/7"}';
    if (route === 'repos/acme/notes/pulls/7') return '{"body":"see https://github.com/user-attachments/assets/abc-1"}';
    if (route === 'repos/acme/notes/pulls/7/reviews') return '[[{"body":"https://github.com/user-attachments/assets/rev-2"}]]';
    return '[[]]';
  });
  const pr = 'https://github.com/acme/notes/pull/7';
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#issuecomment-11`), 'comment');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#issuecomment-12`), null, 'a comment of another pull request');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#pullrequestreview-21`), 'review');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}/files#pullrequestreview-22`), null, 'GitHub finds no such review');
  assert.equal(forge.changeEvidence('acme/notes', 7, `${pr}#discussion_r31`), 'review_comment');
  assert.equal(forge.changeEvidence('acme/notes', 7, 'https://github.com/user-attachments/assets/abc-1'), 'attachment');
  assert.equal(forge.changeEvidence('acme/notes', 7, 'https://github.com/user-attachments/assets/rev-2'), 'attachment', 'linked from a review');
  const calls = args().length;
  for (const url of ['https://github.com/acme/other/pull/7#issuecomment-11', 'https://github.com/acme/notes/pull/8#issuecomment-11', `${pr}#top`, 'http://github.com/acme/notes/pull/7#issuecomment-11', 'nope', 'https://example.com/a.png']) {
    assert.equal(forge.changeEvidence('acme/notes', 7, url), null, url);
  }
  assert.equal(args().length, calls, 'a URL of another repository, pull request, or kind asks GitHub nothing');
  assert.equal(forge.changeEvidence('acme/notes', 7, 'https://github.com/user-attachments/assets/elsewhere'), null, 'an upload the pull request does not link');
  assert.deepEqual(args().slice(0, 7), [
    ['api', 'repos/acme/notes/issues/comments/11'],
    ['api', 'repos/acme/notes/issues/comments/12'],
    ['api', 'repos/acme/notes/pulls/7/reviews/21'],
    ['api', 'repos/acme/notes/pulls/7/reviews/22'],
    ['api', 'repos/acme/notes/pulls/comments/31'],
    ['api', 'repos/acme/notes/pulls/7'],
    ['api', 'repos/acme/notes/issues/7/comments', '--paginate', '--slurp'],
  ]);
  const before = args().length;
  for (const url of ['https://evil.example/acme/notes/pull/7#issuecomment-11', 'https://gist.github.com/acme/notes/pull/7#issuecomment-11', 'https://evil.example/user-attachments/assets/abc-1']) {
    assert.equal(forge.changeEvidence('acme/notes', 7, url), null, url);
  }
  assert.equal(args().length, before, 'a link on another host asks GitHub nothing');
  // A pull request on a GitHub Enterprise host: its links count there, with that host named to gh, and github.com's do not.
  const enterprise = recorded((call) => (call.includes('repos/acme/notes/issues/comments/11') ? '{"issue_url":"https://ghe.example/api/v3/repos/acme/notes/issues/7"}' : '[[]]'));
  assert.equal(enterprise.forge.changeEvidence('acme/notes', 7, 'https://ghe.example/acme/notes/pull/7#issuecomment-11', { host: 'ghe.example' }), 'comment');
  assert.equal(enterprise.forge.changeEvidence('acme/notes', 7, `${pr}#issuecomment-11`, { host: 'ghe.example' }), null, 'github.com is another host there');
  assert.deepEqual(enterprise.args(), [['api', '--hostname', 'ghe.example', 'repos/acme/notes/issues/comments/11']]);
});

test('changeEvidence matches an attachment as a whole URL, never as part of a longer or a shorter one', () => {
  const body = [
    'Screens: ![shot](https://github.com/user-attachments/assets/abcdef) and <https://github.com/user-attachments/assets/auto-1>.',
    '<img src="https://github.com/user-attachments/assets/img-1" width="300">',
    'Bare: https://github.com/user-attachments/assets/bare-1, then https://github.com/user-attachments/assets/paren(1)',
  ].join('\n');
  const { forge } = recorded((call) => (call[1] === 'repos/acme/notes/pulls/7' ? JSON.stringify({ body }) : '[[]]'));
  const at = (id) => forge.changeEvidence('acme/notes', 7, `https://github.com/user-attachments/assets/${id}`);
  for (const id of ['abcdef', 'auto-1', 'img-1', 'bare-1']) assert.equal(at(id), 'attachment', id);
  assert.equal(at('abc'), null, 'a prefix of a linked URL is not linked');
  assert.equal(at('abcdef0'), null, 'a linked URL extended past its end is not linked');
  assert.equal(at('bare-1,'), null);
  assert.equal(at('paren'), null, 'a URL that runs on into a parenthesis is not read as a shorter one');
  assert.deepEqual([...linksIn('see [a](https://x.example/a.png). and https://x.example/b?c=1!')], ['https://x.example/a.png', 'https://x.example/b?c=1']);
});

test('linksIn keeps a destination its syntax delimits exactly, punctuation included; only a bare URL loses sentence punctuation', () => {
  const file = (end) => `https://github.com/user-attachments/files/123/report.txt${end}`;
  for (const end of ['!', '.', ',']) {
    for (const [syntax, text] of [
      ['inline link', `[evidence](${file(end)})`],
      ['inline link with a title', `[evidence](${file(end)} "the report")`],
      ['inline link in angle brackets', `[evidence](<${file(end)}>)`],
      ['image', `![shot](${file(end)})`],
      ['reference definition', `[evidence][r]\n\n[r]: ${file(end)}`],
      ['autolink', `<${file(end)}>`],
      ['src in double quotes', `<img src="${file(end)}" width="300">`],
      ['src in single quotes', `<img src='${file(end)}'>`],
      ['unquoted src', `<img src=${file(end)} alt=x>`],
      ['href', `<a href="${file(end)}">report</a>`],
    ]) assert.deepEqual([...linksIn(text)], [file(end)], `${syntax} ending in ${end}`);
    assert.deepEqual([...linksIn(`See ${file(end)}`)], [file('')], `a bare URL ending in ${end} is linked without it`);
  }
  // The changeEvidence the finding names: the real upload counts, the shorter URL the body never links does not.
  const { forge } = recorded((call) => (call[1] === 'repos/acme/notes/pulls/7' ? JSON.stringify({ body: `[evidence](${file('!')})` }) : '[[]]'));
  assert.equal(forge.changeEvidence('acme/notes', 7, file('!')), 'attachment');
  assert.equal(forge.changeEvidence('acme/notes', 7, file('')), null);
  // Rendered as GitHub renders them: escapes and character references read, balanced parentheses kept, code ignored.
  assert.deepEqual([...linksIn('[a](https://x.example/\\!x)')], ['https://x.example/!x']);
  assert.deepEqual([...linksIn('<a href="https://x.example/q?a=1&amp;b=2">q</a>')], ['https://x.example/q?a=1&b=2']);
  assert.deepEqual([...linksIn('<https://x.example/q?a=1&amp;b=2>')], ['https://x.example/q?a=1&amp;b=2'], 'an autolink keeps every character');
  assert.deepEqual([...linksIn('[a](https://x.example/a(1))')], ['https://x.example/a(1)']);
  assert.deepEqual([...linksIn('[a](https://x.example/a((1)))')], [], 'a target this cannot read whole is left out, never cut short');
  assert.deepEqual([...linksIn('`[a](https://x.example/c)` and `https://x.example/d`')], [], 'inline code links nothing');
  assert.deepEqual([...linksIn('```\r\n[e](https://x.example/f)\r\nhttps://x.example/g\r\n```\r\nthen https://x.example/h')], ['https://x.example/h'], 'a fence links nothing, up to its closing line');
  assert.deepEqual([...linksIn('~~~\nhttps://x.example/never-closed')], [], 'an unclosed fence runs to the end');
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
  for (const read of [forge.conversationComments, forge.reviews, forge.reviewComments]) assert.deepEqual(read('acme/notes', 7, { host: 'ghe.acme.io' }), [{ id: 1 }, { id: 2 }]);
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
