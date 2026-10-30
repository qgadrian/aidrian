// Per-agent tool gates: which tools each agent may use in a project, from `agents` in config.json and the local file.
// config.mjs checks the patterns with patternProblem; scripts/hook-agent-gates.mjs asks gateDenial before every tool
// call. docs/config.md#agents gives the rules.

import { commandLines, inlineShellCommand, lexCommand, readGit, readInvocation, SUBSTITUTION_DEPTH_LIMIT } from './shell-lex.mjs';

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
    if (hit) return blocked(input, `agents.${name}.deny has "${hit}"`, { human, paths });
  }
  for (const [name, { allow }] of entries) {
    if (allow && !allows(allow, tool, input.tool_input)) return blocked(input, `agents.${name}.allow does not list it`, { human, paths });
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

// Tools that only read files, which a subagent keeps while the gates are unknown.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

// Why the subagent call in `input` may not run while `file`, which sets the project's configuration, is there but
// cannot be read (`problem` says why), or null: { match, reason }. The gates it sets are unknown then, so a subagent
// keeps only the tools that read; the main session, which has no `agent_id`, keeps every tool to fix the file.
export function unreadableConfigDenial(input, file, problem, { names: { human } }) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '' || READ_TOOLS.has(input.tool_name)) return null;
  const why = `${file} cannot be read (${problem}), so this project's agent gates are unknown, and until it is fixed a subagent may only read files`;
  return { match: `${file} cannot be read`, reason: projectRuleReason(input, why, human, `that ${file} needs fixing (aidrian check names the problem)`) };
}

// The reason a project rule gives the agent when it blocks the call in `input`: the tool, who called it, `why`, and that
// it should ask `human` for `ask` rather than work around the rule. The gates and the config guard block with it.
export function projectRuleReason(input, why, human, ask = 'what the task needs') {
  const tool = typeof input.tool_name === 'string' && input.tool_name !== '' ? input.tool_name : 'this tool';
  let who = typeof input.agent_id === 'string' && input.agent_id !== '' ? 'a subagent' : 'the main session';
  if (typeof input.agent_type === 'string' && input.agent_type !== '') who = `the agent "${input.agent_type}"`;
  return `aidrian: ${tool} is blocked for ${who} in this project: ${why}.`
    + ` This is a project rule: do not reach the same result with another tool; tell ${human} ${ask}.`;
}

function blocked(input, rule, { human, paths }) {
  return { match: rule, reason: projectRuleReason(input, `${rule} (${paths.config}, or ${paths.local}, which wins)`, human) };
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

// Every command the Bash call runs, each as its words: the commands of each `&&`, `;`, and `|` step, of each command
// substitution, and of each `sh -c` or `bash -c` string, read past wrappers such as `sudo` and `env`, and past git's
// global options, so `git -C x push` is `git push`. The shell itself stays a command too, so an `allow` list must still
// name it. A command run by `eval`, `xargs`, or a script is not read.
function commands(toolInput) {
  const command = toolInput?.command;
  if (typeof command !== 'string') return [];
  const found = [];
  const read = (line, depth) => {
    for (const segment of commandLines(line).flatMap(lexCommand)) {
      const inner = depth < SUBSTITUTION_DEPTH_LIMIT ? inlineShellCommand(readInvocation(segment)) : null;
      if (inner !== null) read(inner, depth + 1);
      const each = words(segment);
      if (each.length > 0) found.push(each);
    }
  };
  read(command, 0);
  return found;
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
