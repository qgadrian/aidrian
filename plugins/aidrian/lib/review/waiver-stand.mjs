// When a judge's verdict at the round cap may run, and when one stands for `aidrian pr auto-merge`
// (docs/config.md#unattended-waiver). The merge guard's own reading of a verdict is lib/review/waiver.mjs guardWaiver.
//
// `aidrian pr waive <PR> --gate [--json]` says, before any judge is dispatched, whether the waiver may run here, exit 0
// only then (waiverMayRun): the review step stopped at `round_limit` on exactly the current head with nothing owed; the
// team's `github.unattendedWaiver.allow` is true on the default branch and the base, read through the forge (the review
// trail, which gives both branches' policy files), never the working copy, and this machine's switch is on or follows
// the team's `solo`; this host confirms a judge's dispatch in the dispatch log, and telemetry writes that log; the
// review bot passed exactly the head on the forge (merge-trust.mjs botProblem); open findings of this machine's own
// reviewers, medium or lower and no security finding, are the whole cause of the cap (waiver.mjs capProblem); no
// sign-off of the Human's is owed on that head (waiver.mjs signoffOwed); a project run has merged fewer than
// WAIVED_MERGES pull requests on a verdict; and no judge has ruled on that head yet, since one judge rules per head. The
// gate also holds the working copy's state folder to the default branch's, as auto-merge's checks do, and, in a project
// run, the pull request to the run's pinned repository. The same gate (readGate) is the `waiver` the review step reports
// at the cap (offerWaiver), and the check `aidrian pr extend --verdict land` makes before it records a `waive`, so a
// session at the cap types no gate command of its own (docs/config.md#unattended-waiver).
//
// Any `aidrian pr auto-merge` under these switches takes `round_limit` on the head in place of `received` when the same
// holds at merge time and a `waive` verdict stands for exactly that head (waiver.mjs waiverFor), recorded at or after the
// cap with the judge's agent id and the recording session, and that session's dispatch log holds the dispatch of that
// judge, a code-reviewer, between the cap and the verdict (judgeProblem). A new push moves the head, and the verdict no
// longer covers it.
//
// The record, the verdict, and the dispatch log are each in folders a project run's confined session can write, so none
// is proof: the bot's pass on the forge, and the sign-off store, are what no such session writes, and a merge no Human
// attends still meets every merge-trust check (merge-trust.mjs trustVerdict).

import { loadConfig, stateDirProblem } from '../config.mjs';
import { forgeFor } from '../forges/index.mjs';
import { knownPrefix } from '../git.mjs';
import { detectHost, sessionIdentity } from '../hosts/index.mjs';
// A cycle (pr-auto-merge.mjs imports this file), benign while neither uses the other's exports as it loads.
import { branchPolicies, trailPaths, trailPolicies } from '../pr-auto-merge.mjs';
import { hostOf, repoName } from '../remotes.mjs';
import { localRefSolo } from '../solo.mjs';
import { recordFor, scoped } from '../rules/github/merge-review.mjs';
import { readUnattendedMark } from '../unattended-mark.mjs';
import { botProblem } from './merge-trust.mjs';
import { SHA_REF } from './state.mjs';
import { budgetProblem, capProblem, judgeProblem, notWaivable, owedSignoffs, runLedger, runOf, waiverFor, waiverGate, waiverKind } from './waiver.mjs';

export { budgetProblem, judgeProblem, runOf, WAIVED_MERGES, waivedMerges } from './waiver.mjs';

// Why this host and config cannot confirm a judge, or null: the host must declare `capabilities.judgeDispatch` (its
// hook writes a `dispatch` row with the agent id the host returned for each subagent), and `telemetry.enabled` must let
// the hooks write the dispatch log. `host` is the host this command runs under (hosts/index.mjs detectHost).
export function judgeHostProblem({ host, config }) {
  if (host?.capabilities?.judgeDispatch !== true) return `this host (${host?.name ?? 'unknown'}) does not confirm a judge's dispatch in the dispatch log, so no verdict can stand here`;
  if (config?.telemetry?.enabled === false) return 'telemetry.enabled is false, so the hooks write no dispatch log to confirm a judge\'s dispatch in';
  return null;
}

