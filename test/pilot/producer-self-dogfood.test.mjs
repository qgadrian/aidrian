import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCatalog,
  loadProjectOverlays,
  loadSkillOverlays,
} from '../../src/build/build.mjs';
import { buildPilot } from '../../src/build/build-pilot.mjs';

import { ROOT } from './helpers.mjs';

const GENERATED_ROOTS = Object.freeze([
  '.claude/agents',
  '.codex/agents',
  '.agents/skills',
]);
const RENDERED_HANDOFF_CONTRACT = '- Return the mandatory machine handoff fields `status`, `role`, `decision`, `evidence`, `deferred_refs`, `blockers`, and `next_owner`; a blocked result names the failing provider or invariant.';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const outputPath = (relative) => {
  if (relative.startsWith('claude/agents/')) return `.claude/agents/${relative.slice('claude/agents/'.length)}`;
  if (relative.startsWith('codex/agents/')) return `.codex/agents/${relative.slice('codex/agents/'.length)}`;
  if (relative.startsWith('shared/skills/')) return `.agents/skills/${relative.slice('shared/skills/'.length)}`;
  if (relative === 'codex/config.toml') return '.codex/config.toml';
  return null;
};

const snapshot = (files) => [...files]
  .map(([relative, file]) => ({ relative, mode: file.mode, sha256: sha256(file.bytes) }))
  .sort((left, right) => left.relative.localeCompare(right.relative));

const expectedProjection = (catalog) => new Map([...catalog]
  .map(([relative, file]) => [outputPath(relative), file])
  .filter(([relative]) => relative !== null));

const listFiles = async (root, prefix = '') => {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(root, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`${relative}: generated projection contains a non-regular entry`);
  }
  return files;
};

const checkedProjection = async () => {
  const entries = [];
  for (const generatedRoot of GENERATED_ROOTS) {
    for (const relative of await listFiles(path.join(ROOT, generatedRoot))) {
      const checkedPath = `${generatedRoot}/${relative}`;
      entries.push([checkedPath, { bytes: await readFile(path.join(ROOT, checkedPath)), mode: 0o644 }]);
    }
  }
  entries.push(['.codex/config.toml', {
    bytes: await readFile(path.join(ROOT, '.codex/config.toml')),
    mode: 0o644,
  }]);
  return new Map(entries);
};

const compareProjection = (expected, actual) => {
  const differences = [];
  const names = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  for (const name of names) {
    const expectedFile = expected.get(name);
    const actualFile = actual.get(name);
    if (!expectedFile) differences.push(`${name}: extra`);
    else if (!actualFile) differences.push(`${name}: missing`);
    else if (expectedFile.mode !== actualFile.mode || !expectedFile.bytes.equals(actualFile.bytes)) {
      differences.push(`${name}: stale`);
    }
  }
  return differences;
};

const assertRenderedHandoffContract = (rendered) => {
  assert.match(rendered, /Machine handoff final output \(mandatory\):/);
  assert.equal(
    rendered.includes(RENDERED_HANDOFF_CONTRACT),
    true,
    'rendered producer role must retain the mandatory handoff fields',
  );
};

