// The tracker write guard's pure logic: reading a tool response for the connected workspace, and judging a write against
// `tracker` in config.json (docs/config.md#tracker). It touches no file and names no tracker: every tool, field, and
// value comes from the config, which config.mjs `checkTracker` has already validated.

import { nameMatches } from './agent-gates.mjs';
import { isObject } from './fs.mjs';

// An issue key, <KEY>-<n>. The prefix follows config.mjs `teamKey`: no hyphen and no whitespace.
const ISSUE_KEY = /^([^\s-]+)-\d+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// The value of `field` in a tool's `tool_response`, or null when it gives none, which is an unreadable read. The response
// is an object, a JSON string, a content-block array, or `{content: [...]}`, as Codex sends it. The field of an object wins
// over its blocks; otherwise the first text block holding JSON is the one read.
export function readTrackerValue(response, field) {
  const parsed = typeof response === 'string' ? parseJson(response) : response;
  const direct = isObject(parsed) ? text(parsed[field]) : null;
  if (direct !== null) return direct;
  const held = firstJsonBlock(Array.isArray(parsed) ? parsed : parsed?.content);
  return isObject(held) ? text(held[field]) : null;
}

function firstJsonBlock(blocks) {
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
      const json = parseJson(block.text);
      if (json !== undefined) return json;
    }
  }
  return undefined;
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

// Why the call of `tool` with `input` may not run, as { match, reason } the way agent-gates.mjs gateDenial gives it, or
// null when it may. `record` is the session's read of the workspace, { value, unreadable, tool, at }, or null when it has
// none. Only a tool in `tracker.writeTools` is judged, and only while `tracker.enabled` is true. A caller that has no
// session to hold a record passes `skipMissingRecord`.
export function judgeTrackerWrite({ tracker, names }, tool, input, record, { skipMissingRecord = false } = {}) {
  if (tracker?.enabled !== true || typeof tool !== 'string') return null;
  if (!tracker.writeTools.some((pattern) => nameMatches(pattern, tool))) return null;
  return workspaceRefusal(tracker, record, names.human, skipMissingRecord) ?? teamRefusal(tracker.team, input, names.human) ?? projectRefusal(tracker.project, input, names.human);
}

function workspaceRefusal({ workspace, readTools }, record, human, skipMissingRecord) {
  if (!workspace) return null;
  const reads = readTools.join(' or ');
  if (record === null || record === undefined) {
    if (skipMissingRecord) return null;
    return refused('this session has not read the connected workspace', `Call ${reads}, then write again`);
  }
  const value = record.unreadable === true ? null : text(record.value);
  if (value === null) {
    const read = text(record.tool) ?? reads;
    return refused(`the read returned no ${workspace.field} (${read})`, `Ask ${human} to fix the tracker connection or the key tracker.workspace.field`);
  }
  if (withoutTrailingSlash(value) === withoutTrailingSlash(workspace.expect)) return null;
  return refused(`the connected workspace is ${JSON.stringify(value)}, and tracker.workspace.expect is ${JSON.stringify(workspace.expect)}`, `Ask ${human} to connect the right workspace or change the key`);
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
      return refused(`${field} is ${JSON.stringify(value)}, whose prefix is not tracker.team.key ${JSON.stringify(team.key)}`, `Write to an issue of that team, pass the item's UUID when it is not an issue, or tell ${human} this write belongs elsewhere`);
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
  return refused(`${field} ${Array.isArray(value) ? 'has' : 'is'} ${JSON.stringify(wrong[0])}, and ${key} allows ${listed}`, `Use ${use}, or tell ${human} this write belongs elsewhere`);
}

// `match` is the cause alone, with its values, for the deny row, which keeps 120 characters (dispatch-rows.mjs);
// `reason` tells the agent that cause and what to do.
const refused = (why, next) => ({ match: why, reason: `aidrian: this tracker write is refused because ${why}. ${next}.` });
