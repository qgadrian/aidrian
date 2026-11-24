// The tracker write guard's pure logic: reading a tool response for the connected workspace, and judging a write against
// `tracker` in config.json (docs/config.md#tracker). It touches no file and names no tracker: every tool, field, and
// value comes from the config, which config-merge.mjs `checkTracker` has already validated.

import { createHash } from 'node:crypto';
import path from 'node:path';

import { nameMatches } from './agent-gates.mjs';
import { textProblem } from './clean-text.mjs';
import { UNKNOWN_HOST } from './hosts/index.mjs';
import { hookCountsFolder } from './project.mjs';
import { knownServers, TRACKERS, trackerById, writeToolsOf } from './trackers/index.mjs';

// An issue key, <KEY>-<n>. The prefix follows config-types.mjs `teamKey`: no hyphen and no whitespace.
const ISSUE_KEY = /^([^\s-]+)-\d+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// The value of `field` in a tool's `tool_response`, or null when it gives none, which is an unreadable read. `host` says
// where its shape holds that value (lib/hosts/): its adapter lists the objects, the most direct first, and the first that
// has the field answers. An unknown host, or none given, tries every adapter's way.
export function readTrackerValue(response, field, host = UNKNOWN_HOST) {
  for (const held of host.toolResponse(response)) {
    const value = text(held[field]);
    if (value !== null) return value;
  }
  return null;
}

const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

// Why the call of `tool` with `input` may not run, as { match, reason } the way agent-gates.mjs gateDenial gives it, or
// null when it may. `record` is the session's read of the workspace, { value, unreadable, tool, at }, or null when it has
// none. Only a tool in `tracker.writeTools` is judged, and only while `tracker.enabled` is true. A record counts only for
// a write on the server its read ran on, since two servers can be connected to different workspaces. A caller whose
// session can hold no record passes `skipMissingRecord`. A refusal with `routine: true` is the step every writing session
// takes, which alone says nothing about the session: the caller counts it only when the session ends with no read recorded.
// `rawTool` is what the host sent when it differs from `tool`, since a pattern may name either (lib/hosts/index.mjs toolNames),
// and `host` names the read a refusal asks for as its model sees that tool.
export function judgeTrackerWrite({ tracker, names }, tool, input, record, { skipMissingRecord = false, rawTool, host = UNKNOWN_HOST } = {}) {
  if (tracker?.enabled !== true || typeof tool !== 'string') return null;
  const called = rawTool ? [tool, rawTool] : [tool];
  if (!tracker.writeTools.some((pattern) => called.some((name) => nameMatches(pattern, name)))) return null;
  const workspace = tracker.workspaceInput ? inputWorkspaceRefusal(tracker, input, names.human) : workspaceRefusal(tracker, tool, record, names.human, skipMissingRecord, host);
  return workspace ?? teamRefusal(tracker, input, names.human) ?? projectRefusal(tracker.project, input, names.human);
}

// The `mcp__<server>__` that starts a tool's name, or null when it has none. The server ends at the first double
// underscore, so a server such as plugin_a_b keeps its single underscores and a tool such as get__workspace its double
// ones. A server whose own name holds a double underscore reads as the part before it.
export const serverPrefix = (tool) => (typeof tool === 'string' ? (/^mcp__.+?__/u.exec(tool)?.[0] ?? null) : null);

// The server of a name from the key, which a project may have written as its host sends it. config-tracker.mjs reads a key by this too,
// so its check and the guard agree on which read clears which write.
export const keyServer = (name) => serverPrefix(UNKNOWN_HOST.toolName(name));

