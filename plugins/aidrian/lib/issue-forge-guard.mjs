// What a project run's issue session asks of the forge that it never asks, however its sandbox lets it reach the forge
// with the token it keeps: a push of anything but its own branch, a release, a workflow, a raw API write outside its
// pull request and issue, or a change to the repository's settings, secrets, or keys. The agent gate hook asks it
// on every call of such a session and its subagents, through lib/unattended-write.mjs unattendedWriteDenial.
// docs/hooks.md#agent-gates says what passes; docs/review.md names what a script the session runs can still do.
//   - A session is held when its unattended mark names an issue, with any tag shape, or cannot be read; a pending
//     mark's hold, an attended session, and a run's driver are not (unattended-mark.mjs issueHeld).
//   - `git push`: only `git push origin HEAD:refs/heads/<branch>`, `<branch>` the one its issue's latest start names
//     (project-run-guard.mjs ownIssue), with a `+` or a force option that names only that branch, and switches
//     that change nothing else, in a call of its own: beside it only `cd`, git's reads (BESIDE_GIT) with the options
//     that only read (BESIDE_OPTIONS), and text filters (BESIDE_PROGRAMS), so no command of the call changes the commits
//     it carries after the guard read them. git then
//     holds the checkout (issue-push-checkout.mjs): its own clone or worktree, not a repository nested in it, with origin
//     pushing to the URL its issue's start pinned, commits that change no host config or instruction file when that
//     start gave its clone the base branch's copies of them, and commits that change none of the forge's workflow files
//     (forges/index.mjs forgeWorkflowFolders) from where they leave origin's default branch, however the session made
//     them, as a `git apply`, `patch`, or `tar -x` puts such a file in a commit past the file-write guard, and no
//     uncommitted change to one.
//     git's other ways to push, `send-pack` and `http-push`, are refused, and so is every git subcommand outside
//     GIT_COMMANDS, such as an alias or `subtree`, but for `git lfs`'s forms that push nothing (LFS_READS).
//   - The forge CLI: the subcommands forges/index.mjs forgeRefCommands lists, and a raw API call forgeApiWrite reads
//     as a write the session never makes.
//   - git or the forge CLI run through a program the shared lexer does not unwrap, `xargs`, `xcrun`, or `find -exec`,
//     or a command git runs for a subcommand, as `git submodule foreach` or `git rebase --exec`, that names them.
// It reads only the command, as the shared lexer reads it, and asks git once or twice, for an exact push only, which
// paths the push's commits change. A word built at run time where a subcommand, a route, or a method goes is refused.

import { projectRuleReason } from './agent-gates.mjs';
import { bashCall, opaqueTexts } from './config-guard.mjs';
import { checkDeadline } from './deadline.mjs';
import { forgeApiWrite, forgeRefCommands } from './forges/index.mjs';
import { isWithin } from './fs.mjs';
import { changesGitTarget, plainGlobals } from './git-push.mjs';
import { opaqueShellCommand } from './hosts/index.mjs';
import { pushCheckoutProblem } from './issue-push-checkout.mjs';
import { changedVariables, changesVariable, GIT_VALUE_GLOBALS, readShortOptions, walkCommands } from './shell-lex.mjs';
import { issueHeld } from './unattended-mark.mjs';
import { runsDeclared } from './unattended-shell.mjs';

