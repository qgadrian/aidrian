// Loads config.json from the project folder: the folder version and the project's settings for this plugin.
// docs/config.md lists the keys; docs/project-folder.md gives the version rule.
// No dependencies: this file runs from the installed plugin, which has no node_modules.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { agentNameProblem, ALL, MAIN, nameMatches, patternProblem } from './agent-gates.mjs';
import { CLASS_MAX, DECISION_DOMAINS, DECISION_MODES, decisionClasses, isClassName, lowerMode, SAFE_DEFAULTS } from './decisions.mjs';
import { loadTable as dispositionTable } from './finding-disposition.mjs';
import { isFile, isObject, readJson } from './fs.mjs';
import { hookForms, modelChoices, reachesAHook, UNKNOWN_HOST } from './hosts/index.mjs';
import { checkLocalReview, checkLocalVisual, checkReview, REVIEW_DEFAULTS } from './review/config.mjs';
import { keyServer, serverPrefix } from './tracker-guard.mjs';
import { expandTracker, knownServers, TRACKERS, trackerById } from './trackers/index.mjs';

// The project folder format this plugin reads. A format change raises it and documents the migration.
export const VERSION = 1;

// The `github.reviewer` that turns the review bot off, as null does.
export const NO_REVIEWER = 'none';

// The keys of the `git` group: the repository's branches, worktrees, checkout, and commits.
const GIT_SCHEMA = {
  defaultBranch: 'text',
  worktrees: { dir: 'text', bootstrap: 'textOrNull', disposable: 'folderNames' },
  mainCheckout: { guard: 'boolean', allowWrites: 'texts' },
  commits: { types: 'someTexts' },
};

// The most objections one plan adversary may raise in a ledger that carries `mode`: the ceiling of
// `quorum.plan.maxObjections`, its default, and the cap lib/quorum.mjs holds a ledger to when no config sets one.
export const MAX_PLAN_OBJECTIONS = 5;

// The keys of the `quorum` group: the quorum skill's roles, providers, judge, and caps (skills/quorum/).
// Plan adversary A takes no provider: its briefs read the ledger, and `aidrian quorum codex --mode rebut` answers only
// B's objections, so A has no Codex path, and a `provider` on it is an unknown key.
const QUORUM_RUNNER = { provider: 'quorumProvider', agent: 'agentName' };
const QUORUM_SCHEMA = {
  judge: { agent: 'agentName' },
  plan: { a: { agent: 'agentName' }, b: QUORUM_RUNNER, maxObjections: 'objectionCap', maxDispatches: 'dispatchCap' },
  decide: { odd: QUORUM_RUNNER, even: QUORUM_RUNNER, swap: 'boolean' },
  product: { owner: { agent: 'agentName' }, witness: { agent: 'agentName' }, ux: { agent: 'agentName' }, engineer: { agent: 'agentName' }, maxLoops: 'objectionCap', autoStart: 'boolean', approval: 'quorumApproval', maxAutoRuns: 'autoRuns' },
};

// The keys of `tracker` with no default: `provider` and `servers` say how to fill the rest, and the others come from an adapter
// or a key written out (checkTracker).
const TRACKER_SHORT_KEYS = ['provider', 'servers', 'workspaceInput', 'readVerbs', 'idHint'];
// A server's name in mcp__<server>__<tool>: it holds no `*`, and a double underscore would end it early (tracker-guard.mjs).
const SERVER_NAME = /^(?!.*__)[\w-]+$/u;
// The keys of each group of `tracker`. Unlike a group of SCHEMA, one of these is set whole or not at all (checkTracker).
const TRACKER_GROUPS = {
  workspace: { expect: 'text', field: 'text' },
  team: { key: 'teamKey', values: 'someTexts', createFields: 'someTexts', keyFields: 'someTexts' },
  project: { values: 'someTexts', field: 'text' },
};

// The keys of the `decisions` group: how far agents may settle product and design decisions (lib/decisions.mjs).
const DECISIONS_SCHEMA = {
  mode: 'decisionMode',
  maxMode: 'decisionMode',
  domains: Object.fromEntries(DECISION_DOMAINS.map((domain) => [domain, 'domainMode'])),
  classes: 'projectClasses',
  escalate: 'decisionClasses',
  escalateDocs: 'docPaths',
  unattended: { safeDefaults: 'safeDefaults' },
  secondLook: 'secondLookOrNull',
  record: { queue: 'decisionQueue' },
  unreviewed: { remind: 'remindMode', pauseDomainAt: 'pauseOrNull' },
};

// The `decisions` keys the local file may set; localDecisions holds each to the team's ceiling.
const LOCAL_DECISIONS_SCHEMA = { mode: 'decisionMode', domains: DECISIONS_SCHEMA.domains, unreviewed: DECISIONS_SCHEMA.unreviewed };