// The refusal of a write on `server` with no read to count. Only one that a listed read clears is routine: the two cases no
// read clears, which config-merge.mjs `checkTracker` reports, are a key to correct, and repeat until someone does.
function noReadRefusal(readTools, server, human, host) {
  const why = 'this session has not read the connected workspace';
  if (server === null) return refused(why, `tracker.writeTools names this tool with no server, so no read can clear it. Ask ${human} to correct that entry, and do not edit the key`);
  const reads = readTools.filter((name) => keyServer(name) === server).map((name) => host.nativeToolName(UNKNOWN_HOST.toolName(name)));
  if (reads.length === 0) return refused(why, `Ask ${human} to add a read tool on this server to tracker.readTools, and do not edit the key`);
  return { ...refused(why, `Call ${reads.join(' or ')}, then write again`), routine: true };
}

function workspaceRefusal({ workspace, readTools }, tool, record, human, skipMissingRecord, host) {
  if (!workspace) return null;
  const server = serverPrefix(tool);
  if (server === null || serverPrefix(record?.tool) !== server) {
    if (skipMissingRecord) return null;
    return noReadRefusal(readTools, server, human, host);
  }
  const value = record.unreadable === true ? null : text(record.value);
  if (value === null) {
    return refused(`the read returned no ${workspace.field} (${record.tool})`, `Ask ${human} to fix the tracker connection or the key tracker.workspace.field`);
  }
  if (withoutTrailingSlash(value) === withoutTrailingSlash(workspace.expect)) return null;
  return refused(`the connected workspace is ${JSON.stringify(value)}, and tracker.workspace.expect is ${JSON.stringify(workspace.expect)}`, `Ask ${human} whether tracker.workspace.expect is wrong or the wrong workspace is connected, and do not edit the key`);
}

// The same rule for a tracker whose every write names its workspace (`tracker.workspaceInput`), judged on the call, so no read is
// asked for. A write that names none cannot be told apart from one to the wrong workspace, so it is refused too.
function inputWorkspaceRefusal({ workspace, workspaceInput }, input, human) {
  const value = text(input?.[workspaceInput]);
  const expect = JSON.stringify(workspace.expect);
  if (value === null) return refused(`it names no ${workspaceInput}`, `Pass ${workspaceInput} ${expect}, or tell ${human} this write belongs elsewhere, and do not edit the key`);
  if (withoutTrailingSlash(value) === withoutTrailingSlash(workspace.expect)) return null;
  return refused(`${workspaceInput} is ${JSON.stringify(value)}, and tracker.workspace.expect is ${expect}`, `Write to that workspace, or ask ${human} whether tracker.workspace.expect is wrong, and do not edit the key`);
}

// The file a routine refusal leaves for the end of its session, in the hooks' counts folder, or null when the session id
// cannot name one. A refusal alone cannot tell a session about to read from one whose read cannot succeed;
// hook-session-end.mjs can. It is written and read only as this user's own regular file (fs.mjs writeOwnText,
// readOwnText).
export function refusalMarker(session, { env = process.env } = {}) {
  if (typeof session !== 'string' || !/^[\w-]{1,128}$/u.test(session)) return null;
  try {
    return path.join(hookCountsFolder(env), `aidrian-tracker-refused-${session}`);
  } catch {
    return null;
  }
}

// The cause on the `hook_deny` row of a session that ended that way.
export const NO_READ_LANDED = 'this session was refused for no read of the connected workspace, and no read landed';

// The first word of a tool name that only reads. It keeps the tools every session reads with out of the note below; a
// write tool named this way, such as get_or_create_item, is the limit, which docs/config.md#tracker states.
const READ_NAME = /^(?:get|list|search|read|find|fetch|query|view|show|describe|whoami)(?![a-z])/u;
// The same for the roles the run rule holds (STRICT_ROLES): no `query`, which may run any statement, and no name that
// holds a write verb (WRITE_WORDS) past its read verb, as get_or_create_item, list_and_update, or getOrCreate.
const STRICT_READ_NAME = /^(?:get|list|search|read|find|fetch|view|show|describe|whoami)(?![a-z])/u;
const WRITE_WORDS = new Set([
  'create', 'update', 'upsert', 'insert', 'delete', 'remove', 'add', 'set', 'save', 'edit', 'write', 'put', 'patch', 'modify', 'assign',
  'unassign', 'move', 'merge', 'close', 'reopen', 'archive', 'unarchive', 'transition', 'send', 'publish', 'upload', 'rename', 'submit',
  'replace', 'append', 'resolve', 'approve', 'reject', 'destroy',
]);
// The words of a tool's name, split at underscores, dashes, dots, and a lower-case letter or digit before a capital.
const nameWords = (name) => name.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase().split(/[\s_.-]+/u).filter(Boolean);
// Whether `short`, a tool's name after its server, says it only reads to a role the run rule holds (STRICT_READ_NAME).
const strictReadName = (short) => STRICT_READ_NAME.test(short) && !nameWords(short).some((word) => WRITE_WORDS.has(word));

