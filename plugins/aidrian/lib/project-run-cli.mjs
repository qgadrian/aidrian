// `aidrian project`: the record of a project run and the order of its issues (lib/project-run.mjs).
//
//   aidrian project init RUN --file PATH   # validate the driver's snapshot input and start run RUN; the attended main session only
//   aidrian project next RUN [--json]      # the next issue or issues to start, `wait N running`, or `done`
//   aidrian project summary RUN            # write and print summary.md from the ledger
//   aidrian project start RUN ISSUE        # the driver starts the issue's session in its worktree (lib/project-run-gate.mjs)
//   aidrian project wait RUN [--max-wait S] # the driver waits for an issue's session to settle, at most S seconds
//   aidrian project result RUN ISSUE --file PATH   # the issue's own session records how it ended
//   aidrian project handoff RUN BRIEF      # the driver records the brief its background continuation starts from
//   aidrian project resume RUN             # an attended session lifts the halt a failed start proof put on the run
//
// The run's files are in `<state>/runs/RUN/`, where `<state>` is the project's state folder as lib/project-run.mjs
// runPlace resolves and checks it. `--project` on init must name the project of the current folder's main checkout.
// Exits: 0 on an answer; 1 on a refusal, a run that cannot be read, or bad arguments, after printing why.

import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { resolvedPath } from './fs.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { projectAt } from './project.mjs';
import { haltOf, initRun, nextLines, planRun, readRun, runPlace, writeSummary } from './project-run.mjs';
import { recordHandoff, recordResult, resumeRun, startIssue, WAIT_CEILING, WAIT_DEFAULT, waitRun } from './project-run-gate.mjs';
import { usageLines } from './usage.mjs';

const USAGE = 'init RUN --file PATH [--project DIR] | next RUN [--json] [--project DIR] | summary RUN [--project DIR] | start RUN ISSUE [--project DIR] | ' +
  'wait RUN [--max-wait SECONDS] [--project DIR] | result RUN ISSUE --file PATH [--project DIR] | handoff RUN BRIEF [--project DIR] | resume RUN [--project DIR]';
// The actions the command takes; lib/project-run-guard.mjs holds a rule for each (test/project-start-guard.test.mjs).
export const ACTIONS = ['init', 'next', 'summary', 'start', 'wait', 'result', 'handoff', 'resume'];
// The positionals each action takes after its name.
const POSITIONALS = { init: ['one run id'], next: ['one run id'], summary: ['one run id'], start: ['a run id', 'an issue key'], wait: ['one run id'], result: ['a run id', 'an issue key'], handoff: ['a run id', 'a brief'], resume: ['one run id'] };

export const commands = {
  project: {
    usage: USAGE,
    about: 'keep the record of a project run that works through a tracker project: init validates the snapshot input the driver session wrote from the tracker and starts run RUN, from the attended main session only; next prints the issue or issues to start, by blockers, then priority, then key, or done; summary writes the run\'s summary.md from its ledger; ' +
      'start, for the run\'s driver, starts the issue\'s own session in the background in its worktree, under the caps; wait waits for an issue\'s session to end or record its result; result records it, from that session only; handoff records the brief the driver\'s background continuation takes the run on with; ' +
      'resume, from an attended session only, lifts the halt a failed start proof put on the run',
    run: (args) => print(projectCommand(args)),
  },
};

// Runs `aidrian project` with `args` and returns { exitCode, out, err }, the lines for stdout and stderr. `cwd` is the
// current folder and `env` the environment the session id is read from. `home` is for a test: the unattended marks are
// read in the home folder of the user this process runs as, which no variable of a command's environment moves, so only
// an in-process caller can point it elsewhere. So are `forge`, the forge facade the team's policy and a merge are read
// through, `spawn` and `wait`, the host adapter's stand-ins for its command and its pause, `pause`, wait's pause between
// reads, and `now`. Throws what parseArgs and commandConfig throw, which lib/cli.mjs reports.
export function projectCommand(args, { cwd = process.cwd(), env = process.env, home, forge, spawn, wait, pause, now } = {}) {
  const [action, ...rest] = args;
  if (!ACTIONS.includes(action)) return fail(`project takes ${ACTIONS.slice(0, -1).join(', ')}, or ${ACTIONS.at(-1)}${action ? `, not "${action}"` : ''}`);
  const word = { type: 'string' };
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      project: word,
      ...(['init', 'result'].includes(action) ? { file: word } : {}),
      ...(action === 'next' ? { json: { type: 'boolean' } } : {}),
      ...(action === 'wait' ? { 'max-wait': word } : {}),
    },
  });
  const wanted = POSITIONALS[action];
  if (positionals.length !== wanted.length) return fail(`project ${action} takes ${wanted.join(' and ')}`);
  const [run, second] = positionals;
  const project = projectAt(path.resolve(cwd, values.project ?? '.'));
  const config = commandConfig(project);
  if (action === 'init') {
    if (!values.file) return fail('project init needs --file');
    if (values.project !== undefined && !sameMainCheckout(project, projectAt(cwd))) {
      return refused('init', '--project names a project outside the main checkout of the current folder; run init from that project');
    }
    return initRun({ project, config, run, file: path.resolve(cwd, values.file), session: sessionIdentity(env).session, env, home });
  }
  const gate = { project, config, run, env, home, ...(now === undefined ? {} : { now }), ...(forge ? { forge } : {}) };
  if (action === 'start') return startIssue({ ...gate, key: second, spawn, wait });
  if (action === 'result') {
    if (!values.file) return fail('project result needs --file');
    return recordResult({ ...gate, key: second, file: path.resolve(cwd, values.file) });
  }
  if (action === 'handoff') return recordHandoff({ ...gate, brief: path.resolve(cwd, second) });
  if (action === 'resume') return resumeRun(gate);
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
    return { exitCode: 0, out: values.json ? [JSON.stringify({ ...plan, halt }, null, 2)] : nextLines(plan, { halt }), err: [] };
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
