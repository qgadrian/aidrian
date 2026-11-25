// `aidrian project`: the record of a project run and the order of its issues (lib/project-run.mjs).
//
//   aidrian project init RUN --file PATH   # validate the driver's snapshot input and start run RUN; the attended main session only,
//                                          # keeping each issue's text the tracker's answers to this session recorded
//                    [--check]             # only check the input and print its order and blockers, writing no run
//   aidrian project next RUN [--json]      # the next issue or issues to start, `wait N running` (a session that runs on
//                                          # after its issue settled counts), or `done`
//   aidrian project summary RUN            # write and print summary.md from the ledger
//   aidrian project end RUN                # the driver records the run's end, which releases its driver mark
//   aidrian project start RUN ISSUE        # the driver starts the issue's session in a fresh clone (lib/project-run-gate.mjs)
//   aidrian project wait RUN [--max-wait S] # the driver waits for an issue's session to settle, at most S seconds
//   aidrian project result RUN ISSUE --file PATH   # the issue's own session records how it ended
//   aidrian project handoff RUN BRIEF      # the driver records the brief its background continuation starts from
//   aidrian project resume RUN             # an attended session lifts the run's halt, such as a failed start proof's or a
//                                          # limit's, or takes custody of a run whose driver's sessions ended
//                    [--custody]           # takes custody only, never lifting a halt; where the team sets
//                                          # projectRun.fullAuto, the host's continuation of the driver needs no person
//   aidrian project report RUN [--json]    # the driver: the status, label, and comment the run owes each settled issue
//   aidrian project recorded RUN ISSUE     # the driver: closes the report on ISSUE once it wrote it (lib/project-report.mjs)
//   aidrian project preflight [RUN]        # every check a start would refuse or halt on, before init (lib/project-preflight.mjs)
//   aidrian project stop-action RUN ISSUE [--catch-up]  # the one action for an issue whose auto-merge stopped, or at an attempt's start (lib/project-stops.mjs)
//   aidrian project confine RUN ISSUE      # the issue's own session, as its first call, proves its sandbox holds
//   aidrian project decision ISSUE --heading TEXT [--record]  # an attended session: the section of ISSUE's description
//                                          # under that heading and its sha256, and with --record its entry in this
//                                          # machine's recorded-decision store (lib/project-decision.mjs)
//   aidrian project decision ISSUE --forget # an attended session removes ISSUE's entry from that store
//
// The run's files are in `<state>/runs/RUN/`, where `<state>` is the project's state folder as lib/project-run.mjs
// runPlace resolves and checks it. `--project` on init must name the project of the current folder's main checkout.
// Exits: 0 on an answer; 1 on a refusal, a run that cannot be read, a failed sandbox proof, or bad arguments, after
// printing why; 75 with a `retry:` line when another process holds the run's ledger locked.

import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { forgeFor } from './forges/index.mjs';
import { resolvedPath } from './fs.mjs';
import { clearLocation } from './git.mjs';
import { detectHost, sessionIdentity } from './hosts/index.mjs';
import { projectAt } from './project.mjs';
import { decisionCommand } from './project-decision.mjs';
import { pauseOf } from './project-limit.mjs';
import { sweepIssueReads } from './project-issue-text.mjs';
import { lingeringStarts } from './project-linger.mjs';
import { LOCKED } from './jsonl.mjs';
import { preflightCommand, recheckLines, snapshotCheck } from './project-preflight.mjs';
import { landedPull, openPullHead } from './project-result.mjs';
import { owedKeys, recordedCommand, reportCommand } from './project-report.mjs';
import { runConfine } from './project-confine.mjs';
import { haltOf, initRun, nextLines, planRun, readRun, runPlace, writeSummary } from './project-run.mjs';
import { resumeWords, runStore } from './project-run-guard.mjs';
import { stopAction } from './project-stops.mjs';
import { endRun, recordHandoff, recordResult, resumeRun, RETRY_EXIT, runParallel, startIssue, WAIT_CEILING, WAIT_DEFAULT, waitRun } from './project-run-gate.mjs';
import { usageLines } from './usage.mjs';

