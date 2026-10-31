// Write rule: no writes to a tracked file in a project's main checkout; task work happens in a git worktree.
// It covers Edit, Write, and NotebookEdit, Codex's apply_patch, and the Bash commands whose target is certain:
// `>` and `>>`, tee, sed -i, perl -i, ruby -i, the destination of cp, ln, and install, every path of mv, git mv, rm, git rm, unlink, touch,
// mkdir, and truncate, dd's of=, and the local destination of rsync, with its sources too under --remove-source-files. A move removes its sources. A command
// substitution that runs is read as the command line is.
//
// It also keeps the main checkout's git state for the session that owns it: no `git switch` or `git checkout <branch>`
// away from the default branch, and no staging of every change at once (`git add -A`, `--all`, `-u`, `.`, `:/`,
// `git commit -a`), which takes whatever other sessions left in the folder.
//
// It is off until a project sets config.json `"git": { "mainCheckout": { "guard": true } }`. A target is allowed when it is outside
// every main checkout (in a worktree, or outside the repository), in a project without a project folder or with the
// guard off, matched by `git.mainCheckout.allowWrites`, or git-ignored. When git cannot tell, a tool write is denied to be
// safe and a Bash command runs: a command line is never as certain as a file path.

import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { globPattern } from '../fs.mjs';

import { loadConfig } from '../config.mjs';
import { checkoutRoots, isIgnored, runGit } from '../git.mjs';
import { findProject, worktreesDir } from '../project.mjs';
import { inlineShellCommand, isLongOption, lexSteps, readGit, readInvocation, readShortOptions, SUBSTITUTION_DEPTH_LIMIT } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_MAIN_WRITE';

const PATCH_TARGET = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gmu;
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

