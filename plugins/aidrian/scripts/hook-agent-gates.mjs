// PreToolUse hook for every tool: the project's per-agent tool gates, `agents` in config.json and the local file.
// lib/agent-gates.mjs decides. It runs before every tool call, so without gates it stops as soon as it has read the
// config; a call a gate blocks exits 2 with the rule's name on stderr. Anything this hook cannot read lets the call run.

import { gateReason } from '../lib/agent-gates.mjs';
import { loadConfig } from '../lib/config.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  if (Object.keys(config.agents).length === 0) return;
  const reason = gateReason(input, config, project.paths);
  if (reason) deny(reason);
});
