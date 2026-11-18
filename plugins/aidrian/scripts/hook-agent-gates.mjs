// PreToolUse hook for every tool: the project's per-agent tool gates, `agents` in config.json and the local file.
// lib/agent-gates.mjs decides, then lib/config-guard.mjs keeps a subagent from changing the files that set the gates,
// and, with or without gates, from setting the machine's switches, as it keeps a session the background handoff route
// started (lib/handoff-guard.mjs startedUnattended); lib/handoff-guard.mjs, with or without
// gates, from running `aidrian handoff continue` or writing in the handoff continuation store, and keeps a subagent
// and such a session from writing there, in the unattended marks, or in the session folders, from starting a host session outside the gate, and
// from running the gate with a variable of their own that moves its store or session. Whether the session is such a
// one is read from its unattended mark (lib/unattended-mark.mjs) on every call, before it runs, wherever it runs, with
// no project at its folder too: the mark names the project the gate started it in, whose guards then hold the call.
// Its chain floor, which a session the gate started before the marks still has, is read at most once a call, and only
// when a guard would refuse the call to it.
// It runs before every tool call, so without gates it stops as soon as it has read the config and run the guards that hold
// without gates; a call a gate blocks exits 2 with the rule's name on stderr, and the block is recorded as the Bash hook
// records its blocks (lib/hook-deny.mjs). The gates are asked before any guard, so a call they deny never waits on one.
// The guards then run under a time budget (lib/deadline.mjs), GUARD_BUDGET_MS from the hook's start, well inside the
// host's 5 second hook timeout, past which the host runs the call with no guard: a call of a subagent, or of a session no
// Human attends, that they cannot finish reading in time is refused (config-guard.mjs deadlineDenial), and an attended
// main session's runs, as the guards allow it anyway. The same two are refused a command longer than the guards read.
// A session the gate is starting, whose id the host has not listed yet, is held by the gate's pending mark
// (lib/unattended-mark.mjs): every session with no mark of its own, wherever its call runs, but the one that ran the gate
// and those the host listed before the start.
// A subagent's call also meets the gates its session started with (lib/gate-snapshot.mjs), so a config.json deleted,
// replaced, or moved away during the session lifts none of them; without a snapshot, as when the hooks were installed
// during the session, only the current config counts, unless the session started with gates and the snapshot is gone:
// that keeps a subagent to reading, as an unreadable snapshot does. The main session always reads the current config.
// A file that sets the configuration but is there and cannot be read leaves the gates unknown, so a subagent may then
// only read (agent-gates.mjs unreadableConfigDenial); the main session keeps every tool, to fix it. So does a snapshot
// that is there and cannot be read, and an `agents` entry whose allow or deny is no list.
// Anything else this hook cannot read lets the call run, except a subagent's call in a session that started with gates:
// an error there keeps the subagent to reading, as an unreadable snapshot does.

import path from 'node:path';

