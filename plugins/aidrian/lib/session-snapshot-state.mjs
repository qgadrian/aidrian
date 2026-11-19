// The state folder as `aidrian session snapshot` (lib/session-snapshot.mjs) reads it: what its sections share, and the
// two sections that read the state folder outside the session's own folder, lessons and audits. The state folder's real
// path is resolved once, checked, and kept, and every read goes through that path, so a symlink at `state.dir` repointed
// after the check moves no read. A folder or file read below it is resolved again and must lie inside no checkout of the
// repository either: with a committed `state.dir` of ".." in a repository folder named `lessons` or `audits`, the state
// folder lies outside the checkout, but that folder below it is the checkout itself.

import path from 'node:path';

import { listAudits } from './audits.mjs';
import { loadConfig } from './config.mjs';
import { checkoutHolding, resolvedPath } from './fs.mjs';
import { lessons, lessonStats, stateInbox } from './lesson-inbox.mjs';
import { projectCheckouts, stateDir } from './project.mjs';
import { sessionFolder, stateHeld } from './session-folder.mjs';

// The git and gh calls a snapshot starts, its readers' too (killingGit), hold no lock: one past its limit is killed.
export const KILL = { killSignal: 'SIGKILL' };

// What the sections share: { project, config, state, checkouts, inside, loose, folder }. `state` is the state folder's
// real path (resolvedPath), or null when it cannot be named or resolved. `checkouts` are the project's and every checkout
// of its repository (projectCheckouts), null when git could not list them. `inside` says the state folder resolves inside
// one of them, or it or they cannot be resolved; `loose` says it, or a folder above it, fails stateHeld. `folder` is the
// session's folder, or null; a session that was given and has none, whether its id fails or its folder cannot be made,
// names the cached sections in `errors`: `worktrees`, `handoff` when the id fails or a transcript was given, and `prs`
// when the id fails or the state folder is inside a checkout.
export function snapshotContext(project, { session, transcript, validId }, errors) {
  const config = loadConfig(project).config;
  let named = null;
  try {
    named = stateDir(project, { config, read: () => KILL });
  } catch {
    // Each section that needs the state folder fails on its own.
  }
  const state = named === null ? null : resolvedPath(named);
  const checkouts = projectCheckouts(project);
  const inside = state === null || checkouts === null || checkoutHolding(state, checkouts) !== undefined;
  const loose = state !== null && !stateHeld(state);
  const folder = validId && !inside ? sessionFolder(state, session, { checkouts }) : null;
  if (session !== null && folder === null) {
    const failed = [['prs', !validId || inside], ['worktrees', true], ['handoff', !validId || transcript !== null], ['links', true]];
    for (const [name, failing] of failed) if (failing) errors.add(name);
  }
  return { project, config, state, checkouts, inside, loose, folder };
}

// The real path of the state folder of `ctx`, as snapshotContext resolved and checked it, when it lies outside every
// checkout and it and every folder above pass stateHeld; else throws.
export const ownState = (ctx) => {
  if (ctx.inside || ctx.loose) throw new Error('not the user`s own');
  return ctx.state;
};

// The real path of `file`, below the state folder of `ctx` (ownState), when it resolves inside no checkout; else throws.
export function ownPath(ctx, file) {
  const real = resolvedPath(file);
  if (real === null || checkoutHolding(real, ctx.checkouts) !== undefined) throw new Error('inside a checkout');
  return real;
}

// { open, byTier }: the open lessons of the project's own inbox, by tier.
export function lessonsSection(ctx) {
  const { count, tiers } = lessonStats(lessons(ownPath(ctx, stateInbox(ownState(ctx))))).open;
  return { open: count, byTier: tiers };
}

// { untriaged }: the audit findings no triage decided yet, over every live report in the state folder's audits folder.
export function auditsSection(ctx) {
  const reports = listAudits(ownPath(ctx, path.join(ownState(ctx), 'audits')));
  return { untriaged: reports.reduce((sum, each) => sum + Math.max(each.untriaged, 0), 0) };
}
