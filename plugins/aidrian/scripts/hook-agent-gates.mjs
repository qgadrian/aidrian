// PreToolUse hook for every tool: the project's per-agent tool gates, `agents` in config.json and the local file.
// lib/agent-gates.mjs decides, then lib/config-guard.mjs keeps a subagent from changing the files that set the gates,
// and, with or without gates, from setting the machine's switches, as it keeps a session the background handoff route
// started (lib/handoff-guard.mjs startedUnattended); lib/handoff-guard.mjs, with or without
// gates, from running `aidrian handoff continue` or writing in the handoff continuation store, and keeps a subagent
// and such a session from writing there, in the unattended marks, in the sign-off store, or in the session folders, from
// starting a host session outside the gate, from running the gate with a variable of their own that moves its store or
// session, and from repointing a git remote or gh's default repository, through which the plugin reads the team's policy
// on the forge, and from writing in the folder of the project runs. Every session's `aidrian project` command is
// authorized against its run's ledger by the host's own session id (lib/project-run-guard.mjs projectCommandDenial).
// Whether the session is such a
// one is read from its unattended mark (lib/unattended-mark.mjs) on every call, before it runs, wherever it runs, with
// no project at its folder too: the mark names the project the gate started it in, whose guards then hold the call.
// Its chain floor, which a session the gate started before the marks still has, is read at most once a call, and only
// when a guard would refuse the call to it.
// It runs before every tool call, so without gates it stops as soon as it has read the config and run the guards that hold
// without gates; a call a gate blocks exits 2 with the rule's name on stderr, and the block is recorded as the Bash hook
// records its blocks (lib/hook-deny.mjs). The gates are asked before any guard, so a call they deny never waits on one.
// The guards then run under a time budget (lib/deadline.mjs), GUARD_BUDGET_MS from the hook's start, well inside the
// host's 5 second hook timeout, past which the host runs the call with no guard: a call of a subagent, of a session no
// Human attends, or of a session a project run's driver mark holds, that they cannot finish reading in time is refused
// (config-guard.mjs deadlineDenial), and an attended main session's runs, as the guards allow it anyway; a call that is
// no shell and writes no file, which no guard refuses, runs for all (writesNothing). The same three are refused a
// command longer than the guards read. The driver's run's state folder is guarded by its mark (runStateDenial).
// A session the gate is starting, whose id the host has not listed yet, is held by the gate's pending mark
// (lib/unattended-mark.mjs): every session with no mark of its own, wherever its call runs, but the one that ran the gate
// and those the host listed before the start. Such a session's call files its beacon, which a start adapter that cannot
// otherwise tell whether the host runs the plugin's hooks waits on (lib/hosts/codex-exec.mjs).
// A subagent's call also meets the gates its session started with (lib/gate-snapshot.mjs), so a config.json deleted,
// replaced, or moved away during the session lifts none of them; without a snapshot, as when the hooks were installed
// during the session, only the current config counts, unless the session started with gates and the snapshot is gone:
// that keeps a subagent to reading, as an unreadable snapshot does. The main session always reads the current config.
// A file that sets the configuration but is there and cannot be read leaves the gates unknown, so a subagent may then
// only read (agent-gates.mjs unreadableConfigDenial); the main session keeps every tool, to fix it. So does a snapshot
// that is there and cannot be read, and an `agents` entry whose allow or deny is no list.
// A session whose start proves its sandbox from inside it (capabilities.projectStart.confineProof) runs only the exact
// `aidrian project confine <run> <issue>` until the start confirms the proof in its unattended mark, and nothing once the
// proof failed; the hook also fails the proof when its own environment, the host process's, holds the session's cache
// variables, and its file tools never read a store the proof's plan lists as hidden (lib/confine-guard.mjs
// confineDenial). A session an unattended mark holds never runs a call that asks the host for its sandbox escape
// (`sandbox_escape`, which the host's adapter maps its own parameter to).
// In a project run's attempt clone, a key of the clone's own git config that makes git run a program, a `.git` that does
// not point at the attempt's own git folder, or a `commondir` or `config.worktree` there other than the start gate's
// placeholder refuses every call, first, before any git call of this hook runs there (lib/attempt-clone.mjs
// cloneConfigProblem).
// Anything else this hook cannot read lets the call run, except a subagent's call in a session that started with gates:
// an error there keeps the subagent to reading, as an unreadable snapshot does.

import path from 'node:path';

