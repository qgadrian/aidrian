// The GitHub adapter of the forge facade: what the plugin asks of the code forge a pull request lives on, through gh
// (github-cli.mjs). Shared code calls the facade, from forgeFor in index.mjs, instead of a forge's commands and routes.
// Payloads stay GitHub's shapes until a second adapter gives a reason to change them.

import { runGh } from './github-cli.mjs';

// The author associations GitHub gives the people who belong to a repository.
// Frozen, with no add, and compared by === rather than through a prototype method, so no module in the gate's process
// can trust another association.
export const MEMBER_ASSOCIATIONS = Object.freeze({ has: (association) => association === 'OWNER' || association === 'MEMBER' || association === 'COLLABORATOR' });

// Whether GitHub says the comment's author belongs to the repository. Anyone can comment on a pull request.
export const isTrustedCommenter = (comment) => MEMBER_ASSOCIATIONS.has(comment?.author_association);

// Whether `name` is shaped like a GitHub login: letters, digits, and single hyphens between them, at most 39 characters.
export const isLogin = (name) => typeof name === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u.test(name);

// The REST media type `aidrian pr await-review` has always named: index.mjs passes it as `mediaType` for `strictJson`.
export const GITHUB_JSON = 'application/vnd.github+json';

// The review rounds of one pull request with their comments, at most PAGE of each, in one GraphQL call.
export const REVIEWS_PAGE = 100;
// The longest body GitHub takes for a comment, a review, or a review comment, in characters.
export const MAX_BODY = 65_536;
const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: ${REVIEWS_PAGE}) {
        totalCount
        nodes {
          author { login }
          commit { oid }
          comments(first: ${REVIEWS_PAGE}) { totalCount nodes { path originalLine diffHunk replyTo { id } originalCommit { oid } } }
        }
      }
    }
  }
}`;

// The review threads of one pull request, a page of 100 after the cursor `$after`, as `aidrian review bench` reads them.
const THREADS_QUERY = 'query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{path line originalLine originalCommit{oid} author{login}}}}}}}}';
// The review threads of one pull request with their comments, a page of 100 after the cursor `$after`, as the engine
// reads the thread of one of its findings (reviewThread) and resolves it (resolveThread). A comment's REST id is its
// `fullDatabaseId`, a 64-bit integer GitHub answers as a string (`databaseId` is deprecated: it does not hold 64 bits).
const FINDING_THREADS_QUERY = 'query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:100){totalCount nodes{fullDatabaseId body authorAssociation author{login}}}}}}}}';
// The most pages of threads one read walks: 10,000 threads.
const THREAD_PAGES = 100;
const RESOLVE_MUTATION = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';
// A comment's `fullDatabaseId` as the REST id the facade uses: a safe integer from digits alone, else null, so a value
// of any other shape matches no comment and names none.
const restId = (value) => {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  const number = /^\d{1,16}$/u.test(text) ? Number(text) : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
// A GraphQL node id as GitHub gives one, such as `PRRT_kwDO...`: checked before it goes back to GitHub as a variable.
const NODE_ID = /^[A-Za-z0-9_=+/-]{1,200}$/u;
// The pull request one GraphQL node id names, as the ready hold looks up an id a ready call names.
const NODE_QUERY = 'query($id:ID!){node(id:$id){... on PullRequest{url}}}';
// When a pull request's body and title last changed: the body's last edit and the newest title rename, as the ready
// checks hold reads whether a check an edit re-queues has had time to show.
const EDITS_QUERY = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){lastEditedAt timelineItems(last:1,itemTypes:[RENAMED_TITLE_EVENT]){nodes{... on RenamedTitleEvent{createdAt}}}}}}';
// How long an upload of images may take: a pull request's captures go up in one call.
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

// Whether a GitHub API URL of an issue or pull request, such as a comment's `issue_url`, names `kind` (`issues` or
// `pulls`) number `n` of `repo` exactly, on any API host.
const namesItem = (apiUrl, kind, repo, n) => {
  const match = /\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)$/u.exec(String(apiUrl ?? ''));
  return Boolean(match) && match[1].toLowerCase() === String(repo).toLowerCase() && match[2] === kind && Number(match[3]) === Number(n);
};

// gh's default host, which a call names only when it is another.
const DEFAULT_HOST = 'github.com';

// A pull request or comment number as a route takes it: a safe positive integer, given as a number or as digits alone.
// Anything else throws before any call, so no route is built from text a pull request supplies.
const idOf = (value, what) => {
  const number = typeof value === 'number' || (typeof value === 'string' && /^\d{1,16}$/u.test(value)) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${what} must be a positive whole number`);
  return number;
};