// Whether `tool` ran on a server that `tracker.readTools` or `tracker.writeTools` names with neither list naming it, and
// with a name that does not say it only reads: the guard let it run unjudged, and it may be a write the lists have not
// caught up with.
export function unlistedTool({ readTools, writeTools, readVerbs = [] }, tool, rawTool) {
  const server = serverPrefix(tool);
  const called = rawTool ? [tool, rawTool] : [tool];
  if (server === null || called.some((name) => readTools.includes(name) || writeTools.some((pattern) => nameMatches(pattern, name)))) return false;
  const short = tool.slice(server.length);
  if (READ_NAME.test(short) || readVerbs.some((pattern) => nameMatches(pattern, short))) return false;
  return [...readTools, ...writeTools].some((name) => keyServer(name.replace(/\*$/u, '')) === server);
}

const withoutTrailingSlash = (value) => (value.endsWith('/') ? value.slice(0, -1) : value);

// What a refused issue key tells the agent to do when the write is on something else (`tracker.idHint`, from the adapter).
const ID_HINT = "pass the item's UUID when it is not an issue";

function teamRefusal({ team, idHint = ID_HINT }, input, human) {
  if (!team) return null;
  for (const field of team.createFields) {
    const refusal = listRefusal({ field, value: input?.[field], allowed: team.values, key: 'tracker.team.values', human, teamKey: team.key });
    if (refusal) return refusal;
  }
  for (const field of team.keyFields) {
    const value = input?.[field];
    const prefix = typeof value === 'string' ? ISSUE_KEY.exec(value)?.[1] : undefined;
    if (prefix !== undefined && !sameKey(prefix, team.key)) {
      return refused(`${field} is ${JSON.stringify(value)}, whose prefix is not tracker.team.key ${JSON.stringify(team.key)}`, `Write to an issue of that team, ${idHint}, or tell ${human} this write belongs elsewhere, and do not edit the key`);
    }
  }
  return null;
}

function projectRefusal(project, input, human) {
  return project ? listRefusal({ field: project.field, value: input?.[project.field], allowed: project.values, key: 'tracker.project.values', human }) : null;
}

const sameKey = (one, other) => one.toLowerCase() === other.toLowerCase();

// The refusal of a value, or the first entry of an array, that is not listed, not a UUID, and not `teamKey` when given.
// An absent field, null, or an empty array names no value to check, so no wrong team or project can be set.
function listRefusal({ field, value, allowed, key, human, teamKey }) {
  if (value === undefined || value === null) return null;
  const accepted = (entry) => allowed.includes(entry)
    || (typeof entry === 'string' && (UUID.test(entry) || (teamKey !== undefined && sameKey(entry, teamKey))));
  const wrong = (Array.isArray(value) ? value : [value]).filter((entry) => !accepted(entry));
  if (wrong.length === 0) return null;
  const listed = allowed.map((each) => JSON.stringify(each)).join(', ');
  const use = teamKey === undefined ? 'a listed value' : `a listed value or the team key ${JSON.stringify(teamKey)}`;
  return refused(`${field} ${Array.isArray(value) ? 'has' : 'is'} ${JSON.stringify(wrong[0])}, and ${key} allows ${listed}`, `Use ${use}, or tell ${human} this write belongs elsewhere, and do not edit the key`);
}

