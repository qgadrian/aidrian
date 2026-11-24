// OpenCode's adapter, for OpenCode 2.0 and later. docs/providers/adding-a-host.md lists the fields.
// OpenCode runs no hooks.json: the aidrian bridge, a server plugin, sends a hook script the standard envelope with
// OpenCode's own tool name, input, and result inside, and a top-level `opencode` object that marks the payload as
// OpenCode's. This file maps that to the standard names, so the hook scripts read it as they read any host's.
// The facts below come from OpenCode 2.4.0: the types of @opencode/plugin@2.4.0 and the embedded source of its binary.

import { homedir } from 'node:os';
import path from 'node:path';

import { NATIVE_NAMES, RAW_NAMES, standardToolName } from './opencode-names.mjs';
import { setUp } from './opencode-setup.mjs';
import { patchEdit } from './patch.mjs';
import { responseObjects } from './response.mjs';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The bridge puts the mark at the top level of the payload, where only the host process writes; a tool's own input sits
// under `tool_input`, so no tool call can add it.
const payloadMark = (input) => isObject(input?.opencode);

// Whether the path whose parts from a confined clone's root are `segments` is a host file of OpenCode at any depth: a
// `.opencode` folder and all it holds, or a config file, either of which can load plugins, or an `.agents` folder and
// all it holds, whose `skills` it loads. OpenCode 2.4.0 looks for `.claude`, `.agents`, `.opencode`, and both config
// files in the folder a session starts in and in every folder above it up to `/`, with no stop at the git root
// (ConfigDiscovery.discover, read as text from its binary), so a nested one loads into every session started below it.
// Names are compared in lower case, as a disk that folds case reads them.
function nestedProtected(segments) {
  const lower = segments.filter(Boolean).map((each) => each.toLowerCase());
  const last = lower.at(-1);
  return lower.includes('.opencode') || lower.includes('.agents') || last === 'opencode.json' || last === 'opencode.jsonc';
}

// Its command line that starts, resumes, attaches to, or serves a session, which lib/handoff-guard.mjs
// hostSessionStartDenial refuses a subagent and a session the background handoff route started. Read from the help of
// an isolated OpenCode 2.4.0 on 2026-11-23, failing closed: each entry below is a word and its subcommand whose help
// was read in full, says it starts no session, and takes no `--server` flag. A command that takes one talks to the
// background service, which OpenCode "discovers or starts" (2.4.0's own text), and a started service serves sessions,
// so every such command is a start: `models`, `stats`, `reload`, and the subcommands of `session`, `machine`, and
// `auth`, `debug agents`, `config`, and `heap-dump`, and `mcp list`, `auth`, and `logout`, and `plugin list`, `check`,
// and `update`. So are no argument, a directory, `run`, `mini`, `acp`, `serve`, `api`, `pair`, `service start` and
// `restart`, `upgrade` and `update`, which may restart the service, `uninstall`, a word a later version adds, and
// `auth export`, whose help was not read. A word that takes subcommands is never listed alone. A `-h` or `--help`
// anywhere before a `--` prints a command's help and starts nothing, as `opencode serve --help` does; `-v`, `--version`,
// and `--completions` count only as the first word. A help flag past the first word on a line with a word the shell
// expands, such as a variable or a brace list, is no help read: the line stays a start.
const INFO = new Set(['-h', '--help', '-v', '--version', '--completions']);
const HELP = new Set(['-h', '--help']);
export const NO_SESSION = Object.freeze([
  ['debug', 'paths'], ['mcp', 'add'], ['plugin', 'add'], ['plugin', 'remove'],
  ['service', 'status'], ['service', 'stop'], ['service', 'get'], ['service', 'set'], ['service', 'unset'],
].map((entry) => Object.freeze(entry)));

