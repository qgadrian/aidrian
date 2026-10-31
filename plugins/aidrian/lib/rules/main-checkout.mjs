// Write rule: no writes to a tracked file in a project's main checkout; task work happens in a git worktree.
// It covers Edit, Write, and NotebookEdit, Codex's apply_patch, and the Bash commands whose target is certain:
// `>` and `>>`, tee, sed -i, perl -i, ruby -i, the destination of cp, ln, and install, every path of mv, git mv, rm, git rm, unlink, touch,
// mkdir, and truncate, dd's of=, and the local destination of rsync, with its sources too under --remove-source-files. A move removes its sources. A command
// substitution that runs is read as the command line is.
//
// It is off until a project sets config.json `"git": { "mainCheckout": { "guard": true } }`. A target is allowed when it is outside
// every main checkout (in a worktree, or outside the repository), in a project without a project folder or with the
// guard off, matched by `git.mainCheckout.allowWrites`, or git-ignored. When git cannot tell, a tool write is denied to be
// safe and a Bash command runs: a command line is never as certain as a file path.

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { globPattern } from '../fs.mjs';

import { loadConfig } from '../config.mjs';
import { checkoutRoots, isIgnored } from '../git.mjs';
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
  return decide(bashTargets(command, cwd), cwd, false, 'this command writes');
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
        if (next) folder = compose ? { text: path.join(folder.text, next.text), dynamic: folder.dynamic || next.dynamic } : next;
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
    // perl -i and ruby -i edit their files in place; without -i they only read them.
    if (!flags.includes('-i')) return [];
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