// `match` is the cause alone, with its values, for the deny row, which keeps 120 characters (dispatch-rows.mjs);
// `reason` tells the agent that cause and what to do.
const refused = (why, next) => ({ match: why, reason: `aidrian: this tracker write is refused because ${why}. ${next}.` });

// The sha256 of a comment body, as `aidrian project report` prints it and the driver's write must match.
export const bodyHash = (body) => createHash('sha256').update(body, 'utf8').digest('hex');

// The hosts an MCP server's definition, as projectRun.mcpServers holds it, reaches: its `url`, and each URL among its
// `args`, as a server started through a remote proxy names one.
function endpointHosts(definition) {
  const values = [definition?.url, ...(Array.isArray(definition?.args) ? definition.args : [])].filter((each) => typeof each === 'string');
  const hosts = [];
  for (const value of values) {
    try {
      hosts.push(new URL(value).hostname.toLowerCase());
    } catch {
      // Not a URL.
    }
  }
  return hosts;
}

// The adapter whose endpoints the MCP server `definition` reaches, or null.
export const trackerOfEndpoint = (definition, trackers = TRACKERS) => {
  const hosts = endpointHosts(definition);
  return trackers.find((each) => (each.endpoints ?? []).some((host) => hosts.includes(host.toLowerCase()))) ?? null;
};

// The adapter whose connection serves the tool `tool`, or null: one whose known servers, with the servers `tracker`
// (the base branch's key) adds for its own provider, hold its server; one whose endpoints the server of that name in
// `mcpServers` (the base branch's projectRun.mcpServers) reaches; else the provider of `tracker`, when its `writeTools`
// name that server.
export function trackerOfTool(tool, tracker, trackers = TRACKERS, mcpServers = {}) {
  const server = serverPrefix(tool);
  if (server === null) return null;
  const named = typeof tracker?.provider === 'string' ? trackerById(tracker.provider, trackers) : null;
  const extra = Array.isArray(tracker?.servers) ? tracker.servers : [];
  const found = trackers.find((each) => knownServers(each, each === named ? extra : []).some((name) => `mcp__${name}__` === server));
  if (found) return found;
  for (const [name, definition] of Object.entries(mcpServers ?? {})) {
    const adapter = trackerOfEndpoint(definition, trackers);
    if (adapter && knownServers({ servers: {} }, [name]).some((spelled) => `mcp__${spelled}__` === server)) return adapter;
  }
  const listed = Array.isArray(tracker?.writeTools) && tracker.writeTools.some((pattern) => keyServer(pattern.replace(/\*$/u, 'x')) === server);
  return listed ? named : null;
}

// Whether `short`, a tool's name after its server, is a read by its name to a role the run rule holds: a read verb with
// no write verb after it (strictReadName), the adapter's own read tool, or one of its `readVerbs`.
const readByName = (adapter, short) => strictReadName(short) || short === adapter?.readTool || (adapter?.readVerbs ?? []).some((pattern) => nameMatches(pattern, short));

// Whether the MCP tool `tool` says by its name that it only reads (strictReadName), whatever its server: what a hook lets
// a held session call when it cannot finish judging the call (scripts/hook-tracker-pre.mjs).
export const readsByName = (tool) => {
  const server = serverPrefix(tool);
  return server !== null && strictReadName(tool.slice(server.length));
};

// Whether `server`, a tool's `mcp__<server>__` prefix, is one of `mcpServers` (the base branch's projectRun.mcpServers),
// as a host spells its name, that `others` (projectRun.nonTrackerServers) does not declare reaches no tracker.
const listedServer = (server, mcpServers, others) => Object.keys(mcpServers ?? {})
  .some((name) => !others.includes(name) && knownServers({ servers: {} }, [name]).some((spelled) => `mcp__${spelled}__` === server));

