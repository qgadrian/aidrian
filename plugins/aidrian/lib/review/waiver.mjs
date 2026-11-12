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
// `aidrian pr auto-merge`'s review gate reads no verdict: it still needs `received` on the head. The waiver is for a
// session the Human told to merge, not for the auto-merge path.
//
// The guard honors a verdict only while both switches are on: `github.unattendedWaiver.allow` true in config.json on both
// the repository's default branch and the pull request's base, read from GitHub as each branch commits it now, never
// from the working copy (as auto-merge's team gate, pr-auto-merge.mjs branchPolicies), and `github.unattendedWaiver` "on"
// in the main checkout's untracked local file (project.localUnattendedWaiver). Any read that fails, or would
// start too late for the hook's 5 s, keeps the denial.
//
// The trust limit: a verdict an agent records is the session's word, not proof. A session with a shell can record one and
// merge under both switches, and the machine switch is the main session's to set, as auto-merge's is. Only the team's
// `allow`, read from GitHub, is out of a session's reach. A verdict shows in the pull request's summary comment only when
// `review.record` is "comment" and the post succeeds (`summary_error` says when it did not). For proof, protect the
// default and base branches with a required review from a second account.

import { resolveUnattendedWaiver } from '../config.mjs';
import { forgeFor } from '../forges/index.mjs';
import { runGit } from '../git.mjs';
import { sessionIdentity } from '../hosts/index.mjs';
// A cycle: pr-auto-merge.mjs imports merge-review.mjs, which imports this file. It is benign while each module uses the
// other's exports only inside functions, never while it loads: keep it that way.
import { branchPolicies, refusingBranches } from '../pr-auto-merge.mjs';
import { originRepo, repoName } from '../review-gate.mjs';
import { holdToBase } from './in-force.mjs';
import { postContext } from './dispatch.mjs';
import { heldMessage, mergePending, owed, publishState, readLocalState, readRecord, sameCommit, SHA_REF, writeLocalState } from './state.mjs';

export const VERDICTS = Object.freeze(['waive', 'refuse']);
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

