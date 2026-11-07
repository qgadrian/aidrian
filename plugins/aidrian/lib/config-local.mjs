// The local file's settings that a team's committed value caps: `decisions`, and the machine's auto-merge switch.

import { merge } from './config-merge.mjs';
import { DECISIONS_SCHEMA, LOCAL_DECISIONS_SCHEMA } from './config-schema.mjs';
import { lowerMode } from './decisions.mjs';
import { isObject } from './fs.mjs';

// `team`, the `decisions` of config.json, with the local file's `decisions` over it, as `project.localDecisions` holds
// it. The local file may set `mode` and `domains`, each held to the team's `maxMode`; `unreviewed.remind`; and
// `unreviewed.pauseDomainAt`, of which only a value lower than the team's applies, one limit at a time. Any other key
// is an error, and keeps the team's value. A key the local file does not set stays as the team wrote it, even above
// `maxMode`, so the resolver and `aidrian check` can say so. `errors` gets the problems; a caller that already reported
// them passes [].
export function localDecisions(team, project, errors) {
  const local = project.localDecisions;
  const file = project.paths.local;
  if (local === undefined) return team;
  if (!isObject(local)) {
    errors.push(`${file}: "decisions" must be an object`);
    return team;
  }
  const teamOnly = (key) => Object.hasOwn(DECISIONS_SCHEMA, key) && !Object.hasOwn(LOCAL_DECISIONS_SCHEMA, key);
  for (const key of Object.keys(local).filter(teamOnly)) errors.push(`${file}: "decisions.${key}" is the team's: set it in config.json`);
  const own = Object.fromEntries(Object.entries(local).filter(([key]) => !teamOnly(key)));
  const read = merge(LOCAL_DECISIONS_SCHEMA, team, own, 'decisions.', file, errors);
  // `merge` keeps the team's value for a key that is unset or refused, so `read` holds the local value only when `set` is it.
  const capped = (set, mode) => (set !== mode || mode === 'inherit' ? mode : lowerMode(mode, team.maxMode));
  return {
    ...team,
    mode: capped(own.mode, read.mode),
    domains: Object.fromEntries(Object.entries(read.domains).map(([domain, mode]) => [domain, capped(own.domains?.[domain], mode)])),
    unreviewed: { remind: read.unreviewed.remind, pauseDomainAt: lowerPause(team.unreviewed.pauseDomainAt, read.unreviewed.pauseDomainAt) },
  };
}

// The pause limits a local value may set over the team's: each limit the lower of the two; a null team value has no
// limits, so any local one is lower, and a null local value raises nothing.
function lowerPause(team, local) {
  if (local === null || local === team) return team;
  if (team === null) return local;
  return { pending: Math.min(team.pending, local.pending), oldestDays: Math.min(team.oldestDays, local.oldestDays) };
}

// Whether auto-merge is on, from a `github` config and the local file's switch (`project.localAutoMerge`, "on",
// "off", or "unset"): { effective, reason }. It is on only when the team allows it and the machine's switch is "on", or
// is "unset" under the team's `default` "on". A machine can lower the team's choice but never pass `allow`. `reason` names the
// side that keeps it off, "team" or "local", and is null when it is on. A pure function of its inputs, so a caller may
// pass the github config of any commit, such as committedConfig's, instead of the working copy's.
export function resolveAutoMerge(github, local) {
  if (github?.autoMerge?.allow !== true) return { effective: false, reason: 'team' };
  const on = local === 'on' || (local === 'unset' && github.autoMerge.default === 'on');
  if (!on) return { effective: false, reason: 'local' };
  return { effective: true, reason: null };
}
