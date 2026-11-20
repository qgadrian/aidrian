// The GitHub adapter of the forge facade: what the plugin asks of the code forge a pull request lives on, through gh
// (github-cli.mjs). Shared code calls the facade, from forgeFor in index.mjs, instead of a forge's commands and routes.
// Payloads stay GitHub's shapes until a second adapter gives a reason to change them, but for changesState's row, which
// is the forge-neutral shape of a change request that the session snapshot shows.

import { isRefName } from '../git.mjs';
import { hasHidden } from '../hidden-text.mjs';
import { runGh } from './github-cli.mjs';

// The author associations GitHub gives the people who belong to a repository.
// Frozen, with no add, and compared by === rather than through a prototype method, so no module in the gate's process
// can trust another association.
export const MEMBER_ASSOCIATIONS = Object.freeze({ has: (association) => association === 'OWNER' || association === 'MEMBER' || association === 'COLLABORATOR' });

// Whether GitHub says the comment's author belongs to the repository. Anyone can comment on a pull request.
export const isTrustedCommenter = (comment) => MEMBER_ASSOCIATIONS.has(comment?.author_association);

// Whether `name` is shaped like a GitHub login: letters, digits, and single hyphens between them, at most 39 characters.
export const isLogin = (name) => typeof name === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u.test(name);

// The adapter's id, which forgeFor's caller keys a forge's readers by and every row changesState gives carries.
const FORGE_ID = 'github';
// The hosts this adapter serves, as a constant in its own source: no config, remote, ledger row, or cache adds one.
export const FORGE_HOSTS = Object.freeze(['github.com']);
// A GitHub repository name: letters, digits, `.`, `_`, and `-`, at most 100 characters, and never `.` or `..`.
const REPOSITORY_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u;

// The repository check of the facade: given a repository's identity as repoIdentity reads it, `{ host, path }`, the
// repository as gh names it, `<host>/<owner>/<name>`, or null. Only for a host of FORGE_HOSTS, named by the constant, and
// a path of exactly two segments, an owner shaped as a login and a repository name.
export function servedRepository(identity) {
  const host = FORGE_HOSTS.find((each) => each === identity?.host);
  const parts = typeof identity?.path === 'string' ? identity.path.split('/') : [];
  if (!host || parts.length !== 2 || !isLogin(parts[0]) || !REPOSITORY_NAME.test(parts[1])) return null;
  return `${host}/${parts[0]}/${parts[1]}`;
}

// The largest pull request number a GraphQL call takes: GitHub's `Int` is a signed 32-bit integer, and one variable past
// it fails the whole operation, every alias of a batch included. REST ids, such as a comment's, stay unbounded.
const GRAPHQL_INT_MAX = 2_147_483_647;
const isChangeNumber = (number) => Number.isSafeInteger(number) && number > 0 && number <= GRAPHQL_INT_MAX;

// A change request's ref, the one shape check of a ref before it is written to the session's ledger or read: given
// `{ host, path, number, branch }`, host and path as repoIdentity reads them, the frozen `{ host, owner, name, number,
// branch }`, or null unless servedRepository names the repository, a number is a positive integer GraphQL's Int holds
// (GRAPHQL_INT_MAX), so one ref's number never fails a batch, a branch passes
// isRefName (git's ref-name rules within 255 bytes) and holds no hidden character (hidden-text.mjs), and one of the two
// is given. Text only: it starts no process.
export function changeRef(fields) {
  const { host, path, number = null, branch = null } = fields !== null && typeof fields === 'object' ? fields : {};
  const repository = servedRepository({ host, path });
  const numbered = number === null || isChangeNumber(number);
  const named = branch === null || (isRefName(branch) && !hasHidden(branch));
  if (repository === null || !numbered || !named || (number === null && branch === null)) return null;
  const [owner, name] = path.split('/');
  return Object.freeze({ host, owner, name, number, branch });
}

// The most refs one changesState call reads, as the security gate set it.
export const MAX_CHANGE_REFS = 25;
// The most entries a row's `closes` holds, and the most closing references the read asks for.
const MAX_CLOSES = 10;
// The one host changesState asks, named to gh as a constant, so neither GH_HOST nor any ref's text picks another: gh sends
// GH_ENTERPRISE_TOKEN to any host but github.com.
const CHANGES_HOST = 'github.com';
// The pull requests of one head branch read, newest first, in the ref's repository and again in its parent's.
// SHORTCUT: GitHub filters pullRequests(headRefName:) by the branch's name alone, from any head repository, so 5 or more
// newer pull requests from forks' branches of the same name crowd out the row's own, which then shows nothing; and on a
// page GitHub says has more (hasNextPage) an older, better-ranked one may lie past it, so there answeredChange takes only
// a pick of the top class and shows nothing otherwise. Enough for display data; paging until the row's own head repository answers would replace it.
// (Ref.associatedPullRequests lists other forks' pull requests too, and ignores orderBy, so it is no fix.)
// SHORTCUT: every pull request read here carries its body text and closing references (CHANGE_FIELDS), the picked one's
// and the others' alike, so one call reads at most MAX_CHANGE_REFS * 2 * HEAD_CHANGES bodies (250) of MAX_BODY characters
// each to keep one row per ref. Picking first and reading the pick's body after would need a second call, which the
// snapshot's one batched read rules out.
const HEAD_CHANGES = 5;
// What changesState reads of one pull request. statusCheckRollup's counts by state cover every check of the head commit,
// however many, with no page of them read (GitHub's StatusCheckRollupContextConnection).
// SHORTCUT: unresolvedThreads counts the unresolved threads among the first 100 alone. Enough for display data; paging
// reviewThreads, as findingThreads does, would replace it.
// bodyText and closingIssuesReferences give the row's `closes` (closesOf), with viewerDidAuthor and authorAssociation,
// which say whose body it is; bodyText holds no HTML comment, so a pull request template's commented placeholder never
// matches, and the body itself never leaves the adapter.
const CHANGE_FIELDS = 'fragment change on PullRequest { number title url isDraft state mergeable reviewDecision createdAt headRefName viewerDidAuthor authorAssociation '
  + `bodyText closingIssuesReferences(first: ${MAX_CLOSES}) { nodes { number repository { name owner { login } } } } `
  + 'headRepository { name owner { login } } repository { name owner { login } } reviewThreads(first: 100) { nodes { isResolved } } '
  + 'commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 1) { checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } } }';
const headChanges = (index) => `pullRequests(headRefName: $b${index}, first: ${HEAD_CHANGES}, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...change } pageInfo { hasNextPage } }`;

// The one query operation for `refs`, as changeRef gave them: its text is built from each ref's index and kind alone, a
// number or a branch, and every value is a variable (changesVariables). No root field: a non-null one a token cannot
// resolve, such as an app installation token's viewer, nulls the whole `data`; each pull request says itself whether the
// token's user wrote it (viewerDidAuthor), which ranks a branch's pull requests (answeredChange). Never a mutation.
function changesQuery(refs) {
  const head = refs.map((ref, i) => `$o${i}: String!, $n${i}: String!, ${ref.number === null ? `$b${i}: String!` : `$p${i}: Int!`}`);
  const body = refs.map((ref, i) => `r${i}: repository(owner: $o${i}, name: $n${i}) { ${ref.number === null ? `${headChanges(i)} parent { ${headChanges(i)} }` : `pullRequest(number: $p${i}) { ...change }`} }`);
  return `query changes(${head.join(', ')}) { ${body.join(' ')} }\n${CHANGE_FIELDS}`;
}
const changesVariables = (refs) => Object.assign({}, ...refs.map((ref, i) => ({ [`o${i}`]: ref.owner, [`n${i}`]: ref.name, ...(ref.number === null ? { [`b${i}`]: ref.branch } : { [`p${i}`]: ref.number }) })));

// The `data` of a GraphQL answer: gh's stdout, read on a non-zero exit too, since an answer that holds errors still holds
// the aliases that resolved. One that does not parse, or holds no data object, throws, as gh's own failure does.
function changesData(call) {
  let text;
  try {
    text = call();
  } catch (error) {
    if (typeof error?.stdout !== 'string' || error.stdout.trim() === '') throw error;
    text = error.stdout;
  }
  const data = JSON.parse(text)?.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('GitHub answered no data');
  return data;
}

