// Claude Code's side of the background route of session.handoff.continue (docs/providers/claude-code.md#the-background-route).
// `claude --bg` starts a session under the background-session supervisor and prints its short id; `claude agents --json`,
// the listing its docs name as the stable interface, gives each session's `id`, `sessionId`, `name`, `kind`, and `cwd`.
// `--bg` ignores `--session-id`, so the new session's id is read back from that listing, which may lag the start.
// `startIn` starts a session in a given folder with a given first message and name, for any gate; `startBackground` is
// the handoff's wrapper of the same launch, which takes the folder, name, and mode from the handing-off session, and
// `startProject` a project run's, which starts in the attempt's clone under the driver session's permission mode, under
// the host's sandbox (lib/hosts/claude-code-sandbox.mjs), and holds the session only once the plugin's agent gate hook
// files its beacon on the session's first tool call, and the session proved from inside its sandbox that the sandbox
// holds (`confined`, the gate's reading of `aidrian project confine`'s verdict).
// Every call goes through `run`, spawnSync's shape, which a test replaces, so no test starts a real session. `claude` is
// found on the absolute folders of PATH alone: an empty or relative entry would run whatever `claude` the folder holds.

import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { pauseSync } from '../fs.mjs';
import { recordTrust } from './claude-code-trust.mjs';
import { configDir, MODEL_CHOICES } from './claude-code-config.mjs';
import { configFolder, mcpConfig, npmGlobalConfigs, sandboxSettings, secretVars } from './claude-code-sandbox.mjs';
import { programNames, programOnPath, runCommand } from './process.mjs';

// `claude --bg` may first start the supervisor, which takes a few seconds.
const START_TIMEOUT = 60_000;
const LIST_TIMEOUT = 15_000;
// How often, and how far apart, the listing is read again for a session the start just made: about 5 seconds.
const LIST_TRIES = 10;
const LIST_PAUSE = 500;
// Its output: `backgrounded · <short id> · <name>`, then the commands that manage the session. Read only at the start of
// a line, so text echoed before it, such as part of the prompt, cannot name another id.
const STARTED = /^[ \t]*backgrounded[ \t]*·[ \t]*([0-9A-Za-z][0-9A-Za-z-]{3,63})\b/mu;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
// A session name the command passes on: plain text that cannot read as a flag.
const NAME = /^[^\s-][^\u0000-\u001f\u007f-\u009f\u2028\u2029]{0,99}$/u;
// A name the say line prints, in single quotes: no quote, `$`, `;`, or other character a shell reads inside them.
// lib/handoff-markers.mjs holds a started marker's name to the same pattern; importing it here would loop the modules.
const PLAIN_NAME = /^[\w .@:\u00b7-]+$/u;
// An agent name the command passes on: a word, or `<plugin>:<agent>`.
const AGENT = /^[A-Za-z0-9][\w.:-]{0,127}$/u;
const ID = /^[0-9A-Za-z][\w-]{3,127}$/u;
// The permission modes `claude --help` lists for `--permission-mode` on 2.1.326, but `bypassPermissions`: a session no
// Human attends never runs without permission checks. A transcript may name the manual mode `default`.
const PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'dontAsk', 'manual', 'plan']);
const MODE_NAMES = new Map([['default', 'manual']]);
const BYPASS = 'bypassPermissions';
// A transcript is read from its end in chunks of MODE_CHUNK bytes until an entry names the mode, so a long session
// costs no more memory than a short one. A line longer than MODE_LINE is not parsed, so one huge entry cannot exhaust
// memory; one that holds MODE_KEY may name a stricter mode than any line before it, so the read fails closed on it.
// MODE_KEY picks the lines worth parsing. The session's model is read the same way (sessionModel).
const MODE_CHUNK = 1024 * 1024;
const MODE_LINE = 32 * 1024 * 1024;
const MODE_KEY = Buffer.from('"permissionMode"');
// The key of an `assistant` entry's model, the word every `user` entry holds as its type, and the bytes of a long line
// kept to find any of them across two pieces.
const MODEL_KEY = Buffer.from('"model"');
const USER_WORD = Buffer.from('"user"');
const KEYS = [MODE_KEY, MODEL_KEY, USER_WORD];
const KEY_TAIL = Math.max(...KEYS.map((key) => key.length)) - 1;
// What the host writes as a `user` entry, as its whole text, when the Human interrupts the session. lib/names.mjs isPrompt
// lists their common start alone, `[Request interrupted`, and reads it as a marker at the start of any text block.
const INTERRUPTED = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);
// The model of an entry the host wrote itself, with no request to a model.
const NO_MODEL = '<synthetic>';
// A full model name as a transcript gives it: `claude-<family>-<version>`, with the families MODEL_CHOICES names and a
// version of digits alone, so no sentence, flag, or host word such as `default` passes.
const MODEL_NAME = new RegExp(String.raw`^claude-(?:${MODEL_CHOICES.model.join('|')})-\d{1,2}(?:-\d{1,2})?(?:-\d{8})?$`, 'u');
// What a start takes for each field from each source, first to last: the session's own, then the team's config.
const isEffort = (value) => MODEL_CHOICES.effort.includes(value);
const TAKES = {
  model: { session: (value) => typeof value === 'string' && MODEL_NAME.test(value), team: (value) => MODEL_CHOICES.model.includes(value) },
  effort: { session: isEffort, team: isEffort },
};
// What the read gives for the session's own entry whose `permissionMode` is not a string: no mode the gate passes on.
const UNREADABLE_MODE = '(unreadable)';
// The count a name ends with, ` · <n>`.
const LAST_COUNT = /\s+\u00b7\s*(\d+)$/u;
// A spawn that failed before `claude` ran, and the output of a `claude --bg` that refused the start before the supervisor
// took it, checked on 2.1.326: no other failure proves that nothing started.
const NOT_RUN = new Set(['ENOENT', 'EACCES']);
const REFUSED = /\bWorkspace not trusted\b/u;
const NO_CLAUDE = '`claude` is not on PATH, in an absolute folder';
// How long a project start waits for the beacon the agent gate hook files on the session's first tool call, and the
// step between reads. The pending mark must outlive the start up to the session's own mark, which `identify` files
// before this wait (IDENTIFY_CAP; test/project-start-sandbox.test.mjs holds the two apart).
export const BEACON_WAIT = 180_000;
const BEACON_STEP = 1_000;
// How long a project start waits, after the beacon, for the session's sandbox proof (lib/project-confine.mjs): its first
// call runs `aidrian project confine`, whose probes take a few seconds.
export const CONFINE_WAIT = 180_000;
export const IDENTIFY_CAP = START_TIMEOUT + LIST_TRIES * (LIST_TIMEOUT + LIST_PAUSE) + LIST_TIMEOUT;
// A network host the sandbox's allowlist takes: a host name, or `*.` and a host name.
const DOMAIN = /^(?:\*\.)?[a-z0-9.-]+$/iu;
// What a start the host refused for an untrusted folder tells the Human to do once: trust the run's runs folder, the
// folder of every attempt's clone, `<state>/runs`, four folders above the clone `work`
// (`runs/<run>/attempts/<issue>.<attempt>/work`), never the whole state folder.
// The runs folder of an attempt's clone, `<runs>/<run>/attempts/<issue>.<n>/work`, when the gate names none.
const runsOf = (work) => path.resolve(work, '../../../..');
const trustStep = (runs) => {
  const named = path.basename(runs) === 'runs' ? `the project's runs folder, ${runs},` : 'the folder that holds the run\'s attempts';
  return `trust ${named} once by running \`claude\` there and accepting its trust question, then start again`;
};

