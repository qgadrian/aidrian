// What git says of the checkout a project run's issue session makes its one exact push from (lib/issue-forge-guard.mjs
// pushProblem), once the words have passed: that it is the session's own clone or worktree, not a repository nested in
// it; that origin pushes to the URL the issue's start pinned; that, when that start gave its clone the base branch's
// copies of the host files (its `overlay`), its commits change no host config or instruction file from the head it
// started from; that its commits change none of the forge's workflow files
// from where they leave origin's default branch; and that it holds no uncommitted change to one, which a command run
// beside the push, or after the guard read it, could commit into the push. Every git call runs within the guards' budget,
// and one that fails, or does not answer in time, refuses the push.

import { checkDeadline, remainingMs } from './deadline.mjs';
import { forgeWorkflowFolders } from './forges/index.mjs';
import { runGit } from './git.mjs';
import { GUARDED_PATHS } from './project.mjs';

// The refs a push's commits are compared with, the first that git resolves: origin's default branch, as config-committed.mjs
// originDefaultTip names it, origin/HEAD, then the plugin's default branch name.
const BASE_REFS = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main'];
// What the session runs when git names no base: `git fetch origin` sets origin/HEAD again from git 2.48 on, and brings
// origin/main back; `git remote set-head origin --auto`, which the remote-change rule lets an issue session run, reads the
// forge's own default branch for an older git.
const NO_BASE = 'it pushes from a checkout where git names no merge base with origin\'s default branch (refs/remotes/origin/HEAD or origin/main), so its commits may change the forge\'s workflow files; run `git fetch origin` (with a git older than 2.48, then `git remote set-head origin --auto`), then push again';
const SLOW = 'git could not say in time';

// runGit within the guards' budget, in `folder`.
function budgeted(args, folder) {
  checkDeadline();
  const budget = Number.isFinite(remainingMs()) ? { timeout: Math.max(1, Math.floor(remainingMs())) } : {};
  return runGit(args, folder, budget);
}

// Why the push from `folder`, inside the session's root `root` ({ root, common }, real and case-folded by `fold`), is
// not from that root's own repository or does not go to `pushUrl`, the URL its issue's start pinned, or null.
function ownCloneProblem(folder, root, pushUrl, fold) {
  const common = budgeted(['rev-parse', '--path-format=absolute', '--git-common-dir'], folder);
  if (common.status !== 0) return `it pushes, and ${SLOW} which repository the folder it pushes from belongs to`;
  const named = common.stdout.trim();
  if (fold(named) !== root.common) return `it pushes from a folder inside its clone or worktree that is another repository, whose git folder is ${named.slice(0, 120)}, such as a nested clone, and whose origin may be any repository`;
  if (typeof pushUrl !== 'string' || pushUrl === '') return 'it pushes, and its issue\'s start recorded no URL its clone pushes to, so where origin pushes cannot be checked; the run\'s driver starts the issue again';
  // Every URL origin pushes to: git pushes to each `remote.origin.pushurl` in turn, so one beside the pinned URL counts.
  const url = budgeted(['remote', 'get-url', '--push', '--all', 'origin'], folder);
  if (url.status !== 0) return `it pushes, and ${SLOW} where origin pushes`;
  const pushes = url.stdout.split('\n').filter((line) => line !== '');
  if (pushes.length === 1 && pushes[0] === pushUrl) return null;
  const elsewhere = pushes.find((each) => each !== pushUrl) ?? pushes.join(', ');
  return `it pushes to ${elsewhere.slice(0, 120) || 'no URL'}${pushes.length > 1 ? `, one of the ${pushes.length} URLs origin pushes to` : ''}, and origin pushes only to ${pushUrl.slice(0, 120)}, the URL its issue's start pinned`;
}

// Why the commits a push from `folder` carries change a host config or instruction file (GUARDED_PATHS) from `overlay`,
// the branch head its attempt started from on the base branch's copies of them (lib/project-start.mjs prepareAttempt),
// or null, as for an attempt with none. A git call that fails refuses the push.
function overlayProblem(folder, overlay) {
  if (!overlay) return null;
  const diff = budgeted(['diff', '--name-only', '--no-renames', '--no-relative', '-z', overlay, 'HEAD', '--'], folder);
  if (diff.status !== 0) return `it pushes, and ${SLOW} which files its commits change from ${overlay.slice(0, 7)}, the head its attempt started from on the base branch's copies of the host config and instruction files`;
  const count = diff.stdout.split('\0').filter((file) => file !== '' && GUARDED_PATHS.test(file)).length;
  if (!count) return null;
  return `it pushes commits that change ${count} host config or instruction ${count === 1 ? 'file' : 'files'}, and this attempt runs on the base branch's copies of them, so it may change none; take those changes out of the commits, or record the result parked when the issue needs them`;
}

