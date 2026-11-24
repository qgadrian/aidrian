// `aidrian pr waive <PR> --verdict waive|refuse --reason TEXT [--head SHA]`: a judge's verdict, recorded in the review
// record (lib/review/state.mjs) under `waivers`, that the merge guard (lib/rules/github/merge-review.mjs) may take in place
// of the Human's answer to the merge guard's question, so an unattended run can finish. docs/config.md#unattended-waiver.
//
// It covers one denial only, `round_cap`: the review step's outcome on the merge's own head is `round_limit`, the round
// cap. Never a head the last review step did not cover, whatever that step's outcome (after `received` or `none_needed`
// on an earlier head, the review can still run on this one), an owed review, an outcome on the head with any other
// status (`blocked_quota`, `error`, `stuck`, `running`, `fix_required`, ...), a head or merge text the guard cannot
// read, or a record with no outcome. An entry of any other kind counts for nothing.
//
// A verdict never stands in for the review bot. It waives only the findings of this machine's own reviewers, the local
// and independent stages, open at the cap, and only when every one of them is of medium severity or lower, none is a
// security finding (critical or high, or marked, or the security reviewer's), no accepted residual above low holds the
// record (settled.mjs heldWaiver), and the review bot (the default branch's `github.reviewer`) passed exactly the head on
// the forge (merge-trust.mjs botProblem), read from the review trail, which also gives both branches' policy files, so
// the gate below reads no policy of its own. The record, the judge's verdict, and the dispatch log are all in folders a
// project run's confined session can write: the bot's pass is the part of the waiver no such session writes.
// `aidrian pr auto-merge` takes a standing verdict for `round_limit` too, and the gate says whether a judge may be
// dispatched at all (waiver-stand.mjs): `aidrian pr waive --gate`, and the `waiver` the review step reports at the cap,
// which `aidrian pr extend --verdict land` asks again before it records a `waive` here (appendVerdict). Each holds a
// project run to WAIVED_MERGES. The guard and auto-merge
// each take a verdict only for the judge the recording session's dispatch log shows (judgeProblem). A merge no Human
// attends still meets every merge-trust check; the waiver lifts only the `round_limit` stop, and a project run's waived
// merge is taken from its budget only after those checks pass (readWaiver `take`).
//
// The guard honors a verdict only while both switches are on: `github.unattendedWaiver.allow` true in config.json on both
// the repository's default branch and the pull request's base, read from GitHub as each branch commits it now, never
// from the working copy (as auto-merge's team gate, pr-auto-merge.mjs branchPolicies), and `github.unattendedWaiver` "on"
// in the main checkout's untracked local file (project.localUnattendedWaiver), or, with that switch unset, the team's
// `solo` committed true on both branches, read with the team's value (config-local.mjs machineSwitch) after the default
// branch's local ref says so (lib/solo.mjs). Any read that fails, or would start too late for the hook's 5 s, keeps the
// denial.
//
// The trust limit: a verdict an agent records is the session's word, not proof. A session with a shell can record one and
// merge under both switches, and the machine switch is the main session's to set, as auto-merge's is. Only the team's
// `allow`, read from GitHub, is out of a session's reach. A verdict shows in the pull request's summary comment only when
// `review.record` is "comment" and the post succeeds (`summary_error` says when it did not). For proof, protect the
// default and base branches with a required review from a second account.

import { loadConfig, machineSwitch, resolveUnattendedWaiver } from '../config.mjs';
import { readLog } from '../dispatch-log.mjs';
import { forgeFor } from '../forges/index.mjs';
import { knownPrefix } from '../git.mjs';
import { sessionIdentity } from '../hosts/index.mjs';
// A cycle: pr-auto-merge.mjs imports merge-review.mjs, which imports this file. It is benign while each module uses the
// other's exports only inside functions, never while it loads: keep it that way.
import { branchPolicies, refusingBranches, soloOn, trailPaths, trailPolicies } from '../pr-auto-merge.mjs';
import { isObject } from '../fs.mjs';
import { stateFolders } from '../handoff-guard.mjs';
import { appendToRun, readRun } from '../project-run.mjs';
import { mayFollowTeamDefault } from '../project.mjs';
import { hostOf } from '../remotes.mjs';
import { forgeRepo, repoName } from '../review-gate.mjs';
import { localRefSolo, viewSolo } from '../solo.mjs';
import { isFindingId, noHigher, severityOf } from './findings.mjs';
import { boundedReads, holdToBase } from './in-force.mjs';
import { botProblem, flowsFloor, readHumanSignoffs, recordedFlows, signoffProblem, unsignedFlows } from './merge-trust.mjs';
import { postContext, readReading } from './dispatch.mjs';
import { heldWaiver } from './settled.mjs';
import { heldMessage, mergePending, owed, publishState, readLocalState, readRecord, sameCommit, SHA_REF, writeLocalState } from './state.mjs';

export const VERDICTS = Object.freeze(['waive', 'refuse']);
// A judge's agent id as `--judge` takes it.
export const JUDGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
// The longest reason a verdict keeps: the summary comment shows the first 300 characters of it.
export const MAX_REASON = 2000;

