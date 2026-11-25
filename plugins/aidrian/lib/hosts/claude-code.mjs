// Claude Code's adapter. Its event and tool names are the standard the shared code reads, so its payload needs no mapping but
// for the GitHub MCP server a plugin installs.
// docs/providers/adding-a-host.md lists the fields; docs/providers/claude-code.md says what was checked on this host.

import { lstatSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

import { attachLine, findLine, findSessions, heldSessions, listBackground, nameMatcher, readAsked, sessionEnded, sessionFinished, startBackground, startChoice, startFolder, startProject, stopBackground, stopLine, stopOwnBackground } from './claude-code-background.mjs';
import { PROJECT_AGENTS, subagentEffort } from './claude-code-agents.mjs';
import { configDir, MODEL_CHOICES } from './claude-code-config.mjs';
import { mergePermission } from './claude-code-merge.mjs';
import { pushPermission } from './claude-code-push.mjs';
import { attended, END_SIGNAL, hasClient, hostProcess, isWrappedHost, PROGRAM } from './claude-code-terminal.mjs';
import modelPrices from './claude-code-prices.mjs';
import { continuedIn, transcriptRoot } from './claude-code-continuation.mjs';
import { transcriptLimit } from './claude-code-limit.mjs';
import { accessProblem, cloneProblem, confineDomains, confineReads, forgetEnvFiles, limitContinueProblem, localBindingRisk, loopbackReach, nestedProtected, PLACEHOLDERS, PROTECTED_PATHS, sessionEnvFile, sessionNote, writeEnvFile } from './claude-code-sandbox.mjs';
import { FOREGROUND, findTask, readTask } from './claude-code-tasks.mjs';
import { trustProblem } from './claude-code-trust.mjs';
import { responseObjects } from './response.mjs';

const agentName = (env) => env.CLAUDE_CODE_AGENT || null;
const effort = (env) => env.CLAUDE_EFFORT || null;
// What a session in a linked worktree reads from the main checkout (the adapter's `mainCheckoutPaths`, below).
const MAIN_CHECKOUT_PATHS = Object.freeze({
  folders: ['.claude/skills', '.claude/agents', '.claude/commands'],
  settings: [{ file: '.claude/settings.local.json' }],
});
// The folders a subagent's definition may be in, from `checkouts`, its own checkout and, for a linked worktree alone, the
// main checkout (scripts/hook-session-start.mjs agentCheckouts): its own agents folder, then, as Claude Code reads it
// from a linked worktree with none, the main checkout's (MAIN_CHECKOUT_PATHS).
function agentFolders(checkouts) {
  const roots = Array.isArray(checkouts) ? checkouts.filter((each) => typeof each === 'string') : [];
  if (!roots.length) return [];
  const inherited = MAIN_CHECKOUT_PATHS.folders.includes(PROJECT_AGENTS) && roots.length > 1 ? [roots.at(-1)] : [];
  return [roots[0], ...inherited].map((root) => path.join(root, PROJECT_AGENTS));
}

// The file a Bash payload's `persistedOutputPath` names, or null unless it is a regular file, by lstat, so no symlink, in a
// `tool-results` folder whose real path is under Claude Code's real projects folder (configDir, then `projects`), where
// Claude Code keeps a long output. Any other path is no output of a call, and is never read.
function persistedFile(file, env) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  try {
    const projects = realpathSync(path.join(configDir(env), 'projects'));
    const folder = realpathSync(path.dirname(file));
    if (path.basename(folder) !== 'tool-results' || !folder.startsWith(`${projects}${path.sep}`)) return null;
    const real = path.join(folder, path.basename(file));
    return lstatSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

// CLAUDECODE=1 marks its hooks and its Bash tool; the others say the same for a process that lost that one.
const MARKERS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_AGENT', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_EFFORT'];

// An MCP server a plugin bundles reaches a hook as mcp__plugin_<plugin>_<server>__<tool> (code.claude.com/docs/en/hooks), so the
// GitHub MCP server installed through a plugin is mcp__plugin_github_github__merge_pull_request. That name is read as
// mcp__github__<tool> when the tool is one the GitHub MCP hook judges and a word of the plugin and server names holds "github",
// in any case. The tool name alone is not enough: other forges' servers, such as Gitea's or Bitbucket's, have a
// merge_pull_request or update_pull_request of their own, and the merge guard refuses a merge whose head it cannot read.
// A GitHub server under a name with no "github" in it stays unread: docs/providers/claude-code.md#a-github-mcp-server-from-a-plugin.
const GITHUB_TOOLS = ['merge_pull_request', 'update_pull_request', 'update_pull_request_draft_state', 'add_issue_comment', 'add_reply_to_pull_request_comment', 'pull_request_review_write'];
const WORD = '[A-Za-z0-9-]';
// Words joined by single underscores, one of them holding "github"; anchored, and with no lookaround, so Codex's regex reads it too.
const SEGMENT = `(?:${WORD}+_)*${WORD}*[Gg][Ii][Tt][Hh][Uu][Bb]${WORD}*(?:_${WORD}+)*`;
// hooks.json's matcher for these names, as written there; test/host-plugin-github.test.mjs holds the two equal.
export const PLUGIN_GITHUB_MATCHER = `^mcp__plugin_${SEGMENT}__(?:${GITHUB_TOOLS.join('|')})$`;
const PLUGIN_GITHUB_TOOL = new RegExp(PLUGIN_GITHUB_MATCHER, 'u');

const toolName = (name) => (typeof name === 'string' && PLUGIN_GITHUB_TOOL.test(name) ? `mcp__github__${name.slice(name.lastIndexOf('__') + 2)}` : name);

// Its tools other than Bash that run `tool_input.command` in a shell. Monitor runs its command in the background under
// Bash's permission rules, and a subagent may call it (code.claude.com/docs/en/tools-reference#monitor-tool). From 2.1.314
// a hook whose matcher is Bash gets those commands as Bash calls; one whose matcher takes every tool, as the agent gates
// hook's does, gets the Monitor call itself (code.claude.com/docs/en/hooks#match-monitor-commands). So such a call reads
// as the standard Bash, and every guard of a shell command reads it. A WebSocket watch takes `ws` and runs no shell, so it
// keeps its name; it still runs under Bash's permission rules, so it carries `permission_tool_name: "Bash"`, and a bare
// Bash deny in an agent gate covers it too (lib/hosts/index.mjs deniedNames).
// docs/providers/claude-code.md#shell-commands-of-the-monitor-tool.
export const SHELL_TOOLS = Object.freeze(['Monitor']);
const shellCommand = (input) => SHELL_TOOLS.includes(input.tool_name) && typeof input.tool_input?.command === 'string';
const shellWatch = (input) => SHELL_TOOLS.includes(input.tool_name) && typeof input.tool_input?.command !== 'string';

// Its tools that run `tool_input.command` in a shell the shared lexer cannot read. PowerShell, on by default on Windows
// and opt-in on Linux, macOS, and WSL, runs its command as PowerShell, whose `@(...)`, backtick escapes, and quoting a
// POSIX lexer misreads, so it is never read as Bash, and a Bash(prefix) gate never admits it: the guards read its command
// as opaque text and fail closed for a subagent, and every Bash deny covers it on every platform, since the gate cannot
// read its command; the host itself turns the tool off for a Bash deny only on Windows with Git Bash installed, and on
// Windows without Git Bash a Bash deny in `main` or `*` leaves the main session no shell tool, a recorded limit
// (lib/hosts/index.mjs opaqueShellCommand, deniedNames). This rests on the tools and hooks references, which
// give its command as `tool_input.command`, and on fixtures; it has not run live.
// docs/providers/claude-code.md#powershell-commands.
const OPAQUE_SHELL_TOOLS = Object.freeze(['PowerShell']);

// Whether an AskUserQuestion result entry of its transcript carries its positive marks of an answer the Human gave in the
// terminal: not a sidechain (`isSidechain` false, not merely absent), no meta entry or compaction summary, the terminal
// CLI's `entrypoint`, and a permission decision the user made (`permissionDecision.source` "user_temporary"). Read on
// Claude Code 2.1.295 to 2.1.328, where every such entry carries all three; before 2.1.295 none carries the permission
// decision, and the desktop app's `entrypoint` is "claude-desktop". A shape this reader does not know never counts.
// Whether an SDK callback or a hook that answers the question writes other marks is not verified: its entry counts only
// if it carries all three. docs/providers/claude-code.md#answers-the-human-gave.
const humanAnswer = (entry) => entry !== null && typeof entry === 'object' && entry.isSidechain === false && entry.isMeta !== true &&
  entry.isCompactSummary !== true && entry.entrypoint === 'cli' && entry.permissionDecision?.source === 'user_temporary';

// Whether a transcript entry is a prompt the Human typed into the session after its start (lib/unattended-mark.mjs
// liftAttended): a main-session user entry from the CLI whose `origin` and `turnOrigin` are "human", at prompt 2 or
// later. Claude Code marks a peer session's message `origin.kind: "peer"`, a hook's or the host's own text `isMeta`, and
// the prompt a background session starts with is prompt 1, which the start wrote, not a person at the terminal.
// docs/providers/claude-code.md#prompts-the-human-typed.
const humanPrompt = (entry) => entry !== null && typeof entry === 'object' && entry.type === 'user' && entry.isSidechain === false &&
  entry.isMeta !== true && entry.isCompactSummary !== true && entry.entrypoint === 'cli' && entry.origin?.kind === 'human' &&
  entry.turnOrigin === 'human' && Number.isInteger(entry.turnPosition?.promptIndex) && entry.turnPosition.promptIndex >= 2;

// When a transcript entry was written, in epoch milliseconds, from its `timestamp`; NaN when it carries none it can read
// (lib/terminal-replace.mjs typedSince).
const entryTime = (entry) => (typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN);

// The real path of `file` when it is the transcript of `session` the host keeps where an unattended session cannot
// write: `<session>.jsonl` in a folder of `.claude/projects` under the account's home folder, the one the write guard
// protects (lib/unattended-write.mjs, userInfo), reached through no link. Null otherwise: a transcript under another
// HOME, or under CLAUDE_CONFIG_DIR, could be the session's own writing. The write guard refuses that folder to every
// unattended session whatever its places, and the home dot folders above it, so no ancestor can be swapped either.
function ownTranscript(file, { session, home } = {}) {
  try {
    if (typeof session !== 'string' || typeof file !== 'string' || !path.isAbsolute(file)) return null;
    home ??= userInfo().homedir;
    const root = path.join(realpathSync(home), '.claude', 'projects');
    const real = realpathSync(file);
    const fits = realpathSync(root) === root && real === path.resolve(file) && path.basename(real) === `${session}.jsonl` && path.dirname(path.dirname(real)) === root;
    return fits ? real : null;
  } catch {
    return null;
  }
}

// Its command line that starts or resumes a session, which lib/handoff-guard.mjs hostSessionStartDenial refuses a
// subagent and a session the background handoff route started, so no session starts outside the handoff gate.
// `claude` with no subcommand starts one, as do `-p`, `--bg`, `--resume`, `--continue`, and a prompt; so does any word
// this list does not name, and any option before the subcommand, so a subcommand added later is read as a start.
// These manage the sessions and install that are there and start none (code.claude.com/docs/en/cli-reference);
// `claude mcp serve` runs Claude Code as a server whose tools a client calls, so it counts as a start.
const NO_SESSION = new Set(['agents', 'attach', 'stop', 'kill', 'logs', 'doctor', 'update', 'install', 'config', 'mcp', 'plugin', 'plugins', 'setup-token', 'auth', 'migrate-installer']);
const INFO = new Set(['-v', '-V', '--version', '-h', '--help']);
// The standard names of a hook payload (hookInput), before its sandbox escape is read.
function mapInput(input) {
  if (shellCommand(input)) return { ...input, tool_name: 'Bash', raw_tool_name: input.tool_name };
  if (shellWatch(input)) return { ...input, permission_tool_name: 'Bash' };
  const name = toolName(input.tool_name);
  return name === input.tool_name ? input : { ...input, tool_name: name, raw_tool_name: input.tool_name };
}

// Its file tools that read, and the path each names (code.claude.com/docs/en/tools-reference): Read's `file_path`, Grep's
// and Glob's `path`, the call's folder when unset, and Glob's `pattern` when it is absolute, up to its first glob
// character, and the file system's root when a `..` follows that. They run outside the sandbox, so the agent gate hook holds a confined session's reads (lib/confine-guard.mjs).
export const READ_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'NotebookRead', 'LS']);
function fileRead(tool, given) {
  if (tool === 'Read' || tool === 'NotebookRead') return [given.file_path ?? given.notebook_path ?? null];
  const base = typeof given.path === 'string' ? given.path : null;
  const named = [base];
  if (tool === 'Glob' && typeof given.pattern === 'string') {
    // The pattern's literal folder: up to the last `/` before its first glob character, `..` included, from its `path`
    // or the call's folder when it is relative.
    const at = given.pattern.search(/[*?[{]/u);
    const literal = at < 0 ? given.pattern : given.pattern.slice(0, given.pattern.lastIndexOf('/', at) + 1);
    const expanded = filePath(literal);
    named.push(path.isAbsolute(expanded) || base === null ? expanded || null : textJoin(filePath(base), expanded));
    // A `..` segment past that folder, in a path or a brace list, climbs from wherever a glob matched, so no folder
    // bounds it: the read reaches the file system's root, which holds every store a confined session may not read.
    if (/(?:^|[/{,])\.\.(?:[/},]|$)/u.test(given.pattern.slice(literal.length))) named.push(path.parse(process.cwd()).root);
  }
  return named;
}

// `file` under the folder `folder`, joined as text and never folded: a `..` after a link in `folder` climbs from the
// link's target, which the confine guard's read check resolves (lib/confine-guard.mjs readsStore). An empty `folder`
// is the call's folder, so `file` stays relative to it.
function textJoin(folder, file) {
  if (folder === '') return file;
  return file === '' ? folder : `${folder.replace(/\/+$/u, '')}/${file}`;
}

// A path its file tools name, as they resolve it: a leading `~` or `~/` is the home folder of the user the host runs as
// (live check 23), joined as text and never folded, so a `..` after it climbs from the home folder's target when that is
// a link (lib/confine-guard.mjs readsStore). Every other path is as it is, relative ones from the call's folder.
function filePath(file) {
  if (typeof file !== 'string') return file;
  if (file === '~') return homedir();
  return file.startsWith('~/') ? textJoin(homedir(), file.slice(2)) : file;
}

const startsSession = (args) => {
  const [first, second] = args.map((token) => (token.dynamic ? null : token.text));
  if (first === undefined) return true;
  if (INFO.has(first)) return false;
  return !NO_SESSION.has(first) || (first === 'mcp' && second === 'serve');
};

export default {
  id: 'claude-code',
  name: 'Claude Code',
  ai: 'Claude',
  // How the plugin's hooks reach it: it reads hooks/hooks.json as it is (docs/providers/adding-a-host.md).
  delivery: 'hooks-json',
  // The `models` key of config.json, and what the Agent tool takes for it. docs/config.md#models cites both.
  modelsKey: 'claude',
  modelChoices: MODEL_CHOICES,
  // Its models' prices, for the cost of the transcripts it writes (lib/model-prices.mjs).
  modelPrices,
  // CLAUDE_CODE_SESSION_ATTENDED and CLAUDE_PID say whether a Human attends the session and which process hosts it
  // (claude-code-terminal.mjs): a reviewer or a test that inherited CLAUDE_CODE_SESSION_ATTENDED=1 would take itself
  // for that attended session.
  identityVars: ['CLAUDE_CODE_AGENT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID'],
  detectVars: ['CLAUDECODE', ...MARKERS],
  detect: ({ env }) => env.CLAUDECODE === '1' || MARKERS.some((name) => Boolean(env[name])),
  sessionId: (env) => env.CLAUDE_CODE_SESSION_ID || null,
  agentName,
  effort,
  // The effort a subagent runs at, from its SubagentStart payload, the environment, the project's `models`, and its
  // definition (claude-code-agents.mjs), or null: a hint for its commit trailers, never what the commit check reads.
  // CLAUDE_CODE_EFFORT_LEVEL in its environment sets every agent's effort, past the dispatch's and the definition's.
  subagentEffort: ({ input, checkouts, models, env = {} }) => subagentEffort({
    input, models, efforts: MODEL_CHOICES.effort, override: env.CLAUDE_CODE_EFFORT_LEVEL ?? null, folders: agentFolders(checkouts),
  }),
  runEnv: (env) => (env.CLAUDE_CODE_REMOTE === 'true' ? 'cloud' : null),
  // `aidrian:<agent>` for this plugin's agents, and `<plugin>:<agent>` for another's.
  pluginAgentPrefix: 'aidrian:',
  agentAliases: (type) => [type.slice(type.lastIndexOf(':') + 1)],
  toolName,
  serverSpelling: (server) => server,
  nativeToolName: (standard) => standard,
  // Its names are the standard, which is what hooks.json matches; a plugin's GitHub server has its own matcher there.
  rawToolName: (standard) => standard,
  toolResponse: responseObjects,
  // A Bash call's response, `{ stdout, stderr, interrupted, … }`, as `{ output, interrupted }`: its stdout, or null when the
  // response holds none (test/fixtures/hosts/claude-code/bash-post.json).
  shellOutput: (response) => ({ output: typeof response?.stdout === 'string' ? response.stdout : null, interrupted: response?.interrupted === true }),
  // A finished Bash call, as the check-run record reads it (lib/check-runs.mjs): `{ output, persisted, finished, exitZero }`,
  // `output` its stdout then stderr; `persisted`, for a stdout too long for the payload, `{ file, after }`: the file
  // Claude Code kept the whole stdout in (`persistedOutputPath`), whose head alone `stdout` holds, and the stderr after
  // it, else null (persistedFile); `finished` false for a call stopped, or one started in or moved to the background,
  // whose end no hook sees (`backgroundTaskId`); `exitZero` true, since Claude Code runs PostToolUse only for a call that
  // exited 0.
  shellRun: (response, env = process.env) => {
    const parts = [response?.stdout, response?.stderr].filter((part) => typeof part === 'string');
    const finished = parts.length > 0 && response?.interrupted !== true && !response?.backgroundTaskId;
    const file = persistedFile(response?.persistedOutputPath, env);
    const after = typeof response?.stderr === 'string' ? response.stderr : '';
    return { output: parts.length ? parts.join('\n') : null, persisted: file ? { file, after } : null, finished, exitZero: true };
  },
  // `raw_tool_name` keeps what Claude Code sent, so a pattern a project wrote in that form still matches (lib/hosts/index.mjs toolNames),
  // as `Monitor` in an agent gate does for a Monitor call read as Bash. A shell call's `dangerouslyDisableSandbox`, its ask
  // to run outside the sandbox (code.claude.com/docs/en/sandboxing), with any value but false or null, reads as the
  // standard `sandbox_escape: true`, failing closed on a value the host may read as true.
  hookInput(input) {
    const mapped = mapInput(input);
    const escape = input?.tool_input?.dangerouslyDisableSandbox;
    return escape === undefined || escape === null || escape === false ? mapped : { ...mapped, sandbox_escape: true };
  },
  opaqueShellTools: OPAQUE_SHELL_TOOLS,
  humanAnswer,
  humanPrompt,
  entryTime,
  ownTranscript,
  // The account home's, and the folder continuedIn reads, from the environment alone, as the command reads it
  // (claude-code-continuation.mjs transcriptRoot): a host whose HOME is not the account's home reads there.
  transcriptFolders: (home, env = process.env) => [...new Set([path.join(home, '.claude', 'projects'), transcriptRoot(env, home), transcriptRoot(env)])],
  sessionStart: { programs: ['claude'], starts: startsSession },
  // The npm package that installs its program, which a package runner runs as `claude` (lib/package-runner.mjs).
  packages: { '@anthropic-ai/claude-code': 'claude' },
  // The subcommands of its program that write its own user or project config: MCP servers, settings, and plugins, and
  // its global options that take the next word. The agent gate hook refuses them to a session no Human attends
  // (lib/unattended-write.mjs).
  configCommands: {
    programs: ['claude'],
    subcommands: [['mcp', 'add'], ['mcp', 'add-json'], ['mcp', 'add-from-claude-desktop'], ['mcp', 'remove'], ['config', 'set'], ['config', 'add'], ['config', 'remove'], ['plugin', 'install'], ['plugin', 'marketplace', 'add']],
    valueOptions: ['--settings', '--setting-sources', '--model', '--fallback-model', '--add-dir', '--mcp-config', '--permission-mode', '--agents', '--agent', '--session-id', '--append-system-prompt', '--system-prompt', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--output-format', '--input-format', '--plugin-dir', '-r', '--resume', '-n', '--name'],
  },
  fileReadTools: READ_TOOLS,
  fileRead,
  filePath,
  fileEditTools: ['Edit', 'Write', 'NotebookEdit'],
  fileEdit(tool, given) {
    const targets = [given.file_path ?? given.notebook_path];
    if (tool === 'Write') return { shape: 'write', file: given.file_path, content: given.content, targets };
    if (tool === 'Edit') return { shape: 'edit', file: given.file_path, edits: Array.isArray(given.edits) ? given.edits : [given], newText: given.new_string, replaceAll: given.replace_all === true, targets };
    return { shape: 'notebook', file: given.notebook_path, targets };
  },
  projectFolders: { skills: '.claude/skills', agents: '.claude/agents' },
  // The host files of a checkout a session no Human attends never writes, from its root: the settings, skills, agents,
  // commands, hooks, scheduled work, and MCP servers a later session there would load (lib/unattended-write.mjs).
  protectedPaths: PROTECTED_PATHS,
  // Whether a path, by its parts from a confined clone's root, is a host file it loads from any depth: a `.claude`
  // folder or its skills, agents, commands, hooks, workflows, or settings, or any SKILL.md (lib/unattended-write.mjs).
  nestedProtected,
  // The instruction files and folder it loads from the folder a session starts in and from each folder above it
  // (code.claude.com/docs/en/memory), its own user folder, and `globalNames`, the files in that folder it loads as the
  // user's own memory for every session wherever it starts: CLAUDE.md alone. A project run refuses a start under any
  // other such file above its attempt's clone that a review did not see (lib/project-trust.mjs ancestorProblem).
  instructionFiles: {
    files: ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'],
    folders: ['.claude'],
    userFolder: (env) => configDir(env),
    globalNames: ['CLAUDE.md'],
  },
  // What a session in a linked worktree reads from the main checkout, wherever the worktree lies: the main checkout's
  // .claude/settings.local.json (code.claude.com/docs/en/settings), and, from 2.1.277, its .claude skills, agents, and
  // commands when the worktree has none (code.claude.com/docs/en/common-workflows, worktrees). The agent gate hook
  // refuses their writes to a session no Human attends (lib/handoff-guard.mjs mainCheckoutWriteDenial). A project run's
  // session works in a fresh clone, which loads none of them, so they refuse no start.
  mainCheckoutPaths: MAIN_CHECKOUT_PATHS,
  capabilities: {
    // The session a session went on as, when the host continued it under a new id (hosts/claude-code-continuation.mjs),
    // as { id, at }, or null: a project run whose driver it continued is stranded (lib/project-run-gate.mjs strandedDriver).
    continuedIn: ({ session, cwd, env, home }) => continuedIn({ session, cwd, env, home }),
    // Reads Claude Code's transcripts (lib/transcript.mjs): cost, names reminder, session length, and attribution's model.
    // Also opts it into the review-rounds rule's reading of the Human's answers and typed grants of review rounds.
    transcripts: true,
    // The tool calls that end a resume in its transcripts, a file edit or a dispatch: lib/resume-tokens.mjs measures what
    // a session resumed from a brief read before the first of them (docs/handoff.md#the-cost-model).
    workTools: ['Edit', 'Write', 'NotebookEdit', 'Agent', 'Task'],
    // The settings files whose `env` reaches every later session and its hooks (code.claude.com/docs/en/settings): the
    // project's and its local one in each checkout of `roots`, and the user's. The override guard refuses an
    // AIDRIAN_ALLOW_* name written there (lib/override-guard.mjs).
    envSettings: (roots, env) => [
      ...roots.flatMap((root) => [path.join(root, '.claude/settings.local.json'), path.join(root, '.claude/settings.json')]),
      path.join(configDir(env), 'settings.json'),
    ],
    // The settings files that say whether Claude Code asks for its generated-by footer, first that sets it wins.
    prFooterSettings: (root, env) => [
      path.join(root, '.claude/settings.local.json'),
      path.join(root, '.claude/settings.json'),
      path.join(configDir(env), 'settings.json'),
    ],
    // Its PostToolUse hook on the Agent tool writes a `dispatch` row with the agent id the tool returned for each subagent
    // (lib/dispatch-rows.mjs dispatchRow), so a waiver's judge can be confirmed in the dispatch log
    // (lib/review/waiver-stand.mjs judgeHostProblem).
    judgeDispatch: true,
    // A background agent's report reaches the subagent that started it even after that subagent ended its turn: the host
    // starts it again with the report (SubagentStart fires, and the report arrives as a message), and tells the subagent's
    // own dispatcher it stopped only once it stops with no live background child. Seen on 2.1.3xx in each of the four
    // idle-with-children occurrences of 2026-11-14 to 17 that kept a transcript. So the stop hook's background check
    // leaves such a child out (lib/dispatch-rows.mjs blockingChildren). `taskTypes` are its `background_tasks` types of an
    // agent; a shell task is none. docs/providers/claude-code.md#background-agents.
    wakesOnChildReport: { taskTypes: ['subagent', 'local_agent', 'remote_agent'] },
    // A background shell's end reaches the subagent that started it as a task notification, and starts it again after it
    // ended its turn: 280 such wakes in subagent transcripts of 2.1.316 and later, each right after an end_turn. The stop
    // hook lets a handoff file wait for the stop after such a wake (hooks.md#delivery-check); a shell that never ends, such
    // as a dev server, wakes it never. `taskTypes` are its `background_tasks` types of a shell.
    wakesOnTaskEnd: { taskTypes: ['shell'] },
    // A foreground command of a background subagent still running after this many seconds is moved to the background,
    // whatever timeout the call asks for, and the length and tool timeout of one wait call that stays under it
    // (hosts/claude-code-tasks.mjs). Seen on 2.1.332 for an unnamed background subagent, and not for a named agent or a
    // foreground one; the SubagentStart payload does not tell the kinds apart. docs/providers/claude-code.md#long-commands.
    foregroundLimit: FOREGROUND.limit,
    waitCall: { seconds: FOREGROUND.wait, toolTimeout: FOREGROUND.toolTimeout },
    // The output of a background shell of the session a command runs in, and whether it ended, for `aidrian wait`.
    taskOutput: { taskTypes: ['shell'], find: findTask, read: readTask },
    // Every MCP call reaches its hooks with no step by a person.
    trackerGuard: { verified: 'live', evidence: 'The PostToolUse payload of a real get_workspace call on Claude Code 2.1.318', unguardedRoutes: [] },
    // Whether auto mode would let a session push to the remote, from the user settings (lib/hosts/claude-code-push.mjs).
    pushPermission: (ask) => pushPermission(ask),
    // Whether nothing in the settings it can read covers a merge auto mode blocks (lib/hosts/claude-code-merge.mjs).
    mergePermission: (ask) => mergePermission(ask),
    // How a session goes on after its handoff (session.handoff.continue). A clear keeps the same process, so the hook's parent,
    // the claude process, names the session before and after it. The background route starts a new session with
    // `claude --bg` (lib/hosts/claude-code-background.mjs), in the session's own folder, `startFolder`, under its name,
    // agent, and the model and effort `startChoice` answered, which `readAsked` reads back from a start record;
    // `stopBackground` stops one the gate cannot hold to a chain floor, `stopLine` says how to stop it by
    // hand when that failed, `findLine` how to find and stop one a start may have made that the gate cannot name,
    // `attachLine` and `attachCommand` say how to open one, and `sessionEnded` whether `claude agents --json --all` lists a
    // started one as done. `replaceTerminal` ends a session that handed off once its turn ends, so the shell function
    // `aidrian shell-init` prints opens the new one in the same terminal (lib/hosts/claude-code-terminal.mjs).
    handoffContinue: {
      routes: ['clear', 'background'],
      steps: {
        clear: 'type /clear, then any message',
        background: 'nothing to type, since a new session starts in the background and resumes from the brief by itself',
      },
      startBackground: ({ session, slug, chain, env, prompt, hold, run, wait, start, asked }) => startBackground({
        session, slug, chain, env, prompt, hold, run, wait, start, agent: agentName(env), model: asked?.model, effort: asked?.effort, efforts: MODEL_CHOICES.effort,
      }),
      // The model and effort the start asks for, read once before the first message is built, and passed back as `asked`.
      startChoice: ({ session, env, start, team }) => startChoice({ session, env, start, team, effort: effort(env) }),
      readAsked,
      // The folder startBackground would start the new session in, which the gate's push preflight judges and passes back.
      startFolder: ({ session, env, run }) => startFolder({ session, env, run }),
      stopBackground: ({ id, env, run }) => stopBackground({ id, env, run }),
      sessionEnded: ({ id, session, env, run }) => sessionEnded({ id, session, env, run }),
      stopLine,
      findLine,
      attachLine,
      attachCommand: ({ id }) => `claude attach ${id}`,
      replaceTerminal: {
        program: PROGRAM,
        attach: 'attach',
        attended,
        // The command that updates the plugin, for a terminal whose copy is older than `shell-init`.
        updateCommand: 'claude plugin update aidrian@aidrian-harness',
        hostProcess: ({ env, shell, run }) => hostProcess({ env, shell, run }),
        isHost: ({ pid, shell, run }) => isWrappedHost({ pid, shell, run }),
        // A background session the terminal follows ends itself with `claude stop`, which the supervisor owns, and
        // `claude attach` then exits 0 about a second later (probed on 2.1.326), so the shell function goes on.
        endOwn: ({ id, session, env, run }) => stopOwnBackground({ id, session, env, run }),
        hasClient: ({ shell, run }) => hasClient({ shell, run }),
        // `claude attach` takes a session's name, or part of it, in place of its id.
        nameMatcher: ({ session, skip, env, run }) => nameMatcher({ session, skip, env, run }),
        signal: END_SIGNAL,
      },
      // Its own clear and compact commands are part of the route, so they cancel nothing. Its commands reference
      // (code.claude.com/docs/en/commands) has `/clear [name]`, with the aliases `/reset` and `/new`, and `/compact [instructions]`.
      keepsArmed: (prompt) => typeof prompt === 'string' && /^\/(?:clear|reset|new|compact)(?:\s[\s\S]*)?$/u.test(prompt.trim()),
      hookHostPid: (pid = process.ppid) => (Number.isInteger(pid) && pid > 1 ? pid : null),
    },
    // The background sessions the supervisor holds (hosts/claude-code-background.mjs): `list` and `held` each read the
    // plain `claude agents --json` once, which keeps a session whose turn ended until `claude stop` releases it (read on
    // 2.1.331); `stopLine` is the project start's. docs/providers/claude-code.md#background-sessions.
    backgroundSessions: {
      list: ({ env, run }) => listBackground({ env, run }),
      held: ({ sessions, env, run }) => heldSessions({ sessions, env, run }),
      stopLine,
    },
    // How `aidrian project start` starts the session of one issue (lib/project-run-gate.mjs): Claude Code is `confined`,
    // as Codex is. The session works in a fresh clone made for its attempt, never a linked worktree, whose shared .git the
    // host's sandbox would let it write, and starts with `claude --bg --setting-sources user --settings <sandbox>
    // --strict-mcp-config --mcp-config <servers>` (hosts/claude-code-sandbox.mjs, claude-code-background.mjs), under the
    // name `<run> · <issue> · <attempt>`, with no agent and the driver session's permission mode and effort. A start holds
    // the session only once the agent gate hook's beacon shows the plugin's hooks run for it, and the session's own
    // `aidrian project confine` showed, from inside it, that the sandbox refuses what it must (confineProof). `access` halts on user
    // settings that would weaken the sandbox or run a command outside it, this plugin not enabled for the user, any other
    // plugin, a user skill, agent, or command with frontmatter hooks or MCP servers, an SSH origin, git's `store` helper,
    // and a Linux without bubblewrap or socat; `cloneProblem` on such a skill, agent, or command of the clone at any
    // depth, or a link out of one's folder; `placeholders` are the protected host files made empty before launch. `ended` counts a
    // session the host lists as stopped or failed as ended too (sessionFinished); `find` lists the background sessions in a
    // folder under an exact name, for a start whose outcome was unknown. `verified`: the launch, listing, and stop are the
    // background route's, checked live on 2.1.326; the sandbox settings, their key names, and the beacon under
    // --setting-sources user come from the host's docs and fixtures, with no live run, so a run starts it only where the
    // default branch sets projectRun.unverifiedHosts (docs/providers/claude-code.md#project-start lists the live checks).
    projectStart: {
      verified: 'unverified',
      evidence: 'fixtures and the host docs; no live run',
      confined: true,
      access: ({ env, home, guarded, pushUrl, platform, allowed, helpers, localBinding }) => accessProblem({ env, home, guarded, pushUrl, platform, allowed, helpers, localBinding }),
      cloneProblem: ({ work, allowed }) => cloneProblem({ work, allowed }),
      // Whether a driver on this host would carry on by itself after a usage limit (aidrian project preflight).
      limitContinue: ({ env, home, project }) => limitContinueProblem({ env, home, project }),
      // Whether the host trusts the runs folder, where every attempt's clone lies (aidrian project preflight).
      trust: ({ folder, env, home }) => trustProblem({ folder, env, home }),
      placeholders: PLACEHOLDERS,
      sessionNote,
      // The package managers' caches reach the session's sandboxed commands alone: the SessionStart hook appends them to
      // the file the host sources before each Bash command, never the settings' `env`, which its hooks and MCP servers get.
      shellEnv: ({ env, vars }) => writeEnvFile(env.CLAUDE_ENV_FILE, vars),
      // The file shellEnv writes for this hook, which the SessionStart hook records before it hands the forge token over,
      // and the removal of those files once the session ended, which the driver's sweep makes (lib/project-start.mjs):
      // the host keeps each in `session-env/<session>/` after the session ends, token and all.
      shellEnvFile: ({ env, session, home }) => sessionEnvFile({ env, session, home }),
      forgetShellEnv: ({ files, session, env, home }) => forgetEnvFiles({ files, session, env, home }),
      // The sandbox hides the system keyring, where the forge CLI may keep its login: the start reads the forge token
      // outside it, and the SessionStart hook hands it to the sandboxed commands through shellEnv (lib/project-token.mjs).
      forgeTokenEnv: true,
      // Each start proves, from inside the session, that the sandbox holds (lib/project-confine.mjs): its first call runs
      // `aidrian project confine`, which tries what the sandbox must refuse, and the start holds the session only once the
      // gate confirmed the verdict (`confined`). `confineReads` are the credential stores the proof tries to read.
      confineProof: true,
      confineReads: ({ env, home, stores }) => confineReads({ env, home, stores }),
      // The allowedDomains the user's and the organization's settings add, which the proof's unlisted host stays outside.
      confineDomains: ({ env, home, platform }) => confineDomains({ env, home, platform }),
      // Whether the session's binding reaches this machine's loopback under projectRun.localBinding, so the proof runs no
      // localhost listener: macOS alone; Linux keeps the session in a network namespace of its own.
      confineLoopback: ({ platform, localBinding }) => loopbackReach({ platform, localBinding }),
      localBindingRisk,
      // `hostFiles` are the other hosts' files the sandbox denies writing too, and `hostStores` their logins and service
      // state, which it denies reading (claude-code-sandbox.mjs sandboxSettings).
      start: ({ session, cwd, name, prompt, env, hold, identify, beacon, confined, git, grants, domains, main, mainGit, tokens, guarded, hostFiles, hostStores, mcp, localBinding, home, platform, run, wait, runs, claimVars }) => startProject({
        session, cwd, runs, name, prompt, env, hold, identify, beacon, confined, sandbox: { git, grants, domains, main, mainGit, tokens, guarded, localBinding, hostFiles, hostStores }, mcp, home, platform, run, wait, effort: effort(env), efforts: MODEL_CHOICES.effort, claimVars,
      }),
      stop: ({ id, started, env, run }) => stopBackground({ id, started, env, run }),
      ended: ({ id, session, env, run }) => sessionFinished({ id, session, env, run }),
      find: ({ cwd, name, env, run }) => findSessions({ cwd, name, env, run }),
      // Whether the session last met a usage or rate limit, from the host's own API error entry at the end of its
      // transcript (hosts/claude-code-limit.mjs), and whether its account-change entry came after it.
      limitOf: ({ session, cwd, env, home, now }) => transcriptLimit({ session, cwd, env, home, now }),
      // The session starts with autoContinueAtUsageLimit (claude-code-sandbox.mjs sandboxSettings), so the host waits
      // out a usage limit and goes on with its work: `wait` keeps a limited session it still lists running. Unverified
      // on a background session (docs/providers/claude-code.md#project-start lists the live check).
      continuesAtLimit: true,
      attachLine,
      stopLine,
    },
  },
};
