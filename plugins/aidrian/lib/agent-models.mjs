// Applies a project's `models` config (docs/config.md#models) to this plugin's agents, one way per host.
//   Claude Code: a PreToolUse hook rewrites the Agent tool call, whose `model` and `effort` win over the agent file's.
//   Codex: install-agents.mjs writes `model` and `model_reasoning_effort` into the role it installs into a project.
// No dependencies: this file runs from the installed plugin.

const PLUGIN = 'aidrian:';

// The Agent tool input with the project's model and effort for this plugin's agent, or null when nothing changes.
// A model or effort the call already carries was chosen for that one dispatch, so it stays.
export function agentCall(toolInput, models) {
  const type = toolInput?.subagent_type;
  if (typeof type !== 'string' || !type.startsWith(PLUGIN)) return null;
  const name = type.slice(PLUGIN.length);
  const chosen = Object.hasOwn(models.claude.agents, name) ? models.claude.agents[name] : {};
  const added = Object.entries(chosen).filter(([field]) => toolInput[field] === undefined);
  return added.length ? { ...toolInput, ...Object.fromEntries(added) } : null;
}

// A generated Codex role with the project's model and effort for its agent. scripts/build.mjs writes the lines this edits.
export function codexRole(text, { model, effort } = {}) {
  let role = text;
  if (effort !== undefined) role = role.replace(/^model_reasoning_effort = .*$/m, `model_reasoning_effort = ${JSON.stringify(effort)}`);
  if (model !== undefined) {
    role = role
      .replace(/^model_reasoning_effort = /m, `model = ${JSON.stringify(model)}\nmodel_reasoning_effort = `)
      .replace(/; this role inherits the Codex session's model\.$/m, "; the project's aidrian config sets this role's model.");
  }
  return role;
}
