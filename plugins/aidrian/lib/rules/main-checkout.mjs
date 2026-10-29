// Write rule: no writes to a tracked file in a project's main checkout; task work happens in a git worktree.
// It covers Edit, Write, and NotebookEdit, Codex's apply_patch, and the Bash commands whose target is certain:
// `>` and `>>`, tee, sed -i, the destination of cp, every path of mv, git mv, rm, git rm, unlink, touch, and mkdir, and
// the local destination of rsync, with its sources too under --remove-source-files. A move removes its sources. A command
// substitution that runs is read as the command line is.
//
// It is off until a project sets config.json `"mainCheckout": { "guard": true }`. A target is allowed when it is outside
// every main checkout (in a worktree, or outside the repository), in a project without a project folder or with the
// guard off, matched by `mainCheckout.allowWrites`, or git-ignored. When git cannot tell, a tool write is denied to be
// safe and a Bash command runs: a command line is never as certain as a file path.

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../config.mjs';
import { checkoutRoots, isIgnored } from '../git.mjs';
import { findProject, worktreesDir } from '../project.mjs';
import { commandLines, isLongOption, lexCommand, readGit, readInvocation } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_MAIN_WRITE';

const PATCH_TARGET = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gmu;
const CHANGES_DIRECTORY = new Set(['cd', 'pushd', 'popd']);
// Programs whose every operand is written, and the options of each that take the next token as their value. A long one
// also matches by a prefix, as getopt_long reads it: `sed --fi script.sed` takes `--file`'s value.
const WRITERS = new Map([
  ['tee', new Set()],
  ['rm', new Set()],
  ['unlink', new Set()],
  ['touch', new Set(['-t', '-r', '-d', '--reference', '--date'])],
  ['mkdir', new Set(['-m', '--mode'])],
  ['sed', new Set(['-e', '-f', '--expression', '--file', '-l', '--line-length'])],
  ['cp', new Set(['-S', '--suffix', '-t', '--target-directory'])],
  ['mv', new Set(['-S', '--suffix', '-t', '--target-directory'])],
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
// git subcommands whose every path is written: git mv removes its sources, git rm its paths.
const GIT_WRITERS = new Map([
  ['mv', new Set()],
  ['rm', new Set(['--pathspec-from-file'])],
]);
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
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const toolInput = input.tool_input ?? {};
  let targets = [toolInput.file_path ?? toolInput.notebook_path];
  if (input.tool_name === 'apply_patch') targets = [...String(toolInput.command ?? '').matchAll(PATCH_TARGET)].map((match) => match[1].trim());
  return decide(targets.filter((target) => typeof target === 'string' && target !== ''), cwd, true, 'this writes');
}

// Every path a Bash command writes with certainty, resolved against `cwd`. A relative target after a `cd` is dropped.
export function bashTargets(command, cwd) {
  const targets = [];
  let moved = false;
  for (const segment of commandLines(command).flatMap((line) => lexCommand(line))) {
    segment.forEach((token, i) => {
      const next = segment[i + 1];
      if ((token.operator === '>' || token.operator === '>>') && next && !next.fdDup && !next.operator) targets.push({ token: next, base: cwd });
    });
    const { program, args, chdir } = readInvocation(segment);
    if (CHANGES_DIRECTORY.has(program)) moved = true;
    // A wrapper's directory change moves the command's own paths, never the shell's redirections above.
    const base = chdir === null ? cwd : chdir.dynamic ? null : path.resolve(cwd, chdir.text);
    if (WRITERS.has(program)) for (const token of written(program, args)) targets.push({ token, base });
    else if (program === 'git') targets.push(...gitWritten(segment, base));
  }
  return targets
    .filter(({ token }) => !token.dynamic && token.text !== '')
    .filter(({ token, base }) => path.isAbsolute(token.text) || (base !== null && !(moved && base === cwd)))
    .map(({ token, base }) => (path.isAbsolute(token.text) ? token.text : path.resolve(base, token.text)));
}

// git mv and git rm: every path they name, resolved from `git -C`, which moves them as a wrapper's directory change does.
function gitWritten(segment, base) {
  const call = readGit(segment);
  if (!call || !GIT_WRITERS.has(call.subcommand)) return [];
  let dir = base;
  call.globals.forEach((token, i) => {
    const value = call.globals[i + 1];
    if (token.text === '-C' && value) dir = dir === null || value.dynamic ? null : path.resolve(dir, value.text);
  });
  return written('git', call.rest, GIT_WRITERS.get(call.subcommand)).map((token) => ({ token, base: dir }));
}

// The operands a writer writes: all of them, every path of mv, the destination of cp and rsync (and rsync's sources
// under --remove-source-files), and the files of sed -i, never its script.
function written(program, args, valueFlags = WRITERS.get(program)) {
  const flags = [];
  const operands = [];
  let ended = false;
  for (let i = 0; i < args.length; i += 1) {
    const { text } = args[i];
    if (!ended && text === '--') ended = true;
    else if (!ended && text.startsWith('-') && text.length > 1) {
      flags.push(text);
      if (valueFlags.has(text) || (/^--[^=]+$/u.test(text) && [...valueFlags].some((option) => option.startsWith(text)))) i += 1;
    } else if (text !== '') {
      operands.push(args[i]); // an empty operand is BSD sed's `-i ''` suffix
    }
  }
  if (program === 'cp' || program === 'mv') {
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
  if (program !== 'sed') return operands;
  // GNU sed takes a prefix of a long option: `--i` is `--in-place`, `--e` is `--expression`, `--fi` is `--file`.
  const inPlace = flags.some((flag) => isLongOption(flag, '--in-place', '--i') || (/^-[^-]*$/u.test(flag) && flag.includes('i')));
  if (!inPlace) return [];
  const scripted = flags.some((flag) => /^-[ef](=|$)/u.test(flag) || isLongOption(flag, '--expression', '--e') || isLongOption(flag, '--file', '--fi'));
  return scripted ? operands : operands.slice(1);
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
    for (let j = 1; j < text.length && text[j] !== 'S'; j += 1) {
      if (text[j] === 't') return j + 1 < text.length ? { text: text.slice(j + 1), dynamic } : args[i + 1] ?? null;
    }
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
    if (!config.mainCheckout.guard) continue;
    const roots = checkoutRoots(folder);
    if (!roots || canonical(roots.current) !== canonical(roots.main)) continue;
    const root = roots.main;
    const rel = path.relative(canonical(root), file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (config.mainCheckout.allowWrites.some((glob) => globPattern(glob).test(rel.split(path.sep).join('/')))) continue;
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
    `This project turns the guard on with "mainCheckout": { "guard": true } in ${path.join(project.root, project.paths.config)};`,
    '"mainCheckout": { "allowWrites": [...] } lists paths that stay writable.',
    `To override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
      "(agents must never set it on the user's behalf).",
  ].join('\n');
}

// `*` matches within one path segment, `**` across segments.
function globPattern(glob) {
  let body = '';
  for (const part of glob.split(/(\*\*\/|\*\*|\*)/u)) {
    if (part === '**/') body += '(?:.*/)?';
    else if (part === '**') body += '.*';
    else if (part === '*') body += '[^/]*';
    else body += part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${body}$`, 'u');
}

// The path with symlinks resolved, for the part of it that exists; git reports the main checkout that way.
function canonical(file) {
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
