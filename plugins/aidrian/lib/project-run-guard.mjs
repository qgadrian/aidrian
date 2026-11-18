// Who may run each `aidrian project` command of a project run, as the hooks and the command both read it from the run's
// ledger (lib/project-run.mjs) and the continuation store (lib/handoff-markers.mjs). lib/project-run-gate.mjs starts the
// sessions and records what they did; this file only reads, so a hook loads it without the gate's forge and git reads.
//   - The driver: the session that ran init, until custody moves. Custody moves to a continuation only when the driver's
//     start record (`started-<driver>`) names it, is dated, by its field and its file, after the ledger row that made the
//     driver, and holds the sha256 of a brief the driver's own session recorded with `aidrian project handoff` after that
//     row. A slug or a name never moves it. The gate appends a `driver` row when the continuation first acts.
//   - An issue's session: the session a `start` row names, and every continuation of it, read through the start records
//     of each, at most BACKGROUND_HOPS + 1 sessions; only one of them records the issue's result.
// scripts/hook-agent-gates.mjs asks projectCommandDenial before every Bash call that names `aidrian project`, with the
// host's own session id, and scripts/hook-stop.mjs asks resultHoldReason when a session stops.

import { readdirSync } from 'node:fs';
import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { bashCall, opaqueTexts } from './config-guard.mjs';
import { loadConfig } from './config.mjs';
import { BACKGROUND_HOPS } from './handoff-continue.mjs';
import { PROJECT_SUB, PROJECT_SUBCOMMANDS, PROJECT_WORD } from './handoff-guard.mjs';
import { openStore, readStarted, readStartedDated, SESSION_ID } from './handoff-markers.mjs';
import { opaqueShellCommand } from './hosts/index.mjs';
import { findProject } from './project.mjs';
import { attendedProblem, ISSUE_KEY, readRun, RUN_ID, runPlace } from './project-run.mjs';
import { aidrianArgs, walkCommands } from './shell-lex.mjs';
import { readUnattendedMark } from './unattended-mark.mjs';

const DAY = 24 * 60 * 60 * 1000;
// How far back a start record of an issue's chain is read: the window of a chain floor.
export const FLOOR_WINDOW = 30 * DAY;
// The most times an issue is started, whatever any config says.
export const ISSUE_ATTEMPTS = 3;
// Every `aidrian project` subcommand, today's and those a later step adds: a command that names one is the run's.
export const SUBCOMMANDS = PROJECT_SUBCOMMANDS;
// The subcommands a subagent may run.
const SUBAGENT_MAY = new Set(['next']);
// What a start row records of its start: a session held to its floor, one whose launch is unknown, or one that could
// not be held.
export const START_OUTCOMES = Object.freeze(['started', 'uncertain', 'unheld']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const isSession = (value) => typeof value === 'string' && SESSION_ID.test(value);
// The time of a row's `at`, or NaN when it is not a timestamp as toISOString writes it.
export const timeOf = (row) => (typeof row?.at === 'string' && ISO.test(row.at) ? Date.parse(row.at) : Number.NaN);

// The driver of the run `found` (readRun) holds: { session, since }, the session and when the row that made it driver
// was written: the init row, or the latest `driver` row that moved custody from the driver before it.
export function driverOf(found) {
  let driver = { session: found.init.session, since: Date.parse(found.init.at) };
  for (const row of found.rows) {
    if (row.event !== 'driver' || !isSession(row.session) || row.from !== driver.session || !SHA256.test(row.sha256 ?? '')) continue;
    const at = timeOf(row);
    if (Number.isFinite(at) && at >= driver.since) driver = { session: row.session, since: at };
  }
  return driver;
}

// Whether the member of a chain, { id, session }, is the session `session`: its full id, or, when only the id the host
// printed is known, a session id that starts with it.
export const isMember = (member, session) => isSession(session)
  && (member.session === session || member.id === session || (member.session === null && typeof member.id === 'string' && session.startsWith(member.id)));

// The custody of the run `found` for `session`: { role: 'driver', driver } when it is the driver; { role: 'successor',
// driver, sha256 } when custody may move to it (the header's rule); else { problem }. `store` is the run's continuation
// store.
export function custody({ found, store, session, now = Date.now() }) {
  const driver = driverOf(found);
  if (!isSession(session)) return { problem: 'this host tells the command no session id, so the run cannot tell whether this session is its driver' };
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

// Whether `row` is a start row as the gate writes it.
export const isStartRow = (row) => row?.event === 'start' && typeof row.key === 'string' && ISSUE_KEY.test(row.key)
  && Number.isInteger(row.attempt) && row.attempt >= 1 && row.attempt <= ISSUE_ATTEMPTS && START_OUTCOMES.includes(row.outcome)
  && isSession(row.session) && Number.isFinite(timeOf(row)) && typeof row.cwd === 'string' && path.isAbsolute(row.cwd) && typeof row.name === 'string'
  && (row.outcome !== 'started' || (isSession(row.id) && (row.child === null || isSession(row.child))));

// The start rows of issue `key`, in order.
export const startsOf = (found, key) => found.rows.filter((row) => isStartRow(row) && row.key === key);

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
// chain. A call whose run, issue, or project folder is built from a variable is refused to all but `next` and
// `summary`. A run or project the hook cannot read lets the call run: the command reads the same files and refuses.
export function projectCommandDenial(input, { names: { human } }, { unattended = () => false, home } = {}) {
  const { calls, hidden } = projectCalls(input);
  const subagent = typeof input.agent_id === 'string' && input.agent_id !== '';
  const deny = (match, why) => ({ match, reason: projectRuleReason(input, why, human, 'to run that project run command') });
  if (hidden && (subagent || unattended())) return deny('hides an aidrian project command', `it runs ${hidden}, and the hooks authorize a project run's command only from its plain words`);
  for (const { sub, rest, folder } of calls) {
    // Plainly aidrian: no session needs a subcommand it cannot type.
    if (sub === null) return deny('hides an aidrian project subcommand', 'it runs `aidrian project` with a subcommand word after `project` built from a variable or a substitution, which the hooks cannot authorize');
    if (!SUBCOMMANDS.includes(sub)) continue;
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
const driverOnly = ({ sub, found, store, session }) => {
  const held = custody({ found, store, session });
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
  start: driverOnly,
  wait: driverOnly,
  handoff: driverOnly,
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
  if (sub === 'init') return rule({ input, session, project, config, state: place.state, home });
  const [run, key] = rest.positionals;
  if (typeof run !== 'string' || !RUN_ID.test(run)) return null;
  const found = readRun(place.state, run);
  if (found.problem) return null;
  return rule({ sub, found, store: runStore(project, config, place.state), key, session, home });
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
