// What a pull request changes, read from git: the files with their line counts, the lines it adds, and the files it
// removes lines from. Every read is pinned to commits, two or one merge, never to the working tree. Every path is
// relative to `root`, the project root, which may sit below the repository root: `--relative` and `<commit>:./<file>`
// ask git for that, so a file outside `root` is not listed, and at the repository root they change nothing.

import { runGit, showPrefix } from '../git.mjs';

const TIMEOUT = { timeout: 30_000, maxBuffer: 256 * 1024 * 1024 };

function git(root, args) {
  const result = runGit(args, root, TIMEOUT);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim() || 'no output'}`);
  return result.stdout;
}

// The merge base of `base` and `head`: the review covers what the pull request adds, not what the base gained since.
export const mergeBase = (root, base, head) => git(root, ['merge-base', base, head]).trim();

// [{ file, added, removed, status }] between two commits. A binary file counts 0 lines; a rename is its new path.
export function changedFiles(root, from, to) {
  const numstat = git(root, ['diff', '--relative', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', from, to]);
  const names = git(root, ['diff', '--relative', '--name-status', '-z', '--no-renames', '--no-ext-diff', from, to]);
  return fileList(numstat, names);
}

// The file list of one `--numstat -z` and one `--name-status -z` output of the same diff.
function fileList(numstat, names) {
  const status = new Map();
  const words = names.split('\0');
  for (let i = 0; i + 1 < words.length; i += 2) status.set(words[i + 1], words[i]);
  const out = [];
  for (const record of numstat.split('\0').filter(Boolean)) {
    const [added, removed, file] = record.split('\t');
    // With renames off every record names its path: one that does not is output this parser cannot read.
    if (!file) throw new Error(`git printed a numstat record with no path: ${JSON.stringify(record)}`);
    out.push({ file, added: added === '-' ? 0 : Number(added), removed: removed === '-' ? 0 : Number(removed), status: status.get(file) ?? 'M' });
  }
  return out;
}

// The added lines per file, and the files that lost lines, from one unified diff with no context.
export function diffLines(root, from, to, files = null) {
  // Unquoted paths (core.quotePath=false), so a header names `src/café.ts` as the file list does; no external diff or
  // text conversion, so the lines are the file's own.
  return parseUnified(git(root, ['-c', 'core.quotePath=false', 'diff', '--relative', '--unified=0', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv', from, to, ...(files ? ['--', ...files] : [])]));
}

function parseUnified(text) {
  const addedLines = {};
  const removedFiles = new Set();
  let file = null;
  let old = null;
  let header = false;
  // `--- ` and `+++ ` are headers only between `diff --git` and the first hunk: a removed `-- comment` line reads `--- comment`.
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true;
      file = null;
    } else if (header && line.startsWith('--- ')) old = line === '--- /dev/null' ? null : line.slice('--- a/'.length);
    // A deleted file has no new path: its removed lines count against the old one.
    else if (header && line.startsWith('+++ ')) file = line === '+++ /dev/null' ? old : line.slice('+++ b/'.length);
    else if (line.startsWith('@@')) header = false;
    else if (header) continue;
    else if (line.startsWith('+') && file) (addedLines[file] ??= []).push(line.slice(1));
    else if (line.startsWith('-') && file) removedFiles.add(file);
  }
  return { addedLines, removedFiles };
}

// The parents of `commit`, first parent first: one for an ordinary commit, two or more for a merge.
export const parents = (root, commit) => git(root, ['rev-list', '--parents', '-n', '1', commit]).trim().split(/\s+/u).slice(1);

export const isMergeCommit = (root, commit) => parents(root, commit).length >= 2;

// git's own merge of commits `a` and `b` (`git merge-tree --write-tree`): { clean, tree, conflicts }, `conflicts` the
// paths it could not merge, from the repository root. Exit 1 is a merge with conflicts, which `clean` false says even
// when no file is listed, as for a directory rename split; any other failure throws.
function autoMerge(root, a, b) {
  const result = runGit(['merge-tree', '--write-tree', '-z', '--name-only', a, b], root, TIMEOUT);
  if (result.status !== 0 && result.status !== 1) throw new Error(`git merge-tree failed: ${(result.stderr || '').trim() || 'no output'}`);
  const parts = result.stdout.split('\0');
  const end = parts.indexOf('', 1);
  return { clean: result.status === 0, tree: parts[0], conflicts: [...new Set(parts.slice(1, end === -1 ? parts.length : end))] };
}

// The paths of a unified diff's `diff --git a/<path> b/<path>` headers. With no renames both sides name one path, so
// the header splits in half whatever spaces the path holds; a quoted path is left to the other lists.
function headerPaths(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('diff --git a/')) continue;
    const rest = line.slice('diff --git a/'.length);
    const file = rest.slice(0, (rest.length - ' b/'.length) / 2);
    if (rest === `${file} b/${file}`) out.push(file);
  }
  return out;
}

// What a two-parent merge commit itself changes: its conflict resolutions and any other edit made in the merge, as
// { changes, addedLines, removedFiles }, the shapes of changedFiles and diffLines. The lines are
// `git show --remerge-diff`'s, which compares the commit with git's own merge of its parents, conflict markers
// included, so a resolved conflict counts its markers as removed lines. A conflict whose resolution shows no lines,
// such as a binary file or a modify/delete kept as one side, is still a change of the merge: every path git's merge
// conflicts on joins `changes`, with no lines. Null for a commit with any other number of parents: an ordinary commit,
// for which git would print the ordinary diff, or an octopus merge, which has no remerge diff. Needs git 2.38 or later
// (`git merge-tree --write-tree`): an older git throws.
export function remergeDiff(root, commit, auto = null) {
  const list = parents(root, commit);
  if (list.length !== 2) return null;
  const show = ['show', '--remerge-diff', '--format=', '--relative', '--no-renames', '--no-ext-diff'];
  const numstat = git(root, [...show, '--numstat', '-z', '--no-textconv', commit]);
  const names = git(root, [...show, '--name-status', '-z', commit]);
  const text = git(root, ['-c', 'core.quotePath=false', ...show, '--unified=0', '--no-color', '--no-textconv', commit]);
  const changes = fileList(numstat, names);
  // git's conflict list names paths from the repository root; `--relative` names them from `root`.
  const prefix = showPrefix(root);
  const conflicts = (auto ?? autoMerge(root, list[0], list[1])).conflicts.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
  for (const file of new Set([...headerPaths(text), ...conflicts])) {
    if (!changes.some((change) => change.file === file)) changes.push({ file, added: 0, removed: 0, status: fileAt(root, commit, file) === null ? 'D' : 'M' });
  }
  return { changes, ...parseUnified(text) };
}

// Whether `head` is a merge from the base branch onto `priorHead`, the head a review last finished on: a two-parent
// merge commit whose first parent is `priorHead` and whose other parent is an ancestor of `base`, the base branch
// tip. Null when it is not. { clean: true } when git's own merge of the two parents exits clean, with no conflict,
// and gives the merge's tree exactly; else { clean: false, scope }, with `scope` its remergeDiff. A merge of a side branch can be
// as clean: the ancestor check is what tells a base merge apart.
export function baseMergeOf(root, head, { priorHead, base }) {
  const list = parents(root, head);
  if (list.length !== 2) return null;
  const first = resolve(root, priorHead);
  if (!first || list[0] !== first || !isAncestor(root, list[1], base)) return null;
  const auto = autoMerge(root, list[0], list[1]);
  if (auto.clean && !auto.conflicts.length && auto.tree === git(root, ['rev-parse', `${head}^{tree}`]).trim()) return { clean: true };
  return { clean: false, scope: remergeDiff(root, head, auto) };
}

// Whether `head` is a merge from the base branch onto `priorHead` that changed nothing git's own merge would not
// (baseMergeOf).
export const cleanBaseMerge = (root, head, opts) => baseMergeOf(root, head, opts)?.clean === true;

// The text of `file` at `commit`, or null when it is not there.
export function fileAt(root, commit, file) {
  const result = runGit(['show', `${commit}:./${file}`], root, TIMEOUT);
  return result.status === 0 ? result.stdout : null;
}

// Whether commit `a` is an ancestor of commit `b` (or the same commit).
export const isAncestor = (root, a, b) => runGit(['merge-base', '--is-ancestor', a, b], root, TIMEOUT).status === 0;

// The commit `ref` names, or null.
export function resolve(root, ref) {
  const result = runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root, TIMEOUT);
  return result.status === 0 ? result.stdout.trim() : null;
}

// Whether the working tree has changes git would show: a local review reads the committed head, never a draft.
export const isClean = (root) => git(root, ['status', '--porcelain', '--untracked-files=no']).trim() === '';
