// Write rule: no writes to a tracked file in a project's main checkout; task work happens in a git worktree.
// It covers Edit, Write, and NotebookEdit, Codex's apply_patch, and the Bash commands whose target is certain:
// `>` and `>>`, tee, sed -i, perl -i, ruby -i, the destination of cp, ln, and install, every path of mv, git mv, rm, git rm, unlink, touch,
// mkdir, and truncate, dd's of=, and the local destination of rsync, with its sources too under --remove-source-files. A move removes its sources. A command
// substitution that runs is read as the command line is.
//
// It also keeps the main checkout's git state for the session that owns it: no `git switch` or `git checkout <branch>`
// away from the default branch, no staging of every change at once (`git add -A`, `--all`, `-u`, `.`, `:/`), which
// takes whatever other sessions left in the folder, and no git call that makes a commit or moves the branch (commit,
// merge and pull without --ff-only, cherry-pick, revert, rebase, am, commit-tree, and a reset that is not of paths).
//
// It is off until a project sets config.json `"git": { "mainCheckout": { "guard": true } }`. A target is allowed when it is outside
// every main checkout (in a worktree, or outside the repository), in a project without a project folder or with the
// guard off, matched by `git.mainCheckout.allowWrites`, or git-ignored. When git cannot tell, a tool write is denied to be
// safe and a Bash command runs: a command line is never as certain as a file path.

import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { globPattern } from '../fs.mjs';

import { loadConfig } from '../config.mjs';
import { checkoutRoots, isIgnored, runGit } from '../git.mjs';
import { fileEditOf } from '../hosts/index.mjs';
import { findProject, worktreesDir } from '../project.mjs';
import { GIT_VALUE_GLOBALS, inlineShellCommand, isLongOption, lexInputs, lexSteps, readGit, readInvocation, readShortOptions, readsShellInput, SUBSTITUTION_DEPTH_LIMIT } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_MAIN_WRITE';

const CHANGES_DIRECTORY = new Set(['cd', 'pushd', 'popd']);
// Programs whose every operand is written, and the options of each that take a value: the rest of a short option's
// word (`-e's/a/b/'`), or else the next word. A long one also matches by a prefix, as getopt_long reads it:
// `sed --fi script.sed` takes `--file`'s value.
const WRITERS = new Map([
  ['tee', new Set()],
  ['rm', new Set()],
  ['unlink', new Set()],
  ['touch', new Set(['-t', '-r', '-d', '--reference', '--date'])],
  ['mkdir', new Set(['-m', '--mode'])],
  // -l takes a value in GNU sed and none in BSD sed, so it is left out and its value reads as one more operand.
  ['sed', new Set(['-e', '-f', '--expression', '--file', '--line-length'])],
  ['cp', new Set(['-S', '--suffix', '-t', '--target-directory'])],
  ['mv', new Set(['-S', '--suffix', '-t', '--target-directory'])],
  ['ln', new Set(['-S', '--suffix', '-t', '--target-directory'])],
  ['install', new Set(['-S', '--suffix', '-t', '--target-directory', '-m', '--mode', '-o', '--owner', '-g', '--group'])],
  ['truncate', new Set(['-s', '--size', '-r', '--reference', '-o'])],
  ['dd', new Set()],
  // Options that take the rest of their word or the next one (perlrun, ruby -h). The rest-only ones are in REST_VALUES:
  // listed here, they would take the next word, which can be the file written.
  ['perl', new Set(['-e', '-E', '-I'])],
  [
    'ruby',
    new Set([
      '-e', '-I', '-C', '-r', '-E', '--encoding', '--external-encoding', '--internal-encoding', '--enable', '--disable',
      '--backtrace-limit', '--parser', '--crash-report', '--dump',
    ]),
  ],
  // A value option whose name extends a switch (`--partial-dir`, `--backup-dir`) is left out, so the switch never
  // swallows an operand. An unlisted option's value reads as one more path: blocked by mistake, never missed.
  [
    'rsync',
    new Set([
      '-e', '--rsh', '--rsync-path', '-f', '--filter', '--exclude', '--exclude-from', '--include', '--include-from',
      '--files-from', '-T', '--temp-dir', '--compare-dest', '--copy-dest', '--link-dest', '--chmod', '--chown',
      '--suffix', '--log-file', '--info', '--debug', '--timeout', '--bwlimit', '--max-size', '--min-size', '-B',
      '--block-size', '-M', '--remote-option', '--out-format', '--password-file', '--port',
    ]),
  ],
]);
// Options that take only the rest of their word: sed's in-place suffix, `-i.bak`, so `-ie` is -i with the suffix "e".
// BSD sed's -I edits in place too.
// perl and ruby take `-i[suffix]` the same way, and their other rest-only options (`-Mstrict`, `-rjson`) never take the
// next word: `perl -M strict` is an error.
const REST_VALUES = new Map([
  ['sed', new Set(['-i', '-I'])],
  ['perl', new Set(['-i', '-M', '-m', '-C', '-x', '-D', '-F'])],
  ['ruby', new Set(['-i', '-F', '-x'])],
]);
// Options whose value has a fixed shape (perl -h, ruby -h), so the switches after it still count: `-0777pi`, `-lpi`,
// `-dpi`, `-W0pi`, `-Kupi`. Each pattern matches the option letter and its value.
const SHORT_VALUES = new Map([
  ['perl', /0(?:x[0-9a-f]+|[0-7]+)?|l[0-7]*|dt?(?::[\w:=,]+)?/giu],
  ['ruby', /0[0-7]*|W(?:[0-2]|:\w+)?|K[a-zA-Z]?|T[0-9]*/gu],
]);
// The option that gives a script on the command line, so every operand is a file; without it the first is the script.
const SCRIPT_OPTIONS = new Map([['perl', ['-e', '-E']], ['ruby', ['-e']]]);
// The options that change the folder the interpreter runs in.
const CHANGES_FOLDER = new Map([['perl', ['-x']], ['ruby', ['-C', '-x']]]);
// git subcommands whose every path is written: git mv removes its sources, git rm its paths.
const GIT_WRITERS = new Map([
  ['mv', new Set()],
  ['rm', new Set(['--pathspec-from-file'])],
]);
// git subcommands that put back a path's content, which bashWrites counts only when asked (`restores`): the main-checkout
// rule lets them discard changes, while the config guard must see a gate file restored to an older version.
const GIT_RESTORERS = new Map([
  ['checkout', new Set(['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file'])],
  ['restore', new Set(['-s', '--source', '--conflict', '--pathspec-from-file'])],
]);
// The cp-like writers: they write their last operand, or the -t directory.
const COPIERS = new Set(['cp', 'ln', 'install']);
// An rsync operand naming another host: `host:path`, `user@host:path`, `host::module`, or `rsync://host/module`.
const REMOTE = /^[^/]*:/u;

