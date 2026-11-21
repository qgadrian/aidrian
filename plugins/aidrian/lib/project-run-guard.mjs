// Who may run each `aidrian project` command of a project run, as the hooks and the command both read it from the run's
// ledger (lib/project-run.mjs) and the continuation store (lib/handoff-markers.mjs). lib/project-run-gate.mjs starts the
// sessions and records what they did; this file only reads, so a hook loads it without the gate's forge and git reads.
//   - The driver: the session that ran init, until custody moves. Custody moves to a continuation only when the driver's
//     start record (`started-<driver>`) names it, is dated, by its field and its file, after the ledger row that made the
//     driver, and holds the sha256 of a brief the driver's own session recorded with `aidrian project handoff` after that
//     row, or when the host itself continued the driver's session under the new id (`capabilities.continuedIn`, at most
//     CONTINUATION_HOPS times in a row, each after the row that made the driver). A slug or a name never moves it. The
//     gate appends a `driver` row when the continuation first acts.
//   - An issue's session: the session a `start` row names, and every continuation of it, read through the start records
//     of each, at most BACKGROUND_HOPS + 1 sessions; only one of them records the issue's result.
// scripts/hook-agent-gates.mjs asks projectCommandDenial before every Bash call that names `aidrian project`, with the
// host's own session id, and scripts/hook-stop.mjs asks resultHoldReason when a session stops.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { attemptOf } from './attempt-clone.mjs';
import { bashCall, opaqueTexts } from './config-guard.mjs';
import { loadConfig } from './config.mjs';
import { BACKGROUND_HOPS } from './handoff-continue.mjs';
import { PROJECT_SUB, PROJECT_SUBCOMMANDS, PROJECT_WORD, stateFolders } from './handoff-guard.mjs';
import { openStore, readStarted, readStartedDated, SESSION_ID } from './handoff-markers.mjs';
import { resolvedPath } from './fs.mjs';
import { continuationReader, opaqueShellCommand } from './hosts/index.mjs';
import { findProject } from './project.mjs';
import { activeRuns, attendedProblem, ISSUE_KEY, readRun, RUN_ID, runPlace } from './project-run.mjs';
import { aidrianArgs, walkCommands } from './shell-lex.mjs';
import { driverAfter, endedIn, runDriver } from './run-driver.mjs';
import { marksNaming, readUnattendedMark } from './unattended-mark.mjs';

// The file a confined session hands its result over in, in its drop folder: project-result.mjs's DROP_FILE, which
// imports this module, so it is spelled again here; test/project-result.test.mjs holds the two equal.
export const DROP_FILE = 'result.json';

