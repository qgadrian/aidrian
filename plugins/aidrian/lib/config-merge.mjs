// Reads one file's values over the defaults, key by key, by config-schema.mjs: a value that fails its check is an error
// and keeps the default. `models`, `agents`, and `tracker` have checks of their own here.

import { agentNameProblem, patternProblem } from './agent-gates.mjs';
import { pluginAgents } from './config.mjs';
import { HANDOFF_MODES, MODEL_CHOICES, REMOVED, RENAMED, TRACKER_GROUPS, TRACKER_SHORT_KEYS } from './config-schema.mjs';
import { checkToolList, checkTrackerProvider, readToolProblem, readToolReport, trackerToolProblem, unclearedWriteProblem, unreachableWriteProblem } from './config-tracker.mjs';
import { isText, isTexts, oneOf, TYPES } from './config-types.mjs';
import { isObject } from './fs.mjs';
import { checkReview } from './review/config.mjs';
import { serverPrefix } from './tracker-guard.mjs';
import { expandTracker } from './trackers/index.mjs';

// The values with a string `session.handoff`, the mode it held before the handoff settings became a group, read as
// `{ mode }`, so a legacy "off" keeps the hooks quiet. The old shape is reported. This is no RENAMED entry: that flags
// a key by its name, and the new group has the same name.
export function legacyHandoff(values, file, errors) {
  const handoff = isObject(values.session) ? values.session.handoff : undefined;
  if (!HANDOFF_MODES.includes(handoff)) return values;
  errors.push(`${file}: "session.handoff" is now "session.handoff.mode": move it`);
  return { ...values, session: { ...values.session, handoff: { mode: handoff } } };
}

export function merge(schema, defaults, values, prefix, file, errors, gateErrors = []) {
  for (const key of Object.keys(values)) {
    const name = `${prefix}${key}`;
    if (Object.hasOwn(RENAMED, name)) errors.push(`${file}: "${name}" is now "${RENAMED[name]}": rename the key`);
    else if (Object.hasOwn(REMOVED, name)) errors.push(`${file}: "${name}" is gone: ${REMOVED[name]}; delete the key`);
    else if (!Object.hasOwn(schema, key)) errors.push(`${file}: unknown key "${name}"`);
  }
  const out = {};
  for (const [key, type] of Object.entries(schema)) {
    const value = values[key];
    out[key] = defaults[key];
    if (!Object.hasOwn(values, key)) continue;
    if (typeof type === 'object') {
      if (isObject(value)) out[key] = merge(type, defaults[key], value, `${prefix}${key}.`, file, errors, gateErrors);
      else errors.push(`${file}: "${prefix}${key}" must be an object`);
    } else if (type === 'models') {
      out[key] = checkModels(value, file, errors, defaults[key]);
    } else if (type === 'review') {
      out[key] = checkReview(value, file, errors);
    } else if (type === 'agents') {
      out[key] = checkAgents(value, file, errors, defaults[key], gateErrors);
    } else if (type === 'tracker') {
      out[key] = checkTracker(value, file, errors, defaults[key]);
    } else if (TYPES[type][0](value, values)) {
      out[key] = value;
    } else {
      const must = TYPES[type][1];
      errors.push(`${file}: "${prefix}${key}" must be ${typeof must === 'function' ? must() : must}`);
    }
  }
  return out;
}

// `models` from one file over `base`, per host, agent, and field: { claude: { agents }, codex: { agents } }.
// A bad host, agent, or value is an error and is left out, so the rest still applies.
export function checkModels(value, file, errors, base) {
  const out = Object.fromEntries(Object.keys(MODEL_CHOICES).map((host) => [host, { agents: { ...base[host].agents } }]));
  if (!isObject(value)) {
    errors.push(`${file}: "models" must be an object`);
    return out;
  }
  for (const [host, groups] of Object.entries(value)) {
    const at = `models.${host}`;
    if (!Object.hasOwn(MODEL_CHOICES, host)) errors.push(`${file}: unknown key "${at}"`);
    else if (!isObject(groups)) errors.push(`${file}: "${at}" must be an object`);
    else {
      for (const [key, agents] of Object.entries(groups)) {
        if (key === 'skills') errors.push(`${file}: "${at}.skills" is not supported: neither host lets a project set a plugin skill's model or effort`);
        else if (key !== 'agents') errors.push(`${file}: unknown key "${at}.${key}"`);
        else if (!isObject(agents)) errors.push(`${file}: "${at}.agents" must be an object`);
        else for (const [name, choice] of Object.entries(agents)) checkAgentChoice(host, name, choice, out[host].agents, file, errors);
      }
    }
  }
  return out;
}

