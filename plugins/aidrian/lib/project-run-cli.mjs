// `aidrian project`: the record of a project run and the order of its issues (lib/project-run.mjs).
//
//   aidrian project init RUN --file PATH   # validate the driver's snapshot input and start run RUN; the attended main session only
//                    [--texts PATH]        # each issue's text, apart from the snapshot input, for its session to read
//                    [--check]             # only check the inputs and print their order and blockers, writing no run
//   aidrian project next RUN [--json]      # the next issue or issues to start, `wait N running`, or `done`
//   aidrian project summary RUN            # write and print summary.md from the ledger
//   aidrian project end RUN                # the driver records the run's end, which releases its driver mark
//   aidrian project start RUN ISSUE        # the driver starts the issue's session in a fresh clone (lib/project-run-gate.mjs)
//   aidrian project wait RUN [--max-wait S] # the driver waits for an issue's session to settle, at most S seconds
//   aidrian project result RUN ISSUE --file PATH   # the issue's own session records how it ended
//   aidrian project handoff RUN BRIEF      # the driver records the brief its background continuation starts from
//   aidrian project resume RUN             # an attended session lifts the halt a failed start proof put on the run
//   aidrian project report RUN [--json]    # the driver: the status, label, and comment the run owes each settled issue
//   aidrian project recorded RUN ISSUE     # the driver: closes the report on ISSUE once it wrote it (lib/project-report.mjs)
//   aidrian project preflight [RUN]        # every check a start would refuse or halt on, before init (lib/project-preflight.mjs)
//
// The run's files are in `<state>/runs/RUN/`, where `<state>` is the project's state folder as lib/project-run.mjs
// runPlace resolves and checks it. `--project` on init must name the project of the current folder's main checkout.
// Exits: 0 on an answer; 1 on a refusal, a run that cannot be read, or bad arguments, after printing why; 75 with a
// `retry:` line when another process holds the run's ledger locked.

import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { resolvedPath } from './fs.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { projectAt } from './project.mjs';
import { pauseOf } from './project-limit.mjs';
import { LOCKED } from './jsonl.mjs';
import { preflightCommand, snapshotCheck } from './project-preflight.mjs';
import { recordedCommand, reportCommand } from './project-report.mjs';
import { haltOf, initRun, nextLines, planRun, readRun, runPlace, writeSummary } from './project-run.mjs';
import { endRun, recordHandoff, recordResult, resumeRun, RETRY_EXIT, startIssue, WAIT_CEILING, WAIT_DEFAULT, waitRun } from './project-run-gate.mjs';
import { usageLines } from './usage.mjs';

const USAGE = 'init RUN --file PATH [--texts PATH] [--check] [--project DIR] | next RUN [--json] [--project DIR] | summary RUN [--project DIR] | start RUN ISSUE [--project DIR] | ' +
  'wait RUN [--max-wait SECONDS] [--project DIR] | result RUN ISSUE --file PATH [--project DIR] | handoff RUN BRIEF [--project DIR] | resume RUN [--project DIR] | end RUN [--project DIR] | ' +
  'report RUN [--json] [--project DIR] | recorded RUN ISSUE [--project DIR] | preflight [RUN] [--project DIR]';
// The actions the command takes; lib/project-run-guard.mjs holds a rule for each (test/project-start-guard.test.mjs).
export const ACTIONS = ['init', 'next', 'summary', 'start', 'wait', 'result', 'handoff', 'resume', 'end', 'report', 'recorded', 'preflight'];
// The positionals each action takes after its name.
const POSITIONALS = { init: ['one run id'], next: ['one run id'], summary: ['one run id'], start: ['a run id', 'an issue key'], wait: ['one run id'], result: ['a run id', 'an issue key'], handoff: ['a run id', 'a brief'], resume: ['one run id'], end: ['one run id'], report: ['one run id'], recorded: ['a run id', 'an issue key'], preflight: [] };

export const commands = {
  project: {
    usage: USAGE,
    about: 'keep the record of a project run that works through a tracker project: init validates the snapshot input the driver session wrote from the tracker and starts run RUN, from the attended main session only; next prints the issue or issues to start, by blockers, then priority, then key, or done; summary writes the run\'s summary.md from its ledger; ' +
      'start, for the run\'s driver, starts the issue\'s own session in the background in its worktree, under the caps; wait waits for an issue\'s session to end or record its result; result records it, from that session only; handoff records the brief the driver\'s background continuation takes the run on with; ' +
      'resume, from an attended session only, lifts the halt a failed start proof put on the run; end, for the run\'s driver at the end of its loop, records the run\'s end, which releases the driver\'s hold; ' +
      'report, for the driver, prints the status, label, and comment the run owes each settled issue, and recorded closes one once written; preflight runs every check a start would refuse or halt on, before init',
    run: (args) => print(projectCommand(args)),
  },
};

