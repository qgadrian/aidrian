// What `aidrian check` says of a tracker write guard that is on and still cannot hold (docs/hooks.md#where-the-tracker-guard-is-verified):
// a route a host's or tracker's adapter says no hook reaches, a host whose hooks wait on a person, a host set up here whose guard
// nobody has verified, and a known connection the lists leave out on a host set up here. Each one is silent at run time, since a
// write that no hook judges passes. These are warnings: the guard is right to stay on for the hosts where it holds.
// Only `aidrian check` loads this for all hosts; the start hook asks for one host, so no other hook pays to read a host's files.

import { nameMatches } from './agent-gates.mjs';
import { detectHost, HOSTS, trackerGuards, UNKNOWN_HOST } from './hosts/index.mjs';
import { serversOn, TRACKERS, trackerById, trackerOfTools } from './trackers/index.mjs';

const PROBE = 'probe';
const covered = (writeTools, host, standard) => [standard, host.rawToolName(standard)].some((name) => writeTools.some((pattern) => nameMatches(pattern, name)));

// The tracker a loaded key belongs to: the one it names, or the one whose known servers its lists name.
const adapterOf = (tracker, trackers) => trackerById(tracker.provider, trackers) ?? trackerOfTools([...tracker.readTools, ...tracker.writeTools], trackers);

// The servers `adapter` knows on `host` that the loaded key leaves a write verb of, as { server, verbs }, in the host's spelling.
export function unwatchedOn(tracker, adapter, host) {
  const unwatched = [];
  for (const known of serversOn(adapter, host.id)) {
    const server = host.serverSpelling(known);
    const verbs = adapter.writeVerbs.filter((verb) => !covered(tracker.writeTools, host, `mcp__${server}__${verb.replace(/\*$/u, PROBE)}`));
    if (verbs.length) unwatched.push({ server, verbs });
  }
  return unwatched;
}

// A server the lists name, written in a form `host` does not send: nothing the lists hold matches what it does send.
function respelled(tracker, host) {
  const found = new Map();
  for (const pattern of tracker.writeTools) {
    const match = /^mcp__(.+?)__(.*)$/u.exec(pattern);
    if (!match) continue;
    const spelled = host.serverSpelling(match[1]);
    if (spelled !== match[1] && !covered(tracker.writeTools, host, `mcp__${spelled}__${match[2].replace(/\*$/u, PROBE)}`)) found.set(match[1], spelled);
  }
  return [...found];
}

// The one line the start hook prints when the host this session runs on reaches a known server the loaded key leaves out, or null.
export function unwatchedLine(tracker, host, trackers = TRACKERS) {
  if (tracker?.enabled !== true || host === UNKNOWN_HOST) return null;
  const adapter = adapterOf(tracker, trackers);
  if (!adapter) return null;
  const servers = unwatchedOn(tracker, adapter, host).map(({ server }) => server);
  if (!servers.length) return null;
  return `Tracker guard: on ${host.name}, tracker.writeTools leaves out ${adapter.name} tools on ${servers.join(', ')}, so a write through them passes unchecked. Tell the Human; aidrian check says the fix, and do not edit the key.`;
}

export function trackerWarnings(tracker, { env = process.env, hosts = HOSTS, trackers = TRACKERS } = {}) {
  if (tracker?.enabled !== true) return [];
  const warnings = [];
  // A host is known to be here when it runs this command or its adapter finds it set up.
  const here = new Set([detectHost({ env }, hosts).id]);
  for (const { host, verified, evidence, unguardedRoutes = [], hookTrust, trustStep, offStep } of trackerGuards(hosts)) {
    for (const { name, reason } of unguardedRoutes) {
      warnings.push(`tracker.enabled: on ${host.name}, a write through ${name} passes unchecked: ${reason}`);
    }
    const trust = hookTrust?.(env) ?? 'absent';
    if (trust !== 'absent') here.add(host.id);
    if (trust === 'off') {
      warnings.push(`tracker.enabled: ${host.name} has this plugin or its tracker hooks turned off, so each of its tracker writes passes unchecked until a person turns them on: ${offStep}`);
    }
    if (trust === 'untrusted') {
      warnings.push(`tracker.enabled: ${host.name} has no trust on record for this plugin's hooks, so each of its tracker writes passes unchecked until a person gives it: ${trustStep}`);
    }
    if (here.has(host.id) && verified === 'none') {
      warnings.push(`tracker.enabled: nobody has verified the guard on ${host.name}, so a write there may pass unchecked: ${evidence}`);
    }
  }
  const adapter = adapterOf(tracker, trackers);
  for (const { name, reason } of adapter?.unguardedRoutes ?? []) {
    warnings.push(`tracker.enabled: on ${adapter.name}, a write through ${name} passes unchecked: ${reason}`);
  }
  for (const host of hosts.filter((each) => here.has(each.id))) {
    for (const [written, spelled] of respelled(tracker, host)) {
      warnings.push(`tracker.writeTools: ${host.name} spells server ${JSON.stringify(written)} as ${JSON.stringify(spelled)}, and no pattern covers that, so a write through it passes unchecked; add its patterns and read tool in that spelling`);
    }
    if (!adapter) continue;
    for (const { server, verbs } of unwatchedOn(tracker, adapter, host)) {
      const fix = `set "provider": ${JSON.stringify(adapter.id)} and drop both tool lists, and raise "aidrian" under "requires" to this plugin's version, or add its patterns and read tool`;
      warnings.push(`tracker.writeTools: no pattern covers ${verbs.join(', ')} on ${adapter.name}'s server ${JSON.stringify(server)} on ${host.name}, so a write through it passes unchecked; ${fix}`);
    }
  }
  return warnings;
}