const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const createdAt = (node) => {
  const time = Date.parse(node?.createdAt);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
};

// How a branch's pull requests rank, best first: the token's user's own (viewerDidAuthor), then one whose author belongs
// to the repository (MEMBER_ASSOCIATIONS; any other association, or none, is an outsider's), then an open one, then the
// newest. Anyone can open a pull request from a branch of any name, so an outsider's never outranks a member's.
const own = (node) => Number(node?.viewerDidAuthor === true);
const trusted = (node) => Number(MEMBER_ASSOCIATIONS.has(node?.authorAssociation));
const open = (node) => Number(node?.state === 'OPEN');
const byRank = (a, b) => own(b) - own(a) || trusted(b) - trusted(a) || open(b) - open(a) || createdAt(b) - createdAt(a);
// How gh itself ranks a branch's pull requests when a `gh pr` call names a branch or none: an open one, then the newest
// (pkg/cmd/pr/shared/finder.go). A ref whose `rank` is 'open', a touched row's, resolves as the call it records did.
const byOpen = (a, b) => open(b) - open(a) || createdAt(b) - createdAt(a);

// The pull request one alias of the answer gives `ref`: a number's own; for a branch, the first by byRank of those whose
// head is that branch of the ref's repository, in the repository or its parent, so a fork's pull request from a branch of
// the same name never resolves it, a branch pushed to a fork resolves to its pull request on the parent, and another
// author's newer pull request from the same branch never replaces the token's user's, nor an outsider's a member's;
// with `order` byOpen, as gh's own lookup ranks them. Else null. When either page is cut off, its pageInfo.hasNextPage
// true, an older, better one may lie past it, so the pick must be of the top class its order gives, an open one for
// byOpen and the token user's own open one for byRank, else it is null: it fails closed, as the crowding SHORTCUT does.
// A page with no pageInfo is read as whole.
function answeredChange(ref, alias, order = byRank) {
  if (ref.number !== null) return alias?.pullRequest ?? null;
  const connections = [alias?.pullRequests, alias?.parent?.pullRequests];
  const pages = connections.map((each) => (Array.isArray(each?.nodes) ? each.nodes : []));
  const heads = pages.flat().filter((node) => sameName(node?.headRepository?.owner?.login, ref.owner) && sameName(node?.headRepository?.name, ref.name) && node?.headRefName === ref.branch);
  const best = heads.sort(order)[0] ?? null;
  const top = (node) => open(node) === 1 && (order === byOpen || own(node) === 1);
  return best && connections.some((each) => each?.pageInfo?.hasNextPage === true) && !top(best) ? null : best;
}

