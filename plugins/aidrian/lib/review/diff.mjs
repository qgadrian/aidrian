// What a pull request changes, read from git: the files with their line counts, the lines it adds, and the files it
// removes lines from. Every read is pinned to two commits, never to the working tree.

import { runGit } from '../git.mjs';

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
  const numstat = git(root, ['diff', '--numstat', '-z', '--no-renames', from, to]);
  const status = new Map();
  const names = git(root, ['diff', '--name-status', '-z', '--no-renames', from, to]).split('\0');
  for (let i = 0; i + 1 < names.length; i += 2) status.set(names[i + 1], names[i]);
  const out = [];
  for (const record of numstat.split('\0').filter(Boolean)) {
    const [added, removed, file] = record.split('\t');
    out.push({ file, added: added === '-' ? 0 : Number(added), removed: removed === '-' ? 0 : Number(removed), status: status.get(file) ?? 'M' });
  }
  return out;
}

// The added lines per file, and the files that lost lines, from one unified diff with no context.
export function diffLines(root, from, to, files = null) {
  const text = git(root, ['diff', '--unified=0', '--no-color', '--no-renames', from, to, ...(files ? ['--', ...files] : [])]);
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

// The text of `file` at `commit`, or null when it is not there.
export function fileAt(root, commit, file) {
  const result = runGit(['show', `${commit}:${file}`], root, TIMEOUT);
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