// Whether a judge may be dispatched for `head`, or would see its verdict stand: { may: true } or { why, kind?, unsigned? },
// `kind` "signoff" when a sign-off of the Human's is owed, with `unsigned` the flows it is for. `policies` are
// branchPolicies' answer, read from the forge; `trail()` gives the forge's review trail of the pull request; `host`
// the host this command runs under.
export function waiverMayRun({ project, config, state, pr, head, policies, repo, host, base, prefix, trail, run, runHost = detectHost() }) {
  if (waiverKind(state, head) !== 'round_cap') return { why: state ? notWaivable(state, head, pr) : `this machine holds no review record for #${pr}` };
  const gate = waiverGate({ project, policies, repo, host, base, prefix });
  if (!gate.on) return { why: gate.why ?? 'the unattended waiver is off' };
  const unconfirmed = judgeHostProblem({ host: runHost, config });
  if (unconfirmed) return { why: unconfirmed };
  const bot = botProblem(trail(), head, policies.policy.github.reviewer);
  if (bot) return { why: `a verdict never stands in for the review bot, and ${bot}` };
  const cap = capProblem(state, head);
  if (cap) return { why: cap };
  const owes = owedSignoffs({ state, head, trail: trail(), policies, prefix, repo, pr });
  // A sign-off the Human owes is merge trust's `signoff` half, so a caller can report it as merge trust does.
  if (owes) return { why: owes.why, kind: 'signoff', unsigned: owes.unsigned };
  const budget = budgetProblem({ project, config, run, pr });
  if (budget) return { why: budget };
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

// Whether a judge may be dispatched for the pull request's current head: { code, may, why, head, repo, base } with code
// 0 when one may, 1 when not, or { code: 3, error } when the pull request, its trail, or its policies cannot be read.
// The one gate of `aidrian pr waive --gate`, the review step's `waiver` at the cap (offerWaiver), and `aidrian pr extend
// --verdict land`. `forge` is the test seam, `session` the session the host gives the command, `run()` the project run
// its unattended mark names (runOf), and `runHost` the host. `record(repo)` gives the review record the gate weighs,
// this machine's by default; `repo`, when given, is the repository the pull request is read in, and must be the one the
// forge's view names.
export function readGate({ pr, repo: given = null }, project, { forge = forgeFor(project.root), session = sessionIdentity(process.env).session, home, run = () => runOf(readUnattendedMark(session, home ? { home } : {})), config = null, runHost = detectHost(), record = null } = {}) {
  let view;
  try {
    view = given ? forge.change(String(pr), GATE_FIELDS, { repo: given }) : forge.change(String(pr), GATE_FIELDS);
  } catch (error) {
    return { code: 3, error: `could not read pull request #${pr} (${String(error?.message ?? error).split('\n')[0]})` };
  }
  const head = view?.headRefOid;
  const base = typeof view?.baseRefName === 'string' && view.baseRefName !== '' ? view.baseRefName : null;
  const host = typeof view?.url === 'string' ? hostOf(view.url) : null;
  const repo = typeof view?.url === 'string' ? repoName(view.url) : null;
  if (typeof head !== 'string' || !SHA_REF.test(head) || head.length !== 40 || !base || !host || !repo) return { code: 3, error: `gh returned no full head, base, or URL for #${pr}` };
  const out = (may, why) => ({ code: may ? 0 : 1, may, why, head, repo, base });
  if (given && repoName(given) !== repo) return out(false, `the forge read #${pr} in ${repo}, not ${repoName(given) ?? 'the repository named'}`);
  const working = config ?? loadConfig(project).config;
  const runId = run();
  // A session of a project run works in the repository its run pinned, and nowhere else.
  if (typeof runId === 'string') {
    const found = runLedger({ project, config: working, run: runId });
    const pinned = found ? repoName(`${found.init.repository.owner}/${found.init.repository.name}`) : null;
    if (pinned !== repo) return out(false, pinned ? `the pull request is in ${repo}, and this session's project run works in ${pinned}` : 'the ledger of this session\'s project run cannot be read, so the repository it works in cannot be told');
  }
  const prefix = knownPrefix(project.root);
  if (prefix === null) return out(false, 'git could not give the project\'s folder in the repository');
  let trail;
  let policies;
  try {
    trail = forge.reviewTrail(repo, pr, { host, paths: trailPaths(prefix) });
    policies = trailPolicies(trail, { repo, base }, prefix) ?? branchPolicies(forge, { repo, host, base }, prefix);
  } catch (error) {
    return { code: 3, error: `could not read the review trail or the team's config of #${pr} (${String(error?.message ?? error).split('\n')[0]})` };
  }
  // The record is read from the working copy's state folder, which must be the default branch's, as auto-merge holds it.
  const folder = stateDirProblem(working, policies.policy, `${repo} ${policies.main}`);
  if (folder) return out(false, folder);
  const state = record ? record(repo) : scoped(recordFor(project, pr, repo), project, repo);
  const ruled = (Array.isArray(state?.waivers) ? state.waivers : []).find((entry) => entry?.kind === 'round_cap' && typeof entry.head === 'string' && entry.head.toLowerCase() === head.toLowerCase());
  if (ruled) return out(false, `a judge already gave its verdict on head ${head.slice(0, 7)} (${ruled.verdict === 'waive' ? 'waive' : 'refuse'}): one judge rules per head`);
  const result = waiverMayRun({ project, config: working, state, pr, head, policies, repo, host, base, prefix, trail: () => trail, run: runId, runHost });
  return out(result.may === true, result.why ?? null);
}

// `aidrian pr waive <PR> --gate [--json]`: exit 0 when a judge may be dispatched for the pull request's current head, 1
// when not, 3 when the pull request, its trail, or its policies cannot be read (readGate).
export function runWaiveGate({ pr, json = false }, project, seams = {}) {
  const gate = readGate({ pr }, project, seams);
  if (gate.code === 3) {
    console.error(`aidrian pr waive: ${gate.error}`);
    return 3;
  }
  const { may, why, head, repo, base } = gate;
  console.log(json ? JSON.stringify({ may, why, pr, head, repo, base })
    : may ? `waiver may run for #${pr} at ${head.slice(0, 7)}: dispatch one fresh judge, and record its verdict with --head ${head} --judge <agent id>` : `waiver off for #${pr}: ${why}`);
  return gate.code;
}

// The review step's record at the cap as a judge's `land` would leave it: a check waiting for its judge is the cap
// standing once the judge stops it, so an `extension_check` outcome reads as `round_limit` on the same head, at the
// same time, with the same cause. Any other record is returned as it is.
export function asLanded(state) {
  if (state?.outcome?.status !== 'extension_check') return state;
  return { ...state, outcome: { ...state.outcome, status: 'round_limit' } };
}

// The `waiver` the review step reports at the cap (`round_limit` or `extension_check` on its head), so that a session
// runs no gate command of its own: { may, why }, readGate's answer for the record the step just wrote, an
// `extension_check` read as asLanded. A machine whose switch is off, or unset with the default branch's local ref
// committing no `solo`, makes no read at all; a read that fails says so in `why`. `result` is the step's result;
// `seams` readGate's.
export function offerWaiver(result, project, config, seams = {}) {
  const local = project.localUnattendedWaiver;
  const notIn = `this machine has not opted in (github.unattendedWaiver in ${project.paths.local})`;
  if (local !== 'on' && local !== 'unset') return { may: false, why: notIn };
  if (local === 'unset' && !localRefSolo(project)) return { may: false, why: notIn };
  let gate;
  try {
    gate = readGate({ pr: result.pr, repo: result.repo ?? null }, project, { config, ...seams, record: (repo) => asLanded(scoped(recordFor(project, result.pr, repo), project, repo)) });
  } catch (error) {
    return { may: false, why: `the gate could not be read (${String(error?.message ?? error).split('\n')[0]})` };
  }
  if (gate.code === 3) return { may: false, why: gate.error };
  if (gate.may && typeof result.head === 'string' && gate.head.toLowerCase() !== result.head.toLowerCase()) {
    return { may: false, why: `the pull request moved to ${gate.head.slice(0, 7)} after the step reviewed ${result.head.slice(0, 7)}: run the step again` };
  }
  return { may: gate.may, why: gate.why };
}