const STATES = Object.freeze({ OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' });
const MERGEABLE = Object.freeze({ MERGEABLE: true, CONFLICTING: false });
const DECISIONS = Object.freeze({ APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required' });
// The count each state of a check run or a status context adds to, as gh pr checks sorts them; any other state, such as
// QUEUED, IN_PROGRESS, WAITING, EXPECTED, or STALE, is pending.
const CHECK_STATES = Object.freeze({
  SUCCESS: 'passed', SKIPPED: 'skipped', NEUTRAL: 'skipped',
  FAILURE: 'failed', ERROR: 'failed', CANCELLED: 'failed', TIMED_OUT: 'failed', ACTION_REQUIRED: 'failed', STARTUP_FAILURE: 'failed',
});
const pick = (table, key, otherwise = null) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : otherwise);

// { passed, failed, pending, skipped }, from the counts by state of a head commit's rollup, with no check-name rule.
function checkCounts(contexts) {
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 };
  const byState = [contexts?.checkRunCountsByState, contexts?.statusContextCountsByState].flatMap((list) => (Array.isArray(list) ? list : []));
  for (const each of byState) {
    if (Number.isSafeInteger(each?.count) && each.count >= 0) counts[pick(CHECK_STATES, each.state, 'pending')] += each.count;
  }
  return counts;
}

// GitHub's closing keywords (docs.github.com, "Linking a pull request to an issue"), compared in lower case.
const CLOSING_WORDS = new Set(['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']);
// A word not preceded by a letter or digit, an optional `:`, 1 to 8 spaces or tabs, then a tracker-shaped key not
// followed by a letter or digit. ASCII classes with no `i` flag, so no other script's letter folds into one; every
// quantifier is bounded, so the scan is linear in the text's length. Which words count is CLOSING_WORDS'.
const CLOSING_KEY = /(?<![A-Za-z0-9])([A-Za-z]{3,8}):?[ \t]{1,8}([A-Za-z][A-Za-z0-9]{0,15}-[0-9]{1,9})(?![A-Za-z0-9])/gu;

// The issue references a pull request says it closes, at most MAX_CLOSES distinct, in order: `#<n>` for each of GitHub's
// closing references to an issue of the pull request's own repository (`owner`, `name`), a number GraphQL's Int holds
// (isChangeNumber), from any author, unlike a body key, since GitHub itself made them and they are display only, never
// looked up (a `#N` has no lookup). GitHub links an issue a closing keyword names only
// for a pull request into the default branch; an issue linked by hand in the sidebar has no branch rule. Then, only
// when the token's user wrote the pull request or its author belongs to the repository (own, trusted: anyone can open
// a pull request and write its body),
// each key of the first MAX_BODY characters of its body text that follows one of GitHub's closing keywords, as written.
// A body longer than MAX_BODY is cut there, so a key that ends at the cut may be the start of a longer one, and is
// dropped. Each key needs its own keyword, as GitHub's own rule for issues. No prefix list: shared code keeps the keys its
// project tracks. Only the keys leave: no other character of the body.
function closesOf(node, owner, name) {
  const refs = Array.isArray(node?.closingIssuesReferences?.nodes) ? node.closingIssuesReferences.nodes : [];
  const same = refs.filter((ref) => sameName(ref?.repository?.owner?.login, owner) && sameName(ref?.repository?.name, name) && isChangeNumber(ref.number));
  const closes = new Set(same.map((ref) => `#${ref.number}`));
  // Membership is judged on the pull request's own repository, so a third-party repository's owner is trusted there:
  // accepted, as it reaches no further than the title rule does (prefix-matched, at most 3 keys a pull request).
  const text = (own(node) || trusted(node)) && typeof node.bodyText === 'string' ? node.bodyText : '';
  const body = text.slice(0, MAX_BODY);
  const cut = text.length > body.length;
  for (const match of body.matchAll(CLOSING_KEY)) {
    // SHORTCUT: the cap applies before shared code filters by prefix and origin, so ten other entries, or case variants
    // of one key, crowd out an eligible key. Accepted as contrived: a pull request rarely links ten issues.
    if (closes.size >= MAX_CLOSES) break;
    if (cut && match.index + match[0].length === body.length) continue;
    if (CLOSING_WORDS.has(match[1].toLowerCase())) closes.add(match[2]);
  }
  return [...closes].slice(0, MAX_CLOSES);
}

// One pull request as the forge-neutral row (docs/providers/adding-a-host.md#adding-a-forge), or null when its owner,
// name, number, or state has no GitHub shape. `url` is built from the owner, name, and number GitHub answered, and kept
// only when GitHub's own url equals it. `closes` is closesOf's, `[]` when the pull request names none.
function changeRow(node) {
  const owner = node?.repository?.owner?.login;
  const name = node?.repository?.name;
  const number = node?.number;
  if (typeof owner !== 'string' || typeof name !== 'string' || changeRef({ host: CHANGES_HOST, path: `${owner}/${name}`, number }) === null) return null;
  if (pick(STATES, node.state) === null) return null;
  const url = `https://${CHANGES_HOST}/${owner}/${name}/pull/${number}`;
  const threads = Array.isArray(node.reviewThreads?.nodes) ? node.reviewThreads.nodes : [];
  return {
    forge: FORGE_ID, host: CHANGES_HOST, repo: `${owner}/${name}`.toLowerCase(), number, title: typeof node.title === 'string' ? node.title : '',
    url: node.url === url ? url : null, isDraft: node.isDraft === true, state: pick(STATES, node.state), mergeable: pick(MERGEABLE, node.mergeable),
    reviewDecision: pick(DECISIONS, node.reviewDecision), unresolvedThreads: threads.filter((thread) => thread?.isResolved === false).length,
    checks: checkCounts(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts), closes: closesOf(node, owner, name),
  };
}

// The REST media type `aidrian pr await-review` has always named: index.mjs passes it as `mediaType` for `strictJson`.
export const GITHUB_JSON = 'application/vnd.github+json';

// The review rounds of one pull request with their comments, at most PAGE of each, in one GraphQL call.
export const REVIEWS_PAGE = 100;
// The longest body GitHub takes for a comment, a review, or a review comment, in characters; and the most characters of
// a pull request's body text closesOf scans for closing keys, a bound GitHub's own pull request body limit matches.
export const MAX_BODY = 65_536;

// The forge CLI's subcommands that write the user's own config, which the agent gates hook refuses to a session no Human
// attends (lib/unattended-write.mjs): gh's config, its extensions, and its login, and `gh auth setup-git`, which writes
// the user's git config. Each is { programs, subcommands, valueOptions, what }, `valueOptions` gh's global options that
// take the next word.
const GH_VALUES = Object.freeze(['-R', '--repo', '--hostname', '-h']);
export const CONFIG_COMMANDS = Object.freeze([
  { programs: ['gh'], subcommands: [['config', 'set'], ['extension', 'install']], valueOptions: GH_VALUES, what: 'the forge CLI\'s own config' },
  { programs: ['gh'], subcommands: [['auth', 'login'], ['auth', 'logout'], ['auth', 'switch'], ['auth', 'refresh']], valueOptions: GH_VALUES, what: 'the forge CLI\'s own login' },
  { programs: ['gh'], subcommands: [['auth', 'setup-git']], valueOptions: GH_VALUES, what: 'the user\'s git config' },
  { programs: ['gh'], subcommands: [['alias', 'set'], ['alias', 'import'], ['alias', 'delete']], valueOptions: GH_VALUES, what: 'the forge CLI\'s own config' },
]);

// The forge CLI's subcommands that change what the forge releases or runs, or the repository's own settings, which the
// agent gate hook refuses to a project run's issue session (lib/issue-forge-guard.mjs): with the token its sandbox
// keeps, one would publish a release, start a workflow with the repository's secrets, rerun a deploy, or make a
// repository or gist to push the work to. Each is
// { programs, subcommands, valueOptions, what }, as CONFIG_COMMANDS; the forms that only read, such as `gh release
// list`, pass.
export const REF_COMMANDS = Object.freeze([
  { programs: ['gh'], subcommands: [['release', 'create'], ['release', 'delete'], ['release', 'edit'], ['release', 'upload'], ['release', 'delete-asset']], valueOptions: GH_VALUES, what: 'a release on the forge' },
  { programs: ['gh'], subcommands: [['workflow', 'run'], ['workflow', 'enable'], ['workflow', 'disable']], valueOptions: GH_VALUES, what: 'a workflow on the forge, which runs with the repository\'s secrets' },
  { programs: ['gh'], subcommands: [['run', 'rerun'], ['run', 'cancel'], ['run', 'delete']], valueOptions: GH_VALUES, what: 'a workflow run on the forge, which may run with the repository\'s secrets' },
  { programs: ['gh'], subcommands: [['secret', 'set'], ['secret', 'delete'], ['secret', 'remove'], ['variable', 'set'], ['variable', 'delete']], valueOptions: GH_VALUES, what: 'the repository\'s secrets or variables' },
  { programs: ['gh'], subcommands: [['repo', 'edit'], ['repo', 'delete'], ['repo', 'rename'], ['repo', 'archive'], ['repo', 'unarchive'], ['repo', 'sync'], ['repo', 'deploy-key', 'add'], ['repo', 'deploy-key', 'delete'], ['cache', 'delete']], valueOptions: GH_VALUES, what: 'the repository\'s settings, keys, or caches' },
  { programs: ['gh'], subcommands: [['ssh-key', 'add'], ['ssh-key', 'delete'], ['gpg-key', 'add'], ['gpg-key', 'delete']], valueOptions: GH_VALUES, what: 'the keys of the forge account' },
  { programs: ['gh'], subcommands: [['repo', 'create'], ['repo', 'fork'], ['gist', 'create']], valueOptions: GH_VALUES, what: 'a new repository, fork, or gist on the forge, where the token it keeps could copy the work and push anything' },
]);

// The folders of a repository whose files the forge runs, with the repository's secrets, on a push to any branch:
// GitHub's workflows, and the actions a workflow calls from the repository. A project run's issue session never writes
// them (lib/unattended-write.mjs).
export const WORKFLOW_FOLDERS = Object.freeze(['.github/workflows', '.github/actions']);

// gh api's options that take the next word, and those of them that send a field, which makes gh's default method POST.
const API_VALUES = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '--input', '-H', '--header', '-q', '--jq', '-t', '--template', '-p', '--preview', '--hostname', '--cache']);
const API_FIELDS = new Set(['-f', '--raw-field', '-F', '--field', '--input']);
// The REST routes of a repository an issue session writes: its pull request's and issues' comments, reviews, labels, and
// reviewers, and a pull request itself, but never a merge. Any other writing route, such as git refs, tags, releases,
// dispatches, contents, statuses, Actions' secrets and variables, rulesets, or the repository's settings, is refused.
const ISSUE_ROUTES = /^repos\/[^/]+\/[^/]+\/(?:pulls(?:\/\d+(?:\/(?:comments|reviews|requested_reviewers|update-branch)(?:\/[^/]+)*)?)?|pulls\/comments\/\d+(?:\/[^/]+)*|pulls\/\d+\/comments\/\d+\/replies|issues\/\d+(?:\/(?:comments|labels|reactions|assignees)(?:\/[^/]+)*)?|issues\/comments\/\d+(?:\/[^/]+)*)$/u;
// The GraphQL mutations an issue session runs: on review threads, comments, reviews, reactions, labels, and its pull
// request's draft state or reviewers. Any other, such as createRef, updateRefs, createCommitOnBranch,
// mergePullRequest, or a ruleset's, is refused.
const ISSUE_MUTATIONS = new Set([
  'addComment', 'updateIssueComment', 'deleteIssueComment', 'minimizeComment', 'unminimizeComment', 'addReaction', 'removeReaction',
  'addPullRequestReview', 'submitPullRequestReview', 'deletePullRequestReview', 'addPullRequestReviewComment', 'addPullRequestReviewThread',
  'addPullRequestReviewThreadReply', 'updatePullRequestReviewComment', 'deletePullRequestReviewComment', 'resolveReviewThread', 'unresolveReviewThread',
  'requestReviews', 'markPullRequestReadyForReview', 'convertPullRequestToDraft', 'addLabelsToLabelable', 'removeLabelsFromLabelable',
]);

