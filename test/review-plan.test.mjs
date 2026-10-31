import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { checkLocalReview, checkReview } from '../plugins/aidrian/lib/review/config.mjs';
import { buildPlan, classify, detectFlows, evaluateRules, flowsInForce, HARNESS_FLOW, mergePlans, validatePlan } from '../plugins/aidrian/lib/review/plan.mjs';

const change = (file, added = 10, removed = 0) => ({ file, added, removed, status: 'M' });
const config = (review = {}, github = {}) => ({ ...DEFAULTS, github: { ...DEFAULTS.github, ...github }, review: { ...DEFAULTS.review, ...review } });
const codex = { name: 'codex-local', kind: 'exec', stage: 'independent' };
const plan = (changes, review, extra = {}) => buildPlan({ head: 'h', base: 'b', changes, addedLines: {}, removedFiles: new Set(), config: config(review), engine: codex, ...extra });

test('classify: ignored files count no lines; docs and assets cannot change behaviour; tests can', () => {
  const sorted = classify([change('package-lock.json', 900), change('README.md', 5), change('src/a.test.js', 3), change('src/a.js', 7), change('logo.svg', 1)]);
  assert.deepEqual(sorted, { ignored: ['package-lock.json'], nonBehaviour: ['README.md', 'logo.svg'], behaviour: ['src/a.test.js', 'src/a.js'], lines: 16 });
});

test('evaluateRules: rules add up, so order never hides a rule, and none only lowers through onlyFiles', () => {
  const rules = [
    { when: { onlyFiles: ['docs/**', 'src/**/*.css'] }, depth: 'none' },
    { when: { anyFiles: ['src/auth/**'] }, require: ['agent:security-engineer'] },
    { when: { lines: { over: 100 } }, depth: 'split' },
  ];
  const run = (changes) => {
    const sorted = classify(changes);
    return evaluateRules(rules, [...sorted.behaviour, ...sorted.nonBehaviour], sorted);
  };
  assert.equal(run([change('src/a.css')]).depth, 'none');
  assert.equal(run([change('src/a.js')]).depth, 'single');
  assert.deepEqual(run([change('src/auth/login.js', 200)]), { depth: 'split', require: ['agent:security-engineer'], reasons: ['rule 2: requires agent:security-engineer', 'rule 3: split'] });
  assert.equal(run([change('docs/a.md')]).depth, 'none');
  assert.equal(run([change('src/a.css', 300)]).depth, 'split', 'a bigger rule wins over a none rule');
});

test('detectFlows: by path on behaviour files, by added lines anywhere; a presentation file triggers only when it removes lines', () => {
  const flows = { booking: { files: ['src/booking/**'] }, payments: { files: ['src/pay/**'], added: ['service_role'] } };
  const sorted = classify([change('src/booking/modal.css'), change('src/booking/api.js'), change('src/util.js')]);
  assert.deepEqual(detectFlows(flows, { sorted, addedLines: { 'src/util.js': ['const k = service_role'] } }), [
    { id: 'booking', files: ['src/booking/api.js', 'src/booking/modal.css'], reasons: ['path: src/booking/modal.css', 'path: src/booking/api.js'] },
    { id: 'payments', files: ['src/util.js'], reasons: ['added line matches /service_role/ in src/util.js'] },
  ]);
  const presentationOnly = ['src/booking/modal.css'];
  const only = classify([change('src/booking/modal.css')]);
  assert.deepEqual(detectFlows(flows, { sorted: only, presentationOnly }), []);
  assert.equal(detectFlows(flows, { sorted: only, presentationOnly, removedFiles: new Set(['src/booking/modal.css']) })[0].reasons[0], 'presentation file with removed lines: src/booking/modal.css');
});

test('flowsInForce: the base keeps its definition; the head can only add flows', () => {
  const base = { booking: { files: ['src/booking/**'], signoff: 'human', invariants: 'docs/b.md' } };
  assert.deepEqual(flowsInForce(base, { booking: { files: ['nothing/**'] }, search: { files: ['src/search/**'] } }), { ...base, search: { files: ['src/search/**'] } });
  assert.deepEqual(flowsInForce(base, {}), base, 'deleting a flow in the head does not drop it');
});