// The guard's budget inside the hook's 5 s, counted from when the hook's process started (`startedAt`), one for the whole
// command. guardWaiver checks GATE_START_MS once, before its first read, so the waiver starts reading (the view, git's
// project folder, the forge reads) only when at most that much has gone; its later reads, and the guard's own head
// lookup, are held to the deadline alone. None begins at or after WAIVER_DEADLINE_MS, and each is stopped with SIGKILL after READ_TIMEOUT_MS
// (VIEW_TIMEOUT_MS for the view), or at that deadline if sooner.
export const GATE_START_MS = 1500;
// Accepted residual: a denial reached at the deadline is then logged by the hook's block(), with about 1 s left of the
// host's 5 s. A log slow enough to spend it is contrived; the host then lets the command run.
export const WAIVER_DEADLINE_MS = 4000;
export const READ_TIMEOUT_MS = 1000;
export const VIEW_TIMEOUT_MS = 3000;
const VIEW_FIELDS = 'number,headRefOid,baseRefName,url';

// `aidrian pr waive <PR> --verdict waive|refuse --reason TEXT [--head SHA] [--judge AGENT_ID]`: { pr, verdict, reason,
// head, judge }; or `aidrian pr waive <PR> --gate [--json]`: { pr, gate: true, json }.
export function parseWaive(args) {
  const [ref, ...rest] = args;
  const match = /^#?(\d+)$/u.exec(ref ?? '') ?? /\/pull\/(\d+)/u.exec(ref ?? '');
  if (!match) throw new Error('waive needs a pull request number');
  if (rest.includes('--gate')) {
    const extra = rest.find((arg) => arg !== '--gate' && arg !== '--json');
    if (extra !== undefined) throw new Error(`--gate takes only --json, not ${extra}`);
    return { pr: Number(match[1]), gate: true, json: rest.includes('--json') };
  }
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!['--verdict', '--reason', '--head', '--judge'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  if (flags.judge !== undefined && !JUDGE_ID.test(flags.judge)) throw new Error('--judge must be the judge\'s agent id, as the host returned it when the judge was dispatched');
  if (!VERDICTS.includes(flags.verdict)) throw new Error('--verdict must be waive or refuse');
  if (!flags.reason?.trim()) throw new Error('--verdict needs --reason with the evidence');
  if (flags.reason.trim().length > MAX_REASON) throw new Error(`--reason is longer than ${MAX_REASON} characters: give the evidence, and link the rest`);
  if (flags.head !== undefined && !SHA_REF.test(flags.head)) throw new Error('--head must be a commit SHA');
  return { pr: Number(match[1]), verdict: flags.verdict, reason: flags.reason.trim(), head: flags.head ?? null, judge: flags.judge ?? null };
}

// The kind of denial a verdict may waive for a merge of `head`, or null when none may: `round_cap` when nothing is owed
// and the outcome on record is `round_limit` on that very head. A head the outcome does not cover is never waived.
export function waiverKind(state, head) {
  if (!state || owed(state).length) return null;
  const outcome = state.outcome ?? null;
  if (!outcome || typeof outcome.head !== 'string' || typeof head !== 'string') return null;
  return sameCommit(outcome.head, head) && outcome.status === 'round_limit' ? 'round_cap' : null;
}

// The highest severity of a finding open at the cap that a verdict may waive.
export const WAIVER_CEILING = 'medium';
// A reviewer of the security stage, by the name a plan or a pass result gives it.
const SECURITY_REVIEWER = /security-engineer/iu;

// The stages whose open findings a verdict may waive: this machine's own reviewers.
const WAIVABLE_STAGES = new Set(['local', 'independent']);
// What a refusal prints of a value a record holds: the value only when it has the shape it should, else a placeholder.
const shown = (value, pattern, placeholder) => (typeof value === 'string' && pattern.test(value) ? value : placeholder);
const FLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const PASS_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/u;
const findingName = (id) => (isFindingId(id) ? `finding ${id}` : 'a finding');

// Why one open item keeps a verdict from standing, or null: `item` is { id, severity, security, stage, reviewer, pass }.
function itemProblem(item, stageOf) {
  const name = findingName(item.id);
  const stage = item.stage ?? stageOf(item.pass);
  if (!WAIVABLE_STAGES.has(stage) || item.reviewer === 'pr-bot') return `${name} is not one of this machine's reviewers' (stage ${shown(stage, PASS_NAME, 'unknown')}), and a verdict waives only theirs`;
  if (!noHigher(item.severity, WAIVER_CEILING)) return `${name} is ${severityOf(item.severity) ?? 'of no known severity'}, above ${WAIVER_CEILING}, which only the Human lets merge`;
  if (item.security === true || SECURITY_REVIEWER.test(String(item.reviewer ?? '')) || SECURITY_REVIEWER.test(String(item.pass ?? ''))) return `${name} is a security finding, which only the Human lets merge`;
  return null;
}

// The agent a waiver's judge is, as a host names it in the dispatch log: the plugin's code-reviewer, or a project's.
const JUDGE_TYPE = /^(?:aidrian[:-])?code-reviewer$/u;
// A session id as a refusal prints it: a host's ids are letters, digits, and dashes.
const SESSION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;

// Why the verdict `entry` names no judge this session dispatched, or null: the recording session's dispatch log
// (`config`'s state folder) must hold a `dispatch` row of that session for the agent id `entry.judge_id`, a
// code-reviewer, at or after the cap's outcome and at or before the verdict. `aidrian pr auto-merge` and the merge guard
// each ask it of the verdict they take, so one recorded with no `--judge` never stands.
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
  const judge = JUDGE_ID.test(entry.judge_id) ? entry.judge_id : '(an id of no known shape)';
  const session = SESSION_SHAPE.test(entry.session) ? entry.session : '(an id of no known shape)';
  return dispatched ? null : `the dispatch log holds no dispatch of the code-reviewer ${judge} by session ${session} between the cap and the verdict`;
}