// git's own ways to push, besides `push`.
const OTHER_PUSHES = new Set(['send-pack', 'http-push']);
// The words of a command the lexer cannot read, or of a command word built at run time, that may push or ask the forge.
const FORGE_WORD = /\b(?:push|send-pack|http-push|release|workflow|api|secret|variable|deploy-key)\b/iu;
// A word that names git or the forge CLI, as a program or in a command's text.
const GIT_OR_FORGE = /\b(?:git|gh)\b/u;
// The `git push` switches that change no ref and no remote, and the short ones, alone or in a cluster: -u, -q, -v, -n,
// -f. A force names only the refspec's own branch, which the refspec check holds.
const PUSH_SWITCHES = new Set(['--set-upstream', '--quiet', '--verbose', '--progress', '--no-progress', '--porcelain', '--dry-run', '--force', '--force-if-includes', '--no-force-if-includes']);
const PUSH_SHORT = new Set(['-u', '-q', '-v', '-n', '-f']);
// git's own subcommands an issue session runs: any other word, such as an alias or `subtree`, which pushes, is refused.
const GIT_COMMANDS = new Set([
  'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'check-ref-format',
  'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'commit-tree', 'config', 'count-objects', 'describe', 'diff', 'diff-files',
  'diff-index', 'diff-tree', 'difftool', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'log',
  'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge', 'merge-base', 'merge-file', 'merge-tree', 'mergetool', 'mv', 'name-rev', 'notes',
  'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'reflog', 'remote', 'repack', 'replace', 'rerere', 'reset', 'restore', 'rev-list',
  'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'status', 'stripspace', 'submodule',
  'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'verify-commit', 'verify-tag', 'version', 'whatchanged', 'worktree',
  'write-tree', 'send-pack', 'http-push', 'interpret-trailers', 'patch-id', 'prune', 'check-mailmap',
]);
// The `git lfs` subcommands that push nothing, the only ones an issue session runs.
const LFS_READS = new Set(['ls-files', 'status', 'env', 'version', 'fetch', 'pull', 'checkout', 'track', 'untrack', 'logs', 'pointer']);
// The git subcommands that run a command their arguments give, as `git submodule foreach`, `git rebase --exec`, and
// `git bisect run` do: refused when that command names git, the forge CLI, or a push.
const RUNS_COMMANDS = new Set(['submodule', 'rebase', 'bisect', 'difftool', 'mergetool']);
// The programs that run a command their arguments name, which the shared lexer does not read as wrappers, and find's
// options that do; and the shells such a command may be, whose text is then read for git or the forge.
const RUNNERS = new Set(['xargs', 'xcrun', 'find']);
const FIND_RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
// What may share a call with the exact push, since none changes HEAD, the index, or the working tree: git's reads, with
// `git branch` only as `--show-current`, and programs that only read their input or files and print. A fetch moves
// origin's remote-tracking ref, the base of the workflow diff, so it runs in a call of its own too.
const BESIDE_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse']);
// The options those reads take beside the push, alone or with `=<value>` (BESIDE_VALUED), plus `-<n>`, `-n <n>`, and
// `-U<n>`: no other, since `--output` writes a file, as a branch's ref in the clone's git folder, and `--ext-diff`,
// `--textconv`, and an unknown option may run a program, after the guard read the commits.
const BESIDE_OPTIONS = new Set([
  '--short', '-s', '--branch', '-b', '--long', '--porcelain', '-z', '--ahead-behind', '--no-ahead-behind', '-u', '--untracked-files', '--ignored',
  '--oneline', '--graph', '--decorate', '--no-decorate', '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--summary',
  '--abbrev-commit', '--no-abbrev-commit', '--color', '--no-color', '--reverse', '--first-parent', '--merges', '--no-merges', '--all',
  '-p', '--patch', '--no-patch', '--cached', '--staged', '--quiet', '-q', '--exit-code', '--check', '--no-ext-diff', '--no-textconv',
  '--word-diff', '--full-index', '--no-renames', '--raw', '--left-right', '--cherry-pick', '--boundary', '--walk-reflogs', '-g',
  '--abbrev-ref', '--show-toplevel', '--show-prefix', '--git-dir', '--git-common-dir', '--absolute-git-dir', '--is-inside-work-tree',
  '--symbolic-full-name', '--verify', '--show-current',
]);
const BESIDE_VALUED = new Set([
  '--format', '--pretty', '--max-count', '--skip', '--since', '--after', '--until', '--before', '--author', '--committer', '--grep', '--date',
  '--abbrev', '--unified', '--porcelain', '--untracked-files', '--ignored', '--path-format', '--color', '--decorate', '--stat', '--short',
  '--abbrev-ref', '--diff-filter', '--word-diff',
]);
const BESIDE_PROGRAMS = new Set(['echo', 'printf', 'true', 'head', 'tail', 'wc', 'cat', 'grep']);
// The variables, besides git-push.mjs GIT_VARIABLES, that move the config files git reads, and so where a push goes.
const CONFIG_HOMES = ['HOME', 'XDG_CONFIG_HOME'];
// The forge CLI's global options that take the next word, skipped before its subcommand.
const FORGE_VALUES = new Set(['-R', '--repo', '--hostname', '-h']);

