// `aidrian worktree new|cleanup`: the task worktree lifecycle, for the worktree-new and worktree-cleanup skills.
// `new` creates a worktree for a branch in the project's worktrees folder and runs config.json `git.worktrees.bootstrap`
// there. `cleanup` sorts the other worktrees into auto (a merged pull request's exact head, clean with no ignored files
// outside the `git.worktrees.disposable` folders, old enough), confirm (everything else, with the reasons), and skip, and
// removes auto rows plus the ones a person confirmed. Its plan only reads: it writes nothing to the repository.
// Both print one JSON object; a problem is {"status":"blocked","phase","reason","next_step"} with exit 1.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { CONFIG_ERROR, commandConfig } from './config.mjs';
import { ghJson } from './gh.mjs';
import { checkoutRoots, isIgnored } from './git.mjs';
import { projectAt, worktreesDir } from './project.mjs';
import { usageLines } from './usage.mjs';

const SLUG = /^[A-Za-z0-9_+][A-Za-z0-9._+-]*$/;
const DAY_SEC = 24 * 60 * 60;
// A failed bootstrap reports the end of its output: the error is there, and the whole log would flood the context.
const OUTPUT_TAIL_LINES = 20;
const GH_PR_LIMIT = 400;
// A confirm reason names at most this many ignored files; the row's `ignored` lists them all.
const IGNORED_SHOWN = 10;
// The squash check reads base's commits that touch the branch's files, named on the command line up to this many.
const PATHS_LIMIT = 500;

const OPTIONS = {
  base: { type: 'string' },
  slug: { type: 'string' },
  fetch: { type: 'boolean' },
  plan: { type: 'boolean' },
  'reuse-existing': { type: 'boolean' },
  'min-age': { type: 'string' },
  force: { type: 'boolean' },
};

export const commands = {
  worktree: {
    usage: 'new BRANCH [--base REF] [--slug NAME] [--fetch] [--plan] [--reuse-existing] | cleanup [plan|execute] [--min-age 24h] [--force]',
    about: 'create a task worktree and run its bootstrap, or remove the worktrees whose work has merged (execute reads decisions on stdin)',
    run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS });
      const [action, target, ...extra] = positionals;
      try {
        if (action === 'new' && target && !extra.length) {
          return print(createWorktree({ branch: target, slug: values.slug, base: values.base, fetch: values.fetch, plan: values.plan, reuseExisting: values['reuse-existing'] }));
        }
        if (action === 'cleanup' && ['plan', 'execute', undefined].includes(target) && !extra.length) {
          const minAgeSec = parseDuration(values['min-age'] ?? '24h');
          if (target !== 'execute') return print(planCleanup({ minAgeSec }));
          const raw = readFileSync(0, 'utf8');
          return print(executeCleanup({ minAgeSec, force: Boolean(values.force), decisions: raw.trim() ? JSON.parse(raw) : {} }));
        }
      } catch (error) {
        console.log(JSON.stringify({ status: 'blocked', phase: error.phase ?? 'arguments', reason: error.message, ...(error.nextStep ? { next_step: error.nextStep } : {}) }));
        return 1;
      }
      console.error(usageLines('worktree', commands.worktree.usage, 'usage: ').join('\n'));
      return 1;
    },
  },
};

function print(result) {
  console.log(JSON.stringify(result));
  return 0;
}

const blocked = (phase, reason, nextStep) => Object.assign(new Error(reason), { phase, nextStep });

// The raw result of a command; `status` is 1 when it could not start.
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
}

const git = (root, args) => run('git', ['-C', root, ...args]);
const failure = (result) => result.stderr.trim() || result.stdout.trim() || `exited ${result.status}`;

