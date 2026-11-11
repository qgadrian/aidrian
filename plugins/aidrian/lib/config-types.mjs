// The value types of config-schema.mjs: each a check and the phrase an error uses for it.

import path from 'node:path';

import { agentNameProblem, ALL, MAIN } from './agent-gates.mjs';
import { AUDIT_LABEL_FIELDS, COMMIT_FIELDS, HANDOFF_MODES, MAX_PLAN_OBJECTIONS, PR_FIELDS } from './config-schema.mjs';
import { CLASS_MAX, DECISION_MODES, decisionClasses, isClassName, SAFE_DEFAULTS } from './decisions.mjs';
import { loadTable as dispositionTable } from './finding-disposition.mjs';
import { isObject } from './fs.mjs';
import { pathsProblem } from './review/config.mjs';

const SEMVER = /^\d+\.\d+\.\d+$/u;
const isAuditLabel = (value) => isText(value) && [...value.matchAll(/[{}]/gu)].length === 2 * [...value.matchAll(/\{(\w+)\}/gu)].filter(([, field]) => AUDIT_LABEL_FIELDS.includes(field)).length;
export const isText = (value) => typeof value === 'string' && value.trim() !== '';
export const isTexts = (value) => Array.isArray(value) && value.every(isText);
const compiles = (source, flags) => {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
};
// What is wrong with a list of path globs, or null: an empty `re:`, or what review/config.mjs pathsProblem finds.
const globsProblem = (list) => (list.includes('re:') ? 'has re: with no expression' : pathsProblem(list));
// A regular expression a project writes as a string; `{types}` and `{issueKey}` are filled in before it compiles
// (lib/rules/github/pr-body.mjs), so they are checked filled with a plain word.
const isPattern = (value) => isText(value) && compiles(value.replaceAll('{types}', 'x').replaceAll('{issueKey}', 'x'), 'u');
// A case-insensitive regular expression a project writes as a string, compiled as lib/rules/github/public-text.mjs compiles it.
const isInsensitivePattern = (value) => isText(value) && compiles(value, 'iu');
// A doc, section, or folder from the project root, as `decisions.escalateDocs` lists them (lib/decisions.mjs).
const isDocPath = (value) => {
  if (!isText(value)) return false;
  const [file, ...section] = value.split('#');
  if (file === '' || /[*?[\]{}\\]/u.test(file) || path.isAbsolute(file) || file.startsWith('~') || file.split('/').includes('..')) return false;
  if (section.length && file.endsWith('/')) return false;
  return path.posix.normalize(file).replace(/\/$/u, '') !== '.';
};
// What `decisions.classes` holds: new names only, so a project can neither lift a floor class nor change a built-in's meaning.
const isProjectClasses = (value) => isObject(value) && Object.entries(value).every(([name, definition]) =>
  isClassName(name) && !decisionClasses().includes(name) && isText(definition) && !/[\r\n]/u.test(definition));
