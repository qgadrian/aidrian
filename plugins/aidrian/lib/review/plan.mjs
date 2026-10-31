// The review plan: what a pull request's review must cover, decided from its diff and the project's `review` config.
// docs/review.md describes the concepts; this file owns the rules.
//
// A plan is { head, base, depth, reasons, flows, stages }. `stages` run in order; the passes inside a stage run in
// parallel. The built-in evaluator below makes one, and a project's `review.planCommand` may make one instead: both go
// through validatePlan, and the executor (lib/review/run.mjs) never knows which made it.
//
// Everything merges upward. Rules raise the depth and add reviewers; flows add passes; a planCommand, the head's
// config, and an agent can only add. Nothing here lowers what the base branch's config asks for.

import { globPattern, isObject } from '../fs.mjs';
import { partition, SPLIT_DEFAULTS, splitPasses } from './split.mjs';

export const DEPTHS = Object.freeze(['none', 'single', 'split']);
export const STAGES = Object.freeze(['local', 'independent', 'remote']);
export const VERDICTS = Object.freeze(['holds', 'violated', 'not_affected', 'cannot_verify']);

// The files whose changes a review need not read, and that no size counts: lockfiles, snapshots, generated, vendored,
// and minified files. A project's `review.ignore` replaces this list.
export const DEFAULT_IGNORE = Object.freeze([
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lockb', '**/Cargo.lock', '**/poetry.lock', '**/go.sum',
  '**/composer.lock', '**/Gemfile.lock', '**/*.snap', '**/__snapshots__/**', '**/generated/**', '**/*.generated.*',
  '**/vendor/**', '**/*.min.js', '**/*.min.css', '**/*.map',
]);

// The files that cannot change what the software does: prose docs and static assets. Tests are not here on purpose:
// deleting or weakening a test changes what a change is held to. A project's `review.nonBehaviour` replaces it.
export const DEFAULT_NON_BEHAVIOUR = Object.freeze([
  '**/*.md', '**/*.mdx', '**/*.txt', 'docs/**', '**/LICENSE', '**/NOTICE',
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.svg', '**/*.ico', '**/*.woff', '**/*.woff2', '**/*.ttf',
]);

// The meta-flow every project has: a change to how the project is reviewed is reviewed by the Human.
export const HARNESS_FLOW = 'harness-config';

const DEPTH_RANK = Object.fromEntries(DEPTHS.map((depth, i) => [depth, i]));
const maxDepth = (a, b) => (DEPTH_RANK[b] > DEPTH_RANK[a] ? b : a);
const matcher = (globs) => {
  const patterns = (globs ?? []).map(globPattern);
  return (file) => patterns.some((pattern) => pattern.test(file));
};

// The changed files sorted into what the review reads: `ignored` (review.ignore), `nonBehaviour`, and `behaviour`,
// the rest. `lines` counts the added and removed lines of the files that are not ignored.
export function classify(changes, { ignore = DEFAULT_IGNORE, nonBehaviour = DEFAULT_NON_BEHAVIOUR } = {}) {
  const ignored = matcher(ignore);
  const prose = matcher(nonBehaviour);
  const out = { ignored: [], nonBehaviour: [], behaviour: [], lines: 0 };
  for (const change of changes) {
    if (ignored(change.file)) {
      out.ignored.push(change.file);
      continue;
    }
    out.lines += (change.added ?? 0) + (change.removed ?? 0);
    (prose(change.file) ? out.nonBehaviour : out.behaviour).push(change.file);
  }
  return out;
}

// One rule's match against the classified diff. A rule with no `when` matches every diff.
function ruleMatches(when, files, sorted) {
  if (!when) return true;
  if (when.onlyFiles) {
    const only = matcher(when.onlyFiles);
    const reviewed = [...sorted.behaviour, ...sorted.nonBehaviour];
    if (reviewed.length === 0 || !reviewed.every(only)) return false;
  }
  if (when.anyFiles && !files.some(matcher(when.anyFiles))) return false;
  if (when.lines && !(sorted.lines > when.lines.over)) return false;
  return true;
}

