// The `review` group of config.json, and `review.engine` of the local settings file: checked here, used by plan.mjs,
// reviewers.mjs, and run.mjs. docs/review.md describes every key. A bad entry is an error and is left out, so the rest
// still applies; a left-out rule or flow only makes the review ask for less than the project wrote, so the command
// that plans a review refuses to run on a config with errors (config.mjs commandConfig).

import { isObject } from '../fs.mjs';
import { DEFAULT_IGNORE, DEFAULT_NON_BEHAVIOUR, DEPTHS, HARNESS_FLOW } from './plan.mjs';
import { SPLIT_DEFAULTS } from './split.mjs';

export const ENGINES = Object.freeze(['auto', 'codex-local', 'pr-bot', 'self']);
export const KINDS = Object.freeze(['exec', 'agent']);
export const SIGNOFFS = Object.freeze(['reviewer', 'human']);
const FLOW_ID = /^[a-z0-9][a-z0-9-]*$/u;
const NAME = /^[\w.:-]+$/u;

export const REVIEW_DEFAULTS = Object.freeze({
  rules: [],
  ignore: DEFAULT_IGNORE,
  nonBehaviour: DEFAULT_NON_BEHAVIOUR,
  flows: {},
  planCommand: null,
  reviewers: {},
  split: SPLIT_DEFAULTS,
});

const texts = (value) => Array.isArray(value) && value.every((each) => typeof each === 'string' && each !== '');
const someTexts = (value) => texts(value) && value.length > 0;
const isText = (value) => typeof value === 'string' && value !== '';
export const capabilityProblem = (word) =>
  word === 'independent-model' || (typeof word === 'string' && /^agent:[\w.:-]+$/u.test(word)) ? null : `"${word}" is not "independent-model" or "agent:<name>"`;

function regexProblem(source) {
  try {
    new RegExp(source, 'u');
    return null;
  } catch (error) {
    return error.message;
  }
}

// `review` from config.json over the defaults. `errors` gets one line per problem.
export function checkReview(value, file, errors) {
  const out = { ...REVIEW_DEFAULTS };
  const bad = (problem) => errors.push(`${file}: ${problem}`);
  if (!isObject(value)) {
    bad('"review" must be an object');
    return out;
  }
  for (const key of Object.keys(value)) {
    if (key === 'engine') bad('"review.engine" is a machine setting: set it in the local settings file, not the project config');
    else if (!Object.hasOwn(REVIEW_DEFAULTS, key)) bad(`unknown key "review.${key}"`);
  }
  for (const key of ['ignore', 'nonBehaviour']) {
    if (!Object.hasOwn(value, key)) continue;
    if (texts(value[key])) out[key] = value[key];
    else bad(`"review.${key}" must be a list of globs`);
  }
  if (Object.hasOwn(value, 'planCommand')) {
    if (value.planCommand === null || isText(value.planCommand)) out.planCommand = value.planCommand;
    else bad('"review.planCommand" must be a command line or null');
  }
  if (Object.hasOwn(value, 'rules')) out.rules = checkRules(value.rules, bad);
  if (Object.hasOwn(value, 'flows')) out.flows = checkFlows(value.flows, bad);
  if (Object.hasOwn(value, 'reviewers')) out.reviewers = checkReviewers(value.reviewers, bad);
  if (Object.hasOwn(value, 'split')) out.split = checkSplit(value.split, bad);
  return out;
}

function checkRules(rules, bad) {
  if (!Array.isArray(rules)) {
    bad('"review.rules" must be a list');
    return [];
  }
  const kept = [];
  rules.forEach((rule, i) => {
    const at = `review.rules[${i}]`;
    if (!isObject(rule)) return bad(`"${at}" must be an object`);
    const problems = [];
    for (const key of Object.keys(rule)) if (!['when', 'depth', 'require'].includes(key)) problems.push(`unknown key "${at}.${key}"`);
    if (rule.depth !== undefined && !DEPTHS.includes(rule.depth)) problems.push(`"${at}.depth" must be one of ${DEPTHS.join(', ')}`);
    if (rule.require !== undefined) {
      if (!texts(rule.require)) problems.push(`"${at}.require" must be a list`);
      else for (const word of rule.require) if (capabilityProblem(word)) problems.push(`"${at}.require": ${capabilityProblem(word)}`);
    }
    if (rule.depth === undefined && rule.require === undefined) problems.push(`"${at}" sets neither depth nor require`);
    if (rule.when !== undefined) {
      if (!isObject(rule.when)) problems.push(`"${at}.when" must be an object`);
      else {
        for (const key of Object.keys(rule.when)) if (!['onlyFiles', 'anyFiles', 'lines'].includes(key)) problems.push(`unknown key "${at}.when.${key}"`);
        for (const key of ['onlyFiles', 'anyFiles']) if (rule.when[key] !== undefined && !someTexts(rule.when[key])) problems.push(`"${at}.when.${key}" must be a list of globs`);
        if (rule.when.lines !== undefined && !(isObject(rule.when.lines) && Number.isInteger(rule.when.lines.over) && rule.when.lines.over >= 0)) {
          problems.push(`"${at}.when.lines" must be { "over": <whole number> }`);
        }
      }
    }
    if (rule.depth === 'none' && !rule.when?.onlyFiles) problems.push(`"${at}": depth "none" needs when.onlyFiles, so it can only cover the files it names`);
    if (problems.length) problems.forEach(bad);
    else kept.push(rule);
  });
  return kept;
}

