// The first half of one `aidrian pr review` step: read the pull request and its record, mark the head `running`, plan
// the review, and refuse a plan that cannot run. It fills the step context `s` that lib/review/run.mjs builds, which the
// stages (lib/review/stages.mjs) then run.

import { committedConfig } from '../config.mjs';
import { roundCapProblem } from '../pr-await-review.mjs';
import { runGit } from '../git.mjs';
import { isolate } from './env.mjs';
import { changedFiles, diffLines, fileAt, isAncestor, mergeBase, resolve } from './diff.mjs';
import { checkReview } from './config.mjs';
import { invariantsOf } from './flows.mjs';
import { packageRoots } from './split.mjs';
import { contentFlows } from './content.mjs';
import { touchedCitations } from './cited.mjs';
import { buildPlan, classify, HARNESS_FLOW, mergePlans, mergeStages, pathPattern } from './plan.mjs';
import { BUILT_IN, resolveEngine, reviewerMap, satisfies } from './reviewers.mjs';
import { buildHistory, extensionLogger, grantedRounds, policyOf, revalidate, roundCap } from './extension.mjs';
import { heldMessage, readRecord, summaryToEdit } from './state.mjs';
import * as quota from './quota.mjs';
import { readManifest, visualMatrix, visualRoutes } from './visual.mjs';
import { headToReview } from './pushed.mjs';
import { runPlanCommand } from './base-worktree.mjs';
import { baseReviewAt, commandFiles, reviewInForce } from './in-force.mjs';
import { evidenceOf, keptSignoffsOf } from './evidence.mjs';

export const MAX_LINES = 20000;

const HARNESS_INVARIANT = Object.freeze({
  id: 'review-not-weakened',
  text: 'The change does not weaken how this project is reviewed: no flow, rule, required reviewer, ignore pattern, plan command, or invariant is removed or loosened.',
});

// The fields the review step reads of its pull request.
const CHANGE_FIELDS = 'number,headRefOid,headRefName,baseRefName,url,title,body';

