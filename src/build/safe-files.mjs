import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { inspectPathSet } from '../distribution-safety/path-policy.mjs';

const contained = (relative) => relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);

export const hasPortablePathCollision = (paths) => inspectPathSet(paths).issues.some(
  ({ ruleId }) => ruleId === 'PATH_DUPLICATE' || ruleId === 'PATH_CASE_COLLISION',
);

export const assertSafePath = async (root, target, { kind = 'file', label = target } = {}) => {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(target);
  const relative = path.relative(lexicalRoot, lexicalTarget);
  if (!contained(relative)) throw new Error(`${label}: path escapes its authorized root`);

  const lexicalRootStat = await lstat(lexicalRoot);
  if (lexicalRootStat.isSymbolicLink()) throw new Error(`${label}: authorized root may not be a symbolic link`);
  if (!lexicalRootStat.isDirectory()) throw new Error(`${label}: authorized root must be a directory`);
  const canonicalRoot = await realpath(lexicalRoot);
  let current = canonicalRoot;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`${label}: symbolic links are not allowed`);
    const expected = index === segments.length - 1 ? kind : 'directory';
    if (expected === 'file' && !stat.isFile()) throw new Error(`${label}: expected a regular file`);
    if (expected === 'directory' && !stat.isDirectory()) throw new Error(`${label}: expected a directory`);
  }

  const canonicalTarget = await realpath(lexicalTarget);
  if (!contained(path.relative(canonicalRoot, canonicalTarget))) throw new Error(`${label}: canonical path escapes its authorized root`);
  if (segments.length === 0 && kind !== 'directory') throw new Error(`${label}: expected a regular file`);
  return canonicalTarget;
};

export const readRegularFile = async (root, target, options = {}) => {
  const safe = await assertSafePath(root, target, { ...options, kind: 'file' });
  return readFile(safe, options.encoding);
};

export const readJsonFile = async (root, target, options = {}) => {
  const text = await readRegularFile(root, target, { ...options, encoding: 'utf8' });
  return JSON.parse(text);
};