// Why what stopped the review at the cap keeps a judge's verdict from standing for `head`, or null. It reads the cap's
// cause, which the review step keeps on the outcome (review/run.mjs capCause): a verdict stands only when open findings
// of this machine's own reviewers are the whole cause. Refused: a record with no cause for `head` (an older record); a
// cause a step judged past the cap by attested results alone (`past_cap`), which read no flow check; the review bot's
// own round limit; a flow left with an invariant violated, unverified, or unsigned, on this round or, for
// a head no round reviewed, the last one; a flow test deleted; a failing flow check; a pass of this machine that never
// reviewed the head; open findings counted and not listed one by one; and any listed finding of the review bot or a
// stage not this machine's, above WAIVER_CEILING or of no known severity, or a security finding (marked, which
// findings.mjs tieTwins does for critical, high, and their twins, from a security pass, or the security reviewer's).
// The finding index is read too: every open entry meets the same rules, its stage from the entry or the plan note.
// An accepted residual above low on any pass record (settled.mjs heldWaiver) refuses as well. The Human's sign-offs are
// signoffOwed's.
export function capProblem(state, head) {
  if (heldWaiver(state)) return 'an accepted residual waived a finding above low severity, and only the Human lets that merge';
  const cause = state?.outcome?.cap;
  if (!isObject(cause) || typeof cause.head !== 'string' || !sameCommit(cause.head, head)) {
    return 'the record keeps no cause of the round cap on this head, as a record from an older plugin, so what stopped the review cannot be told';
  }
  if (cause.past_cap === true) return 'a step past the cap judged this head by attested results alone, before its flow checks: it needs a review round, the Human\'s extra round, before any waiver';
  if (cause.bot === true) return 'the review bot reached its own round limit, and a verdict never stands in for the bot';
  const listOf = (value) => (Array.isArray(value) ? value : null);
  const flows = [...(listOf(cause.flows) ?? []), ...(listOf(cause.unsigned) ?? [])];
  if (listOf(cause.unsigned) === null) return 'the round the record kept for the cap names no flows it left unsigned, so whether one was cannot be told';
  if (flows.length) return `flow ${shown(flows[0], FLOW_NAME, 'with no readable name')} has an invariant violated, unverified, or unsigned, which a fix or the Human settles, never a verdict`;
  if (listOf(cause.tests_removed)?.length) return `the change deletes a test of flow ${shown(cause.tests_removed[0], FLOW_NAME, 'with no readable name')}, which only the Human accepts`;
  if (cause.checks_failing !== 0) return 'a check the flows require fails on this head';
  if (listOf(cause.unrun) === null || cause.unrun.length) return `pass ${shown(cause.unrun?.[0], PASS_NAME, 'of this machine')} never reviewed this head`;
  if (cause.itemized !== true || !Number.isInteger(cause.counted)) return `${Number.isInteger(cause.counted) ? `${cause.counted} open findings are` : 'the open findings are'} counted, not each listed with its severity`;
  const stageOf = (pass) => state.planNote?.passes?.[pass]?.stage ?? state.dispatched?.[pass]?.stage ?? null;
  for (const item of listOf(cause.items) ?? []) {
    const problem = itemProblem(isObject(item) ? item : {}, stageOf);
    if (problem) return problem;
  }
  for (const entry of Object.values(isObject(state?.index) ? state.index : {})) {
    if (!isObject(entry) || entry.state !== 'open') continue;
    const problem = itemProblem(entry, stageOf);
    if (problem) return problem;
  }
  return null;
}

// Why a sign-off of the Human's that a merge of `head` owes keeps a verdict from standing, or null. A verdict never
// lifts one: every flow the record names for the Human on that head (`signoffable`, which it must name for exactly that
// head), every flow the forge's file list and both branches' configs may select (merge-trust.mjs flowsFloor), and every
// flow the cap's cause names, needs a sign-off on exactly `head` in the sign-off store (merge-trust.mjs signoffProblem),
// attended or not. `trail` is the forge's review trail, `policies` branchPolicies' answer.
export const signoffOwed = (args) => owedSignoffs(args)?.why ?? null;

// signoffOwed's answer with the flows it is for: { why, unsigned } or null, `unsigned` every flow, sorted, whose sign-off
// is missing on `head`, every flow when the store cannot be read, and none when the record names no flows for that head.
export function owedSignoffs({ state, head, trail, policies, prefix, repo, pr, signoffs = null }) {
  if (!isObject(state?.signoffable) || typeof state.signoffable.head !== 'string' || !sameCommit(state.signoffable.head, head)) {
    return { why: 'the record names no flows the Human signs off on this head, so whether a sign-off is owed cannot be told', unsigned: [] };
  }
  const floor = flowsFloor({ files: Array.isArray(trail?.files) ? trail.files : [], complete: trail?.filesComplete === true, configs: [policies.policy, policies.basePolicy], prefix, policyFiles: policies.policyFiles });
  const human = Array.isArray(state.outcome?.cap?.human) ? state.outcome.cap.human.filter((flow) => typeof flow === 'string') : [];
  const flows = new Set([...recordedFlows(state, head), ...floor.flows, ...human]);
  const store = signoffs ?? readHumanSignoffs({ repo, pr });
  const why = signoffProblem({ flows, reasons: floor.reasons, signoffs: store, head });
  return why ? { why, unsigned: unsignedFlows({ flows, signoffs: store, head }) } : null;
}

