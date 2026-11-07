// The main-checkout rule's judgement of one git call in a guarded main checkout: the folders it acts on, and whether
// it is one of the plainly safe forms. git-state.mjs reads the calls of a command line.
//
// Like every Bash rule, it reads shell text, so it guards against accidents, not intent. Accepted residuals: a bracket
// glob that names a branch or `--all` (`topi[c]`), shell arguments after `bash -c` shaped like assignments, and quoted
// literal braces read as an expansion, which blocks a safe call in the main checkout.
// The main checkout is shared, so this reads what is plainly safe and blocks the rest, every other spelling included:
//   git add      only named files (no option but -v, -f, -N, -p, and no folder, glob, or pathspec magic)
//   git switch   only back to the default branch, with no option
//   git checkout the default branch with no option, or paths: after `--`, or words that name no commit
//   git merge    and git pull, only with --ff-only toward the default branch's upstream, which makes no commit and
//                brings in nothing that is not on origin, and no option but the quiet and verbose ones
//   git reset    only of named files, which unstages them and moves nothing
//   --abort and --quit alone, for merge, rebase, cherry-pick, revert, and am: they clean up a stray operation
// and never a commit, cherry-pick, revert, rebase, am, or commit-tree: each makes commits on the shared branch.

import { lstatSync } from 'node:fs';
import path from 'node:path';

import { runGit } from '../../git.mjs';
import { canonical, existingFolder, guardedMain } from './checkout.mjs';

// git's own options that change nothing about the repository or how paths match. `-c` is not one: a value such as
// core.worktree moves the checkout.
const SAFE_GLOBALS = /^(?:-C.*|--git-dir(?:=.*)?|--work-tree(?:=.*)?|--no-pager|-P|--paginate|-p|--no-optional-locks|--no-replace-objects)$/u;
const ADD_SAFE = new Set(['-v', '--verbose', '-f', '--force', '-N', '--intent-to-add', '-p', '--patch']);
// The git calls that make commits or move the branch, and what each does, as the deny reason says it. merge, pull, and
// reset have safe forms, read in historySafe.
const HISTORY = new Map([
  ['commit', 'makes a commit'],
  ['commit-tree', 'makes a commit'],
  ['cherry-pick', 'makes commits'],
  ['revert', 'makes commits'],
  ['am', 'makes commits'],
  ['rebase', 'rewrites the branch'],
  ['merge', 'without --ff-only can make a merge commit'],
  ['pull', 'without --ff-only can make a merge commit or rebase'],
  ['reset', 'of anything but named paths moves the branch or unstages other sessions\' work'],
]);
// The git calls this rule judges in the main checkout; any other runs.
export const JUDGED = new Set(['add', 'switch', 'checkout', ...HISTORY.keys()]);
// The options a fast-forward merge or pull may carry: none changes what it makes.
const FF_SAFE = new Set(['--ff-only', '-q', '--quiet', '-v', '--verbose', '--stat', '-n', '--no-stat', '--progress', '--no-progress']);
const PULL_SAFE = new Set([...FF_SAFE, '--no-rebase']);
// The options a reset of named files may carry. A mode (--hard, --soft, --mixed, --merge, --keep) is none of them, and
// neither is --pathspec-from-file, whose paths this rule cannot read.
const RESET_SAFE = new Set(['-q', '--quiet', '-p', '--patch', '-N', '--intent-to-add', '--no-refresh', '--refresh']);
// The operations that stop on a conflict, which `--abort` or `--quit` alone ends without a commit.
const ABORTABLE = new Set(['merge', 'rebase', 'cherry-pick', 'revert', 'am']);
// What `git merge --ff-only` may name: the default branch's upstream, or what a fetch just brought.
const UPSTREAM = new Set(['@{u}', '@{upstream}', 'FETCH_HEAD']);

// Whether a word may become other words when the shell expands it: a parameter, a substitution, a glob (the lexer's
// `dynamic`), or a brace expansion such as `{.,src}` or `--{all,x}`.
const expands = (token) => token.dynamic || /\{[^{}]*(?:,|\.\.)[^{}]*\}/u.test(token.text);

export const GIT_ASSIGNMENT = /^GIT_[A-Z_]+=/u;