import { gateDenial, readOnlyDenial, unreadableConfigDenial } from '../lib/agent-gates.mjs';
import { DEFAULTS, loadConfig, malformedGates } from '../lib/config.mjs';
import { isFile } from '../lib/fs.mjs';
import { configWriteDenial, deadlineDenial, machineSwitchWriteDenial, opaqueLimitDenial, writeLimitDenial } from '../lib/config-guard.mjs';
import { PastDeadline, withinDeadline } from '../lib/deadline.mjs';
import { readGateSnapshot } from '../lib/gate-snapshot.mjs';
import { continueStoreWriteDenial, handoffContinueDenial, handoffEnvDenial, hostSessionStartDenial, sessionFoldersWriteDenial, startedUnattended, stateFoldersWriteDenial } from '../lib/handoff-guard.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { findProject, openProject, stateDir } from '../lib/project.mjs';
import { canonical } from '../lib/rules/main-checkout.mjs';
import { readUnattendedMark } from '../lib/unattended-mark.mjs';

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
  const snapshot = typeof input.agent_id === 'string' && input.agent_id !== '' ? readGateSnapshot(input) : null;
  // Read before any guard, wherever the call runs: a session the background route started stays held outside its project.
  const mark = readUnattendedMark(input.session_id);
  const marked = mark?.root ? findProject(mark.root) : null;
  // With its config.json gone, the folder is no project any more; the snapshot still names the one the session started
  // in, and the mark the one the gate ran in.
  const origin = snapshot?.root ? openProject(snapshot.root) : null;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd()) ?? origin ?? marked;
  if (snapshot?.problem) {
    const settings = project ? loadConfig(project).config : DEFAULTS;
    const denial = unreadableConfigDenial(input, snapshot.file, snapshot.problem, settings, 'to start a new session, which takes the gates from the config again');
    if (denial) await block(input, 'agent-gates', denial.reason, { match: 'the gate snapshot cannot be read', project: project ?? undefined, config: settings });
  }
  if (!project) {
    // The gate command runs outside a project too, with the defaults.
    const unattended = () => mark !== null;
    let outside;
    try {
      outside = withinDeadline(budget, () => handoffContinueDenial(input, DEFAULTS) ?? handoffEnvDenial(input, DEFAULTS, { unattended })
        ?? hostSessionStartDenial(input, DEFAULTS, { unattended }) ?? stateFoldersWriteDenial(input, DEFAULTS, { unattended })
        ?? sessionFoldersWriteDenial(input, null, DEFAULTS, null, { unattended }));
    } catch (error) {
      if (!(error instanceof PastDeadline)) throw error;
      outside = deadlineDenial(input, DEFAULTS, { unattended });
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
  const unattended = () => mark !== null || (alone ??= startedUnattended(project, config, input.session_id));
  let denial;
  try {
    denial = withinDeadline(budget, () => guards(input, project, config, gated, snapshot, [marked, origin], unattended));
  } catch (error) {
    if (!(error instanceof PastDeadline)) throw error;
    denial = deadlineDenial(input, config, { unattended });
  }
  if (denial) await block(input, 'config-guard', denial.reason, { match: denial.match, project, config });
}

// The first guard's denial of the call, or null. The store guard runs first without its link walk, which reads folders
// on disk, and with it last, so a call the other guards refuse by the paths and names it gives is refused before any walk.
// `others` are the project the session's unattended mark names and the one its gate snapshot names, each or null: each
// that is another project than the call's has its store, its session folders, and its machine's switches guarded too,
// so a subagent that moved to another project still meets the folders of the session's own. `unattended()` says whether
// no Human attends the session.
function guards(input, project, config, gated, snapshot, others, unattended) {
  let dir;
  const state = () => (dir ??= stateDir(project, { config }));
  const guarded = snapshot?.gates ? [snapshot.file, snapshot.marker] : [];
  return opaqueLimitDenial(input, config, { unattended })
    ?? writeLimitDenial(input, config, { unattended })
    ?? handoffContinueDenial(input, config)
    ?? handoffEnvDenial(input, config, { unattended })
    ?? hostSessionStartDenial(input, config, { unattended })
    ?? continueStoreWriteDenial(input, project, config, state, { links: false, unattended })
    ?? sessionFoldersWriteDenial(input, project, config, state, { links: false, unattended })
    ?? stateFoldersWriteDenial(input, config, { project, links: false, unattended })
    ?? machineSwitchWriteDenial(input, project, config, { unattended })
    ?? (gated ? configWriteDenial(input, project, config, { also: guarded }) : null)
    ?? continueStoreWriteDenial(input, project, config, state, { unattended })
    ?? sessionFoldersWriteDenial(input, project, config, state, { unattended })
    ?? stateFoldersWriteDenial(input, config, { project, unattended })
    ?? otherProjects(input, project, others, unattended);
}

// The first denial of the guards of each of `others` that is another project folder than the call's, each asked once:
// by its own folder, so a linked checkout whose config moves `state.dir` elsewhere than the main checkout's is its own.
function otherProjects(input, project, others, unattended) {
  const seen = new Set([canonical(project.root)]);
  for (const other of others) {
    const key = other ? canonical(other.root) : null;
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    const denial = otherProject(input, other, unattended);
    if (denial) return denial;
  }
  return null;
}

// The denial of the guards of `marked`, a project the session started in or the gate ran in, as when the session works
// in another repository: its machine's switches, its continuation store, and its session folders.
function otherProject(input, marked, unattended) {
  const { config } = loadConfig(marked);
  let dir;
  const state = () => (dir ??= stateDir(marked, { config }));
  return machineSwitchWriteDenial(input, marked, config, { unattended }) ?? continueStoreWriteDenial(input, marked, config, state, { unattended })
    ?? sessionFoldersWriteDenial(input, marked, config, state, { unattended });
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
