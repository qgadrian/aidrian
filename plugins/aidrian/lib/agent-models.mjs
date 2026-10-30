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

// A generated Codex role with the project's model and effort for its agent. scripts/build.mjs writes the lines this edits:
// the second comment line, which says where the model comes from, and the keys above `developer_instructions`.
// A key the role already has is replaced; a missing one goes in, `model` before `model_reasoning_effort`.
export function codexRole(text, { model, effort } = {}) {
  // Edit only the keys above the instructions, so a line in the instructions that looks like a key stays as it is.
  const at = text.search(/^developer_instructions = /m);
  if (at < 0 || (model === undefined && effort === undefined)) return text;
  let head = text.slice(0, at);
  if (effort !== undefined) head = setKey(head, 'model_reasoning_effort', effort);
  if (model !== undefined) {
    head = setKey(head, 'model', model, 'model_reasoning_effort')
      .replace(/^# .*\bmodel\.$/m, "# The project's aidrian config sets this role's model.");
  }
  return head + text.slice(at);
}

// `key = value` in a role's head: in place of the key's line, else before `before`'s line, else at the end.
function setKey(head, key, value, before) {
  const line = `${key} = ${JSON.stringify(value)}\n`;
  const own = new RegExp(`^${key} = .*\n`, 'm');
  if (own.test(head)) return head.replace(own, line);
  const next = before === undefined ? -1 : head.search(new RegExp(`^${before} = `, 'm'));
  return next < 0 ? head + line : head.slice(0, next) + line + head.slice(next);
}