const USAGE = 'init RUN --file PATH [--check] [--project DIR] | next RUN [--json] [--project DIR] | summary RUN [--project DIR] | start RUN ISSUE [--project DIR] | ' +
  'wait RUN [--max-wait SECONDS] [--project DIR] | result RUN ISSUE --file PATH [--project DIR] | handoff RUN BRIEF [--project DIR] | resume RUN [--custody] [--project DIR] | end RUN [--project DIR] | ' +
  'report RUN [--json] [--project DIR] | recorded RUN ISSUE [--project DIR] | preflight [RUN] [--project DIR] | stop-action RUN ISSUE [--catch-up] [--project DIR] | confine RUN ISSUE | decision ISSUE --heading TEXT [--record] [--project DIR] | decision ISSUE --forget [--project DIR]';
// The actions the command takes; lib/project-run-guard.mjs holds a rule for each (test/project-start-guard.test.mjs).
export const ACTIONS = ['init', 'next', 'summary', 'start', 'wait', 'result', 'handoff', 'resume', 'end', 'report', 'recorded', 'preflight', 'stop-action', 'confine', 'decision'];
// The positionals each action takes after its name.
const POSITIONALS = { init: ['one run id'], next: ['one run id'], summary: ['one run id'], start: ['a run id', 'an issue key'], wait: ['one run id'], result: ['a run id', 'an issue key'], handoff: ['a run id', 'a brief'], resume: ['one run id'], end: ['one run id'], report: ['one run id'], recorded: ['a run id', 'an issue key'], preflight: [], 'stop-action': ['a run id', 'an issue key'], confine: ['a run id', 'an issue key'], decision: ['one issue key'] };

export const commands = {
  project: {
    usage: USAGE,
    about: 'keep the record of a project run that works through a tracker project: init validates the snapshot input the driver session wrote from the tracker and starts run RUN, from the attended main session only; next prints the issue or issues to start, by blockers, then priority, then key, or done; summary writes the run\'s summary.md from its ledger; ' +
      'start, for the run\'s driver, starts the issue\'s own session in the background in a fresh clone of its own, under the caps; wait waits for an issue\'s session to end or record its result; result records it, from that session only; handoff records the brief the driver\'s background continuation takes the run on with; ' +
      'resume, from an attended session only, lifts the run\'s halt, such as a failed start proof\'s or a usage limit\'s, or takes custody of a run whose driver\'s sessions ended, and with --custody takes custody only, which under projectRun.fullAuto the host\'s continuation of the driver takes with no person; end, for the run\'s driver at the end of its loop, records the run\'s end, which releases the driver\'s hold; ' +
      'report, for the driver, prints the status, label, and comment the run owes each settled issue, and recorded closes one once written; preflight runs every check a start would refuse or halt on, before init; ' +
      'stop-action, for the issue\'s own session only, prints the one action for an issue whose pull request did not merge, takes the forge\'s part of it, and records it against its cap, and with --catch-up, at an attempt\'s start, the one way it merges a base its pull request conflicts with; ' +
      'confine, the first call of an issue\'s session on a host that proves its sandbox per start, tries from inside the sandbox what it must refuse, and hands the verdict to the start; ' +
      'decision, from an attended session only, prints the section of an issue\'s description under a heading, from this session\'s recorded tracker read, and its sha256, and with --record writes it to this machine\'s recorded-decision store; --forget removes it',
    run: async (args) => print(await projectCommand(args)),
  },
};

// Runs `aidrian project` with `args` and returns { exitCode, out, err }, the lines for stdout and stderr. `cwd` is the
// current folder and `env` the environment the session id is read from. `home` is for a test: the unattended marks are
// read in the home folder of the user this process runs as, which no variable of a command's environment moves, so only
// an in-process caller can point it elsewhere. So are `forge`, the forge facade the team's policy and a merge are read
// through, `spawn` and `wait`, the host adapter's stand-ins for its command and its pause, `pause`, wait's pause between
// reads, `clock`, the clock that moves wait's later reads on from `now`, `now`, and `platform`, the operating system a start's host sandbox runs on. Throws what parseArgs and
// commandConfig throw, which lib/cli.mjs reports. `autoMerge(url)` is stop-action's stand-in for the auto-merge answer,
// and `exec` the keychain read's execFileSync for start and preflight (lib/project-token.mjs).
// `confine` returns a promise of the answer (lib/project-confine.mjs runConfine), the others the answer itself.
// A ledger another process holds locked is a refusal that may pass: exit 75, EX_TEMPFAIL, with a `retry:` line, which
// the driver's loop tries again after one wait.
export function projectCommand(args, options = {}) {
  // git's location variables, such as GIT_DIR or GIT_INDEX_FILE, would point every git call of the command at another
  // repository than the one at its folder: they go once, here, for the whole command.
  const env = clearLocation(options.env ?? process.env);
  try {
    return projectAction(args, { ...options, env });
  } catch (error) {
    if (error?.code !== LOCKED) throw error;
    return { exitCode: RETRY_EXIT, out: [`retry: ${String(error.message).split('\n')[0]}`], err: [`aidrian project ${args[0]}: ${String(error.message).split('\n')[0]}`] };
  }
}