// Why the call in `input` may not run because a project run's issue session, which `mark` holds (unattended-mark.mjs issueHeld), asks the
// forge for what it never asks, or null: { match, reason }. `issue()` gives the session's { key, branch }
// (project-run-guard.mjs ownIssue), or null when it cannot be told, which refuses every push; `roots()`, the folders a
// push may run in, its own clone's and worktree's, each { root, common }, the real, case-folded paths of its top folder
// and its git common folder. `fold(path)` gives a path as roots holds them.
export function issueForgeDenial(input, { names: { human } }, { mark = null, issue = () => null, roots = () => [], fold = (each) => each, cwd = process.cwd() } = {}) {
  if (!issueHeld(mark)) return null;
  const deny = (match, why) => ({ match, reason: projectRuleReason(input, `${why}, and a project run's issue session never does that: only ${human} does`, human, 'to make that change, or record the issue parked with the decision it needs', { mark }) });
  const opaque = opaqueShellCommand(input);
  if (opaque !== null) {
    return opaqueTexts(opaque).some((text) => FORGE_WORD.test(text)) ? deny('issue session forge call it cannot read', 'it runs a shell the guard cannot read, in words that may push, release, or call the forge') : null;
  }
  const command = bashCall(input) && typeof input.tool_input?.command === 'string' ? input.tool_input.command : null;
  if (command === null || !/push|send-pack|gh|git|release|workflow|api|secret|variable|alias|repo|run|key|cache/iu.test(command)) return null;
  const entries = [...walkCommands(command, cwd)];
  const moved = entries.some(({ invocation }) => changesGitTarget(invocation) || CONFIG_HOMES.some((name) => changesVariable(invocation, name)));
  const beside = entries.find((entry) => !besidePush(entry)) ?? null;
  for (const entry of entries) {
    checkDeadline();
    const found = entryProblem(entry, { moved, issue, roots, fold, beside });
    if (found) return deny(found.match, found.why);
  }
  return null;
}

// Whether one walked command (shell-lex walkCommands) may run in the call of the exact push: a git push, whose own words
// and variables pushProblem holds, a read of BESIDE_GIT, `git branch --show-current`, or a program of BESIDE_PROGRAMS,
// none built at run time, feeding a shell the walk could not read, or run with a variable set or removed for it
// (`VAR=value`, `env VAR=value`, `env -u`), since one such as GIT_EXTERNAL_DIFF makes a read run a program.
function besidePush({ invocation, unread }) {
  if (unread !== undefined || invocation.dynamic) return false;
  const sets = changedVariables(invocation).length > 0;
  if (invocation.program !== 'git') return !sets && BESIDE_PROGRAMS.has(invocation.program);
  const git = gitCall(invocation.args ?? []);
  if (!git || git.built || !plainGlobals(git.globals) || git.rest.some((token) => token.dynamic)) return false;
  if (git.subcommand === 'push') return true;
  if (sets) return false;
  if (git.subcommand === 'branch') return git.rest.length === 1 && git.rest[0].text === '--show-current';
  return BESIDE_GIT.has(git.subcommand) && readsOnly(git.rest.map((token) => token.text));
}

// Whether the words after a read of BESIDE_GIT take only the options BESIDE_OPTIONS and BESIDE_VALUED name, with any
// revisions and paths: an option such as `--output`, `-o`, `--ext-diff`, `--textconv`, or `--exec` makes it no read.
function readsOnly(words) {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--') return true;
    if (!word.startsWith('-') || word === '-') continue;
    if (/^-(?:\d+|n\d+|U\d+)$/u.test(word)) continue;
    if (word === '-n' && /^\d+$/u.test(words[i + 1] ?? '')) {
      i += 1;
      continue;
    }
    const at = word.indexOf('=');
    if (at < 0 ? BESIDE_OPTIONS.has(word) : word.startsWith('--') && BESIDE_VALUED.has(word.slice(0, at))) continue;
    return false;
  }
  return true;
}

// The words of a walked command, for a refusal.
const spelled = ({ invocation }) => [invocation.program ?? '', ...(invocation.args ?? []).map((token) => token.text)].join(' ').slice(0, 80);

// What one walked command (shell-lex walkCommands) asks that the session never asks: { match, why }, or null.
function entryProblem(entry, holds) {
  const { invocation } = entry;
  const args = invocation.args ?? [];
  if (typeof entry.unread === 'string' && FORGE_WORD.test(entry.unread)) return { match: 'issue session forge call it cannot read', why: 'it feeds a shell a command the guard cannot read, which names a push, a release, a workflow, or the forge API' };
  if (invocation.dynamic) {
    return [invocation.program ?? '', ...args.map((token) => token.text)].some((text) => FORGE_WORD.test(text) || /\bgit\b|\bgh\b/u.test(text))
      ? { match: 'issue session command built at run time', why: 'it runs a command whose program is built at run time, in words that name git, the forge CLI, or a push' }
      : null;
  }
  if (invocation.program === 'git') return gitProblem(entry, holds);
  return runnerProblem(invocation.program, args) ?? forgeProblem(invocation.program, args);
}

