// The tracker write guard's pure logic: reading a tool response for the connected workspace, and judging a write against
// `tracker` in config.json (docs/config.md#tracker). It touches no file and names no tracker: every tool, field, and
// value comes from the config, which config.mjs `checkTracker` has already validated.

import { tmpdir } from 'node:os';
import path from 'node:path';

import { nameMatches } from './agent-gates.mjs';
import { UNKNOWN_HOST } from './hosts/index.mjs';

// An issue key, <KEY>-<n>. The prefix follows config.mjs `teamKey`: no hyphen and no whitespace.
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
export function judgeTrackerWrite({ tracker, names }, tool, input, record, { skipMissingRecord = false } = {}) {
  if (tracker?.enabled !== true || typeof tool !== 'string') return null;
  if (!tracker.writeTools.some((pattern) => nameMatches(pattern, tool))) return null;
  return workspaceRefusal(tracker, tool, record, names.human, skipMissingRecord) ?? teamRefusal(tracker.team, input, names.human) ?? projectRefusal(tracker.project, input, names.human);
}

// The `mcp__<server>__` that starts a tool's name, or null when it has none. The server ends at the first double
// underscore, so a server such as plugin_a_b keeps its single underscores and a tool such as get__workspace its double
// ones. A server whose own name holds a double underscore reads as the part before it.
export const serverPrefix = (tool) => (typeof tool === 'string' ? (/^mcp__.+?__/u.exec(tool)?.[0] ?? null) : null);

// The refusal of a write on `server` with no read to count. Only one that a listed read clears is routine: the two cases no
// read clears, which config.mjs `checkTracker` reports, are a key to correct, and repeat until someone does.
function noReadRefusal(readTools, server, human) {
  const why = 'this session has not read the connected workspace';
  if (server === null) return refused(why, `tracker.writeTools names this tool with no server, so no read can clear it. Ask ${human} to correct that entry, and do not edit the key`);
  const reads = readTools.filter((name) => serverPrefix(name) === server);
  if (reads.length === 0) return refused(why, `Ask ${human} to add a read tool on this server to tracker.readTools, and do not edit the key`);
  return { ...refused(why, `Call ${reads.join(' or ')}, then write again`), routine: true };
}

function workspaceRefusal({ workspace, readTools }, tool, record, human, skipMissingRecord) {
  if (!workspace) return null;
  const server = serverPrefix(tool);
  if (server === null || serverPrefix(record?.tool) !== server) {
    if (skipMissingRecord) return null;
    return noReadRefusal(readTools, server, human);
  }
  const value = record.unreadable === true ? null : text(record.value);
  if (value === null) {
    return refused(`the read returned no ${workspace.field} (${record.tool})`, `Ask ${human} to fix the tracker connection or the key tracker.workspace.field`);
  }
  if (withoutTrailingSlash(value) === withoutTrailingSlash(workspace.expect)) return null;
  return refused(`the connected workspace is ${JSON.stringify(value)}, and tracker.workspace.expect is ${JSON.stringify(workspace.expect)}`, `Ask ${human} whether tracker.workspace.expect is wrong or the wrong workspace is connected, and do not edit the key`);
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
export function unlistedTool({ readTools, writeTools }, tool) {
  const server = serverPrefix(tool);
  if (server === null || readTools.includes(tool) || writeTools.some((pattern) => nameMatches(pattern, tool))) return false;
  if (READ_NAME.test(tool.slice(server.length))) return false;
  return [...readTools, ...writeTools].some((name) => serverPrefix(name) === server);
}

const withoutTrailingSlash = (value) => (value.endsWith('/') ? value.slice(0, -1) : value);

function teamRefusal(team, input, human) {
  if (!team) return null;
  for (const field of team.createFields) {
    const refusal = listRefusal({ field, value: input?.[field], allowed: team.values, key: 'tracker.team.values', human, teamKey: team.key });
    if (refusal) return refusal;
  }
  for (const field of team.keyFields) {
    const value = input?.[field];
    const prefix = typeof value === 'string' ? ISSUE_KEY.exec(value)?.[1] : undefined;
    if (prefix !== undefined && !sameKey(prefix, team.key)) {
      return refused(`${field} is ${JSON.stringify(value)}, whose prefix is not tracker.team.key ${JSON.stringify(team.key)}`, `Write to an issue of that team, pass the item's UUID when it is not an issue, or tell ${human} this write belongs elsewhere, and do not edit the key`);
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
