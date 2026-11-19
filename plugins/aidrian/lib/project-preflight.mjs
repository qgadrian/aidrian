// `aidrian project preflight`: every check that would refuse or halt a project run's start, run at once from the
// attended session before `aidrian project init`, so the Human sees each blocker before walking away. It reads and
// starts nothing. Each check is the start gate's own (lib/project-run-gate.mjs, lib/project-start.mjs): the repository
// origin names, the state folder and any other active run, the team's projectRun through the forge, the machine's
// switch, the host's start (confined, verified or allowed through projectRun.unverifiedHosts, hooks trusted), and the
// host's access check (push rights, an HTTPS origin the sandbox can push to, and nothing that would run outside the
// sandbox: other enabled plugins, user hooks, a status line, a credential helper it cannot reach), and whether the host
// carries on by itself after a usage limit, which stops the driver too. Then the base branch's reviewer bot. A check whose input a failed one gives is still run where it can be, on what the base branch says alone,
// so one pass names every blocker. Then what the run needs to finish with no one: the tracker's server among the
// team's projectRun.mcpServers, each tracker server there mapped so the run rule can hold it, auto-merge on with
// required checks, a handoff route for the driver, and, through the forge, the reviewer bot seen and CI workflows.
// A read the forge or the tracker lacks becomes an `ask` line, which the driver answers with its own tools.

import { baseBranchTip, machineSwitch } from './config.mjs';
import { resolveAutoMerge } from './config-local.mjs';
import { forgeFor } from './forges/index.mjs';
import { knownPrefix } from './git.mjs';
import { baseBranchConfig } from './handoff-continue.mjs';
import { continueRoutes, detectHost } from './hosts/index.mjs';
import { branchPolicies } from './pr-auto-merge.mjs';
import { mayFollowTeamDefault } from './project.mjs';
import { activeRuns, nextLines, pinnedRepository, planRun, readIssueTexts, readSnapshotInput, refNames, runPlace } from './project-run.mjs';
import { teamPolicy } from './project-run-gate.mjs';
import { accessProblem, guardedFolders, hostStartProblem } from './project-start.mjs';
import { trackerOfEndpoint } from './tracker-guard.mjs';
import { knownServers, trackerById, trackerOfTools, TRACKERS } from './trackers/index.mjs';

// The reviewer values that mean no bot reviews, as config-defaults.mjs reads `github.reviewer`.
const NO_REVIEWER = new Set([null, undefined, '', 'none']);