// Bash: the deny reason for `command`, or null. git runs only for a write target or a git call in a guarded project,
// and for each folder a `cd` names from a guarded main checkout.
export function check(command, { cwd = process.cwd(), env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  return decide(bashTargets(command, cwd), cwd, false, 'this command writes') ?? afterCdDenial(command, cwd) ?? gitStateDenial(command, cwd);
}

// A `cd` can fail and still return 0, as a shell alias or function for cd can: the shell then stays where it was. From
// a guarded main checkout, a `cd`, `pushd`, or `popd` is trusted only when it names folders that exist, each in a
// checkout of the same repository. Into a linked worktree, nothing after it is judged, as before; inside the main
// checkout, the shell is there whether it works or not, so what follows is judged at the folders before and after it.
// Any other `cd` is untrusted: what follows is judged against the folders before it, for the rest of the line.

// Whether `dir` is a folder, through links.
const isDirectory = (dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

// checkoutRoots, read once per folder per hook run.
const rootsCache = new Map();
function rootsOf(dir) {
  if (!rootsCache.has(dir)) rootsCache.set(dir, checkoutRoots(dir));
  return rootsCache.get(dir);
}

// The guarded main checkouts the folders `dirs` are in, by their canonical root.
function mainsOf(dirs) {
  const mains = new Set();
  for (const dir of dirs) {
    const main = guardedMain(dir);
    if (main) mains.add(canonical(main.roots.main));
  }
  return mains;
}

// How the directory change `change` ({ program, to }) moves a shell that may be in any of `from`, when one of them is
// a guarded main checkout in `mains`: { kind: 'worktree' }, { kind: 'main', dests }, or { kind: 'untrusted' }.
function trustOf(change, from, mains) {
  const { program, to } = change;
  if (program === 'popd' || !to || to.dynamic || to.text.startsWith('~')) return { kind: 'untrusted' };
  const dests = path.isAbsolute(to.text) ? [to.text] : from.map((dir) => path.resolve(dir, to.text));
  if (!dests.length) return { kind: 'untrusted' };
  let inMain = false;
  for (const dest of dests) {
    const roots = isDirectory(dest) ? rootsOf(dest) : null;
    if (!roots || !mains.has(canonical(roots.main))) return { kind: 'untrusted' };
    if (canonical(roots.current) === canonical(roots.main)) inMain = true;
  }
  return inMain ? { kind: 'main', dests } : { kind: 'worktree' };
}

// The directory change an invocation makes, as { program, args }, or null: a `cd`, `pushd`, or `popd`, also behind
// `builtin`, which skips a shell function or alias of that name.
function directoryChange(invocation) {
  if (CHANGES_DIRECTORY.has(invocation.program)) return invocation;
  const [first, ...args] = invocation.args ?? [];
  if (invocation.program !== 'builtin' || !first || first.dynamic || !CHANGES_DIRECTORY.has(first.text)) return null;
  return { ...invocation, program: first.text, args, builtin: true };
}

// The directory change `{ program, args }` (from directoryChange), as bashWrites records it: { from, to, program,
// shown }, `shown` the change as the deny reason names it.
function cdChange({ program, args, builtin = false }, from) {
  const to = program === 'popd' ? null : operand(args);
  const word = to ?? args.find((token) => !token.dynamic && /^(?:-|[+-]\d+)$/u.test(token.text));
  const name = builtin ? `builtin ${program}` : program;
  if (!word || word.text === '') return { from, to, program, shown: name };
  // The lexer drops quotes: a quoted expansion, or a literal word with a shell metacharacter in it, is shown quoted again.
  let text = word.text;
  if (word.dynamic && !word.splits && /[$`]/u.test(text)) text = `"${text}"`;
  else if (!word.dynamic && /[\s$`'"\\]/u.test(text)) text = text.includes("'") ? `"${text.replace(/["$`\\]/gu, '\\$&')}"` : `'${text}'`;
  return { from, to, program, shown: `${name} ${text}` };
}

// Where a target after the changes `cds` is judged, or null when it is not: { at, cd, last }, `at` the folders the
// shell may be in, `cd` the untrusted change shown, or null after changes inside the main checkout only, and `last`
// the last of those, as { shown, dests }.
function afterChanges(cds) {
  const mains = mainsOf(cds[0].from);
  if (!mains.size) return null;
  let at = cds[0].from;
  let last = null;
  for (const change of cds) {
    const trust = trustOf(change, at, mains);
    if (trust.kind === 'untrusted') return { at, cd: change.shown, last };
    if (trust.kind === 'worktree') return null;
    at = [...new Set([...trust.dests, ...at])];
    last = { shown: change.shown, dests: trust.dests };
  }
  return { at, cd: null, last };
}

const WAY_OUT = 'Name the folder in each command instead: an absolute path, `git -C <absolute folder>`, or `env -C <absolute folder>`.';
// Why a cd may fail unseen: a shell alias or function for cd can fail and still return 0. `builtin cd` skips those and
// fails loudly, but it can still fail, as on a missing folder.
const mayFail = (cd, acts, root) =>
  `if it fails, ${acts} the main checkout (${root})${cd.startsWith('builtin ') ? '.' : ': a shell alias or function for cd can fail and still return 0.'}`;
const cdLead = (subject, acts, cd, root) =>
  `Blocked: ${subject} after a cd that leaves the repository, or that this rule cannot read. The cd is \`${cd}\`; ` +
  `${mayFail(cd, acts, root)}\n${WAY_OUT}`;
// A write the main checkout gets only when a `cd` inside it fails, such as `cd build && echo x > a.txt`.
const failedCdLead = (name, cd, root) =>
  `Blocked: this command writes '${name}' in the main checkout if a cd before it fails. The cd is \`${cd}\`; ` +
  `${mayFail(cd, 'the write lands in', root)}\n${WAY_OUT}`;

// The relative writes after a directory change, judged where the shell may still be: the deny reason, or null.
function afterCdDenial(command, cwd) {
  for (const write of bashWrites(command, cwd, { shells: true, globs: true })) {
    if (!write.cds.length || path.isAbsolute(write.text)) continue;
    const walk = afterChanges(write.cds);
    // A wrapper's `env -C` or git's `-C` after the change moves the target; one that may expand leaves it alone.
    if (!walk || write.via.some((token) => token.dynamic)) continue;
    const through = (dir) => write.via.reduce((at, token) => path.resolve(at, token.text), dir);
    const dirs = walk.at.map(through);
    if (write.glob) {
      // A glob fails closed, as it may match a tracked file: after an untrusted cd, at the folders before it; after cds
      // inside the main checkout, at the folders the shell is in only when the last one fails.
      if (walk.cd) {
        const main = dirs.map((dir) => guardedMain(dir)).find(Boolean);
        if (main) return reason(cdLead(`this command writes '${write.text}'`, 'the write lands in', walk.cd, main.roots.main), main.project, main.config);
      } else {
        const main = walk.at.filter((dir) => !walk.last.dests.includes(dir)).map((dir) => guardedMain(through(dir))).find(Boolean);
        if (main) return reason(failedCdLead(write.text, walk.last.shown, main.roots.main), main.project, main.config);
      }
      continue;
    }
    const files = (list) => list.map((dir) => path.resolve(through(dir), write.text));
    const verb = 'this command writes';
    if (walk.cd) {
      const denial = decide(files(walk.at), cwd, false, verb, (root) => cdLead(`${verb} '${write.text}'`, 'the write lands in', walk.cd, root));
      if (denial) return denial;
      continue;
    }
    // Inside the main checkout, a file where the last cd leads is judged as today; one the write reaches only when a
    // cd fails names that cd.
    const reached = walk.at.filter((dir) => walk.last.dests.includes(dir));
    const denial =
      decide(files(reached), cwd, false, verb) ??
      decide(files(walk.at.filter((dir) => !reached.includes(dir))), cwd, false, verb, (root) => failedCdLead(write.text, walk.last.shown, root));
    if (denial) return denial;
  }
  return null;
}

// The git calls that change the main checkout's state for every session in it, as { what, folders, target }: `folders`
// every folder the call may act on, after a wrapper's `env -C`, git's own `-C`, and `--work-tree` or `--git-dir`, and
// `cd` the untrusted directory change before it, if any. Substitutions that run are read too. After a `cd` into a
// linked worktree a call is skipped; after a `cd` inside the main checkout it is judged at the folders before and after
// it; after a `cd` this rule cannot trust, every call that may change the repository is a change when its folder,
// resolved from the folders before the `cd`, is a guarded main checkout.
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
const JUDGED = new Set(['add', 'switch', 'checkout', ...HISTORY.keys()]);
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

// Whether a word may become other words when the shell expands it: a parameter, a substitution, a glob (the lexer's
// `dynamic`), or a brace expansion such as `{.,src}` or `--{all,x}`.
const expands = (token) => token.dynamic || /\{[^{}]*(?:,|\.\.)[^{}]*\}/u.test(token.text);

// `inherited` holds the GIT_* assignments in force: set before an inline shell, or by an earlier `export` or bare
// assignment on the same command line.
const GIT_ASSIGNMENT = /^GIT_[A-Z_]+=/u;
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

// Today's judgement of one add, switch, checkout, or HISTORY call run at `cwd`: the change it makes, or null.
function knownChange(call, invocation, cwd, scope) {
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
function gitFolders(globals, chdir, cwd, assignments = []) {
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

// The guarded main checkout `at` is in, as { project, config, roots }, or null. Read once per folder per hook run.
const guardedMains = new Map();
function guardedMain(at) {
  if (guardedMains.has(at)) return guardedMains.get(at);
  let found = null;
  const folder = existingFolder(at);
  const project = findProject(folder);
  if (project) {
    const { config } = loadConfig(project);
    const roots = config.git.mainCheckout.guard ? checkoutRoots(folder) : null;
    if (roots && canonical(roots.current) === canonical(roots.main)) found = { project, config, roots };
  }
  guardedMains.set(at, found);
  return found;
}

// The deny reason for a git call that changes the main checkout's state, or null. Moving back to the default branch
// is allowed: it is where the main checkout belongs.
function gitStateDenial(command, cwd) {
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

// Edit, Write, NotebookEdit, and apply_patch: the deny reason for the hook payload, or null.
export function checkTool(input, { env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  return decide(toolTargets(input), typeof input.cwd === 'string' ? input.cwd : process.cwd(), true, 'this writes');
}

// Every path an Edit, Write, NotebookEdit, or apply_patch payload writes, as it names them: relative to its cwd or absolute.
export function toolTargets(input) {
  const toolInput = input.tool_input ?? {};
  const targets = fileEditOf(input)?.targets ?? [toolInput.file_path ?? toolInput.notebook_path];
  return targets.filter((target) => typeof target === 'string' && target !== '');
}

// A write target as the shell reads a leading `~`: `~` and `~/x` are in the home folder, not in the shell's folder.
// `~user` stays as written, and so does a token marked `literal`, cut from inside a word or built by this rule: the shell
// expands `~` only at a word's start, so `-t~/x` and `of=~/x` name a folder called `~`. Accepted residual: the lexer drops quotes, so a quoted "~/x", a literal folder named `~`, reads the same.
const isHomeWord = ({ text, literal = false }) => !literal && (text === '~' || text.startsWith('~/'));
const expandHome = (token) => (isHomeWord(token) ? path.join(homedir(), token.text.slice(1)) : token.text);

// Every path a Bash command writes with certainty, resolved against `cwd`. Commands are read in the order they run: a
// relative target after a `cd` is dropped, and one before it stays. A command substitution runs in a shell of its own,
// which starts where its command runs; a `cd` inside it moves nothing outside it.
export function bashTargets(command, cwd) {
  return bashWrites(command, cwd).flatMap(({ files }) => files);
}

// Most folders bashWrites follows the shell through; past it, the shell's folder counts as unknown.
const FOLDERS_LIMIT = 16;

// Every target a Bash command writes, as { text, files, unsure }: `text` as the command names it, `files` the absolute
// paths it can be, and `unsure` when the shell may be in a folder no path names, as after `cd "$dir"`. `globs` keeps a
// target with a glob, which bashTargets drops, as { text, files: [], dirs, unsure, glob: true }, `dirs` the folders it
// is relative to; `restores` counts git
// checkout -- and git restore as writes.
// Every record also has `cds`, the directory changes before it on its line, inline shells' callers included, each
// { from, to, program, shown }: `from` the folders before the change, `to` its folder token (null for none, `-`, `+N`,
// or `popd`), and `shown` the change as a deny reason names it; and `via`, the folder tokens of each `env -C` or git
// `-C` that moved the target after the last of them, in order.
// By default a `cd` makes the shell's folder unknown, as bashTargets reads it. `followCd` follows each `cd` to a named
// folder, and, since a `cd` that fails leaves the shell where it was, keeps the folders before it as well. `shells` also
// reads the command line of each `sh -c` or `bash -c`, which, like a substitution, starts where its command runs.
export function bashWrites(command, cwd, { followCd = false, shells = false, restores = false, globs = false } = {}) {
  const targets = [];
  const visit = (line, place, depth) => {
    for (const { segment, substitutions } of lexSteps(line)) {
      if (depth < SUBSTITUTION_DEPTH_LIMIT) for (const body of substitutions) visit(body, place, depth + 1);
      segment.forEach((token, i) => {
        const next = segment[i + 1];
        if ((token.operator === '>' || token.operator === '>>') && next && !next.fdDup && !next.operator) targets.push({ token: next, place });
      });
      const invocation = readInvocation(segment);
      const { program, args, chdir } = invocation;
      // A wrapper's directory change moves the command's own paths, never the shell's redirections above.
      const own = chdir === null ? place : within(place, chdir);
      if (WRITERS.has(program)) for (const token of written(program, args)) targets.push({ token, place: own });
      else if (program === 'git') targets.push(...gitWritten(segment, own, restores));
      const inner = shells && depth < SUBSTITUTION_DEPTH_LIMIT ? inlineShellCommand(invocation) : null;
      if (inner !== null) visit(inner, own, depth + 1);
      const directory = directoryChange(invocation);
      if (directory) {
        const change = cdChange(directory, place.dirs);
        place = { ...(followCd ? moved(place, change.to, true) : UNKNOWN), cds: [...place.cds, change], via: [] };
      }
    }
  };
  visit(command, { dirs: [cwd], unsure: false, cds: [], via: [] }, 0);
  return targets
    .filter(({ token }) => (!token.dynamic || (globs && !/[$`]/u.test(token.text))) && token.text !== '')
    .map(({ token, place: { dirs, unsure, cds, via } }) => {
      const { dynamic } = token;
      const text = expandHome(token);
      if (dynamic) return { text, files: [], dirs, unsure, glob: true, cds, via };
      if (path.isAbsolute(text)) return { text, files: [text], unsure: false, cds, via };
      return { text, files: dirs.map((dir) => path.resolve(dir, text)), unsure, cds, via };
    });
}

// The shell's folder once a `cd` may have moved it anywhere: no folder is certain.
const UNKNOWN = Object.freeze({ dirs: [], unsure: true });

// Where a command runs after a wrapper's `env -C` or git's `-C` to the token `to`: the shell's own directory changes
// stay, and `via` records the move after the last of them.
function within(place, to) {
  return { ...moved(place, to), cds: place.cds, via: [...place.via, to ?? { text: '', dynamic: true }] };
}

// Where the shell can be after a directory change to the token `to` from `place`: { dirs, unsure }. A missing or
// dynamic `to` reaches an unknown folder. `mayFail` keeps the folders before the change too.
function moved(place, to, mayFail = false) {
  const kept = mayFail ? place.dirs : [];
  let reached;
  if (!to || to.dynamic) reached = UNKNOWN;
  else if (path.isAbsolute(to.text)) reached = { dirs: [to.text], unsure: false };
  else reached = { dirs: place.dirs.map((dir) => path.resolve(dir, to.text)), unsure: place.unsure };
  const dirs = [...new Set([...kept, ...reached.dirs])];
  const unsure = reached.unsure || (mayFail && place.unsure) || dirs.length > FOLDERS_LIMIT;
  return { dirs: dirs.slice(0, FOLDERS_LIMIT), unsure };
}

// The folder a `cd` or `pushd` names: its first word that is not an option, past one `--` that ends the options. Null
// when no word names one: none, which is the home folder, `-`, the previous folder, or `+1`, a place on the directory
// stack.
function operand(args) {
  let i = 0;
  while (args[i] && !args[i].dynamic && /^-[LPe@]+$/u.test(args[i].text)) i += 1;
  if (args[i] && !args[i].dynamic && args[i].text === '--') i += 1;
  const to = args[i];
  return to && (to.dynamic || !/^(?:-|[+-]\d+)$/u.test(to.text)) ? to : null;
}

// git mv and git rm, and with `restores` git checkout and git restore: every path they name, resolved from `git -C`, which moves them as a wrapper's directory change does.
function gitWritten(segment, place, restores) {
  const call = readGit(segment);
  const writers = restores ? new Map([...GIT_WRITERS, ...GIT_RESTORERS]) : GIT_WRITERS;
  if (!call || !writers.has(call.subcommand)) return [];
  let at = place;
  call.globals.forEach((token, i) => {
    const value = call.globals[i + 1];
    if (token.text === '-C' && value) at = within(at, value);
  });
  let { rest } = call;
  // git checkout writes paths only after `--`; before it a word may be a branch. git restore --staged alone writes the index.
  const dashes = rest.findIndex((token) => token.text === '--');
  if (call.subcommand === 'checkout') rest = dashes === -1 ? [] : rest.slice(dashes);
  const has = (letter, long, shortest) => rest.some(({ text }) => isLongOption(text, long, shortest) || (/^-[A-Za-z]+$/u.test(text) && text.includes(letter)));
  if (call.subcommand === 'restore' && has('S', '--staged', '--st') && !has('W', '--worktree', '--w')) return [];
  return written('git', rest, writers.get(call.subcommand)).map((token) => ({ token, place: at }));
}

// The operands a writer writes: all of them, every path of mv, the destination of cp and rsync (and rsync's sources
// under --remove-source-files), and the files of sed -i, never its script.
function written(program, args, valueFlags = WRITERS.get(program)) {
  const flags = [];
  const operands = [];
  let folder = null;
  let suffix = null;
  let ended = false;
  for (let i = 0; i < args.length; i += 1) {
    const { text } = args[i];
    if (!ended && text === '--') ended = true;
    else if (!ended && text.startsWith('--')) {
      flags.push(text);
      if (valueFlags.has(text) || (/^--[^=]+$/u.test(text) && [...valueFlags].some((option) => option.startsWith(text)))) i += 1;
    } else if (!ended && text.startsWith('-') && text.length > 1) {
      // Drop the values of fixed-shape options, up to the first option that takes the rest of the word.
      const cluster = SHORT_VALUES.has(program) ? withoutShortValues(text, program) : text;
      const { options, value } = readShortOptions(cluster, valueFlags, REST_VALUES.get(program));
      flags.push(...options);
      if (SCRIPT_OPTIONS.has(program) && value?.option === '-i') suffix = { text: value.attached ?? '', dynamic: args[i].dynamic };
      if (CHANGES_FOLDER.get(program)?.includes(value?.option)) {
        // ruby changes folder at each option, so `ruby -C one -C two` runs in one/two; perl keeps only its last -x.
        const next = value.attached === null ? args[i + 1] ?? null : { text: value.attached, dynamic: args[i].dynamic, literal: true };
        const compose = program === 'ruby' && folder !== null && next && !path.isAbsolute(next.text) && !isHomeWord(next);
        // A bare perl -x keeps the folder an earlier -x chose.
        if (next && next.text !== '') folder = compose ? { text: path.join(folder.text, next.text), dynamic: folder.dynamic || next.dynamic, literal: folder.literal } : next;
      }
      if (value?.attached === null) i += 1;
    } else if (text !== '') {
      operands.push(args[i]); // an empty operand is BSD sed's `-i ''` suffix
      // perl and ruby read their own options only up to the first operand; what follows is the script's.
      if (SCRIPT_OPTIONS.has(program)) ended = true;
    }
  }
  if (program === 'dd') return operands.filter(({ text }) => text.startsWith('of=')).map((token) => ({ ...token, text: token.text.slice(3), literal: true }));
  if (program === 'install' && flags.some((flag) => flag === '-d' || isLongOption(flag, '--directory', '--d'))) return operands;
  if (COPIERS.has(program) || program === 'mv') {
    const directory = targetDirectory(args);
    if (program === 'mv') return directory ? [...operands, directory] : operands;
    if (directory) return [directory];
    return operands.length >= 2 ? operands.slice(-1) : [];
  }
  if (program === 'rsync') {
    if (operands.length < 2) return [];
    const removesSources = flags.some((flag) => isLongOption(flag, '--remove-source-files', '--remov') || isLongOption(flag, '--remove-sent-files', '--remov'));
    return (removesSources ? operands : operands.slice(-1)).filter((token) => !REMOTE.test(token.text));
  }
  if (SCRIPT_OPTIONS.has(program)) {
    // perl -i and ruby -i edit their files in place; without -i they only read them, and -c only checks syntax.
    if (!flags.includes('-i') || flags.includes('-c')) return [];
    const edited = flags.some((flag) => SCRIPT_OPTIONS.get(program).includes(flag)) ? operands : operands.slice(1);
    // A suffix also writes a backup: `-i.bak` beside each file, `-i'old/*'` with `*` for the file's name.
    const backups = suffix?.text ? edited.map((token) => ({ ...token, dynamic: token.dynamic || suffix.dynamic, text: backupOf(program, expandHome(token), suffix.text), literal: true })) : [];
    const files = [...edited, ...backups];
    // ruby -C and -x, and perl -x, run in the folder they name: a relative file is read from there.
    if (folder === null || folder.text === '') return files;
    return files.map((token) => (path.isAbsolute(token.text) || isHomeWord(token) ? token : { ...token, text: path.join(folder.text, token.text), dynamic: token.dynamic || folder.dynamic, literal: folder.literal }));
  }
  if (program !== 'sed') return operands;
  // GNU sed takes a prefix of a long option: `--i` is `--in-place`, `--e` is `--expression`, `--fi` is `--file`.
  const inPlace = flags.some((flag) => REST_VALUES.get('sed').has(flag) || isLongOption(flag, '--in-place', '--i'));
  if (!inPlace) return [];
  const scripted = flags.some((flag) => flag === '-e' || flag === '-f' || isLongOption(flag, '--expression', '--e') || isLongOption(flag, '--file', '--fi'));
  return scripted ? operands : operands.slice(1);
}

// The backup an in-place edit with `suffix` writes for `file`, as each interpreter does it (checked by running both):
// perl puts the file, as written, in place of each `*` (`-i'old/*'` on `src/f` writes `old/src/f`) and otherwise
// appends the suffix; ruby always appends it, `*` included.
function backupOf(program, file, suffix) {
  return program === 'perl' && suffix.includes('*') ? suffix.replaceAll('*', file) : `${file}${suffix}`;
}

// A perl or ruby option cluster without the values of its fixed-shape options: `-0777pi` reads as `-0pi`. What follows
// an option that takes the rest of the word (`-i.bak0`, `-Mfoo0`) belongs to it and stays.
function withoutShortValues(text, program) {
  const rest = REST_VALUES.get(program);
  const values = WRITERS.get(program);
  let out = '-';
  for (let i = 1; i < text.length; i += 1) {
    const option = `-${text[i]}`;
    if (rest.has(option) || values.has(option)) return out + text.slice(i);
    out += text[i];
    const pattern = SHORT_VALUES.get(program);
    pattern.lastIndex = i;
    const match = pattern.exec(text);
    if (match?.index === i) i += match[0].length - 1;
  }
  return out;
}

// The directory cp or mv writes into with GNU -t, in any spelling: `-t DIR`, `-tDIR`, `-ft DIR`, `--target-directory=DIR`,
// or a prefix of it. Null without one.
function targetDirectory(args) {
  for (let i = 0; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    if (text === '--') return null;
    if (text.startsWith('--')) {
      if (!isLongOption(text, '--target-directory', '--t')) continue;
      const equals = text.indexOf('=');
      return equals === -1 ? args[i + 1] ?? null : { text: text.slice(equals + 1), dynamic, literal: true };
    }
    if (!/^-./u.test(text)) continue;
    // In a cluster, -S takes the rest as its suffix, and -t takes the rest, or the next word, as the directory.
    const { value } = readShortOptions(text, WRITERS.get('cp'));
    if (value?.option === '-t') return value.attached === null ? args[i + 1] ?? null : { text: value.attached, dynamic, literal: true };
  }
  return null;
}

// The deny reason for writing `targets`, or null. A target is judged where it is and, when it is a link, where it leads:
// `rm`, `mv`, and `ln -sf` change the link, and a write through it changes its target, or creates one not made yet.
// `leadFor(root)`, when given, writes the reason's first line in place of today's.
function decide(targets, cwd, failSafe, verb, leadFor = null) {
  for (const target of targets) {
    const absolute = path.resolve(cwd, target);
    for (const file of new Set([entryOf(absolute), canonical(absolute)])) {
      const denial = judged(file, failSafe, verb, leadFor);
      if (denial) return denial;
    }
  }
  return null;
}

// The path `file` names with the folders above it resolved through links, but not its last part: the entry itself.
function entryOf(file) {
  const name = path.basename(file);
  return name ? path.join(canonical(path.dirname(file)), name) : canonical(file);
}

// The deny reason for a write to `file`, a path with links resolved, or null.
function judged(file, failSafe, verb, leadFor) {
  const folder = existingFolder(path.dirname(file));
  const project = findProject(folder);
  if (!project) return null;
  const { config } = loadConfig(project);
  if (!config.git.mainCheckout.guard) return null;
  const roots = checkoutRoots(folder);
  if (!roots || canonical(roots.current) !== canonical(roots.main)) return null;
  const root = roots.main;
  const rel = path.relative(canonical(root), file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (config.git.mainCheckout.allowWrites.some((glob) => globPattern(glob).test(rel.split(path.sep).join('/')))) return null;
  const ignored = isIgnored(root, rel || '.');
  if (ignored === true || (ignored === null && !failSafe)) return null;
  const lead = leadFor
    ? leadFor(root)
    : ignored === null
      ? `Blocked: git could not tell whether '${rel}' is tracked in the main checkout (${root}), so ${verb} nothing to be safe.`
      : `Blocked: ${verb} '${rel}', a tracked file in the main checkout (${root}).`;
  return reason(lead, project, config);
}

function reason(lead, project, config) {
  const worktrees = worktreesDir(project, { config });
  return [
    lead,
    `Work in a git worktree instead: \`aidrian worktree new <branch>\` creates one in ${worktrees} (the worktree-new skill).`,
    `This project turns the guard on with "git": { "mainCheckout": { "guard": true } } in ${path.join(project.root, project.paths.config)};`,
    '"git": { "mainCheckout": { "allowWrites": [...] } } lists paths that stay writable.',
    `To override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
      "(agents must never set it on the user's behalf).",
  ].join('\n');
}


// Most links canonical follows whose target does not exist yet, as Linux follows in one path, and the longest path it
// builds while it follows them.
const LINK_HOPS = 40;
const PATH_LIMIT = 4096;

// The path with symlinks resolved, for the part of it that exists; git reports the main checkout that way. A link whose
// target does not exist yet is followed too: a write through it creates that target, as `echo x > link` does.
export function canonical(file) {
  return throughLinks(file, 0);
}

// canonical, after `hops` links not made yet. A link is followed only when what it leads to does not exist (ENOENT):
// past a loop (ELOOP) or a folder it may not read (EACCES), the path stays as spelled, so a link that nests itself
// returns at once. At the hop or length limit, the last target reached is returned.
function throughLinks(file, hops) {
  const tail = [];
  let current = file;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch (error) {
      const target = error?.code === 'ENOENT' ? linkTarget(current) : null;
      if (target !== null) {
        const next = path.join(target, ...tail);
        return hops + 1 >= LINK_HOPS || next.length > PATH_LIMIT ? next : throughLinks(next, hops + 1);
      }
      const parent = path.dirname(current);
      if (parent === current) return file;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

// Where the link `file` points, resolved from the real folder it sits in, or null when `file` is no link.
function linkTarget(file) {
  try {
    if (!lstatSync(file).isSymbolicLink()) return null;
    return path.resolve(realpathSync(path.dirname(file)), readlinkSync(file));
  } catch {
    return null;
  }
}

// The nearest folder at or above `dir` that exists, for git and the project lookup to start from.
function existingFolder(dir) {
  let current = dir;
  while (!existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}
