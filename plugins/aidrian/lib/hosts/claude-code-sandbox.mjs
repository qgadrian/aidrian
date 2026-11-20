// Claude Code's confinement of a project run's issue session (lib/project-start.mjs): the session works in a fresh clone
// made for its attempt, under the host's OS sandbox, turned on for that one session through inline `--settings`, with
// `--setting-sources user`, so no project or local settings load, and `--strict-mcp-config`, so only the MCP servers the
// team names load (lib/hosts/claude-code-background.mjs startProject). docs/providers/claude-code.md#project-start.
//   - sandboxSettings: the settings object that session starts with, pure, so a test pins it whole.
//   - accessProblem: why the user's own settings, which still load, would weaken that sandbox, or run a command outside
//     it, why this plugin would not load, why another plugin or a user skill would run outside it, or why the platform
//     or origin could not run or push it; each a halt of the start.
//   - cloneProblem: a skill, agent, or command of the clone, at any depth, whose frontmatter declares hooks or MCP
//     servers, which run outside the sandbox, a link under one that leads out of its folder, or a `.claude` that is a link.
//   - nestedProtected: the host files at any depth of a clone the agent gate hook refuses a confined session's writes to.
// The key names are the host's settings reference's (code.claude.com/docs/en/settings-reference, sandboxing), read on
// 2026-11-18; no live run has checked them, and a value that fails validation in a session no Human attends is silently
// ignored. It reads no file when loaded: hooks load every adapter.

import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

import { ATTEMPT_KEEP, KEPT_FOLDERS } from '../attempt-clone.mjs';
import { ENV_NAME } from '../project-registries.mjs';
import { programNames, programOnPath } from './process.mjs';

// The host files of a clone or worktree, from its root, the session never writes: the settings it would load on a later
// start, its skills, agents, commands, hooks, scheduled work, and MCP servers. The sandbox denies their writes, and the
// agent gate hook refuses them to a session no Human attends (lib/unattended-write.mjs, through lib/hosts/index.mjs
// protectedPaths).
export const PROTECTED_PATHS = Object.freeze([
  '.claude/settings.json', '.claude/settings.local.json', '.claude/skills', '.claude/agents', '.claude/commands', '.claude/hooks',
  '.claude/workflows', '.claude/scheduled_tasks.json', '.mcp.json',
]);

// The entries of a `.claude` folder at any depth that the host loads from a nested folder, or that hold what a later
// session runs: its skills, agents, commands, hooks, workflows, and scheduled work, and its settings files (`settings`,
// then anything, then `.json`). Any SKILL.md counts wherever it lies, and so does a `.claude` folder itself.
const NESTED_ENTRIES = Object.freeze(['skills', 'agents', 'commands', 'hooks', 'workflows', 'scheduled_tasks.json']);
const NESTED_SETTINGS = /^settings.*\.json$/u;

// Whether the path whose parts from a confined clone's root are `segments` is a host file a session no Human attends
// never writes, at any depth: a `.claude` folder, an entry of NESTED_ENTRIES or a settings file in one, or a SKILL.md.
// Names are compared in lower case, as a disk that folds case reads them.
export function nestedProtected(segments) {
  const lower = segments.filter(Boolean).map((each) => each.toLowerCase());
  const last = lower.at(-1);
  if (last === undefined) return false;
  if (last === 'skill.md' || last === '.claude') return true;
  return lower.slice(0, -1).some((each, at) => each === '.claude' && (NESTED_ENTRIES.includes(lower[at + 1]) || NESTED_SETTINGS.test(lower[at + 1])));
}

// The sandbox's denyWrite globs for the nested host files of the clone `work`, as nestedProtected reads them, and a
// `.claude` folder itself, so none is made, or made a link, at any depth: the host docs show `**` in sandbox paths;
// whether it holds for a file made after launch, on Linux above all, is live check 5.
const nestedGlobs = (work) => [
  `${work}/**/.claude`, ...NESTED_ENTRIES.flatMap((name) => [`${work}/**/.claude/${name}`, `${work}/**/.claude/${name}/**`]),
  `${work}/**/.claude/settings*.json`, `${work}/**/SKILL.md`,
];

// The user's credential stores, from the home folder, which no sandboxed command and no Read of the session reaches:
// keys, cloud and registry tokens, git's stored credentials, password managers, browser profiles, the host's own login
// and IDE lock tokens, keyrings, and shell histories. The forge CLI's own login, ~/.config/gh, stays readable: the
// session pushes and opens pull requests through it.
export const CREDENTIAL_PATHS = Object.freeze([
  '.ssh', '.gnupg', '.aws', '.netrc', '.docker', '.kube', '.config/gcloud', '.azure', '.oci', 'Library/Keychains', '.password-store',
  '.config/op', '.1password', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox',
  'Library/Application Support/BraveSoftware', 'Library/Application Support/Microsoft Edge', '.mozilla', '.config/google-chrome',
  '.config/chromium', '.git-credentials', '.npmrc', '.pypirc', '.cargo/credentials.toml', '.cargo/credentials', '.gem/credentials',
  '.vault-token', '.config/hub', '.claude.json', '.claude/.credentials.json', '.claude/ide', '.local/share/keyrings',
  '.bash_history', '.zsh_history', '.local/share/fish',
  // The package registries' token stores, beside .npmrc, .pypirc, and cargo's and gem's above: yarn's, npm's XDG
  // config, bun's, gem's XDG credentials, bundler's config, pnpm's own config, pip's config, which may name an index
  // with its password, poetry's, and uv's.
  '.yarnrc.yml', '.yarnrc', '.config/npm/npmrc', '.bunfig.toml', '.local/share/gem/credentials', '.bundle/config',
  '.config/pnpm/rc', 'Library/Preferences/pnpm/rc', '.config/pip/pip.conf', '.pip/pip.conf', 'Library/Application Support/pip/pip.conf',
  '.config/pypoetry/auth.toml', 'Library/Application Support/pypoetry/auth.toml', '.local/share/uv/credentials',
]);

