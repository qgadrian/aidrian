// What `aidrian check` says of a tracker write guard that is on and still cannot hold (docs/hooks.md#where-the-tracker-guard-is-verified):
// a route a host's adapter says no hook reaches, a host whose hooks wait on a person's trust, and a known connection the
// lists leave out on a host set up here. Each one is silent at run time, since a write that no hook judges passes. These are warnings: the
// guard is right to stay on for the hosts where it holds. Only `aidrian check` loads this, so no hook pays to read a host's files.

import { nameMatches } from './agent-gates.mjs';
import { HOSTS, trackerGuards } from './hosts/index.mjs';
import { TRACKERS, trackerById, trackerOfTools, unwatchedServers } from './trackers/index.mjs';

export function trackerWarnings(tracker, { env = process.env, hosts = HOSTS, trackers = TRACKERS } = {}) {
  if (tracker?.enabled !== true) return [];
  const warnings = [];
  const here = new Set();
  for (const { host, unguardedRoutes = [], hookTrust, trustStep } of trackerGuards(hosts)) {
    for (const { name, reason } of unguardedRoutes) {
      warnings.push(`tracker.enabled: on ${host.name}, a write through ${name} passes unchecked: ${reason}`);
    }
    const trust = hookTrust?.(env) ?? 'absent';
    if (trust !== 'absent') here.add(host.id);
    if (trust === 'untrusted') {
      warnings.push(`tracker.enabled: ${host.name} has no trust on record for this plugin's hooks, so each of its tracker writes passes unchecked until a person gives it: ${trustStep}`);
    }
  }
  const adapter = trackerById(tracker.provider, trackers) ?? trackerOfTools([...tracker.readTools, ...tracker.writeTools], trackers);
  if (!adapter) return warnings;
  // Only a host known to be set up here: a project's lists may leave out a spelling it has no connection under, on purpose.
  for (const { server, hosts: on } of unwatchedServers(adapter, tracker.writeTools, nameMatches)) {
    const named = hosts.filter((host) => here.has(host.id) && on.includes(host.id)).map((host) => host.name);
    if (named.length === 0) continue;
    warnings.push(`tracker.writeTools: no pattern covers ${adapter.name}'s server ${JSON.stringify(server)} on ${named.join(', ')}, so a write through it passes unchecked; set "provider": ${JSON.stringify(adapter.id)} and drop both tool lists, or add its patterns and read tool`);
  }
  return warnings;
}