import { gateDenial, projectRuleReason, readOnlyDenial, unreadableConfigDenial } from '../lib/agent-gates.mjs';
import { anchorClones, cloneConfigProblem } from '../lib/attempt-clone.mjs';
import { DEFAULTS, loadConfig, malformedGates } from '../lib/config.mjs';
import { isFile } from '../lib/fs.mjs';
import { configWriteDenial, deadlineDenial, machineSwitchWriteDenial, opaqueLimitDenial, writeLimitDenial, writesNothing } from '../lib/config-guard.mjs';
import { PastDeadline, withinDeadline } from '../lib/deadline.mjs';
import { readGateSnapshot } from '../lib/gate-snapshot.mjs';
import { baseReader, continueStoreWriteDenial, handoffContinueDenial, handoffEnvDenial, hostSessionStartDenial, mainCheckoutWriteDenial, prEnvDenial, projectRunWriteDenial, remoteChangeDenial, sessionFoldersWriteDenial, startedUnattended, stateFolders, stateFoldersWriteDenial } from '../lib/handoff-guard.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { findProject, openProject } from '../lib/project.mjs';
import { confineDenial, sandboxEscapeDenial } from '../lib/confine-guard.mjs';
import { drivesRun, ownAttemptFolder, projectCommandDenial, projectRunActive } from '../lib/project-run-guard.mjs';
import { canonical } from '../lib/rules/main-checkout.mjs';
import { issueHeld, noteBeacon, readDriverMark, readUnattendedMark } from '../lib/unattended-mark.mjs';
import { unattendedPlaces, unattendedWriteDenial } from '../lib/unattended-write.mjs';

// The milliseconds from the hook's start the guards may take. AIDRIAN_GUARD_BUDGET_MS may only lower it, as a test does.
const GUARD_BUDGET_MS = 2500;
const lowered = process.env.AIDRIAN_GUARD_BUDGET_MS ? Number(process.env.AIDRIAN_GUARD_BUDGET_MS) : Number.NaN;
const budget = Number.isFinite(lowered) && lowered >= 0 ? Math.min(lowered, GUARD_BUDGET_MS) : GUARD_BUDGET_MS;

await runHook(async (input) => {
  try {
    await gate(input);
  } catch (error) {
    if (readGateSnapshot(input) === null) return;
    const why = `the agent gate hook failed (${error?.message ?? error}), so the gates this session started with are unknown for this call, and a subagent may only read files`;
    const denial = readOnlyDenial(input, 'the agent gate hook failed', why, DEFAULTS, 'that the agent gate hook failed on this call');
    if (denial) await block(input, 'agent-gates', denial.reason, { match: denial.match });
  }
});