// What a `gh api` call writes that a project run's issue session never writes, or null: a REST route outside
// ISSUE_ROUTES with a writing method, which a field sent with no -X makes POST, or a GraphQL mutation outside
// ISSUE_MUTATIONS, or one whose document cannot be read, as one read from a file or built at run time. `tokens` are
// the call's words past `gh`, each { text, dynamic } as the shell lexer gives them: a word built at run time may name
// any route or method, so a route or a method so built that may write is refused. Null for any other `program`.
export function apiWrite(program, tokens) {
  if (program !== 'gh') return null;
  let at = 0;
  while (at < tokens.length && tokens[at].text.startsWith('-') && !tokens[at].dynamic) at += GH_VALUES.includes(tokens[at].text) ? 2 : 1;
  if (tokens[at]?.text !== 'api' || tokens[at].dynamic) return null;
  let method = null;
  let fields = false;
  let route = null;
  let named = false;
  const sent = [];
  const rest = tokens.slice(at + 1);
  for (let i = 0; i < rest.length; i += 1) {
    const { text: word, dynamic } = rest[i];
    const [name, attached] = optionValue(word);
    if (API_VALUES.has(name) && !dynamic) {
      const given = attached === null ? rest[(i += 1)] : { text: attached, dynamic: false };
      const value = { text: String(given?.text ?? ''), dynamic: given?.dynamic === true };
      if (name === '-X' || name === '--method') method = value.dynamic ? '?' : value.text.toUpperCase();
      if (API_FIELDS.has(name)) {
        fields = true;
        sent.push({ name, ...value });
      }
    } else if (word.startsWith('-') || (dynamic && named)) {
      // An option built at run time may be a method or a field, and one that takes no value is a switch.
      if (dynamic) method = '?';
    } else if (!named) {
      named = true;
      route = dynamic ? null : word.replace(/^\/+/u, '').split('?')[0];
    }
  }
  if (route === 'graphql') return graphqlWrite(sent);
  const writes = method === null ? fields : method !== 'GET' && method !== 'HEAD';
  if (!writes) return null;
  if (route === null) return 'a forge API route built at run time, with a method that writes';
  return ISSUE_ROUTES.test(route.replace(/^repos\/\{owner\}\/\{repo\}\//u, 'repos/o/r/')) ? null : `the forge API route ${route.slice(0, 120)}, which only the Human writes`;
}

// An option word of gh api as [name, attached value]: `--name=value`, a short option glued to its value, as `-XPOST`,
// or the word alone with null.
function optionValue(word) {
  if (word.startsWith('--') && word.includes('=')) return [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)];
  if (/^-[XfFHqtp]./u.test(word)) return [word.slice(0, 2), word.slice(2)];
  return [word, null];
}

// What the GraphQL call whose fields are `sent` writes that an issue session never writes, or null (apiWrite).
function graphqlWrite(sent) {
  if (sent.some(({ name }) => name === '--input')) return 'a GraphQL document read from a file or the input, which may hold any mutation';
  const query = sent.find(({ text }) => /^query=/u.test(text));
  if (!query) return sent.some(({ dynamic, text }) => dynamic && !/^\w+=/u.test(text)) ? 'a GraphQL field built at run time, which may be its document' : null;
  const text = query.text.slice('query='.length);
  if (query.dynamic) return 'a GraphQL document built at run time, which may hold any mutation';
  if (query.name !== '-f' && query.name !== '--raw-field' && text.startsWith('@')) return 'a GraphQL document read from a file, which may hold any mutation';
  const fields = mutationFields(text);
  if (fields === null) return 'a GraphQL mutation whose fields cannot be read';
  const other = fields.find((field) => !ISSUE_MUTATIONS.has(field));
  return other ? `the forge's GraphQL mutation ${other.slice(0, 80)}, which only the Human runs` : null;
}

// The top-level fields of every mutation in the GraphQL document `text`, with strings and comments skipped and an
// alias's own name read: [] for a document with no mutation, null for one this cannot read.
function mutationFields(text) {
  const tokens = text.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n]*/gu, ' " ').match(/[A-Za-z_][A-Za-z0-9_]*|\.\.\.|[{}():]|\S/gu) ?? [];
  const fields = [];
  let depth = 0;
  let parens = 0;
  let mutation = false;
  let inside = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '(') parens += 1;
    else if (token === ')') parens -= 1;
    else if (token === '{') {
      depth += 1;
      if (depth === 1) inside = mutation;
    } else if (token === '}') {
      depth -= 1;
      if (depth === 0) [mutation, inside] = [false, false];
    } else if (depth === 0 && parens === 0 && token === 'mutation') mutation = true;
    else if (depth === 0 && parens === 0 && /^(?:query|subscription|fragment)$/u.test(token)) mutation = false;
    else if (inside && depth === 1 && parens === 0) {
      if (token === '...') return null;
      if (!/^[A-Za-z_]/u.test(token)) continue;
      if (tokens[i + 1] === ':') {
        i += 1;
        continue;
      }
      fields.push(token);
    }
  }
  return depth === 0 && parens === 0 ? fields : null;
}
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
// reads the threads of its findings (findingThreads), and resolves (resolveThread) or unresolves (unresolveThread) one.
// A comment's REST id is its `fullDatabaseId`, a 64-bit integer GitHub answers as a string (`databaseId` is deprecated:
// it does not hold 64 bits).
const FINDING_THREADS_QUERY = 'query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:100){totalCount nodes{fullDatabaseId body authorAssociation author{login}}}}}}}}';
// The most pages of threads one read walks: 10,000 threads.
const THREAD_PAGES = 100;
const RESOLVE_MUTATION = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';
const UNRESOLVE_MUTATION = 'mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';
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
// What an unattended merge confirms on the forge (lib/review/merge-trust.mjs), in one call: the user's login; the
// default branch's name, and its config pointer, config.json, and knowledge folder at the paths given; and the pull
// request's head, base, author, draft state, review decision, latest reviews, the head's checks, the changed files, the
// newest reviews, and the first conversation comments, each with the login of every edit to it, and the base branch's
// pointer and config.json; and the head branch, title, body, and first commits' messages, for the closing-word check.
// A login GraphQL gives a bot carries no `[bot]`; `__typename` says whether the author is a bot.
export const TRAIL_PAGE = 100;
const BLOB = '... on Blob { text isTruncated }';
const POLICY_FILES = `pointer: file(path: $pointer) { object { ${BLOB} } } config: file(path: $config) { object { ${BLOB} } }`;
const TRAIL_QUERY = `query($o: String!, $r: String!, $n: Int!, $pointer: String!, $config: String!, $knowledge: String!) {
  viewer { login }
  repository(owner: $o, name: $r) {
    defaultBranchRef {
      name
      target { ... on Commit { ${POLICY_FILES} knowledge: file(path: $knowledge) { object { ... on Tree { entries { name type object { ${BLOB} } } } } } } }
    }
    pullRequest(number: $n) {
      headRefOid
      headRefName
      baseRefName
      title
      body
      isDraft
      reviewDecision
      author { login }
      baseRef { name target { ... on Commit { ${POLICY_FILES} } } }
      latestReviews(first: ${TRAIL_PAGE}) { nodes { author { login } state } }
      history: commits(first: ${TRAIL_PAGE}) { totalCount nodes { commit { oid message } } }
      commits(last: 1) {
        nodes { commit { oid statusCheckRollup { contexts(first: ${TRAIL_PAGE}) { totalCount nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } }
      }
      files(first: ${TRAIL_PAGE}) { totalCount nodes { path changeType } }
      reviews(last: ${TRAIL_PAGE}) { totalCount nodes { author { login __typename } authorAssociation state commit { oid } submittedAt } }
      comments(first: ${TRAIL_PAGE}) {
        totalCount
        nodes { fullDatabaseId author { login __typename } authorAssociation editor { login } body updatedAt userContentEdits(first: ${TRAIL_PAGE}) { totalCount nodes { editor { login } deletedBy { login } } } }
      }
    }
  }
}`;
// One GraphQL node's author as the trail gives it: { login, bot }, with a deleted account's login null.
const trailAuthor = (author) => ({ login: typeof author?.login === 'string' ? author.login : null, bot: author?.__typename === 'Bot' });
// A GraphQL connection's nodes, and whether they are all of it.
const trailNodes = (connection) => {
  const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
  return { nodes, complete: Number.isSafeInteger(connection?.totalCount) && connection.totalCount <= nodes.length };
};
// A file the trail read: its text, null when the branch has none, or false when GitHub gave only part of it or no text.
const blobText = (entry) => {
  if (entry === null || entry === undefined) return null;
  const object = entry.object;
  return object && object.isTruncated === false && typeof object.text === 'string' ? object.text : false;
};
// A branch's policy files as the trail gives them: { name, pointer, config }, and `knowledge`, the folder's entries
// [{ name, type, text }] or null with no such folder, for the default branch.
const branchFiles = (name, target, knowledge = false) => ({
  name: typeof name === 'string' ? name : null,
  pointer: blobText(target?.pointer),
  config: blobText(target?.config),
  ...(knowledge ? {
    knowledge: target?.knowledge === null || target?.knowledge === undefined ? null
      : (Array.isArray(target.knowledge.object?.entries) ? target.knowledge.object.entries.map((entry) => ({ name: entry?.name, type: entry?.type, text: blobText(entry) })) : false),
  } : {}),
});
// One check of the head as `forge.checks` rows give it: { name, state }, a check run's conclusion once it completed,
// else its status, and a status context's state.
const checkOf = (node) => (node?.__typename === 'StatusContext'
  ? { name: String(node.context ?? ''), state: String(node.state ?? '') }
  : { name: String(node?.name ?? ''), state: String((node?.status === 'COMPLETED' ? node.conclusion : node?.status) ?? '') });

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