function checkAgentChoice(host, name, choice, agents, file, errors) {
  const at = `models.${host}.agents.${name}`;
  if (!pluginAgents().includes(name)) {
    errors.push(`${file}: unknown agent "${at}"; the plugin's agents are ${pluginAgents().join(', ')}`);
    return;
  }
  if (!isObject(choice)) {
    errors.push(`${file}: "${at}" must be an object with "model", "effort", or both`);
    return;
  }
  const kept = {};
  for (const [field, setting] of Object.entries(choice)) {
    const allowed = Object.hasOwn(MODEL_CHOICES[host], field) ? MODEL_CHOICES[host][field] : undefined;
    if (allowed === undefined) errors.push(`${file}: unknown key "${at}.${field}"`);
    else if (allowed === null ? isText(setting) : allowed.includes(setting)) kept[field] = setting;
    else errors.push(`${file}: "${at}.${field}" must be ${allowed === null ? 'a non-empty string' : oneOf(allowed)}`);
  }
  if (Object.keys(kept).length) agents[name] = { ...agents[name], ...kept };
}

// `agents` from one file over `base`, per agent and list: { <name>: { deny, allow } }, each a list of tool patterns.
// A file's `deny` or `allow` for an agent replaces the one below it. A bad name, key, or pattern is an error and is left
// out, so the rest still applies; a pattern left out of `allow` only makes the list stricter. Every other error drops
// a gate (`"allow": "Read"` would allow every tool, `"Deny"` lifts the deny list), so it also goes to `gateErrors`.
export function checkAgents(value, file, errors, base, gateErrors = []) {
  const out = { ...base };
  const lost = (problem) => {
    errors.push(`${file}: ${problem}`);
    gateErrors.push({ file, problem });
  };
  if (!isObject(value)) {
    lost('"agents" must be an object');
    return out;
  }
  for (const [name, gates] of Object.entries(value)) {
    const at = `agents.${name}`;
    const problem = agentNameProblem(name);
    if (problem) lost(`"${at}": ${problem}`);
    else if (!isObject(gates)) lost(`"${at}" must be an object with "deny", "allow", or both`);
    else {
      const kept = {};
      for (const [list, patterns] of Object.entries(gates)) {
        if (list !== 'deny' && list !== 'allow') lost(`unknown key "${at}.${list}"`);
        else if (!Array.isArray(patterns)) lost(`"${at}.${list}" must be a list of tool patterns`);
        else {
          kept[list] = patterns.filter((pattern) => {
            const bad = patternProblem(pattern);
            if (!bad) return true;
            const message = `"${at}.${list}" has ${JSON.stringify(pattern)}: ${bad}`;
            if (list === 'deny') lost(message);
            else errors.push(`${file}: ${message}`);
            return false;
          });
        }
      }
      if (Object.keys(kept).length) out[name] = { ...out[name], ...kept };
    }
  }
  return out;
}