// The additive evaluation of `rules`: depth is the deepest a matching rule asks for, `require` the union. A diff with
// a behaviour-bearing file starts at single; `none` only lowers it through an `onlyFiles` rule that covers every
// reviewed file and no matching rule asks for more, so a rule can never hide another.
export function evaluateRules(rules, files, sorted) {
  const reasons = [];
  const require = new Set();
  let raised = null;
  let lowered = false;
  rules.forEach((rule, i) => {
    if (!ruleMatches(rule.when, files, sorted)) return;
    if (rule.depth === 'none') lowered ||= Boolean(rule.when?.onlyFiles);
    else if (rule.depth) raised = raised ? maxDepth(raised, rule.depth) : rule.depth;
    for (const need of rule.require ?? []) require.add(need);
    reasons.push(`rule ${i + 1}${rule.depth ? `: ${rule.depth}` : ''}${rule.require?.length ? `: requires ${rule.require.join(', ')}` : ''}`);
  });
  let depth = sorted.behaviour.length ? 'single' : 'none';
  if (depth === 'none') reasons.unshift(sorted.nonBehaviour.length ? 'only files that cannot change behaviour' : 'nothing to review');
  if (raised) depth = maxDepth(depth === 'none' && lowered ? 'none' : depth, raised);
  else if (lowered && !require.size) depth = 'none';
  return { depth, require: [...require], reasons };
}

// The flows a diff touches, from the base branch's flows plus any the head adds (never fewer, never weaker):
// L1 a behaviour-bearing changed file matches the flow's `files`; L2 an added line of any reviewed file matches one of
// its `added` patterns. `reasons` says which. `presentationOnly` files (a planCommand's word) do not trigger by path,
// unless they remove lines: deleting a button can remove a way into the flow, so the flow still runs with a note.
export function detectFlows(flows, { sorted, addedLines = {}, removedFiles = new Set(), presentationOnly = [] }) {
  const presentation = new Set(presentationOnly);
  const touched = [];
  for (const [id, flow] of Object.entries(flows)) {
    const inFlow = matcher(flow.files);
    const reasons = [];
    const files = new Set();
    for (const file of sorted.behaviour) {
      if (!inFlow(file)) continue;
      if (presentation.has(file) && !removedFiles.has(file)) continue;
      files.add(file);
      reasons.push(presentation.has(file) ? `presentation file with removed lines: ${file}` : `path: ${file}`);
    }
    const patterns = (flow.added ?? []).map((source) => new RegExp(source, 'u'));
    for (const [file, lines] of Object.entries(addedLines)) {
      const hit = patterns.find((pattern) => lines.some((line) => pattern.test(line)));
      if (hit) {
        files.add(file);
        reasons.push(`added line matches /${hit.source}/ in ${file}`);
      }
    }
    if (files.size) touched.push({ id, files: [...files].sort(), reasons: reasons.slice(0, 10) });
  }
  return touched;
}

// The flows in force: the base branch's, plus flows only the head defines. A flow the base defines keeps the base's
// definition, so a pull request cannot loosen the flow it is reviewed under; the head's changes to it take effect once
// they are on the base branch.
export function flowsInForce(baseFlows = {}, headFlows = {}) {
  const out = { ...baseFlows };
  for (const [id, flow] of Object.entries(headFlows)) if (!Object.hasOwn(out, id)) out[id] = flow;
  return out;
}

// The reviewer for a capability word, a `require` entry: `agent:<name>` is that agent; `independent-model` is the
// machine's independent reviewer (a model other than the author's).
export function requirement(word) {
  if (word.startsWith('agent:')) return { kind: 'agent', name: word.slice('agent:'.length) };
  if (word === 'independent-model') return { kind: 'independent' };
  return null;
}