// Today's judgement of one add, switch, checkout, or HISTORY call run at `cwd`: the change it makes, or null.
export function knownChange(call, invocation, cwd, scope) {
  const folders = gitFolders(call.globals, invocation.chdir, cwd, scope);
  // Nothing below costs a git call unless one of the folders is a guarded main checkout.
  if (folders === null || !folders.some((folder) => guardedMain(folder))) return null;
  // A global option that changes how paths match or which repository is read makes nothing plainly safe.
  const plainGlobals = call.globals.every(({ text }, i) => SAFE_GLOBALS.test(text) || (call.globals[i - 1] && ['-C', '--git-dir', '--work-tree'].includes(call.globals[i - 1].text)));
  const gitEnv = scope.some(({ text }) => GIT_ASSIGNMENT.test(text));
  const words = call.rest.map((token) => token.text);
  const dashes = words.indexOf('--');
  const before = dashes === -1 ? words : words.slice(0, dashes);
  const after = dashes === -1 ? [] : words.slice(dashes + 1);
  const options = before.filter((word) => word.startsWith('-') && word.length > 1);
  const operands = before.filter((word) => !(word.startsWith('-') && word.length > 1));
  const at = folders[0];
  const { defaultBranch } = folders.map((folder) => guardedMain(folder)).find(Boolean).config.git;
  if (HISTORY.has(call.subcommand) && !historySafe(call, { options, operands, dashes, after }, at, defaultBranch)) {
    return { what: `\`git ${call.subcommand}\` ${HISTORY.get(call.subcommand)} on the branch every session shares`, folders, target: null };
  }
  // --work-tree or --git-dir points git at a repository this hook does not read words in: nothing is plainly safe there.
  if (folders.length > 1 || !plainGlobals || gitEnv) {
    return { what: `\`git ${call.subcommand}\` with another repository, work tree, or pathspec option can change the shared checkout`, folders, target: null };
  }
  if (HISTORY.has(call.subcommand)) return null;
  if (call.subcommand === 'add') {
    const dynamic = call.rest.some(expands);
    if (dynamic || !options.every((option) => ADD_SAFE.has(option)) || ![...operands, ...after].every((word) => namedFile(at, word)) || ![...operands, ...after].length) {
      return { what: '`git add` of anything but named files can stage other sessions\' work', folders };
    }
  } else if (call.rest.some(expands)) {
    // A word that may expand can name any branch or option: a checkout or switch with one is not plainly safe.
    return { what: `\`git ${call.subcommand}\` with a word that may expand can move the folder every session shares`, folders, target: null };
  } else if (call.subcommand === 'switch') {
    const back = options.length === 0 && operands.length === 1 && !after.length;
    return { what: '`git switch` moves the folder every session shares to another branch', folders, target: back ? operands[0] : null };
  } else {
    const restore = options.length === 0 && (dashes !== -1 ? after.length > 0 : operands.length > 1 || (operands.length === 1 && !switchesTo(at, operands[0])));
    if (!restore) {
      const back = options.length === 0 && operands.length === 1 && dashes === -1;
      return { what: '`git checkout` moves the folder every session shares to another branch', folders, target: back ? operands[0] : null };
    }
  }
  return null;
}

// The folders a git call may act on: where it runs (a wrapper's `env -C`, then each `-C`), and its `--work-tree` and
// the folder holding its `--git-dir`. Null when one of them cannot be read, which leaves the call alone, as a path that
// may expand is.
export function gitFolders(globals, chdir, cwd, assignments = []) {
  if (chdir?.dynamic) return null;
  let at = chdir ? path.resolve(cwd, chdir.text) : cwd;
  // git resolves --work-tree and --git-dir from where it ends up, after every -C; GIT_DIR and GIT_WORK_TREE set on the
  // command count the same.
  const pending = [];
  // The last assignment of each variable is the one in force, as in the shell.
  const last = new Map(assignments.map((token) => [token.text.slice(0, token.text.indexOf('=')), token]));
  for (const { text, dynamic } of last.values()) {
    const assigned = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE)=(.*)$/su.exec(text);
    // A value that may expand names no folder; the call stays unsafe and is judged where it runs.
    if (!assigned || dynamic) continue;
    // An index file sits in its git folder, so it names that folder's checkout.
    const toFolder = { GIT_DIR: checkoutOfGitDir, GIT_WORK_TREE: (p) => p, GIT_INDEX_FILE: (p) => checkoutOfGitDir(path.dirname(p)) }[assigned[1]];
    pending.push([assigned[2], toFolder]);
  }
  for (let i = 0; i < globals.length; i += 1) {
    const { text, dynamic } = globals[i];
    const next = globals[i + 1];
    const value = (name) => (text === name ? next : text.startsWith(`${name}=`) ? { text: text.slice(name.length + 1), dynamic } : undefined);
    const chdirTo = text === '-C' ? next : /^-C./u.test(text) ? { text: text.slice(2), dynamic } : undefined;
    // -c core.worktree=<path> moves the work tree as --work-tree does.
    if (text === '-c' && next && /^core\.worktree=/iu.test(next.text)) {
      if (next.dynamic) return null;
      pending.push([next.text.slice(next.text.indexOf('=') + 1), (p) => p]);
    }
    for (const [given, toFolder] of [[chdirTo, null], [value('--work-tree'), (p) => p], [value('--git-dir'), checkoutOfGitDir]]) {
      if (given === undefined) continue;
      if (!given || given.dynamic) return null;
      if (toFolder === null) at = path.resolve(at, given.text);
      else pending.push([given.text, toFolder]);
    }
  }
  return [at, ...pending.map(([given, toFolder]) => toFolder(path.resolve(at, given)))];
}

