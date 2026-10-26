import path from 'node:path';

function safeDiagnosticPath(value) {
  if (typeof value !== 'string' || value.length === 0) return '<unknown>';
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes('\0') ||
    value.includes('\\')
  ) {
    return '<invalid-path>';
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return '<invalid-path>';
  }
  return value.normalize('NFC');
}

export function createIssue(ruleId, relativePath) {
  return Object.freeze({
    ruleId,
    path: safeDiagnosticPath(relativePath),
  });
}

export function normalizeIssues(issues) {
  const unique = new Map();
  for (const issue of issues) {
    const normalized = createIssue(issue.ruleId, issue.path);
    unique.set(normalized.ruleId + '\0' + normalized.path, normalized);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

export function formatDiagnostics(issues) {
  return normalizeIssues(issues)
    .map(({ ruleId, path: relativePath }) => ruleId + '\t' + relativePath)
    .join('\n');
}

export class DistributionSafetyError extends Error {
  constructor(issues) {
    const normalized = normalizeIssues(issues);
    super(formatDiagnostics(normalized));
    this.name = 'DistributionSafetyError';
    this.issues = normalized;
  }
}

export function throwIfIssues(issues) {
  if (issues.length > 0) throw new DistributionSafetyError(issues);
}