const DAY = 24 * 60 * 60 * 1000;
// How far back a start record of an issue's chain is read: the window of a chain floor.
export const FLOOR_WINDOW = 30 * DAY;
// The most attempts of an issue that count, whatever any config says: an attempt a usage or rate limit ended does not
// (spentAttempts), since the run's own cap on pauses, LIMIT_WAITS, bounds those.
export const ISSUE_ATTEMPTS = 3;
// The most pauses on a usage or rate limit one run waits out (lib/project-limit.mjs); the next limit halts it.
export const LIMIT_WAITS = 24;
// The highest attempt number a start row may carry: every attempt that counts, and one per pause besides.
export const ATTEMPT_CEILING = ISSUE_ATTEMPTS + LIMIT_WAITS;
// Every `aidrian project` subcommand, today's and those a later step adds: a command that names one is the run's.
export const SUBCOMMANDS = PROJECT_SUBCOMMANDS;
// The subcommands a subagent may run.
const SUBAGENT_MAY = new Set(['next']);
// What a start row records of its start: a session held to its floor, one whose launch is unknown, one that could not be
// held, or a start that ran nothing, or stopped what it ran, and gave its attempt back (`void`). The gate writes each
// start ahead, as `uncertain` with `pending: true`, before the host starts anything, then once more when it knows.
export const START_OUTCOMES = Object.freeze(['started', 'uncertain', 'unheld', 'void']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const isSession = (value) => typeof value === 'string' && SESSION_ID.test(value);
// The time of a row's `at`, or NaN when it is not a timestamp as toISOString writes it.
export const timeOf = (row) => (typeof row?.at === 'string' && ISO.test(row.at) ? Date.parse(row.at) : Number.NaN);

// The driver of the run `found` (readRun) holds: { session, since }, the session and when the row that made it driver
// was written: the init row, or the latest `driver` row that moved custody from the driver before it.
export const driverOf = (found) => driverAfter(found.init, found.rows);

// Whether `project` has a project run under way: a run that has not ended (project-run.mjs activeRuns) in any state
// folder its runs may be kept in (handoff-guard.mjs stateFolders, which takes `base`, the hook call's baseReader, and
// `home`, a test's), a folder of runs that cannot be read, or a live unattended or pending mark that names one of its
// checkouts (unattended-mark.mjs marksNaming). While one is, the agent gate hook holds every subagent to the main
// checkout's host paths (handoff-guard.mjs mainCheckoutWriteDenial); a project with no run is not held.
export function projectRunActive(project, config, { base, home } = {}) {
  for (const state of stateFolders(project, config, { lazy: true, ...(base ? { base } : {}), ...(home ? { home } : {}) })) {
    if (activeRuns(state).length > 0) return true;
  }
  return marksNaming(project.checkouts ?? [], home ? { home } : {});
}

// The hold predicates (run-driver.mjs): which run `session` is held as the driver of, from its driver mark alone.
export { driverHold, drivesRun, endedIn, runDriver } from './run-driver.mjs';

// The authority rule for a driver's WRITES, for a guard that lets a run's driver do what no other session may: the run
// `session` drives by its driver mark (runDriver, naming a run, its project, and its state folder), whose ledger, read
// there, names `session` as its current driver (driverOf) and records no end. { run, project, state, found }, or null.
// runDriver alone only holds a session; it never grants.
export function currentDriver(session, options = {}) {
  const driver = runDriver(session, options);
  if (!driver?.run || !driver.project || !driver.state) return null;
  const found = readRun(driver.state, driver.run);
  if (found.problem || endedIn(found) || driverOf(found).session !== session) return null;
  return { run: driver.run, project: driver.project, state: driver.state, found };
}

// Whether the member of a chain, { id, session }, is the session `session`: its full id, or, when only the id the host
// printed is known, a session id that starts with it.
export const isMember = (member, session) => isSession(session)
  && (member.session === session || member.id === session || (member.session === null && typeof member.id === 'string' && session.startsWith(member.id)));

// The most host continuations in a row custody follows from the driver's session to the last of them.
export const CONTINUATION_HOPS = 8;

// The session the host now runs the driver `driver`, { session, since }, of the run whose main checkout is `cwd` as:
// the last of the continuations from the driver's session, each written after the one before and after the row that made
// the driver, or the driver's own session when the host continued it as none. `continuedIn` is the host's read
// (hosts/index.mjs continuationReader). Past CONTINUATION_HOPS, null: no session holds custody by the host's word.
export function hostDriver(driver, cwd, continuedIn) {
  let at = { id: driver.session, at: driver.since };
  for (let hop = 0; hop <= CONTINUATION_HOPS; hop += 1) {
    const next = continuedIn(at.id, cwd);
    if (!next || !isSession(next.id) || !(next.at > at.at)) return at.id;
    at = next;
  }
  return null;
}

// The custody of the run `found` for `session`: { role: 'driver', driver } when it is the driver; { role: 'successor',
// driver, sha256 } when custody may move to it by a handoff, or { role: 'successor', driver, via: 'continuation' } when
// the host continued the driver's session as it (the header's rule); else { problem }. `store` is the run's continuation
// store, and `continuedIn` the host's read of continuations, which by default finds none.
export function custody({ found, store, session, now = Date.now(), continuedIn = () => null }) {
  const driver = driverOf(found);
  if (!isSession(session)) return { problem: 'this host tells the command no session id, so the run cannot tell whether this session is its driver' };
  const host = hostDriver(driver, found.init.main, continuedIn);
  if (host !== driver.session) {
    if (host !== null && session === host) return { role: 'successor', driver, via: 'continuation' };
    return { problem: `this session is not the driver of the run ${found.init.run}: the host continued its driver ${driver.session} as ${host ?? `a chain of more than ${CONTINUATION_HOPS} sessions`}, and only the last of them drives it` };
  }
  if (session === driver.session) return { role: 'driver', driver };
  const not = `this session is not the driver of the run ${found.init.run}, ${driver.session}`;
  const dated = store.refused ? null : readStartedDated(store, driver.session, { now });
  const record = dated?.record;
  if (!record || record.project || !isMember({ id: record.id, session: record.session }, session)) return { problem: `${not}, and no start record of the driver names it as the session the driver handed the run to` };
  if (!(record.at > driver.since && dated.mtimeMs > driver.since)) return { problem: `${not}, and the driver's start record that names it is older than the row that made the driver` };
  const handed = found.rows.some((row) => row.event === 'handoff' && row.session === driver.session && row.sha256 === record.sha256 && timeOf(row) > driver.since);
  if (!handed) return { problem: `${not}, and the driver recorded no handoff of the brief that started it with \`aidrian project handoff\`` };
  return { role: 'successor', driver, sha256: record.sha256 };
}

// Why `session` may not lift a halt of the run `found`, or null: it drives the run, drove it once (the init row's
// session, or one a `driver` row named), or is the continuation custody would move to. Only another attended session, or
// the Human's own shell, lifts a halt.
export function resumerProblem({ found, store, session, now = Date.now(), continuedIn }) {
  if (!isSession(session)) return null;
  const members = new Set([found.init.session, ...found.rows.filter((row) => row.event === 'driver').flatMap((row) => [row.session, row.from])]);
  if (members.has(session)) return `this session drives the run ${found.init.run}, or did, and a halt is lifted by another session a person attends, or by the Human's own shell`;
  const held = custody({ found, store, session, now, continuedIn });
  if (held.role) return `this session is the run ${found.init.run}'s ${held.role}, and a halt is lifted by another session a person attends, or by the Human's own shell`;
  return null;
}

// The real path of the attempt folder a confined session works in, for the session whose unattended mark `mark` names
// the run and issue: the folder of the drop the issue's latest start row names, started or written ahead, in a state folder of `project`
// (handoff-guard.mjs stateFolders, with `base` and `home`), or null. The agent gate hook lets that session write only
// there of the runs folder (handoff-guard.mjs projectRunWriteDenial).
export function ownAttemptFolder(project, config, mark, { base, home } = {}) {
  if (!mark?.project || !mark?.issue || !RUN_ID.test(mark.project)) return null;
  for (const state of stateFolders(project, config, { lazy: true, ...(base ? { base } : {}), ...(home ? { home } : {}) })) {
    const found = readRun(state, mark.project);
    if (found.problem || found.states.get(mark.issue)?.state !== 'running') continue;
    // The start written ahead counts as soon as it is: the session writes its folder before the gate settles the row.
    const start = startsOf(found, mark.issue).at(-1);
    if (typeof start?.drop !== 'string' || !['started', 'uncertain'].includes(start.outcome)) continue;
    const folder = resolvedPath(path.dirname(start.drop));
    const runs = resolvedPath(path.join(state, 'runs', mark.project, 'attempts'));
    if (folder && runs && path.dirname(folder) === runs) return folder;
  }
  return null;
}

// The issue a session works, for the session whose unattended mark `mark` names the run and issue: { key, branch,
// pushUrl }, the branch the run's snapshot names for that issue and the URL its latest start pinned its clone's origin
// to push to (null when the start recorded none), while the issue runs and its latest start row was written ahead or
// started, in a state folder of `project` (as ownAttemptFolder reads it), or null. The agent gate hook lets that session
// push only that branch (lib/issue-forge-guard.mjs), and write by hand only the files named for its issue or branch in
// the plans, tmp, and dispatch folders (lib/unattended-write.mjs).
export function ownIssue(project, config, mark, { base, home } = {}) {
  if (!mark?.project || !mark?.issue || !RUN_ID.test(mark.project)) return null;
  for (const state of stateFolders(project, config, { lazy: true, ...(base ? { base } : {}), ...(home ? { home } : {}) })) {
    const found = readRun(state, mark.project);
    if (found.problem || found.states.get(mark.issue)?.state !== 'running') continue;
    const start = startsOf(found, mark.issue).at(-1);
    if (!start || !['started', 'uncertain'].includes(start.outcome)) continue;
    const issue = found.snapshot.issues.find((each) => each.key === mark.issue);
    const pushUrl = typeof start.pushUrl === 'string' && start.pushUrl !== '' ? start.pushUrl : null;
    if (typeof issue?.branch === 'string' && issue.branch !== '') return { key: issue.key, branch: issue.branch, pushUrl };
  }
  return null;
}

// Whether `row` is a start row as the gate writes it.
export const isStartRow = (row) => row?.event === 'start' && typeof row.key === 'string' && ISSUE_KEY.test(row.key)
  && Number.isInteger(row.attempt) && row.attempt >= 1 && row.attempt <= ATTEMPT_CEILING && START_OUTCOMES.includes(row.outcome)
  && isSession(row.session) && Number.isFinite(timeOf(row)) && typeof row.cwd === 'string' && path.isAbsolute(row.cwd) && typeof row.name === 'string'
  && (row.outcome !== 'started' || (isSession(row.id) && (row.child === null || isSession(row.child))));

// The start rows of the run `found`, the latest of each issue's attempt, in the order each attempt was first written:
// the gate writes an attempt's row ahead of the start and once more after it, so each attempt counts once.
export function startRows(found) {
  const latest = new Map();
  for (const row of found.rows) if (isStartRow(row)) latest.set(`${row.key}#${row.attempt}`, row);
  return [...latest.values()];
}

// The start rows of issue `key`, one an attempt, in order.
export const startsOf = (found, key) => startRows(found).filter((row) => row.key === key);

// The attempts of issue `key` that count toward ISSUE_ATTEMPTS: each start not given back (`void`), but one a usage or
// rate limit ended (an `ended` row with reason `limit`).
export function spentAttempts(found, key) {
  const limited = new Set(found.rows.filter((row) => row.event === 'ended' && row.key === key && row.reason === 'limit').map((row) => row.attempt));
  return startsOf(found, key).filter((row) => row.outcome !== 'void' && !limited.has(row.attempt)).length;
}

// The latest start of issue `key` that held its session, or null.
export const latestStart = (found, key) => startsOf(found, key).filter((row) => row.outcome === 'started').at(-1) ?? null;

// The sessions of the issue's chain from the start row `start`: { chain, complete }, where `chain` is [{ id, session }],
// the started session first, then each continuation its start record names, read over FLOOR_WINDOW, at most
// BACKGROUND_HOPS + 1 sessions; `complete` is false when the last one read has a start record still, so the chain may go
// on past what was read. A session known only by the id the host printed is looked up by that prefix.
export function issueChain(store, start, { now = Date.now() } = {}) {
  const chain = [{ id: start.id, session: start.child ?? null }];
  if (store.refused) return { chain, complete: false };
  for (let hop = 0; hop <= BACKGROUND_HOPS; hop += 1) {
    const record = startedOf(store, chain.at(-1), now);
    if (!record || record.project) return { chain, complete: true };
    if (hop === BACKGROUND_HOPS) return { chain, complete: false };
    chain.push({ id: record.id, session: record.session ?? null });
  }
  return { chain, complete: false };
}

// The start record of the chain member `member`, by its full id, or by the full id of the one session whose record's
// name starts with its printed id.
function startedOf(store, member, now) {
  if (member.session) return readStarted(store, member.session, { now, window: FLOOR_WINDOW });
  const own = readStarted(store, member.id, { now, window: FLOOR_WINDOW });
  if (own) return own;
  let names;
  try {
    names = readdirSync(store.dir);
  } catch {
    return null;
  }
  const full = names.map((name) => /^started-([\w-]{1,128})\.json$/u.exec(name)?.[1]).filter((id) => id !== undefined && id !== member.id && id.startsWith(member.id));
  return full.length === 1 ? readStarted(store, full[0], { now, window: FLOOR_WINDOW }) : null;
}

// Whether `session` is the newest session of the issue's chain, as issueChain read it: the last one, of a chain read to
// its end. A session that handed the work on is not.
const newest = ({ chain, complete }, session) => complete && isMember(chain.at(-1), session);

// Why `session` may not record the result of issue `key` of the run `found`, or null: the issue is not running, no start
// held a session for it, `session` is not the newest session of the chain of that start (issueChain), or its unattended
// mark names another run or issue.
export function resultAuthorProblem({ found, store, key, session, mark, now = Date.now() }) {
  if (typeof key !== 'string' || !ISSUE_KEY.test(key)) return `${JSON.stringify(key)} is not an issue key`;
  if (!found.snapshot.issues.some((issue) => issue.key === key)) return `the run ${found.init.run} holds no issue ${key}`;
  if (found.states.get(key)?.state !== 'running') return `the issue ${key} is not running in the run ${found.init.run}, so it has no result to record`;
  const start = latestStart(found, key);
  if (!start) return `no start of the issue ${key} held a session, so no session may record its result`;
  if (!isSession(session)) return 'this host tells the command no session id, so the run cannot tell whether this session works the issue';
  const { chain, complete } = issueChain(store, start, { now });
  if (!chain.some((member) => isMember(member, session))) return `only the session the run started for the issue ${key}, ${start.child ?? start.id}, or a continuation of it, records its result`;
  if (!newest({ chain, complete }, session)) return `this session handed the issue's work on to a continuation, which records the issue's result: only the newest session of the issue's chain records it`;
  if (mark && (mark.project !== found.init.run || mark.issue !== key)) return `this session's unattended mark names ${mark.issue ? `the issue ${mark.issue} of the run ${mark.project}` : 'no issue of a project run'}, not the issue ${key} of the run ${found.init.run}`;
  return null;
}

// Why `session` may not act on the pull request of issue `key` of the run `found` with `aidrian project stop-action`
// (lib/project-stops.mjs), or null: only the newest session of the chain of the issue's latest start, while the issue
// runs, whose unattended mark, when it has one, names that run and issue. The driver does not: an issue's merge is its
// own session's.
export function stopActorProblem({ found, store, key, session, mark, now = Date.now() }) {
  if (typeof key !== 'string' || !ISSUE_KEY.test(key)) return `${JSON.stringify(key)} is not an issue key`;
  if (!found.snapshot.issues.some((issue) => issue.key === key)) return `the run ${found.init.run} holds no issue ${key}`;
  if (!isSession(session)) return 'this host tells the command no session id, so the run cannot tell whether this session works the issue';
  if (found.states.get(key)?.state !== 'running') return `the issue ${key} is not running in the run ${found.init.run}, so no session acts on its pull request`;
  const start = latestStart(found, key);
  if (!start) return `no start of the issue ${key} held a session, so no session acts on its pull request`;
  if (!newest(issueChain(store, start, { now }), session)) return `only the newest session of the chain the run started for the issue ${key}, ${start.child ?? start.id}, acts on its pull request`;
  if (mark && (mark.project !== found.init.run || mark.issue !== key)) return `this session's unattended mark names ${mark.issue ? `the issue ${mark.issue} of the run ${mark.project}` : 'no issue of a project run'}, not the issue ${key} of the run ${found.init.run}`;
  return null;
}

// The continuation store of the run's state folder `state`, as the gate opens it.
export const runStore = (project, config, state) => openStore(state, { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain });

// The plain words of an `aidrian project` command after its subcommand: { positionals, options, dynamic }, where
// `dynamic` is true when a positional or an option's value is built from a variable or a substitution.
const VALUED = new Set(['--project', '--file', '--max-wait']);
function readRest(tokens) {
  const positionals = [];
  const options = {};
  let dynamic = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const [flag, attached] = token.text.startsWith('--') && token.text.includes('=') ? [token.text.slice(0, token.text.indexOf('=')), token.text.slice(token.text.indexOf('=') + 1)] : [token.text, null];
    if (!token.dynamic && VALUED.has(flag)) {
      const value = attached === null ? tokens[i + 1] : { text: attached, dynamic: token.dynamic };
      if (attached === null) i += 1;
      if (!value || value.dynamic) dynamic = true;
      else options[flag.slice(2)] = value.text;
    } else if (token.dynamic) dynamic = true;
    else if (!token.text.startsWith('-')) positionals.push(token.text);
  }
  return { positionals, options, dynamic };
}

