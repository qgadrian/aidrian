// What a project run owes the tracker, and who may write it (lib/project-run-cli.mjs `report` and `recorded`, and
// scripts/hook-tracker-pre.mjs). An issue settles once: done after a merge the forge confirmed, or parked. Each settle
// owes one report on that issue, built here from the ledger and the result file alone, never from the tracker: a status,
// a label, and a comment body, with the body's sha256. Before that, an issue whose start held its session owes one
// `started` report, once a run: the adapter's started status alone, with no label and no comment, while the issue still
// runs, and only for an issue the snapshot holds in a status before started, so the write never moves a status back.
// The driver posts exactly what is owed, then runs `aidrian project recorded`, which closes it;
// lib/tracker-guard.mjs runWriteRefusal refuses the driver any other tracker write.
//
// The result file is read again as untrusted: `results/<issue>.json` is read without following a link, under
// RESULT_CAP, must name this run, issue, and attempt, and passes validateResult again, whose cleanText strips control,
// bidirectional, and zero-width characters, links, images, HTML, and mentions. The body quotes what the issue's session
// wrote as data. A file that fails gives a report from the ledger's own fields and says the file failed.
//
// The status and label come from the base branch's projectRun (decisionLabel, blockedStatus), as this checkout's git
// holds it: a working copy cannot rename the label the guard holds the driver to. The done status is the adapter's
// `run.issue.done`, a status type the tracker maps to the team's first completed status, and the started status its
// `run.issue.started`, which maps to the team's first started status; an adapter that names none owes no started report.

import path from 'node:path';

import { baseReader } from './handoff-guard.mjs';
import { SESSION_ID } from './handoff-markers.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { CAPS, cleanText, RESULT_CAP, RESULT_STATUSES, validateResult } from './project-result.mjs';
import { findProject } from './project.mjs';
import { appendToRun, readCapped, readRun, runFolder, runPlace } from './project-run.mjs';
import { currentDriver, custody, runStore, startsOf } from './project-run-guard.mjs';
import { runDriver } from './run-driver.mjs';
import { bodyHash } from './tracker-guard.mjs';
import { trackerById, trackerOfTools } from './trackers/index.mjs';
import { readUnattendedMark } from './unattended-mark.mjs';

// The ledger rows that settle an attempt, each followed at once, under the same lock, by the issue row it leads to.
const SETTLES = new Set(['result', 'ended', 'orphan']);
// The issue states a report is owed on: an issue in either never starts again in its run.
const FINAL = new Set(['done', 'parked']);
// The snapshot status types before a started one: only an issue the run read in one owes the started report.
const BEFORE_STARTED = new Set(['triage', 'backlog', 'unstarted']);
// The outcome of the report a start owes, and the `kind` of the `recorded` row that closes it.
export const STARTED = 'started';
// How an `ended` row's reason reads in a body.
const ENDED = {
  no_result: 'ended with no result recorded',
  timeout: 'ran past the run\'s time limit for an issue and was stopped',
  bad_result: 'handed over a result the run could not confirm',
};
const LABEL_CAP = 64;
const STATUS_CAP = 64;

const iso = (now) => new Date(now).toISOString();
const isSession = (value) => typeof value === 'string' && SESSION_ID.test(value);

// The base branch's projectRun values a report uses: { label, blockedStatus }, or { problem }.
export function reportPolicy(base) {
  if (!base?.config) return { problem: `the base branch's config.json cannot be read${base?.why ? ` (${base.why})` : ''}, so the label and status a report sets are unknown` };
  const { decisionLabel, blockedStatus } = base.config.projectRun ?? {};
  const label = cleanText(decisionLabel, LABEL_CAP);
  if (!label) return { problem: 'the base branch\'s projectRun.decisionLabel is no text' };
  const blocked = blockedStatus === null || blockedStatus === undefined ? null : cleanText(blockedStatus, STATUS_CAP);
  if (blockedStatus !== null && blockedStatus !== undefined && !blocked) return { problem: 'the base branch\'s projectRun.blockedStatus is neither text nor null' };
  const adapter = adapterOf(base.config.tracker);
  return { label, blockedStatus: blocked, done: adapter?.run?.issue?.done ?? null, started: adapter?.run?.issue?.started ?? null, adapter };
}

