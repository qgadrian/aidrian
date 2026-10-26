import { createIssue } from './diagnostics.mjs';

function isExecutable(mode) {
  return (mode & 0o111) !== 0;
}

export function parseMode(mode) {
  return Number.parseInt(mode, 8);
}

export function formatMode(mode) {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

export function inspectDeclaredCapabilities(file) {
  const issues = [];
  const executable = isExecutable(parseMode(file.mode));
  const declared = file.capabilities.includes('execute');
  if (executable && !declared) {
    issues.push(
      createIssue('CAPABILITY_EXECUTABLE_UNDECLARED', file.target),
    );
  }
  if (!executable && declared) {
    issues.push(createIssue('CAPABILITY_EXECUTE_MODE_MISMATCH', file.target));
  }
  return issues;
}

export function inspectArtifactMode(file, actualMode) {
  const issues = [];
  if (formatMode(actualMode) !== file.mode) {
    issues.push(createIssue('ARTIFACT_MODE_MISMATCH', file.target));
  }
  if (
    isExecutable(actualMode) &&
    !file.capabilities.includes('execute')
  ) {
    issues.push(
      createIssue('CAPABILITY_EXECUTABLE_UNDECLARED', file.target),
    );
  }
  return issues;
}