// The folders of its own the user's account holds, under `env`'s XDG folders and their defaults below `home`, as the
// 2.4.0 binary names them: `opencode` in the data folder, which holds auth.json and opencode.db, whose `credential`
// table 2.4.0 imports auth.json into; in the state folder, which holds the background service's registration
// (service.json, service-<channel>.json); and in the config folder and OPENCODE_CONFIG_DIR, which hold the service's
// config, whose `service set env` values may be secrets, and opencode.json, which may hold a provider's key.
function credentialStores({ env = {}, home }) {
  const user = typeof home === 'string' && path.isAbsolute(home) ? home : homedir();
  const named = (name) => (typeof env[name] === 'string' && path.isAbsolute(env[name]) ? [env[name]] : []);
  const folders = [
    ...named('XDG_DATA_HOME'), path.join(user, '.local', 'share'), ...named('XDG_STATE_HOME'), path.join(user, '.local', 'state'),
    ...named('XDG_CONFIG_HOME'), path.join(user, '.config'),
  ].map((each) => path.join(each, 'opencode'));
  return [...new Set([...folders, ...named('OPENCODE_CONFIG_DIR')])];
}
const starts = (args) => {
  const words = args.map((token) => (token.dynamic ? null : token.text));
  if (words.length === 0 || words[0] === null) return true;
  if (INFO.has(words[0])) return false;
  // A help flag past the first word counts only on a line the shell passes as written.
  const options = words.includes('--') ? words.slice(0, words.indexOf('--')) : words;
  if (!args.some((token) => token.dynamic || token.expands) && options.some((word) => HELP.has(word))) return false;
  return !NO_SESSION.some((entry) => entry.every((word, at) => words[at] === word));
};