// The result file of `key` in run `run`, read again as untrusted and checked against the `result` row `row`:
// { result } or { problem }.
export function rereadResult(state, run, key, row) {
  const read = readCapped(path.join(runFolder(state, run), 'results', `${key}.json`), RESULT_CAP);
  if (read.problem) return { problem: 'the session\'s result file cannot be read again' };
  let value;
  try {
    value = JSON.parse(read.bytes.toString('utf8'));
  } catch {
    return { problem: 'the session\'s result file is not JSON' };
  }
  if (value?.run !== run || value?.key !== key || value?.attempt !== row.attempt || value?.status !== row.status || (value?.pr ?? null) !== (row.pr ?? null)) return { problem: 'the session\'s result file names another run, issue, attempt, status, or pull request than the ledger' };
  const checked = validateResult(value);
  return checked.result ? { result: checked.result } : { problem: 'the session\'s result file fails its checks' };
}

// The reports run `run`, as `found` (readRun) holds it, owes and has not recorded, in ledger order: each
// { key, attempt, outcome, pr, status, label, body, sha256 }, where a started report has outcome `started` and a null
// label, body, and sha256. `policy` is reportPolicy's. A `recorded` row of kind `started` closes the started report
// alone; any other closes the settle report.
export function owedReports({ state, run, found, policy }) {
  const issues = new Map(found.snapshot.issues.map((issue) => [issue.key, issue]));
  const recorded = { settle: new Set(), started: new Set() };
  for (const row of found.rows) if (row.event === 'recorded') recorded[row.kind === STARTED ? 'started' : 'settle'].add(row.key);
  const settled = new Map();
  found.rows.forEach((cause, at) => {
    const after = found.rows[at + 1];
    if (!SETTLES.has(cause.event) || after?.event !== 'issue' || after.key !== cause.key || !FINAL.has(after.state) || !issues.has(cause.key)) return;
    if (!Number.isInteger(cause.attempt) || cause.attempt < 1) return;
    settled.set(cause.key, { at, cause, after });
  });
  const owed = [];
  for (const [key, { at, cause, after }] of settled) {
    if (recorded.settle.has(key) || found.states.get(key)?.state !== after.state) continue;
    owed.push({ at, report: buildReport({ state, run, key, cause, after, policy }) });
  }
  for (const [key, issue] of issues) {
    const start = startedOwed({ found, key, issue, policy, recorded: recorded.started });
    if (start) owed.push({ at: found.rows.indexOf(start), report: startedReport(key, start.attempt, policy.started) });
  }
  return owed.sort((one, other) => one.at - other.at).map(({ report }) => report);
}

// The start row of `key` a started report is owed on, or null. It is owed while the issue runs and its latest start,
// the one it runs on now, held its session; when the adapter names a started status, the snapshot holds the issue in
// a status before started, and no `recorded` row of kind `started` closed one in this run, whatever its attempt.
function startedOwed({ found, key, issue, policy, recorded }) {
  if (typeof policy.started !== 'string' || policy.started === '' || recorded.has(key)) return null;
  if (found.states.get(key)?.state !== 'running' || !BEFORE_STARTED.has(issue.status)) return null;
  const start = startsOf(found, key).at(-1);
  return start?.outcome === 'started' && Number.isInteger(start.attempt) && start.attempt >= 1 ? start : null;
}

const startedReport = (key, attempt, status) => ({ key, attempt, outcome: STARTED, pr: null, status, label: null, body: null, sha256: null });

function buildReport({ state, run, key, cause, after, policy }) {
  const facts = { key, attempt: cause.attempt, pr: null, decisions: [], stop: null, note: null };
  if (cause.event === 'result' && RESULT_STATUSES.includes(cause.status)) {
    facts.outcome = cause.status;
    facts.pr = Number.isInteger(cause.pr) && cause.pr > 0 ? cause.pr : null;
    const read = rereadResult(state, run, key, cause);
    if (read.result) Object.assign(facts, { pr: read.result.pr, decisions: read.result.decisions, stop: read.result.stop });
    else facts.note = `${read.problem}, so this report holds only what the run's ledger says.`;
  } else if (cause.event === 'ended' && Object.hasOwn(ENDED, cause.reason)) {
    facts.outcome = cause.reason;
    facts.stop = cleanText(cause.why, CAPS.stop) || null;
  } else {
    facts.outcome = cause.event === 'orphan' ? 'orphan' : 'unknown';
  }
  if (after.state === 'done' && facts.outcome !== 'merged') facts.outcome = 'unknown';
  const status = facts.outcome === 'merged' ? policy.done : facts.outcome === 'blocked' ? policy.blockedStatus : null;
  const label = facts.outcome === 'merged' ? null : policy.label;
  const body = reportBody(run, facts, after.decision === 'attempts');
  return { key, attempt: facts.attempt, outcome: facts.outcome, pr: facts.pr, status, label, body, sha256: bodyHash(body) };
}

