// The hosts the plugin runs on, one adapter a file, and the calls the shared code makes instead of reading a host's
// variables or naming its tools. docs/providers/adding-a-host.md says what an adapter declares; test/adapters.test.mjs
// checks each one. Hooks load this file on every call, so it and the adapters stay small and read no file when loaded.

import path from 'node:path';

import claudeCode from './claude-code.mjs';
import codex from './codex.mjs';
import opencode from './opencode.mjs';

// Detection order (detectHost): Codex first, because a Codex started from a Claude Code shell inherits that shell's
// variables; OpenCode last, because its environment rule is the weakest: any process started from an OpenCode shell
// inherits OPENCODE=1 and OPENCODE_SESSION_ID, so that rule answers only when no other host's whole detection does.
export const HOSTS = Object.freeze([codex, claudeCode, opencode]);

// A process no adapter claims. Never reported as one of the hosts: its name says it is unknown, and its AI has no brand.
// Payloads and responses pass through every adapter, so a host detection cannot fail open on what a known host sends.
export const UNKNOWN_HOST = Object.freeze({
  id: 'unknown',
  name: 'unknown',
  ai: 'the AI',
  sessionId: () => null,
  agentName: () => null,
  effort: () => null,
  subagentEffort: () => null,
  runEnv: () => null,
  toolName: (name) => HOSTS.reduce((each, host) => host.toolName(each), name),
  serverSpelling: (server) => server,
  nativeToolName: (standard) => standard,
  rawToolName: (standard) => standard,
  toolResponse: (response) => HOSTS.flatMap((host) => host.toolResponse(response)),
  // Every adapter's reading of a shell call's response: the first output one reads, and interrupted when any says so.
  shellOutput: (response) => {
    const read = HOSTS.map((host) => host.shellOutput?.(response) ?? { output: null, interrupted: false });
    return { output: read.find((each) => typeof each.output === 'string')?.output ?? null, interrupted: read.some((each) => each.interrupted === true) };
  },
  // A host no adapter claims: its exit status is unknown, so a run is judged by its counts alone.
  shellRun: (response) => {
    const read = HOSTS.map((host) => host.shellRun?.(response)).find((each) => each?.finished);
    return read ? { ...read, exitZero: false } : { output: null, finished: false, exitZero: false };
  },
  hookInput: (input) => HOSTS.reduce((each, host) => host.hookInput(each), input),
  // Nothing says whether this host would let a session push, so a run starts.
  capabilities: Object.freeze({ pushPermission: () => ({ answer: 'unknown' }) }),
});

// The host of this process, from its environment and, in a hook, its payload, in two passes. First, the host whose mark
// the payload carries (an adapter's optional `payloadMark`), in HOSTS order, before any environment is read: a hook's
// payload is written by its host alone, so a hook a bridge runs is that host's whatever variables its process
// inherited. Then each host's whole `detect`, in HOSTS order. A host that declares no mark, as a test's own host does,
// is read by its `detect` alone.
export const detectHost = ({ env = process.env, input = {} } = {}, hosts = HOSTS) =>
  hosts.find((host) => host.payloadMark?.(input) === true)
  ?? hosts.find((host) => host.detect({ env, input }))
  ?? UNKNOWN_HOST;

// The session and agent a command runs under, from its environment, each null when the host does not tell.
export function sessionIdentity(env = process.env) {
  const host = detectHost({ env });
  return { session: host.sessionId(env), agent: host.agentName(env) };
}

// Whether `entry`, an AskUserQuestion result entry of a session transcript, carries a host's positive marks of an answer
// the Human gave in its terminal, by an adapter's `humanAnswer`. A host whose adapter has none never gives such an answer,
// so a rule that needs one refuses there.
export const humanAnswer = (entry, hosts = HOSTS) => hosts.some((host) => host.humanAnswer?.(entry) === true);

