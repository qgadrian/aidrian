import { readFile } from 'node:fs/promises';

import { createIssue } from './diagnostics.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });

const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i;
const ASSIGNED_CREDENTIAL_PATTERN =
  /["']?[A-Z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE[_-]?KEY|API[_-]?KEY|CREDENTIALS?)[A-Z0-9_.-]*["']?\s*[:=]\s*["']?(?!\s*(?:unset|placeholder|example|redacted|null|false|true)\b)\S{8,}/i;
const KNOWN_TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/i;
const CREDENTIAL_URL_PATTERN =
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const CREDENTIAL_QUERY_PATTERN =
  /\bhttps?:\/\/\S+[?&](?:access_?key|api_?key|password|secret|token)=[^&\s]{6,}/i;
const CONNECTION_STRING_PATTERN =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/\S+/i;
const PRIVATE_HOST_PATTERN =
  /\b(?:localhost|(?:[a-z0-9-]+\.)+(?:internal|local)|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/i;
const ABSOLUTE_HOME_PATTERN =
  /(?:^|[\s("'])((?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/workspace\/[^/\s]+|\/private\/tmp\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+))/m;
const ENV_PATH_PATTERN = /(^|\/)\.env(?:$|\.)/i;

export const DEFAULT_CONTENT_POLICY = Object.freeze({
  forbiddenTerms: Object.freeze([]),
  genericPaths: Object.freeze([]),
  maxFileBytes: 8 * 1024 * 1024,
});

function isGenericPath(relativePath, genericPaths) {
  if (genericPaths.length === 0) return true;
  return genericPaths.some(
    (candidate) =>
      relativePath === candidate || relativePath.startsWith(candidate + '/'),
  );
}

export async function loadPolicy(policyPath) {
  if (!policyPath) return DEFAULT_CONTENT_POLICY;
  const value = JSON.parse(await readFile(policyPath, 'utf8'));
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['forbiddenTerms', 'genericPaths', 'maxFileBytes'].includes(key),
    ) ||
    (value.forbiddenTerms !== undefined &&
      (!Array.isArray(value.forbiddenTerms) ||
        value.forbiddenTerms.some(
          (term) => typeof term !== 'string' || term.length === 0,
        ))) ||
    (value.genericPaths !== undefined &&
      (!Array.isArray(value.genericPaths) ||
        value.genericPaths.some(
          (entry) => typeof entry !== 'string' || entry.length === 0,
        ))) ||
    (value.maxFileBytes !== undefined &&
      (!Number.isSafeInteger(value.maxFileBytes) || value.maxFileBytes < 1))
  ) {
    throw new TypeError('invalid distribution policy');
  }
  return Object.freeze({
    forbiddenTerms: Object.freeze([...(value.forbiddenTerms ?? [])]),
    genericPaths: Object.freeze([...(value.genericPaths ?? [])]),
    maxFileBytes: value.maxFileBytes ?? DEFAULT_CONTENT_POLICY.maxFileBytes,
  });
}

export function scanContent({
  content,
  relativePath,
  policy = DEFAULT_CONTENT_POLICY,
}) {
  const issues = [];
  if (ENV_PATH_PATTERN.test(relativePath)) {
    issues.push(createIssue('CONTENT_ENV_FILE', relativePath));
  }
  if (content.length > policy.maxFileBytes) {
    issues.push(createIssue('CONTENT_FILE_TOO_LARGE', relativePath));
    return issues;
  }
  let text;
  try {
    text = decoder.decode(content);
  } catch {
    issues.push(createIssue('CONTENT_BINARY', relativePath));
    return issues;
  }
  if (text.includes('\0')) {
    issues.push(createIssue('CONTENT_BINARY', relativePath));
    return issues;
  }
  const controlCount = [...text].filter((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 && !['\n', '\r', '\t'].includes(character);
  }).length;
  if (text.length > 0 && controlCount / text.length > 0.01) {
    issues.push(createIssue('CONTENT_BINARY', relativePath));
    return issues;
  }
  if (PRIVATE_KEY_PATTERN.test(text)) {
    issues.push(createIssue('CONTENT_PRIVATE_KEY', relativePath));
  }
  if (
    ASSIGNED_CREDENTIAL_PATTERN.test(text) ||
    KNOWN_TOKEN_PATTERN.test(text) ||
    BEARER_PATTERN.test(text) ||
    CREDENTIAL_URL_PATTERN.test(text) ||
    CREDENTIAL_QUERY_PATTERN.test(text) ||
    CONNECTION_STRING_PATTERN.test(text)
  ) {
    issues.push(createIssue('CONTENT_CREDENTIAL', relativePath));
  }
  if (PRIVATE_HOST_PATTERN.test(text)) {
    issues.push(createIssue('CONTENT_PRIVATE_HOST', relativePath));
  }
  if (ABSOLUTE_HOME_PATTERN.test(text)) {
    issues.push(createIssue('CONTENT_ABSOLUTE_PATH', relativePath));
  }
  if (
    isGenericPath(relativePath, policy.genericPaths) &&
    policy.forbiddenTerms.some((term) =>
      text.toLocaleLowerCase('en-US').includes(
        term.toLocaleLowerCase('en-US'),
      ),
    )
  ) {
    issues.push(createIssue('CONTENT_SOURCE_SPECIFIC', relativePath));
  }
  return issues;
}
