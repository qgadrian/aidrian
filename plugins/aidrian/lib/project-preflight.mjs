// `aidrian project preflight`: every check that would refuse or halt a project run's start but the push preflight, which
// reads the attempt's clone no preflight has (project-run-gate.mjs confinedRoom), run at once from the
// attended session before `aidrian project init`, so the Human sees each blocker before walking away. It reads and
// starts nothing. Each check is the start gate's own (lib/project-run-gate.mjs, lib/project-start.mjs): the repository
// origin names, the state folder and any other active run, a host instruction file above the runs folder, the team's projectRun through the forge, the machine's
// switch, the host's start (confined, verified or allowed through projectRun.unverifiedHosts, hooks trusted), the host's
// trust in the runs folder, and the
// host's access check (push rights, an HTTPS origin the sandbox can push to, and nothing that would run outside the
// sandbox: other enabled plugins, user hooks, a status line, a credential helper it cannot reach; and, on a host that
// hands its sessions the forge token, a token to hand, with a note naming its source), and whether the host
// carries on by itself after a usage limit, which stops the driver too. Then the base branch's reviewer bot. A check whose input a failed one gives is still run where it can be, on what the base branch says alone,
// so one pass names every blocker. Then what the run needs to finish with no one: the tracker's server among the
// team's projectRun.mcpServers, each tracker server there mapped so the run rule can hold it, auto-merge on with
// required checks, a handoff route for the driver, and, through the forge, the reviewer bot seen, CI workflows, a
// default branch that asks the signed-in user for a pull request, admin or not, a tag rule that user cannot bypass that
// stops any tag being created or moved, and no CI secret a workflow file that token may push could read, each unless the
// team accepts it, since an issue's session keeps that user's token: the agent gate hook refuses its tag pushes, releases,
// and workflow pushes, and the forge holds what a script it runs does with the token, unless the team accepts running
// without that backstop (projectRun.forgeProtectionAccepted). Notes say the forge runs a
// branch's workflow files with the repository's secrets on every push, and other services act on a push or a comment.
// A read the forge or the tracker lacks becomes an `ask` line, which the driver answers with its own tools.

import path from 'node:path';

import { baseBranchTip, machineSwitch } from './config.mjs';
import { resolveAutoMerge } from './config-local.mjs';
import { pluginRepository } from './config-version.mjs';
import { forgeFor } from './forges/index.mjs';
import { knownPrefix } from './git.mjs';
import { baseBranchConfig } from './handoff-continue.mjs';
import { continueRoutes, detectHost } from './hosts/index.mjs';
import { isQuotaNotice } from './pr-await-review.mjs';
import { branchPolicies } from './pr-auto-merge.mjs';
import { mayFollowTeamDefault } from './project.mjs';
import { recordedTexts } from './project-issue-text.mjs';
import { activeRuns, nextLines, pinnedRepository, planRun, readSnapshotInput, refNames, runPlace, runsFolder, teamsNote } from './project-run.mjs';
import { runParallel, teamPolicy } from './project-run-gate.mjs';
import { accessProblem, guardedFolders, hostStartProblem } from './project-start.mjs';
import { ancestorProblem } from './project-trust.mjs';
import { cardState, REVIEW_SUMMARY_CARD_MARKER } from './review/bot-card.mjs';
import { trackerOfEndpoint } from './tracker-guard.mjs';
import { knownServers, trackerById, trackerOfTools, TRACKERS } from './trackers/index.mjs';

// The reviewer values that mean no bot reviews, as config-defaults.mjs reads `github.reviewer`.
const NO_REVIEWER = new Set([null, undefined, '', 'none']);
// What a `note` says in place of a branch-protection or release-tags blocker the team accepts through
// projectRun.forgeProtectionAccepted.
const ACCEPTED_PROTECTION = 'the team accepts no forge protection (projectRun.forgeProtectionAccepted): a script an issue session runs can push to the default branch or a tag with the token, and only the hooks hold it';
// The risk of projectRun.localBinding where the host names none of its own.
const LOCAL_BINDING_RISK = 'a service a session starts may listen on this machine\'s network interfaces, where other local processes, and other machines the firewall lets through, reach it, and the session may reach the services listening on this machine';

