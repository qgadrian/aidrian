import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import Ajv from 'ajv';

import {
  inspectArtifactMode,
  inspectDeclaredCapabilities,
} from './capabilities.mjs';
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
  resolveWithin,
} from './path-policy.mjs';
import { provenanceSchema } from './provenance-schema.mjs';

const validateSchema = new Ajv({
  allErrors: true,
  strict: true,
}).compile(provenanceSchema);

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function parseJson(content, ruleId, diagnosticPath) {
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    throw new DistributionSafetyError([
      createIssue(ruleId, diagnosticPath),
    ]);
  }
}

async function readJson(filePath, ruleId, diagnosticPath) {
  try {
    return parseJson(await readFile(filePath), ruleId, diagnosticPath);
  } catch (error) {
    if (error instanceof DistributionSafetyError) throw error;
    throw new DistributionSafetyError([
      createIssue(ruleId, diagnosticPath),
    ]);
  }
}

function packageNameFromLockPath(lockPath) {
  return lockPath.slice('node_modules/'.length);
}

function inspectDependencies(lock, manifest) {
  const issues = [];
  if (
    lock === null ||
    typeof lock !== 'object' ||
    lock.lockfileVersion !== 3 ||
    lock.packages === null ||
    typeof lock.packages !== 'object'
  ) {
    return [createIssue('DEPENDENCY_LOCK_INVALID', 'package-lock.json')];
  }
  const runtimePackages = Object.entries(lock.packages)
    .filter(
      ([lockPath, value]) =>
        lockPath.startsWith('node_modules/') &&
        value !== null &&
        typeof value === 'object' &&
        value.dev !== true,
    )
    .map(([lockPath, value]) => ({
      package: packageNameFromLockPath(lockPath),
      version: value.version,
      license: value.license,
    }));
  const reviews = new Map(
    manifest.dependencyReviews.map((review) => [
      review.package + '@' + review.version,
      review,
    ]),
  );
  for (const dependency of runtimePackages) {
    const dependencyPath =
      'node_modules/' + dependency.package + '/package.json';
    if (
      typeof dependency.version !== 'string' ||
      typeof dependency.license !== 'string' ||
      dependency.license.length === 0
    ) {
      issues.push(
        createIssue('DEPENDENCY_LICENSE_UNDECLARED', dependencyPath),
      );
      continue;
    }
    const review = reviews.get(
      dependency.package + '@' + dependency.version,
    );
    if (!review) {
      issues.push(
        createIssue('DEPENDENCY_LICENSE_REVIEW_MISSING', dependencyPath),
      );
      continue;
    }
    if (review.declaredLicense !== dependency.license) {
      issues.push(
        createIssue('DEPENDENCY_LICENSE_MISMATCH', dependencyPath),
      );
    }
  }
  for (const review of manifest.dependencyReviews) {
    const present = runtimePackages.some(
      (dependency) =>
        dependency.package === review.package &&
        dependency.version === review.version,
    );
    if (!present) {
      issues.push(
        createIssue(
          'DEPENDENCY_REVIEW_UNKNOWN',
          'node_modules/' + review.package + '/package.json',
        ),
      );
    }
  }
  return issues;
}

export async function loadAndValidateProvenance({
  rootDir,
  manifestPath,
  publicPromotion = false,
  policy = DEFAULT_CONTENT_POLICY,
}) {
  const absoluteRoot = path.resolve(rootDir);
  const absoluteManifest = path.resolve(manifestPath);
  const manifestContent = await readFile(absoluteManifest).catch(() => null);
  if (manifestContent === null) {
    throw new DistributionSafetyError([
      createIssue('PROVENANCE_PARSE', 'provenance/distribution-files.json'),
    ]);
  }
  const manifest = parseJson(
    manifestContent,
    'PROVENANCE_PARSE',
    'provenance/distribution-files.json',
  );
  if (!validateSchema(manifest)) {
    throw new DistributionSafetyError([
      createIssue('PROVENANCE_SCHEMA', 'provenance/distribution-files.json'),
    ]);
  }

  const issues = [
    ...scanContent({
      content: manifestContent,
      relativePath: 'provenance/distribution-files.json',
      policy: {
        ...policy,
        genericPaths: [],
      },
    }),
  ];
  const realRoot = await realpath(absoluteRoot);
  issues.push(...inspectPathSet(manifest.files.map(({ source }) => source)).issues);
  issues.push(...inspectPathSet(manifest.files.map(({ target }) => target)).issues);
  for (const file of manifest.files) {
    issues.push(...inspectDeclaredCapabilities(file));
    if (file.origin.type === 'repository') {
      const origin = inspectRelativePath(file.origin.path);
      issues.push(...origin.issues);
      if (origin.normalized !== file.source) {
        issues.push(createIssue('PROVENANCE_ORIGIN_MISMATCH', file.target));
      }
    }
    const sourcePath = resolveWithin(absoluteRoot, file.source);
    if (!sourcePath) {
      issues.push(createIssue('PATH_TRAVERSAL', file.source));
      continue;
    }
    let sourceStat;
    let content;
    try {
      sourceStat = await lstat(sourcePath);
      if (sourceStat.isSymbolicLink()) {
        issues.push(createIssue('SOURCE_SYMLINK', file.source));
        continue;
      }
      if (!sourceStat.isFile()) {
        issues.push(createIssue('SOURCE_NON_REGULAR', file.source));
        continue;
      }
      const realSource = await realpath(sourcePath);
      if (
        realSource !== realRoot &&
        !realSource.startsWith(realRoot + path.sep)
      ) {
        issues.push(createIssue('SOURCE_SYMLINK', file.source));
        continue;
      }
      content = await readFile(realSource);
    } catch {
      issues.push(createIssue('SOURCE_MISSING', file.source));
      continue;
    }
    if (sha256(content) !== file.expectedSha256) {
      issues.push(createIssue('PROVENANCE_CHECKSUM', file.source));
    }
    issues.push(...inspectArtifactMode(file, sourceStat.mode));
    issues.push(...scanContent({ content, relativePath: file.target, policy }));
    if (publicPromotion && file.publicEligibility.status !== 'eligible') {
      issues.push(
        createIssue('PROVENANCE_PUBLIC_ELIGIBILITY', file.target),
      );
    }
  }

  const lock = await readJson(
    path.join(absoluteRoot, 'package-lock.json'),
    'DEPENDENCY_LOCK_INVALID',
    'package-lock.json',
  );
  issues.push(...inspectDependencies(lock, manifest));
  if (publicPromotion) {
    if (
      manifest.distribution.publicPromotion !==
      'eligible'
    ) {
      issues.push(
        createIssue(
          'PROVENANCE_PUBLIC_PROMOTION_BLOCKED',
          'provenance/distribution-files.json',
        ),
      );
    }
    for (const review of manifest.dependencyReviews) {
      if (review.publicEligibility !== 'eligible') {
        issues.push(
          createIssue(
            'DEPENDENCY_PUBLIC_ELIGIBILITY',
            'node_modules/' + review.package + '/package.json',
          ),
        );
      }
    }
  }
  throwIfIssues(issues);

  const publicPromotionEligible =
    manifest.distribution.publicPromotion === 'eligible' &&
    manifest.files.every(
      ({ publicEligibility }) => publicEligibility.status === 'eligible',
    ) &&
    manifest.dependencyReviews.every(
      ({ publicEligibility }) => publicEligibility === 'eligible',
    );
  return {
    manifest,
    manifestSha256: sha256(manifestContent),
    publicPromotionEligible,
  };
}