// Bash: the deny reason for `command`, or null. A command with no certain target never runs git.
export function check(command, { cwd = process.cwd(), env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  return decide(bashTargets(command, cwd), cwd, false, 'this command writes') ?? gitStateDenial(command, cwd);
}

// The git calls that change the main checkout's state for every session in it, as { what, folders, target }: `folders`
// every folder the call may act on, after a wrapper's `env -C`, git's own `-C`, and `--work-tree` or `--git-dir`.
// Substitutions that run are read too; a call after a `cd` is skipped, as its folder is not certain.
//
// The main checkout is shared, so this reads what is plainly safe and blocks the rest, every other spelling included:
//   git add      only named files (no option but -v, -f, -N, -p, and no folder, glob, or pathspec magic)
//   git commit   any options but -a and --all, with no `--no-` form and no unknown short cluster holding `a`
//   git switch   only back to the default branch, with no option
//   git checkout the default branch with no option, or paths: after `--`, or words that name no commit
// git's own options that change nothing about the repository or how paths match. `-c` is not one: a value such as
// core.worktree moves the checkout.
const SAFE_GLOBALS = /^(?:-C.*|--git-dir(?:=.*)?|--work-tree(?:=.*)?|--no-pager|-P|--paginate|-p|--no-optional-locks|--no-replace-objects)$/u;
const ADD_SAFE = new Set(['-v', '--verbose', '-f', '--force', '-N', '--intent-to-add', '-p', '--patch']);
const COMMIT_VALUES = new Set(['-m', '-F', '-c', '-C', '-t', '--message', '--file', '--author', '--date', '--template', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--cleanup', '--trailer']);
const COMMIT_ATTACHED = new Set(['-u', '-S']);
// `inherited` holds the GIT_* assignments in force: set before an inline shell, or by an earlier `export` or bare
// assignment on the same command line.
const GIT_ASSIGNMENT = /^GIT_[A-Z_]+=/u;
function gitStateChanges(command, cwd, depth = 0, inherited = []) {
  const found = [];
  let known = true;
  const env = [...inherited];
  for (const { segment, substitutions } of lexSteps(command)) {
    if (known && depth < SUBSTITUTION_DEPTH_LIMIT) for (const body of substitutions) found.push(...gitStateChanges(body, cwd, depth + 1, env));
    const invocation = readInvocation(segment);
    // Assignments are the words before the command runs (and an `env` wrapper's), never its arguments: in
    // `git commit -m "GIT_DIR=x"` the message is no assignment. `export` takes them as its arguments.
    const program = segment.findIndex((token) => !token.operator && token.text === invocation.program);
    const head = invocation.program === 'export' ? segment : program === -1 ? segment : segment.slice(0, program);
    const assignments = head.filter((token) => !token.operator && GIT_ASSIGNMENT.test(token.text));
    // `export GIT_DIR=…` or a bare `GIT_DIR=…` lasts for the rest of the line.
    if (invocation.program === 'export' || (assignments.length && !invocation.program)) env.push(...assignments);
    if (CHANGES_DIRECTORY.has(invocation.program)) known = false;
    // `sh -c`, `bash -c`, `flock … -c`, and a heredoc fed to a shell run their command where the invocation runs.
    const inner = known && depth < SUBSTITUTION_DEPTH_LIMIT ? inlineShellCommand(invocation) : null;
    if (inner !== null && !invocation.chdir?.dynamic) found.push(...gitStateChanges(inner, invocation.chdir ? path.resolve(cwd, invocation.chdir.text) : cwd, depth + 1, [...env, ...assignments]));
    const call = known ? readGit(segment) : null;
    if (!call || !['add', 'commit', 'switch', 'checkout'].includes(call.subcommand)) continue;
    const scope = [...env, ...assignments];
    const folders = gitFolders(call.globals, invocation.chdir, cwd, scope);
    if (folders === null) continue;
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
    // --work-tree or --git-dir points git at a repository this hook does not read words in: only a commit without -a
    // is plainly safe there.
    if ((folders.length > 1 || !plainGlobals || gitEnv) && (call.subcommand !== 'commit' || commitsAll(call.rest) || gitEnv)) {
      found.push({ what: `\`git ${call.subcommand}\` with another repository, work tree, or pathspec option can change the shared checkout`, folders, target: null });
      continue;
    }
    if (call.subcommand === 'add') {
      const named = (word) => !/[*?[\]:]/u.test(word) && !isFolder(path.resolve(at, word)) && tracksAtMostItself(at, word);
      const dynamic = call.rest.some((token) => token.dynamic);
      if (dynamic || !options.every((option) => ADD_SAFE.has(option)) || ![...operands, ...after].every(named) || ![...operands, ...after].length) {
        found.push({ what: '`git add` of anything but named files can stage other sessions\' work', folders });
      }
    } else if (call.subcommand === 'commit') {
      if (commitsAll(call.rest)) found.push({ what: '`git commit -a` commits every change in the folder, other sessions\' work included', folders });
    } else if (call.subcommand === 'switch') {
      const back = options.length === 0 && operands.length === 1 && !after.length;
      found.push({ what: '`git switch` moves the folder every session shares to another branch', folders, target: back ? operands[0] : null });
    } else {
      const restore = options.length === 0 && (dashes !== -1 ? after.length > 0 : operands.length > 1 || (operands.length === 1 && !switchesTo(at, operands[0])));
      if (!restore) {
        const back = options.length === 0 && operands.length === 1 && dashes === -1;
        found.push({ what: '`git checkout` moves the folder every session shares to another branch', folders, target: back ? operands[0] : null });
      }
    }
  }
  return found;
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

// Whether `git commit` with these words commits every tracked change: -a or --all in any spelling. A short cluster is
// read up to its first value option, so `-am msg` holds -a and `-mall` does not.
function commitsAll(rest) {
  for (let i = 0; i < rest.length; i += 1) {
    const { text } = rest[i];
    if (text === '--') return false;
    if (text.startsWith('--')) {
      if (isLongOption(text, '--all', '--al')) return true;
      if (COMMIT_VALUES.has(text)) i += 1;
    } else if (text.startsWith('-') && text.length > 1) {
      const { options, value } = readShortOptions(text, COMMIT_VALUES, COMMIT_ATTACHED);
      if (options.includes('-a')) return true;
      if (value?.attached === null) i += 1;
    }
  }
  return false;
}

// Whether `git checkout <word>` would switch branches: the previous branch (`-`), a commit, or a remote branch git
// would create locally. Any other word is a path to restore.
function switchesTo(at, word) {
  if (word === '-') return true;
  const folder = existingFolder(at);
  if (runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${word}^{commit}`], folder).status === 0) return true;
  const remote = runGit(['for-each-ref', '--format=%(refname)', `refs/remotes/*/${word}`], folder);
  return remote.status === 0 && remote.stdout.trim() !== '';
}

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
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
};

// The deny reason for a git call that changes the main checkout's state, or null. Moving back to the default branch
// is allowed: it is where the main checkout belongs.
function gitStateDenial(command, cwd) {
  for (const change of gitStateChanges(command, cwd)) {
    for (const at of change.folders) {
      const folder = existingFolder(at);
      const project = findProject(folder);
      if (!project) continue;
      const { config } = loadConfig(project);
      if (!config.git.mainCheckout.guard) continue;
      const roots = checkoutRoots(folder);
      if (!roots || canonical(roots.current) !== canonical(roots.main)) continue;
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
  let targets = [toolInput.file_path ?? toolInput.notebook_path];
  if (input.tool_name === 'apply_patch') targets = [...String(toolInput.command ?? '').matchAll(PATCH_TARGET)].map((match) => match[1].trim());
  return targets.filter((target) => typeof target === 'string' && target !== '');
}

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
      const own = chdir === null ? place : moved(place, chdir);
      if (WRITERS.has(program)) for (const token of written(program, args)) targets.push({ token, place: own });
      else if (program === 'git') targets.push(...gitWritten(segment, own, restores));
      const inner = shells && depth < SUBSTITUTION_DEPTH_LIMIT ? inlineShellCommand(invocation) : null;
      if (inner !== null) visit(inner, own, depth + 1);
      if (CHANGES_DIRECTORY.has(program)) place = followCd ? moved(place, program === 'popd' ? null : operand(args), true) : UNKNOWN;
    }
  };
  visit(command, { dirs: [cwd], unsure: false }, 0);
  return targets
    .filter(({ token }) => (!token.dynamic || (globs && !/[$`]/u.test(token.text))) && token.text !== '')
    .map(({ token: { text, dynamic }, place }) => {
      if (dynamic) return { text, files: [], dirs: place.dirs, unsure: place.unsure, glob: true };
      if (path.isAbsolute(text)) return { text, files: [text], unsure: false };
      return { text, files: place.dirs.map((dir) => path.resolve(dir, text)), unsure: place.unsure };
    });
}

// The shell's folder once a `cd` may have moved it anywhere: no folder is certain.
const UNKNOWN = Object.freeze({ dirs: [], unsure: true });

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

// The folder a `cd` or `pushd` names: its first word that is not an option. Null when no word names one: none, which is
// the home folder, `-`, the previous folder, or `+1`, a place on the directory stack.
function operand(args) {
  const to = args.find((token) => token.dynamic || !/^-[LPe@]+$/u.test(token.text));
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
    if (token.text === '-C' && value) at = moved(at, value);
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
        const next = value.attached === null ? args[i + 1] ?? null : { text: value.attached, dynamic: args[i].dynamic };
        const compose = program === 'ruby' && folder !== null && next && !path.isAbsolute(next.text);
        // A bare perl -x keeps the folder an earlier -x chose.
        if (next && next.text !== '') folder = compose ? { text: path.join(folder.text, next.text), dynamic: folder.dynamic || next.dynamic } : next;
      }
      if (value?.attached === null) i += 1;
    } else if (text !== '') {
      operands.push(args[i]); // an empty operand is BSD sed's `-i ''` suffix
      // perl and ruby read their own options only up to the first operand; what follows is the script's.
      if (SCRIPT_OPTIONS.has(program)) ended = true;
    }
  }
  if (program === 'dd') return operands.filter(({ text }) => text.startsWith('of=')).map((token) => ({ ...token, text: token.text.slice(3) }));
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
    const backups = suffix?.text ? edited.map((token) => ({ ...token, dynamic: token.dynamic || suffix.dynamic, text: backupOf(program, token.text, suffix.text) })) : [];
    const files = [...edited, ...backups];
    // ruby -C and -x, and perl -x, run in the folder they name: a relative file is read from there.
    if (folder === null || folder.text === '') return files;
    return files.map((token) => (path.isAbsolute(token.text) ? token : { ...token, text: path.join(folder.text, token.text), dynamic: token.dynamic || folder.dynamic }));
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
      return equals === -1 ? args[i + 1] ?? null : { text: text.slice(equals + 1), dynamic };
    }
    if (!/^-./u.test(text)) continue;
    // In a cluster, -S takes the rest as its suffix, and -t takes the rest, or the next word, as the directory.
    const { value } = readShortOptions(text, WRITERS.get('cp'));
    if (value?.option === '-t') return value.attached === null ? args[i + 1] ?? null : { text: value.attached, dynamic };
  }
  return null;
}

function decide(targets, cwd, failSafe, verb) {
  for (const target of targets) {
    const file = canonical(path.resolve(cwd, target));
    const folder = existingFolder(path.dirname(file));
    const project = findProject(folder);
    if (!project) continue;
    const { config } = loadConfig(project);
    if (!config.git.mainCheckout.guard) continue;
    const roots = checkoutRoots(folder);
    if (!roots || canonical(roots.current) !== canonical(roots.main)) continue;
    const root = roots.main;
    const rel = path.relative(canonical(root), file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (config.git.mainCheckout.allowWrites.some((glob) => globPattern(glob).test(rel.split(path.sep).join('/')))) continue;
    const ignored = isIgnored(root, rel || '.');
    if (ignored === true || (ignored === null && !failSafe)) continue;
    const lead =
      ignored === null
        ? `Blocked: git could not tell whether '${rel}' is tracked in the main checkout (${root}), so ${verb} nothing to be safe.`
        : `Blocked: ${verb} '${rel}', a tracked file in the main checkout (${root}).`;
    return reason(lead, project, config);
  }
  return null;
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


// The path with symlinks resolved, for the part of it that exists; git reports the main checkout that way.
export function canonical(file) {
  const tail = [];
  let current = file;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return file;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

// The nearest folder at or above `dir` that exists, for git and the project lookup to start from.
function existingFolder(dir) {
  let current = dir;
  while (!existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}
