// What the GitHub adapter says about a token a project run hands its issue session: the variable gh and its git
// credential helper read it from, the step that signs gh in, what a token's kind lets it reach, read from its prefix
// alone (docs.github.com, "About authentication to GitHub", token prefixes), whether it may push, by a probe that
// writes nothing, and which of the reads an issue session makes it may not make, with the permission each needs.

import { execFileSync } from 'node:child_process';

import { programNames, programOnPath } from '../hosts/process.mjs';

// The variable gh reads a token for `host` from first, and `gh auth git-credential`, the helper `gh auth setup-git`
// writes, too, so git's HTTPS push takes it as well (`gh help environment`): GH_TOKEN for github.com and a ghe.com
// tenancy, GH_ENTERPRISE_TOKEN for any other host, a GitHub Enterprise Server.
export function tokenVarFor(host) {
  const named = String(host ?? 'github.com').toLowerCase();
  return named === 'github.com' || named.endsWith('.ghe.com') ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN';
}

// The step that gives gh a login for `host`.
export const loginStep = (host) => `gh auth login --hostname ${host} --git-protocol https`;

// The prefixes of the token kinds that reach every repository and scope the user's login has: gh's own OAuth login, a
// classic personal access token, and a user-to-server token.
const BROAD = Object.freeze([
  { prefix: 'gho_', kind: 'an OAuth token of gh\'s own login' },
  { prefix: 'ghp_', kind: 'a classic personal access token' },
  { prefix: 'ghu_', kind: 'a user-to-server token' },
]);

// A note on a token that reaches more than one repository, naming its kind, or null for a fine-grained token
// (`github_pat_`), which its owner limits to chosen repositories and permissions. A token of no known kind gets a note too.
export function tokenNote(token) {
  const value = String(token ?? '');
  if (value.startsWith('github_pat_')) return null;
  const broad = BROAD.find((each) => value.startsWith(each.prefix));
  const kind = broad ? broad.kind : 'a token of no kind GitHub names by prefix';
  return `it is ${kind}, which reaches every repository and scope its user has, not only this one; a fine-grained token limited to this repository narrows that`;
}

// How long the push probe may take.
const PROBE_TIMEOUT_MS = 20_000;
// The probe, run by this Node with no shell: a GET of the URL its first argument names, with basic auth from the token
// in the variable its second argument names, printing the HTTP status and the answer's content type on one line. The
// token is never an argument.
const PROBE = [
  'const [url, name] = process.argv.slice(1);',
  'const auth = Buffer.from(`x-access-token:${process.env[name] ?? ""}`).toString("base64");',
  'fetch(url, { headers: { Authorization: `Basic ${auth}` }, redirect: "manual" })',
  '  .then((answer) => process.stdout.write(`${answer.status} ${answer.headers.get("content-type") ?? ""}`), (error) => { process.stderr.write(String(error?.message ?? error)); process.exit(2); });',
].join('\n');
// The content type of a receive-pack advertisement, the one answer that shows a push may start.
const ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';

// What GitHub answers the receive-pack advertisement of `repo` on `host` with, for `token`: { status, type }, the start
// of a push, which writes nothing, and which GitHub answers 200 with an advertisement only for a token that may write
// the repository's contents, and 401 or 403 otherwise. The token reaches the probe through its environment, under the
// variable tokenVarFor names. `exec` is execFileSync's shape, the test seam.
export function receivePackStatus(repo, { host, token, exec = execFileSync }) {
  const name = tokenVarFor(host);
  const url = `https://${host}/${repo}.git/info/refs?service=git-receive-pack`;
  const out = String(exec(process.execPath, ['-e', PROBE, url, name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS, env: { ...process.env, [name]: token } })).trim();
  const space = out.indexOf(' ');
  return { status: Number(space < 0 ? out : out.slice(0, space)), type: space < 0 ? '' : out.slice(space + 1).trim() };
}

// Whether `token` may push to `repo` on `host`, by receivePackStatus: { may, why }. `may` is true only for a 200 whose
// content type is a receive-pack advertisement, false for a 200 of any other type, 401, 403, or 404, with `why` naming
// the answer; any other answer throws, since it says nothing either way.
export function tokenMayPush(repo, { host, token, probe = receivePackStatus }) {
  const { status, type = '' } = probe(repo, { host, token });
  const base = String(type).split(';')[0].trim().toLowerCase();
  if (status === 200 && base === ADVERTISEMENT) return { may: true, why: null };
  if (status === 200) return { may: false, why: `the forge answered 200 with ${base || 'no content type'}, not a push advertisement` };
  if ([401, 403, 404].includes(status)) return { may: false, why: `the forge answered ${status}` };
  throw new Error(`the forge answered the push probe with ${Number.isFinite(status) ? status : 'no status'}`);
}

