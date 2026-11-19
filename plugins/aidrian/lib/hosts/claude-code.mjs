// Claude Code's adapter. Its event and tool names are the standard the shared code reads, so its payload needs no mapping but
// for the GitHub MCP server a plugin installs.
// docs/providers/adding-a-host.md lists the fields; docs/providers/claude-code.md says what was checked on this host.

import { homedir } from 'node:os';
import path from 'node:path';

import { attachLine, findLine, findSessions, sessionEnded, sessionFinished, startBackground, startProject, stopBackground, stopLine } from './claude-code-background.mjs';
import modelPrices from './claude-code-prices.mjs';
import { accessProblem, cloneProblem, nestedProtected, PLACEHOLDERS, PROTECTED_PATHS, sessionNote, writeEnvFile } from './claude-code-sandbox.mjs';
import { responseObjects } from './response.mjs';

const MODEL_CHOICES = { model: ['sonnet', 'opus', 'haiku', 'fable'], effort: ['low', 'medium', 'high', 'xhigh', 'max'] };
const agentName = (env) => env.CLAUDE_CODE_AGENT || null;
const effort = (env) => env.CLAUDE_EFFORT || null;

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

// Its command line that starts or resumes a session, which lib/handoff-guard.mjs hostSessionStartDenial refuses a
// subagent and a session the background handoff route started, so no session starts outside the handoff gate.
// `claude` with no subcommand starts one, as do `-p`, `--bg`, `--resume`, `--continue`, and a prompt; so does any word
// this list does not name, and any option before the subcommand, so a subcommand added later is read as a start.
// These manage the sessions and install that are there and start none (code.claude.com/docs/en/cli-reference);
// `claude mcp serve` runs Claude Code as a server whose tools a client calls, so it counts as a start.
const NO_SESSION = new Set(['agents', 'attach', 'stop', 'kill', 'logs', 'doctor', 'update', 'install', 'config', 'mcp', 'plugin', 'plugins', 'setup-token', 'auth', 'migrate-installer']);
const INFO = new Set(['-v', '-V', '--version', '-h', '--help']);
// The keys a main checkout's settings.local.json may hold for a project run to start a session beside it: `$schema`, and
// `permissions` with only `allow`, `ask`, and `deny` as lists of plain strings and `disableBypassPermissionsMode` as
// "disable". It is what the host writes when the Human answers "don't ask again", and no such entry lifts a hook, which
// runs before the permission rules. Every other key, such as hooks, disableAllHooks, env, apiKeyHelper, statusLine,
// enabledPlugins, sandbox, model, permissions.defaultMode, or permissions.additionalDirectories, changes what an
// unattended session runs or reads, and refuses the start. Returns the key or entry that refuses, or null.
const PERMISSION_LISTS = new Set(['allow', 'ask', 'deny']);
function localSettingsProblem(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'it is not a JSON object';
  const top = Object.keys(value).find((key) => key !== '$schema' && key !== 'permissions');
  if (top !== undefined) return `it sets "${top}"`;
  if (value.$schema !== undefined && typeof value.$schema !== 'string') return 'its "$schema" is not text';
  const { permissions } = value;
  if (permissions === undefined) return null;
  if (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)) return 'its "permissions" is not an object';
  for (const [key, entry] of Object.entries(permissions)) {
    if (key === 'disableBypassPermissionsMode') {
      if (entry !== 'disable') return 'it sets "permissions.disableBypassPermissionsMode" to something other than "disable"';
    } else if (!PERMISSION_LISTS.has(key)) return `it sets "permissions.${key}"`;
    else if (!Array.isArray(entry) || entry.some((rule) => typeof rule !== 'string' || /[\u0000-\u001f\u007f]/u.test(rule))) return `its "permissions.${key}" is not a list of plain strings`;
  }
  return null;
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
  identityVars: ['CLAUDE_CODE_AGENT', 'CLAUDE_CODE_SESSION_ID'],
  detectVars: ['CLAUDECODE', ...MARKERS],
  detect: ({ env }) => env.CLAUDECODE === '1' || MARKERS.some((name) => Boolean(env[name])),
  sessionId: (env) => env.CLAUDE_CODE_SESSION_ID || null,
  agentName,
  effort,
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
  // `raw_tool_name` keeps what Claude Code sent, so a pattern a project wrote in that form still matches (lib/hosts/index.mjs toolNames),
  // as `Monitor` in an agent gate does for a Monitor call read as Bash.
  hookInput(input) {
    if (shellCommand(input)) return { ...input, tool_name: 'Bash', raw_tool_name: input.tool_name };
    if (shellWatch(input)) return { ...input, permission_tool_name: 'Bash' };
    const name = toolName(input.tool_name);
    return name === input.tool_name ? input : { ...input, tool_name: name, raw_tool_name: input.tool_name };
  },
  opaqueShellTools: OPAQUE_SHELL_TOOLS,
  sessionStart: { programs: ['claude'], starts: startsSession },
  // The subcommands of its program that write its own user or project config: MCP servers, settings, and plugins, and
  // its global options that take the next word. The agent gate hook refuses them to a session no Human attends
  // (lib/unattended-write.mjs).
  configCommands: {
    programs: ['claude'],
    subcommands: [['mcp', 'add'], ['mcp', 'add-json'], ['mcp', 'add-from-claude-desktop'], ['mcp', 'remove'], ['config', 'set'], ['config', 'add'], ['config', 'remove'], ['plugin', 'install'], ['plugin', 'marketplace', 'add']],
    valueOptions: ['--settings', '--setting-sources', '--model', '--fallback-model', '--add-dir', '--mcp-config', '--permission-mode', '--agents', '--agent', '--session-id', '--append-system-prompt', '--system-prompt', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--output-format', '--input-format', '--plugin-dir', '-r', '--resume', '-n', '--name'],
  },
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
  // (code.claude.com/docs/en/memory), and its own user folder, which it reads for every session wherever it starts. A
  // project run refuses a start under any other such file a review did not see (lib/project-run-gate.mjs).
  instructionFiles: {
    files: ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'],
    folders: ['.claude'],
    userFolder: (env) => env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
  },
  // What a session in a linked worktree reads from the main checkout, wherever the worktree lies: the main checkout's
  // .claude/settings.local.json (code.claude.com/docs/en/settings), and, from 2.1.277, its .claude skills, agents, and
  // commands when the worktree has none (code.claude.com/docs/en/common-workflows, worktrees). A project run refuses a
  // start under any file in those folders a review did not see, and under a settings file `problem` refuses
  // (lib/project-run-gate.mjs mainCheckoutProblem); the agent gate hook refuses their writes to a session no Human attends.
  mainCheckoutPaths: {
    folders: ['.claude/skills', '.claude/agents', '.claude/commands'],
    settings: [{ file: '.claude/settings.local.json', problem: localSettingsProblem }],
  },
  capabilities: {
    // Reads Claude Code's transcripts (lib/transcript.mjs): cost, names reminder, session length, and attribution's model.
    // Also opts it into the review-rounds rule's reading of the Human's answers and typed grants of review rounds.
    transcripts: true,
    // The settings files that say whether Claude Code asks for its generated-by footer, first that sets it wins.
    prFooterSettings: (root, env) => [
      path.join(root, '.claude/settings.local.json'),
      path.join(root, '.claude/settings.json'),
      path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'settings.json'),
    ],
    // Every MCP call reaches its hooks with no step by a person.
    trackerGuard: { verified: 'live', evidence: 'The PostToolUse payload of a real get_workspace call on Claude Code 2.1.318', unguardedRoutes: [] },
    // How a session goes on after its handoff (session.handoff.continue). A clear keeps the same process, so the hook's parent,
    // the claude process, names the session before and after it. The background route starts a new session with
    // `claude --bg` (lib/hosts/claude-code-background.mjs), in the session's own folder, under its name, agent, and
    // effort; `stopBackground` stops one the gate cannot hold to a chain floor, `stopLine` says how to stop it by hand when
    // that failed, `findLine` how to find and stop one a start may have made that the gate cannot name, `attachLine`
    // says how to open one, and `sessionEnded` whether `claude agents --json --all` lists a started one as done.
    handoffContinue: {
      routes: ['clear', 'background'],
      steps: {
        clear: 'type /clear, then any message',
        background: 'nothing to type, since a new session starts in the background and resumes from the brief by itself',
      },
      startBackground: ({ session, slug, chain, env, prompt, hold, run, wait }) => startBackground({
        session, slug, chain, env, prompt, hold, run, wait, agent: agentName(env), effort: effort(env), efforts: MODEL_CHOICES.effort,
      }),
      stopBackground: ({ id, env, run }) => stopBackground({ id, env, run }),
      sessionEnded: ({ id, session, env, run }) => sessionEnded({ id, session, env, run }),
      stopLine,
      findLine,
      attachLine,
      // Its own clear and compact commands are part of the route, so they cancel nothing. Its commands reference
      // (code.claude.com/docs/en/commands) has `/clear [name]`, with the aliases `/reset` and `/new`, and `/compact [instructions]`.
      keepsArmed: (prompt) => typeof prompt === 'string' && /^\/(?:clear|reset|new|compact)(?:\s[\s\S]*)?$/u.test(prompt.trim()),
      hookHostPid: (pid = process.ppid) => (Number.isInteger(pid) && pid > 1 ? pid : null),
    },
    // How `aidrian project start` starts the session of one issue (lib/project-run-gate.mjs): Claude Code is `confined`,
    // as Codex is. The session works in a fresh clone made for its attempt, never a linked worktree, whose shared .git the
    // host's sandbox would let it write, and starts with `claude --bg --setting-sources user --settings <sandbox>
    // --strict-mcp-config --mcp-config <servers>` (hosts/claude-code-sandbox.mjs, claude-code-background.mjs), under the
    // name `<run> · <issue> · <attempt>`, with no agent and the driver session's permission mode and effort. A start holds
    // the session only once the agent gate hook's beacon shows the plugin's hooks run for it. `access` halts on user
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
      access: ({ env, home, guarded, pushUrl, platform, allowed, helpers }) => accessProblem({ env, home, guarded, pushUrl, platform, allowed, helpers }),
      cloneProblem: ({ work, allowed }) => cloneProblem({ work, allowed }),
      placeholders: PLACEHOLDERS,
      sessionNote,
      // The package managers' caches reach the session's sandboxed commands alone: the SessionStart hook appends them to
      // the file the host sources before each Bash command, never the settings' `env`, which its hooks and MCP servers get.
      shellEnv: ({ env, vars }) => writeEnvFile(env.CLAUDE_ENV_FILE, vars),
      start: ({ session, cwd, name, prompt, env, hold, identify, beacon, git, grants, domains, main, mainGit, tokens, guarded, mcp, home, platform, run, wait }) => startProject({
        session, cwd, name, prompt, env, hold, identify, beacon, sandbox: { git, grants, domains, main, mainGit, tokens, guarded }, mcp, home, platform, run, wait, effort: effort(env), efforts: MODEL_CHOICES.effort,
      }),
      stop: ({ id, env, run }) => stopBackground({ id, env, run }),
      ended: ({ id, session, env, run }) => sessionFinished({ id, session, env, run }),
      find: ({ cwd, name, env, run }) => findSessions({ cwd, name, env, run }),
      attachLine,
      stopLine,
    },
  },
};