// The type of every key. A nested object is one group of keys; a project sets any subset of a group.
const SCHEMA = {
  git: GIT_SCHEMA,
  state: { dir: 'textOrNull' },
  github: {
    requiredSections: 'texts',
    reviewer: 'textOrNull',
    maxReviewRounds: 'positive',
    extraRounds: 'extraMode',
    maxExtraRounds: 'zeroOrMore',
    requiredChecks: 'texts',
    ignoreCancelledChecks: 'texts',
    conditionalChecks: 'texts',
    titleIssuePrefix: 'boolean',
    markReady: 'readyMode',
    reviewLoop: 'readyMode',
    pullRequest: {
      title: 'patternOrNull',
      issueKey: 'patternOrNull',
      sections: 'textsOrNull',
      deferrals: 'deferralsOrNull',
      residuals: 'residualsOrNull',
      sharedTempBodyFile: 'boolean',
      duplicateBody: 'boolean',
    },
    reviewGate: { enabled: 'boolean', checklist: 'textOrNull' },
    autoMerge: { allow: 'boolean', default: 'onOff', strategy: 'mergeStrategy', deleteBranch: 'boolean', deleteWorktree: 'boolean' },
  },
  review: 'review',
  docs: { wrapLimit: 'zeroOrMore' },
  terms: { file: 'textOrNull' },
  knowledge: { budgets: { alwaysBytes: 'positive', taggedDocBytes: 'positive' } },
  skills: { descriptionChars: 'positive', listingBytes: 'positive' },
  session: { handoff: { mode: 'handoffMode', costRatio: 'costRatio', maxTokens: 'zeroOrMore' } },
  lessons: { auto: 'boolean', maxOpen: 'zeroOrMore', maxAgeDays: 'zeroOrMore' },
  models: 'models',
  names: { human: 'text', ai: 'textOrNull' },
  attribution: { commit: 'commitFields', pullRequest: 'prFields', exclude: 'texts' },
  telemetry: {
    enabled: 'boolean',
    docReads: 'boolean',
    hookDenies: 'boolean',
    maxMb: 'positive',
    health: {
      minSample: 'positive',
      redispatchPercent: 'percent',
      sentBackPercent: 'percent',
      topDocPercent: 'percent',
      reviewRounds: 'positive',
      lateFindingPercent: 'percent',
      denyHotSpot: 'positive',
      costRisePercent: 'positive',
      decisionOverridePercent: 'percent',
      decisionMinSample: 'positive',
    },
  },
  agents: 'agents',
  requires: { aidrian: 'versionOrNull' },
  quorum: QUORUM_SCHEMA,
  decisions: DECISIONS_SCHEMA,
  audits: { triage: { issueCreation: 'issueCreationMode', labels: 'auditLabels' } },
  tracker: 'tracker',
};

// Keys a format change renamed or moved, old name to new; a key inside a group is named with its group, "group.key".
// A config that still uses the old name gets an error naming the new one.
const RENAMED = {
  pr: 'github',
  'docs.alwaysBudgetBytes': 'knowledge.budgets.alwaysBytes',
  'telemetry.doc_reads': 'telemetry.docReads',
  'telemetry.hook_denies': 'telemetry.hookDenies',
  'telemetry.max_mb': 'telemetry.maxMb',
  'session.maxTokens': 'session.handoff.maxTokens',
};

// Keys a format change took out, with why; a config that still sets one gets an error, and its value is not carried.
const REMOVED = {
  'session.maxCalls': 'the session-length reminder weighs cost, not calls',
  'session.maxHours': 'the session-length reminder weighs cost, not hours',
};

// The modes a string `session.handoff` held before the handoff settings became a group.
const HANDOFF_MODES = ['off', 'ask', 'auto'];

// What `models` may set for one of this plugin's agents, per host; null takes any non-empty string.
// The fields config.json `attribution` may list (lib/attribution.mjs).
export const COMMIT_FIELDS = ['agent', 'model', 'effort', 'tool', 'env'];
export const PR_FIELDS = ['tool', 'model', 'effort', 'env', 'agents'];

// Each host's adapter says what it takes (lib/hosts/); docs/config.md#models cites them.
const MODEL_CHOICES = modelChoices();