// Whether gh failed on an answer GitHub gave with a 4xx status, such as 422 for a review line outside the diff.
const clientError = (error) => /\(HTTP 4\d\d\)/u.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`);
// Whether gh failed on GitHub's 404.
const notFound = (error) => /\(HTTP 404\)/u.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`);

// One `gh pr checks` row in the forge's shape: its name and state, the workflow, event, and run that reported it, and
// `workflowId`, the workflow file's id (filled in by workflowIds), null until it is read. `host` and `repo` name the
// run's repository, from its link, for that read.
const RUN_LINK = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/|$)/u;
const checkRow = (row) => {
  const link = typeof row?.link === 'string' ? RUN_LINK.exec(row.link) : null;
  const text = (value) => (typeof value === 'string' && value !== '' ? value : null);
  return {
    name: row?.name, state: row?.state, workflow: text(row?.workflow), event: text(row?.event),
    run: link ? Number(link[3]) : null, host: link ? link[1] : null, repo: link ? link[2] : null, workflowId: null,
  };
};

// Fills in `workflowId` on every row of a run, once some workflow name and event is reported by more than one run: two
// workflow files may share a display name, so only the file's id tells a rerun from another workflow. `listRuns(host,
// repo)` gives the workflow runs of the pull request's head in that repository, every page of them, each with its `id`
// and `workflow_id`; it is called once for each repository the workflow rows' runs belong to, so a row with no workflow,
// such as an app's status that links to a run, chooses none. A run no list names, or one whose list fails, keeps null.
// Returns the rows.
function workflowIds(rows, listRuns) {
  const runs = new Map();
  const repos = new Map();
  const key = (host, repo) => `${host}/${repo}`;
  for (const row of rows) {
    if (row.run === null || !row.workflow) continue;
    const group = `${row.workflow}\u0000${row.event ?? ''}`;
    runs.set(group, (runs.get(group) ?? new Set()).add(row.run));
    repos.set(key(row.host, row.repo), { host: row.host, repo: row.repo });
  }
  if (![...runs.values()].some((each) => each.size > 1)) return rows;
  const ids = new Map();
  for (const { host, repo } of repos.values()) {
    try {
      for (const run of listRuns(host, repo)) {
        if (Number.isInteger(run?.id) && Number.isInteger(run.workflow_id)) ids.set(`${key(host, repo)}#${run.id}`, run.workflow_id);
      }
    } catch {
      // Unread: no run of this repository is taken for a rerun of another.
    }
  }
  for (const row of rows) row.workflowId = row.run === null ? null : ids.get(`${key(row.host, row.repo)}#${row.run}`) ?? null;
  return rows;
}

