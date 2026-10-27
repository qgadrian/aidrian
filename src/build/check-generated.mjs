import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { buildCatalog } from './build.mjs';
import { readJsonFile } from './safe-files.mjs';
import { parseStrictOptions } from './strict-args.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

const snapshot = (files) => [...files]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, file]) => ({
    name,
    mode: file.mode,
    sha256: createHash('sha256').update(file.bytes).digest('hex'),
  }));

export const checkGenerated = async ({ root = ROOT, manifestPath = path.join(root, 'test/build/generated-manifest.json'), candidateInventory = null } = {}) => {
  const first = await buildCatalog(root, {}, { candidateInventory });
  const second = await buildCatalog(root, {}, { candidateInventory });
  assert.deepEqual(snapshot(first), snapshot(second), 'catalog render is not deterministic');

  const expected = await readJsonFile(path.dirname(manifestPath), manifestPath, { label: 'generated manifest' });
  const actual = snapshot(first);
  const expectedByName = new Map(expected.files.map((file) => [file.name, file]));
  const actualByName = new Map(actual.map((file) => [file.name, file]));
  const names = [...new Set([...expectedByName.keys(), ...actualByName.keys()])].sort();
  const differences = [];
  for (const name of names) {
    const a = actualByName.get(name);
    const e = expectedByName.get(name);
    if (!a) differences.push(`${name}: missing actual`);
    else if (!e) differences.push(`${name}: unexpected actual`);
    else if (a.mode !== e.mode) differences.push(`${name}: mode ${a.mode.toString(8)} != ${e.mode.toString(8)}`);
    else if (a.sha256 !== e.sha256) differences.push(`${name}: bytes differ`);
  }
  if (differences.length) throw new Error(`generated output is stale\n${differences.join('\n')}`);
  return { checked: true, deterministic: true, files: actual.length };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseStrictOptions(process.argv.slice(2), {
    '--expected-manifest': { name: 'manifestPath', default: path.join(ROOT, 'test/build/generated-manifest.json') },
    '--candidate-inventory': { name: 'candidateInventory', default: null },
  });
  const result = await checkGenerated(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
