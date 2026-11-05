// The trackers the plugin knows, one adapter a file, and what turns a project's short `tracker` key into the lists the
// guard reads (docs/config.md#tracker). docs/providers/adding-a-host.md#adding-a-tracker says what an adapter declares;
// test/adapters.test.mjs checks each one. config.mjs loads this on every hook, so it stays small and reads no file.

import { normalizeHookInput, serverSpellings } from '../hosts/index.mjs';
import linear from './linear.mjs';

export const TRACKERS = Object.freeze([linear]);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export const trackerById = (id, trackers = TRACKERS) => trackers.find((each) => each.id === id) ?? null;

// Every server name an adapter knows, on any host, in its own order, plus a project's own, as each host may spell it.
export const knownServers = (adapter, extra = []) => [...new Set([...Object.values(adapter.servers).flat(), ...extra].flatMap((server) => serverSpellings(server)))];

// The server names of every tracker, for a host whose tool names do not say where the server ends.
export const allTrackerServers = (trackers = TRACKERS) => trackers.flatMap((adapter) => knownServers(adapter));

// A hook's payload read again with the project's own `tracker.servers`, which only a loaded config knows.
export const withProjectServers = (input, tracker, env = process.env, hosts) => (tracker.servers
  ? normalizeHookInput(input, env, [...allTrackerServers(), ...tracker.servers.flatMap((server) => serverSpellings(server))], hosts)
  : input);

export const readToolsOf = (adapter, servers) => (adapter.readTool ? servers.map((server) => `mcp__${server}__${adapter.readTool}`) : []);
export const writeToolsOf = (adapter, servers) => servers.flatMap((server) => adapter.writeVerbs.map((verb) => `mcp__${server}__${verb}`));

// `value`, the file's `tracker` key, with what `adapter` knows filled in where the file says nothing. A list or field the
// file sets stays as written, so it overrides the adapter. `readTools` goes in only with a `workspace` to hold them to,
// since the key pairs the two; each group is left out when unset, so a project's choice to leave one out stands.
export function expandTracker(value, adapter) {
  const servers = knownServers(adapter, Array.isArray(value.servers) ? value.servers : []);
  const expanded = { ...value };
  if (value.writeTools === undefined) expanded.writeTools = writeToolsOf(adapter, servers);
  if (isObject(value.workspace)) {
    expanded.workspace = { field: adapter.workspaceField, ...value.workspace };
    if (value.readTools === undefined) expanded.readTools = readToolsOf(adapter, servers);
  }
  if (isObject(value.team)) expanded.team = { ...adapter.team, ...value.team };
  if (isObject(value.project)) expanded.project = { ...adapter.project, ...value.project };
  return expanded;
}

// The adapter whose known servers a project's lists name, for a key written out with no `provider`, or null.
export function trackerOfTools(names, trackers = TRACKERS) {
  const servers = new Set(names.map((name) => /^mcp__(.+?)__/u.exec(name)?.[1]).filter(Boolean));
  return trackers.find((each) => knownServers(each).some((server) => servers.has(server))) ?? null;
}

// The server names `adapter` knows on one host, as written: those it lists for every host, then that host's own.
export const serversOn = (adapter, hostId) => [...new Set([...(adapter.servers.any ?? []), ...(adapter.servers[hostId] ?? [])])];