const SEMVER = /^\d+\.\d+\.\d+$/u;
// The placeholders an audit label may hold, filled per finding (lib/audits.mjs issueLabels).
export const AUDIT_LABEL_FIELDS = ['persona', 'severity'];
const isAuditLabel = (value) => isText(value) && [...value.matchAll(/[{}]/gu)].length === 2 * [...value.matchAll(/\{(\w+)\}/gu)].filter(([, field]) => AUDIT_LABEL_FIELDS.includes(field)).length;
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isTexts = (value) => Array.isArray(value) && value.every(isText);
// A regular expression a project writes as a string; `{types}` and `{issueKey}` are filled in before it compiles
// (lib/rules/github/pr-body.mjs), so they are checked filled with a plain word.
const isPattern = (value) => {
  if (!isText(value)) return false;
  try {
    new RegExp(value.replaceAll('{types}', 'x').replaceAll('{issueKey}', 'x'), 'u');
    return true;
  } catch {
    return false;
  }
};
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
const TYPES = {
  text: [isText, 'a non-empty string'],
  textOrNull: [(value) => value === null || isText(value), 'a non-empty string or null'],
  texts: [isTexts, 'a list of non-empty strings'],
  someTexts: [(value) => isTexts(value) && value.length > 0, 'a non-empty list of non-empty strings'],
  textsOrNull: [(value) => value === null || isTexts(value), 'a list of non-empty strings, or null'],
  patternOrNull: [(value) => value === null || isPattern(value), 'a regular expression as a string, or null'],
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

// `state.dir: null` is the per-project folder under `$XDG_STATE_HOME` (lib/project.mjs). Task worktrees sit beside the
// repository's files, where editors and agents expect them; the guard is off until a project opts in.
// `git.worktrees.disposable` names the folders of installed packages, build output, and caches, which a worktree cleanup
// may delete without asking (lib/worktree.mjs).
// `names.ai: null` is the host's own name, which only the running hook knows. `github.reviewer: null`, or "none", which
// loadConfig reads as null, runs no review bot: `aidrian pr await-review` then waits for nothing.
export const DEFAULTS = deepFreeze({
  git: {
    defaultBranch: 'main',
    worktrees: { dir: '.worktrees', bootstrap: null, disposable: ['node_modules', 'dist', 'build', '.next', '.cache', 'coverage', '.turbo'] },
    mainCheckout: { guard: false, allowWrites: [] },
    commits: { types: ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'] },
  },
  state: { dir: null },
  github: {
    requiredSections: ['Summary', 'Tests run'],
    reviewer: 'chatgpt-codex-connector[bot]',
    maxReviewRounds: 3,
    // What happens at that cap (lib/review/extension.mjs): "ask" checks whether one more round is warranted and asks
    // the Human; "auto" grants it on the judge's word; "off" stops. maxExtraRounds is the hard ceiling on grants.
    extraRounds: 'ask',
    maxExtraRounds: 2,
    requiredChecks: [],
    ignoreCancelledChecks: [],
    conditionalChecks: [],
    titleIssuePrefix: false,
    // Who marks a draft ready: the loop once review signed off and the checks are green ("auto"); or the author, or the
    // loop when the Human asks ("ask").
    markReady: 'auto',
    // What follows the pr-write skill: the session starts the review loop at once ("auto"), or offers it ("ask").
    reviewLoop: 'auto',
    // The pull request contract the pull request body rule holds beyond requiredSections (lib/rules/github/pr-body.mjs).
    pullRequest: { title: null, issueKey: null, sections: null, deferrals: null, residuals: null, sharedTempBodyFile: true, duplicateBody: false },
    // The review that must be on record before the review bot is asked (lib/review-gate.mjs).
    reviewGate: { enabled: false, checklist: null },
    // The team's ceiling on auto-merge: no machine merges a pull request unless `allow` is true. `strategy: null` leaves
    // the choice to pr-merge-when-green's order: squash, then merge, then rebase, among those the repository allows.
    // A machine opts in under it from the local file (resolveAutoMerge).
    autoMerge: { allow: false, default: 'off', strategy: null, deleteBranch: false, deleteWorktree: false },
  },
  // How a pull request is reviewed (lib/review/, docs/review.md).
  review: REVIEW_DEFAULTS,
  docs: { wrapLimit: 155 },
  // The terms file (lib/terms.mjs); null turns the terms rule off.
  terms: { file: null },
  knowledge: { budgets: { alwaysBytes: 16384, taggedDocBytes: 24576 } },
  skills: { descriptionChars: 160, listingBytes: 9216 },
  // The session-length reminder (lib/session-length.mjs, docs/handoff.md): it fires once a call costs `costRatio` times
  // what it would in a fresh session; `maxTokens` is an optional ceiling on the context, 0 for off.
  session: { handoff: { mode: 'ask', costRatio: 2, maxTokens: 0 } },
  lessons: { auto: true, maxOpen: 20, maxAgeDays: 14 },
  models: Object.fromEntries(Object.keys(MODEL_CHOICES).map((key) => [key, { agents: {} }])),
  names: { human: 'the Human', ai: null },
  // The oldest plugin the project's config needs; null asks for none (versionFloorProblem).
  requires: { aidrian: null },
  // What a commit and a pull request say about the agents that wrote them (lib/attribution.mjs); [] is off. `exclude`
  // names the agents a pull request's `Assisted-by:` lines leave out: by default the ones that only search and read.
  attribution: { commit: [], pullRequest: [], exclude: ['explorer', 'helper-scout', 'Explore', 'claude-code-guide', 'statusline-setup'] },
  telemetry: {
    enabled: true,
    docReads: true,
    hookDenies: true,
    maxMb: 20,
    // The thresholds of `aidrian report health` (report-health.mjs). A signal with fewer than minSample samples is not judged.
    health: {
      minSample: 5,
      redispatchPercent: 20,
      sentBackPercent: 10,
      topDocPercent: 50,
      reviewRounds: 3,
      lateFindingPercent: 50,
      denyHotSpot: 5,
      costRisePercent: 50,
      // The share of the decisions the Human reviewed that the Human overrode, over decisionMinSample of them.
      decisionOverridePercent: 20,
      decisionMinSample: 5,
    },
  },
  agents: {},
  // The quorum skill's roles and caps, today's by default. `agent` is a role's agent on provider "agent", and its
  // fallback on "codex". `decide.odd` runs positions A and C, `decide.even` B and D; `swap` turns the odd-hash claim swap on.
  quorum: {
    judge: { agent: 'architect' },
    plan: {
      a: { agent: 'code-reviewer' },
      b: { provider: 'codex', agent: 'product-manager' },
      maxObjections: MAX_PLAN_OBJECTIONS,
      maxDispatches: 8,
    },
    decide: {
      odd: { provider: 'agent', agent: 'code-reviewer' },
      even: { provider: 'codex', agent: 'code-reviewer' },
      swap: true,
    },
    product: {
      owner: { agent: 'product-manager' },
      witness: { agent: 'ux-researcher' },
      ux: { agent: 'ux-specialist' },
      engineer: { agent: 'architect' },
      maxLoops: 2,
      // What `aidrian quorum route` reads, always from the base branch (committedQuorumProduct): nobody gets an
      // automatic run, or work that continues before the Human approves, without committing to it.
      autoStart: false,
      approval: 'first',
      maxAutoRuns: 3,
    },
  },
  // How far agents may settle product and design decisions (lib/decisions.mjs, docs/config.md#decisions): every
  // decision goes to the Human, and nothing raises `mode` past `maxMode`, so a team opts in by committing a higher one.
  decisions: {
    mode: 'ask',
    maxMode: 'ask',
    domains: Object.fromEntries(DECISION_DOMAINS.map((domain) => [domain, 'inherit'])),
    classes: {},
    escalate: [],
    escalateDocs: [],
    // What an unattended run may settle with a safe default (unattendedAnswer).
    unattended: { safeDefaults: 'outside-escalated' },
    secondLook: { agent: 'critic', minSeverity: 'high' },
    record: { queue: 'pr-body' },
    unreviewed: { remind: 'session-start', pauseDomainAt: { pending: 10, oldestDays: 7 } },
  },
  // How the persona-audit-triage skill files issues (lib/audits.mjs, docs/personas.md#triage): "confirm" shows each
  // draft and creates nothing before the Human's yes; "auto" creates without asking, for unsupervised runs. Every issue
  // gets each label, `{persona}` and `{severity}` filled from its finding.
  audits: { triage: { issueCreation: 'confirm', labels: ['persona-audit', 'persona:{persona}', 'severity:{severity}'] } },
  // The tracker write guard's values (docs/config.md#tracker): off until a project sets them; a null group is unset.
  tracker: { enabled: false, workspace: null, readTools: [], writeTools: [], team: null, project: null },
  reviewEngine: 'auto',
  reviewVisual: { baseUrl: null },
});

// Returns { config, errors, gateErrors, current }. `config` is frozen and always complete: the file's values over DEFAULTS, one
// group at a time, with the default kept for any value that is missing or invalid. The local file's `models`, `names`,
// `telemetry`, and `agents` (`project.localModels`, `project.localNames`, `project.localTelemetry`, `project.localAgents`) then
// go over the file's. A hook can use it even when `errors` is not empty. `current` is false when the file is missing,
// unreadable, or of another version: then nothing in the folder
// can be trusted to have the shape this plugin reads. `gateErrors` holds the errors of `errors` that dropped a gate,
// as { file, problem }: see checkAgents.
export function loadConfig(project) {
  const errors = [];
  const gateErrors = [];
  const file = project.paths.config;
  const raw = readJson(project.root, file, errors);
  if (!raw) return { config: DEFAULTS, errors, gateErrors, current: false };
  const problem = versionProblem(file, raw.version);
  if (problem) return { config: DEFAULTS, errors: [problem], gateErrors, current: false };
  const { version, ...rest } = raw;
  const values = legacyHandoff(rest, file, errors);
  const config = merge(SCHEMA, DEFAULTS, values, '', file, errors, gateErrors);
  if (config.github.reviewer === NO_REVIEWER) config.github = { ...config.github, reviewer: null };
  if (project.localModels !== undefined) config.models = checkModels(project.localModels, project.paths.local, errors, config.models);
  for (const [key, local] of [['names', project.localNames], ['telemetry', project.localTelemetry]]) {
    if (local !== undefined) config[key] = merge({ [key]: SCHEMA[key] }, config, { [key]: local }, '', project.paths.local, errors)[key];
  }
  // The machine's review engine, from the local file; config.json `review.engine`, when set, wins (lib/review/reviewers.mjs).
  config.reviewEngine = project.localReview === undefined ? 'auto' : checkLocalReview(project.localReview, project.paths.local, errors);
  config.reviewVisual = checkLocalVisual(project.localReview, project.paths.local, errors);
  if (project.localAgents !== undefined) config.agents = checkAgents(project.localAgents, project.paths.local, errors, config.agents, gateErrors);
  config.decisions = localDecisions(config.decisions, project, errors);
  return { config: deepFreeze(config), errors, gateErrors, current: true };
}

// The project config as committed at `commit`, with no machine settings: what a pull request cannot change from its
// own working copy, such as github.maxReviewRounds. A commit with no config, or one that does not parse, gives
// DEFAULTS; a value that fails its check keeps its default, as loadConfig does, and goes to `errors` when the caller
// passes that list.
export function committedConfig(project, commit, errors = []) {
  // `./`: the path from project.root, where git runs, so a project below the repository root reads its own file.
  const shown = spawnSync('git', ['show', `${commit}:./${project.paths.config}`], { cwd: project.root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
  if (shown.error || shown.signal) throw new Error(`git show ${commit}:./${project.paths.config} failed: ${shown.error?.message ?? shown.signal}`);
  return configFromText(shown.status === 0 ? shown.stdout : null, project.paths.config, errors);
}

// The project config committed as `text` at `file`, with no machine settings, by committedConfig's rules: null (no file)
// or text that does not parse gives DEFAULTS, and a value that fails its check keeps its default and goes to `errors`.
// For a commit read some other way, such as a base branch read through GitHub.
export function configFromText(text, file, errors = []) {
  if (typeof text !== 'string') return DEFAULTS;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULTS;
  }
  if (!isObject(raw) || versionProblem(file, raw.version)) return DEFAULTS;
  const { version, ...rest } = raw;
  const config = merge(SCHEMA, DEFAULTS, legacyHandoff(rest, file, errors), '', file, errors, []);
  if (config.github.reviewer === NO_REVIEWER) config.github = { ...config.github, reviewer: null };
  return deepFreeze(config);
}

// configFromText for a reader that must not take a broken file for the defaults: text that does not parse, is no object,
// or has another version throws, and so does an error `fatal` picks out. Null, no file, is still the defaults.
export function strictConfigFromText(text, file, fatal = () => false) {
  if (typeof text !== 'string') return DEFAULTS;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error.message})`);
  }
  if (!isObject(raw)) throw new Error(`${file}: must be a JSON object`);
  const problem = versionProblem(file, raw.version);
  if (problem) throw new Error(problem);
  const errors = [];
  const config = configFromText(text, file, errors);
  const broken = errors.find(fatal);
  if (broken) throw new Error(broken);
  return config;
}

// `team`, the `decisions` of config.json, with the local file's `decisions` over it, as `project.localDecisions` holds
// it. The local file may set `mode` and `domains`, each held to the team's `maxMode`; `unreviewed.remind`; and
// `unreviewed.pauseDomainAt`, of which only a value lower than the team's applies, one limit at a time. Any other key
// is an error, and keeps the team's value. A key the local file does not set stays as the team wrote it, even above
// `maxMode`, so the resolver and `aidrian check` can say so. `errors` gets the problems; a caller that already reported
// them passes [].
export function localDecisions(team, project, errors) {
  const local = project.localDecisions;
  const file = project.paths.local;
  if (local === undefined) return team;
  if (!isObject(local)) {
    errors.push(`${file}: "decisions" must be an object`);
    return team;
  }
  const teamOnly = (key) => Object.hasOwn(DECISIONS_SCHEMA, key) && !Object.hasOwn(LOCAL_DECISIONS_SCHEMA, key);
  for (const key of Object.keys(local).filter(teamOnly)) errors.push(`${file}: "decisions.${key}" is the team's: set it in config.json`);
  const own = Object.fromEntries(Object.entries(local).filter(([key]) => !teamOnly(key)));
  const read = merge(LOCAL_DECISIONS_SCHEMA, team, own, 'decisions.', file, errors);
  // `merge` keeps the team's value for a key that is unset or refused, so `read` holds the local value only when `set` is it.
  const capped = (set, mode) => (set !== mode || mode === 'inherit' ? mode : lowerMode(mode, team.maxMode));
  return {
    ...team,
    mode: capped(own.mode, read.mode),
    domains: Object.fromEntries(Object.entries(read.domains).map(([domain, mode]) => [domain, capped(own.domains?.[domain], mode)])),
    unreviewed: { remind: read.unreviewed.remind, pauseDomainAt: lowerPause(team.unreviewed.pauseDomainAt, read.unreviewed.pauseDomainAt) },
  };
}

// The pause limits a local value may set over the team's: each limit the lower of the two; a null team value has no
// limits, so any local one is lower, and a null local value raises nothing.
function lowerPause(team, local) {
  if (local === null || local === team) return team;
  if (team === null) return local;
  return { pending: Math.min(team.pending, local.pending), oldestDays: Math.min(team.oldestDays, local.oldestDays) };
}

// The team's `decisions` at `commit`, from the config file `file` that commit names (project.mjs committedConfigFile),
// with what committedConfig does not say: a commit where that file is missing, does not parse, or has another version,
// or `file` null, has no team block to read, and one with an error under `decisions` has a block no one can read as the
// team meant it. Either way the ceiling is "ask", spelled here so it does not follow the default, and the block's other
// values are the defaults, not a partial block's. committedConfig returns DEFAULTS itself only in the first cases.
// No one can say what such a block listed, so `safeDefaults` is null, which no config can set, and an unattended run parks:
// a commit whose config.json is missing, does not parse, or has another version, and one with an error under `decisions`.
// A config.json with no `decisions` key says nothing to misread: it takes the defaults, as any other unset group does.
export const committedDecisions = (project, commit, file) => committedAuthority(project, commit, file).decisions;

// committedDecisions' block and `autoMergeAllow`, whether that same commit sets `github.autoMerge.allow` true: false for a
// block no one can read, since its team said nothing anyone can read. resolveAuthority takes it as the team's acceptance.
export function committedAuthority(project, commit, file) {
  const askOnly = { decisions: { ...DEFAULTS.decisions, maxMode: 'ask', unattended: { safeDefaults: null } }, autoMergeAllow: false };
  if (file === null) return askOnly;
  const errors = [];
  const committed = committedConfig({ ...project, paths: { ...project.paths, config: file } }, commit, errors);
  if (committed === DEFAULTS || errors.some((error) => /"decisions[".]/u.test(error))) return askOnly;
  return { decisions: committed.decisions, autoMergeAllow: committed.github.autoMerge.allow === true };
}

