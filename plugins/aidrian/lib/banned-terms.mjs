// The private words of a checkout: the git-ignored `.banned-terms.local`, one case-insensitive regular expression per
// line, `#` for a comment, so no tracked file names them. This repository's git hooks read it (scripts/banned-terms.mjs),
// and so does the public text rule (lib/rules/github/public-text.mjs). `aidrian check` reports what is wrong with it, and
// never prints what it holds.

import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isIgnored, mainRoot } from './git.mjs';

export const BANNED_FILE = '.banned-terms.local';

// The most a private words file may hold.
const MAX_BYTES = 64 * 1024;

// The copies that exist, in `root` and in the main checkout: the file is git-ignored, so a linked worktree has no copy of
// its own, and a copy in both places counts both. existsSync and statSync follow a link, so a link to a file works.
const copies = (root) => [...new Set([root, mainRoot(root)].filter(Boolean))].map((dir) => path.join(dir, BANNED_FILE)).filter((file) => existsSync(file));

// The file's lines that hold a pattern, as { line, source }. Throws on anything but a regular file of modest size: reading
// a pipe or a device could stop the caller for good. One descriptor, opened without blocking, is both checked and read, so
// the file cannot change between the two.
function entries(file) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let text;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`${file} is not a regular file of at most ${MAX_BYTES / 1024} KiB`);
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  return text.split('\n').flatMap((raw, index) => {
    const source = raw.trim();
    return source && !source.startsWith('#') ? [{ line: index + 1, source }] : [];
  });
}

const compiles = (source) => {
  try {
    new RegExp(source, 'iu');
    return true;
  } catch {
    return false;
  }
};

// The pattern lines of every copy. Throws when a copy cannot be read, which stops a git hook rather than let a word out.
export function bannedLines(root) {
  return [...new Set(copies(root).flatMap((file) => entries(file).map(({ source }) => source)))];
}

// The pattern lines that compile, for a hook: a bad line drops only itself, and a copy that cannot be read only itself.
export function usableBannedLines(root) {
  const sources = copies(root).flatMap((file) => {
    try {
      return entries(file).map(({ source }) => source);
    } catch {
      return [];
    }
  });
  return [...new Set(sources)].filter(compiles);
}

// What `aidrian check` says about the copies: a copy git does not ignore, one that cannot be read, and the numbers of the
// lines that do not compile. Never a line's text.
export function bannedFileProblems(root) {
  return copies(root).flatMap((file) => {
    const problems = [];
    if (isIgnored(path.dirname(file), file) === false) {
      problems.push(`${file} is tracked or not git-ignored, so its words could be published: add the line "${BANNED_FILE}" to .gitignore, and untrack it if it is tracked`);
    }
    try {
      const bad = entries(file).filter(({ source }) => !compiles(source)).map(({ line }) => line);
      if (bad.length) problems.push(`${file}: ${bad.length > 1 ? 'lines' : 'line'} ${bad.join(', ')} ${bad.length > 1 ? 'do' : 'does'} not compile, so the rules skip ${bad.length > 1 ? 'them' : 'it'}`);
    } catch (error) {
      problems.push(`${error.message}, so the rules skip it`);
    }
    return problems;
  });
}
