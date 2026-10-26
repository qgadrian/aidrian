#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { create as createTar } from 'tar';

import { checkArtifact } from '../distribution-safety/artifact.mjs';
import { parseMode } from '../distribution-safety/capabilities.mjs';
import {
  DEFAULT_CONTENT_POLICY,
  loadPolicy,
} from '../distribution-safety/content-policy.mjs';
import {
  DistributionSafetyError,
  formatDiagnostics,
} from '../distribution-safety/diagnostics.mjs';
import {
  loadAndValidateProvenance,
} from '../distribution-safety/provenance.mjs';

function runGit(rootDir, argumentsList, encoding = 'utf8') {
  return execFileSync('git', argumentsList, {
    cwd: rootDir,
    encoding,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

async function matchesHeadInput(rootDir, commit, inputPath) {
  const root = path.resolve(rootDir);
  const absoluteInput = path.resolve(inputPath);
  const relativeInput = path.relative(root, absoluteInput);
  if (
    relativeInput === '' ||
    relativeInput === '..' ||
    relativeInput.startsWith('..' + path.sep) ||
    path.isAbsolute(relativeInput)
  ) {
    return false;
  }
  const repositoryPath = relativeInput.split(path.sep).join('/');
  const treeEntry = runGit(
    rootDir,
    ['ls-tree', '-z', commit, '--', ':(literal)' + repositoryPath],
  );
  const [identity, listedPath = ''] = treeEntry.replace(/\0$/, '').split('\t');
  const [mode, type, objectId] = identity.split(' ');
  if (
    listedPath !== repositoryPath ||
    type !== 'blob' ||
    !['100644', '100755'].includes(mode) ||
    !objectId
  ) {
    return false;
  }
  const [headContent, workingContent, workingStat] = await Promise.all([
    Promise.resolve(runGit(rootDir, ['cat-file', 'blob', objectId], null)),
    readFile(absoluteInput),
    stat(absoluteInput),
  ]);
  const workingMode = (workingStat.mode & 0o111) === 0 ? '100644' : '100755';
  return mode === workingMode && headContent.equals(workingContent);
}

async function sourceState(rootDir, provenance, manifestPath) {
  try {
    const commit = runGit(rootDir, ['rev-parse', 'HEAD']).trim();
    const dirty =
      runGit(
        rootDir,
        ['status', '--porcelain', '--untracked-files=all'],
      ).trim().length > 0;
    const inputs = [
      manifestPath,
      path.join(rootDir, 'package-lock.json'),
      ...provenance.manifest.files.map(({ source }) =>
        path.join(rootDir, ...source.split('/')),
      ),
    ];
    const inputsMatchHead =
      !dirty &&
      (
        await Promise.all(
          [...new Set(inputs)].map((inputPath) =>
            matchesHeadInput(rootDir, commit, inputPath),
          ),
        )
      ).every(Boolean);
    return {
      kind: inputsMatchHead ? 'clean-git-source' : 'working-inputs',
      observedCommit: commit,
      immutable: inputsMatchHead,
      sourcePin: inputsMatchHead ? commit : null,
    };
  } catch {
    return {
      kind: 'working-inputs',
      observedCommit: null,
      immutable: false,
      sourcePin: null,
    };
  }
}

function relativeReportPath(outputDir, filePath) {
  return path.relative(outputDir, filePath).split(path.sep).join('/');
}

export async function buildPilot({
  rootDir,
  manifestPath = path.join(rootDir, 'provenance/distribution-files.json'),
  outputDir = path.join(rootDir, 'dist/pilot'),
  policy = DEFAULT_CONTENT_POLICY,
}) {
  const provenance = await loadAndValidateProvenance({
    rootDir,
    manifestPath,
    policy,
  });
  const artifactId = provenance.manifest.distribution.id;
  const assemblyDir = path.join(outputDir, artifactId);
  const archivePath = path.join(outputDir, artifactId + '.tgz');
  const reportPath = path.join(outputDir, 'distribution-report.json');
  await rm(assemblyDir, { force: true, recursive: true });
  await rm(archivePath, { force: true });
  await rm(reportPath, { force: true });
  await mkdir(assemblyDir, { recursive: true });

  const orderedFiles = [...provenance.manifest.files].sort((left, right) =>
    left.target.localeCompare(right.target),
  );
  for (const file of orderedFiles) {
    const targetPath = path.join(assemblyDir, ...file.target.split('/'));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(path.join(rootDir, ...file.source.split('/')), targetPath);
    await chmod(targetPath, parseMode(file.mode));
  }

  const assemblyResult = await checkArtifact({
    artifactPath: assemblyDir,
    manifestPath,
    rootDir,
    policy,
  });
  await createTar(
    {
      cwd: assemblyDir,
      file: archivePath,
      gzip: { level: 9, mtime: 0 },
      noMtime: true,
      portable: true,
      strict: true,
    },
    orderedFiles.map(({ target }) => target),
  );
  const archiveResult = await checkArtifact({
    artifactPath: archivePath,
    manifestPath,
    rootDir,
    policy,
  });
  const archiveStat = await stat(archivePath);
  const files = orderedFiles.map((file) => ({
    path: file.target,
    sha256: file.expectedSha256,
    mode: file.mode,
    sourceCategory: file.sourceCategory,
    origin: file.origin,
    privateAuthority: file.privateAuthority,
    publicEligibility: file.publicEligibility,
    transformation: file.transformation,
  }));
  const report = {
    reportSchemaVersion: 1,
    producer: provenance.manifest.producer,
    provenanceSchemaVersion: provenance.manifest.schemaVersion,
    builder: provenance.manifest.builder,
    distribution: provenance.manifest.distribution,
    sourceState: await sourceState(rootDir, provenance, manifestPath),
    manifestSha256: provenance.manifestSha256,
    publicPromotionEligible: provenance.publicPromotionEligible,
    files,
    assembly: {
      directory: relativeReportPath(outputDir, assemblyDir),
      sha256: assemblyResult.artifactSha256,
      scanned: true,
    },
    archive: {
      file: relativeReportPath(outputDir, archivePath),
      format: 'tar+gzip',
      sha256: archiveResult.artifactSha256,
      size: archiveStat.size,
      scanned: true,
    },
    reproducibility: {
      deterministicOrder: true,
      normalizedOwnership: true,
      timestampsOmitted: true,
      treeSha256: createHash('sha256')
        .update(JSON.stringify(files))
        .digest('hex'),
    },
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  let checkOnly = false;
  let manifestPath = path.resolve('provenance/distribution-files.json');
  let outputDir = path.resolve('dist/pilot');
  let policyPath = null;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--check') {
      checkOnly = true;
    } else if (argument === '--manifest' && argumentsList[index + 1]) {
      manifestPath = path.resolve(argumentsList[++index]);
    } else if (argument === '--output' && argumentsList[index + 1]) {
      outputDir = path.resolve(argumentsList[++index]);
    } else if (argument === '--policy' && argumentsList[index + 1]) {
      policyPath = path.resolve(argumentsList[++index]);
    } else {
      throw new TypeError('invalid build arguments');
    }
  }
  const scratch = checkOnly
    ? await mkdtemp(path.join(tmpdir(), 'private-pilot-check-'))
    : null;
  try {
    const report = await buildPilot({
      rootDir: process.cwd(),
      manifestPath,
      outputDir: scratch ?? outputDir,
      policy: await loadPolicy(policyPath),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    if (scratch) await rm(scratch, { force: true, recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    if (error instanceof DistributionSafetyError) {
      process.stderr.write(formatDiagnostics(error.issues) + '\n');
    } else {
      process.stderr.write('BUILD_INVALID\t<build>\n');
    }
    process.exitCode = 1;
  }
}
