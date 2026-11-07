// The main-checkout rule's shared reading of a target: the guarded main checkout a folder is in, the decision on a
// write target, and the deny reasons. lib/rules/main-checkout.mjs is the rule's entry.

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { globPattern } from '../../fs.mjs';

import { loadConfig } from '../../config.mjs';
import { checkoutRoots, isIgnored } from '../../git.mjs';
import { findProject, worktreesDir } from '../../project.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_MAIN_WRITE';

const WAY_OUT = 'Name the folder in each command instead: an absolute path, `git -C <absolute folder>`, or `env -C <absolute folder>`.';
// Why a cd may fail unseen: a shell alias or function for cd can fail and still return 0. `builtin cd` skips those and
// fails loudly, but it can still fail, as on a missing folder.
const mayFail = (cd, acts, root) =>
  `if it fails, ${acts} the main checkout (${root})${cd.startsWith('builtin ') ? '.' : ': a shell alias or function for cd can fail and still return 0.'}`;
export const cdLead = (subject, acts, cd, root) =>
  `Blocked: ${subject} after a cd that leaves the repository, or that this rule cannot read. The cd is \`${cd}\`; ` +
  `${mayFail(cd, acts, root)}\n${WAY_OUT}`;
// A write the main checkout gets only when a `cd` inside it fails, such as `cd build && echo x > a.txt`.
export const failedCdLead = (name, cd, root) =>
  `Blocked: this command writes '${name}' in the main checkout if a cd before it fails. The cd is \`${cd}\`; ` +
  `${mayFail(cd, 'the write lands in', root)}\n${WAY_OUT}`;

// The guarded main checkout `at` is in, as { project, config, roots }, or null. Read once per folder per hook run.
const guardedMains = new Map();
export function guardedMain(at) {
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

// `leadFor(root)`, when given, writes the reason's first line in place of today's.
export function decide(targets, cwd, failSafe, verb, leadFor = null) {
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
    const lead = leadFor
      ? leadFor(root)
      : ignored === null
        ? `Blocked: git could not tell whether '${rel}' is tracked in the main checkout (${root}), so ${verb} nothing to be safe.`
        : `Blocked: ${verb} '${rel}', a tracked file in the main checkout (${root}).`;
    return reason(lead, project, config);
  }
  return null;
}

export function reason(lead, project, config) {
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
export function existingFolder(dir) {
  let current = dir;
  while (!existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}