// The REST API root of `host`: api.github.com for github.com, api.<tenant> for a ghe.com tenancy, and /api/v3 of a
// GitHub Enterprise Server host; and its GraphQL endpoint, which a Server host serves at /api/graphql.
export function apiRoot(host) {
  const named = String(host ?? 'github.com').toLowerCase();
  if (named === 'github.com') return 'https://api.github.com';
  return named.endsWith('.ghe.com') ? `https://api.${named}` : `https://${named}/api/v3`;
}
export const graphqlUrl = (host) => `${apiRoot(host).replace(/\/api\/v3$/u, '/api')}/graphql`;

// The read probe, run as the push probe is: a GET of the URL its first argument names, or with a third argument a POST
// of that GraphQL body, with the token in the variable its second argument names as a bearer token. It parses the whole
// answer in its own process and prints one JSON line of the fields a read needs: the status, whether the body parsed,
// the first `number` and the `default_branch` it holds, whether it holds GraphQL `data`, the GraphQL error types, the
// first message, and the rate-limit headers. No body crosses the pipe, so none is cut short.
const READ_PROBE = [
  'const [url, name, query] = process.argv.slice(1);',
  'const headers = { Authorization: `Bearer ${process.env[name] ?? ""}`, Accept: "application/vnd.github+json" };',
  'const init = query ? { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: query } : { headers };',
  'fetch(url, { ...init, redirect: "manual" }).then(async (answer) => {',
  '  let body; try { body = JSON.parse(await answer.text()); } catch { body = undefined; }',
  '  const first = Array.isArray(body) ? body[0] : body;',
  '  const errors = Array.isArray(body?.errors) ? body.errors : [];',
  '  process.stdout.write(JSON.stringify({ status: answer.status, parsed: body !== undefined && body !== null, number: Number.isSafeInteger(first?.number) ? first.number : null,',
  '    branch: typeof body?.default_branch === "string" ? body.default_branch : null, data: Boolean(body?.data), errors: errors.slice(0, 5).map((each) => String(each?.type ?? "")),',
  '    said: String(body?.message ?? errors[0]?.message ?? "").slice(0, 200), remaining: answer.headers.get("x-ratelimit-remaining"), retry: answer.headers.get("retry-after") }));',
  '}, (error) => { process.stderr.write(String(error?.message ?? error)); process.exit(2); });',
].join('\n');

// What GitHub answers the REST route `route` of `host`, or with `query` its GraphQL endpoint, for `token`: the probe's
// fields, { status, parsed, number, branch, data, errors, said, remaining, retry }. The token reaches the probe through
// its environment, never an argument. An answer that is not the probe's one line throws.
export function apiStatus(route, { host, token, query = null, exec = execFileSync }) {
  const name = tokenVarFor(host);
  const url = query ? graphqlUrl(host) : `${apiRoot(host)}/${route}`;
  const out = String(exec(process.execPath, ['-e', READ_PROBE, url, name, ...(query ? [query] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS, env: { ...process.env, [name]: token } }));
  const read = JSON.parse(out);
  if (typeof read !== 'object' || read === null || !Number.isInteger(read.status)) throw new Error('the read probe gave no status');
  return read;
}

// The reads an issue session's token makes, beyond the push, each with what it is for and the fine-grained token
// permission that grants it, as GitHub's "Permissions required for fine-grained personal access tokens" names them, at
// the level the session needs (it also writes pull requests, and reruns failed jobs). GitHub offers fine-grained tokens
// no Checks permission: `gh pr checks` reads a pull request's check rollup in GraphQL, its statuses and its runs.
export const TOKEN_READS = Object.freeze({
  repository: { what: 'read the repository', permission: 'Metadata: Read-only, with the repository selected under Repository access' },
  pulls: { what: 'read its pull requests, as the review step and the driver do', permission: 'Pull requests: Read and write' },
  reactions: { what: 'read the reactions on a pull request, as `aidrian pr review --with-bot` does', permission: 'Issues: Read-only' },
  statuses: { what: 'read a commit\'s statuses, as `gh pr checks` does', permission: 'Commit statuses: Read-only' },
  actions: { what: 'read its workflow runs, as `gh pr checks` and the checks read do', permission: 'Actions: Read and write' },
  rollup: { what: 'read a pull request\'s check rollup, the GraphQL read `gh pr checks` makes', permission: 'Commit statuses: Read-only and Actions: Read and write' },
});

// The GraphQL read `gh pr checks` makes, cut to its first context: the check rollup of a pull request's last commit,
// each context's type and, on a check run, its name and status.
const ROLLUP = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){commits(last:1){nodes{commit{statusCheckRollup{contexts(first:1){nodes{__typename ... on CheckRun{name status}}}}}}}}}}';

