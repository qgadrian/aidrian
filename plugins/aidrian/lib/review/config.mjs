// The `review` group of config.json, and `review.engine` of the local settings file: checked here, used by plan.mjs,
// reviewers.mjs, and run.mjs. The project's `review.engine`, when set, is policy: it wins over the machine's.
// docs/review.md describes every key. A bad entry is an error and is left out, so the rest still applies; a left-out
// rule or flow only makes the review ask for less than the project wrote, so the command that plans a review refuses
// to run on a config with errors (config.mjs commandConfig).

import { isObject } from '../fs.mjs';
import { DEFAULT_IGNORE, DEFAULT_NON_BEHAVIOUR, DEPTHS, HARNESS_FLOW } from './plan.mjs';
import { SPLIT_DEFAULTS } from './split.mjs';

export const ENGINES = Object.freeze(['auto', 'codex-local', 'pr-bot', 'self']);
export const KINDS = Object.freeze(['exec', 'agent']);
export const SIGNOFFS = Object.freeze(['reviewer', 'human']);
// Where the review record goes: the state folder and one summary comment on the pull request, or the state folder only.
export const RECORDS = Object.freeze(['comment', 'local']);
const FLOW_ID = /^[a-z0-9][a-z0-9-]*$/u;
const NAME = /^[\w.:-]+$/u;

export const REVIEW_DEFAULTS = Object.freeze({
  engine: null,
  record: 'comment',
  rules: [],
  ignore: DEFAULT_IGNORE,
  nonBehaviour: DEFAULT_NON_BEHAVIOUR,
  flows: {},
  planCommand: null,
  reviewers: {},
  split: SPLIT_DEFAULTS,
  visual: null,
});

// The visual review's limits: images one route may ask for across viewports, locales, and variants (a config error
// past it), and images one review may capture (the review stops past it and names the routes).
export const VISUAL_PER_ROUTE = 60;
export const VISUAL_PER_RUN = 200;
export const VISUAL_PLATFORMS = Object.freeze(['web']);
export const ATTACH_MODES = Object.freeze(['auto', 'local', 'off']);
export const VISUAL_REVIEWERS = Object.freeze(['designer', 'ux-specialist']);

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
  for (const key of Object.keys(value)) if (!Object.hasOwn(REVIEW_DEFAULTS, key)) bad(`unknown key "review.${key}"`);
  if (Object.hasOwn(value, 'engine')) {
    if (value.engine === null || engineName(value.engine)) out.engine = value.engine;
    else bad(ENGINE_PROBLEM);
  }
  if (Object.hasOwn(value, 'record')) {
    if (RECORDS.includes(value.record)) out.record = value.record;
    else bad('"review.record" must be "comment" or "local"');
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
  if (Object.hasOwn(value, 'visual')) out.visual = value.visual === null ? null : checkVisual(value.visual, bad);
  return out;
}

