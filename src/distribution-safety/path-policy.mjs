import path from 'node:path';

import { createIssue } from './diagnostics.mjs';

export function inspectRelativePath(value) {
  const issues = [];
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(createIssue('PATH_INVALID', '<unknown>'));
    return { issues, normalized: null };
  }
  if (value.includes('\0') || value.includes('\\')) {
    issues.push(createIssue('PATH_INVALID', value));
    return { issues, normalized: null };
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    issues.push(createIssue('PATH_ABSOLUTE', value));
    return { issues, normalized: null };
  }
  const parts = value.split('/');
  if (parts.includes('..')) {
    issues.push(createIssue('PATH_TRAVERSAL', value));
    return { issues, normalized: null };
  }
  if (parts.some((part) => part === '' || part === '.')) {
    issues.push(createIssue('PATH_NOT_NORMALIZED', value));
    return { issues, normalized: null };
  }
  const normalized = value.normalize('NFC');
  if (normalized !== value) {
    issues.push(createIssue('PATH_NOT_NORMALIZED', value));
    return { issues, normalized: null };
  }
  return { issues, normalized };
}

export function inspectPathSet(values) {
  const issues = [];
  const exact = new Set();
  const folded = new Map();
  const normalized = [];
  for (const value of values) {
    const inspected = inspectRelativePath(value);
    issues.push(...inspected.issues);
    if (inspected.normalized === null) continue;
    const current = inspected.normalized;
    if (exact.has(current)) {
      issues.push(createIssue('PATH_DUPLICATE', current));
    } else {
      exact.add(current);
    }
    const caseKey = current.toLowerCase();
    const previous = folded.get(caseKey);
    if (previous !== undefined && previous !== current) {
      issues.push(createIssue('PATH_CASE_COLLISION', current));
      issues.push(createIssue('PATH_CASE_COLLISION', previous));
    } else {
      folded.set(caseKey, current);
    }
    normalized.push(current);
  }
  return { issues, normalized };
}

export function resolveWithin(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}
