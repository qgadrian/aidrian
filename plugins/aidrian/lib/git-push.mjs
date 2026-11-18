// What a `git push` on a session's command line pushes, read from its words alone, for the session ledger
// (lib/session-prs.mjs). Git is no forge, so this names none. It runs nothing: the remote's URL and the folder's branch
// are the ledger's reads. A push it cannot read with certainty gives nothing, so no row names a repository or branch the
// push may not have touched.

import { changesVariable, isLongOption, readGit, readShortOptions } from './shell-lex.mjs';

// The branch a refspec pushes when it names the folder's current branch.
export const CURRENT = Symbol('current');
const NOTHING = Symbol('nothing');
// The variables that move the repository, the work tree, or the config git reads: set, unset, or emptied by `env -i` on
// the line, they make every git and forge call on it record nothing. GIT_CONFIG_KEY_<n> takes effect only with
// GIT_CONFIG_COUNT, so that name covers them.
const GIT_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'];
// The git global options a read push may carry: `-C` with its folder, which the walk reads, and switches that change no
// repository or config. Any other, such as `-c`, `--config-env`, `--git-dir`, or `--work-tree`, gives nothing.
const PLAIN_GLOBALS = new Set(['--no-pager', '-P', '-p', '--paginate', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs']);
const PUSH_VALUES = new Set(['-o']);
const PUSH_LONG_VALUES = ['--repo', '--push-option', '--receive-pack', '--exec'];

// Whether readInvocation's invocation changes a variable of GIT_VARIABLES for what it runs, or for the shell after it.
export const changesGitTarget = (invocation) => GIT_VARIABLES.some((name) => changesVariable(invocation, name));

// The branch one refspec pushes to: a name, CURRENT for the folder's branch, or NOTHING.
function refspecBranch(text) {
  const spec = text.startsWith('+') ? text.slice(1) : text;
  const colon = spec.indexOf(':');
  if (colon === -1 && (spec === 'HEAD' || spec === '@')) return CURRENT;
  const dst = colon === -1 ? spec : spec.slice(colon + 1);
  if (colon === 0 || dst === '' || dst === 'HEAD' || dst === '@') return NOTHING;
  if (dst.startsWith('refs/heads/')) return dst.slice('refs/heads/'.length) || NOTHING;
  return dst.startsWith('refs/') ? NOTHING : dst;
}

// The branch each refspec of `specs` pushes, as refspecBranch reads it, with git's `tag <name>` form, which pushes the
// tag refs/tags/<name>, giving none for both words. Null for a `tag` with no name after it, which git refuses.
function tagFree(specs) {
  const refs = [];
  for (let i = 0; i < specs.length; i += 1) {
    if (specs[i] !== 'tag') refs.push(refspecBranch(specs[i]));
    else if (i + 1 < specs.length) i += 1;
    else return null;
  }
  return refs;
}

// The option word `text` of a push: 'stop' for one that pushes no branch, 'value' for one whose value is the next word,
// `{ repo }` for `--repo=<remote>`, else null.
function pushOption(text) {
  if (text.startsWith('--')) {
    if (isLongOption(text, '--delete', '--de') || isLongOption(text, '--dry-run', '--dr')) return 'stop';
    if (['--all', '--mirror', '--branches', '--tags'].some((each) => isLongOption(text, each, each))) return 'stop';
    if (text.startsWith('--repo=')) return { repo: text.slice('--repo='.length) };
    return PUSH_LONG_VALUES.includes(text) ? 'value' : null;
  }
  const { options, value } = readShortOptions(text, PUSH_VALUES);
  if (options.includes('-d') || options.includes('-n')) return 'stop';
  return value && value.attached === null ? 'value' : null;
}

// Whether every git global option before `push` is `-C` with its folder or one of PLAIN_GLOBALS.
function plainGlobals(globals) {
  for (let i = 0; i < globals.length; i += 1) {
    if (globals[i].text === '-C') i += 1;
    else if (!PLAIN_GLOBALS.has(globals[i].text)) return false;
  }
  return true;
}

// The words after `push`: { operands, repo }, or null for a push that pushes no branch or holds a word the shell fills
// in or expands, the value of `--repo` included.
function pushWords(rest) {
  const operands = [];
  let repo = null;
  let ended = false;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.dynamic || token.expands) return null;
    if (ended || !token.text.startsWith('-') || token.text === '-') operands.push(token.text);
    else if (token.text === '--') ended = true;
    else {
      const option = pushOption(token.text);
      if (option === 'stop') return null;
      if (option?.repo) repo = option.repo;
      if (option !== 'value') continue;
      const value = rest[i + 1];
      if (value && (value.dynamic || value.expands)) return null;
      if (token.text === '--repo') repo = value?.text ?? null;
      i += 1;
    }
  }
  return { operands, repo };
}

// A `git push` of one walked command (shell-lex walkCommands) as `{ remote, refs }`: `remote` the word naming it, null
// for origin, and `refs` the branch each refspec pushes, CURRENT for the folder's, empty for no refspec. Null for no push,
// and for a push that pushes no branch, holds a word the shell fills in or expands, carries a git global option that
// may move its repository or config, or changes a variable of GIT_VARIABLES itself.
export function readPush(entry) {
  const git = readGit(entry.segment);
  if (git?.subcommand !== 'push' || !plainGlobals(git.globals) || changesGitTarget(entry.invocation)) return null;
  const words = pushWords(git.rest);
  if (words === null) return null;
  const [remote = words.repo, ...specs] = words.operands;
  if (remote?.startsWith('-')) return null;
  const refs = tagFree(specs);
  if (refs === null) return null;
  if (specs.length > 0 && refs.every((ref) => ref === NOTHING)) return null;
  return { remote, refs: refs.filter((ref) => ref !== NOTHING) };
}
