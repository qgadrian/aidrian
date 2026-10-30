// PreToolUse hook for every tool: the project's per-agent tool gates, `agents` in config.json and the local file.
// lib/agent-gates.mjs decides, then lib/config-guard.mjs keeps a subagent from changing the files that set the gates.
// It runs before every tool call, so without gates it stops as soon as it has read the config; a call a gate blocks
// exits 2 with the rule's name on stderr, and the block is recorded as the Bash hook records its blocks (lib/hook-deny.mjs).
// Anything this hook cannot read lets the call run.

import { gateDenial } from '../lib/agent-gates.mjs';
import { loadConfig } from '../lib/config.mjs';
import { configWriteDenial } from '../lib/config-guard.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';

await runHook(async (input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  if (Object.keys(config.agents).length === 0) return;
  const gate = gateDenial(input, config, project.paths);
  const [rule, denial] = gate ? ['agent-gates', gate] : ['config-guard', configWriteDenial(input, project, config)];
  if (denial) await block(input, rule, denial.reason, { match: denial.match, project, config });
});