// `aidrian pr waive <PR> --verdict waive|refuse --reason TEXT [--head SHA]`: { pr, verdict, reason, head }.
export function parseWaive(args) {
  const [ref, ...rest] = args;
  const match = /^#?(\d+)$/u.exec(ref ?? '') ?? /\/pull\/(\d+)/u.exec(ref ?? '');
  if (!match) throw new Error('waive needs a pull request number');
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!['--verdict', '--reason', '--head'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  if (!VERDICTS.includes(flags.verdict)) throw new Error('--verdict must be waive or refuse');
  if (!flags.reason?.trim()) throw new Error('--verdict needs --reason with the evidence');
  if (flags.reason.trim().length > MAX_REASON) throw new Error(`--reason is longer than ${MAX_REASON} characters: give the evidence, and link the rest`);
  if (flags.head !== undefined && !SHA_REF.test(flags.head)) throw new Error('--head must be a commit SHA');
  return { pr: Number(match[1]), verdict: flags.verdict, reason: flags.reason.trim(), head: flags.head ?? null };
}

// The kind of denial a verdict may waive for a merge of `head`, or null when none may: `round_cap` when nothing is owed
// and the outcome on record is `round_limit` on that very head. A head the outcome does not cover is never waived.
export function waiverKind(state, head) {
  if (!state || owed(state).length) return null;
  const outcome = state.outcome ?? null;
  if (!outcome || typeof outcome.head !== 'string' || typeof head !== 'string') return null;
  return sameCommit(outcome.head, head) && outcome.status === 'round_limit' ? 'round_cap' : null;
}

// Why no verdict may be recorded for `head`, for runWaive's error.
function notWaivable(state, head, pr) {
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
  return { change: call('change', VIEW_TIMEOUT_MS), repository: call('repository', READ_TIMEOUT_MS), contents: call('contents', READ_TIMEOUT_MS) };
}

// Whether both switches let a verdict stand: { on, reason: null | 'local' | 'team' | 'unread', refusing, why }. The team
// value is read at the default branch and at `base` on GitHub, through `forge`; `prefix` is the project's folder from the
// top of the repository (null: unknown, so unread). Any failed read is `unread`, and keeps it off.
export function waiverGate({ project, forge, repo, host, base, prefix }) {
  const local = project.localUnattendedWaiver;
  if (local !== 'on') return { on: false, reason: 'local', refusing: [], why: `this machine has not opted in (github.unattendedWaiver in ${project.paths.local})` };
  if (!repo || !host || !base || prefix === null) return { on: false, reason: 'unread', refusing: [], why: 'the pull request\'s repository, host, base, or the project\'s folder could not be read' };
  let policies;
  try {
    policies = branchPolicies(forge, { repo, host, base }, prefix);
  } catch (error) {
    return { on: false, reason: 'unread', refusing: [], why: error.message };
  }
  const refusing = refusingBranches(policies, base, 'unattendedWaiver');
  const { effective, reason } = resolveUnattendedWaiver({ unattendedWaiver: { allow: refusing.length === 0 } }, local);
  return { on: effective, reason, refusing, why: reason === 'team' ? `the team does not allow it (github.unattendedWaiver.allow on ${repo} ${refusing.join(' and ')})` : null };
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
};

const showPrefix = (root, timeout) => {
  const shown = runGit(['rev-parse', '--show-prefix'], root, { timeout });
  return shown.status === 0 ? shown.stdout.trim() : null;
};

const UNREAD_NOTE = ', and the team\'s github.unattendedWaiver could not be read in time';

// What the merge guard makes of a verdict for a denial it is about to give: { allow, note, route }. Asked only after the
// Human's answer did not waive it. Nothing is read, from the network or git, unless this machine's switch is on and the
// record holds an outcome with nothing owed. `named`: the merge names its head (`--match-head-commit`, `sha=`, the MCP
// `sha`), the only merge a verdict counts for, since gh would otherwise merge whatever head the branch has by then.
// `view` is the guard's earlier view, null when it made none. `forge` is budgetedForge's `make`, the test seam;
// `startedAt` when the hook's process started, by `now`, the one clock for every merge of one command.
// Any throw, from a read or the clock, is the `unread` denial: the hook's own catch would let the merge run.
export function guardWaiver(args) {
  try {
    return readWaiver(args);
  } catch {
    return { allow: false, note: UNREAD_NOTE, route: '' };
  }
}

function readWaiver({ project, state, pr, head, named = false, repo = null, view = null, forge = null, startedAt, now = Date.now }) {
  const none = { allow: false, note: '', route: '' };
  if (project.localUnattendedWaiver !== 'on' || !state?.outcome || owed(state).length) return none;
  const kind = waiverKind(state, head);
  if (kind === null) return none;
  const unread = { ...none, note: UNREAD_NOTE };
  // The one start check, before the first read: every waiver read follows it.
  if (now() - startedAt > GATE_START_MS) return unread;
  const deadline = startedAt + WAIVER_DEADLINE_MS;
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
  const gate = waiverGate({ project, forge: reads, repo: home, host, base, prefix: rest > 0 ? showPrefix(project.root, Math.min(READ_TIMEOUT_MS, rest)) : null });
  if (gate.reason === 'unread') return unread;
  if (!gate.on) return none;
  const verdict = waiverFor(state, head, kind);
  if (verdict && named) return { allow: true, note: '', route: '' };
  if (verdict) {
    return { ...none, route: ` A judge's recorded verdict waives this head, but only for a merge that names it: merge with \`gh pr merge ${pr} --match-head-commit ${head}\`, or give the merge tool its \`sha\`.` };
  }
  return {
    ...none,
    route: ` Or an unattended run the Human told to merge records the verdict of a fresh judge, as the pr-review-loop skill's references/review-plan.md § At the cap says, with \`aidrian pr waive ${pr} --verdict waive|refuse --reason "<evidence>" --head ${head}\`, which this repository allows (github.unattendedWaiver), then merges naming that head.`,
  };
}

// What to run after a recorded verdict.
const nextStep = (entry, pr, local) => (entry.verdict === 'waive'
  ? `merge with \`gh pr merge ${pr} --match-head-commit ${entry.head}\`: the merge guard accepts this verdict only while github.unattendedWaiver.allow is true on the base and default branches and the switch is on in ${local}`
  : 'the guard stands: the Human merges, or answers the merge guard\'s question with "Merge with the findings filed"');

// The CLI body. It reads and writes the record where the review step does: this machine's state folder and, unless the
// base branch's `review.record` is "local", the pull request's summary comment. The entries owed on this machine are
// merged in first, as the review step does, so a newer record from the comment never hides one; and when this machine's
// record changes before the write, nothing is written. `deps.forge` replaces the forge (change, conversationComments,
// postComment, editComment, viewer), `deps.repo` the origin, and `deps.env` the environment, in tests.
export async function runWaive(args, project, config, deps = {}) {
  const opts = parseWaive(args);
  if (opts.verdict === 'waive' && project.localUnattendedWaiver !== 'on') {
    throw new Error(`this machine's github.unattendedWaiver is not on in ${project.paths.local}, so the merge guard would not take a waive verdict; --verdict refuse is still recorded`);
  }
  const forge = deps.forge ?? forgeFor(project.root);
  const repo = deps.repo ?? originRepo(project);
  // The record is read only from the state.dir the pull request's base branch commits, so a verdict needs that base.
  let base = null;
  try {
    base = forge.change(String(opts.pr), 'baseRefName')?.baseRefName ?? null;
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
  const local = readLocalState(project, opts.pr);
  const record = readRecord(project, opts.pr, comments, repo);
  if (record.held !== undefined) throw new Error(heldMessage(opts.pr, record.held, record.why));
  const { state } = record;
  state.pending = mergePending(local?.pending, state.pending);
  let current = null;
  try {
    current = forge.change(String(opts.pr), 'number,headRefOid,url')?.headRefOid ?? null;
  } catch {}
  if (typeof current !== 'string' || !SHA_REF.test(current)) throw new Error('cannot read the pull request\'s head: a verdict binds to one head');
  const head = opts.head ?? current;
  if (!sameCommit(head, current)) throw new Error(`the pull request's head is ${current.slice(0, 7)}, not ${head.slice(0, 7)}: the verdict binds to the current head`);
  const kind = waiverKind(state, current);
  if (kind === null) throw new Error(notWaivable(state, current, opts.pr));
  const env = deps.env ?? process.env;
  const entry = { head: current, kind, verdict: opts.verdict, reason: opts.reason, judge: sessionIdentity(env).agent ?? 'unknown', at: new Date().toISOString() };
  state.waivers = [...(Array.isArray(state.waivers) ? state.waivers : []), entry];
  // A request or a review step written since the read would be lost under this write: refused, and nothing written.
  const again = readLocalState(project, opts.pr);
  if ((again?.revision ?? null) !== (local?.revision ?? null)) throw new Error(`the review record of #${opts.pr} changed while the verdict was recorded: run again`);
  writeLocalState(project, state);
  const summaryError = onPr ? publishState(state, { comments: () => comments, post: (body) => forge.postComment(repo, opts.pr, body), edit: (id, body) => forge.editComment(repo, id, body), viewer: () => forge.viewer() }, `waiver ${opts.verdict}`, postContext({ forge, repo, n: opts.pr, project, configs: [committed, config], env: deps.env ?? process.env })) : null;
  console.log(JSON.stringify({ status: 'recorded', pr: opts.pr, waiver: entry, next: nextStep(entry, opts.pr, project.paths.local), ...(summaryError ? { summary_error: summaryError } : {}) }, null, 2));
  return 0;
}
