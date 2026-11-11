// The shape of config.json: the folder version, the type of every key, and the keys a format change renamed or removed.
// config-types.mjs defines each type; config-merge.mjs reads a file by this table. docs/config.md lists the keys.

import { DECISION_DOMAINS } from './decisions.mjs';
import { modelChoices } from './hosts/index.mjs';

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
export const TRACKER_SHORT_KEYS = ['provider', 'servers', 'workspaceInput', 'readVerbs', 'idHint'];
// A server's name in mcp__<server>__<tool>: it holds no `*`, and a double underscore would end it early (tracker-guard.mjs).
export const SERVER_NAME = /^(?!.*__)[\w-]+$/u;
// The keys of each group of `tracker`. Unlike a group of SCHEMA, one of these is set whole or not at all (checkTracker).
export const TRACKER_GROUPS = {
  workspace: { expect: 'text', field: 'text' },
  team: { key: 'teamKey', values: 'someTexts', createFields: 'someTexts', keyFields: 'someTexts' },
  project: { values: 'someTexts', field: 'text' },
};

// The keys of the `decisions` group: how far agents may settle product and design decisions (lib/decisions.mjs).
export const DECISIONS_SCHEMA = {
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
export const LOCAL_DECISIONS_SCHEMA = { mode: 'decisionMode', domains: DECISIONS_SCHEMA.domains, unreviewed: DECISIONS_SCHEMA.unreviewed };

// The type of every key. A nested object is one group of keys; a project sets any subset of a group.
export const SCHEMA = {
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
    publicText: { patterns: 'patterns' },
    reviewGate: { enabled: 'boolean', checklist: 'textOrNull' },
    autoMerge: { allow: 'boolean', default: 'onOff', strategy: 'mergeStrategy', deleteBranch: 'boolean', deleteWorktree: 'boolean', includeGuardedPaths: 'boolean', unreviewedPaths: 'globs' },
    unattendedWaiver: { allow: 'boolean' },
  },
  review: 'review',
  docs: { wrapLimit: 'zeroOrMore' },
  terms: { file: 'textOrNull' },
  knowledge: { budgets: { alwaysBytes: 'positive', taggedDocBytes: 'positive' }, defaults: { codeStyle: 'boolean' } },
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
export const RENAMED = {
  pr: 'github',
  'docs.alwaysBudgetBytes': 'knowledge.budgets.alwaysBytes',
  'telemetry.doc_reads': 'telemetry.docReads',
  'telemetry.hook_denies': 'telemetry.hookDenies',
  'telemetry.max_mb': 'telemetry.maxMb',
  'session.maxTokens': 'session.handoff.maxTokens',
};

// Keys a format change took out, with why; a config that still sets one gets an error, and its value is not carried.
export const REMOVED = {
  'session.maxCalls': 'the session-length reminder weighs cost, not calls',
  'session.maxHours': 'the session-length reminder weighs cost, not hours',
};

// The modes a string `session.handoff` held before the handoff settings became a group.
export const HANDOFF_MODES = ['off', 'ask', 'auto'];

// The fields config.json `attribution` may list (lib/attribution.mjs).
export const COMMIT_FIELDS = ['agent', 'model', 'effort', 'tool', 'env'];
export const PR_FIELDS = ['tool', 'model', 'effort', 'env', 'agents'];

// What `models` may set for one of this plugin's agents, per host; null takes any non-empty string.
// Each host's adapter says what it takes (lib/hosts/); docs/config.md#models cites them.
export const MODEL_CHOICES = modelChoices();

// The placeholders an audit label may hold, filled per finding (lib/audits.mjs issueLabels).
export const AUDIT_LABEL_FIELDS = ['persona', 'severity'];