// The folders under the account's home folder `home` where any host keeps the transcripts its `ownTranscript` vouches
// for: the write guard refuses them to every unattended session (lib/unattended-write.mjs).
export const transcriptFolders = (home, hosts = HOSTS) => hosts.flatMap((host) => host.transcriptFolders?.(home) ?? []);

// The prompt the Human typed into a session, as the adapter of the host the call runs under (`input`, a hook's
// payload) reads its transcript: { file, isHuman }, where `file` is the real path of the session's own transcript, kept
// where the session cannot write (an adapter's `ownTranscript`), and `isHuman(entry)` its `humanPrompt`; null when that
// host has neither, or the payload's transcript is not the session's own. Never another host's adapter.
export function humanPrompts(input, hosts = HOSTS) {
  const host = detectHost({ input }, hosts);
  if (typeof host.humanPrompt !== 'function' || typeof host.ownTranscript !== 'function') return null;
  const file = host.ownTranscript(input?.transcript_path, { session: input?.session_id });
  // Checked again after the read: the entries count only while the path still names the session's own transcript.
  return file ? { file, isHuman: (entry) => host.humanPrompt(entry) === true, still: () => host.ownTranscript(file, { session: input?.session_id }) === file } : null;
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

// The variables that say which session a process belongs to, whether a Human attends that session, and its host
// process. A reviewer or a test runs without them.
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
// Every path in it is as the host's file tool resolves it (hostPath), as a leading `~` the host expands: the one resolver
// every guard of a file tool reads it through.
export function fileEditOf({ tool_name: tool, tool_input: given }) {
  const host = HOSTS.find((each) => each.fileEditTools.includes(tool));
  const edit = host ? host.fileEdit(tool, given ?? {}) : null;
  if (!edit) return edit;
  const resolve = (file) => hostPath(host, file);
  return {
    ...edit,
    ...(edit.file === undefined ? {} : { file: resolve(edit.file) }),
    ...(Array.isArray(edit.files) ? { files: edit.files.map((each) => ({ ...each, file: resolve(each.file) })) } : {}),
    targets: (edit.targets ?? []).map(resolve),
  };
}

// A path a file tool of `host` names, as the host resolves it: its `filePath`, such as Claude Code's expansion of a
// leading `~`, or the path as it is.
const hostPath = (host, file) => (typeof file === 'string' && typeof host.filePath === 'function' ? host.filePath(file) : file);

// The paths a file-tool read in a tool call names, as the tool names them, a null one standing for the call's folder,
// or null when the tool reads no file through the host's own file tools: a host lists its read tools in
// `fileReadTools` and names their paths with `fileRead(tool, input)`. A host whose reads all run in its shell lists none.
export function fileReadOf({ tool_name: tool, tool_input: given }) {
  const host = HOSTS.find((each) => (each.fileReadTools ?? []).includes(tool));
  return host ? host.fileRead(tool, given ?? {}).map((file) => hostPath(host, file)) : null;
}

// The folders a project keeps `kind` (skills or agents) in, on every host that reads them.
export const projectFolders = (kind) => HOSTS.flatMap((host) => host.projectFolders[kind] ?? []);

// `models` in config.json, per host: { <key>: { model, effort } }.
export const modelChoices = () => Object.fromEntries(HOSTS.map((host) => [host.modelsKey, host.modelChoices]));

// Every host's model prices, as { host, models, rows }: the data lib/model-prices.mjs reads. A host with none has no rows.
export const priceTables = (hosts = HOSTS) => hosts.map((host) => ({ host: host.id, models: host.modelPrices?.models ?? [], rows: host.modelPrices?.rows ?? [] }));

// The host instruction files and folders every host loads from the folders above where a session starts, as { files,
// folders, users }: the names of each, and each host's own user folder under `env`, which it reads for every session,
// with the names of the files in it that host loads as the user's own instructions, each { folder, names }.
export function instructionNames(env = process.env, hosts = HOSTS) {
  const declared = hosts.map((host) => host.instructionFiles).filter(Boolean);
  return {
    files: [...new Set(declared.flatMap((each) => each.files ?? []))],
    folders: [...new Set(declared.flatMap((each) => each.folders ?? []))],
    users: declared.map((each) => ({ folder: each.userFolder?.(env), names: each.globalNames ?? [] })).filter(({ folder }) => typeof folder === 'string' && folder !== ''),
  };
}

// The main checkout's paths every host reads from a session in a linked worktree, as { folders, settings }: the
// folders, from the checkout's root, and the settings files, each { file }.
export function mainCheckoutPaths(hosts = HOSTS) {
  const declared = hosts.map((host) => host.mainCheckoutPaths).filter(Boolean);
  return {
    folders: [...new Set(declared.flatMap((each) => each.folders ?? []))],
    settings: declared.flatMap((each) => each.settings ?? []).filter((each) => typeof each?.file === 'string'),
  };
}

// The host programs' subcommands that write the host's own config, as { programs, subcommands, valueOptions }, from
// each adapter's `configCommands`: each subcommand a list of words, as `['mcp', 'add']`, and `valueOptions` the global
// options that take the next word, skipped before it. A host that names none adds none.
export const configCommands = (hosts = HOSTS) => hosts.map((host) => host.configCommands)
  .filter((each) => Array.isArray(each?.programs) && Array.isArray(each.subcommands));

// Every host's own programs, as `claude` and `opencode`: those that start its sessions (`sessionStart`) and those whose
// subcommands write its config (`configCommands`), which a package runner's call may name anywhere (package-runner.mjs).
export const hostPrograms = (hosts = HOSTS) => [...new Set(hosts.flatMap((host) => [...(host.sessionStart?.programs ?? []), ...(host.configCommands?.programs ?? [])]))];

// The npm packages that install a host's program, as { package: program }, from each adapter's optional `packages`: a
// package runner's call of one runs that program (package-runner.mjs), whatever the package's last part is named.
export const packagePrograms = (hosts = HOSTS) => Object.fromEntries(hosts.flatMap((host) => Object.entries(host.packages ?? {})));

// The files and folders where the hosts keep their own logins and the state of their services, for the user whose home
// is `home` under `env`, which Claude Code's confined sandbox denies reading and its sandbox proof tries; Codex's sandbox
// takes no such list (docs/providers/codex.md, its residuals). From each adapter's optional `credentialStores({ env,
// home })`: their union, each an absolute path of plain text.
export const credentialStores = ({ env = process.env, home } = {}, hosts = HOSTS) => [...new Set(hosts.flatMap((host) => host.credentialStores?.({ env, home }) ?? []))]
  .filter((each) => typeof each === 'string' && path.isAbsolute(each) && !CONTROL.test(each));

// The local services the hosts run that start a session no guard holds, each { name, ports, stores }: from each
// adapter's optional `localService` ({ ports }, its fixed ports), with `stores` its own credentialStores, which hold the
// service's password, for the user whose home is `home` under `env`.
export const localServices = ({ env = process.env, home } = {}, hosts = HOSTS) => hosts
  .filter((host) => Array.isArray(host.localService?.ports))
  .map((host) => ({ name: host.name, ports: host.localService.ports, stores: credentialStores({ env, home }, [host]) }));

// The host files of a checkout no session no Human attends writes, from its root, as every host declares them
// (`protectedPaths`): their union, so a session of one host cannot plant what another loads. The write guard refuses
// them at the root of the session's worktree, of each checkout nested in it, of each folder between the two, and of its
// attempt's clone (lib/unattended-write.mjs hostRefused).
export const protectedPaths = (hosts = HOSTS) => [...new Set(hosts.flatMap((host) => host.protectedPaths ?? []))];

// Whether the path whose parts from a confined attempt's clone root, or from a temporary folder, are `segments` is a
// host file some host loads from any depth (`nestedProtected`), which no session no Human attends writes there.
export const nestedProtected = (segments, hosts = HOSTS) => hosts.some((host) => typeof host.nestedProtected === 'function' && host.nestedProtected(segments) === true);

// The globs, from a confined clone's root, of the host files the hosts load from any depth (an adapter's optional
// `nestedGlobs`): their union, in the `**` form git and a sandbox both read.
export const nestedGlobs = (hosts = HOSTS) => [...new Set(hosts.flatMap((host) => host.nestedGlobs ?? []))];
// The same globs as git pathspecs, in any case: git's glob magic matches a `**/` glob at the root too.
export const nestedPathspecs = (hosts = HOSTS) => nestedGlobs(hosts).map((glob) => `:(glob,icase)${glob}`);

// Whether a protected name is a file: one ending .json or .jsonc. Any other is a folder.
export const protectedFile = (name) => /\.jsonc?$/u.test(name);

// The placeholders of the root host files the hosts other than `host` protect: a folder, or a file holding `{}`. The
// starting host's own protected paths are left out, not only its own placeholders, since it may leave one out on purpose.
export const otherPlaceholders = (host, hosts = HOSTS) => protectedPaths(hosts)
  .filter((each) => !(host?.protectedPaths ?? []).includes(each))
  .map((each) => (protectedFile(each) ? { path: each, text: '{}\n' } : { path: each, folder: true }));

// The handoff continue routes `host` can do, of CONTINUE_ROUTES in lib/config-schema.mjs; none for a host that names none.
export const continueRoutes = (host) => host.capabilities.handoffContinue?.routes ?? [];

// What a host says of a push to the repository's remote, before a run no Human attends starts work
// (docs/providers/adding-a-host.md, capabilities.pushPermission). `ask` is { repository, session, cwd, env }, with
// `repository` as `host/owner/repo`.
export const PUSH_ANSWERS = Object.freeze(['allowed', 'denied', 'unknown']);
const DENIAL_FIELDS = ['setting', 'file', 'why', 'fix'];
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const UNKNOWN_PUSH = Object.freeze({ answer: 'unknown' });

// The host's answer, never thrown: { answer: 'allowed' }, { answer: 'unknown' }, or { answer: 'denied', setting, file,
// why, fix }. Unknown for a host without the capability, one that throws or answers outside PUSH_ANSWERS, and a denial
// missing one of its four strings, with a control character in one, or with a `file` that is not absolute: a denial that
// cannot name its setting and its file is not clear.
export function pushPermission(host, ask) {
  try {
    const read = host?.capabilities?.pushPermission?.(ask);
    if (typeof read?.then === 'function') {
      Promise.resolve(read).catch(() => {});
      return UNKNOWN_PUSH;
    }
    if (!PUSH_ANSWERS.includes(read?.answer)) return UNKNOWN_PUSH;
    if (read.answer !== 'denied') return { answer: read.answer };
    const denial = Object.fromEntries(DENIAL_FIELDS.map((field) => [field, read[field]]));
    const clear = Object.values(denial).every((value) => typeof value === 'string' && value.trim() !== '' && !CONTROL.test(value));
    return clear && path.isAbsolute(denial.file) ? { answer: 'denied', ...denial } : UNKNOWN_PUSH;
  } catch {
    return UNKNOWN_PUSH;
  }
}

// Whether `host` wakes a subagent that ended its turn with the report of `child`, one of its background tasks, from the
// adapter's `capabilities.wakesOnChildReport`. A host that declares none wakes it for no task.
export const wakesOnReport = (host, child) => host.capabilities.wakesOnChildReport?.taskTypes?.includes(child?.type) === true;

// Whether `host` starts a subagent that ended its turn again when `child`, one of its background tasks, finishes: with the
// child agent's report (wakesOnReport) or with the notice of a shell's end (`capabilities.wakesOnTaskEnd`).
export const wakesOnEnd = (host, child) => wakesOnReport(host, child) || host.capabilities.wakesOnTaskEnd?.taskTypes?.includes(child?.type) === true;

// What each host says about the tracker guard, as { host, ...capability }.
export const trackerGuards = (hosts = HOSTS) => hosts.map((host) => ({ host, ...host.capabilities.trackerGuard }));
