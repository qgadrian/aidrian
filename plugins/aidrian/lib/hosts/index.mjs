// The hosts the plugin runs on, one adapter a file, and the calls the shared code makes instead of reading a host's
// variables or naming its tools. docs/providers/adding-a-host.md says what an adapter declares; test/adapters.test.mjs
// checks each one. Hooks load this file on every call, so it and the adapters stay small and read no file when loaded.

import claudeCode from './claude-code.mjs';
import codex from './codex.mjs';

// Detection order: Codex first, because a Codex started from a Claude Code shell inherits that shell's variables.
export const HOSTS = Object.freeze([codex, claudeCode]);

// A process no adapter claims. Never reported as one of the hosts: its name says it is unknown, and its AI has no brand.
// Payloads and responses pass through every adapter, so a host detection cannot fail open on what a known host sends.
export const UNKNOWN_HOST = Object.freeze({
  id: 'unknown',
  name: 'unknown',
  ai: 'the AI',
  sessionId: () => null,
  agentName: () => null,
  effort: () => null,
  runEnv: () => null,
  toolName: (name) => HOSTS.reduce((each, host) => host.toolName(each), name),
  serverSpelling: (server) => server,
  nativeToolName: (standard) => standard,
  rawToolName: (standard) => standard,
  toolResponse: (response) => HOSTS.flatMap((host) => host.toolResponse(response)),
  hookInput: (input) => HOSTS.reduce((each, host) => host.hookInput(each), input),
  capabilities: Object.freeze({}),
});

// The host of this process, from its environment and, in a hook, its payload.
export const detectHost = ({ env = process.env, input = {} } = {}, hosts = HOSTS) =>
  hosts.find((host) => host.detect({ env, input })) ?? UNKNOWN_HOST;

// The session and agent a command runs under, from its environment, each null when the host does not tell.
export function sessionIdentity(env = process.env) {
  const host = detectHost({ env });
  return { session: host.sessionId(env), agent: host.agentName(env) };
}

// `raw`, a hook's payload, in the standard names the shared code reads: `tool_name` as mcp__<server>__<tool> for an MCP tool.
export const normalizeHookInput = (raw, env = process.env) => detectHost({ env, input: raw }).hookInput(raw);

// The names a call goes by: the standard one, and what the host sent when that differs. A project's pattern may name either,
// so a gate or the guard matches both: it is the pattern a project wrote before the layer existed that must not stop matching.
export const toolNames = ({ tool_name: name, raw_tool_name: raw }) => [name, raw].filter((each) => typeof each === 'string' && each !== '');

// The names a deny matches the call by: toolNames; `permission_tool_name`, the standard tool whose permission rules the
// host runs this call under when that is another tool, as an adapter's `hookInput` sets it; and, for a command in a shell
// the lexer cannot read (opaqueShellCommand), the standard Bash. A Bash deny cannot be held to a command no lexer reads,
// so every Bash deny, bare or by prefix, covers it on every platform; a host may do the like only in some setups, as
// Claude Code turns its PowerShell tool off for a Bash deny only on Windows with Git Bash installed
// (code.claude.com/docs/en/tools-reference#bash-deny-rules-also-turn-off-the-powershell-tool). lib/agent-gates.mjs
// reads such a call as matching every Bash(<prefix>) pattern.
export const deniedNames = (input) => [...toolNames(input), input.permission_tool_name, opaqueShellCommand(input) === null ? null : 'Bash']
  .filter((each, i, all) => typeof each === 'string' && each !== '' && all.indexOf(each) === i);

// The command of a call that runs one in a shell the shared lexer cannot read, from an adapter's `opaqueShellTools`, or null.
// The guards read it as opaque text, never as Bash, and fail closed for a subagent (lib/config-guard.mjs opaqueWords).
export function opaqueShellCommand({ tool_name: tool, tool_input: given }) {
  const command = given?.command;
  return typeof command === 'string' && HOSTS.some((host) => host.opaqueShellTools?.includes(tool)) ? command : null;
}

// A GitHub tool call as { tool, given }, in the terms of the GitHub MCP server's tool: what a host's connector stands for, from the
// adapter's `githubTools`, with its repository split into `owner` and `repo`, and the adapter's `fixed` values, the inputs its
// tool implies without taking them, such as `draft: false` for a tool that only marks ready. `name` is the standard name; any
// other call stays as it is.
export function githubCall(name, given) {
  const tool = HOSTS.map((host) => host.githubTools?.[name]).find(Boolean);
  if (!tool) return { tool: name, given };
  const [, owner, repo] = /^([^/]+)\/([^/]+)$/u.exec(given[tool.repo]) ?? [];
  const fields = Object.entries(tool.fields).map(([standard, own]) => [standard, given[own]]);
  return { tool: tool.as, given: { owner, repo, ...Object.fromEntries(fields), ...tool.fixed } };
}

// The forms the tool `name` reaches a hook in: the standard one, and as each host sends it.
export const hookForms = (name, hosts = HOSTS) => {
  const standard = UNKNOWN_HOST.toolName(name);
  return [...new Set([standard, ...hosts.map((host) => host.rawToolName(standard))])];
};

// Whether `name` as written is one of those. The form only a model sees reaches no hook.
export const reachesAHook = (name, hosts = HOSTS) => hookForms(name, hosts).includes(name);

// Every way hosts spell a server's name, the written one first.
export const serverSpellings = (server, hosts = HOSTS) => [...new Set([server, ...hosts.map((host) => host.serverSpelling(server))])];

