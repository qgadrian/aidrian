// The tracker write guard's pure logic: reading a tool response for the connected workspace, and judging a write against
// `tracker` in config.json (docs/config.md#tracker). It touches no file and names no tracker: every tool, field, and
// value comes from the config, which config-merge.mjs `checkTracker` has already validated.

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { nameMatches } from './agent-gates.mjs';
import { UNKNOWN_HOST } from './hosts/index.mjs';
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

// The file a routine refusal leaves for the end of its session, or null when the session id cannot name one. A refusal
// alone cannot tell a session about to read from one whose read cannot succeed; hook-session-end.mjs can.
export const refusalMarker = (session) =>
  (typeof session === 'string' && /^[\w-]{1,128}$/u.test(session) ? path.join(tmpdir(), `aidrian-tracker-refused-${session}`) : null);

// The cause on the `hook_deny` row of a session that ended that way.
export const NO_READ_LANDED = 'this session was refused for no read of the connected workspace, and no read landed';

// The first word of a tool name that only reads. It keeps the tools every session reads with out of the note below; a
// write tool named this way, such as get_or_create_item, is the limit, which docs/config.md#tracker states.
const READ_NAME = /^(?:get|list|search|read|find|fetch|query|view|show|describe|whoami)(?![a-z])/u;

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

// The adapter whose connection serves the tool `tool`, or null: one whose known servers, with the servers `tracker`
// (the base branch's key) adds for its own provider, hold its server; else the provider of `tracker`, when its
// `writeTools` name that server.
export function trackerOfTool(tool, tracker, trackers = TRACKERS) {
  const server = serverPrefix(tool);
  if (server === null) return null;
  const named = typeof tracker?.provider === 'string' ? trackerById(tracker.provider, trackers) : null;
  const extra = Array.isArray(tracker?.servers) ? tracker.servers : [];
  const found = trackers.find((each) => knownServers(each, each === named ? extra : []).some((name) => `mcp__${name}__` === server));
  if (found) return found;
  const listed = Array.isArray(tracker?.writeTools) && tracker.writeTools.some((pattern) => keyServer(pattern.replace(/\*$/u, 'x')) === server);
  return listed ? named : null;
}

// Why a session of a project run, or one no Human attends, may not call `tool` with `input`, as { match, reason }, or
// null. It never reads `tracker.enabled`: a working copy that turns the guard off turns none of this off. `writer` says
// who calls, as lib/project-report.mjs runWriter reads it from the session's unattended mark and the run's ledger:
//   { role: 'child', run, issue }   an issue's session: it writes only its own issue, by its key, through the
//                                   adapter's `run` tools and fields; a create, a UUID, or a tool with no issue field is refused;
//   { role: 'driver', run, owed }   the run's driver: it writes only what `aidrian project report` owes, each
//                                   [{ key, status, label, sha256 }]: the status and label as printed, and a comment
//                                   whose body has that sha256;
//   { role: 'unattended' }          a session no Human attends outside a run: only the merge rule below;
//   { role: 'held', why }           a session that cannot be told apart from one of these: every write refused.
// Every role is refused an adapter's `mergeVerbs` tool, since a merge goes only through pr-auto-merge. A write is a call
// that `writeTools`, the base branch's and the working copy's lists, or the adapter's own verbs on its server, match.
// `tracker` is the base branch's `tracker` key, or null; `rawTool` what the host sent, when it differs.
export function runWriteRefusal({ writer, tool, rawTool, input, tracker = null, writeTools = [], human = 'the Human', trackers = TRACKERS }) {
  if (!writer) return null;
  const kind = runCallKind({ tool, rawTool, tracker, writeTools, trackers });
  if (kind === null) return null;
  const { adapter, short } = kind;
  if (kind.merge) {
    return refused(`${short} merges code, and a session no Human attends merges only through the pr-auto-merge skill`, `Run \`aidrian pr auto-merge <number>\` through that skill, or leave the merge to ${human}`);
  }
  if (writer.role === 'unattended') return null;
  if (writer.role === 'held') return refused(writer.why, `Try again once the start that holds this session has settled, or tell ${human}`);
  const call = runCall(adapter, short, input);
  if (writer.role === 'child') return childRefusal(writer, call, adapter, short, human);
  if (writer.role === 'driver') return driverRefusal(writer, call, adapter, short, human);
  return null;
}

// What the run rule judges of the call of `tool`: { adapter, short, merge } for a tool that merges code or writes, or
// null for any other, which the rule lets run whoever calls. The hook asks it first, so a read reads no mark or ledger.
export function runCallKind({ tool, rawTool, tracker = null, writeTools = [], trackers = TRACKERS }) {
  if (typeof tool !== 'string') return null;
  const called = rawTool ? [tool, rawTool] : [tool];
  const adapter = trackerOfTool(tool, tracker, trackers);
  const server = serverPrefix(tool);
  const short = server === null ? tool : tool.slice(server.length);
  if (adapter && (adapter.mergeVerbs ?? []).some((verb) => nameMatches(verb, short))) return { adapter, short, merge: true };
  const patterns = [...writeTools, ...(adapter ? writeToolsOf(adapter, [server.slice('mcp__'.length, -2)]) : [])];
  return patterns.some((pattern) => called.some((name) => nameMatches(pattern, name))) ? { adapter, short, merge: false } : null;
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

function childRefusal(writer, call, adapter, short, human) {
  const own = `an issue's session of the run ${writer.run} writes only its own issue ${writer.issue}`;
  if (!call) return refused(`${short} is not a write the run's tools make, and ${own}`, `Write only through ${runTools(adapter)} ${writer.issue}, or put it in the result for ${human}`);
  const key = keyProblem(call, (key) => key === writer.issue);
  if (key) return refused(`${key}, and ${own}`, `Name ${writer.issue} in ${call.spec.key}, or put the write in the result for ${human}`);
  const allowed = call.kind === 'issue' ? [call.spec.key, call.spec.status, ...(call.spec.fields ?? [])] : [call.spec.key, call.spec.body];
  const extra = call.fields.find((field) => !allowed.includes(field));
  if (extra) return refused(`${short} sets ${extra}, which ${own} does not set`, `Set only ${allowed.join(', ')}, or put the rest in the result for ${human}`);
  return null;
}

function driverRefusal(writer, call, adapter, short, human) {
  const report = `\`aidrian project report ${writer.run}\``;
  const only = `the run ${writer.run}'s driver writes only what ${report} owes`;
  if (!call) return refused(`${short} is not a write the run's tools make, and ${only}`, `Write only through ${runTools(adapter)}, with the values ${report} printed`);
  const owed = (writer.owed ?? []).find((each) => each.key === call.key);
  const key = keyProblem(call, () => owed !== undefined);
  if (key) return refused(`${key}, and ${only}`, `Write only to an issue ${report} lists, by its key, or tell ${human}`);
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

const describeWanted = (wanted) => {
  const set = Object.entries(wanted).filter(([, value]) => value !== null);
  return set.length ? set.map(([field, value]) => `${field} ${JSON.stringify(value)}`).join(' and ') : 'nothing on the issue but its comment';
};
