// PreToolUse hook for every tool: the project's per-agent tool gates, `agents` in config.json and the local file.
// lib/agent-gates.mjs decides, then lib/config-guard.mjs keeps a subagent from changing the files that set the gates.
// It runs before every tool call, so without gates it stops as soon as it has read the config; a call a gate blocks
// exits 2 with the rule's name on stderr, and the block is recorded as the Bash hook records its blocks (lib/hook-deny.mjs).
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
import { configWriteDenial } from '../lib/config-guard.mjs';
import { readGateSnapshot } from '../lib/gate-snapshot.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { findProject, openProject } from '../lib/project.mjs';

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
  if (!project) return;
  const { config, errors, current } = loadConfig(project);
  // An `agents` list of the wrong shape is dropped, which lifts its gate; read it as a file that cannot be read.
  const broken = unreadable(project, current, errors) ?? (current ? malformedGates(errors) : null);
  const failed = broken && unreadableConfigDenial(input, broken.file, broken.problem, config);
  if (failed) await block(input, 'agent-gates', failed.reason, { match: failed.match, project, config });
  const started = (snapshot?.gates ?? []).filter((agents) => Object.keys(agents).length > 0);
  if (Object.keys(config.agents).length === 0 && started.length === 0) return;
  const gate = gateDenial(input, config, project.paths)
    ?? started.map((agents) => gateDenial(input, { ...config, agents }, project.paths, { started: true })).find(Boolean);
  const guarded = snapshot?.gates ? [snapshot.file, snapshot.marker] : [];
  const [rule, denial] = gate ? ['agent-gates', gate] : ['config-guard', configWriteDenial(input, project, config, { also: guarded })];
  if (denial) await block(input, rule, denial.reason, { match: denial.match, project, config });
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