// What a program that runs another command (RUNNERS) asks, when that command is git or the forge CLI, or a shell whose
// text names them or a push: { match, why }, or null. The command's words are not read further: xargs adds words from
// its input, and find the paths it finds, so no push it runs can be told exact.
function runnerProblem(program, args) {
  if (!RUNNERS.has(program)) return null;
  const texts = args.map((token) => token.text);
  const starts = program === 'find' ? texts.flatMap((text, at) => (FIND_RUNS.has(text) ? [at + 1] : [])) : [0];
  const named = starts.some((start) => {
    const words = program === 'find' ? texts.slice(start, start + 1) : texts.slice(start);
    const programs = words.map((word) => word.split('/').pop());
    // A shell, or a word built at run time, may be git: then any word after it that names git, the forge, or a push counts.
    const opaque = programs.some((word) => SHELLS.has(word)) || args.slice(start).some((token) => token.dynamic);
    return programs.some((word) => word === 'git' || word === 'gh') || (opaque && texts.slice(start).some((text) => GIT_OR_FORGE.test(text) || FORGE_WORD.test(text)));
  });
  return named ? { match: 'issue session git or forge call through another program', why: `it runs git or the forge CLI through ${program}, which hands it words the guard cannot read, so it may push any ref or write the forge` } : null;
}

// The git subcommand of a call's arguments `args`, with the global options before it and the words after it:
// { subcommand, globals, rest }, { built: true } when a word built at run time stands where an option or the
// subcommand goes, or null when there is none.
function gitCall(args) {
  const globals = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.dynamic) return { built: true };
    if (GIT_VALUE_GLOBALS.has(token.text)) {
      globals.push(token, ...(args[i + 1] ? [args[i + 1]] : []));
      i += 1;
    } else if (token.text.startsWith('-')) globals.push(token);
    else return { subcommand: token.text, globals, rest: args.slice(i + 1) };
  }
  return null;
}

// What a git call asks that the session never asks (entryProblem).
function gitProblem(entry, { moved, issue, roots, fold, beside }) {
  const git = gitCall(entry.invocation.args ?? []);
  if (!git) return null;
  if (git.built) return { match: 'issue session git command built at run time', why: 'it runs git with a subcommand or an option built at run time, which may push any ref' };
  if (OTHER_PUSHES.has(git.subcommand)) return { match: 'issue session push', why: `it pushes with \`git ${git.subcommand}\`, which may push any ref to any repository` };
  if (git.subcommand === 'push') {
    const why = pushProblem(git, { moved, issue, folder: entry.folder, roots, fold, beside, sets: changedVariables(entry.invocation) });
    return why ? { match: 'issue session push', why } : null;
  }
  if (git.subcommand === 'lfs') {
    const lfs = git.rest.find((token) => token.dynamic || !token.text.startsWith('-'));
    return lfs && !lfs.dynamic && LFS_READS.has(lfs.text) ? null : { match: 'issue session git lfs write', why: `it runs \`git lfs ${lfs?.text.slice(0, 40) ?? ''}\`, and an issue session runs only the forms of git lfs that push nothing` };
  }
  if (!GIT_COMMANDS.has(git.subcommand)) return { match: 'issue session git command', why: `it runs \`git ${git.subcommand.slice(0, 40)}\`, which is none of the git commands an issue session runs: an alias, or a command such as subtree, may push any ref` };
  if (RUNS_COMMANDS.has(git.subcommand) && git.rest.some((token) => token.dynamic || GIT_OR_FORGE.test(token.text) || FORGE_WORD.test(token.text))) {
    return { match: 'issue session git call through git', why: `it has \`git ${git.subcommand}\` run a command that names git, the forge CLI, or a push, which the guard does not read, so it may push any ref` };
  }
  return null;
}

