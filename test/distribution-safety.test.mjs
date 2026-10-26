import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import { buildPilot } from '../src/build/build-pilot.mjs';
import { checkArtifact } from '../src/distribution-safety/artifact.mjs';
import {
  DistributionSafetyError,
  formatDiagnostics,
} from '../src/distribution-safety/diagnostics.mjs';
import {
  loadPolicy,
  scanContent,
} from '../src/distribution-safety/content-policy.mjs';
import {
  loadAndValidateProvenance,
} from '../src/distribution-safety/provenance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, 'fixtures', 'distribution-safety');
const repositoryRoot = path.resolve(here, '..');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function issueIds(error) {
  assert.ok(error instanceof DistributionSafetyError);
  return error.issues.map(({ ruleId }) => ruleId);
}

async function expectRule(action, ruleId) {
  await assert.rejects(action, (error) => {
    assert.ok(issueIds(error).includes(ruleId), formatDiagnostics(error.issues));
    return true;
  });
}

async function withFixture(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'distribution-safety-'));
  await cp(path.join(fixtureRoot, 'positive'), root, { recursive: true });
  try {
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function readManifest(root) {
  return JSON.parse(await readFile(path.join(root, 'provenance.json'), 'utf8'));
}

async function writeManifest(root, manifest) {
  await writeFile(
    path.join(root, 'provenance.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function writeField(buffer, offset, length, value) {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
}

function tarBuffer(entries) {
  const chunks = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content ?? '');
    const header = Buffer.alloc(512);
    writeField(header, 0, 100, entry.path);
    writeField(header, 100, 8, octal(entry.mode ?? 0o644, 8));
    writeField(header, 108, 8, octal(0, 8));
    writeField(header, 116, 8, octal(0, 8));
    writeField(header, 124, 12, octal(content.length, 12));
    writeField(header, 136, 12, octal(0, 12));
    header.fill(0x20, 148, 156);
    writeField(header, 156, 1, entry.type ?? '0');
    writeField(header, 157, 100, entry.linkpath ?? '');
    writeField(header, 257, 6, 'ustar\0');
    writeField(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeField(
      header,
      148,
      8,
      checksum.toString(8).padStart(6, '0') + '\0 ',
    );
    chunks.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

async function writeTar(root, name, entries, { gzip = false } = {}) {
  const archivePath = path.join(root, name);
  const data = tarBuffer(entries);
  await writeFile(archivePath, gzip ? gzipSync(data, { mtime: 0 }) : data);
  return archivePath;
}

test('positive provenance permits a private pilot while public promotion remains blocked', async () => {
  await withFixture(async (root) => {
    const result = await loadAndValidateProvenance({
      rootDir: root,
      manifestPath: path.join(root, 'provenance.json'),
    });
    assert.deepEqual(result.manifest.files.map(({ target }) => target), ['guide.md']);
    assert.equal(result.publicPromotionEligible, false);

    await expectRule(
      () =>
        loadAndValidateProvenance({
          rootDir: root,
          manifestPath: path.join(root, 'provenance.json'),
          publicPromotion: true,
        }),
      'PROVENANCE_PUBLIC_ELIGIBILITY',
    );
  });
});

test('public promotion stays blocked even when every row is eligible', async () => {
  await withFixture(async (root) => {
    const manifest = await readManifest(root);
    manifest.files[0].publicEligibility = {
      status: 'eligible',
      basis: 'synthetic-review',
    };
    for (const review of manifest.dependencyReviews) {
      review.publicEligibility = 'eligible';
    }
    await writeManifest(root, manifest);

    await expectRule(
      () =>
        loadAndValidateProvenance({
          rootDir: root,
          manifestPath: path.join(root, 'provenance.json'),
          publicPromotion: true,
        }),
      'PROVENANCE_PUBLIC_PROMOTION_BLOCKED',
    );

    const archivePath = await writeTar(
      root,
      'eligible-but-blocked.tgz',
      [{ path: 'guide.md', content: 'Neutral private pilot guide.\n' }],
      { gzip: true },
    );
    await expectRule(
      () =>
        checkArtifact({
          artifactPath: archivePath,
          manifestPath: path.join(root, 'provenance.json'),
          rootDir: root,
          publicPromotion: true,
        }),
      'PROVENANCE_PUBLIC_PROMOTION_BLOCKED',
    );

    const publicCommands = [
      [
        'check-provenance.mjs',
        ['--manifest', path.join(root, 'provenance.json'), '--public'],
      ],
      [
        'check-artifact.mjs',
        [
          '--manifest',
          path.join(root, 'provenance.json'),
          '--artifact',
          archivePath,
          '--public',
        ],
      ],
    ];
    for (const [script, argumentsList] of publicCommands) {
      const command = spawnSync(
        process.execPath,
        [
          path.join(repositoryRoot, 'src/distribution-safety', script),
          ...argumentsList,
        ],
        { cwd: root, encoding: 'utf8' },
      );
      assert.equal(command.status, 1);
      assert.match(
        command.stderr,
        /^PROVENANCE_PUBLIC_PROMOTION_BLOCKED\tprovenance\/distribution-files\.json$/m,
      );
    }
  });
});

test('provenance rejects a source reached through a symlinked ancestor', async () => {
  await withFixture(async (root) => {
    const externalRoot = await mkdtemp(
      path.join(tmpdir(), 'distribution-source-outside-'),
    );
    try {
      await writeFile(
        path.join(externalRoot, 'guide.md'),
        'Neutral private pilot guide.\n',
      );
      await rm(path.join(root, 'payload'), { recursive: true });
      await symlink(externalRoot, path.join(root, 'payload'));
      await expectRule(
        () =>
          loadAndValidateProvenance({
            rootDir: root,
            manifestPath: path.join(root, 'provenance.json'),
          }),
        'SOURCE_SYMLINK',
      );
    } finally {
      await rm(externalRoot, { force: true, recursive: true });
    }
  });
});

test('provenance rejects missing private authority, checksum mismatch, and license review gaps', async () => {
  await withFixture(async (root) => {
    const original = await readManifest(root);

    const missingAuthority = structuredClone(original);
    delete missingAuthority.files[0].privateAuthority;
    await writeManifest(root, missingAuthority);
    await expectRule(
      () =>
        loadAndValidateProvenance({
          rootDir: root,
          manifestPath: path.join(root, 'provenance.json'),
        }),
      'PROVENANCE_SCHEMA',
    );

    const wrongChecksum = structuredClone(original);
    wrongChecksum.files[0].expectedSha256 = '0'.repeat(64);
    await writeManifest(root, wrongChecksum);
    await expectRule(
      () =>
        loadAndValidateProvenance({
          rootDir: root,
          manifestPath: path.join(root, 'provenance.json'),
        }),
      'PROVENANCE_CHECKSUM',
    );

    const missingReview = structuredClone(original);
    missingReview.dependencyReviews = [];
    await writeManifest(root, missingReview);
    await expectRule(
      () =>
        loadAndValidateProvenance({
          rootDir: root,
          manifestPath: path.join(root, 'provenance.json'),
        }),
      'DEPENDENCY_LICENSE_REVIEW_MISSING',
    );
  });
});

test('content policy rejects credentials, private keys, private hosts, home paths, binaries, and configured source terms', async () => {
  const cases = [
    ['credential.txt', 'CONTENT_CREDENTIAL'],
    ['private-key.pem', 'CONTENT_PRIVATE_KEY'],
    ['private-host.txt', 'CONTENT_PRIVATE_HOST'],
    ['absolute-path.txt', 'CONTENT_ABSOLUTE_PATH'],
  ];
  for (const [file, ruleId] of cases) {
    const content = await readFile(
      path.join(fixtureRoot, 'negative', 'content', file),
    );
    const issues = scanContent({ content, relativePath: 'generic/' + file });
    assert.ok(issues.some((issue) => issue.ruleId === ruleId));
  }

  const binaryIssues = scanContent({
    content: Buffer.from([0x00, 0x01, 0x02, 0xff]),
    relativePath: 'generic/binary.dat',
  });
  assert.ok(binaryIssues.some(({ ruleId }) => ruleId === 'CONTENT_BINARY'));

  const policy = await loadPolicy(
    path.join(fixtureRoot, 'policies', 'source-specific.json'),
  );
  const specificContent = await readFile(
    path.join(fixtureRoot, 'negative', 'content', 'source-specific.txt'),
  );
  const specificIssues = scanContent({
    content: specificContent,
    relativePath: 'generic/guide.md',
    policy,
  });
  assert.ok(
    specificIssues.some(
      ({ ruleId }) => ruleId === 'CONTENT_SOURCE_SPECIFIC',
    ),
  );

  const inlineCases = [
    ['generic/.env.production', 'SAFE_VALUE=yes\n', 'CONTENT_ENV_FILE'],
    [
      'generic/credential-url.txt',
      'https://synthetic-user:synthetic-password@example.invalid/data\n',
      'CONTENT_CREDENTIAL',
    ],
    [
      'generic/connection.txt',
      'postgresql://synthetic-user@example.invalid/database\n',
      'CONTENT_CREDENTIAL',
    ],
    [
      'generic/query-token.txt',
      'https://example.invalid/data?token=synthetic-token-value\n',
      'CONTENT_CREDENTIAL',
    ],
    [
      'generic/quoted-token.json',
      '{"accessToken":"synthetic-quoted-secret-value"}\n',
      'CONTENT_CREDENTIAL',
    ],
  ];
  for (const [relativePath, text, ruleId] of inlineCases) {
    const issues = scanContent({ content: Buffer.from(text), relativePath });
    assert.ok(issues.some((issue) => issue.ruleId === ruleId));
  }

  const caseVariantIssues = scanContent({
    content: Buffer.from('PRIVATE-COMPANY-MARKER\n'),
    relativePath: 'generic/guide.md',
    policy: {
      forbiddenTerms: ['private-company-marker'],
      genericPaths: [],
      maxFileBytes: 1024,
    },
  });
  assert.ok(
    caseVariantIssues.some(
      ({ ruleId }) => ruleId === 'CONTENT_SOURCE_SPECIFIC',
    ),
  );
});

test('provenance metadata is scanned without leaking rejected values', async () => {
  await withFixture(async (root) => {
    const manifest = await readManifest(root);
    manifest.files[0].privateAuthority.basis =
      'accessToken: synthetic-provenance-secret-value';
    await writeManifest(root, manifest);

    await assert.rejects(
      () =>
        loadAndValidateProvenance({
          rootDir: root,
          manifestPath: path.join(root, 'provenance.json'),
        }),
      (error) => {
        assert.ok(error instanceof DistributionSafetyError);
        const diagnostics = formatDiagnostics(error.issues);
        assert.match(
          diagnostics,
          /^CONTENT_CREDENTIAL\tprovenance\/distribution-files\.json$/m,
        );
        assert.doesNotMatch(diagnostics, /synthetic-provenance-secret-value/);
        assert.doesNotMatch(diagnostics, /accessToken/);
        return true;
      },
    );

    const command = spawnSync(
      process.execPath,
      [
        path.join(repositoryRoot, 'src/distribution-safety/check-provenance.mjs'),
        '--manifest',
        path.join(root, 'provenance.json'),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(command.status, 1);
    assert.equal(command.stdout, '');
    assert.match(
      command.stderr,
      /^CONTENT_CREDENTIAL\tprovenance\/distribution-files\.json$/m,
    );
    assert.doesNotMatch(
      command.stderr,
      /synthetic-provenance-secret-value|accessToken/,
    );
  });
});

test('diagnostics contain only rule identifiers and relative paths', async () => {
  const content = await readFile(
    path.join(fixtureRoot, 'negative', 'content', 'credential.txt'),
  );
  const diagnostics = formatDiagnostics(
    scanContent({ content, relativePath: 'generic/credential.txt' }),
  );
  assert.match(diagnostics, /^CONTENT_CREDENTIAL\tgeneric\/credential\.txt$/m);
  assert.doesNotMatch(diagnostics, /synthetic_super_secret_value/);
  assert.doesNotMatch(diagnostics, /SERVICE_TOKEN/);
});

test('artifact scanner accepts an exact directory and archive', async () => {
  await withFixture(async (root) => {
    const artifactDir = path.join(root, 'artifact');
    await mkdir(artifactDir);
    await copyFile(
      path.join(root, 'payload', 'guide.md'),
      path.join(artifactDir, 'guide.md'),
    );
    await chmod(path.join(artifactDir, 'guide.md'), 0o644);

    const directoryResult = await checkArtifact({
      artifactPath: artifactDir,
      manifestPath: path.join(root, 'provenance.json'),
      rootDir: root,
    });
    assert.deepEqual(directoryResult.files.map(({ path: filePath }) => filePath), [
      'guide.md',
    ]);

    const archivePath = await writeTar(
      root,
      'positive.tgz',
      [{ path: 'guide.md', content: 'Neutral private pilot guide.\n' }],
      { gzip: true },
    );
    const archiveResult = await checkArtifact({
      artifactPath: archivePath,
      manifestPath: path.join(root, 'provenance.json'),
      rootDir: root,
    });
    assert.deepEqual(archiveResult.files.map(({ path: filePath }) => filePath), [
      'guide.md',
    ]);
  });
});

test('artifact scanner rejects unallowlisted, missing, executable, and binary entries', async () => {
  await withFixture(async (root) => {
    const cases = [
      [
        'unallowlisted.tar',
        [
          { path: 'guide.md', content: 'Neutral private pilot guide.\n' },
          { path: 'extra.md', content: 'extra\n' },
        ],
        'ARTIFACT_UNALLOWLISTED',
      ],
      [
        'missing.tar',
        [{ path: 'other.md', content: 'other\n' }],
        'ARTIFACT_MISSING',
      ],
      [
        'executable.tar',
        [
          {
            path: 'guide.md',
            content: 'Neutral private pilot guide.\n',
            mode: 0o755,
          },
        ],
        'CAPABILITY_EXECUTABLE_UNDECLARED',
      ],
      [
        'binary.tar',
        [{ path: 'guide.md', content: Buffer.from([0x00, 0xff]) }],
        'CONTENT_BINARY',
      ],
    ];
    for (const [name, entries, ruleId] of cases) {
      const archivePath = await writeTar(root, name, entries);
      await expectRule(
        () =>
          checkArtifact({
            artifactPath: archivePath,
            manifestPath: path.join(root, 'provenance.json'),
            rootDir: root,
          }),
        ruleId,
      );
    }
  });
});

test('artifact scanner rejects traversal, links, non-regular entries, duplicates, and case collisions', async () => {
  await withFixture(async (root) => {
    const cases = [
      [
        'traversal.tar',
        [{ path: '../escape.md', content: 'escape\n' }],
        'PATH_TRAVERSAL',
      ],
      [
        'absolute.tar',
        [{ path: '/absolute.md', content: 'escape\n' }],
        'PATH_ABSOLUTE',
      ],
      [
        'symlink.tar',
        [{ path: 'guide.md', type: '2', linkpath: '../escape.md' }],
        'ARTIFACT_SYMLINK',
      ],
      [
        'hardlink.tar',
        [{ path: 'guide.md', type: '1', linkpath: 'other.md' }],
        'ARTIFACT_HARDLINK',
      ],
      [
        'device.tar',
        [{ path: 'guide.md', type: '3' }],
        'ARTIFACT_NON_REGULAR',
      ],
      [
        'duplicate.tar',
        [
          { path: 'guide.md', content: 'Neutral private pilot guide.\n' },
          { path: 'guide.md', content: 'Neutral private pilot guide.\n' },
        ],
        'PATH_DUPLICATE',
      ],
      [
        'case-collision.tar',
        [
          { path: 'guide.md', content: 'Neutral private pilot guide.\n' },
          { path: 'GUIDE.md', content: 'Neutral private pilot guide.\n' },
        ],
        'PATH_CASE_COLLISION',
      ],
    ];
    for (const [name, entries, ruleId] of cases) {
      const archivePath = await writeTar(root, name, entries);
      await expectRule(
        () =>
          checkArtifact({
            artifactPath: archivePath,
            manifestPath: path.join(root, 'provenance.json'),
            rootDir: root,
          }),
        ruleId,
      );
    }
  });
});

test('CLI diagnostics redact rejected values and public promotion fails closed', async () => {
  await withFixture(async (root) => {
    const manifest = await readManifest(root);
    const secret = Buffer.from('SERVICE_TOKEN=synthetic_cli_secret_value_12345\n');
    manifest.files[0].expectedSha256 = sha256(secret);
    await writeManifest(root, manifest);
    await writeFile(path.join(root, 'payload', 'guide.md'), secret);

    const command = spawnSync(
      process.execPath,
      [
        path.join(repositoryRoot, 'src/distribution-safety/check-provenance.mjs'),
        '--manifest',
        path.join(root, 'provenance.json'),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(command.status, 1);
    assert.match(command.stderr, /^CONTENT_CREDENTIAL\tguide\.md$/m);
    assert.doesNotMatch(command.stderr, /synthetic_cli_secret_value/);
    assert.doesNotMatch(command.stderr, /SERVICE_TOKEN/);

    await writeFile(
      path.join(root, 'payload', 'guide.md'),
      'Neutral private pilot guide.\n',
    );
    await writeManifest(
      root,
      await readManifest(path.join(fixtureRoot, 'positive')),
    );
    const publicCommand = spawnSync(
      process.execPath,
      [
        path.join(repositoryRoot, 'src/distribution-safety/check-provenance.mjs'),
        '--manifest',
        path.join(root, 'provenance.json'),
        '--public',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(publicCommand.status, 1);
    assert.match(publicCommand.stderr, /PROVENANCE_PUBLIC_ELIGIBILITY/);
    assert.match(publicCommand.stderr, /DEPENDENCY_PUBLIC_ELIGIBILITY/);
  });
});

test('artifact content is checked against declared checksum and privacy policy', async () => {
  await withFixture(async (root) => {
    const manifest = await readManifest(root);
    const credential = await readFile(
      path.join(fixtureRoot, 'negative', 'content', 'credential.txt'),
    );
    manifest.files[0].expectedSha256 = sha256(credential);
    await writeManifest(root, manifest);
    await writeFile(path.join(root, 'payload', 'guide.md'), credential);
    const archivePath = await writeTar(root, 'credential.tar', [
      { path: 'guide.md', content: credential },
    ]);
    await expectRule(
      () =>
        checkArtifact({
          artifactPath: archivePath,
          manifestPath: path.join(root, 'provenance.json'),
          rootDir: root,
        }),
      'CONTENT_CREDENTIAL',
    );
  });
});

test('pilot builder is deterministic, scans directory and archive, and reports no dirty release pin', async () => {
  await withFixture(async (root) => {
    const firstOutput = path.join(root, 'first');
    const secondOutput = path.join(root, 'second');
    const first = await buildPilot({
      rootDir: root,
      manifestPath: path.join(root, 'provenance.json'),
      outputDir: firstOutput,
    });
    const second = await buildPilot({
      rootDir: root,
      manifestPath: path.join(root, 'provenance.json'),
      outputDir: secondOutput,
    });

    assert.equal(first.archive.sha256, second.archive.sha256);
    assert.deepEqual(first.files, second.files);
    assert.deepEqual(first.files.map(({ path: filePath }) => filePath), [
      'guide.md',
    ]);
    assert.equal(first.sourceState.immutable, false);
    assert.equal(first.sourceState.sourcePin, null);
    assert.equal(first.archive.scanned, true);
    assert.equal(first.assembly.scanned, true);
  });
});

test('pilot builder pins only commits that contain every allowlisted source', async () => {
  await withFixture(async (root) => {
    const manifest = await readManifest(root);
    manifest.files[0].source = '.cache/guide.md';
    manifest.files[0].origin.path = '.cache/guide.md';
    await mkdir(path.join(root, '.cache'));
    await copyFile(
      path.join(root, 'payload', 'guide.md'),
      path.join(root, '.cache', 'guide.md'),
    );
    await rm(path.join(root, 'payload'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), '.cache/\n');
    await writeManifest(root, manifest);

    execFileSync('git', ['-c', 'init.templateDir=', 'init'], {
      cwd: root,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'add',
        '.gitignore',
        'package-lock.json',
        'provenance.json',
      ],
      { cwd: root, stdio: 'ignore' },
    );
    const tree = execFileSync(
      'git',
      ['write-tree'],
      { cwd: root, encoding: 'utf8' },
    ).trim();
    const commit = execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit-tree',
        tree,
        '-m',
        'fixture',
      ],
      { cwd: root, encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['update-ref', 'HEAD', commit], {
      cwd: root,
      stdio: 'ignore',
    });
    const outputDir = await mkdtemp(path.join(tmpdir(), 'pilot-output-'));
    try {
      const report = await buildPilot({
        rootDir: root,
        manifestPath: path.join(root, 'provenance.json'),
        outputDir,
      });
      assert.equal(report.sourceState.immutable, false);
      assert.equal(report.sourceState.sourcePin, null);
      assert.equal(report.sourceState.kind, 'working-inputs');

      execFileSync('git', ['add', '-f', '.cache/guide.md'], {
        cwd: root,
        stdio: 'ignore',
      });
      const completeTree = execFileSync('git', ['write-tree'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      const completeCommit = execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit-tree',
          completeTree,
          '-p',
          commit,
          '-m',
          'complete fixture',
        ],
        { cwd: root, encoding: 'utf8' },
      ).trim();
      execFileSync('git', ['update-ref', 'HEAD', completeCommit], {
        cwd: root,
        stdio: 'ignore',
      });
      const pinned = await buildPilot({
        rootDir: root,
        manifestPath: path.join(root, 'provenance.json'),
        outputDir,
      });
      assert.equal(pinned.sourceState.immutable, true);
      assert.equal(pinned.sourceState.sourcePin, completeCommit);
      assert.equal(pinned.sourceState.kind, 'clean-git-source');
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });
});

test('repository contract keeps generated output ignored without hiding distribution sources', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['build:pilot'],
    'node src/build/build-pilot.mjs',
  );
  assert.equal(
    packageJson.scripts['test:distribution-safety'],
    'node --test test/distribution-safety.test.mjs',
  );

  const ignore = await readFile(path.join(repositoryRoot, '.gitignore'), 'utf8');
  const ignoreLines = new Set(ignore.split('\n'));
  for (const expected of [
    'node_modules/',
    'dist/',
    'coverage/',
    '.scratch/',
    '.cache/',
    '.claude/runs/',
    '.claude/session-artifacts/',
  ]) {
    assert.ok(ignoreLines.has(expected));
  }
  for (const forbidden of [
    '.claude/',
    '.claude/agents/',
    '.claude-plugin/',
    'plugins/',
    'adapters/',
    'provenance/',
    '*.d.ts',
  ]) {
    assert.ok(!ignoreLines.has(forbidden));
  }
});