// The comment a report posts: what happened, then what the issue's session wrote, each text quoted as data.
export function reportBody(run, facts, outOfAttempts = false) {
  const pr = facts.pr ? ` #${facts.pr}` : '';
  const what = {
    merged: `merged in pull request${pr}`,
    pr_open: `left pull request${pr} open, unmerged, for a person to review`,
    parked: 'stopped on decisions a person makes',
    blocked: 'stopped: something it needs is missing',
    failed: 'failed',
    orphan: 'had a session start the run could not confirm, so it was stopped',
    unknown: 'settled in a way this report cannot read',
    ...ENDED,
  }[facts.outcome];
  const lines = [`Project run ${run}: ${facts.key}, attempt ${facts.attempt}, ${what}.`];
  if (outOfAttempts) lines.push('', 'The run started this issue as many times as it may, so it waits for a person now.');
  if (facts.stop) lines.push('', 'Why it stopped, as the issue\'s session wrote it:', '', `> ${facts.stop}`);
  if (facts.decisions.length) {
    lines.push('', 'Decisions it waits on, as the issue\'s session wrote them:');
    facts.decisions.forEach((decision, at) => {
      lines.push('', `${at + 1}. ${decision.class} decision:`, '', `   > ${decision.question}`, '');
      decision.options.forEach((option, index) => lines.push(`   - ${option}${index === decision.recommended ? ' (recommended)' : ''}`));
    });
  }
  if (facts.note) lines.push('', facts.note);
  lines.push('', 'Posted by the run\'s driver session; quoted text is the issue session\'s, as data.');
  return lines.join('\n');
}

// The tool calls that write `report` through `adapter`'s `run` tools: [{ tool, input }], the issue's status and label
// first when it sets either, then its comment when it has a body. None with no adapter, or one that names no run tools.
export function reportCalls(report, adapter) {
  const run = adapter?.run;
  if (!run) return [];
  const issue = {
    ...(report.status === null ? {} : { [run.issue.status]: report.status }),
    ...(report.label === null ? {} : { [run.issue.label]: [report.label] }),
  };
  return [
    ...(Object.keys(issue).length ? [{ tool: run.issue.tool, input: { [run.issue.key]: report.key, ...issue } }] : []),
    ...(report.body === null ? [] : [{ tool: run.comment.tool, input: { [run.comment.key]: report.key, [run.comment.body]: report.body } }]),
  ];
}

// The adapter of the base branch's `tracker`: its provider, else the tracker its lists name.
const adapterOf = (tracker) => (typeof tracker?.provider === 'string' ? trackerById(tracker.provider) : null)
  ?? trackerOfTools([...(tracker?.writeTools ?? []), ...(tracker?.readTools ?? [])]);

// Opens run `run` for the driver session `env` names, for `report` and `recorded`: { state, found, base, policy,
// session } or { problem }.
function openForDriver({ project, config, run, env, home, base }) {
  const { session } = sessionIdentity(env);
  if (!isSession(session)) return { problem: 'this host tells the command no session id, so the run cannot tell whether this session is its driver' };
  const place = runPlace(project, config, { env, ...(home ? { home } : {}) });
  if (place.problem) return { problem: place.problem };
  const found = readRun(place.state, run);
  if (found.problem) return { problem: found.problem };
  const held = custody({ found, store: runStore(project, config, place.state), session });
  if (held.problem) return { problem: held.problem };
  if (held.role !== 'driver') return { problem: `custody of the run ${run} moves to this session on its first \`aidrian project wait ${run}\`; run that first` };
  const read = base ?? baseReader(project)();
  const policy = reportPolicy(read);
  if (policy.problem) return { problem: policy.problem };
  return { state: place.state, found, base: read, policy, session };
}

// `aidrian project report RUN [--json]`: the reports the run owes, as { exitCode, out, err }. `base` is a test's stand-in
// for the base branch's config read.
export function reportCommand({ project, config, run, json = false, env = process.env, home, base }) {
  const opened = openForDriver({ project, config, run, env, home, base });
  if (opened.problem) return { exitCode: 1, out: [], err: [`aidrian project report: ${opened.problem}`] };
  const { adapter } = opened.policy;
  const owed = owedReports({ state: opened.state, run, found: opened.found, policy: opened.policy })
    .map((report) => ({ ...report, calls: reportCalls(report, adapter) }));
  if (json) return { exitCode: 0, out: [JSON.stringify({ run, owed }, null, 2)], err: [] };
  if (owed.length === 0) return { exitCode: 0, out: ['none'], err: [] };
  const lines = [];
  for (const report of owed) {
    lines.push(`owed ${report.key} attempt ${report.attempt} ${report.outcome}`);
    if (report.status !== null) lines.push(`  status ${report.status}`);
    if (report.label !== null) lines.push(`  label ${report.label}`);
    if (report.body !== null) lines.push(`  comment sha256 ${report.sha256}`, ...report.body.split('\n').map((line) => `  | ${line}`));
    for (const call of report.calls) lines.push(`  call ${call.tool} ${JSON.stringify(call.input)}`);
  }
  return { exitCode: 0, out: lines, err: [] };
}