function checkFlows(flows, bad) {
  if (!isObject(flows)) {
    bad('"review.flows" must be an object');
    return {};
  }
  const kept = {};
  for (const [id, flow] of Object.entries(flows)) {
    const at = `review.flows.${id}`;
    const problems = [];
    if (!FLOW_ID.test(id)) problems.push(`"${at}": a flow id is lowercase letters, digits, and dashes`);
    if (id === HARNESS_FLOW) problems.push(`"${at}": "${HARNESS_FLOW}" is built in`);
    if (!isObject(flow)) {
      bad(`"${at}" must be an object`);
      continue;
    }
    const keys = ['files', 'added', 'tests', 'checks', 'invariants', 'require', 'signoff'];
    for (const key of Object.keys(flow)) if (!keys.includes(key)) problems.push(`unknown key "${at}.${key}"`);
    if (!someTexts(flow.files)) problems.push(`"${at}.files" must be a non-empty list of globs`);
    for (const key of ['tests', 'checks']) if (flow[key] !== undefined && !texts(flow[key])) problems.push(`"${at}.${key}" must be a list`);
    if (flow.added !== undefined) {
      if (!texts(flow.added)) problems.push(`"${at}.added" must be a list of regular expressions`);
      else for (const source of flow.added) if (regexProblem(source)) problems.push(`"${at}.added" has /${source}/: ${regexProblem(source)}`);
    }
    if (flow.require !== undefined) {
      if (!someTexts(flow.require)) problems.push(`"${at}.require" must be a non-empty list`);
      else for (const word of flow.require) if (capabilityProblem(word)) problems.push(`"${at}.require": ${capabilityProblem(word)}`);
    }
    if (flow.signoff !== undefined && !SIGNOFFS.includes(flow.signoff)) problems.push(`"${at}.signoff" must be "reviewer" or "human"`);
    if (flow.invariants !== undefined && !isText(flow.invariants) && !invariantList(flow.invariants)) {
      problems.push(`"${at}.invariants" must be a doc path or a list of { "id", "text", "cite"? }`);
    }
    if (flow.signoff === 'human' && flow.invariants === undefined) problems.push(`"${at}": a flow the Human signs off must state its invariants`);
    if (problems.length) problems.forEach(bad);
    else kept[id] = flow;
  }
  return kept;
}

const invariantList = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((each) => isObject(each) && FLOW_ID.test(each.id ?? '') && isText(each.text) && (each.cite === undefined || isText(each.cite)));

function checkReviewers(reviewers, bad) {
  if (!isObject(reviewers)) {
    bad('"review.reviewers" must be an object');
    return {};
  }
  const kept = {};
  for (const [name, reviewer] of Object.entries(reviewers)) {
    const at = `review.reviewers.${name}`;
    const problems = [];
    if (!NAME.test(name)) problems.push(`"${at}": a reviewer name is letters, digits, and . _ : -`);
    if (ENGINES.includes(name)) problems.push(`"${at}": "${name}" is built in`);
    if (!isObject(reviewer)) {
      bad(`"${at}" must be an object`);
      continue;
    }
    for (const key of Object.keys(reviewer)) if (!['kind', 'command', 'agent', 'stage', 'independent', 'timeoutSec'].includes(key)) problems.push(`unknown key "${at}.${key}"`);
    if (!KINDS.includes(reviewer.kind)) problems.push(`"${at}.kind" must be "exec" or "agent"`);
    if (reviewer.kind === 'exec' && !someTexts(reviewer.command)) problems.push(`"${at}.command" must be a non-empty list: the program, then its arguments`);
    if (reviewer.kind === 'agent' && !isText(reviewer.agent)) problems.push(`"${at}.agent" must name the agent`);
    if (reviewer.stage !== undefined && !['local', 'independent'].includes(reviewer.stage)) problems.push(`"${at}.stage" must be "local" or "independent"`);
    if (reviewer.independent !== undefined && typeof reviewer.independent !== 'boolean') problems.push(`"${at}.independent" must be true or false`);
    if (reviewer.timeoutSec !== undefined && !(Number.isInteger(reviewer.timeoutSec) && reviewer.timeoutSec > 0 && reviewer.timeoutSec <= 3600)) {
      problems.push(`"${at}.timeoutSec" must be a whole number from 1 to 3600`);
    }
    if (problems.length) problems.forEach(bad);
    else kept[name] = reviewer;
  }
  return kept;
}

// `review.engine` from the local settings file: a built-in engine or a reviewer the project defines. Unknown names are
// checked when the engine resolves, against the project's reviewers.
export function checkLocalReview(value, file, errors) {
  if (!isObject(value)) {
    errors.push(`${file}: "review" must be an object`);
    return 'auto';
  }
  for (const key of Object.keys(value)) if (key !== 'engine') errors.push(`${file}: unknown key "review.${key}"; only "review.engine" is a machine setting`);
  if (value.engine === undefined) return 'auto';
  if (isText(value.engine) && NAME.test(value.engine)) return value.engine;
  errors.push(`${file}: "review.engine" must be ${ENGINES.map((each) => `"${each}"`).join(', ')}, or a reviewer of review.reviewers`);
  return 'auto';
}

// `review.split`: slice size, parallel passes, and the most slices. Each is a whole number in a sane range.
function checkSplit(split, bad) {
  const out = { ...SPLIT_DEFAULTS };
  if (!isObject(split)) {
    bad('"review.split" must be an object');
    return out;
  }
  const ranges = { sliceLines: [100, 10000], parallel: [1, 8], maxSlices: [2, 16] };
  for (const [key, value] of Object.entries(split)) {
    if (!Object.hasOwn(ranges, key)) bad(`unknown key "review.split.${key}"`);
    else if (Number.isInteger(value) && value >= ranges[key][0] && value <= ranges[key][1]) out[key] = value;
    else bad(`"review.split.${key}" must be a whole number from ${ranges[key][0]} to ${ranges[key][1]}`);
  }
  return out;
}