// `review.visual`: the screens a change to the UI is captured on, for the visual reviewers. A bad entry drops the whole
// group: a half-configured capture would show reviewers less than the project asked for without saying so.
function checkVisual(visual, bad) {
  if (!isObject(visual)) {
    bad('"review.visual" must be an object');
    return null;
  }
  const problems = [];
  const keys = ['platform', 'targets', 'viewports', 'locales', 'variants', 'login', 'preview', 'attach', 'reviewers', 'checklist'];
  for (const key of Object.keys(visual)) if (!keys.includes(key)) problems.push(`unknown key "review.visual.${key}"`);
  if (!VISUAL_PLATFORMS.includes(visual.platform)) problems.push(`"review.visual.platform" must be ${VISUAL_PLATFORMS.map((each) => `"${each}"`).join(', ')}`);
  if (!Array.isArray(visual.targets) || visual.targets.length === 0) problems.push('"review.visual.targets" must be a non-empty list of { "files", "routes" }');
  else {
    visual.targets.forEach((target, i) => {
      const at = `review.visual.targets[${i}]`;
      if (!isObject(target)) return problems.push(`"${at}" must be an object`);
      for (const key of Object.keys(target)) if (!['files', 'routes', 'base', 'locales', 'variants'].includes(key)) problems.push(`unknown key "${at}.${key}"`);
      // A target's own subset of the locales and variants, for a screen that does not change with them: [] locales is
      // one capture in the app's default locale.
      if (target.locales !== undefined && !(Array.isArray(target.locales) && target.locales.every((locale) => Array.isArray(visual.locales) && visual.locales.includes(locale)) && new Set(target.locales).size === target.locales.length)) {
        problems.push(`"${at}.locales" must list tags from review.visual.locales, each once, or be [] for one capture in the default locale`);
      }
      if (target.variants !== undefined && !(someTexts(target.variants) && target.variants.every((id) => Array.isArray(visual.variants) && visual.variants.some((variant) => variant?.id === id)) && new Set(target.variants).size === target.variants.length)) {
        problems.push(`"${at}.variants" must be a non-empty list of ids from review.visual.variants, each once`);
      }
      if (target.base !== undefined && !FLOW_ID.test(String(target.base))) problems.push(`"${at}.base" must name a base the login command prints, such as "guest"`);
      if (!someTexts(target.files)) problems.push(`"${at}.files" must be a non-empty list of globs`);
      else if (pathsProblem(target.files)) problems.push(`"${at}.files" ${pathsProblem(target.files)}`);
      if (!someTexts(target.routes) || !target.routes.every((route) => route.startsWith('/'))) problems.push(`"${at}.routes" must be a non-empty list of paths starting with /`);
    });
  }
  const widths = visual.viewports ?? [];
  if (!Array.isArray(widths) || widths.length === 0 || !widths.every((width) => Number.isInteger(width) && width >= 240 && width <= 3840)) {
    problems.push('"review.visual.viewports" must be a non-empty list of widths from 240 to 3840');
  }
  if (visual.locales !== undefined && !(someTexts(visual.locales) && visual.locales.every((locale) => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(locale)))) {
    problems.push('"review.visual.locales" must be a non-empty list of locale tags such as "en" or "el-GR"');
  }
  const variants = visual.variants ?? [];
  if (!Array.isArray(variants) || !variants.every((variant) => isObject(variant) && FLOW_ID.test(variant.id ?? '') && Object.keys(variant).every((key) => ['id', 'account'].includes(key)) && (variant.account === undefined || (isText(variant.account) && NAME.test(variant.account))))) {
    problems.push('"review.visual.variants" must be a list of { "id", "account"? }: a lowercase id, and the name of a demo account (never its secret)');
  } else if (new Set(variants.map((variant) => variant.id)).size !== variants.length) problems.push('"review.visual.variants" ids must be unique');
  for (const key of ['login', 'preview', 'checklist']) if (visual[key] !== undefined && !isText(visual[key])) problems.push(`"review.visual.${key}" must be a ${key === 'checklist' ? 'doc path' : 'command line'}`);
  if (Array.isArray(variants) && variants.some((variant) => variant?.account) && !isText(visual.login)) problems.push('"review.visual.login" must name the command that signs in a variant\'s account');
  if (Array.isArray(visual.targets) && visual.targets.some((target) => target?.base !== undefined) && !isText(visual.login)) problems.push('"review.visual.targets[].base" needs review.visual.login, which prints the named bases');
  if (visual.attach !== undefined && !ATTACH_MODES.includes(visual.attach)) problems.push(`"review.visual.attach" must be ${ATTACH_MODES.map((each) => `"${each}"`).join(', ')}`);
  if (visual.reviewers !== undefined && !(someTexts(visual.reviewers) && visual.reviewers.every((name) => NAME.test(name)))) problems.push('"review.visual.reviewers" must be a non-empty list of agent names');
  if (!problems.length) {
    visual.targets.forEach((target, i) => {
      const locales = target.locales ? Math.max(target.locales.length, 1) : visual.locales?.length ?? 1;
      const perRoute = widths.length * locales * Math.max(target.variants?.length ?? variants.length, 1);
      if (perRoute > VISUAL_PER_ROUTE) problems.push(`review.visual.targets[${i}] asks for ${perRoute} images per route (viewports x locales x variants), past ${VISUAL_PER_ROUTE}: trim a list`);
    });
  }
  if (problems.length) {
    problems.forEach(bad);
    return null;
  }
  return { attach: null, reviewers: [...VISUAL_REVIEWERS], locales: [], variants: [], ...visual };
}