// Whether GitHub's answer `read` is a rate limit, primary or secondary, which says nothing of the token's permissions:
// a 403 or 429 with no request left or a Retry-After, or a GraphQL answer whose errors say RATE_LIMITED.
const rateLimited = (read) => ((read.status === 403 || read.status === 429) && (read.remaining === '0' || (typeof read.retry === 'string' && read.retry !== '')))
  || (read.errors ?? []).includes('RATE_LIMITED');

// The reads of TOKEN_READS that `token` may not make on `repo` of `host`, by reads that write nothing:
// { missing, unverified, unanswered }. `missing` holds each read refused, { read, what, permission, why }, in the order
// asked; `unverified` each read that could not be made here, in the same shape, as the check rollup of a repository with
// no pull request yet; `unanswered` why each read the forge could not answer now, as a rate limit, a 2xx whose body
// does not parse, or any other status, which says nothing of the token. Every read is asked, so a refusal is reported
// whatever else went unanswered. A 401, 403, or 404 is a read refused, and so is a GraphQL answer whose errors say
// FORBIDDEN or that holds no data. The reactions are read on the newest pull request, or the newest issue with none; a
// repository with neither proves the Issues read by that list. `probe` is apiStatus's shape, the test seam.
export function tokenReadProblems(repo, { host, token, probe = apiStatus }) {
  const answer = { missing: [], unverified: [], unanswered: [] };
  const said = (got) => (got.said ? `: ${got.said}` : '');
  const ask = (read, route, query = null) => {
    const got = probe(route, { host, token, ...(query ? { query } : {}) });
    const ok = got.status >= 200 && got.status < 300;
    let refused = null;
    if (rateLimited(got)) answer.unanswered.push(`the forge rate-limited the ${read} read (${got.status}${said(got)})`);
    else if (ok && !got.parsed) answer.unanswered.push(`the forge answered the ${read} read with a body that does not parse`);
    else if (ok && query && ((got.errors ?? []).includes('FORBIDDEN') || !got.data)) refused = `the forge answered ${(got.errors ?? []).join(', ') || 'no data'}${said(got)}`;
    else if (ok) return got;
    else if ([401, 403, 404].includes(got.status)) refused = `the forge answered ${got.status}`;
    else answer.unanswered.push(`the forge answered the ${read} read with ${Number.isFinite(got.status) ? got.status : 'no status'}`);
    if (refused) answer.missing.push({ read, ...TOKEN_READS[read], why: refused });
    return null;
  };
  const [owner, name] = String(repo).split('/');
  const about = ask('repository', `repos/${repo}`);
  // A token that cannot read the repository can read nothing of it.
  if (!about) return answer;
  const pulls = ask('pulls', `repos/${repo}/pulls?state=all&per_page=1`);
  const pull = pulls?.number ?? null;
  const number = pull ?? ask('reactions', `repos/${repo}/issues?state=all&per_page=1`)?.number ?? null;
  if (number !== null) ask('reactions', `repos/${repo}/issues/${number}/reactions?per_page=1`);
  if (typeof about.branch === 'string' && about.branch !== '') ask('statuses', `repos/${repo}/commits/${encodeURIComponent(about.branch)}/status`);
  ask('actions', `repos/${repo}/actions/runs?per_page=1`);
  if (pull !== null) ask('rollup', 'graphql', JSON.stringify({ query: ROLLUP, variables: { o: owner, r: name, n: pull } }));
  else if (pulls) answer.unverified.push({ read: 'rollup', ...TOKEN_READS.rollup, why: 'the repository has no pull request yet, so its first one proves it' });
  return answer;
}

// The git credential helper that answers git with the token in gh's variable: gh's own `auth git-credential`, by the
// absolute path of the gh first on an absolute folder of `env`'s PATH, quoted for the shell git runs a `!` helper in;
// or null when no gh is there.
export function gitHelperValue(env) {
  const gh = programOnPath(env, programNames('gh'));
  return gh ? `!'${gh.replaceAll("'", "'\\''")}' auth git-credential` : null;
}