async function gate(input) {
  // Every attempt clone this call reads is linked only for the session the payload names (lib/attempt-clone.mjs).
  anchorClones({ session: input.session_id });
  // In a project run's attempt clone, before any git call there: a key of the clone's own git config that makes git run
  // a program, or a git folder file that is not the gate's placeholder, refuses every call, so neither the session's git
  // nor a hook's reads it (lib/attempt-clone.mjs).
  const planted = cloneConfigProblem(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (planted) await block(input, 'config-guard', projectRuleReason(input, planted, DEFAULTS.names.human, 'that the attempt clone\'s git config must be checked'), { match: 'attempt clone git config' });
  const snapshot = typeof input.agent_id === 'string' && input.agent_id !== '' ? readGateSnapshot(input) : null;
  // Read before any guard, wherever the call runs: a session the background route started stays held outside its project.
  const mark = readUnattendedMark(input.session_id);
  // A session a gate's pending mark holds, or one that works an issue of a project run, files its beacon on its first
  // call: the proof a host's start adapter waits on that the host runs this plugin's hooks for it
  // (lib/unattended-mark.mjs noteBeacon). It never throws.
  if (mark?.pending || mark?.issue) noteBeacon(input.session_id);
  // A session no Human attends never asks the host to run a command outside its sandbox.
  const escape = sandboxEscapeDenial(input, { mark });
  if (escape) await block(input, 'config-guard', escape.reason, { match: escape.match });
  // A confined session whose start proves its sandbox from inside it runs only `aidrian project confine` until the
  // start confirmed that proof in its mark, and nothing once it failed, and its file tools never read a store its
  // sandbox hides (lib/confine-guard.mjs), wherever its call runs.
  const unproven = confineDenial(input, { mark, env: process.env });
  if (unproven) await block(input, 'config-guard', unproven.reason, { match: unproven.match });
  const marked = mark?.root ? findProject(mark.root) : null;
  // With its config.json gone, the folder is no project any more; the snapshot still names the one the session started
  // in, and the mark the one the gate ran in.
  // A project run's driver is held to its run's project wherever its call runs, as a marked session is (runDriver).
  const driven = readDriverMark(input.session_id);
  // The driver's holds, asked once a call, here, so every guard and the time budget's answer share them: `drives()`, its
  // run under way, holds it from the continuation store and the runs folder, and `drove()`, any driver mark, from the
  // marks and the sign-off store after its run's end too (run-driver.mjs drivesRun, droveRun), and from a call the
  // guards cannot read whole or in time, which may reach any of them. The project its mark names, opened when asked.
  let drivesNow;
  const drives = () => (drivesNow ??= drivesRun(input.session_id));
  const drove = () => driven !== null;
  // Whether the session works an issue of a project run, which a refusal for the guards' limits names as its reason.
  const issue = () => issueHeld(mark);
  let runProject;
  const drivenProject = () => (runProject === undefined ? (runProject = driven?.root ? findProject(driven.root) : null) : runProject);
  const found = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  // The project the snapshot names, opened only when a guard asks for it, and never when it is the call's own: opening it
  // runs git, and a call that writes nowhere near the state root runs none of its own.
  let opened;
  const origin = () => {
    if (!snapshot?.root || found?.checkouts.some((each) => canonical(each) === canonical(snapshot.root))) return null;
    opened ??= openProject(snapshot.root);
    return opened;
  };
  const project = found ?? origin() ?? marked ?? drivenProject();
  if (snapshot?.problem) {
    const settings = project ? loadConfig(project).config : DEFAULTS;
    const denial = unreadableConfigDenial(input, snapshot.file, snapshot.problem, settings, 'to start a new session, which takes the gates from the config again');
    if (denial) await block(input, 'agent-gates', denial.reason, { match: 'the gate snapshot cannot be read', project: project ?? undefined, config: settings });
  }
  if (!project) {
    // The gate command runs outside a project too, with the defaults. A run's driver is held there too, by its mark.
    const unattended = () => mark !== null;
    // A session that drove a run keeps the sign-off hold and the marks' hold after the run's end (run-driver.mjs
    // droveRun): its driver mark is what holds it, so it may not remove or rewrite that mark either.
    const droveHeld = () => unattended() || drove();
    let outside;
    try {
      // A command longer than the guards read may hide one of those stores in the words they skip.
      outside = withinDeadline(budget, () => opaqueLimitDenial(input, DEFAULTS, { unattended, drove, issue })
        ?? handoffContinueDenial(input, DEFAULTS) ?? handoffEnvDenial(input, DEFAULTS, { unattended }) ?? prEnvDenial(input, DEFAULTS, { unattended })
        ?? hostSessionStartDenial(input, DEFAULTS, { unattended }) ?? remoteChangeDenial(input, DEFAULTS, { unattended })
        ?? projectCommandDenial(input, DEFAULTS, { unattended })
        ?? stateFoldersWriteDenial(input, DEFAULTS, { unattended, marksHeld: droveHeld, signoffsHeld: droveHeld })
        ?? sessionFoldersWriteDenial(input, null, DEFAULTS, null, { unattended })
        // A driver whose run's main checkout no longer resolves to a project, as when its config was removed.
        ?? runStateDenial(input, driven, DEFAULTS, { unattended, drives })
        // A session its own mark holds, with no project it can read, cannot tell its own places, so it writes nothing; a
        // pending or unreadable hold keeps only the entries refused wherever they lie (lib/unattended-write.mjs).
        ?? unattendedWriteDenial(input, DEFAULTS, { mark, places: () => unattendedPlaces({ cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), mark, project: null }) }));
    } catch (error) {
      if (!(error instanceof PastDeadline)) throw error;
      outside = deadlineDenial(input, DEFAULTS, { unattended, drove, issue });
    }
    if (outside) await block(input, 'config-guard', outside.reason, { match: outside.match });
    return;
  }
  const { config, errors, gateErrors, current } = loadConfig(project);
  // An `agents` error that lifts a gate: read it as a file that cannot be read.
  const broken = unreadable(project, current, errors) ?? (current ? malformedGates(gateErrors) : null);
  const failed = broken && unreadableConfigDenial(input, broken.file, broken.problem, config);
  if (failed) await block(input, 'agent-gates', failed.reason, { match: failed.match, project, config });
  // The gates come before the guards, which resolve the paths and globs a command gives: however long those take, a call
  // a gate denies is denied first.
  const started = (snapshot?.gates ?? []).filter((agents) => Object.keys(agents).length > 0);
  const gated = Object.keys(config.agents).length > 0 || started.length > 0;
  const gate = gated
    ? gateDenial(input, config, project.paths) ?? started.map((agents) => gateDenial(input, { ...config, agents }, project.paths, { started: true })).find(Boolean)
    : null;
  if (gate) await block(input, 'agent-gates', gate.reason, { match: gate.match, project, config });
  // Read once, before the call runs, so a call that deletes the session's floor is judged while the floor is there.
  let alone;
  // The base branch's config, read at most once a call, within the guards' budget, for every guard and pass below.
  const base = baseReader(project);
  const unattended = () => mark !== null || (alone ??= startedUnattended(project, config, input.session_id, { base }));
  let denial;
  try {
    // The attempt folder of the issue a confined session works, whose work, git, and drop folders it may write
    // (handoff-guard.mjs projectRunWriteDenial): the running start row's, read only when a write reaches the runs folder.
    const own = mark?.project && mark?.issue ? () => ownAttemptFolder(marked ?? project, loadConfig(marked ?? project).config, mark, marked ? {} : { base }) : null;
    // The places a session no Human attends may write, read once, only for a marked session's write
    // (lib/unattended-write.mjs unattendedPlaces): in the project its mark names.
    let places;
    const held = marked ?? project;
    const placesOf = () => (places ??= unattendedPlaces({
      cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), mark, project: held,
      config: held === project ? config : loadConfig(held).config, base: held === project ? base : baseReader(held), own,
    }));
    // The driver's run project is one of `others`, so a call from another project's folder still meets its run's stores.
    denial = withinDeadline(budget, () => guards(input, project, config, gated, snapshot, [() => marked, origin, drivenProject], { unattended, drives, drove, issue }, base, own)
      // The run's state folder, by the driver mark itself, from any project: its own may no longer resolve.
      ?? runStateDenial(input, driven, config, { unattended, drives, own, checkouts: () => drivenProject()?.checkouts ?? [] })
      ?? unattendedWriteDenial(input, config, { mark, places: placesOf }));
  } catch (error) {
    if (!(error instanceof PastDeadline)) throw error;
    // A run's driver past the budget is held as the guards it could not finish would hold it.
    denial = deadlineDenial(input, config, { unattended, drove, issue });
  }
  if (denial) await block(input, 'config-guard', denial.reason, { match: denial.match, project, config });
}