// The host's own credential files in its user config folder, wherever CLAUDE_CONFIG_DIR moves it.
const CONFIG_CREDENTIALS = Object.freeze(['.credentials.json', 'ide', '.claude.json']);

// An environment variable whose name says it holds a credential, which the sandbox unsets before each sandboxed command
// runs; and the well-known ones, unset whether or not the driver's environment has them, since the host's background
// supervisor may hold another environment.
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH/iu;
const KNOWN_SECRETS = Object.freeze([
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'GITLAB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SSH_AUTH_SOCK',
]);

// The credential-named variables of `env`, and the well-known ones, but the forge's own token variables, `keep`: the
// names a sandboxed command never sees.
export function secretVars(env, keep = []) {
  const kept = new Set(keep);
  const names = [...KNOWN_SECRETS, ...Object.keys(env ?? {}).filter((name) => SECRET_NAME.test(name))];
  return [...new Set(names)].filter((name) => ENV_NAME.test(name) && !kept.has(name)).sort();
}

// The keys of the user's settings whose value is a command, or a program, the host runs outside the sandbox, and so
// outside every hold of the plugin's hooks. `--setting-sources user` drops them from project and local settings; the
// user's own still load, so one set there halts the start unless projectRun.outsideSandbox names it. The sandbox's own
// program keys (bwrapPath, socatPath) halt through the sandbox allowlist below, which no name lifts.
const COMMAND_KEYS = Object.freeze([
  'hooks', 'apiKeyHelper', 'statusLine', 'subagentStatusLine', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh',
  'otelHeadersHelper', 'fileSuggestion', 'policyHelper', 'processWrapper', 'sshHostCommands',
]);

// The keys of the user's `sandbox` settings a start lets stand, by their dotted path below `sandbox`; any other key set
// there halts it, whatever it is, so a key the host adds later halts until it is judged. Three kinds:
//   - a scalar sandboxSettings passes too: --settings wins over the user's value, so it neither widens nor narrows;
//   - a list or rule that only narrows: what sandboxed commands may not read, write, or reach, and credentials hidden
//     (credentials entries pass only with mode deny or mask);
//   - network.allowedDomains, which widens the network a sandboxed command reaches: an accepted residual, as package
//     registries need it (docs/providers/claude-code.md#project-start).
// Not here, so halting: excludedCommands, filesystem.allowWrite, allowRead, and disabled, network.allowUnixSockets,
// allowMachLookup, httpProxyPort, socksProxyPort, and tlsTerminate, bwrapPath, socatPath, ripgrep, and ignoreViolations,
// which silences the sandbox's reports of what it refused, so no reader of them sees a probe: it narrows nothing.
const OVERRIDDEN = Object.freeze([
  'enabled', 'failIfUnavailable', 'allowUnsandboxedCommands', 'autoAllowBashIfSandboxed', 'enableWeakerNestedSandbox',
  'enableWeakerNetworkIsolation', 'allowAppleEvents', 'allowNestedUserNamespaces', 'network.strictAllowlist',
  'network.allowAllUnixSockets', 'network.allowLocalBinding',
]);
const NARROWING = Object.freeze(['filesystem.denyRead', 'filesystem.denyWrite', 'network.deniedDomains', 'credentials.files', 'credentials.envVars']);
const USER_SANDBOX = new Set([...OVERRIDDEN, ...NARROWING, 'network.allowedDomains']);
const HIDING = new Set(['deny', 'mask']);