// The files tracked at `commit`.
function trackedAt(root, commit) {
  const result = runGit(['ls-tree', '-r', '--name-only', '-z', commit], root, { timeout: 30_000, maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.split('\0').filter(Boolean) : [];
}

// Whether the change from `from` to `to` touches `files` (null: any reviewed file).
const touches = (changes, files) => (files === null ? changes.length > 0 : changes.some((change) => files.includes(change.file)));

// Plans the step into `s`. Returns the step's result when it ends here, or null when the stages run next.
export async function prepareStep(s) {
  const { opts, project, config, env, forge, codex, run, settle } = s;
  const root = project.root;
  const cleanEnv = isolate({ ...env });
  const info = forge.change(opts.pr, CHANGE_FIELDS);
  const repo = opts.repo ?? forge.repo();
  const n = info.number;
  // Right after a push the forge may still report the commit it built on: this checkout's pushed head wins, and a local
  // commit past it is named rather than an older round re-served (lib/review/pushed.mjs).
  const at = headToReview(root, info.headRefOid, info.headRefName);
  const head = at.head;
  if (at.unpushed) return { status: 'incomplete', pr: n, repo, head, local_head: at.unpushed, reason: `this checkout's HEAD ${at.unpushed.slice(0, 7)} is past ${head.slice(0, 7)}, the head of pull request #${n}: push, then run the step again`, retry_recommended: true };
  if (!resolve(root, head)) throw new Error(`the head ${head.slice(0, 7)} of pull request #${n} is not in this checkout: git fetch first`);
  const baseTip = resolve(root, `origin/${info.baseRefName}`) ?? resolve(root, info.baseRefName);
  if (!baseTip) throw new Error(`the base branch ${info.baseRefName} is not in this checkout: git fetch first`);
  const base = mergeBase(root, baseTip, head);
  // The round cap is the base branch's: an edit to the working copy's config, committed or not, cannot raise it. So is
  // what happens at it: github.extraRounds and its ceiling, github.maxExtraRounds.
  const committed = committedConfig(project, baseTip);
  const cap = committed.github.maxReviewRounds;
  const policy = policyOf(committed.github);
  const capped = opts.maxRounds === undefined ? null : roundCapProblem(opts.maxRounds, cap, env);
  if (capped) throw new Error(capped);

  // The config in force, and what in the change touches how the project is reviewed.
  // The head's review config is read from the head commit, not this checkout, which may be on another branch; only
  // machine settings (the engine) come from the checkout.
  const baseReview = baseReviewAt(project, baseTip);
  const headReview = baseReviewAt(project, head) ?? checkReview({}, project.paths.config, []);
  const { review, changed } = reviewInForce(baseReview, headReview);
  const effective = { ...config, review };
  const changes = changedFiles(root, base, head);
  const changedPaths = new Set(changes.map((change) => change.file));
  const harnessChanged = [];
  if (changed.length && changedPaths.has(project.paths.config)) harnessChanged.push(project.paths.config);
  for (const command of [review.planCommand, baseReview?.visual?.login, baseReview?.visual?.preview]) {
    for (const file of commandFiles(root, command, baseTip)) if (changedPaths.has(file)) harnessChanged.push(file);
  }
  // A flow's invariants doc, and every doc section an invariant cites, is part of how the project is reviewed: a
  // change to one is the Human's to sign off. An edit elsewhere in a doc that is cited only by section is not.
  harnessChanged.push(...touchedCitations(root, base, head, baseReview?.flows, changedPaths));
  for (const reviewer of Object.values(baseReview?.reviewers ?? {})) {
    for (const file of commandFiles(root, (reviewer.command ?? []).join(' '), baseTip)) if (changedPaths.has(file)) harnessChanged.push(file);
  }
  const { addedLines, removedFiles } = diffLines(root, base, head);

  // The record so far: the newer of this machine's and the pull request's. With config.json `review.record: "local"`
  // the pull request is never read or written: the record is this machine's state folder only. A comment that holds
  // a record newer than this machine's stops the step before it writes anything: starting over would replace it.
  const onPr = config.review.record !== 'local';
  const comments = onPr ? forge.conversationComments(repo, n) : [];
  const summary = summaryToEdit(comments, () => forge.viewer());
  const record = readRecord(project, n, comments, repo);
  if (record.held !== undefined) return { status: 'incomplete', pr: n, repo, head, reason: heldMessage(n, record.held), held: record.held, retry_recommended: false };
  let state = record.state;
  Object.assign(s, { root, cleanEnv, info, repo, n, head, baseTip, base, policy, baseReview, review, changes, onPr, comments, summary, state });
  // The step is open on this head before any reviewer, the plan command, or the bot runs: a merge meanwhile is refused.
  // The mark is this machine's alone and posts nothing, so it is no revision of its own: the step's next write takes
  // the one it raised. Two steps on one pull request share this one mark; the last write wins.
  settle({ status: 'running', head });
  state.revision -= 1;
  Object.assign(run, { pr: n, head, repo });

  const engine = resolveEngine(effective, codex ? { codex } : {});
  if (engine.problem) return settle({ status: 'unsatisfied', pr: n, repo, head, reason: engine.problem });
  // Flows whose files the globs miss: a changed file whose whole head content, or whose callers, hand it the flow's
  // privileged value (review.flows.<id>.content). A git failure stops the review rather than plan less.
  const traced = contentFlows({ root, head, changes, addedLines, flows: review.flows });
  const planFor = (minDepth) => buildPlan({
    head, base, changes, addedLines, removedFiles, config: effective, harnessChanged: [...new Set(harnessChanged)], extraFlows: traced,
    roots: packageRoots(trackedAt(root, head)), halved: state.halved ?? {},
    engine: { name: engine.reviewer.name, kind: engine.reviewer.kind, stage: engine.reviewer.stage, agent: engine.reviewer.agent, builtIn: Boolean(BUILT_IN[engine.reviewer.name]) },
    minDepth,
    merge: false,
  });
  let plan = planFor('none');
  if (review.planCommand) {
    const project_ = await runPlanCommand(review.planCommand, { base, head, changes }, { root, env: cleanEnv, baseTip });
    // A plan command that raises the depth to split gets the slices too: the built-in plan is rebuilt at that depth.
    if (project_.depth === 'split' && plan.depth !== 'split') plan = planFor('split');
    plan = mergePlans(plan, project_);
  }
  // Agent passes merge per reviewer only now, after the plan command's passes joined, so one agent reads the diff once.
  plan = mergeStages(plan);
  // --with-bot (the skill's --await-codex): the review bot runs as the last stage too, after this machine's engine.
  if (opts.withBot && plan.depth !== 'none' && config.github.reviewer !== null && !plan.stages.some((stage) => stage.passes.some((pass) => pass.reviewer === 'pr-bot'))) {
    plan.stages = [...plan.stages.filter((stage) => stage.name !== 'remote'), { name: 'remote', passes: [...(plan.stages.find((stage) => stage.name === 'remote')?.passes ?? []), { id: 'engine:pr-bot', reviewer: 'pr-bot', kind: 'remote', files: null, context: 'full' }] }];
  }
  plan.engine = { name: engine.reviewer.name, reason: engine.reason };
  const map = reviewerMap(effective);
  // A reviewer out of quota on this head, and the Human's choice of what replaces it (lib/review/quota.mjs). The flag
  // answers a stop on this head only, and is refused where the plan requires an independent model.
  if (opts.quotaFallback) {
    const stop = (state.quotaStops ?? []).filter((each) => each.head === head).at(-1);
    if (!stop) throw new Error(`no quota stop is on record for head ${head.slice(0, 7)} of #${n}: --quota-fallback answers a blocked_quota on the current head only`);
    const refused = quota.refusal(plan, stop, plan.stages.flatMap((stage) => stage.passes), map);
    if (refused) return settle({ status: 'unsatisfied', pr: n, repo, head, reason: refused, plan });
    if (stop.choice !== opts.quotaFallback) Object.assign(stop, { choice: opts.quotaFallback, chosen_at: new Date().toISOString(), signoff: null });
  }
  // A pass's result counts for this head when it is for this head, or for an earlier one the change since does not
  // touch and that left nothing open.
  const deltaCache = new Map();
  const delta = (from) => {
    if (!deltaCache.has(from)) deltaCache.set(from, isAncestor(root, from, head) ? changedFiles(root, from, head) : null);
    return deltaCache.get(from);
  };
  // A pass with a file list (a slice, a flow pass) keeps its history only while it covers the same files: when a fix
  // repacks slices, a slice's earlier result and findings are another set of files' and count for nothing.
  const sameFiles = (pass, result) => !Array.isArray(pass.files) || JSON.stringify([...pass.files].sort()) === JSON.stringify(result.files ?? null);
  const resultFor = (pass) => {
    const result = state.passes[pass.id];
    if (!result || !sameFiles(pass, result)) return null;
    if (result.head === head) return result;
    const since = delta(result.head);
    return since && !touches(since, pass.files) && result.open === 0 ? result : null;
  };
  const fallbacks = quota.applyChoices(plan, state.quotaStops, head, resultFor);
  const { lines } = classify(changes, review);
  if (plan.depth !== 'none' && lines > MAX_LINES) return settle({ status: 'too_large', pr: n, repo, head, lines, reason: `${lines} changed lines is past ${MAX_LINES}: split the pull request` });

  // The flows' invariants: a flow the base defines reads its doc from the base, so the change under review cannot
  // rewrite it; a flow the change adds reads it from the head, the only place it exists.
  const readAt = (commit) => (file) => fileAt(root, commit, file);
  for (const flow of plan.flows) {
    if (flow.id === HARNESS_FLOW) Object.assign(flow, { invariants: [HARNESS_INVARIANT], unspecified: false, signoff: 'human' });
    else Object.assign(flow, invariantsOf(review.flows[flow.id] ?? {}, readAt(baseReview?.flows?.[flow.id] ? baseTip : head)));
  }

  const keptSignoffs = await keptSignoffsOf({ project, root, head, baseTip, cleanEnv, review, baseReview, plan, state });

  // The visual capture: the routes the change touches, and their matrix. A matrix past the limit stops the review here,
  // naming the routes, rather than capture part of it. The capture itself runs once per head, when a visual reviewer
  // is dispatched.
  const visual = review.visual;
  const visualRoutesHere = visualRoutes(visual, changes);
  let visualEntries = [];
  if (visualRoutesHere.length) {
    try {
      visualEntries = visualMatrix(visual, visualRoutesHere);
    } catch (error) {
      return settle({ status: 'too_large', pr: n, repo, head, reason: error.message });
    }
  }
  const manifest = visual ? readManifest(project, n, head) : null;
  const isVisual = (pass) => Boolean(visual) && visual.reviewers.includes(map[pass.reviewer]?.agent ?? pass.reviewer);

  const passes = plan.stages.flatMap((stage) => stage.passes);
  // A pass nobody can run would never finish and never block: refuse the plan instead.
  const orphan = passes.find((pass) => pass.kind !== 'agent' && !map[pass.reviewer]);
  if (orphan) return settle({ status: 'unsatisfied', pr: n, repo, head, reason: `pass ${orphan.id} names reviewer "${orphan.reviewer}", which is not an agent pass or a reviewer of review.reviewers`, plan });
  // Every pass after the local stage answers for every flow: a violated from any reviewer blocks the flow, and a flow
  // only the independent model reviews is signed by it. The review bot gives no verdicts, so a flow needs another
  // pass that can answer for it.
  for (const stage of plan.stages) if (stage.name !== 'local') for (const pass of stage.passes) pass.flows = plan.flows.map((flow) => flow.id);
  for (const word of plan.require) {
    if (!satisfies(word, passes, map) && word === 'independent-model' && fallbacks.length) return settle({ status: 'unsatisfied', pr: n, repo, head, reason: quota.refusal(plan, fallbacks[0], [], map), plan });
    if (!satisfies(word, passes, map)) return settle({ status: 'unsatisfied', pr: n, repo, head, reason: `the plan requires ${word}, and the engine here is ${engine.reviewer.name} (${engine.reason})`, plan });
  }
  // A flow's deleted test stops the review whatever else the change does, even when nothing else needs a review.
  const removedTests = [];
  for (const [id, definition] of Object.entries(review.flows)) {
    const tests = (definition.tests ?? []).map(pathPattern);
    const gone = changes.filter((each) => each.status === 'D' && tests.some((pattern) => pattern.test(each.file))).map((each) => each.file);
    if (gone.length) removedTests.push({ flow: id, deleted: gone, accept: `aidrian pr signoff ${n} --flow ${id} --head ${head}` });
  }
  // The flows the Human may sign off on this head: one the project marks for the Human's sign-off, the built-in
  // harness-config, or one whose test the change deletes. `aidrian pr signoff` refuses any other, since its sign-off
  // would count for nothing: a violated invariant is fixed, never signed away.
  state.signoffable = { head, flows: [...new Set([...plan.flows.filter((flow) => flow.signoff === 'human').map((flow) => flow.id), ...removedTests.map((each) => each.flow)])].sort() };
  const answerless = plan.flows.find((flow) => !passes.some((pass) => (pass.flows ?? []).includes(flow.id) && map[pass.reviewer]?.kind !== 'remote'));
  if (answerless) return settle({ status: 'unsatisfied', pr: n, repo, head, reason: `flow ${answerless.id} needs a reviewer that answers its invariants, and the review bot does not: run codex-local, or require an agent for the flow`, plan });
  if (!passes.length && !removedTests.length && !fallbacks.length) return settle({ status: 'none_needed', pr: n, repo, head, base, depth: plan.depth, engine: plan.engine, plan: { depth: plan.depth, reasons: plan.reasons, flows: [], stages: [] } });

  // Each extra round the base branch's policy grants (lib/review/extension.mjs) raises the cap by one. A decision still
  // open at the cap (a check, or a grant whose round has not opened) is read again when the head has moved since.
  const planHistory = () => buildHistory({ root, rounds: state.rounds.map((round, i) => ({ round: i + 1, head: round.head, open: round.open ?? null, findings: round.findings ?? null })), baseTip, head, review });
  const extensionLog = extensionLogger(project, config, { pr: n, repo, env });
  if (policy.mode !== 'off') revalidate({ state, source: 'plan', round: state.rounds.length, head, history: planHistory, log: extensionLog });
  const { maxRounds, grantFloor } = roundCap({ baseline: opts.maxRounds ?? cap, granted: grantedRounds(state, 'plan', policy) });

  Object.assign(s, { plan, map, resultFor, sameFiles, fallbacks, keptSignoffs, visual, visualEntries, manifest, isVisual, passes, removedTests, planHistory, extensionLog, maxRounds, grantFloor });
  Object.assign(s, evidenceOf(s));
  return null;
}