// The most pull requests one project run merges on a judge's verdict; past it, the issue is parked for the Human.
export const WAIVED_MERGES = 3;

// The project run a session's unattended mark names, or the run a driver's hold drives (run-driver.mjs driverHold
// `driving`): undefined for none, the run id, or null when the mark carries run tags that cannot be read, which no
// budget can count.
export function runOf(mark) {
  const key = ['project', 'driving'].find((each) => mark && Object.hasOwn(mark, each));
  if (key === undefined) return undefined;
  return typeof mark[key] === 'string' ? mark[key] : null;
}

// The ledger of the project run `run`, readRun's answer from the first state folder of `project` (the main checkout,
// whose config names its state folders, as the merge guard's pinnedFor reads it) that holds it, or null.
export function runLedger({ project, config, run }) {
  return runAt({ project, config, run })?.found ?? null;
}

// runLedger's answer with the state folder it was read in: { state, found }, or null.
function runAt({ project, config, run }) {
  for (const state of stateFolders(project, config, { lazy: true })) {
    const found = readRun(state, run);
    if (!found.problem) return { state, found };
  }
  return null;
}

// The pull requests of the run `found` whose merge on a judge's verdict the merge guard took from the run's budget at
// merge time (takeWaivedMerge): its `waived` rows.
const takenMerges = (found) => new Set(found.rows.filter((row) => row?.event === 'waived' && Number.isInteger(row.pr)).map((row) => row.pr));

// Thrown when a count runs out of the hook's time.
class OutOfTime extends Error {}

// How many pull requests the project run `run` merged, other than `pr`, on a judge's verdict: those the merge guard took
// from the budget at merge time (takenMerges), and its ledger's merged results whose review record, read in `project`,
// holds a `waive` that stands for the head its outcome names, the head that merged (waiverFor); or null when the run's
// ledger cannot be read. The ledger is read through `home`, the main checkout, and its config, or given as `found`. It
// stops counting at WAIVED_MERGES, and `pastDeadline()` is asked before each record read: past it, the count throws
// OutOfTime.
export function waivedMerges({ project, home = project, config, run, pr, pastDeadline = () => false, found = runLedger({ project: home, config, run }) }) {
  if (!found) return null;
  const { owner, name } = found.init.repository;
  const taken = takenMerges(found);
  taken.delete(pr);
  const merged = new Set(found.rows.filter((row) => row?.event === 'result' && row.status === 'merged' && Number.isInteger(row.pr) && row.pr !== pr && !taken.has(row.pr)).map((row) => row.pr));
  let count = taken.size;
  for (const n of merged) {
    if (count >= WAIVED_MERGES) break;
    if (pastDeadline()) throw new OutOfTime();
    const record = readLocalState(project, n, `${owner}/${name}`);
    if (typeof record?.outcome?.head === 'string' && waiverFor(record, record.outcome.head, 'round_cap') !== null) count += 1;
  }
  return count;
}

// Why the run's budget keeps a verdict from standing for `pr`, or null. `run` is runOf's answer; `home` and `config`
// the main checkout and its config, which name the ledger's state folders; `pastDeadline` the hook's clock.
export function budgetProblem({ project, home = project, config, run, pr, pastDeadline = () => false }) {
  if (run === undefined) return null;
  if (run === null) return 'this session\'s unattended mark names a project run that cannot be read, so the run\'s waived merges cannot be counted';
  let spent;
  try {
    spent = waivedMerges({ project, home, config, run, pr, pastDeadline });
  } catch (error) {
    if (error instanceof OutOfTime) return 'the hook ran out of time counting the project run\'s waived merges';
    spent = null;
  }
  if (spent === null) return `the ledger of project run ${shown(run, PASS_NAME, 'named')} cannot be read, so its waived merges cannot be counted`;
  return spent >= WAIVED_MERGES ? `project run ${run} merged ${spent} pull requests on a judge's verdict already, its most (${WAIVED_MERGES}): park the issue for the Human` : null;
}

// Takes pull request `pr`'s merge at `head` on a judge's verdict from the budget of project run `run`, at merge time, under
// the run's ledger lock: the budget is counted again under the lock (waivedMerges), and, below WAIVED_MERGES, a `waived`
// row is written for `pr`, unless one is there already. So the sessions of parallel issues, each of which counted the
// budget before its merge, never pass it together. Returns why the merge may not take it, or null. The lock is waited
// on at most `waitMs`; a lock it cannot take, a ledger it cannot read or write, and a count past `pastDeadline()` refuse.
export function takeWaivedMerge({ project, home = project, config, run, pr, head, pastDeadline = () => false, waitMs = 1000, now = Date.now() }) {
  const place = runAt({ project: home, config, run });
  if (!place) return `the ledger of project run ${shown(run, PASS_NAME, 'named')} cannot be read, so its waived merges cannot be counted`;
  let answer;
  try {
    answer = appendToRun(place.state, run, (found) => {
      if (takenMerges(found).has(pr)) return { rows: [] };
      const spent = waivedMerges({ project, home, config, run, pr, pastDeadline, found });
      if (spent >= WAIVED_MERGES) return { problem: `project run ${run} merged ${spent} pull requests on a judge's verdict already, its most (${WAIVED_MERGES}): park the issue for the Human` };
      return { rows: [{ event: 'waived', pr, head, at: new Date(now).toISOString() }] };
    }, { waitMs });
  } catch (error) {
    if (error instanceof OutOfTime) return 'the hook ran out of time counting the project run\'s waived merges';
    return `the ledger of project run ${run} could not be locked or written to take this merge from its budget of waived merges (${String(error?.message ?? error).split('\n')[0]}); try the merge again`;
  }
  return answer.problem ?? null;
}

