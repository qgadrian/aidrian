// The local file's settings that a team's committed value caps: `decisions`, and the machine's auto-merge and
// unattended switches.

import { merge } from './config-merge.mjs';
import { DECISIONS_SCHEMA, LOCAL_DECISIONS_SCHEMA } from './config-schema.mjs';
import { lowerMode } from './decisions.mjs';
import { isObject, knownFields } from './fs.mjs';
// A cycle: project.mjs imports config.mjs, which re-exports this file. It is benign while each uses the other's exports
// only inside functions.
import { mayFollowTeamDefault } from './project.mjs';
import { PUBLISH_DEFAULTS } from './review/config.mjs';

// `messages`, the errors of the local settings file `file`, split into { errors, warnings }: an unknown key, top-level or
// nested (fs.mjs knownFields), and an unknown agent in `models`, are warnings, and ignored, unless the message is one of
// `kept`, such as a gate error (checkAgents). The file is per machine and git-ignored, written once for the newest
// plugin while older ones still run on the same machine, so a key a newer release reads must not fail an older one's
// check (docs/config.md#plugin-version).
export function splitUnknownKeys(messages, file, kept = new Set()) {
  const unknown = (message) => (message.startsWith(`${file}: unknown key "`) || message.startsWith(`${file}: unknown agent "`)) && !kept.has(message);
  return { errors: messages.filter((message) => !unknown(message)), warnings: messages.filter(unknown) };
}

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
  // A pause limit is read whole, so a field a newer release adds to it is an unknown key here, never a bad limit; config.json keeps it strict.
  const pause = isObject(own.unreviewed) ? own.unreviewed.pauseDomainAt : undefined;
  if (isObject(pause)) own.unreviewed = { ...own.unreviewed, pauseDomainAt: knownFields(pause, ['pending', 'oldestDays'], 'decisions.unreviewed.pauseDomainAt', file, errors) };
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

// One unattended machine switch, `github.unattendedWaiver`, `unattendedSignoff`, or `handoff.background`, as the local
// file sets it (`local`: "on", "off", or "unset", project.mjs), with the base branch's `solo` for a machine that sets
// nothing: "on" when `local` is "unset", `solo` says true, and git says it tracks no local file in the main checkout
// (mayFollowTeamDefault), as auto-merge's team default is followed; "off" when solo says true but the file is tracked;
// else `local` as it is. A local "off", or a file that is broken or tracked, which reads "off" (project.mjs
// machineSwitches), always wins. `solo` is a boolean or a function that reads it, called only for an unset switch, so a
// caller pays for its reads only then; it must read the base branch only, never the working copy (lib/solo.mjs). The
// team's own key for the switch still decides apart from this: solo replaces the machine's word alone. `mayFollow` is
// mayFollowTeamDefault's answer when the caller read it already, as the merge guard does inside its deadline.
export function machineSwitch(local, solo, project, mayFollow = () => mayFollowTeamDefault(project)) {
  if (local !== 'unset') return local;
  const on = (typeof solo === 'function' ? solo() : solo) === true;
  if (!on) return 'unset';
  return (typeof mayFollow === 'function' ? mayFollow() : mayFollow) === true ? 'on' : 'off';
}

// Whether the merge guard may take a recorded judge verdict (`aidrian pr waive`) in place of the Human's answer, from a
// `github` config and the machine's switch: { effective, reason }, as resolveAutoMerge. `local` is
// `project.localUnattendedWaiver`, or machineSwitch's answer for it under the base branch's `solo`; "unset" is off.
// `reason` is "team" or "local", null when it is on.
export function resolveUnattendedWaiver(github, local) {
  if (github?.unattendedWaiver?.allow !== true) return { effective: false, reason: 'team' };
  if (local !== 'on') return { effective: false, reason: 'local' };
  return { effective: true, reason: null };
}

// `review.publish` in force: the team's, from the base branch's config.json, with what the local file may set over it
// (R10): `summary` "counts" and `inline` false, which only ever post less. Any other local key or value is an error
// (review/config.mjs checkLocalReview), and the team's value stays. With no team value, the defaults.
export function resolvePublish(team, local) {
  const out = { ...PUBLISH_DEFAULTS, ...(isObject(team) ? team : {}) };
  if (!isObject(local)) return out;
  if (local.summary === 'counts') out.summary = 'counts';
  if (local.inline === false) out.inline = false;
  return out;
}

// The longest keychain service or account name the local file may give, and what neither may hold.
const KEYCHAIN_NAME_MAX = 255;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

// The local file's `projectRun.forgeTokenKeychain`, `{ service, account }`: the macOS keychain entry the driver reads a
// project run's forge token from, before the forge CLI's own login (lib/project-token.mjs). Null when unset. `projectRun`
// is an object, and the entry a non-empty `service` and `account`, each text with no control character. Any other field
// of either is an unknown key in `errors`, which the local file reads as a warning (knownFields); anything else is an
// error there, named for the local file `file`, and reads null, so the next source gives it.
export function localForgeTokenKeychain(raw, errors, file = 'the local file') {
  if (!isObject(raw) || !Object.hasOwn(raw, 'projectRun')) return null;
  const given = isObject(raw.projectRun) ? knownFields(raw.projectRun, ['forgeTokenKeychain'], 'projectRun', file, errors) : null;
  if (given && !Object.hasOwn(given, 'forgeTokenKeychain')) return null;
  const entry = isObject(given?.forgeTokenKeychain) ? knownFields(given.forgeTokenKeychain, ['service', 'account'], 'projectRun.forgeTokenKeychain', file, errors) : null;
  const name = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= KEYCHAIN_NAME_MAX && !CONTROL.test(value);
  if (entry && name(entry.service) && name(entry.account)) return { service: entry.service, account: entry.account };
  errors.push(`${file}: "projectRun" must be { "forgeTokenKeychain": { "service": "<name>", "account": "<name>" } }, each name text of at most ${KEYCHAIN_NAME_MAX} characters`);
  return null;
}
