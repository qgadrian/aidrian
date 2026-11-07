// The main-checkout rule's shared reading of a target: the guarded main checkout a folder is in, the decision on a
// write target, and the deny reasons. lib/rules/main-checkout.mjs is the rule's entry.

import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
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

// The deny reason for writing `targets`, or null. A target is judged where it is and, when it is a link, where it leads:
// `rm`, `mv`, and `ln -sf` change the link, and a write through it changes its target, or creates one not made yet.
// `leadFor(root)`, when given, writes the reason's first line in place of today's.
export function decide(targets, cwd, failSafe, verb, leadFor = null) {
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
export function existingFolder(dir) {
  let current = dir;
  while (!existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}