// Why no verdict may be recorded for `head`, for runWaive's error and the gate's.
export function notWaivable(state, head, pr) {
  const sha7 = String(head).slice(0, 7);
  const owing = owed(state);
  if (owing.length) return `${owing.length} review ${owing.length === 1 ? 'entry is' : 'entries are'} still owed on #${pr}: a verdict never covers an owed review`;
  const outcome = state.outcome ?? null;
  if (!outcome) return `the review record of #${pr} holds no outcome: run \`aidrian pr review ${pr}\` first`;
  const prior = String(outcome.head).slice(0, 7);
  if (sameCommit(outcome.head, head)) return `the review of head ${sha7} is ${outcome.status}: a verdict covers only round_limit on the current head`;
  return `the last review step covered ${prior}, not head ${sha7}: a verdict covers only round_limit on the current head, so run \`aidrian pr review ${pr}\` on it`;
}

// The verdict that stands for a merge of `head` under `kind`: the last entry of `state.waivers` for that head and kind,
// when it says waive and was given at or after the outcome, as the Human's answer must be; else null. A later refuse
// for the same head withdraws an earlier waive. An outcome or entry whose time cannot be read lets none stand.
export function waiverFor(state, head, kind) {
  const entries = (Array.isArray(state?.waivers) ? state.waivers : []).filter((entry) => entry && sameCommit(entry.head, head) && entry.kind === kind);
  const last = entries.at(-1) ?? null;
  if (last?.verdict !== 'waive') return null;
  const since = Date.parse(state.outcome?.at ?? '');
  const at = Date.parse(last.at ?? '');
  return !Number.isNaN(since) && !Number.isNaN(at) && at >= since ? last : null;
}

// The forge methods the waiver calls, each under the one `deadline` (a Date.now() value): a call gets the time left, at
// most its own cap, is stopped with SIGKILL at it, and none begins at or after the deadline. `make(options)` builds the
// forge facade for one call's options, forgeFor's at the project root unless a test passes its own.
export function budgetedForge(make, deadline, now = Date.now) {
  const call = (name, cap) => (...args) => {
    // Whole milliseconds: execFileSync refuses a fractional timeout, and `startedAt` (performance.timeOrigin) is one.
    const left = Math.floor(deadline - now());
    if (left <= 0) throw new Error(`no time left in the hook to read ${name}`);
    return make({ timeoutMs: Math.min(cap, left), killSignal: 'SIGKILL' })[name](...args);
  };
  return {
    change: call('change', VIEW_TIMEOUT_MS), repository: call('repository', READ_TIMEOUT_MS), contents: call('contents', READ_TIMEOUT_MS),
    // The head's compare with its base, which the policy-file lift reads (pr-auto-merge.mjs headPolicyProblem).
    compare: call('compare', READ_TIMEOUT_MS),
    // The merge guard's trust read for a session no Human attends (merge-review.mjs), one GraphQL call, as long as a view.
    reviewTrail: call('reviewTrail', VIEW_TIMEOUT_MS),
  };
}

// Whether both switches let a verdict stand: { on, reason: null | 'local' | 'team' | 'unread', refusing, why }. The team
// value is read at the default branch and at `base` on GitHub, through `forge`; `prefix` is the project's folder from the
// top of the repository (null: unknown, so unread). Any failed read is `unread`, and keeps it off. A machine switch left
// unset follows the team's `solo` from the same reads, once the default branch's local ref says so too and the local
// file is no tracked one (config-local.mjs machineSwitch). `localSolo` is that local answer when the caller read it
// already, inside its own deadline, as the merge guard does (readWaiver); null reads it here, for a command.
// `policies`, branchPolicies' answer the caller read already (from a review trail, or for auto-merge's own team check),
// is taken as it is, and then nothing is read from the forge here.
export function waiverGate({ project, forge, repo, host, base, prefix, localSolo = null, memo = null, policies = null }) {
  const local = project.localUnattendedWaiver;
  const notIn = { on: false, reason: 'local', refusing: [], why: `this machine has not opted in (github.unattendedWaiver in ${project.paths.local})` };
  if (local !== 'on' && local !== 'unset') return notIn;
  if (!repo || !host || !base || prefix === null) return { on: false, reason: 'unread', refusing: [], why: 'the pull request\'s repository, host, base, or the project\'s folder could not be read' };
  if (!policies) {
    try {
      policies = branchPolicies(forge, { repo, host, base }, prefix);
    } catch (error) {
      return { on: false, reason: 'unread', refusing: [], why: error.message };
    }
  }
  // The merge guard's trust check for a session no Human attends reuses them (merge-review.mjs unattendedProblem).
  if (memo) memo.policies = { key: `${repo}|${base}|${prefix}`, value: policies };
  const refusing = refusingBranches(policies, base, 'unattendedWaiver');
  const allow = refusing.length === 0;
  const machine = allow ? machineSwitch(local, () => soloOn(policies) && (localSolo ?? localRefSolo(project)), project, localSolo ?? undefined) : local;
  const { effective, reason } = resolveUnattendedWaiver({ unattendedWaiver: { allow } }, machine);
  const why = reason === 'team' ? `the team does not allow it (github.unattendedWaiver.allow on ${repo} ${refusing.join(' and ')})` : reason === 'local' ? notIn.why : null;
  return { on: effective, reason, refusing, why };
}