// The network hosts a session pushing to and reading from the forge at `host` must reach: the host itself, for git over
// HTTPS, and, for github.com, its API host, which gh calls; a GitHub Enterprise host serves its API under its own name.
// A sandbox's allowlist of a confined project session holds these and nothing else (lib/hosts/claude-code-sandbox.mjs).
export function domains(host) {
  const named = String(host ?? '').toLowerCase();
  return named === DEFAULT_HOST ? [named, 'api.github.com'] : [named];
}

// The environment variables gh reads its token from (`gh help environment`): the one credential a confined project
// session keeps in its sandbox, since it pushes and opens pull requests through gh; every other credential-named
// variable is unset there (lib/hosts/claude-code-sandbox.mjs).
export const TOKEN_VARS = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);

// A pull request or comment number as a route takes it: a safe positive integer, given as a number or as digits alone.
// Anything else throws before any call, so no route is built from text a pull request supplies.
const idOf = (value, what) => {
  const number = typeof value === 'number' || (typeof value === 'string' && /^\d{1,16}$/u.test(value)) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${what} must be a positive whole number`);
  return number;
};

// A pull request number as a GraphQL variable takes it: idOf's, and within GRAPHQL_INT_MAX, else it throws before any call.
const graphNumber = (value) => {
  const number = idOf(value, 'a pull request number');
  if (!isChangeNumber(number)) throw new Error('a pull request number must fit GraphQL\'s Int');
  return number;
};

// Whether gh failed on an answer GitHub gave with a 4xx status, such as 422 for a review line outside the diff.
const clientError = (error) => /\(HTTP 4\d\d\)/u.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`);
// Whether gh failed on GitHub's 404.
const notFound = (error) => /\(HTTP 404\)/u.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`);
// Whether a `change` call failed because GitHub has no such pull request: a 404 from REST, or GraphQL's answer that it
// could not resolve the number, which `gh pr view` gives. Any other failure, such as a network error, may pass.
export const changeNotFound = (error) => notFound(error)
  || /Could not resolve to a PullRequest with the number/u.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`);

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

// The tag rule patterns that name every tag: GitHub's own `~ALL`, and `refs/tags/**/*`. A rule's `*` and `**` stop at a
// slash, as fnmatch's do, so `refs/tags/*` and `refs/tags/**` let a tag such as `release/v1` through.
const ALL_TAGS = new Set(['~ALL', 'refs/tags/**/*']);

// The names of the environments of `repo` a workflow on any branch may deploy to, and so read the secrets of: those with
// no deployment branch policy and no required reviewers rule that holds the signed-in user `login` (heldForReviewer).
// A repository GitHub keeps no environments for has none.
// SHORTCUT: an environment limited by custom branch patterns counts as held, though a pattern may match an issue's branch,
// and so does one limited to protected branches, though a branch protection's pattern may match an issue's branch too;
// an environment whose admins may bypass its rules (`can_admins_bypass`, true by default) counts as held, though an
// admin's token, as the session's may be, deploys past them through a script. Listing each pattern against the branch
// names issues get, and reading the bypass, would replace this when a team keeps secrets so.
function openEnvironments(list, repo, host, login) {
  let pages;
  try {
    pages = list(`repos/${repo}/environments`, { host });
  } catch (error) {
    if (notFound(error)) return [];
    throw error;
  }
  const environments = pages.flatMap((page) => (Array.isArray(page?.environments) ? page.environments : []));
  const reviewed = (each) => (Array.isArray(each?.protection_rules) ? each.protection_rules : []).some((rule) => heldForReviewer(rule, login));
  return environments.filter((each) => typeof each?.name === 'string' && !each.deployment_branch_policy && !reviewed(each)).map((each) => each.name);
}

// Whether an environment's protection rule holds a deployment for a reviewer other than the signed-in user `login`
// (null when it cannot be told): a required reviewers rule that prevents self-review, or that names reviewers, none of
// them that user. A team may hold the user, so a rule naming one holds nothing, nor does one that names no reviewer:
// the user who pushed the branch could approve the deployment, and its secrets, alone.
function heldForReviewer(rule, login) {
  if (rule?.type !== 'required_reviewers') return false;
  if (rule.prevent_self_review === true) return true;
  const reviewers = Array.isArray(rule.reviewers) ? rule.reviewers : [];
  const other = (each) => each?.type === 'User' && typeof each.reviewer?.login === 'string' && typeof login === 'string' && login !== '' && each.reviewer.login.toLowerCase() !== login.toLowerCase();
  return reviewers.length > 0 && reviewers.every(other);
}

// The signed-in user's login from `gh api --include user`'s answer, its headers then its body, or null.
function signedInLogin(answer) {
  const body = answer.split(/\r?\n\r?\n/u).slice(1).join('\n\n');
  try {
    const login = JSON.parse(body)?.login;
    return typeof login === 'string' && login !== '' ? login : null;
  } catch {
    return null;
  }
}

// One tag ruleset, as GitHub answers it, in the preflight's shape: { name, all, creation, update, bypass }: whether it
// names every tag and excludes none, whether it restricts creating and updating a matching tag, and whether the
// signed-in user may bypass it ('never', 'pull_requests_only', 'always', or 'exempt', as GitHub answers; null when it
// says nothing).
function tagRule(ruleset) {
  const names = (key) => (Array.isArray(ruleset?.conditions?.ref_name?.[key]) ? ruleset.conditions.ref_name[key].map(String) : []);
  const types = new Set((Array.isArray(ruleset?.rules) ? ruleset.rules : []).map((rule) => rule?.type));
  return {
    name: String(ruleset?.name ?? ''),
    all: names('include').some((pattern) => ALL_TAGS.has(pattern)) && names('exclude').length === 0,
    creation: types.has('creation'),
    update: types.has('update'),
    bypass: typeof ruleset?.current_user_can_bypass === 'string' ? ruleset.current_user_can_bypass : null,
  };
}

