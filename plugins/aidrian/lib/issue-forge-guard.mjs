// What a project run's issue session asks of the forge that it never asks, however its sandbox lets it reach the forge
// with the token it keeps: a push of anything but its own branch, a release, a workflow, a raw API write outside its
// pull request and issue, or a change to the repository's settings, secrets, or keys. The agent gate hook asks it
// on every call of such a session and its subagents, through lib/unattended-write.mjs unattendedWriteDenial.
// docs/hooks.md#agent-gates says what passes; docs/review.md names what a script the session runs can still do.
//   - A session is held when its unattended mark names an issue, with any tag shape, or cannot be read; a pending
//     mark's hold, an attended session, and a run's driver are not (unattended-mark.mjs issueHeld).
//   - `git push`: only `git push origin HEAD:refs/heads/<branch>`, `<branch>` the one the run's snapshot names for its
//     issue (project-run-guard.mjs ownIssue), from a folder of its own clone or worktree, with a `+` or a force option
//     that names only that branch, and switches that change nothing else. git's other ways to push, `send-pack` and
//     `http-push`, and an alias, are refused.
//   - The forge CLI: the subcommands forges/index.mjs forgeRefCommands lists, and a raw API call forgeApiWrite reads
//     as a write the session never makes.
// It reads only the command, as the shared lexer reads it, and asks git once for an alias of a subcommand it does not
// know. A word built at run time where a subcommand, a route, or a method goes is refused.

import { projectRuleReason } from './agent-gates.mjs';
import { bashCall, opaqueTexts } from './config-guard.mjs';
import { checkDeadline, remainingMs } from './deadline.mjs';
import { forgeApiWrite, forgeRefCommands } from './forges/index.mjs';
import { isWithin } from './fs.mjs';
import { runGit } from './git.mjs';
import { changesGitTarget, plainGlobals } from './git-push.mjs';
import { opaqueShellCommand } from './hosts/index.mjs';
import { changesVariable, GIT_VALUE_GLOBALS, readShortOptions, walkCommands } from './shell-lex.mjs';
import { issueHeld } from './unattended-mark.mjs';
import { runsDeclared } from './unattended-shell.mjs';

// git's own ways to push, besides `push`.
const OTHER_PUSHES = new Set(['send-pack', 'http-push']);
// The words of a command the lexer cannot read, or of a command word built at run time, that may push or ask the forge.
const FORGE_WORD = /\b(?:push|send-pack|http-push|release|workflow|api|secret|variable|deploy-key)\b/iu;
// The `git push` switches that change no ref and no remote, and the short ones, alone or in a cluster: -u, -q, -v, -n,
// -f. A force names only the refspec's own branch, which the refspec check holds.
const PUSH_SWITCHES = new Set(['--set-upstream', '--quiet', '--verbose', '--progress', '--no-progress', '--porcelain', '--dry-run', '--force', '--force-if-includes', '--no-force-if-includes']);
const PUSH_SHORT = new Set(['-u', '-q', '-v', '-n', '-f']);
// git's own subcommands a session runs, which no alias replaces: any other word is looked up as an alias.
const GIT_COMMANDS = new Set([
  'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'check-ref-format',
  'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'commit-tree', 'config', 'count-objects', 'describe', 'diff', 'diff-files',
  'diff-index', 'diff-tree', 'difftool', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'log',
  'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge', 'merge-base', 'merge-file', 'merge-tree', 'mergetool', 'mv', 'name-rev', 'notes',
  'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'reflog', 'remote', 'repack', 'replace', 'rerere', 'reset', 'restore', 'rev-list',
  'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'status', 'stripspace', 'submodule',
  'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'verify-commit', 'verify-tag', 'version', 'whatchanged', 'worktree',
  'write-tree', 'send-pack', 'http-push',
]);
// The variables, besides git-push.mjs GIT_VARIABLES, that move the config files git reads, and so where a push goes.
const CONFIG_HOMES = ['HOME', 'XDG_CONFIG_HOME'];
// The forge CLI's global options that take the next word, skipped before its subcommand.
const FORGE_VALUES = new Set(['-R', '--repo', '--hostname', '-h']);