const UNREAD_NOTE = ', and the team\'s github.unattendedWaiver could not be read in time';

// The key of a review trail kept in the merge guard's `memo`, so merge trust reads it only when the waiver did not.
export const trailKey = (repo, host, pr, prefix) => `${String(repo).toLowerCase()}|${String(host).toLowerCase()}|${pr}|${prefix}`;

// What the merge guard makes of a verdict for a denial it is about to give: { allow, note, route }. Asked only after the
// Human's answer did not waive it. Nothing is read, from the network or git, unless the record holds an outcome with
// nothing owed and this machine's switch is on, or is unset and may follow the team's `solo`: then git is read first,
// once, every read bounded to the time left (in-force.mjs boundedReads), and the network only when the default branch's
// local ref commits solo and the local file is untracked; a read that fails or runs out of time is no solo. `named`: the merge names its head (`--match-head-commit`, `sha=`, the MCP
// `sha`), the only merge a verdict counts for, since gh would otherwise merge whatever head the branch has by then.
// `view` is the guard's earlier view, null when it made none. `forge` is budgetedForge's `make`, the test seam;
// `startedAt` when the hook's process started, by `now`, the one clock for every merge of one command. `memo`, when given,
// keeps the review trail and the policies the gate read, for the merge guard's trust check.
// The forge reads, after the view: the review trail, one GraphQL call, which gives both branches' policy files (only a
// pointer to another folder reads them over REST too) and the review bot's verdict. With the gate on, a verdict stands
// only when capProblem passes and the bot passed exactly the head (merge-trust.mjs botProblem).
// Any throw, from a read or the clock, is the `unread` denial: the hook's own catch would let the merge run.
export function guardWaiver(args) {
  try {
    return readWaiver(args);
  } catch {
    return { allow: false, note: UNREAD_NOTE, route: '' };
  }
}

function readWaiver({ project, state, pr, head, named = false, repo = null, view = null, forge = null, startedAt, now = Date.now, memo = null }) {
  const none = { allow: false, note: '', route: '' };
  const local = project.localUnattendedWaiver;
  if ((local !== 'on' && local !== 'unset') || !state?.outcome || owed(state).length) return none;
  const kind = waiverKind(state, head);
  if (kind === null) return none;
  const deadline = startedAt + WAIVER_DEADLINE_MS;
  // An unset switch may follow the team's `solo` only when the default branch's local ref commits it and git tracks no
  // local file: every git read that needs, done once here, before the start check, and each held to the deadline. Else
  // nothing is read from the network, and a read that fails says nothing of a switch this machine never turned on.
  let localSolo = null;
  if (local === 'unset') {
    const git = boundedReads(deadline, now);
    try {
      localSolo = localRefSolo(project, git) && mayFollowTeamDefault(project, git());
    } catch {
      localSolo = false;
    }
    if (!localSolo) return none;
  }
  const unread = local === 'on' ? { ...none, note: UNREAD_NOTE } : none;
  // The one start check, before the first forge read: every one follows it.
  if (now() - startedAt > GATE_START_MS) return unread;
  const reads = budgetedForge(forge ?? ((options) => forgeFor(project.root, options)), deadline, now);
  let seen = view?.baseRefName && view?.url ? view : null;
  if (!seen) {
    try {
      seen = reads.change(String(pr), VIEW_FIELDS, { repo });
    } catch {
      return unread;
    }
  }
  const base = typeof seen?.baseRefName === 'string' && seen.baseRefName !== '' ? seen.baseRefName : null;
  const host = typeof seen?.url === 'string' ? hostOf(seen.url) : null;
  const home = typeof seen?.url === 'string' ? repoName(seen.url) : null;
  if (!base || !host || !home) return unread;
  const rest = Math.floor(deadline - now());
  const prefix = rest > 0 ? knownPrefix(project.root, { timeout: Math.min(READ_TIMEOUT_MS, rest) }) : null;
  if (prefix === null) return unread;
  // One read gives both branches' policy files and the review bot's verdict: the review trail, which merge trust reads
  // too (merge-review.mjs unattendedProblem takes it from `memo`). Only a pointer to another folder reads the policies
  // over REST as well.
  let trail;
  let policies;
  try {
    trail = reads.reviewTrail(home, pr, { host, paths: trailPaths(prefix) });
    policies = trailPolicies(trail, { repo: home, base }, prefix) ?? branchPolicies(reads, { repo: home, host, base }, prefix);
  } catch {
    return unread;
  }
  if (memo) memo.trail = { key: trailKey(home, host, pr, prefix), value: trail };
  const gate = waiverGate({ project, forge: reads, repo: home, host, base, prefix, localSolo, memo, policies });
  if (gate.reason === 'unread') return unread;
  if (!gate.on) return none;
  // A verdict never stands in for the review bot, and never lifts what else stopped the review or a sign-off the Human
  // owes: each is read before the verdict, so the denial says why none can stand. The sign-off store and the run's
  // ledger and records are read only with time left in the hook.
  const cannot = (why) => ({ ...none, route: ` A judge's verdict cannot stand for this head: ${why}.` });
  // Past the deadline only: a read that ends on it, as budgetedForge's last may, is in time.
  const late = () => now() > deadline;
  const bot = botProblem(trail, head, policies.policy.github.reviewer);
  if (bot) return cannot(`it never stands in for the review bot, and ${bot}`);
  const cap = capProblem(state, head);
  if (cap) return cannot(cap);
  if (late()) return unread;
  const owes = signoffOwed({ state, head, trail, policies, prefix, repo: home, pr });
  if (owes) return cannot(owes);
  // A session of a project run is held to the run's budget of waived merges (`memo.run`), its ledger read through the
  // main checkout and its config (`memo.home`, merge-review.mjs check), as the guard reads the run's pinned repository.
  if (late()) return unread;
  const main = memo?.home ?? project;
  const budget = memo && memo.run !== undefined ? budgetProblem({ project, home: main, config: loadConfig(main).config, run: memo.run, pr, pastDeadline: late }) : null;
  if (budget) return cannot(budget);
  const verdict = waiverFor(state, head, kind);
  if (verdict && named) {
    // A verdict stands only for the judge the recording session's dispatch log shows it dispatched, as auto-merge's does:
    // a session that skips auto-merge cannot merge on a verdict it recorded with no judge.
    if (late()) return unread;
    const unseen = judgeProblem({ project, config: loadConfig(project).config, state, entry: verdict });
    if (unseen) return cannot(unseen);
    // A session of a project run takes the merge from the run's budget under the ledger's lock, so parallel issues never
    // spend more than it holds between them, and only once the merge guard's every other check passed: `take()`, which
    // the guard calls last (merge-review.mjs takeWaived), gives why the budget refuses, or null once it is taken.
    if (memo && memo.run !== undefined) {
      const take = () => {
        if (late()) return 'the hook ran out of time to take this merge from the project run\'s budget of waived merges';
        return takeWaivedMerge({ project, home: main, config: loadConfig(main).config, run: memo.run, pr, head, pastDeadline: late, waitMs: Math.max(0, Math.min(1000, Math.floor(deadline - now()))) });
      };
      return { allow: true, note: '', route: '', take };
    }
    return { allow: true, note: '', route: '' };
  }
  if (verdict) {
    return { ...none, route: ` A judge's recorded verdict waives this head, but only for a merge that names it: merge with \`gh pr merge ${pr} --match-head-commit ${head} --repo ${home}\`, or give the merge tool its \`sha\`.` };
  }
  return {
    ...none,
    route: ` Or, under the unattended waiver this repository allows (github.unattendedWaiver), a run with no Human present reads \`waiver\` in the JSON of \`aidrian pr review ${pr} --repo ${home}\`, and only when it says a judge may rule runs the one judge its \`dispatch\` names, as the pr-review-loop skill's references/review-plan.md § At the cap says, then records that judge's verdict with \`aidrian pr extend ${pr} --verdict land|stop --reason "<evidence>" --head ${head} --judge <agent id> --repo ${home}\`, and on \`land\` merges naming that head.`,
  };
}

