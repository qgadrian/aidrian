// How the Claude mod reads `aidrian session snapshot`: it finds the aidrian plugin installed for the session's folder,
// finds the session's transcript, runs the snapshot with one process at a time, and coalesces the triggers that come
// while it runs. A mod module has no Node, so this file imports nothing and takes everything outside it in `io`:
//   fs              $.fs: read(path), list(path), stat(path, { resolve })
//   run             $.process.run(argv, { cwd, env, timeoutMs }): no shell; rejects when it cannot start or times out
//   now             $.clock.now
//   env             { PATH, HOME, CLAUDE_CONFIG_DIR }: the values the mod read, each by its own name, with $.env.get
//   pluginRoot      $.plugin.root
//   enabledPlugins  () => $.settings.read({ key: 'enabledPlugins' })
// Every process the mod starts, this snapshot, the focus check, and the band's git reads, goes through one resolver,
// runnerFor: a program of its allowlist by an absolute argv[0], never a shell, env PATH set to the entries it checked,
// whose git and gh, which the snapshot starts by name, it checked too, and a time limit.

// The aidrian plugin's SESSION_ID (its lib/handoff-markers.mjs), held equal by test/claude-mod-servers.test.mjs.
export const SESSION_ID = /^[\w-]{1,128}$/u;
// Above the snapshot's 4 s forge budget and the first read of a long transcript.
export const SNAPSHOT_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
// The focus check: osascript by its absolute path, with one constant script. The mod compares its focusApp setting
// with the output, so no setting or other text ever reaches the script.
export const OSASCRIPT = '/usr/bin/osascript';
export const FOCUS_SCRIPT = 'tell application "System Events" to get name of first process whose frontmost is true';
const FOCUS_TIMEOUT_MS = 2_000;
// The programs the resolver runs: node for the snapshot and git for the band's branch. The mod reads files through
// $.fs, so it runs no program to read one. aidrian is only looked up on PATH, to reach its lib/cli.mjs, which runs by
// node, never by the command's own shell script.
const RUNNABLE = new Set(['node', 'git']);
const LOOKED_UP = new Set([...RUNNABLE, 'aidrian']);
// The programs the snapshot itself starts by name from the PATH it is given (the aidrian plugin's lib/git.mjs and
// lib/forges/github-cli.mjs), so each PATH entry is checked for them too.
const STARTED_BY_NAME = ['git', 'gh'];
const MARKETPLACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAbsolute = (value) => typeof value === 'string' && value.startsWith('/');
// Whether `child` is `parent` or below it, at a separator boundary.
const within = (child, parent) => child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);
// A path as a case-insensitive disk compares it. A real path keeps the spelling it was asked by, so a case alias of a
// folder inside the session's folder resolves to another spelling; the fences compare folded paths, which only ever
// counts more paths as inside.
const folded = (file) => file.normalize('NFC').toLowerCase();
const below = (child, parent) => child !== parent && within(child, parent);
const parentOf = (file) => file.slice(0, file.lastIndexOf('/')) || '/';
const own = (object, key) => (isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined);

// The stat of the absolute `file`, with its real path, when it resolves and is of `kind` ('file' or 'dir'); else null.
async function realStat(io, file, kind) {
  if (!isAbsolute(file)) return null;
  try {
    const stat = await io.fs.stat(file, { resolve: true });
    if (!isAbsolute(stat?.realPath) || (kind && stat.kind !== kind)) return null;
    return stat;
  } catch {
    return null;
  }
}

// Whether `name` is shown absent from the folder `real`: a stat that does not resolve finds nothing there, and the
// folder's listing holds no such name. A denied lookup, or a listing that fails, shows no absence.
async function isAbsent(io, real, name) {
  try {
    await io.fs.stat(`${real}/${name}`, { resolve: false });
    return false;
  } catch {
    // Nothing a plain stat sees: the listing tells an absent name from a denied lookup.
  }
  try {
    const names = await io.fs.list(real);
    return Array.isArray(names) && !names.some((entry) => entry?.name === name);
  } catch {
    return false;
  }
}

