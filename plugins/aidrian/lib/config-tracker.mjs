// The checks of `tracker` that need no other key: its `provider` and `servers`, and each tool name or pattern of its lists.
// config-merge.mjs checkTracker puts them together.

import { nameMatches, patternProblem } from './agent-gates.mjs';
import { SERVER_NAME } from './config-schema.mjs';
import { oneOf } from './config-types.mjs';
import { hookForms, reachesAHook, UNKNOWN_HOST } from './hosts/index.mjs';
import { keyServer } from './tracker-guard.mjs';
import { knownServers, TRACKERS, trackerById } from './trackers/index.mjs';

// The adapter `tracker.provider` names, null when the key sets none, or undefined when it names none we have, whose error
// is the only one the key raises: nothing else in it can be judged without knowing the tracker.
export function checkTrackerProvider(value, file, errors) {
  if (value.provider === undefined) {
    if (value.servers !== undefined) errors.push(`${file}: "tracker.servers" needs "tracker.provider", the tracker those servers connect to`);
    return null;
  }
  const adapter = trackerById(value.provider);
  if (!adapter) {
    errors.push(`${file}: "tracker.provider" must be ${oneOfTrackers()}`);
    return undefined;
  }
  const named = value.servers ?? [];
  if (!Array.isArray(named) || !named.every((each) => typeof each === 'string' && SERVER_NAME.test(each))) {
    errors.push(`${file}: "tracker.servers" must be a list of server names, such as "my-linear" in mcp__my-linear__save_issue`);
    return undefined;
  }
  // The file's list replaces the adapter's, which is what `servers` adds to, so the server would go unwatched with no word.
  if (value.writeTools !== undefined) {
    for (const server of named) errors.push(`${file}: "tracker.servers" has ${JSON.stringify(server)}, but "tracker.writeTools" replaces the list it adds to, so no write on it is watched: add its patterns there, or drop "tracker.writeTools"`);
  }
  return adapter;
}

const oneOfTrackers = () => (TRACKERS.length === 1 ? JSON.stringify(TRACKERS[0].id) : oneOf(TRACKERS.map((each) => each.id)));

// Why `pattern` cannot name a tracker tool, or null. The guard's hooks match only MCP calls, so "*" or Bash(...) would
// pass the check of `agents` patterns and never fire.
export function trackerToolProblem(pattern) {
  if (typeof pattern === 'string' && pattern !== '' && !pattern.startsWith('mcp__')) return 'a tracker tool is an MCP tool, so its pattern starts with "mcp__"';
  return patternProblem(pattern);
}

// Why `name` cannot be a read tool, or null. A read names one tool, and a write pattern that covers it would refuse the
// read the workspace check asks for, so no write could ever pass. The `*` check comes first, since patternProblem's
// answer to a mid-name `*` would suggest a trailing one.
export function readToolProblem(name, writeTools) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return trackerToolProblem(name);
  if (name.includes('*')) return 'a read tool is an exact tool name, with no "*"';
  const problem = patternProblem(name);
  if (problem) return problem;
  const covering = writeTools.find((pattern) => nameMatches(pattern, name));
  return covering === undefined ? null : coveredProblem(covering);
}

const coveredProblem = (pattern) => `a read tool cannot also match "tracker.writeTools", and ${JSON.stringify(pattern)} covers it`;

// What is wrong with a read tool that stays in the list. This is a report only, as unclearedWriteProblem is: leaving it out would
// unset `workspace` for every host, and the guard that keeps it refuses writes on that server, which is the safe way to be wrong.
export function readToolReport(name, writeTools) {
  if (!reachesAHook(name)) {
    // Where a flat name's connector ends cannot be told from it, so the name to use is given only for a server a tracker knows.
    const standard = UNKNOWN_HOST.toolName(name);
    const known = TRACKERS.some((tracker) => knownServers(tracker).some((server) => keyServer(standard) === `mcp__${server}__`));
    return `no host sends this name, which is the form only a model sees, so no read would ever count${known ? `; name it as ${JSON.stringify(standard)}` : ''}`;
  }
  const covering = writeTools.find((pattern) => hookForms(name).some((form) => nameMatches(pattern, form)));
  return covering === undefined ? null : coveredProblem(covering);
}

// Why no call a hook sees can match `pattern`, or null. A pattern ending in `*` is tried on a name it would match: it can match
// a call when the standard or raw form of that name still starts with the pattern's stem. This is a report only, and it matters
// because a pattern that matches nothing lets every write run unjudged.
export function unreachableWriteProblem(pattern) {
  const stem = pattern.endsWith('*') ? pattern.slice(0, -1) : null;
  const reaches = stem === null ? reachesAHook(pattern) : hookForms(`${stem}x`).some((form) => form.startsWith(stem));
  return reaches ? null : 'no host sends a name this matches, as it is the form only a model sees, so a write it means runs unjudged, unless it names a connector whose own name holds an underscore';
}

// Why no read could ever clear a write on `pattern`, as the guard counts a read only on the write's server, or null.
// This is a report only: the entry stays, and the guard refuses those writes. A "*" before the server's name ends can match
// a server that has a read tool, so it is not judged.
export function unclearedWriteProblem(pattern, readTools) {
  const star = pattern.endsWith('*');
  const server = keyServer(star ? pattern.slice(0, -1) : pattern);
  if (server === null) return star ? null : 'it names no server, as in mcp__<server>__<tool>, so no read can clear it';
  return readTools.some((name) => keyServer(name) === server) ? null : 'no tool in "tracker.readTools" is on its server, so no read can clear it';
}

// The good entries of one tool list of `tracker`; a bad one is an error and is left out, as in `agents`.
export function checkToolList(name, noun, value, problemOf, file, errors) {
  if (value === undefined) return [];
  const at = `tracker.${name}`;
  if (!Array.isArray(value)) {
    errors.push(`${file}: "${at}" must be a list of tool ${noun}`);
    return [];
  }
  return value.filter((entry) => {
    const bad = problemOf(entry);
    if (bad) errors.push(`${file}: "${at}" has ${JSON.stringify(entry)}: ${bad}`);
    return !bad;
  });
}