// What to run after a recorded verdict, naming the pull request's repository `repo` (`owner/name`) when known, so the
// merge acts on that repository whatever the checkout's default.
export const verdictNext = (entry, pr, local, repo = null) => (entry.verdict === 'waive'
  ? `merge with \`gh pr merge ${pr} --match-head-commit ${entry.head}${repo ? ` --repo ${repo}` : ''}\`: the merge guard accepts this verdict only while github.unattendedWaiver.allow is true on the base and default branches and the switch is on in ${local}`
  : 'the guard stands: the Human merges, or answers the merge guard\'s question with "Merge with the findings filed"');

// The CLI body. It reads and writes the record where the review step does: this machine's state folder and, unless the
// base branch's `review.record` is "local", the pull request's summary comment. The entries owed on this machine are
// merged in first, as the review step does, so a newer record from the comment never hides one; and when this machine's
// record changes before the write, nothing is written. `deps.forge` replaces the forge (change, conversationComments,
// postComment, editComment, viewer), `deps.repo` the pull request's repository, and `deps.env` the environment, in tests.
// That repository is resolved once, from a lookup of the pull request on the forge (review-gate.mjs forgeRepo), never
// origin in its place: a lookup that fails exits 3 with nothing written (VERDICT_UNREAD). Every forge read, the record,
// and the printed `next` use that one value, so in a fork checkout a verdict never lands on, or merges, the other
// repository's pull request of the same number.
export async function runWaive(args, project, config, deps = {}) {
  const url = urlRef(args[0]);
  if (url !== null && !args.includes('--gate')) {
    // Fixed text: nothing the URL holds reaches the message.
    console.error('aidrian pr waive: a verdict takes the pull request\'s number, not a URL; `aidrian pr waive <n>` reads the number in gh\'s default repository; for another repository, a dispatched judge\'s verdict is recorded with `aidrian pr extend <n> --verdict land|stop --reason "<evidence>" --head <sha> --judge <agent id> --repo OWNER/NAME`.');
    return USAGE;
  }
  const opts = parseWaive(args);
  if (opts.gate) return (await import('./waiver-stand.mjs')).runWaiveGate(opts, project, { config, ...(deps.forge ? { forge: deps.forge } : {}), ...(deps.gate ?? {}) });
  const machine = project.localUnattendedWaiver;
  const switchOff = () => new Error(`this machine's github.unattendedWaiver is not on in ${project.paths.local}, so the merge guard would not take a waive verdict; --verdict refuse is still recorded`);
  if (opts.verdict === 'waive' && machine !== 'on' && machine !== 'unset') throw switchOff();
  const forge = deps.forge ?? forgeFor(project.root);
  const repo = deps.repo ?? forgeRepo(opts.pr, forge);
  if (!repo) {
    console.error(`aidrian pr waive: ${unreadRepo(opts.pr)}`);
    return VERDICT_UNREAD;
  }
  // The record is read only from the state.dir the pull request's base branch commits, so a verdict needs that base.
  let base = null;
  try {
    base = forge.change(String(opts.pr), 'baseRefName', { repo })?.baseRefName ?? null;
  } catch {}
  if (!base) throw new Error('cannot read the pull request\'s base branch: the review record is read from the state.dir it commits');
  const { committed } = holdToBase(project, config, { repo, base });
  const onPr = committed.review.record !== 'local';
  let comments = [];
  if (onPr) {
    try {
      comments = forge.conversationComments(repo, opts.pr);
    } catch {}
  }
  const local = readLocalState(project, opts.pr, repo);
  const record = readRecord(project, opts.pr, comments, repo, () => readReading(forge, repo, opts.pr));
  if (record.held !== undefined) throw new Error(heldMessage(opts.pr, record.held, record.why, record.finding));
  const { state } = record;
  state.pending = mergePending(local?.pending, state.pending);
  let current = null;
  let viewed = null;
  try {
    viewed = forge.change(String(opts.pr), 'number,headRefOid,url', { repo });
    current = viewed?.headRefOid ?? null;
  } catch {}
  if (typeof current !== 'string' || !SHA_REF.test(current)) throw new Error('cannot read the pull request\'s head: a verdict binds to one head');
  const head = opts.head ?? current;
  if (!sameCommit(head, current)) throw new Error(`the pull request's head is ${current.slice(0, 7)}, not ${head.slice(0, 7)}: the verdict binds to the current head`);
  // An unset switch follows the team's `solo`, read at the base on the forge as the guard reads it.
  if (opts.verdict === 'waive' && machineSwitch(machine, () => viewSolo(project, { baseRefName: base, url: viewed?.url }, { forge }), project) !== 'on') throw switchOff();
  const entry = appendVerdict(state, { project, config, pr: opts.pr, head: current, verdict: opts.verdict, reason: opts.reason, judge: opts.judge, env: deps.env ?? process.env });
  // A request or a review step written since the read would be lost under this write: refused, and nothing written.
  sameRevision(project, opts.pr, repo, local);
  writeLocalState(project, state, { repo });
  const summaryError = onPr ? publishState(state, { comments: () => comments, post: (body) => forge.postComment(repo, opts.pr, body), edit: (id, body) => forge.editComment(repo, id, body), viewer: () => forge.viewer() }, `waiver ${opts.verdict}`, postContext({ forge, repo, n: opts.pr, project, configs: [committed, config], env: deps.env ?? process.env })) : null;
  console.log(JSON.stringify({ status: 'recorded', pr: opts.pr, waiver: entry, next: verdictNext(entry, opts.pr, project.paths.local, repo), ...(summaryError ? { summary_error: summaryError } : {}) }, null, 2));
  return 0;
}