// The built-in plan. `engine` is the machine's resolved reviewer: { name, kind, stage, independent }.
// A local stage holds every required agent and flow pass; the engine's pass sits in its own stage after it.
export function buildPlan({ head, base, changes, addedLines, removedFiles, config, engine, presentationOnly = [], extraFlows = [], harnessChanged = [], roots = new Set(), halved = {} }) {
  const review = config.review;
  const sorted = classify(changes, review);
  const files = [...sorted.behaviour, ...sorted.nonBehaviour];
  const evaluated = evaluateRules(review.rules, files, sorted);
  const reasons = [...evaluated.reasons];
  let depth = evaluated.depth;
  const flows = detectFlows(review.flows, { sorted, addedLines, removedFiles, presentationOnly });
  for (const extra of extraFlows) {
    const known = flows.find((flow) => flow.id === extra.id);
    if (known) known.files = [...new Set([...known.files, ...extra.files])].sort();
    else flows.push(extra);
  }
  if (harnessChanged.length) flows.push({ id: HARNESS_FLOW, files: harnessChanged, reasons: ['the review config, its plan command, or a flow invariants doc changed'] });
  if (flows.length && depth === 'none') depth = 'single';
  const passes = { local: [], independent: [], remote: [] };
  const require = new Set(evaluated.require);
  if (config.github.reviewGate.enabled && depth !== 'none') require.add('agent:code-reviewer');
  for (const word of require) {
    const need = requirement(word);
    if (need?.kind === 'agent') passes.local.push({ id: `agent:${need.name}`, reviewer: need.name, kind: 'agent', files: null, context: 'full' });
  }
  for (const flow of flows) {
    const definition = review.flows[flow.id] ?? {};
    const reviewers = definition.require?.length ? definition.require : ['agent:code-reviewer'];
    for (const word of reviewers) {
      const need = requirement(word);
      if (need?.kind === 'agent') passes.local.push({ id: `flow:${flow.id}:${need.name}`, reviewer: need.name, kind: 'agent', flow: flow.id, files: flow.files, context: 'full' });
      if (need?.kind === 'independent') require.add('independent-model');
    }
  }
  if (depth !== 'none' && engine) {
    // The built-in self engine is the same reviewer as a required code-reviewer, so they merge into one pass. A
    // project's agent reviewer keeps its own name, stage, and independence.
    if (engine.kind === 'agent' && engine.builtIn) passes.local.push({ id: `agent:${engine.agent}`, reviewer: engine.agent, kind: 'agent', files: null, context: 'full' });
    else if (engine.kind === 'agent') passes[engine.stage].push({ id: `engine:${engine.name}`, reviewer: engine.name, kind: 'agent', engine: true, files: null, context: 'full' });
    else passes[engine.stage].push({ id: `engine:${engine.name}`, reviewer: engine.name, kind: engine.kind, files: null, context: 'full' });
  }
  // A split review: the engine's one pass becomes a pass per slice and a cross-cutting pass after them. The review
  // bot reviews the whole pull request in one go, so it cannot split.
  if (depth === 'split' && engine) {
    const stage = engine.kind === 'agent' && engine.builtIn ? 'local' : engine.stage;
    const reviewer = engine.kind === 'agent' && engine.builtIn ? engine.agent : engine.name;
    const id = engine.kind === 'agent' && engine.builtIn ? `agent:${engine.agent}` : `engine:${engine.name}`;
    if (engine.kind === 'remote') reasons.push('split: the review bot reviews the whole pull request in one pass');
    else {
      const reviewed = changes.filter((change) => sorted.behaviour.includes(change.file) || sorted.nonBehaviour.includes(change.file));
      const slices = partition(reviewed, roots, { ...SPLIT_DEFAULTS, ...review.split });
      passes[stage] = passes[stage].filter((pass) => pass.id !== id);
      passes[stage].push(...splitPasses(reviewer, slices, { kind: engine.kind, halved }));
      reasons.push(`split into ${slices.length} slices and a cross-cutting pass`);
    }
  }
  const stages = STAGES.filter((stage) => passes[stage].length).map((stage) => ({ name: stage, passes: mergeAgentPasses(passes[stage]) }));
  return {
    head,
    base,
    depth,
    reasons,
    require: [...require],
    flows: flows.map((flow) => ({ ...flow, signoff: review.flows[flow.id]?.signoff ?? (flow.id === HARNESS_FLOW ? 'human' : 'reviewer') })),
    stages,
  };
}

