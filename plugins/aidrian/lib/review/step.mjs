// The first half of one `aidrian pr review` step: read the pull request and its record, mark the head `running`, plan
// the review, and refuse a plan that cannot run. It fills the step context `s` that lib/review/run.mjs builds, which the
// stages (lib/review/stages.mjs) then run.

import { roundCapProblem } from '../pr-await-review.mjs';
import { runGit } from '../git.mjs';
import { isolate } from './env.mjs';
import { baseMergeOf, changedFiles, diffLines, fileAt, isAncestor, mergeBase, parents, QUIET_TEST_FILES, quietDelta, resolve } from './diff.mjs';
import { checkReview } from './config.mjs';
import { invariantsOf } from './flows.mjs';
import { packageRoots } from './split.mjs';
import { contentFlows } from './content.mjs';
import { touchedCitations } from './cited.mjs';
import { buildPlan, classify, detectFlows, HARNESS_FLOW, mergePlans, mergeStages, pathPattern } from './plan.mjs';
import { BUILT_IN, resolveEngine, reviewerMap, satisfies } from './reviewers.mjs';
import { buildHistory, extensionLogger, grantedRounds, policyOf, revalidate, roundCap } from './extension.mjs';
import { heldMessage, publishState, readRecord, sameCommit, summaryToEdit } from './state.mjs';
import * as quota from './quota.mjs';
import { readManifest, visualMatrix, visualRoutes } from './visual.mjs';
import { headToReview } from './pushed.mjs';
import { runPlanCommand, stderrTail } from './base-worktree.mjs';
import { baseReviewAt, baseReviewMoved, commandFiles, holdToBase, reviewInForce } from './in-force.mjs';
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