// Why the call in `input` may not run because a project run's issue session, which `mark` holds (unattended-mark.mjs issueHeld), asks the
// forge for what it never asks, or null: { match, reason }. `issue()` gives the session's { key, branch }
// (project-run-guard.mjs ownIssue), or null when it cannot be told, which refuses every push; `roots()`, the folders a
// push may run in, its own clone's and worktree's real, case-folded paths. `fold(path)` gives a path as roots holds them.
export function issueForgeDenial(input, { names: { human } }, { mark = null, issue = () => null, roots = () => [], fold = (each) => each, cwd = process.cwd() } = {}) {
  if (!issueHeld(mark)) return null;
  const deny = (match, why) => ({ match, reason: projectRuleReason(input, `${why}, and a project run's issue session never does that: only ${human} does`, human, 'to make that change, or record the issue parked with the decision it needs') });
  const opaque = opaqueShellCommand(input);
  if (opaque !== null) {
    return opaqueTexts(opaque).some((text) => FORGE_WORD.test(text)) ? deny('issue session forge call it cannot read', 'it runs a shell the guard cannot read, in words that may push, release, or call the forge') : null;
  }
  const command = bashCall(input) && typeof input.tool_input?.command === 'string' ? input.tool_input.command : null;
  if (command === null || !/push|send-pack|gh|git|release|workflow|api|secret|variable|alias|repo|run|key|cache/iu.test(command)) return null;
  const entries = [...walkCommands(command, cwd)];
  const moved = entries.some(({ invocation }) => changesGitTarget(invocation) || CONFIG_HOMES.some((name) => changesVariable(invocation, name)));
  for (const entry of entries) {
    checkDeadline();
    const found = entryProblem(entry, { moved, issue, roots, fold });
    if (found) return deny(found.match, found.why);
  }
  return null;
}

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
  return forgeProblem(invocation.program, args);
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
function gitProblem(entry, { moved, issue, roots, fold }) {
  const git = gitCall(entry.invocation.args ?? []);
  if (!git) return null;
  if (git.built) return { match: 'issue session git command built at run time', why: 'it runs git with a subcommand or an option built at run time, which may push any ref' };
  if (OTHER_PUSHES.has(git.subcommand)) return { match: 'issue session push', why: `it pushes with \`git ${git.subcommand}\`, which may push any ref to any repository` };
  if (git.subcommand === 'push') {
    const why = pushProblem(git, { moved, issue, folder: entry.folder, roots, fold });
    return why ? { match: 'issue session push', why } : null;
  }
  if (GIT_COMMANDS.has(git.subcommand)) return null;
  // A word git does not know as its own may be an alias, which may push: set on the call's line, or in a config git reads.
  const configured = moved || git.globals.some((token) => ['-c', '--config-env'].includes(token.text) || /^--config-env=/u.test(token.text));
  if (configured || isAlias(git.subcommand, entry.folder)) return { match: 'issue session git alias', why: `it runs \`git ${git.subcommand.slice(0, 40)}\`, which is no command of git's own but an alias, which may push any ref` };
  return null;
}

// Whether git names `word` an alias in the folder `folder`, as the call would run it: a folder that cannot be told, or
// a git call that fails to answer in time, counts.
function isAlias(word, folder) {
  if (typeof folder !== 'string') return true;
  const budget = Number.isFinite(remainingMs()) ? { timeout: Math.max(1, Math.floor(remainingMs())) } : {};
  const read = runGit(['config', '--get', `alias.${word}`], folder, budget);
  return read.status !== 1;
}

// Why a `git push` (gitCall's `git`) is not the session's own exact push, or null: `git push origin
// HEAD:refs/heads/<branch>`, with `+` or a lease that names only that branch, run in one of its roots. What the words
// alone refuse is read first: the branch (`issue()`) and the roots are read only for a push shaped like its own.
function pushProblem(git, { moved, issue, folder, roots, fold }) {
  if (moved || !plainGlobals(git.globals)) return 'it pushes with a git option or variable that changes the repository or the config git reads, which may point the push anywhere';
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
  const branch = issue()?.branch ?? null;
  if (branch === null) return 'it pushes, and no running start of its issue names the branch it may push';
  const exact = `HEAD:refs/heads/${branch}`;
  if (operands[1] !== exact && operands[1] !== `+${exact}`) return `it pushes \`${operands.join(' ').slice(0, 120)}\`, and the one push it makes is \`git push origin ${exact}\``;
  const lease = leases.find((each) => each !== branch && each !== `refs/heads/${branch}`);
  if (lease !== undefined) return `it pushes with a lease on ${lease.slice(0, 80)}, not on its own branch ${branch}`;
  if (typeof folder !== 'string' || !roots().some((root) => isWithin(root, fold(folder)))) return 'it pushes from a folder that is not its own clone or worktree, whose origin may be any repository';
  return null;
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
