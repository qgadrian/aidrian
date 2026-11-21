// Codex's adapter. docs/providers/adding-a-host.md lists the fields; docs/providers/codex.md says what was checked here.

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { attachLine, findProcesses, logLimit, processEnded, sessionNote, startProject, stopLine, stopProcess } from './codex-exec.mjs';
import { responseObjects } from './response.mjs';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// An app connector's tool reaches a hook as mcp__codex_apps__<connector>__<tool> (codex-rs/core/src/tools/handlers/mcp.rs
// at rust-v0.166.0, `hook_tool_name`), which reads as one server for every connector. The model's own flat name for it,
// mcp__codex_apps__<connector>_<tool>, is taken too, so a Codex that sends that one is not silently unguarded;
// a connector whose name holds an underscore splits at its first one in that flat form, which only names it differently.
const APP_TOOL = /^mcp__codex_apps__(.+?)__(.+)$/u;
const APP_FLAT_TOOL = /^mcp__codex_apps__([^_]+)_(.+)$/u;

const toolName = (name) => {
  if (typeof name !== 'string') return name;
  const match = APP_TOOL.exec(name) ?? APP_FLAT_TOOL.exec(name);
  return match ? `mcp__codex_apps_${match[1]}__${match[2]}` : name;
};

// Its file edits all go through one tool (codex-rs/core/src/tools/hook_names.rs at rust-v0.166.0).
const RAW_TOOLS = { Edit: 'apply_patch', Write: 'apply_patch', NotebookEdit: 'apply_patch' };

// What its model calls a standard tool that it names otherwise: its question tool is request_user_input
// (core/src/tools/handlers/request_user_input.rs, named in the 0.167.0 binary).
const NATIVE_TOOLS = { AskUserQuestion: 'request_user_input' };

// A connector's tool in the standard form, as the two names above undo it.
const STANDARD_APP_TOOL = /^mcp__codex_apps_(.+?)__(.+)$/u;

// Codex replaces every character outside [A-Za-z0-9_] in a tool's qualified name (codex-mcp/src/mcp/mod.rs at rust-v0.166.0,
// `sanitize_responses_api_tool_name`), so the server linear-server reaches a hook as mcp__linear_server__<tool>.
const serverSpelling = (server) => server.replace(/[^A-Za-z0-9_]/gu, '_');

// The GitHub connector's merge, comment, and ready tools, and the GitHub MCP server's tool each stands for, with `fields` as
// { its field: the connector's }. The names and inputs come from the connector catalog a 0.166.0 install cached; OpenAI's
// servers serve that catalog, so a new name there passes unchecked. hooks.json lists each one, as Codex sends it and in the flat form.
// `enable_auto_merge` is a merge, as `gh pr merge --auto` is, and names no head. docs/providers/codex.md#github-through-the-app-connector.
const MERGE = 'mcp__github__merge_pull_request';
const githubTools = {
  mcp__codex_apps_github__merge_pull_request: { as: MERGE, repo: 'repository_full_name', fields: { pullNumber: 'pr_number', sha: 'expected_head_sha' } },
  mcp__codex_apps_github__enable_auto_merge: { as: MERGE, repo: 'repository_full_name', fields: { pullNumber: 'pr_number' } },
  mcp__codex_apps_github__add_comment_to_issue: { as: 'mcp__github__add_issue_comment', repo: 'repo_full_name', fields: { issue_number: 'pr_number', body: 'comment' } },
  mcp__codex_apps_github__reply_to_review_comment: { as: 'mcp__github__add_reply_to_pull_request_comment', repo: 'repo_full_name', fields: { pullNumber: 'pr_number', body: 'comment' } },
  mcp__codex_apps_github__add_review_to_pr: { as: 'mcp__github__pull_request_review_write', repo: 'repo_full_name', fields: { pullNumber: 'pr_number', body: 'review' } },
  // It only marks a draft ready, so it stands for the server's draft tool with `draft: false`. Its name and input come from the
  // catalog a Codex 0.167.0 install cached on 2026-11-06; the connector's own update_pull_request takes no draft.
  mcp__codex_apps_github__mark_pull_request_ready_for_review: { as: 'mcp__github__update_pull_request_draft_state', repo: 'repository_full_name', fields: { pullNumber: 'pr_number' }, fixed: { draft: false } },
};