// Runs every check for `project`, whose loaded config is `config`, with `run` the run these checks are for, which the
// active-run check leaves out, and returns { exitCode, out, err }: a line `ok NAME`,
// `blocker NAME: WHY`, or `ask NAME: WHAT` per check, exit 1 when any blocker. `forge`, `home`, and `platform` are a test's.
export function preflightCommand({ project, config, run = null, env = process.env, home, forge, platform = process.platform }) {
  const lines = [];
  const check = (name, problem) => lines.push(problem ? `blocker ${name}: ${problem}` : `ok ${name}`);
  const main = project.checkouts.at(-1);
  const repository = pinnedRepository(project);
  check('repository', repository ? null : 'origin names no repository a forge serves; set origin to the repository\'s HTTPS URL');
  const place = runPlace(project, config, { env, ...(home ? { home } : {}) });
  check('state', place.problem ?? null);
  if (!place.problem) {
    const active = activeRuns(place.state, run ? { except: run } : {});
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
  const asks = [];
  const tracker = trackerLines(base, policy, read.problem ? (fallback.mcpServers ?? {}) : policy.mcpServers);
  lines.push(...tracker.lines);
  check('auto-merge', autoMergeProblem({ project, repository, facade }));
  const route = base.config?.session?.handoff?.continue;
  check('handoff', base.why ? `the base branch's config.json cannot be read (${base.why})` : route === 'background' ? null
    : route === 'clear' ? 'the base branch\'s session.handoff.continue is "clear", and the clear route needs a person to start the next session; set it to "background" on the default branch'
      : 'the base branch\'s session.handoff.continue is not "background", so the driver cannot hand itself on when its session grows long; set it on the default branch');
  if (!continueRoutes(detectHost({ env })).some((route) => ['background', 'clear'].includes(route))) lines.push('note handoff: this host lists no route that continues a session, so the driver keeps driving in this one session, which the host compacts');
  const reviewer = base.config?.github?.reviewer;
  check('reviewer', base.why ? `the base branch's config.json cannot be read (${base.why})` : NO_REVIEWER.has(reviewer) ? 'the base branch sets no github.reviewer, so no bot reviews an issue\'s pull request before an unattended merge' : null);
  forgeLines({ facade, repository, reviewer, lines, check, asks });
  if (tracker.adapter?.run?.labelRead) {
    const status = base.config?.projectRun?.blockedStatus;
    asks.push(`ask labels: confirm with ${tracker.adapter.run.labelRead} that the team has the label ${JSON.stringify(base.config?.projectRun?.decisionLabel)}${typeof status === 'string' ? `, and with ${tracker.adapter.run.statusRead} the status ${JSON.stringify(status)}` : ''}; a missing one is a blocker`);
  }
  lines.push(...asks);
  if (typeof cap?.limitContinue !== 'function') lines.push('ask usage-limit: confirm this host carries on by itself after a usage limit, since a limit stops the driver too');
  const blocked = lines.some((line) => line.startsWith('blocker '));
  return { exitCode: blocked ? 1 : 0, out: lines, err: blocked ? ['aidrian project preflight: fix each blocker line, then run it again'] : [] };
}

// The tracker check: the base branch's tracker adapter, and a server of it among the team's projectRun.mcpServers, which
// are the only servers an issue's session loads; and every server there that a tracker's name or endpoint marks as one
// the run rule can map. A server named like a tracker whose endpoint maps to none is a blocker: the rule could not hold
// its writes. Returns { lines, adapter }.
function trackerLines(base, policy, mcpServers) {
  const lines = [];
  const tracker = base.config?.tracker ?? {};
  const adapter = (typeof tracker.provider === 'string' ? trackerById(tracker.provider) : null) ?? trackerOfTools([...(tracker.writeTools ?? []), ...(tracker.readTools ?? [])]);
  const entries = Object.entries(mcpServers ?? {});
  const mapped = (name, definition) => trackerOfEndpoint(definition) ?? TRACKERS.find((each) => knownServers(each).includes(name)) ?? null;
  const unmapped = entries.filter(([name, definition]) => !mapped(name, definition) && TRACKERS.some((each) => name.toLowerCase().includes(each.id))).map(([name]) => name);
  let problem = null;
  if (!adapter) problem = 'the base branch\'s config.json names no tracker the plugin knows (tracker.provider), so the run cannot read or report its issues';
  else if (unmapped.length) problem = `projectRun.mcpServers holds ${unmapped.map((name) => JSON.stringify(name)).join(', ')}, named like a tracker with an endpoint no tracker adapter knows, so the run rule could not hold its writes; point it at the tracker's own endpoint, or remove it`;
  lines.push(problem ? `blocker tracker: ${problem}` : 'ok tracker');
  // An issue's session reads its issue from a file the driver wrote, so a run needs no tracker server in it.
  if (adapter && !entries.some(([name, definition]) => mapped(name, definition) === adapter)) lines.push(`note tracker: projectRun.mcpServers holds no ${adapter.name} server, so issue sessions will not write the tracker; the driver reports`);
  // Every tracker connection there must reach an adapter's endpoint, or be named in tracker.servers: the rule screens no other.
  const others = entries.filter(([name, definition]) => !mapped(name, definition) && !(tracker.servers ?? []).includes(name)).map(([name]) => name);
  if (others.length) lines.push(`note mcp-servers: the run rule maps ${others.map((name) => JSON.stringify(name)).join(', ')} to no tracker, so it screens no tracker write there; a tracker connection must reach its adapter's endpoint or be named in tracker.servers`);
  return { lines, adapter };
}

// Why an issue's pull request could not merge with no one there, or null: the default branch on the forge allows
// auto-merge, this machine's switch lets it, and it lists required checks, since a merge with none waits on no CI.
function autoMergeProblem({ project, repository, facade }) {
  if (!repository) return 'the repository is unknown, so the forge\'s config cannot be read';
  const prefix = knownPrefix(project.root);
  let policies;
  try {
    policies = branchPolicies(facade, { repo: `${repository.owner}/${repository.name}`, host: repository.host, base: null }, prefix ?? '');
  } catch (error) {
    return `the forge's copy of the default branch's config.json cannot be read (${String(error.message).split('\n')[0]})`;
  }
  const github = policies.policy.github ?? {};
  // As `aidrian pr auto-merge` reads it: the machine's own word, or the team's default where a tracked file cannot say.
  let local = project.localAutoMerge;
  if (local === 'unset' && github.autoMerge?.default === 'on' && !mayFollowTeamDefault(project)) local = 'off';
  const resolved = resolveAutoMerge(github, local);
  if (resolved.reason === 'team') return 'the default branch on the forge does not set github.autoMerge.allow, so no issue\'s pull request merges with no one there';
  if (resolved.reason === 'local') return 'this machine has not turned auto-merge on: "github": { "autoMerge": "on" } in its git-ignored local file, or the team sets github.autoMerge.default to "on"';
  if (!Array.isArray(github.requiredChecks) || github.requiredChecks.length === 0) return 'the default branch lists no github.requiredChecks, so a pull request would merge with no CI run; merge a CI workflow and its checks in github.requiredChecks before the run';
  return null;
}

// The reviewer bot seen on a recent pull request, and CI workflows, through the forge's own reads, or `ask` lines for a
// forge with none. With no pull request yet, the first one proves the bot, and the merge's trust check holds it until then.
function forgeLines({ facade, repository, reviewer, lines, check, asks }) {
  const bot = NO_REVIEWER.has(reviewer) ? null : reviewer;
  const named = repository ? `${repository.owner}/${repository.name}` : null;
  if (typeof facade.reviewerSeen === 'function' && named && bot) {
    try {
      const { changes, seen } = facade.reviewerSeen(named, bot, { host: repository.host });
      if (changes === 0) lines.push(`note reviewer-seen: no pull request yet, so the first one shows whether ${bot} reviews; the merge's trust check holds every merge until it has`);
      else check('reviewer-seen', seen ? null : `${bot} reviewed none of the last ${changes} pull requests; install it on the repository and request one review`);
    } catch (error) {
      check('reviewer-seen', `the forge cannot list recent pull requests (${String(error.message).split('\n')[0]})`);
    }
  } else if (bot) asks.push(`ask reviewer-seen: confirm on the forge that ${bot} has reviewed a recent pull request of this repository`);
  if (typeof facade.ciWorkflows === 'function' && named) {
    try {
      const workflows = facade.ciWorkflows(named, { host: repository.host });
      check('ci', workflows.length ? null : 'the repository has no active CI workflow; merge one that runs on pull requests before the run');
    } catch (error) {
      check('ci', `the forge cannot list CI workflows (${String(error.message).split('\n')[0]})`);
    }
  } else asks.push('ask ci: confirm the default branch runs CI on pull requests');
}

// `aidrian project init RUN --file PATH [--texts PATH] --check`: the inputs' checks, as init makes them, and the order,
// with no run written: a `blocker snapshot` line for each problem, for each issue blocked by a cycle or by a status the
// run does not start from, and, when the base branch's projectRun.mcpServers holds no tracker server an issue's session
// could read the tracker through, for each issue to start with no text; then `next` lines as `aidrian project next`
// prints them. Exit 1 on any blocker.
export function snapshotCheck({ project, config, file, texts = null }) {
  const read = readSnapshotInput(file, refNames(project, config));
  if (!read.snapshot) return { exitCode: 1, out: read.problems.slice(0, 50).map((problem) => `blocker snapshot: ${problem}`), err: ['aidrian project init --check: fix the snapshot input, then check it again'] };
  const kept = readIssueTexts(texts, new Set(read.snapshot.issues.map((issue) => issue.key)));
  if (kept.problem) return { exitCode: 1, out: [`blocker texts: ${kept.problem}`], err: ['aidrian project init --check: fix the texts input, then check it again'] };
  const plan = planRun(read.snapshot, new Map());
  const blockers = plan.blocked.filter(({ reason }) => reason === 'cycle' || reason === 'status')
    .map(({ key, reason, on }) => `blocker snapshot: ${key} is ${reason === 'cycle' ? `in a cycle of blockers, ${on.join(', ')}, so it never starts` : `${on[0]} in the tracker, which a run does not start from`}`);
  if (!trackerReachable(baseBranchTip(project.root) ? baseBranchConfig(project, 'projectRun') : {})) {
    const startable = new Set(plan.order);
    blockers.push(...read.snapshot.issues.filter((issue) => startable.has(issue.key) && !plan.done.includes(issue.key) && !kept.texts[issue.key])
      .map((issue) => `blocker texts: ${issue.key} has no text, and projectRun.mcpServers holds no tracker server its session could read it through; give its text in --texts`));
  }
  const out = [`ok snapshot ${read.snapshot.issues.length} issues, ${Object.keys(kept.texts).length} with text`, ...blockers, ...nextLines(plan)];
  return blockers.length ? { exitCode: 1, out, err: ['aidrian project init --check: clear each blocker, then check again'] } : { exitCode: 0, out, err: [] };
}

// Whether the base branch's config, as `base` (baseBranchConfig) reads it, lists in projectRun.mcpServers a server of its
// tracker, by name or endpoint.
function trackerReachable(base) {
  const tracker = base.config?.tracker ?? {};
  const adapter = (typeof tracker.provider === 'string' ? trackerById(tracker.provider) : null) ?? trackerOfTools([...(tracker.writeTools ?? []), ...(tracker.readTools ?? [])]);
  if (!adapter) return false;
  return Object.entries(base.config?.projectRun?.mcpServers ?? {}).some(([name, definition]) => (trackerOfEndpoint(definition) ?? TRACKERS.find((each) => knownServers(each).includes(name))) === adapter);
}
