// Per-agent tool gates: which tools each agent may use in a project, from `agents` in config.json and the local file.
// config-merge.mjs checks the patterns with patternProblem; scripts/hook-agent-gates.mjs asks gateDenial before every tool
// call. docs/config.md#agents gives the rules.

import { agentAliases, deniedNames, opaqueShellCommand, toolNames } from './hosts/index.mjs';
import { commandLines, inlineShellCommand, lexInputs, readGit, readInvocation, readsShellInput, SUBSTITUTION_DEPTH_LIMIT } from './shell-lex.mjs';

// The entry that applies to every agent, and the one for the main session, which has no `agent_id`. Both select gates;
// neither is an agent a dispatch can name (config-types.mjs `agentName`).
export const ALL = '*';
export const MAIN = 'main';

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
// agent; `paths` is the project's paths (lib/project.mjs), which the reason names. `started` marks gates from the
// session's snapshot (lib/gate-snapshot.mjs), which the reason says a change to those files cannot lift.
// Every entry that names the caller applies: `*`, `main` for the main session, and the agent's name, full or short.
// A deny that matches wins; then each entry with an `allow` list must match the call. A deny matches the call by each of
// its names (deniedNames), so a bare Bash deny also covers a tool the host runs under Bash's permission rules, and every
// Bash deny, bare or by prefix, covers a command in a shell the lexer cannot read, for the main session and every agent.
export function gateDenial(input, { agents, names: { human } }, paths, { started = false } = {}) {
  const tool = input.tool_name;
  if (typeof tool !== 'string' || tool === '') return null;
  const called = toolNames(input);
  const denied = deniedNames(input);
  const unread = opaqueShellCommand(input) !== null;
  const caller = callerNames(input);
  const entries = Object.entries(agents).filter(([name]) => caller.has(name));
  const where = { human, paths, started };
  for (const [name, { deny = [] }] of entries) {
    const hit = deny.find((pattern) => denied.some((name) => denies(pattern, name, input.tool_input, unread)));
    if (!hit) continue;
    return blocked(input, `agents.${name}.deny has "${hit}"`, where, coveredWhy(input, hit, called, unread));
  }
  for (const [name, { allow }] of entries) {
    if (allow && !allows(allow, called, input.tool_input)) return blocked(input, `agents.${name}.allow does not list it`, where);
  }
  return null;
}

// Why the deny `hit` covers a call it does not name, or '' when it names it: the call's command is `unread`, in a shell
// the gate cannot read, or the host runs the call under another tool's permission rules (`permission_tool_name`).
function coveredWhy(input, hit, called, unread) {
  if (called.some((name) => denies(hit, name, input.tool_input, false))) return '';
  const tool = calledName(input);
  if (unread) return `; a Bash deny covers ${tool} too, since the gate cannot read its command to tell what it runs`;
  const under = input.permission_tool_name;
  return `; a ${under} deny covers ${tool} too, since the host runs it under ${under}'s permission rules`;
}

// The `agents` keys that name the caller. A plugin agent answers to its short name too, in each host's form of it
// (lib/hosts/): `explorer` for what one host calls `aidrian:explorer` and another `aidrian-explorer`.
function callerNames(input) {
  const names = new Set([ALL]);
  if (typeof input.agent_id !== 'string' || input.agent_id === '') names.add(MAIN);
  const type = input.agent_type;
  if (typeof type === 'string' && type !== '') for (const name of agentAliases(type)) names.add(name);
  return names;
}

// Tools that only read files, which a subagent keeps while the gates are unknown.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

// Why the subagent call in `input` may not run while `file`, which sets the project's configuration, is there but
// cannot be read (`problem` says why), or null: { match, reason }. The gates it sets are unknown then, so a subagent
// keeps only the tools that read; the main session, which has no `agent_id`, keeps every tool to fix the file.
// `fix` is what the human is asked for; by default, to fix the file.
export function unreadableConfigDenial(input, file, problem, settings, fix = `that ${file} needs fixing (aidrian check names the problem)`) {
  const why = `${file} cannot be read (${problem}), so this project's agent gates are unknown, and until it is fixed a subagent may only read files`;
  return readOnlyDenial(input, `${file} cannot be read`, why, settings, fix);
}

// The denial { match, reason } that keeps the subagent call in `input` to the tools that read, or null for a read or a
// call of the main session. `why` says why the gates are unknown; `fix` is what the human is asked for.
export function readOnlyDenial(input, match, why, { names: { human } }, fix) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '' || READ_TOOLS.has(input.tool_name)) return null;
  return { match, reason: projectRuleReason(input, why, human, fix) };
}

