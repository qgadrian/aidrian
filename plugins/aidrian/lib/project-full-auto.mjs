// What the team's projectRun.fullAuto changes, and the complete list of what still waits on a person, as
// `aidrian project preflight` prints it (lib/project-preflight.mjs), so the driver hands the Human every `note human:`
// line in its one turn-1 message. fullAuto is standing consent for custody of a driver session the host continued
// (lib/project-run-gate.mjs resumeRun); it takes no decision, merges nothing more, signs nothing off, and lifts no halt.
// Reads only: the recorded-decision store is counted, never written, and no grant's heading or text is printed.

import { loadVocab } from './decisions.mjs';
import { countRecordedDecisions } from './project-decision-store.mjs';

// The lines for the team's `policy` (project-run-gate.mjs teamPolicy) and `base`, the default branch's config as this
// checkout's git holds it (baseBranchConfig), or none while the policy does not set fullAuto. `projectKey` names the
// project in this machine's recorded-decision store, under `env`; `count` is the store's counter, a test's stand-in.
export function fullAutoLines({ base, policy, projectKey, env = process.env, count = countRecordedDecisions }) {
  if (policy.problem || policy.fullAuto !== true) return [];
  const config = base.config ?? {};
  const human = [
    policy.includePolicyFiles === true
      ? 'a pull request that changes a policy file, the config.json the gate reads, the pointer file, or the local switch file, merges by itself with no sign-off of the Human, since github.autoMerge.includePolicyFiles is on, '
        + 'except one that changes github.requiredChecks, conditionalChecks, ignoreCancelledChecks, or state.dir, which the gate\'s checks row keeps off with the key on or off: the Human merges that one'
      : 'a pull request that changes a policy file, the config.json the gate reads, the pointer file, or the local switch file, never merges by itself; the Human merges it',
    signoffLine(config),
    decisionLine({ policy, projectKey, env, count, safeDefaults: config.decisions?.unattended?.safeDefaults }),
    'a halt, such as a failed sandbox proof or a broken environment, waits for the Human: the driver names it in its final report, and the Human lifts it with `aidrian project resume <run>` in a session they attend',
    'a run whose driver chain ended, with no session the host continued its driver as, waits for the Human to take it up',
    ...parkingLines(config, policy),
  ];
  return [
    'note full-auto: projectRun.fullAuto lets the session the host continued the driver as take the run\'s custody with `aidrian project resume <run> --custody` and drive on with no person; it takes no decision, merges nothing more, signs nothing off, and lifts no halt',
    ...human.map((line) => `note human: ${line}`),
  ];
}

// The sign-off flows of the default branch's config that the Human signs off (`signoff: "human"`), by id.
function signoffLine(config) {
  const flows = Object.entries(config.review?.flows ?? {}).filter(([, flow]) => flow?.signoff === 'human').map(([id]) => id).sort();
  return `the sign-off flows the default branch gives the Human (signoff "human"): ${flows.length ? flows.join(', ') : 'none'}; a pull request such a flow selects waits for the Human's \`aidrian pr signoff\``;
}

// A floor-class decision parks unless a decision the Human recorded pins the answer, which a start reads only while the
// team's projectRun.recordedDecisions is on, from this machine's store.
function decisionLine({ policy, projectKey, env, count, safeDefaults }) {
  const floor = loadVocab().classes.filter((each) => each.floor).map((each) => each.class).join(', ');
  const undone = safeDefaults === 'all' ? ', or takes a safe default that can be undone under decisions.unattended.safeDefaults "all",' : '';
  const parks = `a floor-class decision (${floor}) parks the issue for the Human${undone}`;
  if (policy.recordedDecisions !== true) return `${parks}: projectRun.recordedDecisions is off, so no recorded answer is read`;
  const read = count({ projectKey, env });
  const mine = 'grants are this machine\'s, so a run driven from another machine sees none, and a grant stands only at a start whose kept text still hashes so';
  if (read.problem) return `${parks} unless a recorded decision pins the Human's answer, and ${read.problem}`;
  if (read.count === 0) return `${parks} unless a recorded decision pins the Human's answer, and no grant is pinned on this machine: record one with \`aidrian project decision ISSUE --heading TEXT --record\` from a session the Human attends; ${mine}`;
  return `${parks} unless a recorded decision pins the Human's answer: ${read.count} ${read.count === 1 ? 'grant' : 'grants'} pinned on this machine; ${mine}`;
}

// The settings that park more than they must: an agent settles no reversible decision below decide-reversible, an
// unattended run takes a safe default only outside the escalated domains below `all`, and a pull request that changes a
// guarded path waits for the Human while github.autoMerge.includeGuardedPaths is off.
function parkingLines(config, policy) {
  const lines = [];
  const decisions = config.decisions ?? {};
  if (decisions.mode !== 'decide-reversible' || decisions.maxMode !== 'decide-reversible') {
    lines.push(`decisions.mode is ${JSON.stringify(decisions.mode ?? null)} and decisions.maxMode ${JSON.stringify(decisions.maxMode ?? null)} on the default branch, so a reversible decision parks too; "decide-reversible" for both lets an agent settle it`);
  }
  if (decisions.unattended?.safeDefaults !== 'all') {
    lines.push(`decisions.unattended.safeDefaults is ${JSON.stringify(decisions.unattended?.safeDefaults ?? null)} on the default branch, so an unattended run parks a question of a floor class, or of a class it does not know, where a safe default that can be undone would do; "all" lets it take one, and what the project escalates still parks`);
  }
  if (policy.includeGuardedPaths !== true) {
    lines.push('github.autoMerge.includeGuardedPaths is off, so a pull request that changes a guarded path, such as a workflow or the knowledge folder, waits for the Human to merge it');
  }
  return lines;
}