// The first guard's denial of the call, or null. The store guard runs first without its link walk, which reads folders
// on disk, and with it last, so a call the other guards refuse by the paths and names it gives is refused before any walk.
// `others` give, each when first asked, the project the session's unattended mark names, the one its gate snapshot
// names, and the one its driver mark names, each or null: each that is another project than the call's has its store,
// its session folders, its project runs, its main checkout's host files, and its machine's switches guarded too, so a
// subagent that moved to another project, and a run's driver whose call runs there, still meet the folders of the
// session's own. `holds` are the session's: `unattended()` says whether no Human attends it, `issue()` whether it works
// an issue of a project run, `drives()` whether it drives a project run under way, and `drove()` whether it has driven
// one; `base` is the call's one read of the base branch's config (handoff-guard.mjs baseReader).
function guards(input, project, config, gated, snapshot, others, holds, base, own) {
  const { unattended, drives, drove } = holds;
  let dirs;
  // Every state folder the session's stores may be in: the working copy's, the main checkout's, and the base branch's.
  const state = () => (dirs ??= stateFolders(project, config, { base }));
  const guarded = snapshot?.gates ? [snapshot.file, snapshot.marker] : [];
  // Whether this project has a project run under way, read only for a subagent's write that reaches the main
  // checkout's host paths.
  let active;
  const runSession = () => (active ??= projectRunActive(project, config, { base }));
  // A project run's driver is held as one no Human attends for the continuation store, the runs folder, the marks, and
  // the sign-off store: it may run for hours with no Human at hand, from its first call, before any unattended mark of its
  // own. Its driver mark names it (project-run-guard.mjs runDriver).
  // A session that drove a run keeps the sign-off hold and the marks' hold after the run's end (run-driver.mjs
  // droveRun): its driver mark is what holds it, so it may not remove or rewrite that mark either.
  const droveHeld = () => unattended() || drove();
  return opaqueLimitDenial(input, config, { unattended, drove, issue: holds.issue })
    ?? writeLimitDenial(input, config, { unattended, drove, issue: holds.issue })
    ?? handoffContinueDenial(input, config)
    ?? handoffEnvDenial(input, config, { unattended })
    ?? prEnvDenial(input, config, { unattended })
    ?? hostSessionStartDenial(input, config, { unattended })
    ?? remoteChangeDenial(input, config, { unattended })
    ?? projectCommandDenial(input, config, { unattended })
    ?? continueStoreWriteDenial(input, project, config, state, { links: false, unattended, drives, base })
    ?? sessionFoldersWriteDenial(input, project, config, state, { links: false, unattended })
    ?? stateFoldersWriteDenial(input, config, { project, links: false, unattended, marksHeld: droveHeld, signoffsHeld: droveHeld })
    ?? projectRunWriteDenial(input, project, config, state, { links: false, unattended, drives, base, own })
    ?? mainCheckoutWriteDenial(input, project, config, { links: false, unattended, runSession })
    ?? machineSwitchWriteDenial(input, project, config, { unattended })
    ?? (gated ? configWriteDenial(input, project, config, { also: guarded }) : null)
    ?? continueStoreWriteDenial(input, project, config, state, { unattended, drives, base })
    ?? sessionFoldersWriteDenial(input, project, config, state, { unattended })
    ?? stateFoldersWriteDenial(input, config, { project, unattended, marksHeld: droveHeld, signoffsHeld: droveHeld })
    ?? projectRunWriteDenial(input, project, config, state, { unattended, drives, base, own })
    ?? mainCheckoutWriteDenial(input, project, config, { unattended, runSession })
    ?? otherProjects(input, project, others, holds, own);
}