// Whether `server`, a tool's `mcp__<server>__` prefix, is one `others` (projectRun.nonTrackerServers) declares reaches no
// tracker, as a host spells its name.
const declaredServer = (server, others) => others.some((name) => knownServers({ servers: {} }, [name]).some((spelled) => `mcp__${spelled}__` === server));

// What the run rule judges of the call of `tool` with `input`: { adapter, short, merge, ready, write, unscreened }, or
// null for a call it lets run whoever calls. `merge` is a tool whose name an adapter's `mergeVerbs` match, on its
// tracker's server (`tracker`), or on any server (`anywhere`); `ready` a call the adapter's `readyCalls` name; `write` a
// call `writeTools` or the adapter's own verbs match, or, with `strict`, any call on a tracker's server that is not a read
// by its name. `unscreened`, with `strict` only, is a call no adapter maps whose name does not say it reads, on a server
// of `mcpServers` that `otherServers` does not declare reaches no tracker, with `unlisted`, on any server `otherServers`
// does not declare, or, with `blind`, on any server: the rule cannot tell it from a tracker write, so it counts as a
// write too.
export function runCallKind({ tool, rawTool, input, tracker = null, writeTools = [], trackers = TRACKERS, mcpServers = {}, otherServers = [], strict = false, blind = false, unlisted = false }) {
  if (typeof tool !== 'string') return null;
  const called = rawTool ? [tool, rawTool] : [tool];
  const adapter = trackerOfTool(tool, tracker, trackers, mcpServers);
  const server = serverPrefix(tool);
  const short = server === null ? tool : tool.slice(server.length);
  const mergeNamed = trackers.some((each) => (each.mergeVerbs ?? []).some((verb) => nameMatches(verb, short)));
  const merge = mergeNamed ? (adapter ? 'tracker' : 'anywhere') : null;
  const given = input && typeof input === 'object' ? input : {};
  const ready = Boolean(adapter && (adapter.readyCalls ?? []).some((each) => each.tool === short && each.values.includes(given[each.field])));
  const patterns = [...writeTools, ...(adapter ? writeToolsOf(adapter, [server.slice('mcp__'.length, -2)]) : [])];
  const unscreened = strict && adapter === null && server !== null && !strictReadName(short) && (blind || listedServer(server, mcpServers, otherServers) || (unlisted && !declaredServer(server, otherServers)));
  const write = patterns.some((pattern) => called.some((name) => nameMatches(pattern, name))) || (strict && adapter !== null && !readByName(adapter, short)) || unscreened;
  return merge || ready || write ? { adapter, short, merge, ready, write, unscreened } : null;
}