test('buildPlan: zero config is one engine pass; docs only is none; the review gate and flows add local agent passes before the engine', () => {
  assert.deepEqual(plan([change('src/a.js')]).stages, [{ name: 'independent', passes: [{ id: 'engine:codex-local', reviewer: 'codex-local', kind: 'exec', files: null, context: 'full' }] }]);
  assert.equal(plan([change('README.md')]).depth, 'none');
  assert.deepEqual(plan([change('README.md')]).stages, []);
  const gated = buildPlan({ head: 'h', base: 'b', changes: [change('src/booking/a.js')], addedLines: {}, removedFiles: new Set(), engine: codex,
    config: config({ flows: { booking: { files: ['src/booking/**'], require: ['agent:product-manager', 'independent-model'] } } }, { reviewGate: { enabled: true, checklist: null } }) });
  assert.deepEqual(gated.stages.map((stage) => [stage.name, stage.passes.map((pass) => pass.id)]), [
    ['local', ['agent:code-reviewer', 'agent:product-manager:booking']],
    ['independent', ['engine:codex-local']],
  ]);
  assert.deepEqual(gated.require, ['agent:code-reviewer', 'independent-model']);
  assert.equal(gated.flows[0].signoff, 'reviewer');
});

test('buildPlan: an agent reviews at most 3 flows per pass; a self engine merges with the required code-reviewer', () => {
  const flows = Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, { files: [`src/${id}/**`] }]));
  const four = plan(['a', 'b', 'c', 'd'].map((id) => change(`src/${id}/x.js`)), { flows }, { engine: { name: 'self', kind: 'agent', stage: 'local', agent: 'code-reviewer' } });
  assert.deepEqual(four.stages.map((stage) => stage.passes.map((pass) => [pass.id, pass.files])), [[
    ['agent:code-reviewer:a+b+c', null],
    ['agent:code-reviewer:d', ['src/d/x.js']],
  ]]);
});

test('buildPlan: a change to how the project is reviewed adds the harness-config flow, which the Human signs off', () => {
  const p = plan([change('.aidrian/config.json')], {}, { harnessChanged: ['.aidrian/config.json'] });
  assert.deepEqual(p.flows.map((flow) => [flow.id, flow.signoff]), [[HARNESS_FLOW, 'human']]);
});

test('validatePlan and mergePlans: a plan command may add and reorder, never drop a built-in pass or flow', () => {
  assert.deepEqual(validatePlan({ depth: 'deep', stages: [{ name: 'x', passes: [{ id: 'a', reviewer: 'r' }, { id: 'a', reviewer: 'r' }] }] }), [
    'depth must be one of none, single, split',
    'stages[0].passes[1]: pass id "a" is used twice',
  ]);
  const builtIn = plan([change('src/booking/a.js')], { flows: { booking: { files: ['src/booking/**'] } } });
  const merged = mergePlans(builtIn, { depth: 'none', stages: [{ name: 'local', passes: [{ id: 'pm', reviewer: 'product-manager', kind: 'agent' }] }], flows: [{ id: 'checkout', files: ['src/c.js'] }] });
  assert.equal(merged.depth, 'single', 'a plan command cannot lower the depth');
  assert.deepEqual(merged.stages.map((stage) => stage.passes.map((pass) => pass.id)), [['pm', 'agent:code-reviewer:booking'], ['engine:codex-local']]);
  assert.deepEqual(merged.flows.map((flow) => flow.id), ['booking', 'checkout']);
});

test('checkReview: bad rules, flows, and reviewers are errors and left out; engine belongs to the machine', () => {
  const errors = [];
  const review = checkReview({
    engine: 'self',
    rules: [{ depth: 'none' }, { when: { anyFiles: ['x/**'] }, require: ['bogus'] }, { when: { lines: { over: 10 } }, depth: 'split' }],
    flows: { Booking: { files: ['a/**'] }, pay: { files: ['p/**'], signoff: 'human' }, ok: { files: ['o/**'], added: ['('] }, good: { files: ['g/**'] } },
    reviewers: { mine: { kind: 'exec', command: ['bin/review'] }, self: { kind: 'agent', agent: 'x' } },
  }, 'config.json', errors);
  assert.deepEqual(review.rules, [{ when: { lines: { over: 10 } }, depth: 'split' }]);
  assert.deepEqual(Object.keys(review.flows), ['good']);
  assert.deepEqual(Object.keys(review.reviewers), ['mine']);
  assert.equal(errors.length, 7);
  assert.match(errors.join('\n'), /review.engine" is a machine setting/u);
  assert.match(errors.join('\n'), /a flow the Human signs off must state its invariants/u);
  assert.equal(checkLocalReview({ engine: 'codex-local' }, 'local', []), 'codex-local');
  const local = [];
  assert.equal(checkLocalReview({ engine: 'no way', depth: 'x' }, 'local', local), 'auto');
  assert.equal(local.length, 2);
});
