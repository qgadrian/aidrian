// PreToolUse hook for every tool: the project's per-agent tool gates, `agents` in config.json and the local file.
// lib/agent-gates.mjs decides, then lib/config-guard.mjs keeps a subagent from changing the files that set the gates.
// It runs before every tool call, so without gates it stops as soon as it has read the config; a call a gate blocks
// exits 2 with the rule's name on stderr, and the block is recorded as the Bash hook records its blocks (lib/hook-deny.mjs).
// A file that sets the configuration but is there and cannot be read leaves the gates unknown, so a subagent may then
// only read (agent-gates.mjs unreadableConfigDenial); the main session keeps every tool, to fix it.
// Anything else this hook cannot read lets the call run.

import path from 'node:path';

import { gateDenial, unreadableConfigDenial } from '../lib/agent-gates.mjs';
import { isFile, loadConfig } from '../lib/config.mjs';
import { configWriteDenial } from '../lib/config-guard.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';

await runHook(async (input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config, errors, current } = loadConfig(project);
  const broken = unreadable(project, current, errors);
  const failed = broken && unreadableConfigDenial(input, broken.file, broken.problem, config);
  if (failed) await block(input, 'agent-gates', failed.reason, { match: failed.match, project, config });
  if (Object.keys(config.agents).length === 0) return;
  const gate = gateDenial(input, config, project.paths);
  const [rule, denial] = gate ? ['agent-gates', gate] : ['config-guard', configWriteDenial(input, project, config)];
  if (denial) await block(input, rule, denial.reason, { match: denial.match, project, config });
});

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