// A `*** ... File:` line opens a section of the patch, and `*** Move to:` renames the one above.
const PATCH_TARGET = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gmu;

function patchFiles(text) {
  const files = [];
  for (const line of text.split(/\r?\n/u)) {
    const header = /^\*\*\* (?:Add|Update) File: (.+)$/u.exec(line);
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (header) files.push({ file: header[1].trim(), added: [] });
    else if (move && files.at(-1)?.file) files.at(-1).file = move[1].trim();
    else if (/^\*\*\* /u.test(line)) files.push({ file: null, added: [] });
    else if (line.startsWith('+') && files.at(-1)?.file) files.at(-1).added.push(line.slice(1));
  }
  return files.filter(({ file }) => file);
}

// Its command line that starts or resumes a session, which lib/handoff-guard.mjs hostSessionStartDenial refuses a
// subagent and a session the background handoff route started. `codex` with no subcommand, `exec`, `resume`, `cloud`,
// a prompt, and any word this list does not name start one; these manage its login, servers, and features, and start
// none, a list not checked against a live Codex. `codex mcp-server` and `app-server` serve a client, so they count.
const NO_SESSION = new Set(['login', 'logout', 'mcp', 'completion', 'features', 'help']);
const INFO = new Set(['-V', '--version', '-h', '--help']);
const startsSession = (args) => {
  const first = args[0]?.dynamic ? null : args[0]?.text;
  if (first === undefined) return true;
  return !INFO.has(first) && !NO_SESSION.has(first);
};

const configFile = (env) => path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');

// The lines of the first section whose header `matches`, without the header, or null when there is none.
function section(lines, matches) {
  const at = lines.findIndex(matches);
  if (at < 0) return null;
  const after = lines.slice(at + 1);
  const end = after.findIndex((line) => line.startsWith('['));
  return end < 0 ? after : after.slice(0, end);
}

