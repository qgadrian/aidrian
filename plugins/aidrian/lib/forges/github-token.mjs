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
// GitHub Enterprise Server host.
export function apiRoot(host) {
  const named = String(host ?? 'github.com').toLowerCase();
  if (named === 'github.com') return 'https://api.github.com';
  return named.endsWith('.ghe.com') ? `https://api.${named}` : `https://${named}/api/v3`;
}

// The read probe, run as the push probe is: a GET of the URL its first argument names, with the token in the variable
// its second argument names as a bearer token, printing the HTTP status, a newline, and at most 64 KiB of the body.
const READ_PROBE = [
  'const [url, name] = process.argv.slice(1);',
  'fetch(url, { headers: { Authorization: `Bearer ${process.env[name] ?? ""}`, Accept: "application/vnd.github+json" }, redirect: "manual" })',
  '  .then(async (answer) => process.stdout.write(`${answer.status}\\n${(await answer.text()).slice(0, 65536)}`), (error) => { process.stderr.write(String(error?.message ?? error)); process.exit(2); });',
].join('\n');

// What GitHub answers a GET of the REST route `route` of `host` with, for `token`: { status, body }, the body parsed, or
// null when it is not JSON. The token reaches the probe through its environment, never an argument.
export function apiStatus(route, { host, token, exec = execFileSync }) {
  const name = tokenVarFor(host);
  const out = String(exec(process.execPath, ['-e', READ_PROBE, `${apiRoot(host)}/${route}`, name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS, env: { ...process.env, [name]: token } }));
  const line = out.indexOf('\n');
  let body = null;
  try {
    body = JSON.parse(line < 0 ? '' : out.slice(line + 1));
  } catch {
    body = null;
  }
  return { status: Number(line < 0 ? out.trim() : out.slice(0, line)), body };
}

// The reads an issue session's token makes, beyond the push, each with what it is for and the fine-grained token
// permission that grants it, as GitHub's "Permissions required for fine-grained personal access tokens" names them, at
// the level the session needs (it also writes pull requests, and reruns failed jobs). GitHub offers fine-grained tokens
// no Checks permission: `gh pr checks` reads a commit's statuses and its workflow runs.
export const TOKEN_READS = Object.freeze({
  repository: { what: 'read the repository', permission: 'Metadata: Read-only, with the repository selected under Repository access' },
  pulls: { what: 'read its pull requests, as the review step and the driver do', permission: 'Pull requests: Read and write' },
  reactions: { what: 'read the reactions on a pull request, as `aidrian pr review --with-bot` does', permission: 'Issues: Read-only' },
  statuses: { what: 'read a commit\'s statuses, as `gh pr checks` does', permission: 'Commit statuses: Read-only' },
  actions: { what: 'read its workflow runs, as `gh pr checks` and the checks read do', permission: 'Actions: Read and write' },
});

// The reads of TOKEN_READS that `token` may not make on `repo` of `host`, by GETs that write nothing: each
// { read, what, permission, why }, in the order asked, none when every read passed. A 401, 403, or 404 is a read the
// token may not make; any other answer but a 2xx throws, since it says nothing either way. The reactions are read on the
// newest pull request, or the newest issue with none; a repository with neither proves the Issues read by that list.
// `probe` is apiStatus's shape, the test seam.
export function tokenReadProblems(repo, { host, token, probe = apiStatus }) {
  const problems = [];
  const ask = (read, route) => {
    const { status, body } = probe(route, { host, token });
    if (status >= 200 && status < 300) return body ?? {};
    if ([401, 403, 404].includes(status)) {
      problems.push({ read, ...TOKEN_READS[read], why: `the forge answered ${status}` });
      return null;
    }
    throw new Error(`the forge answered the ${read} read with ${Number.isFinite(status) ? status : 'no status'}`);
  };
  const first = (list) => (Array.isArray(list) && Number.isSafeInteger(list[0]?.number) ? list[0].number : null);
  const about = ask('repository', `repos/${repo}`);
  // A token that cannot read the repository can read nothing of it.
  if (!about) return problems;
  let number = first(ask('pulls', `repos/${repo}/pulls?state=all&per_page=1`));
  if (number === null) {
    const issues = ask('reactions', `repos/${repo}/issues?state=all&per_page=1`);
    number = issues ? first(issues) : null;
  }
  if (number !== null) ask('reactions', `repos/${repo}/issues/${number}/reactions?per_page=1`);
  if (typeof about.default_branch === 'string' && about.default_branch !== '') ask('statuses', `repos/${repo}/commits/${encodeURIComponent(about.default_branch)}/status`);
  ask('actions', `repos/${repo}/actions/runs?per_page=1`);
  return problems;
}

// The git credential helper that answers git with the token in gh's variable: gh's own `auth git-credential`, by the
// absolute path of the gh first on an absolute folder of `env`'s PATH, quoted for the shell git runs a `!` helper in;
// or null when no gh is there.
export function gitHelperValue(env) {
  const gh = programOnPath(env, programNames('gh'));
  return gh ? `!'${gh.replaceAll("'", "'\\''")}' auth git-credential` : null;
}
