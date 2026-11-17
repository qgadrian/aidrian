// `aidrian project`: the record of a project run and the order of its issues (lib/project-run.mjs).
//
//   aidrian project init RUN --file PATH   # validate the driver's snapshot input and start run RUN; the attended main session only
//   aidrian project next RUN [--json]      # the next issue or issues to start, `wait N running`, or `done`
//   aidrian project summary RUN            # write and print summary.md from the ledger
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
import { initRun, nextLines, planRun, readRun, runPlace, writeSummary } from './project-run.mjs';
import { usageLines } from './usage.mjs';

const USAGE = 'init RUN --file PATH [--project DIR] | next RUN [--json] [--project DIR] | summary RUN [--project DIR]';

export const commands = {
  project: {
    usage: USAGE,
    about: 'keep the record of a project run that works through a tracker project: init validates the snapshot input the driver session wrote from the tracker and starts run RUN, from the attended main session only; next prints the issue or issues to start, by blockers, then priority, then key, or done; summary writes the run\'s summary.md from its ledger',
    run: (args) => print(projectCommand(args)),
  },
};

// Runs `aidrian project` with `args` and returns { exitCode, out, err }, the lines for stdout and stderr. `cwd` is the
// current folder and `env` the environment the session id is read from. `home` is for a test: the unattended marks are
// read in the home folder of the user this process runs as, which no variable of a command's environment moves, so only
// an in-process caller can point it elsewhere. Throws what parseArgs and commandConfig throw, which lib/cli.mjs reports.
export function projectCommand(args, { cwd = process.cwd(), env = process.env, home } = {}) {
  const [action, ...rest] = args;
  if (!['init', 'next', 'summary'].includes(action)) return fail(`project takes init, next, or summary${action ? `, not "${action}"` : ''}`);
  const word = { type: 'string' };
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { project: word, ...(action === 'init' ? { file: word } : {}), ...(action === 'next' ? { json: { type: 'boolean' } } : {}) },
  });
  if (positionals.length !== 1) return fail(`project ${action} takes one run id`);
  const [run] = positionals;
  const project = projectAt(path.resolve(cwd, values.project ?? '.'));
  const config = commandConfig(project);
  if (action === 'init') {
    if (!values.file) return fail('project init needs --file');
    if (values.project !== undefined && !sameMainCheckout(project, projectAt(cwd))) {
      return refused('init', '--project names a project outside the main checkout of the current folder; run init from that project');
    }
    return initRun({ project, config, run, file: path.resolve(cwd, values.file), session: sessionIdentity(env).session, env, home });
  }
  const place = runPlace(project, config, { env, home });
  if (place.problem) return refused(action, place.problem);
  const found = readRun(place.state, run);
  if (found.problem) return refused(action, found.problem);
  if (action === 'next') {
    const plan = planRun(found.snapshot, found.states);
    return { exitCode: 0, out: values.json ? [JSON.stringify(plan, null, 2)] : nextLines(plan), err: [] };
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