// The team's `quorum.product` at `commit`, from the config file `file` that commit names, as committedAuthority finds it:
// the defaults, which are off, for a commit with no readable config, `file` null, or an error in this block, which no one
// can read as the team meant it. An error elsewhere in the config leaves this block readable.
export function committedQuorumProduct(project, commit, file) {
  if (file === null) return DEFAULTS.quorum.product;
  const errors = [];
  const committed = committedConfig({ ...project, paths: { ...project.paths, config: file } }, commit, errors);
  return errors.some((error) => /"quorum(?:"|\.product[".])/u.test(error)) ? DEFAULTS.quorum.product : committed.quorum.product;
}

// Whether auto-merge is on, from a `github` config and the local file's switch (`project.localAutoMerge`, "on",
// "off", or "unset"): { effective, reason }. It is on only when the team allows it and the machine's switch is "on", or
// is "unset" under the team's `default` "on". A machine can lower the team's choice but never pass `allow`. `reason` names the
// side that keeps it off, "team" or "local", and is null when it is on. A pure function of its inputs, so a caller may
// pass the github config of any commit, such as committedConfig's, instead of the working copy's.
export function resolveAutoMerge(github, local) {
  if (github?.autoMerge?.allow !== true) return { effective: false, reason: 'team' };
  const on = local === 'on' || (local === 'unset' && github.autoMerge.default === 'on');
  if (!on) return { effective: false, reason: 'local' };
  return { effective: true, reason: null };
}

// The `code` of the error commandConfig throws; cli.mjs prints its message and exits with its `exitCode`.
export const CONFIG_ERROR = 'ERR_AIDRIAN_CONFIG';

// The config an `aidrian` command acts on. When loadConfig reports errors, the command must not run on defaults the
// project did not choose, so this throws: the message lists the errors, and `exitCode` is the command's error code.
// A project with no config.json yet runs on DEFAULTS. Hooks call loadConfig instead: a broken config never stops a session.
export function commandConfig(project, { exitCode = 1 } = {}) {
  const { config, errors } = loadConfig(project);
  if (!errors.length || !isFile(path.join(project.root, project.paths.config))) return config;
  throw Object.assign(new Error(errors.join('\n')), { code: CONFIG_ERROR, exitCode });
}

const manifest = () => JSON.parse(readFileSync(path.join(import.meta.dirname, '../plugin.json'), 'utf8'));

// The version of this plugin copy, from its manifest.
export const pluginVersion = () => manifest().version;

// The repository the plugin's manifest names, such as `https://github.com/<owner>/<repo>`, or null.
export const pluginRepository = () => {
  const { repository } = manifest();
  return typeof repository === 'string' && repository.trim() ? repository.trim() : null;
};

// Whether semver `a` is older than `b`; both are x.y.z.
const older = (a, b) => {
  const [x, y] = [a, b].map((each) => each.split('.').map(Number));
  const at = x.findIndex((part, i) => part !== y[i]);
  return at !== -1 && x[at] < y[at];
};

// The problem when this plugin copy is older than the version the project requires (`requires` in config.json), or null. It names the copy that
// runs, because a session can load an older install than the one the project was set up with.
export function versionFloorProblem(config, running = pluginVersion()) {
  const { aidrian: floor } = config.requires ?? {};
  if (!floor || !older(running, floor)) return null;
  const root = path.resolve(import.meta.dirname, '..');
  return `this project requires aidrian ${floor} or later, and this session runs ${running} from ${root}: update the plugin, then start a new session`;
}

// The error for a `version` other than VERSION, or null.
export function versionProblem(file, version) {
  if (version === VERSION) return null;
  const found = version === undefined ? 'missing' : JSON.stringify(version);
  return `${file}: project folder version ${found}; this plugin reads version ${VERSION}; see ${migratingUrl()}`;
}

// The migration notes in the repository the plugin's manifest names, so a fork links to its own.
function migratingUrl() {
  return `${pluginRepository()}/blob/main/docs/project-folder.md#migrating`;
}

// The values with a string `session.handoff`, the mode it held before the handoff settings became a group, read as
// `{ mode }`, so a legacy "off" keeps the hooks quiet. The old shape is reported. This is no RENAMED entry: that flags
// a key by its name, and the new group has the same name.
function legacyHandoff(values, file, errors) {
  const handoff = isObject(values.session) ? values.session.handoff : undefined;
  if (!HANDOFF_MODES.includes(handoff)) return values;
  errors.push(`${file}: "session.handoff" is now "session.handoff.mode": move it`);
  return { ...values, session: { ...values.session, handoff: { mode: handoff } } };
}

function merge(schema, defaults, values, prefix, file, errors, gateErrors = []) {
  for (const key of Object.keys(values)) {
    const name = `${prefix}${key}`;
    if (Object.hasOwn(RENAMED, name)) errors.push(`${file}: "${name}" is now "${RENAMED[name]}": rename the key`);
    else if (Object.hasOwn(REMOVED, name)) errors.push(`${file}: "${name}" is gone: ${REMOVED[name]}; delete the key`);
    else if (!Object.hasOwn(schema, key)) errors.push(`${file}: unknown key "${name}"`);
  }
  const out = {};
  for (const [key, type] of Object.entries(schema)) {
    const value = values[key];
    out[key] = defaults[key];
    if (!Object.hasOwn(values, key)) continue;
    if (typeof type === 'object') {
      if (isObject(value)) out[key] = merge(type, defaults[key], value, `${prefix}${key}.`, file, errors, gateErrors);
      else errors.push(`${file}: "${prefix}${key}" must be an object`);
    } else if (type === 'models') {
      out[key] = checkModels(value, file, errors, defaults[key]);
    } else if (type === 'review') {
      out[key] = checkReview(value, file, errors);
    } else if (type === 'agents') {
      out[key] = checkAgents(value, file, errors, defaults[key], gateErrors);
    } else if (type === 'tracker') {
      out[key] = checkTracker(value, file, errors, defaults[key]);
    } else if (TYPES[type][0](value, values)) {
      out[key] = value;
    } else {
      const must = TYPES[type][1];
      errors.push(`${file}: "${prefix}${key}" must be ${typeof must === 'function' ? must() : must}`);
    }
  }
  return out;
}

// `models` from one file over `base`, per host, agent, and field: { claude: { agents }, codex: { agents } }.
// A bad host, agent, or value is an error and is left out, so the rest still applies.
function checkModels(value, file, errors, base) {
  const out = Object.fromEntries(Object.keys(MODEL_CHOICES).map((host) => [host, { agents: { ...base[host].agents } }]));
  if (!isObject(value)) {
    errors.push(`${file}: "models" must be an object`);
    return out;
  }
  for (const [host, groups] of Object.entries(value)) {
    const at = `models.${host}`;
    if (!Object.hasOwn(MODEL_CHOICES, host)) errors.push(`${file}: unknown key "${at}"`);
    else if (!isObject(groups)) errors.push(`${file}: "${at}" must be an object`);
    else {
      for (const [key, agents] of Object.entries(groups)) {
        if (key === 'skills') errors.push(`${file}: "${at}.skills" is not supported: neither host lets a project set a plugin skill's model or effort`);
        else if (key !== 'agents') errors.push(`${file}: unknown key "${at}.${key}"`);
        else if (!isObject(agents)) errors.push(`${file}: "${at}.agents" must be an object`);
        else for (const [name, choice] of Object.entries(agents)) checkAgentChoice(host, name, choice, out[host].agents, file, errors);
      }
    }
  }
  return out;
}

function checkAgentChoice(host, name, choice, agents, file, errors) {
  const at = `models.${host}.agents.${name}`;
  if (!pluginAgents().includes(name)) {
    errors.push(`${file}: unknown agent "${at}"; the plugin's agents are ${pluginAgents().join(', ')}`);
    return;
  }
  if (!isObject(choice)) {
    errors.push(`${file}: "${at}" must be an object with "model", "effort", or both`);
    return;
  }
  const kept = {};
  for (const [field, setting] of Object.entries(choice)) {
    const allowed = Object.hasOwn(MODEL_CHOICES[host], field) ? MODEL_CHOICES[host][field] : undefined;
    if (allowed === undefined) errors.push(`${file}: unknown key "${at}.${field}"`);
    else if (allowed === null ? isText(setting) : allowed.includes(setting)) kept[field] = setting;
    else errors.push(`${file}: "${at}.${field}" must be ${allowed === null ? 'a non-empty string' : oneOf(allowed)}`);
  }
  if (Object.keys(kept).length) agents[name] = { ...agents[name], ...kept };
}

// `agents` from one file over `base`, per agent and list: { <name>: { deny, allow } }, each a list of tool patterns.
// A file's `deny` or `allow` for an agent replaces the one below it. A bad name, key, or pattern is an error and is left
// out, so the rest still applies; a pattern left out of `allow` only makes the list stricter. Every other error drops
// a gate (`"allow": "Read"` would allow every tool, `"Deny"` lifts the deny list), so it also goes to `gateErrors`.
function checkAgents(value, file, errors, base, gateErrors = []) {
  const out = { ...base };
  const lost = (problem) => {
    errors.push(`${file}: ${problem}`);
    gateErrors.push({ file, problem });
  };
  if (!isObject(value)) {
    lost('"agents" must be an object');
    return out;
  }
  for (const [name, gates] of Object.entries(value)) {
    const at = `agents.${name}`;
    const problem = agentNameProblem(name);
    if (problem) lost(`"${at}": ${problem}`);
    else if (!isObject(gates)) lost(`"${at}" must be an object with "deny", "allow", or both`);
    else {
      const kept = {};
      for (const [list, patterns] of Object.entries(gates)) {
        if (list !== 'deny' && list !== 'allow') lost(`unknown key "${at}.${list}"`);
        else if (!Array.isArray(patterns)) lost(`"${at}.${list}" must be a list of tool patterns`);
        else {
          kept[list] = patterns.filter((pattern) => {
            const bad = patternProblem(pattern);
            if (!bad) return true;
            const message = `"${at}.${list}" has ${JSON.stringify(pattern)}: ${bad}`;
            if (list === 'deny') lost(message);
            else errors.push(`${file}: ${message}`);
            return false;
          });
        }
      }
      if (Object.keys(kept).length) out[name] = { ...out[name], ...kept };
    }
  }
  return out;
}

// `tracker` from config.json over its defaults. The result never holds what a hook cannot act on: a group with any error
// is unset, `workspace` and `readTools` are both set or both empty, and both go when any read tool has an error, and
// `enabled` needs a write tool to watch and a group to hold it to.
// A pairing error reads what the file set, and only a key of the right type counts as set or unset, so a key that has its
// own error raises no second one, about itself or about what depends on it.
// `provider` names a tracker adapter (lib/trackers/), which fills in the lists and fields the file leaves out, and a list
// or field the file sets overrides it. A key with no `provider` holds every list itself, as it always has.
function checkTracker(raw, file, errors, defaults) {
  if (!isObject(raw)) {
    errors.push(`${file}: "tracker" must be an object`);
    return defaults;
  }
  const provided = checkTrackerProvider(raw, file, errors);
  if (provided === undefined && raw.writeTools === undefined) return defaults;
  const value = provided ? expandTracker(raw, provided) : raw;
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key) && !TRACKER_SHORT_KEYS.includes(key)) errors.push(`${file}: unknown key "tracker.${key}"`);
  for (const key of ['workspaceInput', 'idHint']) if (raw[key] !== undefined && !isText(raw[key])) errors.push(`${file}: "tracker.${key}" must be a non-empty string`);
  if (raw.readVerbs !== undefined && !isTexts(raw.readVerbs)) errors.push(`${file}: "tracker.readVerbs" must be a list of tool patterns after the server`);
  const perCall = isText(value.workspaceInput);
  if (Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean') errors.push(`${file}: "tracker.enabled" must be ${TYPES.boolean[1]}`);
  const workspace = checkTrackerGroup('workspace', value.workspace, file, errors);
  const writeTools = checkToolList('writeTools', 'patterns', value.writeTools, trackerToolProblem, file, errors);
  const readTools = checkToolList('readTools', 'names', value.readTools, (name) => readToolProblem(name, writeTools), file, errors);
  for (const pattern of writeTools) {
    const bad = unreachableWriteProblem(pattern);
    if (bad) errors.push(`${file}: "tracker.writeTools" has ${JSON.stringify(pattern)}: ${bad}`);
  }
  for (const name of readTools) {
    const bad = readToolReport(name, writeTools);
    if (bad) errors.push(`${file}: "tracker.readTools" has ${JSON.stringify(name)}: ${bad}`);
  }
  const team = checkTrackerGroup('team', value.team, file, errors);
  const project = checkTrackerGroup('project', value.project, file, errors);
  const listUnset = (raw) => raw === undefined || (Array.isArray(raw) && raw.length === 0);
  const listSet = (raw) => Array.isArray(raw) && raw.length > 0;
  const groupUnset = (raw) => raw === undefined || raw === null;
  if (isObject(value.workspace) && listUnset(value.readTools) && !perCall) errors.push(`${file}: "tracker.workspace" needs "tracker.readTools", the tools that read the connected workspace`);
  if (listSet(value.readTools) && groupUnset(value.workspace)) errors.push(`${file}: "tracker.readTools" needs "tracker.workspace", the value those tools must report`);
  if (value.enabled === true && listUnset(value.writeTools)) errors.push(`${file}: "tracker.enabled" needs "tracker.writeTools", the tools the guard watches`);
  if (value.enabled === true && listSet(value.writeTools) && [value.workspace, value.team, value.project].every(groupUnset)) {
    errors.push(`${file}: "tracker.enabled" needs one of "tracker.workspace", "tracker.team", or "tracker.project", the values a write is held to`);
  }
  // A read tool left out may be the one the connector has, so the workspace check goes with it instead of refusing every write.
  const readPaired = workspace !== null && readTools.length > 0 && readTools.length === value.readTools.length;
  const paired = perCall ? workspace !== null : readPaired;
  if (readPaired) {
    const uncleared = writeTools.map((pattern) => [pattern, unclearedWriteProblem(pattern, readTools)]).filter(([, bad]) => bad);
    // With the adapter's patterns under a file's read tools, what is wrong is that one key, however many patterns it strands.
    if (provided && raw.writeTools === undefined && uncleared.length > 0) {
      const servers = [...new Set(uncleared.map(([pattern]) => serverPrefix(pattern)))].join(', ');
      errors.push(raw.readTools === undefined
        ? `${file}: "tracker.servers" gives writes with no read the guard can count on ${servers}, so no write there can pass`
        : `${file}: "tracker.readTools" replaces the adapter's and leaves no read on ${servers}, so no write there can pass: drop "tracker.readTools", or add a read on each`);
    } else {
      for (const [pattern, bad] of uncleared) errors.push(`${file}: "tracker.writeTools" has ${JSON.stringify(pattern)}: ${bad}`);
    }
  }
  return {
    enabled: value.enabled === true && writeTools.length > 0 && (paired || team !== null || project !== null),
    workspace: paired ? workspace : null,
    readTools: readPaired ? readTools : [],
    writeTools,
    team,
    project,
    ...(provided ? { provider: provided.id } : {}),
    ...(perCall && paired ? { workspaceInput: value.workspaceInput } : {}),
    ...(isText(value.idHint) ? { idHint: value.idHint } : {}),
    ...(isTexts(value.readVerbs) ? { readVerbs: value.readVerbs } : {}),
  };
}

// The adapter `tracker.provider` names, null when the key sets none, or undefined when it names none we have, whose error
// is the only one the key raises: nothing else in it can be judged without knowing the tracker.
function checkTrackerProvider(value, file, errors) {
  if (value.provider === undefined) {
    if (value.servers !== undefined) errors.push(`${file}: "tracker.servers" needs "tracker.provider", the tracker those servers connect to`);
    return null;
  }
  const adapter = trackerById(value.provider);
  if (!adapter) {
    errors.push(`${file}: "tracker.provider" must be ${oneOfTrackers()}`);
    return undefined;
  }
  const named = value.servers ?? [];
  if (!Array.isArray(named) || !named.every((each) => typeof each === 'string' && SERVER_NAME.test(each))) {
    errors.push(`${file}: "tracker.servers" must be a list of server names, such as "my-linear" in mcp__my-linear__save_issue`);
    return undefined;
  }
  // The file's list replaces the adapter's, which is what `servers` adds to, so the server would go unwatched with no word.
  if (value.writeTools !== undefined) {
    for (const server of named) errors.push(`${file}: "tracker.servers" has ${JSON.stringify(server)}, but "tracker.writeTools" replaces the list it adds to, so no write on it is watched: add its patterns there, or drop "tracker.writeTools"`);
  }
  return adapter;
}

const oneOfTrackers = () => (TRACKERS.length === 1 ? JSON.stringify(TRACKERS[0].id) : oneOf(TRACKERS.map((each) => each.id)));

// One group of `tracker`, or null when it is unset or has any error: the guard cannot run on part of one.
function checkTrackerGroup(name, value, file, errors) {
  if (value === undefined || value === null) return null;
  const at = `tracker.${name}`;
  if (!isObject(value)) {
    errors.push(`${file}: "${at}" must be an object, or null`);
    return null;
  }
  const before = errors.length;
  const group = merge(TRACKER_GROUPS[name], {}, value, `${at}.`, file, errors);
  for (const key of Object.keys(TRACKER_GROUPS[name])) if (!Object.hasOwn(value, key)) errors.push(`${file}: "${at}.${key}" is missing`);
  return errors.length === before ? group : null;
}

// Why `pattern` cannot name a tracker tool, or null. The guard's hooks match only MCP calls, so "*" or Bash(...) would
// pass the check of `agents` patterns and never fire.
function trackerToolProblem(pattern) {
  if (typeof pattern === 'string' && pattern !== '' && !pattern.startsWith('mcp__')) return 'a tracker tool is an MCP tool, so its pattern starts with "mcp__"';
  return patternProblem(pattern);
}

// Why `name` cannot be a read tool, or null. A read names one tool, and a write pattern that covers it would refuse the
// read the workspace check asks for, so no write could ever pass. The `*` check comes first, since patternProblem's
// answer to a mid-name `*` would suggest a trailing one.
function readToolProblem(name, writeTools) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return trackerToolProblem(name);
  if (name.includes('*')) return 'a read tool is an exact tool name, with no "*"';
  const problem = patternProblem(name);
  if (problem) return problem;
  const covering = writeTools.find((pattern) => nameMatches(pattern, name));
  return covering === undefined ? null : coveredProblem(covering);
}

