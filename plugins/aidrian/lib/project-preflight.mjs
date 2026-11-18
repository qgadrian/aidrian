// `aidrian project preflight`: every check that would refuse or halt a project run's start, run at once from the
// attended session before `aidrian project init`, so the Human sees each blocker before walking away. It reads and
// starts nothing. Each check is the start gate's own (lib/project-run-gate.mjs, lib/project-start.mjs): the repository
// origin names, the state folder and any other active run, the team's projectRun through the forge, the machine's
// switch, the host's start (confined, verified or allowed through projectRun.unverifiedHosts, hooks trusted), and the
// host's access check (push rights, an HTTPS origin the sandbox can push to, and nothing that would run outside the
// sandbox: other enabled plugins, user hooks, a status line, a credential helper it cannot reach), and whether the host
// carries on by itself after a usage limit, which stops the driver too. Then the base branch's reviewer bot. A check whose input a failed one gives is still run where it can be, on what the base branch says alone,
// so one pass names every blocker. Two checks need the tracker's and the forge's own reads, which the driver makes:
// `ask` lines name them.

import { baseBranchTip, machineSwitch } from './config.mjs';
import { forgeFor } from './forges/index.mjs';
import { baseBranchConfig } from './handoff-continue.mjs';
import { detectHost } from './hosts/index.mjs';
import { activeRuns, pinnedRepository, runPlace } from './project-run.mjs';
import { teamPolicy } from './project-run-gate.mjs';
import { accessProblem, guardedFolders, hostStartProblem } from './project-start.mjs';

// The reviewer values that mean no bot reviews, as config-defaults.mjs reads `github.reviewer`.
const NO_REVIEWER = new Set([null, undefined, '', 'none']);

// Runs every check for `project`, whose loaded config is `config`, and returns { exitCode, out, err }: a line `ok NAME`,
// `blocker NAME: WHY`, or `ask NAME: WHAT` per check, exit 1 when any blocker. `forge`, `home`, and `platform` are a test's.
export function preflightCommand({ project, config, env = process.env, home, forge, platform = process.platform }) {
  const lines = [];
  const check = (name, problem) => lines.push(problem ? `blocker ${name}: ${problem}` : `ok ${name}`);
  const main = project.checkouts.at(-1);
  const repository = pinnedRepository(project);
  check('repository', repository ? null : 'origin names no repository a forge serves; set origin to the repository\'s HTTPS URL');
  const place = runPlace(project, config, { env, ...(home ? { home } : {}) });
  check('state', place.problem ?? null);
  if (!place.problem) {
    const active = activeRuns(place.state);
    check('run', active.length ? `the run ${active[0].run ?? 'in a folder that cannot be listed'} is still active, and a project has one active run at a time` : null);
  }
  const base = baseBranchTip(project.root) ? baseBranchConfig(project, 'projectRun') : { why: 'git names no base branch commit' };
  const facade = forge ?? forgeFor(project.root);
  const read = repository ? teamPolicy(project, repository, facade) : { problem: 'the repository is unknown, so the forge\'s config cannot be read' };
  check('policy', read.problem ?? null);
  // The base branch's word alone stands in for a policy the forge could not confirm: it only finds more blockers.
  const fallback = base.config?.projectRun ?? {};
  const policy = read.problem ? { solo: base.config?.solo === true, unverifiedHosts: fallback.unverifiedHosts === true, outsideSandbox: fallback.outsideSandbox ?? [] } : read;
  const machine = machineSwitch(project.localHandoffBackground, () => policy.solo === true, project);
  check('machine', machine === 'on' ? null : 'this machine has not turned on sessions no Human attends: add "handoff": { "background": "on" } to its git-ignored local file, or the team sets solo');
  const cap = detectHost({ env }).capabilities.projectStart;
  let host = null;
  if (!cap) host = 'this host declares no way to start a project run\'s session';
  else if (cap.confined !== true) host = 'this host\'s project start is not confined to a fresh clone under its own sandbox';
  else host = hostStartProblem(cap, policy, env);
  check('host', host);
  if (cap && repository && !place.problem) {
    let access;
    try {
      access = accessProblem({ cap, forge: facade, repository, env, home, guarded: guardedFolders({ main, state: place.state, env, home }), main, platform, allowed: policy.outsideSandbox });
    } catch (error) {
      access = { halt: `the access check failed (${String(error?.message ?? error).split('\n')[0]})` };
    }
    check('access', access?.halt ?? access?.refuse ?? null);
  } else {
    check('access', 'it needs the repository, the state folder, and a host that starts project sessions, which the lines above name');
  }
  // A usage limit is the account's, so it stops the driver with the issues' sessions: the run takes up again only when
  // the driver's host carries on by itself. A host that declares no way to read that is asked of the driver.
  let limit = null;
  if (typeof cap?.limitContinue === 'function') {
    try {
      limit = cap.limitContinue({ env, home });
    } catch (error) {
      limit = `the host's usage-limit setting cannot be read (${String(error?.message ?? error).split('\n')[0]})`;
    }
    check('usage-limit', limit);
  }
  const reviewer = base.config?.github?.reviewer;
  check('reviewer', base.why ? `the base branch's config.json cannot be read (${base.why})` : NO_REVIEWER.has(reviewer) ? 'the base branch sets no github.reviewer, so no bot reviews an issue\'s pull request before an unattended merge' : null);
  lines.push(`ask reviewer-seen: confirm on the forge that ${NO_REVIEWER.has(reviewer) ? 'the reviewer bot' : reviewer} has reviewed a recent pull request of this repository`);
  lines.push('ask ci: confirm the default branch runs CI on pull requests, or that the run\'s first issue creates it');
  if (typeof cap?.limitContinue !== 'function') lines.push('ask usage-limit: confirm this host carries on by itself after a usage limit, since a limit stops the driver too');
  const blocked = lines.some((line) => line.startsWith('blocker '));
  return { exitCode: blocked ? 1 : 0, out: lines, err: blocked ? ['aidrian project preflight: fix each blocker line, then run it again'] : [] };
}