// The variables that say which session a process belongs to. A reviewer or a test runs without them.
export const IDENTITY_VARS = Object.freeze([...new Set(HOSTS.flatMap((host) => host.identityVars))]);
// The variables that say which host runs a process. The test suite runs without them, so it gives one result everywhere.
export const DETECT_VARS = Object.freeze([...new Set(HOSTS.flatMap((host) => host.detectVars))]);

// An agent's name without the plugin's prefix, in any host's form.
export const pluginAgentName = (name) => {
  const prefix = HOSTS.map((host) => host.pluginAgentPrefix).find((each) => name.startsWith(each));
  return prefix ? name.slice(prefix.length) : name;
};

// Every name that `type`, an agent type from a payload, answers to. A host's short form may hold another's, so this repeats
// until no adapter adds one.
export function agentAliases(type) {
  const names = new Set([type]);
  for (const name of names) for (const host of HOSTS) for (const alias of host.agentAliases(name)) names.add(alias);
  return names;
}

// Whether `tool` edits a file, on any host; a host's tool names are its own, so the host need not be known.
export const isFileEditTool = (tool) => HOSTS.some((host) => host.fileEditTools.includes(tool));

// The file edit in a tool call, in one of these shapes, or null when the tool edits no file. Every shape has `targets`, the
// paths it writes as it names them.
//   write     { file, content }: a whole file
//   edit      { file, edits, newText, replaceAll }: replacements in a file
//   notebook  { file }: a cell of a notebook
//   patch     { text, files: [{ file, added }] }: a patch naming its files, whose text is never known here
export function fileEditOf({ tool_name: tool, tool_input: given }) {
  const host = HOSTS.find((each) => each.fileEditTools.includes(tool));
  return host ? host.fileEdit(tool, given ?? {}) : null;
}

// The paths a file-tool read in a tool call names, as the tool names them, a null one standing for the call's folder,
// or null when the tool reads no file through the host's own file tools: a host lists its read tools in
// `fileReadTools` and names their paths with `fileRead(tool, input)`. A host whose reads all run in its shell lists none.
export function fileReadOf({ tool_name: tool, tool_input: given }) {
  const host = HOSTS.find((each) => (each.fileReadTools ?? []).includes(tool));
  return host ? host.fileRead(tool, given ?? {}) : null;
}

// The folders a project keeps `kind` (skills or agents) in, on every host that reads them.
export const projectFolders = (kind) => HOSTS.flatMap((host) => host.projectFolders[kind] ?? []);

// `models` in config.json, per host: { <key>: { model, effort } }.
export const modelChoices = () => Object.fromEntries(HOSTS.map((host) => [host.modelsKey, host.modelChoices]));

// Every host's model prices, as { host, models, rows }: the data lib/model-prices.mjs reads. A host with none has no rows.
export const priceTables = (hosts = HOSTS) => hosts.map((host) => ({ host: host.id, models: host.modelPrices?.models ?? [], rows: host.modelPrices?.rows ?? [] }));

// The host instruction files and folders every host loads from the folders above where a session starts, as { files,
// folders, userFolders }: the names of each, and each host's own user folder under `env`, which it reads for every session.
export function instructionNames(env = process.env, hosts = HOSTS) {
  const declared = hosts.map((host) => host.instructionFiles).filter(Boolean);
  return {
    files: [...new Set(declared.flatMap((each) => each.files ?? []))],
    folders: [...new Set(declared.flatMap((each) => each.folders ?? []))],
    userFolders: declared.map((each) => each.userFolder?.(env)).filter((each) => typeof each === 'string' && each !== ''),
  };
}

// The main checkout's paths every host reads from a session in a linked worktree, as { folders, settings }: the
// folders, from the checkout's root, and the settings files, each { file, problem(value) }, the host's check of its JSON.
export function mainCheckoutPaths(hosts = HOSTS) {
  const declared = hosts.map((host) => host.mainCheckoutPaths).filter(Boolean);
  return {
    folders: [...new Set(declared.flatMap((each) => each.folders ?? []))],
    settings: declared.flatMap((each) => each.settings ?? []).filter((each) => typeof each?.file === 'string' && typeof each.problem === 'function'),
  };
}

// The host programs' subcommands that write the host's own config, as { programs, subcommands, valueOptions }, from
// each adapter's `configCommands`: each subcommand a list of words, as `['mcp', 'add']`, and `valueOptions` the global
// options that take the next word, skipped before it. A host that names none adds none.
export const configCommands = (hosts = HOSTS) => hosts.map((host) => host.configCommands)
  .filter((each) => Array.isArray(each?.programs) && Array.isArray(each.subcommands));

// The host files of a checkout no session no Human attends writes, from its root, as every host declares them
// (`protectedPaths`): their union, so a session of one host cannot plant what another loads.
export const protectedPaths = (hosts = HOSTS) => [...new Set(hosts.flatMap((host) => host.protectedPaths ?? []))];

// Whether the path whose parts from a confined attempt's clone root are `segments` is a host file some host loads from
// any depth (`nestedProtected`), which no session no Human attends writes there.
export const nestedProtected = (segments, hosts = HOSTS) => hosts.some((host) => typeof host.nestedProtected === 'function' && host.nestedProtected(segments) === true);

// The handoff continue routes `host` can do, of CONTINUE_ROUTES in lib/config-schema.mjs; none for a host that names none.
export const continueRoutes = (host) => host.capabilities.handoffContinue?.routes ?? [];

// What each host says about the tracker guard, as { host, ...capability }.
export const trackerGuards = (hosts = HOSTS) => hosts.map((host) => ({ host, ...host.capabilities.trackerGuard }));