const coveredProblem = (pattern) => `a read tool cannot also match "tracker.writeTools", and ${JSON.stringify(pattern)} covers it`;

// What is wrong with a read tool that stays in the list. This is a report only, as unclearedWriteProblem is: leaving it out would
// unset `workspace` for every host, and the guard that keeps it refuses writes on that server, which is the safe way to be wrong.
function readToolReport(name, writeTools) {
  if (!reachesAHook(name)) {
    // Where a flat name's connector ends cannot be told from it, so the name to use is given only for a server a tracker knows.
    const standard = UNKNOWN_HOST.toolName(name);
    const known = TRACKERS.some((tracker) => knownServers(tracker).some((server) => keyServer(standard) === `mcp__${server}__`));
    return `no host sends this name, which is the form only a model sees, so no read would ever count${known ? `; name it as ${JSON.stringify(standard)}` : ''}`;
  }
  const covering = writeTools.find((pattern) => hookForms(name).some((form) => nameMatches(pattern, form)));
  return covering === undefined ? null : coveredProblem(covering);
}

// Why no call a hook sees can match `pattern`, or null. A pattern ending in `*` is tried on a name it would match: it can match
// a call when the standard or raw form of that name still starts with the pattern's stem. This is a report only, and it matters
// because a pattern that matches nothing lets every write run unjudged.
function unreachableWriteProblem(pattern) {
  const stem = pattern.endsWith('*') ? pattern.slice(0, -1) : null;
  const reaches = stem === null ? reachesAHook(pattern) : hookForms(`${stem}x`).some((form) => form.startsWith(stem));
  return reaches ? null : 'no host sends a name this matches, as it is the form only a model sees, so a write it means runs unjudged, unless it names a connector whose own name holds an underscore';
}

