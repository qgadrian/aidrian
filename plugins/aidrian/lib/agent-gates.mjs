// Per-agent tool gates: which tools each agent may use in a project, from `agents` in config.json and the local file.
// config.mjs checks the patterns with patternProblem; scripts/hook-agent-gates.mjs asks gateDenial before every tool
// call. docs/config.md#agents gives the rules.

import { commandLines, lexCommand, readGit, readInvocation } from './shell-lex.mjs';

// The entry that applies to every agent, and the one for the main session, which has no `agent_id`.
const ALL = '*';
const MAIN = 'main';
// Codex installs this plugin's agents as roles named `aidrian-<agent>`; Claude Code names them `aidrian:<agent>`.
const CODEX_PREFIX = 'aidrian-';

const AGENT_NAME = /^[\w.:-]+$/u;
const TOOL_NAME = /^[\w.:-]*$/u;
const BASH = /^Bash\((.*)\)$/su;
// A word of a Bash(...) prefix: plain text the shell reads as it is, with no quotes, operators, `$`, or glob.
const PLAIN_WORD = /^[^\s*?;&|<>()`$"'\\]+$/u;

// Why `name` cannot be a key of `agents`, or null.
export function agentNameProblem(name) {
  return name === ALL || AGENT_NAME.test(name) ? null : 'an agent name is "*", "main", or an agent name such as explorer';
}

// Why `pattern` is not a tool pattern, or null. A pattern is a tool name, a name ending in `*`, or Bash(<command prefix>).
export function patternProblem(pattern) {
  if (typeof pattern !== 'string' || pattern === '') return 'a pattern is a non-empty string';
  const prefix = BASH.exec(pattern)?.[1];
  if (prefix !== undefined) {
    const words = prefix.trim().split(/\s+/u).filter(Boolean);
    if (words.length === 0) return 'Bash() needs a command prefix, such as Bash(git push)';
    if (prefix.includes('*')) return 'Bash(...) takes a command prefix without "*", such as Bash(git push)';
    return words.every((word) => PLAIN_WORD.test(word)) ? null : 'Bash(...) takes plain words, with no quotes, operators, or "$"';
  }
  if (!TOOL_NAME.test(pattern.replaceAll('*', ''))) {
    return 'a pattern is a tool name such as Read, a name ending in "*" such as mcp__github__*, or Bash(<command prefix>)';
  }
  return /\*./u.test(pattern) ? 'a "*" can only end a pattern, as in mcp__github__*' : null;
}

// The gate in config `agents` that the tool call in `input`, a PreToolUse payload, breaks, or null when it breaks none:
// { match, reason }. `match` names the gate, such as `agents.main.deny has "Bash(git push)"`, and `reason` tells the
// agent; `paths` is the project's paths (lib/project.mjs), which the reason names.
// Every entry that names the caller applies: `*`, `main` for the main session, and the agent's name, full or short.
// A deny that matches wins; then each entry with an `allow` list must match the call.
export function gateDenial(input, { agents, names: { human } }, paths) {
  const tool = input.tool_name;
  if (typeof tool !== 'string' || tool === '') return null;
  const caller = callerNames(input);
  const entries = Object.entries(agents).filter(([name]) => caller.has(name));
  for (const [name, { deny = [] }] of entries) {
    const hit = deny.find((pattern) => denies(pattern, tool, input.tool_input));
    if (hit) return blocked(input, tool, `agents.${name}.deny has "${hit}"`, { human, paths });
  }
  for (const [name, { allow }] of entries) {
    if (allow && !allows(allow, tool, input.tool_input)) return blocked(input, tool, `agents.${name}.allow does not list it`, { human, paths });
  }
  return null;
}

// The `agents` keys that name the caller. A plugin agent answers to its short name too: `aidrian:explorer` and Codex's
// `aidrian-explorer` are both `explorer`.
function callerNames(input) {
  const names = new Set([ALL]);
  if (typeof input.agent_id !== 'string' || input.agent_id === '') names.add(MAIN);
  const type = input.agent_type;
  if (typeof type === 'string' && type !== '') {
    const short = type.slice(type.lastIndexOf(':') + 1);
    names.add(type).add(short);
    if (short.startsWith(CODEX_PREFIX)) names.add(short.slice(CODEX_PREFIX.length));
  }
  return names;
}

function blocked(input, tool, rule, { human, paths }) {
  const who = typeof input.agent_type === 'string' && input.agent_type !== '' ? `the agent "${input.agent_type}"` : 'the main session';
  const reason = `aidrian: ${tool} is blocked for ${who} in this project: ${rule} (${paths.config}, or ${paths.local}, which wins).`
    + ` This is a project rule: do not reach the same result with another tool; tell ${human} what the task needs.`;
  return { match: rule, reason };
}

// A deny pattern matches the tool by name; Bash(<prefix>) matches a Bash call where any command starts with the prefix.
function denies(pattern, tool, toolInput) {
  const prefix = bashPrefix(pattern);
  if (!prefix) return nameMatches(pattern, tool);
  return tool === 'Bash' && commands(toolInput).some((words) => startsWith(words, prefix));
}

// An allow list lets the tool run when a pattern names it, or, for Bash, when every command starts with an allowed
// prefix, so `npm test && rm -rf build` needs both `npm test` and `rm` allowed.
function allows(allow, tool, toolInput) {
  if (allow.some((pattern) => !bashPrefix(pattern) && nameMatches(pattern, tool))) return true;
  if (tool !== 'Bash') return false;
  const prefixes = allow.map(bashPrefix).filter(Boolean);
  const found = commands(toolInput);
  return prefixes.length > 0 && found.length > 0 && found.every((words) => prefixes.some((prefix) => startsWith(words, prefix)));
}

function nameMatches(pattern, tool) {
  return pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern;
}

// The words of a Bash(<prefix>) pattern, or null for any other pattern.
function bashPrefix(pattern) {
  return BASH.exec(pattern)?.[1].trim().split(/\s+/u) ?? null;
}

// Every command the Bash call runs, each as its words: the commands of each `&&`, `;`, and `|` step and of each command
// substitution, read past wrappers such as `sudo` and `env`, and past git's global options, so `git -C x push` is
// `git push`. A command run inside `sh -c`, `eval`, or a script is not read.
function commands(toolInput) {
  const command = toolInput?.command;
  if (typeof command !== 'string') return [];
  return commandLines(command).flatMap((line) => lexCommand(line).map(words).filter((each) => each.length > 0));
}

function words(segment) {
  const git = readGit(segment);
  if (git) return ['git', git.subcommand, ...git.rest.map((token) => token.text)];
  const { program, args } = readInvocation(segment);
  return program ? [program, ...args.map((token) => token.text)] : [];
}

// Whether `words` begin with `prefix`. The first word is the program's file name, so `/usr/bin/git push` is `git push`.
function startsWith(words, prefix) {
  return prefix.length <= words.length && prefix.every((word, i) => (i === 0 ? word.split('/').pop() : word) === words[i]);
}
