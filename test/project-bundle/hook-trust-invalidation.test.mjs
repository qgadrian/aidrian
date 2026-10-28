import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import {
  assemblePrivateDistribution,
  assertSemanticExecutableClosure,
} from '../../src/project-bundle/assemble.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE_COMMIT = 'f714cfac938af8a70dbe7bf540f965ab7d728b05';

test('production provider manifests, capabilities, provenance, and package stay semantically executable-empty', async () => {
  const assembled = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  assert.equal('hooks' in assembled.manifests.claude, false);
  assert.equal(assembled.manifests.codex.extensions?.['com.openai']?.hooks, undefined);
  assert.equal([...assembled.pluginFiles.keys()].some((relative) => relative.startsWith('hooks/')), false);
  assert.deepEqual(assembled.semanticInventory, []);
});

test('every semantic executable origin fails closed with its origin before output', async () => {
  const base = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  const capability = { schemaVersion: 1, executables: [] };
  const provenance = { files: [] };
  const cases = [
    { origin: 'claude-fixture', path: 'hooks/canary.mjs', command: 'node hooks/canary.mjs', expected: 'interpreter-script-target' },
    { origin: 'shell-fixture', path: 'hooks/canary.sh', command: 'sh -c ./hooks/canary.sh', expected: 'shell-command' },
    { origin: 'eval-fixture', path: '<inline>', command: 'node -e process.exit(0)', expected: 'inline-eval' },
    { origin: 'path-fixture', path: '<inline>', command: 'canary', expected: 'path-only-resolution' },
  ];
  for (const candidate of cases) {
    assert.throws(
      () => assertSemanticExecutableClosure({
        files: base.pluginFiles,
        providerManifests: base.manifests,
        provenance,
        capabilities: capability,
        bindings: [candidate],
      }),
      new RegExp(`${candidate.origin}.*${candidate.expected}`, 's'),
    );
  }
  const executable = new Map([['skills/example/SKILL.md', { bytes: Buffer.from('text\n'), mode: 0o755 }]]);
  assert.throws(
    () => assertSemanticExecutableClosure({ files: executable, providerManifests: {}, provenance, capabilities: capability }),
    /packaged-file-mode:skills\/example\/SKILL\.md:executable-mode/,
  );
  const shebang = new Map([['skills/example/SKILL.md', { bytes: Buffer.from('#!\/bin\/sh\n'), mode: 0o644 }]]);
  assert.throws(
    () => assertSemanticExecutableClosure({ files: shebang, providerManifests: {}, provenance, capabilities: capability }),
    /packaged-file-bytes:skills\/example\/SKILL\.md:shebang/,
  );
  assert.throws(
    () => assertSemanticExecutableClosure({
      files: new Map(),
      providerManifests: {},
      provenance: { files: [{ target: 'x', mode: '0755', capabilities: ['execute'] }] },
      capabilities: capability,
    }),
    /provenance-capability:x:execute/,
  );
});

test('fixture definition mutation is denied by controlled preflight before provider launch', () => {
  const pinned = Buffer.from('{"hooks":{"SessionStart":[]}}\n');
  const expected = createHash('sha256').update(pinned).digest('hex');
  let launches = 0;
  const controlledLaunch = (definition) => {
    if (createHash('sha256').update(definition).digest('hex') !== expected) {
      throw new Error('fixture hook definition changed before Claude launch');
    }
    launches += 1;
  };
  controlledLaunch(pinned);
  assert.throws(
    () => controlledLaunch(Buffer.from('{"hooks":{"SessionStart":[{"hooks":[]}]}}\n')),
    /fixture hook definition changed before Claude launch/,
  );
  assert.equal(launches, 1);
});
