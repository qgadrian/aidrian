// What the GitHub adapter says about a token a project run hands its issue session: the variable gh and its git
// credential helper read it from, the step that signs gh in, and what a token's kind lets it reach, read from its prefix
// alone (docs.github.com, "About authentication to GitHub", token prefixes). No call: the token never leaves the process.

// The variable gh reads a token from first, and `gh auth git-credential`, the helper `gh auth setup-git` writes, too, so
// git's HTTPS push takes it as well.
export const TOKEN_VAR = 'GH_TOKEN';

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
