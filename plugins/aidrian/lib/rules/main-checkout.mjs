// Write rule: no writes to a tracked file in a project's main checkout; task work happens in a git worktree.
// It covers Edit, Write, and NotebookEdit, Codex's apply_patch, and the Bash commands whose target is certain:
// `>` and `>>`, tee, sed -i, the destination of cp and mv, rm, touch, and mkdir.
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
import { lexCommand, readInvocation } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_MAIN_WRITE';

const PATCH_TARGET = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gmu;
const CHANGES_DIRECTORY = new Set(['cd', 'pushd', 'popd']);
// Programs whose every operand is written, and the options of each that take the next token as their value.
const WRITERS = new Map([
  ['tee', new Set()],
  ['rm', new Set()],
  ['touch', new Set(['-t', '-r', '-d', '--reference', '--date'])],
  ['mkdir', new Set(['-m', '--mode'])],
  ['sed', new Set(['-e', '-f', '--expression', '--file', '-l', '--line-length'])],
  ['cp', new Set(['-S', '--suffix'])],
  ['mv', new Set(['-S', '--suffix'])],
]);

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
  for (const segment of lexCommand(command)) {
    segment.forEach((token, i) => {
      const next = segment[i + 1];
      if ((token.operator === '>' || token.operator === '>>') && next && !next.fdDup && !next.operator) targets.push({ token: next, base: cwd });
    });
    const { program, args, chdir } = readInvocation(segment);
    if (CHANGES_DIRECTORY.has(program)) moved = true;
    if (!WRITERS.has(program)) continue;
    // A wrapper's directory change moves the command's own paths, never the shell's redirections above.
    const base = chdir === null ? cwd : chdir.dynamic ? null : path.resolve(cwd, chdir.text);
    for (const token of written(program, args)) targets.push({ token, base });
  }
  return targets
    .filter(({ token }) => !token.dynamic && token.text !== '')
    .filter(({ token, base }) => path.isAbsolute(token.text) || (base !== null && !(moved && base === cwd)))
    .map(({ token, base }) => (path.isAbsolute(token.text) ? token.text : path.resolve(base, token.text)));
}

// The operands a writer writes: all of them, the destination of cp and mv, and the files of sed -i, never its script.
function written(program, args) {
  const valueFlags = WRITERS.get(program);
  const flags = [];
  const operands = [];
  let ended = false;
  for (let i = 0; i < args.length; i += 1) {
    const { text } = args[i];
    if (!ended && text === '--') ended = true;
    else if (!ended && text.startsWith('-') && text.length > 1) {
      flags.push(text);
      if (valueFlags.has(text)) i += 1;
    } else if (text !== '') {
      operands.push(args[i]); // an empty operand is BSD sed's `-i ''` suffix
    }
  }
  if (program === 'cp' || program === 'mv') return operands.length >= 2 ? operands.slice(-1) : [];
  if (program !== 'sed') return operands;
  const inPlace = flags.some((flag) => flag.startsWith('--in-place') || (/^-[^-]*$/u.test(flag) && flag.includes('i')));
  if (!inPlace) return [];
  const scripted = flags.some((flag) => /^(-e|-f|--expression|--file)(=|$)/u.test(flag));
  return scripted ? operands : operands.slice(1);
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
    `Work in a git worktree instead, for example: git worktree add "${path.join(worktrees, '<branch>')}" -b <branch>`,
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
