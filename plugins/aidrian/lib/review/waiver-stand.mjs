// When a judge's verdict at the round cap may run, and when one stands for `aidrian pr auto-merge`
// (docs/config.md#unattended-waiver). The merge guard's own reading of a verdict is lib/review/waiver.mjs guardWaiver.
//
// `aidrian pr waive <PR> --gate [--json]` says, before any judge is dispatched, whether the waiver may run here, exit 0
// only then (waiverMayRun): the review step stopped at `round_limit` on exactly the current head with nothing owed; the
// team's `github.unattendedWaiver.allow` is true on the default branch and the base, read through the forge (the review
// trail, which gives both branches' policy files), never the working copy, and this machine's switch is on or follows
// the team's `solo`; every finding open at the cap is a local reviewer's of medium severity or lower and no security
// finding (waiver.mjs capProblem); a project run has merged fewer than WAIVED_MERGES pull requests on a verdict; the
// review bot passed exactly the head on the forge (merge-trust.mjs botProblem); and no judge has ruled on that head yet,
// since one judge rules per head.
//
// `aidrian pr auto-merge` takes `round_limit` on the head in place of `received` only when the same holds at merge time
// and a `waive` verdict stands for exactly that head (waiver.mjs waiverFor), recorded at or after the cap with the
// judge's agent id and the recording session, and that session's dispatch log holds the dispatch of that judge, a
// code-reviewer, between the cap and the verdict (judgeProblem). A new push moves the head, and the verdict no longer
// covers it. Under a project run, the run counts the pull requests it merged whose record holds a `waive` verdict.
//
// The record, the verdict, and the dispatch log are each in folders a project run's confined session can write, so none
// is proof: the bot's pass on the forge is what no such session writes, and a merge no Human attends still meets every
// merge-trust check (merge-trust.mjs trustVerdict).

import { loadConfig } from '../config.mjs';
import { readLog } from '../dispatch-log.mjs';
import { forgeFor } from '../forges/index.mjs';
import { knownPrefix } from '../git.mjs';
import { stateFolders } from '../handoff-guard.mjs';
import { sessionIdentity } from '../hosts/index.mjs';
// A cycle (pr-auto-merge.mjs imports this file), benign while neither uses the other's exports as it loads.
import { branchPolicies, trailPaths, trailPolicies } from '../pr-auto-merge.mjs';
import { readRun } from '../project-run.mjs';
import { hostOf, repoName } from '../remotes.mjs';
import { recordFor, scoped } from '../rules/github/merge-review.mjs';
import { readUnattendedMark } from '../unattended-mark.mjs';
import { botProblem } from './merge-trust.mjs';
import { readLocalState, SHA_REF } from './state.mjs';
import { capProblem, notWaivable, waiverFor, waiverGate, waiverKind } from './waiver.mjs';

// The most pull requests one project run merges on a judge's verdict; past it, the issue is parked for the Human.
export const WAIVED_MERGES = 3;
// The agent a waiver's judge is, as a host names it in the dispatch log: the plugin's code-reviewer, or a project's.
const JUDGE_TYPE = /^(?:aidrian[:-])?code-reviewer$/u;

// The project run a session's unattended mark names: undefined for none, the run id, or null when the mark carries run
// tags that cannot be read, which no budget can count.
export function runOf(mark) {
  if (!mark || !Object.hasOwn(mark, 'project')) return undefined;
  return typeof mark.project === 'string' ? mark.project : null;
}

// How many pull requests the project run `run` merged, other than `pr`, whose review record holds a `waive` verdict, by
// its ledger's merged results, the forge-verified ones; or null when the run's ledger cannot be read.
export function waivedMerges({ project, config, run, pr }) {
  for (const state of stateFolders(project, config, { lazy: true })) {
    const found = readRun(state, run);
    if (found.problem) continue;
    const { owner, name } = found.init.repository;
    const merged = new Set(found.rows.filter((row) => row?.event === 'result' && row.status === 'merged' && Number.isInteger(row.pr) && row.pr !== pr).map((row) => row.pr));
    return [...merged].filter((n) => {
      const waivers = readLocalState(project, n, `${owner}/${name}`)?.waivers;
      return Array.isArray(waivers) && waivers.some((entry) => entry?.verdict === 'waive');
    }).length;
  }
  return null;
}

// Why the run's budget keeps a verdict from running for `pr`, or null. `run` is runOf's answer.
export function budgetProblem({ project, config, run, pr }) {
  if (run === undefined) return null;
  if (run === null) return 'this session\'s unattended mark names a project run that cannot be read, so the run\'s waived merges cannot be counted';
  let spent;
  try {
    spent = waivedMerges({ project, config, run, pr });
  } catch {
    spent = null;
  }
  if (spent === null) return `the ledger of project run ${run} cannot be read, so its waived merges cannot be counted`;
  return spent >= WAIVED_MERGES ? `project run ${run} merged ${spent} pull requests on a judge's verdict already, its most (${WAIVED_MERGES}): park the issue for the Human` : null;
}