// The adapter for the repository at `cwd`. `run` is gh, the test seam: the adapter's methods call it, and it stays in
// this closure, so no caller of the facade gets a raw gh. Every method returns GitHub's payload, parsed, and throws
// what gh throws. A method that names no `repo` reads gh's default repository for `cwd`.
//
// `mediaType` keeps the two ways the plugin has always called GitHub's REST routes, each gh command as it was:
// - null, gh's default: no Accept header; a list's pages are joined, and an empty answer is an empty list.
// - a media type, such as GITHUB_JSON: every REST call sends it as its Accept header; an empty answer is null.
// `timeoutMs` bounds every call, for a hook that must answer inside its own limit; null keeps gh's (github-cli.mjs).
// `killSignal` stops a call at that bound with another signal, such as SIGKILL; null keeps gh's runner's default.
// A method that takes `{ host }` names that host to every REST call it makes (`--hostname`), as `aidrian pr auto-merge`
// does with the host of the pull request's URL; without one, gh picks its default host.
export function createGithubForge({ cwd, run = runGh, mediaType = null, timeoutMs = null, killSignal = null } = {}) {
  const gh = (args, { timeoutMs: limit = timeoutMs, input } = {}) =>
    run(args, { cwd, ...(limit === null ? {} : { timeoutMs: limit }), ...(killSignal === null ? {} : { killSignal }), ...(input === undefined ? {} : { input }) });
  const json = (args) => JSON.parse(gh(args));
  const given = (ref) => ref !== undefined && ref !== null && ref !== '';
  // One REST route. `paginate` reads every page and joins them into one list; `fields` are sent as `-f key=value`, each
  // value a literal string, and `input`, a request body, as JSON on gh's stdin: never `-F`, which reads a leading `@` as
  // a file and `true` as a boolean. `empty` reads an answer with no body, such as a delete's, as null.
  const rest = (route, { paginate = false, method, fields, input, empty = false, host } = {}) => {
    const args = ['api', ...(host ? ['--hostname', host] : []), route, ...(mediaType === null ? [] : ['--header', `Accept: ${mediaType}`])];
    if (paginate) args.push('--paginate', '--slurp');
    if (method) args.push('--method', method);
    for (const [key, value] of Object.entries(fields ?? {})) args.push('-f', `${key}=${value}`);
    if (input !== undefined) args.push('--input', '-');
    const answer = gh(args, input === undefined ? {} : { input: JSON.stringify(input) });
    if (empty) return answer.trim() === '' ? null : JSON.parse(answer);
    if (mediaType === null) return paginate ? JSON.parse(answer || '[]').flat() : JSON.parse(answer);
    const parsed = JSON.parse(answer || 'null');
    return paginate && Array.isArray(parsed) ? parsed.flat() : parsed;
  };
  const list = (route, { host } = {}) => rest(route, { paginate: true, host });
  // Each repository's web address as GitHub answers it (compareUrl), read once.
  const homes = new Map();
  // The review thread of pull request `n` whose first comment is the review comment `commentId`, as GitHub's GraphQL
  // node, or null when no thread starts there. Every page is read until it is found; a page that does not answer as
  // one, and more pages than THREAD_PAGES, throw.
  const threadAt = (repo, n, commentId) => {
    const number = idOf(n, 'a pull request number');
    const root = idOf(commentId, 'a comment id');
    const [owner, name, ...extra] = String(repo).split('/');
    if (!owner || !name || extra.length) throw new Error('a repository is owner/name');
    let after = null;
    for (let page = 0; page < THREAD_PAGES; page += 1) {
      const answer = json(['api', 'graphql', '-f', `query=${FINDING_THREADS_QUERY}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${number}`, ...(after ? ['-f', `after=${after}`] : [])]);
      const threads = answer?.data?.repository?.pullRequest?.reviewThreads;
      if (!Array.isArray(threads?.nodes)) throw new Error('GitHub answered the review threads with no list');
      // fullDatabaseId is a BigInt GitHub answers as a string: compared as text, and a null one matches nothing.
      const found = threads.nodes.find((thread) => {
        const full = thread?.comments?.nodes?.[0]?.fullDatabaseId;
        return (typeof full === 'string' || typeof full === 'number') && String(full) === String(root);
      });
      if (found) return found;
      if (threads.pageInfo?.hasNextPage !== true || typeof threads.pageInfo.endCursor !== 'string') return null;
      after = threads.pageInfo.endCursor;
    }
    throw new Error(`pull request #${number} has more than ${THREAD_PAGES * 100} review threads`);
  };
  return Object.freeze({
    id: 'github',
    cwd,
    isTrustedCommenter,
    // The pull request `ref` (a number, a branch, or a URL; none: the current branch's), with the gh `fields` named;
    // `repo` looks in that repository instead of the default one. With a `repo`, an empty `ref` still goes to gh, as the
    // merge guard has always sent it: gh needs an argument with `--repo`, and an empty one is the current branch's.
    change: (ref, fields, { repo = null } = {}) => {
      const target = given(ref) || (ref === '' && repo) ? [String(ref)] : [];
      return json(['pr', 'view', ...target, '--json', fields, ...(repo ? ['--repo', repo] : [])]);
    },
    // The merged pull requests, newest first, at most `limit`, each with the `fields` named; with `sinceMs`, only those
    // merged since then.
    mergedChanges: (limit, { sinceMs = null, fields = 'number,reviews' } = {}) => {
      const search = sinceMs === null ? [] : ['--search', `merged:>=${new Date(sinceMs).toISOString().slice(0, 19)}+00:00`];
      return json(['pr', 'list', '--state', 'merged', '--limit', String(limit), ...search, '--json', fields]);
    },
    // The open pull requests, at most `limit`, each with the `fields` named; `repo` lists that repository's.
    openChanges: (limit, fields, { repo = null } = {}) => json(['pr', 'list', '--state', 'open', '--limit', String(limit), '--json', fields, ...(repo ? ['--repo', repo] : [])]),
    // The checks of the pull request `ref` (none: the current branch's), as checkRow rows: `run` is the id of the Actions
    // workflow run in the row's link, null for a check no workflow run reports, such as an app's status, and
    // `workflowId` is read from the head's runs, on the link's host, once a workflow name has several (workflowIds). gh exits 8 while a check is
    // pending, with the rows on stdout: those rows are the answer. Any other failure throws as gh threw it.
    checks: (ref, { repo = null } = {}) => {
      const args = ['pr', 'checks', ...(given(ref) ? [String(ref)] : []), ...(repo ? ['--repo', repo] : []), '--json', 'name,state,workflow,event,link'];
      let rows;
      try {
        rows = json(args);
      } catch (error) {
        try {
          rows = JSON.parse(error?.stdout ?? '');
        } catch {
          throw error;
        }
      }
      if (!Array.isArray(rows)) return rows;
      const listRuns = (host, owner) => {
        const head = json(['pr', 'view', ...(given(ref) ? [String(ref)] : []), ...(repo ? ['--repo', repo] : []), '--json', 'headRefOid']).headRefOid;
        if (!/^[0-9a-f]{40}$/u.test(head ?? '')) return [];
        return rest(`repos/${owner}/actions/runs?head_sha=${head}&per_page=100`, { paginate: true, host }).flatMap((page) => page?.workflow_runs ?? []);
      };
      return workflowIds(rows.map(checkRow), listRuns);
    },
    // `owner/name` of the default repository.
    repo: () => json(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner,
    // The repository itself, such as its `default_branch`.
    repository: (repo, { host } = {}) => rest(`repos/${repo}`, { host }),
    // One file of `repo` at `ref`, such as `refs/heads/main`: `{ type, encoding, content }`, its content base64.
    contents: (repo, file, ref, { host } = {}) => rest(`repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, { host }),
    // One folder of a commit's tree, not recursive: `{ sha, tree: [{ path, mode, type, sha }], truncated }`, each entry's
    // `path` its name in the folder, `mode` git's, such as 100644, 120000 for a symbolic link, 160000 for a submodule, or
    // 040000 for a folder, whose `sha` reads it in turn. `sha` is a commit, whose root folder it reads, or a folder's.
    tree: (repo, sha, { host } = {}) => rest(`repos/${repo}/git/trees/${encodeURIComponent(sha)}`, { host }),
    // PUBLIC, PRIVATE, or INTERNAL.
    visibility: (repo) => json(['repo', 'view', repo, '--json', 'visibility']).visibility,
    // The login gh is signed in as.
    viewer: ({ host } = {}) => rest('user', { host })?.login,
    // The comments on the pull request's conversation, not those on its diff (reviewComments).
    conversationComments: (repo, n, { host } = {}) => list(`repos/${repo}/issues/${n}/comments`, { host }),
    // One comment of a conversation, by its id. With `pr`, it is held to that pull request of `repo`: a comment whose
    // `issue_url` names any other, or that GitHub does not find (HTTP 404), is null; any other failure throws.
    comment: (repo, id, { host, pr } = {}) => {
      const route = `repos/${repo}/issues/comments/${idOf(id, 'a comment id')}`;
      if (pr === undefined || pr === null) return rest(route, { host });
      const number = idOf(pr, 'a pull request number');
      let found;
      try {
        found = rest(route, { host });
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
      return namesItem(found?.issue_url, 'issues', repo, number) ? found : null;
    },
    postComment: (repo, n, body, { host } = {}) => rest(`repos/${repo}/issues/${idOf(n, 'a pull request number')}/comments`, { method: 'POST', fields: { body }, host }),
    editComment: (repo, id, body, { host } = {}) => rest(`repos/${repo}/issues/comments/${idOf(id, 'a comment id')}`, { method: 'PATCH', fields: { body }, host }),
    deleteComment: (repo, id) => rest(`repos/${repo}/issues/comments/${idOf(id, 'a comment id')}`, { method: 'DELETE', empty: true }),
    // One review of pull request `n`, with its inline comments, as one request: the event is always COMMENT, so a review
    // the engine posts never approves or requests changes, and no option sets another. `comments` are
    // { path, line, side, body }, `line` on the head `commitId`'s side of the diff. Returns { refused: false, id, comments },
    // the review's id and its inline comments as GitHub lists them ({ id, body, path, line }, null when that read fails),
    // or { refused: true } when GitHub answers with a 4xx status, such as a line outside the diff. Any other failure
    // throws as gh threw it.
    postReview: (repo, n, { commitId, body, comments = [] } = {}) => {
      const number = idOf(n, 'a pull request number');
      if (typeof commitId !== 'string' || !/^[0-9a-f]{40}$/u.test(commitId)) throw new Error('a review needs the full SHA of its commit');
      const request = {
        commit_id: commitId,
        body: String(body ?? ''),
        event: 'COMMENT',
        comments: comments.map((each) => ({ path: String(each.path), line: idOf(each.line, 'a line number'), side: each.side === 'LEFT' ? 'LEFT' : 'RIGHT', body: String(each.body) })),
      };
      let review;
      try {
        review = rest(`repos/${repo}/pulls/${number}/reviews`, { method: 'POST', input: request });
      } catch (error) {
        if (clientError(error)) return { refused: true };
        throw error;
      }
      const id = idOf(review?.id, 'the review id GitHub answered');
      let posted = null;
      try {
        posted = list(`repos/${repo}/pulls/${number}/reviews/${id}/comments`).map((each) => ({ id: each?.id, body: each?.body, path: each?.path, line: each?.line }));
      } catch {}
      return { refused: false, id, comments: posted };
    },
    // One review comment of pull request `n`, by its id, held to that pull request: one whose `pull_request_url` names any
    // other, or that GitHub does not find (HTTP 404), is null; any other failure throws.
    reviewComment: (repo, n, id) => {
      const number = idOf(n, 'a pull request number');
      let found;
      try {
        found = rest(`repos/${repo}/pulls/comments/${idOf(id, 'a comment id')}`);
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
      return namesItem(found?.pull_request_url, 'pulls', repo, number) ? found : null;
    },
    deleteReviewComment: (repo, id) => rest(`repos/${repo}/pulls/comments/${idOf(id, 'a comment id')}`, { method: 'DELETE', empty: true }),
    // The review thread of pull request `n` that review comment `commentId` starts: { resolved, complete, comments }, its
    // comments in order, the first one `commentId`, each { id, body, user: { login }, author_association } as the REST
    // reads give a comment; `complete` false when the thread holds more than the 100 read. Null when no thread of the
    // pull request starts at that comment. A failed read throws.
    reviewThread: (repo, n, commentId) => {
      const thread = threadAt(repo, n, commentId);
      if (!thread) return null;
      const nodes = Array.isArray(thread.comments?.nodes) ? thread.comments.nodes : [];
      return {
        resolved: thread.isResolved === true,
        complete: Number.isSafeInteger(thread.comments?.totalCount) && thread.comments.totalCount <= nodes.length,
        comments: nodes.map((each) => ({ id: restId(each?.fullDatabaseId), body: typeof each?.body === 'string' ? each.body : '', user: { login: each?.author?.login ?? null }, author_association: each?.authorAssociation ?? null })),
      };
    },
    // A reply in the thread of review comment `commentId` of pull request `n`: one POST, its body a raw -f field, which
    // gh never reads as a file or a boolean. Returns the reply as GitHub answers it, with its `id`.
    replyToReviewComment: (repo, n, commentId, body) => rest(`repos/${repo}/pulls/${idOf(n, 'a pull request number')}/comments/${idOf(commentId, 'a comment id')}/replies`, { method: 'POST', fields: { body: String(body ?? '') } }),
    // Resolves the review thread of pull request `n` that review comment `commentId` starts: the thread is found by that
    // comment's id, so no caller handles a GraphQL node id. With `only`, the ids of the comments the caller allows in the
    // thread (its root and the caller's own replies), the thread as read just now must hold no other comment and be read
    // whole; else nothing is resolved and it answers { resolved: false, others: true }, so a reply that landed since the
    // caller's own read keeps the thread open. Returns { resolved: true } for a thread resolved, by this call or before;
    // throws when no thread starts there, when the call fails, or when GitHub does not answer that it is resolved.
    resolveThread: (repo, n, commentId, { only } = {}) => {
      const listed = Array.isArray(only) ? only : [only];
      const allowed = only === undefined ? null : new Set(listed.map((id) => idOf(id, 'a comment id')));
      const thread = threadAt(repo, n, commentId);
      if (!thread) throw new Error('no review thread of the pull request starts at that comment');
      if (thread.isResolved === true) return { resolved: true };
      if (allowed) {
        const nodes = Array.isArray(thread.comments?.nodes) ? thread.comments.nodes : [];
        const whole = Number.isSafeInteger(thread.comments?.totalCount) && thread.comments.totalCount <= nodes.length;
        if (!whole || nodes.some((each) => !allowed.has(restId(each?.fullDatabaseId)))) return { resolved: false, others: true };
      }
      if (typeof thread.id !== 'string' || !NODE_ID.test(thread.id)) throw new Error('GitHub answered the review thread with no id');
      const answer = json(['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `id=${thread.id}`]);
      if (answer?.data?.resolveReviewThread?.thread?.isResolved !== true) throw new Error('GitHub did not resolve the review thread');
      return { resolved: true };
    },
    // The reactions on the pull request itself; `content`, such as `+1`, keeps that one kind, read as the reviews report
    // always has: its paging flags before the route.
    reactions: (repo, n, content = null) => {
      const route = `repos/${repo}/issues/${n}/reactions${content === null ? '' : `?content=${encodeURIComponent(content)}`}`;
      return content !== null && mediaType === null ? json(['api', '--paginate', '--slurp', route]).flat() : list(route);
    },
    pull: (repo, n, { host } = {}) => rest(`repos/${repo}/pulls/${n}`, { host }),
    // The pull request `ref`'s diff, as gh prints it: text, not JSON. `repo` reads it from that repository.
    diff: (ref, { repo = null } = {}) => gh(['pr', 'diff', String(ref), ...(repo ? ['--repo', repo] : [])]),
    // The pull request a GraphQL node id names: GitHub's answer, `data.node.url`, whose node is null for any other id.
    nodeChange: (id) => json(['api', 'graphql', '-f', `query=${NODE_QUERY}`, '-f', `id=${id}`]),
    // Every changed file of the pull request, each as GitHub's REST entry ({ filename, status, ... }), all pages, 100 a
    // page. GitHub lists at most 3000; `gh pr view` lists at most 100. The list names no commit: it is the head now.
    changeFiles: (repo, n, { host } = {}) => list(`repos/${repo}/pulls/${n}/files?per_page=100`, { host }),
    reviews: (repo, n, { host } = {}) => list(`repos/${repo}/pulls/${n}/reviews`, { host }),
    reviewComments: (repo, n, { host } = {}) => list(`repos/${repo}/pulls/${n}/comments`, { host }),
    // What `url` links of pull request `n` of `repo`: "comment" for its issue comment (`#issuecomment-<id>`), "review"
    // for its review (`#pullrequestreview-<id>`), or "review_comment" for its review comment (`#discussion_r<id>`), each
    // read by its id and held to this pull request; or null for any other URL, such as an uploaded file's, or when
    // GitHub finds no such item (HTTP 404). Any other failure throws as gh threw it. `host` is the GitHub host the pull
    // request lives on, github.com unless named: a link on any other host is no part of it, and is never asked about.
    // `withBody` answers { kind, body } instead, the item's text as GitHub holds it, so a caller can tell whose post it is.
    changeEvidence: (repo, n, url, { host = DEFAULT_HOST, withBody = false } = {}) => {
      let parsed;
      try {
        parsed = new URL(String(url));
      } catch {
        return null;
      }
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== String(host).toLowerCase()) return null;
      const link = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^/]*)?\/?$/u.exec(parsed.pathname);
      const [, kind, id] = /^#(issuecomment-|pullrequestreview-|discussion_r)(\d+)$/u.exec(parsed.hash) ?? [];
      if (!link || !kind || `${link[1]}/${link[2]}`.toLowerCase() !== String(repo).toLowerCase() || Number(link[3]) !== Number(n)) return null;
      // github.com is gh's default host, so its calls name none, as every other method's do.
      const at = parsed.hostname.toLowerCase() !== DEFAULT_HOST ? { host: parsed.hostname } : {};
      const found = (route) => {
        try {
          return rest(route, at);
        } catch (error) {
          if (notFound(error)) return null;
          throw error;
        }
      };
      const answer = (item, name) => {
        if (!item) return null;
        return withBody ? { kind: name, body: typeof item.body === 'string' ? item.body : '' } : name;
      };
      if (kind === 'issuecomment-') {
        const item = found(`repos/${repo}/issues/comments/${id}`);
        return answer(namesItem(item?.issue_url, 'issues', repo, n) ? item : null, 'comment');
      }
      if (kind === 'pullrequestreview-') return answer(found(`repos/${repo}/pulls/${n}/reviews/${id}`), 'review');
      const item = found(`repos/${repo}/pulls/comments/${id}`);
      return answer(namesItem(item?.pull_request_url, 'pulls', repo, n) ? item : null, 'review_comment');
    },
    // The reviews with their inline comments, GitHub's GraphQL answer: `data.repository.pullRequest.reviews`, at most
    // REVIEWS_PAGE of each, with each list's `totalCount`.
    reviewsWithComments: (repo, n) => {
      const [owner, name] = repo.split('/');
      return json(['api', 'graphql', '-f', `query=${REVIEWS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${n}`]);
    },
    // One page of the review threads, each with its first comment, after the cursor `after` (null: the first page):
    // GitHub's GraphQL answer, `data.repository.pullRequest.reviewThreads` with its `pageInfo`.
    reviewThreads: (repo, n, after = null) => {
      const [owner, name] = repo.split('/');
      return json(['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `o=${owner}`, '-F', `r=${name}`, '-F', `n=${n}`, ...(after ? ['-f', `after=${after}`] : [])]);
    },
    // When the body of pull request `n` of `repo` was last edited and its title last renamed, GitHub's GraphQL answer:
    // `data.repository.pullRequest` with `lastEditedAt` (null when never edited) and `timelineItems.nodes`, the newest
    // rename's `createdAt` or none.
    changeEdits: (repo, n, { host } = {}) => {
      const [owner, name] = repo.split('/');
      return json(['api', 'graphql', ...(host ? ['--hostname', host] : []), '-f', `query=${EDITS_QUERY}`, '-F', `o=${owner}`, '-F', `r=${name}`, '-F', `n=${n}`]);
    },
    commit: (repo, sha) => rest(`repos/${repo}/commits/${sha}`),
    // The check runs of one commit, every page.
    checkRuns: (repo, sha) => (list(`repos/${repo}/commits/${sha}/check-runs`) ?? []).flatMap((page) => page.check_runs ?? []),
    compare: (repo, base, head) => rest(`repos/${repo}/compare/${base}...${head}`),
    // The web link that shows the commits from `from` to `to` of `repo` (R9), on the forge's own identity of that
    // repository: the `html_url` GitHub answers for it, read once per repository, so a GitHub Enterprise repository
    // links to its own host. Built only from two full-hex SHAs, an owner login and a repository name GitHub accepts, and
    // an https `html_url` on a host name whose path names that same repository. Anything else, and a read that fails,
    // gives null; with SHAs or a name that fail, no call is made.
    compareUrl: (repo, from, to) => {
      const [owner, name, ...extra] = typeof repo === 'string' ? repo.split('/') : [];
      const sha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
      const named = isLogin(owner) && extra.length === 0 && typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/u.test(name) && name !== '.' && name !== '..';
      if (!sha(from) || !sha(to) || !named) return null;
      const key = `${owner}/${name}`.toLowerCase();
      if (!homes.has(key)) {
        let home = null;
        try {
          home = new URL(String(rest(`repos/${owner}/${name}`)?.html_url ?? ''));
        } catch {}
        const own = home && home.protocol === 'https:' && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/iu.test(home.hostname) && !home.port && !home.search && !home.hash
          && home.pathname.replace(/\/+$/u, '').toLowerCase() === `/${key}`;
        homes.set(key, own ? `https://${home.hostname.toLowerCase()}${home.pathname.replace(/\/+$/u, '')}` : null);
      }
      return homes.get(key) === null ? null : `${homes.get(key)}/compare/${from}...${to}`;
    },
    // The deployments of exactly the commit `sha`, the first page, and the statuses of one deployment, the first page.
    deployments: (repo, sha, { host } = {}) => rest(`repos/${repo}/deployments?sha=${encodeURIComponent(sha)}`, { host }),
    deploymentStatuses: (repo, id, { host } = {}) => rest(`repos/${repo}/deployments/${id}/statuses`, { host }),
    // Uploads image files to `repo` through the gh-image extension and returns what it prints: one Markdown image a file.
    // It may take UPLOAD_TIMEOUT_MS.
    uploadImages: (repo, files) => gh(['image', '--repo', repo, ...files], { timeoutMs: UPLOAD_TIMEOUT_MS }),
  });
}