const assertArtifactReadmeReferences = ({ readme, artifactPaths }) => {
  assert.match(
    readme,
    /Provider-attended activation and role invocation remain unverified/,
    'artifact README must retain the unverified provider-attended claim',
  );
  const assertIncluded = (rawReference, label) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(rawReference)) return;
    const withoutFragment = rawReference.split('#', 1)[0];
    const normalized = path.posix.normalize(withoutFragment.replace(/^\.\//, ''));
    assert.equal(
      normalized.startsWith('../'),
      false,
      `${label} escapes the artifact: ${rawReference}`,
    );
    assert.equal(
      artifactPaths.has(normalized),
      true,
      `${label} is absent from the artifact: ${rawReference}`,
    );
  };
  for (const match of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    assertIncluded(match[1], 'README local link');
  }
  for (const block of readme.matchAll(/```(?:sh|bash|shell)\n([\s\S]*?)```/g)) {
    if (/^\s*npm(?:\s|$)/m.test(block[1])) {
      assertIncluded('package.json', 'README npm command dependency');
    }
    for (const match of block[1].matchAll(
      /(?:^|[\s'"=])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)/gm,
    )) {
      assertIncluded(match[1], 'README shell path');
    }
  }
};

const renderProducer = async () => {
  const projectOverlays = await loadProjectOverlays(path.join(ROOT, '.agent-harness/overlays/agents'));
  const skillOverlays = await loadSkillOverlays(path.join(ROOT, '.agent-harness/overlays/skills'));
  return buildCatalog(ROOT, projectOverlays, { skillOverlays });
};

test('37-file compiler output has an exact 35-file producer fixed point', async () => {
  const first = await renderProducer();
  const second = await renderProducer();
  assert.deepEqual(snapshot(first), snapshot(second));
  assert.equal(first.size, 37);
  assert.deepEqual(
    [...first.keys()].filter((relative) => outputPath(relative) === null).sort(),
    ['capability-report.json', 'source-report.json'],
  );
  const expected = expectedProjection(first);
  const checked = await checkedProjection();
  assert.equal(expected.size, 35);
  assert.deepEqual(compareProjection(expected, checked), []);
});

test('producer currentness rejects missing, extra, and stale files', async () => {
  const expected = expectedProjection(await renderProducer());
  const [firstPath, firstFile] = expected.entries().next().value;
  const missing = new Map(expected);
  missing.delete(firstPath);
  assert.deepEqual(compareProjection(expected, missing), [`${firstPath}: missing`]);
  const extra = new Map(expected).set('.claude/agents/extra.md', { bytes: Buffer.from('extra\n'), mode: 0o644 });
  assert.deepEqual(compareProjection(expected, extra), ['.claude/agents/extra.md: extra']);
  const stale = new Map(expected).set(firstPath, { ...firstFile, bytes: Buffer.from('stale\n') });
  assert.deepEqual(compareProjection(expected, stale), [`${firstPath}: stale`]);
});

test('both host projections select the producer explorer and expose visible handoff failure', async () => {
  const projection = expectedProjection(await renderProducer());
  const claude = projection.get('.claude/agents/explorer.md').bytes.toString('utf8');
  const codex = projection.get('.codex/agents/explorer.toml').bytes.toString('utf8');
  const registry = projection.get('.codex/config.toml').bytes.toString('utf8');
  for (const rendered of [claude, codex]) {
    assert.match(rendered, /README\.md, docs\/providers\.md, and docs\/self-dogfood\.md/);
    assert.match(rendered, /provider-attended rows remain unverified/);
    assertRenderedHandoffContract(rendered);
  }
  assert.match(claude, /^name: explorer$/m);
  assert.match(registry, /^\[agents\.explorer\]$/m);
  assert.match(registry, /^config_file = "agents\/explorer\.toml"$/m);
  assert.throws(
    () => assertRenderedHandoffContract(
      claude.replace(RENDERED_HANDOFF_CONTRACT, 'handoff fields omitted'),
    ),
    /rendered producer role must retain the mandatory handoff fields/,
  );
});

test('producer overlays and generated paths are outside the private artifact manifest', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'provenance/distribution-files.json'), 'utf8'));
  const sources = manifest.files.map(({ source }) => source);
  const forbiddenPrefixes = [
    '.agent-harness/overlays/',
    '.agents/skills/',
    '.claude/agents/',
    '.codex/agents/',
  ];
  assert.equal(sources.includes('.codex/config.toml'), false);
  for (const source of sources) {
    assert.equal(forbiddenPrefixes.some((prefix) => source.startsWith(prefix)), false, source);
  }
});

test('producer overlays and generated outputs cannot change the private artifact digest', async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'aidrian-artifact-exclusion-'));
  t.after(() => rm(scratch, { force: true, recursive: true }));
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'provenance/distribution-files.json'), 'utf8'));
  for (const relative of [
    'package-lock.json',
    'provenance/distribution-files.json',
    ...manifest.files.map(({ source }) => source),
  ]) {
    const source = path.join(ROOT, relative);
    const target = path.join(scratch, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, manifest.files.find(({ source: candidate }) => candidate === relative)?.mode === '0755' ? 0o755 : 0o644);
  }
  const first = await buildPilot({
    rootDir: scratch,
    outputDir: path.join(scratch, 'first'),
  });
  const assemblyRoot = path.join(scratch, 'first', first.assembly.directory);
  const artifactPaths = new Set(await listFiles(assemblyRoot));
  const readme = await readFile(path.join(assemblyRoot, 'README.md'), 'utf8');
  assertArtifactReadmeReferences({ readme, artifactPaths });
  assert.throws(
    () => assertArtifactReadmeReferences({
      readme: readme.replace(
        'Provider-attended activation and role invocation remain unverified',
        'Provider-attended activation and role invocation pass',
      ),
      artifactPaths,
    }),
    /artifact README must retain the unverified provider-attended claim/,
  );
  assert.throws(
    () => assertArtifactReadmeReferences({
      readme: `${readme}\n[Missing provider guide](docs/providers.md)\n`,
      artifactPaths,
    }),
    /README local link is absent from the artifact/,
  );
  assert.throws(
    () => assertArtifactReadmeReferences({
      readme: [
        readme,
        '```sh',
        'node --test test/pilot/provider-claims.test.mjs',
        '```',
        '',
      ].join('\n'),
      artifactPaths,
    }),
    /README shell path is absent from the artifact/,
  );
  await mkdir(path.join(scratch, '.agent-harness/overlays'), { recursive: true });
  await mkdir(path.join(scratch, '.claude/agents'), { recursive: true });
  await writeFile(path.join(scratch, '.agent-harness/overlays/ignored.json'), '{"ignored":true}\n');
  await writeFile(path.join(scratch, '.claude/agents/ignored.md'), 'ignored generated bytes\n');
  const second = await buildPilot({
    rootDir: scratch,
    outputDir: path.join(scratch, 'second'),
  });
  assert.equal(first.archive.sha256, second.archive.sha256);
  assert.equal(first.reproducibility.treeSha256, second.reproducibility.treeSha256);
});
