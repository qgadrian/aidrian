import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';

import { list as listTar } from 'tar';

import { inspectArtifactMode } from './capabilities.mjs';
import {
  DEFAULT_CONTENT_POLICY,
  scanContent,
} from './content-policy.mjs';
import {
  createIssue,
  DistributionSafetyError,
  throwIfIssues,
} from './diagnostics.mjs';
import {
  inspectPathSet,
  inspectRelativePath,
} from './path-policy.mjs';
import {
  loadAndValidateProvenance,
  sha256,
} from './provenance.mjs';

async function readDirectoryEntries(rootDir) {
  const entries = [];
  const issues = [];
  async function walk(directory, prefix) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = prefix ? prefix + '/' + child.name : child.name;
      const absolutePath = path.join(directory, child.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        issues.push(createIssue('ARTIFACT_SYMLINK', relativePath));
      } else if (stat.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        if (stat.nlink > 1) {
          issues.push(createIssue('ARTIFACT_HARDLINK', relativePath));
        }
        entries.push({
          path: relativePath,
          mode: stat.mode,
          content: await readFile(absolutePath),
        });
      } else {
        issues.push(createIssue('ARTIFACT_NON_REGULAR', relativePath));
      }
    }
  }
  await walk(rootDir, '');
  return { entries, issues };
}

async function readArchiveEntries(archivePath, maxFileBytes) {
  const entries = [];
  const issues = [];
  const pending = [];
  try {
    await listTar({
      file: archivePath,
      strict: true,
      onentry(entry) {
        const relativePath = entry.path;
        if (entry.type === 'SymbolicLink') {
          issues.push(createIssue('ARTIFACT_SYMLINK', relativePath));
          entry.resume();
          return;
        }
        if (entry.type === 'Link') {
          issues.push(createIssue('ARTIFACT_HARDLINK', relativePath));
          entry.resume();
          return;
        }
        if (!['File', 'OldFile', 'ContiguousFile'].includes(entry.type)) {
          issues.push(createIssue('ARTIFACT_NON_REGULAR', relativePath));
          entry.resume();
          return;
        }
        if (entry.size > maxFileBytes) {
          issues.push(createIssue('CONTENT_FILE_TOO_LARGE', relativePath));
          entry.resume();
          return;
        }
        pending.push(
          new Promise((resolve, reject) => {
            const chunks = [];
            entry.on('data', (chunk) => chunks.push(chunk));
            entry.on('end', () => {
              entries.push({
                path: relativePath,
                mode: entry.mode,
                content: Buffer.concat(chunks),
              });
              resolve();
            });
            entry.on('error', reject);
          }),
        );
      },
    });
    await Promise.all(pending);
  } catch {
    throw new DistributionSafetyError([
      createIssue('ARCHIVE_INVALID', '<archive>'),
    ]);
  }
  return { entries, issues };
}

function inspectEntries(entries, manifest, policy) {
  const issues = [];
  issues.push(...inspectPathSet(entries.map((entry) => entry.path)).issues);
  const expected = new Map(
    manifest.files.map((file) => [file.target, file]),
  );
  const seen = new Set();
  const files = [];
  for (const entry of entries) {
    const inspectedPath = inspectRelativePath(entry.path);
    if (inspectedPath.normalized === null) continue;
    const relativePath = inspectedPath.normalized;
    issues.push(
      ...scanContent({
        content: entry.content,
        relativePath,
        policy,
      }),
    );
    const declared = expected.get(relativePath);
    if (!declared) {
      issues.push(createIssue('ARTIFACT_UNALLOWLISTED', relativePath));
      continue;
    }
    seen.add(relativePath);
    issues.push(...inspectArtifactMode(declared, entry.mode));
    const checksum = sha256(entry.content);
    if (checksum !== declared.expectedSha256) {
      issues.push(createIssue('ARTIFACT_CHECKSUM', relativePath));
    }
    files.push({
      path: relativePath,
      sha256: checksum,
      mode: (entry.mode & 0o777).toString(8).padStart(4, '0'),
    });
  }
  for (const target of expected.keys()) {
    if (!seen.has(target)) {
      issues.push(createIssue('ARTIFACT_MISSING', target));
    }
  }
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    issues,
  };
}

export async function checkArtifact({
  artifactPath,
  manifestPath,
  rootDir,
  publicPromotion = false,
  policy = DEFAULT_CONTENT_POLICY,
}) {
  const provenance = await loadAndValidateProvenance({
    rootDir,
    manifestPath,
    publicPromotion,
    policy,
  });
  let stat;
  try {
    stat = await lstat(artifactPath);
  } catch {
    throw new DistributionSafetyError([
      createIssue('ARTIFACT_MISSING', '<artifact>'),
    ]);
  }
  if (stat.isSymbolicLink()) {
    throw new DistributionSafetyError([
      createIssue('ARTIFACT_SYMLINK', '<artifact>'),
    ]);
  }
  const inspected = stat.isDirectory()
    ? await readDirectoryEntries(artifactPath)
    : stat.isFile()
      ? await readArchiveEntries(artifactPath, policy.maxFileBytes)
      : {
          entries: [],
          issues: [createIssue('ARTIFACT_NON_REGULAR', '<artifact>')],
        };
  const result = inspectEntries(
    inspected.entries,
    provenance.manifest,
    policy,
  );
  throwIfIssues([...inspected.issues, ...result.issues]);
  const artifactChecksum = stat.isFile()
    ? sha256(await readFile(artifactPath))
    : createHash('sha256')
        .update(JSON.stringify(result.files))
        .digest('hex');
  return {
    files: result.files,
    artifactSha256: artifactChecksum,
    manifestSha256: provenance.manifestSha256,
  };
}
