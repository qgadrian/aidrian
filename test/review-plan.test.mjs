import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { checkLocalReview, checkLocalVisual, checkReview, VISUAL_PER_ROUTE } from '../plugins/aidrian/lib/review/config.mjs';
import { buildPlan, classify, detectFlows, evaluateRules, flowsInForce, HARNESS_FLOW, mergePlans, mergeStages, validatePlan } from '../plugins/aidrian/lib/review/plan.mjs';

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
  const four = plan(['a', 'b', 'c', 'd'].map((id) => change(`src/${id}/x.js`)), { flows }, { engine: { name: 'self', kind: 'agent', stage: 'local', agent: 'code-reviewer', builtIn: true } });
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

test('checkReview: bad rules, flows, reviewers, and engine are errors and left out', () => {
  const errors = [];
  const review = checkReview({
    engine: 'no way',
    rules: [{ depth: 'none' }, { when: { anyFiles: ['x/**'] }, require: ['bogus'] }, { when: { lines: { over: 10 } }, depth: 'split' }],
    flows: { Booking: { files: ['a/**'] }, pay: { files: ['p/**'], signoff: 'human' }, ok: { files: ['o/**'], added: ['('] }, good: { files: ['g/**'] } },
    reviewers: { mine: { kind: 'exec', command: ['bin/review'] }, self: { kind: 'agent', agent: 'x' } },
  }, 'config.json', errors);
  assert.deepEqual(review.rules, [{ when: { lines: { over: 10 } }, depth: 'split' }]);
  assert.deepEqual(Object.keys(review.flows), ['good']);
  assert.deepEqual(Object.keys(review.reviewers), ['mine']);
  assert.equal(errors.length, 7);
  assert.match(errors.join('\n'), /"review.engine" must be "auto", "codex-local", "pr-bot", "self", or a reviewer/u);
  assert.equal(review.engine, null, 'a bad engine is left out: the machine`s applies');
  assert.match(errors.join('\n'), /a flow the Human signs off must state its invariants/u);
  assert.equal(checkLocalReview({ engine: 'codex-local' }, 'local', []), 'codex-local');
  const local = [];
  assert.equal(checkLocalReview({ engine: 'no way', depth: 'x' }, 'local', local), 'auto');
  assert.equal(local.length, 2);
});

test('mergePlans: a plan command pass with a built-in id cannot replace it', () => {
  const builtIn = plan([change('src/a.js')], {});
  const merged = mergePlans(builtIn, { depth: 'single', stages: [{ name: 'local', passes: [{ id: 'engine:codex-local', reviewer: 'self', kind: 'agent', files: ['x'] }] }] });
  assert.deepEqual(merged.stages, builtIn.stages);
  assert.match(merged.reasons.at(-1), /engine:codex-local is built in and was kept as built/u);
});

test('a path entry may be re:<regex>: rules, flows, and tests match it, and a bad one is an error', () => {
  const flows = { booking: { files: ['re:^src/(?:.*/)?bookings?/|^src/app/subdomain/'] } };
  const sorted = classify([change('src/lib/booking/a.ts'), change('src/app/subdomain/p.tsx'), change('src/other.ts')]);
  assert.deepEqual(detectFlows(flows, { sorted })[0].files, ['src/app/subdomain/p.tsx', 'src/lib/booking/a.ts']);
  const errors = [];
  checkReview({ flows: { bad: { files: ['re:(unclosed'] } }, rules: [{ when: { anyFiles: ['re:['] }, depth: 'split' }] }, 'c.json', errors);
  assert.equal(errors.length, 2);
});

test('mergePlans then mergeStages: a plan command pass for an agent folds into the built-in pass for it, and a shared flow keeps both files and reasons', () => {
  const flows = { 'service-role': { files: ['src/admin/**'], require: ['agent:security-engineer'] } };
  const builtIn = plan([change('src/admin/a.ts'), change('src/lib/b.ts')], { flows, rules: [{ when: { anyFiles: ['src/**'] }, require: ['agent:security-engineer'] }] }, { merge: false });
  const project = {
    depth: 'single',
    reasons: ['service-role: the head content of src/lib/b.ts uses the client'],
    flows: [{ id: 'service-role', files: ['src/lib/b.ts'], reasons: ['head content matches /x/ in src/lib/b.ts'] }],
    stages: [{ name: 'local', passes: [{ id: 'flow:service-role:content:security-engineer', reviewer: 'security-engineer', kind: 'agent', flow: 'service-role', flows: ['service-role'], files: ['src/lib/b.ts'] }] }],
  };
  const merged = mergeStages(mergePlans(builtIn, project));
  const security = merged.stages[0].passes.filter((pass) => pass.reviewer === 'security-engineer');
  assert.equal(security.length, 1, 'security-engineer is dispatched once');
  assert.deepEqual(security[0].flows, ['service-role']);
  assert.equal(security[0].files, null, 'the plain required pass reads the whole change');
  const flow = merged.flows.find((each) => each.id === 'service-role');
  assert.deepEqual(flow.files, ['src/admin/a.ts', 'src/lib/b.ts']);
  assert.ok(flow.reasons.some((reason) => reason === 'plan command: head content matches /x/ in src/lib/b.ts'), flow.reasons.join('; '));
  assert.equal(merged.stages.flatMap((stage) => stage.passes).length, new Set(merged.stages.flatMap((stage) => stage.passes.map((pass) => pass.id))).size, 'pass ids stay unique');
});

