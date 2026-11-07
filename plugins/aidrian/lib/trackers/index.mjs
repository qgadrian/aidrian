// The trackers the plugin knows, one adapter a file, and what turns a project's short `tracker` key into the lists the
// guard reads (docs/config.md#tracker). docs/providers/adding-a-host.md#adding-a-tracker says what an adapter declares;
// test/adapters.test.mjs checks each one. config.mjs loads this on every hook, so it stays small and reads no file.

import { serverSpellings } from '../hosts/index.mjs';
import linear from './linear.mjs';

export const TRACKERS = Object.freeze([linear]);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export const trackerById = (id, trackers = TRACKERS) => trackers.find((each) => each.id === id) ?? null;

// Every server name an adapter knows, on any host, in its own order, plus a project's own, as each host may spell it.
export const knownServers = (adapter, extra = []) => [...new Set([...Object.values(adapter.servers).flat(), ...extra].flatMap((server) => serverSpellings(server)))];

export const readToolsOf = (adapter, servers) => (adapter.readTool ? servers.map((server) => `mcp__${server}__${adapter.readTool}`) : []);
export const writeToolsOf = (adapter, servers) => servers.flatMap((server) => adapter.writeVerbs.map((verb) => `mcp__${server}__${verb}`));

// `value`, the file's `tracker` key, with what `adapter` knows filled in where the file says nothing. A list or field the
// file sets stays as written, so it overrides the adapter. `readTools` goes in only with a `workspace` to hold them to,
// since the key pairs the two; each group is left out when unset, so a project's choice to leave one out stands.
// A tracker whose writes each name their workspace needs no read: `workspaceInput` is that field, judged on the call itself.
// Each of those a file sets stays as written. A team named only by its key may be written by that key alone, since the guard takes the key as a value anyway.
export function expandTracker(value, adapter) {
  const servers = knownServers(adapter, Array.isArray(value.servers) ? value.servers : []);
  const expanded = { ...value };
  if (value.writeTools === undefined) expanded.writeTools = writeToolsOf(adapter, servers);
  if (isObject(value.workspace)) {
    // A value that is no text is config-merge.mjs checkTracker's error, and must not turn a tracker with a read into one with none.
    const written = typeof value.workspaceInput === 'string' && value.workspaceInput.trim() !== '' ? value.workspaceInput : undefined;
    const input = written ?? adapter.workspaceInput;
    const field = input ?? adapter.workspaceField;
    expanded.workspace = { ...(field ? { field } : {}), ...value.workspace };
    if (input) expanded.workspaceInput = written ?? expanded.workspace.field;
    else if (value.readTools === undefined) expanded.readTools = readToolsOf(adapter, servers);
  }
  if (isObject(value.team)) expanded.team = { ...(typeof value.team.key === 'string' ? { values: [value.team.key] } : {}), ...adapter.team, ...value.team };
  if (isObject(value.project)) expanded.project = { ...adapter.project, ...value.project };
  if (value.idHint === undefined && adapter.idHint) expanded.idHint = adapter.idHint;
  if (value.readVerbs === undefined && adapter.readVerbs) expanded.readVerbs = adapter.readVerbs;
  return expanded;
}

// The adapter whose known servers a project's lists name, for a key written out with no `provider`, or null.
export function trackerOfTools(names, trackers = TRACKERS) {
  const servers = new Set(names.map((name) => /^mcp__(.+?)__/u.exec(name)?.[1]).filter(Boolean));
  return trackers.find((each) => knownServers(each).some((server) => servers.has(server))) ?? null;
}

// The server names `adapter` knows on one host, as written: those it lists for every host, then that host's own.
export const serversOn = (adapter, hostId) => [...new Set([...(adapter.servers.any ?? []), ...(adapter.servers[hostId] ?? [])])];