// The setup doc of a project run, and its section that clears each check's blocker, by the check's name: every blocker
// line, and the labels `ask`, ends with a pointer to it (setupPointer). `token` is the access check's section when no
// source gives a forge token, that token may not push, or it is not the forge CLI's own user's.
// test/project-run-report.test.mjs holds each anchor to a heading of the doc.
export const SETUP_DOC = 'docs/project-run-setup.md';
// The doc's address on the main branch of the repository the plugin's manifest names, so a fork points at its own: a
// project's checkout has no copy of the doc. Its path alone when the manifest names no repository.
export function setupDocUrl() {
  const repository = pluginRepository();
  return repository ? `${repository.replace(/(?:\.git)?\/*$/u, '')}/blob/main/${SETUP_DOC}` : SETUP_DOC;
}
export const SETUP_SECTIONS = Object.freeze({
  repository: 'origin-over-https', state: 'state-folder', run: 'after-a-halt-or-a-stop', instructions: 'state-folder',
  policy: 'team-config', machine: 'this-machine', host: 'host-start', trust: 'trust-the-runs-folder', access: 'host-settings',
  token: 'forge-token-in-the-keychain', 'usage-limit': 'host-settings', tracker: 'team-config', 'auto-merge': 'auto-merge-and-ci',
  handoff: 'team-config', reviewer: 'review-bot', 'reviewer-seen': 'review-bot', ci: 'auto-merge-and-ci',
  'branch-protection': 'forge-rules', 'release-tags': 'forge-rules', 'workflow-secrets': 'forge-rules', labels: 'the-decision-label',
});
export const setupPointer = (section) => ` (setup: ${setupDocUrl()}#${SETUP_SECTIONS[section]})`;
const blockerLine = (name, problem, section = name) => `blocker ${name}: ${problem}${setupPointer(section)}`;

// The `note` preflight prints when the team lets issue sessions bind local ports through projectRun.localBinding: the
// risk as the host `cap` says it is on `platform` (capabilities.projectStart.localBindingRisk), and the remedy.
export function localBindingNote(cap, platform) {
  let risk = null;
  try {
    risk = cap?.localBindingRisk?.({ platform });
  } catch {
    risk = null;
  }
  const said = typeof risk === 'string' && risk ? risk : LOCAL_BINDING_RISK;
  return `note local-binding: the team lets issue sessions bind local ports (projectRun.localBinding): ${said}; bind each test server to 127.0.0.1, never 0.0.0.0`;
}