// Why a session may not call `tool` with `input` under the project run rule, as { match, reason }, or null. It never
// reads `tracker.enabled`: a working copy that turns the guard off turns none of this off. `writer` says who calls, as
// lib/project-report.mjs runWriter reads it from the session's unattended mark and its driver mark:
//   null                            an attended session: only a tracker's merge and ready calls are refused, since
//                                   `gh pr merge` and `gh pr ready` are the routes their guards judge;
//   { role: 'child', run, issue }   an issue's session: it writes only its own issue, by its key, through the adapter's
//                                   `run` tools and fields, status `started` only, with text no mention, link, address,
//                                   image, HTML, or hidden character; a create, a UUID, or another tool is refused;
//   { role: 'driver', run, owed, started }
//                                   the run's current driver: it writes only what `aidrian project report` owes, each
//                                   [{ key, status, label, sha256 }]: the status and label as printed, and a comment
//                                   whose body has that sha256; and, on an issue that owes none, the started status
//                                   `started` lists, [{ key, status }], with no other field;
//   { role: 'unattended' }          a session no Human attends outside a run: the merge and ready rules alone;
//   { role: 'held', why }           a session that cannot be told apart from one of these: every write refused.
// Any role but null is refused a tool a merge verb names on any server. For the child, driver, and held roles, every call
// on a tracker's server is a write unless its name says it reads, and so is every call no tracker maps, unless its name
// says it reads, on a server of `mcpServers` that `otherServers` does not declare reaches no tracker: a tracker
// connection the rule cannot map. The driver runs in a session with the user's own servers, not `mcpServers` alone, so
// for it that holds on every server `otherServers` does not declare. A name says it reads to these roles only with a
// read verb other than `query` first and no write verb after it (strictReadName), so get_or_create_item and
// list_and_update count as writes. `tracker`, `mcpServers`, and `otherServers` are the base branch's `tracker`,
// projectRun.mcpServers, and projectRun.nonTrackerServers, read through the main checkout the session's mark names.
// `unread` says why that read failed, or null when it did not: the child and driver roles, then, and the held role
// always, since it reads none, count every call on any server that no tracker maps as one of those.
export function runWriteRefusal({ writer, tool, rawTool, input, tracker = null, writeTools = [], human = 'the Human', trackers = TRACKERS, mcpServers = {}, otherServers = [], unread = null }) {
  const strict = STRICT_ROLES.includes(writer?.role);
  const blind = writer?.role === 'held' || unread !== null;
  const kind = runCallKind({ tool, rawTool, input, tracker, writeTools, trackers, mcpServers, otherServers, strict, blind, unlisted: writer?.role === 'driver' });
  if (kind === null) return null;
  const { adapter, short } = kind;
  if (kind.merge === 'anywhere' && writer) {
    return refused(`${short} is named like a tool that merges, and a session no Human attends never calls one, on any server`, `Merge only through the pr-auto-merge skill, \`aidrian pr auto-merge <number> --check\`; or leave it to ${human}`);
  }
  if (kind.merge === 'tracker') {
    return refused(`${short} merges code through the tracker, past the merge guard`, writer
      ? `A session no Human attends merges only through the pr-auto-merge skill, \`aidrian pr auto-merge <number> --check\`; or leave the merge to ${human}`
      : 'Merge with `gh pr merge <number>`, which the merge guard judges');
  }
  if (kind.ready) return refused(`${short} marks a pull request ready through the tracker, past the ready hold`, 'Mark it ready with `gh pr ready <number>`, which the ready hold judges');
  if (!writer || !kind.write || writer.role === 'unattended') return null;
  if (writer.role === 'held') return refused(writer.why, `Try again once that has settled, or tell ${human}`);
  if (kind.unscreened) return unscreenedRefusal(short, serverPrefix(tool), { unread, listed: listedServer(serverPrefix(tool), mcpServers, otherServers) }, human);
  const call = runCall(adapter, short, input);
  if (writer.role === 'child') return childRefusal(writer, call, adapter, short, human);
  if (writer.role === 'driver') return driverRefusal(writer, call, adapter, short, human);
  return refused(`the run cannot tell what this session may write (${String(writer.role).slice(0, 20)})`, `Tell ${human}`);
}

// The roles the run rule holds to its run: every call that may write a tracker is judged.
export const STRICT_ROLES = Object.freeze(['child', 'driver', 'held']);

// The refusal of a call the run rule cannot screen: `short` on `server`, which no tracker maps, with a name that does
// not say it reads; `unread`, why the base branch's config could not be read, or null; `listed`, whether
// projectRun.mcpServers lists the server, which for the driver may be any server projectRun.nonTrackerServers does not name.
function unscreenedRefusal(short, server, { unread, listed }, human) {
  if (unread !== null) {
    return refused(`${short} does not say by its name that it reads, and the run rule cannot tell which servers reach a tracker, since ${unread}`, `Call only tools that read until that is fixed, or tell ${human}`);
  }
  const name = server.slice('mcp__'.length, -2);
  const which = listed ? 'a server projectRun.mcpServers lists' : 'a server of this session projectRun.nonTrackerServers does not name';
  return refused(`${short} does not say by its name that it reads, and ${name}, ${which}, maps to no tracker, so whether it writes one cannot be told`, `Ask ${human} to point that server at its tracker's own endpoint, or to list ${name} in projectRun.nonTrackerServers when it reaches no tracker; do not edit the key`);
}