// Why the verdict `entry` names no judge this session dispatched, or null: the recording session's dispatch log
// (`config`'s state folder) must hold a `dispatch` row of that session for the agent id `entry.judge_id`, a
// code-reviewer, at or after the cap's outcome and at or before the verdict.
export function judgeProblem({ project, config, state, entry }) {
  if (typeof entry?.judge_id !== 'string' || typeof entry.session !== 'string' || entry.session === '') {
    return 'the verdict names no judge agent and session (`aidrian pr waive --judge <agent id>`), so the dispatch log cannot show its judge was dispatched';
  }
  const since = Date.parse(state?.outcome?.at ?? '');
  const until = Date.parse(entry.at ?? '');
  let rows;
  try {
    rows = readLog(project, config).rows;
  } catch {
    return 'the dispatch log cannot be read, so the judge\'s dispatch cannot be confirmed';
  }
  const dispatched = rows.some((row) => {
    if (row?.event !== 'dispatch' || row.session_id !== entry.session || row.agent_id !== entry.judge_id || !JUDGE_TYPE.test(String(row.agent_type ?? ''))) return false;
    const at = Date.parse(row.ts ?? '');
    return !Number.isNaN(since) && !Number.isNaN(at) && at >= since && at <= until;
  });
  return dispatched ? null : `the dispatch log holds no dispatch of the code-reviewer ${entry.judge_id} by session ${entry.session} between the cap and the verdict`;
}

// Whether a judge may be dispatched for `head`, or would see its verdict stand: { may: true } or { why }. `policies` are
// branchPolicies' answer, read from the forge; `trail()` gives the forge's review trail of the pull request.
export function waiverMayRun({ project, config, state, pr, head, policies, repo, host, base, prefix, trail, run }) {
  if (waiverKind(state, head) !== 'round_cap') return { why: state ? notWaivable(state, head, pr) : `this machine holds no review record for #${pr}` };
  const gate = waiverGate({ project, policies, repo, host, base, prefix });
  if (!gate.on) return { why: gate.why ?? 'the unattended waiver is off' };
  const cap = capProblem(state, head);
  if (cap) return { why: cap };
  const budget = budgetProblem({ project, config, run, pr });
  if (budget) return { why: budget };
  const bot = botProblem(trail(), head, policies.policy.github.reviewer);
  if (bot) return { why: `a verdict waives only this machine's reviewers' findings, and stands only once the review bot passed the head: ${bot}` };
  return { may: true };
}

// Whether a judge's verdict lets `aidrian pr auto-merge` take `round_limit` on `head`: { waived: true } or { why }.
// waiverMayRun, then a `waive` verdict that stands for exactly the head, whose judge the dispatch log shows.
export function waivedReview(args) {
  const may = waiverMayRun(args);
  if (!may.may) return may;
  const verdict = waiverFor(args.state, args.head, 'round_cap');
  if (!verdict) return { why: `no judge's \`waive\` verdict stands for head ${String(args.head).slice(0, 7)}` };
  const judge = judgeProblem({ project: args.project, config: args.config, state: args.state, entry: verdict });
  return judge ? { why: judge } : { waived: true };
}

const GATE_FIELDS = 'number,headRefOid,baseRefName,url';

// `aidrian pr waive <PR> --gate [--json]`: exit 0 when a judge may be dispatched for the pull request's current head, 1
// when not, 3 when the pull request, its trail, or its policies cannot be read. `forge` is the test seam, `session` the
// session the host gives the command, and `run()` the project run its unattended mark names (runOf).
export function runWaiveGate({ pr, json = false }, project, { forge = forgeFor(project.root), session = sessionIdentity(process.env).session, home, run = () => runOf(readUnattendedMark(session, home ? { home } : {})), config = null } = {}) {
  const fail = (message) => {
    console.error(`aidrian pr waive: ${message}`);
    return 3;
  };
  let view;
  try {
    view = forge.change(String(pr), GATE_FIELDS);
  } catch (error) {
    return fail(`could not read pull request #${pr} (${String(error?.message ?? error).split('\n')[0]})`);
  }
  const head = view?.headRefOid;
  const base = typeof view?.baseRefName === 'string' && view.baseRefName !== '' ? view.baseRefName : null;
  const host = typeof view?.url === 'string' ? hostOf(view.url) : null;
  const repo = typeof view?.url === 'string' ? repoName(view.url) : null;
  if (typeof head !== 'string' || !SHA_REF.test(head) || head.length !== 40 || !base || !host || !repo) return fail(`gh returned no full head, base, or URL for #${pr}`);
  const out = (may, why) => {
    console.log(json ? JSON.stringify({ may, why, pr, head, repo, base })
      : may ? `waiver may run for #${pr} at ${head.slice(0, 7)}: dispatch one fresh judge, and record its verdict with --head ${head}` : `waiver off for #${pr}: ${why}`);
    return may ? 0 : 1;
  };
  const prefix = knownPrefix(project.root);
  if (prefix === null) return out(false, 'git could not give the project\'s folder in the repository');
  let trail;
  let policies;
  try {
    trail = forge.reviewTrail(repo, pr, { host, paths: trailPaths(prefix) });
    policies = trailPolicies(trail, { repo, base }, prefix) ?? branchPolicies(forge, { repo, host, base }, prefix);
  } catch (error) {
    return fail(`could not read the review trail or the team's config of #${pr} (${String(error?.message ?? error).split('\n')[0]})`);
  }
  const state = scoped(recordFor(project, pr, repo), project, repo);
  const ruled = (Array.isArray(state?.waivers) ? state.waivers : []).find((entry) => entry?.kind === 'round_cap' && typeof entry.head === 'string' && entry.head.toLowerCase() === head.toLowerCase());
  if (ruled) return out(false, `a judge already gave its verdict on head ${head.slice(0, 7)} (${ruled.verdict}): one judge rules per head`);
  const result = waiverMayRun({ project, config: config ?? loadConfig(project).config, state, pr, head, policies, repo, host, base, prefix, trail: () => trail, run: run() });
  return out(result.may === true, result.why ?? null);
}