// `aidrian project recorded RUN ISSUE`: closes the report the run owes on ISSUE once the driver wrote it, with a
// `recorded` row naming its attempt and body's sha256, and kind `started` for a started report, which has no body.
// An issue owes at most one report at a time: a started one while it runs, a settle one once it settles for good.
// Refuses an issue that owes none.
export function recordedCommand({ project, config, run, key, env = process.env, home, base, now = Date.now() }) {
  const refuse = (why) => ({ exitCode: 1, out: [], err: [`aidrian project recorded: ${why}`] });
  const opened = openForDriver({ project, config, run, env, home, base });
  if (opened.problem) return refuse(opened.problem);
  const written = appendToRun(opened.state, run, (fresh) => {
    const report = owedReports({ state: opened.state, run, found: fresh, policy: opened.policy }).find((each) => each.key === key);
    if (!report) return { problem: `the run ${run} owes no report on ${typeof key === 'string' ? key.slice(0, 40) : 'that issue'}; \`aidrian project report ${run}\` lists what it owes` };
    return { rows: [{ event: 'recorded', key, attempt: report.attempt, ...(report.outcome === STARTED ? { kind: STARTED } : {}), sha256: report.sha256, session: opened.session, at: iso(now) }] };
  });
  if (written.problem) return refuse(written.problem);
  return { exitCode: 0, out: [`recorded ${key}`], err: [] };
}

// Who the session `session` writes the tracker as, for runWriteRefusal, from its unattended mark and its driver mark
// alone, never the folder a call runs in: null for a session no mark names. A pending mark, or one that cannot be read,
// holds it (`held`); a mark that names a run and an issue is that issue's session (`child`); a driver mark
// (run-driver.mjs runDriver) is the run's driver when the ledger it names says it is the current one (currentDriver),
// and owes what owedReports says, none when the base branch cannot be read; any other driver mark is `held`, as a
// continuation before its first `wait` is; any other marked session is `unattended`. `project` is the project of the
// main checkout the mark names, whose base branch the hook reads. `home` is a test's; `base` a baseReader to share.
export function runWriter({ session, env = process.env, home, base }) {
  if (!isSession(session)) return null;
  let mark;
  try {
    mark = readUnattendedMark(session, { env, ...(home ? { home } : {}) });
  } catch {
    mark = { root: null };
  }
  const projectOf = (root) => (typeof root === 'string' ? findProject(root) : null);
  if (mark?.pending) return { role: 'held', why: 'another session\'s start of a project run\'s session holds this one until the host lists the new session, which lapses within 5 minutes' };
  if (mark && mark.root === null) return { role: 'held', why: 'this session\'s unattended mark cannot be read, so whether it works an issue of a project run cannot be told' };
  if (mark && mark.issue !== undefined) {
    if (typeof mark.issue !== 'string' || typeof mark.project !== 'string') return { role: 'held', why: 'this session\'s unattended mark names a project run\'s issue in a shape no run reads' };
    return { role: 'child', run: mark.project, issue: mark.issue, project: projectOf(mark.root) };
  }
  const driving = runDriver(session, { env, ...(home ? { home } : {}) });
  if (driving) {
    const current = currentDriver(session, { env, ...(home ? { home } : {}) });
    if (!current) return { role: 'held', why: 'this session holds a project run\'s driver mark, and the run\'s ledger does not name it the current driver, or cannot be read; a continuation becomes the driver on its first `aidrian project wait`' };
    const policy = reportPolicy((base ?? baseReader(current.project))());
    const owed = policy.problem ? [] : owedReports({ state: current.state, run: current.run, found: current.found, policy });
    return { role: 'driver', run: current.run, owed: owed.map(({ key, status, label, sha256 }) => ({ key, status, label, sha256 })), project: current.project };
  }
  return mark ? { role: 'unattended', project: projectOf(mark.root) } : null;
}