// Whether the default branch's protection (not a ruleset) holds the signed-in user to a pull request: { held, why },
// `held` true, false, or null when GitHub would not show its settings, `why` the reason it is not true. `read(route)`
// reads a route under the branch; `admin` is whether that user administers the repository, which GitHub's default lets
// past a protection that does not include administrators; `viewer()` gives the user's login. A protection that lets
// named people skip its pull request holds only when that user is not one of them and no team or app is named, since a
// team may hold that user.
function branchHold(read, admin, viewer) {
  if (read('')?.protected !== true) return { held: false, why: 'it has no branch protection' };
  let rules;
  try {
    rules = read('/protection');
  } catch (error) {
    if (clientError(error)) return { held: null, why: 'GitHub shows the settings of its branch protection only to an administrator' };
    throw error;
  }
  const reviews = rules?.required_pull_request_reviews;
  if (!reviews) return { held: false, why: 'its branch protection does not ask for a pull request' };
  if (admin && rules?.enforce_admins?.enabled !== true) return { held: false, why: 'its branch protection does not include administrators, and the signed-in user is one' };
  const skip = reviews.bypass_pull_request_allowances ?? {};
  const named = (key) => (Array.isArray(skip[key]) ? skip[key] : []);
  if (named('teams').length > 0) return { held: false, why: 'its branch protection lets a team skip the pull request, which may hold the signed-in user' };
  if (named('users').length > 0 && named('users').some((user) => String(user?.login ?? '').toLowerCase() === String(viewer() ?? '').toLowerCase())) {
    return { held: false, why: 'its branch protection lets the signed-in user skip the pull request' };
  }
  return { held: true, why: null };
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
  // The review threads of pull request `n`, as GitHub's GraphQL nodes, read page by page: with `root`, the one whose first
  // comment is the review comment `root`, as soon as it is found, or null when none starts there; without, every thread
  // read, and with `roots`, the ids of root comments, no page past the one where the last of them is found.
  // A page that does not answer as one, and more pages than THREAD_PAGES, throw.
  const walkThreads = (repo, n, { root = null, roots = null } = {}) => {
    const number = graphNumber(n);
    const rootId = root === null ? null : idOf(root, 'a comment id');
    const wanted = rootId === null && Array.isArray(roots) ? new Set(roots.map((each) => String(idOf(each, 'a comment id')))) : null;
    const [owner, name, ...extra] = String(repo).split('/');
    if (!owner || !name || extra.length) throw new Error('a repository is owner/name');
    // fullDatabaseId is a BigInt GitHub answers as a string: compared as text, and a null one matches nothing.
    const rootOf = (thread) => {
      const full = thread?.comments?.nodes?.[0]?.fullDatabaseId;
      return typeof full === 'string' || typeof full === 'number' ? String(full) : null;
    };
    const all = [];
    let after = null;
    for (let page = 0; page < THREAD_PAGES; page += 1) {
      const answer = json(['api', 'graphql', '-f', `query=${FINDING_THREADS_QUERY}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${number}`, ...(after ? ['-f', `after=${after}`] : [])]);
      const threads = answer?.data?.repository?.pullRequest?.reviewThreads;
      if (!Array.isArray(threads?.nodes)) throw new Error('GitHub answered the review threads with no list');
      if (rootId !== null) {
        const found = threads.nodes.find((thread) => rootOf(thread) === String(rootId));
        if (found) return found;
      } else {
        all.push(...threads.nodes);
        for (const thread of threads.nodes) wanted?.delete(rootOf(thread));
        if (wanted && !wanted.size) return all;
      }
      if (threads.pageInfo?.hasNextPage !== true || typeof threads.pageInfo.endCursor !== 'string') return rootId === null ? all : null;
      after = threads.pageInfo.endCursor;
    }
    throw new Error(`pull request #${number} has more than ${THREAD_PAGES * 100} review threads`);
  };
  // The thread that review comment `commentId` starts: a missing or malformed id throws, and never reads every thread.
  const threadAt = (repo, n, commentId) => walkThreads(repo, n, { root: idOf(commentId, 'a comment id') });
  // One thread node in the facade's shape: { resolved, complete, comments }, its comments in order, each { id, body,
  // user: { login }, author_association } as the REST reads give a comment; `complete` false when the thread holds more
  // than the 100 read.
  const threadShape = (thread) => {
    const nodes = Array.isArray(thread?.comments?.nodes) ? thread.comments.nodes : [];
    return {
      resolved: thread?.isResolved === true,
      complete: Number.isSafeInteger(thread?.comments?.totalCount) && thread.comments.totalCount <= nodes.length,
      comments: nodes.map((each) => ({ id: restId(each?.fullDatabaseId), body: typeof each?.body === 'string' ? each.body : '', user: { login: each?.author?.login ?? null }, author_association: each?.authorAssociation ?? null })),
    };
  };
  return Object.freeze({
    id: FORGE_ID,
    cwd,
    isTrustedCommenter,
    // The hosts it serves, FORGE_HOSTS, the allowlist of the session ledger: a host no adapter declares is recorded nowhere.
    hosts: FORGE_HOSTS,
    changeRef,
    // The state of the change requests `refs` name, each `{ host, path, number, branch, rank }` as the session ledger
    // holds it, a branch's `rank` 'open' for gh's own order (byOpen) and any other for the token user's first (byRank),
    // newest first: for each of the first MAX_CHANGE_REFS, the forge-neutral row of its pull request (changeRow), or null
    // when it fails changeRef, resolves to none, or its alias is null. One GraphQL call for them all, its body on gh's
    // stdin and its host the constant CHANGES_HOST; none when no ref passes. An answer that does not parse throws.
    changesState: (refs) => {
      const given = (Array.isArray(refs) ? refs : []).slice(0, MAX_CHANGE_REFS);
      const checked = given.map((ref) => changeRef(ref));
      const asked = checked.filter(Boolean);
      if (asked.length === 0) return checked;
      const input = JSON.stringify({ query: changesQuery(asked), variables: changesVariables(asked) });
      const data = changesData(() => gh(['api', 'graphql', '--hostname', CHANGES_HOST, '--input', '-'], { input }));
      let alias = 0;
      return checked.map((ref, index) => {
        if (ref === null) return null;
        const node = answeredChange(ref, data[`r${alias++}`], given[index]?.rank === 'open' ? byOpen : byRank);
        return node ? changeRow(node) : null;
      });
    },
    // The link of a change row, as changesState gives one or a cache holds one: its `url` when it is the one this adapter
    // builds for the row's forge, host, repository, and number, in printable ASCII and equal to it but for letter case,
    // as GitHub writes an owner's name; anything else, a link to another host included, is null.
    changeUrl: (row) => {
      const repo = typeof row?.repo === 'string' ? row.repo : '';
      if (row?.forge !== FORGE_ID || changeRef({ host: row.host, path: repo, number: row.number }) === null) return null;
      const built = `https://${CHANGES_HOST}/${repo}/pull/${row.number}`;
      return typeof row.url === 'string' && /^[\x21-\x7e]+$/u.test(row.url) && row.url.toLowerCase() === built.toLowerCase() ? row.url : null;
    },
    // The pull request `ref` (a number, a branch, or a URL; none: the current branch's), with the gh `fields` named;
    // `repo` looks in that repository instead of the default one. With a `repo`, an empty `ref` still goes to gh, as the
    // merge guard has always sent it: gh needs an argument with `--repo`, and an empty one is the current branch's.
    change: (ref, fields, { repo = null } = {}) => {
      const target = given(ref) || (ref === '' && repo) ? [String(ref)] : [];
      return json(['pr', 'view', ...target, '--json', fields, ...(repo ? ['--repo', repo] : [])]);
    },
    // The merged pull requests, newest first, at most `limit`, each with the `fields` named; with `sinceMs`, only those
    // merged since then. `repo` lists that repository's, as servedRepository names it.
    mergedChanges: (limit, { sinceMs = null, fields = 'number,reviews', repo = null } = {}) => {
      const search = sinceMs === null ? [] : ['--search', `merged:>=${new Date(sinceMs).toISOString().slice(0, 19)}+00:00`];
      return json(['pr', 'list', '--state', 'merged', '--limit', String(limit), ...search, '--json', fields, ...(repo ? ['--repo', repo] : [])]);
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
    // Whether the reviewer `login` reviewed any of the repository's last `limit` pull requests, for a project run's
    // preflight: { changes, seen }, with a bot's login compared with or without its `[bot]` suffix.
    reviewerSeen: (repo, login, { host, limit = 20 } = {}) => {
      const list = json(['pr', 'list', '--repo', host ? `${host}/${repo}` : repo, '--state', 'all', '--limit', String(limit), '--json', 'number,reviews']);
      const bare = (name) => String(name ?? '').replace(/\[bot\]$/u, '').toLowerCase();
      const seen = Array.isArray(list) && list.some((change) => (change.reviews ?? []).some((review) => bare(review.author?.login) === bare(login)));
      return { changes: Array.isArray(list) ? list.length : 0, seen };
    },
    // The names of the repository's active CI workflows, for a project run's preflight.
    ciWorkflows: (repo, { host } = {}) => (rest(`repos/${repo}/actions/workflows`, { host })?.workflows ?? [])
      .filter((workflow) => workflow?.state === 'active').map((workflow) => String(workflow.name)),
    // What guards the default branch and the tags of `repo` from the signed-in user, whose token a project run's issue
    // session keeps, for the run's preflight: { branch, protected, why, tags }. `branch` is the default branch's name;
    // `protected` true when an active ruleset that asks for a pull request there may never be bypassed by that user, or
    // branch protection asks for one and binds that user (branchHold), false when neither does, and null when only branch
    // protection could hold and GitHub shows its settings to admins alone; `why` says why it is not true. `tags` holds
    // each active tag ruleset (tagRule).
    refProtection: (repo, { host } = {}) => {
      const about = rest(`repos/${repo}`, { host });
      const branch = about?.default_branch;
      if (typeof branch !== 'string' || branch === '') throw new Error('GitHub named no default branch');
      const rulesets = new Map();
      const ruleset = (id) => {
        if (!rulesets.has(id)) rulesets.set(id, rest(`repos/${repo}/rulesets/${id}`, { host }));
        return rulesets.get(id);
      };
      const asks = list(`repos/${repo}/rules/branches/${encodeURIComponent(branch)}`, { host })
        .filter((rule) => rule?.type === 'pull_request' && Number.isSafeInteger(rule.ruleset_id));
      const ruled = [...new Set(asks.map((rule) => rule.ruleset_id))].map(ruleset).filter((each) => each?.enforcement === 'active');
      const tags = list(`repos/${repo}/rulesets?targets=tag&includes_parents=true`, { host })
        .filter((each) => each?.enforcement === 'active' && each?.target === 'tag' && Number.isSafeInteger(each?.id))
        .map((each) => ruleset(each.id)).filter((each) => each?.enforcement === 'active').map(tagRule);
      if (ruled.some((each) => each.current_user_can_bypass === 'never')) return { branch, protected: true, why: null, tags };
      const read = (route) => rest(`repos/${repo}/branches/${encodeURIComponent(branch)}${route}`, { host });
      const classic = branchHold(read, about?.permissions?.admin !== false, () => rest('user', { host })?.login);
      const bypassed = ruled.map((each) => `the ruleset ${JSON.stringify(String(each.name ?? each.id))} asks for a pull request, and lets the signed-in user bypass it (${String(each.current_user_can_bypass ?? 'not said')})`);
      const why = classic.held === true ? null : [...bypassed, classic.why].filter(Boolean).join('; ');
      return { branch, protected: classic.held, why, tags };
    },
    // What a project run's issue session's token could run with the repository's secrets, for the run's preflight:
    // { secrets, workflowPush }. `secrets` counts the Actions secrets of the repository, those its organization
    // shares with it (none for a repository with no organization), and those of each environment any branch may deploy
    // to without a reviewer other than the signed-in user (openEnvironments); `workflowPush` is whether the signed-in
    // token's scopes include `workflow`, which GitHub asks of a push that changes a workflow file, or null for a token
    // that names no scopes, as a fine-grained one.
    workflowSecrets: (repo, { host } = {}) => {
      const count = (route) => {
        const total = rest(route, { host })?.total_count;
        if (!Number.isSafeInteger(total)) throw new Error('GitHub answered no count of secrets');
        return total;
      };
      let shared = 0;
      try {
        shared = count(`repos/${repo}/actions/organization-secrets`);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
      const answer = String(gh(['api', '--include', ...(host ? ['--hostname', host] : []), 'user']));
      const line = answer.split(/\r?\n/u).find((each) => /^x-oauth-scopes:/iu.test(each));
      const scopes = line === undefined ? null : line.slice(line.indexOf(':') + 1).split(',').map((each) => each.trim());
      const open = openEnvironments(list, repo, host, signedInLogin(answer)).reduce((sum, name) => sum + count(`repos/${repo}/environments/${encodeURIComponent(name)}/secrets`), 0);
      const secrets = count(`repos/${repo}/actions/secrets`) + shared + open;
      return { secrets, workflowPush: scopes === null ? null : scopes.includes('workflow') };
    },
    // The commit the branch `branch` of `repo` points to now, as a full SHA, or null when the answer names none.
    branchHead: (repo, branch, { host } = {}) => {
      const sha = rest(`repos/${repo}/branches/${encodeURIComponent(branch)}`, { host })?.commit?.sha;
      return typeof sha === 'string' && /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
    },
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
    // { path, line, side, body }, `line` on the head `commitId`'s side of the diff. Returns { refused: false, id, login,
    // comments }, the review's id, the login GitHub answered it with (null with none), and its inline comments as GitHub
    // lists them ({ id, body, path, line }, null when that read fails),
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
      return { refused: false, id, login: typeof review?.user?.login === 'string' ? review.user.login : null, comments: posted };
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
    // The review threads of pull request `n`, each in the facade's shape (threadShape): { resolved, complete, comments },
    // the first comment its root. A step reads them once and looks each finding's thread up by its root's id. With
    // `roots`, the root comment ids the caller looks for, the read stops at the page where the last of them is found;
    // without, it reads every page. A failed read throws.
    findingThreads: (repo, n, { roots } = {}) => walkThreads(repo, n, { roots: Array.isArray(roots) ? roots : null }).map(threadShape),
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
    // Unresolves the review thread of pull request `n` that review comment `commentId` starts, found by that comment's id
    // as resolveThread finds it. Returns { resolved: false } for a thread open, by this call or before; throws when no
    // thread starts there, when the call fails, or when GitHub does not answer that it is open.
    unresolveThread: (repo, n, commentId) => {
      const thread = threadAt(repo, n, commentId);
      if (!thread) throw new Error('no review thread of the pull request starts at that comment');
      if (thread.isResolved !== true) return { resolved: false };
      if (typeof thread.id !== 'string' || !NODE_ID.test(thread.id)) throw new Error('GitHub answered the review thread with no id');
      const answer = json(['api', 'graphql', '-f', `query=${UNRESOLVE_MUTATION}`, '-f', `id=${thread.id}`]);
      if (answer?.data?.unresolveReviewThread?.thread?.isResolved !== false) throw new Error('GitHub did not unresolve the review thread');
      return { resolved: false };
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
    // The owner and name go as raw -f strings, and the number through graphNumber before -F, which reads a leading `@` as a file.
    reviewsWithComments: (repo, n) => {
      const number = graphNumber(n);
      const [owner, name] = repo.split('/');
      return json(['api', 'graphql', '-f', `query=${REVIEWS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]);
    },
    // One page of the review threads, each with its first comment, after the cursor `after` (null: the first page):
    // GitHub's GraphQL answer, `data.repository.pullRequest.reviewThreads` with its `pageInfo`.
    reviewThreads: (repo, n, after = null) => {
      const number = graphNumber(n);
      const [owner, name] = repo.split('/');
      return json(['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${number}`, ...(after ? ['-f', `after=${after}`] : [])]);
    },
    // What an unattended merge of pull request `n` of `repo` confirms on the forge, in the facade's shape: { viewer, head,
    // base, author, draft, reviewDecision, latestReviews: [{ author: { login }, state }], checks: { head, rows, complete },
    // files: [{ path, changeType }], filesTotal, filesComplete, reviews: [{ login, bot, association, state, commit, at }], reviewsComplete,
    // comments: [{ id, login, bot, association, body, at, editors, editsComplete }], commentsComplete, branches: { default,
    // base } }. `reviews` are the newest TRAIL_PAGE, `comments` and `files` the first TRAIL_PAGE; `editors` holds the
    // login of the comment's last editor, of every edit of it, and of whoever deleted an edit from its history, null for a
    // deleted account or an edit with no editor. `paths` are the pointer file, config.json, and knowledge folder to read on
    // the default branch, and the first two on the base, from the top of the repository. `host` names the GitHub host.
    // An answer with no pull request throws.
    reviewTrail: (repo, n, { host, paths } = {}) => {
      const number = idOf(n, 'a pull request number');
      const [owner, name, ...extra] = String(repo).split('/');
      if (!owner || !name || extra.length) throw new Error('a repository is owner/name');
      const { pointer, config, knowledge } = paths ?? {};
      if (![pointer, config, knowledge].every((each) => typeof each === 'string' && each !== '')) throw new Error('the review trail needs the paths of the policy files it reads');
      const args = ['api', 'graphql', ...(host ? ['--hostname', host] : []), '-f', `query=${TRAIL_QUERY}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${number}`,
        '-f', `pointer=${pointer}`, '-f', `config=${config}`, '-f', `knowledge=${knowledge}`];
      let answer;
      try {
        answer = json(args);
      } catch (error) {
        // A policy file the branch has not is GraphQL's NOT_FOUND on that field, and gh then exits 1 with the answer on
        // stdout: the answer stands, with that field null. Any other error throws as gh threw it.
        let partial = null;
        try {
          partial = JSON.parse(error?.stdout ?? '');
        } catch {}
        const missing = (each) => each?.type === 'NOT_FOUND' && ['pointer', 'config', 'knowledge'].includes(each?.path?.at(-1));
        if (!partial?.data || !Array.isArray(partial.errors) || !partial.errors.every(missing)) throw error;
        answer = partial;
      }
      const data = answer?.data;
      const pr = data?.repository?.pullRequest;
      if (!pr || typeof pr !== 'object') throw new Error(`GitHub answered no pull request #${number} of ${repo}`);
      const files = trailNodes(pr.files);
      const reviews = trailNodes(pr.reviews);
      const comments = trailNodes(pr.comments);
      const commit = pr.commits?.nodes?.at(-1)?.commit ?? null;
      const history = trailNodes(pr.history);
      const contexts = trailNodes(commit?.statusCheckRollup?.contexts);
      const association = (each) => (typeof each?.authorAssociation === 'string' ? each.authorAssociation : null);
      return {
        viewer: typeof data?.viewer?.login === 'string' ? data.viewer.login : null,
        head: typeof pr.headRefOid === 'string' ? pr.headRefOid : null,
        headRef: typeof pr.headRefName === 'string' ? pr.headRefName : null,
        title: typeof pr.title === 'string' ? pr.title : null,
        body: typeof pr.body === 'string' ? pr.body : null,
        // Every commit's message, for the closing-word check (lib/closing-words.mjs); complete only when all are here.
        messages: history.nodes.map((each) => ({ oid: each?.commit?.oid ?? null, message: typeof each?.commit?.message === 'string' ? each.commit.message : null })),
        messagesComplete: history.complete,
        base: typeof pr.baseRefName === 'string' ? pr.baseRefName : null,
        author: typeof pr.author?.login === 'string' ? pr.author.login : null,
        draft: pr.isDraft === true,
        reviewDecision: typeof pr.reviewDecision === 'string' ? pr.reviewDecision : '',
        latestReviews: trailNodes(pr.latestReviews).nodes.map((each) => ({ author: { login: each?.author?.login ?? null }, state: each?.state ?? null })),
        // No rollup is no check reported: an empty, whole list.
        checks: { head: typeof commit?.oid === 'string' ? commit.oid : null, rows: contexts.nodes.map(checkOf), complete: commit?.statusCheckRollup ? contexts.complete : true },
        files: files.nodes.filter((each) => typeof each?.path === 'string').map(({ path, changeType }) => ({ path, changeType: typeof changeType === 'string' ? changeType : null })),
        filesTotal: Number.isSafeInteger(pr.files?.totalCount) ? pr.files.totalCount : null,
        filesComplete: files.complete,
        reviews: reviews.nodes.map((each) => ({ ...trailAuthor(each?.author), association: association(each), state: each?.state ?? null, commit: each?.commit?.oid ?? null, at: each?.submittedAt ?? null })),
        reviewsComplete: reviews.complete,
        comments: comments.nodes.map((each) => {
          const edits = trailNodes(each?.userContentEdits);
          return {
            id: restId(each?.fullDatabaseId), ...trailAuthor(each?.author), association: association(each), body: typeof each?.body === 'string' ? each.body : '', at: each?.updatedAt ?? null,
            // The comment's last editor, each edit's editor, and whoever deleted an edit from its history.
            editors: [...(each?.editor ? [each.editor] : []), ...edits.nodes.flatMap((edit) => [edit?.editor ?? null, ...(edit?.deletedBy ? [edit.deletedBy] : [])])]
              .map((actor) => (typeof actor?.login === 'string' ? actor.login : null)),
            editsComplete: edits.complete,
          };
        }),
        commentsComplete: comments.complete,
        branches: {
          default: branchFiles(data?.repository?.defaultBranchRef?.name, data?.repository?.defaultBranchRef?.target, true),
          base: branchFiles(pr.baseRef?.name, pr.baseRef?.target),
        },
      };
    },
    // When the body of pull request `n` of `repo` was last edited and its title last renamed, GitHub's GraphQL answer:
    // `data.repository.pullRequest` with `lastEditedAt` (null when never edited) and `timelineItems.nodes`, the newest
    // rename's `createdAt` or none.
    changeEdits: (repo, n, { host } = {}) => {
      const number = graphNumber(n);
      const [owner, name] = repo.split('/');
      return json(['api', 'graphql', ...(host ? ['--hostname', host] : []), '-f', `query=${EDITS_QUERY}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${number}`]);
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
    // What an auto-merge stop reads and does (lib/project-stops.mjs), and what the closing-word check reads
    // (lib/pr-auto-merge.mjs closingProblem).
    // Where pull request `ref` of `repo` stands for a merge: `ref` is its number or its head branch, and `repo` may name
    // its host, `host/owner/name`. GitHub's view with MERGE_STATE_FIELDS: `mergeable` is MERGEABLE, CONFLICTING, or
    // UNKNOWN, and `mergeStateStatus` is BEHIND, DIRTY, BLOCKED, CLEAN, UNSTABLE, HAS_HOOKS, DRAFT, or UNKNOWN.
    mergeState: (repo, ref) => json(['pr', 'view', String(ref), '--repo', repo, '--json', MERGE_STATE_FIELDS]),
    // Starts the failed jobs of each Actions workflow run of `repo` in `runs`, by id, again; returns the ids it asked for.
    rerunFailedChecks: (repo, runs, { host } = {}) => runs.map((run) => {
      const id = idOf(run, 'a workflow run id');
      rest(`repos/${repo}/actions/runs/${id}/rerun-failed-jobs`, { method: 'POST', empty: true, host });
      return id;
    }),
    // Whether a push that is no fast-forward may land on the branch `branch` of `repo`: false when GitHub protects the
    // branch, whose protection only an admin may read, or a ruleset that applies to it forbids one (`non_fast_forward`).
    branchAllowsForce: (repo, branch, { host } = {}) => {
      const name = encodeURIComponent(branch);
      if (rest(`repos/${repo}/branches/${name}`, { host })?.protected !== false) return false;
      const rules = rest(`repos/${repo}/rules/branches/${name}`, { paginate: true, host });
      return Array.isArray(rules) && rules.every((rule) => typeof rule?.type === 'string' && rule.type !== 'non_fast_forward');
    },
    // Brings pull request `n` of `repo` up to date with its base on the forge, only while its head is `expectedHead`:
    // `merge` merges the base in, one new commit on top; `rebase` puts its commits on the base, which replaces them, a
    // push that is no fast-forward. Throws what gh throws, such as GitHub's 422 for a conflict or a head that moved.
    updateBranch: (repo, n, { host, expectedHead, method = 'merge' } = {}) => {
      const number = idOf(n, 'a pull request number');
      if (typeof expectedHead !== 'string' || !/^[0-9a-f]{40}$/u.test(expectedHead)) throw new Error('an update names the head it expects, a full commit SHA');
      if (method === 'merge') return rest(`repos/${repo}/pulls/${number}/update-branch`, { method: 'PUT', fields: { expected_head_sha: expectedHead }, host });
      if (method !== 'rebase') throw new Error('an update merges the base in or rebases onto it');
      const id = rest(`repos/${repo}/pulls/${number}`, { host })?.node_id;
      if (typeof id !== 'string' || !NODE_ID.test(id)) throw new Error(`GitHub gave no node id for pull request #${number}`);
      return json(['api', 'graphql', ...(host ? ['--hostname', host] : []), '-f', `query=${REBASE_MUTATION}`, '-f', `id=${id}`, '-f', `head=${expectedHead}`]);
    },
    // One Actions workflow run of `repo`, by id: its `head_sha`, `head_branch`, `head_repository`, and `run_attempt`.
    workflowRun: (repo, id, { host } = {}) => rest(`repos/${repo}/actions/runs/${idOf(id, 'a workflow run id')}`, { host }),
    // The commits of pull request `n` of `repo`, every page, each with its `commit.message`: GitHub lists at most 250.
    changeCommits: (repo, n, { host } = {}) => list(`repos/${repo}/pulls/${idOf(n, 'a pull request number')}/commits?per_page=100`, { host }),
  });
}

// The fields mergeState reads.
export const MERGE_STATE_FIELDS = 'number,url,state,isDraft,mergeable,mergeStateStatus,headRefOid,headRefName,baseRefName,isCrossRepository,reviewDecision,latestReviews';
// updateBranch's rebase, which GitHub's REST route does not offer.
const REBASE_MUTATION = 'mutation($id:ID!,$head:GitObjectID!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$head,updateMethod:REBASE}){pullRequest{headRefOid}}}';