// The call of `short` with `input` as the adapter's `run` names it: { kind, spec, key, fields }, or null for any other
// tool. `fields` are the input's fields that hold a value, the key among them.
function runCall(adapter, short, input) {
  const run = adapter?.run;
  if (!run) return null;
  const kind = ['issue', 'comment'].find((each) => run[each]?.tool === short);
  if (!kind) return null;
  const given = input && typeof input === 'object' ? input : {};
  return { kind, spec: run[kind], key: given[run[kind].key], fields: Object.keys(given).filter((field) => given[field] !== undefined), input: given };
}

// What the run's tools are, for a refusal's next step.
const runTools = (adapter) => (adapter?.run ? `${adapter.run.issue.tool} with ${adapter.run.issue.key} or ${adapter.run.comment.tool} with ${adapter.run.comment.key}` : 'no tool: this tracker\'s adapter names none for a project run');

// Why the call names no issue the session may write, or null: no issue field, which is a create; a UUID; another key.
function keyProblem(call, allowed) {
  if (typeof call.key !== 'string' || call.key === '') return `it names no issue in ${call.spec.key}, which makes a new item`;
  if (UUID.test(call.key)) return `it names the item by a UUID in ${call.spec.key}, which names no issue key`;
  return allowed(call.key) ? null : `${call.spec.key} is ${JSON.stringify(call.key)}`;
}

// The keys of a patch operation whose text is never inserted: the operation's name, and the anchors an operation matches
// existing text by. An adapter's `anchors` names its own; these hold for every adapter.
const ANCHORS = Object.freeze(['op', 'old_string', 'anchor', 'from', 'to']);

// The text a value may insert: the value itself when it is a string; else, at any depth, every string but those under a
// key of ANCHORS or of the adapter's `anchors`, so a key the adapter does not know is checked as text.
const insertedText = (value, anchors) => {
  if (typeof value === 'string') return [value];
  const skipped = new Set([...ANCHORS, ...anchors]);
  const walk = (each) => {
    if (typeof each === 'string') return [each];
    if (Array.isArray(each)) return each.flatMap(walk);
    if (!each || typeof each !== 'object') return [];
    return Object.entries(each).flatMap(([key, held]) => (skipped.has(key) ? [] : walk(held)));
  };
  return walk(value);
};

function childRefusal(writer, call, adapter, short, human) {
  const own = `an issue's session of the run ${writer.run} writes only its own issue ${writer.issue}`;
  if (!call) return refused(`${short} is not a write the run's tools make, and ${own}`, `Write only through ${runTools(adapter)} ${writer.issue}, or put it in the result for ${human}`);
  const key = keyProblem(call, (key) => key === writer.issue);
  if (key) return refused(`${key}, and ${own}`, `Name ${writer.issue} in ${call.spec.key}, or put the write in the result for ${human}`);
  const allowed = call.kind === 'issue' ? [call.spec.key, call.spec.status, ...(call.spec.fields ?? [])] : [call.spec.key, call.spec.body];
  const extra = call.fields.find((field) => !allowed.includes(field));
  if (extra) return refused(`${short} sets ${extra}, which ${own} does not set`, `Set only ${allowed.join(', ')}, or put the rest in the result for ${human}`);
  if (call.kind === 'issue' && call.fields.includes(call.spec.status) && call.input[call.spec.status] !== call.spec.started) {
    return refused(`${short} sets ${call.spec.status} to ${JSON.stringify(call.input[call.spec.status])?.slice(0, 40)}, and an issue's session sets only ${JSON.stringify(call.spec.started)}`, `Leave the rest to the run's report, which the driver writes`);
  }
  const texts = call.kind === 'issue' ? (call.spec.text ?? []) : [call.spec.body];
  const field = texts.find((each) => insertedText(call.input[each], call.spec.anchors ?? []).some(textProblem));
  if (field) return refused(`${short} sets ${field} with a mention, link, address, image, HTML, or hidden character`, 'Write plain text: name a page or a person in words, and put a file or host name in backticks, such as `config.json`');
  return null;
}