// A command that records a judge's verdict takes the pull request's number alone: a URL could name a repository other
// than the one its reads resolve (forgeRepo), so it is refused as a usage error, exit USAGE. `urlRef` gives the number a
// pull request URL names, or null for anything else.
export const USAGE = 2;
export const urlRef = (ref) => (typeof ref === 'string' && !/^#?\d+$/u.test(ref) ? /\/pull\/(\d+)/u.exec(ref)?.[1] ?? null : null);

// The exit of a command that records a judge's verdict when the forge cannot name the pull request's repository, and
// why: the verdict would otherwise go to origin's pull request of that number.
export const VERDICT_UNREAD = 3;
export const unreadRepo = (pr) => `cannot read pull request #${pr} on the forge, so its repository cannot be told: nothing is recorded, since origin's pull request of that number may be another one. Run it again once gh can read it`;

// Throws when this machine's record of `pr` changed since `local`, its copy read before: a write would lose it.
export function sameRevision(project, pr, repo, local) {
  const again = readLocalState(project, pr, repo);
  if ((again?.revision ?? null) !== (local?.revision ?? null)) throw new Error(`the review record of #${pr} changed while the verdict was recorded: run again`);
}

// Appends a judge's verdict for `head` to `state.waivers` and returns the entry: the one writer of a waiver, for
// `aidrian pr waive --verdict` and `aidrian pr extend --verdict land|stop --judge`. Throws, writing nothing, when no
// verdict may cover `head` (waiverKind, notWaivable), or when `judge`, the judge's agent id, has no dispatch of this
// session's in the dispatch log between the cap and now (judgeProblem). The entry keeps the judge's id with this
// session's, so auto-merge and the merge guard can find that dispatch again.
export function appendVerdict(state, { project, config, pr, head, verdict, reason, judge = null, env = process.env }) {
  const kind = waiverKind(state, head);
  if (kind === null) throw new Error(notWaivable(state, head, pr));
  const identity = sessionIdentity(env);
  const named = judge === null ? {} : { judge_id: judge, session: identity.session ?? null };
  const entry = { head, kind, verdict, reason, judge: identity.agent ?? 'unknown', ...named, at: new Date().toISOString() };
  if (judge !== null) {
    const unseen = judgeProblem({ project, config, state, entry });
    if (unseen) throw new Error(unseen);
  }
  state.waivers = [...(Array.isArray(state.waivers) ? state.waivers : []), entry];
  return entry;
}