// The checkout a git folder belongs to: its configured work tree, as for a separate git folder, or else the folder
// that holds it.
function checkoutOfGitDir(gitDir) {
  const tree = runGit(['--git-dir', gitDir, 'config', '--get', 'core.worktree'], existingFolder(path.dirname(gitDir)));
  return tree.status === 0 && tree.stdout.trim() ? path.resolve(gitDir, tree.stdout.trim()) : path.dirname(gitDir);
}

// Whether a HISTORY call is one of its safe forms: `--abort` or `--quit` alone, which ends a stray operation;
// `git merge --ff-only` and `git pull --ff-only` toward the default branch's upstream, which make no commit and bring
// nothing in that is not on origin; and `git reset` of named files, which only unstages them. A word that may expand
// is never safe.
function historySafe(call, { options, operands, dashes, after }, at, defaultBranch) {
  if (call.rest.some(expands)) return false;
  const { subcommand } = call;
  const words = call.rest.map(({ text }) => text);
  if (ABORTABLE.has(subcommand) && words.length === 1 && (words[0] === '--abort' || words[0] === '--quit')) return true;
  if (subcommand === 'merge' || subcommand === 'pull') {
    if (!options.includes('--ff-only') || !options.every((option) => (subcommand === 'pull' ? PULL_SAFE : FF_SAFE).has(option))) return false;
    if (dashes !== -1) return false;
    if (subcommand === 'merge') return operands.length === 0 || (operands.length === 1 && (UPSTREAM.has(operands[0]) || operands[0] === `origin/${defaultBranch}`));
    return operands.length === 0 || (operands.length === 2 && operands[0] === 'origin' && operands[1] === defaultBranch);
  }
  if (subcommand !== 'reset' || !options.every((option) => RESET_SAFE.has(option))) return false;
  // The first word before `--` may be the tree to read the paths from; with `--`, at most that one word comes before it.
  if (dashes !== -1 && operands.length > 1) return false;
  const tree = operands.length && (dashes !== -1 || namesCommit(at, operands[0]));
  const paths = [...(tree ? operands.slice(1) : operands), ...after];
  // No path at all unstages everything, other sessions' work included; so do a folder, a glob, and pathspec magic.
  return paths.length > 0 && paths.every((word) => namedFile(at, word));
}

// Whether `word` names one file for git add or git reset: no folder, glob, or pathspec magic, and nothing git tracks
// under it but itself.
const namedFile = (at, word) => !/[*?[\]:]/u.test(word) && !isFolder(path.resolve(at, word)) && tracksAtMostItself(at, word);

// Whether `git checkout <word>` would switch branches: the previous branch (`-`), a commit, or a remote branch git
// would create locally. Any other word is a path to restore.
function switchesTo(at, word) {
  if (word === '-' || namesCommit(at, word)) return true;
  const remote = runGit(['for-each-ref', '--format=%(refname)', `refs/remotes/*/${word}`], existingFolder(at));
  return remote.status === 0 && remote.stdout.trim() !== '';
}

// Whether `word` names a commit in the repository at `at`.
const namesCommit = (at, word) => runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${word}^{commit}`], existingFolder(at)).status === 0;

// Whether git tracks nothing under `word` but `word` itself: a folder deleted from disk still names every file in it.
function tracksAtMostItself(at, word) {
  const folder = existingFolder(at);
  const top = runGit(['rev-parse', '--show-toplevel'], folder);
  const listed = runGit(['ls-files', '-z', '--full-name', '--', word], folder);
  if (top.status !== 0 || listed.status !== 0) return false;
  // An unmerged file is listed once per stage: count each path once.
  const files = new Set(listed.stdout.split('\0').filter(Boolean).map((file) => canonical(path.join(top.stdout.trim(), file))));
  return files.size === 0 || (files.size === 1 && files.has(canonical(path.resolve(at, word))));
}

const isFolder = (file) => {
  try {
    return lstatSync(file).isDirectory();
  } catch {
    return false;
  }
};
