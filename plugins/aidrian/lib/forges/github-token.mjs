// What the GitHub adapter says about a token a project run hands its issue session: the variable gh and its git
// credential helper read it from, the step that signs gh in, what a token's kind lets it reach, read from its prefix
// alone (docs.github.com, "About authentication to GitHub", token prefixes), and whether it may push, by a probe that
// writes nothing.

import { execFileSync } from 'node:child_process';

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
// in the variable its second argument names, printing the HTTP status. The token is never an argument.
const PROBE = [
  'const [url, name] = process.argv.slice(1);',
  'const auth = Buffer.from(`x-access-token:${process.env[name] ?? ""}`).toString("base64");',
  'fetch(url, { headers: { Authorization: `Basic ${auth}` }, redirect: "manual" })',
  '  .then((answer) => process.stdout.write(String(answer.status)), (error) => { process.stderr.write(String(error?.message ?? error)); process.exit(2); });',
].join('\n');

// The HTTP status GitHub answers the receive-pack advertisement of `repo` on `host` with, for `token`: the start of a
// push, which writes nothing, and which GitHub answers 200 only for a token that may write the repository's contents,
// and 401 or 403 otherwise. The token reaches the probe through its environment, under the variable tokenVarFor names.
// `exec` is execFileSync's shape, the test seam.
export function receivePackStatus(repo, { host, token, exec = execFileSync }) {
  const name = tokenVarFor(host);
  const url = `https://${host}/${repo}.git/info/refs?service=git-receive-pack`;
  const out = exec(process.execPath, ['-e', PROBE, url, name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS, env: { ...process.env, [name]: token } });
  return Number(String(out).trim());
}

// Whether `token` may push to `repo` on `host`, by receivePackStatus: true for 200, false for 401, 403, or 404, and a
// throw for any other answer, which says nothing either way.
export function tokenMayPush(repo, { host, token, probe = receivePackStatus }) {
  const status = probe(repo, { host, token });
  if (status === 200) return true;
  if ([401, 403, 404].includes(status)) return false;
  throw new Error(`the forge answered the push probe with ${Number.isFinite(status) ? status : 'no status'}`);
}