export { runCommand };
const pause = pauseSync;

// The first line of a command's message, on one line and at most 200 characters, for a fallback line.
const firstLine = (text) => String(text ?? '').trim().split('\n')[0].replace(new RegExp(CONTROL, 'gu'), ' ').slice(0, 200);

// The `claude` executable on the absolute folders of `env.PATH`, or null.
export const claudeOnPath = (env) => programOnPath(env, programNames('claude'));

// The rows `claude agents --json` lists, as it gives them, with `extra` its further options, or null when it cannot
// answer.
function listedRows(run, claude, cwd, extra = []) {
  const result = run(claude, ['agents', '--json', ...extra], { cwd, timeout: LIST_TIMEOUT });
  if (result.error || result.status !== 0) return null;
  try {
    const list = JSON.parse(result.stdout);
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

// The sessions `claude agents --json` lists, with `extra` its further options, or null when it cannot answer.
function listed(run, claude, cwd, extra = []) {
  return listedRows(run, claude, cwd, extra)?.filter((each) => each !== null && typeof each === 'object') ?? null;
}

// The one listed background session the start made: a `sessionId` the listing before it did not hold, in `cwd`, with
// the short `id` the start printed, else with `name`. null when none, or more than one, fits.
function newSession(list, { before, cwd, id, name }) {
  const fits = (list ?? []).filter((each) => each.kind === 'background' && typeof each.sessionId === 'string' && ID.test(each.sessionId)
    && !before.has(each.sessionId) && each.cwd === cwd
    && (id ? each.id === id || each.sessionId.startsWith(id) : each.name === name));
  return fits.length === 1 ? fits[0] : null;
}

// Reads the listing until it names the new session, at most LIST_TRIES times: { entry, list }, the last listing read.
function awaitSession({ run, claude, wait, ...want }) {
  let list = null;
  for (let attempt = 0; attempt < LIST_TRIES; attempt += 1) {
    if (attempt > 0) wait(LIST_PAUSE);
    list = listed(run, claude, want.cwd) ?? list;
    const entry = newSession(list, want);
    if (entry) return { entry, list };
  }
  return { entry: null, list };
}

// The permission mode the session `session` runs in, from the last entry of its transcript with a `permissionMode`,
// `<config folder>/projects/<start folder, each character but a letter or digit as ->/<session>.jsonl`, else that file
// in any project folder there: the mode's name, or null when none can be read. `env.CLAUDE_CONFIG_DIR` moves the config
// folder, as it does for Claude Code. On 2.1.326 neither the gate's shell nor `claude agents --json` gives the mode; the
// transcript may hold `{"type":"permission-mode","permissionMode":<mode>,"sessionId":<id>}` entries, and its `user`
// entries carry the mode as a top-level `permissionMode` field, which is all some transcripts have.
export const sessionMode = ({ session, cwd, env }) => readTranscript({ session, cwd, env }, lastMode);

// The model the session `session` started its turn in, from the transcript sessionMode reads: the one the first assistant
// entry after the last prompt gives, else the nearest earlier one, so neither a fallback the host took in the middle of
// the turn nor a skill's own model is taken. Many prompts carry no mode, so no mode takes part. It is chosen first and
// then held to MODEL_NAME, with no search for another that passes: the name, or null. null too with no folder `cwd`, or
// a line too long to parse among those read that holds MODEL_KEY, or that may be the last prompt, as it holds USER_WORD.
// No answer of it changes sessionMode's.
export function sessionModel({ session, cwd, env }) {
  if (typeof cwd !== 'string') return null;
  const model = readTranscript({ session, cwd, env }, turnModel);
  return TAKES.model.session(model) ? model : null;
}

// What `read(file, session)` answers for the session's transcript, the first file of that name it does not answer
// undefined for, or null.
function readTranscript({ session, cwd, env }, read) {
  if (typeof session !== 'string' || !ID.test(session)) return null;
  const projects = path.join(configDir(env), 'projects');
  const name = `${session}.jsonl`;
  const first = path.join(projects, String(cwd).replace(/[^A-Za-z0-9]/gu, '-'), name);
  let folders;
  try {
    folders = readdirSync(projects);
  } catch {
    return null;
  }
  for (const file of [first, ...folders.map((folder) => path.join(projects, folder, name))]) {
    const found = read(file, session);
    if (found !== undefined) return found;
  }
  return null;
}

// The mode a transcript line names: its top-level `permissionMode` when the entry is the session's own, by its
// `sessionId`, else null. A sidechain entry is a subagent's, which may run in another mode. A `permissionMode` that is
// not a string gives UNREADABLE_MODE, which the gate refuses.
function lineMode(line, session) {
  if (line.indexOf(MODE_KEY) === -1) return null;
  let entry;
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch {
    return null;
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || entry.isSidechain === true) return null;
  if (entry.sessionId !== session || !Object.hasOwn(entry, 'permissionMode')) return null;
  return typeof entry.permissionMode === 'string' ? entry.permissionMode : UNREADABLE_MODE;
}

// What a transcript line of the session's own, no sidechain entry, is to turnModel: { prompt, model } or null.
function lineTurn(line, session) {
  if (!line.includes(MODEL_KEY) && !line.includes(USER_WORD)) return null;
  let entry;
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch {
    return null;
  }
  if (entry === null || typeof entry !== 'object' || entry.isSidechain === true || entry.sessionId !== session) return null;
  if (entry.message === null || typeof entry.message !== 'object') return null;
  return { prompt: startsTurn(entry), model: entryModel(entry) };
}

// Whether an entry is a prompt, which starts a turn: a `user` entry whose content is text, or a list that holds a block
// and no tool result, and not the host's own bookkeeping: one marked isMeta, a compaction summary, a task notification,
// or an interruption marker as the whole text. The marks are those of transcript.mjs humanPrompt, copied since that
// file's imports lead back here; unlike it, this counts a message from any other origin. A block that is not well formed
// counts for nothing.
function startsTurn({ type, isMeta, isCompactSummary, origin, message: { content } }) {
  if (type !== 'user' || isMeta === true || isCompactSummary === true || origin?.kind === 'task-notification') return false;
  if (typeof content === 'string') return !isMarker(content);
  if (!Array.isArray(content)) return false;
  const blocks = content.filter(isBlock);
  if (blocks.length === 0 || blocks.some((block) => block.type === 'tool_result')) return false;
  return blocks.length > 1 || blocks[0].type !== 'text' || !isMarker(blocks[0].text);
}

const isMarker = (text) => INTERRUPTED.has(text.trim());
// A content block as the read takes one: an object with a type, and, when it is text, a text that is a string.
const isBlock = (block) => block !== null && typeof block === 'object' && typeof block.type === 'string' && (block.type !== 'text' || typeof block.text === 'string');

// The model an `assistant` entry names: its message's own string, other than NO_MODEL; else null.
function entryModel({ type, message }) {
  if (type !== 'assistant' || !Object.hasOwn(message, 'model')) return null;
  return typeof message.model === 'string' && message.model !== NO_MODEL ? message.model : null;
}

// The line of a transcript being read backwards, a piece at a time: `add` takes the bytes before those it holds, and
// `whole` gives it once whole. Past MODE_LINE bytes it keeps only the first KEY_TAIL of them, enough to find each of KEYS
// across the next piece, and notes which of KEYS were in it.
function backwardLine() {
  let parts = [];
  let size = 0;
  let over = false;
  const keyed = new Set();
  let head = Buffer.alloc(0);
  return {
    add(piece) {
      if (!over) {
        parts.push(piece);
        size += piece.length;
        if (size <= MODE_LINE) return;
        head = Buffer.concat(parts.reverse());
        parts = [];
        over = true;
      } else {
        head = Buffer.concat([piece, head]);
      }
      for (const key of KEYS) if (head.includes(key)) keyed.add(key);
      head = Buffer.from(head.subarray(0, KEY_TAIL));
    },
    // { bytes } of a line that may be parsed, or { long }, the keys a longer one holds.
    whole: () => (over ? { long: keyed } : { bytes: parts.length === 1 ? parts[0] : Buffer.concat(parts.reverse()) }),
  };
}

// The mode the last line of the regular file `file` to name one names: the mode, null when no line names one or a line
// too long to parse holds MODE_KEY, or undefined when the file cannot be read.
const lastMode = (file, session) => readBackwards(file, ({ long, bytes }) => {
  if (long) return long.has(MODE_KEY) ? null : undefined;
  return lineMode(bytes, session) ?? undefined;
});

// The model sessionModel chooses in the regular file `file`, before it is held to MODEL_NAME: its name, null when there is
// none to choose, or undefined when the file cannot be read.
function turnModel(file, session) {
  let first = null;
  let turn = false;
  return readBackwards(file, ({ long, bytes }) => {
    if (long) return long.has(MODEL_KEY) || (!turn && long.has(USER_WORD)) ? null : undefined;
    const { prompt = false, model = null } = lineTurn(bytes, session) ?? {};
    if (!turn && prompt) {
      turn = true;
      return first ?? undefined;
    }
    if (model !== null && turn) return model;
    first = model ?? first;
    return undefined;
  });
}

// What `visit` answers for the last line of the regular file `file` it answers anything but undefined for, read backwards
// in MODE_CHUNK chunks: null when it answers for none, or undefined when the file cannot be read.
function readBackwards(file, visit) {
  let fd;
  try {
    // Not blocking, so a named pipe in a transcript's place answers at once, as no file, and never holds the gate.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    let end = stat.size;
    let line = backwardLine();
    while (end > 0) {
      const start = Math.max(0, end - MODE_CHUNK);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      end = start;
      // Each newline ends the line after it, which is then whole.
      let stop = chunk.length;
      for (let cut = chunk.lastIndexOf(0x0a, stop - 1); cut !== -1; cut = cut === 0 ? -1 : chunk.lastIndexOf(0x0a, cut - 1)) {
        line.add(chunk.subarray(cut + 1, stop));
        const found = visit(line.whole());
        if (found !== undefined) return found;
        line = backwardLine();
        stop = cut;
      }
      line.add(chunk.subarray(0, stop));
    }
    return visit(line.whole()) ?? null;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The handing-off session's name without the counts a hop gave it: when it ends in ` · <chain - 1>`, that count and the
// ones before it that count down by one, as an earlier build left them. Any other name stays whole, such as
// `release · 2026`.
function withoutCounts(own, chain) {
  let name = own;
  let want = Number(chain) - 1;
  for (let match = LAST_COUNT.exec(name); match && want >= 0 && Number(match[1]) === want; match = LAST_COUNT.exec(name)) {
    name = name.slice(0, match.index);
    want -= 1;
  }
  return name;
}

// The new session's name: the handing-off session's, without the count a hop gave it, else the slug, then
// ` · <chain>`, within 100 characters.
function sessionName(own, slug, chain) {
  const suffix = ` · ${chain}`;
  const bare = typeof own === 'string' && NAME.test(own) ? withoutCounts(own, chain) : '';
  const base = NAME.test(bare) ? bare : slug;
  return `${base.slice(0, 100 - suffix.length).trimEnd()}${suffix}`;
}

// How the Human looks at the session `id`: `claude attach <id>` first, and its name when it is plain text and `unique`.
export function attachLine({ id, name }) {
  const byName = typeof name === 'string' && PLAIN_NAME.test(name) ? `, or \`claude attach '${name}'\` by its name` : '';
  return `\`claude attach ${id}\` opens it${byName}, and \`claude agents\` lists it`;
}

// How the Human stops the session `id` by hand, when stopBackground could not, or null for a full id, the id of a
// session listed with no short one: `claude stop` refuses it.
export const stopLine = ({ id }) => (FULL_ID.test(id) ? null : `\`claude stop ${id}\` stops it`);

// The folder of the session `session` in the listing `list`, where startBackground starts the session that resumes its
// brief: an absolute path with no control character, or null.
function ownFolder(list, session) {
  const own = list?.find((each) => each.sessionId === session);
  return typeof own?.cwd === 'string' && path.isAbsolute(own.cwd) && !CONTROL.test(own.cwd) ? own.cwd : null;
}

// The folder startBackground would start the session that resumes the brief of the session `session` in, from one read
// of `claude agents --json`: { cwd, listing }, or null when `claude` is not found, the listing does not answer, or it
// lists no such folder. The gate's push preflight judges the remote of `cwd` (docs/handoff.md#the-push-preflight), then
// passes this answer to startBackground as `start`, which starts there from `listing` and never reads the folder again.
export function startFolder({ session, env, run = runCommand, resolve = claudeOnPath }) {
  const claude = resolve(env);
  const listing = claude ? listed(run, claude, undefined) : null;
  const cwd = ownFolder(listing, session);
  return cwd === null ? null : { cwd, listing };
}

// The model and effort startBackground asks for in the new session, per field: the handing-off session's own, the model
// as sessionModel reads it and the effort the host's variable gave, `effort`; else the team's, `team`, as
// session.handoff.models of the base branch names them; else null, the host's default. Each is held to TAKES:
// { model, modelFrom, effort, effortFrom }, each `From` one of `session`, `team`, or `host`. It is read once, and
// startBackground is handed this answer. `start` is startFolder's, whose folder sessionMode's read takes too.
export function startChoice({ session, env, start, team, effort }) {
  const told = { session: { model: sessionModel({ session, cwd: start?.cwd, env }), effort }, team };
  const choice = {};
  for (const [field, takes] of Object.entries(TAKES)) {
    const from = Object.keys(takes).find((each) => takes[each](told[each]?.[field])) ?? 'host';
    choice[field] = from === 'host' ? null : told[from][field];
    choice[`${field}From`] = from;
  }
  return choice;
}

// A startChoice answer read back from a start record, whatever it holds: each field with its `From` when TAKES takes it
// from that source, or it is null from the host, else both null.
export function readAsked(asked) {
  const read = {};
  for (const [field, takes] of Object.entries(TAKES)) {
    const value = asked?.[field];
    const from = asked?.[`${field}From`];
    const taken = typeof from === 'string' && Object.hasOwn(takes, from) && takes[from](value);
    read[field] = taken ? value : null;
    read[`${field}From`] = taken || (from === 'host' && value === null) ? from : null;
  }
  return read;
}

// Starts a session in the background in the folder `cwd`, by its real path, whose first message is `prompt`, under the name `name`, in
// the permission mode `mode`: { id, session, name, cwd, mode }, or { problem, uncertain } when none it can name started,
// as startBackground's. `mode` must be one of PERMISSION_MODES: a session no Human attends never runs without permission
// checks, and the host's default may. `cwd` is an absolute path of plain text, `name` plain text that cannot read as a
// flag, and `prompt` text that does not start with a dash or a slash; `agent` and `effort` are passed on when they are valid.
// `settings`, an object, starts the session with `--setting-sources user --settings <its JSON>`, so only the user's
// settings and these load, and `mcp`, an object, with `--strict-mcp-config --mcp-config <its JSON>`, so only its servers
// load; a start that passes neither, as the handoff's, loads every source as the host does.
// `hold`, `run`, `wait`, and `resolve` are startBackground's. It names no brief: lib/session-start-gate.mjs startHeld
// holds what it starts.
export function startIn({ cwd, prompt, name, mode, agent, effort, efforts = [], settings = null, mcp = null, env, hold, run = runCommand, wait = pause, resolve = claudeOnPath }) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || CONTROL.test(cwd)) return { problem: 'the folder to start the session in is not an absolute path of plain text' };
  if (typeof name !== 'string' || !NAME.test(name)) return { problem: 'the session\'s name is not plain text of at most 100 characters that cannot read as a flag' };
  if (typeof prompt !== 'string' || prompt.trim() === '' || /^\s*[-/]/u.test(prompt)) {
    return { problem: 'the first message is empty, or starts with a dash, which would read as a flag, or a slash, which would read as a command' };
  }
  if (!PERMISSION_MODES.has(mode)) return { problem: 'the permission mode is not one a session no Human attends may start in' };
  let real;
  try {
    real = realpathSync(cwd);
  } catch (error) {
    return { problem: `the folder to start the session in cannot be resolved (${error.code ?? 'no code'})` };
  }
  if (CONTROL.test(real)) return { problem: 'the folder to start the session in resolves to a path that is not plain text' };
  const claude = resolve(env);
  if (!claude) return { problem: NO_CLAUDE };
  const before = listed(run, claude, undefined);
  if (!before) return { problem: '`claude agents --json` did not answer, so the sessions listed before the start are unknown' };
  return launch({ claude, before, cwd: real, prompt, name, mode, agent, effort, efforts, settings, mcp, hold, run, wait });
}

// The permission mode the session `session`, as `list` names it, runs in: { mode, own } or { problem }, with `own` its
// listing entry in the folder `cwd`, its listed folder (ownFolder) unless given. A session whose mode is
// bypassPermissions, or cannot be read, gives a problem: the host's default may bypass permission checks.
function ownMode({ session, list, env, readMode, cwd = ownFolder(list, session) }) {
  if (cwd === null) return { problem: '`claude agents --json` does not list the folder of this session' };
  const own = { ...list.find((each) => each.sessionId === session), cwd };
  const read = readMode({ session, cwd, env });
  if (read === BYPASS) return { problem: 'this session runs with permission checks bypassed, and a session no Human attends never starts that way' };
  const mode = MODE_NAMES.get(read) ?? read;
  if (!PERMISSION_MODES.has(mode)) return { problem: 'the permission mode of this session could not be read, and the host\'s default may bypass permission checks' };
  return { mode, own };
}

// Starts the session of one issue of a project run, in the background, in the attempt's clone `cwd`, under the name
// `name`, whose first message is `prompt`, as startIn does, in the permission mode the driver session `session` runs in
// (`readMode`, sessionMode by default; never bypassPermissions), under the host's sandbox: `--setting-sources user`,
// the settings sandboxSettings gives for `sandbox`, { git, grants, domains, main, mainGit, tokens, guarded, localBinding }, and
// `--strict-mcp-config` with only the servers `mcp` names. `sandbox.git` is the clone's git folder, which `sandbox.grants`
// must hold, each an absolute path of plain text that resolves; `sandbox.domains` the forge's network hosts;
// `sandbox.main` the main checkout, which the session may not read but its git folder `sandbox.mainGit`, and in which
// neither the clone nor a granted folder may lie; `sandbox.tokens` the forge's token variables, the one credential kept
// (secretVars); `sandbox.guarded` the folders no sandboxed command writes, such as the sign-off store; `sandbox.hostFiles`,
// { paths, globs }, the other hosts' files from the clone's root whose writes the sandbox denies too; `sandbox.hostStores`
// the hosts' logins and service state, absolute, whose reads it denies beside npm's global config. Any miss runs no `claude --bg`. No agent is
// passed, so the session runs as the host's main agent and no agent's own permission mode can stand in for the one
// passed; the driver's effort is passed on. `home` and `platform` are the user's home folder and the operating system
// the settings name.
// Once the host names the session, `identify({ id, session })` files its floor and mark, and the start holds it only once
// `beacon(session)`, the agent gate hook's beacon, shows the plugin's hooks run for it, within BEACON_WAIT: else the
// session is stopped, and the answer names the failed proof (`proof`). Returns startIn's answer, or { problem,
// uncertain, proof }. `hold`, `run`, `wait`, and `resolve` are startBackground's.
export function startProject({ session, cwd, runs, prompt, name, effort, efforts = [], env, hold, identify, beacon, confined, sandbox, mcp, home, platform = process.platform, run = runCommand, wait = pause, resolve = claudeOnPath, readMode = sessionMode, claimVars = null }) {
  const box = sandboxInputs(sandbox);
  if (box.problem) return { problem: box.problem };
  if (typeof beacon !== 'function') return { problem: 'the gate gave no way to read the agent gate hook\'s beacon' };
  let work;
  try {
    work = realpathSync(cwd);
  } catch (error) {
    return { problem: `the folder to start the session in cannot be resolved (${error.code ?? 'no code'})` };
  }
  const claude = resolve(env);
  if (!claude) return { problem: NO_CLAUDE };
  const before = listed(run, claude, undefined);
  if (!before) return { problem: '`claude agents --json` did not answer, so the permission mode of the driver session is unknown' };
  const read = ownMode({ session, list: before, env, readMode });
  if (read.problem) return { problem: read.problem.replace('this session', 'the driver session') };
  if (box.main && [work, ...box.grants].some((each) => within(box.main, each) && !(box.mainGit && within(box.mainGit, each)))) {
    return { problem: `the attempt's clone or a folder the gate grants the session lies in the main checkout ${box.main}, which a confined session may not read; set state.dir to a folder outside it` };
  }
  const user = home ?? homedir();
  const boxed = sandboxSettings({ ...box, work, temp: tempFolders(), home: user, config: configFolder(env, user), platform, secrets: secretVars(env, box.tokens), stores: [...new Set([...npmGlobalConfigs(env), ...box.hostStores])] });
  // The start's claim, the one variable the settings set (`claimVars`, from lib/project-token.mjs): it marks this session,
  // and no other opened in the clone, to the SessionStart hook that hands it the forge token. It is no secret.
  const claimed = claimVars && typeof claimVars === 'object' && Object.values(claimVars).every((value) => typeof value === 'string');
  const settings = claimed ? { ...boxed, env: { ...claimVars } } : boxed;
  // The clone is a repository of its own, so it never inherits the runs folder's trust: the start records it.
  const consent = typeof runs === 'string' && runs ? runs : runsOf(work);
  const trust = recordTrust({ work, runs: consent, env, home: user });
  if (trust) return { problem: `${trust.problem}; ${trustStep(consent)}` };
  const started = startIn({ cwd: work, prompt, name, mode: read.mode, effort, efforts, settings, mcp: mcpConfig(mcp), env, hold, run, wait, resolve: () => claude });
  if (started.problem) return REFUSED.test(started.problem) && started.uncertain === false ? { ...started, problem: `${started.problem}; ${trustStep(consent)}` } : started;
  return proveHooks({ started, identify, beacon, confined, env, run, wait, claude });
}

const within = (folder, file) => file === folder || file.startsWith(`${folder}${path.sep}`);

// The checked folders and hosts of a project start's sandbox, { git, grants, domains, main, mainGit, tokens } with real
// paths, or { problem }. `main` and `mainGit` are optional, and each, when given, an absolute path that resolves.
function sandboxInputs(sandbox) {
  const plain = (each) => typeof each === 'string' && path.isAbsolute(each) && !CONTROL.test(each);
  if (sandbox === null || typeof sandbox !== 'object') return { problem: 'the gate named no sandbox for the session: its git folder, granted folders, and network hosts' };
  const { git, grants, domains } = sandbox;
  if (!plain(git) || !Array.isArray(grants) || !grants.every(plain)) return { problem: 'a folder the gate grants the session is not an absolute path of plain text' };
  if (!Array.isArray(domains) || domains.length === 0 || !domains.every((each) => typeof each === 'string' && DOMAIN.test(each))) {
    return { problem: 'the network hosts the gate grants the session are not host names' };
  }
  let real;
  try {
    real = [git, ...grants].map((each) => realpathSync(each));
  } catch (error) {
    return { problem: `a folder the gate grants the session cannot be resolved (${error.code ?? 'no code'})` };
  }
  if (real.some((each) => CONTROL.test(each))) return { problem: 'a folder the gate grants the session resolves to a path that is not plain text' };
  const [own, ...granted] = real;
  if (!granted.includes(own)) return { problem: 'the clone\'s git folder is not among the folders the gate grants the session' };
  const optional = {};
  for (const key of ['main', 'mainGit']) {
    if (sandbox[key] === undefined || sandbox[key] === null) continue;
    if (!plain(sandbox[key])) return { problem: `the ${key === 'main' ? 'main checkout' : 'main checkout\'s git folder'} the gate names is not an absolute path of plain text` };
    try {
      optional[key] = realpathSync(sandbox[key]);
    } catch (error) {
      return { problem: `the ${key === 'main' ? 'main checkout' : 'main checkout\'s git folder'} the gate names cannot be resolved (${error.code ?? 'no code'})` };
    }
  }
  const tokens = Array.isArray(sandbox.tokens) ? sandbox.tokens.filter((each) => typeof each === 'string') : [];
  // Folders no sandboxed command may write, which need not exist yet: each an absolute path of plain text, kept as given.
  const guarded = sandbox.guarded ?? [];
  if (!Array.isArray(guarded) || !guarded.every(plain)) return { problem: 'a folder the gate guards from the session is not an absolute path of plain text' };
  // The other hosts' files, from the clone's root, which need not exist: absent, none; else two lists of relative paths
  // of plain text, none with a `..` part, so no entry denies or names a path outside the clone.
  const hostFiles = sandbox.hostFiles ?? { paths: [], globs: [] };
  const relative = (each) => typeof each === 'string' && each !== '' && !path.isAbsolute(each) && !CONTROL.test(each) && !each.split(/[\\/]/u).includes('..');
  const lists = [hostFiles?.paths, hostFiles?.globs];
  if (!lists.every((list) => Array.isArray(list) && list.every(relative))) return { problem: 'a host file the gate denies the session is not a relative path of plain text inside its clone' };
  // The hosts' logins and service state, which need not exist: absent, none; else absolute paths of plain text with no
  // `..` part, so each names the file or folder it is.
  const hostStores = sandbox.hostStores ?? [];
  if (!Array.isArray(hostStores) || !hostStores.every((each) => plain(each) && !each.split(/[\\/]/u).includes('..'))) {
    return { problem: 'a host\'s login or service state the gate hides from the session is not an absolute path of plain text' };
  }
  return { git: own, grants: granted, domains: [...domains], main: optional.main ?? null, mainGit: optional.mainGit ?? null, tokens, guarded: [...guarded], localBinding: sandbox.localBinding === true, hostFiles: { paths: [...hostFiles.paths], globs: [...hostFiles.globs] }, hostStores: [...hostStores] };
}

// The temporary folders a sandboxed command may write, by their real paths: /tmp and the host's own.
function tempFolders() {
  const folders = [];
  for (const each of ['/tmp', tmpdir()]) {
    try {
      folders.push(realpathSync(each));
    } catch {
      // No such folder here.
    }
  }
  return [...new Set(folders)];
}

// The proofs of a started project session: its full id, its floor and mark, the beacon of the plugin's hooks, then,
// when the gate gives `confined`, its sandbox proof: `confined(session)` answers true once the proof passed and the
// gate filed it in the session's mark, { problem } once it failed, and null while no verdict is there. The session
// `started` names is stopped when one fails, or the proof does not come within CONFINE_WAIT.
function proveHooks({ started, identify, beacon, confined, env, run, wait, claude }) {
  const stopped = (why, proof = null) => {
    if (!stopBackground({ id: started.id, env, run, resolve: () => claude })) return { problem: `${why}, and the session ${started.id} could not be stopped`, uncertain: true, ...(proof ? { proof } : {}) };
    return { problem: `${why}; the session was stopped`, uncertain: false, ...(proof ? { proof } : {}) };
  };
  const own = started.session;
  if (typeof own !== 'string') return stopped('`claude agents --json` never named the new session\'s full id, so whether the plugin\'s hooks run for it cannot be shown', 'session');
  if (typeof identify === 'function' && identify({ id: started.id, session: own }) !== true) return stopped('the gate could not file the new session\'s floor and mark');
  for (let step = 0; step <= BEACON_WAIT / BEACON_STEP; step += 1) {
    if (step > 0) wait(BEACON_STEP);
    let seen = false;
    try {
      seen = beacon(own) === true;
    } catch {
      seen = false;
    }
    if (seen) return typeof confined === 'function' ? proveSandbox({ started, own, confined, wait, stopped }) : started;
  }
  return stopped(`the plugin's agent gate hook did not run on the session's first tool call within ${BEACON_WAIT / 1000} seconds, so the host may not run the plugin's hooks under --setting-sources user`, 'beacon');
}

// Waits for the sandbox proof of the session `own`, which `started` named (proveHooks): `started` once `confined`
// confirms it, else what `stopped` answers for the proof `confine`.
function proveSandbox({ started, own, confined, wait, stopped }) {
  for (let step = 0; step <= CONFINE_WAIT / BEACON_STEP; step += 1) {
    if (step > 0) wait(BEACON_STEP);
    let answer;
    try {
      answer = confined(own);
    } catch (error) {
      answer = { problem: `its verdict could not be read (${String(error?.message ?? error).split('\n')[0]})` };
    }
    if (answer === true) return started;
    if (answer && typeof answer.problem === 'string') return stopped(`the session's sandbox proof failed: ${answer.problem}`, 'confine');
  }
  return stopped(`the session did not prove its sandbox with \`aidrian project confine\` within ${CONFINE_WAIT / 1000} seconds of its first tool call`, 'confine');
}

// The background sessions `claude agents --json --all` lists in the folder `cwd` under the exact name `name`, as [{ id,
// session, state }], or null when the listing gives no answer: how a project run finds a session an uncertain start may
// have made.
export function findSessions({ cwd, name, env, run = runCommand, resolve = claudeOnPath }) {
  const claude = resolve(env);
  if (!claude || typeof cwd !== 'string' || typeof name !== 'string') return null;
  const list = listed(run, claude, undefined, ['--all']);
  if (!list) return null;
  return list.filter((each) => each.kind === 'background' && each.cwd === cwd && each.name === name && typeof each.sessionId === 'string' && ID.test(each.sessionId))
    .map((each) => ({ id: typeof each.id === 'string' && ID.test(each.id) ? each.id : each.sessionId, session: each.sessionId, state: typeof each.state === 'string' ? each.state : null }));
}

// Starts the session that resumes a brief, in the background, in the folder of the handing-off session `session` as the
// host lists it: { id, session, name, cwd }, or { problem, uncertain } when none it can name started. `id` is the id to
// name it by, the short one when the output printed it; `session` its full id, or null when the listing did not name it
// within about 5 seconds; `name` its name when it is plain text no other listed session has, else null. A start that
// timed out or failed still counts when the listing then shows it. `uncertain` is true when `claude --bg` ran and what
// it did is unknown: it may have started a session the listing never named (startProblem). `agent` is the
// handing-off session's, passed on when known, and so is its permission mode (`readMode`, sessionMode by default), when
// it is one of PERMISSION_MODES: `mode` in the result is the mode passed. A session whose mode is bypassPermissions, or
// cannot be read, starts nothing: the host's default may bypass permission checks. `hold({ cwd, known })`, the gate's, files the pending mark that holds
// every session the host had not listed, `known` being the ids it had, until the new session's own mark is written; it
// runs before `claude --bg`, and a start it does not confirm is none. `run` and `wait` are a test's stand-ins, and
// `resolve` finds `claude` from `env`. `start`, startFolder's answer the gate judged, gives the folder and the listing;
// without it, the listing is read here. It is the handoff's wrapper of the launch startIn makes. `model`
// and `effort` are startChoice's, passed on as they are when valid, with no second read; a start whose model the host
// refuses ends as any start that failed, with no retry.
export function startBackground({ session, slug, chain, agent, model, effort, efforts, prompt, env, hold, start, run = runCommand, wait = pause, resolve = claudeOnPath, readMode = sessionMode }) {
  const claude = resolve(env);
  if (!claude) return { problem: NO_CLAUDE };
  const before = start?.listing ?? listed(run, claude, undefined);
  if (!before) return { problem: '`claude agents --json` did not answer, so the folder of this session is unknown' };
  const read = ownMode({ session, list: before, env, readMode, cwd: start?.cwd ?? ownFolder(before, session) });
  if (read.problem) return { problem: read.problem };
  const { mode, own } = read;
  const name = sessionName(own.name, slug, chain);
  return launch({ claude, before, cwd: own.cwd, prompt, name, mode, agent, model, effort, efforts, hold, run, wait });
}

// The start itself, once `before`, the listing read before it, is known: `hold` files the pending mark with the ids that
// listing names, then `claude --bg` starts the session in `cwd`, and the listing is read until it names the new one.
function launch({ claude, before, cwd, prompt, name, mode, agent, model, effort, efforts, settings = null, mcp = null, hold, run, wait }) {
  const known = before.map((each) => each.sessionId).filter((id) => typeof id === 'string' && ID.test(id));
  if (typeof hold !== 'function' || !hold({ cwd, known })) {
    return { problem: 'the gate could not record the pending mark that holds the new session as unattended until its own mark is written' };
  }
  const args = ['--bg', '--name', name];
  if (typeof agent === 'string' && AGENT.test(agent)) args.push('--agent', agent);
  if (efforts.includes(effort)) args.push('--effort', effort);
  if (Object.values(TAKES.model).some((takes) => takes(model))) args.push('--model', model);
  args.push('--permission-mode', mode);
  if (settings !== null) args.push('--setting-sources', 'user', '--settings', JSON.stringify(settings));
  if (mcp !== null) args.push('--strict-mcp-config', '--mcp-config', JSON.stringify(mcp));
  // `--` ends the options: --mcp-config takes several values (`<configs...>`), so a prompt right after its JSON would be
  // read as a second config, and 2.1.330 refuses the start (`was read as a value of --mcp-config, not as a prompt`).
  const result = run(claude, [...args, '--', prompt], { cwd, timeout: START_TIMEOUT });
  const printed = STARTED.exec(String(result.stdout ?? ''))?.[1] ?? null;
  const want = { before: new Set(before.map((each) => each.sessionId)), cwd, id: printed, name };
  const { entry, list } = awaitSession({ run, claude, wait, ...want });
  if (!entry && !printed) return startProblem(result, list, want.before);
  const id = printed ?? (typeof entry.id === 'string' && ID.test(entry.id) ? entry.id : entry.sessionId);
  const unique = (list ?? []).filter((each) => each.name === name).length === 1;
  return { id, session: entry?.sessionId ?? null, name: unique && PLAIN_NAME.test(name) ? name : null, cwd, mode };
}

// Why a start that printed no id and that the listing does not show made no session it can name: { problem, uncertain }.
// It is certain that none started only when `claude` never ran (NOT_RUN), or when its output is a known refusal (REFUSED)
// and the last listing it read, `list`, holds no background session that the listing before the start, `before`, did
// not. Any other exit, a timeout, a signal, a listing that never answered, or any new background session leaves it
// uncertain: the supervisor may have taken the start, and its session may be listed later.
function startProblem(result, list, before) {
  if (NOT_RUN.has(result.error?.code)) return { problem: `\`claude\` could not be run (${result.error.code})`, uncertain: false };
  const unknown = list === null || list.some((each) => each.kind === 'background' && !before.has(each.sessionId));
  if (result.error) return { problem: `\`claude --bg\` did not finish (${result.error.code ?? 'no code'}), and \`claude agents\` lists no session it started`, uncertain: true };
  if (Number.isInteger(result.status) && result.status !== 0) {
    const refused = REFUSED.test(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
    return { problem: `\`claude --bg\` exited ${result.status}: ${firstLine(result.stderr || result.stdout) || 'no message'}`, uncertain: unknown || !refused };
  }
  if (result.status !== 0) return { problem: `\`claude --bg\` was stopped (${result.signal ?? 'no signal'}), and \`claude agents\` lists no session it started`, uncertain: true };
  return { problem: '`claude --bg` printed no session id, and `claude agents` lists no session it started', uncertain: true };
}

// Whether the host lists the background session a start record names as ended: true only when `claude agents --json
// --all`, which adds the completed background sessions to the active ones, names it, by its full id `session`, or by
// `id`, the id the start printed, when the full one was never listed, and every row that names it is a background
// session with `state: "done"`, as a completed session's row is on 2.1.326, where a running one has `state: "working"`;
// false when a row that names it has any other state, or none names it; null when the listing gives no answer or
// `claude` cannot be found. Only true lets a gate start another session for the same starting session.
export function sessionEnded({ id, session, env, run = runCommand, resolve = claudeOnPath }) {
  return listedIn({ id, session, env, run, resolve, states: DONE });
}

// The states of a background session that runs no more: completed (`done`), stopped by `claude stop` (`stopped`), or
// ended by an error (`failed`), as 2.1.326 names them (docs/providers/claude-code.md).
const DONE = new Set(['done']);
const FINISHED = new Set(['done', 'stopped', 'failed']);

// Whether the host lists the background session a project run started as one that runs no more: sessionEnded's read,
// with `stopped` and `failed` counted as ended too. A project run's driver stops an issue's session past its hours and
// starts the next issue; a session that failed records no result, and the issue opens again. The handoff route keeps
// sessionEnded, where only `done` lets a session start another.
export function sessionFinished({ id, session, env, run = runCommand, resolve = claudeOnPath }) {
  return listedIn({ id, session, env, run, resolve, states: FINISHED });
}

// Whether every row of `claude agents --json --all` that names the session is a background session in one of `states`;
// sessionEnded says how it is named, and when it answers false or null.
function listedIn({ id, session, env, run, resolve, states }) {
  const claude = resolve(env);
  if (!claude) return null;
  const list = listed(run, claude, undefined, ['--all']);
  if (!list) return null;
  const rows = list.filter((each) => namesSession(each, { id, session }));
  return rows.length > 0 && rows.every((each) => each.kind === 'background' && states.has(each.state));
}

// Whether a listing row names the session a start record gives as { id, session }: by the full id `session` when it has
// the id shape, else by `id`, the id the start printed, as the row's `id`, its `sessionId`, or the start of its
// `sessionId`. False for a record that names neither.
function namesSession(row, { id, session }) {
  if (typeof row.sessionId !== 'string') return false;
  if (typeof session === 'string' && ID.test(session)) return row.sessionId === session;
  return typeof id === 'string' && ID.test(id) && (row.id === id || row.sessionId === id || row.sessionId.startsWith(id));
}

// The background rows of a listing whose `sessionId` has the id shape: what the host holds that the harness can name.
const backgroundRows = (list) => list.filter((each) => each.kind === 'background' && typeof each.sessionId === 'string' && ID.test(each.sessionId));

// The states in which a background row whose `status` is `idle` is idle: its turn ended (`done`), or it waits on a
// response (`blocked`), which may be mid-task. A row in `working` with `status: "idle"` ended its turn while a task
// it started still runs (read on 2.1.331), so it is not idle, and neither is a row in a state not named here.
const RESTING = new Set(['done', 'blocked']);

// The plain listing, `claude agents --json` with no `--all`, which holds the sessions the supervisor still keeps, a
// finished one among them (`state: "done"`, `status: "idle"`, a `pid`, read on 2.1.331), while `--all` adds the
// completed ones it holds no more: { list } or { problem }.
function heldListing({ env, run, resolve }) {
  const claude = resolve(env);
  if (!claude) return { problem: NO_CLAUDE };
  const list = listed(run, claude, undefined);
  return list ? { list } : { problem: '`claude agents --json` did not answer, so the background sessions it holds are unknown' };
}

// The background sessions the host holds, from one read of the plain listing: { sessions: [{ id, session, name, cwd,
// startedAt, idle, waiting }] } or { problem }. `id` is the short id `claude stop` takes, else the full one; `name`,
// `cwd`, and `startedAt` are the listing's, which hosts/index.mjs backgroundList cleans; `idle` is true only for
// `status: "idle"` in a RESTING state, so a row with no `status` or still working is never idle, and `waiting` only for
// `state: "blocked"`. An interactive row is left out.
export function listBackground({ env, run = runCommand, resolve = claudeOnPath }) {
  const read = heldListing({ env, run, resolve });
  if (read.problem) return read;
  return {
    sessions: backgroundRows(read.list).map((each) => ({
      id: typeof each.id === 'string' && ID.test(each.id) ? each.id : each.sessionId,
      session: each.sessionId,
      name: each.name,
      cwd: each.cwd,
      startedAt: each.startedAt,
      idle: each.status === 'idle' && RESTING.has(each.state),
      waiting: each.state === 'blocked',
    })),
  };
}

// Which of `sessions`, each { id, session } as a start record names it, the host still holds, from one read of the
// plain listing: { held: [true | false | null, ...] } in their order, null for a member that names no session, or
// { problem }. A member is held when a background row names it (namesSession).
export function heldSessions({ sessions, env, run = runCommand, resolve = claudeOnPath }) {
  const read = heldListing({ env, run, resolve });
  if (read.problem) return read;
  const rows = backgroundRows(read.list);
  const known = ({ id, session }) => [id, session].some((each) => typeof each === 'string' && ID.test(each));
  return { held: sessions.map((member) => (known(member) ? rows.some((row) => namesSession(row, member)) : null)) };
}

// Stops the background session `session` this process runs in, listed under the id `id`, with `claude stop`: whether it
// exited 0. It stops nothing unless the listing names exactly one background session whose `sessionId` is `session` and
// whose `id` is `id`, or which starts with `id`: a session ends only itself, never another.
export function stopOwnBackground({ id, session, env, run = runCommand, resolve = claudeOnPath }) {
  const claude = resolve(env);
  if (!claude || typeof id !== 'string' || !ID.test(id) || typeof session !== 'string' || !ID.test(session)) return false;
  const own = (listed(run, claude, undefined) ?? []).filter((each) => each.kind === 'background' && each.sessionId === session
    && (each.id === id || session.startsWith(id)));
  if (own.length !== 1) return false;
  const target = typeof own[0].id === 'string' && ID.test(own[0].id) ? own[0].id : session;
  const result = run(claude, ['stop', target], { cwd: undefined, timeout: LIST_TIMEOUT });
  return !result.error && result.status === 0;
}

// Whether `claude attach <target>` opens the session `session` for a typed target that is no id of it: a test of a
// target, from one read of the whole listing, every row. `claude attach --help` on 2.1.328 takes `<id|name>`, and part
// of a name works in place of the id; which session it picks when several names hold the target is not known, so the
// test holds only when the target cannot open another: it is this session's whole name, case and all; no other row's
// name holds it, which covers a name two sessions share and a session renamed since; and no row's `sessionId` or `id`,
// this session's own included, is the target or starts with it, so a target that reads as an id never opens by a name.
// A part of a name never matches. Null when the listing cannot be read, does not name the session once, or holds a row
// whose `sessionId` or `name` is not a string, or whose `id` is neither a string nor absent, as no check can then run.
// `skip`, when a string, is the full id of the session the handoff just started, whose row alone is left out: no
// terminal attached to it before it existed, and its name, such as `widget · 1`, holds this one's, `widget`.
export function nameMatcher({ session, skip = null, env, run = runCommand, resolve = claudeOnPath }) {
  const claude = resolve(env);
  if (!claude || typeof session !== 'string' || !ID.test(session) || skip === session) return null;
  const listing = listedRows(run, claude, undefined);
  const whole = (row) => row !== null && typeof row === 'object' && typeof row.sessionId === 'string' && typeof row.name === 'string'
    && (row.id === undefined || typeof row.id === 'string');
  if (listing === null || !listing.every(whole)) return null;
  const rows = typeof skip === 'string' && skip !== '' ? listing.filter((row) => row.sessionId !== skip) : listing;
  const own = rows.filter((row) => row.sessionId === session);
  if (own.length !== 1) return null;
  const { name } = own[0];
  return (target) => typeof target === 'string' && target !== '' && target === name
    && rows.every((row) => row === own[0] || !row.name.includes(target))
    && !rows.some((row) => [row.sessionId, row.id].some((id) => typeof id === 'string' && id.startsWith(target)));
}

// How the Human finds and stops a session a start may have made, when the gate cannot name it.
export const findLine = () => '`claude agents` lists the background sessions, with the folder each started in, and `claude stop <id>` stops one';

// Stops the background session `id`, as `claude stop` does: whether it exited 0. `claude stop` takes the listing's short
// `id` and refuses a full `sessionId` ("No session matching", exit 1, seen on 2.1.330). So `started`, the id the
// session's start printed when a caller recorded one, and then `id`, each go to `claude stop` as they are, with no
// listing, unless it is a full `sessionId`. Only when none of those stopped it is the listing read once, and a full
// `sessionId` given turned into the short `id` of the one listed row whose `sessionId` is exactly it, and tried. No
// prefix is matched: a prefix another session shares would stop that session instead.
export function stopBackground({ id, started = null, env, run = runCommand, resolve = claudeOnPath }) {
  const claude = resolve(env);
  if (!claude || typeof id !== 'string' || !ID.test(id)) return false;
  const given = [...new Set([started, id].filter((each) => typeof each === 'string' && ID.test(each)))];
  const tried = new Set();
  const stop = (target) => {
    if (tried.has(target)) return false;
    tried.add(target);
    const result = run(claude, ['stop', target], { cwd: undefined, timeout: LIST_TIMEOUT });
    return !result.error && result.status === 0;
  };
  if (given.some((each) => !FULL_ID.test(each) && stop(each))) return true;
  const rows = listed(run, claude, undefined, ['--all']) ?? [];
  return given.filter((each) => FULL_ID.test(each)).some((each) => {
    const holds = rows.filter((row) => row.sessionId === each);
    const short = holds.length === 1 && typeof holds[0].id === 'string' && ID.test(holds[0].id) ? holds[0].id : each;
    return stop(short);
  });
}

// A full session id, as `claude agents` gives `sessionId`: one `claude stop` refuses.
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
