// GitHub's reader for the session ledger (docs/hooks.md#session-ledger): the `gh pr` calls of a session's command line,
// `-R` and GH_REPO, and the pull request links in `gh pr create`'s output. It runs nothing: scripts/hook-bash-post.mjs
// hands it to the shared lib/session-prs.mjs in a table keyed by FORGE, which judges each row against the adapter's
// `hosts` and `changeRef`. A word the shell fills in or expands, where the call's repository or pull request would be,
// makes the call record nothing, and so does any word the shell fills in unquoted.

import { isLogin, repoIdentity } from '../../forges/index.mjs';
import { parseTarget } from '../../pr-resolve.mjs';
import { unreadable } from '../product-feedback-answer.mjs';
import { commandPath, readWords } from './review-request.mjs';

// The id of the forge adapter this reader serves, the key of its entry in the hook's table.
export const FORGE = 'github';
// The environment gh reads its repository and host from: a line that sets, unsets, or empties one of them before a call,
// as `export GH_REPO=x; gh pr view 1` does, makes that call record nothing (lib/session-prs.mjs).
export const variables = Object.freeze(['GH_REPO', 'GH_HOST']);

// The options that take a value, per `gh pr` command read here, from each command's `--help`, so the word after one is
// never read as the pull request. `-R` and `--repo` take one everywhere.
const REPO = ['-R', '--repo'];
const VALUES = {
  create: ['-a', '--assignee', '-B', '--base', '-b', '--body', '-F', '--body-file', '-H', '--head', '-l', '--label', '-m', '--milestone', '-p', '--project', '--recover', '-r', '--reviewer', '-T', '--template', '-t', '--title'],
  ready: [],
  edit: ['--add-assignee', '--add-label', '--add-project', '--add-reviewer', '-B', '--base', '-b', '--body', '-F', '--body-file', '-m', '--milestone', '--remove-assignee', '--remove-label', '--remove-project', '--remove-reviewer', '-t', '--title'],
  merge: ['-A', '--author-email', '-b', '--body', '-F', '--body-file', '--match-head-commit', '-t', '--subject'],
  checks: ['-i', '--interval', '-q', '--jq', '-t', '--template', '--json'],
  view: ['-q', '--jq', '-t', '--template', '--json'],
  comment: ['-b', '--body', '-F', '--body-file'],
};
const VERBS = new Map(Object.entries(VALUES).map(([verb, values]) => [verb, new Set([...REPO, ...values])]));
// A pull request link as gh prints it, the whole line: https://<host>/<owner>/<name>/pull/<number>. Linear: no part can
// match another's characters.
const PULL_URL = /^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+$/u;
// A word gh may read as a URL, or as `<owner>:<branch>`, the branch of that owner's fork, which targetOf reads apart.
const SCHEME_OR_OWNER = /^[^/]*:/u;
const OWNER_BRANCH = /^([^:/]+):([^:/][^:]*)$/u;
// The ref git keeps for the pull request `gh pr checkout` checked out, as a branch's `branch.<name>.merge`.
const PULL_HEAD = /^refs\/pull\/(\d{1,10})\/head$/u;
// What a call the reader cannot read gives.
const UNREAD = Symbol('unread');

// The value of the variable `name` for this invocation, after its assignments and env changes, as a word: null when it is
// unset or empty.
function invocationValue(name, environment, env) {
  let value = typeof env[name] === 'string' && env[name] !== '' ? { text: env[name] } : null;
  for (const change of environment) {
    if (change.clear) value = change.keep?.includes(name) ? value : null;
    else if (change.name === name) value = change.value ?? null;
  }
  return value === null || value.text === '' ? null : value;
}

// A `-R` or GH_REPO value as `{ host, path }`, or UNREAD: one the reader cannot read, one that names no repository, and a
// bare `owner/name` while GH_HOST is set, since gh then reads it on that host.
function repoValue(value, environment, env) {
  if (unreadable(value)) return UNREAD;
  const bare = !value.text.includes(':') && value.text.split('/').filter(Boolean).length === 2;
  if (bare && invocationValue('GH_HOST', environment, env) !== null) return UNREAD;
  return repoIdentity(value.text) ?? UNREAD;
}