// The longest settings, installed-plugins, manifest, or frontmatter file read.
const FILE_CAP = 1024 * 1024;
// The most skill, agent, and command files read for frontmatter, and the most folders of a clone walked to find them.
const FILE_COUNT = 2000;
const FOLDER_COUNT = 20_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
// The id of this plugin as the host's enabledPlugins names it, `aidrian@<marketplace>`.
const OWN_PLUGIN = /^aidrian@[^@]+$/u;
// A frontmatter key that makes the host run a command or a server outside the sandbox, bare or quoted, at any indent.
const FRONT_KEY = /(?:^|[\s{,])["']?(?:hooks|mcpServers)["']?\s*:/u;
// The folders of a `.claude` folder whose Markdown files take frontmatter the host reads.
const COMPONENTS = Object.freeze(['skills', 'agents', 'commands']);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
// The name of the user this process runs as, or null.
const userName = () => {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
};
const within = (folder, file) => file === folder || file.startsWith(`${folder}${path.sep}`);
// Whether the folders `one` and `other` are one, or one holds the other.
const meets = (one, other) => within(one, other) || within(other, one);

// The credential stores of the user whose home is `home` and whose host config folder is `config`.
const credentialStores = (home, config) => [...new Set([
  ...CREDENTIAL_PATHS.map((each) => path.join(home, each)), ...CONFIG_CREDENTIALS.map((each) => path.join(config, each)),
])];

// The settings object of the session that works in the clone `work`, whose separate git folder is `git`, granted the
// real folders `grants` (its git, drop, and cache folders, and the state work folders), the network hosts `domains`, and the
// temporary folders `temp`, for the user whose home is `home` and host config folder `config`, on `platform`. `main` is
// the main checkout, which no sandboxed command and no Read reaches but its git folder `mainGit`, whose objects the clone
// borrows; `secrets` the environment variables the sandbox unsets (secretVars); `guarded` folders no sandboxed command
// writes even where a user's allowWrite would reach them, such as the sign-off store (review/merge-trust.mjs); `stores`
// more credential files that lie outside the home folder, as npm's global config (npmGlobalConfigs). The attempt's drop
// and cache folders each hold a keep file (attempt-clone.mjs ATTEMPT_KEEP) whose write is denied, so neither can be
// emptied and removed. No package manager variable is set here: the settings' `env` would reach the host's own process,
// its hooks, and its MCP servers, so they reach the sandboxed commands alone, through the SessionStart hook
// (writeEnvFile). Scalars passed with --settings win over the user's settings; lists merge with them, which
// accessProblem checks.
export function sandboxSettings({ work, git, grants, domains, temp, home, config = path.join(home, '.claude'), platform, main = null, mainGit = null, secrets = [], guarded = [], stores = [] }) {
  const credentials = [...new Set([...credentialStores(home, config), ...stores])];
  const unread = main ? [...credentials, main] : credentials;
  const reopen = main && mainGit && within(main, mainGit) ? { allowRead: [mainGit] } : {};
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: platform === 'darwin',
      allowAppleEvents: false,
      allowNestedUserNamespaces: false,
      filesystem: {
        allowWrite: [...new Set([...grants, ...temp])],
        denyWrite: [
          path.join(work, '.git'), path.join(git, 'config'), path.join(git, 'hooks'), path.join(git, 'commondir'), path.join(git, 'config.worktree'),
          ...PROTECTED_PATHS.map((each) => path.join(work, each)), ...nestedGlobs(work), ...guarded,
          ...KEPT_FOLDERS.map((name) => path.join(path.dirname(git), name, ATTEMPT_KEEP)),
        ],
        denyRead: unread,
        ...reopen,
      },
      network: { strictAllowlist: true, allowedDomains: [...domains], allowAllUnixSockets: false, allowLocalBinding: false },
      credentials: { envVars: secrets.map((name) => ({ name, mode: 'deny' })) },
    },
    // Read rules take `//` for an absolute path; the file tools run outside the sandbox, so they need their own.
    // The guarded folders are held from the file tools too, which run outside the sandbox.
    permissions: { deny: [...unread.flatMap((each) => [`Read(/${each})`, `Read(/${each}/**)`]), ...guarded.flatMap((each) => [`Edit(/${each})`, `Edit(/${each}/**)`])] },
    // The claude.ai connectors load whatever --strict-mcp-config says; only this turns them off, and a true wins from any source.
    disableClaudeAiConnectors: true,
    worktree: { bgIsolation: 'none' },
    // A usage limit pauses the session until the limit resets, then the host continues it, keeping its unpushed work,
    // where the limit dialog would otherwise wait on a person (lib/project-limit.mjs).
    autoContinueAtUsageLimit: true,
  };
}

// The credential stores the sandbox denies reading for the user whose home is `home`, under `env`, which the per-start
// sandbox proof tries to read from inside the session (lib/project-confine.mjs): the proof reads the ones there.
export const confineReads = ({ env, home }) => {
  const user = home ?? homedir();
  return [...new Set([...credentialStores(user, configFolder(env, user)), ...npmGlobalConfigs(env)])];
};

// The npm config files a sandboxed command could read a registry token from beside ~/.npmrc: the user and global config
// files the driver's environment names (npm_config_userconfig and npm_config_globalconfig, in either case), and
// `<prefix>/etc/npmrc`, for the prefix it names and the one the npm first on PATH, in an absolute folder, lies under
// (`<prefix>/bin/npm`).
export function npmGlobalConfigs(env) {
  const absolute = (each) => typeof each === 'string' && path.isAbsolute(each) && !CONTROL.test(each);
  const named = [env.npm_config_userconfig, env.NPM_CONFIG_USERCONFIG, env.npm_config_globalconfig, env.NPM_CONFIG_GLOBALCONFIG].filter(absolute).map((each) => path.resolve(each));
  const prefixes = [env.NPM_CONFIG_PREFIX, env.npm_config_prefix].filter(absolute);
  const npm = programOnPath(env, programNames('npm'));
  if (npm && !CONTROL.test(npm)) prefixes.push(path.dirname(path.dirname(npm)));
  return [...new Set([...named, ...prefixes.map((prefix) => path.join(path.resolve(prefix), 'etc', 'npmrc'))])];
}

// A value as a POSIX shell reads it inside single quotes, each quote closed, escaped, and opened again.
const quoted = (value) => `'${value.replaceAll("'", "'\\''")}'`;

// Appends an `export NAME='value'` line for each of `vars` to the host's session environment file `file`, which the
// host sources before each Bash command of the session, and no hook or MCP server reads: whether it wrote them. A file
// that is no absolute path, a link, or a name a shell does not take writes nothing.
export function writeEnvFile(file, vars) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || CONTROL.test(file)) return false;
  const entries = Object.entries(vars ?? {});
  if (!entries.length || !entries.every(([name, value]) => ENV_NAME.test(name) && typeof value === 'string' && !CONTROL.test(value))) return false;
  let fd;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    if (!fstatSync(fd).isFile()) return false;
    writeSync(fd, `${entries.map(([name, value]) => `export ${name}=${quoted(value)}`).join('\n')}\n`);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The MCP configuration the session starts with under --strict-mcp-config: only `servers`, the base branch's
// projectRun.mcpServers.
export const mcpConfig = (servers) => ({ mcpServers: isObject(servers) ? servers : {} });