// Runs every check for `project`, whose loaded config is `config`, with `run` the run these checks are for, which the
// active-run check leaves out, and returns { exitCode, out, err }: a line `ok NAME`,
// `blocker NAME: WHY (setup: URL#SECTION)`, or `ask NAME: WHAT` per check, exit 1 when any blocker. `forge`, `home`, `platform`, and `exec`,
// the keychain read's execFileSync, are a test's.
export function preflightCommand({ project, config, run = null, env = process.env, home, forge, platform = process.platform, exec }) {
  const lines = [];
  const check = (name, problem) => lines.push(problem ? blockerLine(name, problem) : `ok ${name}`);
  const main = project.checkouts.at(-1);
  const repository = pinnedRepository(project);
  check('repository', repository ? null : 'origin names no repository a forge serves; set origin to the repository\'s HTTPS URL');
  const place = runPlace(project, config, { env, ...(home ? { home } : {}) });
  check('state', place.problem ?? null);
  if (!place.problem) {
    const active = activeRuns(place.state, run ? { except: run } : {});
    check('run', active.length ? `the run ${active[0].run ?? 'in a folder that cannot be listed'} is still active, and a project has one active run at a time` : null);
    // Every attempt's clone lies under the runs folder, so a host instruction file above it refuses every start.
    check('instructions', ancestorProblem(path.join(runsFolder(place.state), 'attempts'), { project, tip: baseBranchTip(project.root), env }));
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
  // A start in a folder the host has not trusted starts nothing, so a host that can read its trust says so for the runs folder.
  if (typeof cap?.trust === 'function' && !place.problem) {
    const trust = cap.trust({ folder: runsFolder(place.state), env, home });
    if (trust?.note) lines.push(`note trust: ${trust.note}`);
    else check('trust', trust?.problem ?? null);
  }
  if (cap && repository && !place.problem) {
    lines.push(...accessLines({ cap, facade, repository, env, home, main, state: place.state, platform, allowed: policy.outsideSandbox, localBinding: policy.localBinding === true, keychain: project.localForgeTokenKeychain, exec }));
    if (policy.localBinding === true) lines.push(localBindingNote(cap, platform));
  } else {
    check('access', 'it needs the repository, the state folder, and a host that starts project sessions, which the lines above name');
  }
  // A usage limit is the account's, so it stops the driver with the issues' sessions: the run takes up again only when
  // the driver's host carries on by itself. A host that declares no way to read that is asked of the driver.
  let limit = null;
  if (typeof cap?.limitContinue === 'function') {
    try {
      limit = cap.limitContinue({ env, home, project: main });
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
  protectionLines({ facade, repository, policy, lines, check, asks });
  if (tracker.adapter?.run?.labelRead) {
    const status = base.config?.projectRun?.blockedStatus;
    asks.push(`ask labels: confirm with ${tracker.adapter.run.labelRead} that the team has the label ${JSON.stringify(base.config?.projectRun?.decisionLabel)}${typeof status === 'string' ? `, and with ${tracker.adapter.run.statusRead} the status ${JSON.stringify(status)}` : ''}; a missing one is a blocker${setupPointer('labels')}`);
  }
  lines.push(...asks);
  if (typeof cap?.limitContinue !== 'function') lines.push('ask usage-limit: confirm this host carries on by itself after a usage limit, since a limit stops the driver too');
  const blocked = lines.some((line) => line.startsWith('blocker '));
  return { exitCode: blocked ? 1 : 0, out: lines, err: blocked ? ['aidrian project preflight: fix each blocker line, then run it again'] : [] };
}

// The access check, the start gate's own (project-start.mjs accessProblem): `ok access` or its blocker, then, on a host
// that hands its sessions the forge token, a `note token:` line naming the source the token came from, and one for each
// note on it, such as a token that reaches more than this repository. Never the token itself.
function accessLines({ cap, facade, repository, env, home, main, state, platform, allowed, localBinding, keychain, exec }) {
  let access;
  try {
    access = accessProblem({ cap, forge: facade, repository, env, home, guarded: guardedFolders({ main, state, env, home }), main, platform, allowed, localBinding, keychain, ...(exec ? { exec } : {}) });
  } catch (error) {
    access = { halt: `the access check failed (${String(error?.message ?? error).split('\n')[0]})` };
  }
  const problem = access?.halt ?? access?.refuse ?? null;
  // A halt that carries the token's record is the token's own: no source gave one, it may not push, or it is not the
  // forge CLI's own user's.
  const lines = [problem ? blockerLine('access', problem, access?.token ? 'token' : 'access') : 'ok access'];
  if (access?.token?.source) lines.push(`note token: ${access.token.source} gives the issue sessions their forge token`);
  for (const note of access?.token?.notes ?? []) lines.push(`note token: ${note}`);
  return lines;
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
  lines.push(problem ? blockerLine('tracker', problem) : 'ok tracker');
  // An issue's session reads its issue from a file the driver wrote, so a run needs no tracker server in it.
  if (adapter && !entries.some(([name, definition]) => mapped(name, definition) === adapter)) lines.push(`note tracker: projectRun.mcpServers holds no ${adapter.name} server, so issue sessions will not write the tracker; the driver reports`);
  // Every tracker connection there must reach an adapter's endpoint, or be named in tracker.servers: on any other the
  // rule holds issue sessions and the driver to calls that read, unless projectRun.nonTrackerServers names it.
  const declared = base.config?.projectRun?.nonTrackerServers ?? [];
  const others = entries.filter(([name, definition]) => !mapped(name, definition) && !(tracker.servers ?? []).includes(name) && !declared.includes(name)).map(([name]) => name);
  if (others.length) lines.push(`note mcp-servers: the run rule maps ${others.map((name) => JSON.stringify(name)).join(', ')} to no tracker, so issue sessions and the driver may call only tools there whose name says they read; name a server that reaches no tracker in projectRun.nonTrackerServers, and point a tracker connection at its adapter's endpoint or name it in tracker.servers`);
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

// Whether a comment by the review bot's login shows a review it finished: its usage-limit notice does not, and nor does
// its status card, which the bot posts when a review starts, until the card says the code review completed: in its
// machine state, or, on an older card with no state marker, in its visible Code Review table row. A state that does not
// parse shows nothing. Only a comment that opens with the card's marker is the card, so a review that quotes it counts.
const STATE_MARKER = /<!--\s*codex-review-state:v1\b/u;
export const showsReview = (body) => {
  if (isQuotaNotice(body)) return false;
  if (typeof body === 'string' && body.trimStart().startsWith(REVIEW_SUMMARY_CARD_MARKER)) {
    if (STATE_MARKER.test(body)) return cardState(body)?.code_review?.status === 'completed';
    return /^\|\s*📝\s*\*\*Code Review\*\*\s*\|\s*✅\s*\*\*Completed\*\*/mu.test(body);
  }
  return true;
};

// The reviewer bot seen on a recent pull request, and CI workflows, through the forge's own reads, or `ask` lines for a
// forge with none. With no pull request yet, the first one proves the bot, and the merge's trust check holds it until then.

function forgeLines({ facade, repository, reviewer, lines, check, asks }) {
  const bot = NO_REVIEWER.has(reviewer) ? null : reviewer;
  const named = repository ? `${repository.owner}/${repository.name}` : null;
  if (typeof facade.reviewerSeen === 'function' && named && bot) {
    try {
      const { changes, seen } = facade.reviewerSeen(named, bot, { host: repository.host, counts: showsReview });
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

// What guards the default branch and the release tags from the token an issue's session keeps, through the forge's own
// read (refProtection), or `ask` lines for a forge with none: a blocker when no rule that asks for a pull request on the
// default branch binds the signed-in user, who may be an administrator a rule lets past, an `ask` when the forge shows
// such a rule only to an administrator, and a blocker when no active tag rule that user may never bypass names every
// tag and restricts creating and updating one; a forge whose plan offers no such rule names the plan in both blockers.
// When the team sets projectRun.forgeProtectionAccepted (as teamPolicy reads it, on the forge and the local ref both),
// each of those blockers and asks is a `note` naming the risk the team took instead. Then the workflow secrets
// (secretsLine), and notes on what the forge runs.
function protectionLines({ facade, repository, policy, lines, check, asks }) {
  const named = repository ? `${repository.owner}/${repository.name}` : null;
  const accepted = policy.forgeProtectionAccepted === true;
  const guard = (name, problem) => {
    if (problem && accepted) lines.push(`note ${name}: ${ACCEPTED_PROTECTION}`);
    else check(name, problem);
  };
  if (typeof facade.refProtection === 'function' && named) {
    let read = null;
    try {
      read = facade.refProtection(named, { host: repository.host });
    } catch (error) {
      const why = `the forge cannot say what guards the default branch and the tags (${String(error.message).split('\n')[0]}); check them on the forge and add the rules the run needs, or the default branch sets projectRun.forgeProtectionAccepted`;
      guard('branch-protection', why);
      guard('release-tags', why);
    }
    if (read?.plan === true) {
      const plan = `the forge offers no rule for this repository, since ${read.why}, so nothing holds the signed-in user, whose token an issue's session keeps, from pushing to the default branch ${read.branch} or a tag, and a script it runs could; move to a plan that offers them, or make the repository public, then add the rules, or the default branch sets projectRun.forgeProtectionAccepted to run with only the hooks holding it`;
      guard('branch-protection', plan);
      guard('release-tags', plan);
    } else if (read) {
      if (read.protected === null && accepted) guard('branch-protection', read.why);
      else if (read.protected === null) asks.push(`ask branch-protection: confirm on the forge that the default branch ${read.branch} asks for a pull request of the signed-in user too, since ${read.why}; a missing one is a blocker, unless the default branch sets projectRun.forgeProtectionAccepted`);
      else guard('branch-protection', read.protected ? null : `no rule on the forge holds the signed-in user, whose token an issue's session keeps, to a pull request on the default branch ${read.branch} (${read.why}), so a script it runs could push to it; protect it with a rule that asks for a pull request, includes administrators, and lets that user bypass nothing, before the run, or the default branch sets projectRun.forgeProtectionAccepted`);
      const held = read.tags.filter((rule) => rule.all && rule.creation && rule.update && rule.bypass === 'never');
      guard('release-tags', held.length ? null : 'no active tag rule on the forge names every tag and stops the signed-in user, whose token an issue\'s session keeps, creating or moving one, so a script it runs could push a release tag; add a tag ruleset over all tags (~ALL or refs/tags/**/*, excluding none; refs/tags/* stops at a slash) that restricts creations and updates, with no bypass for that user, before the run, or the default branch sets projectRun.forgeProtectionAccepted');
    }
  } else if (accepted) lines.push(`note protection: ${ACCEPTED_PROTECTION}`);
  else asks.push('ask protection: confirm on the forge that the default branch asks for a pull request of the signed-in user, admin or not, and that a tag rule the signed-in user cannot bypass stops a tag being created or moved; a missing one is a blocker, unless the default branch sets projectRun.forgeProtectionAccepted');
  secretsLine({ facade, named, repository, policy, check, asks });
  lines.push(`note workflows: the forge runs a branch's own workflow files, and the code they call, with the repository's secrets on every push, and an issue's session pushes its branch: keep release and deploy secrets in environments held for a reviewer who prevents self-review or is not the signed-in user; an environment limited to protected branches or branch patterns counts as open, since a deployment branch rule is no hold against code the run pushes; ${SECRETS_ACCEPTED}; a token without the workflow scope keeps the session from changing a workflow file, not from changing the tests and scripts a workflow runs; a cloud role trusted through OIDC federation for any ref of the repository (a subject such as repo:<owner>/<name>:*) can be assumed from any branch, so limit its trust to a protected branch, or to an environment held as above; the hook refuses an issue session's writes to the workflow files and a push whose commits change them, and a script it runs is the residual`);
  lines.push('note triggers: other services that act on a push or a pull request comment, such as preview deploys and ChatOps bots, run for an issue\'s branch too, with their own secrets; keep them to protected branches or reviewed pull requests');
}

// How a team accepts the workflow secrets risk, in every line that names the key: it skips the secrets read whole, so it
// accepts the secrets of the repository, its organization, and every environment, today's and any added later.
const SECRETS_ACCEPTED = 'projectRun.workflowSecretsAccepted on the default branch skips the workflow secrets read whole: it accepts all current and future workflow secret exposure for project runs, the repository\'s, its organization\'s, and every environment\'s secrets, so a team sets it only when that is acceptable';

// The workflow secrets check: a blocker when the repository's workflows see CI secrets, unless the default branch sets
// projectRun.workflowSecretsAccepted (as teamPolicy reads it, on the forge and the local ref both); an `ask` for a forge
// with no such read. Whatever the token's scopes: the forge runs the existing push and pull request workflows on an
// issue's branch, and they run the branch's own code, its tests, scripts, and build, with their secrets. A token that
// may push a change to a workflow file widens that, and one that may not narrows it, which the blocker says.
function secretsLine({ facade, named, repository, policy, check, asks }) {
  if (policy.workflowSecretsAccepted === true) {
    check('workflow-secrets', null);
    return;
  }
  if (typeof facade.workflowSecrets !== 'function' || !named) {
    asks.push(`ask workflow-secrets: confirm the repository's workflows see no CI secret on a branch an issue's session pushes, since they run that branch's own code; else ${SECRETS_ACCEPTED}`);
    return;
  }
  let read;
  try {
    read = facade.workflowSecrets(named, { host: repository.host });
  } catch (error) {
    check('workflow-secrets', `the forge cannot say which CI secrets the repository's workflows see (${String(error.message).split('\n')[0]}); ${SECRETS_ACCEPTED}`);
    return;
  }
  let token = 'and the signed-in token names no scopes, so it may push a change to a workflow file too';
  if (read.workflowPush === true) token = 'and the signed-in token\'s scopes include workflow, so it may push a change to a workflow file too';
  if (read.workflowPush === false) token = 'though the signed-in token cannot push a change to a workflow file, which narrows it only';
  check('workflow-secrets', read.secrets > 0 ? `the repository's workflows see ${read.secrets} CI secrets, and the forge runs its push and pull request workflows on an issue's branch with the branch's own code, its tests, scripts, and build, which the session writes, so a change to them could read the secrets, ${token}; move the secrets to environments held for a reviewer who is not the signed-in user, when the signed-in user is not an admin of the repository (an admin's token can edit the rule), since a deployment branch rule is no hold against code the run pushes; ${SECRETS_ACCEPTED}` : null);
}

// `aidrian project init RUN --file PATH --check`: the input's checks, as init makes them, and the order, with no run
// written: a `blocker snapshot` line for each problem, for each issue blocked by a cycle or by a status the run does not
// start from, and, when the base branch's projectRun.mcpServers holds no tracker server an issue's session could read
// the tracker through, a `blocker texts` line for each issue to start whose text no tracker read of `session` recorded
// (project-issue-text.mjs recordedTexts); then `next` lines as `aidrian project next` prints them for turn 1, with the
// maxParallel it reads (project-run-gate.mjs runParallel, through `forge` at the repository init would pin), and a
// `note teams` line when the snapshot names no team of the workspace (project-run.mjs teamsNote). Exit 1 on any blocker.
export function snapshotCheck({ project, config, file, session = null, env = process.env, home, forge = null }) {
  const read = readSnapshotInput(file, refNames(project, config));
  if (!read.snapshot) return { exitCode: 1, out: read.problems.slice(0, 50).map((problem) => `blocker snapshot: ${problem}`), err: ['aidrian project init --check: fix the snapshot input, then check it again'] };
  const kept = { texts: recordedTexts(session, read.snapshot.issues.map((issue) => issue.key), { env, ...(home ? { home } : {}) }) };
  const plan = planRun(read.snapshot, new Map(), { maxParallel: runParallel(project, pinnedRepository(project), forge ?? forgeFor(project.root)) });
  const blockers = plan.blocked.filter(({ reason }) => reason === 'cycle' || reason === 'status')
    .map(({ key, reason, on }) => `blocker snapshot: ${key} is ${reason === 'cycle' ? `in a cycle of blockers, ${on.join(', ')}, so it never starts` : `${on[0]} in the tracker, which a run does not start from`}`);
  if (!trackerReachable(baseBranchTip(project.root) ? baseBranchConfig(project, 'projectRun') : {})) {
    const startable = new Set(plan.order);
    blockers.push(...read.snapshot.issues.filter((issue) => startable.has(issue.key) && !plan.done.includes(issue.key) && !kept.texts[issue.key])
      .map((issue) => `blocker texts: ${issue.key} has no text, and projectRun.mcpServers holds no tracker server its session could read it through; read it in this session with the tracker's own issue read, whose answer the run records`));
  }
  const teams = teamsNote(read.snapshot);
  const out = [`ok snapshot ${read.snapshot.issues.length} issues, ${Object.keys(kept.texts).length} with text`, ...blockers, ...nextLines(plan), ...(teams ? [`note teams: ${teams}`] : [])];
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
