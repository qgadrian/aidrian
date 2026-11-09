// The private words of a checkout: the git-ignored `.banned-terms.local`, one case-insensitive regular expression per
// line, `#` for a comment, so no tracked file names them. This repository's git hooks read it (scripts/banned-terms.mjs),
// and so does the public text rule (lib/rules/github/public-text.mjs).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { mainRoot } from './git.mjs';

export const BANNED_FILE = '.banned-terms.local';

// The file's lines that hold a pattern, read from `root` and from the main checkout: the file is git-ignored, so a linked
// worktree has no copy of its own, and a copy in both places counts both.
export function bannedLines(root) {
  const roots = new Set([root, mainRoot(root)].filter(Boolean));
  const local = [...roots].map((dir) => path.join(dir, BANNED_FILE)).filter((file) => existsSync(file))
    .flatMap((file) => readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
  return [...new Set(local)];
}

// The patterns of the lines that compile, for a hook: a bad line drops only itself, and a file that cannot be read gives none.
export function usableBannedPatterns(root) {
  try {
    return bannedLines(root).flatMap((line) => {
      try {
        return [new RegExp(line, 'iu')];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