// Why no read could ever clear a write on `pattern`, as the guard counts a read only on the write's server, or null.
// This is a report only: the entry stays, and the guard refuses those writes. A "*" before the server's name ends can match
// a server that has a read tool, so it is not judged.
function unclearedWriteProblem(pattern, readTools) {
  const star = pattern.endsWith('*');
  const server = keyServer(star ? pattern.slice(0, -1) : pattern);
  if (server === null) return star ? null : 'it names no server, as in mcp__<server>__<tool>, so no read can clear it';
  return readTools.some((name) => keyServer(name) === server) ? null : 'no tool in "tracker.readTools" is on its server, so no read can clear it';
}

// The good entries of one tool list of `tracker`; a bad one is an error and is left out, as in `agents`.
function checkToolList(name, noun, value, problemOf, file, errors) {
  if (value === undefined) return [];
  const at = `tracker.${name}`;
  if (!Array.isArray(value)) {
    errors.push(`${file}: "${at}" must be a list of tool ${noun}`);
    return [];
  }
  return value.filter((entry) => {
    const bad = problemOf(entry);
    if (bad) errors.push(`${file}: "${at}" has ${JSON.stringify(entry)}: ${bad}`);
    return !bad;
  });
}

// The first of loadConfig's `gateErrors`, as { file, problem }, or null. Without that gate the hook treats the file
// as one it cannot read.
export function malformedGates(gateErrors) {
  return gateErrors[0] ?? null;
}

// The plugin's agent names, from the agent files it ships beside this folder.
let agentNames;
function pluginAgents() {
  agentNames ??= readdirSync(path.join(import.meta.dirname, '../agents'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .sort();
  return agentNames;
}

const oneOf = (list) => `${list.slice(0, -1).map((each) => JSON.stringify(each)).join(', ')}, or ${JSON.stringify(list.at(-1))}`;

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