const turnedOff = (lines) => lines.some((line) => /^\s*enabled\s*=\s*false\b/u.test(line));
const holdsHash = (lines) => lines.some((line) => /^\s*trusted_hash\s*=\s*(?:"[^"]+"|'[^']+')/u.test(line));

// Whether Codex would run this plugin's tracker hooks: 'trusted'; 'untrusted'; 'off', when the plugin or one of those hooks is
// turned off; or 'absent' when no Codex here has the plugin installed. Codex keeps one `[hooks.state."<plugin
// id>:hooks/hooks.json:<event>:<group>:<handler>"]` per hook, and a hook runs when that holds a `trusted_hash` and
// `enabled` is not false (hooks/src/engine/discovery.rs:1000-1020 at rust-v0.166.0). A hash an update made stale still reads
// as trusted: only `/hooks` can tell, since that takes hashing the hook as Codex does.
// The answer is one of those four words, so no value of the file, which holds a token, leaves this function.
function hookTrust(env) {
  let lines;
  try {
    lines = readFileSync(configFile(env), 'utf8').split(/\r?\n/u);
  } catch {
    return 'absent';
  }
  const plugin = section(lines, (line) => /^\[plugins\."aidrian@[^"]+"\]/u.test(line));
  if (plugin === null) return 'absent';
  if (turnedOff(plugin)) return 'off';
  const states = trackerHookKeys().map((key) => section(lines, (line) => /^\[hooks\.state\."[^"]*aidrian[^"]*hooks\/hooks\.json:/u.test(line) && line.trimEnd().endsWith(`:${key}"]`)));
  if (states.some((state) => state !== null && turnedOff(state))) return 'off';
  return states.every((state) => state !== null && holdsHash(state)) ? 'trusted' : 'untrusted';
}

// Whether Codex would run every hook of this plugin, for a project run's session: the answer hookTrust gives, but over
// every handler hooks.json lists, of every event and group, each matched by this plugin's own id as its `[plugins."<id>"]`
// table names it: a session no Human attends is held by many hooks, not by the tracker hooks alone.
function allHooksTrust(env) {
  let lines;
  try {
    lines = readFileSync(configFile(env), 'utf8').split(/\r?\n/u);
  } catch {
    return 'absent';
  }
  const ids = lines.map((line) => /^\[plugins\."(aidrian@[^"]+)"\]\s*$/u.exec(line.trimEnd())?.[1]).filter(Boolean);
  if (ids.length === 0) return 'absent';
  const answers = ids.map((id) => {
    if (turnedOff(section(lines, (line) => line.trimEnd() === `[plugins."${id}"]`))) return 'off';
    const states = allHookKeys().map((key) => section(lines, (line) => line.trimEnd() === `[hooks.state."${id}:hooks/hooks.json:${key}"]`));
    if (states.some((state) => state !== null && turnedOff(state))) return 'off';
    return states.every((state) => state !== null && holdsHash(state)) ? 'trusted' : 'untrusted';
  });
  if (answers.includes('trusted')) return 'trusted';
  return answers.includes('off') ? 'off' : 'untrusted';
}

// The trust key of every handler hooks.json lists, `<event>:<group>:<handler>`, with the event in Codex's snake case.
function allHookKeys() {
  const { hooks } = JSON.parse(readFileSync(new URL('../../hooks/hooks.json', import.meta.url), 'utf8'));
  const snake = (event) => event.replace(/[A-Z]/gu, (letter, at) => `${at ? '_' : ''}${letter.toLowerCase()}`);
  return Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group, at) => group.hooks.map((_hook, handler) => `${snake(event)}:${at}:${handler}`)));
}

// The folders `[sandbox_workspace_write] writable_roots` names in Codex's config.toml, each as written, or [] when it
// names none. A value it cannot read gives [null].
function writableRoots(env) {
  let lines;
  try {
    lines = readFileSync(configFile(env), 'utf8').split(/\r?\n/u);
  } catch {
    return [];
  }
  const sandbox = section(lines, (line) => /^\[sandbox_workspace_write\]\s*(?:#.*)?$/u.test(line)) ?? [];
  const text = sandbox.join('\n');
  const at = text.search(/^\s*writable_roots\s*=/mu);
  if (at < 0) return [];
  const rest = text.slice(at);
  const end = rest.indexOf(']');
  if (end < 0) return [null];
  return [...rest.slice(0, end).matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu)].map((match) => match[1] ?? match[2]);
}

// The temporary folders Codex's workspace-write sandbox lets a session write besides its writable roots: /tmp, unless
// config.toml sets `exclude_slash_tmp = true` under `[sandbox_workspace_write]`, and the folder $TMPDIR names, unless it
// sets `exclude_tmpdir_env_var = true` (Codex's config reference).
function tempRoots(env) {
  let lines;
  try {
    lines = readFileSync(configFile(env), 'utf8').split(/\r?\n/u);
  } catch {
    lines = [];
  }
  const sandbox = section(lines, (line) => /^\[sandbox_workspace_write\]\s*(?:#.*)?$/u.test(line)) ?? [];
  const excluded = (key) => sandbox.some((line) => new RegExp(String.raw`^\s*${key}\s*=\s*true\b`, 'u').test(line));
  const tmpdir = typeof env.TMPDIR === 'string' && path.isAbsolute(env.TMPDIR) ? env.TMPDIR : null;
  return [...(excluded('exclude_slash_tmp') ? [] : ['/tmp']), ...(tmpdir && !excluded('exclude_tmpdir_env_var') ? [tmpdir] : [])];
}

// Why the writable roots of Codex's config, or the temporary folders its sandbox writes (tempRoots), would let a session
// write in one of `guarded`, real absolute paths such as the main checkout's git folder, the state root, the mark
// folders, the sign-off store's, and the runs folder, or null.
function writableRootsProblem(env, guarded) {
  for (const root of tempRoots(env)) {
    let real = root;
    try {
      real = realpathSync(root);
    } catch {}
    const holds = guarded.find((folder) => real === folder || folder.startsWith(`${real}${path.sep}`) || real.startsWith(`${folder}${path.sep}`));
    if (holds) return `Codex's workspace-write sandbox lets a session write ${root}, which reaches ${holds}, a folder a session no Human attends must not write: move the state folder out of it, or set ${root === '/tmp' ? 'exclude_slash_tmp' : 'exclude_tmpdir_env_var'} = true under [sandbox_workspace_write] in config.toml`;
  }
  for (const root of writableRoots(env)) {
    if (typeof root !== 'string') return 'Codex\'s config.toml sets writable_roots for its workspace-write sandbox in a form the gate cannot read';
    const home = env.HOME || homedir();
    const spelled = root.startsWith('~/') ? path.join(home, root.slice(2)) : root;
    if (!path.isAbsolute(spelled)) return `Codex's config.toml makes ${root} writable, a path that is not absolute`;
    let real = path.resolve(spelled);
    try {
      real = realpathSync(real);
    } catch {
      // Not there yet: its spelling.
    }
    const reaches = guarded.find((folder) => real === folder || real.startsWith(`${folder}${path.sep}`) || folder.startsWith(`${real}${path.sep}`));
    if (reaches) return `Codex's config.toml makes ${root} writable in its workspace-write sandbox, which reaches ${reaches}, a folder a session no Human attends must not write`;
  }
  return null;
}

// Why a session `codex exec --sandbox workspace-write` starts could neither push nor reach the forge, or null: that
// sandbox turns the network off unless config.toml sets `network_access = true` under `[sandbox_workspace_write]`
// (Codex's config reference). Read from the same file as hookTrust, and no value of it leaves this function.
function sandboxNetworkProblem(env) {
  let lines;
  try {
    lines = readFileSync(configFile(env), 'utf8').split(/\r?\n/u);
  } catch {
    lines = [];
  }
  const sandbox = section(lines, (line) => /^\[sandbox_workspace_write\]\s*(?:#.*)?$/u.test(line)) ?? [];
  if (sandbox.some((line) => /^\s*network_access\s*=\s*true\b/u.test(line))) return null;
  return 'Codex runs the session in its workspace-write sandbox, whose network is off unless its config.toml sets network_access = true under [sandbox_workspace_write], so the session could neither push its branch nor reach the forge';
}

// Why the user's Codex config.toml could widen the network proxy a project start turns on, or null: any line that is no
// comment and names `network_proxy`, as a `[features.network_proxy]` table, a `network_proxy` key of `[features]`, or a
// dotted key. Until a live run shows that the start's `-c features.network_proxy.domains` table replaces the user's
// rather than merging with it (docs/providers/codex.md live check 12), a user allow rule could open a host the team
// never listed. Read from the same file as hookTrust.
function networkProxyProblem(env) {
  let lines;
  try {
    lines = readFileSync(configFile(env), 'utf8').split(/\r?\n/u);
  } catch {
    return null;
  }
  if (!lines.some((line) => !/^\s*#/u.test(line) && /network_proxy/u.test(line))) return null;
  return 'Codex\'s config.toml sets a features.network_proxy key, and until a live run shows that the start\'s own allow rules replace the user\'s rather than merge with them, a rule there could open a host the team never listed; remove the network_proxy settings from config.toml, then start again';
}

// The trust keys of the tracker hooks, `<event>:<group>:<handler>`, read from hooks.json so a reordered file cannot go stale.
// Trust is per hook, so trust in another of this plugin's hooks says nothing about these.
function trackerHookKeys() {
  const { hooks } = JSON.parse(readFileSync(new URL('../../hooks/hooks.json', import.meta.url), 'utf8'));
  const keys = [];
  for (const [event, script] of [['PreToolUse', 'hook-tracker-pre.mjs'], ['PostToolUse', 'hook-tracker-post.mjs']]) {
    hooks[event].forEach((group, at) => group.hooks.forEach((hook, handler) => {
      if (hook.command.includes(script)) keys.push(`${event === 'PreToolUse' ? 'pre_tool_use' : 'post_tool_use'}:${at}:${handler}`);
    }));
  }
  return keys;
}

export default {
  id: 'codex',
  name: 'Codex',
  ai: 'Codex',
  // How the plugin's hooks reach it: it reads hooks/hooks.json as it is, and has an event of each name (docs/providers/adding-a-host.md).
  delivery: 'hooks-json',
  modelsKey: 'codex',
  // Codex reads any model name and names these efforts. docs/config.md#models cites both.
  modelChoices: { model: null, effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'] },
  // No prices: nothing reads its transcripts (capabilities.transcripts), so no cost is computed for its sessions, and a model
  // no table prices is reported as unpriced, at $0. Its price page is https://developers.openai.com/api/docs/pricing;
  // rows come with a transcript reader, as the model-prices skill of this repository says.
  modelPrices: { models: [], rows: [] },
  identityVars: ['CODEX_THREAD_ID'],
  detectVars: ['CODEX_THREAD_ID', 'PLUGIN_ROOT'],
  // A tool hook's payload holds `turn_id`, a plugin hook has PLUGIN_ROOT equal to CLAUDE_PLUGIN_ROOT, and a shell Codex runs
  // has CODEX_THREAD_ID (hooks/src/schema.rs, hooks/src/engine/discovery.rs:314-316, core/src/exec_env.rs at rust-v0.166.0).
  // PLUGIN_ROOT alone may be inherited from anywhere, and CODEX_THREAD_ID alone by a Claude Code started from a Codex shell,
  // which CLAUDECODE tells apart.
  detect: ({ env, input }) => typeof input?.turn_id === 'string'
    || (Boolean(env.PLUGIN_ROOT) && env.PLUGIN_ROOT === env.CLAUDE_PLUGIN_ROOT)
    || (Boolean(env.CODEX_THREAD_ID) && env.CLAUDECODE !== '1'),
  sessionId: (env) => env.CODEX_THREAD_ID || null,
  agentName: () => null,
  effort: () => null,
  runEnv: () => null,
  // Codex installs this plugin's agents as roles named `aidrian-<agent>`.
  pluginAgentPrefix: 'aidrian-',
  agentAliases: (type) => (type.startsWith('aidrian-') ? [type.slice('aidrian-'.length)] : []),
  toolName,
  githubTools,
  serverSpelling,
  // The name the model calls a tool by: the namespace and the name it sees, run together, with one underscore here.
  nativeToolName(standard) {
    if (Object.hasOwn(NATIVE_TOOLS, standard)) return NATIVE_TOOLS[standard];
    const match = STANDARD_APP_TOOL.exec(standard);
    return match ? `mcp__codex_apps__${match[1]}_${match[2]}` : standard;
  },
  // What a tool reaches a hook's matcher as, before any mapping.
  rawToolName(standard) {
    if (RAW_TOOLS[standard]) return RAW_TOOLS[standard];
    const match = STANDARD_APP_TOOL.exec(standard);
    return match ? `mcp__codex_apps__${match[1]}__${match[2]}` : standard;
  },
  // The MCP result as it comes off the wire: `content`, and sometimes `structuredContent`, which is that tool's own object.
  toolResponse(response) {
    const [direct, ...rest] = responseObjects(response);
    const structured = direct?.structuredContent ?? direct?.structured_content;
    return [direct, ...(isObject(structured) ? [structured] : []), ...rest].filter(Boolean);
  },
  // A shell call's response, as `{ output, interrupted }`: Codex sends the command's output as one string, stdout and stderr
  // together, and a call it stopped fires no PostToolUse (codex-rs/core/src/tools/context.rs, ExecCommandToolOutput
  // post_tool_use_response, at rust-v0.169.0; test/fixtures/hosts/codex/bash-post.json).
  shellOutput: (response) => ({ output: typeof response === 'string' ? response : null, interrupted: false }),
  // A finished shell call, as the check-run record reads it (lib/check-runs.mjs): Codex runs PostToolUse for a call that
  // exited non-zero too, and sends no exit status, so `exitZero` is false and a run is judged by its counts alone.
  shellRun: (response) => ({ output: typeof response === 'string' ? response : null, finished: typeof response === 'string', exitZero: false }),
  // `raw_tool_name` keeps what Codex sent, so a pattern a project wrote in that form still matches (lib/hosts/index.mjs toolNames).
  hookInput(input) {
    const name = toolName(input.tool_name);
    return name === input.tool_name ? input : { ...input, tool_name: name, raw_tool_name: input.tool_name };
  },
  sessionStart: { programs: ['codex'], starts: startsSession },
  // The subcommands of its program that write its own user config: MCP servers and the login it keeps, and its global
  // options that take the next word. The agent gate hook refuses them to a session no Human attends
  // (lib/unattended-write.mjs).
  configCommands: {
    programs: ['codex'],
    subcommands: [['mcp', 'add'], ['mcp', 'remove'], ['login'], ['logout']],
    valueOptions: ['-p', '--profile', '-c', '--config', '-m', '--model', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--enable', '--disable', '--add-dir', '--local-provider'],
  },
  fileEditTools: ['apply_patch'],
  fileEdit(_tool, given) {
    const text = String(given.command ?? given.input ?? '');
    return { shape: 'patch', text, files: patchFiles(text), targets: [...text.matchAll(PATCH_TARGET)].map((match) => match[1].trim()) };
  },
  projectFolders: {},
  // No host file of a checkout is protected beyond what every host's are: its config is the user's, in CODEX_HOME.
  protectedPaths: [],
  // The instruction files and folder it loads from the folders between the project root and the folder a session
  // starts in, its own user folder, CODEX_HOME, and `globalNames`, the files there it loads as the user's own guidance
  // for every session: AGENTS.override.md, else AGENTS.md (developers.openai.com/codex/guides/agents-md). A project run
  // refuses a start under any other such file a review did not see (lib/project-trust.mjs ancestorProblem).
  instructionFiles: {
    files: ['AGENTS.md', 'AGENTS.override.md'],
    folders: ['.codex'],
    userFolder: (env) => env.CODEX_HOME || path.join(env.HOME || homedir(), '.codex'),
    globalNames: ['AGENTS.md', 'AGENTS.override.md'],
  },
  // What a session in a linked worktree reads from the main checkout: nothing its docs name. Its instructions load from
  // the worktree's own folders up to the project root, which instructionFiles covers.
  mainCheckoutPaths: { folders: [], settings: [] },
  capabilities: {
    // Codex keeps its own transcript format, which lib/transcript.mjs does not read.
    transcripts: false,
    trackerGuard: {
      verified: 'source',
      evidence: 'rust-v0.166.0 source, a live codex exec call of the Linear app, and a recorded payload; no live hook has run',
      // MCP servers and app connectors both go through McpHandler and its PreToolUse hook. Hosted tools reach no hook, but
      // no tracker write goes through one.
      unguardedRoutes: [],
      hookTrust,
      trustStep: 'open Codex and trust them in its hooks panel, /hooks, after each install and update',
      offStep: 'open Codex and turn them back on in its hooks panel, /hooks, or enable the plugin',
    },
    // Nothing here says whether Codex would let a session push to the remote, so the answer is unknown and a run starts.
    pushPermission: () => ({ answer: 'unknown' }),
    // No handoff continue route runs here: session.handoff.continue falls back to none on Codex.
    handoffContinue: { routes: [] },
    // A project run's issue session, through a detached `codex exec` in a fresh clone made for its attempt
    // (hosts/codex-exec.mjs, lib/project-start.mjs): Codex is `confined` to its workspace-write sandbox, with `--add-dir`
    // for what the gate grants. Codex lists no sessions, so a session is known by its process, and a start holds it only
    // once its id, its first tool call, and the agent gate hook's beacon arrive. `verified`: fixtures only, with a fake
    // `codex`; no live Codex has run it, so a run starts it only where the default branch sets projectRun.unverifiedHosts
    // (docs/providers/codex.md#project-start lists the live checks). `hookTrust` must answer 'trusted' for every hook of
    // the plugin, and `access` says why a session it starts could not push or reach the forge, or could write a folder
    // the gate guards.
    projectStart: {
      verified: 'unverified',
      evidence: 'fixtures with a fake codex that runs the real agent gate hook; codex exec --json, --add-dir, and the sandbox flags are from Codex\'s docs, not a live run',
      confined: true,
      hookTrust: allHooksTrust,
      trustStep: 'open Codex and trust every hook of this plugin in its hooks panel, /hooks, after each install and update',
      access: ({ env, guarded = [] }) => sandboxNetworkProblem(env) ?? networkProxyProblem(env) ?? writableRootsProblem(env, guarded),
      sessionNote,
      start: ({ cwd, name, prompt, env, hold, identify, run, wait, log, beacon, grants, domains, cacheVars, localBinding }) => startProject({ cwd, name, prompt, env, hold, identify, log, beacon, grants, domains, cacheVars, localBinding, run, wait }),
      stop: ({ id, started, run }) => stopProcess({ id, started, run }),
      ended: ({ id, run }) => processEnded({ id, run }),
      find: ({ cwd, run }) => findProcesses({ cwd, run }),
      // Whether the session's turn failed on a usage or rate limit, from Codex's own `turn.failed` record in the run log
      // (codex-exec.mjs logLimit); unverified, as no live `codex exec` has shown that record.
      limitOf: ({ log, now }) => logLimit({ log, now }),
      attachLine,
      stopLine,
    },
  },
};