// `tracker` from config.json over its defaults. The result never holds what a hook cannot act on: a group with any error
// is unset, `workspace` and `readTools` are both set or both empty, and both go when any read tool has an error, and
// `enabled` needs a write tool to watch and a group to hold it to.
// A pairing error reads what the file set, and only a key of the right type counts as set or unset, so a key that has its
// own error raises no second one, about itself or about what depends on it.
// `provider` names a tracker adapter (lib/trackers/), which fills in the lists and fields the file leaves out, and a list
// or field the file sets overrides it. A key with no `provider` holds every list itself, as it always has.
function checkTracker(raw, file, errors, defaults) {
  if (!isObject(raw)) {
    errors.push(`${file}: "tracker" must be an object`);
    return defaults;
  }
  const provided = checkTrackerProvider(raw, file, errors);
  if (provided === undefined && raw.writeTools === undefined) return defaults;
  const value = provided ? expandTracker(raw, provided) : raw;
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key) && !TRACKER_SHORT_KEYS.includes(key)) errors.push(`${file}: unknown key "tracker.${key}"`);
  for (const key of ['workspaceInput', 'idHint']) if (raw[key] !== undefined && !isText(raw[key])) errors.push(`${file}: "tracker.${key}" must be a non-empty string`);
  if (raw.readVerbs !== undefined && !isTexts(raw.readVerbs)) errors.push(`${file}: "tracker.readVerbs" must be a list of tool patterns after the server`);
  const perCall = isText(value.workspaceInput);
  if (Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean') errors.push(`${file}: "tracker.enabled" must be ${TYPES.boolean[1]}`);
  const workspace = checkTrackerGroup('workspace', value.workspace, file, errors);
  const writeTools = checkToolList('writeTools', 'patterns', value.writeTools, trackerToolProblem, file, errors);
  const readTools = checkToolList('readTools', 'names', value.readTools, (name) => readToolProblem(name, writeTools), file, errors);
  for (const pattern of writeTools) {
    const bad = unreachableWriteProblem(pattern);
    if (bad) errors.push(`${file}: "tracker.writeTools" has ${JSON.stringify(pattern)}: ${bad}`);
  }
  for (const name of readTools) {
    const bad = readToolReport(name, writeTools);
    if (bad) errors.push(`${file}: "tracker.readTools" has ${JSON.stringify(name)}: ${bad}`);
  }
  const team = checkTrackerGroup('team', value.team, file, errors);
  const project = checkTrackerGroup('project', value.project, file, errors);
  const listUnset = (raw) => raw === undefined || (Array.isArray(raw) && raw.length === 0);
  const listSet = (raw) => Array.isArray(raw) && raw.length > 0;
  const groupUnset = (raw) => raw === undefined || raw === null;
  if (isObject(value.workspace) && listUnset(value.readTools) && !perCall) errors.push(`${file}: "tracker.workspace" needs "tracker.readTools", the tools that read the connected workspace`);
  if (listSet(value.readTools) && groupUnset(value.workspace)) errors.push(`${file}: "tracker.readTools" needs "tracker.workspace", the value those tools must report`);
  if (value.enabled === true && listUnset(value.writeTools)) errors.push(`${file}: "tracker.enabled" needs "tracker.writeTools", the tools the guard watches`);
  if (value.enabled === true && listSet(value.writeTools) && [value.workspace, value.team, value.project].every(groupUnset)) {
    errors.push(`${file}: "tracker.enabled" needs one of "tracker.workspace", "tracker.team", or "tracker.project", the values a write is held to`);
  }
  // A read tool left out may be the one the connector has, so the workspace check goes with it instead of refusing every write.
  const readPaired = workspace !== null && readTools.length > 0 && readTools.length === value.readTools.length;
  const paired = perCall ? workspace !== null : readPaired;
  if (readPaired) {
    const uncleared = writeTools.map((pattern) => [pattern, unclearedWriteProblem(pattern, readTools)]).filter(([, bad]) => bad);
    // With the adapter's patterns under a file's read tools, what is wrong is that one key, however many patterns it strands.
    if (provided && raw.writeTools === undefined && uncleared.length > 0) {
      const servers = [...new Set(uncleared.map(([pattern]) => serverPrefix(pattern)))].join(', ');
      errors.push(raw.readTools === undefined
        ? `${file}: "tracker.servers" gives writes with no read the guard can count on ${servers}, so no write there can pass`
        : `${file}: "tracker.readTools" replaces the adapter's and leaves no read on ${servers}, so no write there can pass: drop "tracker.readTools", or add a read on each`);
    } else {
      for (const [pattern, bad] of uncleared) errors.push(`${file}: "tracker.writeTools" has ${JSON.stringify(pattern)}: ${bad}`);
    }
  }
  return {
    enabled: value.enabled === true && writeTools.length > 0 && (paired || team !== null || project !== null),
    workspace: paired ? workspace : null,
    readTools: readPaired ? readTools : [],
    writeTools,
    team,
    project,
    ...(provided ? { provider: provided.id } : {}),
    ...(perCall && paired ? { workspaceInput: value.workspaceInput } : {}),
    ...(isText(value.idHint) ? { idHint: value.idHint } : {}),
    ...(isTexts(value.readVerbs) ? { readVerbs: value.readVerbs } : {}),
  };
}

// One group of `tracker`, or null when it is unset or has any error: the guard cannot run on part of one.
function checkTrackerGroup(name, value, file, errors) {
  if (value === undefined || value === null) return null;
  const at = `tracker.${name}`;
  if (!isObject(value)) {
    errors.push(`${file}: "${at}" must be an object, or null`);
    return null;
  }
  const before = errors.length;
  const group = merge(TRACKER_GROUPS[name], {}, value, `${at}.`, file, errors);
  for (const key of Object.keys(TRACKER_GROUPS[name])) if (!Object.hasOwn(value, key)) errors.push(`${file}: "${at}.${key}" is missing`);
  return errors.length === before ? group : null;
}
