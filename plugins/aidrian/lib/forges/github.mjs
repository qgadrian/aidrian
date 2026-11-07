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
// How long an upload of images may take: a pull request's captures go up in one call.
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

// A file uploaded to GitHub, as a pull request's body or comment links it.
const ATTACHMENT = /^https:\/\/(?:github\.com\/user-attachments\/(?:assets|files)\/|github\.com\/[^/]+\/[^/]+\/(?:assets|files)\/|(?:private-)?user-images\.githubusercontent\.com\/)\S+$/u;

// The adapter for the repository at `cwd`. `run` is gh, the test seam: the adapter's methods call it, and it stays in
// this closure, so no caller of the facade gets a raw gh. Every method returns GitHub's payload, parsed, and throws
// what gh throws. A method that names no `repo` reads gh's default repository for `cwd`.
//
// `mediaType` keeps the two ways the plugin has always called GitHub's REST routes, each gh command as it was:
// - null, gh's default: no Accept header; a list's pages are joined, and an empty answer is an empty list.
// - a media type, such as GITHUB_JSON: every REST call sends it as its Accept header; an empty answer is null.
// `timeoutMs` bounds every call, for a hook that must answer inside its own limit; null keeps gh's (github-cli.mjs).
// A method that takes `{ host }` names that host to every REST call it makes (`--hostname`), as `aidrian pr auto-merge`
// does with the host of the pull request's URL; without one, gh picks its default host.
export function createGithubForge({ cwd, run = runGh, mediaType = null, timeoutMs = null } = {}) {
  const gh = (args, { timeoutMs: limit = timeoutMs } = {}) => run(args, { cwd, ...(limit === null ? {} : { timeoutMs: limit }) });
  const json = (args) => JSON.parse(gh(args));
  const given = (ref) => ref !== undefined && ref !== null && ref !== '';
  // One REST route. `paginate` reads every page and joins them into one list; `fields` are sent as `-f key=value`.
  const rest = (route, { paginate = false, method, fields, host } = {}) => {
    const args = ['api', ...(host ? ['--hostname', host] : []), route, ...(mediaType === null ? [] : ['--header', `Accept: ${mediaType}`])];
    if (paginate) args.push('--paginate', '--slurp');
    if (method) args.push('--method', method);
    for (const [key, value] of Object.entries(fields ?? {})) args.push('-f', `${key}=${value}`);
    if (mediaType === null) return paginate ? JSON.parse(gh(args) || '[]').flat() : json(args);
    const parsed = JSON.parse(gh(args) || 'null');
    return paginate && Array.isArray(parsed) ? parsed.flat() : parsed;
  };
  const list = (route, { host } = {}) => rest(route, { paginate: true, host });
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
    // The checks of the pull request `ref` (none: the current branch's), as `{ name, state }` rows. gh exits 8 while a
    // check is pending, with the rows on stdout: those rows are the answer. Any other failure throws as gh threw it.
    checks: (ref, { repo = null } = {}) => {
      try {
        return json(['pr', 'checks', ...(given(ref) ? [String(ref)] : []), ...(repo ? ['--repo', repo] : []), '--json', 'name,state']);
      } catch (error) {
        try {
          return JSON.parse(error?.stdout ?? '');
        } catch {
          throw error;
        }
      }
    },
    // `owner/name` of the default repository.
    repo: () => json(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner,
    // The repository itself, such as its `default_branch`.
    repository: (repo, { host } = {}) => rest(`repos/${repo}`, { host }),
    // One file of `repo` at `ref`, such as `refs/heads/main`: `{ type, encoding, content }`, its content base64.
    contents: (repo, file, ref, { host } = {}) => rest(`repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, { host }),
    // PUBLIC, PRIVATE, or INTERNAL.
    visibility: (repo) => json(['repo', 'view', repo, '--json', 'visibility']).visibility,
    // The login gh is signed in as.
    viewer: ({ host } = {}) => rest('user', { host })?.login,
    // The comments on the pull request's conversation, not those on its diff (reviewComments).
    conversationComments: (repo, n, { host } = {}) => list(`repos/${repo}/issues/${n}/comments`, { host }),
    postComment: (repo, n, body) => rest(`repos/${repo}/issues/${n}/comments`, { method: 'POST', fields: { body } }),
    editComment: (repo, id, body) => rest(`repos/${repo}/issues/comments/${id}`, { method: 'PATCH', fields: { body } }),
    // The reactions on the pull request itself; `content`, such as `+1`, keeps that one kind, read as the reviews report
    // always has: its paging flags before the route.
    reactions: (repo, n, content = null) => {
      const route = `repos/${repo}/issues/${n}/reactions${content === null ? '' : `?content=${encodeURIComponent(content)}`}`;
      return content !== null && mediaType === null ? json(['api', '--paginate', '--slurp', route]).flat() : list(route);
    },
    pull: (repo, n) => rest(`repos/${repo}/pulls/${n}`),
    reviews: (repo, n, { host } = {}) => list(`repos/${repo}/pulls/${n}/reviews`, { host }),
    reviewComments: (repo, n, { host } = {}) => list(`repos/${repo}/pulls/${n}/comments`, { host }),
    // What `url` links of pull request `n` of `repo`: "comment", "review", or "review_comment" for a link to one of the
    // pull request's own, "attachment" for an uploaded file its body, a comment, or a review links, or null when it is
    // no part of that pull request, or GitHub finds no such item (HTTP 404). Any other failure throws as gh threw it.
    changeEvidence: (repo, n, url) => {
      let parsed;
      try {
        parsed = new URL(String(url));
      } catch {
        return null;
      }
      if (parsed.protocol !== 'https:') return null;
      const found = (read) => {
        try {
          return read();
        } catch (error) {
          if (/\(HTTP 404\)/u.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`)) return null;
          throw error;
        }
      };
      const link = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^/]*)?\/?$/u.exec(parsed.pathname);
      if (link) {
        if (`${link[1]}/${link[2]}`.toLowerCase() !== String(repo).toLowerCase() || Number(link[3]) !== Number(n)) return null;
        const [, kind, id] = /^#(issuecomment-|pullrequestreview-|discussion_r)(\d+)$/u.exec(parsed.hash) ?? [];
        if (kind === 'issuecomment-') return String(found(() => rest(`repos/${repo}/issues/comments/${id}`))?.issue_url ?? '').endsWith(`/issues/${n}`) ? 'comment' : null;
        if (kind === 'pullrequestreview-') return found(() => rest(`repos/${repo}/pulls/${n}/reviews/${id}`)) ? 'review' : null;
        if (kind === 'discussion_r') return String(found(() => rest(`repos/${repo}/pulls/comments/${id}`))?.pull_request_url ?? '').endsWith(`/pulls/${n}`) ? 'review_comment' : null;
        return null;
      }
      if (!ATTACHMENT.test(parsed.href)) return null;
      const bodies = [found(() => rest(`repos/${repo}/pulls/${n}`))?.body, ...[`repos/${repo}/issues/${n}/comments`, `repos/${repo}/pulls/${n}/reviews`, `repos/${repo}/pulls/${n}/comments`].flatMap((route) => list(route) ?? []).map((each) => each?.body)];
      return bodies.some((body) => typeof body === 'string' && body.includes(String(url))) ? 'attachment' : null;
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
    commit: (repo, sha) => rest(`repos/${repo}/commits/${sha}`),
    // The check runs of one commit, every page.
    checkRuns: (repo, sha) => (list(`repos/${repo}/commits/${sha}/check-runs`) ?? []).flatMap((page) => page.check_runs ?? []),
    compare: (repo, base, head) => rest(`repos/${repo}/compare/${base}...${head}`),
    // Uploads image files to `repo` through the gh-image extension and returns what it prints: one Markdown image a file.
    // It may take UPLOAD_TIMEOUT_MS.
    uploadImages: (repo, files) => gh(['image', '--repo', repo, ...files], { timeoutMs: UPLOAD_TIMEOUT_MS }),
  });
}