// The forge's workflow folders and every folder that holds one, as `:(top,literal)` pathspecs: a holding folder, as
// `.github`, counts only when its own entry changes, as when it becomes a link to a folder of other files.
function workflowPaths() {
  const folders = forgeWorkflowFolders();
  const holders = [...new Set(folders.flatMap((each) => each.split('/').slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).join('/'))))];
  const counts = (file) => holders.includes(file) || folders.some((each) => file === each || file.startsWith(`${each}/`));
  return { pathspecs: [...folders, ...holders].map((each) => `:(top,literal)${each}`), counts };
}

// Why the commits a push from `folder` carries change the forge's workflow files (forges/index.mjs
// forgeWorkflowFolders), or a folder that holds them, or null: the paths HEAD changes from its merge base with origin's
// default branch (BASE_REFS), so a merge of the default branch brings none of that branch's own changes in.
// `--no-relative` keeps a clone's `diff.relative` from hiding, in a push from a subfolder, every path outside it;
// `git status --porcelain` already names paths from the root whatever `status.relativePaths` says.
// SHORTCUT: origin's remote-tracking ref is the session's own copy, which git in its checkout can move; the forge's
// branch and tag rules and its secrets' environments stand behind it (docs/hooks.md#agent-gates names the residual).
function committedProblem(folder, { pathspecs, counts }) {
  for (const base of BASE_REFS) {
    const diff = budgeted(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-relative', `${base}...HEAD`, '--', ...pathspecs], folder);
    if (diff.status === null) return `it pushes, and ${SLOW} which files its commits change, so they may change the forge's workflow files`;
    if (diff.status !== 0) continue;
    const changed = rawPaths(diff.stdout).filter((file) => counts(file));
    return changed.length ? `it pushes commits that change ${changed[0].slice(0, 120)}, a workflow file the forge runs with the repository's secrets on that push, before any review; an issue that needs such a change is parked for the Human, and one the default branch made counts once \`git fetch origin\` brings it` : null;
  }
  return NO_BASE;
}

// Why `folder` holds a staged, unstaged, or untracked change to a workflow file, which a command beside the push or
// run after the guard read it could commit into the push, or null.
function uncommittedProblem(folder, { pathspecs, counts }) {
  const status = budgeted(['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=no', '--', ...pathspecs], folder);
  if (status.status !== 0) return `it pushes, and ${SLOW} whether its checkout holds a change to the forge's workflow files`;
  const found = statusEntries(status.stdout).find(({ paths }) => paths.some((file) => counts(file)));
  if (!found) return null;
  const file = found.paths.find((each) => counts(each));
  const undo = found.untracked ? `git clean -f -- ${shellWord(file)}` : `git restore --staged --worktree -- ${shellWord(file)}`;
  return `it pushes from a checkout that holds an uncommitted change to ${file.slice(0, 120)}, a workflow file the forge runs with the repository's secrets, which a command run beside the push could commit into it; take it out with \`${undo.slice(0, 200)}\`, then push again`;
}

// The paths of `git diff --raw -z` output: each entry is its `:<modes> <ids> <status>` field, then one path, or two for
// a rename or a copy (status R or C), each ended by NUL, so a name git would quote, with a space or a non-ASCII letter,
// comes as it is.
export function rawPaths(text) {
  const fields = text.split('\0');
  const paths = [];
  for (let at = 0; at < fields.length; at += 1) {
    if (!fields[at].startsWith(':')) continue;
    const two = /[RC]\d*$/u.test(fields[at]);
    paths.push(...fields.slice(at + 1, at + (two ? 3 : 2)).filter((each) => each !== ''));
    at += two ? 2 : 1;
  }
  return paths;
}

// The entries of `git status --porcelain -z` output: each `XY <path>`, and for a rename or a copy the path it came from
// as the next NUL-ended field: { paths, untracked }.
export function statusEntries(text) {
  const fields = text.split('\0');
  const entries = [];
  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const paths = [field.slice(3)];
    if (/[RC]/u.test(code)) {
      at += 1;
      if (fields[at]) paths.push(fields[at]);
    }
    entries.push({ paths, untracked: code === '??' });
  }
  return entries;
}

// A path as one shell word, for advice a session runs.
const shellWord = (file) => (/^[\w./@%+=:,-]+$/u.test(file) ? file : `'${file.replaceAll("'", "'\\''")}'`);

// Why the exact push from `folder` may not run, or null (see the header). `root` is the session's root that holds it
// ({ root, common }), `pushUrl` the URL its issue's start pinned, `overlay` the head that start recorded its base copies
// over, or null, and `fold(path)` gives a path as `root` holds them.
export function pushCheckoutProblem(folder, { root, pushUrl, fold, overlay = null }) {
  const paths = workflowPaths();
  return ownCloneProblem(folder, root, pushUrl, fold) ?? overlayProblem(folder, overlay) ?? committedProblem(folder, paths) ?? uncommittedProblem(folder, paths);
}