// The repository context every step needs: the main checkout, the current checkout, the config, and the base ref.
function context(cwd) {
  const roots = checkoutRoots(cwd);
  if (!roots) throw blocked('preconditions', `${cwd} is not inside a git repository`);
  const project = projectAt(cwd);
  const config = projectConfig(project);
  const hasOrigin = git(roots.main, ['remote', 'get-url', 'origin']).status === 0;
  const remoteDefault = `origin/${config.git.defaultBranch}`;
  const base = hasOrigin && git(roots.main, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteDefault}`]).status === 0 ? remoteDefault : config.git.defaultBranch;
  return { ...roots, project, config, hasOrigin, base };
}

// The project's config. A config.json with errors blocks the run in the `config` phase, before any change.
function projectConfig(project) {
  try {
    return commandConfig(project);
  } catch (error) {
    if (error.code !== CONFIG_ERROR) throw error;
    throw blocked('config', error.message, 'Fix config.json; aidrian check lists every problem.');
  }
}

// Plans or creates the worktree for `branch`. A new branch starts at `base` (origin/<defaultBranch>, or the local
// default branch without one) with no upstream, so a bare `git push` cannot target the default branch. An existing
// local or remote branch is reused only with `reuseExisting`, after a person approved the plan that named it.
export function createWorktree({ branch, slug, base, fetch = false, plan = false, reuseExisting = false }, { cwd = process.cwd() } = {}) {
  const ctx = context(cwd);
  if (run('git', ['check-ref-format', '--branch', branch]).status !== 0) throw blocked('validate', `invalid branch name: ${branch}`);
  const name = slug ?? branch.split('/').pop();
  if (!SLUG.test(name)) throw blocked('validate', `invalid worktree folder name: ${name}`, 'Pass --slug with letters, digits, ".", "_", "+", or "-".');
  if (fetch && ctx.hasOrigin) {
    const fetched = git(ctx.main, ['fetch', 'origin']);
    if (fetched.status !== 0) throw blocked('fetch', failure(fetched), 'Retry without --fetch to use the local refs.');
  }
  const baseRef = base ?? ctx.base;
  const resolved = git(ctx.main, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (resolved.status !== 0) throw blocked('resolve-base', `base ref not found: ${baseRef}`, 'Pass --base with a ref that exists, or --fetch.');

  const folder = worktreesDir(ctx.project, { config: ctx.config });
  const rel = path.relative(ctx.main, folder);
  if (!rel.startsWith('..') && !path.isAbsolute(rel) && isIgnored(ctx.main, `${folder}/`) === false) {
    throw blocked('preconditions', `${folder} is inside the repository but not git-ignored`, `Add "${rel.split(path.sep).join('/')}/" to .gitignore (aidrian init does), or set git.worktrees.dir.`);
  }
  const dir = path.join(folder, name);
  if (existsSync(dir)) throw blocked('validate-path', `the worktree folder already exists: ${dir}`, 'Use it, or pass another --slug.');
  const holder = listWorktrees(ctx.main).find((worktree) => worktree.branch === branch);
  if (holder) throw blocked('validate-branch', `${branch} is checked out in ${holder.path}`, `Work in ${holder.path}.`);

  let mode = 'new';
  let addArgs = ['worktree', 'add', '--no-track', '-b', branch, dir, baseRef];
  let fetchBranch = false;
  if (git(ctx.main, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) {
    mode = 'reuse-local';
    addArgs = ['worktree', 'add', dir, branch];
  } else if (ctx.hasOrigin) {
    const tracked = git(ctx.main, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).status === 0;
    const remote = tracked ? { status: 0 } : git(ctx.main, ['ls-remote', '--exit-code', '--heads', 'origin', branch]);
    if (remote.status === 0) {
      mode = 'reuse-remote';
      fetchBranch = !tracked;
      addArgs = ['worktree', 'add', '--track', '-b', branch, dir, `origin/${branch}`];
    } else if (remote.status !== 2) {
      throw blocked('inspect-remote', failure(remote), 'Fix access to origin, or retry with --fetch; a branch is not created while its remote state is unknown.');
    }
  }

  const report = { worktree_path: dir, branch, branch_mode: mode, base: baseRef, base_sha: resolved.stdout.trim(), bootstrap: ctx.config.git.worktrees.bootstrap };
  if (plan) return { status: 'planned', ...report };
  if (mode !== 'new' && !reuseExisting) {
    throw blocked('confirm-reuse', `the branch already exists (${mode}): ${branch}`, 'Run again with --reuse-existing once the reuse is approved.');
  }
  if (fetchBranch) {
    const fetched = git(ctx.main, ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    if (fetched.status !== 0) throw blocked('fetch-branch', failure(fetched), `Fetch ${branch} from origin, then run again.`);
  }
  const added = git(ctx.main, addArgs);
  if (added.status !== 0) throw blocked('create', failure(added), 'Fix the git error and run again; nothing was removed.');
  if (ctx.config.git.worktrees.bootstrap) {
    const setup = run('sh', ['-c', ctx.config.git.worktrees.bootstrap], { cwd: dir });
    if (setup.status !== 0) {
      const tail = `${setup.stdout}${setup.stderr}`.trim().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
      throw blocked('bootstrap', `the worktree ${dir} was created, but its bootstrap failed:\n${tail}`, `cd ${JSON.stringify(dir)} && ${ctx.config.git.worktrees.bootstrap}`);
    }
  }
  return { status: 'created', ...report };
}

// `git worktree list --porcelain` as [{ path, main, head, branch, locked, prunable }]. The first entry is the main
// checkout, which `main` marks: its path is not always the folder (a separate git folder is listed in its place).
export function listWorktrees(main) {
  const listed = git(main, ['worktree', 'list', '--porcelain']);
  if (listed.status !== 0) throw blocked('inspect-worktrees', failure(listed));
  return listed.stdout.split('\n\n').filter((block) => block.startsWith('worktree ')).map((block, index) => {
    const lines = block.split('\n');
    const value = (key) => lines.find((line) => line === key || line.startsWith(`${key} `))?.slice(key.length + 1);
    return {
      path: value('worktree'),
      main: index === 0,
      head: value('HEAD') ?? null,
      branch: value('branch')?.replace(/^refs\/heads\//, '') ?? null,
      locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')),
      prunable: lines.some((line) => line === 'prunable' || line.startsWith('prunable ')),
    };
  });
}

// `30m`, `2h`, `1d`, or bare seconds; `0` turns the age guard off.
export function parseDuration(text) {
  const match = /^(\d+)([smhd]?)$/.exec(String(text).trim());
  if (!match) throw blocked('arguments', `invalid --min-age: ${text} (use seconds, or 30m, 2h, 1d)`);
  return Number(match[1]) * { '': 1, s: 1, m: 60, h: 3600, d: DAY_SEC }[match[2]];
}

// Head commits of merged pull requests, by branch name, or null when gh cannot answer (absent, offline, no GitHub).
export function mergedHeads(main) {
  try {
    const heads = new Map();
    for (const { headRefName, headRefOid } of ghJson(['pr', 'list', '--state', 'merged', '--limit', String(GH_PR_LIMIT), '--json', 'headRefName,headRefOid'], { cwd: main })) {
      if (headRefName && headRefOid) heads.set(headRefName, [...(heads.get(headRefName) ?? []), headRefOid]);
    }
    return heads;
  } catch {
    return null;
  }
}

// Sorts every worktree. Auto needs proof that nothing is lost: HEAD is exactly a merged pull request's head, the tree is
// clean and holds no git-ignored file, such as a `.env`, outside the folders config.json `git.worktrees.disposable` names,
// such as `node_modules/`, and the worktree is old enough. A merge seen only by git (HEAD already on the base, or the
// same change squashed into it) is also true of a branch created a minute ago with no commits, so it only frames the
// confirm question.
export function planCleanup({ minAgeSec = DAY_SEC } = {}, { cwd = process.cwd(), heads = mergedHeads, now = Date.now() } = {}) {
  const ctx = context(cwd);
  const merged = heads(ctx.main);
  const out = {
    status: 'planned', base: ctx.base, gh_available: merged !== null, min_age_sec: minAgeSec, disposable: ctx.config.git.worktrees.disposable,
    auto: [], confirm: [], skip: [],
  };
  for (const worktree of listWorktrees(ctx.main)) {
    const row = classify(worktree, ctx, merged, minAgeSec, now);
    out[row.bucket].push(row);
  }
  return out;
}

function classify(worktree, ctx, merged, minAgeSec, now) {
  const { path: dir, branch, head } = worktree;
  const skip = (reason) => ({ bucket: 'skip', path: dir, branch, reason });
  if (worktree.main) return skip('main checkout');
  if (dir === ctx.current) return skip('current worktree');
  if (worktree.locked) return skip('locked');
  if (worktree.prunable) return skip('folder is gone; cleanup execute prunes it');
  const age = ageSec(dir, now);
  if (age !== null && age < minAgeSec) return skip(`too new: ${Math.floor(age / 3600)}h old, under --min-age`);

  const { changes, ignored, disposable } = treeState(dir, ctx.config.git.worktrees.disposable);
  const oids = (branch && merged?.get(branch)) ?? [];
  const exact = oids.includes(head);
  const reasons = [];
  if (exact) reasons.push('merged pull request');
  else if (oids.some((oid) => git(ctx.main, ['merge-base', '--is-ancestor', oid, head]).status === 0)) reasons.push('commits after its merged pull request');
  else if (head && git(ctx.main, ['merge-base', '--is-ancestor', head, ctx.base]).status === 0) reasons.push(`already in ${ctx.base}; no merged pull request confirms it`);
  else if (head && patchMerged(ctx.main, head, ctx.base)) reasons.push(`its changes are in ${ctx.base}; no merged pull request confirms it`);
  else reasons.push(`not merged into ${ctx.base}`);
  if (changes === null) reasons.push('git status failed');
  else if (changes > 0) reasons.push(`${changes} uncommitted change${changes === 1 ? '' : 's'}`);
  if (ignored.length) {
    const more = ignored.length > IGNORED_SHOWN ? `, and ${ignored.length - IGNORED_SHOWN} more` : '';
    reasons.push(`${ignored.length} git-ignored file${ignored.length === 1 ? '' : 's'}, removed with it: ${ignored.slice(0, IGNORED_SHOWN).join(', ')}${more}`);
  }
  // A detached HEAD's commits that no branch, remote branch, or tag holds go with its worktree: null when git cannot say.
  const unreachable = branch === null && head ? onNoBranch(ctx.main, head) : 0;
  if (unreachable === null) reasons.push('detached HEAD: git could not tell whether a branch holds its commits');
  else if (unreachable > 0) reasons.push(`detached HEAD: ${unreachable} commit${unreachable === 1 ? '' : 's'} on no branch, lost when it is removed`);
  if (age === null) reasons.push('age unknown');
  // `unless-moved` where every commit on the branch is in the merged pull request: the branch goes only while it still
  // points at the inspected `head`. Otherwise `if-merged`: `git branch -d`, which git refuses for unmerged work.
  const row = {
    path: dir, branch, head, reasons, dirty: changes !== 0, ignored, disposable, unreachable,
    branch_delete: branch ? (exact ? 'unless-moved' : 'if-merged') : null,
  };
  return { bucket: exact && changes === 0 && !ignored.length && age !== null ? 'auto' : 'confirm', ...row };
}

// A worktree's files as git status sees them: { changes, ignored, disposable }. `changes` counts tracked and untracked
// changes, null when git status fails. The git-ignored files and folders, which `git worktree remove` deletes too, split
// in two: `disposable` lists those inside a folder named in `folders` (config.json `git.worktrees.disposable`), at any
// depth, as `packages/a/node_modules/` is; `ignored` lists the rest. `--ignored=matching` lists what an ignore pattern
// matches, so a folder that holds only ignored files is not listed whole, as `packages/` would be.
function treeState(dir, folders) {
  const status = git(dir, ['status', '--porcelain', '--ignored=matching']);
  if (status.status !== 0) return { changes: null, ignored: [], disposable: [] };
  const lines = status.stdout.split('\n').filter(Boolean);
  const all = lines.filter((line) => line.startsWith('!! ')).map((line) => line.slice(3));
  // A folder is every part of the path but the last, and the last too when git lists a folder (`node_modules/`).
  const inDisposable = (entry) => entry.split('/').slice(0, -1).some((part) => folders.includes(part));
  return { changes: lines.length - all.length, ignored: all.filter((entry) => !inDisposable(entry)), disposable: all.filter(inDisposable) };
}

// How many commits reachable from `head` no local branch, remote branch, or tag holds; null when git cannot say.
function onNoBranch(main, head) {
  const counted = git(main, ['rev-list', '--count', head, '--not', '--branches', '--remotes', '--tags']);
  return counted.status === 0 ? Number(counted.stdout.trim()) : null;
}

// Seconds since the worktree was created: the birth (else change) time of its `.git` file. Null when unreadable.
function ageSec(dir, now) {
  try {
    const stat = statSync(path.join(dir, '.git'));
    return Math.floor((now - (stat.birthtimeMs || stat.mtimeMs)) / 1000);
  } catch {
    return null;
  }
}

// A squash merge: the branch's whole change since its merge base has the same patch id as one of base's commits since
// then, as `git cherry` would judge a commit of it. It only reads: the patch ids come from diff and log output.
function patchMerged(main, head, base) {
  const mergeBase = git(main, ['merge-base', head, base]);
  if (mergeBase.status !== 0) return false;
  const from = mergeBase.stdout.trim();
  const diff = ['--no-color', '--no-ext-diff', '--no-textconv'];
  const [own] = patchIds(main, ['diff', ...diff, from, head]);
  const names = git(main, ['diff', '--name-only', '-z', from, head]);
  if (!own || names.status !== 0) return false;
  // Only a commit that touches the same files can hold the same patch; --full-diff still shows the whole commit.
  const files = names.stdout.split('\0').filter(Boolean);
  const only = files.length <= PATHS_LIMIT ? ['--full-diff', '--', ...files] : [];
  return patchIds(main, ['--literal-pathspecs', 'log', '-p', '--no-merges', ...diff, `${from}..${base}`, ...only]).includes(own);
}

// The patch id of each patch the git command prints, in order; none when it fails.
function patchIds(main, args) {
  const patches = git(main, args);
  if (patches.status !== 0 || !patches.stdout) return [];
  const ids = run('git', ['-C', main, 'patch-id', '--stable'], { input: patches.stdout });
  return ids.status === 0 ? ids.stdout.split('\n').filter(Boolean).map((line) => line.split(' ')[0]) : [];
}

// Sorts again, then removes every auto row and every confirm row whose path `decisions` marks "delete". A decision's
// path and a row's match with symlinks resolved, so `/tmp/x` names the row git lists as `/private/tmp/x`; a decision
// that names no row is reported in `unmatched`. A row with uncommitted changes, or a detached HEAD with commits on no
// branch, needs both that decision and `force`. Another session may commit while this runs, so a row whose HEAD moved,
// or whose tree gained changes or ignored files, is refused with its branch kept. Branches go with their worktree;
// `git worktree prune` ends it.
export function executeCleanup({ minAgeSec = DAY_SEC, force = false, decisions = {} } = {}, { cwd = process.cwd(), heads = mergedHeads, now = Date.now() } = {}) {
  const plan = planCleanup({ minAgeSec }, { cwd, heads, now });
  const { main } = checkoutRoots(cwd);
  const decided = new Map(Object.entries(decisions).map(([key, decision]) => [realPath(key), { key, decision }]));
  const rows = [...plan.auto, ...plan.confirm, ...plan.skip].map((row) => realPath(row.path));
  const unmatched = [...decided].filter(([real]) => !rows.includes(real)).map(([, { key }]) => key);
  const out = { status: 'done', removed: [], kept: [], refused: [], failed: [], unmatched };
  const remove = (row, forced) => {
    const changed = changedSinceInspected(row, forced, plan.disposable);
    if (changed) return out.refused.push({ path: row.path, reason: `changed after it was inspected: ${changed}; kept with its branch, run cleanup again` });
    const removed = git(main, ['worktree', 'remove', ...(forced ? ['--force'] : []), row.path]);
    if (removed.status !== 0) return out.failed.push({ path: row.path, error: failure(removed) });
    const entry = { path: row.path, branch: row.branch, branch_deleted: false };
    if (row.branch_delete) {
      const deleted = row.branch_delete === 'unless-moved' ? deleteBranchAt(main, row.branch, row.head) : git(main, ['branch', '-d', row.branch]);
      entry.branch_deleted = deleted.status === 0;
      if (!entry.branch_deleted) entry.branch_error = failure(deleted);
    }
    return out.removed.push(entry);
  };
  for (const row of plan.auto) remove(row, false);
  for (const row of plan.confirm) {
    if (decided.get(realPath(row.path))?.decision !== 'delete') out.kept.push(row.path);
    else if (row.dirty && !force) out.refused.push({ path: row.path, reason: 'uncommitted changes: needs --force as well as the delete decision' });
    else if (row.unreachable !== 0 && !force) out.refused.push({ path: row.path, reason: 'commits on no branch: needs --force as well as the delete decision' });
    else remove(row, row.dirty);
  }
  git(main, ['worktree', 'prune']);
  return out;
}

// What changed in a row since classify read it, or null: its HEAD, or, unless the removal is forced, its clean tree and
// its list of ignored files outside the `disposable` folders.
function changedSinceInspected(row, forced, disposable) {
  const head = git(row.path, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const current = head.status === 0 ? head.stdout.trim() : null;
  if (!row.head || current !== row.head) return `HEAD moved from ${row.head ?? 'unknown'} to ${current ?? 'unknown'}`;
  if (forced) return null;
  const { changes, ignored } = treeState(row.path, disposable);
  if (changes === null) return 'git status failed';
  if (changes > 0) return 'uncommitted changes appeared';
  const added = ignored.filter((file) => !row.ignored.includes(file));
  return added.length ? `git-ignored files appeared: ${added.slice(0, IGNORED_SHOWN).join(', ')}` : null;
}

// `file` with its symlinks resolved, or as given when it does not exist.
function realPath(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// Deletes a branch only while it still points at `sha`, then its config section, as `git branch -D` does. A commit
// that lands between the last check and this keeps the branch, and git names both commits in the error.
function deleteBranchAt(main, branch, sha) {
  const deleted = git(main, ['update-ref', '-d', `refs/heads/${branch}`, sha]);
  if (deleted.status === 0) git(main, ['config', '--remove-section', `branch.${branch}`]);
  return deleted;
}