// Whether `since`, the change from `from` to `head`, is quiet (diff.mjs quietDelta: prose, tests that only gained
// lines, comment-only code). Quiet decides round accounting alone: the round on `from` stays open on `head`, with its
// number, cap, and last-round flag. It never decides whether a pass runs: a quiet push is reviewed by every pass it
// touches, as any push is, so a misread change costs a round of cap, never a review. A change to a file that decides
// how the project is reviewed, to a doc a flow cites, or one that selects a flow by itself is not quiet: it changes
// what the round's passes were asked to judge.
function quietChange({ root, from, head, since, review, harnessFiles }) {
  const lines = diffLines(root, from, head);
  const sorted = classify(since, review);
  const prose = new Set([...sorted.ignored, ...sorted.nonBehaviour]);
  const tests = [...QUIET_TEST_FILES, ...Object.values(review.flows ?? {}).flatMap((flow) => flow.tests ?? [])].map(pathPattern);
  // The cheap line check first: a loud change needs no guard.
  if (!quietDelta({ changes: since, ...lines }, { prose: (file) => prose.has(file), test: (file) => tests.some((pattern) => pattern.test(file)) }).quiet) return false;
  const sincePaths = new Set(since.map((change) => change.file));
  if (since.some((change) => harnessFiles.has(change.file)) || touchedCitations(root, from, head, review.flows, sincePaths).length) return false;
  if (detectFlows(review.flows, { sorted, addedLines: lines.addedLines, removedFiles: lines.removedFiles }).length) return false;
  return contentFlows({ root, head, changes: since, addedLines: lines.addedLines, flows: review.flows }).length === 0;
}

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
  // The round cap is the base branch's: an edit to the working copy's config, committed or not, cannot raise it. So is
  // what happens at it: github.extraRounds and its ceiling, github.maxExtraRounds. So are where the record is read from,
  // state.dir, and whether it goes on the pull request, review.record.
  const { committed, baseTip } = holdToBase(project, config, { repo, base: info.baseRefName });
  const base = mergeBase(root, baseTip, head);
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
  // The files that decide how the project is reviewed besides the config: the plan command's, the visual hooks', and
  // every reviewer command's, as the base branch has them.
  const reviewCommands = [review.planCommand, review.visual?.login, review.visual?.preview, ...Object.values(baseReview?.reviewers ?? {}).map((reviewer) => (reviewer.command ?? []).join(' '))];
  const harnessFiles = new Set([project.paths.config, ...reviewCommands.flatMap((command) => commandFiles(root, command, baseTip))]);

  // The record so far: the newer of this machine's and the pull request's. With `review.record: "local"` on the base
  // branch the pull request is never read or written: the record is this machine's state folder only. A comment that holds
  // a record newer than this machine's stops the step before it writes anything: starting over would replace it.
  const onPr = committed.review.record !== 'local';
  const comments = onPr ? forge.conversationComments(repo, n) : [];
  const summary = summaryToEdit(comments, () => forge.viewer());
  const record = readRecord(project, n, comments, repo);
  if (record.held !== undefined) return { status: 'incomplete', pr: n, repo, head, reason: heldMessage(n, record.held), held: record.held, retry_recommended: false };
  let state = record.state;
  Object.assign(s, { root, cleanEnv, info, repo, n, head, baseTip, base, policy, review, onPr, comments, summary, state });

  // A merge from the base branch onto the head whose review last came back `received` (diff.mjs baseMergeOf). That
  // head is the outcome's while it is on another head; on a later step for the same merge head, the one a carried
  // outcome or the first step on it named. A clean merge carries the review: no reviewer, no round, nothing marked
  // running. Any other reviews only the changes the merge commit made; `base` stays the merge base for everything
  // else. A merge git cannot read (an older git, a broken config) is reviewed as any head is, never refused for it, and
  // so is one where the base branch, up to its tip, changes how the project is reviewed (baseReviewMoved): the reviewed
  // head never met that rule, whether it came with the merge or landed on the base after it.
  const last = state.outcome ?? null;
  const reviewedHead = last?.status === 'received' && typeof last.head === 'string' && !sameCommit(last.head, head) ? last.head
    : sameCommit(last?.head, head) && typeof last?.carried_from === 'string' ? last.carried_from
      : sameCommit(state.remerge?.head, head) && typeof state.remerge?.from === 'string' ? state.remerge.from : null;
  let baseMerge = null;
  let mergeNote = null;
  let mergedBase = null;
  try {
    baseMerge = reviewedHead ? baseMergeOf(root, head, { priorHead: reviewedHead, base: baseTip }) : null;
    if (baseMerge) {
      mergedBase = parents(root, head)[1];
      const moved = baseReviewMoved(project, { from: mergeBase(root, reviewedHead, mergedBase), to: baseTip, flows: review.flows, harnessFiles });
      if (moved.length) {
        baseMerge = null;
        mergeNote = `the merge from ${info.baseRefName} changes how the project is reviewed (${moved.join(', ')}): the whole change is reviewed`;
      }
    }
  } catch (error) {
    baseMerge = null;
    mergeNote = `the merge from ${info.baseRefName} could not be read (${stderrTail(error.message, { chars: 200 })}): the whole change is reviewed`;
  }
  if (baseMerge?.clean) {
    const carried = settle({
      status: 'received', pr: n, repo, head, base, carried_from: reviewedHead, carried_base: mergedBase, round: state.rounds.length, depth: 'none',
      max_rounds: roundCap({ baseline: opts.maxRounds ?? cap, granted: grantedRounds(state, 'plan', policy) }).maxRounds,
      plan: { depth: 'none', reasons: [`a clean merge from ${info.baseRefName}: the review of ${reviewedHead.slice(0, 7)} carries to this head`], flows: [], stages: [] },
    });
    // Published as the review step publishes, so another machine's merge guard reads the same record.
    const summaryError = onPr ? publishState(state, { comments: () => comments, post: (body) => forge.postComment(repo, n, body), edit: (id, body) => forge.editComment(repo, id, body), viewer: () => forge.viewer() }, 'received') : null;
    return summaryError ? { ...carried, summary_error: summaryError } : carried;
  }
  const scope = baseMerge ? baseMerge.scope : null;
  if (scope) state.remerge = { head, from: reviewedHead };
  const changes = scope?.changes ?? changedFiles(root, base, head);
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
  const { addedLines, removedFiles } = scope ?? diffLines(root, base, head);

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
  if (mergeNote) plan.reasons = [...plan.reasons, mergeNote];
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
  // On a merge from the base branch, what the base brought in was reviewed there: since the reviewed head the change is
  // the merge's own, and since an earlier head, that head's change to the reviewed one plus the merge's own. A merge
  // that drops what the base brought (`-s ours`) is a change of its own then, though its tree equals the reviewed head's.
  const sinceFor = (from) => {
    if (!isAncestor(root, from, head)) return null;
    if (!scope || !isAncestor(root, from, reviewedHead)) return changedFiles(root, from, head);
    const since = changedFiles(root, from, reviewedHead);
    return [...since, ...scope.changes.filter((change) => !since.some((each) => each.file === change.file))];
  };
  const delta = (from) => {
    if (!deltaCache.has(from)) deltaCache.set(from, sinceFor(from));
    return deltaCache.get(from);
  };
  // Whether the change since `from` is quiet (quietChange). A merge scoped to its own changes (`scope`) is not; any
  // other merge is judged by its change, as a push is.
  const quietCache = new Map();
  const quietSince = (from) => {
    if (!quietCache.has(from)) {
      const since = scope ? null : delta(from);
      quietCache.set(from, since ? quietChange({ root, from, head, since, review, harnessFiles }) : false);
    }
    return quietCache.get(from);
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

  const keptSignoffs = await keptSignoffsOf({ root, head, baseTip, cleanEnv, review, harnessFiles, plan, state });

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
  // The checks measure a round from the head it first reviewed, so what a quiet push added is that round's fix, never
  // part of what the pull request first changed. The rounds they read back stand on the head each moved to: that is
  // the head the round reviewed, which says whether the head at the cap is one no round reviewed. A fix no round
  // reviewed is sized from that same head: the last round's `reviewed_fix`, kept non-enumerable so the signals and the
  // judge's history carry only the first-head `fix`.
  const planHistory = () => {
    const read = buildHistory({ root, rounds: state.rounds.map((round, i) => ({ round: i + 1, head: round.quiet?.[0]?.from ?? round.head, open: round.open ?? null, findings: round.findings ?? null })), baseTip, head, review });
    const rounds = read.rounds.map((round, i) => ({ ...round, head: state.rounds[i].head }));
    const last = state.rounds.at(-1);
    if (last?.quiet?.length && !sameCommit(last.head, head)) {
      Object.defineProperty(rounds.at(-1), 'reviewed_fix', { value: buildHistory({ root, rounds: [{ head: last.head }], baseTip, head, review }).rounds[0].fix });
    }
    return { ...read, rounds };
  };
  const extensionLog = extensionLogger(project, config, { pr: n, repo, env });
  if (policy.mode !== 'off') revalidate({ state, source: 'plan', round: state.rounds.length, head, history: planHistory, log: extensionLog });
  const { maxRounds, grantFloor } = roundCap({ baseline: opts.maxRounds ?? cap, granted: grantedRounds(state, 'plan', policy) });

  Object.assign(s, { changes, scope, plan, map, resultFor, sameFiles, quietSince, fallbacks, keptSignoffs, visual, visualEntries, manifest, isVisual, passes, removedTests, planHistory, extensionLog, maxRounds, grantFloor });
  Object.assign(s, evidenceOf(s));
  return null;
}
