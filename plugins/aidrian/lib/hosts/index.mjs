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

// The folders a project keeps `kind` (skills or agents) in, on every host that reads them.
export const projectFolders = (kind) => HOSTS.flatMap((host) => host.projectFolders[kind] ?? []);

// `models` in config.json, per host: { <key>: { model, effort } }.
export const modelChoices = () => Object.fromEntries(HOSTS.map((host) => [host.modelsKey, host.modelChoices]));

// What each host says about the tracker guard, as { host, ...capability }.
export const trackerGuards = (hosts = HOSTS) => hosts.map((host) => ({ host, ...host.capabilities.trackerGuard }));