// A subcommand word, and the word `project`, in a text no lexer reads, in any case: handoff-guard.mjs's.
const SUB_WORD = PROJECT_SUB;
// The programs that run their arguments as a command, which the lexer does not read as the command they run, and the
// shells that run a script file whose commands it never sees.
const RUNNERS = new Set(['xargs', 'npx', 'pnpx', 'bunx', 'find', 'parallel', 'watch', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

// Whether plain `words` name `project` and, after it, a subcommand.
const namesProjectCommand = (words) => {
  const at = words.findIndex((word) => word.toLowerCase() === 'project');
  return at !== -1 && words.slice(at + 1).some((word) => SUB_WORD.test(word) && word.length <= 'stop-action'.length);
};

// The `aidrian project` commands a call runs, as [{ sub, rest, folder }], with `sub` null for a subcommand word built
// from a variable or a substitution (`aidrian project "$(echo init)"`, `aidrian project $A`), and whether it holds a
// form no hook can read as such a command: { calls, hidden }, where `hidden` names the form: a command word built from one whose later plain
// words name `project` and a subcommand (`$AIDRIAN project start`); a runner (RUNNERS) whose plain words do (`xargs
// aidrian project start`, `bash run.sh project start`); a shell fed text the lexer cannot read, or a command in a shell
// it cannot read (lib/hosts/index.mjs opaqueShellCommand), whose text does.
export function projectCalls(input) {
  const opaque = opaqueShellCommand(input);
  const command = opaque ?? (bashCall(input) ? input.tool_input?.command : null);
  if (typeof command !== 'string' || !/project/iu.test(command)) return { calls: [], hidden: null };
  if (opaque !== null) {
    const texts = opaqueTexts(opaque);
    const named = texts.some((text) => PROJECT_WORD.test(text) && SUB_WORD.test(text));
    return { calls: [], hidden: named ? 'a command in a shell the hooks cannot read that names `project` and a subcommand' : null };
  }
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const calls = [];
  let hidden = null;
  for (const { invocation, unread, folder } of walkCommands(command, cwd)) {
    if (unread !== undefined && new RegExp(String.raw`\bproject\b[^\n;|&]*${SUB_WORD.source}`, 'iu').test(unread)) hidden ??= 'a shell fed text the hooks cannot read that names `project` and a subcommand';
    const plain = invocation.args.filter((token) => !token.dynamic).map((token) => token.text);
    if (invocation.dynamic && namesProjectCommand(plain)) hidden ??= 'a command word built from a variable whose later words name `project` and a subcommand';
    if (RUNNERS.has(invocation.program) && namesProjectCommand(plain)) hidden ??= `\`${invocation.program}\`, which runs its arguments or a script as a command the hooks cannot read, naming \`project\` and a subcommand`;
    const words = aidrianArgs(invocation);
    if (!words || words[0]?.dynamic || words[0]?.text !== 'project') continue;
    const sub = words[1];
    if (!sub) continue;
    if (sub.dynamic) {
      calls.push({ sub: null, rest: null, folder: folder ?? cwd });
      continue;
    }
    calls.push({ sub: sub.text, rest: readRest(words.slice(2)), folder: folder ?? cwd });
  }
  return { calls, hidden };
}

// Why the call in `input` may not run an `aidrian project` command, or null: { match, reason }. A subagent runs only
// `next`. A subcommand word built from a variable is refused to every session; another hidden form (projectCalls) to a
// subagent and to a session `unattended()` says no Human attends.
// Every session's call is then authorized against the run's ledger by `input.session_id`, the host's own session id,
// which no variable of the command moves: `init` by attendedProblem with the hook's payload; `start`, `wait`, and
// `handoff` only for the driver, or a continuation custody may move to; `result` only for a session of the issue's
// chain; `stop-action` only for that session's newest one (stopActorProblem). A call whose run, issue, or project folder
// is built from a variable is refused to all but `next` and
// `summary`. A run or project the hook cannot read lets the call run: the command reads the same files and refuses.
// `mark`, the session's unattended mark, names an issue session of a project run as that in the reason.
export function projectCommandDenial(input, { names: { human } }, { unattended = () => false, home, mark = null } = {}) {
  const { calls, hidden } = projectCalls(input);
  const subagent = typeof input.agent_id === 'string' && input.agent_id !== '';
  const deny = (match, why) => ({ match, reason: projectRuleReason(input, why, human, 'to run that project run command', { mark }) });
  if (hidden && (subagent || unattended())) return deny('hides an aidrian project command', `it runs ${hidden}, and the hooks authorize a project run's command only from its plain words`);
  for (const { sub, rest, folder } of calls) {
    // Plainly aidrian: no session needs a subcommand it cannot type.
    if (sub === null) return deny('hides an aidrian project subcommand', 'it runs `aidrian project` with a subcommand word after `project` built from a variable or a substitution, which the hooks cannot authorize');
    // A word the command does not take runs nothing, but a later step may give it meaning: only a rule lets it run.
    if (!SUBCOMMANDS.includes(sub)) {
      if (sub.startsWith('-')) continue;
      return deny(`runs aidrian project ${sub}`, `the hooks hold no rule for \`aidrian project ${sub}\`, a word the command does not take, and a project run's subcommand runs only under its rule`);
    }
    if (subagent && !SUBAGENT_MAY.has(sub)) return deny(`runs aidrian project ${sub}`, `\`aidrian project ${sub}\` acts for a project run's driver or issue session, and a subagent runs only \`aidrian project next\``);
    const rule = RULES[sub];
    if (!rule) return deny(`runs aidrian project ${sub}`, `the hooks hold no rule for \`aidrian project ${sub}\` yet, and a project run's subcommand runs only under its rule`);
    if (rule === readOnly) continue;
    if (rest.dynamic) return deny(`runs aidrian project ${sub}`, `\`aidrian project ${sub}\` names its run, issue, file, or project folder with a word built from a variable, which the hooks cannot authorize`);
    const why = authorize({ input, sub, rest, folder, home, rule });
    if (why) return deny(`runs aidrian project ${sub}`, why);
  }
  return null;
}

// The rule of each subcommand, which says why a session may not run it, or null. A subcommand of SUBCOMMANDS with no rule
// is refused (projectCommandDenial): a later step that adds one adds its rule here.
const readOnly = () => null;
const driverOnly = ({ sub, found, store, session, input, home }) => {
  const held = custody({ found, store, session, continuedIn: continuationReader({ input, ...(home ? { home } : {}) }) });
  return held.problem && `\`aidrian project ${sub}\` is the driver's, and ${held.problem}`;
};
const RULES = Object.freeze({
  next: readOnly,
  summary: readOnly,
  // Before the run exists: attendedProblem, with the hook's own payload.
  init: ({ input, session, project, config, state, home }) => {
    const problem = attendedProblem({ input, session, project, config, state, ...(home ? { home } : {}) });
    return problem && `\`aidrian project init\` makes this session a project run's driver, and ${problem}`;
  },
  // Lifts a halt: only an attended main session, by attendedProblem with the hook's own payload, as init.
  resume: ({ input, session, project, config, state, home, run }) => {
    const problem = attendedProblem({ input, session, project, config, state, ...(home ? { home } : {}) });
    if (problem) return `\`aidrian project resume\` lifts a run's halt, which a person decides, and ${problem}`;
    const found = RUN_ID.test(run ?? '') ? readRun(state, run) : null;
    const continuedIn = continuationReader({ input, ...(home ? { home } : {}) });
    const member = found && !found.problem ? resumerProblem({ found, store: runStore(project, config, state), session, continuedIn }) : null;
    return member && `\`aidrian project resume\` lifts a run's halt, which a person decides, and ${member}`;
  },
  start: driverOnly,
  wait: driverOnly,
  handoff: driverOnly,
  end: driverOnly,
  // The reports the run owes the tracker, and closing one: the driver's, as the tracker guard holds its writes to them.
  report: driverOnly,
  recorded: driverOnly,
  // Reads every check a start would make, and starts nothing.
  preflight: readOnly,
  // Proves the sandbox of the issue's own session from inside it (lib/project-confine.mjs): only the session the run
  // started for the issue, by its own mark, or, before the gate files that, by the pending mark that starts it in the
  // issue's clone, where the call runs.
  confine: ({ found, key, session, home, input }) => {
    let mark = null;
    try {
      mark = readUnattendedMark(session, home ? { home } : {});
    } catch {
      mark = { root: null };
    }
    const run = found.init.run;
    if (mark && !mark.pending && mark.project === run && mark.issue === key) return null;
    const at = typeof input?.cwd === 'string' ? attemptOf(input.cwd) : null;
    const clone = mark?.pending && typeof mark.cwd === 'string' ? resolvedPath(mark.cwd) : null;
    if (at && clone && at.run === run && at.key === key && at.work === clone) return null;
    return `\`aidrian project confine\` proves the sandbox of the session the run started for the issue ${key}, and this session is not that one`;
  },
  result: ({ found, store, key, session, home }) => {
    let mark = null;
    try {
      mark = readUnattendedMark(session, home ? { home } : {});
    } catch {
      mark = { root: null };
    }
    const problem = resultAuthorProblem({ found, store, key, session, mark });
    return problem && `\`aidrian project result\` records the result of the issue's own session, and ${problem}`;
  },
  // Acts on the issue's pull request after its auto-merge stopped: the issue's own session only.
  'stop-action': ({ found, store, key, session, home }) => {
    let mark = null;
    try {
      mark = readUnattendedMark(session, home ? { home } : {});
    } catch {
      mark = { root: null };
    }
    const problem = stopActorProblem({ found, store, key, session, mark });
    return problem && `\`aidrian project stop-action\` acts on the pull request of an issue, for the issue's own session only, and ${problem}`;
  },
});
// The subcommands the hooks hold a rule for.
export const SUBCOMMAND_RULES = Object.freeze(Object.keys(RULES));

// Why the session of `input` may not run `aidrian project <sub>` with `rest`, from `folder`, under `rule`, or null.
function authorize({ input, sub, rest, folder, home, rule }) {
  const project = findProject(path.resolve(folder, rest.options.project ?? '.'));
  if (!project) return null;
  const { config } = loadConfig(project);
  const place = runPlace(project, config, home ? { home } : {});
  if (place.problem) return null;
  const session = input.session_id;
  if (sub === 'init' || sub === 'resume') return rule({ input, session, project, config, state: place.state, home, run: rest.positionals[0] });
  const [run, key] = rest.positionals;
  if (typeof run !== 'string' || !RUN_ID.test(run)) return null;
  const found = readRun(place.state, run);
  if (found.problem) return null;
  return rule({ sub, found, store: runStore(project, config, place.state), key, session, home, input });
}

// The reason a session that works an issue of a project run is sent back once when it stops, or null: its unattended
// mark names a run and an issue (lib/unattended-mark.mjs), that issue still runs in the run's ledger, and the session is
// the newest session of the chain of its latest start (issueChain), so no result is recorded yet. Pure but for the reads of the mark, the
// run, and the store; anything it cannot read gives null, so a stop is never held on a guess. `home` is for a test.
export function resultHoldReason(input, { home, env = process.env } = {}) {
  try {
    const session = input.session_id;
    if (!isSession(session)) return null;
    const mark = readUnattendedMark(session, { env, ...(home ? { home } : {}) });
    if (!mark?.issue || !mark.project || !mark.root) return null;
    const project = findProject(mark.root);
    if (!project) return null;
    const { config } = loadConfig(project);
    const place = runPlace(project, config, { env, ...(home ? { home } : {}) });
    if (place.problem) return null;
    const found = readRun(place.state, mark.project);
    if (found.problem || found.states.get(mark.issue)?.state !== 'running') return null;
    const start = latestStart(found, mark.issue);
    if (!start) return null;
    // A confined session handed its result over in its drop folder, which the driver's wait takes in: it has recorded it.
    if (typeof start.drop === 'string' && existsSync(path.join(start.drop, DROP_FILE))) return null;
    // Only the newest session of the chain: one that handed the work on stops on purpose.
    if (!newest(issueChain(runStore(project, config, place.state), start), session)) return null;
    return `This session works the issue ${mark.issue} of the project run ${mark.project}, and it has not recorded the issue's result, which the run's driver waits on. ` +
      `Before stopping, write the result as JSON to a file outside the state folder and run \`aidrian project result ${mark.project} ${mark.issue} --file <that file>\`: ` +
      'status merged, pr_open, parked, blocked, or failed, the pull request number or null, any decisions the issue waits on, and, when the work stopped, why. ' +
      'When the work can still go on, go on with it instead, and record the result when it ends.';
  } catch {
    return null;
  }
}
