// The guard that keeps a gated subagent from lifting its own gates: while `agents` sets any gate, no subagent may change
// a file that sets the project's configuration (project.mjs configFiles). The main session, which has no `agent_id`,
// still can. scripts/hook-agent-gates.mjs asks it before every tool call; docs/config.md#agents gives the rule.
// It reads the targets the way the main-checkout rule does: Edit, Write, NotebookEdit, and apply_patch by the path they
// name, and a Bash command by the paths it certainly writes.

import path from 'node:path';

import { configFiles } from './project.mjs';
import { bashTargets, canonical, toolTargets } from './rules/main-checkout.mjs';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_patch']);

// The reason the subagent call in `input`, a PreToolUse payload, changes one of `project`'s config files, or null.
// It changes one when it writes the file, or a folder that holds it, such as the project folder an `rm -rf` names, unless
// that folder also holds one of the project's checkouts, such as the project root or its worktree, as `cp notes.md .` does.
export function configWriteReason(input, project, { names: { human } }) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '') return null;
  const targets = writeTargets(input);
  if (targets.length === 0) return null;
  const roots = project.checkouts.map((dir) => canonical(dir));
  const files = configFiles(project).map((file) => canonical(file));
  for (const target of targets.map((each) => canonical(each))) {
    const holdsRoot = roots.some((root) => root === target || inside(target, root));
    const file = files.find((each) => each === target || (!holdsRoot && inside(target, each)));
    if (file) return blocked(input, inside(roots[0], file) ? path.relative(roots[0], file) : file, human);
  }
  return null;
}

// The absolute paths the call writes: none for a tool that writes no file.
function writeTargets(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (WRITE_TOOLS.has(input.tool_name)) return toolTargets(input).map((target) => path.resolve(cwd, target));
  const command = input.tool_input?.command;
  return input.tool_name === 'Bash' && typeof command === 'string' ? bashTargets(command, cwd) : [];
}

// Whether `file` lies below the folder `dir`.
function inside(dir, file) {
  const rel = path.relative(dir, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function blocked(input, file, human) {
  const who = typeof input.agent_type === 'string' && input.agent_type !== '' ? `the agent "${input.agent_type}"` : 'a subagent';
  return `aidrian: ${input.tool_name} is blocked for ${who} in this project: it changes ${file}, which sets this project's agent gates,`
    + ' and while gates are set only the main session may change it.'
    + ` This is a project rule: do not reach the same result with another tool; tell ${human} what the task needs.`;
}
