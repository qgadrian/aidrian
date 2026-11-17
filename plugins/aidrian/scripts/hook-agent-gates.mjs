// PreToolUse hook for every tool: the project's per-agent tool gates, `agents` in config.json and the local file.
// lib/agent-gates.mjs decides, then lib/config-guard.mjs keeps a subagent from changing the files that set the gates,
// and, with or without gates, from setting the machine's switches, as it keeps a session the background handoff route
// started (lib/handoff-guard.mjs startedUnattended); lib/handoff-guard.mjs, with or without
// gates, from running `aidrian handoff continue` or writing in the handoff continuation store.
// It runs before every tool call, so without gates it stops as soon as it has read the config and run the guards that hold
// without gates; a call a gate blocks exits 2 with the rule's name on stderr, and the block is recorded as the Bash hook
// records its blocks (lib/hook-deny.mjs). The gates are asked before any guard, so a call they deny never waits on one.
// The guards then run under a time budget (lib/deadline.mjs), GUARD_BUDGET_MS from the hook's start, well inside the
// host's 5 second hook timeout, past which the host runs the call with no guard: a subagent's call they cannot finish
// reading in time is refused (config-guard.mjs deadlineDenial), and the main session's runs, as the guards allow it anyway.
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
import { continueStoreWriteDenial, handoffContinueDenial, startedUnattended } from '../lib/handoff-guard.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { findProject, openProject, stateDir } from '../lib/project.mjs';

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
  // With its config.json gone, the folder is no project any more; the snapshot still names the one the session started in.
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd()) ?? (snapshot?.root ? openProject(snapshot.root) : null);
  if (snapshot?.problem) {
    const settings = project ? loadConfig(project).config : DEFAULTS;
    const denial = unreadableConfigDenial(input, snapshot.file, snapshot.problem, settings, 'to start a new session, which takes the gates from the config again');
    if (denial) await block(input, 'agent-gates', denial.reason, { match: 'the gate snapshot cannot be read', project: project ?? undefined, config: settings });
  }
  if (!project) {
    // The gate command runs outside a project too, with the defaults.
    const outside = handoffContinueDenial(input, DEFAULTS);
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
  let denial;
  try {
    denial = withinDeadline(budget, () => guards(input, project, config, gated, snapshot));
  } catch (error) {
    if (!(error instanceof PastDeadline)) throw error;
    denial = deadlineDenial(input, config);
  }
  if (denial) await block(input, 'config-guard', denial.reason, { match: denial.match, project, config });
}

// The first guard's denial of the call, or null. The store guard runs first without its link walk, which reads folders
// on disk, and with it last, so a call the other guards refuse by the paths and names it gives is refused before any walk.
function guards(input, project, config, gated, snapshot) {
  let dir;
  const state = () => (dir ??= stateDir(project, { config }));
  const guarded = snapshot?.gates ? [snapshot.file, snapshot.marker] : [];
  return opaqueLimitDenial(input, config)
    ?? writeLimitDenial(input, config)
    ?? handoffContinueDenial(input, config)
    ?? continueStoreWriteDenial(input, project, config, state, { links: false })
    ?? machineSwitchWriteDenial(input, project, config, { unattended: () => startedUnattended(project, config, input.session_id) })
    ?? (gated ? configWriteDenial(input, project, config, { also: guarded }) : null)
    ?? continueStoreWriteDenial(input, project, config, state);
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