test('a presentation-only edit, such as a class name change, triggers a UI flow by its path', () => {
  const flows = { ui: { files: ['re:^src/app/.*\\.tsx$', 'src/components/**'], require: ['agent:designer', 'agent:ux-specialist'] } };
  const sorted = classify([change('src/components/Button.tsx', 1, 1)]);
  const touched = detectFlows(flows, { sorted, addedLines: { 'src/components/Button.tsx': ['  <button className="px-2 py-1">'] }, removedFiles: new Set(['src/components/Button.tsx']) });
  assert.deepEqual(touched.map((flow) => [flow.id, flow.files]), [['ui', ['src/components/Button.tsx']]]);
  const p = plan([change('src/components/Button.tsx', 1, 1)], { flows });
  assert.deepEqual(p.stages[0].passes.map((pass) => pass.reviewer).sort(), ['designer', 'ux-specialist']);
});

test('checkReview: review.visual and a flow content block are checked, and a bad one is left out whole', () => {
  const errors = [];
  const visual = { platform: 'web', targets: [{ files: ['src/app/**'], routes: ['/dashboard', '/{locale}/book'] }], viewports: [360, 768, 1280], locales: ['en', 'de'], variants: [{ id: 'hospitality', account: 'demo-hospitality' }], login: 'node scripts/login.mjs' };
  const content = { roots: ['src'], exclude: ['re:\\.test\\.ts$'], probes: ['\\badminClient\\b'], trace: { variables: ['adminClient', 'ctx.adminClient'], factories: ['get\\w*AdminClient\\s*\\('], params: ['client'], aliases: { '~/': 'src/' }, hops: 2 } };
  const ok = checkReview({ visual, flows: { 'service-role': { files: ['src/admin/**'], content } } }, 'config.json', errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(ok.visual.reviewers, ['designer', 'ux-specialist']);
  assert.equal(ok.visual.attach, null);
  assert.deepEqual(ok.flows['service-role'].content, content);

  const bad = [];
  const out = checkReview({
    visual: { ...visual, variants: [{ id: 'hospitality', account: 'demo', password: 'x' }], attach: 'always' },
    flows: { x: { files: ['src/**'], content: { roots: ['/abs'], trace: { hops: 2 } } } },
  }, 'config.json', bad);
  assert.equal(out.visual, null);
  assert.deepEqual(Object.keys(out.flows), []);
  assert.match(bad.join('\n'), /never its secret/u);
  assert.match(bad.join('\n'), /review\.visual\.attach/u);
  assert.match(bad.join('\n'), /content\.roots/u);
  assert.match(bad.join('\n'), /hops" 2 needs params/u);

  const wide = [];
  checkReview({ visual: { ...visual, viewports: [320, 360, 390, 414, 768, 1024, 1280, 1440], locales: ['en', 'de', 'el-GR', 'fr'], variants: [{ id: 'a' }, { id: 'b' }] } }, 'config.json', wide);
  assert.match(wide.join('\n'), new RegExp(`64 images per route .* past ${VISUAL_PER_ROUTE}`, 'u'));
  const noLogin = [];
  checkReview({ visual: { ...visual, login: undefined } }, 'config.json', noLogin);
  assert.match(noLogin.join('\n'), /review\.visual\.login/u);
});

test('checkLocalVisual: the base URL is a machine setting; anything else there is an error', () => {
  assert.deepEqual(checkLocalVisual({ engine: 'self' }, 'local', []), { baseUrl: null });
  assert.deepEqual(checkLocalVisual({ visual: { baseUrl: 'http://localhost:3000/' } }, 'local', []), { baseUrl: 'http://localhost:3000' });
  const errors = [];
  assert.deepEqual(checkLocalVisual({ visual: { baseUrl: 'ftp://x', token: 'y' } }, 'local', errors), { baseUrl: null });
  assert.equal(errors.length, 1);
  assert.equal(checkLocalReview({ engine: 'self', visual: { baseUrl: 'http://localhost:3000' } }, 'local', []), 'self');
});

test('mergeStages keeps a plan command pass that another waits for, or that waits, under its own id and order', () => {
  const merged = mergeStages({ stages: [{ name: 'local', passes: [
    { id: 'pm-first', reviewer: 'product-manager', kind: 'agent', files: null },
    { id: 'pm-then', reviewer: 'product-manager', kind: 'agent', files: null, after: ['pm-first'] },
    { id: 'agent:code-reviewer', reviewer: 'code-reviewer', kind: 'agent', files: null },
  ] }] });
  const passes = merged.stages[0].passes;
  assert.deepEqual(passes.map((pass) => pass.id).sort(), ['agent:code-reviewer', 'pm-first', 'pm-then']);
  assert.deepEqual(passes.find((pass) => pass.id === 'pm-then').after, ['pm-first']);
});