const hasOnly = (value, keys) => isObject(value) && Object.keys(value).every((key) => keys.includes(key));
export const TYPES = {
  text: [isText, 'a non-empty string'],
  textOrNull: [(value) => value === null || isText(value), 'a non-empty string or null'],
  texts: [isTexts, 'a list of non-empty strings'],
  // Path globs as review globs take them (review/plan.mjs pathPattern), checked by review/config.mjs pathsProblem, and no
  // empty `re:`, which would match every path.
  globs: [(value) => isTexts(value) && !globsProblem(value), (value) => `a list of globs${isTexts(value) ? `, and it ${globsProblem(value)}` : ''}`],
  someTexts: [(value) => isTexts(value) && value.length > 0, 'a non-empty list of non-empty strings'],
  textsOrNull: [(value) => value === null || isTexts(value), 'a list of non-empty strings, or null'],
  patternOrNull: [(value) => value === null || isPattern(value), 'a regular expression as a string, or null'],
  patterns: [(value) => Array.isArray(value) && value.every(isInsensitivePattern), 'a list of valid regular expressions as strings'],
  deferralsOrNull: [
    (value) => value === null || (hasOnly(value, ['section', 'field', 'reasons', 'neverValid']) && isText(value.section) && isText(value.field) &&
      isTexts(value.reasons) && value.reasons.length > 0 && (value.neverValid === undefined || isTexts(value.neverValid))),
    'null, or { "section", "field", "reasons": [...], "neverValid": [...] } with at least one reason',
  ],
  residualsOrNull: [
    (value) => value === null || (hasOnly(value, ['section', 'fields']) && isText(value.section) && isTexts(value.fields) && value.fields.length > 0),
    'null, or { "section", "fields": [...] } with at least one field',
  ],
  folderNames: [
    (value) => Array.isArray(value) && value.every((name) => isText(name) && !/[/\\]/u.test(name) && name !== '.' && name !== '..'),
    'a list of folder names with no "/", such as "node_modules"',
  ],
  boolean: [(value) => typeof value === 'boolean', 'true or false'],
  positive: [(value) => Number.isInteger(value) && value > 0, 'a whole number above 0'],
  percent: [(value) => Number.isInteger(value) && value > 0 && value <= 100, 'a whole number from 1 to 100'],
  zeroOrMore: [(value) => Number.isInteger(value) && value >= 0, 'a whole number, 0 or more'],
  // At 1 a call costs what it would in a fresh session, so a handoff saves nothing; under 1.1 the saving per call is
  // too small for a handoff to pay back its own calls.
  costRatio: [(value) => typeof value === 'number' && Number.isFinite(value) && value >= 1.1, 'a number of 1.1 or more'],
  commitFields: [(value) => Array.isArray(value) && value.every((f) => COMMIT_FIELDS.includes(f)), `a list of ${COMMIT_FIELDS.map((f) => `"${f}"`).join(', ')}`],
  prFields: [(value) => Array.isArray(value) && value.every((f) => PR_FIELDS.includes(f)), `a list of ${PR_FIELDS.map((f) => `"${f}"`).join(', ')}`],
  handoffMode: [(value) => HANDOFF_MODES.includes(value), '"off", "ask", or "auto"'],
  readyMode: [(value) => ['ask', 'auto'].includes(value), '"ask" or "auto"'],
  extraMode: [(value) => ['off', 'ask', 'auto'].includes(value), '"off", "ask", or "auto"'],
  onOff: [(value) => ['on', 'off'].includes(value), '"on" or "off"'],
  mergeStrategy: [(value) => [null, 'squash', 'merge', 'rebase'].includes(value), 'null, "squash", "merge", or "rebase"'],
  // One agent a dispatch names. "*" and "main" select gates in `agents`, every agent and the main session; neither is one agent.
  agentName: [(value) => isText(value) && value !== ALL && value !== MAIN && !agentNameProblem(value), 'an agent name such as code-reviewer'],
  quorumProvider: [(value) => ['agent', 'codex'].includes(value), '"agent" or "codex"'],
  objectionCap: [(value) => Number.isInteger(value) && value >= 1 && value <= MAX_PLAN_OBJECTIONS, `a whole number from 1 to ${MAX_PLAN_OBJECTIONS}`],
  // The least a plan run needs: two objection dispatches, one ruling, one Codex fallback, and the reserved proportionality pass.
  dispatchCap: [(value) => Number.isInteger(value) && value >= 5, 'a whole number, 5 or more'],
  quorumApproval: [(value) => ['first', 'review-later'].includes(value), '"first" or "review-later"'],
  autoRuns: [(value) => Number.isInteger(value) && value >= 1 && value <= 10, 'a whole number from 1 to 10'],
  issueCreationMode: [(value) => ['confirm', 'auto'].includes(value), '"confirm" or "auto"'],
  // The duplicate search queries the labels with no placeholder, so at least one is fixed.
  auditLabels: [
    (value) => Array.isArray(value) && value.every(isAuditLabel) && value.some((label) => !label.includes('{')),
    `a list of labels, each plain or holding ${AUDIT_LABEL_FIELDS.map((f) => `{${f}}`).join(' or ')}, with at least one plain label`,
  ],
  versionOrNull: [(value) => value === null || (typeof value === 'string' && SEMVER.test(value)), 'a plugin version such as "0.17.0", or null'],
  // The part of an issue key before its "-<n>", so a hyphen or a space would never match a key.
  teamKey: [(value) => isText(value) && !/[-\s]/u.test(value), 'a non-empty string with no hyphen or whitespace, such as NOTES'],
  decisionMode: [(value) => DECISION_MODES.includes(value), '"ask" or "decide-reversible"'],
  domainMode: [(value) => value === 'inherit' || DECISION_MODES.includes(value), '"ask", "decide-reversible", or "inherit"'],
  // `group` is the keys beside this one, so an `escalate` entry may name a class of a valid `classes` beside it.
  decisionClasses: [
    (value, group) => {
      const own = isProjectClasses(group?.classes) ? Object.keys(group.classes) : [];
      return Array.isArray(value) && value.every((kind) => decisionClasses().includes(kind) || own.includes(kind));
    },
    'a list of decision classes of lib/decisions.json or decisions.classes, which `aidrian decisions resolve --vocab` lists',
  ],
  projectClasses: [
    (value) => isProjectClasses(value),
    `an object of new class names, each lowercase letters, digits, and "-", at most ${CLASS_MAX} characters, to a one-line definition; a class of lib/decisions.json cannot be redefined or removed`,
  ],
  safeDefaults: [(value) => SAFE_DEFAULTS.includes(value), '"outside-escalated" or "all"'],
  secondLookOrNull: [
    (value) => value === null || (hasOnly(value, ['agent', 'minSeverity']) && TYPES.agentName[0](value.agent) && dispositionTable().severities.includes(value.minSeverity)),
    () => `null, or { "agent": an agent name, "minSeverity": ${oneOf(dispositionTable().severities)} }`,
  ],
  docPaths: [
    (value) => Array.isArray(value) && value.every(isDocPath),
    'a list of paths from the project root, each a file, a "file#section", or a folder such as "docs/legal/" for everything in it; no glob characters, absolute path, or ".."',
  ],
  decisionQueue: [(value) => ['pr-body', 'report'].includes(value), '"pr-body" or "report"'],
  remindMode: [(value) => ['session-start', 'off'].includes(value), '"session-start" or "off"'],
  pauseOrNull: [
    (value) => value === null || (hasOnly(value, ['pending', 'oldestDays']) && [value.pending, value.oldestDays].every((n) => Number.isInteger(n) && n > 0)),
    'null, or { "pending", "oldestDays" }, each a whole number above 0',
  ],
};

export const oneOf = (list) => `${list.slice(0, -1).map((each) => JSON.stringify(each)).join(', ')}, or ${JSON.stringify(list.at(-1))}`;