// One pass per agent and flow group: an agent reviews at most 3 flows in one dispatch, and its plain pass folds into
// the first group, so the same agent does not read the same diff twice.
function mergeAgentPasses(passes) {
  const byAgent = new Map();
  const others = [];
  for (const pass of passes) {
    if (pass.kind !== 'agent' || pass.engine || pass.role) {
      others.push(pass);
      continue;
    }
    const list = byAgent.get(pass.reviewer) ?? [];
    list.push(pass);
    byAgent.set(pass.reviewer, list);
  }
  const merged = [];
  for (const [agent, list] of byAgent) {
    const flows = list.filter((pass) => pass.flow);
    const plain = list.some((pass) => !pass.flow);
    if (!flows.length) {
      merged.push({ id: `agent:${agent}`, reviewer: agent, kind: 'agent', files: null, context: 'full', flows: [] });
      continue;
    }
    for (let i = 0; i < flows.length; i += 3) {
      const group = flows.slice(i, i + 3);
      merged.push({
        id: `agent:${agent}:${group.map((pass) => pass.flow).join('+')}`,
        reviewer: agent,
        kind: 'agent',
        files: plain && i === 0 ? null : [...new Set(group.flatMap((pass) => pass.files))].sort(),
        context: 'full',
        flows: group.map((pass) => pass.flow),
      });
    }
  }
  return [...merged, ...others];
}

// The problems with a plan a planCommand made, as strings; empty when it is well formed. The built-in plan passes too.
export function validatePlan(plan) {
  const problems = [];
  if (!isObject(plan)) return ['the plan must be a JSON object'];
  if (!DEPTHS.includes(plan.depth)) problems.push(`depth must be one of ${DEPTHS.join(', ')}`);
  if (!Array.isArray(plan.stages)) problems.push('stages must be a list');
  const ids = new Set();
  for (const [i, stage] of (Array.isArray(plan.stages) ? plan.stages : []).entries()) {
    if (!isObject(stage) || typeof stage.name !== 'string' || !Array.isArray(stage.passes)) {
      problems.push(`stages[${i}] must be { name, passes: [...] }`);
      continue;
    }
    for (const [j, pass] of stage.passes.entries()) {
      const at = `stages[${i}].passes[${j}]`;
      if (!isObject(pass) || typeof pass.id !== 'string' || typeof pass.reviewer !== 'string') problems.push(`${at} needs an id and a reviewer`);
      else if (ids.has(pass.id)) problems.push(`${at}: pass id "${pass.id}" is used twice`);
      else ids.add(pass.id);
      if (isObject(pass) && pass.files !== null && pass.files !== undefined && !(Array.isArray(pass.files) && pass.files.every((f) => typeof f === 'string'))) {
        problems.push(`${at}.files must be null or a list of paths`);
      }
    }
  }
  if (plan.flows !== undefined && !(Array.isArray(plan.flows) && plan.flows.every((flow) => isObject(flow) && typeof flow.id === 'string'))) {
    problems.push('flows must be a list of { id, files, reasons }');
  }
  return problems;
}

// A planCommand's plan over the built-in one: it may add depth, flows, passes, and reorder stages, never remove. Every
// built-in pass the command left out is put back in its stage, and every built-in flow stays.
export function mergePlans(builtIn, project) {
  const depth = maxDepth(builtIn.depth, project.depth);
  // A built-in pass is kept as built: a project pass with the same id is dropped, so it cannot swap the reviewer,
  // narrow the files, or drop a flow from a pass the config requires.
  const builtInIds = new Set(builtIn.stages.flatMap((stage) => stage.passes.map((pass) => pass.id)));
  const shadowed = project.stages.flatMap((stage) => stage.passes.filter((pass) => builtInIds.has(pass.id)).map((pass) => pass.id));
  const stages = project.stages.map((stage) => ({ name: stage.name, passes: stage.passes.filter((pass) => !builtInIds.has(pass.id)) }));
  for (const stage of builtIn.stages) {
    const missing = stage.passes;
    if (!missing.length) continue;
    const target = stages.find((each) => each.name === stage.name);
    if (target) target.passes.push(...missing);
    else stages.push({ name: stage.name, passes: missing });
  }
  const flows = [...builtIn.flows];
  for (const flow of project.flows ?? []) if (!flows.some((each) => each.id === flow.id)) flows.push({ signoff: 'reviewer', reasons: [], files: [], ...flow });
  const notes = shadowed.map((id) => `plan command: pass ${id} is built in and was kept as built`);
  const interfaceFiles = [...new Set([...(builtIn.interfaceFiles ?? []), ...(Array.isArray(project.interfaceFiles) ? project.interfaceFiles.filter((each) => typeof each === 'string') : [])])];
  return { ...builtIn, depth, interfaceFiles, stages: stages.filter((stage) => stage.passes.length), flows, reasons: [...builtIn.reasons, ...(project.reasons ?? []).map((reason) => `plan command: ${reason}`), ...notes] };
}
