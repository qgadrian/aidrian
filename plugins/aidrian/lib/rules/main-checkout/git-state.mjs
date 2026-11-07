// The git calls of a Bash command line that change the main checkout's state for every session in it, for the
// main-checkout rule (lib/rules/main-checkout.mjs). git-calls.mjs judges each call.

import path from 'node:path';

import { GIT_VALUE_GLOBALS, inlineShellCommand, lexInputs, lexSteps, readGit, readInvocation, readsShellInput, SUBSTITUTION_DEPTH_LIMIT } from '../../shell-lex.mjs';
import { cdLead, guardedMain, reason } from './checkout.mjs';
import { cdChange, directoryChange, mainsOf, trustOf } from './directory-change.mjs';
import { GIT_ASSIGNMENT, gitFolders, JUDGED, knownChange } from './git-calls.mjs';

// The GIT_* assignments of one command: the words before it runs (and an `env` wrapper's), never its arguments, so in
// `git commit -m "GIT_DIR=x"` the message is no assignment; `export` takes them as its arguments. The command word is
// matched by name, so `/bin/bash` is `bash`.
function assignmentsOf(segment, invocation, call = null) {
  // The command word is the last word named like the program before git's subcommand, so `env -C /x/git … git add`
  // reads up to the real `git`.
  const end = call ? segment.findIndex((token, i) => i > 0 && token.text === call.subcommand && path.basename(segment[i - 1].text) === 'git') : -1;
  const matches = segment.map((token, i) => (!token.operator && path.basename(token.text) === invocation.program && (end === -1 || i < end) ? i : -1)).filter((i) => i !== -1);
  const program = matches.at(-1) ?? -1;
  const head = invocation.program === 'export' ? segment : program === -1 ? segment : segment.slice(0, program);
  // A subshell's `(` stays glued to its first word: `(GIT_DIR=…` is an assignment too.
  return head.filter((token) => !token.operator && GIT_ASSIGNMENT.test(token.text.replace(/^\(+/u, ''))).map((token) => ({ ...token, text: token.text.replace(/^\(+/u, '') }));
}

// The state of the shell a line runs in, for gitStateChanges: { folders }, where it may be, at the start and after a
// `cd` inside the main checkout; { skipped: true } after a `cd` into a linked worktree or from a folder no guarded main
// checkout holds, where nothing is judged; or { strict: { cd, from } } after a `cd` this rule cannot trust, `from` the
// folders before it.
const SKIPPED = Object.freeze({ skipped: true });

// The state after the directory change `invocation`. Untrusted stays so for the rest of the line.
function stateAfterCd(state, invocation) {
  if (!state.folders) return state;
  const mains = mainsOf(state.folders);
  if (!mains.size) return SKIPPED;
  const change = cdChange(invocation, state.folders);
  const trust = trustOf(change, state.folders, mains);
  if (trust.kind === 'worktree') return SKIPPED;
  if (trust.kind === 'main') return { folders: [...new Set([...trust.dests, ...state.folders])] };
  return { strict: { cd: change.shown, from: state.folders } };
}

// The state a command with a wrapper's directory change `chdir` runs in, or null when the folder may expand.
function stateIn(state, chdir) {
  if (state.skipped || !chdir) return state;
  if (chdir.dynamic) return null;
  if (state.folders) return { folders: state.folders.map((dir) => path.resolve(dir, chdir.text)) };
  if (path.isAbsolute(chdir.text)) return { folders: [chdir.text] };
  return { strict: { ...state.strict, from: state.strict.from.map((dir) => path.resolve(dir, chdir.text)) } };
}

// git subcommands that change nothing, and the read forms of others, which run after an untrusted `cd`. Every other
// call, an unknown subcommand included, counts as a change there: blocked by mistake, never missed.
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'rev-list', 'describe',
  'blame', 'grep', 'shortlog', 'name-rev', 'for-each-ref', 'show-ref', 'check-ignore', 'check-attr', 'merge-base',
  'count-objects', 'var', 'version', 'help', 'fsck',
]);
function readsOnly({ subcommand, rest }) {
  if (READ_ONLY_GIT.has(subcommand)) return true;
  const words = rest.map(({ text }) => text);
  const operands = words.filter((word) => !word.startsWith('-'));
  if (subcommand === 'branch' || subcommand === 'tag') return operands.length === 0;
  if (subcommand === 'worktree') return operands[0] === 'list';
  if (subcommand === 'stash') return operands[0] === 'list' || operands[0] === 'show';
  if (subcommand === 'config') return operands[0] === 'get' || words.some((word) => word.startsWith('--get') || word === '-l' || word === '--list');
  if (subcommand === 'remote') return operands.length === 0 || ['show', 'get-url'].includes(operands[0]);
  return false;
}