// The host's user config folder under `env`, and the home folder a test may give.
export const configFolder = (env, home) => env.CLAUDE_CONFIG_DIR || path.join(home ?? env.HOME ?? homedir(), '.claude');

// The JSON of the regular file `file`, read without following a link: { value }, { missing: true }, or { problem }.
function readJson(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: 'it is not a regular file' };
    if (stat.size > FILE_CAP) return { problem: 'it is too large to read' };
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return { value: JSON.parse(buffer.subarray(0, read).toString('utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    return { problem: error instanceof SyntaxError ? 'it is not JSON' : `it cannot be read (${error.code ?? 'no code'})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The user's settings: { value, file }, an empty object when there is no file, or { problem, file }.
function userSettings(folder) {
  const file = path.join(folder, 'settings.json');
  const read = readJson(file);
  if (read.missing) return { value: {}, file };
  if (read.problem) return { problem: `the host's user settings ${file} cannot be read: ${read.problem}`, file };
  if (!isObject(read.value)) return { problem: `the host's user settings ${file} are not a JSON object`, file };
  return { value: read.value, file };
}

// The host's record of installed plugins in the user config folder `folder`: { records } by plugin id, each a list of
// install records, none when there is no file, or { problem }.
function installedPlugins(folder) {
  const read = readJson(path.join(folder, 'plugins', 'installed_plugins.json'));
  if (read.missing) return { records: {} };
  if (read.problem || !isObject(read.value?.plugins)) return { problem: 'the host\'s list of installed plugins cannot be read' };
  const records = Object.fromEntries(Object.entries(read.value.plugins).map(([id, list]) => [id, Array.isArray(list) ? list.filter(isObject) : []]));
  return { records };
}

// The value at the dotted `key` of `value`.
const at = (value, key) => key.split('.').reduce((each, part) => (isObject(each) ? each[part] : undefined), value);
// The entries of the list at `key`: none when unset, and a value that is no list as one entry, which no check places.
const listAt = (value, key) => {
  const found = at(value, key);
  if (found === undefined || found === null) return [];
  return Array.isArray(found) ? found : [found];
};
// Whether a settings value is set: a non-empty object or list, or any other value but null.
const isSet = (value) => (Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : value !== undefined && value !== null);

// Why this plugin would not load in a session started with --setting-sources user, or null: the user's settings must
// enable it (`enabledPlugins`), or the host must record it installed at user scope with no user setting that turns it
// off. A plugin a project's settings enable, or a project-scope install, does not load from user settings alone, and
// then no hook of this plugin would hold the session: the start would wait for a beacon that never comes.
function ownPluginProblem(settings, folder, installed) {
  const flags = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  if (Object.keys(flags).some((id) => OWN_PLUGIN.test(id) && flags[id] === true)) return null;
  const userScope = Object.entries(installed.records ?? {}).some(([id, list]) => OWN_PLUGIN.test(id) && flags[id] !== false && list.some((each) => each.scope === 'user'));
  if (userScope) return null;
  return `this plugin is not enabled in the host's user settings, and a session started with --setting-sources user loads only those, so none of its hooks would hold the session; install it at user scope with \`claude plugin install aidrian@<marketplace> --scope user\`, or add "enabledPlugins": { "aidrian@<marketplace>": true } to ${path.join(folder, 'settings.json')}`;
}

// The ids and names a plugin's manifest at `place` says it depends on, or null when the manifest cannot be read.
function dependencies(place) {
  if (typeof place !== 'string' || !path.isAbsolute(place)) return null;
  const manifest = readJson(path.join(place, '.claude-plugin', 'plugin.json'));
  if (manifest.missing) return [];
  if (manifest.problem || !isObject(manifest.value)) return null;
  const listed = Array.isArray(manifest.value.dependencies) ? manifest.value.dependencies : [];
  return listed.map((each) => (typeof each === 'string' ? each : each?.name)).filter((each) => typeof each === 'string');
}

// Why a plugin other than this one would run a hook, an MCP or LSP server, or a monitor outside the sandbox, or null.
// Every plugin the host records installed, or the user's enabledPlugins names, counts as enabled unless enabledPlugins
// sets it false and no enabled plugin depends on it, since a plugin with no entry follows its own default, which is on.
// Each one counts unless projectRun.outsideSandbox, `named`, names it; one enabled with no install record counts too.
function otherPluginsProblem(settings, installed, named) {
  const flags = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const { records } = installed;
  const ids = [...new Set([...Object.keys(records), ...Object.keys(flags)])].filter((id) => !OWN_PLUGIN.test(id)).sort();
  const enabled = ids.filter((id) => flags[id] !== false);
  // What every enabled plugin, this one included, depends on; null when a manifest cannot be read, so each counts.
  const needed = [];
  for (const id of [...enabled, ...Object.keys(records).filter((each) => OWN_PLUGIN.test(each))]) {
    for (const record of records[id] ?? []) {
      const listed = dependencies(record.installPath);
      if (listed === null) return `the manifest of the plugin ${id} cannot be read, so which plugins it loads cannot be told`;
      needed.push(...listed);
    }
  }
  const dependedOn = (id) => needed.some((each) => each === id || each === id.split('@')[0]);
  for (const id of ids) {
    if (named.has(id) || !(flags[id] !== false || dependedOn(id))) continue;
    if (!(records[id] ?? []).length) return `the plugin ${id} is enabled in the host's user settings with no install record, so what it runs cannot be told; remove it from enabledPlugins, or the team names it in projectRun.outsideSandbox`;
    return `the plugin ${id} is enabled, and a plugin's hooks, MCP and LSP servers, and monitors run outside the sandbox of a session no Human attends; turn it off in the host's user settings ("enabledPlugins": { "${id}": false }), or the team names it in projectRun.outsideSandbox`;
  }
  return null;
}

// Why the user's settings `settings` (the parsed settings.json of the host's user folder `folder`) would run a command
// outside the sandbox, or load another plugin, that projectRun.outsideSandbox, `allowed`, does not name, or null: a key
// of COMMAND_KEYS, or an enabled plugin other than this one (otherPluginsProblem).
export function userSettingsProblem(settings, { folder, allowed = [] }) {
  const named = new Set(allowed);
  const key = COMMAND_KEYS.find((each) => isSet(at(settings, each)) && !named.has(each));
  if (key) return `the host's user settings set ${key}, a command the host runs outside the sandbox of a session no Human attends; remove it, or the team names it in projectRun.outsideSandbox`;
  const installed = installedPlugins(folder);
  if (installed.problem) return `${installed.problem}, so which plugins load outside the sandbox cannot be told`;
  return otherPluginsProblem(settings, installed, named);
}

// A path as the user's settings write it, `spelled`, as an absolute path: `~/` from `home`; for a permission rule
// (`rule`), `//` for an absolute path; else an absolute path as it is, and a relative one from `folder`, the settings
// folder a relative sandbox path is read from. Null for a path whose anchor is the session's folder, unknown here: a
// relative permission rule, or a relative path where `folder` is null.
function settingsPath(spelled, { home, folder = null, rule = false }) {
  if (typeof spelled !== 'string' || spelled === '' || CONTROL.test(spelled)) return null;
  if (spelled === '~' || spelled.startsWith('~/')) return path.join(home, spelled.slice(1));
  if (rule) return spelled.startsWith('//') ? path.resolve(spelled.slice(1)) : null;
  if (path.isAbsolute(spelled)) return path.resolve(spelled);
  return folder === null ? null : path.resolve(folder, spelled);
}

// A path cut at its first glob character, as the folder a rule or root reaches.
const cutAtGlob = (spelled) => {
  const index = spelled.search(/[*?[{]/u);
  return index < 0 ? spelled : spelled.slice(0, index);
};

// The real path of `file`, or its spelling when it is not there yet.
const realOf = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

// The folders the user's permission settings grant a session write to: permissions.additionalDirectories, and each Edit
// or Write allow rule that starts `//` or `~`, cut at its first glob; a root the gate cannot place is null.
function grantedRoots(settings, { home }) {
  const roots = [];
  for (const each of listAt(settings, 'permissions.additionalDirectories')) roots.push({ spelled: each, file: settingsPath(each, { home }) });
  for (const rule of listAt(settings, 'permissions.allow')) {
    const match = /^(?:Edit|Write)\((.*)\)$/u.exec(typeof rule === 'string' ? rule.trim() : '');
    if (!match || !/^(?:\/\/|~)/u.test(match[1])) continue;
    roots.push({ spelled: rule, file: settingsPath(cutAtGlob(match[1]), { home, rule: true }) });
  }
  return roots;
}

// The first key below the user's `sandbox` settings `value` that USER_SANDBOX does not let stand, as its dotted path,
// or null; `prefix` is the path walked so far. A key set to null is unset. A credentials entry that does not hide
// (mode deny or mask) counts as the key that holds it.
function sandboxKeyProblem(value, prefix = '', strict = null) {
  if (!isObject(value)) return null;
  for (const [key, entry] of Object.entries(value)) {
    const dotted = `${prefix}${key}`;
    if (entry === null || entry === undefined) continue;
    // A source that ranks above --settings keeps an overridden scalar only at the value the session's own settings set.
    if (strict && OVERRIDDEN.includes(dotted)) {
      if (!(strict[dotted] ?? []).includes(entry)) return dotted;
      continue;
    }
    if (USER_SANDBOX.has(dotted)) {
      if (dotted.startsWith('credentials.') && !(Array.isArray(entry) && entry.every((each) => isObject(each) && HIDING.has(each.mode)))) return dotted;
      continue;
    }
    if (isObject(entry) && [...USER_SANDBOX].some((each) => each.startsWith(`${dotted}.`))) {
      const below = sandboxKeyProblem(entry, `${dotted}.`, strict);
      if (below) return below;
      continue;
    }
    if (isSet(entry)) return dotted;
  }
  return null;
}

// What the user's settings, which still load under --setting-sources user, would do to the sandbox: a reason, or null.
// Any `sandbox` key outside USER_SANDBOX halts; so does a permission grant whose folder holds, is, or lies in a guarded
// one, or that the gate cannot place.
function weakenedProblem(settings, { home, guarded, label = 'the host\'s user settings', strict = null }) {
  if (isSet(settings.sandbox) && !isObject(settings.sandbox)) return `${label} set sandbox to a value that is not an object, so what it does to the sandbox of a session no Human attends cannot be told`;
  const key = sandboxKeyProblem(settings.sandbox, '', strict);
  if (key) return `${label} set sandbox.${key}, which does not only narrow the sandbox of a session no Human attends; such a session starts only with the sandbox keys that narrow it, and network.allowedDomains (docs/providers/claude-code.md#project-start)`;
  for (const { spelled, file } of grantedRoots(settings, { home })) {
    if (file === null) return `${label} grant ${String(spelled).slice(0, 200)}, a path the gate cannot place, so whether a session could write a folder the run guards cannot be told`;
    const real = realOf(file);
    const reaches = guarded.find((each) => meets(real, each));
    if (reaches) return `${label} grant ${String(spelled).slice(0, 200)}, which reaches ${reaches}, a folder a session no Human attends must not write`;
  }
  return null;
}

// The values of each overridden sandbox scalar a managed source may set, which ranks above --settings: those the
// session's own settings set (sandboxSettings), and, for autoAllowBashIfSandboxed, either, since false only asks more.
const strictScalars = (platform) => ({
  enabled: [true], failIfUnavailable: [true], allowUnsandboxedCommands: [false], autoAllowBashIfSandboxed: [true, false], enableWeakerNestedSandbox: [false],
  enableWeakerNetworkIsolation: platform === 'darwin' ? [true, false] : [false], allowAppleEvents: [false], allowNestedUserNamespaces: [false],
  'network.strictAllowlist': [true], 'network.allowAllUnixSockets': [false], 'network.allowLocalBinding': [false],
});

// The system folder of the host's managed settings files, and the macOS managed preferences files of its policy domain,
// for `user` (code.claude.com/docs/en/managed-settings, delivery mechanisms). The host ranks each above --settings.
const MANAGED_DIRS = Object.freeze({ darwin: '/Library/Application Support/ClaudeCode', linux: '/etc/claude-code' });
const PLIST_DOMAIN = 'com.anthropic.claudecode';
export const managedPlists = (user) => [`/Library/Managed Preferences/${PLIST_DOMAIN}.plist`, ...(user ? [`/Library/Managed Preferences/${user}/${PLIST_DOMAIN}.plist`] : [])];

// The managed settings documents the host reads on `platform`, lowest rank first: `managed-settings.json` and each
// `managed-settings.d/*.json` in the system folder, by name, then on macOS the managed preferences of the host's
// policy domain, read through plutil. { documents: [{ source, value }] }, or { problem } when a source is there and
// cannot be read, or the platform's sources are unknown. `managed` is a test's, { dir, plists }; `run` spawnSync's shape.
export function managedSettings({ platform, managed = null, user = null, run = spawnSync }) {
  const dir = managed?.dir ?? MANAGED_DIRS[platform];
  if (!dir) return { problem: `the host's managed settings on ${platform} are not ones the start can read, and they rank above the session's own settings` };
  const documents = [];
  const take = (source, read) => {
    if (read.missing) return null;
    if (read.problem) return `the host's managed settings ${source} cannot be read: ${read.problem}, and they rank above the session's own settings`;
    if (!isObject(read.value)) return `the host's managed settings ${source} are not a JSON object`;
    documents.push({ source, value: read.value });
    return null;
  };
  const main = take(path.join(dir, 'managed-settings.json'), readJson(path.join(dir, 'managed-settings.json')));
  if (main) return { problem: main };
  const drops = path.join(dir, 'managed-settings.d');
  let names = [];
  try {
    names = readdirSync(drops).filter((name) => !name.startsWith('.') && name.endsWith('.json')).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') return { problem: `the host's managed settings folder ${drops} cannot be listed (${error.code ?? 'no code'}), and its files rank above the session's own settings` };
  }
  for (const name of names) {
    const problem = take(path.join(drops, name), readJson(path.join(drops, name)));
    if (problem) return { problem };
  }
  const plists = managed?.plists ?? (platform === 'darwin' ? managedPlists(user) : []);
  for (const file of plists) {
    try {
      lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      return { problem: `the host's managed preferences ${file} cannot be read (${error.code ?? 'no code'})` };
    }
    const read = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', file], { encoding: 'utf8', timeout: 10_000 });
    let value;
    try {
      value = read.status === 0 ? JSON.parse(read.stdout) : undefined;
    } catch {
      value = undefined;
    }
    const problem = take(file, value === undefined ? { problem: 'plutil cannot convert it to JSON' } : { value });
    if (problem) return { problem };
  }
  return { documents };
}

// Why the managed settings `documents` would weaken the session's sandbox, run a command outside it, or grant a guarded
// folder, under the user settings' rules, with an overridden sandbox scalar kept only at the session's own value; or null.
function managedProblem(documents, { home, guarded, platform, allowed }) {
  const named = new Set(allowed);
  for (const { source, value } of documents) {
    const label = `the host's managed settings ${source}`;
    const weakened = weakenedProblem(value, { home, guarded, label, strict: strictScalars(platform) });
    if (weakened) return weakened;
    const key = COMMAND_KEYS.find((each) => isSet(at(value, each)) && !named.has(each));
    if (key) return `${label} set ${key}, a command the host runs outside the sandbox of a session no Human attends; the team names it in projectRun.outsideSandbox, or the organization removes it`;
    // The host then drops the session's own permission rules, which hold its file tools from the credential stores.
    if (value.allowManagedPermissionRulesOnly === true) return `${label} set allowManagedPermissionRulesOnly, so the host drops the permission rules the session's own settings pass, which keep its file tools from the stores its sandbox hides`;
  }
  return null;
}

// The user's settings with the plugin switches of the managed `documents` over theirs, as the host ranks them.
const withManagedPlugins = (settings, documents) => ({
  ...settings,
  enabledPlugins: Object.assign({}, isObject(settings.enabledPlugins) ? settings.enabledPlugins : {}, ...documents.map(({ value }) => (isObject(value.enabledPlugins) ? value.enabledPlugins : {}))),
});

// The network hosts the user's and the organization's settings add to the session's allowedDomains, which lists merge:
// the sandbox proof names a host outside them (lib/project-confine.mjs). Unreadable settings add none; the start halts
// on them anyway.
export function confineDomains({ env, home, platform = process.platform, managed = null }) {
  const user = home ?? env.HOME ?? homedir();
  const settings = userSettings(configFolder(env, user));
  const documents = managedSettings({ platform, managed, user: userName() }).documents ?? [];
  return [settings.value ?? {}, ...documents.map((each) => each.value)].flatMap((value) => listAt(value, 'sandbox.network.allowedDomains')).filter((each) => typeof each === 'string');
}

// Whether `url`, a push URL, goes over SSH: `ssh://`, `git+ssh://`, or the scp form `[user@]host:path`.
const overSsh = (url) => /^(?:git\+)?ssh:\/\//iu.test(url) || /^(?:[^@/:\s]+@)?[^/:\s]+:(?!\/\/)/u.test(url);
// Whether a git credential helper's value keeps the token in a file the sandbox hides, as `store` keeps ~/.git-credentials.
const storeHelper = (value) => /^\s*(?:store\b|!?\S*git-credential-store\b)/u.test(value);

// Why a session the host starts now under sandboxSettings could not run as confined as it is meant to, or could not push:
// a halt, or null. `env` and `home` name the user's settings; `guarded` holds the real folders no session no Human
// attends may write; `pushUrl` is the URL the attempt's clone pushes to, origin's URL in the main checkout; `helpers` the
// git credential helpers its config names; `platform` the operating system; `allowed`, the base branch's
// projectRun.outsideSandbox. The checks, in order: the user's settings read; their sandbox keys and grants; this plugin
// enabled; their command keys and other plugins; the user's own skills, agents, and commands; then origin, git's
// credential helper, and bubblewrap and socat on Linux.
export function accessProblem({ env, home, guarded = [], pushUrl, platform, allowed = [], helpers = [], managed = null }) {
  const user = home ?? env.HOME ?? homedir();
  const folder = configFolder(env, user);
  const settings = userSettings(folder);
  if (settings.problem) return settings.problem;
  const weakened = weakenedProblem(settings.value, { home: user, guarded });
  if (weakened) return weakened;
  const read = managedSettings({ platform, managed, user: userName() });
  if (read.problem) return read.problem;
  const ranked = managedProblem(read.documents, { home: user, guarded, platform, allowed });
  if (ranked) return ranked;
  const effective = withManagedPlugins(settings.value, read.documents);
  const installed = installedPlugins(folder);
  if (installed.problem) return `${installed.problem}, so whether this plugin loads cannot be told`;
  const own = ownPluginProblem(effective, folder, installed);
  if (own) return own;
  const command = userSettingsProblem(effective, { folder, allowed });
  if (command) return command;
  const components = componentsProblem({ root: folder, folders: [folder], label: '~/.claude/', where: ', in the host\'s user config folder,', allowed });
  if (components) return components;
  if (typeof pushUrl !== 'string' || pushUrl === '') return 'git names no URL origin pushes to in the main checkout, so whether the session could push cannot be told';
  if (overSsh(pushUrl)) {
    return `origin's URL, which the attempt's clone pushes to, goes over SSH (${pushUrl.slice(0, 80)}), and the host's sandbox hides ~/.ssh and refuses SSH, so the session could not push its branch; set an HTTPS URL, \`git remote set-url origin https://<host>/<owner>/<name>.git\`, and remove any url.<base>.insteadOf rule in the git config that rewrites it to SSH, which \`git config --get-regexp 'insteadof$'\` lists`;
  }
  if (helpers.some((each) => typeof each === 'string' && storeHelper(each))) {
    return 'git\'s credential helper `store` keeps the push token in ~/.git-credentials, which the sandbox hides from the session, so it could not push; use the forge CLI\'s helper instead, `gh auth setup-git`, and remove the `store` helper from the git config';
  }
  if (platform === 'linux') {
    const missing = ['bwrap', 'socat'].find((name) => !programOnPath(env, programNames(name)));
    if (missing) return `${missing} is not on PATH, in an absolute folder, and the host's sandbox needs it on Linux; install bubblewrap and socat`;
  }
  return null;
}

// The frontmatter of a Markdown text: its lines between a first `---` line and the next, or null.
function frontmatter(text) {
  const lines = text.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.slice(1).findIndex((line) => line.trim() === '---');
  return end < 0 ? null : lines.slice(1, end + 1);
}

// The `.claude` folders of the clone `work` at any depth, any case, not through a link and not in a `.git` folder,
// within `budget.folders` folders walked: { folders }, { link } for the first entry named `.claude` that is a link, as
// its path from the clone's root, or null past the budget. The host loads a nested `.claude` through such a link, from
// wherever it leads, which no walk of the clone reads, and the placeholders would be written through it.
function claudeFolders(work, budget) {
  const found = [];
  const pending = [work];
  while (pending.length) {
    const dir = pending.pop();
    budget.folders -= 1;
    if (budget.folders < 0) return null;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const claude = entry.name.toLowerCase() === '.claude';
      if (claude && entry.isSymbolicLink()) return { link: path.relative(work, full).split(path.sep).join('/') };
      if (!entry.isDirectory() || entry.name === '.git') continue;
      if (claude) found.push(full);
      else pending.push(full);
    }
  }
  return { folders: found.sort() };
}

// Why the Markdown file `full`, shown as `shown`, declares hooks or MCP servers in its frontmatter, or cannot be read, or null.
function frontmatterProblem(full, shown) {
  let text;
  try {
    text = readFileSync(full, 'utf8').slice(0, FILE_CAP);
  } catch {
    return `${shown} cannot be read, so whether its frontmatter declares hooks cannot be told`;
  }
  if (!(frontmatter(text) ?? []).some((line) => FRONT_KEY.test(line))) return null;
  return `${shown} declares hooks or MCP servers in its frontmatter, which the host runs outside the sandbox of a session no Human attends; the team names it in projectRun.outsideSandbox, or removes them`;
}

// Why the component folder `dir` (a skills, agents, or commands folder), whose files are named from `root` under
// `label` and said to lie `where`, holds a file the host would run outside the sandbox, or a link that leads out of it,
// or null; `budget.files` bounds the files read, and `named` the paths projectRun.outsideSandbox names.
function componentProblem(dir, { root, label, where, named, budget }) {
  let top;
  try {
    top = realpathSync(dir);
  } catch {
    return null;
  }
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return `${label}${path.relative(root, current).split(path.sep).join('/')}${where} cannot be listed, so whether it declares hooks cannot be told`;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const shown = `${label}${path.relative(root, full).split(path.sep).join('/')}`;
      if (named.has(shown)) continue;
      if (entry.isSymbolicLink()) {
        if (!within(top, realOf(full))) return `${shown}${where} is a link that leads out of its folder, so the host would load a file a review of that folder never saw, and a session may write; the team names it in projectRun.outsideSandbox, or replaces the link with the files`;
        continue;
      }
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && /\.md$/iu.test(entry.name)) {
        budget.files -= 1;
        if (budget.files < 0) return `more than ${FILE_COUNT} skill, agent, and command files are there to read, so whether one declares hooks cannot be told`;
        const why = frontmatterProblem(full, `${shown}${where}`);
        if (why) return why;
      }
    }
  }
  return null;
}

// Why one of the `.claude` folders `folders` (or, for the user's config folder, that folder itself) holds a skill,
// agent, or command the host would run outside the sandbox: componentProblem for each of its COMPONENTS.
function componentsProblem({ root, folders, label, where, allowed }) {
  const named = new Set(allowed);
  const budget = { files: FILE_COUNT };
  for (const folder of folders) {
    for (const name of COMPONENTS) {
      const why = componentProblem(path.join(folder, name), { root, label, where, named, budget });
      if (why) return why;
    }
  }
  return null;
}

// Why the clone `work` holds, under a `.claude` folder at any depth, a skill, agent, or command whose frontmatter
// declares hooks or MCP servers, which the host runs outside the sandbox, or a link under one that leads out of its
// folder, or null. `allowed`, projectRun.outsideSandbox, may name one by its path from the clone's root. A `.claude`
// that is itself a link, at the root or at any depth, halts whatever the team names: the fix is the folder itself.
export function cloneProblem({ work, allowed = [] }) {
  const walked = claudeFolders(work, { folders: FOLDER_COUNT });
  if (walked === null) return `the attempt's clone holds more than ${FOLDER_COUNT} folders, so whether a nested .claude folder declares hooks cannot be told`;
  if (walked.link) return `${walked.link} in the attempt's clone is a link, and the host loads the skills, agents, commands, hooks, and settings of a .claude folder from wherever it leads, which a session may write; replace the link with the folder, then start again`;
  return componentsProblem({ root: work, folders: walked.folders, label: '', where: ' in the attempt\'s clone', allowed });
}

// The host files to put in a fresh clone, from its root, before its session starts, where none is there: a folder
// (`folder: true`) or a file with `text`. On Linux a sandbox write denial holds only on a path there at launch, so each
// protected entry that can be there harmlessly is made: the settings files and .mcp.json as `{}`, which
// --setting-sources user and --strict-mcp-config never load; and the hooks and workflows folders empty, as are the
// skills, agents, and commands folders, which hold nothing to load. .claude/scheduled_tasks.json is left out: its shape
// is the host's, and a file it cannot read may stop a scheduled task; the hook and the sandbox's own placeholder hold it.
export const PLACEHOLDERS = Object.freeze([
  { path: '.claude/settings.json', text: '{}\n' }, { path: '.claude/settings.local.json', text: '{}\n' }, { path: '.mcp.json', text: '{}\n' },
  ...['skills', 'agents', 'commands', 'hooks', 'workflows'].map((name) => ({ path: `.claude/${name}`, folder: true })),
]);

// What the session is told beside the project prompt: it works only in its attempt's clone, under the host's sandbox,
// pushes its branch with a full refspec over the HTTPS URL its clone has, and names the branch to every forge command.
export const sessionNote = ({ work, branch }) => `This session runs in Claude Code's sandbox, in ${work}, a clone made for this attempt: work only in that folder, and never ask to run a command outside the sandbox. ` +
  `Push only with \`git push origin HEAD:refs/heads/${branch}\`, in a call of its own, and name the branch to every forge command, as \`gh pr create --head ${branch}\`. ` +
  'This session starts no other session and hands no continuation over: when its work ends, it records its result.';

// Why the host would not carry on by itself after a usage limit, or null: a limit is account-wide, so it stops a project
// run's driver at the same moment as the issues' sessions, and only a driver whose host continues on its own takes the
// run on once the limit lifts. The user's settings must set `autoContinueAtUsageLimit` to true. It reads only the user's
// settings, where the host's own code honors the key; a project or managed setting is not read, and is no answer.
export function limitContinueProblem({ env, home }) {
  const settings = userSettings(configFolder(env, home ?? env.HOME ?? homedir()));
  if (settings.problem) return settings.problem;
  if (settings.value.autoContinueAtUsageLimit === true) return null;
  return `the host's user settings ${settings.file} do not set "autoContinueAtUsageLimit": true, so a usage limit would stop the driver for good; add it`;
}