// Whether each program of STARTED_BY_NAME in the folder `real` is shown absent, or resolves to a real path `outside`
// keeps. It fails closed: one that exists and cannot be resolved, as a link to nothing yet, or whose lookup is denied,
// fails the check.
async function startsOutside(io, real, outside) {
  for (const name of STARTED_BY_NAME) {
    let found;
    try {
      found = await io.fs.stat(`${real}/${name}`, { resolve: true });
    } catch {
      if (await isAbsent(io, real, name)) continue;
      return false;
    }
    if (!isAbsolute(found?.realPath) || !outside(found.realPath)) return false;
  }
  return true;
}

// The resolver every process of the mod runs through. Its PATH is the absolute entries of the mod's PATH whose real
// path holds no PATH separator and lies outside the real session folder `cwd` and session root `root`, compared folded,
// and whose git and gh, where present, lie outside both too; `which` finds a program of LOOKED_UP on them, outside both too; `run` starts one of
// RUNNABLE; `frontmostApp` runs the focus check and gives the frontmost application's name, or null. A check that
// cannot be made leaves no entry.
export async function runnerFor(io, { cwd, root }) {
  const fences = await Promise.all([cwd, root].map(async (folder) => (await realStat(io, folder, 'dir'))?.realPath));
  const fenced = fences.every(Boolean);
  const outside = (real) => fenced && fences.every((fence) => !within(folded(real), folded(fence)));
  const entries = [];
  for (const entry of String(io.env?.PATH ?? '').split(':')) {
    const real = (await realStat(io, entry, 'dir'))?.realPath;
    // A real path holding the separator would split into entries no check saw, once joined into the child's PATH.
    const isNew = real && !real.includes(':') && outside(real) && !entries.includes(real);
    if (isNew && (await startsOutside(io, real, outside))) entries.push(real);
  }
  const which = async (name) => {
    if (!LOOKED_UP.has(name)) return null;
    for (const entry of entries) {
      const found = await realStat(io, `${entry}/${name}`, 'file');
      if (found && outside(found.realPath)) return found.realPath;
    }
    return null;
  };
  const start = (argv, folder, timeoutMs) => io.run(argv, { cwd: folder, env: { PATH: entries.join(':') }, timeoutMs });
  const run = async (name, args, { cwd: folder = cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
    const program = RUNNABLE.has(name) ? await which(name) : null;
    if (program === null) throw new Error(`not run: ${name}`);
    return start([program, ...args], folder, timeoutMs);
  };
  const frontmostApp = async () => {
    try {
      const ran = await start([OSASCRIPT, '-e', FOCUS_SCRIPT], cwd, FOCUS_TIMEOUT_MS);
      return ran?.exitCode === 0 ? String(ran.stdout).trim() : null;
    } catch {
      return null;
    }
  };
  return { entries, outside, which, run, frontmostApp };
}

// The Claude mod's own marketplace and config dir, from the real path of its root,
// `<config dir>/plugins/cache/<marketplace>/<plugin>/<version>`; null outside a plugins cache, as for --plugin-dir.
export async function ownPlace(io) {
  const root = await realStat(io, io.pluginRoot, 'dir');
  const found = root ? /^(\/.*)\/plugins\/cache\/([^/]+)\/[^/]+\/[^/]+$/u.exec(root.realPath) : null;
  if (found === null || !MARKETPLACE.test(found[2])) return null;
  return { configDir: found[1], marketplace: found[2] };
}

// The entry installed for the folder `cwd`: the local, then the project, entry whose real projectPath holds the real
// cwd at a separator boundary, the longest first; else the user entry.
async function chosenEntry(io, entries, cwd) {
  const realCwd = (await realStat(io, cwd, 'dir'))?.realPath;
  for (const scope of ['local', 'project']) {
    const held = [];
    for (const entry of entries) {
      if (own(entry, 'scope') !== scope || !realCwd) continue;
      const real = (await realStat(io, own(entry, 'projectPath'), 'dir'))?.realPath;
      if (real && within(realCwd, real)) held.push({ entry, length: real.length });
    }
    if (held.length) return held.sort((a, b) => b.length - a.length)[0].entry;
  }
  return entries.find((entry) => own(entry, 'scope') === 'user') ?? null;
}

// The entry of installed_plugins.json under the exact key `aidrian@<marketplace>` installed for `cwd`, or null when
// the file, the key, or an entry for the folder is missing.
async function installedEntry(io, { configDir, marketplace }, cwd) {
  let data;
  try {
    data = JSON.parse(await io.fs.read(`${configDir}/plugins/installed_plugins.json`));
  } catch {
    return null;
  }
  const entries = own(own(data, 'plugins'), `aidrian@${marketplace}`);
  return Array.isArray(entries) ? chosenEntry(io, entries, cwd) : null;
}

// The real path of the lib/cli.mjs of the installed `entry`: the install's real path below that marketplace's aidrian
// cache folder, and lib/cli.mjs a regular file there, not a link, whose real path stays below the install. Null when
// any check fails or cannot be made.
async function installedCli(io, { configDir, marketplace }, entry) {
  const cache = await realStat(io, `${configDir}/plugins/cache/${marketplace}/aidrian`, 'dir');
  const install = await realStat(io, own(entry, 'installPath'), 'dir');
  if (!cache || !install || !below(install.realPath, cache.realPath)) return null;
  const cli = await realStat(io, `${install.realPath}/lib/cli.mjs`, 'file');
  return cli && cli.isLink === false && below(cli.realPath, install.realPath) ? cli.realPath : null;
}

// The fallback: the lib/cli.mjs of the plugin folder that holds an `aidrian` command on the resolver's PATH, as
// <plugin>/bin/aidrian, which runs by node rather than by that command's shell script; a regular file, not a link,
// below the real plugin folder, and outside the session's folder and root.
async function pathCli(io, runner) {
  const command = await runner.which('aidrian');
  const plugin = command === null ? null : await realStat(io, parentOf(parentOf(command)), 'dir');
  if (plugin === null) return null;
  const cli = await realStat(io, `${plugin.realPath}/lib/cli.mjs`, 'file');
  const held = cli && cli.isLink === false && below(cli.realPath, plugin.realPath);
  return held && runner.outside(cli.realPath) ? cli.realPath : null;
}

// Where the aidrian cli is: `{ kind: 'plugin' | 'path', cli, place }`, or `{ kind, place }` of `off`, `refused`, or
// `missing`. When the own marketplace is known, nothing runs unless enabledPlugins holds `aidrian@<marketplace>` true:
// an entry installed for the folder is then `off`, and no entry is `missing`, with no PATH fallback. An enabled entry
// that fails a check is `refused`, with no PATH fallback. Only with no entry for the folder is PATH tried.
export async function findCli(io, { cwd, runner }) {
  const place = await ownPlace(io);
  if (place) {
    const enabled = await Promise.resolve().then(() => io.enabledPlugins()).catch(() => undefined);
    const isOn = own(enabled, `aidrian@${place.marketplace}`) === true;
    const entry = await installedEntry(io, place, cwd);
    if (!isOn) return { kind: entry === null ? 'missing' : 'off', place };
    if (entry !== null) {
      const cli = await installedCli(io, place, entry);
      return cli ? { kind: 'plugin', cli, place } : { kind: 'refused', place };
    }
  }
  const cli = await pathCli(io, runner);
  return cli ? { kind: 'path', cli, place } : { kind: 'missing', place };
}

// The config dir whose projects folder holds the transcripts: the one the own marketplace gave, else an absolute
// CLAUDE_CONFIG_DIR, else ~/.claude for an absolute HOME; null with none.
export function configDirOf(io, place) {
  if (place) return place.configDir;
  if (isAbsolute(io.env?.CLAUDE_CONFIG_DIR)) return io.env.CLAUDE_CONFIG_DIR;
  return isAbsolute(io.env?.HOME) ? `${io.env.HOME}/.claude` : null;
}

// The real path of the session's transcript, the newest `<config dir>/projects/*/<session>.jsonl` that is a regular
// file whose real path lies below the real projects folder; null for a session id that fails SESSION_ID, or with none.
// Each call looks again, so a newer copy in another projects folder is found on the next run.
export async function findTranscript(io, { configDir, session }) {
  if (typeof session !== 'string' || !SESSION_ID.test(session) || !isAbsolute(configDir)) return null;
  const projects = await realStat(io, `${configDir}/projects`, 'dir');
  if (!projects) return null;
  const valid = async (file) => {
    const stat = await realStat(io, file, 'file');
    return stat && below(stat.realPath, projects.realPath) ? stat : null;
  };
  let names;
  try {
    names = await io.fs.list(projects.realPath);
  } catch {
    return null;
  }
  let newest = null;
  for (const { name, kind } of names) {
    const found = kind === 'dir' && !name.includes('/') ? await valid(`${projects.realPath}/${name}/${session}.jsonl`) : null;
    if (found && (newest === null || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  return newest?.realPath ?? null;
}

// The snapshot's arguments after node, each flag as `--name=value`, so no value reads as a flag of its own.
export function snapshotArgs({ cli, session, transcript = null, ticketPrefixes = '' }) {
  const args = [cli, 'session', 'snapshot', '--json'];
  if (typeof session === 'string' && SESSION_ID.test(session)) args.push(`--session=${session}`);
  if (transcript) args.push(`--transcript=${transcript}`);
  if (typeof ticketPrefixes === 'string' && ticketPrefixes !== '') args.push(`--ticket-prefixes=${ticketPrefixes}`);
  return args;
}

const parsedObject = (text) => {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
};

// One snapshot for `{ session, cwd, root }`: `{ kind: 'ok', snapshot, transcript }`, or `{ kind }` of `missing` (no
// cli), `refused` (the entry installed for the folder failed a check), `no-node` (a cli, and no node on a checked PATH
// entry), or `off`, or `{ kind, transcript }` of `failed` (a non-zero exit, or output that is not one JSON object) or
// `timed-out`. `transcript` is the checked transcript the run was given, or null: the mod reads its cache from it.
export async function runSnapshot(io, { session, cwd, root, ticketPrefixes = '' }) {
  const runner = await runnerFor(io, { cwd, root });
  const found = await findCli(io, { cwd, runner });
  if (found.kind !== 'plugin' && found.kind !== 'path') return { kind: found.kind };
  if ((await runner.which('node')) === null) return { kind: 'no-node' };
  const transcript = await findTranscript(io, { configDir: configDirOf(io, found.place), session });
  const started = await io.now();
  let ran;
  try {
    ran = await runner.run('node', snapshotArgs({ cli: found.cli, session, transcript, ticketPrefixes }), { cwd, timeoutMs: SNAPSHOT_TIMEOUT_MS });
  } catch {
    const late = (await io.now()) - started >= SNAPSHOT_TIMEOUT_MS;
    const kind = late ? 'timed-out' : 'failed';
    return { kind, transcript };
  }
  const snapshot = ran?.exitCode === 0 ? parsedObject(String(ran.stdout)) : null;
  return snapshot ? { kind: 'ok', snapshot, transcript } : { kind: 'failed', transcript };
}

// One snapshot in flight at a time. `trigger()` starts a run for `target()`, `{ session, cwd, root }`, now; one that
// comes during a run sets a single pending rerun, however many come, which starts when the run ends. A result is drawn
// only when the session and the cwd it ran for are still `target()`'s; otherwise it is dropped. `trigger` resolves when
// the runs it joined are done.
export function poller({ target, snapshot, draw }) {
  let running = null;
  let pending = false;
  const once = async () => {
    const asked = await target();
    const result = await Promise.resolve().then(() => snapshot(asked)).catch(() => ({ kind: 'failed' }));
    const now = await target();
    if (now.session === asked.session && now.cwd === asked.cwd) draw(result, asked);
  };
  const loop = async () => {
    try {
      do {
        pending = false;
        await once().catch(() => undefined);
      } while (pending);
    } finally {
      running = null;
    }
  };
  return {
    trigger() {
      if (running) {
        pending = true;
        return running;
      }
      running = loop();
      return running;
    },
  };
}