// Runs `aidrian project` with `args` and returns { exitCode, out, err }, the lines for stdout and stderr. `cwd` is the
// current folder and `env` the environment the session id is read from. `home` is for a test: the unattended marks are
// read in the home folder of the user this process runs as, which no variable of a command's environment moves, so only
// an in-process caller can point it elsewhere. So are `forge`, the forge facade the team's policy and a merge are read
// through, `spawn` and `wait`, the host adapter's stand-ins for its command and its pause, `pause`, wait's pause between
// reads, `now`, and `platform`, the operating system a start's host sandbox runs on. Throws what parseArgs and
// commandConfig throw, which lib/cli.mjs reports.
// A ledger another process holds locked is a refusal that may pass: exit 75, EX_TEMPFAIL, with a `retry:` line, which
// the driver's loop tries again after one wait.
export function projectCommand(args, options = {}) {
  try {
    return projectAction(args, options);
  } catch (error) {
    if (error?.code !== LOCKED) throw error;
    return { exitCode: RETRY_EXIT, out: [`retry: ${String(error.message).split('\n')[0]}`], err: [`aidrian project ${args[0]}: ${String(error.message).split('\n')[0]}`] };
  }
}

// The exit of a refusal that may pass when tried again: project-run-gate.mjs's.
export { RETRY_EXIT };

function projectAction(args, { cwd = process.cwd(), env = process.env, home, forge, spawn, wait, pause, now, platform } = {}) {
  const [action, ...rest] = args;
  if (!ACTIONS.includes(action)) return fail(`project takes ${ACTIONS.slice(0, -1).join(', ')}, or ${ACTIONS.at(-1)}${action ? `, not "${action}"` : ''}`);
  const word = { type: 'string' };
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      project: word,
      ...(['init', 'result'].includes(action) ? { file: word } : {}),
      ...(action === 'init' ? { check: { type: 'boolean' }, texts: word } : {}),
      ...(['next', 'report'].includes(action) ? { json: { type: 'boolean' } } : {}),
      ...(action === 'wait' ? { 'max-wait': word } : {}),
    },
  });
  // preflight takes the run it checks for, once init has made it, or none before.
  const wanted = action === 'preflight' && positionals.length === 1 ? ['one run id'] : POSITIONALS[action];
  if (positionals.length !== wanted.length) return fail(`project ${action} takes ${action === 'preflight' ? 'at most one run id' : wanted.join(' and ')}`);
  const [run, second] = positionals;
  const project = projectAt(path.resolve(cwd, values.project ?? '.'));
  const config = commandConfig(project);
  if (action === 'init') {
    if (!values.file) return fail('project init needs --file');
    const texts = values.texts === undefined ? null : path.resolve(cwd, values.texts);
    if (values.check) return snapshotCheck({ project, config, file: path.resolve(cwd, values.file), texts });
    if (values.project !== undefined && !sameMainCheckout(project, projectAt(cwd))) {
      return refused('init', '--project names a project outside the main checkout of the current folder; run init from that project');
    }
    return initRun({ project, config, run, file: path.resolve(cwd, values.file), texts, session: sessionIdentity(env).session, env, home });
  }
  if (action === 'preflight') return preflightCommand({ project, config, run: run ?? null, env, home, ...(forge ? { forge } : {}), ...(platform ? { platform } : {}) });
  if (action === 'report') return reportCommand({ project, config, run, json: values.json === true, env, home });
  if (action === 'recorded') return recordedCommand({ project, config, run, key: second, env, home, ...(now === undefined ? {} : { now }) });
  const gate = { project, config, run, env, home, ...(now === undefined ? {} : { now }), ...(forge ? { forge } : {}) };
  if (action === 'start') return startIssue({ ...gate, key: second, spawn, wait, ...(platform ? { platform } : {}) });
  if (action === 'result') {
    if (!values.file) return fail('project result needs --file');
    return recordResult({ ...gate, key: second, file: path.resolve(cwd, values.file) });
  }
  if (action === 'handoff') return recordHandoff({ ...gate, brief: path.resolve(cwd, second) });
  if (action === 'resume') return resumeRun({ ...gate, spawn });
  if (action === 'end') return endRun(gate);
  if (action === 'wait') {
    const given = values['max-wait'] ?? String(WAIT_DEFAULT);
    if (!/^\d{1,4}$/u.test(given) || Number(given) > WAIT_CEILING) return fail(`project wait takes --max-wait as whole seconds from 0 to ${WAIT_CEILING}`);
    return waitRun({ ...gate, maxWait: Number(given), spawn, ...(pause ? { pause } : {}) });
  }
  const place = runPlace(project, config, { env, home });
  if (place.problem) return refused(action, place.problem);
  const found = readRun(place.state, run);
  if (found.problem) return refused(action, found.problem);
  if (action === 'next') {
    const plan = planRun(found.snapshot, found.states);
    const halt = haltOf(found);
    const pause = pauseOf(found, now ?? Date.now());
    return { exitCode: 0, out: values.json ? [JSON.stringify({ ...plan, halt, pause }, null, 2)] : nextLines(plan, { halt, pause }), err: [] };
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