export default {
  id: 'opencode',
  name: 'OpenCode',
  ai: 'OpenCode',
  // How the plugin's hooks reach it: a bridge plugin runs the hook scripts its routes name, on OpenCode's tool events
  // (docs/providers/adding-a-host.md). A hook no route names does not run here.
  delivery: 'bridge',
  modelsKey: 'opencode',
  // No agents of this plugin run here yet, so no model or effort is read for it, and nothing reads its transcripts.
  modelChoices: { model: null, effort: null },
  modelPrices: { models: [], rows: [] },
  identityVars: ['OPENCODE_SESSION_ID'],
  detectVars: ['OPENCODE', 'OPENCODE_SESSION_ID'],
  payloadMark,
  // Every command its shell tool runs has OPENCODE=1 and OPENCODE_SESSION_ID, the calling session's id. Those variables
  // claim a process only when it holds no hook payload: a payload the bridge sent carries the mark, so one without it,
  // under variables inherited from an OpenCode shell, is another host's hook that lost its own marks, and the unknown host
  // reads it through every adapter. It names no other host's variable: lib/hosts/index.mjs asks it last, so a process
  // another host's detection claims is never read as OpenCode's.
  detect: ({ env, input }) => payloadMark(input)
    || (typeof input?.hook_event_name !== 'string' && env.OPENCODE === '1' && Boolean(env.OPENCODE_SESSION_ID)),
  sessionId: (env) => env.OPENCODE_SESSION_ID || null,
  agentName: () => null,
  effort: () => null,
  runEnv: () => null,
  pluginAgentPrefix: 'aidrian-',
  agentAliases: (type) => (type.startsWith('aidrian-') ? [type.slice('aidrian-'.length)] : []),
  // Its tool names come from one table, opencode-names.mjs. The bridge forwards no MCP tool call, so no MCP name is
  // mapped yet.
  toolName: (name) => standardToolName(name) ?? name,
  serverSpelling: (server) => server,
  nativeToolName: (standard) => NATIVE_NAMES[standard] ?? standard,
  rawToolName: (standard) => RAW_NAMES[standard] ?? standard,
  toolResponse: responseObjects,
  // A shell call's result, `{ output: { output, exitCode }, content, metadata }`: the command's output is the text under
  // `output.output`. The bridge sends only a call that completed, so none is interrupted.
  shellOutput: (response) => ({ output: typeof response?.output?.output === 'string' ? response.output.output : null, interrupted: false }),
  // A marked call reads under its standard name, as the shell tool reads as Bash; `raw_tool_name` keeps what OpenCode sent
  // (lib/hosts/index.mjs toolNames). A name the leaf cannot read stays as it came.
  hookInput(input) {
    if (!payloadMark(input)) return input;
    const standard = standardToolName(input.tool_name, input.opencode.info);
    if (standard === null || standard === input.tool_name) return input;
    return { ...input, tool_name: standard, raw_tool_name: input.tool_name };
  },
  // Its file tools and their inputs, read as text from the tool schemas embedded in the installed OpenCode 2.4.0 binary
  // (the `edit` tool's is { path, oldString, newString, replaceAll }), not from a recorded live payload: `write` { path,
  // content }, `edit` as given, and `patch` { patchText } in the `*** Begin Patch` format. No hook receives a file edit on
  // OpenCode in this version; the conformance suite asks every host to say these.
  fileEditTools: ['edit', 'write', 'patch'],
  fileEdit(tool, given) {
    if (tool === 'write') return { shape: 'write', file: given.path, content: given.content, targets: [given.path] };
    if (tool === 'edit') {
      return { shape: 'edit', file: given.path, edits: [{ old_string: given.oldString, new_string: given.newString, replace_all: given.replaceAll === true }], newText: given.newString, replaceAll: given.replaceAll === true, targets: [given.path] };
    }
    return patchEdit(String(given.patchText ?? ''));
  },
  sessionStart: { programs: ['opencode'], starts },
  // The npm packages that install its program, which a package runner runs as `opencode` (lib/package-runner.mjs).
  packages: { '@opencode/cli': 'opencode', 'opencode-ai': 'opencode' },
  // The subcommands of its program that write its config, a credential, a pairing, the session store, or the program
  // itself, and its global options that take the next word: the agent gate hook refuses them to a session no Human
  // attends (lib/unattended-write.mjs). From the same reading of 2.4.0's help as NO_SESSION: the first twelve were listed
  // before it; `machine add` and `remove` and `pair` write a pairing; `auth` stands whole, as its `export` help was not
  // read; `session import` and `delete` write the store `opencode -c` resumes from; `uninstall`, `upgrade`, and `update`
  // replace or remove the program; and `service stop` stops the service every OpenCode session on the machine uses.
  // `auth` whole does not shadow the four `auth` entries: a lone word matches only as the first word, and an entry of two
  // anywhere in the call, as past the value of an option this list does not name (unattended-shell.mjs runsDeclared).
  configCommands: {
    programs: ['opencode'],
    subcommands: [
      ['mcp', 'add'], ['mcp', 'auth'], ['mcp', 'logout'], ['auth', 'login'], ['auth', 'logout'], ['auth', 'import'], ['auth', 'switch'],
      ['plugin', 'add'], ['plugin', 'remove'], ['plugin', 'update'], ['service', 'set'], ['service', 'unset'],
      ['machine', 'add'], ['machine', 'remove'], ['pair'], ['auth'],
      ['session', 'import'], ['session', 'delete'], ['uninstall'], ['upgrade'], ['update'], ['service', 'stop'],
    ],
    valueOptions: ['--server', '--log-level', '--completions', '--session', '-s', '--prompt'],
  },
  // Its logins and its service's state, which Claude Code's confined sandbox denies reading and its sandbox proof tries;
  // Codex's sandbox takes no such list (lib/hosts/index.mjs credentialStores).
  credentialStores,
  // Its background service, which runs sessions and shell commands as the user for any caller that holds the password
  // in `service.json` of its state folder, one of credentialStores: the port 2.4.0's source gives it on the release
  // channel, on the loopback address. The agent gate hook refuses a session no Human attends a shell command that names
  // the port or a credential store, since a session the service starts meets no guard (lib/handoff-guard.mjs
  // hostServiceDenial).
  localService: { ports: [49374] },
  projectFolders: {},
  // The host files of a checkout a session no Human attends never writes, from its root: `.opencode/plugins/` loads code
  // into the next session there, either config file can name plugins, and 2.4.0 loads skills from the `skills` folder of
  // `.agents` (its opencode.config.compatibility plugin), held whole (lib/unattended-write.mjs).
  protectedPaths: ['.opencode', 'opencode.json', 'opencode.jsonc', '.agents'],
  nestedProtected,
  // The same files at any depth, as globs from a clone's root in the `**` form git and the sandbox both read: a confined
  // session's sandbox denies them, and the write guard lists the git index's links among them.
  nestedGlobs: ['**/.opencode', '**/.opencode/**', '**/opencode.json', '**/opencode.jsonc', '**/.agents', '**/.agents/**'],
  mainCheckoutPaths: { folders: [], settings: [] },
  capabilities: {
    transcripts: false,
    trackerGuard: {
      verified: 'none',
      evidence: 'the bridge forwards no MCP tool call to a hook, so no tracker write is judged on OpenCode',
      unguardedRoutes: [{ name: 'any MCP tool', reason: 'the bridge forwards no MCP tool call to a hook in this version' }],
    },
    // Whether OpenCode is set up to run this plugin here, `setUp({ env, root })`, from its config files alone
    // (opencode-setup.mjs): `aidrian check` names OpenCode's unguarded routes, and the gap below, only then
    // (lib/tracker-check.mjs).
    setUp,
    // What no hook holds on it: the bridge runs no guard, so `aidrian check` names this where OpenCode is set up.
    unguarded: { what: 'no merge guard, Bash rule, or write guard holds an OpenCode session', doc: 'docs/providers/opencode.md#limits' },
    // Nothing here says whether OpenCode would let a session push to the remote.
    pushPermission: () => ({ answer: 'unknown' }),
    handoffContinue: { routes: [] },
  },
};