// Why a `git push` (gitCall's `git`) is not the session's own exact push, or null: `git push origin
// HEAD:refs/heads/<branch>`, with `+` or a lease that names only that branch, with no variable set or removed for it
// (`sets`, the names changedVariables gives), run in a call of its own (`beside`, the first command of the call that may
// not share it, or null) in one of its roots. What the words alone refuse is read first: the branch (`issue()`) and the
// roots are read only for a push shaped like its own, and git only past them all.
function pushProblem(git, { moved, issue, folder, roots, fold, beside, sets = [] }) {
  if (moved || !plainGlobals(git.globals)) return 'it pushes with a git option or variable that changes the repository or the config git reads, which may point the push anywhere';
  if (sets.length > 0) return `it pushes with ${sets[0] === '*' ? 'its environment changed' : `${sets[0].slice(0, 40)} set or removed`} for the push, and a variable such as GIT_SSH_COMMAND runs a program and GIT_TRACE writes a file; an issue session runs its one push with no variable of its own`;
  if (git.rest.some((token) => token.dynamic)) return 'it pushes with a word built at run time, which may name any ref or remote';
  const operands = [];
  const leases = [];
  let ended = false;
  for (const { text } of git.rest) {
    if (ended || !text.startsWith('-') || text === '-') operands.push(text);
    else if (text === '--') ended = true;
    else if (text.startsWith('--force-with-lease')) {
      if (text !== '--force-with-lease' && !text.startsWith('--force-with-lease=')) return `it pushes with \`${text.slice(0, 60)}\`, an option the one push of an issue session does not take`;
      if (text.includes('=')) leases.push(text.slice(text.indexOf('=') + 1).split(':')[0]);
    } else if (text.startsWith('--') ? !PUSH_SWITCHES.has(text) : !readShortOptions(text, new Set()).options.every((option) => PUSH_SHORT.has(option))) {
      return `it pushes with \`${text.slice(0, 60)}\`, an option the one push of an issue session does not take, as one may push other refs, tags, or to another place`;
    }
  }
  const shaped = operands.length === 2 && operands[0] === 'origin' && /^\+?HEAD:refs\/heads\/./u.test(operands[1]);
  if (!shaped) return `it pushes \`${operands.join(' ').slice(0, 120) || 'with no remote or refspec'}\`, and the one push it makes is \`git push origin HEAD:refs/heads/<its branch>\``;
  const own = issue();
  const branch = own?.branch ?? null;
  if (branch === null) return 'it pushes, and no running start of its issue names the branch it may push';
  const exact = `HEAD:refs/heads/${branch}`;
  if (operands[1] !== exact && operands[1] !== `+${exact}`) return `it pushes \`${operands.join(' ').slice(0, 120)}\`, and the one push it makes is \`git push origin ${exact}\``;
  const lease = leases.find((each) => each !== branch && each !== `refs/heads/${branch}`);
  if (lease !== undefined) return `it pushes with a lease on ${lease.slice(0, 80)}, not on its own branch ${branch}`;
  if (beside) return `it pushes in a call that also runs \`${spelled(beside)}\`, which may change the commits the push carries after the guard read them; an issue session pushes in a call of its own: commit first, then run \`git push origin ${exact}\` alone`;
  const root = typeof folder === 'string' ? roots().find((each) => isWithin(each.root, fold(folder))) : undefined;
  if (!root) return 'it pushes from a folder that is not its own clone or worktree, whose origin may be any repository';
  return pushCheckoutProblem(folder, { root, pushUrl: own.pushUrl ?? null, fold, overlay: own.overlay ?? null, policyFiles: own.policyFiles ?? [], indexFiles: own.indexFiles ?? [] });
}

// What a forge CLI call asks that the session never asks (entryProblem): a refused subcommand, or a raw API write.
function forgeProblem(program, args) {
  const words = args.filter((token) => !token.dynamic).map((token) => token.text);
  const refused = forgeRefCommands().find((each) => runsDeclared(each, program, words));
  if (refused) return { match: 'issue session forge write', why: `it changes ${refused.what} with \`${[program, ...words].join(' ').slice(0, 100)}\`` };
  if (forgeRefCommands().some((each) => each.programs.includes(program))) {
    // The forge CLI's subcommand words, past its global options: one built at run time may name any of them.
    const named = [];
    for (let i = 0; i < args.length && named.length < 2; i += 1) {
      if (!args[i].dynamic && FORGE_VALUES.has(args[i].text)) i += 1;
      else if (args[i].dynamic || !args[i].text.startsWith('-')) named.push(args[i]);
    }
    if (named.some((token) => token.dynamic)) return { match: 'issue session forge command built at run time', why: `it runs ${program} with a subcommand built at run time, which may be one that releases, runs a workflow, or writes the forge` };
  }
  const api = forgeApiWrite(program, args);
  return api ? { match: 'issue session forge write', why: `it writes ${api}` } : null;
}
