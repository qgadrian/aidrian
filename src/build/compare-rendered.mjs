import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { assertSafePath, readRegularFile } from './safe-files.mjs';
import { parseStrictOptions } from './strict-args.mjs';

const collect = async (root) => {
  await assertSafePath(root, root, { kind: 'directory', label: 'comparison root' });
  const files = new Map();
  const visit = async (dir, rel = '') => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = path.posix.join(rel, entry.name);
      const child = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`unsupported comparison entry ${childRel}`);
      if (entry.isDirectory()) await visit(child, childRel);
      else if (entry.isFile()) {
        const stat = await lstat(child);
        files.set(childRel, { bytes: await readRegularFile(root, child, { label: `comparison entry ${childRel}` }), mode: stat.mode & 0o777 });
      } else throw new Error(`unsupported comparison entry ${childRel}`);
    }
  };
  await visit(root);
  return files;
};

export const compareRenderedTree = async (actualRoot, expectedRoot) => {
  const actual = await collect(actualRoot);
  const expected = await collect(expectedRoot);
  const names = [...new Set([...actual.keys(), ...expected.keys()])].sort();
  const differences = [];
  for (const name of names) {
    const a = actual.get(name);
    const e = expected.get(name);
    if (!a) differences.push(`${name}: missing actual`);
    else if (!e) differences.push(`${name}: unexpected actual`);
    else if (a.mode !== e.mode) differences.push(`${name}: mode ${a.mode.toString(8)} != ${e.mode.toString(8)}`);
    else if (!a.bytes.equals(e.bytes)) differences.push(`${name}: bytes differ`);
  }
  if (differences.length) throw new Error(`rendered tree mismatch\n${differences.join('\n')}`);
  return { files: names.length };
};

const parseArgs = (args) => parseStrictOptions(args, {
  '--actual': { name: 'actual', required: true },
  '--expected': { name: 'expected', required: true },
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { actual, expected } = parseArgs(process.argv.slice(2));
  const result = await compareRenderedTree(actual, expected);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