function driverRefusal(writer, call, adapter, short, human) {
  const report = `\`aidrian project report ${writer.run}\``;
  const only = `the run ${writer.run}'s driver writes only what ${report} owes, and the started status of an issue it runs`;
  if (!call) return refused(`${short} is not a write the run's tools make, and ${only}`, `Write only through ${runTools(adapter)}, with the values ${report} printed`);
  const owed = (writer.owed ?? []).find((each) => each.key === call.key);
  const start = owed ? undefined : (writer.started ?? []).find((each) => each.key === call.key);
  const key = keyProblem(call, () => owed !== undefined || start !== undefined);
  if (key) return refused(`${key}, and ${only}`, `Write only to an issue ${report} lists, or one the run started, by its key, or tell ${human}`);
  if (start) return startedRefusal(call, start, short);
  if (call.kind === 'comment') {
    const extra = call.fields.find((field) => ![call.spec.key, call.spec.body].includes(field));
    if (extra) return refused(`${short} sets ${extra}, and ${only}`, `Pass only ${call.spec.key} and ${call.spec.body}`);
    const body = call.input[call.spec.body];
    if (typeof body !== 'string' || bodyHash(body) !== owed.sha256) return refused(`the comment on ${owed.key} is not the body ${report} printed`, `Post that body exactly, as its JSON gives it, with sha256 ${owed.sha256}`);
    return null;
  }
  const wanted = { [call.spec.status]: owed.status, [call.spec.label]: owed.label === null ? null : [owed.label] };
  const extra = call.fields.find((field) => field !== call.spec.key && (!(field in wanted) || wanted[field] === null));
  if (extra) return refused(`${short} sets ${extra} on ${owed.key}, and ${only}`, `Set only ${describeWanted(wanted)}`);
  const wrong = call.fields.find((field) => field !== call.spec.key && JSON.stringify(call.input[field]) !== JSON.stringify(wanted[field]));
  if (wrong) return refused(`${short} sets ${wrong} to ${JSON.stringify(call.input[wrong])?.slice(0, 60)} on ${owed.key}, and ${report} owes ${JSON.stringify(wanted[wrong])}`, `Set only ${describeWanted(wanted)}`);
  if (call.fields.length < 2) return refused(`${short} sets nothing on ${owed.key}`, `Set ${describeWanted(wanted)}`);
  return null;
}

// Why the driver may not make the call `call` on the issue `start` names, which runs and owes no report, or null: it
// may set the issue's status to `start.status`, the adapter's started status type, with no other field.
function startedRefusal(call, start, short) {
  const set = `Set only ${call.spec.status} ${JSON.stringify(start.status)} on ${start.key}, through ${call.spec.tool}`;
  const only = `the run's driver sets only the started status of ${start.key}, an issue that runs`;
  if (call.kind !== 'issue') return refused(`${short} writes a comment on ${start.key}, and ${only}`, set);
  const extra = call.fields.find((field) => field !== call.spec.key && field !== call.spec.status);
  if (extra) return refused(`${short} sets ${extra} on ${start.key}, and ${only}`, set);
  if (!call.fields.includes(call.spec.status)) return refused(`${short} sets nothing on ${start.key}`, set);
  const value = call.input[call.spec.status];
  if (value !== start.status) return refused(`${short} sets ${call.spec.status} to ${JSON.stringify(value)?.slice(0, 40)} on ${start.key}, and ${only}, ${JSON.stringify(start.status)}`, set);
  return null;
}

const describeWanted = (wanted) => {
  const set = Object.entries(wanted).filter(([, value]) => value !== null);
  return set.length ? set.map(([field, value]) => `${field} ${JSON.stringify(value)}`).join(' and ') : 'nothing on the issue but its comment';
};