// The reason a project rule gives the agent when it blocks the call in `input`: the tool, by the name the host sent when
// that differs (`raw_tool_name`), since that is the tool the agent called, who called it, `why`, and that it should ask
// `human` for `ask` rather than work around the rule. The gates and the config guard block with it. A guard that holds
// the session's unattended `mark` passes it, so a session that works an issue of a project run, and its subagents, are
// named as that, never as the main session.
export function projectRuleReason(input, why, human, ask = 'what the task needs', { mark = null } = {}) {
  const tool = calledName(input);
  const subagent = typeof input.agent_id === 'string' && input.agent_id !== '';
  let who = subagent ? 'a subagent' : 'the main session';
  if (typeof input.agent_type === 'string' && input.agent_type !== '') who = `the agent "${input.agent_type}"`;
  if (typeof mark?.issue === 'string' && mark.issue !== '') {
    const session = `the issue session of a project run${typeof mark.project === 'string' && mark.project !== '' ? ` (${mark.project}, ${mark.issue})` : ` (${mark.issue})`}`;
    who = subagent ? `${who} of ${session}` : session;
  }
  return `aidrian: ${tool} is blocked for ${who} in this project: ${why}.`
    + ` This is a project rule: do not reach the same result with another tool; tell ${human} ${ask}.`;
}

// The name of the tool the agent called: the one the host sent when that differs (`raw_tool_name`), else the standard one.
const calledName = (input) => [input.raw_tool_name, input.tool_name].find((name) => typeof name === 'string' && name !== '') ?? 'this tool';

// `why` adds to the rule's source, such as why the rule covers this tool.
function blocked(input, rule, { human, paths, started }, why = '') {
  const source = started
    ? `${rule}, as the project set it when this session started (a change to ${paths.config} or ${paths.local} during the session cannot lift it)`
    : `${rule} (${paths.config}, or ${paths.local}, which wins)`;
  return { match: rule, reason: projectRuleReason(input, `${source}${why}`, human) };
}

// A deny pattern matches the tool by name; Bash(<prefix>) matches a Bash call where any command starts with the prefix,
// and every call whose command is `unread`, in a shell the lexer cannot read, since no prefix can be told apart there.
function denies(pattern, tool, toolInput, unread) {
  const prefix = bashPrefix(pattern);
  if (!prefix) return nameMatches(pattern, tool);
  return tool === 'Bash' && (unread || commands(toolInput).some((words) => startsWith(words, prefix)));
}

// An allow list lets the call run when a pattern names it, or, for Bash, when every command starts with an allowed
// prefix, so `npm test && rm -rf build` needs both `npm test` and `rm` allowed. `called` is the call's names, the standard
// one first (toolNames). A shell command the host read as Bash from a tool of another name, such as a command watch,
// meets the list's Bash(...) patterns when it has any: a pattern that names only that tool lets any command through only
// when the list limits Bash by no prefix.
function allows(allow, [tool, raw], toolInput) {
  const prefixes = allow.map(bashPrefix).filter(Boolean);
  const named = (name) => typeof name === 'string' && allow.some((pattern) => !bashPrefix(pattern) && nameMatches(pattern, name));
  if (named(tool)) return true;
  if (tool !== 'Bash') return named(raw);
  if (named(raw) && prefixes.length === 0) return true;
  const found = commands(toolInput);
  return prefixes.length > 0 && found.length > 0 && found.every((words) => prefixes.some((prefix) => startsWith(words, prefix)));
}

// Whether a tool name matches a pattern: exactly, or by the start of a pattern that ends in `*`.
export function nameMatches(pattern, tool) {
  return pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern;
}

// The words of a Bash(<prefix>) pattern, or null for any other pattern.
function bashPrefix(pattern) {
  return BASH.exec(pattern)?.[1].trim().split(/\s+/u) ?? null;
}

// Every command the Bash call runs, each as its words: the commands of each `&&`, `;`, and `|` step, of each command
// substitution, of each `sh -c` or `bash -c` string, and of each heredoc or here-string a shell reads its commands from,
// read past wrappers such as `sudo` and `env`, and past git's global options, so `git -C x push` is `git push`. The
// shell itself stays a command too, so an `allow` list must still name it. A command run by `eval`, `xargs`, a pipe into
// a shell, or a script is not read.
// The last command read and its commands, so a call's every Bash(<prefix>) pattern reads its command once.
let lexed = { command: null, found: [] };
function commands(toolInput) {
  const command = toolInput?.command;
  if (typeof command !== 'string') return [];
  if (lexed.command === command) return lexed.found;
  lexed = { command, found: readCommands(command) };
  return lexed.found;
}

function readCommands(command) {
  const found = [];
  const read = (line, depth) => {
    for (const { segments, inputs } of commandLines(line).map(lexInputs)) {
      for (const [i, segment] of segments.entries()) {
        const invocation = readInvocation(segment);
        if (depth < SUBSTITUTION_DEPTH_LIMIT) {
          const inner = inlineShellCommand(invocation);
          if (inner !== null) read(inner, depth + 1);
          else if (readsShellInput(invocation)) for (const body of inputs[i]) read(body, depth + 1);
        }
        const each = words(segment);
        if (each.length > 0) found.push(each);
      }
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