// The first denial of the guards of each of `others` that is another project folder than the call's, each asked once:
// by its own folder, so a linked checkout whose config moves `state.dir` elsewhere than the main checkout's is its own.
function otherProjects(input, project, others, holds, own) {
  if (writesNothing(input)) return null;
  const seen = new Set([canonical(project.root)]);
  for (const ask of others) {
    const other = ask();
    const key = other ? canonical(other.root) : null;
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    const denial = otherProject(input, other, holds, own);
    if (denial) return denial;
  }
  return null;
}

// The denial of the guards of `marked`, a project the session started in, the gate ran in, or whose run it drives, as
// when the session works in another repository: its machine's switches, its continuation store, its session folders,
// its project runs, and its main checkout's host files. A run's driver is held from the store and the runs folder there
// as in its own folder (`holds.drives`).
function otherProject(input, marked, { unattended, drives }, own) {
  const { config } = loadConfig(marked);
  let dirs;
  const base = baseReader(marked);
  const state = () => (dirs ??= stateFolders(marked, config, { base }));
  const runSession = () => projectRunActive(marked, config, { base });
  return machineSwitchWriteDenial(input, marked, config, { unattended }) ?? continueStoreWriteDenial(input, marked, config, state, { unattended, drives, base })
    ?? sessionFoldersWriteDenial(input, marked, config, state, { unattended })
    ?? projectRunWriteDenial(input, marked, config, state, { unattended, drives, base, own }) ?? mainCheckoutWriteDenial(input, marked, config, { unattended, runSession });
}

// The denial of the continuation store and the runs folder in the state folder that `driven`, the session's driver
// mark, names, or null: the folder whose ledger alone says whether the run is under way (run-driver.mjs runDriver),
// guarded by the mark itself, so a run whose main checkout no longer resolves to a project, as when its config was
// removed or moved state.dir away, still holds its driver there while `drives()`, from any folder. `config.state.dir`
// is set to that folder, so the guards ask it whatever the call's targets, and no base branch is read for it.
// `checkouts()` are the run's main checkout's, when it resolves, read only when a guard asks, for its reading of a
// target that holds a checkout.
function runStateDenial(input, driven, config, { unattended, drives, own = null, checkouts = () => [] }) {
  if (!driven?.state) return null;
  const settings = { ...config, state: { ...config.state, dir: driven.state } };
  const state = () => [driven.state];
  const base = () => ({ config: null, failed: false });
  const project = { root: driven.root, get checkouts() { return checkouts(); } };
  return continueStoreWriteDenial(input, project, settings, state, { unattended, drives, base })
    ?? projectRunWriteDenial(input, project, settings, state, { unattended, drives, base, own });
}

// The first file that sets the configuration and is there but could not be read, as { file, problem }, or null.
// `problem` is the error loadConfig or the project lookup gave for it, without the file name it starts with.
function unreadable(project, current, errors) {
  let file = project.paths.config;
  let problem = errors.at(-1);
  if (current || !isFile(path.join(project.root, file))) {
    [file] = project.unreadable;
    problem = file && project.errors.findLast((each) => each.startsWith(`${path.basename(file)}: `));
  }
  return file ? { file, problem: problem?.slice(problem.indexOf(': ') + 2) ?? 'unreadable' } : null;
}