// The exit of a refusal that may pass when tried again: project-run-gate.mjs's.
export { RETRY_EXIT };

function projectAction(args, { cwd = process.cwd(), env = process.env, home, forge, spawn, wait, pause, clock, now, platform, autoMerge, exec } = {}) {
  // When the command began, on wait's clock: wait's --max-wait counts from here, the command's own setup included.
  const started = (clock ?? Date.now)();
  const [action, ...rest] = args;
  if (!ACTIONS.includes(action)) return fail(`project takes ${ACTIONS.slice(0, -1).join(', ')}, or ${ACTIONS.at(-1)}${action ? `, not "${action}"` : ''}`);
  // resume's words as the hook reads them too (project-run-guard.mjs resumeWords): an option twice is refused.
  if (action === 'resume' && !resumeWords(rest)) return fail('project resume takes one run id, and --custody and --project DIR at most once each');
  const word = { type: 'string' };
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      project: word,
      ...(['init', 'result'].includes(action) ? { file: word } : {}),
      ...(action === 'init' ? { check: { type: 'boolean' } } : {}),
      ...(['next', 'report'].includes(action) ? { json: { type: 'boolean' } } : {}),
      ...(action === 'wait' ? { 'max-wait': word } : {}),
      ...(action === 'decision' ? { heading: word, record: { type: 'boolean' }, forget: { type: 'boolean' } } : {}),
      ...(action === 'resume' ? { custody: { type: 'boolean' } } : {}),
      ...(action === 'stop-action' ? { 'catch-up': { type: 'boolean' } } : {}),
    },
  });
  // preflight takes the run it checks for, once init has made it, or none before.
  const wanted = action === 'preflight' && positionals.length === 1 ? ['one run id'] : POSITIONALS[action];
  if (positionals.length !== wanted.length) return fail(`project ${action} takes ${action === 'preflight' ? 'at most one run id' : wanted.join(' and ')}`);
  const [run, second] = positionals;
  // Inside the session's sandbox, before anything of the project is read: the plan beside its clone names every probe.
  if (action === 'confine') return values.project === undefined ? runConfine({ run, key: second, cwd, env }) : fail('project confine takes no --project: it runs in the clone its session started in');
  const project = projectAt(path.resolve(cwd, values.project ?? '.'));
  const config = commandConfig(project);
  if (action === 'init') {
    if (!values.file) return fail('project init needs --file');
    if (values.check) return snapshotCheck({ project, config, file: path.resolve(cwd, values.file), session: sessionIdentity(env).session, env, home, ...(forge ? { forge } : {}) });
    if (values.project !== undefined && !sameMainCheckout(project, projectAt(cwd))) {
      return refused('init', '--project names a project outside the main checkout of the current folder; run init from that project');
    }
    // An old ledger's parked issue that recorded no head resumes from its open pull request's (project-run.mjs resumedIssues).
    const pullHead = ({ pr, branch, repository }) => openPullHead({ forge: forge ?? forgeFor(project.root), repository, pr, branch });
    // A pull request an earlier run left open that merged since takes its issue in as done (project-run.mjs resumedIssues).
    const landed = ({ pr, branch, repository, since }) => landedPull({ forge: forge ?? forgeFor(project.root), repository, pr, branch, since });
    return initRun({ project, config, run, file: path.resolve(cwd, values.file), session: sessionIdentity(env).session, env, home, pullHead, landed });
  }
  if (action === 'decision') {
    // A write goes only to the project --project names itself: a folder that is gone, or no project's root, such as a
    // removed nested project or worktree, never falls through to the project above it.
    const named = values.project === undefined ? null : resolvedPath(path.resolve(cwd, values.project));
    if ((values.record || values.forget) && values.project !== undefined && (named === null || named !== resolvedPath(project.root))) {
      return refused('decision', `--project names ${path.resolve(cwd, values.project)}, which is not the root of a project here (it resolves to ${project.root}); record or forget the decision from the project the preview named`);
    }
    return decisionCommand({ project, config, key: run, heading: values.heading, record: values.record === true, forget: values.forget === true, env, home });
  }
  if (action === 'preflight') return preflightCommand({ project, config, run: run ?? null, env, home, ...(forge ? { forge } : {}), ...(platform ? { platform } : {}), ...(exec ? { exec } : {}) });
  if (action === 'report') return reportCommand({ project, config, run, json: values.json === true, env, home });
  if (action === 'recorded') return recordedCommand({ project, config, run, key: second, env, home, ...(now === undefined ? {} : { now }) });
  const gate = { project, config, run, env, home, ...(now === undefined ? {} : { now }), ...(forge ? { forge } : {}) };
  // The preflight's checks of a halt's cause, for this run on its pinned repository, which the driver's start of the
  // halted issue runs (project-recheck.mjs).
  const recheck = ({ repository, names }) => recheckLines({ project, config, run, repository, names, env, home, ...(forge ? { forge } : {}), ...(platform ? { platform } : {}), ...(exec ? { exec } : {}) });
  if (action === 'start') return startIssue({ ...gate, key: second, spawn, wait, recheck, ...(platform ? { platform } : {}), ...(exec ? { exec } : {}) });
  if (action === 'result') {
    if (!values.file) return fail('project result needs --file');
    return recordResult({ ...gate, key: second, file: path.resolve(cwd, values.file) });
  }
  if (action === 'handoff') return recordHandoff({ ...gate, brief: path.resolve(cwd, second) });
  if (action === 'resume') return resumeRun({ ...gate, custody: values.custody === true, spawn });
  if (action === 'end') return endRun({ ...gate, spawn });
  if (action === 'stop-action') return stopAction({ ...gate, key: second, catchUp: values['catch-up'] === true, ...(autoMerge ? { autoMerge } : {}) });
  if (action === 'wait') {
    const given = values['max-wait'] ?? String(WAIT_DEFAULT);
    if (!/^\d{1,4}$/u.test(given) || Number(given) > WAIT_CEILING) return fail(`project wait takes --max-wait as whole seconds from 0 to ${WAIT_CEILING}`);
    return waitRun({ ...gate, maxWait: Number(given), spawn, started, ...(pause ? { pause } : {}), ...(clock ? { clock } : {}) });
  }
  const place = runPlace(project, config, { env, home });
  if (place.problem) return refused(action, place.problem);
  const found = readRun(place.state, run);
  if (found.problem) return refused(action, found.problem);
  if (action === 'next') {
    // Each pass of a run's loop sweeps the recorded issue reads past their age, on a host with no session-end hook too.
    sweepIssueReads({ env, now: now ?? Date.now() });
    const maxParallel = runParallel(project, found.init.repository, forge ?? forgeFor(project.root));
    // A session that runs on after its issue settled, as the host lists it, holds every start back: `wait` (lib/project-linger.mjs).
    const { lingering } = lingeringStarts({ found, store: runStore(project, config, place.state), cap: detectHost({ env }).capabilities.projectStart, env, spawn, now: now ?? Date.now() });
    const planned = planRun(found.snapshot, found.states, { maxParallel });
    const plan = lingering.length ? { ...planned, next: [], verdict: 'wait' } : planned;
    const halt = haltOf(found);
    const pause = pauseOf(found, now ?? Date.now());
    const held = lingering.map((row) => ({ key: row.key, attempt: row.attempt }));
    // The settle reports the run owes, on every pass, so one owed before this driver's first `wait` is written too.
    const owed = owedKeys(found);
    return { exitCode: 0, out: values.json ? [JSON.stringify({ ...plan, lingering: held, maxParallel, halt, pause, owed }, null, 2)] : nextLines(plan, { halt, pause, lingering: held, owed }), err: [] };
  }
  const written = writeSummary(place.state, run);
  if (written.problem) return refused('summary', written.problem);
  return { exitCode: 0, out: [written.text.replace(/\n$/u, '')], err: [] };
}

const refused = (action, problem) => ({ exitCode: 1, out: [], err: [`aidrian project ${action}: ${problem}`] });

// Whether the projects `one` and `other` share a main checkout, by its real path.
function sameMainCheckout(one, other) {
  const [a, b] = [one, other].map((project) => resolvedPath(project.checkouts.at(-1)));
  return a !== null && a === b;
}

function print({ exitCode, out, err }) {
  if (out.length) console.log(out.join('\n'));
  if (err.length) console.error(err.join('\n'));
  return exitCode;
}

function fail(problem) {
  return { exitCode: 1, out: [], err: [...usageLines('project', USAGE, 'usage: '), '', problem] };
}