// The repository GH_REPO names for this invocation, as repoValue reads it, or null when none is set.
function ghRepo(environment, env) {
  const value = invocationValue('GH_REPO', environment, env);
  return value === null ? null : repoValue(value, environment, env);
}

// The pull request a target word names: `{ number }`, `{ repo, number }` for a link, `{ branch }`, `{ branch, owner }`
// for gh's `<owner>:<branch>`, whose head is that owner's, or UNREAD.
function targetOf(word) {
  if (unreadable(word) || word.text.startsWith('-')) return UNREAD;
  const parsed = parseTarget(word.text);
  if (parsed.number !== undefined && parsed.host === undefined) return { number: parsed.number };
  if (parsed.number !== undefined) return { repo: repoIdentity(`https://${parsed.host}/${parsed.owner}/${parsed.name}`) ?? UNREAD, number: parsed.number };
  const headed = OWNER_BRANCH.exec(word.text);
  if (headed && isLogin(headed[1])) return { branch: headed[2], owner: headed[1] };
  if (SCHEME_OR_OWNER.test(word.text) || /^#?\d+$/u.test(word.text)) return UNREAD;
  return { branch: word.text };
}

// The ledger call of one invocation (shell-lex readInvocation), or null when it is none or the reader cannot read it:
// `{ kind: 'created', repo }` for `gh pr create`, none with `--dry-run`, which prints a preview and creates nothing, and
// `{ kind: 'touched', repo, target }` for `gh pr ready|edit|merge|checks|view|comment`, where `repo` is the repository `-R` or GH_REPO names as `{ host, path }`, or null when neither
// does, and `target` the pull request named, as targetOf reads it, or null for the current branch's. `env` is the
// hook's environment, which a session's commands inherit.
export function readCall({ program, args = [], environment = [] }, env = {}) {
  if (program !== 'gh') return null;
  const [noun, said] = commandPath(args);
  const verb = said === 'new' ? 'create' : said;
  if (noun !== 'pr' || !VERBS.has(verb)) return null;
  const { words, flags } = readWords(args, VERBS.get(verb));
  if (flags.some(({ name }) => name === '-h' || name === '--help')) return null;
  // A word the shell fills in unquoted may split into flags, such as a second `-R`.
  if (args.some((token) => token.splits || token.expands)) return null;
  if (words.some((word) => unreadable(word)) || flags.some(({ name, value }) => REPO.includes(name) && (value === null || unreadable(value)))) return null;
  const flag = flags.filter(({ name }) => REPO.includes(name)).at(-1);
  const repo = flag ? repoValue(flag.value, environment, env) : ghRepo(environment, env);
  if (repo === UNREAD) return null;
  if (verb === 'create') return flags.some(({ name }) => name === '--dry-run') ? null : { kind: 'created', repo };
  const target = words[2] ? targetOf(words[2]) : null;
  if (target === UNREAD || target?.repo === UNREAD) return null;
  return { kind: 'touched', repo, target };
}

// The pull requests `gh pr create`'s output links, each `{ repo, number }`: every line that is exactly a pull request
// link, read through repoIdentity. The caller passes the bounded tail of the output.
export function createdChanges(output) {
  return output.split('\n').map((line) => line.replace(/\r$/u, '')).filter((line) => PULL_URL.test(line)).flatMap((line) => {
    const { host, owner, name, number } = parseTarget(line);
    const repo = number === undefined ? null : repoIdentity(`https://${host}/${owner}/${name}`);
    return repo ? [{ repo, number }] : [];
  });
}

// The repository a `<owner>:<branch>` target's head is in, from the repository the call reads, `{ host, path }`: that
// owner's repository of the same name, gh's fork. The forge's lookup then holds the pull request's head to it.
// SHORTCUT: a fork renamed from its parent's name resolves to none. Enough for display data; gh's own head label match,
// by owner alone, would replace it.
export const headRepository = (repo, owner) => ({ host: repo.host, path: `${owner}/${repo.path.split('/').at(-1)}` });

// The pull request a branch's `branch.<name>.merge` names when gh checked it out (`refs/pull/<n>/head`), which gh then
// reads before any branch lookup, as its number; else null.
export function checkedOutChange(merge) {
  const match = typeof merge === 'string' ? PULL_HEAD.exec(merge) : null;
  return match ? Number(match[1]) : null;
}