// A flow's `content`: whole-file probes and caller-to-callee tracing over the head (lib/review/content.mjs).
function contentProblems(content, at) {
  const problems = [];
  if (!isObject(content)) return [`"${at}" must be an object`];
  for (const key of Object.keys(content)) if (!['roots', 'exclude', 'probes', 'trace'].includes(key)) problems.push(`unknown key "${at}.${key}"`);
  if (!someTexts(content.roots) || content.roots.some((root) => root.startsWith('/') || root.includes('*') || root.split('/').includes('..'))) {
    problems.push(`"${at}.roots" must be a non-empty list of folders in the repository, such as "src", or "." for all of it`);
  }
  if (content.exclude !== undefined) {
    if (!texts(content.exclude)) problems.push(`"${at}.exclude" must be a list of globs`);
    else if (pathsProblem(content.exclude)) problems.push(`"${at}.exclude" ${pathsProblem(content.exclude)}`);
  }
  const regexes = (list, where) => {
    if (!texts(list)) return problems.push(`"${where}" must be a list of regular expressions`);
    for (const source of list) if (regexProblem(source)) problems.push(`"${where}" has /${source}/: ${regexProblem(source)}`);
  };
  if (content.probes !== undefined) regexes(content.probes, `${at}.probes`);
  if (content.trace !== undefined) {
    const trace = content.trace;
    const where = `${at}.trace`;
    if (!isObject(trace)) return [...problems, `"${where}" must be an object`];
    for (const key of Object.keys(trace)) if (!['variables', 'factories', 'params', 'aliases', 'hops'].includes(key)) problems.push(`unknown key "${where}.${key}"`);
    if (trace.variables !== undefined && !(texts(trace.variables) && trace.variables.every((name) => /^\w+(?:\.\w+)?$/u.test(name)))) problems.push(`"${where}.variables" must be a list of names, such as "adminClient" or "ctx.adminClient"`);
    if (trace.factories !== undefined) regexes(trace.factories, `${where}.factories`);
    if (!someTexts(trace.variables ?? []) && !someTexts(trace.factories ?? [])) problems.push(`"${where}" needs variables or factories: what holds the privileged value`);
    if (trace.params !== undefined && !(texts(trace.params) && trace.params.every((name) => /^\w+$/u.test(name)))) problems.push(`"${where}.params" must be a list of parameter names`);
    if (trace.aliases !== undefined && !(isObject(trace.aliases) && Object.entries(trace.aliases).every(([from, to]) => isText(from) && typeof to === 'string'))) problems.push(`"${where}.aliases" must map an import prefix to a folder, such as { "~/": "src/" }`);
    if (trace.hops !== undefined && ![1, 2].includes(trace.hops)) problems.push(`"${where}.hops" must be 1 or 2`);
    if (trace.hops === 2 && !someTexts(trace.params ?? [])) problems.push(`"${where}.hops" 2 needs params: the names a callee receives the value under`);
  }
  return problems;
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
        for (const key of ['onlyFiles', 'anyFiles']) {
          if (rule.when[key] === undefined) continue;
          if (!someTexts(rule.when[key])) problems.push(`"${at}.when.${key}" must be a list of globs`);
          else if (pathsProblem(rule.when[key])) problems.push(`"${at}.when.${key}" ${pathsProblem(rule.when[key])}`);
        }
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
    const keys = ['files', 'added', 'tests', 'checks', 'invariants', 'require', 'signoff', 'content'];
    for (const key of Object.keys(flow)) if (!keys.includes(key)) problems.push(`unknown key "${at}.${key}"`);
    if (!someTexts(flow.files)) problems.push(`"${at}.files" must be a non-empty list of globs`);
    else if (pathsProblem(flow.files)) problems.push(`"${at}.files" ${pathsProblem(flow.files)}`);
    if (texts(flow.tests ?? []) && pathsProblem(flow.tests ?? [])) problems.push(`"${at}.tests" ${pathsProblem(flow.tests)}`);
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
      problems.push(`"${at}.invariants" must be a doc path or a list of { "id", "text", "cite"? }, where text may be left out when cite names a heading`);
    }
    if (flow.signoff === 'human' && flow.invariants === undefined) problems.push(`"${at}": a flow the Human signs off must state its invariants`);
    if (flow.content !== undefined) problems.push(...contentProblems(flow.content, `${at}.content`));
    if (problems.length) problems.forEach(bad);
    else kept[id] = flow;
  }
  return kept;
}

// An invariant is { id, text, cite? }; with a cite to a heading (`doc.md#heading`), text is optional: the question
// comes from the heading, and the reviewer judges against the cited section (flows.mjs withSource).
const invariantList = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((each) => isObject(each) && FLOW_ID.test(each.id ?? '') && (each.cite === undefined || isText(each.cite)) && (isText(each.text) || (each.text === undefined && isText(each.cite) && /#./u.test(each.cite))));

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
  for (const key of Object.keys(value)) if (key !== 'engine' && key !== 'visual') errors.push(`${file}: unknown key "review.${key}"; only "review.engine" and "review.visual" are machine settings`);
  if (value.engine === undefined) return 'auto';
  if (engineName(value.engine)) return value.engine;
  errors.push(`${file}: ${ENGINE_PROBLEM}`);
  return 'auto';
}

// An engine is a built-in or a reviewer the project defines; unknown names are checked when the engine resolves.
const engineName = (value) => isText(value) && NAME.test(value);
const ENGINE_PROBLEM = `"review.engine" must be ${ENGINES.map((each) => `"${each}"`).join(', ')}, or a reviewer of review.reviewers`;

// `review.visual` from the local settings file: { baseUrl }, where this machine serves the app for the visual capture
// (a local dev server, or a preview). A machine setting, so a committed config never points the capture at a host.
export function checkLocalVisual(value, file, errors) {
  const visual = isObject(value) ? value.visual : undefined;
  if (visual === undefined) return { baseUrl: null };
  const ok = isObject(visual) && Object.keys(visual).every((key) => key === 'baseUrl') && (visual.baseUrl === undefined || (isText(visual.baseUrl) && /^https?:\/\/[^\s/]+(?:\/\S*)?$/u.test(visual.baseUrl)));
  if (!ok) {
    errors.push(`${file}: "review.visual" must be { "baseUrl": "http(s)://host[:port]" }`);
    return { baseUrl: null };
  }
  return { baseUrl: visual.baseUrl ? visual.baseUrl.replace(/\/+$/u, '') : null };
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

// The problem with a list of path entries (globs, or `re:<regular expression>`), or null.
function pathsProblem(list) {
  for (const entry of list) {
    if (entry.startsWith('re:')) {
      const problem = regexProblem(entry.slice('re:'.length));
      if (problem) return `has ${entry}: ${problem}`;
    }
  }
  return null;
}