// The changes a git segment makes after an untrusted `cd`, judged at the folders before it: any call that is not
// read-only and whose folder is a guarded main checkout, and a call whose subcommand an expansion hides.
function strictChanges(invocation, call, { cd, from }, scope) {
  if (!call) {
    if (invocation.program !== 'git') return [];
    const { args } = invocation;
    for (let i = 0; i < args.length; i += 1) {
      const { text, dynamic } = args[i];
      // A dynamic word that starts with `-`, such as `--git-dir="$D"`, is a folder that may expand: left alone.
      if (dynamic) return text.startsWith('-') ? [] : [{ what: '`git` with a subcommand this rule cannot read', folders: from, target: null, cd }];
      if (GIT_VALUE_GLOBALS.has(text)) i += 1;
      else if (!text.startsWith('-')) return [];
    }
    return [];
  }
  if (readsOnly(call)) return [];
  const folders = [];
  for (const at of from) {
    const each = gitFolders(call.globals, invocation.chdir, at, scope);
    if (each === null) return [];
    folders.push(...each);
  }
  const unique = [...new Set(folders)];
  return unique.some((folder) => guardedMain(folder)) ? [{ what: `\`git ${call.subcommand}\``, folders: unique, target: null, cd }] : [];
}

// The git calls that change the main checkout's state for every session in it, as { what, folders, target }: `folders`
// every folder the call may act on, after a wrapper's `env -C`, git's own `-C`, and `--work-tree` or `--git-dir`, and
// `cd` the untrusted directory change before it, if any. Substitutions that run are read too. After a `cd` into a
// linked worktree a call is skipped; after a `cd` inside the main checkout it is judged at the folders before and after
// it; after a `cd` this rule cannot trust, every call that may change the repository is a change when its folder,
// resolved from the folders before the `cd`, is a guarded main checkout.
// `inherited` holds the GIT_* assignments in force: set before an inline shell, or by an earlier `export` or bare
// assignment on the same command line.
function gitStateChanges(command, state, depth = 0, inherited = []) {
  const found = [];
  const env = [...inherited];
  // A shell reading its input runs a heredoc or here-string body as commands, where that shell runs.
  if (depth < SUBSTITUTION_DEPTH_LIMIT) {
    const { segments, inputs } = lexInputs(command);
    const lineEnv = [...inherited];
    let here = state;
    segments.forEach((segment, i) => {
      const invocation = readInvocation(segment);
      // A directory change moves the shell as in the main pass.
      const change = directoryChange(invocation);
      if (change) here = stateAfterCd(here, change);
      if (here.skipped) return;
      const own = assignmentsOf(segment, invocation);
      if (invocation.program === 'export' || (own.length && !invocation.program)) lineEnv.push(...own);
      if (!inputs[i].length || !readsShellInput(invocation)) return;
      const where = stateIn(here, invocation.chdir);
      if (where) for (const body of inputs[i]) found.push(...gitStateChanges(body, where, depth + 1, [...lineEnv, ...own]));
    });
  }
  let now = state;
  for (const { segment, substitutions } of lexSteps(command)) {
    if (!now.skipped && depth < SUBSTITUTION_DEPTH_LIMIT) for (const body of substitutions) found.push(...gitStateChanges(body, now, depth + 1, env));
    const invocation = readInvocation(segment);
    const call = readGit(segment);
    const assignments = assignmentsOf(segment, invocation, call);
    // `export GIT_DIR=…` or a bare `GIT_DIR=…` lasts for the rest of the line.
    if (invocation.program === 'export' || (assignments.length && !invocation.program)) env.push(...assignments);
    const change = directoryChange(invocation);
    if (change) now = stateAfterCd(now, change);
    if (now.skipped) continue;
    // `sh -c`, `bash -c`, `flock … -c`, and a heredoc fed to a shell run their command where the invocation runs.
    const inner = depth < SUBSTITUTION_DEPTH_LIMIT ? inlineShellCommand(invocation) : null;
    const where = inner === null ? null : stateIn(now, invocation.chdir);
    if (where) found.push(...gitStateChanges(inner, where, depth + 1, [...env, ...assignments]));
    const scope = [...env, ...assignments];
    if (now.strict) {
      found.push(...strictChanges(invocation, call, now.strict, scope));
      continue;
    }
    if (!call || !JUDGED.has(call.subcommand)) continue;
    for (const cwd of now.folders) {
      const change = knownChange(call, invocation, cwd, scope);
      if (change) found.push(change);
    }
  }
  return found;
}

// The deny reason for a git call that changes the main checkout's state, or null. Moving back to the default branch
// is allowed: it is where the main checkout belongs.
export function gitStateDenial(command, cwd) {
  for (const change of gitStateChanges(command, { folders: [cwd] })) {
    for (const at of change.folders) {
      const main = guardedMain(at);
      if (!main) continue;
      const { project, config, roots } = main;
      if (change.cd) return reason(cdLead(`${change.what} runs`, 'the call acts on', change.cd, roots.main), project, config);
      if (change.target && change.target === config.git.defaultBranch) continue;
      return reason(`Blocked: ${change.what}, in the main checkout (${roots.main}).`, project, config);
    }
  }
  return null;
}
