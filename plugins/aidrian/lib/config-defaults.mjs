// The value of every config key a project leaves unset, frozen.

import { MAX_PLAN_OBJECTIONS, MODEL_CHOICES } from './config-schema.mjs';
import { DECISION_DOMAINS } from './decisions.mjs';
import { REVIEW_DEFAULTS } from './review/config.mjs';

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
    // The wording no public issue, pull request, or comment may carry (lib/rules/github/public-text.mjs); [] is off.
    publicText: { patterns: [] },
    // The review that must be on record before the review bot is asked (lib/review-gate.mjs).
    reviewGate: { enabled: false, checklist: null },
    // The team's ceiling on auto-merge: no machine merges a pull request unless `allow` is true. `strategy: null` leaves
    // the choice to pr-merge-when-green's order: squash, then merge, then rebase, among those the repository allows.
    // A machine opts in under it from the local file (resolveAutoMerge). `includeGuardedPaths` lets a pull request that
    // changes a guarded path (project.mjs GUARDED_PATHS) through the paths gate, but never one of the files the gate
    // reads its policy from, including a folder the pointer file names; the team accepts that risk on both branches
    // (pr-auto-merge.mjs). `unreviewedPaths` lists the files a pull request whose review was `none_needed` may change and
    // still auto-merge, on both branches (pr-auto-merge-docs.mjs); empty, no such pull request auto-merges.
    autoMerge: { allow: false, default: 'off', strategy: null, deleteBranch: false, deleteWorktree: false, includeGuardedPaths: false, unreviewedPaths: [] },
    // The team's ceiling on a recorded judge verdict standing in for the Human's answer to the merge guard's question
    // (lib/review/waiver.mjs). A machine opts in under it from the local file (resolveUnattendedWaiver); no team default.
    unattendedWaiver: { allow: false },
  },
  // How a pull request is reviewed (lib/review/, docs/review.md).
  review: REVIEW_DEFAULTS,
  docs: { wrapLimit: 155 },
  // The terms file (lib/terms.mjs); null turns the terms rule off.
  terms: { file: null },
  // The docs this plugin ships under a project's own knowledge, each on unless set to false (DEFAULT_DOCS in lib/knowledge.mjs).
  knowledge: { budgets: { alwaysBytes: 16384, taggedDocBytes: 24576 }, defaults: { codeStyle: true } },
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

export function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}